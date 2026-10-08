'use strict';
/*
 * A THIRD EAR THAT IS NOT WHISPER — so a mishearing both Whisper ears share
 * can still be caught (geminiear.js + captionfuse.js, wired in main.js).
 *
 * Measured on a real sermon: both Whisper ears wrote "attract God on the
 * same" where the preacher said "on the scene". Two ears that share a blind
 * spot cannot point at it; a third, different one can.
 *   [1] two of three: Gemini and the second ear agree against the first — theirs
 *   [2] both Whisper ears agree, Gemini differs — asked of a reader, not decided here
 *   [3] what Gemini left out, or only Gemini heard, never changes a caption
 *   [4] the same words written another way (gonna / going to, 3 / three, um) are not a mishearing
 *   [5] the new words keep the sentence's punctuation and sit inside the old ones' time
 *   [6] the reader's picks are read back safely
 *   [7] Gemini: the best free model is used; a model whose day is used up is set aside
 *   [8] end to end: the studio's own captions:transcribe, with fake Groq + Gemini
 *
 *   node test/caption-third.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fuse = require(path.join(ROOT, 'src/main/captionfuse'));
const gem = require(path.join(ROOT, 'src/main/geminiear'));
let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${m}${d != null && !c ? '  -> ' + JSON.stringify(d) : ''}`); };
/** words of `txt`, one every 0.4 s from t0 */
const WS = (txt, t0 = 1.2) => txt.split(' ').map((x, i) => ({ text: x, start: +(t0 + i * 0.4).toFixed(2), end: +(t0 + i * 0.4 + 0.35).toFixed(2) }));
const CH = (text) => [{ from: 0, to: 60, text }];
const said = (ws) => ws.map((w) => w.text).join(' ');

