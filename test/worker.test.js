// Runs with: npm test
// Mocks Workers AI, the rate limiter, Turnstile and the Jev API, so no keys or network are needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { extractJson, toResult, rateLimitKey, QUESTIONS, SITEVERIFY_TIMEOUT_MS } from '../src/worker.js';

const OBS = {
  plant_visible: true, soil_visible: true, image_quality: 'good',
  plant_name_en: 'Pothos', plant_name_ja: 'ポトス',
  leaf_posture: 'slightly drooping', soil_surface_color: 'pale, greyish',
  evidence_ja: ['土の表面が白っぽい', '葉が少し垂れている'],
};

function jevAnswer(needScore, extra = {}) {
  return {
    model: 'jev-1.13.0',
    answers: {
      watering_need: { type: 'score', score: needScore, confidence: 0.72, probabilities: [0, 0.05, 0.2, 0.5, 0.25] },
      wilting: { type: 'score', score: 1.2 },
      soil_dryness: { type: 'score', score: 3.1 },
      overwatered: { type: 'noul', noul: 0.05 },
      water_preference: { type: 'choice', choice: 'moderate' },
      photo_reliable: { type: 'noul', noul: 0.9 },
      ...extra,
    },
  };
}

// calls.precheck / calls.limit record PRECHECK_LIMITER (loose, before Turnstile) / JUDGE_LIMITER (strict, after)
function makeEnv({ obs = OBS, visionShape = 'response-object', allow = true, allowPrecheck = true } = {}) {
  const calls = { ai: [], precheck: [], limit: [] };
  return {
    calls,
    TYPESAFE_API_KEY: 'test-key',
    TURNSTILE_SECRET: 'ts-secret',
    TURNSTILE_SITE_KEY: 'ts-site',
    PRECHECK_LIMITER: { async limit(opts) { calls.precheck.push(opts); return { success: allowPrecheck }; } },
    JUDGE_LIMITER: { async limit(opts) { calls.limit.push(opts); return { success: allow }; } },
    AI: {
      async run(model, input) {
        calls.ai.push({ model, input });
        if (visionShape === 'openai') return { choices: [{ message: { content: '```json\n' + JSON.stringify(obs) + '\n```' } }] };
        if (visionShape === 'response-string') return { response: JSON.stringify(obs) };
        return { response: obs };
      },
    },
    ASSETS: { fetch: () => new Response('asset') },
  };
}

const SELF = 'https://mizukure.example.workers.dev';

const jpeg = bytes => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });

// A request as the page sends it: same Origin, client IP from Cloudflare, Turnstile token header.
function judgeRequest(fields = {}, headers = {}, image = jpeg(6), base = SELF) {
  const fd = new FormData();
  fd.append('image', image, 'p.jpg');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request(`${base}/api/judge`, {
    method: 'POST', body: fd,
    headers: { Origin: base, 'CF-Connecting-IP': '203.0.113.7', 'X-Turnstile-Token': 'ts-token', ...headers },
  });
}

const noJev = () => { throw new Error('Jev should not be called'); };

const REAL_FETCH = globalThis.fetch;

// Replaces fetch for the rest of test `t` (restored afterwards). Routes outgoing fetches: Turnstile siteverify → `turnstile`, everything else → Jev `handler`.
function mockFetch(t, handler, { turnstile = { success: true, hostname: 'mizukure.example.workers.dev' } } = {}) {
  const seen = [], tsSeen = [];
  globalThis.fetch = async (url, init) => {
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      tsSeen.push(JSON.parse(init.body));
      return typeof turnstile === 'function' ? turnstile(init) : Response.json(turnstile);
    }
    seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return handler(seen.length);
  };
  t.after(() => { globalThis.fetch = REAL_FETCH; });
  return { seen, tsSeen };
}

