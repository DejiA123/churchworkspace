'use strict';
/*
 * ►► THE FREE CLOUD EAR BEHIND 🎤 LISTEN ◄◄
 *
 * The complaint this answers was not subtle: the listening was terrible. It was
 * terrible for a structural reason rather than a fixable one — the only Whisper
 * models small enough to run many times a minute on a church PC are the two
 * smallest OpenAI ever shipped, and the one that would be good enough runs 3.2x
 * slower than real time on this machine. There is no setting that fixes that.
 *
 * So the recognising moved to a machine that runs the FULL model, and the thing
 * that then has to be proved is not "is Whisper Large good" — it is — but the
 * three ways a feature like this goes wrong in a church hall:
 *
 *   1. IT RUNS OUT. The free tier is 20 requests a minute, 7,200 audio-seconds
 *      an hour. The ear's own pace asks 50 times a minute. Get the pacing wrong
 *      and it works beautifully for ten minutes and dies mid-sermon — which is
 *      worse than never working, because nobody plans around it. The sustained
 *      arithmetic is asserted here over a simulated 100-minute service.
 *
 *   2. IT STOPS DEAD. The hall's internet drops. Every failure has to land as
 *      "use the local model for this window" and nothing else, and it has to do
 *      that QUICKLY rather than paying a timeout every phrase for an hour.
 *
 *   3. IT INVENTS THINGS. The prompt that makes it hear "Habakkuk" correctly is
 *      a list of all sixty-six books, and a prompted Whisper handed silence can
 *      say its prompt back. A book list arriving at the reference parser is the
 *      one failure this feature cannot have: a verse on the wall nobody asked
 *      for.
 *
 * Everything above runs with no key and no network. With a key in GROQ_API_KEY
 * (or whatever is saved in the app), it ALSO puts the real recorded sermon
 * through both engines and prints the two transcripts side by side, which is
 * the only honest way to answer "is it actually better".
 *
 *   node test/cloud-listen.test.js
 *   GROQ_API_KEY=gsk_... node test/cloud-listen.test.js      (the real comparison)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const captioner = require('../src/main/captioner');
captioner.init(process.env.MW_USERDATA
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Church Work Space'));
const cloudspeech = require('../src/main/cloudspeech');
const voicelisten = require('../src/main/voicelisten');
const { endpointer, createEar, BLOCK_MS, DEFAULTS } = require('../src/renderer/voiceear');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

const GROQ = cloudspeech.PROVIDERS.groq.limits;
const PARTIAL = { rpm: 0.75, rpd: 0.90, hour: 0.90, day: 0.90 };
const FINAL = { rpm: 0.95, rpd: 0.99, hour: 0.99, day: 0.99 };

/*
 * WHAT CONTINUOUS PREACHING LOOKS LIKE TO A LEVEL METER.
 *
 * Not a constant. The endpointer has no fixed threshold — it tracks the
 * quietest recent blocks, and, since the fix in voiceear.js, it also asks
 * whether the level MOVES, because a level that does not move is a room rather
 * than a person. Driving it with a flat 0.2 therefore says "there is a fan on"
 * and it is quite right to hear no speech in it.
 *
 * So: a loud block with a syllable gap every quarter of a second, which is what
 * somebody talking without pausing actually produces.
 */
const speechAt = (i) => (i % 8 === 0 ? 0.02 : 0.2);
const ROOM = 1e-6;

