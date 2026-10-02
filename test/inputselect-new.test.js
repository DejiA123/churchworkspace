'use strict';
/*
 * GO LIVE — NEW INPUT SELECT CATEGORIES (the vMix "everything must be
 * available" pass). Boots the REAL app UI wired to the REAL engines (no
 * stubbing the thing under test) and drives the Input Select dialog through
 * real DOM clicks/typing for every newly-supported category:
 *   Audio (file), List, Image Sequence/Stinger, Video Delay, Instant Replay,
 *   Stream/SRT, Web Browser, Video Call, PowerPoint — plus confirms DVD and
 *   Virtual Set remain honestly disabled.
 *
 * Run: npx electron test/inputselect-new.test.js
 */
const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { LiveStream, ProgramHub, QUALITIES } = require('../src/main/livestream');
const { BrowserSource } = require('../src/main/browsersource');
const { NetStream } = require('../src/main/netstream');
const ffmod = require('../src/main/ffmpeg');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-inputsel-'));

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

function run(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
}
async function probe(file) {
  const r = await run(FP, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]);
  try { return JSON.parse(r.out); } catch (e) { return {}; }
}

/* ---- IPC stubs (mirrors main.js; the engines under test are REAL) ---- */
let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: { dest: 'facebook', key: '', customUrl: '', quality: '480p' } };
let nextOpenFile = null;
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: FF, ffprobe: FP }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('dialog:openFile', wrap(async () => nextOpenFile));
ipcMain.handle('fs:writeText', wrap(async (e, { path: p, text }) => { fs.writeFileSync(p, text, 'utf-8'); return p; }));
ipcMain.handle('fs:readText', wrap(async (e, { path: p }) => fs.readFileSync(p, 'utf-8')));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:pickScreen', () => ok(true));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));

/* real recorder engine, wired like main.js: Record and Instant Replay share the
   ProgramHub's single encode of the program; MultiCorder records its own inputs */
const ctx = { ffmpeg: FF, ffprobe: FP };
const hub = new ProgramHub();
const hubRecFiles = new Map();
const recorders = new Map();
const isProgramRec = (recId) => recId === 'main' || recId === 'replay';

function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    const isRec = isProgramRec(id);
    const chan = isRec ? 'rec:' + type : 'live:' + type;
    const key = isRec ? { recId: id, file: hubRecFiles.get(id) } : { destId: id };
    try { if (!sender.isDestroyed()) sender.send(chan, { ...key, ...payload }); } catch (er) {}
    if (type === 'ended' && isRec) hubRecFiles.delete(id);
  };
  hub.onHubEvent = (type, payload) => {
    if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (er) {} }
  };
}
// main.js probes the hardware encoder at startup so the first Record / Go Live
// isn't delayed by encoder validation; do the same here or the timings differ.
const { detectEncoder } = require('../src/main/livestream');
detectEncoder(FF, 'auto').catch(() => {});

