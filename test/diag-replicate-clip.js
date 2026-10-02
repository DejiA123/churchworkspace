'use strict';
/*
 * REPLICATE A REFERENCE EDIT, THROUGH THE APP'S OWN PIPELINE.
 *
 * Takes a landscape recording and produces the short-form vertical edit the
 * studio would produce: the speaker followed into a 9:16 crop, a name banner at
 * the top, and captions that light up word by word in time with the voice.
 *
 * It is deliberately NOT a re-implementation. Every stage is the module the
 * Video Studio itself calls:
 *
 *   tracking   window.FaceTrack           (MediaPipe, exactly as the studio runs it)
 *   reframe    video.exportShortReframed  (the same time-varying crop expression)
 *   captions   window.CapLayout           (the layout the preview draws) rasterised
 *              to a transparent track and burned by video.burnCaptionTrack
 *   banner     the studio's text-overlay rasteriser -> video.burnImageOverlays
 *
 * so whatever comes out of here is what the app produces. Run:
 *
 *   npx electron test/diag-replicate-clip.js --source "<video>" --words <whisper.json>
 *                 [--out <dir>] [--banner "BISHOP DAVID RICHMAN"] [--quality 720p]
 */
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpegBin = require('ffmpeg-static');
const ffprobeBin = require('ffprobe-static').path;
const video = require('../src/main/video');
const captioner = require('../src/main/captioner');

const ctx = { ffmpeg: ffmpegBin, ffprobe: ffprobeBin };
const AI_DIR = path.join(__dirname, '..', 'bin', 'ai');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const SOURCE = arg('source');
const WORDS = arg('words');
const EVENTS = arg('events', '');   // caption lines prepared elsewhere (e.g. through the Word Book)
const BANNER = arg('banner', '');
const QUALITY = arg('quality', '720p');
const OUT = arg('out', path.join(os.tmpdir(), 'mw-replica'));
const CAP_POS_Y = Number(arg('capY', 0.7808));   // block centre, frame fraction
const WORD_GAP = Number(arg('wordGap', 0.1));    // extra space between words, in font sizes
const SIZE_KEY = arg('size', 'm');
const SIZE_PCT = Number(arg('sizePct', 0)) || undefined;   // exact caption height, frame fraction
const TRACKING = Number(arg('tracking', 0));               // letter spacing, in font sizes
const MEASURE = arg('measure', '');                        // render one line and report its ink
const CAP_WIDTH = Number(arg('capWidth', 0.99));

