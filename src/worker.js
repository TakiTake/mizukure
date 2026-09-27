// mizukure backend (Cloudflare Worker)
//
//   Phone camera → public/index.html → POST /api/judge (this Worker)
//     1. Workers AI vision model turns the photo into structured, English observations
//        (Jev is text-only, so the image has to become text first)
//     2. Jev (typesafe.ai /v1/systemone) scores those observations with calibrated
//        probabilities: watering need, wilting, soil dryness, over-watering, etc.
//     3. The Worker converts Jev's answers into the JSON the page already renders.
//
// Required config:
//   - secret  TYPESAFE_API_KEY   (wrangler secret put TYPESAFE_API_KEY)
//   - secret  TURNSTILE_SECRET   (wrangler secret put TURNSTILE_SECRET)
//   - secret  TURNSTILE_SITE_KEY (public, but a secret so `wrangler deploy` never resets it;
//                                  the page reads it from /api/config)
//   - binding AI                 (Workers AI, see wrangler.jsonc)
//   - bindings PRECHECK_LIMITER, JUDGE_LIMITER (per-IP rate limits, see wrangler.jsonc)
// Optional binding DB (D1): judgements and the page's 👍/👎 feedback are stored there (no photos, no IPs),
//                to measure how often the verdicts are right. Without it, judging works and nothing is stored.
// Optional vars: VISION_MODEL, JEV_MODEL, ALLOWED_ORIGINS (comma separated; extra origins that proxy to this
//                Worker. No CORS headers are sent, so a browser page on another origin can't call it directly)
//
// /api/judge spends Workers AI + Jev credits, so every call must pass the Origin check,
// the per-IP rate limit and a Turnstile check. Missing config fails closed.
//
// Each /api/judge response carries a Server-Timing header (turnstile, upload, vision, jev, total in ms)
// and the same numbers are logged as one JSON line, so the time spent per step can be compared across versions.

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DEFAULT_VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const DEFAULT_JEV_MODEL = 'jev-latest';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_IMAGE_BYTES + 64 * 1024; // image + small form fields and multipart overhead
export const SITEVERIFY_TIMEOUT_MS = 5000;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// /api/judge refuses to run (not_configured) unless all of these are set.
const REQUIRED_CONFIG = ['TYPESAFE_API_KEY', 'AI', 'PRECHECK_LIMITER', 'JUDGE_LIMITER', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/judge') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const sw = stopwatch();
      return sw.finish(await handleJudge(request, env, ctx, url, sw));
    }
    if (url.pathname === '/api/feedback') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return handleFeedback(request, env, url);
    }
    if (url.pathname === '/api/config') {
      return json({ turnstile_site_key: env.TURNSTILE_SITE_KEY || null, max_image_bytes: MAX_IMAGE_BYTES });
    }
    if (url.pathname === '/api/health') {
      return json({
        ok: REQUIRED_CONFIG.every(k => env[k]), jev: !!env.TYPESAFE_API_KEY, ai: !!env.AI,
        turnstile: !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET), rate_limit: !!(env.PRECHECK_LIMITER && env.JUDGE_LIMITER),
        db: !!env.DB, // optional: not part of `ok`
      });
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------- /api/judge

