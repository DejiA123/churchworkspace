'use strict';
/*
 * REAL end-to-end test for: "I cut a pause out of a short, now close the gap so the
 * pieces become ONE short without the pause."
 *
 * The source is a COLOUR-CODED video, which is what makes the proof objective:
 *
 *     0–10s  RED      the first half of the short
 *    10–15s  GREEN    <- "the pause" the user cuts out
 *    15–25s  BLUE     the second half
 *
 * The test splits at 10s and 15s, deletes the green middle, presses the app's real
 * "🔗 Close gap" button, then EXPORTS for real and decodes frames back out of the
 * MP4. If the pause was truly removed, the exported file is 20s long and contains
 * no green frame anywhere — red runs straight into blue at the 10s mark.
 *
 *   npx electron test/close-gap.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-closegap-test');
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'rgb-25s.mp4');

const PAUSE_START = 10, PAUSE_END = 15, TOTAL = 25;
const KEPT = TOTAL - (PAUSE_END - PAUSE_START); // 20s

let failed = false;
function log(okv, name, d) {
  console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!okv) failed = true;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---- read one frame's average colour straight out of a file (no PNG decode) ---- */
function frameRGB(file, t) {
  const seek = t == null ? [] : ['-ss', String(t)];
  const buf = execFileSync(ffmpeg, ['-v', 'error', ...seek, '-i', file,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '8x8', '-'],
    { maxBuffer: 1 << 22 });
  if (!buf.length) return null;
  let r = 0, g = 0, b = 0; const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}
/** Which of the three coded colours is this frame? (h.264 + yuv420 shifts values) */
function classify(c) {
  if (!c) return 'none';
  const { r, g, b } = c;
  if (r > 150 && g > 150 && b > 150) return 'WHITE';
  if (r > 110 && g < 90 && b < 90) return 'RED';
  if (g > 110 && r < 90 && b < 90) return 'GREEN';
  if (b > 110 && r < 90 && g < 90) return 'BLUE';
  return `other(${r},${g},${b})`;
}

/*
 * A LONG source, because that is where closing a gap used to fall apart. The same
 * RED/GREEN/BLUE short appears twice — once at 0s, once at 450s — so the identical
 * export can be measured from the front of the file and from deep inside it.
 *
 *   0–10 RED · 10–15 GREEN · 15–25 BLUE · 25–450 WHITE ·
 *   450–460 RED · 460–465 GREEN · 465–475 BLUE · 475–480 WHITE
 */
const LONG = path.join(WORK, 'long-480s.mp4');
const FAR = 450, LONG_TOTAL = 480;
function buildLong() {
  if (fs.existsSync(LONG)) return;
  const seg = (c, d) => ['-f', 'lavfi', '-t', String(d), '-i', `color=c=${c}:s=640x360:r=30`];
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    ...seg('0xFF0000', 10), ...seg('0x00FF00', 5), ...seg('0x0000FF', 10), ...seg('0xFFFFFF', FAR - 25),
    ...seg('0xFF0000', 10), ...seg('0x00FF00', 5), ...seg('0x0000FF', 10), ...seg('0xFFFFFF', LONG_TOTAL - 475),
    '-f', 'lavfi', '-t', String(LONG_TOTAL), '-i', 'sine=frequency=440:sample_rate=44100',
    '-filter_complex', '[0:v][1:v][2:v][3:v][4:v][5:v][6:v][7:v]concat=n=8:v=1:a=0[v]',
    '-map', '[v]', '-map', '8:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-g', '250', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', LONG], { stdio: 'ignore' });
}
/** Walk a finished short and report which coded colours it contains. */
function scanColours(file, dur) {
  const seen = [];
  for (let t = 0.3; t < dur - 0.4; t += 0.5) seen.push({ t: +t.toFixed(1), c: classify(frameRGB(file, t)) });
  return {
    seen,
    red: seen.filter((s) => s.c === 'RED'),
    blue: seen.filter((s) => s.c === 'BLUE'),
    bad: seen.filter((s) => s.c !== 'RED' && s.c !== 'BLUE'),
  };
}

