'use strict';
/*
 * LONG TO SHORTS, PLANNED FROM THE WHOLE SERMON (src/main/shortplan.js).
 *
 * Built from what a real 45-minute sermon's shorts got wrong: an opening on
 * "Huh? Oh yes, yes", an aside to someone in the room ("Faithful, how are you?
 * You're looking so good"), an ending on the first line of the next story ("I
 * went to a church about two years ago."), and the strongest point never
 * becoming a short at all. A fake reader stands in for the model.
 *
 *   node test/shortplan.test.js
 */
const P = require('../src/main/shortplan.js');
let pass = 0, fail = 0;
const check = (name, ok, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d).slice(0, 400) : '')); ok ? pass++ : fail++; };

// 600 sentences of ~6 s and ~12 words each: a 60-minute sermon
const S = [];
for (let k = 0; k < 600; k++) S.push({ start: k * 6, end: k * 6 + 5.6, text: `Sentence ${k} says something about the love of God and how we pray today.` });
S[100].text = 'Huh?'; S[101].text = 'Oh yes, yes.';
S[130].text = 'I went to a church about two years ago.';
S[200].text = 'Let me be serious.'; S[201].text = 'Faithful, how are you?'; S[202].text = "You're looking so good.";
S[330].text = 'There is no prosperity gospel, there is only one gospel.';