test('full flow: vision → Jev → page result', async (t) => {
  const env = makeEnv();
  const jev = mockFetch(t, () => Response.json(jevAnswer(3.1)));
  const res = await worker.fetch(judgeRequest({ kind: 'ポトス', device_soil: JSON.stringify({ dry: 0.66, L: 0.41, S: 0.2 }) }), env);
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.need_percent, 78);          // 3.1 / 4
  assert.equal(r.verdict, 'now');
  assert.equal(r.soil_dryness, 78);
  assert.equal(r.wilting, 40);               // 1.2 / 3
  assert.equal(r.plant_guess, 'ポトス');
  assert.equal(r.confidence, 0.72);
  assert.ok(r.advice.includes('2〜3cm'));

  // vision call got the image as a data URL
  const content = env.calls.ai[0].input.messages[0].content;
  assert.match(content[1].image_url.url, /^data:image\/jpeg;base64,/);

  // Jev call shape
  const { url, body, headers } = jev.seen[0];
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(headers.Authorization, 'Bearer test-key');
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(Object.keys(body.questions), Object.keys(QUESTIONS));
  assert.equal(body.state.owner_says_plant_is, 'ポトス');
  assert.equal(body.state.on_device_soil_colour_measurement.estimated_dryness_percent, 66);
});

test('retries Jev on 429 then succeeds', async (t) => {
  const jev = mockFetch(t, n => (n === 1 ? new Response('slow down', { status: 429 }) : Response.json(jevAnswer(0.4))));
  const r = await (await worker.fetch(judgeRequest(), makeEnv())).json();
  assert.equal(jev.seen.length, 2);
  assert.equal(r.verdict, 'not_needed');
});

test('Jev throttled or overloaded (429/529 on every retry) → 503 unavailable, not the user\'s rate_limited', async (t) => {
  // backs off 400 then 800 ms, with no wait after the last attempt
  const realSetTimeout = globalThis.setTimeout;
  let delays;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => { delays.push(ms); return realSetTimeout(fn, 0, ...args); });
  for (const status of [429, 529]) {
    delays = [];
    const jev = mockFetch(t, () => new Response('busy', { status }));
    const res = await worker.fetch(judgeRequest(), makeEnv());
    assert.equal(res.status, 503, status);
    assert.equal((await res.json()).error, 'unavailable', status);
    assert.equal(jev.seen.length, 3, status);
    assert.deepEqual(delays, [400, 800], status);
  }
});

test('Server-Timing header and log line carry per-step timings', async (t) => {
  const logs = t.mock.method(console, 'log', () => {});
  mockFetch(t, () => Response.json(jevAnswer(2)));
  const res = await worker.fetch(judgeRequest(), makeEnv());
  assert.equal(res.status, 200);
  const header = res.headers.get('Server-Timing');
  assert.match(header, /^turnstile;dur=\d+, upload;dur=\d+, vision;dur=\d+, jev;dur=\d+, total;dur=\d+$/);
  assert.equal(logs.mock.callCount(), 1);
  const line = JSON.parse(logs.mock.calls[0].arguments[0]);
  assert.equal(line.judge.status, 200);
  assert.deepEqual(Object.keys(line.judge.ms), ['turnstile', 'upload', 'vision', 'jev', 'total']);

  // a refusal still reports the steps it reached in the header, but isn't logged (junk shouldn't fill the logs)
  const refused = await worker.fetch(judgeRequest({}, { Origin: 'https://evil.example' }), makeEnv());
  assert.equal(refused.status, 403);
  assert.match(refused.headers.get('Server-Timing'), /^total;dur=\d+$/);
  mockFetch(t, noJev, { turnstile: { success: false } });
  const junk = await worker.fetch(judgeRequest(), makeEnv());
  assert.equal(junk.status, 403);
  assert.match(junk.headers.get('Server-Timing'), /^turnstile;dur=\d+, total;dur=\d+$/);
  assert.equal(logs.mock.callCount(), 1);
});

test('Jev 401 → jev_failed without retry', async (t) => {
  const jev = mockFetch(t, () => new Response('bad key', { status: 401 }));
  const res = await worker.fetch(judgeRequest(), makeEnv());
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'jev_failed');
  assert.equal(jev.seen.length, 1);
});

test('no plant and no soil → unclear, Jev not called', async (t) => {
  const jev = mockFetch(t, noJev);
  const env = makeEnv({ obs: { ...OBS, plant_visible: false, soil_visible: false, image_quality: 'dark' } });
  const r = await (await worker.fetch(judgeRequest(), env)).json();
  assert.equal(r.verdict, 'unclear');
  assert.equal(r.need_percent, null);
  assert.ok(r.advice.includes('明るい'));
  assert.equal(jev.seen.length, 0);
});

