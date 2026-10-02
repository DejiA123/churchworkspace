'use strict';
/*
 * REAL end-to-end test for the Video Studio round that added:
 *
 *   1. background music (library + volume + bed under every short)
 *   2. a clip library whose chosen clip is appended to every short (the outro)
 *   3. Cancel on long jobs (deep analysis / transcription)
 *   4. "remove pauses" on the AI-generated shorts
 *   5. a VISUAL caption-style picker instead of a dropdown
 *   6. new text boxes start at the TOP of the frame
 *   7. captions carry no commas
 *
 * Nothing here is mocked where it matters: the source is a colour-coded video
 * with REAL silent gaps in its audio, the music is a real file mixed by real
 * ffmpeg, and the outro is decoded back out of the finished MP4 to prove it is
 * actually on the end.
 *
 *   npx electron test/music-outro-pauses.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const jobs = require(path.join(ROOT, 'src/main/jobs'));
const library = require(path.join(ROOT, 'src/main/library'));
const captioner = require(path.join(ROOT, 'src/main/captioner'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-music-outro-test');
fs.rmSync(path.join(WORK, 'library'), { recursive: true, force: true }); // a fresh library every run
fs.mkdirSync(WORK, { recursive: true });
library.init(WORK);

const SRC = path.join(WORK, 'talk-24s.mp4');   // RED, speech with two silent gaps
const OUTRO = path.join(WORK, 'outro-3s.mp4'); // GREEN
const MUSIC = path.join(WORK, 'bed-30s.m4a');
const TOTAL = 24, OUTRO_LEN = 3;
const GAP1 = [4, 7], GAP2 = [14, 17];

let failed = false;
function log(okv, name, d) {
  console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!okv) failed = true;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---- decode one frame's average colour straight out of a file ----
 * `center` samples only the middle band. A 16:9 outro fitted into a 9:16 short
 * is letterboxed on purpose, so a whole-frame average is mostly black bars and
 * says nothing about what's on screen. */
function frameRGB(file, t, center) {
  const args = ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1'];
  if (center) args.push('-vf', 'crop=iw/2:ih/6:iw/4:ih*5/12');
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '8x8', '-');
  const buf = execFileSync(ffmpeg, args, { maxBuffer: 1 << 22 });
  if (!buf.length) return null;
  let r = 0, g = 0, b = 0; const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}
function classify(c) {
  if (!c) return 'none';
  const { r, g, b } = c;
  if (r > 110 && g < 90 && b < 90) return 'RED';
  if (g > 110 && r < 90 && b < 90) return 'GREEN';
  if (b > 110 && r < 90 && g < 90) return 'BLUE';
  return `other(${r},${g},${b})`;
}
/** RMS loudness (0-1) of a window of a file's audio — how we prove music landed. */
function rmsAt(file, t, len) {
  const buf = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-t', String(len), '-i', file,
    '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 1 << 24 });
  if (buf.length < 2) return 0;
  let sum = 0; const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2) / 32768; sum += s * s; }
  return Math.sqrt(sum / n);
}