async function handleJudge(request, env, ctx, url, sw) {
  const origin = request.headers.get('Origin');
  if (!originAllowed(origin, url, env)) return json({ error: 'forbidden' }, 403);
  if (REQUIRED_CONFIG.some(k => !env[k])) return json({ error: 'not_configured' }, 500);

  // Two per-IP limits around Turnstile (the token comes in a header, checked before the body is read):
  //  - PRECHECK (loose) counts every tokened request, capping the siteverify calls one IP can cause.
  //    Trade-off: someone behind a shared IP (carrier NAT) sending junk above that rate can still
  //    lock the IP out; the loose threshold only raises the bar. Keep it: without it, a junk flood
  //    goes straight to siteverify.
  //  - JUDGE (strict) counts only requests about to make the paid calls: Turnstile passed and the
  //    photo is valid, so junk tokens and rejected photos don't use up a real user's quota.
  // Tokens are at most 2048 characters; anything else is refused without asking siteverify.
  const token = request.headers.get('X-Turnstile-Token');
  if (!token || token.length > 2048) return json({ error: 'turnstile_failed' }, 403);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const key = rateLimitKey(ip);

  const precheck = await limited(env.PRECHECK_LIMITER, key);
  if (precheck) return precheck;
  const verdict = await sw.time('turnstile', () => verifyTurnstile(env, token, ip, origin, url));
  if (verdict === 'error') return json({ error: 'unavailable' }, 503);
  if (verdict !== 'pass') return json({ error: 'turnstile_failed' }, 403);
  sw.log = true; // log timings only from here on, so junk requests don't fill the logs

  let form;
  try {
    form = await sw.time('upload', () => readBodyCapped(request, MAX_BODY_BYTES, 'formData'));
  } catch { return json({ error: 'bad_request' }, 400); } // malformed form, or the client dropped mid-upload
  if (form === null) return json({ error: 'image_too_large' }, 413);
  const image = form.get('image');
  if (!image || typeof image === 'string') return json({ error: 'image_missing' }, 400);
  if (!ALLOWED_TYPES.has(image.type)) return json({ error: 'image_rejected' }, 415);
  if (image.size > MAX_IMAGE_BYTES) return json({ error: 'image_too_large' }, 413);

  const judged = await limited(env.JUDGE_LIMITER, key);
  if (judged) return judged;

  const kind = String(form.get('kind') || '').trim().slice(0, 60);
  const deviceSoil = parseDeviceSoil(form.get('device_soil'));

  // 1) photo → observations
  let obs;
  try {
    obs = await sw.time('vision', () => describePhoto(env, image, kind));
  } catch (e) {
    console.error('vision failed', e);
    return json({ error: 'vision_failed' }, 502);
  }

  const state = buildState(obs, kind, deviceSoil);
  const record = { models: { vision: env.VISION_MODEL || DEFAULT_VISION_MODEL }, inputs: state };

  // Nothing usable in the photo: skip Jev, ask for a retake.
  if (!obs.plant_visible && !obs.soil_visible) {
    return judgementResponse(env, ctx, sw, unclearResult(obs, 'The photo shows neither a plant nor soil.'), record);
  }

  // 2) observations → calibrated judgement
  let jev;
  try {
    jev = await sw.time('jev', () => askJev(env, state));
  } catch (e) {
    console.error('jev failed', e);
    // Jev throttling or overload is a temporary server-side problem, not the user judging too often
    // ('rate_limited' is reserved for our own per-IP limit).
    if (e.status === 429 || e.status === 529) return json({ error: 'unavailable' }, 503);
    return json({ error: 'jev_failed' }, 502);
  }

  // 3) shape for the page
  return judgementResponse(env, ctx, sw, toResult(obs, jev), { ...record, models: { ...record.models, jev: jev?.model ?? null }, answers: jev?.answers ?? null });
}

// ---------------------------------------------------------------- judgement log + feedback (D1)

// Created on first use, so a new deployment needs no migration step. Every write runs it in the same batch.
// It never changes an existing table: adding a column later needs an ALTER TABLE (a real migration).
const SCHEMA = `CREATE TABLE IF NOT EXISTS judgements (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,  -- unix ms
  pipeline TEXT NOT NULL,       -- how the verdict was made, e.g. 'vision+jev'
  models TEXT,                  -- JSON {vision, jev}
  inputs TEXT,                  -- JSON: what Jev was (or would have been) given
  answers TEXT,                 -- JSON: Jev's answers (null when Jev was skipped)
  result TEXT NOT NULL,         -- JSON: what the page showed
  ms TEXT,                      -- JSON: step timings
  vote TEXT CHECK (vote IN ('good', 'bad')),
  actual TEXT CHECK (actual IN ('dry', 'moist')),  -- after 👎: what the owner's finger test found
  feedback_at INTEGER           -- time of the latest feedback
)`;
const PIPELINE = 'vision+jev';
export const FEEDBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Returns the result, and (with a DB) gives it an id and stores it once the timings are final.
// The write happens after the response is sent, so it adds no latency; if it fails, only the log is lost.
function judgementResponse(env, ctx, sw, result, record) {
  if (env.DB) {
    const id = result.judgement_id = crypto.randomUUID();
    sw.onFinish(ms => ctx.waitUntil(saveJudgement(env.DB, id, record, result, ms).catch(e => console.error('saving judgement failed', e))));
  }
  return json(result);
}