test('low photo_reliable → unclear; overwatering flagged', () => {
  assert.equal(toResult(OBS, jevAnswer(2, { photo_reliable: { noul: 0.1 } })).verdict, 'unclear');
  const r = toResult(OBS, jevAnswer(0.5, { overwatered: { noul: 0.8 } }));
  assert.equal(r.reasons[0], '水のやりすぎのサインが見られます');
  assert.ok(r.advice.includes('控え'));
});

test('extractJson handles several Workers AI response shapes', () => {
  assert.deepEqual(extractJson({ response: { a: 1 } }), { a: 1 });
  assert.deepEqual(extractJson({ response: '{"a":1}' }), { a: 1 });
  assert.deepEqual(extractJson({ response: 'Sure! {"a":1} done' }), { a: 1 });
  assert.deepEqual(extractJson({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] }), { a: 1 });
  assert.equal(extractJson({ response: 'no json' }), null);
});

test('rejects wrong method, cross-origin, missing Origin, bad image type', async (t) => {
  const env = makeEnv();
  const ts = mockFetch(t, noJev);
  assert.equal((await worker.fetch(new Request(`${SELF}/api/judge`), env)).status, 405);
  // cross-origin and curl-style (no Origin) requests stop at the Origin check, before anything else
  const noOrigin = judgeRequest();
  noOrigin.headers.delete('Origin');
  for (const req of [judgeRequest({}, { Origin: 'https://evil.example' }), noOrigin]) {
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'forbidden');
  }
  assert.equal(env.calls.precheck.length, 0);
  assert.equal(env.calls.limit.length, 0);
  assert.equal(ts.tsSeen.length, 0);

  const fd = new FormData();
  fd.append('image', new Blob(['x'], { type: 'image/gif' }), 'a.gif');
  const res = await worker.fetch(new Request(`${SELF}/api/judge`, {
    method: 'POST', body: fd, headers: { Origin: SELF, 'X-Turnstile-Token': 'ts-token' },
  }), env);
  assert.equal(res.status, 415);
});

test('rate limited per client (IPv6 /64) → 429 before any paid call', async (t) => {
  const env = makeEnv({ allow: false });
  mockFetch(t, noJev);
  const res = await worker.fetch(judgeRequest({}, { 'CF-Connecting-IP': '2001:db8:1:2:aaaa::1' }), env);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'rate_limited');
  assert.deepEqual(env.calls.limit, [{ key: '2001:db8:1:2::/64' }]);
  assert.equal(env.calls.ai.length, 0);
});

test('junk tokens don\'t count toward the strict per-IP limit (only the loose precheck sees them)', async (t) => {
  const env = makeEnv();
  const jev = mockFetch(t, noJev, { turnstile: { success: false, 'error-codes': ['invalid-input-response'] } });
  for (let i = 0; i < 3; i++) assert.equal((await worker.fetch(judgeRequest(), env)).status, 403);
  assert.equal(jev.tsSeen.length, 3);
  assert.equal(env.calls.precheck.length, 3);   // the loose limit still sees them
  assert.equal(env.calls.limit.length, 0);
});

test('a junk-token flood from one IP is capped by the loose limit before siteverify is asked', async (t) => {
  const env = makeEnv({ allowPrecheck: false });
  const jev = mockFetch(t, noJev);
  const res = await worker.fetch(judgeRequest({}, { 'CF-Connecting-IP': '2001:db8:1:2:aaaa::1' }), env);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'rate_limited');
  assert.deepEqual(env.calls.precheck, [{ key: '2001:db8:1:2::/64' }]);
  assert.equal(jev.tsSeen.length, 0);
  assert.equal(env.calls.limit.length, 0);
});

