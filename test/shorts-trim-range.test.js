'use strict';
/*
 * REAL end-to-end test for the complaint:
 *
 *   "I upload a long live session, I drag the clip on the timeline to the right so
 *    it starts where the preacher starts teaching — and Long-to-shorts STILL gives
 *    me clips from the whole video."
 *
 * The source is a synthetic two-half "service" whose structure is known exactly,
 * which is what makes the proof objective rather than a vibe:
 *
 *     0–145s   "the pre-service"  — three loud, well-framed moments at
 *                                   33-49s, 77-93s, 121-137s
 *   145–290s   "the preaching"    — three more at 178-194s, 222-238s, 266-282s
 *
 * Every one of those six is a legitimate highlight to the analyzer. So if the
 * operator trims the timeline block to start at 145s and the feature works, the
 * three EARLY ones must vanish completely and the three LATE ones must all be
 * found. If it is broken, early clips come back — exactly what the user saw.
 *
 * Proven at three levels, all real:
 *   [1] the engine, decoding real audio through real ffmpeg,
 *   [2] the actual UI — a real mouse drag of the clip's left trim handle in the
 *       real index.html, then a real click on the real Long-to-shorts button,
 *   [3] a real MP4 export of one of the resulting clips, decoded back to prove
 *       the picture came from after the trim (the halves are colour-coded).
 *
 *   npx electron test/shorts-trim-range.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const highlights = require(path.join(ROOT, 'src/main/highlights'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const { sermonPath, noSermon } = require('./sermon');
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-trimrange-test');
fs.mkdirSync(WORK, { recursive: true });

let failed = false;
function log(okv, name, d) {
  console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!okv) failed = true;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ the synthetic service (known ground truth) ============ */
const SR = 16000;
const A_CALM = 3200, A_LOUD = 13000, A_SIL = 30;
const HALF = 145, TOTAL = 290;
const TRIM = HALF;                     // where the operator drags the left edge to
// [start, end, level] within ONE half; level 0 silence, 1 calm, 2 loud
const HALF_REGIONS = [
  [0, 8, 0], [8, 30, 1], [30, 33, 0],
  [33, 49, 2],                          // KEY
  [49, 52, 0], [52, 74, 1], [74, 77, 0],
  [77, 93, 2],                          // KEY
  [93, 96, 0], [96, 118, 1], [118, 121, 0],
  [121, 137, 2],                        // KEY
  [137, 145, 0],
];
const EARLY_KEYS = [[33, 49], [77, 93], [121, 137]];
const LATE_KEYS = EARLY_KEYS.map(([a, b]) => [a + HALF, b + HALF]);

const WAV = path.join(WORK, 'service.wav');
const SRC = path.join(WORK, 'service-290s.mp4');

