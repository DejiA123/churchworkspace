'use strict';
/*
 * A PROOFREADER THAT LISTENS AGAIN (relisten.js) — for what every ear got wrong.
 *
 * Measured on a real sermon: after Gemini's words and Whisper's timing, the
 * mistakes left were ones all three ears made ("have read that" for "have
 * real dad", "If thou shall keep" for "shalt"). A reader finds the phrases that
 * make no sense; the few seconds of audio decide. Fake Gemini, no network:
 *   [1] the captions are read as numbered lines, with the other ear's hearing where it differs
 *   [2] a note is matched to the exact caption words — or dropped if it does not fit
 *   [3] the audio decides: the guess goes in only when the clip says so
 *   [4] the two versions are offered in no telling order, and read back the right way round
 *   [5] "cannot tell" leaves the words, handed back to be listed for a look
 *   [6] no answer from Gemini: the captions are exactly as they were
 *
 *   node test/caption-relisten.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const rl = require(path.join(ROOT, 'src/main/relisten'));
const gem = require(path.join(ROOT, 'src/main/geminiear'));
let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${m}${d != null && !c ? '  -> ' + JSON.stringify(d) : ''}`); };
const WS = (txt, t0 = 0.5, step = 0.4) => txt.split(' ').map((x, i) => ({ text: x, start: +(t0 + i * step).toFixed(2), end: +(t0 + i * step + 0.35).toFixed(2) }));
const said = (ws) => ws.map((w) => w.text).join(' ');
const listing = { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] };
const reply = (obj) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }] }) });

const TEXT = 'A number of people have read that. When you have read that, the first time you go to him. '
  + 'You have your feel of love before you go out. So why would somebody deceive you? '
  + 'If thou shall keep the commandment of the Lord thy God. Amen.';

(async () => {
  process.env.GEMINI_API_KEY = 'test-gemini';
  const words = WS(TEXT);
  const alt = WS(TEXT.replace('have read that, the', 'have a little dad the'));

  console.log('\n[1] the captions as lines');
  const lines = rl.linesOf(words, alt);
  ok(lines.length === 6 && lines[0].text === 'A number of people have read that.', 'one line per sentence', lines.map((l) => l.text));
  ok(lines[1].alt && /a little dad/.test(lines[1].alt) && !lines[0].alt, 'the other ear\'s hearing is shown only where it differs', lines.map((l) => l.alt));
  ok(/#2 \[0:03\] When you have read that/.test(rl.proofreadPrompt(lines)) && /another recogniser heard: .*a little dad/.test(rl.proofreadPrompt(lines)),
    'the reader sees numbered, timed lines and the other hearing');

  console.log('\n[2] a note, matched to the words');
  ok(JSON.stringify(rl.locate({ line: 2, heard: 'read that,', likely: 'real dad' }, lines, words)) === JSON.stringify({ a: 10, b: 11 }), 'the exact words of that line', rl.locate({ line: 2, heard: 'read that,', likely: 'real dad' }, lines, words));
  ok(rl.locate({ line: 2, heard: 'feel of love', likely: 'fill of love' }, lines, words) === null, 'words that are not on that line: dropped');
  ok(rl.locate({ line: 3, heard: 'feel', likely: '(unclear)' }, lines, words) === null && rl.locate({ line: 3, heard: 'feel of love', likely: 'feel of love' }, lines, words) === null,
    'a guess with a note in it, or no change at all: dropped');

  console.log('\n[2b] his grammar is not a mishearing');
  const T = (x) => x.toLowerCase().split(' ');
  ok(['send them|sent them', 'answers|answer', 'an evil spirit|the evil spirits', 'else have seen|else had seen', 'will|would'].every((c) => rl.grammarOnly(T(c.split('|')[0]), T(c.split('|')[1]))),
    'send/sent, answers/answer, an/the spirit(s), have/had, will/would: never asked');
  ok(['if you do learn|if you do not learn', 'knee down|kneel down', 'read daddies|real daddies', "that's not be you|that shall not be you"].every((c) => !rl.grammarOnly(T(c.split('|')[0]), T(c.split('|')[1]))),
    '…but "do NOT learn", "kneel", "real", "that SHALL not be" are asked');
  ok(rl.locate({ line: 2, heard: 'have read that,', likely: 'had read that,' }, lines, words) === null, 'a grammar-only note is dropped before any listening');

  console.log('\n[3]-[5] the audio decides');
  const asked = { read: 0, listen: 0, prompts: [], clips: 0 };
  const fake = async (url, o) => {
    if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => listing };
    const body = JSON.parse(o.body);
    const parts = body.contents[0].parts;
    const text = parts.map((p) => p.text || '').join('\n');
    if (/proofreading/.test(text)) {
      asked.read++;
      return reply({ fixes: [
        { line: 1, heard: 'read that.', likely: 'real dad.' },
        { line: 2, heard: 'read that,', likely: 'real dad' },
        { line: 3, heard: 'feel of love', likely: 'fill of love' },
        { line: 5, heard: 'If thou shall keep', likely: 'If thou shalt keep' },
        { line: 4, heard: 'not in this line', likely: 'something' },
      ] });
    }
    asked.listen++; asked.prompts.push(text); asked.clips += parts.filter((p) => p.inline_data).length;
    // the "audio": what was really said in each clip
    const truth = ['real dad.', 'real dad', 'feel of love', null];
    const answers = [];
    const rx = /Clip (\d+): \(1\) "([^"]*)"  \(2\) "([^"]*)"/g;
    let m;
    while ((m = rx.exec(text))) {
      const k = +m[1], t = truth[k - 1];
      answers.push({ clip: k, choice: t === null ? 0 : (m[2].includes(t) ? 1 : 2) });
    }
    return reply({ answers });
  };
  const enc = async (input, a, d) => Buffer.from(`${a.toFixed(2)}+${d.toFixed(2)}`);
  const r = await rl.proofread({ words, alt, input: 'x', from: 100, fetchImpl: fake, encode: enc });
  const out = said(r.words);
  ok(asked.read === 1 && asked.listen === 1 && asked.clips === 4, 'one read, then one listen with every clip in it', asked);
  ok(/people have real dad\. When you have real dad, the first time/.test(out), '"have read that" → "have real dad", where the clip says so', out);
  ok(/your feel of love/.test(out), 'where the clip says the caption was right, it stays', out);
  ok(/If thou shall keep/.test(out) && r.unsure.map((w) => w.text).join(' ') === 'If thou shall keep', '"cannot tell": the words stay, handed back to be listed', r.unsure.map((w) => w.text));
  ok(r.report.suspects === 5 && r.report.located === 4 && r.report.changed === 2 && r.report.kept === 1 && r.report.unsure === 1, 'the report counts it all', r.report);
  ok(r.report.changes.length === 2 && r.report.changes[0].was === 'read that.' && r.report.changes[0].now === 'real dad.', '…and lists every change', r.report.changes);
  const rd = r.words.filter((w) => w.text === 'real' && w.src === 'relisten')[1];
  const was = words[10];
  ok(rd && rd.start === was.start && r.words[r.words.indexOf(rd) + 1].end === words[11].end, 'the new words sit in the old words\' time', { rd, was });
  ok(r.words.find((w) => w.text === 'dad,'), 'the caption\'s own comma stays', said(r.words));
  // [4] the order: clip 1 offered caption-first, clip 2 guess-first
  const p = asked.prompts[0];
  ok(/Clip 1: \(1\) "[^"]*read that[^"]*"  \(2\) "[^"]*real dad/.test(p) && /Clip 2: \(1\) "[^"]*real dad[^"]*"  \(2\) "[^"]*read that/.test(p), 'the two versions come in no telling order', p.slice(-600));
  ok(/EXACTLY what the speaker says/.test(p) && /answer 0/.test(p), 'the question asks for the sounds, and allows "cannot tell"');

  console.log('\n[6] no answer');
  const down = async (url) => {
    if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => listing };
    return { ok: false, status: 429, json: async () => ({ error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }) };
  };
  gem._reset();
  const r2 = await rl.proofread({ words, alt, input: 'x', from: 0, fetchImpl: down, encode: enc });
  ok(said(r2.words) === said(words) && /used up/.test(r2.report.why), 'Gemini\'s allowance used up: the captions are exactly as they were, and it says why', r2.report);
  delete process.env.GEMINI_API_KEY;
  const r3 = await rl.proofread({ words, alt, input: 'x', from: 0, fetchImpl: fake, encode: enc });
  ok(said(r3.words) === said(words) && r3.report.windows === 0, 'no key: nothing asked');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