test('Turnstile: token is verified server-side; anything but a clean pass → 403, no paid call', async (t) => {
  const rejects = {
    'siteverify says no': { success: false, hostname: 'mizukure.example.workers.dev' },
    'expired or reused token': { success: false, 'error-codes': ['timeout-or-duplicate'] },
    'failing test key': { success: false, hostname: 'example.com', metadata: { result_with_testing_key: true } },
    'test key used in production': { success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } },
    'truthy but not true': { success: 'true', hostname: 'mizukure.example.workers.dev' },
    'token minted for another site': { success: true, hostname: 'evil.example' },
  };
  for (const [name, turnstile] of Object.entries(rejects)) {
    const env = makeEnv();
    const jev = mockFetch(t, noJev, { turnstile });
    const res = await worker.fetch(judgeRequest(), env);
    assert.equal(res.status, 403, name);
    assert.equal((await res.json()).error, 'turnstile_failed', name);
    assert.deepEqual(jev.tsSeen, [{ secret: 'ts-secret', response: 'ts-token', remoteip: '203.0.113.7' }], name);
    assert.equal(env.calls.ai.length, 0, name);
  }

  // no token, or longer than any real token (2048 chars): refused without asking siteverify
  const env = makeEnv();
  const jev = mockFetch(t, noJev);
  const noToken = judgeRequest();
  noToken.headers.delete('X-Turnstile-Token');
  for (const req of [noToken, judgeRequest({}, { 'X-Turnstile-Token': 'x'.repeat(2049) })]) {
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'turnstile_failed');
  }
  assert.equal(jev.tsSeen.length, 0);
  assert.equal(env.calls.precheck.length, 0);
  assert.equal(env.calls.limit.length, 0);
  assert.equal(env.calls.ai.length, 0);

  // a real-length token is passed through; no client IP → no remoteip sent (siteverify rejects an empty one)
  const env2 = makeEnv();
  const jev2 = mockFetch(t, () => Response.json(jevAnswer(2)));
  const req = judgeRequest({}, { 'X-Turnstile-Token': 't'.repeat(2048) });
  req.headers.delete('CF-Connecting-IP');
  assert.equal((await worker.fetch(req, env2)).status, 200);
  assert.deepEqual(jev2.tsSeen, [{ secret: 'ts-secret', response: 't'.repeat(2048) }]);
});

test('Turnstile test keys (hostname example.com) pass only when the Worker runs on localhost; hostname comes from Origin', async (t) => {
  // a test secret deployed to production can't be unlocked by a client claiming a localhost Origin
  const prod = { ...makeEnv(), ALLOWED_ORIGINS: 'http://localhost:8787' };
  mockFetch(t, noJev, {
    turnstile: { success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } },
  });
  assert.equal((await worker.fetch(judgeRequest({}, { Origin: 'http://localhost:8787' }), prod)).status, 403);

  for (const local of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    const env = makeEnv();
    mockFetch(t, () => Response.json(jevAnswer(2)), {
      turnstile: { success: true, hostname: 'example.com', metadata: { result_with_testing_key: 'yes' } },
    });
    // truthy-but-not-true metadata is not a test-key result
    assert.equal((await worker.fetch(judgeRequest({}, {}, undefined, local), env)).status, 403, local);
    mockFetch(t, () => Response.json(jevAnswer(2)), {
      turnstile: { success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } },
    });
    assert.equal((await worker.fetch(judgeRequest({}, {}, undefined, local), env)).status, 200, local);
    // the always-fail test key still fails on localhost
    mockFetch(t, noJev, {
      turnstile: { success: false, hostname: 'example.com', metadata: { result_with_testing_key: true } },
    });
    assert.equal((await worker.fetch(judgeRequest({}, {}, undefined, local), env)).status, 403, local);
  }

  // a token for the other allowed origin is accepted only when that origin is the one asking
  // (entries may be written with spaces after the commas)
  const env2 = { ...makeEnv(), ALLOWED_ORIGINS: 'https://a.example, https://other.example' };
  mockFetch(t, () => Response.json(jevAnswer(2)), { turnstile: { success: true, hostname: 'other.example' } });
  assert.equal((await worker.fetch(judgeRequest({}, { Origin: 'https://other.example' }), env2)).status, 200);
  assert.equal((await worker.fetch(judgeRequest(), env2)).status, 403);
});

test('an unparseable Origin allowed by mistake (e.g. "null") → 403, not an outage', async (t) => {
  const env = { ...makeEnv(), ALLOWED_ORIGINS: 'null' };
  mockFetch(t, noJev);
  const res = await worker.fetch(judgeRequest({}, { Origin: 'null' }), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'turnstile_failed');
  assert.equal(env.calls.ai.length, 0);
});