/* --- real main-process IPC, same handlers the app ships ------------------ */
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test Church', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
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
  const ext = (path.extname(p).slice(1) || 'png').toLowerCase();
  return ok(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`);
});
// the handlers this feature actually rides on. `pieces` is the whole point: the
// export cuts the removed pauses out inside its OWN pass, so no joined
// intermediate is ever written.
let joinCalls = 0;
ipcMain.handle('video:joinPieces', async (_e, { input, pieces }) => {
  joinCalls++;
  const output = path.join(WORK, `joined-${Date.now()}.mp4`);
  await video.joinPieces(ctx, { input, pieces, output });
  return ok(output);
});
ipcMain.handle('sermon:exportShort', async (_e, { input, startSec, endSec, preset, pieces, label }) => {
  const safe = (label || 'short').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const output = path.join(WORK, `short-${safe}-${Date.now()}.mp4`);
  await video.exportShort(ctx, { input, startSec, endSec, preset: preset || 'reel-9x16', pieces, output });
  return ok(output);
});
ipcMain.handle('sermon:exportFramed', async (_e, { input, startSec, endSec, preset, zoom, offsetX, offsetY, pieces, label }) => {
  const safe = (label || 'short').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const output = path.join(WORK, `framed-${safe}-${Date.now()}.mp4`);
  const res = await video.exportShortFramed(ctx, { input, startSec, endSec, preset: preset || 'reel-9x16', zoom, offsetX, offsetY, pieces, output });
  return ok(res.output);
});
ipcMain.handle('sermon:exportReframed', async (_e, { input, startSec, endSec, preset, keyframes, pieces, label }) => {
  const safe = (label || 'short').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const output = path.join(WORK, `reframed-${safe}-${Date.now()}.mp4`);
  await video.exportShortReframed(ctx, { input, startSec, endSec, preset: preset || 'reel-9x16', keyframes, pieces, output });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  /* ---------- [0] a colour-coded source we can verify frame by frame ------ */
  console.log('\n[0] Colour-coded source (RED 0-10s · GREEN 10-15s "the pause" · BLUE 15-25s)');
  if (!fs.existsSync(SRC)) {
    execFileSync(ffmpeg, ['-y',
      '-f', 'lavfi', '-t', '10', '-i', 'color=c=0xFF0000:s=640x360:r=30',
      '-f', 'lavfi', '-t', '5', '-i', 'color=c=0x00FF00:s=640x360:r=30',
      '-f', 'lavfi', '-t', '10', '-i', 'color=c=0x0000FF:s=640x360:r=30',
      '-f', 'lavfi', '-t', String(TOTAL), '-i', 'sine=frequency=440:sample_rate=44100',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map', '[v]', '-map', '3:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', SRC], { stdio: 'ignore' });
  }
  const srcInfo = await video.getInfo(ctx, SRC);
  log(near(srcInfo.durationSec, TOTAL, 0.4), 'built a 25s source', `${srcInfo.width}x${srcInfo.height} ${srcInfo.durationSec.toFixed(1)}s`);
  log(classify(frameRGB(SRC, 5)) === 'RED' && classify(frameRGB(SRC, 12)) === 'GREEN' && classify(frameRGB(SRC, 20)) === 'BLUE',
    'the source really is RED → GREEN → BLUE',
    `5s=${classify(frameRGB(SRC, 5))} 12s=${classify(frameRGB(SRC, 12))} 20s=${classify(frameRGB(SRC, 20))}`);
  log(srcInfo.hasAudio, 'the source has an audio track (the join must keep it)');

  /* ---------- main-process unit checks on the join primitive -------------- */
  console.log('\n[1] normalizePieces (the guard in front of ffmpeg)');
  const NP = video.normalizePieces;
  log(JSON.stringify(NP([{ start: 15, end: 25 }, { start: 0, end: 10 }], 25)) === JSON.stringify([{ start: 0, end: 10 }, { start: 15, end: 25 }]),
    'puts pieces in time order');
  log(NP([{ start: 0, end: 10 }, { start: 10, end: 20 }], 25).length === 1, 'merges pieces that touch (no duplicated frame)');
  log(NP([{ start: 0, end: 10 }, { start: 5, end: 20 }], 25).length === 1, 'merges overlapping pieces');
  log(NP([{ start: 0, end: 0.02 }], 25).length === 0, 'drops a sliver too short to hold a frame');
  log(NP([{ start: 0, end: 999 }], 25)[0].end === 25, 'clamps past the end of the video');

  /* ---------- [1b] cutPlan — the graph every export now cuts with ---------- */
  console.log('\n[1b] cutPlan (the cut folded into the export\'s own pass)');
  const CP = video.cutPlan;
  log(CP([], 25) === null && CP(null, 25) === null, 'no pieces → no plan (callers keep their plain path)');

  const one = CP([{ start: 100, end: 110 }], { durationSec: 500, hasAudio: true });
  log(one.chain === null, 'a single kept piece needs no concat at all');
  log(JSON.stringify(one.inputArgs('X')) === JSON.stringify(['-ss', '100.000', '-i', 'X', '-t', '10.000']),
    'it seeks the input instead of decoding from 00:00', JSON.stringify(one.inputArgs('X')));

  const plan = CP([{ start: 450, end: 460 }, { start: 465, end: 475 }], { durationSec: 480, hasAudio: true });
  log(JSON.stringify(plan.inputArgs('X')) === JSON.stringify(['-ss', '450.000', '-i', 'X', '-t', '25.000']),
    'THE FIX: input seeks to the first kept piece and stops after the last',
    JSON.stringify(plan.inputArgs('X')));
  log(plan.dur === 20, 'it knows the export is 20s long (for the progress bar)', plan.dur + 's');
  log(/trim=start=0\.000:end=10\.000/.test(plan.chain) && /trim=start=15\.000:end=25\.000/.test(plan.chain),
    'the trim points are rebased onto that seek — not absolute source time');
  log(!/trim=start=450/.test(plan.chain) && !/trim=start=465/.test(plan.chain),
    'no absolute timestamp survives anywhere in the graph');
  log(/concat=n=2:v=1:a=1\[cutv\]\[cuta\]/.test(plan.chain), 'the pieces are concatenated into one video + audio stream');
  log(plan.v === 'cutv' && plan.a === 'cuta', 'the caller gets labels to hang its own crop/scale off');

  const mute = CP([{ start: 0, end: 5 }, { start: 8, end: 12 }], { durationSec: 20, hasAudio: false });
  log(!/atrim/.test(mute.chain) && /concat=n=2:v=1:a=0\[cutv\]$/.test(mute.chain) && mute.a === null,
    'a silent source builds a video-only graph (no atrim, no dangling audio label)');
  log(CP([{ start: 8, end: 12 }, { start: 0, end: 5 }], { durationSec: 20, hasAudio: true }).base === 0,
    'out-of-order pieces are sorted before the seek point is chosen');

  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1200);

  /* ---------- [2] the user's real workflow: split, split, delete ---------- */
  console.log('\n[2] Cut the pause out by hand (split at 10s, split at 15s, delete the middle)');
  const cut = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    const rf = document.getElementById('veAutoReframe'); if (rf) rf.checked = false;
    return window.VideoEditor.__test.loadReal(${JSON.stringify(SRC)}).then(() => {
      const T = window.VideoEditor.__test;
      T.split(${PAUSE_START});
      T.split(${PAUSE_END});
      const before = T.segments().map(s => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2) }));
      const ids = T.segIds();
      T.deleteClip(ids[1]);                       // bin the pause
      return {
        dur: T.videoDuration(), before,
        after: T.segments().map(s => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2) })),
        count: T.segCount(),
      };
    });`);
  if (cut.__error) console.error('[2] ' + cut.__error);
  log(near(cut.dur, TOTAL, 0.4), 'the 25s video is on the timeline', (cut.dur || 0).toFixed(1) + 's');
  log(cut.before.length === 3, 'two splits gave three clips', JSON.stringify(cut.before));
  log(cut.count === 2, 'deleting the middle leaves two clips and a real gap', JSON.stringify(cut.after));
  log(near(cut.after[0].end, PAUSE_START, 0.05) && near(cut.after[1].start, PAUSE_END, 0.05),
    'the gap is exactly the pause', `${cut.after[0].end}s → ${cut.after[1].start}s`);

  /* ---------- [3] press the real 🔗 Close gap button ---------------------- */
  console.log('\n[3] 🔗 Close gap — the two pieces become ONE short');
  const joined = await js(win, `
    const T = window.VideoEditor.__test;
    const id = T.clickCloseGap(false);          // the real toolbar button, real click
    const k = T.keptOf(id);
    return {
      id, count: T.segCount(), cuts: T.cutsOf(id), kept: k,
      notches: T.cutNotches(id), badge: T.joinBadge(id), pxPerSec: T.pxPerSec(),
      cards: document.querySelectorAll('#veClipList .ve-clip').length,
      isSeed: T.isSeed(id),
      exportBtn: (T.exportEditedButton() || {}).text || '',
    };`);
  if (joined.__error) console.error('[3] ' + joined.__error);
  log(joined.count === 1, 'the two clips are now ONE clip', `${joined.count} clip on the timeline`);
  log(joined.cuts && joined.cuts.length === 1 && near(joined.cuts[0].start, PAUSE_START, 0.05) && near(joined.cuts[0].end, PAUSE_END, 0.05),
    'the removed pause is recorded on that clip', JSON.stringify(joined.cuts));
  log(near(joined.kept.kept, KEPT, 0.1) && near(joined.kept.removed, 5, 0.1),
    'the clip now exports as 20s, with 5s removed', `kept=${joined.kept.kept}s removed=${joined.kept.removed}s`);
  log(joined.kept.pieces.length === 2 && near(joined.kept.pieces[0].end, PAUSE_START, 0.05) && near(joined.kept.pieces[1].start, PAUSE_END, 0.05),
    'the pieces that will be joined are the right two', JSON.stringify(joined.kept.pieces));
  log(joined.notches && joined.notches.length === 1
    && near(joined.notches[0].left, PAUSE_START * joined.pxPerSec, 1.5)
    && near(joined.notches[0].width, (PAUSE_END - PAUSE_START) * joined.pxPerSec, 1.5),
    'the removed pause is drawn as a notch, in the right place',
    JSON.stringify(joined.notches));
  log(/20s/.test(joined.badge || ''), 'the clip is badged with its real export length', joined.badge);
  // Editing the BASE video (split → delete → close gap) never makes a short: the
  // joined clip keeps its seed flag and stays OFF the Shorts panel. The kept
  // length shows on the 💾 Export video button instead of a clip card.
  log(joined.isSeed === true && joined.cards === 0,
    'the joined base video stays OFF the Shorts panel (still the seed, 0 cards)',
    `seed=${joined.isSeed} cards=${joined.cards}`);
  log(/0:20/.test(joined.exportBtn), 'the 💾 Export video button shows the 20s kept length', joined.exportBtn.trim());

  /* ---------- [4] the preview plays what will export ---------------------- */
  console.log('\n[4] Playback jumps over the removed pause');
  const skip = await js(win, `
    const T = window.VideoEditor.__test;
    const inPause = T.skipAt(12), before = T.skipAt(5), after = T.skipAt(20);
    const atEdge = T.skipAt(${PAUSE_START} + 0.05);
    T.seekAndRefresh(12); const maskInPause = T.gapMaskVisible();
    T.seekAndRefresh(5);  const maskInKept  = T.gapMaskVisible();
    return { inPause, before, after, atEdge, maskInPause, maskInKept };`);
  if (skip.__error) console.error('[4] ' + skip.__error);
  log(skip.inPause != null && near(skip.inPause, PAUSE_END, 0.05), 'playing into the pause jumps to its end', `12s → ${skip.inPause}s`);
  log(skip.atEdge != null && near(skip.atEdge, PAUSE_END, 0.05), 'the very first frame of the pause is skipped too', `10.05s → ${skip.atEdge}s`);
  log(skip.before == null && skip.after == null, 'kept footage plays normally (no phantom jumps)');
  log(skip.maskInPause === true && skip.maskInKept === false, 'scrubbing into the removed pause blanks the preview');

  /* ---------- [5] source time → exported time ----------------------------- */
  console.log('\n[5] The clip knows where every moment lands in the export');
  const map = await js(win, `
    const T = window.VideoEditor.__test, id = ${JSON.stringify(joined.id)};
    return { at0: T.srcToOut(id, 0), at9: T.srcToOut(id, 9), inPause: T.srcToOut(id, 12), at16: T.srcToOut(id, 16), at25: T.srcToOut(id, 25) };`);
  if (map.__error) console.error('[5] ' + map.__error);
  log(near(map.at0, 0, 0.01) && near(map.at9, 9, 0.01), 'before the cut, time is unchanged', `9s → ${map.at9}s`);
  log(map.inPause === null, 'a moment inside the pause maps to nothing (it is gone)');
  log(near(map.at16, 11, 0.01), 'after the cut, everything moves 5s earlier', `16s → ${map.at16}s`);
  log(near(map.at25, KEPT, 0.01), 'the end of the clip is the end of a 20s export', `25s → ${map.at25}s`);

  /* ---------- [6] captions ride along ------------------------------------- */
  console.log('\n[6] Captions are re-timed so the words still match the mouth');
  const caps = await js(win, `
    const T = window.VideoEditor.__test, id = ${JSON.stringify(joined.id)};
    // caption lines are stored CLIP-RELATIVE; this clip starts at 0
    T.setCapEvents([
      { start: 1,  end: 3,  text: 'BEFORE THE PAUSE' },
      { start: 11, end: 13, text: 'INSIDE THE PAUSE' },
      { start: 16, end: 18, text: 'AFTER THE PAUSE' },
    ], 0);
    return { remapped: T.remapCaps(id), blockCut: [T.capBlockCut(0), T.capBlockCut(1), T.capBlockCut(2)] };`);
  if (caps.__error) console.error('[6] ' + caps.__error);
  const rm = caps.remapped || [];
  log(rm.length === 2, 'the line spoken during the pause is dropped', `${rm.length} lines survive`);
  log(rm[0] && rm[0].text === 'BEFORE THE PAUSE' && near(rm[0].start, 1, 0.02),
    'a line before the cut keeps its timing', rm[0] && `${rm[0].start}s "${rm[0].text}"`);
  log(rm[1] && rm[1].text === 'AFTER THE PAUSE' && near(rm[1].start, 11, 0.05),
    'a line after the cut moves 5s earlier — still on the words', rm[1] && `16s → ${rm[1].start}s "${rm[1].text}"`);
  log(caps.blockCut[1] === true && caps.blockCut[0] === false && caps.blockCut[2] === false,
    'the dropped line is greyed out on the caption lane', JSON.stringify(caps.blockCut));

  /* ---------- [7] undo / redo -------------------------------------------- */
  console.log('\n[7] Undo puts the gap back');
  const undo = await js(win, `
    const T = window.VideoEditor.__test;
    T.undo();
    const afterUndo = { count: T.segCount(), segs: T.segments().map(s => +s.end.toFixed(1)) };
    T.redo();
    const ids = T.segIds();
    return { afterUndo, afterRedo: { count: T.segCount(), cuts: T.cutsOf(ids[0]) } };`);
  if (undo.__error) console.error('[7] ' + undo.__error);
  log(undo.afterUndo.count === 2, 'undo brings back the two separate clips', JSON.stringify(undo.afterUndo));
  log(undo.afterRedo.count === 1 && undo.afterRedo.cuts.length === 1, 'redo joins them again');

  /* ---------- [8] closing the gap from the OTHER side -------------------- */
  console.log('\n[8] It works whichever half you have selected');
  const other = await js(win, `
    const T = window.VideoEditor.__test;
    return T.loadReal(${JSON.stringify(SRC)}).then(() => {
      T.split(${PAUSE_START}); T.split(${PAUSE_END});
      const ids = T.segIds();
      T.deleteClip(ids[1]);
      // splitting leaves the RIGHT half selected — the awkward case, where there is
      // no clip AFTER the selection to join to
      const selIsRight = T.selId() === T.segIds()[1];
      const id = T.clickCloseGap(false);
      const k = T.keptOf(id);
      return { count: T.segCount(), kept: k && k.kept, removed: k && k.removed, selIsRight };
    });`);
  if (other.__error) console.error('[8] ' + other.__error);
  log(other.selIsRight === true, 'the clip left selected after a split really is the right-hand half');
  log(other.count === 1 && near(other.kept, KEPT, 0.1) && near(other.removed, 5, 0.1),
    'with the right-hand half selected it still joins into one 20s short',
    `${other.count} clip, kept=${other.kept}s removed=${other.removed}s`);

  /* ---------- [9] several pauses in one short ---------------------------- */
  console.log('\n[9] Two pauses in one short — one press each');
  const multi = await js(win, `
    const T = window.VideoEditor.__test;
    return T.loadReal(${JSON.stringify(SRC)}).then(() => {
      // two pauses: 5-7s and 15-18s
      T.split(5); T.split(7); T.split(15); T.split(18);
      const ids = T.segIds();                     // [0-5][5-7][7-15][15-18][18-25]
      T.deleteClip(ids[3]); T.deleteClip(ids[1]);
      const gaps = T.segCount();
      T.clickCloseGap();                          // closes one pause
      const mid = T.segCount();
      const id = T.clickCloseGap();               // closes the other
      const k = T.keptOf(id);
      return { gaps, mid, count: T.segCount(), cuts: T.cutsOf(id), kept: k && k.kept, removed: k && k.removed, notches: (T.cutNotches(id) || []).length };
    });`);
  if (multi.__error) console.error('[9] ' + multi.__error);
  log(multi.gaps === 3, 'three pieces with two holes between them', `${multi.gaps} clips`);
  log(multi.mid === 2, 'the first press closes one pause', `${multi.gaps} → ${multi.mid} clips`);
  log(multi.count === 1 && multi.cuts.length === 2, 'the second press leaves ONE short with both pauses removed', `${multi.cuts.length} pauses removed`);
  log(near(multi.removed, 5, 0.15) && near(multi.kept, 20, 0.15), 'total removed is 2s + 3s = 5s', `kept=${multi.kept}s removed=${multi.removed}s`);
  log(multi.notches === 2, 'both removed pauses are drawn on the clip');

  /* ---------- [9b] splitting a joined clip keeps the pauses removed ------- */
  console.log('\n[9b] Split a joined clip and each half keeps its removed pauses');
  const resplit = await js(win, `
    const T = window.VideoEditor.__test;
    const build = () => {
      T.split(${PAUSE_START}); T.split(${PAUSE_END});
      T.deleteClip(T.segIds()[1]);
      return T.clickCloseGap();                   // [0-25] with 10-15 removed
    };
    return T.loadReal(${JSON.stringify(SRC)}).then(() => {
      build();
      T.split(20);                                // split AFTER the removed pause
      let ids = T.segIds();
      const after = { left: T.keptOf(ids[0]), right: T.keptOf(ids[1]) };
      return T.loadReal(${JSON.stringify(SRC)}).then(() => {
        build();
        T.split(12);                              // split INSIDE the removed pause
        ids = T.segIds();
        return { after, inside: { left: T.keptOf(ids[0]), right: T.keptOf(ids[1]) } };
      });
    });`);
  if (resplit.__error) console.error('[9b] ' + resplit.__error);
  log(near(resplit.after.left.kept, 15, 0.1) && near(resplit.after.left.removed, 5, 0.1),
    'the half holding the pause still has it removed', `left kept=${resplit.after.left.kept}s removed=${resplit.after.left.removed}s`);
  log(near(resplit.after.right.kept, 5, 0.1) && resplit.after.right.removed === 0,
    'the other half is untouched', `right kept=${resplit.after.right.kept}s`);
  log(near(resplit.inside.left.removed, 2, 0.1) && near(resplit.inside.right.removed, 3, 0.1),
    'splitting INSIDE a removed pause divides it between the halves',
    `left removed=${resplit.inside.left.removed}s · right removed=${resplit.inside.right.removed}s`);

  /* ---------- [10] THE REAL EXPORT --------------------------------------- */
  console.log('\n[10] Export for real — one file, pause gone (this runs ffmpeg)');
  const exported = await js(win, `
    const T = window.VideoEditor.__test;
    return T.loadReal(${JSON.stringify(SRC)}).then(() => {
      T.split(${PAUSE_START}); T.split(${PAUSE_END});
      const ids = T.segIds();
      T.deleteClip(ids[1]);
      const id = T.clickCloseGap(false);
      return T.exportClip(id).then(p => ({ path: p, kept: T.keptOf(id).kept }));
    });`);
  if (exported.__error) console.error('[10] ' + exported.__error);
  const outPath = exported && exported.path;
  log(!!outPath && fs.existsSync(outPath), 'a single file was written', outPath);

  if (outPath && fs.existsSync(outPath)) {
    const outInfo = await video.getInfo(ctx, outPath);
    log(near(outInfo.durationSec, KEPT, 0.5), 'it is 20s long — the 5s pause is really gone',
      `${outInfo.durationSec.toFixed(2)}s (source was ${TOTAL}s)`);
    log(outInfo.hasAudio, 'the audio survived the join');

    // walk the whole exported file: there must be NO green anywhere
    const seen = [];
    for (let t = 0.3; t < KEPT - 0.4; t += 0.5) seen.push({ t: +t.toFixed(1), c: classify(frameRGB(outPath, t)) });
    const greens = seen.filter((s) => s.c === 'GREEN');
    log(greens.length === 0, 'NOT ONE frame of the removed pause is in the export',
      `${seen.length} frames sampled across the whole file, ${greens.length} green`);

    const reds = seen.filter((s) => s.c === 'RED'), blues = seen.filter((s) => s.c === 'BLUE');
    log(reds.length > 15 && blues.length > 15, 'both halves are present', `${reds.length} red + ${blues.length} blue frames`);
    log(reds.every((s) => s.t < PAUSE_START + 0.4) && blues.every((s) => s.t > PAUSE_START - 0.4),
      'red runs straight into blue at the 10s mark — the join is seamless',
      `last red ${Math.max(...reds.map((s) => s.t))}s · first blue ${Math.min(...blues.map((s) => s.t))}s`);
    const odd = seen.filter((s) => s.c !== 'RED' && s.c !== 'BLUE');
    log(odd.length === 0, 'no muddy blended frames at the splice', odd.length ? JSON.stringify(odd.slice(0, 3)) : 'clean');
    console.log('   eyeball it: ' + outPath);
  }

  /* ---------- [10b] THE SLOW CASE: a gap deep inside a long video --------- */
  console.log('\n[10b] A gap 450s into the video costs the same as one at 0s');
  console.log('   (building the long source…)');
  buildLong();
  const longInfo = await video.getInfo(ctx, LONG);
  log(near(longInfo.durationSec, LONG_TOTAL, 0.6), 'built a 480s source with the same short at 0s and at 450s',
    `${longInfo.durationSec.toFixed(1)}s`);

  const timeExport = async (name, pieces) => {
    const output = path.join(WORK, `far-${name}-${Date.now()}.mp4`);
    const t = Date.now();
    await video.exportShort(ctx, { input: LONG, pieces, preset: 'reel-9x16', output });
    return { ms: Date.now() - t, output };
  };
  const early = await timeExport('early', [{ start: 0, end: 10 }, { start: 15, end: 25 }]);
  const late = await timeExport('late', [{ start: FAR, end: FAR + 10 }, { start: FAR + 15, end: FAR + 25 }]);
  console.log(`   near the front: ${(early.ms / 1000).toFixed(1)}s · 450s in: ${(late.ms / 1000).toFixed(1)}s`);
  // Same 20s of output either way. Before the fix the late one also had to decode
  // 450s of lead-in first, so it took many times longer — and got worse the further
  // into the sermon the short sat. Allowing 2x + 6s absorbs machine noise while
  // still failing loudly if the lead-in is being decoded again.
  log(late.ms <= early.ms * 2 + 6000,
    'closing a gap 450s in is no slower than one at the start — the lead-in is never decoded',
    `${(late.ms / 1000).toFixed(1)}s vs ${(early.ms / 1000).toFixed(1)}s`);

  const frameCount = (f) => parseInt(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f]).toString().trim(), 10);
  for (const [name, r] of [['at 0s', early], ['at 450s', late]]) {
    const oi = await video.getInfo(ctx, r.output);
    const sc = scanColours(r.output, oi.durationSec);
    log(near(oi.durationSec, 20, 0.15) && oi.hasAudio && sc.bad.length === 0 && sc.red.length > 15 && sc.blue.length > 15,
      `and the export ${name} is still perfect — 20s, audio, red→blue, no pause`,
      `${oi.durationSec.toFixed(2)}s · ${sc.red.length} red + ${sc.blue.length} blue + ${sc.bad.length} other`);
  }
  // Seeking the input can leave the picture a sub-frame off, which lets the last
  // trim admit one extra frame at the tail. Everything BEFORE that stays aligned
  // (verified frame-by-frame against the old two-pass output at 41 dB, no frame
  // under 30 dB, splices included) — but if this ever grows past a frame or two,
  // the rebased trim points have drifted and the cuts are landing in the wrong place.
  const fEarly = frameCount(early.output), fLate = frameCount(late.output);
  log(Math.abs(fEarly - 600) <= 2 && Math.abs(fLate - 600) <= 2,
    'both exports hold 600 frames (20s @ 30fps) — the seek costs at most a frame at the tail',
    `at 0s: ${fEarly} · at 450s: ${fLate}`);
  log(Math.abs(fEarly - fLate) <= 1, 'and seeking 450s in does not change the frame count');

  /* ---------- [10c] the other two export paths cut the gaps too ----------- */
  console.log('\n[10c] Custom framing and face-tracked exports close the gaps as well');
  const farPieces = [{ start: FAR, end: FAR + 10 }, { start: FAR + 15, end: FAR + 25 }];

  const framedOut = path.join(WORK, `framed-${Date.now()}.mp4`);
  await video.exportShortFramed(ctx, { input: LONG, pieces: farPieces, preset: 'reel-9x16', zoom: 1.4, offsetX: 0.5, offsetY: 0.4, output: framedOut });
  const fi = await video.getInfo(ctx, framedOut);
  const fs2 = scanColours(framedOut, fi.durationSec);
  log(near(fi.durationSec, 20, 0.15) && fi.hasAudio && fs2.bad.length === 0,
    'a manually framed export is 20s with the pause gone',
    `${fi.durationSec.toFixed(2)}s · ${fs2.bad.length} bad frames`);

  // keyframes are on the JOINED clip's clock (0..20s), which is exactly what the
  // tracker now produces without a joined file existing
  const kf = [{ t: 0, x: 320, y: 180 }, { t: 10, x: 300, y: 180 }, { t: 20, x: 340, y: 180 }];
  const reOut = path.join(WORK, `reframed-${Date.now()}.mp4`);
  await video.exportShortReframed(ctx, { input: LONG, pieces: farPieces, preset: 'reel-9x16', keyframes: kf, output: reOut });
  const ri = await video.getInfo(ctx, reOut);
  const rs = scanColours(reOut, ri.durationSec);
  log(near(ri.durationSec, 20, 0.15) && ri.hasAudio && rs.bad.length === 0,
    'a face-tracked export is 20s with the pause gone',
    `${ri.durationSec.toFixed(2)}s · ${rs.bad.length} bad frames`);

  /* ---------- [10d] tracking only ever sees the kept footage -------------- */
  console.log('\n[10d] Face tracking samples the joined clip, not the removed pause');
  const fdir = fs.mkdtempSync(path.join(WORK, 'tframes-'));
  const tf = await video.extractFrames(ctx, { input: LONG, pieces: farPieces, fps: 6, outDir: fdir });
  const cols = tf.map((f) => classify(frameRGB(f.path, null)));
  const greenFrames = cols.filter((c) => c === 'GREEN');
  log(tf.length > 100, 'frames were sampled across the whole 20s clip', `${tf.length} frames at 6fps`);
  log(greenFrames.length === 0, 'NOT ONE tracking frame comes from the removed pause',
    `${cols.filter((c) => c === 'RED').length} red + ${cols.filter((c) => c === 'BLUE').length} blue, ${greenFrames.length} green`);
  log(near(tf[tf.length - 1].t, 20, 0.4), 'the last frame sits at the end of the JOINED clip, not the original range',
    `t=${tf[tf.length - 1].t.toFixed(2)}s`);
  // Scene-cut detection rides along in the same pass and swallows its own errors,
  // so it would fail SILENTLY — and the crop would glide across a splice instead of
  // snapping. The join itself is a hard cut (red straight into blue at 10s), so a
  // working detector must report one there.
  const atSplice = (tf.cuts || []).filter((c) => Math.abs(c.t - 10) < 0.6);
  log(atSplice.length > 0, 'the closed gap is reported as a scene cut, so the crop SNAPS at the splice',
    `${(tf.cuts || []).length} cuts found${atSplice.length ? ` incl. t=${atSplice[0].t.toFixed(2)}s` : ''}`);
  try { fs.rmSync(fdir, { recursive: true, force: true }); } catch (e) {}

  /* ---------- [10e] audio stays glued to the picture across the splices --- */
  console.log('\n[10e] Audio and video come out the same length (no drift at a splice)');
  const streamDur = (file, kind) => {
    const out = execFileSync(ffprobe, ['-v', 'error', '-select_streams', kind, '-show_entries',
      'stream=duration', '-of', 'csv=p=0', file]).toString().trim().split(/\r?\n/)[0];
    return parseFloat(out);
  };
  for (const [name, file] of [['plain', late.output], ['custom framing', framedOut], ['face-tracked', reOut]]) {
    const v = streamDur(file, 'v:0'), a = streamDur(file, 'a:0');
    // three pieces concatenated: if the atrim/trim pair ever disagreed, audio would
    // finish measurably early or late and the words would slide off the mouth
    log(Math.abs(v - a) < 0.12, `the ${name} export's audio matches its video length`,
      `video ${v.toFixed(3)}s · audio ${a.toFixed(3)}s · drift ${Math.abs(v - a).toFixed(3)}s`);
  }

  /* ---------- [10f] a source with no audio at all ------------------------- */
  console.log('\n[10f] A silent clip closes its gaps too (no dangling audio branch)');
  const SILENT = path.join(WORK, 'silent-30s.mp4');
  if (!fs.existsSync(SILENT)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-t', '10', '-i', 'color=c=0xFF0000:s=640x360:r=30',
      '-f', 'lavfi', '-t', '5', '-i', 'color=c=0x00FF00:s=640x360:r=30',
      '-f', 'lavfi', '-t', '10', '-i', 'color=c=0x0000FF:s=640x360:r=30',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', SILENT], { stdio: 'ignore' });
  }
  const silOut = path.join(WORK, `silent-short-${Date.now()}.mp4`);
  let silErr = null;
  try {
    await video.exportShort(ctx, { input: SILENT, pieces: [{ start: 0, end: 10 }, { start: 15, end: 25 }], preset: 'reel-9x16', output: silOut });
  } catch (e) { silErr = e.message; }
  log(!silErr, 'a silent source exports without ffmpeg choking on the graph', silErr || 'ok');
  if (!silErr) {
    const si = await video.getInfo(ctx, silOut);
    const ss2 = scanColours(silOut, si.durationSec);
    log(near(si.durationSec, 20, 0.15) && !si.hasAudio && ss2.bad.length === 0,
      'and it is 20s, still silent, with the pause gone',
      `${si.durationSec.toFixed(2)}s audio=${si.hasAudio} · ${ss2.bad.length} bad frames`);
  }

  /* ---------- [10g] no throwaway intermediate is rendered ----------------- */
  console.log('\n[10g] No joined intermediate is written any more');
  log(joinCalls === 0, 'exporting never rendered a joined temp file — the cut rides inside the export pass',
    `${joinCalls} join renders`);
  // the primitive still works on its own (it backs video:joinPieces)
  const jOut = path.join(WORK, `join-${Date.now()}.mp4`);
  await video.joinPieces(ctx, { input: LONG, pieces: farPieces, output: jOut });
  const ji = await video.getInfo(ctx, jOut);
  log(near(ji.durationSec, 20, 0.15) && ji.hasAudio, 'joinPieces itself still produces a correct 20s joined file',
    `${ji.durationSec.toFixed(2)}s`);

  /* ---------- [11] console clean ----------------------------------------- */
  console.log('\n[11] Console clean');
  log(errors.length === 0, 'no renderer errors during the whole run', errors.slice(0, 3).join(' | '));

  console.log('\n' + (failed ? '==============  close-gap test FAILED  ==============' : '==============  close-gap test PASSED  =============='));
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