if (!SOURCE || !(WORDS || EVENTS)) { console.error('need --source <video> and either --words <whisper.json> or --events <events.json>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

protocol.registerSchemesAsPrivileged([
  { scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const log = (...a) => console.log('[replicate]', ...a);
const ok = (data) => ({ ok: true, data });

/* ---- the few IPC calls the renderer half of the studio makes ---- */
ipcMain.handle('captions:fontList', () => ok(captioner.FONT_LIST.map((f) => ({ name: f.name, family: f.family, file: f.file }))));
ipcMain.handle('fonts:data', () => ok(fontData()));
ipcMain.handle('frames:write', (e, { dir, i, b64 }) => {
  const d = path.join(dir, 'capframes');
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, 'c' + String(i).padStart(5, '0') + '.png');
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  return ok(p);
});
ipcMain.handle('sermon:extractFrames', async (e, a) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-frames-'));
  const r = await video.extractFrames(ctx, Object.assign({ outDir: dir }, a));
  return ok(r);
});
function fontData() {
  const dir = captioner.fontsDir();
  const out = [];
  for (const f of captioner.FONT_LIST) {
    if (!f.file) continue;
    const p = path.join(dir, f.file);
    if (!fs.existsSync(p)) continue;
    out.push({ name: f.name, family: f.family, file: f.file, base64: fs.readFileSync(p).toString('base64') });
  }
  return out;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  protocol.handle('mwasset', async (request) => {
    try {
      const u = new URL(request.url);
      const rel = decodeURIComponent((u.hostname + u.pathname)).replace(/^\/+/, '');
      const full = path.normalize(path.join(AI_DIR, rel));
      if (!full.startsWith(AI_DIR)) return new Response('forbidden', { status: 403 });
      const ext = path.extname(full).toLowerCase();
      const mime = ext === '.wasm' ? 'application/wasm'
        : (ext === '.mjs' || ext === '.js') ? 'text/javascript' : 'application/octet-stream';
      return new Response(await fs.promises.readFile(full), { headers: { 'content-type': mime } });
    } catch (e) { return new Response('not found', { status: 404 }); }
  });

  const win = new BrowserWindow({
    show: false, width: 400, height: 300,
    webPreferences: {
      preload: path.join(__dirname, 'replicate-preload.js'),
      contextIsolation: false, nodeIntegration: false, offscreen: false,
    },
  });
  const page = path.join(OUT, 'harness.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><body>
    <script src="${JSON.stringify(path.join(__dirname, '..', 'src', 'renderer', 'caplayout.js')).slice(1, -1).replace(/\\/g, '/')}"></script>
    <script src="${JSON.stringify(path.join(__dirname, '..', 'src', 'renderer', 'facetrack.js')).slice(1, -1).replace(/\\/g, '/')}"></script>
    <script src="${JSON.stringify(path.join(__dirname, 'replicate-page.js')).slice(1, -1).replace(/\\/g, '/')}"></script>
  </body>`);
  await win.loadFile(page);
  await win.webContents.executeJavaScript('window.__ready === true');

  try {
    await run(win);
    log('DONE');
    app.exit(0);
  } catch (e) {
    console.error('[replicate] FAILED:', e && (e.stack || e.message));
    app.exit(1);
  }
});

async function run(win) {
  const info = await video.getInfo(ctx, SOURCE);
  log('source', info.width + 'x' + info.height, info.durationSec.toFixed(1) + 's', 'audio:', info.hasAudio);
  const p = video.presetSize('reel-9x16', QUALITY);
  log('output frame', p.w + 'x' + p.h);

  if (MEASURE) {
    const cfg = capCfg();
    const m = await win.webContents.executeJavaScript(
      `window.MW.measure(${JSON.stringify({ text: MEASURE, cfg, outW: p.w, outH: p.h })})`);
    const shot = m.shot; delete m.shot;
    const shotPath = path.join(OUT, 'measure.png');
    fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'));
    console.log(JSON.stringify({ frame: p.w + 'x' + p.h, cfg: { sizePct: cfg.sizePct, sizeKey: cfg.sizeKey, wordGap: cfg.wordGap, width: cfg.width }, shot: shotPath, ...m }, null, 1));
    return;
  }

  /* ---------------- 1. follow the speaker ---------------- */
  const kfFile = path.join(OUT, 'keyframes.json');
  let keyframes;
  if (fs.existsSync(kfFile)) {
    keyframes = JSON.parse(fs.readFileSync(kfFile, 'utf8'));
    log('keyframes: reusing', keyframes.length, 'from a previous run');
  } else {
    log('tracking the speaker…');
    keyframes = await win.webContents.executeJavaScript(
      `window.MW.track(${JSON.stringify({ input: SOURCE, startSec: 0, endSec: info.durationSec, targetAR: p.w / p.h, srcW: info.width, srcH: info.height })})`);
    log('keyframes:', keyframes.length);
    fs.writeFileSync(kfFile, JSON.stringify(keyframes));
  }

  /* ---------------- 2. the vertical crop ---------------- */
  const stage1 = path.join(OUT, '1-reframed.mp4');
  if (!fs.existsSync(stage1)) {
    log('reframing to ' + p.w + 'x' + p.h + '…');
    await video.exportShortReframed(ctx, {
      input: SOURCE, startSec: 0, endSec: info.durationSec, preset: 'reel-9x16', quality: QUALITY,
      keyframes, fill: 'crop', output: stage1,
      onProgress: pct((x) => log('  reframe ' + x + '%')),
    });
  } else log('reframe: reusing', stage1);

  /* ---------------- 3. the banner ---------------- */
  let stage2 = stage1;
  if (BANNER) {
    stage2 = path.join(OUT, '2-banner.mp4');
    if (!fs.existsSync(stage2)) {
      log('drawing the name banner…');
      const png = await win.webContents.executeJavaScript(
        `window.MW.banner(${JSON.stringify({ text: BANNER, w: p.w, h: p.h })})`);
      const pngPath = path.join(OUT, 'banner.png');
      fs.writeFileSync(pngPath, Buffer.from(png, 'base64'));
      await video.burnImageOverlays(ctx, {
        input: stage1, output: stage2,
        images: [{ path: pngPath, start: 0, end: info.durationSec }],
        onProgress: pct((x) => log('  banner ' + x + '%')),
      });
    } else log('banner: reusing', stage2);
  }

  /* ---------------- 4. the captions ---------------- */
  // Lines the caller already prepared (transcribed, and put through the Word
  // Book) win; otherwise they are built here from the raw transcript.
  const events = EVENTS
    ? JSON.parse(fs.readFileSync(EVENTS, 'utf8'))
    : captioner.buildCaptionEvents(captioner.wordsFromTokens(JSON.parse(fs.readFileSync(WORDS, 'utf8'))) || [],
      { wordsPerLine: 3, textCase: 'upper' });
  log('caption lines:', events.length, ' words:', events.reduce((n, e) => n + e.words.length, 0));
  fs.writeFileSync(path.join(OUT, 'events.json'), JSON.stringify(events));

  const cfg = capCfg();
  log('rasterising the caption track (this is the studio\'s own WYSIWYG path)…');
  const track = await win.webContents.executeJavaScript(
    `window.MW.capTrack(${JSON.stringify({ events, cfg, outW: p.w, outH: p.h, durationSec: info.durationSec, outDir: OUT })})`,
  );
  if (!track) throw new Error('the caption track came back empty');
  log('caption frames:', track.frames.length, ' band:', JSON.stringify(track.band));

  // A frame with no picture is a GAP between lines; they all share one fully
  // transparent still, written once however many gaps there are.
  const blank = path.join(OUT, 'capframes', 'gap.png');
  if (track.frames.some((f) => !f.file)) fs.writeFileSync(blank, video.transparentPng(track.band.w, track.band.h));
  track.frames = track.frames.map((f) => ({ file: f.file || blank, dur: f.dur }));

  const final = path.join(OUT, 'replica.mp4');
  log('burning captions…');
  await video.burnCaptionFrames(ctx, {
    input: stage2, track, output: final,
    onProgress: pct((x) => log('  captions ' + x + '%')),
  });
  log('wrote', final, (fs.statSync(final).size / 1e6).toFixed(1) + ' MB');
}

/** The caption look, in one place, so a measurement and the real burn can never
 *  be describing two different captions. */
function capCfg() {
  return {
    font: 'Poppins', family: 'Poppins', sizeKey: SIZE_KEY, sizePct: SIZE_PCT, style: 'outline',
    color: '#ffffff', outline: '#000000', outlineScale: 1, transition: 'none',
    position: 'bottom', posX: 0.5, posY: CAP_POS_Y, width: CAP_WIDTH,
    wordHighlight: true, wordColor: '#ffff00', wordGap: WORD_GAP, tracking: TRACKING,
  };
}

function pct(fn) {
  let last = -10;
  return (x) => { if (x >= last + 10) { last = x; fn(x); } };
}
