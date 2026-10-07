'use strict';
/*
 * CAPTION PIECES ARE HEARD WITH THEIR CONTEXT.
 *
 * On a real 45-minute sermon, ten-minute pieces heard cold wrote "who at a
 * never" for "who art in heaven", "salt hallelujah" for "shout hallelujah", and
 * dropped all punctuation for minutes at a time. So each piece now goes up:
 *   [1] lossless (FLAC), in three-minute pieces
 *   [2] with a punctuated primer, the Word Book's names, and the end of what
 *       was heard just before it (inside Whisper's 224-token prompt)
 *   [3] and a stretch that is only the prompt said back over silence is
 *       dropped — but a preacher really saying "Our Father, who art in heaven"
 *       is kept
 *   [4] `plain` is the old way (Opus, no prompt), for side-by-side measuring
 *
 *   node test/caption-context.test.js
 */
const path = require('path'), os = require('os'), fs = require('fs');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const cs = require(path.join(__dirname, '..', 'src', 'main', 'cloudspeech'));

let pass = 0, fail = 0;
const check = (name, ok, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + d : '')); ok ? pass++ : fail++; };

(async () => {
  const wav = path.join(os.tmpdir(), 'mw-capctx-' + process.pid + '.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '400', '-y', wav]);
  const calls = [];
  let reply = null;
  global.fetch = async (url, init) => {
    const form = init.body;
    const file = form.get('file');
    const buf = Buffer.from(await file.arrayBuffer());
    calls.push({ name: file.name, type: file.type, magic: buf.slice(0, 4).toString('latin1'), prompt: form.get('prompt') || '', bytes: buf.length });
    const n = calls.length - 1;
    const r = reply ? reply(n) : { words: [{ word: 'piece' + n, start: 10, end: 10.4 }, { word: 'ends.', start: 10.5, end: 10.9 }], segments: [{ start: 9, end: 11, text: 'piece' + n + ' ends.', no_speech_prob: 0.01, avg_logprob: -0.2 }] };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => r };
  };
  cs.configure({ on: false, provider: 'groq', key: 'test-key' });

  console.log('\n[1] lossless, three-minute pieces');
  const r = await cs.transcribeWords({ input: wav, startSec: 0, endSec: 400, terms: ['Bishop David Richman', 'New Kingdom Center'] });
  const own = calls.filter((c) => c.prompt !== undefined);
  check('400 s is three pieces (was one at ten minutes)', own.length >= 3, own.length);
  check('each piece is FLAC', own.slice(0, 3).every((c) => c.name === 'clip.flac' && c.type === 'audio/flac' && c.magic === 'fLaC'), JSON.stringify(own.slice(0, 3).map((c) => c.magic)));
  check('a three-minute piece stays well inside the upload limit', own[0].bytes > 0 && own[0].bytes < 8e6, own[0].bytes);

  console.log('\n[2] heard with its context');
  check('every piece carries the punctuated primer', own.slice(0, 3).every((c) => c.prompt.startsWith(cs.CAPTION_PRIMER)));
  check('…and the Word Book names', own[0].prompt.includes('Bishop David Richman') && own[0].prompt.includes('New Kingdom Center'));
  check('the second piece hears the end of what the first one heard', /piece0 ends\.$/.test(own[1].prompt), own[1].prompt.slice(-40));
  check('the third, what the second heard', /piece1 ends\.$/.test(own[2].prompt), own[2].prompt.slice(-40));
  check('inside Whisper\'s prompt window', own.every((c) => c.prompt.length <= 780));
  const long = cs.captionPrompt({ terms: [], before: 'and he said to them go '.repeat(100) });
  check('a long run before is cut at the front, on a word', long.length <= 780 && /said to them go$/.test(long) && long.startsWith(cs.CAPTION_PRIMER), long.length);
  check('the words came back in order', r.words.map((w) => w.text).join(' ').startsWith('piece0 ends. piece1 ends.'));

  console.log('\n[3] the prompt said back is dropped — a real prayer is not');
  calls.length = 0;
  reply = () => ({
    words: [
      { word: 'Our', start: 0.2, end: 0.4 }, { word: 'Father,', start: 0.4, end: 0.8 }, { word: 'who', start: 0.8, end: 1 }, { word: 'art', start: 1, end: 1.2 },
      { word: 'in', start: 1.2, end: 1.3 }, { word: 'heaven.', start: 1.3, end: 1.8 },
      { word: 'Our', start: 20.2, end: 20.4 }, { word: 'Father,', start: 20.4, end: 20.8 }, { word: 'who', start: 20.8, end: 21 }, { word: 'art', start: 21, end: 21.2 },
      { word: 'in', start: 21.2, end: 21.3 }, { word: 'heaven.', start: 21.3, end: 21.8 },
    ],
    segments: [
      { start: 0, end: 2, text: 'Our Father, who art in heaven.', no_speech_prob: 0.02, avg_logprob: -0.15 },     // said
      { start: 20, end: 22, text: 'Our Father, who art in heaven.', no_speech_prob: 0.72, avg_logprob: -0.9 },     // music: the prompt back
    ],
  });
  const e = await cs.transcribeWords({ input: wav, startSec: 0, endSec: 30 });
  const t = e.words.map((w) => w.text).join(' ');
  check('the preacher saying it is kept', /^Our Father, who art in heaven\./.test(t), t);
  check('the decoder saying it back over music is not', (t.match(/Our/g) || []).length === 1, t);

  console.log('\n[4] the old way, for measuring');
  calls.length = 0; reply = null;
  await cs.transcribeWords({ input: wav, startSec: 0, endSec: 30, plain: true });
  check('plain: Opus, no prompt', calls[0] && calls[0].name === 'clip.ogg' && !calls[0].prompt, JSON.stringify(calls[0] && { n: calls[0].name, p: calls[0].prompt }));

  console.log('\n[5] words squeezed into an instant that the other ear did not hear are dropped');
  {
    const W = (t, a, b) => ({ text: t, start: a, end: b });
    // the real sermon: "ask them been praying for a long time, forever."
    const heard = [W('ask', 324.5, 324.82), W('them', 324.82, 324.98), W('been', 325, 325.02), W('praying', 325.02, 325.04), W('for', 325.04, 325.1),
      W('a', 325.1, 325.34), W('long', 325.34, 325.46), W('time,', 325.46, 325.48), W('forever.', 325.48, 325.62)];
    const other = [W('ask', 324.5, 324.8), W('them', 324.8, 325), W('forever.', 325.1, 325.6)];
    const r1 = cs.dropSqueezed(heard, other);
    check('"ask them been praying for a long time, forever" → "ask them … forever"', r1.words.map((w) => w.text).join(' ') === 'ask them forever.', r1.words.map((w) => w.text).join(' '));
    // "do do what? what?" — instant repeats
    const rep = [W('spirit', 112.84, 112.9), W('do', 112.9, 112.98), W('do', 112.98, 113.02), W('what?', 113, 113), W('what?', 113.02, 114.04), W('Have', 114.04, 114.18)];
    const r2 = cs.dropSqueezed(rep, [W('spirit', 112.8, 112.9), W('do', 112.9, 113), W('what?', 113, 114)]);
    check('"do do what? what?" → "do what?"', r2.words.map((w) => w.text).join(' ') === 'spirit do what? Have', r2.words.map((w) => w.text).join(' '));
    // quick real words the other ear DID hear stay
    const fast = [W('in', 10, 10.04), W('the', 10.04, 10.08), W('name', 10.08, 10.4)];
    const r3 = cs.dropSqueezed(fast, [W('in', 10, 10.05), W('the', 10.05, 10.1), W('name', 10.1, 10.4)]);
    check('quick words the other ear heard too are kept', r3.words.length === 3 && r3.dropped === 0);
  }

  console.log('\n[6] a stretch the primed ear lost comes from the plain ear; a short difference stays');
  {
    const W = (t, a, b) => ({ text: t, start: a, end: b });
    const said = 'and the mother actually agreed with the father you know that i know that this is not your daughter but please cover this secret don\'t let anybody know'.split(' ');
    const plainEar = said.map((t, k) => W(t, 250 + k * 0.6, 250 + k * 0.6 + 0.5));
    // the real failure: fifteen seconds came back as "Our father, I I that us. praying."
    const primed = [W('Our', 250.2, 250.4), W('father,', 258, 258.3), W('I', 261.3, 261.35), W('I', 261.4, 261.45), W('that', 261.4, 261.5), W('us.', 261.5, 261.6), W('praying.', 267, 267.02)];
    const f = cs.fuseWithPlain(primed, plainEar);
    const t = f.words.map((w) => w.text).join(' ');
    check('the lost fifteen seconds are back', /this is not your daughter but please cover this secret don't let anybody know/.test(t) && !/praying/.test(t), t);
    check('…with "I" written as "I"', /that I know/.test(t), t);
    const ctx = [W('pray', 200, 200.3), W('this,', 200.3, 200.6), W('our', 200.6, 200.8), W('Father,', 200.8, 201.2), W('who', 201.2, 201.4), W('art', 201.4, 201.6), W('in', 201.6, 201.7), W('heaven.', 201.7, 202.2)];
    const plain2 = [W('pray', 200, 200.3), W('this', 200.3, 200.6), W('with', 200.6, 200.7), W('our', 200.7, 200.9), W('father', 200.9, 201.2), W('who', 201.2, 201.4), W('at', 201.4, 201.6), W('a', 201.6, 201.7), W('never', 201.7, 202.2)];
    const g = cs.fuseWithPlain(ctx, plain2);
    check('"who art in heaven" is kept against "who at a never"', g.words.map((w) => w.text).join(' ') === 'pray this, our Father, who art in heaven.', g.words.map((w) => w.text).join(' '));
  }

  fs.rmSync(wav, { force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
