'use strict';
/*
 * THE REFRAME'S EYE (src/main/cloudsee.js) against a fake provider.
 *
 * What a free account really does to a request, measured on the church's own
 * Groq key while this was built, replayed here so each case is exact:
 *
 *   - 429 with "try again in 25s" when the per-minute allowance is used up:
 *     wait and ask again, because the export is waiting for this short anyway
 *   - a model that cannot take pictures, or has been retired: the next one
 *   - "too many images" (a 400 that is OUR fault): stop, say so
 *   - an answer about frames it was not asked about, or numbers past the
 *     last box: ignored / treated as "nobody"
 *   - no key: say what to do, never call out
 *
 *   node test/cloudsee.test.js
 */
const cloudwrite = require('../src/main/cloudwrite');
const cloudsee = require('../src/main/cloudsee');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d !== undefined ? '  -> ' + d : '')); c ? pass++ : fail++; };

const IMG = 'data:image/jpeg;base64,' + Buffer.from('not really a jpeg').toString('base64');
const FRAMES = [{ label: 'A' }, { label: 'B' }];   // each ruled into 8 columns (the default)
let calls = [];
let script = [];   // what the fake provider says, in order
const MODELS = ['allam-2-7b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'whisper-large-v3'];
function reply(status, body, headers) {
  return { ok: status >= 200 && status < 300, status,
    headers: { get: (h) => (headers || {})[h.toLowerCase()] || null },
    json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
global.fetch = async (url, init) => {
  if (/\/models$/.test(url)) return reply(200, { data: MODELS.map((id) => ({ id })) });
  const body = JSON.parse(init.body);
  calls.push({ model: body.model, json: !!body.response_format, effort: body.reasoning_effort, images: body.messages[1].content.filter((c) => c.type === 'image_url').length, system: body.messages[0].content });
  const next = script.shift();
  return typeof next === 'function' ? next(body) : next;
};
const ok = (answer) => reply(200, { choices: [{ message: { content: typeof answer === 'string' ? answer : JSON.stringify(answer) } }] });

(async () => {
  console.log('\n[1] No key');
  cloudwrite.configure({ provider: 'groq', key: '' });
  cloudwrite.shareKey('groq', '');
  calls = [];
  const none = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES });
  check('says what to do instead of calling out', !none.ok && /key/i.test(none.why) && calls.length === 0, none.why);
  check('and the state says it is not ready', cloudsee.state().ready === false);

  console.log('\n[2] The ordinary answer');
  cloudwrite.shareKey('groq', 'gsk_test');   // the Listen key, borrowed — no key of its own
  check('the Listen key is enough: ready', cloudsee.state().ready === true);
  calls = [];
  script = [ok({ frames: [{ frame: 'A', column: 6, sure: true }, { frame: 'B', column: 0, sure: true }] })];
  const r = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES });
  check('answers per frame: a column, or 0 for "cannot see him"', r.ok && r.answers.A.column === 6 && r.answers.B.column === 0, JSON.stringify(r.answers));
  check('asked the vision model, with one picture, JSON, no thinking', calls[0].model === 'qwen/qwen3.8-27b' && calls[0].images === 1 && calls[0].json && calls[0].effort === 'none', JSON.stringify(Object.assign({}, calls[0], { system: undefined })));
  check('…about COLUMNS, not boxes (boxes were measured and dropped)', /8 equal vertical columns/.test(calls[0].system) && !/box/i.test(calls[0].system));

  console.log('\n[3] Answers that do not fit the question');
  script = [ok('Sure! ```json\n{"frames":[{"frame":"a","column":3},{"frame":"B","column":11},{"frame":"Z","column":1}]}\n```')];
  const odd = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES });
  check('JSON inside prose and a fence is still read; a lower-case letter is the same frame', odd.ok && odd.answers.A.column === 3, JSON.stringify(odd.answers));
  check('a column past the last is no answer at all — neither "there" nor "nobody"', !('B' in odd.answers));
  check('a frame it was not asked about is ignored', !('Z' in odd.answers));

  console.log('\n[4] The free allowance runs out');
  calls = [];
  script = [reply(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '1' }),
    ok({ frames: [{ frame: 'A', column: 4 }, { frame: 'B', column: 4 }] })];
  const t0 = Date.now();
  const waited = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES });
  const ms = Date.now() - t0;
  check('it waits as long as it is told and asks again', waited.ok && calls.length === 2 && ms >= 1000 && ms < 4000, ms + ' ms, ' + calls.length + ' calls');
  calls = [];
  script = [reply(429, {}, { 'retry-after': '120' }), ok({ frames: [{ frame: 'A', column: 4 }] })];
  const t1 = Date.now();
  const tooLong = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES, maxWaitMs: 5000 });
  check('a wait longer than the short is worth moves on rather than hanging', Date.now() - t1 < 3000 && calls.length >= 1, (Date.now() - t1) + ' ms, then ' + (tooLong.ok ? 'answered by ' + tooLong.model : tooLong.why));
  cloudsee._blocked().clear();

  calls = [];
  script = [reply(503, { error: { message: 'qwen/qwen3.8-27b is currently over capacity. Please try again and back off exponentially.' } }),
    ok({ frames: [{ frame: 'A', column: 4 }] })];
  const t2 = Date.now();
  const busy = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES });
  check('"over capacity" (seen on the free tier) is waited out, not given up on', busy.ok && calls.length === 2 && Date.now() - t2 >= 2500,
    (Date.now() - t2) + ' ms, ' + calls.length + ' calls');

  // The DAILY cap (200,000 tokens on the free vision model), measured: it
  // answers "try again in 8m21s". The next short must say THAT — not "no model
  // here can look at pictures", which is what it said when the only vision
  // model was parked until its allowance came back.
  cloudsee._blocked().clear();
  calls = [];
  const tpd = () => reply(429, { error: { message: 'Rate limit reached on tokens per day (TPD): Limit 200000, Used 198541. Please try again in 8m21.984s.' } }, { 'retry-after': '502' });
  script = [tpd(), tpd()];   // both vision models on the (fake) account
  const daily = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES, maxWaitMs: 5000 });
  check('a used-up DAILY allowance says so, and when it comes back', !daily.ok && /daily/.test(daily.why) && /9 min/.test(daily.why), daily.why);
  const next = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES, maxWaitMs: 5000 });
  check('…and so does the next short, without asking again', !next.ok && /daily/.test(next.why) && calls.length === 2, next.why + ' (' + calls.length + ' calls in all)');
  cloudsee._blocked().clear();

  console.log('\n[5] A model that cannot look at pictures');
  calls = [];
  script = [reply(400, { error: { message: 'this model does not support image input' } }), ok({ frames: [{ frame: 'A', column: 4 }] })];
  const blind = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES });
  check('the next model on the ladder is asked', blind.ok && calls.length === 2 && calls[0].model !== calls[1].model, calls.map((c) => c.model).join(' -> '));
  const blindOne = calls[0].model;
  calls = [];
  script = [ok({ frames: [{ frame: 'A', column: 4 }] })];
  await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES });
  check('…and the blind one is not asked again', calls[0].model !== blindOne, blindOne + ' skipped, asked ' + calls[0].model);
  cloudsee._blocked().clear();

  console.log('\n[6] Our own mistake is not the model\'s');
  calls = [];
  script = [reply(400, { error: { message: 'Too many images provided. This model supports up to 3 images' } })];
  const ours = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES });
  check('stops and says why, without walking the ladder', !ours.ok && calls.length === 1 && /400/.test(ours.why), ours.why);

  console.log('\n[7] A refused key, and a network that is down');
  script = [reply(401, { error: { message: 'Invalid API Key' } })];
  const refused = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES });
  check('a refused key says so', !refused.ok && /refused/.test(refused.why), refused.why);
  const realFetch = global.fetch;
  global.fetch = async (url) => { if (/\/models$/.test(url)) return reply(200, { data: MODELS.map((id) => ({ id })) }); throw new TypeError('fetch failed'); };
  const offline = await cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES });
  check('no internet says so', !offline.ok && /reach/.test(offline.why), offline.why);
  global.fetch = realFetch;

  console.log('\n[8] One question at a time');
  calls = [];
  let inFlight = 0, most = 0;
  const slow = () => { inFlight++; most = Math.max(most, inFlight); return new Promise((res) => setTimeout(() => { inFlight--; res(ok({ frames: [{ frame: 'A', column: 4 }] })); }, 80)); };
  script = [slow, slow, slow];
  const all = await Promise.all([1, 2, 3].map(() => cloudsee.whoIsSpeaking({ image: IMG, frames: FRAMES })));
  check('three shorts asking at once are asked one after another', all.every((x) => x.ok) && most === 1, 'most at once: ' + most);

  console.log('\n[8b] Where are the people? (the Viral Montage)');
  calls = [];
  script = [ok({ frames: [{ frame: 'A', people: 2, column: 3, sure: true }, { frame: 'B', people: 0, sure: true }] })];
  const pp = await cloudsee.whereArePeople({ image: IMG, frames: FRAMES });
  check('counts the people, and "people: 0" with no column is still an answer: nobody there', pp.ok && pp.answers.A.people === 2 && pp.answers.A.column === 3 && pp.answers.B && pp.answers.B.people === 0 && pp.answers.B.column === 0, JSON.stringify(pp.answers));
  check('…asked as a people question: title graphics and screens count as nobody', /people/.test(calls[0].system) && /title graphic/.test(calls[0].system));
  calls = [];
  script = [ok({ frames: [{ frame: 'A', people: 0, column: 5 }] })];
  const p0 = await cloudsee.whereArePeople({ image: IMG, frames: FRAMES });
  check('nobody there wins over a column given anyway', p0.ok && p0.answers.A.people === 0 && p0.answers.A.column === 0, JSON.stringify(p0.answers));

  console.log('\n[9] Bad input');
  const bad = await cloudsee.whoIsSpeaking({ image: 'C:/not-a-data-url.jpg', frames: FRAMES });
  check('a picture that is not a data URL is refused before any call', !bad.ok, bad.why);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
