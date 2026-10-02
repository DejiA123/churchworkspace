'use strict';
/*
 * ►► 🎤 LISTEN, AGAINST A REAL SERMON ◄◄
 *
 * Every other test of this feature speaks at it with the Windows synthesiser:
 * clean, close, unaccented, no room, no PA, and pausing obligingly between
 * sentences. All of those are the parts a church does not have, and the gap is
 * not a detail — measured on ten minutes of a real recorded sermon, the design
 * that passed every synthetic test found NOTHING AT ALL. Waiting for a pause
 * produced phrases with a median length of 8.7 seconds because a preacher in
 * full flow does not pause, so a reference announced mid-sentence waited that
 * long to be looked at and a quotation arrived diluted in eight seconds of
 * other words.
 *
 * So this drives the real chain — the real endpointer, the real rolling
 * look-backs, the real speech model, the real reference parser and the real
 * quotation matcher — over real preaching, and asks the only question that
 * matters: what would have gone on the wall, and when?
 *
 * It SKIPS cleanly when the recording is not on this machine.
 *
 *   npm run test:voice-sermon        (or pass another recording + times)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { endpointer, BLOCK_MS } = require('../src/renderer/voiceear');
const captioner = require('../src/main/captioner');
const voiceref = require('../src/main/voiceref');

const USER = path.join(os.homedir(), 'AppData', 'Roaming', 'Church Work Space');
captioner.init(USER);
const voicelisten = require('../src/main/voicelisten');

const RATE = 16000;
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SOURCE = args[0] || path.join(os.homedir(), 'Downloads', 'Word Study - You will be blessed as you tune in.mp4');
const FROM = parseFloat(args[1] || '7000');
const DUR = parseFloat(args[2] || '240');

/*
 * WHAT THE PREACHER SAID, AND THEREFORE WHAT SHOULD HAVE HAPPENED. Read off a
 * careful transcription of the audio rather than off any model under test.
 * `by` is how many seconds after the words are finished the studio still counts
 * as having kept up — a verse that arrives after the preacher has moved on is
 * not an answer.
 */
const EXPECT = [
  { said: '…we will give ourselves to prayer, Acts chapter 6', spokenBy: 96, by: 12, kind: 'ref', want: /^Acts 6/ },
];

/*
 * The three passages this stretch of the sermon actually contains, and how many
 * of them have to be found.
 *
 * Not all three, and that is a measurement rather than a hedge: a look-back
 * arriving while the engine is busy is dropped, so the windows this machine
 * gets through are genuinely different from one run to the next, and whether a
 * quotation lands cleanly inside one of them moves with it. Over repeated runs
 * the announced reference is found every time and the two quotations are found
 * most times. Asserting all three would be asserting the machine's load.
 *
 * What is NOT negotiable is the other direction: naming a passage that was
 * never said, which is checked separately and must be zero every time.
 */
const PASSAGES = [
  { what: /^Proverbs 13:23$/, said: 'there is much food in the tillage of the poor…' },
  { what: /^Proverbs 24:3[01]$/, said: 'I went by the field of the slothful' },
  { what: /^Acts 6/, said: 'Acts chapter 6, announced' },
];
const MUST_FIND = 2;

/*
 * Passages the preacher really does quote here, which the studio is right to
 * name whenever it manages to. They are not in EXPECT because whether a given
 * look-back happens to contain a clean transcript of them varies with how fast
 * the machine was that minute — a look-back that arrives while the engine is
 * busy is dropped, so the schedule is genuinely different run to run. Naming
 * one of these more than once is not a fault either: the studio's own repeat
 * guard swallows the second, and what is being tested here is the recogniser.
 *
 * Anything NOT on this list is a verse that was never said, which is the one
 * failure this feature cannot have.
 */
const ALSO_SAID = [/^Proverbs 24:3[01]$/, /^Acts 6/, /^Proverbs 13:23$/];

let pass = 0, fail = 0;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };

