'use strict';
/*
 * CAPTIONS: the characters that must never be drawn, and how well it hears.
 *
 * Two asks, one pipeline:
 *
 *   "remove these characters from the caption:  ?  ,  .  "  “”"
 *   "make the captions generated very accurate"
 *
 * The first is checked exhaustively and at every gate — the words are cleaned
 * when they are generated, again if they are retyped on the timeline, and once
 * more in the .ass the burner actually reads, because a caption that reaches the
 * picture with a full stop on it is the bug. The renderer's copy of the cleaner
 * is checked against the main process's copy input-for-input: they draw the same
 * words in the preview and in the file, so they may not disagree.
 *
 * The second is checked END TO END on real synthesised speech: Windows' own
 * speech engine reads a known sentence, whisper transcribes it, and the caption
 * lines are compared with what was said. That catches the thing unit tests
 * cannot — a decoder change that quietly stops producing word timings, or an
 * audio filter that shifts them.
 *
 *   node test/captions-accuracy.test.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const captioner = require('../src/main/captioner');
const ff = require('../src/main/ffmpeg');

const ctx = { ffmpeg, ffprobe };
let pass = 0, fail = 0, skipped = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const skip = (n, why) => { console.log('  SKIP ' + n + '  -> ' + why); skipped++; };

const clean = captioner.cleanCaptionText;
/** Every character the user listed, plus the shapes whisper actually emits. */
const BANNED = ['.', ',', '?', '"', '“', '”', '„', '«', '»', '…', '？', '，', '。'];
const hasBanned = (s) => BANNED.filter((c) => String(s).includes(c));

/**
 * The renderer's copy of the cleaner, lifted out of veditor.js and made
 * runnable. If the two ever drift apart, this stops being able to find it — and
 * that failure is the point: the preview and the burn must be one rule.
 */