async function saveJudgement(db, id, record, result, ms) {
  const insert = db.prepare(
    'INSERT INTO judgements (id, created_at, pipeline, models, inputs, answers, result, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, Date.now(), PIPELINE, JSON.stringify(record.models), JSON.stringify(record.inputs),
    record.answers ? JSON.stringify(record.answers) : null, JSON.stringify(result), JSON.stringify(ms));
  await db.batch([db.prepare(SCHEMA), insert]);
}

// POST /api/feedback  {id, vote: 'good'|'bad'}  or, after 👎,  {id, actual: 'dry'|'moist'}
// Each judgement takes one vote and (after 'bad') one `actual`, within a day of judging; sending the same value
// again succeeds (a retry after a lost response), a different one doesn't. A judgement already passed Turnstile,
// and ids are random, so this only needs the Origin check and the loose per-IP limit.
async function handleFeedback(request, env, url) {
  if (!originAllowed(request.headers.get('Origin'), url, env)) return json({ error: 'forbidden' }, 403);
  if (!env.DB || !env.PRECHECK_LIMITER) return json({ error: 'not_configured' }, 500);
  const busy = await limited(env.PRECHECK_LIMITER, rateLimitKey(request.headers.get('CF-Connecting-IP') || ''));
  if (busy) return busy;

  let text, body;
  try { text = await readBodyCapped(request, 1024, 'text'); } catch { text = ''; } // client dropped mid-body
  if (text === null) return json({ error: 'bad_request' }, 413);
  try { body = JSON.parse(text); } catch {}
  const { id, vote, actual } = body && typeof body === 'object' ? body : {};
  if (typeof id !== 'string' || !UUID_RE.test(id)) return json({ error: 'bad_request' }, 400);

  const isVote = ['good', 'bad'].includes(vote) && actual === undefined;
  const isActual = ['dry', 'moist'].includes(actual) && vote === undefined;
  if (!isVote && !isActual) return json({ error: 'bad_request' }, 400);
  // column and extra condition come from this fixed choice, never from the request
  const [column, value, afterBad] = isVote ? ['vote', vote, ''] : ['actual', actual, " AND vote = 'bad'"];
  const now = Date.now();
  const update = env.DB.prepare(
    `UPDATE judgements SET ${column} = ?1, feedback_at = ?2 WHERE id = ?3 AND (${column} IS NULL OR ${column} = ?1) AND created_at > ?4${afterBad}`,
  ).bind(value, now, id, now - FEEDBACK_WINDOW_MS);

  let changes;
  try {
    const results = await env.DB.batch([env.DB.prepare(SCHEMA), update]);
    changes = results.at(-1)?.meta?.changes;
  } catch (e) {
    console.error('saving feedback failed', e);
    // distinct from 'unavailable' (limiter hiccup): the page stops asking only when storage itself is down,
    // e.g. over D1's daily limit, which lasts until midnight UTC
    return json({ error: 'storage_unavailable' }, 503);
  }
  // unknown id (or not stored yet: the judgement is written after its response), a different answer already
  // given, too old, or `actual` without a 👎 first
  if (!changes) return json({ error: 'not_found' }, 404);
  return json({ ok: true });
}

// ---------------------------------------------------------------- step 1: vision

const OBS_SCHEMA = {
  type: 'object',
  properties: {
    plant_visible: { type: 'boolean' },
    soil_visible: { type: 'boolean' },
    image_quality: { type: 'string', enum: ['good', 'dark', 'blurry', 'too_far', 'too_close', 'other_problem'] },
    plant_name_en: { type: 'string' },
    plant_name_ja: { type: 'string' },
    container: { type: 'string' },
    leaf_posture: { type: 'string' },
    leaf_texture_and_color: { type: 'string' },
    stem_posture: { type: 'string' },
    soil_surface_color: { type: 'string' },
    soil_surface_texture: { type: 'string' },
    soil_pulling_from_pot_edge: { type: 'string' },
    overwatering_signs: { type: 'string' },
    lighting: { type: 'string' },
    other_notes: { type: 'string' },
    evidence_ja: { type: 'array', items: { type: 'string' } },
  },
  required: ['plant_visible', 'soil_visible', 'image_quality', 'plant_name_en', 'leaf_posture', 'soil_surface_color', 'evidence_ja'],
};

