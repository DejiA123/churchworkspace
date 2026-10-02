'use strict';
/*
 * REAL test for the follow-up complaint:
 *
 *   "If I trim the clip and then use Long to shorts, THE FULL VIDEO is in the
 *    short clips — so Export all exports the whole video as well as the shorts.
 *    And if I just want to edit a long video and shorten it manually, I should
 *    be able to export the edited version."
 *
 * The cause: the timeline's base clip is marked `seed`, which keeps it OUT of
 * the Shorts panel — but dragging its edge CLEARED that flag ("trimming turns it
 * into a real clip"). So the moment you trimmed the recording down to where the
 * preaching starts, the whole trimmed service became a "short" and Export all
 * rendered it alongside the real ones.
 *
 * Trimming the base clip is how an operator says "this is the part I care
 * about". It is not the act of making a short. Splitting it or closing a gap
 * still are, and still produce listed clips.
 *
 * The other half of the fix is that manual long-form editing needs its own way
 * out: 💾 Export video renders the main-lane timeline as ONE file at the
 * recording's own size.
 *
 * The source is COLOUR-CODED so every claim about what was exported is checked
 * against the actual pixels:
 *      0–20s  RED    the pre-service
 *     20–50s  BLUE   the preaching
 *
 *   npm run test:editedexport
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
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-editedexport-test');
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'service-50s.mp4');
const TRIM = 20, TOTAL = 50;

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const near = (a, b, t) => Math.abs(a - b) <= t;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Speech-shaped audio, not a flat tone: the highlight engine looks for passages
 * of elevated energy FRAMED BY PAUSES, so a constant sine gives it nothing to
 * find and "no shorts" would be the test's fault, not the app's.
 *   0–20s  quiet-ish pre-service    20–50s  preaching with two loud key moments */
const SR = 16000;
function synthWav(file) {
  const n = SR * TOTAL;
  const data = Buffer.alloc(n * 2);
  let seed = 1357;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  // [from, to, level] 0 silence · 1 calm speech · 2 the loud key point
  const REG = [
    [0, 3, 0], [3, 17, 1], [17, 20, 0],
    [20, 23, 0], [23, 31, 2], [31, 34, 0],
    [34, 40, 1], [40, 43, 0], [43, 48, 2], [48, 50, 0],
  ];
  const amp = [30, 3200, 13000];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const r = REG.find(([a, b]) => t >= a && t < b) || REG[REG.length - 1];
    let a = 30;
    if (r[2] > 0) a = ((t - r[0]) % 0.47) < 0.35 ? amp[r[2]] : 30;  // "words"
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(a * rand()))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
function buildSrc() {
  if (fs.existsSync(SRC) && fs.statSync(SRC).size > 100000) return;
  const wav = path.join(WORK, 'speech.wav');
  synthWav(wav);
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-t', String(TRIM), '-i', 'color=c=0xFF0000:s=640x360:r=30',
    '-f', 'lavfi', '-t', String(TOTAL - TRIM), '-i', 'color=c=0x0000FF:s=640x360:r=30',
    '-i', wav,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', SRC], { stdio: 'ignore' });
}
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

/* ---- real main-process IPC ---- */
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
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
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'not needed' }));
// the rest of the app boots alongside the Video Studio — stub it so the console
// check measures real renderer errors rather than missing test handlers
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:savePresentation', (_e, { presentation }) => ok(presentation));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
// finishedFile() offers to reveal/play the export — nothing should actually open
// on the test machine, but the calls must not reject into the console
ipcMain.handle('shell:openPath', () => ok(true));
ipcMain.handle('shell:showItem', () => ok(true));
ipcMain.handle('video:info', async (_e, { input }) => ok(await video.getInfo(ctx, input)));
ipcMain.handle('video:waveform', async (_e, { input }) => {
  const output = path.join(WORK, `wave-${Date.now()}.png`);
  await video.waveform(ctx, { input, width: 1600, height: 90, output });
  return ok(output);
});
ipcMain.handle('video:filmstrip', async (_e, { input, count }) => {
  const output = path.join(WORK, `strip-${Date.now()}.png`);
  await video.filmstrip(ctx, { input, count: count || 16, output });
  return ok(output);
});
ipcMain.handle('fs:readImageDataUrl', async (_e, { path: p }) =>
  ok(`data:image/png;base64,${fs.readFileSync(p).toString('base64')}`));