/* --- real main-process IPC, same handlers the app ships ------------------ */
const ok = (data) => ({ ok: true, data });
const wrapJob = (fn) => async (e, args = {}) => {
  try { return ok(args.jobId ? await jobs.run(args.jobId, () => fn(e, args)) : await fn(e, args)); }
  catch (err) { return jobs.isCancelError(err) ? { ok: false, error: 'Cancelled', cancelled: true } : { ok: false, error: err.message }; }
};
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test Church', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton']));
ipcMain.handle('video:thumbnail', async (_e, { input, timeSec }) => {
  const output = path.join(WORK, `thumb-${Date.now()}.jpg`);
  await video.thumbnail(ctx, { input, timeSec, output });
  return ok(output);
});
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
// the handlers this round actually rides on
ipcMain.handle('video:detectSilence', wrapJob((_e, a) => video.detectSilences(ctx, a)));
ipcMain.handle('library:list', () => ok(library.list()));
ipcMain.handle('library:add', async (_e, { kind, path: p, name, source }) => {
  try { return ok(await library.add(ctx, video, { kind, path: p, name, source })); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('library:remove', (_e, { kind, id }) => ok(library.remove({ kind, id })));
ipcMain.handle('job:cancel', (_e, { id }) => ok(jobs.cancel(id)));
ipcMain.handle('youtube:status', () => ok(library.ytStatus()));

app.disableHardwareAcceleration();

const js = (win, src) => win.webContents.executeJavaScript(`(() => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  /* ================= [0] sources ================= */
  console.log('\n[0] Build a talk with real silent gaps, a GREEN outro and a music bed');
  if (!fs.existsSync(SRC)) {
    execFileSync(ffmpeg, ['-y',
      '-f', 'lavfi', '-t', String(TOTAL), '-i', 'color=c=0xFF0000:s=320x180:r=25',
      '-f', 'lavfi', '-t', '4', '-i', 'sine=frequency=440:sample_rate=44100',
      '-f', 'lavfi', '-t', '3', '-i', 'anullsrc=r=44100:cl=mono',
      '-f', 'lavfi', '-t', '7', '-i', 'sine=frequency=440:sample_rate=44100',
      '-f', 'lavfi', '-t', '3', '-i', 'anullsrc=r=44100:cl=mono',
      '-f', 'lavfi', '-t', '7', '-i', 'sine=frequency=440:sample_rate=44100',
      '-filter_complex', '[1:a][2:a][3:a][4:a][5:a]concat=n=5:v=0:a=1[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', SRC], { stdio: 'ignore' });
  }
  if (!fs.existsSync(OUTRO)) {
    execFileSync(ffmpeg, ['-y',
      '-f', 'lavfi', '-t', String(OUTRO_LEN), '-i', 'color=c=0x00FF00:s=640x360:r=25',
      '-f', 'lavfi', '-t', String(OUTRO_LEN), '-i', 'sine=frequency=880:sample_rate=44100',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', OUTRO], { stdio: 'ignore' });
  }
  if (!fs.existsSync(MUSIC)) {
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-t', '30',
      '-i', 'sine=frequency=220:sample_rate=44100', '-c:a', 'aac', '-b:a', '128k', MUSIC], { stdio: 'ignore' });
  }
  const srcInfo = await video.getInfo(ctx, SRC);
  log(near(srcInfo.durationSec, TOTAL, 0.4) && srcInfo.hasAudio, 'talk source built', `${srcInfo.durationSec.toFixed(1)}s`);
  log(rmsAt(SRC, 1, 2) > 0.05 && rmsAt(SRC, 5, 1.5) < 0.01, 'its audio really is loud → SILENT → loud',
    `1s=${rmsAt(SRC, 1, 2).toFixed(3)} 5s=${rmsAt(SRC, 5, 1.5).toFixed(4)}`);

  /* ================= [1] find the pauses (request 4) ================= */
  console.log('\n[1] "Remove pauses": silencedetect finds the dead air inside a clip');
  const sil = await video.detectSilences(ctx, { input: SRC, startSec: 0, endSec: TOTAL, noiseDb: -32, minSilenceSec: 0.7 });
  const found = sil.silences;
  log(found.length === 2, 'found exactly the two pauses', JSON.stringify(found.map((s) => [+s.start.toFixed(1), +s.end.toFixed(1)])));
  const hit = (g) => found.some((s) => near(s.start, g[0], 0.5) && near(s.end, g[1], 0.5));
  log(hit(GAP1), 'the 4s–7s pause is where it should be');
  log(hit(GAP2), 'the 14s–17s pause is where it should be');
  log(found.every((s) => s.end - s.start >= 0.15), 'no zero-width "pauses" survive the padding');
  const inRange = await video.detectSilences(ctx, { input: SRC, startSec: 10, endSec: TOTAL, noiseDb: -32, minSilenceSec: 0.7 });
  log(inRange.silences.length === 1 && near(inRange.silences[0].start, GAP2[0], 0.5),
    'asking about ONE clip only returns that clip\'s pauses, in source time',
    JSON.stringify(inRange.silences.map((s) => +s.start.toFixed(1))));

  /* ================= [2] music bed (request 1) ================= */
  console.log('\n[2] Background music is really mixed under the video');
  const musicOut = path.join(WORK, 'with-music.mp4');
  await video.mixMusic(ctx, { input: SRC, output: musicOut, musicPath: MUSIC, musicVolume: 0.8, fadeIn: 0.2, fadeOut: 0.2, duck: false });
  const mInfo = await video.getInfo(ctx, musicOut);
  log(near(mInfo.durationSec, TOTAL, 0.5), 'the clip is still the same length', mInfo.durationSec.toFixed(1) + 's');
  log(classify(frameRGB(musicOut, 3)) === 'RED', 'the picture is untouched (video stream copied)');
  const quietBefore = rmsAt(SRC, GAP1[0] + 0.7, 1.5);
  const quietAfter = rmsAt(musicOut, GAP1[0] + 0.7, 1.5);
  log(quietAfter > quietBefore * 8 && quietAfter > 0.02,
    'the silent gap is now filled with music', `was ${quietBefore.toFixed(4)} → now ${quietAfter.toFixed(3)}`);

  console.log('\n[2b] The volume slider genuinely changes the level');
  const loudOut = path.join(WORK, 'music-loud.mp4');
  const softOut = path.join(WORK, 'music-soft.mp4');
  await video.mixMusic(ctx, { input: SRC, output: loudOut, musicPath: MUSIC, musicVolume: 0.9, fadeIn: 0, fadeOut: 0, duck: false });
  await video.mixMusic(ctx, { input: SRC, output: softOut, musicPath: MUSIC, musicVolume: 0.12, fadeIn: 0, fadeOut: 0, duck: false });
  const loud = rmsAt(loudOut, GAP1[0] + 0.7, 1.5), soft = rmsAt(softOut, GAP1[0] + 0.7, 1.5);
  log(loud > soft * 2.5, 'a louder setting really is louder', `90%=${loud.toFixed(3)} vs 12%=${soft.toFixed(3)}`);

  console.log('\n[2c] Ducking pulls the music down while someone is talking');
  const duckOut = path.join(WORK, 'music-duck.mp4');
  await video.mixMusic(ctx, { input: SRC, output: duckOut, musicPath: MUSIC, musicVolume: 0.8, fadeIn: 0, fadeOut: 0, duck: true });
  const duckSpeech = rmsAt(duckOut, 1, 2), flatSpeech = rmsAt(loudOut, 1, 2);
  log(duckSpeech < flatSpeech, 'music sits lower under speech when ducking is on',
    `ducked=${duckSpeech.toFixed(3)} vs flat=${flatSpeech.toFixed(3)}`);
  log(rmsAt(duckOut, GAP1[0] + 0.7, 1.5) > 0.02, '…and comes back up in the gap');

  /* ================= [3] outro on the end (request 2) ================= */
  console.log('\n[3] The chosen outro really is appended to the finished short');
  const short = path.join(WORK, 'short.mp4');
  await video.exportShort(ctx, { input: SRC, startSec: 0, endSec: 8, preset: 'reel-9x16', output: short });
  const shortInfo = await video.getInfo(ctx, short);
  const withOutro = path.join(WORK, 'short-outro.mp4');
  await video.appendClips(ctx, { input: short, output: withOutro, clips: [OUTRO], position: 'end' });
  const oInfo = await video.getInfo(ctx, withOutro);
  log(near(oInfo.durationSec, shortInfo.durationSec + OUTRO_LEN, 0.6),
    'the short got exactly the outro longer', `${shortInfo.durationSec.toFixed(1)}s → ${oInfo.durationSec.toFixed(1)}s`);
  log(oInfo.width === shortInfo.width && oInfo.height === shortInfo.height,
    'a 16:9 outro is fitted into the 9:16 frame, not stretched over it', `${oInfo.width}x${oInfo.height}`);
  log(classify(frameRGB(withOutro, 2, true)) === 'RED', 'the sermon is still at the front');
  log(classify(frameRGB(withOutro, shortInfo.durationSec + 1.4, true)) === 'GREEN', 'the outro plays at the end',
    classify(frameRGB(withOutro, shortInfo.durationSec + 1.4, true)));
  log(oInfo.hasAudio, 'the joined file kept its audio');

  /* ================= [4] the saved library ================= */
  console.log('\n[4] The library saves a copy, so the file can move and it still works');
  const movable = path.join(WORK, 'temp-outro.mp4');
  fs.copyFileSync(OUTRO, movable);
  const entry = await library.add(ctx, video, { kind: 'clips', path: movable, name: 'Church outro' });
  fs.rmSync(movable, { force: true });                       // the user tidies their Downloads
  log(fs.existsSync(entry.file) && entry.file !== movable, 'the clip lives in the library, not where it came from');
  log(near(entry.durationSec, OUTRO_LEN, 0.4), 'it knows how long it is', (entry.durationSec || 0).toFixed(1) + 's');
  log(!!entry.thumb && fs.existsSync(entry.thumb), 'it has a poster frame for the grid');
  const mEntry = await library.add(ctx, video, { kind: 'music', path: MUSIC, name: 'Bed' });
  const listed = library.list();
  log(listed.clips.length === 1 && listed.music.length === 1, 'both shelves list what was added',
    `${listed.music.length} music / ${listed.clips.length} clips`);
  try { await library.add(ctx, video, { kind: 'music', path: OUTRO, name: 'nope' }); log(false, 'a video is refused as music'); }
  catch (e) { log(/isn.t an audio file/.test(e.message), 'a video is refused as music', e.message.slice(0, 46)); }
  library.remove({ kind: 'music', id: mEntry.id });
  log(library.list().music.length === 0 && !fs.existsSync(mEntry.file), 'removing a track deletes its copy too');
  await library.add(ctx, video, { kind: 'music', path: MUSIC, name: 'Worship bed' }); // the studio needs one below

  /* ================= [5] Cancel (requests 3 & 5) ================= */
  console.log('\n[5] Cancel really kills the work in flight');
  const jobId = 'test-cancel-1';
  const slow = path.join(WORK, 'slow.mp4');
  const t0 = Date.now();
  const running = jobs.run(jobId, () => video.makeProxy(ctx, {
    // a deliberately expensive encode, so there is something to interrupt
    input: SRC, output: slow, onProgress: () => {},
  }));
  await sleep(600);
  const killed = jobs.cancel(jobId);
  let cancelErr = null;
  try { await running; } catch (e) { cancelErr = e; }
  const took = Date.now() - t0;
  log(killed.killed >= 1, 'cancelling killed the running ffmpeg', `${killed.killed} process(es)`);
  log(!!cancelErr && jobs.isCancelError(cancelErr), 'the job rejects as CANCELLED, not as a crash', cancelErr && cancelErr.message);
  log(took < 6000, 'it stopped promptly', took + 'ms');
  const jobId2 = 'test-cancel-2';
  const fine = await jobs.run(jobId2, async () => video.getInfo(ctx, SRC));
  log(!!fine.durationSec, 'a later job still runs normally (the cancel flag did not stick)');

  /* ================= [6] the renderer ================= */
  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1500, height: 1000,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1400);

  console.log('\n[6] Video Studio UI');
  const ui = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    const rf = document.getElementById('veAutoReframe'); if (rf) rf.checked = false;
    return window.VideoEditor.__test.loadReal(${JSON.stringify(SRC)}).then(() => ({
      musicBtn: !!document.getElementById('veMusic'),
      clipsBtn: !!document.getElementById('veClips'),
      pauseBox: !!document.getElementById('veRemovePauses'),
      musicLane: !!document.getElementById('veMusicTrack'),
      cancelBtn: !!document.getElementById('overlayCancel'),
      styleGrid: !!document.getElementById('capStyleGrid'),
      dur: window.VideoEditor.__test.videoDuration(),
    }));`);
  if (ui.__error) console.error('[6] ' + ui.__error);
  log(ui.musicBtn && ui.clipsBtn, 'Music and Clips buttons are in the toolbar');
  log(ui.pauseBox, '"Remove pauses" is an option next to Long-to-shorts');
  log(ui.musicLane, 'the timeline has a 🎵 Music lane');
  log(ui.cancelBtn, 'the progress overlay has a Cancel button');
  log(near(ui.dur, TOTAL, 0.5), 'the test video loaded', (ui.dur || 0).toFixed(1) + 's');

  console.log('\n[7] Caption looks are picked by SIGHT, not from a dropdown (request 6)');
  const styles = await js(win, `
    const T = window.VideoEditor.__test;
    const cards = T.capStyleCards();
    const before = T.pickCapStyle('clean');
    const band = T.pickCapStyle('band');
    const neon = T.pickCapStyle('neon');
    const dom = document.querySelector('#capStyleGrid .cap-style-card[data-capstyle="neon"]');
    return {
      cards, count: cards.length,
      selected: dom && dom.classList.contains('sel'),
      sampleText: dom && dom.querySelector('.cap-style-sample').textContent,
      sampleStyled: dom && /-?webkit-text-stroke|text-shadow|background/.test(dom.querySelector('.cap-style-sample').getAttribute('style') || ''),
      clean: before, band, neon,
      selValue: document.getElementById('capStyleSel').value,
    };`);
  if (styles.__error) console.error('[7] ' + styles.__error);
  log(styles.count >= 8, 'there is a grid of looks to choose from', styles.count + ' cards');
  log(!!styles.sampleText && styles.sampleText.trim().length > 0, 'each card shows real words, not a style name', JSON.stringify(styles.sampleText));
  log(!!styles.sampleStyled, 'the words on the card are actually wearing the style');
  log(styles.selected, 'clicking a card selects it');
  log(styles.selValue === 'neon', 'the saved value follows the card you clicked', styles.selValue);
  log(styles.band.style === 'box' && styles.band.outline === '#000000', 'a boxed look burns as a band', JSON.stringify(styles.band.style));
  log(styles.neon.style === 'outline' && styles.neon.color === '#2ff3ff' && styles.neon.outlineScale > 1,
    'a coloured look carries its own colour and stroke into the burn', `${styles.neon.color} x${styles.neon.outlineScale}`);
  log(styles.clean.style === 'shadow', 'the plain look is still a plain drop shadow');

  console.log('\n[7b] …and the preview on the video shows the same look');
  const overlay = await js(win, `
    const T = window.VideoEditor.__test;
    T.setCapEvents([{ start: 0.2, end: 6, text: 'THE QUICK BROWN FOX' }]);
    document.getElementById('veCapShow').checked = true;
    T.pickCapStyle('band'); T.updateCapOverlayAt(1);
    const boxed = T.capOverlayCss();
    T.pickCapStyle('neon'); T.updateCapOverlayAt(1);
    const neon = T.capOverlayCss();
    return { boxed, neon };`);
  if (overlay.__error) console.error('[7b] ' + overlay.__error);
  log(overlay.boxed && /rgb|#/.test(overlay.boxed.background || '') && overlay.boxed.background !== 'transparent',
    'the boxed look paints a band on the preview', overlay.boxed && overlay.boxed.background);
  log(overlay.neon && /47, 243, 255|2ff3ff/i.test(overlay.neon.color || ''), 'the neon look is neon on the preview', overlay.neon && overlay.neon.color);
  log(overlay.neon && overlay.neon.background === 'transparent', 'switching away from the band clears it again');

  // Captions used to keep full stops and question marks and drop only commas.
  // They now drop those too, on request ("remove these characters from the
  // caption: ? , . " “”") — test/captions-accuracy.test.js is where that rule is
  // pinned down in full; this just checks the studio's own grouping obeys it.
  console.log('\n[8] Captions carry no sentence punctuation (request 8)');
  const commas = await js(win, `
    const T = window.VideoEditor.__test;
    const words = [
      { start: 0, end: .4, text: 'And' }, { start: .4, end: .8, text: 'he' }, { start: .8, end: 1.2, text: 'said,' },
      { start: 1.2, end: 1.6, text: 'Peace,' }, { start: 1.6, end: 2, text: 'be' }, { start: 2, end: 2.4, text: 'still.' },
    ];
    return { three: T.groupWords(words, '3', 'none').map(e => e.text), auto: T.groupWords(words, 'auto', 'upper').map(e => e.text) };`);
  if (commas.__error) console.error('[8] ' + commas.__error);
  log(commas.three.every((t) => !/[,.?"“”]/.test(t)), 'no commas, full stops or quotes in the caption lines', JSON.stringify(commas.three));
  log(commas.three.join(' ').includes('said') && commas.three.join(' ').includes('still'),
    'but every WORD survives', JSON.stringify(commas.three));
  log(commas.auto.every((t) => !t.includes(',')), 'auto grouping still breaks ON commas but never prints one', JSON.stringify(commas.auto));

  console.log('\n[9] A new text box starts at the TOP of the frame (request 7)');
  const text = await js(win, `
    const T = window.VideoEditor.__test;
    const id = T.addText();
    const pos = T.textPos(id);
    return { pos };`);
  if (text.__error) console.error('[9] ' + text.__error);
  log(text.pos && text.pos.y < 0.3, 'it lands in the top third, not over the speaker\'s face', 'y=' + (text.pos && text.pos.y));
  // x stays mid-frame; the existing in-frame clamp may nudge it when the words are
  // wide relative to a narrow 9:16 crop, which is correct — it keeps them exportable.
  log(text.pos && near(text.pos.x, 0.5, 0.15), '…and mid-frame horizontally', 'x=' + (text.pos && text.pos.x.toFixed(3)));

  console.log('\n[10] Choosing music and an outro from the library');
  const lib = await js(win, `
    const T = window.VideoEditor.__test;
    return T.libReload().then((l) => {
      const music = l.music[0], clip = l.clips[0];
      const used = music ? T.useMusic(music.id) : null;
      const outro = clip ? T.useOutro(clip.id) : null;
      const vol = T.setMusicVolume(0.55);
      return {
        counts: { music: l.music.length, clips: l.clips.length },
        used, outro, vol,
        laneW: T.musicLaneWidthPx(),
        outroBlock: T.outroBlockPx(),
        trackW: T.trackWidthPx(),
        bedPos: T.musicPosAt(3),
        btnOn: document.getElementById('veMusic').classList.contains('on') && document.getElementById('veClips').classList.contains('on'),
      };
    });`);
  if (lib.__error) console.error('[10] ' + lib.__error);
  log(lib.counts && lib.counts.clips === 1, 'the saved outro shows up in the studio', JSON.stringify(lib.counts));
  log(lib.used && lib.used.bed === true, 'the chosen track defaults to a bed under every short');
  log(near(lib.vol, 0.55, 0.001), 'the volume slider sets the level', String(lib.vol));
  log(lib.laneW > 10, 'the music appears on the 🎵 lane', lib.laneW + 'px');
  log(lib.outroBlock && lib.outroBlock.left > 0 && lib.outroBlock.width > 0,
    'the outro is drawn on the END of the timeline', JSON.stringify(lib.outroBlock));
  log(lib.outroBlock && lib.trackW >= lib.outroBlock.left + lib.outroBlock.width - 1,
    'the timeline is long enough to show it');
  log(lib.bedPos != null && lib.bedPos >= 0, 'the preview knows where in the song the playhead is', String(lib.bedPos));
  log(lib.btnOn, 'the toolbar buttons light up once something is chosen');

  console.log('\n[11] "Remove pauses" turns dead air into real cuts on the clip');
  const pauses = await js(win, `
    const T = window.VideoEditor.__test;
    T.applyClips([{ start: 0, end: 24, label: 'Key 1' }]);
    const id = T.segIds()[0];
    T.setRemovePauses(true);
    return T.removePauses([id]).then((res) => ({ res, cuts: T.cutsFor(id), kept: T.keptDurOf ? T.keptDurOf(id) : null }));`);
  if (pauses.__error) console.error('[11] ' + pauses.__error);
  log(pauses.res && pauses.res.clips === 1, 'the clip was processed');
  log(pauses.cuts && pauses.cuts.length === 2, 'both pauses became cuts on the timeline',
    JSON.stringify((pauses.cuts || []).map((c) => [+c.start.toFixed(1), +c.end.toFixed(1)])));
  log(pauses.res && pauses.res.removed > 4, 'several seconds of dead air are marked for removal',
    (pauses.res && pauses.res.removed || 0).toFixed(1) + 's');
  log(!!(pauses.cuts || []).find((c) => near(c.start, GAP1[0], 0.6)), 'the first pause is in the right place');

  console.log('\n[12] The library window opens on the right shelf');
  const modal = await js(win, `
    const T = window.VideoEditor.__test;
    const a = T.openLibrary('clips');
    const cards = document.querySelectorAll('#libClipList .lib-card').length;
    const rows = document.querySelectorAll('#libMusicList .lib-row').length;
    const b = T.openLibrary('music');
    T.closeLibrary();
    return { a, b, cards, rows, closed: document.getElementById('libModal').classList.contains('hidden') };`);
  if (modal.__error) console.error('[12] ' + modal.__error);
  log(modal.a && modal.a.open && modal.a.tab === 'clips', 'the Clips button opens the clips shelf');
  log(modal.b && modal.b.tab === 'music', 'the Music button opens the music shelf');
  log(modal.cards === 1, 'the saved outro is on the shelf as a card with a thumbnail', modal.cards + ' card(s)');
  log(modal.closed, 'Done closes it');

  /* ================= [13] the caption burn honours the look ============ */
  console.log('\n[13] The .ass the burner writes matches the chosen look');
  const assPath = path.join(WORK, 'style.ass');
  captioner.writeAss([{ start: 0, end: 2, text: 'HELLO' }], {
    width: 1080, height: 1920, output: assPath,
    opts: { font: 'Anton', sizeKey: 'm', color: '#2ff3ff', outline: '#062a33', style: 'outline', outlineScale: 1.5 },
  });
  const ass = fs.readFileSync(assPath, 'utf-8');
  const styleLine = ass.split('\n').find((l) => l.startsWith('Style: Cap'));
  log(/&H00FFF32F/i.test(styleLine), 'the fill colour is the one the card showed', styleLine.slice(0, 70));
  log(/&H00332A06/i.test(styleLine), 'the outline colour came through too');
  captioner.writeAss([{ start: 0, end: 2, text: 'HELLO' }], {
    width: 1080, height: 1920, output: assPath,
    opts: { font: 'Anton', sizeKey: 'm', color: '#ffffff', outline: '#7b3ff2', style: 'box' },
  });
  const ass2 = fs.readFileSync(assPath, 'utf-8').split('\n').find((l) => l.startsWith('Style: Cap'));
  log(/,3,/.test(ass2), 'a boxed look uses ASS BorderStyle 3 (a real band)');
  log(/&H28F23F7B/i.test(ass2), 'the band is painted in the colour the card showed', ass2.slice(0, 70));

  console.log('\n[14] Console');
  const real = errors.filter((m) => !/DevTools|Autofill|Electron Security|GPU|Passthrough/i.test(m));
  log(real.length === 0, 'no renderer errors', real.slice(0, 3).join(' | ') || 'clean');

  console.log(failed ? '\nFAILED\n' : '\nALL PASS\n');
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
