'use strict';
/*
 * WHO IS THE TRACKER FOLLOWING? — a look inside the identity layer.
 *
 * Runs the real pipeline (extractFrames -> FaceTrack.detectFrames ->
 * buildKeyframes) over one range of a real recording and reports, per identity
 * it found, the cues that decided the pick — then writes annotated frames with
 * every person boxed, the followed one in green, and the 9:16 window the export
 * would cut drawn on top. Statistics lie about this problem (see the notes in
 * the auto-reframe memory); the contact sheet does not.
 *
 *   node_modules/electron/dist/electron.exe test/diag-subject.js "<video>" <startSec> <durSec> [--lock=N] [--out=DIR]
 *
 * --lock=N re-runs with identity N (an id from the table) locked, which is
 * exactly what the studio's "Choose who to follow" does.
 */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/electron|diag-subject/i.test(path.basename(a)));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
const input = args[0];
const startSec = parseFloat(args[1] || '0');
const durSec = parseFloat(args[2] || '30');
const OUT = flags.out || path.join(os.tmpdir(), 'mw-subject-diag');
fs.mkdirSync(OUT, { recursive: true });

const AI_DIR = path.join(__dirname, '..', 'bin', 'ai');
protocol.registerSchemesAsPrivileged([{ scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.disableHardwareAcceleration();

function camAt(kf, t) {
  if (!kf.length) return 0;
  if (t <= kf[0].t) return kf[0].x;
  for (let i = 0; i < kf.length - 1; i++) {
    if (t < kf[i + 1].t) { const p = (t - kf[i].t) / (kf[i + 1].t - kf[i].t); return kf[i].x + (kf[i + 1].x - kf[i].x) * p; }
  }
  return kf[kf.length - 1].x;
}

process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + (e && e.stack || e)); process.exit(1); });