let analyzeCalls = 0;
ipcMain.handle('sermon:analyze', async (_e, a) => {
  analyzeCalls++;
  try { return ok(await highlights.analyzeSermon(ctx, Object.assign({}, a, { contentAware: false, transcribeRange: null }))); }
  catch (err) { return { ok: false, error: err.message }; }
});
const exported = [];
ipcMain.handle('sermon:exportShort', async (_e, { input, startSec, endSec, preset, pieces, label }) => {
  const safe = (label || 'short').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const output = path.join(WORK, `out-${safe}-${Date.now()}-${exported.length}.mp4`);
  await video.exportShort(ctx, { input, startSec, endSec, preset: preset || 'reel-9x16', pieces, output });
  exported.push({ output, startSec, endSec, preset, pieces: pieces ? pieces.length : 0, label });
  return ok(output);
});
ipcMain.handle('video:extractFrames', async (_e, a) => {
  const dir = fs.mkdtempSync(path.join(WORK, 'frames-'));
  const frames = await video.extractFrames(ctx, Object.assign({ outDir: dir, fps: 2 }, a));
  return ok({ dir, cuts: frames.cuts || [], frames: frames.map((f) => ({ t: f.t, url: 'file:///' + f.path.replace(/\\/g, '/'), path: f.path })) });
});
ipcMain.handle('fs:rmdir', async (_e, { dir }) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} return ok(true); });

app.disableHardwareAcceleration();
const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

