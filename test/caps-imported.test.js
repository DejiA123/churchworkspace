'use strict';
/*
 * CAPTIONS THAT CAME FROM SOMEWHERE ELSE — subtitle files, or lines typed in by
 * hand — driven through the REAL app window.
 *
 * They know when each LINE starts and stops but not when each WORD does, and
 * the two caption dropdowns used to refuse them outright: "these captions have
 * no word-by-word timing to regroup". This checks the two things that had to
 * become true instead:
 *
 *   • CASE changes the letters and nothing else — same lines, same timings,
 *     same punctuation (it never needed word timings in the first place)
 *   • WORDS/LINE really does re-break them, from timings estimated inside each
 *     line, and Ctrl+Z puts the operator's own lines back
 *
 *   npx electron test/caps-imported.test.js
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

const WORK = path.join(os.tmpdir(), 'mw-caps-imported');
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'clip-20s.mp4');

let failed = false;
const log = (okv, name, d) => { console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : '')); if (!okv) failed = true; };

const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test Church', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: path.join(ROOT, 'bin/fonts') }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton']));
ipcMain.handle('captions:models', () => ok(require(path.join(ROOT, 'src/main/captioner')).models()));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
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

app.disableHardwareAcceleration();
const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lines as a subtitle file gives them: whole phrases, real punctuation, no words.
const IMPORTED = [
  { start: 0.4, end: 2.6, text: 'And he said unto them, peace be still.' },
  { start: 3.0, end: 5.4, text: 'Why are you so fearful?' },
  { start: 6.0, end: 9.2, text: 'How is it that you have no faith at all in this hour?' },
];

app.whenReady().then(async () => {
  if (!fs.existsSync(SRC)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-t', '20', '-i', 'testsrc2=s=1280x720:r=30',
      '-f', 'lavfi', '-t', '20', '-i', 'sine=frequency=440:sample_rate=44100',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
  }

  const errors = [];
  const win = new BrowserWindow({
    show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1400);

  const boot = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    await window.VideoEditor.__test.loadReal(${JSON.stringify(SRC)});
    const T = window.VideoEditor.__test;
    T.setCaps(${JSON.stringify(IMPORTED)});
    return { dur: T.videoDuration(), caps: T.capState() };`);
  if (boot.__error) console.error('[boot] ' + boot.__error);
  log(Math.abs(boot.dur - 20) < 0.6, 'a video is loaded', (boot.dur || 0).toFixed(1) + 's');
  log(boot.caps.events === 3 && boot.caps.words === 0,
    'three imported lines, with no word timings at all', JSON.stringify(boot.caps));

  /* ---- [1] the estimate ------------------------------------------------- */
  console.log('\n[1] Word timings estimated inside each line');
  const est = await js(win, 'return window.VideoEditor.__test.estimatedWords();');
  if (est.__error) console.error('[1] ' + est.__error);
  const totalWords = IMPORTED.reduce((n, e) => n + e.text.split(/\s+/).length, 0);
  log(est.length === totalWords, 'every word gets a timing', est.length + ' of ' + totalWords);
  log(est.every((w, i) => i === 0 || w.start >= est[i - 1].start - 1e-6), 'they run forwards');
  const inside = est.every((w) => IMPORTED.some((e) => w.start >= e.start - 1e-6 && w.end <= e.end + 1e-6));
  log(inside, 'and every word stays inside the line it came from');
  const first = est[0], last = est[est.length - 1];
  log(Math.abs(first.start - IMPORTED[0].start) < 1e-6, 'the first word starts when its line does', first.start + '');
  log(Math.abs(last.end - IMPORTED[2].end) < 0.01, 'the last word ends when its line does', last.end + '');

  /* ---- [2] CASE: letters only ------------------------------------------- */
  console.log('\n[2] ALL CAPS changes the letters and nothing else');
  const upper = await js(win, 'return window.VideoEditor.__test.setCapCase("upper");');
  if (upper.__error) console.error('[2] ' + upper.__error);
  log(upper.length === 3, 'still three lines — the breaks were not touched', upper.length + ' lines');
  log(upper.every((l, i) => Math.abs(l.start - IMPORTED[i].start) < 1e-6 && Math.abs(l.end - IMPORTED[i].end) < 1e-6),
    'and their timings are untouched');
  log(upper.every((l) => l.text === l.text.toUpperCase() && /[A-Z]/.test(l.text)),
    'every line is in capitals', JSON.stringify(upper[0].text));
  log(upper[0].text.indexOf(',') >= 0 && upper[0].text.indexOf('.') >= 0,
    'their own punctuation survives (this is not the app’s transcript to tidy)', JSON.stringify(upper[0].text));
  const back = await js(win, 'return window.VideoEditor.__test.setCapCase("none");');
  log(back.every((l, i) => l.text === IMPORTED[i].text),
    'and switching back to Normal restores the exact words they wrote', JSON.stringify(back[0].text));

  /* ---- [3] WORDS/LINE: really re-breaks --------------------------------- */
  console.log('\n[3] Words/line re-breaks imported captions');
  const three = await js(win, 'return window.VideoEditor.__test.setCapWordsPerLine(3);');
  if (three.__error) console.error('[3] ' + three.__error);
  log(three.length > 3, 'three words a line makes more, shorter lines', three.length + ' lines');
  log(three.every((l) => l.text.split(/\s+/).length <= 3), 'and none of them is longer than three words',
    JSON.stringify(three.slice(0, 3).map((l) => l.text)));
  log(three.every((l, i) => i === 0 || l.start >= three[i - 1].start - 1e-6), 'the new lines are in order');
  log(three.every((l) => l.end > l.start), 'and every one of them has a duration');
  const wordsNow = three.map((l) => l.text).join(' ').toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
  const wordsWas = IMPORTED.map((e) => e.text).join(' ').toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
  log(wordsNow.join(' ') === wordsWas.join(' '), 'not one word was lost or reordered',
    wordsNow.length + ' vs ' + wordsWas.length + ' words');
  const covered = three[0].start >= IMPORTED[0].start - 1e-6
    && three[three.length - 1].end <= IMPORTED[2].end + 0.01;
  log(covered, 'and the new lines sit inside the time the old ones did');

  // 1 / 2 / 3 / 4 / auto are the choices the dropdown actually offers
  const four = await js(win, 'return window.VideoEditor.__test.setCapWordsPerLine(4);');
  log(four.length < three.length, 'four words a line makes fewer, longer ones', four.length + ' lines');
  log(four.every((l) => l.text.split(/\s+/).length <= 4), 'and none of those is longer than four words',
    JSON.stringify(four.slice(0, 3).map((l) => l.text)));
  const auto = await js(win, 'return window.VideoEditor.__test.setCapWordsPerLine("auto");');
  log(auto.length > 0 && auto.every((l) => l.text.trim().length > 0), 'Auto also produces real lines', auto.length + ' lines');

  /* ---- [4] undo ---------------------------------------------------------- */
  console.log('\n[4] Ctrl+Z puts their own lines back');
  const undone = await js(win, `
    const T = window.VideoEditor.__test;
    T.undo();
    return T.capLines();`);
  if (undone.__error) console.error('[4] ' + undone.__error);
  log(undone.length === four.length, 'one undo steps back exactly one change', undone.length + ' lines (Auto had ' + auto.length + ', before that ' + four.length + ')');
  const allBack = await js(win, `
    const T = window.VideoEditor.__test;
    for (let i = 0; i < 6; i++) T.undo();
    return T.capLines();`);
  log(allBack.length === 3 && allBack.every((l, i) => l.text === IMPORTED[i].text),
    'and undoing the lot restores the imported captions exactly',
    JSON.stringify(allBack.map((l) => l.text)));

  /* ---- [5] nothing broke quietly ----------------------------------------- */
  console.log('\n[5] Nothing broke quietly');
  const real = errors.filter((e) => !/Autofill|devtools|GPU|Electron Security/i.test(e));
  log(real.length === 0, 'no console errors from the studio', real.slice(0, 3).join(' | '));

  console.log('\n==================  caps-imported ' + (failed ? 'FAILED' : 'PASSED') + '  ==================');
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
}).catch((e) => { console.error(e); process.exit(1); });