ipcMain.handle('program:session', wrap(async (e, a) => {
  wireHub(e.sender);
  return { ...(await hub.session(ctx, { ...a, encoder: 'auto' })), sid: a.sid };
}));
ipcMain.on('live:chunk', (e, payload) => {
  try { hub.write(payload && payload.sid, Buffer.from(payload && payload.buf ? payload.buf : payload)); } catch (er) {}
});
ipcMain.handle('rec:start', wrap(async (e, { recId, name, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['480p'];
  const file = path.join(tmp, `${String(name || 'recording').replace(/[^\w.-]+/g, '_')}-${Date.now()}.mp4`);
  if (isProgramRec(recId)) {
    wireHub(e.sender);
    hubRecFiles.set(recId, file);
    try { hub.addOutput(ctx, recId, { kind: 'file', filePath: file, q, fps: q.fps || fps }); }
    catch (err) { hubRecFiles.delete(recId); throw err; }
    return { file };
  }
  if (recorders.has(recId)) throw new Error('recorder busy');
  const rec = new LiveStream();
  rec.onEvent = (type, payload) => {
    try { if (!e.sender.isDestroyed()) e.sender.send('rec:' + type, { recId, file, ...payload }); } catch (er) {}
    if (type === 'ended') recorders.delete(recId);
  };
  rec.start(ctx, { filePath: file, videoKbps: q.videoKbps, audioKbps: q.audioKbps, fps: q.fps || fps });
  recorders.set(recId, rec);
  return { file };
}));
ipcMain.on('rec:chunk', (e, { recId, buf }) => { const r = recorders.get(recId); if (r) { try { r.write(Buffer.from(buf)); } catch (er) {} } });
ipcMain.handle('rec:stop', wrap(async (e, { recId }) => {
  if (isProgramRec(recId)) { await hub.removeOutput(recId); hubRecFiles.delete(recId); if (!hub.outputCount) await hub.stop(); return true; }
  const r = recorders.get(recId); if (r) { await r.stop(); recorders.delete(recId); }
  return true;
}));

/* real Web Browser / Video Call / PowerPoint engine */
const browserSources = new Map();
ipcMain.handle('browser:open', wrap(async (e, { id, url }) => {
  if (browserSources.has(id)) throw new Error('already open');
  const bs = new BrowserSource(id, (buf, w, h) => { try { if (!e.sender.isDestroyed()) e.sender.send('browser:frame', { id, buf, w, h }); } catch (er) {} });
  browserSources.set(id, bs);
  try { await bs.load(url); } catch (err) { bs.destroy(); browserSources.delete(id); throw err; }
  return true;
}));
ipcMain.handle('browser:nav', wrap(async (e, { id, url }) => { const bs = browserSources.get(id); if (!bs) throw new Error('not open'); await bs.load(url); return true; }));
ipcMain.handle('browser:close', wrap(async (e, { id }) => { const bs = browserSources.get(id); if (bs) { bs.destroy(); browserSources.delete(id); } return true; }));

/* real Stream/SRT engine */
const netStreams = new Map();
ipcMain.handle('netstream:start', wrap(async (e, { id, url }) => {
  if (netStreams.has(id)) throw new Error('already running');
  const framePath = path.join(tmp, `netstream-${id}.jpg`);
  const ns = new NetStream();
  ns.onEvent = (type, payload) => { try { if (!e.sender.isDestroyed()) e.sender.send('netstream:' + type, { id, ...payload }); } catch (er) {} if (type === 'ended') netStreams.delete(id); };
  ns.start({ ffmpeg: FF }, { url, framePath });
  netStreams.set(id, ns);
  return { framePath };
}));
ipcMain.handle('netstream:stop', wrap(async (e, { id }) => { const ns = netStreams.get(id); if (ns) { await ns.stop(); netStreams.delete(id); } return true; }));

/* real PowerPoint (LibreOffice) engine */
function findSoffice() {
  const candidates = ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'];
  return candidates.find((c) => { try { return fs.existsSync(c); } catch (e) { return false; } }) || null;
}
ipcMain.handle('ppt:check', wrap(async () => ({ available: !!findSoffice() })));
function runSofficeConvert(soffice, outDir, pptxPath) {
  return new Promise((resolve, reject) => {
    const p = spawn(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, pptxPath], { windowsHide: true });
    const killTimer = setTimeout(() => { try { p.kill(); } catch (e) {} reject(new Error('LibreOffice took too long.')); }, 30000);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(killTimer); code === 0 ? resolve() : reject(new Error('convert failed: ' + err.slice(-300))); });
  });
}
ipcMain.handle('ppt:convert', wrap(async (e, { pptxPath }) => {
  const soffice = findSoffice();
  if (!soffice) throw new Error('LibreOffice is not installed.');
  const base = path.basename(pptxPath, path.extname(pptxPath));
  let pdfPath = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const outDir = path.join(tmp, `ppt-${Date.now()}-${attempt}`);
    fs.mkdirSync(outDir, { recursive: true });
    await runSofficeConvert(soffice, outDir, pptxPath);
    const candidate = path.join(outDir, base + '.pdf');
    if (fs.existsSync(candidate)) { pdfPath = candidate; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!pdfPath) throw new Error('no pdf produced after retry');
  return { pdfPath };
}));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.LiveStudio.__test';