(async () => {
  if (!fs.existsSync(SOURCE)) {
    console.log('\nSKIP voice-sermon: no recording at ' + SOURCE);
    console.log('     (pass one as the first argument to run it)\n');
    process.exit(0);
  }
  if (!voicelisten.available()) { console.log('\nSKIP voice-sermon: the speech engine is not installed\n'); process.exit(0); }

  const raw = path.join(os.tmpdir(), 'mw-voice-sermon.raw');
  execFileSync(ffmpeg, ['-v', 'error', '-ss', String(FROM), '-t', String(DUR), '-i', SOURCE,
    '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-y', raw]);
  const b = fs.readFileSync(raw);
  const pcm = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2));
  fs.rmSync(raw, { force: true });

  let vf = null; const indexes = [];
  try {
    vf = require('../src/main/versefind');
    const bible = require('../src/main/bible');
    bible.init(USER);
    const abbrs = vf.chooseTranslations(null, bible.installed().map((t) => t.abbr));
    for (const a of abbrs) { const ix = await vf.indexFor(a, bible.load); if (ix) indexes.push(ix); }
  } catch (e) { /* the reference half still works without it */ }
  if (!indexes.length) { console.log('\nSKIP voice-sermon: no Bible downloaded to match against\n'); process.exit(0); }

  console.log('\n' + path.basename(SOURCE) + '  ' + FROM + 's +' + DUR + 's');
  console.log('  model ' + voicelisten.DEFAULT_MODEL + ', matching across ' + indexes.map((i) => i.translation).join(', ') + '\n');

  /*
   * The real ear, driven from a file instead of a microphone: the same
   * endpointer, the same look-back schedule, and — crucially — the same rule
   * that a look-back arriving while the engine is busy is DROPPED rather than
   * queued, which is what keeps a slow machine from falling behind. So the
   * number of look-backs this actually gets through is the number this machine
   * would really manage in a service.
   */
  const per = Math.round(RATE * BLOCK_MS / 1000);
  const ep = endpointer();
  const fired = [];
  const moved = [];      // what would have moved the screen with a passage up
  const times = [];
  let looks = 0, finals = 0;
  let busyUntil = 0;                    // audio-time ms: when the engine is free again
  for (let i = 0, blk = 0; i + per <= pcm.length; i += per, blk++) {
    let s = 0;
    for (let k = 0; k < per; k++) { const v = pcm[i + k] / 32768; s += v * v; }
    const now = blk * BLOCK_MS;
    const phrase = ep.push(Math.sqrt(s / per));
    const look = phrase ? null : (now >= busyUntil ? ep.look() : null);
    const span = phrase || look;
    if (!span) continue;
    const seg = pcm.subarray(span.start * per, Math.min(pcm.length, (span.end + 1) * per));
    if (!seg.length) continue;
    const t0 = Date.now();
    const r = await voicelisten.hear({ pcm16: seg, fast: true });
    const took = Date.now() - t0;
    times.push(took);
    if (phrase) finals++; else looks++;
    // The studio drops a look-back that arrives while the engine is busy, so
    // the pace is set by how fast THIS machine actually is. Feeding the real
    // measurement back is the difference between testing the shipping
    // behaviour and testing a guess about it.
    if (look) busyUntil = now + took;
    if (process.argv.includes('--verbose')) console.log('   ' + (now / 1000).toFixed(1) + 's ' + (phrase ? 'PHRASE' : 'look  ') + ' "' + r.text + '"');
    const heardAt = now / 1000 + took / 1000;      // when the studio would know
    /*
     * The same words again, but with a passage ON THE SCREEN. "Carry on",
     * "go on", "go back", "next chapter" and "verse five" only become
     * instructions when there is something to navigate — so the run above,
     * with nothing cued, cannot exercise them at all. This is where they are
     * armed, and forty minutes of preaching is exactly the input they have to
     * survive: every one of them is also an ordinary thing to say.
     */
    const armed = voiceref.parseVoice(r.text, { live: { bookNr: 19, chapter: 23, verse: 1 } });
    if (armed && !(r.intent && r.intent.kind === 'ref')) {
      moved.push({ at: heardAt, kind: armed.kind, what: armed.verse || armed.delta || '', text: r.text });
    }
    if (r.intent && r.intent.kind === 'ref') {
      fired.push({ at: heardAt, kind: 'ref', what: r.intent.book + ' ' + r.intent.chapter, text: r.text });
    } else if (!r.intent && r.text) {
      let q = null; try { q = vf.findAcross(indexes, r.text); } catch (e) {}
      if (q && q.ok) fired.push({ at: heardAt, kind: 'quote', what: q.ref, text: r.text });
    }
  }
  console.log('  ' + (finals + looks) + ' recognitions in ' + DUR + 's — '
    + finals + ' finished phrases, ' + looks + ' look-backs');

  const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)];
  console.log('  recognition cost: median ' + q(times, 0.5) + 'ms  p90 ' + q(times, 0.9) + 'ms');

  const claimed = new Set();
  for (const want of EXPECT) {
    const hit = fired.find((f, ix) => !claimed.has(ix) && f.kind === want.kind && want.want.test(f.what)
      && f.at >= want.spokenBy - 8 && f.at <= want.spokenBy + want.by);
    if (hit) claimed.add(fired.indexOf(hit));
    log(!!hit, '“' + want.said + '” reaches the wall',
      hit ? hit.what + ', ' + (hit.at - want.spokenBy).toFixed(1) + 's after it was said' : 'never');
  }

  /*
   * A wrong verse mid-sermon is the failure this feature cannot have, and
   * running forty times a minute instead of once a phrase is exactly what would
   * multiply them. So the bar is not "how many times did it fire" — naming the
   * same true passage from two overlapping look-backs is right, and the studio's
   * repeat guard swallows the second — it is "did it ever name something that
   * was not said".
   */
  const wrong = fired.filter((f) => !ALSO_SAID.some((re) => re.test(f.what)));
  for (const e of [...new Map(wrong.map((f) => [f.kind + f.what, f])).values()]) {
    console.log('       WRONG: ' + e.kind + ' ' + e.what + ' at ' + e.at.toFixed(0) + 's  — "' + (e.text || '').slice(0, 70) + '"');
  }
  log(wrong.length === 0, 'it never names a verse that was not said',
    wrong.length + ' wrong firing(s) in ' + DUR + 's of preaching');

  /*
   * The navigation vocabulary, armed. Not one of these words may move the
   * screen during a sermon just because a passage happens to be up.
   */
  for (const m of [...new Map(moved.map((x) => [x.kind + x.what + x.text, x])).values()]) {
    console.log('       MOVED: ' + m.kind + ' ' + m.what + ' at ' + m.at.toFixed(0) + 's  — "' + (m.text || '').slice(0, 70) + '"');
  }
  log(moved.length === 0, 'no ordinary sentence moves the screen, even with a passage up',
    moved.length + ' would have moved it');

  const got = PASSAGES.filter((p) => fired.some((f) => p.what.test(f.what)));
  for (const p of PASSAGES) {
    const hit = fired.find((f) => p.what.test(f.what));
    console.log('       ' + (hit ? 'found  ' : 'missed ') + '“' + p.said + '”'
      + (hit ? '  → ' + hit.what + ' at ' + hit.at.toFixed(0) + 's' : ''));
  }
  log(got.length >= MUST_FIND, 'it finds the passages the preacher put on the wall',
    got.length + ' of ' + PASSAGES.length + ' (needs at least ' + MUST_FIND + ')');

  console.log('\n' + (fail ? '============  VOICE ON A REAL SERMON FAILED  ============'
    : '============  VOICE ON A REAL SERMON PASSED  ============') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAILED: ' + ((e && e.stack) || e)); process.exit(1); });