(async () => {

/* ============ 1. THE PACE THE FREE ALLOWANCE CAN ACTUALLY KEEP ============ */
head('[1] It must still be listening at the end of the sermon');
{
  const b = cloudspeech.budget(GROQ);
  const win = cloudspeech.cadence().liveWinMs / 1000;
  const hop = b.sustainableHopMs(win);

  // The old cadence, for the record: what would have happened if the ear's own
  // numbers had simply been left alone.
  const oldHop = DEFAULTS.liveHopMs, oldWin = DEFAULTS.liveWinMs / 1000;
  const oldPerMin = 60000 / oldHop;
  const oldAudioPerHour = oldPerMin * 60 * b.billed(oldWin);
  check('the ear\'s own pace would blow the free allowance', oldAudioPerHour > GROQ.audioSecPerHour,
    `${Math.round(oldPerMin)} req/min and ${Math.round(oldAudioPerHour)} audio-s/hour against caps of ${GROQ.rpm} and ${GROQ.audioSecPerHour}`);

  const perMin = 60000 / hop;
  check('the chosen pace is inside the per-minute cap', perMin <= GROQ.rpm,
    `${perMin.toFixed(1)} req/min of ${GROQ.rpm}`);
  check('…and inside the per-hour audio cap', perMin * 60 * b.billed(win) <= GROQ.audioSecPerHour,
    `${Math.round(perMin * 60 * b.billed(win))} audio-s/hour of ${GROQ.audioSecPerHour}`);

  /*
   * The one that matters. A rolling hourly budget always collects: a pace that
   * is 10% too fast does not fail at minute 6, it fails at minute 54, which is
   * exactly the half of a service nobody tests.
   */
  const real = Date.now, base = Date.now();
  const sim = cloudspeech.budget(GROQ);
  let sent = 0, skipped = 0;
  for (let ms = 0; ms < 100 * 60000; ms += hop) {
    Date.now = () => base + ms;
    if (sim.refuse(win, PARTIAL)) skipped++; else { sim.spend(win); sent++; }
  }
  Date.now = real;
  check('100 minutes of nonstop preaching, nothing skipped', skipped === 0,
    `${sent} windows sent, ${skipped} skipped, hop ${(hop / 1000).toFixed(2)}s`);

  /*
   * The overlap is not a nicety. A spoken reference lasts about four seconds
   * and lands wherever it lands; if consecutive windows do not overlap by more
   * than that, there are boundaries at which it is cut in half in EVERY window
   * it appears in, and neither half parses.
   */
  const overlap = (cloudspeech.cadence().liveWinMs - hop) / 1000;
  check('consecutive windows overlap by more than a spoken reference', overlap >= 4.5,
    `${overlap.toFixed(1)}s overlap — "turn with me to the book of Habakkuk chapter two" is ~4s`);
}

/* ============ 2. A LOOK-BACK IS OPTIONAL; AN INSTRUCTION IS NOT =========== */
head('[2] Running short costs the transcript, never the instructions');
{
  const b = cloudspeech.budget(GROQ);
  let looks = 0;
  while (!b.refuse(12, PARTIAL)) { b.spend(12); looks++; }
  check('look-backs stop when the minute is nearly spent', looks < GROQ.rpm,
    `${looks} look-backs, then it holds back`);
  check('…and a finished phrase can still get through', !b.refuse(12, FINAL),
    'the reserve is kept for the words somebody paused to say');
  check('it says why, in words an operator can act on',
    /allowance|too often/.test(b.refuse(12, PARTIAL) || ''), `"${b.refuse(12, PARTIAL)}"`);
}
{
  /*
   * A phrase cut at the eight-second cap is not an instruction, and there is one
   * every eight seconds of a sermon. If those spent from the reserve, the
   * reserve would be gone before the sermon was half over.
   *
   * The room has to be quiet FIRST. The endpointer has no fixed threshold — it
   * tracks the quietest recent blocks and sits a fixed margin above them — so a
   * level that starts loud and stays loud IS the noise floor and nobody is ever
   * speaking. That is the right behaviour (it is what lets the same code work
   * under an air handler) and it is what a test has to respect.
   */
  const quiet = (ep, n) => { for (let i = 0; i < n; i++) ep.push(ROOM); };
  const talk = (ep, n, out) => { for (let i = 0; i < n; i++) { const p = ep.push(speechAt(i)); if (p && !out.got) out.got = p; } };

  const ep = endpointer();
  quiet(ep, 60);
  const cut = {};
  talk(ep, Math.round(DEFAULTS.maxPhraseMs / BLOCK_MS) + 40, cut);

  const ep2 = endpointer();
  quiet(ep2, 60);
  const done = {};
  talk(ep2, 60, done);
  for (let i = 0; i < 40 && !done.got; i++) { const p = ep2.push(ROOM); if (p) done.got = p; }

  check('a phrase cut at the length cap is marked as such', !!cut.got && cut.got.capped === true,
    cut.got ? `${Math.round((cut.got.end - cut.got.start) * BLOCK_MS)}ms, capped=${cut.got.capped}` : 'no phrase');
  check('…and one that ended in a pause is not', !!done.got && done.got.capped === false,
    'so a spoken instruction still spends from the reserve');
}

/* ================= 3. IT MUST NEVER SAY ITS OWN PROMPT BACK =============== */
head('[3] The book list must never reach the reference parser');
{
  const echo = 'Genesis, Exodus, Leviticus, Numbers, Deuteronomy, Joshua';
  check('a run of book names is caught', cloudspeech.looksLikePromptEcho(echo) === true);
  check('the prompt\'s own lead-in is caught', cloudspeech.looksLikePromptEcho('Books of the Bible: Genesis') === true);
  check('the whole prompt is caught', cloudspeech.looksLikePromptEcho(cloudspeech.promptFor(null)) === true);
  /*
   * And the other direction, which is the one that would quietly break the
   * feature: real preaching names books, sometimes two in a sentence, and none
   * of it may be thrown away.
   */
  const real = [
    'turn with me to John chapter three verse sixteen',
    'Paul writes to the Romans, and again to the Corinthians, about the same thing',
    'we read it in Matthew, and Mark tells it too',
    'the field of the slothful, Proverbs twenty four',
    'Acts chapter six, and they gave themselves to prayer',
  ];
  check('real preaching is never mistaken for it', real.every((t) => !cloudspeech.looksLikePromptEcho(t)),
    `${real.length} lines, including two that name two books`);
  check('the prompt fits inside Whisper\'s 224 tokens',
    cloudspeech.promptFor({ book: 'Habakkuk', chapter: 2 }).split(/\s+/).length < 120,
    cloudspeech.promptFor({ book: 'Habakkuk', chapter: 2 }).split(/\s+/).length + ' words');
  check('what is on the wall is named in the prompt',
    /Habakkuk chapter 2/.test(cloudspeech.promptFor({ book: 'Habakkuk', chapter: 2 })));
}

/* ============ 4. ROOM TONE MUST NOT ARRIVE AS A SENTENCE ================== */
head('[4] What Whisper says when it has heard nothing');
{
  /*
   * THE NUMBERS THAT LOOK LIKE THEY WOULD WORK, AND DO NOT.
   *
   * Measured against the real service on real audio (see the table in
   * cloudspeech.js): `no_speech_prob` came back 0.00 for everything, digital
   * silence included, and `avg_logprob` rated DIGITAL SILENCE (-0.41) better
   * than real degraded speech (-0.68). So the guard cannot be a confidence
   * threshold; it has to be the text. These fixtures carry the measured
   * numbers rather than invented ones, so that if a future change reaches for
   * those fields again, this test is the thing that says why not.
   */
  const silence = { segments: [{ text: ' Thank you.', no_speech_prob: 0.00, avg_logprob: -0.41 }] };
  const roomTone = { segments: [{ text: ' so', no_speech_prob: 0.00, avg_logprob: -0.72 }] };
  const dots = { segments: [{ text: ' ...', no_speech_prob: 0.00, avg_logprob: -0.81 }] };
  const noisySpeech = { segments: [
    { text: ' Be anxious for nothing, but in everything by prayer and supplication,', no_speech_prob: 0.00, avg_logprob: -0.68 },
  ] };
  const real = { segments: [
    { text: ' Turn with me to Romans chapter eight.', no_speech_prob: 0.00, avg_logprob: -0.14 },
    { text: ' And we know that all things work together for good.', no_speech_prob: 0.00, avg_logprob: -0.14 },
  ] };

  check('what silence produces is dropped', cloudspeech.textFrom(silence) === '', '"Thank you."');
  check('what room tone produces is dropped', cloudspeech.textFrom(roomTone) === '', '"so"');
  check('punctuation-only is dropped', cloudspeech.textFrom(dots) === '', '"..."');
  check('real speech is kept whole', cloudspeech.textFrom(real)
    === 'Turn with me to Romans chapter eight. And we know that all things work together for good.');
  /*
   * The one that matters most: this segment scores WORSE on avg_logprob than
   * the digital silence above, and it is the preacher. Any confidence gate
   * tuned to catch the silence throws this away.
   */
  check('…and so is real speech that scored worse than the silence did',
    /Be anxious for nothing/.test(cloudspeech.textFrom(noisySpeech)),
    'logprob -0.68, against -0.41 for the silence that IS dropped');
  check('a short real reply is still kept', cloudspeech.textFrom({ text: 'verse four' }) === 'verse four');
  check('a plain answer with no segments still works', cloudspeech.textFrom({ text: '  next   verse ' }) === 'next verse');
  check('subtitle credits from its training data are dropped',
    cloudspeech.textFrom({ text: 'Subtitles by the Amara.org community' }) === '');
}

/* ================= 5. THE FALLBACK, WHICH IS THE WHOLE SAFETY NET ========= */
head('[5] The internet drops and the service carries on');
{
  cloudspeech.configure({ on: true, provider: 'custom', key: 'x', url: 'http://127.0.0.1:9/nope' });
  cloudspeech._resetBudget();
  check('it reports itself ready before it has failed', cloudspeech.ready() === true);
  const t0 = Date.now();
  const r = await cloudspeech.transcribe(new Int16Array(16000 * 2), { partial: true });
  check('a dead address returns null rather than throwing', r === null, `${Date.now() - t0} ms`);
  await cloudspeech.transcribe(new Int16Array(16000 * 2), { partial: true });
  await cloudspeech.transcribe(new Int16Array(16000 * 2), { partial: true });
  check('three failures and it stops asking for a while', cloudspeech.ready() === false,
    `cooling for ${Math.round(cloudspeech.state().cooling / 1000)}s — so it is not a timeout per phrase for the rest of the service`);
  check('…and it says what went wrong', /reach|answer|time/.test(cloudspeech.state().why || ''),
    `"${cloudspeech.state().why}"`);

  if (voicelisten.engine()) {
    cloudspeech.configure({ on: true, provider: 'custom', key: 'x', url: 'http://127.0.0.1:9/nope' });
    cloudspeech._resetBudget();
    const pcm = new Int16Array(16000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 10) * 300);
    const heard = await voicelisten.hear({ pcm16: pcm, partial: false });
    check('🎤 Listen falls through to this PC without an error reaching the studio',
      !!(heard && heard.ok) && heard.via !== 'cloud', `answered via "${heard && heard.via}"`);
  } else {
    console.log('  SKIP  the local fallback — no speech engine installed on this machine');
  }
  cloudspeech.configure({ on: false });
}

/* ================= 6. THE RING THE LOOK-BACK IS CUT FROM ================== */
head('[6] A twelve-second look-back has to have twelve seconds to cut from');
{
  const cad = cloudspeech.cadence();
  // Sized the way createEar sizes it — from the settings ACTUALLY IN FORCE,
  // which for the cloud engine means a 30-second phrase cap, not the local 8.
  const keptMs = (Math.max(cad.maxPhraseMs || DEFAULTS.maxPhraseMs, cad.liveWinMs) + 3000);
  check('the ear keeps more audio than the longest window it can be asked for',
    keptMs > cad.liveWinMs, `${keptMs}ms kept for a ${cad.liveWinMs}ms window`);
  // Drive the real endpointer at the real cloud cadence and measure the spans
  // it hands out, in blocks, against what the ring would hold.
  const ep = endpointer(cad);
  const maxKeepBlocks = Math.ceil(keptMs / BLOCK_MS);
  const secs = 600;
  const blocks = Math.round(secs * 1000 / BLOCK_MS);
  let longest = 0, looks = 0, capped = 0, shortLooks = 0;
  for (let i = 0; i < 60; i++) ep.push(ROOM);     // let it learn a quiet room first
  for (let i = 0; i < blocks; i++) {
    const p = ep.push(speechAt(i));
    if (p && p.capped) capped++;
    const l = ep.look();
    if (l) {
      looks++;
      const span = l.end - l.start + 1;
      longest = Math.max(longest, span);
      // Only once there IS a full window of history to cut from: the first
      // look-backs of a session are short because the service just started, and
      // that is not the bug this is watching for.
      if (i * BLOCK_MS > cad.liveWinMs + 1000 && span * BLOCK_MS < cad.liveWinMs - 200) shortLooks++;
    }
  }
  check('every look-back fits in what is kept', longest <= maxKeepBlocks,
    `longest ${longest} blocks (${Math.round(longest * BLOCK_MS)}ms), ring holds ${maxKeepBlocks}`);
  check('look-backs keep coming at the cloud pace', looks >= Math.floor(secs / (cad.liveHopMs / 1000)) - 2,
    `${looks} in ${secs}s — one every ${(cad.liveHopMs / 1000).toFixed(1)}s`);
  /*
   * The one this section exists for. A look-back used to be clamped to the
   * start of the phrase it was inside, so the first one after every phrase
   * boundary carried 2.5 seconds instead of twelve — and at that moment the
   * overlap the whole design rests on was zero. All but the very first should
   * now carry the full window.
   */
  check('…and they carry their full window, boundaries and all', shortLooks === 0,
    `${shortLooks} short of ${looks} once the first 12s have gone by — a phrase boundary `
    + `every ${cad.maxPhraseMs / 1000}s no longer starves one`);

  /*
   * WHAT TEN MINUTES OF PREACHING REALLY COSTS, counted off the real endpointer
   * rather than off the nominal hop. This is the number that decides whether
   * the feature is alive at the end of the service, and the two things that
   * were wrong with the first draft — a phrase capped every 8 seconds, and a
   * capped phrase costing a request of its own — are both only visible here.
   */
  const b = cloudspeech.budget(GROQ);
  const audio = looks * b.billed(cad.liveWinMs / 1000);
  const perHour = audio * 3600 / secs;
  check('ten minutes of preaching stays inside the hourly allowance', perHour <= GROQ.audioSecPerHour,
    `${Math.round(perHour)} audio-s/hour of ${GROQ.audioSecPerHour}, and ${capped} capped phrases dropped rather than sent`);
  const withCapped = (audio + capped * 20) * 3600 / secs;
  check('…which it would NOT have been if capped phrases were sent too', withCapped > GROQ.audioSecPerHour,
    `sending them would cost ${Math.round(withCapped)} audio-s/hour`);
}

/* ================= 7. GETTING THE AUDIO THERE ON A CHURCH UPLINK ========== */
head('[7] It has to fit down a church\'s upload');
{
  const twelve = new Int16Array(16000 * 12);
  for (let i = 0; i < twelve.length; i++) twelve[i] = Math.round(Math.sin(i / 7) * 3000 * Math.sin(i / 50000));
  const t0 = Date.now();
  const enc = await cloudspeech.encode(twelve);
  const ms = Date.now() - t0;
  const rawKB = twelve.byteLength / 1024;
  const gotKB = enc.body.length / 1024;
  check('twelve seconds is small enough to push in a fraction of a second', gotKB < 60,
    `${rawKB.toFixed(0)} KB raw -> ${gotKB.toFixed(0)} KB ${enc.name.split('.').pop()} in ${ms}ms `
    + `(${(gotKB * 8 / 1024).toFixed(2)} Mb — ~${(gotKB * 8 / 1024).toFixed(1)}s on a 1 Mbit uplink would be ${(gotKB * 8 / 1024 / 1).toFixed(2)}s)`);
  check('…and it is a format the service accepts', /\.(ogg|flac|wav)$/.test(enc.name), enc.name);
}

/* ================= 8. THE REAL THING, IF THERE IS A KEY =================== */
head('[8] The same recorded sermon, through both engines');
{
  let key = process.env.GROQ_API_KEY || '';
  let provider = 'groq';
  if (!key) {
    // Whatever the app itself has saved, so running this after setting it up in
    // the studio needs no environment variable.
    try {
      const f = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Church Work Space', 'workstation.json');
      const c = ((JSON.parse(fs.readFileSync(f, 'utf8')).settings || {}).listen || {}).cloud || {};
      if (c.key) { key = c.key; provider = c.provider || 'groq'; }
    } catch (e) {}
  }
  const FIX = path.join(__dirname, 'fixtures', 'sermon-dry.flac');
  if (!key) {
    console.log('  SKIP  no key. Paste one under Hearing in the studio, or set GROQ_API_KEY,');
    console.log('        and this prints the two transcripts of the real sermon side by side.');
  } else if (!fs.existsSync(FIX)) {
    console.log('  SKIP  the recorded sermon fixture is not on this machine');
  } else {
    const ffmpeg = require('ffmpeg-static');
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', FIX, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
      { maxBuffer: 1 << 28, windowsHide: true });
    const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
    console.log(`  ${(pcm.length / 16000).toFixed(1)}s of a real recorded voice\n`);

    let local = null, localMs = 0;
    if (voicelisten.engine()) {
      cloudspeech.configure({ on: false });
      const t = Date.now();
      local = await voicelisten.hear({ pcm16: pcm.subarray(0, 16000 * 20) });
      localMs = Date.now() - t;
      console.log(`  this PC (${(voicelisten.engine() || {}).modelId})  ${localMs}ms`);
      console.log(`    "${(local.text || '').slice(0, 300)}"\n`);
    }

    cloudspeech.configure({ on: true, provider, key });
    cloudspeech._resetBudget();
    const t = Date.now();
    const cloud = await voicelisten.hear({ pcm16: pcm.subarray(0, 16000 * 20) });
    const cloudMs = Date.now() - t;
    console.log(`  the cloud ear (${cloudspeech.state().model})  ${cloudMs}ms`);
    console.log(`    "${((cloud && cloud.text) || '').slice(0, 300)}"\n`);

    check('the cloud ear answered', !!(cloud && cloud.ok && cloud.via === 'cloud'), `via "${cloud && cloud.via}"`);
    check('…with words in it', !!(cloud && (cloud.text || '').trim().length > 20),
      `${((cloud && cloud.text) || '').split(/\s+/).filter(Boolean).length} words`);
    check('…and it did not say the book list back', !cloudspeech.looksLikePromptEcho((cloud && cloud.text) || ''));
    if (local) {
      check('…faster than the model on this PC', cloudMs < localMs,
        `${cloudMs}ms against ${localMs}ms — and it is the full-size model`);
    }

    // A spoken reference, synthesised, is the one thing that can be asserted
    // exactly: the words are known, so the intent must come out right.
    const spoken = path.join(os.tmpdir(), 'mw-cloud-ref.wav');
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
        + `$s.SetOutputToWaveFile('${spoken}'); $s.Rate = -1; `
        + '$s.Speak("Turn with me to the book of Habakkuk, chapter two, verse four."); $s.Dispose();'],
        { windowsHide: true, timeout: 30000 });
      const wav = fs.readFileSync(spoken);
      const conv = execFileSync(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
        { input: wav, maxBuffer: 1 << 28, windowsHide: true });
      const said = new Int16Array(conv.buffer, conv.byteOffset, Math.floor(conv.byteLength / 2));
      cloudspeech._resetBudget();
      const r = await voicelisten.hear({ pcm16: said });
      console.log(`  spoken reference -> "${r.text}"`);
      check('a spoken reference becomes the right instruction',
        !!(r.intent && r.intent.kind === 'ref' && /Habakkuk/i.test(r.intent.book || '') && r.intent.chapter === 2),
        r.intent ? `${r.intent.book} ${r.intent.chapter}:${(r.intent.verses || [])[0]}` : 'no intent');
    } catch (e) {
      console.log('  SKIP  the spoken-reference check (no Windows speech synthesiser here)');
    } finally { try { fs.rmSync(spoken, { force: true }); } catch (e) {} }
    cloudspeech.configure({ on: false });
  }
}

console.log(`\n${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
