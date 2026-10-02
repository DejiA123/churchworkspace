'use strict';
/*
 * ☁️ CAPTIONS FROM GROQ, AND ✨ THE AI PROOF-READER — against the real service,
 * on a real sermon, with the key this PC already has.
 *
 * test/caption-grammar.test.js proves the seams with a fake provider. This one
 * asks the real one, because the things that break a cloud feature are the
 * things a fake cannot: a field the provider renamed, word timings that do not
 * arrive, a reasoning model answering in the wrong field.
 *
 *  1. 90 s of a real sermon, heard in ONE piece and again in THREE (30 s each,
 *     overlapping): the three-piece words must be the one-piece words — none
 *     doubled at a seam, none lost, times on the file's clock.
 *  2. The AI proof-reader, handed lines with planted mistakes, must suggest the
 *     fixes — and every suggestion it makes must pass the vetting.
 *
 * Skips (and says so) with no key or no recording. Spends about 3 minutes of
 * the free tier's 120-minutes-an-hour audio allowance and one chat request.
 *
 *   node test/cloud-captions-live.test.js
 */
const path = require('path');
const fs = require('fs');
const cs = require('../src/main/cloudspeech.js');
const cw = require('../src/main/cloudwrite.js');
const G = require('../src/renderer/capgrammar.js');
const { sermonPath, noSermon } = require('./sermon.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d !== undefined ? '  -> ' + d : '')); c ? pass++ : fail++; };

function settings() {
  const p = path.join(process.env.APPDATA || '', 'Church Work Space', 'workstation.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')).settings || {}; } catch (e) { return {}; }
}
const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9']/g, '');
function lcs(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}

(async () => {
  const s = settings();
  const listen = (s.listen || {}).cloud || {};
  const social = (s.social || {}).cloud || {};
  const key = listen.key || (social.provider === 'groq' || !social.provider ? social.key : '');
  const sermon = sermonPath(process.argv[2]);
  if (!key) { console.log('  SKIP — no Groq key on this PC (🎤 Listen or the caption writer).'); process.exit(0); }
  if (!sermon) { console.log(noSermon()); process.exit(0); }

  console.log('\n[1] Word-timed captions from the full-size Whisper');
  cs.configure({ on: false, provider: 'groq', key });
  const FROM = 600, TO = 690;
  const t0 = Date.now();
  const one = await cs.transcribeWords({ input: sermon, startSec: FROM, endSec: TO });
  const oneMs = Date.now() - t0;
  check('90 s of sermon heard, with word timings', one && one.words.length > 100 && one.doneSec === 90,
    one ? `${one.words.length} words in ${(oneMs / 1000).toFixed(1)} s${one.why ? ' — ' + one.why : ''}` : 'null');
  if (!one || !one.words.length) { console.log(`\n${pass} PASS / ${fail} FAIL`); process.exit(1); }
  check('…far faster than real time', oneMs < 30000, `${(oneMs / 1000).toFixed(1)} s for 90 s`);
  check('…every time inside the clip, relative to its start, in order',
    one.words.every((w, i) => w.start >= 0 && w.end <= 90.5 && w.end >= w.start && (i === 0 || w.start >= one.words[i - 1].start - 0.01)));
  const t1 = Date.now();
  const three = await cs.transcribeWords({ input: sermon, startSec: FROM, endSec: TO, chunkSec: 30 });
  check('the same 90 s in three overlapping pieces', three && three.doneSec === 90, three ? `${three.words.length} words in ${((Date.now() - t1) / 1000).toFixed(1)} s` : 'null');
  const A = one.words.map((w) => norm(w.text)).filter(Boolean), B = three.words.map((w) => norm(w.text)).filter(Boolean);
  const same = lcs(A, B);
  check('…agrees with the one-piece transcript (the seams lose and double nothing)',
    same / Math.max(A.length, B.length) >= 0.9, `${same} of ${Math.max(A.length, B.length)} words in common`);
  // A doubled word at a seam shows as the same word twice within a second, right by a seam.
  const seamDupes = three.words.filter((w, i) => i > 0 && norm(w.text) === norm(three.words[i - 1].text)
    && w.start - three.words[i - 1].start < 1 && [30, 60].some((b) => Math.abs(w.start - b) < 4));
  check('…and no word is said twice where two pieces meet', seamDupes.length === 0, JSON.stringify(seamDupes));
  console.log('    one piece : ' + one.words.slice(0, 18).map((w) => w.text).join(' ') + ' …');

  console.log('\n[2] The AI proof-reader, on lines with planted mistakes');
  cw.configure({ on: true, provider: 'groq', key: social.key || key, model: '' });
  const lines = [
    { i: 0, text: 'FOR GOD SO LOVED THE WORLD' },
    { i: 1, text: 'THAT HE GAVE HIS ONLY BEGOTTEN SUN' },     // misheard
    { i: 2, text: 'THAT WHOSOEVER BELIEVETH IN HIM' },
    { i: 3, text: 'SHOULD NOT PERISH BUT HAVE' },
    { i: 4, text: 'EVERLASTING LIVE' },                       // misheard
    { i: 5, text: 'AND THE WOMAN DID NOT NO' },               // misheard
    { i: 6, text: 'WHAT WAS COMING' },
  ];
  const { system, prompt } = G.buildAiPrompt(lines.map((l) => ({ n: l.i, text: l.text })), { mode: 'exact' });
  const t2 = Date.now();
  const answer = await cw.chat({ system, prompt, maxTokens: 2000, temperature: 0, json: true, timeoutMs: 45000 });
  const got = G.parseAiFixes(answer, lines.map((l) => ({ n: l.i, text: l.text })));
  check('the AI answered in the shape asked for', Array.isArray(got),
    `${((Date.now() - t2) / 1000).toFixed(1)} s by ${cw.state().usingModel || '?'}${cw.state().why ? ' — ' + cw.state().why : ''}`);
  const vetted = (got || []).map((f) => ({ f, v: G.vetAiLine(lines[f.n].text, f.text, { caseMode: 'upper', mode: 'exact' }) }));
  const ok = vetted.filter((x) => x.v.ok).map((x) => ({ n: x.f.n, text: x.v.text }));
  console.log('    suggested: ' + JSON.stringify(ok));
  check('…caught "BEGOTTEN SUN"', ok.some((x) => x.n === 1 && /BEGOTTEN SON/.test(x.text)));
  check('…caught "EVERLASTING LIVE"', ok.some((x) => x.n === 4 && /EVERLASTING LIFE/.test(x.text)));
  check('…caught "DID NOT NO"', ok.some((x) => x.n === 5 && /DID NOT KNOW/.test(x.text)));
  check('…left the lines that were right alone', !ok.some((x) => [0, 2, 3].includes(x.n)), JSON.stringify(ok.filter((x) => [0, 2, 3].includes(x.n))));
  check('…and nothing it said was a rewrite', vetted.every((x) => x.v.ok || x.v.reason === 'no change'), JSON.stringify(vetted.filter((x) => !x.v.ok)));

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