function visionPrompt(kind) {
  return `You are a careful horticulture observer. Describe ONLY what is visible in this photo of a potted or garden plant. Do not decide whether it needs water; another system decides that from your notes.
${kind ? `The owner says the plant is: "${kind}". Use this if it is consistent with the photo.` : 'The owner did not say what plant it is; identify it if you can, otherwise write "unknown".'}

Fill every field with short, concrete English observations (Japanese only for plant_name_ja and evidence_ja):
- leaf_posture: firm and upright / slightly drooping / clearly drooping or limp / collapsed; mention curling edges.
- leaf_texture_and_color: glossy, dull, wrinkled, crispy/brown tips, yellowing, translucent/mushy.
- stem_posture: upright, bending, collapsed.
- soil_surface_color: dark and wet-looking / medium brown / pale, light, greyish or dusty. Account for the lighting.
- soil_surface_texture: shiny wet, moist crumbly, dry powdery, crusted, cracked.
- soil_pulling_from_pot_edge: yes (visible gap) / no / cannot see.
- overwatering_signs: standing water, mould, algae, fungus gnats, yellow soft leaves, or "none".
- lighting: e.g. bright daylight, warm indoor light, flash, backlit, dim.
- evidence_ja: up to 3 very short Japanese phrases describing the most important visible evidence (e.g. "土の表面が白っぽく乾いている").
If the plant or soil is not visible, set the matching *_visible field to false and write "not visible" in the related fields.
Return JSON only.`;
}

async function describePhoto(env, image, kind) {
  const bytes = new Uint8Array(await image.arrayBuffer());
  const dataUrl = `data:${image.type};base64,${toBase64(bytes)}`;
  const model = env.VISION_MODEL || DEFAULT_VISION_MODEL;

  const out = await env.AI.run(model, {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: visionPrompt(kind) },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
    response_format: { type: 'json_schema', json_schema: OBS_SCHEMA },
    max_tokens: 900,
    temperature: 0.1,
  });

  const obs = extractJson(out);
  if (!obs || typeof obs !== 'object') throw new Error('vision returned no JSON: ' + JSON.stringify(out).slice(0, 300));
  obs.plant_visible = obs.plant_visible !== false;
  obs.soil_visible = obs.soil_visible !== false;
  obs.evidence_ja = Array.isArray(obs.evidence_ja) ? obs.evidence_ja.map(String).slice(0, 3) : [];
  return obs;
}

// Workers AI models answer in different shapes depending on the model:
// { response: "..." } | { response: {...} } | OpenAI-style { choices: [{ message: { content } }] }
export function extractJson(out) {
  if (out == null) return null;
  let v = out.response ?? out.result?.response ?? out.choices?.[0]?.message?.content ?? out;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  v = v.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(v); } catch {}
  const m = v.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ---------------------------------------------------------------- step 2: Jev

