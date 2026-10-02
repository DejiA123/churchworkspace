'use strict';
/*
 * ►► THE SAME WORDS, THROUGH A HALL ◄◄
 *
 * test/cloud-listen.test.js puts a clean 21-second recording through both
 * engines and they agree word for word. That is a real result and it proves the
 * wrong thing: on close-miked studio audio the small local model is FINE. It
 * was never the easy case that made 🎤 Listen unusable.
 *
 * What a church actually has is a preacher thirty feet away, through a PA, in a
 * room with a reverb tail, under an air handler, recorded on a camera with AGC.
 * So this takes the same recording — whose true words are known, because both
 * engines agreed on it clean — and spoils it the way a building does, then asks
 * the only question that matters: HOW MANY WORDS DOES EACH ENGINE STILL GET?
 *
 * The degradations, in the order a hall applies them:
 *
 *   distance   a reverb tail and an early reflection off the back wall
 *   PA         band-limited to roughly what a ceiling speaker passes
 *   room       broadband noise under it all, at a realistic level
 *   camera     the level pulled down, the way a quiet room is captured
 *
 * WORD ERROR RATE is the measure, against the clean transcript as truth. It is
 * the standard one and it is unforgiving in the right way: a substitution
 * ("Acts of the Six" for "Acts chapter 6") costs exactly as much as a deletion,
 * which is correct here, because a wrong book on the wall is worse than none.
 *
 * Needs a key. Skips cleanly without one.
 *
 *   GROQ_API_KEY=gsk_... node test/cloud-listen-hall.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const captioner = require('../src/main/captioner');
captioner.init(process.env.MW_USERDATA
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Church Work Space'));
const cloudspeech = require('../src/main/cloudspeech');
const voicelisten = require('../src/main/voicelisten');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

const FIX = path.join(__dirname, 'fixtures', 'sermon-dry.flac');

/** Words, lowercased, stripped of punctuation — what was SAID, not how it was typed. */
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Word error rate: (substitutions + insertions + deletions) / words of truth.
 * Plain Levenshtein over word arrays — the standard definition, no shortcuts.
 */
function wer(truth, heard) {
  const a = words(truth), b = words(heard);
  if (!a.length) return b.length ? 1 : 0;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] / a.length;
}

/** 16 kHz mono Int16 out of any file, through an optional filter chain. */
function pcmOf(file, filter) {
  const args = ['-v', 'error', '-i', file, '-vn'];
  if (filter) args.push('-af', filter);
  args.push('-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1');
  const raw = execFileSync(ffmpeg, args, { maxBuffer: 1 << 28, windowsHide: true });
  return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
}

/*
 * A hall, as a filter chain.
 *
 * `aecho` is the distance: one early reflection at 90 ms and a later one at
 * 180 ms, both well down, which is what a room thirty feet deep does to a
 * voice. `highpass`/`lowpass` is the PA — a ceiling speaker does not pass much
 * below 150 Hz or above 6 kHz. `volume` is the camera capturing a quiet room.
 * The noise is added separately because it has to be CONSTANT, not shaped by
 * the speech.
 */
const HALL = (vol, lp) => `aecho=0.8:0.85:90|180:0.45|0.32,highpass=f=180,lowpass=f=${lp},volume=${vol}`;

/**
 * The whole graph: voice through the hall, constant room noise under it.
 *
 * The noise is levelled on its OWN input and `normalize=0` keeps amix from
 * quietly rescaling both — with normalisation on, adding noise makes the voice
 * quieter by exactly as much as the noise adds, so the signal-to-noise ratio
 * the test thinks it set is not the one the model gets.
 */
const graph = (noiseGain, vol, lp) =>
  `[0:a]${HALL(vol, lp)}[v];[1:a]volume=${noiseGain}[n];[v][n]amix=inputs=2:duration=shortest:normalize=0[out]`;

/** The fixture (or any file) put through that hall, written to `out`. */
function spoil(src, out, noiseGain = 0.05, vol = 0.35, lp = 6000) {
  execFileSync(ffmpeg, ['-v', 'error', '-i', src,
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.9',
    '-filter_complex', graph(noiseGain, vol, lp),
    '-map', '[out]', '-ac', '1', '-ar', '16000', '-y', out], { windowsHide: true });
  return out;
}

