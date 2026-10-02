'use strict';
/*
 * WHERE DOES A PHRASE END?
 *
 * 🎤 Listen sends whisper one spoken phrase at a time, and the whole responsive-
 * ness of the feature rests on spotting the pause at the end of one. Too eager
 * and "turn with me to John chapter three" gets cut before "verse sixteen"; too
 * slow and the screen lags a sentence behind the preacher.
 *
 * The endpointer is a plain function of levels in and phrases out, so this
 * pushes made-up level readings through it — a quiet hall, a noisy one, coughs,
 * a preacher who does not pause for eleven seconds — and checks it draws the
 * lines in the right places. No microphone, no sound card, runs in milliseconds.
 *
 *   node test/voice-endpoint.test.js
 */
const { endpointer, BLOCK_MS } = require('../src/renderer/voiceear');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const ms = (blocks) => Math.round(blocks * BLOCK_MS);

/** Push a script of [level, milliseconds] pairs and collect the phrases. */
function run(script, opts) {
  const ep = endpointer(opts);
  const out = [];
  let at = 0;
  for (const [level, dur] of script) {
    for (let t = 0; t < dur; t += BLOCK_MS) {
      const p = ep.push(level);
      at++;
      if (p) out.push({ startMs: ms(p.start), endMs: ms(p.end), lenMs: ms(p.end - p.start) });
    }
  }
  return out;
}
const QUIET = 0.0008, TALK = 0.05, LOUD = 0.2;

console.log('\n== 🎤 LISTEN: finding the pause at the end of a phrase ==\n');

console.log('[1] One phrase in a quiet hall');
{
  const p = run([[QUIET, 1200], [TALK, 1800], [QUIET, 1500]]);
  check('exactly one phrase came out', p.length === 1, `${p.length}`);
  if (p[0]) {
    check('…it starts a little BEFORE the first loud block (pre-roll)',
      p[0].startMs < 1200 && p[0].startMs > 700, `starts at ${p[0].startMs} ms, speech began at 1200`);
    check('…and it covers the speech', p[0].lenMs >= 1700 && p[0].lenMs < 2700, `${p[0].lenMs} ms for 1800 ms of talking`);
  }
}

console.log('\n[2] Two phrases with a breath between them');
{
  const p = run([[QUIET, 800], [TALK, 1400], [QUIET, 900], [TALK, 1200], [QUIET, 1200]]);
  check('two phrases, not one run-on', p.length === 2, `${p.length}: ${p.map((x) => x.lenMs + 'ms').join(', ')}`);
}

console.log('\n[3] A short breath INSIDE a phrase does not split it');
{
  // "turn with me to John chapter three … verse sixteen" — a 200 ms gap
  const p = run([[QUIET, 800], [TALK, 1200], [QUIET, 200], [TALK, 900], [QUIET, 1200]]);
  check('the gap is ridden through', p.length === 1, `${p.length} phrase(s)`);
  if (p[0]) check('…and both halves are in it', p[0].lenMs >= 2100, `${p[0].lenMs} ms`);
}

console.log('\n[4] Coughs, chairs and door bangs are not phrases');
{
  const p = run([[QUIET, 900], [LOUD, 90], [QUIET, 1200], [LOUD, 60], [QUIET, 1200]]);
  check('nothing was sent to the speech engine', p.length === 0, `${p.length} phrase(s)`);
}

console.log('\n[5] A noisy hall — the threshold rises to meet it');
{
  // air handling at a level that would be "speech" in a silent room
  const NOISE = 0.01;
  const p = run([[NOISE, 2000], [NOISE * 12, 1600], [NOISE, 1500]]);
  check('the air handler alone is not speech, the voice over it is', p.length === 1,
    `${p.length} phrase(s)`);
}

console.log('\n[6] A preacher who does not pause is still transcribed');
{
  const p = run([[QUIET, 700], [TALK, 30000], [QUIET, 1200]], { maxPhraseMs: 12000 });
  check('long speech is cut into pieces rather than held forever', p.length >= 2, `${p.length} pieces`);
  check('…and no piece is longer than the cap', p.every((x) => x.lenMs <= 12600),
    `longest ${Math.max(...p.map((x) => x.lenMs))} ms`);
}

console.log('\n[7] Silence produces nothing at all');
check('an empty room sends nothing', run([[QUIET, 30000]]).length === 0, 'quiet');
check('digital silence sends nothing', run([[0, 30000]]).length === 0, 'silence');

console.log('\n[8] The pause is not so long that the screen feels slow');
{
  // From the last word to the phrase being handed over: hangover + a little.
  const ep = endpointer();
  let fired = -1, i = 0;
  const push = (v, dur) => { for (let t = 0; t < dur; t += BLOCK_MS) { const p = ep.push(v); i++; if (p && fired < 0) fired = i; } };
  push(QUIET, 800); push(TALK, 1200);
  const lastWord = i;
  push(QUIET, 2000);
  const waitMs = ms(fired - lastWord);
  check('handed over within ~700 ms of the last word', waitMs > 0 && waitMs < 750, `${waitMs} ms after the speaker stopped`);
}

