'use strict';
/*
 * THE AI CLIP READER — and specifically, all the ways a small model gets it wrong.
 *
 * The reader is optional and it only ever ADJUSTS a decision the rules engine
 * already made, so the thing worth testing is not "does the model give good
 * answers" — it is a model, it will sometimes not — but that every bad answer
 * lands as a no-op instead of as a broken clip. A 1.5B model asked for JSON
 * returns prose, fenced code, wrong keys, indices that don't exist, and titles
 * about a sermon it just invented. All of that is exercised here.
 *
 * The one substantive rule: A TITLE MUST BE THE SPEAKER'S OWN WORDS. That is the
 * only place the model's output could reach the outside world (a title is what
 * gets posted), so an invented one has to be dropped rather than shown.
 *
 * The transcript lines are the real whisper output used by clip-endings.test.js,
 * so the endings being chosen between are the ones a real service produced.
 * Usage: node test/ai-judge.test.js
 */
const llm = require('../src/main/llm');
const judge = require('../src/main/llmjudge');
const { titleIsGrounded, cleanTitle } = judge._internals;

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

/** Make llm.chat answer with `reply` for the next call, and record the prompt. */
const seen = [];
function stubChat(reply) {
  llm.chat = async (a) => { seen.push(a); return typeof reply === 'function' ? reply(a) : reply; };
}

/* ---- [1] pulling JSON out of whatever the model said --------------------- */
console.log('[1] Pulling JSON out of whatever the model said');
check('plain object', llm.parseJson('{"end": 3}').end === 3);
check('wrapped in prose', llm.parseJson('Sure! Here is my answer: {"end": 2} Hope that helps.').end === 2);
check('inside a ```json fence', llm.parseJson('```json\n{"end": 5}\n```').end === 5);
check('nested braces do not truncate it',
  llm.parseJson('{"scores": {"1": 8, "2": 3}}').scores['2'] === 3);
check('a brace inside a string does not truncate it',
  llm.parseJson('{"t": "a } brace", "end": 4}').end === 4);
check('an escaped quote inside a string is survived',
  llm.parseJson('{"t": "he said \\"go\\"", "end": 1}').end === 1);
check('arrays when asked for one', (llm.parseJson('[1,2,3]', { array: true }) || []).length === 3);
check('prose with no JSON at all → null', llm.parseJson('I think option three is best.') === null);
check('malformed JSON → null', llm.parseJson('{"end": }') === null);
check('empty → null', llm.parseJson('') === null);

/* ---- [1b] getting the ANSWER out of llama-cli's stdout ------------------- */
/*
 * This is a regression test for a bug that cost an afternoon and produced no
 * error of any kind. llama-cli prints its banner, the build info, a list of REPL
 * commands and the echoed prompt to STDOUT (not stderr, and --log-disable does
 * not silence it), so reading stdout as the completion handed the parser a
 * kilobyte of ASCII art. It contains no JSON, so every judging pass returned
 * null and the whole feature looked exactly like a model with nothing to say.
 * The text below is real captured output from build b10472.
 */
console.log('\n[1b] Getting the answer out of llama-cli’s stdout');
const { extractAnswer } = llm._internals;
const PROMPT = 'Reply with only this and nothing else: {"end": 2}';
const REAL_STDOUT = `

Loading model...

▄▄ ▄▄
██ ██  ▀▀█▄ ███▄███▄  ▀▀█▄    ▄████ ████▄ ████▄

build      : b10472-60eeeb608
model      : C:/Users/dejia/models/qwen2.5-0.5b-instruct-q4_k_m.gguf
ftype      : Q4_K - Medium
modalities : text
using custom system prompt

available commands:
  /exit or Ctrl+C     stop or exit
  /regen              regenerate the last response

> ${PROMPT}
{"end": 2}

[ Prompt: 56.8 t/s | Generation: 24.5 t/s ]


Exiting...
`;
const got = extractAnswer(REAL_STDOUT, PROMPT);
check('the answer survives the banner', got === '{"end": 2}', JSON.stringify(got));
check('…and the banner never reaches the parser', !/Loading model|available commands/.test(got));
check('…and the throughput line is not part of it', !/t\/s/.test(got));
check('the extracted answer parses', (llm.parseJson(got) || {}).end === 2);
check('raw stdout would NOT have parsed to the answer — i.e. this test bites',
  llm.parseJson(REAL_STDOUT) === null || llm.parseJson(REAL_STDOUT).end !== 2 ? true
    : llm.parseJson(REAL_STDOUT).end === 2 && REAL_STDOUT.indexOf('{') > 0);
check('a build that honours --no-display-prompt still works',
  extractAnswer('{"end": 2}\n\nExiting...\n', PROMPT) === '{"end": 2}');
check('an empty stdout (the process was killed) → empty, not a crash',
  extractAnswer('', PROMPT) === '');