app.whenReady().then(async () => {
  protocol.handle('mwasset', async (request) => {
    try {
      const u = new URL(request.url);
      const rel = decodeURIComponent(u.hostname + u.pathname).replace(/^\/+/, '');
      const full = path.normalize(path.join(AI_DIR, rel));
      if (!full.startsWith(AI_DIR)) return new Response('forbidden', { status: 403 });
      const ext = path.extname(full).toLowerCase();
      const mime = ext === '.wasm' ? 'application/wasm' : (ext === '.mjs' || ext === '.js') ? 'text/javascript' : 'application/octet-stream';
      return new Response(await fs.promises.readFile(full), { headers: { 'content-type': mime } });
    } catch (e) { return new Response('err: ' + e.message, { status: 404 }); }
  });

  const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
  const csp = "default-src 'self'; img-src 'self' data: file: blob:; media-src 'self' file: blob: data:; script-src 'self' 'wasm-unsafe-eval' mwasset:; connect-src 'self' mwasset: file: data: blob:; worker-src 'self' blob:;";
  const tmpHtml = path.join(OUT, 'harness.html');
  fs.writeFileSync(tmpHtml, '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + csp + '"></head>'
    + '<body><script src="' + pathToFileURL(path.join(rendererDir, 'facetrack.js')).toString() + '"></script></body></html>');

  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log('  [page] ' + message); });
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 400));
  const ok = await win.webContents.executeJavaScript('window.FaceTrack.available()');
  if (!ok) { console.log('tracker unavailable'); process.exit(1); }

  const info = await video.getInfo(ctx, input);
  console.log('\n' + path.basename(input) + '  ' + info.width + 'x' + info.height + '   range ' + startSec + 's +' + durSec + 's');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-diag-frames-'));
  const t0 = Date.now();
  const frames = await video.extractFrames(ctx, { input, startSec, endSec: startSec + durSec, fps: 6, pairs: true, outDir: dir });
  const payload = frames.map((f) => ({ t: f.t, url: pathToFileURL(f.path).toString(), pairUrl: f.pairPath ? pathToFileURL(f.pairPath).toString() : null }));
  const cuts = frames.cuts || [];
  console.log('  ' + payload.length + ' frames, ' + cuts.length + ' scene events  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's extract)');

  const lockId = flags.lock != null ? parseInt(flags.lock, 10) : null;
  await win.webContents.executeJavaScript('window.__frames = ' + JSON.stringify(payload) + '; window.__cuts = ' + JSON.stringify(cuts) + '; 1');

  const run = async (lockSig) => win.webContents.executeJavaScript('(async () => {'
    + 'const t0 = performance.now();'
    + 'const dets = await window.FaceTrack.detectFrames(window.__frames, { cuts: window.__cuts, debugRaw: true, signals: window.__signals || null, lock: ' + (lockSig ? 'window.__lock' : 'null') + ' });'
    + 'window.__signals = dets.signals;'
    + 'const ms = performance.now() - t0;'
    + 'const kf = window.FaceTrack.buildKeyframes(dets, ' + info.width + ', ' + info.height + ', { targetAR: 9/16, cuts: window.__cuts });'
    + 'return { ms, subject: dets.subject, kf, dets: dets.map((d) => ({ t: d.t, cx: d.cxNorm, src: d.subject ? "subject" : d.src,'
    + '  people: (d.people || []).map((p) => ({ cx: p.cx, cy: p.cy, bw: p.bw, bh: p.bh, cid: p.cid, src: p.src, talk: p.talk == null ? null : +p.talk.toFixed(2) })) })) };'
    + '})()');

  let res = await run(null);
  const report = (S, n) => {
    if (!S) { console.log('  NO identity layer result (nobody found)'); return; }
    console.log('\n  followed person #' + S.id + '  (' + S.why + ') — found in ' + S.frames + '/' + n + ' frames\n');
    console.log('    id  seen%  shots%  size    cx  (p10-p90)  talk  face |  talk cover shot size ctr face =  SCORE');
    for (const p of S.people.slice().sort((a, b) => b.score - a.score)) {
      const q = p.parts;
      console.log('   ' + (p.id === S.id ? '*' : ' ') + String(p.id).padStart(2)
        + (p.cover * 100).toFixed(0).padStart(6) + (p.shots * 100).toFixed(0).padStart(7)
        + '  ' + p.size.toFixed(3) + '  ' + p.cx.toFixed(2)
        + '  (' + p.cxLo.toFixed(2) + '-' + p.cxHi.toFixed(2) + ')'
        + '  ' + (p.talk == null ? ' n/a' : p.talk.toFixed(2))
        + '  ' + (p.facing == null ? ' n/a' : p.facing.toFixed(2))
        + ' |  ' + q.talk.toFixed(2) + ' ' + q.cover.toFixed(2) + '  ' + q.shots.toFixed(2)
        + ' ' + q.size.toFixed(2) + ' ' + q.centre.toFixed(2) + ' ' + (q.facing == null ? ' n/a' : q.facing.toFixed(2))
        + ' =  ' + p.score.toFixed(3));
    }
  };
  console.log('  detection ' + (res.ms / 1000).toFixed(1) + 's  (' + (res.ms / payload.length).toFixed(0) + 'ms/frame)');
  {
    const withPpl = res.dets.filter((d) => d.people && d.people.length).length;
    const tot = res.dets.reduce((n, d) => n + ((d.people && d.people.length) || 0), 0);
    console.log('  people found in ' + withPpl + '/' + res.dets.length + ' frames, '
      + (tot / Math.max(1, res.dets.length)).toFixed(2) + ' per frame');
    const bySrc = {};
    for (const d of res.dets) for (const pp of (d.people || [])) bySrc[pp.src] = (bySrc[pp.src] || 0) + 1;
    console.log('  found as: ' + Object.entries(bySrc).map(([k, v]) => k + ' ' + v).join(', '));
  }
  report(res.subject, payload.length);

  // ---- how separable are these people, really? --------------------------
  // Everything downstream rests on "two pictures of the same person score
  // higher than two pictures of two people". Ground truth without labelling
  // anything by hand: two people in the SAME FRAME are certainly different, and
  // one person followed from frame to frame inside one shot (small step, same
  // size) is certainly themselves. Both are exact; no eyeballing required.
  if ('sep' in flags) {
    const sep = await win.webContents.executeJavaScript('(() => {'
      + 'const FT = window.FaceTrack, S = window.__signals || [];'
      + 'const shots = ' + JSON.stringify(cuts.map((c) => c.t)) + ';'
      + 'const cutBetween = (a, b) => shots.some((c) => c > Math.min(a,b) && c <= Math.max(a,b));'
      + 'const diff = [], same1 = [], same30 = [];'
      + 'for (const f of S) { const ps = (f.people || []).filter((p) => p.sig);'
      + '  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) diff.push(FT.sigSim(ps[i].sig, ps[j].sig)); }'
      // link one person forward through a shot
      + 'const chains = [];'
      + 'let live = [];'
      + 'for (let k = 0; k < S.length; k++) { const f = S[k];'
      + '  const brk = k > 0 && cutBetween(S[k-1].t, f.t);'
      + '  if (brk) live = [];'
      + '  const ps = (f.people || []).filter((p) => p.sig);'
      + '  const next = [];'
      + '  for (const p of ps) {'
      + '    let best = null, bd = 0.045;'
      + '    for (const L of live) { const d = Math.hypot(L.cx - p.cx, L.cy - p.cy); if (d < bd && Math.abs(Math.log((L.bw+1e-6)/(p.bw+1e-6))) < 0.3) { bd = d; best = L; } }'
      + '    if (best) { best.hist.push({ k, sig: p.sig }); next.push({ cx: p.cx, cy: p.cy, bw: p.bw, hist: best.hist }); }'
      + '    else { const h = [{ k, sig: p.sig }]; chains.push(h); next.push({ cx: p.cx, cy: p.cy, bw: p.bw, hist: h }); }'
      + '  }'
      + '  live = next;'
      + '}'
      + 'for (const h of chains) { if (h.length < 2) continue;'
      + '  for (let i = 0; i < h.length; i++) { for (let j = i + 1; j < h.length; j++) {'
      + '    const gap = h[j].k - h[i].k;'
      + '    if (gap === 1) same1.push(FT.sigSim(h[i].sig, h[j].sig));'
      + '    else if (gap >= 25 && gap <= 40) same30.push(FT.sigSim(h[i].sig, h[j].sig));'
      + '  } } }'
      + 'const stats = (xs) => { if (!xs.length) return null; xs.sort((a,b)=>a-b); return { n: xs.length, p10: xs[Math.floor(xs.length*0.1)], med: xs[xs.length>>1], p90: xs[Math.floor(xs.length*0.9)] }; };'
      + 'return { diff: stats(diff), same1: stats(same1), same30: stats(same30), chains: chains.length };'
      + '})()');
    console.log('');
    console.log('  appearance separation (exact ground truth, ' + sep.chains + ' within-shot chains)');
    const row = (name, v) => console.log('    ' + name.padEnd(30) + (v ? 'n=' + String(v.n).padStart(5) + '   p10 ' + v.p10.toFixed(3) + '   med ' + v.med.toFixed(3) + '   p90 ' + v.p90.toFixed(3) : '-'));
    row('SAME person, next frame', sep.same1);
    row('SAME person, ~5s later', sep.same30);
    row('DIFFERENT people, same frame', sep.diff);
    if (sep.same30 && sep.diff) {
      console.log('    -> a threshold works only if SAME p10 (' + sep.same30.p10.toFixed(3)
        + ') is clear of DIFFERENT p90 (' + sep.diff.p90.toFixed(3) + ')');
    }
  }

  if (lockId != null && res.subject) {
    const who = res.subject.people.find((p) => p.id === lockId);
    if (!who || !who.sig) console.log('\n  (no identity #' + lockId + ' to lock onto)');
    else {
      console.log('\n  --- re-running with person #' + lockId + ' LOCKED (what the picker does) ---');
      await win.webContents.executeJavaScript('window.__lock = window.FaceTrack.unpackSig(' + JSON.stringify(who.sig) + '); 1');
      res = await run(true);
      report(res.subject, payload.length);
      // Coverage on its own cannot say WHY a frame was missed. Compare the
      // locked signature against everybody in every frame: if the best match is
      // usually high, a threshold is throwing them away; if it is usually low,
      // the person genuinely is not being detected there.
      const fit = await win.webContents.executeJavaScript('(() => {'
        + 'const FT = window.FaceTrack, S = window.__signals || [], L = window.__lock;'
        + 'const best = [], none = [];'
        + 'for (const f of S) { let m = -1;'
        + '  for (const p of (f.people || [])) if (p.sig) m = Math.max(m, FT.sigSim(p.sig, L));'
        + '  if (m < 0) none.push(1); else best.push(m); }'
        + 'best.sort((a, b) => a - b);'
        + 'const q = (x) => best.length ? best[Math.min(best.length - 1, Math.floor(x * best.length))] : 0;'
        + 'return { noPeople: none.length, n: best.length, p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9) };'
        + '})()');
      console.log('');
      console.log('  how well the locked look fits the best person in each frame');
      console.log('    frames with nobody at all: ' + fit.noPeople);
      console.log('    best match  p10 ' + fit.p10.toFixed(3) + '  p25 ' + fit.p25.toFixed(3)
        + '  p50 ' + fit.p50.toFixed(3) + '  p75 ' + fit.p75.toFixed(3) + '  p90 ' + fit.p90.toFixed(3));
    }
  }

  // ---- WHO is each identity? ---------------------------------------------
  // The table is meaningless until you can see the people it is describing, and
  // guessing from an x-coordinate is exactly how you convince yourself the
  // tracker is following the preacher when it is following his crozier-bearer.
  // One cut-out per identity, from a frame where that identity was found.
  {
    const ids = (res.subject && res.subject.people ? res.subject.people : []).map((x) => x.id);
    const shots2 = [];
    for (const id of ids) {
      let at = -1, box = null;
      for (let i = 0; i < res.dets.length; i++) {
        const hit = (res.dets[i].people || []).find((pp) => pp.cid === id);
        if (hit) { at = i; box = hit; break; }
      }
      if (at < 0) continue;
      shots2.push({ id, at, box });
    }
    for (const sh of shots2) {
      const jpg = await win.webContents.executeJavaScript('(async () => {'
        + 'const img = await new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = ' + JSON.stringify(payload[sh.at].url) + '; });'
        + 'const b = ' + JSON.stringify(sh.box) + ';'
        + 'const W = img.naturalWidth, H = img.naturalHeight;'
        + 'const sx = Math.max(0, (b.cx - b.bw * 1.1) * W), sy = Math.max(0, (b.cy - b.bh * 0.9) * H);'
        + 'const sw = Math.min(W - sx, b.bw * 2.2 * W), sh2 = Math.min(H - sy, b.bh * 3.4 * H);'
        + 'const c = document.createElement("canvas"); c.width = 110; c.height = 150;'
        + 'const x = c.getContext("2d"); x.fillStyle = "#000"; x.fillRect(0, 0, 110, 150);'
        + 'x.drawImage(img, sx, sy, Math.max(2, sw), Math.max(2, sh2), 0, 0, 110, 150);'
        + 'x.fillStyle = "#ffe066"; x.font = "bold 18px sans-serif"; x.fillText("#" + ' + sh.id + ', 4, 20);'
        + 'return c.toDataURL("image/jpeg", 0.85);'
        + '})()');
      fs.writeFileSync(path.join(OUT, 'who_' + String(sh.id).padStart(2, '0') + '.jpg'), Buffer.from(jpg.split(',')[1], 'base64'));
    }
    if (shots2.length) {
      const strip = path.join(OUT, 'who' + (lockId != null ? '-lock' + lockId : '') + '.jpg');
      await new Promise((r) => require('child_process').execFile(ffmpeg,
        ['-v', 'error', '-pattern_type', 'glob', '-i', path.join(OUT, 'who_*.jpg'), '-vf', 'tile=' + shots2.length + 'x1', '-frames:v', '1', '-y', strip], () => r()));
      console.log('  who is who: ' + strip);
    }
  }

  // ---- annotated contact sheet -------------------------------------------
  const sheetDir = path.join(OUT, 'sheet');
  fs.rmSync(sheetDir, { recursive: true, force: true });
  fs.mkdirSync(sheetDir, { recursive: true });
  const every = Math.max(1, Math.round(payload.length / 32));
  const picks = payload.map((f, i) => i).filter((i) => i % every === 0).slice(0, 32);
  const cropW = (info.height * (9 / 16)) / info.width;   // crop width, as a fraction of the source
  for (const [n, i] of picks.entries()) {
    const camX = camAt(res.kf, res.dets[i].t) / info.width;
    const d = res.dets[i];
    const jpg = await win.webContents.executeJavaScript('(async () => {'
      + 'const img = await new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = ' + JSON.stringify(payload[i].url) + '; });'
      + 'const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;'
      + 'const x = c.getContext("2d"); x.drawImage(img, 0, 0);'
      + 'const people = ' + JSON.stringify(d.people) + ', subjCx = ' + (d.cx == null ? 'null' : d.cx) + ';'
      + 'x.lineWidth = 2; x.font = "13px sans-serif";'
      + 'for (const p of people) {'
      + '  const isSub = subjCx != null && Math.abs(p.cx - subjCx) < 0.03;'
      + '  x.strokeStyle = isSub ? "#22ff55" : "#ff4444";'
      + '  x.strokeRect((p.cx - p.bw/2) * c.width, (p.cy - p.bh/2) * c.height, p.bw * c.width, p.bh * c.height);'
      + '  x.fillStyle = isSub ? "#22ff55" : "#ff9999";'
      + '  x.fillText("#" + p.cid + (p.talk == null ? "" : " t" + p.talk), (p.cx - p.bw/2) * c.width, (p.cy - p.bh/2) * c.height - 3);'
      + '}'
      + 'x.strokeStyle = "#ffe066"; x.lineWidth = 3;'
      + 'x.strokeRect((' + camX + ' - ' + (cropW / 2) + ') * c.width, 1, ' + cropW + ' * c.width, c.height - 2);'
      + 'x.fillStyle = "#ffe066"; x.fillText("t=' + d.t.toFixed(1) + ' ' + (d.src || 'none') + '", 5, 15);'
      + 'return c.toDataURL("image/jpeg", 0.85);'
      + '})()');
    fs.writeFileSync(path.join(sheetDir, 'a_' + String(n).padStart(3, '0') + '.jpg'), Buffer.from(jpg.split(',')[1], 'base64'));
  }
  const sheet = path.join(OUT, 'sheet-' + Math.round(startSec) + (lockId != null ? '-lock' + lockId : '') + '.jpg');
  await new Promise((r) => require('child_process').execFile(ffmpeg,
    ['-v', 'error', '-i', path.join(sheetDir, 'a_%03d.jpg'), '-vf', 'scale=320:-1,tile=4x8', '-frames:v', '1', '-y', sheet], () => r()));
  console.log('\n  annotated sheet: ' + sheet + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
});
