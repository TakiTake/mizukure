// Runs with: node --test test/
// Mocks Workers AI and the Jev API, so no keys or network are needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { extractJson, toResult, QUESTIONS } from '../src/worker.js';

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

function makeEnv({ obs = OBS, visionShape = 'response-object' } = {}) {
  const calls = { ai: [] };
  return {
    calls,
    TYPESAFE_API_KEY: 'test-key',
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

function judgeRequest(fields = {}, headers = {}) {
  const fd = new FormData();
  fd.append('image', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: 'image/jpeg' }), 'p.jpg');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request('https://mizukure.example.workers.dev/api/judge', { method: 'POST', body: fd, headers });
}

function mockJev(handler) {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url, body: JSON.parse(init.body), headers: init.headers }); return handler(seen.length); };
  return { seen, restore: () => { globalThis.fetch = orig; } };
}

test('full flow: vision → Jev → page result', async () => {
  const env = makeEnv();
  const jev = mockJev(() => Response.json(jevAnswer(3.1)));
  try {
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
  } finally { jev.restore(); }
});

test('retries Jev on 429 then succeeds', async () => {
  const jev = mockJev(n => (n === 1 ? new Response('slow down', { status: 429 }) : Response.json(jevAnswer(0.4))));
  try {
    const r = await (await worker.fetch(judgeRequest(), makeEnv())).json();
    assert.equal(jev.seen.length, 2);
    assert.equal(r.verdict, 'not_needed');
  } finally { jev.restore(); }
});

test('Jev 401 → jev_failed without retry', async () => {
  const jev = mockJev(() => new Response('bad key', { status: 401 }));
  try {
    const res = await worker.fetch(judgeRequest(), makeEnv());
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'jev_failed');
    assert.equal(jev.seen.length, 1);
  } finally { jev.restore(); }
});

test('no plant and no soil → unclear, Jev not called', async () => {
  const jev = mockJev(() => { throw new Error('should not be called'); });
  try {
    const env = makeEnv({ obs: { ...OBS, plant_visible: false, soil_visible: false, image_quality: 'dark' } });
    const r = await (await worker.fetch(judgeRequest(), env)).json();
    assert.equal(r.verdict, 'unclear');
    assert.equal(r.need_percent, null);
    assert.ok(r.advice.includes('明るい'));
    assert.equal(jev.seen.length, 0);
  } finally { jev.restore(); }
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

test('rejects wrong method, cross-origin, bad image type', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(new Request('https://x.dev/api/judge'), env)).status, 405);
  assert.equal((await worker.fetch(judgeRequest({}, { Origin: 'https://evil.example' }), env)).status, 403);
  const fd = new FormData();
  fd.append('image', new Blob(['x'], { type: 'image/gif' }), 'a.gif');
  const res = await worker.fetch(new Request('https://x.dev/api/judge', { method: 'POST', body: fd }), env);
  assert.equal(res.status, 415);
});

test('non-API paths are served from static assets', async () => {
  const res = await worker.fetch(new Request('https://x.dev/'), makeEnv());
  assert.equal(await res.text(), 'asset');
});