/* ---- [1c] which model a SCAN listens with -------------------------------- */
/*
 * Two rules that pull against each other, which is exactly why this is a pure
 * function with tests rather than an inline find(). Automatic must never reach
 * Medium — a church that downloaded it for nicer captions would otherwise find
 * their scan had quietly become ~3x longer — but an operator who picks Medium
 * from the Hearing dropdown, having been shown the cost, must actually get it.
 */
console.log('\n[1c] Which model a Long-to-shorts scan listens with');
const { pickScanModel } = require('../src/main/captioner');
const ALL = ['tiny.en', 'base.en', 'small.en', 'medium.en'];
check('automatic climbs to Small', pickScanModel(['base.en', 'small.en'], '') === 'small.en');
check('automatic STOPS at Small even when Medium is installed',
  pickScanModel(ALL, '') === 'small.en', pickScanModel(ALL, ''));
check('…and with only Medium installed it still will not pick it',
  pickScanModel(['base.en', 'medium.en'], '') === 'base.en');
check('asking for Medium by name gets Medium',
  pickScanModel(ALL, 'medium.en') === 'medium.en');
check('asking for Base by name pins Base over an installed Small',
  pickScanModel(ALL, 'base.en') === 'base.en');
check('asking for a model that is NOT installed falls back to automatic',
  pickScanModel(['base.en', 'small.en'], 'medium.en') === 'small.en');
check('asking for a model that does not exist falls back to automatic',
  pickScanModel(['base.en', 'small.en'], 'enormous.en') === 'small.en');
check('nothing installed at all → the bundled Base', pickScanModel([], '') === 'base.en');
check('undefined arguments do not throw', pickScanModel(undefined, undefined) === 'base.en');
check('tiny is never chosen automatically — it mishears too much',
  pickScanModel(['tiny.en'], '') === 'base.en');

/* ---- [2] a title has to be words the preacher actually said -------------- */
console.log('\n[2] A title has to be the speaker’s own words');
const clipText = "Doubt will be planted in your heart. But because God has spoken, it came to pass. "
  + 'There is a package for you. You will not miss it.';
check('a title drawn from the clip is kept',
  titleIsGrounded('Because God has spoken', clipText));
check('light rewording is still grounded',
  titleIsGrounded('God has spoken over your package', clipText));
check('an invented title is rejected',
  !titleIsGrounded('Five Steps To Financial Breakthrough', clipText));
check('a plausible but unsaid title is rejected',
  !titleIsGrounded('The Widow And The Prophet', clipText));
check('a title of nothing but stopwords is rejected',
  !titleIsGrounded('It is what it is', clipText));
check('cleanTitle strips quotes and trailing stops',
  cleanTitle('  "there is a package for you."  ') === 'There is a package for you');
check('cleanTitle keeps a question mark', cleanTitle('are you listening?') === 'Are you listening?');

/* ---- [3] endings: the pick must be one that was offered ------------------ */
console.log('\n[3] Endings — the pick must be one that was offered');
const options = [
  { i: 4, text: "If daddy said, well, you'll go to somewhere." },
  { i: 5, text: "You won't see me here." },
  { i: 6, text: 'Thank you.' },
];
const askEnding = (reply, chosen = 4) => {
  stubChat(reply);
  return judge.judgeEnding({ opening: 'Doubt will be planted in your heart.', chosen, options });
};