function synthWav(file) {
  const n = SR * TOTAL;
  const data = Buffer.alloc(n * 2);
  let seed = 24680;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  const amps = [A_SIL, A_CALM, A_LOUD];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const local = t % HALF;              // the same shape twice: two halves of a service
    const reg = HALF_REGIONS.find(([a, b]) => local >= a && local < b) || HALF_REGIONS[HALF_REGIONS.length - 1];
    let amp = A_SIL;
    if (reg[2] > 0) amp = ((local - reg[0]) % 0.47) < 0.35 ? amps[reg[2]] : A_SIL; // "words"
    let s = Math.round(amp * rand());
    s = Math.max(-32767, Math.min(32767, s));
    data.writeInt16LE(s, i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
/** Two colour-coded halves, so an exported short's PICTURE proves where it came from. */
function buildSource() {
  if (fs.existsSync(SRC)) return;
  synthWav(WAV);
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-t', String(HALF), '-i', 'color=c=0xFF0000:s=320x180:r=10',   // pre-service = RED
    '-f', 'lavfi', '-t', String(TOTAL - HALF), '-i', 'color=c=0x0000FF:s=320x180:r=10', // preaching = BLUE
    '-i', WAV,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', SRC], { stdio: 'ignore' });
}
/** Average colour of one frame — RED = pre-service half, BLUE = preaching half. */
function frameColour(file, t) {
  const buf = execFileSync(ffmpeg, ['-v', 'error', ...(t == null ? [] : ['-ss', String(t)]), '-i', file,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '8x8', '-'], { maxBuffer: 1 << 22 });
  if (!buf.length) return 'none';
  let r = 0, g = 0, b = 0; const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  r /= n; g /= n; b /= n;
  if (r > 110 && b < 90) return 'RED';
  if (b > 110 && r < 90) return 'BLUE';
  return `other(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}
const overlaps = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0])) > 3;
const hits = (clips, key) => clips.some((c) => overlaps([c.start, c.end], key));

/* ================= real main-process IPC (the handlers the app ships) ============= */
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test Church', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'thumbs not needed' }));
ipcMain.handle('video:info', async (_e, { input }) => ok(await video.getInfo(ctx, input)));
ipcMain.handle('video:waveform', async (_e, { input, width, height }) => {
  const output = path.join(WORK, `wave-${Date.now()}.png`);
  await video.waveform(ctx, { input, width: width || 1600, height: height || 90, output });
  return ok(output);
});
ipcMain.handle('video:filmstrip', async (_e, { input, count }) => {
  const output = path.join(WORK, `strip-${Date.now()}.png`);
  await video.filmstrip(ctx, { input, count: count || 16, output });
  return ok(output);
});
ipcMain.handle('fs:readImageDataUrl', async (_e, { path: p }) => {
  const buf = fs.readFileSync(p);
  return ok(`data:image/png;base64,${buf.toString('base64')}`);
});
// The REAL analyzer, with the REAL range plumbing. Audio-only (no whisper on the
// test box) — which is also the harder case for this feature, because the audio
// path is what decides where clips may open and close.
let lastAnalyzeArgs = null;
ipcMain.handle('sermon:analyze', async (_e, a) => {
  lastAnalyzeArgs = a;
  try {
    return ok(await highlights.analyzeSermon(ctx, Object.assign({}, a, { contentAware: false, transcribeRange: null })));
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('sermon:exportShort', async (_e, { input, startSec, endSec, preset, pieces, label }) => {
  const safe = (label || 'short').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const output = path.join(WORK, `short-${safe}-${Date.now()}.mp4`);
  await video.exportShort(ctx, { input, startSec, endSec, preset: preset || 'reel-9x16', pieces, output });
  return ok(output);
});
ipcMain.handle('video:extractFrames', async (_e, { input, startSec, endSec, fps, pieces }) => {
  const dir = fs.mkdtempSync(path.join(WORK, 'frames-'));
  const frames = await video.extractFrames(ctx, { input, startSec, endSec, fps: fps || 2, pieces, outDir: dir });
  return ok({ dir, cuts: frames.cuts || [], frames: frames.map((f) => ({ t: f.t, url: 'file:///' + f.path.replace(/\\/g, '/'), path: f.path })) });
});
ipcMain.handle('fs:rmdir', async (_e, { dir }) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (er) {} return ok(true); });

app.disableHardwareAcceleration();
const js = (win, src) => win.webContents.executeJavaScript(`(() => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

app.whenReady().then(async () => {
  console.log('\n[0] A synthetic 290s "service": RED pre-service (3 loud moments) + BLUE preaching (3 more)');
  buildSource();
  const info = await video.getInfo(ctx, SRC);
  log(near(info.durationSec, TOTAL, 1), 'built the source', `${info.width}x${info.height} ${info.durationSec.toFixed(1)}s`);
  log(frameColour(SRC, 60) === 'RED' && frameColour(SRC, 200) === 'BLUE',
    'the two halves are colour-coded, so an export can be traced back',
    `60s=${frameColour(SRC, 60)} 200s=${frameColour(SRC, 200)}`);

  /* ---------------- [1] the engine ---------------- */
  console.log('\n[1] The engine: does limiting the search actually limit it?');
  // Length band chosen so the six planted moments are the best windows available;
  // maxClips is generous, so a miss is a real miss and not a shortage of slots.
  const P = { minLen: 12, maxLen: 20, idealLen: 16, maxClips: 6, autoLen: true, contentAware: false };
  const whole = await highlights.analyzeSermon(ctx, Object.assign({ input: SRC }, P));
  const wholeClips = whole.clips.map((c) => ({ start: c.start, end: c.end }));
  log(EARLY_KEYS.every((k) => hits(wholeClips, k)) && LATE_KEYS.every((k) => hits(wholeClips, k)),
    'searching the WHOLE video finds moments in both halves (this is the behaviour being complained about)',
    wholeClips.map((c) => `${c.start}-${c.end}`).join(' '));
  log(wholeClips.some((c) => c.start < TRIM), 'and it really does return clips from before 145s', `${wholeClips.filter((c) => c.start < TRIM).length} early`);

  const trimmed = await highlights.analyzeSermon(ctx, Object.assign({ input: SRC }, P, {
    startSec: TRIM, endSec: TOTAL, ranges: [[TRIM, TOTAL]],
  }));
  const tClips = trimmed.clips.map((c) => ({ start: c.start, end: c.end }));
  log(tClips.length > 0, 'trimming to 145s→290s still produces clips', `${tClips.length} clips`);
  log(tClips.every((c) => c.start >= TRIM - 0.5), 'THE FIX: not one clip starts before the trim',
    tClips.map((c) => `${c.start}-${c.end}`).join(' '));
  log(tClips.every((c) => c.end <= TOTAL + 0.5), 'and none runs past the end of the kept footage');
  log(LATE_KEYS.every((k) => hits(tClips, k)), 'all three real moments inside the kept half are still found',
    LATE_KEYS.map((k) => (hits(tClips, k) ? '✓' : '✗') + k.join('-')).join(' '));
  log(!EARLY_KEYS.some((k) => hits(tClips, k)), 'and none of the three trimmed-away moments came back');
  log(trimmed.meta.searchedFrom === TRIM && near(trimmed.meta.searchedTo, TOTAL, 2),
    'the result says which stretch it searched', `${trimmed.meta.searchedFrom}s → ${trimmed.meta.searchedTo}s`);

  /* The real correctness bar: searching a range of the long file must give the
   * SAME answer as physically cutting that range out and analysing the cut file.
   * Anything less would mean the trim quietly changes which moments you get. */
  const CUT = path.join(WORK, 'second-half.mp4');
  if (!fs.existsSync(CUT)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(TRIM), '-i', SRC, '-t', String(TOTAL - TRIM), '-c', 'copy', CUT], { stdio: 'ignore' });
  }
  const preCut = await highlights.analyzeSermon(ctx, Object.assign({ input: CUT }, P));
  const shifted = preCut.clips.map((c) => `${(c.start + TRIM).toFixed(1)}-${(c.end + TRIM).toFixed(1)}`).join(' ');
  const asRanged = tClips.map((c) => `${c.start.toFixed(1)}-${c.end.toFixed(1)}`).join(' ');
  log(shifted === asRanged,
    'and it gives EXACTLY what analysing a physically pre-cut file gives — the trim changes where it looks, never how well it looks',
    shifted === asRanged ? asRanged : `ranged[${asRanged}] vs pre-cut[${shifted}]`);

  // A trim from the RIGHT (cut the end off) has to work the same way.
  const headOnly = await highlights.analyzeSermon(ctx, Object.assign({ input: SRC }, P, {
    startSec: 0, endSec: HALF, ranges: [[0, HALF]],
  }));
  log(headOnly.clips.length > 0 && headOnly.clips.every((c) => c.end <= HALF + 0.5),
    'trimming the END off works the same way — nothing comes from after it',
    headOnly.clips.map((c) => `${c.start}-${c.end}`).join(' '));

  // Two kept pieces with a hole between them: nothing may come out of the hole.
  const holed = await highlights.analyzeSermon(ctx, Object.assign({ input: SRC }, P, {
    startSec: 20, endSec: 290, ranges: [[20, 60], [170, 290]],
  }));
  log(holed.clips.length > 0 && holed.clips.every((c) => (c.start >= 19.5 && c.end <= 60.5) || (c.start >= 169.5 && c.end <= 290.5)),
    'split the timeline in two and clips only come from the pieces that are left',
    holed.clips.map((c) => `${c.start}-${c.end}`).join(' '));

  /* ---- [1b] DEEP mode: whisper must be asked for the right part of the file ----
   * Deep mode is the default in the app, and it reads the ORIGINAL file — so the
   * ranges it is handed have to be in the source's clock while everything inside
   * the analyzer is on the trimmed clock. Get that offset wrong and the words
   * come from the wrong minute of the service. A recording stub proves it without
   * paying for a real transcription. */
  console.log('\n[1b] Deep mode asks whisper for the right minutes of the file');
  const asked = [];
  const stubTranscribe = async (from, to) => {
    asked.push([from, to]);
    const segs = [];                       // sentences, clip-relative (as main.js returns)
    for (let t = 0; t + 3 <= to - from; t += 3) segs.push({ start: t, end: t + 3, text: `Sentence at ${(from + t).toFixed(0)} seconds.` });
    return { segs };
  };
  const deep = await highlights.analyzeSermon(ctx, Object.assign({ input: SRC }, P, {
    contentAware: true, transcribeRange: stubTranscribe, concurrency: 1,
    startSec: TRIM, endSec: TOTAL, ranges: [[TRIM, TOTAL]],
  }));
  log(asked.length > 0 && asked.every(([a, b]) => a >= TRIM - 0.01 && b <= TOTAL + 0.01),
    'every span sent for transcription is inside the kept footage, in SOURCE time',
    asked.map(([a, b]) => `${a.toFixed(0)}-${b.toFixed(0)}`).join(' '));
  log(deep.clips.length > 0 && deep.clips.every((c) => c.start >= TRIM - 0.5 && c.end <= TOTAL + 0.5),
    'and the deep-mode clips it picks are inside it too',
    deep.clips.map((c) => `${c.start}-${c.end}`).join(' '));
  const quoted = deep.clips.map((c) => (c.quote || '').match(/at (\d+) seconds/)).filter(Boolean).map((m) => +m[1]);
  log(quoted.length > 0 && quoted.every((t) => t >= TRIM - 5),
    'the WORDS attached to each clip come from that part of the service, not from the trimmed-off start',
    quoted.join(','));

  /* ---- [1c] the real thing: a 65-minute sermon off the user's own disk ---- */
  const REAL = sermonPath();
  console.log('\n[1c] A real 65-minute sermon recording');
  if (!REAL) {
    console.log(noSermon());
  } else {
    const ri = await video.getInfo(ctx, REAL);
    const START = 20 * 60;                                   // "the preaching starts here"
    const realP = { minLen: 20, maxLen: 90, idealLen: 50, autoLen: true, maxClips: 12, contentAware: false };
    const rWhole = await highlights.analyzeSermon(ctx, Object.assign({ input: REAL }, realP));
    log(rWhole.clips.some((c) => c.start < START),
      'untrimmed, the AI really does pull clips out of the first 20 minutes',
      `${rWhole.clips.filter((c) => c.start < START).length}/${rWhole.clips.length} before 20:00`);
    const rTrim = await highlights.analyzeSermon(ctx, Object.assign({ input: REAL }, realP, {
      startSec: START, endSec: ri.durationSec, ranges: [[START, ri.durationSec]],
    }));
    log(rTrim.clips.length >= 5, 'trimmed to 20:00→end it still finds a full set', `${rTrim.clips.length} clips`);
    log(rTrim.clips.every((c) => c.start >= START - 0.5),
      'and on real church footage not one of them starts before the trim',
      `earliest ${Math.min(...rTrim.clips.map((c) => c.start)).toFixed(0)}s (trim ${START}s)`);
    log(rTrim.clips.every((c) => c.end <= ri.durationSec + 0.5), 'nor past the end of the recording');
  }

  /* ---------------- [2] the real UI ---------------- */
  console.log('\n[2] The real Video Studio: drag the clip’s left edge, then press the real button');
  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1200);

  const loaded = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    const rf = document.getElementById('veAutoReframe'); if (rf) rf.checked = false;
    const dp = document.getElementById('veDeep'); if (dp) dp.checked = false;
    return window.VideoEditor.__test.loadReal(${JSON.stringify(SRC)}).then(() => {
      const T = window.VideoEditor.__test;
      return { segs: T.segments(), ranges: T.searchRanges(), label: T.searchLabel(), pxPerSec: T.pxPerSec() };
    });`);
  if (loaded.__error) console.error('[2] ' + loaded.__error);
  log(loaded.segs && loaded.segs.length === 1, 'the video lands on the timeline as one clip', JSON.stringify(loaded.segs && loaded.segs[0]));
  log(loaded.ranges.length === 1 && loaded.ranges[0][0] < 1 && loaded.ranges[0][1] > TOTAL - 2,
    'untouched, the whole recording is what will be searched', JSON.stringify(loaded.ranges));
  log(!loaded.label.trimmed && /Long to short/.test(loaded.label.text), 'and the button says so', loaded.label.text);

  // The actual gesture: grab the left trim handle and drag it right to 145s.
  const dragged = await js(win, `
    const T = window.VideoEditor.__test;
    const id = T.segIds()[0];
    const px = ${TRIM} * T.pxPerSec();
    const after = T.trimEdge(id, 'l', px);
    return { after, ranges: T.searchRanges(), label: T.searchLabel(), count: T.segCount() };`);
  if (dragged.__error) console.error('[2] ' + dragged.__error);
  log(dragged.after && near(dragged.after.start, TRIM, 3),
    'dragging the left handle really moved the clip’s start to ~145s',
    dragged.after ? `${dragged.after.start.toFixed(1)}s → ${dragged.after.end.toFixed(1)}s` : 'no drag');
  log(dragged.ranges.length === 1 && near(dragged.ranges[0][0], TRIM, 3) && dragged.ranges[0][1] > TOTAL - 2,
    'so the search range follows the trim', JSON.stringify(dragged.ranges));
  log(dragged.label.trimmed && /Shorts from/.test(dragged.label.text),
    'and the button now tells the operator exactly what it will search', dragged.label.text);

  const run = await js(win, `
    const T = window.VideoEditor.__test;
    return T.clickFindHighlights().then(args => ({
      args, segs: T.segments(), ai: T.aiClips(),
    }));`);
  if (run.__error) console.error('[2] ' + run.__error);
  log(run.args && near(run.args.startSec, TRIM, 3) && near(run.args.endSec, TOTAL, 2),
    'the app really asks the engine for the trimmed range only',
    run.args ? `startSec=${(run.args.startSec || 0).toFixed(1)} endSec=${(run.args.endSec || 0).toFixed(1)}` : 'no args');
  log(run.args && Array.isArray(run.args.ranges) && run.args.ranges.length === 1,
    'passing the exact pieces left on the timeline', JSON.stringify(run.args && run.args.ranges));
  const ai = (run.ai || []);
  log(ai.length > 0, 'the button produced clips', `${ai.length} clips`);
  log(ai.length > 0 && ai.every((c) => c.start >= TRIM - 3),
    'THE BUG THE USER REPORTED IS GONE: every short starts after the trim',
    ai.map((c) => `${c.start.toFixed(0)}-${c.end.toFixed(0)}`).join(' '));
  log(ai.length > 0 && ai.every((c) => c.end <= TOTAL + 1), 'and none runs past the end');

  /* ---------------- [3] a real export, decoded back ---------------- */
  console.log('\n[3] Export one of those shorts for real and look at the picture');
  const out = await js(win, `
    const T = window.VideoEditor.__test;
    const c = T.aiClips().sort((a,b) => a.start - b.start)[0];
    return T.exportClip(c.id).then(f => ({ file: f, clip: { start: c.start, end: c.end } }));`);
  if (out.__error) console.error('[3] ' + out.__error);
  const file = out.file;
  log(!!file && fs.existsSync(file), 'the short was written', file);
  if (file && fs.existsSync(file)) {
    const oi = await video.getInfo(ctx, file);
    const seen = [];
    for (let t = 0.5; t < oi.durationSec - 0.5; t += 2) seen.push(frameColour(file, t));
    log(seen.length > 0 && seen.every((c) => c === 'BLUE'),
      'every frame of the exported short is from the PREACHING half — no pre-service footage at all',
      `${seen.filter((c) => c === 'BLUE').length}/${seen.length} blue` + (seen.some((c) => c !== 'BLUE') ? ' · ' + seen.join(',') : ''));
  }

  /* ---------------- [4] untrimmed still searches everything ---------------- */
  console.log('\n[4] Put the whole video back and the AI is allowed everywhere again');
  const back = await js(win, `
    const T = window.VideoEditor.__test;
    T.seedFullClip();
    return T.clickFindHighlights().then(args => ({ args, ai: T.aiClips(), label: T.searchLabel() }));`);
  if (back.__error) console.error('[4] ' + back.__error);
  log(back.args && !back.args.startSec && !back.args.ranges, 'no range is sent when nothing is trimmed', JSON.stringify(back.args && { startSec: back.args.startSec, ranges: back.args.ranges }));
  log((back.ai || []).some((c) => c.start < TRIM) && (back.ai || []).some((c) => c.start >= TRIM),
    'and clips come from both halves again', (back.ai || []).map((c) => c.start.toFixed(0)).join(' '));
  log(!back.label.trimmed, 'the button goes back to its plain label', back.label.text);

  console.log('\n[5] Console');
  log(errors.length === 0, 'no renderer errors', errors.slice(0, 3).join(' | ') || 'clean');

  console.log('\n============  TRIM-RANGE test ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
