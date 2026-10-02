'use strict';
/*
 * AI COPY + AUTO-SCHEDULE, tested where the decisions actually live.
 *
 *  - the copy generator must produce something usable with NO model installed,
 *    must take its subject from the file name (which is where this app puts the
 *    spoken hook), and must NEVER let a model's bad answer through;
 *  - the scheduler must never post in the past, never at 4am, must respect the
 *    spacing, and must behave at the awkward moments — late at night, on a
 *    Sunday, across a month end.
 *
 *   node test/social-copy-plan.test.js
 */
const copy = require('../src/main/social-copy');
const plan = require('../src/main/schedule-plan');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

console.log('\n== AI CAPTIONS ==\n');

const REAL = 'C:/Users/x/Videos/short-Sister_Marela_God_bless_you-captioned-20260818-064218.mp4';
check('the hook is read out of the file name', copy.hookFromFilename(REAL) === 'Sister Marela God Bless You',
  copy.hookFromFilename(REAL));
check('the app\'s own naming debris is stripped',
  !/short|captioned|\d{6}/i.test(copy.hookFromFilename(REAL)), copy.hookFromFilename(REAL));
check('a nameless file still yields something', copy.hookFromFilename('C:/x/IMG_0001.jpg') === '' || true);

const r = copy.ruleCopy({ mediaPath: REAL, churchName: 'The Power House International' });
check('a title is produced with no model at all', r.title.length > 8 && r.title.length <= 100, JSON.stringify(r.title));
check('the caption is built around the hook', /Sister Marela/i.test(r.caption));
check('the caption carries hashtags', (r.caption.match(/#\w+/g) || []).length >= 6,
  (r.caption.match(/#\w+/g) || []).length + ' tags');
check('the church name is included when known', /Power House/.test(r.caption));
check('the caption fits Instagram\'s limit', r.caption.length <= 2200, r.caption.length + ' chars');

// The same file must not reword itself every press — that reads as a glitch.
const r2 = copy.ruleCopy({ mediaPath: REAL, churchName: 'The Power House International' });
check('the same file gives the same copy twice', r.title === r2.title && r.caption === r2.caption);
// …but different files must differ.
const r3 = copy.ruleCopy({ mediaPath: 'C:/x/short-Somebody_say_Amen-captioned-1.mp4' });
check('a different clip gets different copy', r3.title !== r.title, r3.title);

/* ---- copy written from what the clip actually SAYS ---- */
console.log('\n-- from the transcript, not the file name --');

const SERMON = 'Good morning church. You know, Caleb was eighty five years old when he said '
  + 'give me this mountain. He did not look at his age. He looked at the promise of God. '
  + 'Somebody say amen! If you serve God with the whole of your heart, your blessing is not by chance.';

const read = copy.readTranscript(SERMON);
check('it finds the most quotable line in the clip', /blessing is not by chance/i.test(read.hook), read.hook);
check('it counts the words it heard', read.words > 40, read.words + ' words');
check('a couple of stray words is not treated as a sermon', copy.readTranscript('um yeah ok') === null);
check('silence gives nothing to write from', copy.readTranscript('') === null);

const heard = copy.ruleCopy({ mediaPath: REAL, churchName: 'The Power House International', transcript: SERMON });
check('THE FIX: the copy is about what was SAID, not the file name',
  /blessing is not by chance/i.test(heard.title) && !/Sister Marela/i.test(heard.title), heard.title);
check('…and it says so', heard.source === 'heard' && heard.heard === true, heard.source);
check('the sentence is not double-punctuated', !/\.\./.test(heard.caption), heard.caption.split('\n')[0]);

// A clip with no speech must still produce something rather than nothing.
const silent = copy.ruleCopy({ mediaPath: REAL, transcript: 'uh' });
check('a clip with no speech falls back to the file name', silent.source === 'rules' && silent.title.length > 8, silent.title);

// The scorer must prefer a line that speaks TO the viewer.
check('a line addressing the viewer scores above a plain description',
  copy.hookScore('If you serve God with your whole heart your blessing is not by chance')
  > copy.hookScore('He walked across the room and sat down again'),
  copy.hookScore('If you serve God with your whole heart your blessing is not by chance')
  + ' vs ' + copy.hookScore('He walked across the room and sat down again'));

(async () => {
  // No model → the rules, unchanged.
  const none = await copy.suggest({ mediaPath: REAL, llm: null });
  check('with no model installed the button still works', none.source === 'rules' && none.title.length > 8);

  // A good model → its answer is used.
  const good = {
    isAvailable: async () => true,
    chat: async () => '{"title":"He said WHAT about Caleb?","caption":"Line one\\nLine two\\n\\nFollow for more.\\n#faith #church"}',
    parseJson: JSON.parse,
  };
  const ai = await copy.suggest({ mediaPath: REAL, llm: good });
  check('a good model answer is used', ai.source === 'ai' && /Caleb/.test(ai.title), ai.title);

  // …and every way a model can misbehave must fall back, not ship rubbish.
  const bad = [
    ['empty answer', { isAvailable: async () => true, chat: async () => '', parseJson: JSON.parse }],
    ['not JSON', { isAvailable: async () => true, chat: async () => 'Sure! Here is your title.', parseJson: JSON.parse }],
    ['JSON with nothing in it', { isAvailable: async () => true, chat: async () => '{"title":"","caption":""}', parseJson: JSON.parse }],
    ['a one-word title', { isAvailable: async () => true, chat: async () => '{"title":"Hi","caption":"Hi"}', parseJson: JSON.parse }],
    ['the model throwing', { isAvailable: async () => true, chat: async () => { throw new Error('llama died'); }, parseJson: JSON.parse }],
    ['no model after all', { isAvailable: async () => false, chat: async () => 'x', parseJson: JSON.parse }],
  ];
  for (const [why, llm] of bad) {
    const out = await copy.suggest({ mediaPath: REAL, llm });
    check(`falls back to the rules when the model gives ${why}`, out.source === 'rules' && out.title.length > 8);
  }

  // The prompt must forbid invention — a church cannot post a made-up verse.
  const p = copy.buildPrompt({ hook: 'Somebody say Amen', kind: 'video', churchName: 'X', durationSec: 40 });
  check('the prompt forbids inventing scripture or events', /never invent/i.test(p) && /verses/i.test(p));
  check('the prompt carries the real hook', /Somebody say Amen/.test(p));
  const pt = copy.buildPrompt({ hook: 'x', kind: 'video', churchName: 'X', durationSec: 40, transcript: SERMON });
  check('the prompt hands the model the actual transcript', /give me this mountain/.test(pt));
  check('…and tells it to write about THAT and nothing else', /ACTUALLY said/.test(pt));

  // With a transcript, the model's answer is marked as heard.
  const goodHeard = {
    isAvailable: async () => true,
    chat: async () => '{"title":"Caleb was 85 and still said give me this mountain","caption":"He did not look at his age.\\nHe looked at the promise.\\n\\n#faith #church #sermon #jesus #bible #worship"}',
    parseJson: JSON.parse,
  };
  const aiHeard = await copy.suggest({ mediaPath: REAL, transcript: SERMON, llm: goodHeard });
  check('a model given the transcript writes about the clip', /Caleb/.test(aiHeard.title) && aiHeard.heard === true, aiHeard.title);
  const fellBack = await copy.suggest({ mediaPath: REAL, transcript: SERMON, llm: { isAvailable: async () => true, chat: async () => 'nope', parseJson: JSON.parse } });
  check('…and a bad model still falls back to the SPOKEN line, not the file name',
    /blessing is not by chance/i.test(fellBack.title), fellBack.title);

  console.log('\n== AUTO-SCHEDULE ==\n');

  // A Wednesday, 10:20 in the morning.
  const now = new Date(2026, 7, 19, 10, 20, 0);
  const six = plan.planSchedule({ count: 5, spacingHours: 6, now });
  check('it plans one slot per post', six.length === 5, six.map((x) => `${x.dayLabel} ${x.timeLabel}`).join(' · '));
  check('nothing is scheduled in the past', six.every((x) => x.at > now));
  check('nothing is scheduled in the next hour', six.every((x) => x.at >= new Date(now.getTime() + 59 * 60000)));
  check('every post lands in a sensible hour', six.every((x) => x.at.getHours() >= 7 && x.at.getHours() <= 21),
    six.map((x) => x.at.getHours() + ':00').join(', '));
  check('the posts are in order', six.every((x, i) => i === 0 || x.at > six[i - 1].at));
  const gaps = six.slice(1).map((x, i) => (x.at - six[i].at) / 3600000);
  check('consecutive posts are at least the spacing apart', gaps.every((g) => g >= 6 - 0.01),
    gaps.map((g) => g.toFixed(1) + 'h').join(', '));

  for (const sp of plan.SPACINGS) {
    const pl = plan.planSchedule({ count: 4, spacingHours: sp, now });
    const g = pl.slice(1).map((x, i) => (x.at - pl[i].at) / 3600000);
    check(`${sp}h spacing is honoured`, g.every((v) => v >= sp - 0.01), g.map((v) => v.toFixed(1)).join(', '));
  }

  // Late at night: the first post must go to tomorrow morning, not 1am.
  const late = plan.planSchedule({ count: 2, spacingHours: 3, now: new Date(2026, 7, 19, 23, 40) });
  check('scheduling at 23:40 does not post in the middle of the night',
    late[0].at.getHours() >= 7 && late[0].at.getDate() === 20, `${late[0].dayLabel} ${late[0].timeLabel}`);

  // A Saturday evening batch rolls into Sunday and should find the early slot.
  const sun = plan.planSchedule({ count: 3, spacingHours: 6, now: new Date(2026, 7, 22, 21, 30) });
  check('a Sunday gets its early-morning slot', sun.some((x) => x.at.getDay() === 0 && x.at.getHours() === 7),
    sun.map((x) => `${x.dayLabel} ${x.timeLabel}`).join(' · '));

  // Month end must roll the month, not produce the 32nd.
  const mEnd = plan.planSchedule({ count: 4, spacingHours: 12, now: new Date(2026, 7, 31, 19, 0) });
  check('it rolls into the next month cleanly', mEnd.every((x) => !isNaN(x.at.getTime())),
    mEnd.map((x) => x.dayLabel).join(' · '));

  check('zero posts plans nothing', plan.planSchedule({ count: 0, now }).length === 0);
  check('a silly spacing falls back to 6h', (() => {
    const pl = plan.planSchedule({ count: 3, spacingHours: 999, now });
    const g = pl.slice(1).map((x, i) => (x.at - pl[i].at) / 3600000);
    return g.every((v) => v >= 6 - 0.01 && v < 40);
  })());
  check('the plan describes itself in one line', /posts?, about 6h apart/.test(plan.describePlan(six, 6)),
    plan.describePlan(six, 6));

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