app.whenReady().then(async () => {
  console.log('\n[0] A colour-coded service: RED pre-service 0–20s, BLUE preaching 20–50s');
  buildSrc();
  const info = await video.getInfo(ctx, SRC);
  log(near(info.durationSec, TOTAL, 1), 'built the source', `${info.width}x${info.height} ${info.durationSec.toFixed(1)}s`);
  log(frameColour(SRC, 5) === 'RED' && frameColour(SRC, 35) === 'BLUE', 'the halves are colour-coded');

  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1200);

  console.log('\n[1] Load the recording — the base clip is not a short');
  const loaded = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    const rf = document.getElementById('veAutoReframe'); if (rf) rf.checked = false;
    const dp = document.getElementById('veDeep'); if (dp) dp.checked = false;
    await window.VideoEditor.__test.loadReal(${JSON.stringify(SRC)});
    const T = window.VideoEditor.__test;
    return { segs: T.segments(), shorts: T.shortsList(), cards: T.shortsCards(),
             exportAllOff: T.exportAllDisabled(), btn: T.exportEditedButton(), span: T.editedSpan() };`);
  if (loaded.__error) console.error('[1] ' + loaded.__error);
  log(loaded.segs.length === 1, 'the whole recording is on the timeline as one clip');
  log(loaded.shorts.length === 0 && loaded.cards === 0, 'and the Shorts panel is empty', `${loaded.shorts.length} shorts`);
  log(loaded.exportAllOff, 'Export all is disabled — there is nothing to export all OF');
  log(loaded.btn && !loaded.btn.disabled && /Export video/.test(loaded.btn.text),
    'but 💾 Export video is available and says how long it would be', loaded.btn && loaded.btn.text);

  console.log('\n[2] ►► THE BUG ◄◄ drag the clip’s left edge in to where the preaching starts');
  const trimmed = await js(win, `
    const T = window.VideoEditor.__test;
    const id = T.segIds()[0];
    const after = T.trimEdge(id, 'l', ${TRIM} * T.pxPerSec());
    return { after, isSeed: T.isSeed(id), shorts: T.shortsList(), cards: T.shortsCards(),
             exportAllOff: T.exportAllDisabled(), btn: T.exportEditedButton(), span: T.editedSpan() };`);
  if (trimmed.__error) console.error('[2] ' + trimmed.__error);
  log(trimmed.after && near(trimmed.after.start, TRIM, 2), 'the clip really was trimmed',
    trimmed.after && `${trimmed.after.start.toFixed(1)}s → ${trimmed.after.end.toFixed(1)}s`);
  log(trimmed.isSeed === true, 'THE FIX: trimming leaves it as the timeline base, not a short');
  log(trimmed.shorts.length === 0 && trimmed.cards === 0,
    'so the full video does NOT appear in the Shorts panel', `${trimmed.shorts.length} shorts, ${trimmed.cards} cards`);
  log(trimmed.exportAllOff, 'and Export all stays disabled — it cannot export the whole service by accident');
  log(trimmed.btn && /Export video \(/.test(trimmed.btn.text),
    '💾 Export video now offers exactly the trimmed length', trimmed.btn && trimmed.btn.text);

  console.log('\n[3] Long to shorts on the trimmed timeline');
  const run = await js(win, `
    const T = window.VideoEditor.__test;
    await T.clickFindHighlights();
    return { shorts: T.shortsList(), cards: T.shortsCards(), ai: T.aiClips(),
             segs: T.segments().length, exportAllOff: T.exportAllDisabled() };`);
  if (run.__error) console.error('[3] ' + run.__error);
  log(run.ai.length > 0, 'the AI produced shorts', `${run.ai.length} clips`);
  log(run.shorts.length === run.ai.length,
    'THE FIX: the Shorts panel lists ONLY the AI shorts — the full video is not among them',
    `${run.shorts.length} listed, ${run.ai.length} AI clips, ${run.segs} clips on the timeline`);
  log(run.shorts.every((s) => s.ai), 'every card in the panel is a real short', run.shorts.map((s) => s.label).join(' | '));
  log(!run.shorts.some((s) => near(s.start, TRIM, 2) && near(s.end, TOTAL, 2)),
    'nothing in the panel spans the whole trimmed recording');
  log(!run.exportAllOff, 'Export all is now enabled (there are real shorts to export)');

  console.log('\n[4] Export all renders the shorts and NOTHING else');
  exported.length = 0;
  const all = await js(win, `
    const T = window.VideoEditor.__test;
    await T.exportAll();
    return T.shortsList().length;`);
  if (all.__error) console.error('[4] ' + all.__error);
  log(exported.length === all, 'exactly one file per short — no extra full-length render',
    `${exported.length} exports for ${all} shorts`);
  const longest = exported.reduce((m, e) => Math.max(m, e.endSec - e.startSec), 0);
  log(longest < (TOTAL - TRIM) * 0.9, 'and not one of them is the whole service',
    `longest export ${longest.toFixed(1)}s of the ${TOTAL - TRIM}s kept`);
  for (const e of exported) {
    log(e.startSec >= TRIM - 2, `a short starts after the trim (${e.startSec.toFixed(1)}s)`);
  }

  console.log('\n[5] The other job: edit a long video by hand and save it');
  exported.length = 0;
  const edited = await js(win, `
    const T = window.VideoEditor.__test;
    await T.exportEditedVideo();
    return T.editedSpan();`);
  if (edited.__error) console.error('[5] ' + edited.__error);
  log(exported.length === 1, '💾 Export video renders exactly ONE file', `${exported.length} file(s)`);
  const ex = exported[0];
  if (ex) {
    log(ex.preset === 'source', 'at the recording’s own size — not cropped to a social preset', ex.preset);
    log(near(ex.startSec, TRIM, 2) && near(ex.endSec, TOTAL, 2), 'covering exactly the trimmed range',
      `${ex.startSec.toFixed(1)}s → ${ex.endSec.toFixed(1)}s`);
    const oi = await video.getInfo(ctx, ex.output);
    log(oi.width === info.width && oi.height === info.height, 'the exported file keeps the original frame',
      `${oi.width}x${oi.height}`);
    log(near(oi.durationSec, TOTAL - TRIM, 2), 'and is the trimmed length', `${oi.durationSec.toFixed(1)}s`);
    const seen = [];
    for (let t = 1; t < oi.durationSec - 1; t += 4) seen.push(frameColour(ex.output, t));
    log(seen.length > 0 && seen.every((c) => c === 'BLUE'),
      'EVERY frame is from the preaching — the pre-service is genuinely gone',
      `${seen.filter((c) => c === 'BLUE').length}/${seen.length} blue`);
  }

  console.log('\n[6] Closing a gap is included in the edited export');
  exported.length = 0;
  const gapped = await js(win, `
    const T = window.VideoEditor.__test;
    const id = T.segIds().filter(i => T.isSeed(i))[0] || T.segIds()[0];
    T.setCuts(id, [{ start: 30, end: 36 }]);      // the operator closed a 6s pause
    const span = T.editedSpan();
    await T.exportEditedVideo();
    return { span, btn: T.exportEditedButton() };`);
  if (gapped.__error) console.error('[6] ' + gapped.__error);
  const ex2 = exported[0];
  log(ex2 && ex2.pieces === 2, 'the export is handed the kept pieces either side of the pause',
    ex2 && `${ex2.pieces} pieces`);
  if (ex2) {
    const oi2 = await video.getInfo(ctx, ex2.output);
    log(near(oi2.durationSec, (TOTAL - TRIM) - 6, 2.5), 'and the saved video really is 6s shorter',
      `${oi2.durationSec.toFixed(1)}s`);
  }
  log(gapped.btn && /removed/.test(gapped.btn.title || ''), 'the button says the gap will be removed',
    gapped.btn && gapped.btn.title.slice(0, 90));

  console.log('\n[7] Untrimmed, everything still behaves');
  const back = await js(win, `
    const T = window.VideoEditor.__test;
    T.seedFullClip();
    return { shorts: T.shortsList().length, exportAllOff: T.exportAllDisabled(),
             span: T.editedSpan(), btn: T.exportEditedButton() };`);
  log(back.shorts === 0 && back.exportAllOff, 'a freshly seeded timeline has no shorts and Export all is off');
  log(back.span && near(back.span.start, 0, 1) && near(back.span.end, TOTAL, 2),
    '💾 Export video would save the whole recording', back.span && `${back.span.start.toFixed(1)}–${back.span.end.toFixed(1)}s`);

  console.log('\n[8] Console');
  log(errors.length === 0, 'no renderer errors', errors.slice(0, 3).join(' | ') || 'clean');

  console.log('\n============  EDITED EXPORT test ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