test('the strict limit counts only valid photos about to be judged (a rejected photo costs no quota)', async (t) => {
  const env = makeEnv();
  mockFetch(t, noJev);
  const res = await worker.fetch(judgeRequest({}, {}, new Blob(['x'], { type: 'image/gif' })), env);
  assert.equal(res.status, 415);
  assert.equal(env.calls.precheck.length, 1);
  assert.equal(env.calls.limit.length, 0);
});

test('a malformed limiter answer counts as "limited" (fails closed)', async (t) => {
  for (const name of ['PRECHECK_LIMITER', 'JUDGE_LIMITER']) {
    const env = makeEnv();
    env[name] = { async limit() { return {}; } };
    mockFetch(t, noJev);
    assert.equal((await worker.fetch(judgeRequest(), env)).status, 429, name);
    assert.equal(env.calls.ai.length, 0, name);
  }
});

test('rate limiter failure (either one) → 503 JSON, no paid call', async (t) => {
  for (const name of ['PRECHECK_LIMITER', 'JUDGE_LIMITER']) {
    const env = makeEnv();
    env[name] = { async limit() { throw new Error('binding down'); } };
    mockFetch(t, noJev);
    const res = await worker.fetch(judgeRequest(), env);
    assert.equal(res.status, 503, name);
    assert.equal((await res.json()).error, 'unavailable', name);
    assert.equal(env.calls.ai.length, 0, name);
  }
});

test('siteverify down, misconfigured, garbled or hanging → 503 unavailable (not the user\'s fault), no paid call', { timeout: 15000 }, async (t) => {
  const outages = {
    'wrong secret configured': { success: false, 'error-codes': ['invalid-input-secret'] },
    'Cloudflare internal error': { success: false, 'error-codes': ['internal-error'] },
    'our request was malformed': { success: false, 'error-codes': ['bad-request'] },
    unreachable: () => { throw new TypeError('network down'); },
    'non-JSON': () => new Response('<html>oops</html>', { status: 502 }),
    // never answers: only the request's own timeout signal can end it
    // (Node's AbortSignal.timeout doesn't hold the event loop open, so keep it alive meanwhile)
    hanging: init => new Promise((_, reject) => {
      const alive = setTimeout(() => {}, 60000);
      init.signal?.addEventListener('abort', () => { clearTimeout(alive); reject(init.signal.reason); });
    }),
  };
  for (const [name, turnstile] of Object.entries(outages)) {
    const env = makeEnv();
    mockFetch(t, noJev, { turnstile });
    const started = Date.now();
    const res = await worker.fetch(judgeRequest(), env);
    assert.equal(res.status, 503, name);
    assert.equal((await res.json()).error, 'unavailable', name);
    assert.ok(Date.now() - started < SITEVERIFY_TIMEOUT_MS + 2000, name);
    assert.equal(env.calls.ai.length, 0, name);
  }
});

test('oversized body is refused, with or without Content-Length, without reading it all', async (t) => {
  const env = makeEnv();
  mockFetch(t, noJev);
  // declared size: refused without reading anything
  let res = await worker.fetch(judgeRequest({}, { 'Content-Length': String(50 * 1024 * 1024) }), env);
  assert.equal(res.status, 413);

  // chunked upload (no Content-Length): refused once the running byte count passes the cap
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream({ pull(c) { pulled++; if (pulled > 50) c.close(); else c.enqueue(chunk); } });
  const req = new Request(`${SELF}/api/judge`, {
    method: 'POST', body, duplex: 'half',
    headers: { Origin: SELF, 'X-Turnstile-Token': 'ts-token', 'Content-Type': 'multipart/form-data; boundary=x' },
  });
  assert.equal(req.headers.get('Content-Length'), null);
  res = await worker.fetch(req, env);
  assert.equal(res.status, 413);
  // 1 MB chunks: the 5th crosses the ~4.06 MB cap; the stream may have pre-fetched one more
  assert.ok(pulled <= 6, `stopped reading at the cap (pulled ${pulled} MB)`);
  assert.equal(env.calls.ai.length, 0);
});

test('a photo right at the 4 MB limit is accepted; 1 byte over is refused', async (t) => {
  const MB4 = 4 * 1024 * 1024;
  mockFetch(t, () => Response.json(jevAnswer(2)));
  assert.equal((await worker.fetch(judgeRequest({ kind: 'ポトス' }, {}, jpeg(MB4)), makeEnv())).status, 200);
  const env = makeEnv();
  const res = await worker.fetch(judgeRequest({}, {}, jpeg(MB4 + 1)), env);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'image_too_large');
  assert.equal(env.calls.limit.length, 0);   // a refused photo costs no quota
});