(async () => {
  console.log('\n[1] the sermon is read in overlapping sections');
  const secs = P.sections(S);
  check('a 60-minute sermon is read in sections of about eight minutes', secs.length >= 5 && secs.length <= 10, secs.length);
  check('…that overlap, so a moment on a seam is seen whole', secs.every((s, i) => i === 0 || s[0] <= secs[i - 1][1]), secs);
  check('…and cover every sentence', secs[0][0] === 0 && secs[secs.length - 1][1] === S.length - 1);

  console.log('\n[2] every moment is held to the rules');
  const sec = [0, S.length - 1];
  const band = { minLen: 60, maxLen: 150 };
  const a = P.vet({ from: 100, to: 112, title: 'Joy', strength: 7 }, S, sec, band);
  check('an opening on "Huh?" / "Oh yes, yes." moves to where the thought starts', a && a.from === 102, a);
  const b = P.vet({ from: 115, to: 130, title: 'x', strength: 7 }, S, sec, band);
  check('an ending on the first line of a new story stops before it', b && b.to === 129, b);
  const c = P.vet({ from: 200, to: 215, title: 'x', strength: 7 }, S, sec, band);
  check('an aside to someone in the room is not where a short starts', c && c.from === 203, c);
  const d = P.vet({ from: 300, to: 340, title: 'x', strength: 9 }, S, sec, band);
  check('too long: the payoff is kept, the run-up shortened', d && d.to === 340 && d.end - d.start <= 150 * 1.08, d && { from: d.from, to: d.to, dur: d.end - d.start });
  S[150].text = 'Where did you see Jesus?';
  const q = P.vet({ from: 136, to: 150, title: 'x', strength: 7 }, S, sec, band);
  check('an ending on the short question that opens the next point stops before it', q && q.to === 149, q);
  S[400].text = 'God should be approached as a father.'; S[401].text = "That exactly how God is, he is always happy to have you.";
  const lean = P.vet({ from: 401, to: 412, title: 'x', strength: 8 }, S, sec, band);
  check('a start that leans on the line before ("That exactly how God is…") takes that line too', lean && lean.from === 400, lean);
  S[430].text = 'You are paid salary for your work but you are rewarded for your effect What you effect'; S[431].text = 'is what you are rewarded for.';
  const cut = P.vet({ from: 418, to: 430, title: 'x', strength: 8 }, S, sec, band);
  check('an ending cut mid-phrase ("…What you effect") finishes its sentence', cut && cut.to === 431, cut);
  check('too short and not strong: left out', P.vet({ from: 50, to: 52, strength: 5 }, S, sec, band) === null);
  // Auto (about 1:30, never under 1:00): a strong moment the AI cut to its punchline takes the thought around it
  const grown = P.vet({ from: 60, to: 62, title: 'x', strength: 8 }, S, sec, Object.assign({}, band, { minLen: 60, idealLen: 90, maxLen: 150 }));
  check('a strong moment shorter than asked grows by whole lines to the length asked (setup first)', !!grown && grown.end - grown.start >= 60 && grown.end - grown.start <= 150 && grown.from < 60 && grown.to > 62, grown && { from: grown.from, to: grown.to, secs: Math.round(grown.end - grown.start) });
  // the live sermon's misses: a start mid-sentence, an end on a comma, a misheard swear word
  const L = S.map((x) => Object.assign({}, x));
  L[320].text = 'On earth'; L[321].text = 'nothing is greater than the prayer of saints on earth.';
  const mid = P.vet({ from: 321, to: 334, title: 'x', strength: 8 }, L, sec, band);
  check('a start mid-sentence ("nothing is greater…") goes back to where its sentence starts', !!mid && mid.from === 320, mid && mid.from);
  const C = S.map((x) => Object.assign({}, x));
  C[240].text = 'That is how we win.'; C[241].text = 'The devil cannot understand our winning formula.'; C[242].text = 'He cannot understand it,';
  for (let k = 243; k < 250; k++) C[k].text = 'Hallelujah.';
  const comma = P.vet({ from: 228, to: 242, title: 'x', strength: 8 }, C, sec, band);
  check('an end on a comma ("He cannot understand it,") goes back to the last whole sentence', !!comma && comma.to === 241, comma && comma.to);
  const F = S.map((x) => Object.assign({}, x));
  F[275].text = 'If you do not kill me today, then fuck it.';
  const swearEnd = P.vet({ from: 262, to: 275, title: 'x', strength: 8 }, F, sec, band);
  check('a misheard swear word never closes a church short (it ends on the line before)', !!swearEnd && swearEnd.to === 274, swearEnd && swearEnd.to);
  const swearIn = P.vet({ from: 268, to: 282, title: 'x', strength: 8 }, F, sec, band);
  check('…and a short with one inside it is left out', swearIn === null, swearIn && [swearIn.from, swearIn.to]);
  const A = S.map((x) => Object.assign({}, x));
  A[360].text = 'Are you here, young lady?'; A[375].text = "Can you see what I'm talking about?";
  const aside = P.vet({ from: 360, to: 375, title: 'x', strength: 8 }, A, sec, band);
  check('a word to someone in the room never opens or closes a short ("Are you here, young lady?")', !!aside && aside.from === 361 && aside.to === 374, aside && [aside.from, aside.to]);
  check('short but one of the strongest: kept', !!P.vet({ from: 330, to: 334, strength: 9 }, S, sec, band));
  check('a title is tidied ("…" quotes and the full stop go)', P.vet({ from: 330, to: 345, title: '"There is only one gospel."', strength: 9 }, S, sec, band).title === 'There is only one gospel');

  console.log('\n[3] the model\'s answer is read defensively');
  check('JSON wrapped in prose is still read', (P.parseMoments('Here you go: {"moments":[{"from":3,"to":9,"title":"T","point":"p","strength":8}]} done') || []).length === 1);
  check('garbage is null, not a crash', P.parseMoments('no json here') === null);

  console.log('\n[4] the whole plan: every section\'s best point first, nothing overlapping');
  const asked = [];
  let flaky = 1;
  let edgeAsked = 0, edgeIds = 0;
  const fake = async ({ prompt }) => {
    if (/Around the START/.test(prompt)) {
      edgeAsked++;
      // the payoff of "There is only one gospel" lands one sentence later than first marked
      // (each short's point is shown with it now: "… — its point: …")
      const ids = [...prompt.matchAll(/^Short (\d+) — "([^"]*)"(?: — its point: [^\n]*?)? \(now starts at \[(\d+)\], ends at \[(\d+)\]\)/gm)];
      if (ids.length && !/its point: /.test(prompt)) edgeIds = -1;
      edgeIds = ids.length;
      return JSON.stringify({ edges: ids.map((m) => ({ id: +m[1], from: +m[3], to: m[2] === 'There is only one gospel' ? +m[4] + 1 : +m[4] })) });
    }
    asked.push(prompt.length);
    if (flaky-- > 0) return '';              // the free allowance said no once
    const nums = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => +m[1]);
    const lo = nums[0], hi = nums[nums.length - 1];
    const out = [];
    for (let f = lo + 3; f + 18 < hi; f += 40) out.push({ from: f, to: f + 15, title: `Moment at ${f}`, point: 'p', strength: f === 333 ? 10 : 6 + (f % 3) });
    if (lo <= 330 && hi >= 346) out.push({ from: 330, to: 344, title: 'There is only one gospel', point: 'one gospel', strength: 10 });
    return JSON.stringify({ moments: out });
  };
  const r = await P.planShorts({ sents: S, maxClips: 12, ask: fake, retryWaits: [5, 5, 5] });
  check('a section the allowance turned away is asked again', r && r.failed === 0 && asked.length === secs.length + 1, { asked: asked.length, secs: secs.length, failed: r && r.failed });
  check('every chosen short\'s edges are looked at again, in one call — each with its point', edgeAsked === 1 && edgeIds === r.moments.length, { edgeAsked, edgeIds });
  const og = r.moments.find((m) => m.title === 'There is only one gospel');
  check('…and an ending one sentence short of the payoff is moved onto it', og && og.to === 345 && r.edgesMoved >= 1, og && { to: og.to, moved: r.edgesMoved });
  check('12 shorts chosen', r && r.moments.length === 12, r && r.moments.length);
  const ov = r.moments.some((m, i) => i && m.start < r.moments[i - 1].end);
  check('none overlap, in order', !ov);
  check('the strongest point is in', r.moments.some((m) => m.title === 'There is only one gospel'));
  const perSec = secs.map(([x, y]) => r.moments.some((m) => m.from >= x && m.to <= y));
  check('every section of the sermon has a short', perSec.every(Boolean), perSec);
  check('each short carries its words, title and point', r.moments.every((m) => m.text && m.title && m.point && m.sents.length));
  check('every prompt fits the free tier (under ~16,000 characters)', asked.every((n) => n < 16000), Math.max(...asked));

  console.log('\n[5] a reader that never answers: no plan (the loudness scan takes over)');
  const none = await P.planShorts({ sents: S, ask: async () => '', retryWaits: [1] });
  check('null, so the caller falls back', none === null);

  console.log('\n[6] "stuck on 84%": the bar keeps moving while the AI reads, and says which step it is on');
  const told = [];
  const slow = async ({ prompt }) => {
    await new Promise((r) => setTimeout(r, 2700));   // a reader that takes its time (the real one: a minute or more)
    if (/Around the START/.test(prompt)) return JSON.stringify({ edges: [] });
    const out = [];
    for (let f = 5; f + 18 < S.length; f += 45) out.push({ from: f, to: f + 15, title: `Moment at ${f}`, point: 'p', strength: 7 });
    return JSON.stringify({ moments: out });
  };
  const t0 = Date.now();
  const w = await P.planShorts({ sents: S, maxClips: 8, ask: slow, wide: true, retryWaits: [5], onProgress: (f, stage) => told.push({ f, stage, at: Date.now() - t0 }) });
  const stages = [...new Set(told.map((x) => x.stage).filter(Boolean))];
  check('the whole sermon is planned in one reading', w && w.sections === 1 && w.moments.length === 8, w && { sections: w.sections, n: w.moments.length });
  check('it says what it is doing: reading the sermon, then perfecting each short\'s start and end',
    stages.length === 2 && /reading the sermon/i.test(stages[0]) && /start and end/i.test(stages[1]), stages);
  const during = told.filter((x) => /reading the sermon/i.test(x.stage) && x.at < 2700);
  check('while the answer is awaited, the bar moves (more than once) — no waiting on one number', during.length >= 2 && during[during.length - 1].f > during[0].f, during);
  check('it never goes backwards', told.every((x, i) => !i || x.f >= told[i - 1].f - 1e-9), told.map((x) => +x.f.toFixed(3)));
  check('…and ends at the end, the step line cleared', told.length && told[told.length - 1].f === 1 && told[told.length - 1].stage === '', told[told.length - 1]);
  const J = require('../src/main/jobs.js');
  const quick = [];
  const stop = J.creep((p, st) => quick.push([p, st]), 70, 98, 'x');
  await new Promise((r) => setTimeout(r, 300));
  check('a wait over within a second says nothing (no flash of a step)', quick.length === 0 && stop() === 70, quick);

  console.log('\n[7] every short opens on a sentence and lands on a full stop — never chopped by the clock');
  {
    // a pause at a comma breaks a "sentence" in two (highlights.buildSentences): the halves of a live sermon's lines
    const T = [];
    for (let k = 0; k < 120; k++) T.push({ start: k * 6, end: k * 6 + 5.6, text: `Line ${k} is a whole sentence about prayer and faith.` });
    T[40].text = 'Especially when the children of God gather, individual issues will be solved,';
    T[41].text = 'whether they be sicknesses or difficulty in marriage.';
    T[20].text = 'I am coming to the feet of Jesus, the feet of the cross,';
    T[21].text = 'to obtain mercy and find grace to help in time of need.';
    const sec2 = [0, T.length - 1], band2 = { minLen: 60, maxLen: 150 };
    const e = P.vet({ from: 26, to: 40, strength: 7 }, T, sec2, band2);
    check('an end on a comma ("…will be solved,") finishes its sentence', e && e.to === 41, e && [e.from, e.to]);
    const st = P.vet({ from: 21, to: 34, strength: 7 }, T, sec2, band2);
    check('a start mid-sentence ("to obtain mercy…") goes back to where the sentence began', st && st.from === 20, st && [st.from, st.to]);
    // too long for the band: 40 lines of 6 s is 240 s — it is cut back on whole sentences, inside the cut's own limit
    const lng = P.vet({ from: 5, to: 45, strength: 7 }, T, sec2, band2);
    const okLong = lng && lng.end - lng.start <= P.ceilFor(150) && /[.!?]$/.test(T[lng.to].text) && (lng.from === 0 || /[.!?]$/.test(T[lng.from - 1].text));
    check('a moment longer than the band is shortened on whole sentences, never past 150 + 4 s (the cut stops at +6)', okLong, lng && [lng.from, lng.to, lng.end - lng.start]);
    check('the limit is the cut\'s, not 8% over it (150 s band: 154 s, not 162 s)', P.ceilFor(150) === 154 && Math.abs(P.ceilFor(45) - 48.6) < 1e-9, [P.ceilFor(150), P.ceilFor(45)]);
    T[60].text = "You understand what I'm saying?"; T[61].text = "You understand what I'm saying?";
    const ck = P.vet({ from: 45, to: 61, strength: 7 }, T, sec2, band2);
    check('a short does not end on the preacher checking on the room ("You understand what I\'m saying?")', ck && ck.to === 59, ck && [ck.from, ck.to]);
    const fw = P.finishWhole(T, 21, 41, 154);
    check('finishWhole: both edges whole', fw && fw.from === 20 && fw.to === 41, fw);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