function rendererCleaner() {
  const srcFile = path.join(__dirname, '..', 'src', 'renderer', 'veditor.js');
  const src = fs.readFileSync(srcFile, 'utf-8');
  const i = src.indexOf('function cleanCapText(t)');
  if (i < 0) return null;
  // take the function body up to its closing brace at the same indentation
  const end = src.indexOf('\n  }', i);
  if (end < 0) return null;
  const body = src.slice(i, end + 4);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return cleanCapText;`)();
}

(async () => {
  /* ================= 1. the characters, exhaustively ================= */
  const cases = [
    ['THE END GOAL.', 'THE END GOAL'],
    ['ROUND HOLE. IT', 'ROUND HOLE IT'],
    ["AIN'T GONNA WORK.", "AIN'T GONNA WORK"],
    ['Why shouldn’t they leave?', "Why shouldn't they leave"],
    ['well, you know, it', 'well you know it'],
    ['He said "wait on the Lord"', 'He said wait on the Lord'],
    ['He said “wait” now', 'He said wait now'],
    ['«bonjour»', 'bonjour'],
    ['what… now', 'what now'],
    ['？，。gone', 'gone'],
    ['A. B, C? D"', 'A B C D'],
    ['....', ''],
    ['?', ''],
    ['   spaced   out  ', 'spaced out'],
  ];
  for (const [input, want] of cases) {
    const got = clean(input);
    check(`clean(${JSON.stringify(input)}) = ${JSON.stringify(want)}`, got === want, JSON.stringify(got));
  }
  // things that must SURVIVE
  const keep = [
    ["DON'T", "DON'T"],
    ["YOU'RE", "YOU'RE"],
    ['well-known', 'well-known'],
    ['STOP!', 'STOP!'],
    ['1,000 people', '1,000 people'],
    ['3.5 hours', '3.5 hours'],
    ['Genesis 1:1', 'Genesis 1:1'],
    ['don’t', "don't"],
  ];
  for (const [input, want] of keep) {
    const got = clean(input);
    check(`keeps ${JSON.stringify(input)}`, got === want, JSON.stringify(got));
  }

  /* ---- the preview and the burn use ONE rule ---- */
  const rClean = rendererCleaner();
  if (!rClean) {
    check('the renderer cleaner could be located in veditor.js', false, 'cleanCapText not found — did it move?');
  } else {
    const probes = cases.concat(keep).map(([i]) => i).concat([
      'Mixed. "quotes", and? everything…', 'God’s word', 'A,B.C?D"E”F',
    ]);
    const bad = probes.filter((p) => rClean(p) !== clean(p));
    check('the preview cleaner and the burner cleaner agree on every probe',
      bad.length === 0, bad.length ? `differ on ${JSON.stringify(bad[0])}: ${JSON.stringify(rClean(bad[0]))} vs ${JSON.stringify(clean(bad[0]))}` : `${probes.length} inputs`);
  }

  /* ================= 2. cleaning happens at every gate ================= */
  const words = 'Why shouldn’t they leave? It could be another church. "Yes," he said, that they are meant for.'
    .split(' ').map((w, i) => ({ start: i * 0.4, end: i * 0.4 + 0.35, text: w }));
  const events = captioner.buildCaptionEvents(words, { wordsPerLine: 3, textCase: 'upper' });
  const dirty = events.filter((e) => hasBanned(e.text).length);
  check('generated caption lines carry none of the banned characters',
    dirty.length === 0, dirty.length ? `${JSON.stringify(dirty[0].text)}` : `${events.length} lines clean`);
  check('the words themselves survive intact', events.map((e) => e.text).join(' ').includes('SHOULDN\'T'),
    events.slice(0, 3).map((e) => e.text).join(' | '));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-capacc-'));
  const assPath = path.join(dir, 'caps.ass');
  // straight past buildCaptionEvents, as a hand-retyped line would arrive
  captioner.writeAss([
    { start: 0, end: 1, text: 'THE END GOAL.' },
    { start: 1, end: 2, text: 'IS THIS IT?' },
    { start: 2, end: 3, text: 'HE SAID "NO", THEN' },
    { start: 3, end: 4, text: '...' },
  ], { width: 1080, height: 1920, opts: {}, output: assPath });
  const ass = fs.readFileSync(assPath, 'utf-8');
  const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  const assText = dialogue.map((l) => l.split(',').slice(9).join(',')).join('\n');
  check('the .ass the burner reads has no banned characters in its text',
    hasBanned(assText).length === 0, JSON.stringify(assText.replace(/\n/g, ' / ')));
  check('a line that was ONLY punctuation is dropped, not drawn empty',
    dialogue.length === 3, `${dialogue.length} dialogue lines`);
  check('the surviving words are still the words', assText.includes('THE END GOAL') && assText.includes('IS THIS IT') && assText.includes('HE SAID NO THEN'), JSON.stringify(assText.replace(/\n/g, ' / ')));

  /* ================= 3. word timings out of a normal decode ============== */
  // whisper's -ojf json, with the special tokens and a zero-length token it
  // really does emit
  const fakeJson = { transcription: [{
    offsets: { from: 0, to: 2000 },
    text: " Wait on the Lord.",
    tokens: [
      { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 1 },
      { text: ' Wait', offsets: { from: 100, to: 400 }, p: 0.9 },
      { text: ' on', offsets: { from: 400, to: 520 }, p: 0.9 },
      { text: ' the', offsets: { from: 700, to: 700 }, p: 0.9 },   // zero length
      { text: ' Lo', offsets: { from: 700, to: 900 }, p: 0.9 },
      { text: 'rd', offsets: { from: 900, to: 1100 }, p: 0.9 },     // sub-word: same word
      { text: '.', offsets: { from: 1100, to: 1150 }, p: 0.4 },
      { text: '[_TT_230]', offsets: { from: 0, to: 0 }, p: 1 },
    ],
  }] };
  const w = captioner.wordsFromTokens(fakeJson);
  check('tokens become WORDS, not tokens', w.length === 4, w.map((x) => x.text).join(' | '));
  check('sub-word pieces are joined back into one word', w[3].text === 'Lord.', w[3].text);
  check("whisper's own markers are not words", !w.some((x) => x.text.startsWith('[')), w.map((x) => x.text).join(' '));
  check('a zero-length word still gets time on screen', w[2].end > w[2].start, `${w[2].start}-${w[2].end}`);
  check('word times are in seconds and in order',
    w[0].start === 0.1 && w.every((x, i) => i === 0 || x.start >= w[i - 1].start), JSON.stringify(w.map((x) => x.start)));
  check('a json with no token detail returns null so the caller can fall back',
    captioner.wordsFromTokens({ transcription: [{ text: 'hi', tokens: [] }] }) === null);

  /* ================= 4. the ASR audio chain shifts nothing ============== */
  const tone = path.join(dir, 'tone.wav');
  await ff.runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=5',
    '-af', "volume='if(lt(t,2),0,1)':eval=frame", '-c:a', 'pcm_s16le', '-y', tone], {});
  const filtered = path.join(dir, 'tone-asr.wav');
  await ff.runFfmpeg(ffmpeg, ['-i', tone, '-af', captioner.asrAudioFilter({}), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', filtered], {});
  const onsetOf = (f) => {
    const buf = execFileSync(ffmpeg, ['-v', 'error', '-i', f, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 });
    const p = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
    for (let i = 0; i < p.length; i++) if (Math.abs(p[i]) > 0.2) return i / 16000;
    return -1;
  };
  const shift = Math.abs(onsetOf(filtered) - onsetOf(tone));
  check('the ASR audio filter does not move the audio in time (< 5ms)', shift < 0.005, `${(shift * 1000).toFixed(1)} ms`);
  check('the ASR chain does NOT level or de-noise by default (both measured to hurt)',
    !captioner.asrAudioFilter({}).includes('speechnorm') && !captioner.asrAudioFilter({}).includes('afftdn'),
    captioner.asrAudioFilter({}));
  check('…but de-noising is available when the caller asks for it',
    captioner.asrAudioFilter({ denoise: 0.5 }).includes('afftdn'), captioner.asrAudioFilter({ denoise: 0.5 }));
  check('…and when it does, it is the SAME chain the finished video gets',
    captioner.asrAudioFilter({ denoise: 'strong', floorDb: -40 }) === require('../src/main/video').noiseReductionAf('strong', { floorDb: -40 }),
    captioner.asrAudioFilter({ denoise: 'strong', floorDb: -40 }));

  /* ================= 5. the model catalogue ================= */
  const models = captioner.models();
  check('the bundled model is listed and installed', models.some((m) => m.id === 'base.en' && m.installed && m.bundled));
  check('bigger models are offered as downloads', models.some((m) => m.id === 'small.en' && m.downloadable));
  check('exactly one model is marked in use', models.filter((m) => m.inUse).length === 1, models.filter((m) => m.inUse).map((m) => m.id).join(','));
  check('a bundled model cannot be deleted', captioner.removeModel('base.en') === false);

  /* ================= 6. END TO END on real speech ================= */
  const SAID = 'Wait on the Lord. Be strong, and let your heart take courage. Do you believe it?';
  const spoken = path.join(dir, 'spoken.wav');
  let haveSpeech = false;
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
      `$s.Rate = -1; $s.SetOutputToWaveFile('${spoken.replace(/\\/g, '\\\\')}'); $s.Speak('${SAID.replace(/'/g, "''")}'); $s.Dispose()`],
      { encoding: 'utf-8', timeout: 60000 });
    haveSpeech = ps.status === 0 && fs.existsSync(spoken) && fs.statSync(spoken).size > 20000;
  }
  if (!haveSpeech) {
    skip('end-to-end: real speech in, clean captions out', 'no system speech synthesiser on this platform');
  } else if (!captioner.isAvailable()) {
    skip('end-to-end: real speech in, clean captions out', 'the whisper engine/model is not installed in this checkout');
  } else {
    const spokenMp4 = path.join(dir, 'spoken.mp4');
    await ff.runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=15', '-i', spoken,
      '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', spokenMp4], {});
    const t0 = Date.now();
    const res = await captioner.transcribe(ctx, { input: spokenMp4 });
    const secs = (Date.now() - t0) / 1000;
    const info = await require('../src/main/video').getInfo(ctx, spokenMp4);
    check('real speech produced word-level timings', res.words.length >= 12, `${res.words.length} words in ${secs.toFixed(1)}s (${info.durationSec.toFixed(1)}s of audio)`);
    check('every word lands inside the clip',
      res.words.every((x) => x.start >= -0.05 && x.end <= info.durationSec + 0.6), 'ok');
    check('the words are in time order', res.words.every((x, i) => i === 0 || x.start >= res.words[i - 1].start));

    const heard = res.words.map((x) => x.text).join(' ').toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const said = SAID.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const wer = (() => {
      const a = said.split(' '), b = heard.split(' ');
      const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
      for (let j = 0; j <= b.length; j++) d[0][j] = j;
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
        d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1]);
      return d[a.length][b.length] / a.length;
    })();
    check('it heard what was actually said (word error rate <= 10%)', wer <= 0.10,
      `${(wer * 100).toFixed(1)}%  heard: "${heard}"`);

    const lines = captioner.buildCaptionEvents(res.words, { wordsPerLine: 3, textCase: 'upper' });
    const dirtyLines = lines.filter((l) => hasBanned(l.text).length);
    check('and NONE of the finished caption lines carries a banned character',
      dirtyLines.length === 0,
      dirtyLines.length ? JSON.stringify(dirtyLines[0].text) : lines.slice(0, 4).map((l) => l.text).join(' | '));
    check('the question mark in the spoken sentence is gone from the captions',
      !lines.some((l) => l.text.includes('?')) && heard.includes('believe'),
      lines.map((l) => l.text).join(' | ').slice(-60));

    // and through the REAL burner, the whole way to an .ass on disk
    const ass2 = path.join(dir, 'e2e.ass');
    captioner.writeAss(lines, { width: 1080, height: 1920, opts: { font: 'Bebas Neue', style: 'outline' }, output: ass2 });
    const body = fs.readFileSync(ass2, 'utf-8').split('\n').filter((l) => l.startsWith('Dialogue:')).map((l) => l.split(',').slice(9).join(',')).join(' ');
    check('the burned .ass from real speech is clean too', hasBanned(body).length === 0, JSON.stringify(body.slice(0, 90)));
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n==================  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