// Score criteria are ordered from "no water needed" to "water now".
export const QUESTIONS = {
  watering_need: {
    type: 'score',
    instructions: 'Based on the observations of this plant, how urgently does it need to be watered right now? Consider the species\' water preference (succulents, cacti and snake plants tolerate dry soil; ferns, basil and peace lilies do not).',
    criteria: [
      'Not needed: soil looks wet or clearly moist and leaves are firm, or there are signs of over-watering',
      'Not yet: soil is still somewhat moist and leaves are firm',
      'Soon: surface soil is starting to dry but leaves are still firm; water within a day or two',
      'Today: soil surface is dry and pale, or leaves are beginning to droop',
      'Urgent: soil is very dry (cracked, pulling from the pot edge) and/or leaves are clearly wilted or collapsing',
    ],
  },
  wilting: {
    type: 'score',
    instructions: 'How wilted does the plant look?',
    criteria: [
      'Leaves and stems firm, upright and turgid',
      'Slight softening or a few leaves drooping',
      'Many leaves drooping or curling',
      'Plant clearly limp, leaves hanging or collapsing',
    ],
  },
  soil_dryness: {
    type: 'score',
    instructions: 'How dry does the soil surface look? Take the lighting into account (warm or dim light makes soil look darker; bright light or flash makes it look paler).',
    criteria: [
      'Wet: dark, shiny, or standing water',
      'Moist: dark brown and crumbly',
      'Drying: medium brown, surface starting to lighten',
      'Dry: pale, greyish or dusty surface',
      'Very dry: pale and cracked, or pulling away from the pot edge',
    ],
  },
  overwatered: {
    type: 'noul',
    instructions: 'Are there signs that the plant is being over-watered (standing water, mould, soggy dark soil with yellow or mushy leaves)?',
  },
  water_preference: {
    type: 'choice',
    instructions: 'What is the typical water preference of this kind of plant?',
    criteria: {
      dry_tolerant: 'Succulents, cacti, snake plant (sansevieria), ZZ plant, aloe: let the soil dry out fully between waterings',
      moderate: 'Most houseplants such as pothos, monstera, ficus: water when the top few centimetres of soil are dry',
      moisture_loving: 'Ferns, peace lily, basil and many herbs, calathea: keep the soil evenly moist',
      unknown: 'The plant type cannot be determined',
    },
  },
  photo_reliable: {
    type: 'noul',
    instructions: 'Do the observations contain enough clear information about both the plant and the soil to judge whether it needs water?',
  },
};

export function buildState(obs, kind, deviceSoil) {
  const state = {
    owner_says_plant_is: kind || 'not specified',
    photo_observations: {
      plant_visible: obs.plant_visible,
      soil_visible: obs.soil_visible,
      image_quality: obs.image_quality,
      plant: obs.plant_name_en,
      container: obs.container,
      leaf_posture: obs.leaf_posture,
      leaf_texture_and_color: obs.leaf_texture_and_color,
      stem_posture: obs.stem_posture,
      soil_surface_color: obs.soil_surface_color,
      soil_surface_texture: obs.soil_surface_texture,
      soil_pulling_from_pot_edge: obs.soil_pulling_from_pot_edge,
      overwatering_signs: obs.overwatering_signs,
      lighting: obs.lighting,
      other_notes: obs.other_notes,
    },
  };
  if (deviceSoil) {
    state.on_device_soil_colour_measurement = {
      note: 'Rough measurement of the soil area by the phone; strongly affected by lighting.',
      estimated_dryness_percent: deviceSoil.dry,
      lightness_0_to_1: deviceSoil.L,
      saturation_0_to_1: deviceSoil.S,
    };
  }
  return state;
}

const JEV_ATTEMPTS = 3;