/* ===================================================================
 * The other half of the response time: how much of whisper's encoder
 * window each phrase asks for.
 * =================================================================== */
console.log('\n[9] The encoder window is sized to the phrase, with margin');
{
  const { audioCtxFor } = require('../src/main/voicelisten');
  /*
   * whisper encodes a 30-second window whatever it is given, and on a two-second
   * instruction that was 766 ms of the 1.3 s — spent almost entirely on silence.
   * Shortening the window is where the speed came from, so these numbers are
   * load-bearing.
   */
  check('a short instruction gets the floor, not the whole 30 seconds',
    audioCtxFor(2) === 256, `2 s -> ${audioCtxFor(2)}`);
  check('a longer sentence gets more', audioCtxFor(8) > audioCtxFor(4) && audioCtxFor(4) > audioCtxFor(2),
    `2 s ${audioCtxFor(2)}, 4 s ${audioCtxFor(4)}, 8 s ${audioCtxFor(8)}`);
  check('…and it never exceeds the full window', audioCtxFor(60) === 1500, `60 s -> ${audioCtxFor(60)}`);
  /*
   * THE CLIFF. Measured on 22 spoken instructions: everything from 1500 down to
   * 192 got all 22 right, and 128 got 15 — because too small a window does not
   * error, it LOOPS ("John chapter 3, 3, 3, 3, 3…") and parses as a confident,
   * wrong "John 3". So the floor must keep real clearance above 192, not sit on
   * the last value that happened to work.
   */
  check('the floor keeps clear of where the model starts repeating itself',
    audioCtxFor(0.5) >= 256, `shortest possible -> ${audioCtxFor(0.5)} (192 still worked, 128 broke)`);
  check('every phrase length the ear can send stays above that floor',
    [0.4, 1, 2, 3, 5, 8, 12].every((s) => audioCtxFor(s) >= 256 && audioCtxFor(s) >= s * 50),
    [0.4, 1, 2, 3, 5, 8, 12].map((s) => `${s}s:${audioCtxFor(s)}`).join(' '));
}

/*
 * ►► THE LOOK-BACK SCHEDULE ◄◄
 *
 * Waiting for a pause is right about somebody giving an instruction and wrong
 * about somebody preaching: measured on a real sermon it produced phrases with
 * a median length of 8.7 s, so a reference said mid-sentence waited that long
 * to be looked at. The ear now also offers the last few seconds WHILE the
 * speaking goes on. What has to be true of those offers is small and exact.
 */
{
  console.log('\n[5] Looking back while somebody is still talking');
  const { DEFAULTS } = require('../src/renderer/voiceear');
  const blocks = (ms) => Math.round(ms / BLOCK_MS);
  const ep = endpointer();
  const looks = [];
  let phrase = null;
  // A moment of room tone first: the threshold is learned from the quiet, so a
  // signal that starts at full level and never stops simply raises the floor to
  // meet itself and nothing is ever heard. (That is the design — see the note on
  // the noise floor above — but it does mean a test has to hand it silence.)
  for (let i = 0; i < blocks(1000); i++) { ep.push(1e-5); ep.look(); }
  // …then 20 seconds of unbroken speech: a preacher in full flow.
  const from = blocks(1000);
  for (let i = from; i < from + blocks(20000); i++) {
    const done = ep.push(0.05);
    if (done && !phrase) phrase = { at: i, span: done };
    const lk = ep.look();
    if (lk) looks.push({ at: i - from, span: lk });
  }
  check('it offers look-backs during continuous speech', looks.length > 5, `${looks.length} in 20s`);
  // Measured on the SPAN, not on when it arrived: the phrase starts a little
  // before the level crosses (preRollMs), so a look-back that lands 1.25 s in
  // is still carrying 1.5 s of audio, which is the thing that matters.
  const span0 = looks.length ? (looks[0].span.end - looks[0].span.start) * BLOCK_MS : 0;
  check('…but never with less audio than it promises to carry',
    looks.length > 0 && span0 >= DEFAULTS.liveMinMs,
    `first look-back carries ${span0}ms, floor ${DEFAULTS.liveMinMs}ms`);
  const gaps = looks.slice(1).map((l, i) => (l.at - looks[i].at) * BLOCK_MS);
  check('…and no faster than the hop', gaps.every((g) => g >= DEFAULTS.liveHopMs - BLOCK_MS),
    `smallest gap ${Math.min(...gaps)}ms, hop ${DEFAULTS.liveHopMs}ms`);
  check('a look-back never covers more than the window it promises',
    looks.every((l) => (l.span.end - l.span.start) * BLOCK_MS <= DEFAULTS.liveWinMs + BLOCK_MS),
    `longest ${Math.max(...looks.map((l) => (l.span.end - l.span.start) * BLOCK_MS))}ms of ${DEFAULTS.liveWinMs}ms`);
  check('a look-back never reaches back before the phrase began',
    looks.every((l) => l.span.start >= 0), 'all within the phrase');
  check('it is marked as a look-back, so the studio can refuse to step the screen on it',
    looks.every((l) => l.span.partial === true));
  // Silence: nothing is offered when nobody is speaking.
  const quiet = endpointer();
  let offered = 0;
  for (let i = 0; i < blocks(6000); i++) { quiet.push(1e-6); if (quiet.look()) offered++; }
  check('nothing is offered while nobody is talking', offered === 0, `${offered} look-backs in 6s of silence`);
}

