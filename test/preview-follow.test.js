'use strict';
/*
 * THE PREVIEW FOLLOWS THE SPEAKER EXACTLY AS THE EXPORT WILL.
 *
 * "Follow the speaker is shocking — sometimes he is in the frame, sometimes it
 * is his shoulder." That was the preview: a quick live guess four times a
 * second, only while playing — paused or scrubbed, the frame stayed wherever
 * it last was — and never the camera path the export uses. Now a short's path
 * is worked out once by the export's own tracking (veditor.js camPath), the
 * preview draws it frame by frame, playing or paused, and the export reuses it.
 *
 * The speaker here is a known one walking left to right (the tracker's
 * detections are stood in for, so the test needs no footage of a person); the
 * camera path itself is the real buildKeyframes.
 *
 *   node test/preview-follow.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the preview follow was not tested.');
  process.exit(0);
}
const ROOT = path.join(__dirname, '..');
const ffmpeg = require('ffmpeg-static');
const PORT = 7389, CODE = 'follow-test-4417';
const WORK = path.join(os.tmpdir(), 'mw-preview-follow-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); ok ? pass++ : fail++; };
const post = (p, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data);
});
const up = async () => { for (let k = 0; k < 80; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; };

(async () => {
  const VID = path.join(MEDIA, 'Sermon.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=15:d=40', '-f', 'lavfi', '-i', 'sine=f=220:d=40',
    '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    if (!(await up())) throw new Error('server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Deji Ade', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'no page errors', e.message));
    let frameAsks = 0;
    page.on('request', (r) => { if (r.url().includes('/api/rpc') && /extractFrames/.test(r.postData() || '')) frameAsks++; });
    await page.goto(`http://127.0.0.1:${PORT}/#home`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath && window.FaceTrack, null, { timeout: 30000 });
    await page.evaluate(async (p) => { await window.VideoEditor.openPath(p); }, VID);
    await page.waitForFunction(() => { const p = document.getElementById('vePlayer'); return p && p.readyState >= 2; }, null, { timeout: 30000 });

    // the speaker walks from left (0.25) to right (0.75) over the short's 30 s
    const id = await page.evaluate(() => {
      window.FaceTrack.available = async () => true;
      window.FaceTrack.detectFrames = async (frames) => {
        const out = frames.map((f) => ({ t: f.t, cxNorm: 0.25 + 0.5 * Math.min(1, f.t / 30), cyNorm: 0.45, score: 0.9, src: 'face' }));
        out.subject = null; out.referee = null; return out;
      };
      window.api.reframe.whoIsSpeaking = async () => ({ ok: false, why: 'not asked in this test' });
      const T = window.VideoEditor.__test;
      T.applyClips([{ start: 4, end: 34, label: 'Walk' }]);
      const p = document.getElementById('vePlayer'); p.pause(); p.currentTime = 10;
      return T.segments().find((s) => s.end - s.start < 60).id;
    });

    let sawBadge = false, sawBusy = false, cam = null;
    for (let i = 0; i < 90 && !cam; i++) {
      await sleep(500);
      const st = await page.evaluate((id) => ({ badge: !!document.querySelector('.ve-cam-busy'), busy: window.VideoEditor.__test.camBusy(), cam: window.VideoEditor.__test.camOf(id) }), id);
      sawBadge = sawBadge || st.badge; sawBusy = sawBusy || st.busy; cam = st.cam;
    }
    check(!!cam && cam.n > 2, 'paused in a short, its camera path is worked out (the export\'s own tracking)', cam ? cam.n + ' keyframes' : 'none');
    check(!sawBadge, 'it is worked out quietly — no "Finding the speaker in this short…" over the picture', { sawBadge, sawBusy });

    // paused and scrubbed: the frame is where the speaker is, and where the export will put it
    const at = await page.evaluate(async (id) => {
      const T = window.VideoEditor.__test, p = document.getElementById('vePlayer');
      const kf = T.camOf(id).kf, W = p.videoWidth;
      const camX = (t) => { if (t <= kf[0].t) return kf[0].x; for (let i = 1; i < kf.length; i++) if (t <= kf[i].t) { const a = kf[i - 1], b = kf[i], r = (t - a.t) / Math.max(1e-6, b.t - a.t); return a.x + (b.x - a.x) * r; } return kf[kf.length - 1].x; };
      const out = [];
      for (const t of [6, 14, 22, 31]) {
        p.currentTime = t; await new Promise((r) => p.addEventListener('seeked', r, { once: true })); await new Promise((r) => setTimeout(r, 300));
        const c = T.cropNow();
        const ot = T.srcToOut(id, t);
        out.push({ t, ox: c.ox, export: Math.min(Math.max(camX(ot) / W, c.cw / 2), 1 - c.cw / 2), speaker: 0.25 + 0.5 * Math.min(1, (ot + 0.1) / 30) });
      }
      return out;
    }, id);
    const worstExport = Math.max(...at.map((x) => Math.abs(x.ox - x.export)));
    check(worstExport < 0.003, 'paused or scrubbed, the preview frames exactly what the export will', at.map((x) => `${x.t}s ${x.ox.toFixed(3)} vs ${x.export.toFixed(3)}`).join(' · '));
    check(at[3].ox - at[0].ox > 0.15, 'scrubbing along the short, the frame goes where the speaker walked', at.map((x) => x.ox.toFixed(3)).join(' → '));

    const before = frameAsks;
    const file = await page.evaluate(async (id) => { try { return await window.VideoEditor.__test.exportClip(id); } catch (e) { return 'ERR ' + e.message; } }, id);
    check(!!file && !/^ERR/.test(file) && fs.existsSync(file), 'the short exports', String(file).split('/').pop());
    check(frameAsks === before, 'the export reuses the path: no second tracking', `${frameAsks - before} frame requests`);
  } catch (e) {
    check(false, 'ran to the end', e.message);
  } finally {
    await browser.close().catch(() => {});
    srv.kill();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