async function askJev(env, state) {
  const body = JSON.stringify({ model: env.JEV_MODEL || DEFAULT_JEV_MODEL, state, questions: QUESTIONS });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(JEV_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => '');
    const err = Object.assign(new Error(`Jev ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
    // only retry rate-limit / overload, and don't wait after the last attempt
    if ((res.status !== 429 && res.status !== 529) || attempt === JEV_ATTEMPTS) throw err;
    await new Promise(r => setTimeout(r, 400 * 2 ** (attempt - 1)));
  }
}

// ---------------------------------------------------------------- step 3: result

function scorePct(ans, levels) {
  const s = Number(ans?.score);
  if (!isFinite(s)) return null;
  return Math.round(Math.max(0, Math.min(1, s / (levels - 1))) * 100);
}
function noul(ans) { const v = Number(ans?.noul); return isFinite(v) ? v : null; }

export function toResult(obs, jevRes) {
  const a = jevRes?.answers || {};
  const need = scorePct(a.watering_need, QUESTIONS.watering_need.criteria.length);
  const wilting = scorePct(a.wilting, QUESTIONS.wilting.criteria.length);
  const soil = obs.soil_visible ? scorePct(a.soil_dryness, QUESTIONS.soil_dryness.criteria.length) : null;
  const over = noul(a.overwatered);
  const reliable = noul(a.photo_reliable);
  const pref = a.water_preference?.choice || 'unknown';
  const conf = Number(a.watering_need?.confidence);

  if (need === null) return unclearResult(obs, 'Jev returned no watering score.');

  let verdict = need >= 70 ? 'now' : need >= 40 ? 'soon' : 'not_needed';
  if (reliable !== null && reliable < 0.3) verdict = 'unclear';

  const reasons = [...obs.evidence_ja];
  if (over !== null && over >= 0.6) reasons.unshift('水のやりすぎのサインが見られます');

  return {
    need_percent: need,
    verdict,
    wilting,
    soil_dryness: soil,
    plant_guess: obs.plant_name_ja || obs.plant_name_en || '',
    reasons: reasons.slice(0, 3),
    advice: adviceFor(verdict, pref, over, obs),
    confidence: isFinite(conf) ? conf : reliable,
    plant_visible: obs.plant_visible,
    soil_visible: obs.soil_visible,
    source: 'jev',
    detail: {
      overwatered: over,
      photo_reliable: reliable,
      water_preference: pref,
      probabilities: a.watering_need?.probabilities || null,
    },
  };
}

function adviceFor(verdict, pref, over, obs) {
  if (verdict === 'unclear') return retakeAdvice(obs);
  if (over !== null && over >= 0.6) return '土が乾くまで水やりは控え、鉢底から水が抜けているか・受け皿に水が溜まっていないか確認しましょう。';
  const byPref = {
    dry_tolerant: '乾燥に強いタイプです。土が中まで完全に乾いてから、鉢底から流れるくらいたっぷりあげましょう。',
    moisture_loving: '水を好むタイプです。土の表面が乾き始めたら、鉢底から流れるくらいたっぷりあげましょう。',
    moderate: '土の表面から2〜3cmが乾いていたら、鉢底から流れるくらいたっぷりあげましょう。',
    unknown: '指で土を2〜3cm触って乾いていたら、鉢底から流れるくらいたっぷりあげましょう。',
  };
  if (verdict === 'now') return byPref[pref] || byPref.unknown;
  if (verdict === 'soon') return '1〜2日後にもう一度チェックしましょう。' + (pref === 'dry_tolerant' ? '乾燥に強いタイプなので急がなくて大丈夫です。' : '');
  return '今は水やり不要です。受け皿に溜まった水は捨てておきましょう。';
}

function retakeAdvice(obs) {
  const q = obs?.image_quality;
  if (q === 'dark') return '明るい場所で撮り直してください。';
  if (q === 'blurry') return 'ピントを合わせて、手ブレしないように撮り直してください。';
  if (q === 'too_far') return 'もう少し近づいて、葉と土の表面が大きく写るように撮り直してください。';
  if (q === 'too_close') return '少し離れて、植物全体と土の表面が一緒に写るように撮り直してください。';
  return '葉と土の表面が一緒に写るように撮り直してください。';
}

function unclearResult(obs, why) {
  return {
    need_percent: null, verdict: 'unclear', wilting: null, soil_dryness: null,
    plant_guess: obs?.plant_name_ja || '', reasons: obs?.evidence_ja || [],
    advice: retakeAdvice(obs), confidence: 0,
    plant_visible: !!obs?.plant_visible, soil_visible: !!obs?.soil_visible,
    source: 'jev', detail: { why },
  };
}

// ---------------------------------------------------------------- helpers

function parseDeviceSoil(v) {
  if (!v || typeof v !== 'string') return null;
  try {
    const o = JSON.parse(v);
    const n = x => (isFinite(Number(x)) ? Math.round(Number(x) * 1000) / 1000 : null);
    const dry = Number(o.dry);
    if (!isFinite(dry)) return null;
    return { dry: Math.round(Math.max(0, Math.min(1, dry)) * 100), L: n(o.L), S: n(o.S) };
  } catch { return null; }
}

// Returns an error response when the limiter says no (429) or fails (503), otherwise null.
async function limited(limiter, key) {
  try {
    if ((await limiter.limit({ key })).success) return null;
    return json({ error: 'rate_limited' }, 429);
  } catch (e) {
    console.error('rate limiter failed', e);
    return json({ error: 'unavailable' }, 503);
  }
}

// IPv6 clients usually own a whole /64, so limit per /64 rather than per address.
export function rateLimitKey(ip) {
  if (!ip) return 'unknown';
  ip = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, ''); // IPv4-mapped IPv6 → IPv4
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// Parses the multipart body, or returns null as soon as it exceeds max bytes (throws if malformed).
// Counts bytes as they stream into the parser: Content-Length is optional (chunked uploads), so the
// header alone can't be trusted.
// Reads the body as `as` ('formData' or 'text'), counting bytes as they arrive: null once it is over `max`.
async function readBodyCapped(request, max, as) {
  if (Number(request.headers.get('Content-Length')) > max) return null;
  let size = 0, tooBig = false;
  const counted = request.body?.pipeThrough(new TransformStream({
    transform(chunk, c) {
      size += chunk.byteLength;
      if (size > max) { tooBig = true; c.error(new Error('body too large')); } else c.enqueue(chunk);
    },
  }));
  try {
    return await new Response(counted, { headers: { 'Content-Type': request.headers.get('Content-Type') || '' } })[as]();
  } catch (e) {
    if (tooBig) return null;
    throw e;
  }
}

// siteverify error codes that mean our config, our request or Cloudflare is at fault, not the visitor's token.
const SITEVERIFY_OUR_FAULT = new Set(['missing-input-secret', 'invalid-input-secret', 'bad-request', 'internal-error']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Returns 'pass', 'reject' (bad token) or 'error' (siteverify unreachable / garbled / misconfigured:
// our problem, not the user's).
// Turnstile tokens are single-use; the page gets a fresh one per judgement.
// hostname must match the page that asked, so tokens minted on another site using this key are refused.
// Cloudflare's test keys always report hostname "example.com", so that one check is skipped when the
// Worker itself runs on localhost (wrangler dev). That is decided by the Worker's own URL, not by the
// client-controlled Origin, so a test secret deployed by mistake can't switch Turnstile off in production.
async function verifyTurnstile(env, token, ip, origin, url) {
  let host;
  try { host = new URL(origin).hostname; } catch { return 'reject'; } // e.g. Origin "null" allowed by mistake
  const workerIsLocal = LOCAL_HOSTS.has(url.hostname);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, ...(ip && { remoteip: ip }) }),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    const out = await res.json();
    const localTestKey = out.metadata?.result_with_testing_key === true && workerIsLocal;
    if (out.success === true && (out.hostname === host || localTestKey)) return 'pass';
    if (out['error-codes']?.some(c => SITEVERIFY_OUR_FAULT.has(c))) {
      console.error('turnstile siteverify refused our request', out['error-codes']);
      return 'error';
    }
    // Usually a bad token; these two usually mean a widget/hostname or test-key misconfiguration, so log them.
    if (out.success === true) console.warn('turnstile token for another host', { token_host: out.hostname, host, test_key: !!out.metadata?.result_with_testing_key });
    return 'reject';
  } catch (e) {
    console.error('turnstile verify failed', e);
    return 'error';
  }
}

// Not a security boundary on its own (non-browser clients can send any Origin);
// it keeps other sites' pages from using this endpoint. Browsers always send Origin on POST.
function originAllowed(origin, url, env) {
  if (!origin) return false;
  const extra = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return origin === url.origin || extra.includes(origin);
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Times the steps of one request. finish() adds the Server-Timing header, and logs the numbers if `log` was set.
// (In Workers the clock only advances across I/O, which is what these steps wait on.)
function stopwatch() {
  const start = performance.now();
  const ms = {};
  const after = [];
  return {
    log: false,
    onFinish(fn) { after.push(fn); },
    async time(name, fn) {
      const t = performance.now();
      try { return await fn(); } finally { ms[name] = Math.round(performance.now() - t); }
    },
    finish(res) {
      ms.total = Math.round(performance.now() - start);
      res.headers.set('Server-Timing', Object.entries(ms).map(([k, v]) => `${k};dur=${v}`).join(', '));
      if (this.log) console.log(JSON.stringify({ judge: { status: res.status, ms } }));
      for (const fn of after) fn(ms);
      return res;
    },
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