(async () => {
  console.log('\n[1] two of three');
  {
    const w = WS('and then Jesus came on the scene and sad peace be still to the storm');
    const a = WS('and then Jesus came on the scene and said peace be still to the storm');
    const p = fuse.plan(w, a, CH('And then Jesus came on the scene and said, peace, be still to the storm.'));
    ok(p.auto.length === 1 && p.auto[0].whisper === 'sad' && p.auto[0].tokens.join() === 'said', 'the word the other two agree on is taken (without Gemini\'s comma)', p);
    ok(p.ask.length === 0, 'nothing else is asked');
    const out = fuse.apply(w, p.auto);
    ok(said(out) === 'and then Jesus came on the scene and said peace be still to the storm', 'the caption reads as two of three heard it', said(out));
    const w2 = WS('and then Jesus came on the scene. And then he sad to them peace be still');
    const a2 = WS('and then Jesus came on the scene. And then he said to them peace be still');
    const p2 = fuse.plan(w2, a2, CH('And then Jesus came on the scene. And then he said. To them, peace, be still.'));
    ok(p2.auto.length === 1 && p2.auto[0].tokens.join() === 'said', 'Gemini\'s own sentence breaks and capitals do not come in', p2.auto);
    const p3 = fuse.plan(WS('so we pray that the Word may know that Jesus is Lord of all'), WS('so we pray that the Word may know that Jesus is Lord of all'),
      CH('So we pray that the word may know that Jesus is lord of all.'));
    ok(p3.auto.length === 0 && p3.ask.length === 0, 'a capital is not a different word', p3);
  }

  console.log('\n[1b] the third ear settles a disagreement');
  {
    const w = WS('we give God the glory for the grace He has given to us this day');
    const a = WS('we give God the glory for the grays He has given to us this day');
    const p = fuse.plan(w, a, CH('We give God the glory for the grace He has given to us this day.'));
    ok(!p.auto.length && !p.ask.length && p.agreed.has(6), 'Gemini heard "grace" like the caption: two of three, nothing to look at', [...p.agreed]);
    const p2 = fuse.plan(w, a, CH('We give God the glory for the great grace He has given to us this day.'));
    ok(!p2.agreed.has(6), '…but not where Gemini heard something more beside it', [...p2.agreed]);
  }

  console.log('\n[2] both Whisper ears share the mishearing');
  {
    const w = WS('attract God and the presence of God came on the same that day church');
    const a = WS('attract God and the presence of God came on the same that day church');
    const p = fuse.plan(w, a, CH('Attract God, and the presence of God came on the scene that day, church.'));
    ok(p.auto.length === 0 && p.ask.length === 1, 'not decided on one ear\'s say-so: one question for the reader', p);
    const q = p.ask[0] || {};
    ok(q.whisper === 'same' && q.gemini === 'scene', '…the two hearings, side by side', q);
    ok(/came on the$/.test(q.before) && /^that day/.test(q.after), '…with the sentence around them', q);
    const { prompt } = fuse.refereePrompt([Object.assign({ id: 1 }, q)]);
    ok(/\[A: same \| B: scene\]/.test(prompt) && /not sure, answer "\?"/.test(prompt), 'the reader sees A and B and may say it cannot tell', prompt.slice(0, 200));
  }

  console.log('\n[3] Gemini\'s omissions and additions');
  {
    const w = WS('so so we we are going to pray right now for the nation of Nigeria today');
    const a = WS('so so we we are going to pray right now for the nation of Nigeria today');
    const p = fuse.plan(w, a, CH('So we are going to pray right now for the nation of Nigeria today.'));
    ok(!p.auto.length && !p.ask.length, 'repeated words Gemini tidied away stay in the caption', p);
    const w2 = WS('we are going to pray now for the nation of Nigeria today amen');
    const p2 = fuse.plan(w2, w2, CH('We are going to pray right now for the great nation of Nigeria today, amen.'));
    ok(!p2.auto.length && !p2.ask.length, 'words only Gemini heard are not added', p2);
  }

  console.log('\n[4] the same words, written another way');
  {
    const w = WS('we are gonna read John 3 16 today and um it is every day that God loves');
    const p = fuse.plan(w, w, CH('We are going to read John three sixteen today and it\'s everyday that God loves.'));
    ok(!p.auto.length && !p.ask.length, 'gonna / going to, 3 16 / three sixteen, it is / it\'s, every day / everyday: nothing changes', p);
    ok(fuse.tokensOf('Um, so uh the Lord').join(' ') === 'so the Lord', 'fillers are not words to line up');
  }

  console.log('\n[5] timing and punctuation');
  {
    const w = WS('he said that the Lord is my shepherd I shall not want.');
    const a = WS('he said that the Lord is my shepherd I shall not won.');
    const g = 'He said that the Lord is my shepherd, I shall not want.';
    // the change at the very end of a stretch is left alone (two ears cut there differently)…
    ok(!fuse.plan(w, a, CH(g)).auto.length, 'nothing at the edge of a stretch is touched');
    const w2 = WS('my God is a shepherd who heard me in my time of need and He is good');
    const a2 = WS('my God is a shepherd who hold me in my time of need and He is good');
    const p = fuse.plan(w2, a2, CH('My God is a shepherd who hold me in my time of need, and He is good.'));
    const out = fuse.apply(w2, p.auto);
    const nw = out.find((x) => x.text === 'hold');
    const old = w2.find((x) => x.text === 'heard');
    ok(nw && nw.start === old.start && nw.end === old.end && nw.third === 'gemini', 'the new word sits exactly in the old one\'s time, marked', { nw, old });
    const w3 = WS('and the Lord said go up to the mountain and pray, and he went');
    const out3 = fuse.apply(w3, [{ i0: 10, i1: 10, tokens: ['play'], start: w3[10].start, end: w3[10].end }]);
    ok(out3[10].text === 'play,', 'a replaced word keeps the comma that ended it', out3[10]);
  }

  console.log('\n[6] the reader\'s answer');
  {
    const m = fuse.parsePicks('thinking… {"picks":[{"id":1,"pick":"B"},{"id":"2","pick":"a"},{"id":3,"pick":"maybe"},{"id":4,"pick":"?"}]}');
    ok(m && m.get(1) === 'B' && m.get(2) === 'A' && !m.has(3) && m.get(4) === '?', 'A, B and ? are read; anything else is ignored', m && [...m]);
    ok(fuse.parsePicks('no json here') === null, 'no answer is no answer (nothing changes)');
  }

  console.log('\n[7] Gemini, free tier');
  {
    process.env.GEMINI_API_KEY = 'test-gemini';
    const order = ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-preview-tts'];
    const listing = { models: order.map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) };
    const asked = [];
    const fake = (dayGone) => async (url, o) => {
      if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => listing };
      const model = decodeURIComponent((/models\/([^:]+):generateContent/.exec(url) || [])[1] || '');
      asked.push(model);
      if (dayGone.includes(model)) return { ok: false, status: 429, json: async () => ({ error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 250', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }) };
      const body = JSON.parse(o.body);
      ok(body.contents[0].parts[0].inline_data.mime_type === 'audio/flac', 'the audio goes as lossless FLAC (' + model + ')');
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Speaker 1: Good morning [music] church.' }] } }] }) };
    };
    gem._reset();
    ok(await gem.pickModel(fake([])) === 'gemini-2.5-flash', 'the newest full flash model is chosen — never lite, pro or a speech model');
    const r = await gem.hear(Buffer.from('fLaC'), { fetchImpl: fake(['gemini-2.5-flash']), waits: [1] });
    ok(r.model === 'gemini-2.5-pro' || r.model === 'gemini-2.0-flash', 'a model whose day is used up is set aside for the next', { r, asked });
    ok(r.text === 'Good morning church.', 'labels and [music] notes are not words', r.text);
    gem._reset(); asked.length = 0;
    const span = await gem.transcribeSpan({ input: 'x', from: 0, to: 900, chunkSec: 300, encode: async () => Buffer.from('fLaC'),
      fetchImpl: fake(order), waits: [1] });
    ok(span.chunks.length === 0 && span.failed === 3 && /used up/.test(span.why), 'every model used up: the rest of the span is not tried in vain', span);
    ok(asked.length <= 4, '…one ask per model, then it stops', asked);
    gem._reset();
  }

  console.log('\n[8] end to end: captions:transcribe with three ears');
  {
    const os = require('os'), fs = require('fs');
    const INPUT = path.join(__dirname, 'fixtures', 'sermon-dry.flac');
    const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-third-'));
    require(path.join(ROOT, 'src/cloud/electron-shim')).install({ dataDir: path.join(WORK, 'userData'), mediaDir: WORK, version: 'test' });
    const sched = require(path.join(ROOT, 'src/main/scheduler'));
    if (sched.Scheduler) sched.Scheduler.prototype.start = function () { return this; };
    require(path.join(ROOT, 'src/main/autopost')).startHeartbeat = () => ({ stop() {} });
    const rpc = require(path.join(ROOT, 'src/main/rpc'));
    require(path.join(ROOT, 'src/main/main.js'));
    await new Promise((r) => setTimeout(r, 600));
    const cs = require(path.join(ROOT, 'src/main/cloudspeech'));
    const cw = require(path.join(ROOT, 'src/main/cloudwrite'));
    const SAY = {
      'whisper-large-v3': 'and the presence of God came on the same and sad peace be still',
      'whisper-large-v3-turbo': 'and the presents of God came on the same and said peace be still',
    };
    const W = (txt) => ({
      words: txt.split(' ').map((x, i) => ({ word: x, start: 0.2 + i * 0.4, end: 0.55 + i * 0.4 })),
      segments: [{ start: 0.2, end: 0.2 + txt.split(' ').length * 0.4, text: txt, avg_logprob: -0.2, no_speech_prob: 0, compression_ratio: 1.2 }],
    });
    const seen = { gemini: 0, reader: 0, prompt: '' };
    global.fetch = async (url, o) => {
      url = String(url);
      if (/generativelanguage/.test(url) && /\/models\?/.test(url)) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }) };
      if (/generativelanguage/.test(url)) {
        seen.gemini++;
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'And the presence of God came on the scene, and said, peace, be still.' }] } }] }) };
      }
      if (/chat\/completions/.test(url)) {
        seen.reader++; seen.prompt = JSON.parse(o.body).messages.map((m) => m.content).join('\n');
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: '{"picks":[{"id":1,"pick":"B"}]}' } }] }) };
      }
      if (/\/models$/.test(url)) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [{ id: 'openai/gpt-oss-120b' }] }) };
      const m = o.body.get('model');
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => W(SAY[m]) };
    };
    process.env.GEMINI_API_KEY = 'test-gemini';
    gem._reset();
    cs.configure({ on: true, provider: 'groq', key: 'gsk_test' });
    cw.configure({ on: true, provider: 'groq', key: 'gsk_test' });
    const res = await rpc.invoke('captions:transcribe', { input: INPUT, startSec: 0, endSec: 6, model: 'cloud' });
    const out = res && res.ok !== undefined ? res.data : res;
    const text = out && out.words.map((w) => w.text).join(' ');
    ok(seen.gemini === 1, 'Gemini heard the clip once', seen);
    ok(/came on the scene and said,? peace be still/.test(text), 'the caption: "came on the scene and said" — both mishearings put right', text);
    ok(seen.reader === 1 && /\[A: same \| B: scene\]/.test(seen.prompt), 'the shared Whisper mishearing was put to the reader', seen.prompt.slice(0, 300));
    const t = out && out.check && out.check.third;
    ok(t && t.auto === 1 && t.asked === 1 && t.reader === 1 && t.model === 'gemini-2.5-flash', 'the answer says what the third ear did', t);
    ok(out && !out.words.some((w) => w.doubt), 'what two ears (or an ear and the reader) settled is not left in doubt', out && out.words.filter((w) => w.doubt));
    ok(t && t.settled === 1 && /presence/.test(text), '"presence" / "presents": Gemini heard the caption\'s word, so it is not listed for a look', t);
    ok(t && Array.isArray(t.texts) && /on the scene/.test(t.texts[0].text), 'what Gemini heard comes back with the answer', t && t.texts);

    // the reader cannot tell: the Whisper words stay, marked for a look, Gemini's hearing offered
    global.fetch = ((real) => async (url, o) => {
      if (/chat\/completions/.test(String(url))) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: '{"picks":[{"id":1,"pick":"?"}]}' } }] }) };
      return real(url, o);
    })(global.fetch);
    const res2 = await rpc.invoke('captions:transcribe', { input: INPUT, startSec: 0, endSec: 6, model: 'cloud' });
    const out2 = res2 && res2.ok !== undefined ? res2.data : res2;
    const d = out2 && out2.words.filter((w) => w.doubt).map((w) => w.text);
    ok(out2 && /on the same/.test(out2.words.map((w) => w.text).join(' ')), 'unsure: the words both Whisper ears heard stay', out2 && out2.words.map((w) => w.text).join(' '));
    ok(d && d.join() === 'same', '…marked as worth a look', d);
    ok(out2 && out2.check.alt.some((w) => w.text === 'scene'), '…with Gemini\'s hearing as the one-tap alternative', out2 && out2.check.alt.map((w) => w.text).join(' '));

    // no Gemini key: exactly the captions there were before
    delete process.env.GEMINI_API_KEY; seen.gemini = 0;
    const res3 = await rpc.invoke('captions:transcribe', { input: INPUT, startSec: 0, endSec: 6, model: 'cloud' });
    const out3 = res3 && res3.ok !== undefined ? res3.data : res3;
    ok(seen.gemini === 0 && out3 && !out3.check.third && /on the same/.test(out3.words.map((w) => w.text).join(' ')), 'no key: no third ear, nothing else changes', out3 && out3.check);
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