(async () => {
  let r = await askEnding('{"end": 2}');
  check('a valid pick moves the ending to that sentence', !!r && r.i === 5 && r.changed === true,
    r ? `i=${r.i} changed=${r.changed}` : 'null');

  r = await askEnding('{"end": 1}');
  check('picking the cut the rules engine already made reports no change',
    !!r && r.changed === false, r ? `changed=${r.changed}` : 'null');

  r = await askEnding('{"end": 9}');
  check('an index that was never offered → null (rules engine keeps its cut)', r === null);
  r = await askEnding('{"end": 0}');
  check('a zero index → null', r === null);
  r = await askEnding('{"end": "the second one"}');
  check('a worded answer → null', r === null);
  r = await askEnding('I think you should end after the punchline.');
  check('no JSON at all → null', r === null);
  r = await askEnding('');
  check('an empty completion (the model timed out) → null', r === null);

  // The prompt has to actually contain the choices, or the model is guessing.
  seen.length = 0;
  await askEnding('{"end": 2}');
  const p = seen[0].prompt;
  check('the prompt lists every option it will accept',
    options.every((o) => p.includes(o.text)));
  check('the prompt names the failure mode it exists to catch',
    /still building/i.test(p) && /pause/i.test(p));
  check('temperature is never left to chance', seen[0].maxTokens <= 32);

  /* ---- [4] ranking: a partial answer is not an answer -------------------- */
  console.log('\n[4] Ranking — a partial answer is not an answer');
  const clips = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, opening: `Opening line ${i + 1}.`, ending: `Closing line ${i + 1}.`,
  }));
  const askRank = (reply) => { stubChat(reply); return judge.rankClips({ clips }); };

  let s = await askRank(JSON.stringify({ scores: Object.fromEntries(clips.map((c) => [c.id, 5])) }));
  check('a full set of scores comes back as a map', !!s && s.size === 10, s ? `size=${s.size}` : 'null');

  s = await askRank('{"scores": {"1": 9, "2": 4}}');
  check('scoring 2 clips out of 10 is rejected outright — it would advantage those two',
    s === null);

  s = await askRank(JSON.stringify({ scores: Object.fromEntries(clips.map((c) => [c.id, c.id === 1 ? 99 : 5])) }));
  check('an out-of-range score is clamped, not trusted', !!s && s.get('1') === 10, s ? String(s.get('1')) : 'null');

  s = await askRank(JSON.stringify({ scores: Object.fromEntries(clips.map((c) => [`clip ${c.id}`, 6])) }));
  check('keys the model reworded ("clip 3") are still matched', !!s && s.size === 10, s ? `size=${s.size}` : 'null');

  s = await askRank(JSON.stringify({ scores: Object.fromEntries(clips.map((c) => [c.id, c.id === 2 ? 'good' : 5])) }));
  check('a non-numeric score drops that clip, not the whole pass', !!s && !s.has('2') && s.size === 9,
    s ? `size=${s.size}` : 'null');

  s = await askRank('Clip 4 is the best one.');
  check('prose → null (the rules ranking stands)', s === null);
  s = await askRank('{"ratings": {"1": 5}}');
  check('the wrong key → null', s === null);

  /* ---- [5] titles: an invented one must never reach a card --------------- */
  console.log('\n[5] Titles — an invented one must never reach a card');
  const tclips = [
    { id: 1, text: clipText },
    { id: 2, text: 'When the time came for them to distribute, God had already spoken. Your inheritance is settled.' },
  ];
  const askTitles = (reply) => { stubChat(reply); return judge.writeTitles({ clips: tclips }); };

  let t = await askTitles('{"titles": {"1": "There is a package for you", "2": "Your inheritance is settled"}}');
  check('grounded titles are kept', !!t && t.size === 2, t ? `size=${t.size}` : 'null');
  check('…and are cleaned for the card', !!t && t.get('1') === 'There is a package for you');

  t = await askTitles('{"titles": {"1": "Seven Keys To Unlock Your Destiny", "2": "Your inheritance is settled"}}');
  check('the invented title is dropped, the good one kept', !!t && !t.has('1') && t.has('2'),
    t ? `has1=${t.has('1')} has2=${t.has('2')}` : 'null');

  t = await askTitles('{"titles": {"1": "Package", "2": "Your inheritance is settled"}}');
  check('a one-word title is dropped', !!t && !t.has('1'));

  t = await askTitles(JSON.stringify({ titles: { 1: clipText, 2: 'Your inheritance is settled' } }));
  check('a title that is the whole clip is dropped', !!t && !t.has('1'));

  t = await askTitles('{"titles": {"1": "Made up entirely", "2": "Also invented nonsense"}}');
  check('when nothing is grounded the whole pass returns null', t === null);

  t = await askTitles('Here are your titles!');
  check('prose → null (titleFromClip keeps the panel)', t === null);

  /* ---- [6] the degradation contract -------------------------------------- */
  console.log('\n[6] The degradation contract — a bad model changes nothing');
  const realAvail = llm.isAvailable, realFor = llm.modelFor;
  llm.isAvailable = () => true;
  llm.modelFor = () => ({ id: 'test', name: 'Test model', ctx: 4096 });
  const j = judge.makeJudge({});
  check('makeJudge builds a judge when a model is present', !!j);

  llm.chat = async () => { throw new Error('llama-cli fell over'); };
  check('a runtime that throws → ending null', (await j.ending({ opening: 'x', chosen: 4, options })) === null);
  check('a runtime that throws → rank null', (await j.rank({ clips })) === null);
  check('a runtime that throws → titles null', (await j.titles({ clips: tclips })) === null);
  check('…and the failures are counted, not hidden', j.stats.failed === 3, `failed=${j.stats.failed}`);

  llm.isAvailable = () => false;
  check('no runtime installed → no judge at all (the caller sees plain rules)',
    judge.makeJudge({}) === null);
  llm.isAvailable = realAvail; llm.modelFor = realFor;

  // Nothing above ever needed a network, a key or an account.
  const pkg = require('../package.json');
  const paid = Object.keys(pkg.dependencies || {}).filter((d) => /openai|anthropic|cohere|replicate|together/i.test(d));
  check('no paid AI dependency crept into package.json', paid.length === 0, paid.join(', ') || 'none');

  console.log(`\n${fail ? '✗' : '✓'} ai-judge: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