test('Turnstile is verified before the photo is read', async (t) => {
  const env = makeEnv();
  let pulled = 0, pulledAtVerify = null;
  mockFetch(t, noJev, { turnstile: () => { pulledAtVerify = pulled; return Response.json({ success: false }); } });
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(10)); } }, { highWaterMark: 0 });
  const res = await worker.fetch(new Request(`${SELF}/api/judge`, {
    method: 'POST', body, duplex: 'half', headers: { Origin: SELF, 'X-Turnstile-Token': 'ts-token' },
  }), env);
  assert.equal(res.status, 403);
  assert.equal(pulledAtVerify, 0, 'body was read before Turnstile');
  assert.equal(pulled, 0, 'a rejected caller\'s body is never read');
});

test('a client dropping mid-upload → 400, no paid call', async (t) => {
  const env = makeEnv();
  mockFetch(t, noJev);
  let sent = 0;
  const body = new ReadableStream({ pull(c) { if (sent++ < 2) c.enqueue(new Uint8Array(1024)); else c.error(new Error('client aborted')); } });
  const res = await worker.fetch(new Request(`${SELF}/api/judge`, {
    method: 'POST', body, duplex: 'half',
    headers: { Origin: SELF, 'X-Turnstile-Token': 'ts-token', 'Content-Type': 'multipart/form-data; boundary=x' },
  }), env);
  assert.equal(res.status, 400);
  assert.equal(env.calls.ai.length, 0);
});

test('any missing config → not_configured (fails closed), nothing called', async (t) => {
  const jev = mockFetch(t, noJev);
  for (const key of ['TYPESAFE_API_KEY', 'AI', 'PRECHECK_LIMITER', 'JUDGE_LIMITER', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET']) {
    const env = makeEnv();
    delete env[key];
    const res = await worker.fetch(judgeRequest(), env);
    assert.equal(res.status, 500, key);
    assert.equal((await res.json()).error, 'not_configured', key);
    assert.equal(jev.tsSeen.length, 0, key);
    assert.equal(env.calls.precheck.length + env.calls.limit.length, 0, key);
    assert.equal(env.calls.ai.length, 0, key);
  }
});

test('rate limit key: IPv4 as is, IPv6 per /64, missing IP shares one bucket', () => {
  assert.equal(rateLimitKey('203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:DB8:0001:0002::9'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('fe80::1:2:3:4:5'), 'fe80:0:0:1::/64');
  assert.equal(rateLimitKey('2001:db8::'), '2001:db8:0:0::/64');
  assert.equal(rateLimitKey('::ffff:198.51.100.9'), '198.51.100.9');
  // hex-form mapped addresses aren't normalised (Cloudflare sends the dotted form); they just share a bucket
  assert.equal(rateLimitKey('::ffff:abcd:1'), '0:0:0:0::/64');
  assert.equal(rateLimitKey(''), 'unknown');
});

test('/api/health reports the Turnstile and rate-limit config', async (t) => {
  const env = makeEnv();
  delete env.TURNSTILE_SECRET;
  const r = await (await worker.fetch(new Request(`${SELF}/api/health`), env)).json();
  assert.deepEqual(r, { ok: false, jev: true, ai: true, turnstile: false, rate_limit: true });
  assert.equal((await (await worker.fetch(new Request(`${SELF}/api/health`), makeEnv())).json()).ok, true);

  const env2 = makeEnv();
  delete env2.PRECHECK_LIMITER;
  const r2 = await (await worker.fetch(new Request(`${SELF}/api/health`), env2)).json();
  assert.equal(r2.rate_limit, false);
});

test('/api/config exposes the public Turnstile site key and the photo size limit', async (t) => {
  const r = await (await worker.fetch(new Request(`${SELF}/api/config`), makeEnv())).json();
  assert.deepEqual(r, { turnstile_site_key: 'ts-site', max_image_bytes: 4 * 1024 * 1024 });
});

test('non-API paths are served from static assets', async (t) => {
  const res = await worker.fetch(new Request('https://x.dev/'), makeEnv());
  assert.equal(await res.text(), 'asset');
});
