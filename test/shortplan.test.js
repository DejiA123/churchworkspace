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
      const ids = [...prompt.matchAll(/^Short (\d+) — "([^"]*)" \(now starts at \[(\d+)\], ends at \[(\d+)\]\)/gm)];
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
  check('every chosen short\'s edges are looked at again, in one call', edgeAsked === 1 && edgeIds === r.moments.length, { edgeAsked, edgeIds });
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