app.whenReady().then(async () => {
  console.log('== INPUT SELECT — NEW CATEGORIES TEST ==');

  /* -------- test assets -------- */
  const vid1 = path.join(tmp, 'clip-red.mp4');
  const vid2 = path.join(tmp, 'clip-blue.mp4');
  for (const [f, col] of [[vid1, 'red'], [vid2, 'blue']]) {
    const r = await run(FF, ['-y', '-f', 'lavfi', '-i', `color=c=${col}:size=640x360:rate=30:duration=2`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
    if (r.code !== 0) { console.error('sample video build failed:\n' + r.out.slice(-800)); app.exit(1); return; }
  }
  const img1 = path.join(tmp, 'slide-a.png');
  const img2 = path.join(tmp, 'slide-b.png');
  await run(FF, ['-y', '-f', 'lavfi', '-i', 'color=c=green:size=320x180', '-frames:v', '1', img1]);
  await run(FF, ['-y', '-f', 'lavfi', '-i', 'color=c=magenta:size=320x180', '-frames:v', '1', img2]);
  const mp3 = path.join(tmp, 'tone.mp3');
  await run(FF, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', mp3]);
  const pptx = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'scratchpad-placeholder.pptx'); // unused, replaced below

  // a real single-slide pptx, built the same way as the throwaway generator script
  const pptxPath = path.join(tmp, 'deck.pptx');
  {
    const archiver = require('archiver');
    const parts = {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
      'ppt/presentation.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId2"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>',
      'ppt/slides/slide1.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Slide One Test</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
      'ppt/slides/_rels/slide1.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
      'ppt/slideLayouts/slideLayout1.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="title"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
      'ppt/slideMasters/slideMaster1.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>',
      'ppt/theme/theme1.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>',
    };
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(pptxPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      out.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(out);
      for (const [name, content] of Object.entries(parts)) archive.append(content, { name });
      archive.finalize();
    });
  }

  // a tiny distinctive local test page for Web Browser / Video Call
  const webPage = path.join(tmp, 'testpage.html');
  fs.writeFileSync(webPage, '<!doctype html><html><body style="margin:0;background:#ff8800;height:100vh"></body></html>');

  // a tiny local HTTP server for the Stream/SRT test (serves the red clip)
  const httpServer = http.createServer((req, res) => {
    const s = fs.createReadStream(vid1);
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    s.pipe(res);
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const httpPort = httpServer.address().port;

  const win = new BrowserWindow({
    show: true, width: 1480, height: 920,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => callback(sources[0] ? { video: sources[0] } : {})).catch(() => callback({}));
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1200);
  await js(win, `document.querySelector('.nav-item[data-view="live"]').click(); await new Promise((r) => setTimeout(r, 300)); return true;`);

  /* ============================ Audio (file) ============================ */
  console.log('\n[Audio] standalone audio-file input');
  nextOpenFile = mp3;
  let r = await js(win, `
    document.getElementById('vmxAddInput').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.querySelector('.vmx-is-cat[data-cat="audiofile"]').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.getElementById('vmxIsBrowse').click();
    await new Promise((r2) => setTimeout(r2, 300));
    const okDisabled = document.getElementById('vmxIsOk').disabled;
    document.getElementById('vmxIsOk').click();
    await new Promise((r2) => setTimeout(r2, 400));
    const s = ${T}.state();
    return { n: s.inputs.length, type: s.inputs[0] && s.inputs[0].type, name: s.inputs[0] && s.inputs[0].name, okDisabled };
  `);
  if (r.__error) console.error(r.__error);
  log(r.n === 1 && r.type === 'audio', 'Audio file added as a non-visual input', JSON.stringify(r));
  log(r.okDisabled === false, 'OK enables once a file is picked');

  /* ================================ List ================================= */
  console.log('\n[List] mixed video + image playlist');
  nextOpenFile = [vid1, img1]; // multi-select stub returns an array
  r = await js(win, `
    document.getElementById('vmxAddInput').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.querySelector('.vmx-is-cat[data-cat="list"]').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.getElementById('vmxIsBrowse').click();
    await new Promise((r2) => setTimeout(r2, 300));
    document.getElementById('vmxIsListSec').value = '1';
    document.getElementById('vmxIsListSec').dispatchEvent(new Event('input'));
    document.getElementById('vmxIsOk').click();
    await new Promise((r2) => setTimeout(r2, 500));
    const s = ${T}.state();
    return { n: s.inputs.length, type: s.inputs[1] && s.inputs[1].type };
  `);
  if (r.__error) console.error(r.__error);
  log(r.n === 2 && r.type === 'list', 'List input created from 2 picked files', JSON.stringify(r));
  r = await js(win, `
    ${T}.setPreview(${T}.state().inputs[1].id); ${T}.cut();
    await new Promise((r2) => setTimeout(r2, 800));
    ${T}.drawNow();
    const first = ${T}.pgmPixel(640, 360);
    const listInputId = ${T}.state().inputs[1].id;
    // sample every 400ms — a full video(2s)+image(1s) loop cycle takes ~3s, so
    // this window will catch the IMG element at listIdx 1 at least once
    const trace = [];
    for (let i = 0; i < 6; i++) {
      await new Promise((r2) => setTimeout(r2, 400));
      const s = ${T}.state();
      const inp = s.inputs.find((x) => x.id === listInputId);
      trace.push({ elTag: inp.elTag, listIdx: inp.listIdx });
    }
    return { first, trace };
  `);
  if (r.__error) console.error(r.__error);
  log(r.first[0] > 200 && r.first[1] < 60, 'List starts on the video item (red)', 'rgb=' + r.first.slice(0, 3));
  log(r.trace.some((t) => t.elTag === 'VIDEO' && t.listIdx === 0), 'List item 1 (video) confirmed playing', JSON.stringify(r.trace));
  log(r.trace.some((t) => t.elTag === 'IMG' && t.listIdx === 1), 'List auto-advances to item 2 (image) when the video ends', JSON.stringify(r.trace));
  log(r.trace.some((t, i) => i > 0 && t.listIdx === 0 && r.trace[i - 1].listIdx === 1), 'List loops back to item 1 after the image\'s duration (loop default on)', JSON.stringify(r.trace));

  /* ======================= Image Sequence / Stinger ======================= */
  console.log('\n[Stinger] image-sequence slideshow');
  nextOpenFile = [img1, img2];
  r = await js(win, `
    document.getElementById('vmxAddInput').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.querySelector('.vmx-is-cat[data-cat="stinger"]').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.getElementById('vmxIsBrowse').click();
    await new Promise((r2) => setTimeout(r2, 300));
    document.getElementById('vmxIsListSec').value = '1';
    document.getElementById('vmxIsListSec').dispatchEvent(new Event('input'));
    document.getElementById('vmxIsOk').click();
    await new Promise((r2) => setTimeout(r2, 300));
    const s = ${T}.state();
    const inp = s.inputs[s.inputs.length - 1];
    ${T}.setPreview(inp.id); ${T}.cut();
    await new Promise((r2) => setTimeout(r2, 300));
    ${T}.drawNow();
    const first = ${T}.pgmPixel(160, 90);
    const trace = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((r2) => setTimeout(r2, 400));
      const st2 = ${T}.state();
      trace.push(st2.inputs.find((x) => x.id === inp.id).listIdx);
    }
    return { n: s.inputs.length, type: inp.type, first, trace };
  `);
  if (r.__error) console.error(r.__error);
  log(r.type === 'list', 'Image Sequence uses the same List engine', JSON.stringify({ n: r.n, type: r.type }));
  log(r.first[1] > 100 && r.first[0] < 60, 'slideshow starts on image 1 (green)', 'rgb=' + r.first.slice(0, 3));
  log(r.trace.includes(1), 'slideshow auto-advances to image 2 after its duration', JSON.stringify(r.trace));
  log(r.trace.some((idx, i) => i > 0 && idx === 0 && r.trace[i - 1] === 1), 'slideshow loops back to image 1', JSON.stringify(r.trace));

  /* =============================== Delay ================================= */
  console.log('\n[Delay] buffered copy of another input');
  r = await js(win, `
    const syn = ${T}.addSynthetic('Delay Source', 0); // fixed hue so colour is deterministic-ish
    const s0 = ${T}.state();
    document.getElementById('vmxAddInput').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.querySelector('.vmx-is-cat[data-cat="delay"]').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.getElementById('vmxIsDelaySrc').value = String(syn.id);
    document.getElementById('vmxIsDelaySrc').dispatchEvent(new Event('change'));
    document.getElementById('vmxIsDelaySec').value = '1';
    document.getElementById('vmxIsDelaySec').dispatchEvent(new Event('input'));
    document.getElementById('vmxIsOk').click();
    await new Promise((r2) => setTimeout(r2, 300));
    const s = ${T}.state();
    return { n: s.inputs.length, type: s.inputs[s.inputs.length - 1].type, synId: syn.id };
  `);
  if (r.__error) console.error(r.__error);
  log(r.type === 'delay', 'Video Delay input created', JSON.stringify(r));
  r = await js(win, `
    const s = ${T}.state();
    const delayInp = s.inputs[s.inputs.length - 1];
    ${T}.setPreview(delayInp.id); ${T}.cut();
    await new Promise((r2) => setTimeout(r2, 1800)); // let the delay buffer fill past 1s
    ${T}.drawNow();
    const delayed = ${T}.pgmPixel(640, 360);
    return { delayed };
  `);
  if (r.__error) console.error(r.__error);
  log(!!(r.delayed && (r.delayed[0] + r.delayed[1] + r.delayed[2]) > 30), 'Delay input renders real buffered picture (not black)', 'rgb=' + (r.delayed || []).slice(0, 3));

  /* ============================ Instant Replay ============================ */
  console.log('\n[Instant Replay] background buffer -> take as Video input');
  r = await js(win, `
    ${T}.closeAllInputs();
    const red = ${T}.addColor('ReplaySource', '#ff0000');
    ${T}.setPreview(red.id); ${T}.cut(); ${T}.drawNow();
    document.getElementById('vmxAddInput').click();
    await new Promise((r2) => setTimeout(r2, 400)); // selectCat('video') then user picks Instant Replay
    document.querySelector('.vmx-is-cat[data-cat="replay"]').click();
    await new Promise((r2) => setTimeout(r2, 1200));
    const armed = ${T}.state().recording !== undefined; // sanity: state() call didn't throw
    return { armed };
  `);
  if (r.__error) console.error(r.__error);
  await sleep(3000);
  r = await js(win, `
    const okDisabled = document.getElementById('vmxIsOk').disabled;
    document.getElementById('vmxIsOk').click();
    await new Promise((r2) => setTimeout(r2, 2500));
    const s = ${T}.state();
    const last = s.inputs[s.inputs.length - 1];
    return { okDisabled, n: s.inputs.length, name: last && last.name, path: last && last.type };
  `);
  if (r.__error) console.error(r.__error);
  log(r.okDisabled === false, 'Instant Replay OK enables once armed');
  log(r.name === 'Instant Replay' && r.path === 'video', 'Take Replay adds a real Video input named "Instant Replay"', JSON.stringify(r));
  {
    const s2 = await js(win, `return ${T}.state().inputs.find((i) => i.name === 'Instant Replay')`);
    // pull the actual file path via preset serialization (name/path are on the real input object, not exposed by state(); use serializePreset)
    const preset = await js(win, `return ${T}.serializePreset ? ${T}.serializePreset() : null`);
  }

  /* ============================== Stream / SRT ============================= */
  console.log('\n[Stream/SRT] network ingest via ffmpeg');
  r = await js(win, `
    document.getElementById('vmxAddInput').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.querySelector('.vmx-is-cat[data-cat="srt"]').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.getElementById('vmxIsSrtUrl').value = 'http://127.0.0.1:${httpPort}/clip.mp4';
    document.getElementById('vmxIsSrtUrl').dispatchEvent(new Event('input'));
    const okEnabled = !document.getElementById('vmxIsOk').disabled;
    document.getElementById('vmxIsOk').click();
    await new Promise((r2) => setTimeout(r2, 1800));
    const s = ${T}.state();
    const inp = s.inputs[s.inputs.length - 1];
    ${T}.setPreview(inp.id); ${T}.cut();
    await new Promise((r2) => setTimeout(r2, 600));
    ${T}.drawNow();
    const pix = ${T}.pgmPixel(640, 360);
    return { okEnabled, type: inp.type, pix };
  `);
  if (r.__error) console.error(r.__error);
  log(r.okEnabled, 'Stream/SRT OK enables once a URL is typed');
  log(r.type === 'stream', 'network stream added as its own input type');
  log(r.pix && r.pix[0] > 150 && r.pix[1] < 90, 'real decoded frames from the network source render on program (red clip)', 'rgb=' + (r.pix || []).slice(0, 3));

  /* =============================== Web Browser =============================== */
  console.log('\n[Web Browser] offscreen Chromium -> canvas input');
  r = await js(win, `
    document.getElementById('vmxAddInput').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.querySelector('.vmx-is-cat[data-cat="web"]').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.getElementById('vmxIsWebUrl').value = ${JSON.stringify('file:///' + webPage.replace(/\\/g, '/'))};
    document.getElementById('vmxIsWebUrl').dispatchEvent(new Event('input'));
    const okEnabled = !document.getElementById('vmxIsOk').disabled;
    document.getElementById('vmxIsOk').click();
    await new Promise((r2) => setTimeout(r2, 2500));
    const s = ${T}.state();
    const inp = s.inputs[s.inputs.length - 1];
    ${T}.setPreview(inp.id); ${T}.cut();
    await new Promise((r2) => setTimeout(r2, 500));
    ${T}.drawNow();
    const pix = ${T}.pgmPixel(640, 360);
    return { okEnabled, type: inp.type, pix };
  `);
  if (r.__error) console.error(r.__error);
  log(r.okEnabled, 'Web Browser OK enables once a valid URL is typed');
  log(r.type === 'web', 'browser source added as its own input type');
  log(r.pix && r.pix[0] > 200 && r.pix[1] > 100 && r.pix[1] < 160 && r.pix[2] < 40, 'real offscreen-rendered page content shows on program (orange test page)', 'rgb=' + (r.pix || []).slice(0, 3));

  /* ================================ Video Call ================================ */
  console.log('\n[Video Call] Jitsi-style room via the same browser engine');
  r = await js(win, `
    document.getElementById('vmxAddInput').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.querySelector('.vmx-is-cat[data-cat="call"]').click();
    await new Promise((r2) => setTimeout(r2, 200));
    const prefilled = document.getElementById('vmxIsCallUrl').value;
    document.getElementById('vmxIsCallUrl').value = ${JSON.stringify('file:///' + webPage.replace(/\\/g, '/'))};
    document.getElementById('vmxIsCallUrl').dispatchEvent(new Event('input'));
    document.getElementById('vmxIsCallCopy').click();
    await new Promise((r2) => setTimeout(r2, 300));
    document.getElementById('vmxIsOk').click();
    await new Promise((r2) => setTimeout(r2, 2000));
    const s = ${T}.state();
    const inp = s.inputs[s.inputs.length - 1];
    return { prefilled, type: inp.type };
  `);
  if (r.__error) console.error(r.__error);
  log(/^https:\/\/meet\.jit\.si\//.test(r.prefilled), 'Video Call prefills a real Jitsi Meet room link', r.prefilled);
  log(r.type === 'call', 'Video Call reuses the browser engine as its own input type', JSON.stringify(r));

  /* ================================ PowerPoint ================================= */
  console.log('\n[PowerPoint] LibreOffice convert -> paged PDF via the browser engine');
  r = await js(win, `
    document.getElementById('vmxAddInput').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.querySelector('.vmx-is-cat[data-cat="ppt"]').click();
    await new Promise((r2) => setTimeout(r2, 600));
    const available = !!document.querySelector('.vmx-is-content #vmxIsBrowse');
    return { available };
  `);
  if (r.__error) console.error(r.__error);
  log(r.available === true, 'PowerPoint detects the installed LibreOffice and shows Browse', JSON.stringify(r));
  nextOpenFile = pptxPath;
  r = await js(win, `
    document.getElementById('vmxIsBrowse').click();
    // poll for up to 80s — a cold LibreOffice profile can take a while to spin up
    for (let i = 0; i < 40; i++) {
      await new Promise((r2) => setTimeout(r2, 2000));
      if (!document.getElementById('vmxIsOk').disabled) break;
    }
    const okEnabled = !document.getElementById('vmxIsOk').disabled;
    const nBefore = ${T}.state().inputs.length;
    document.getElementById('vmxIsOk').click();
    await new Promise((r2) => setTimeout(r2, 2500));
    const modalHidden = document.getElementById('vmxModal').classList.contains('hidden');
    const s = ${T}.state();
    const inp = s.inputs[s.inputs.length - 1];
    ${T}.setPreview(inp.id); ${T}.cut();
    await new Promise((r2) => setTimeout(r2, 500));
    ${T}.drawNow();
    const pix = ${T}.pgmPixel(640, 360);
    return { okEnabled, type: inp.type, nBefore, nAfter: s.inputs.length, modalHidden };
  `);
  if (r.__error) console.error(r.__error);
  log(r.okEnabled, 'PowerPoint OK enables once LibreOffice finishes converting', JSON.stringify(r));
  log(r.type === 'ppt', 'PowerPoint input added, backed by the converted PDF', JSON.stringify(r));
  r = await js(win, `
    const s = ${T}.state();
    const inp = s.inputs[s.inputs.length - 1];
    const cell = document.querySelector('.vmx-input[data-id="' + inp.id + '"]');
    const hasSlideBtns = !!(cell && cell.querySelector('[data-act="pptnext"]') && cell.querySelector('[data-act="pptprev"]'));
    if (cell) cell.querySelector('[data-act="pptnext"]').click();
    await new Promise((r2) => setTimeout(r2, 500));
    return { hasSlideBtns };
  `);
  if (r.__error) console.error(r.__error);
  log(r.hasSlideBtns, 'PowerPoint input shows Slide ◀ / ▶ navigation buttons');

  /* ========================= DVD / Virtual Set stay honest ========================= */
  console.log('\n[Declined] DVD and Virtual Set remain clearly unavailable');
  r = await js(win, `
    document.getElementById('vmxAddInput').click();
    await new Promise((r2) => setTimeout(r2, 200));
    document.querySelector('.vmx-is-cat[data-cat="dvd"]').click();
    await new Promise((r2) => setTimeout(r2, 150));
    const dvdOk = document.getElementById('vmxIsOk').disabled;
    const dvdNote = document.querySelector('.vmx-is-empty-note') ? document.querySelector('.vmx-is-empty-note').textContent : '';
    document.querySelector('.vmx-is-cat[data-cat="vset"]').click();
    await new Promise((r2) => setTimeout(r2, 150));
    const vsetOk = document.getElementById('vmxIsOk').disabled;
    document.getElementById('vmxIsCancel').click();
    return { dvdOk, dvdNote, vsetOk };
  `);
  if (r.__error) console.error(r.__error);
  log(r.dvdOk === true, 'DVD stays disabled (no copy-protection circumvention)', r.dvdNote);
  log(r.vsetOk === true, 'Virtual Set stays disabled (out of scope for a 2D switcher)');

  httpServer.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n==================  INPUT SELECT NEW CATEGORIES ${failed ? 'FAILED' : 'PASSED'}  ==================`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