/* ============ [10] IT MUST NOT GO DEAF PARTWAY THROUGH A SERMON ==========
 *
 * The bug this guards was silent, slow, and fatal to the whole feature.
 *
 * A preacher in full flow never pauses long enough to end a phrase, so phrases
 * end at the LENGTH CAP instead — and at that instant the speaker is still
 * talking. `speaking` goes false, and the handful of blocks before speech is
 * detected again were fed to the noise floor as though they were the room. Four
 * blocks is nothing; a cap every eight seconds for half an hour is not. After
 * about eleven of them the floor's own 30th percentile IS speech level, the
 * threshold sits 9 dB above THAT, and nothing in the hall is ever loud enough
 * to count as speaking again.
 *
 * Nothing errors. The meter still moves. There are simply no phrases, no
 * look-backs and no transcript, for the rest of the service. Measured with the
 * shipping settings before the fix: deaf after 84 seconds of 600.
 *
 * Both directions are checked, because the obvious fix — never learn from a
 * loud block — breaks the other one: a hall that GAINS a fan has nothing below
 * the threshold ever again, and a floor that cannot rise would hear the fan as
 * a sermon for ever.
 */
{
  console.log('\n[10] Half an hour of preaching without a proper pause');
  // Somebody talking without pausing: loud, with a syllable gap every 250 ms.
  // Never a flat line — a flat line is a room, and the endpointer now says so.
  const talking = (i) => (i % 8 === 0 ? 0.02 : 0.2);
  const blocks = (n) => Math.round(n / BLOCK_MS);
  const ep = endpointer();
  for (let i = 0; i < 60; i++) ep.push(1e-6);        // learn a quiet hall first
  let heard = 0, looks = 0;
  const N = blocks(30 * 60000);
  for (let i = 0; i < N; i++) {
    ep.push(talking(i));
    if (ep.speaking) heard++;
    if (ep.look()) looks++;
  }
  check('it is still hearing the preacher half an hour in', heard > N * 0.9,
    `speaking for ${(heard * BLOCK_MS / 1000).toFixed(0)}s of 1800s`);
  check('…and still offering look-backs', looks > 1000, `${looks} look-backs`);

  /*
   * SWITCHED ON MID-SENTENCE, which is what actually happens: the operator
   * remembers 🎤 Listen once the preacher is already going. There is no quiet
   * lead-in to learn the room from, and the first block the floor ever sees is
   * speech. Both the old rule and the new one could in principle take that
   * first loud block as the room and start off deaf.
   */
  const mid = endpointer();
  let heardAt = -1, up = 0;
  for (let i = 0; i < N; i++) { mid.push(talking(i)); if (mid.speaking) { if (heardAt < 0) heardAt = i; up++; } }
  check('switched on mid-sentence, it hears the speaker straight away', heardAt >= 0 && heardAt * BLOCK_MS < 1000,
    heardAt < 0 ? 'never heard anything' : `first heard ${(heardAt * BLOCK_MS / 1000).toFixed(2)}s in`);
  check('…and keeps hearing them', up > N * 0.9, `speaking for ${(up * BLOCK_MS / 1000).toFixed(0)}s of 1800s`);

  // The other direction: the room itself gets louder mid-service.
  const hall = endpointer();
  for (let i = 0; i < 60; i++) hall.push(1e-6);
  let fooled = 0;
  const fan = (i) => 2e-3 * (1 + 0.05 * Math.sin(i / 13));   // a fan wanders a little
  for (let i = 0; i < blocks(120000); i++) { hall.push(fan(i)); if (hall.speaking) fooled++; }
  check('a fan starting is mistaken for speech only briefly', fooled * BLOCK_MS < 30000,
    `${(fooled * BLOCK_MS / 1000).toFixed(0)}s before the floor relearned the room`);
  let spoke = false;
  for (let i = 0; i < blocks(6000); i++) { hall.push(Math.max(fan(i), talking(i))); if (hall.speaking) spoke = true; }
  check('…and somebody talking over that fan is still heard', spoke === true);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