(async () => {
  const key = process.env.GROQ_API_KEY || (() => {
    try {
      const f = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Church Work Space', 'workstation.json');
      return (((JSON.parse(fs.readFileSync(f, 'utf8')).settings || {}).listen || {}).cloud || {}).key || '';
    } catch (e) { return ''; }
  })();
  if (!key) { console.log('\nSKIP cloud-listen-hall: no key (set GROQ_API_KEY)\n'); process.exit(0); }
  if (!fs.existsSync(FIX)) { console.log('\nSKIP cloud-listen-hall: no recording fixture\n'); process.exit(0); }
  if (!voicelisten.engine()) { console.log('\nSKIP cloud-listen-hall: no local engine to compare against\n'); process.exit(0); }

  const local = voicelisten.engine().modelId;
  console.log(`\n== THE SAME SERMON, THROUGH A HALL ==\n   this PC: ${local}   vs   cloud: whisper-large-v3-turbo\n`);

  const hear = async (pcm, cloud) => {
    if (cloud) { cloudspeech.configure({ on: true, provider: 'groq', key }); cloudspeech._resetBudget(); }
    else cloudspeech.configure({ on: false });
    const t = Date.now();
    const r = await voicelisten.hear({ pcm16: pcm });
    return { text: (r && r.text) || '', ms: Date.now() - t, via: r && r.via };
  };

  /* ---- 1. the truth, from clean audio both engines already agree on ---- */
  const clean = pcmOf(FIX);
  const truth = (await hear(clean, true)).text;
  console.log('  what was actually said (clean, cloud):');
  console.log(`    "${truth}"\n`);
  check('there is a transcript to measure against', words(truth).length > 20,
    `${words(truth).length} words`);

  /* ---- 2. the same words, through a building, at three distances ----
   *
   * THREE LEVELS, NOT ONE, AND THE MIDDLE ONE IS THE ANSWER.
   *
   * Measured: on a LIGHTLY spoiled recording both engines are perfect, so a
   * test run only there proves nothing and would read as "no benefit". Pushed
   * to absurdity — a voice at a twelfth of its level under pink noise — BOTH
   * are useless, and the cloud's failure is the uglier of the two: the small
   * local model returns broken fragments, the big one returns fluent sentences
   * about nothing, which is worse for anything downstream. Neither end is where
   * a church lives.
   *
   * The middle row is a hall: that is where the difference shows and where it
   * matters, so that is the row the assertion below is made on.
   */
  const LEVELS = [
    { label: 'close mic', noise: 0.03, vol: 0.55, lp: 7000 },
    { label: 'across a hall', noise: 0.12, vol: 0.25, lp: 5000 },
    { label: 'far too far', noise: 0.35, vol: 0.12, lp: 3400 },
  ];
  console.log('                    this PC                    the cloud ear');
  let mid = null;
  for (const L of LEVELS) {
    const f = spoil(FIX, path.join(os.tmpdir(), 'mw-hall.wav'), L.noise, L.vol, L.lp);
    const pcm = pcmOf(f);
    const a = await hear(pcm, false);
    const b = await hear(pcm, true);
    try { fs.rmSync(f, { force: true }); } catch (e) {}
    const wa = wer(truth, a.text), wb = wer(truth, b.text);
    console.log(`  ${L.label.padEnd(15)} ${(wa * 100).toFixed(0).padStart(3)}% wrong ${String(a.ms).padStart(6)}ms   `
      + `${(wb * 100).toFixed(0).padStart(3)}% wrong ${String(b.ms).padStart(5)}ms`);
    if (L.label === 'across a hall') mid = { a, b, wa, wb };
  }
  console.log(`\n  across a hall, this PC heard:  "${mid.a.text.slice(0, 150)}"`);
  console.log(`  across a hall, the cloud heard: "${mid.b.text.slice(0, 150)}"\n`);

  check('the cloud ear answered the hall recording', mid.b.via === 'cloud');
  /*
   * ASSERTED: not worse. NOT asserted: a specific margin.
   *
   * Whisper is not deterministic on noisy audio even at temperature 0 — the
   * same clip run twice gives different answers — and this clip is one
   * twenty-one-second sample of one voice. A test that demands "the cloud wins
   * by 30%" would pass today and fail on a Tuesday for no reason anyone could
   * act on, which is worse than no test. What IS stable, and what actually has
   * to hold for this feature to be worth having, is that sending the audio away
   * does not make things worse. The margin is printed above; read it.
   */
  check('it is no worse than this PC on hall audio', mid.wb <= mid.wa + 0.05,
    `${(mid.wb * 100).toFixed(0)}% wrong against ${(mid.wa * 100).toFixed(0)}%`);
  check('…and it is quick enough for a live service', mid.b.ms < 4000, `${mid.b.ms}ms`);
  /*
   * This one IS asserted hard, because it is the claim the whole feature rests
   * on and it has held by a factor of ten in every run: the FULL-SIZE model,
   * answering faster than the small one does locally.
   */
  check('…and far faster than the local model on the same audio', mid.b.ms * 3 < mid.a.ms,
    `${mid.b.ms}ms against ${mid.a.ms}ms — ${(mid.a.ms / mid.b.ms).toFixed(1)}x`);
  check('it did not invent a book list out of the room noise',
    !cloudspeech.looksLikePromptEcho(mid.b.text));

  /* ---- 3. a spoken reference through the same hall ---- */
  const spoken = path.join(os.tmpdir(), 'mw-hall-ref.wav');
  const dirty = path.join(os.tmpdir(), 'mw-hall-ref2.wav');
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
      + `$s.SetOutputToWaveFile('${spoken}'); $s.Rate = -1; `
      + '$s.Speak("Turn with me please to the book of Habakkuk, chapter two, verse four."); $s.Dispose();'],
      { windowsHide: true, timeout: 30000 });
    spoil(spoken, dirty);
    const said = pcmOf(dirty);

    cloudspeech.configure({ on: false });
    const refPc = await voicelisten.hear({ pcm16: said });
    cloudspeech.configure({ on: true, provider: 'groq', key });
    cloudspeech._resetBudget();
    const refCloud = await voicelisten.hear({ pcm16: said });

    const nameOf = (r) => (r && r.intent && r.intent.kind === 'ref')
      ? `${r.intent.book} ${r.intent.chapter}:${(r.intent.verses || [])[0]}` : 'nothing';
    console.log(`  a reference called out across that hall:`);
    console.log(`    this PC     heard "${refPc.text}"  ->  ${nameOf(refPc)}`);
    console.log(`    cloud ear   heard "${refCloud.text}"  ->  ${nameOf(refCloud)}\n`);
    /*
     * REPORTED, NOT ASSERTED — and that is a deliberate retreat.
     *
     * An earlier version of this asserted that the cloud ear gets "Habakkuk"
     * across a hall. It failed: the cloud heard "Havakak" and named nothing,
     * while the small local model happened to get it right. Measured properly
     * afterwards over six hard book names, the two engines scored 2/6 EACH —
     * this was one sample of a coin toss, not a result.
     *
     * The deeper reason not to assert it is that the voice here is the Windows
     * speech synthesiser, and this project has been burned by exactly that
     * before: see voice-listen-rebuild, where every test passed because every
     * test used synthesised speech, and the feature then found nothing at all
     * in a real sermon. A synthesised voice pushed through a synthetic room is
     * two layers of not-a-church. So both answers are printed for a human to
     * weigh, and neither is allowed to claim a pass.
     */
    console.log(`  (reported, not asserted — one synthesised sample; measured over six`);
    console.log(`   hard book names the two engines score about the same.)`);
  } catch (e) {
    console.log('  SKIP  the spoken-reference check (' + (e.message || e) + ')');
  } finally {
    for (const f of [spoken, dirty]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  }

  cloudspeech.configure({ on: false });
  console.log(`\n${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
