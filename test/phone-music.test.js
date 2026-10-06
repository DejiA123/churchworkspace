'use strict';
/*
 * THE MUSIC BED UNDER THE PHONE'S PREVIEW — in a real browser, on the real
 * Cloud Studio, the way an iPhone plays it. "When I add my own background
 * music it sounds terrible — choppy."
 *
 *   [A] the song is the phone's own: the library's preview copy, fetched once
 *       and played from memory — the export still mixes the original file
 *   [B] plain Play from the start: the song is not re-seeked (it used to be
 *       forced 0 → 0 on every play, which is a hole)
 *   [C] a video split into clips plays the song straight through — the export's
 *       clock — instead of restarting it at every cut
 *   [D] a removed pause: the picture hops over it, the song carries on
 *   [E] the picture stalls to buffer (mobile data): the song waits with it,
 *       never runs ahead, and is never yanked back
 *   [F] an iPhone ignores <audio>.volume: there the bed goes through a Web
 *       Audio gain wired by a tap and the slider moves it; where volume works
 *       (here, the desktop) no AudioContext is ever made
 *
 * Needs Playwright with Chromium (it is not one of the app's dependencies);
 * without it this says so and skips.
 *
 *   node test/phone-music.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the phone music bed was not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7610;
const CODE = 'music-test-5821';
const WORK = path.join(os.tmpdir(), 'mw-phone-music-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(data);
  });
}
async function waitUp() {
  for (let k = 0; k < 60; k++) {
    try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); }
  }
  return false;
}

(async () => {
  // a 40 s picture the browser can play (Chromium here has no H.264), with sound
  const VID = path.join(MEDIA, 'tl.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=40', '-f', 'lavfi', '-i', 'sine=f=220:d=40',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  // …and a heavy one, so a throttled phone connection has to stop and buffer
  const HEAVY = path.join(MEDIA, 'heavy.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=40', '-f', 'lavfi', '-i', 'sine=f=220:d=40',
    '-c:v', 'libvpx-vp9', '-b:v', '6M', '-minrate', '6M', '-maxrate', '6M', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', HEAVY]);
  // a 2-minute song, as a VBR mp3 (what most people's music is)
  const SONG = path.join(MEDIA, 'song.mp3');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:r=44100:d=120', '-ac', '2', '-c:a', 'libmp3lame', '-q:a', '5', SONG]);

  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');

    /*
     * `ios`: the volume a page writes does not stick and always reads 1 — which
     * is what an iPhone does, and a desktop Chromium does not. Every context
     * counts the AudioContexts the page makes.
     */
    const open = async ({ ios } = {}) => {
      const ctx = await browser.newContext({ ...devices['iPhone 13'] });
      await ctx.addInitScript(([t, ios]) => {
        try { localStorage.setItem('mw.cloud.token', t); } catch (e) {}
        window.__acMade = 0;
        const AC = window.AudioContext;
        window.AudioContext = function (...a) { window.__acMade++; return new AC(...a); };
        window.AudioContext.prototype = AC.prototype;
        if (ios) Object.defineProperty(HTMLMediaElement.prototype, 'volume', { configurable: true, get() { return 1; }, set(v) {} });
      }, [login.token, !!ios]);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
      await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
      await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
      await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
      await sleep(800);
      return { ctx, page };
    };
    /*
     * A real finger on the first of these that is on screen. The phone has its
     * own bar for Play ([data-ct]); the desk's button is the
     * fallback, so the test means the same thing however the layout moves.
     */
    const tapFirst = async (page, sels) => {
      for (const sel of sels) {
        const el = await page.$(sel);
        if (el && await el.isVisible()) { await el.tap(); return sel; }
      }
      throw new Error('none of these is on screen: ' + sels.join(', '));
    };
    const tapPlay = (page) => tapFirst(page, ['#cloudTouchBar [data-ct="play"]', '#vePlay']);
    // Split lives in the phone's ✂️ Edit tools, which press the studio's own button
    const split = (page) => page.evaluate(() => document.getElementById('veSplit').click());
    // choose the song the way a person does: the 🎵 My music panel, Use, Done
    const useSong = async (page, id) => {
      await page.evaluate(() => window.VideoEditor.__test.openLibrary('music'));
      await page.waitForSelector(`[data-musicuse="${id}"]`, { timeout: 10000 });
      await page.tap(`[data-musicuse="${id}"]`);
      await page.tap('#libDone');
      await sleep(300);
    };
    // every seek of the bed, and where the video was when it happened
    const instrument = (page) => page.evaluate(() => {
      const a = document.getElementById('veMusicAudio');
      if (a.__logged) return;
      a.__logged = true;
      window.__seeks = [];
      const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      Object.defineProperty(a, 'currentTime', { configurable: true, get() { return d.get.call(this); }, set(v) {
        window.__seeks.push({ vt: +document.getElementById('vePlayer').currentTime.toFixed(3), from: +d.get.call(this).toFixed(3), to: +(+v).toFixed(3), vmax: +(window.__vmax || 0).toFixed(3) });
        d.set.call(this, v);
      } });
    });
    const state = (page) => page.evaluate(() => {
      const p = document.getElementById('vePlayer'), a = document.getElementById('veMusicAudio');
      return { vt: p.currentTime, mt: a.currentTime, want: window.VideoEditor.__test.musicPosAt(p.currentTime), mPaused: a.paused, seeks: window.__seeks.slice() };
    });
    // play `secs` from `from`, after a real tap (the phone only plays sound from one)
    const playFor = async (page, from, secs) => {
      await page.evaluate((t) => { const p = document.getElementById('vePlayer'); p.pause(); p.currentTime = t; }, from);
      await sleep(500);
      await page.evaluate(() => { window.__seeks = []; });
      await tapPlay(page);
      await sleep(secs * 1000);
      const s = await state(page);
      await page.evaluate(() => document.getElementById('vePlayer').pause());
      return s;
    };

    const { page } = await open();
    const entry = await page.evaluate((p) => window.api.library.add('music', p), SONG);

    console.log('\n=== [A] the phone plays its own copy of the song ===');
    check(entry && /\.preview\.mp3$/.test(entry.preview || ''), 'the library made a preview copy of the song', entry && entry.preview);
    await useSong(page, entry.id);
    const ms = await page.evaluate(() => window.VideoEditor.__test.musicState());
    check(ms && ms.file === entry.file && /\.mp3$/.test(ms.file) && !/\.preview\./.test(ms.file), 'the export still mixes the ORIGINAL song', ms && path.basename(ms.file));
    check(ms && ms.preview === entry.preview, '…and the preview plays the preview copy', ms && ms.preview && path.basename(ms.preview));
    await page.waitForFunction(() => window.VideoEditor.__test.musicBlobReady(), null, { timeout: 15000 }).catch(() => {});
    check(await page.evaluate(() => window.VideoEditor.__test.musicBlobReady()), 'the phone fetched the song once and keeps it in memory');
    await instrument(page);

    console.log('\n=== [B] plain Play from the start ===');
    let s = await playFor(page, 0, 3);
    check(s.seeks.filter((x) => Math.abs(x.to - x.from) < 0.12).length === 0, 'no pointless 0 → 0 seek of the song on Play', s.seeks);
    check(s.seeks.length <= 1, 'at most one seek of the song', s.seeks);
    check(!s.mPaused && Math.abs(s.mt - s.want) < 0.4, 'the song plays in step with the picture', { vt: s.vt, mt: s.mt, want: s.want });
    check(/^blob:/.test(await page.evaluate(() => document.getElementById('veMusicAudio').src)), 'and it plays from the phone\'s own copy (blob:)');

    console.log('\n=== [C] split into clips: the song plays straight through ===');
    for (const t of [2, 4, 6]) {
      await page.evaluate((t) => { document.getElementById('vePlayer').currentTime = t; }, t);
      await sleep(250);
      await split(page);
      await sleep(200);
    }
    const segs = await page.evaluate(() => window.VideoEditor.__test.segments().filter((x) => x.lane === 0).length);
    check(segs === 4, 'the video is now four clips', segs);
    s = await playFor(page, 0, 8);
    check(s.seeks.length <= 1, 'at most one seek of the song across three cuts (it used to restart at every one)', s.seeks);
    check(Math.abs(s.mt - s.vt) < 0.4 && Math.abs(s.mt - s.want) < 0.4, 'after 8 s the song is 8 s in, exactly where the export has it', { vt: s.vt, mt: s.mt, want: s.want });

    console.log('\n=== [D] a removed pause: the picture hops, the song carries on ===');
    const base = await page.evaluate(() => window.VideoEditor.__test.segments().filter((x) => x.lane === 0).sort((a, b) => a.start - b.start).map((x) => x.id));
    await page.evaluate((id) => window.VideoEditor.__test.setCuts(id, [{ start: 2.6, end: 3.6 }]), base[1]);
    const inCut = await page.evaluate(() => window.VideoEditor.__test.musicPosAt(3));
    check(inCut === null, 'inside the removed pause there is no music (it is not in the export)', inCut);
    s = await playFor(page, 1, 4);
    const jumps = s.seeks.filter((x) => Math.abs(x.to - x.from) > 0.12);
    check(jumps.length === 0, 'the song does not jump forward over the hop', s.seeks);
    check(Math.abs(s.mt - s.want) < 0.4 && s.vt - s.mt > 0.6, 'it is a pause-length behind the picture, as in the export', { vt: s.vt, mt: s.mt, want: s.want });

    console.log('\n=== [E] the picture stalls to buffer: the song waits ===');
    await page.evaluate((p) => window.VideoEditor.openPath(p), HEAVY);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    // parked at the start (as Play from 0:00 has it), so the only seeks left are the stall's
    await page.evaluate(() => { document.getElementById('vePlayer').currentTime = 0; });
    await sleep(2500);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 200, downloadThroughput: 250000, uploadThroughput: 250000 });
    await page.evaluate(() => {
      const p = document.getElementById('vePlayer'), a = document.getElementById('veMusicAudio');
      window.__seeks = []; window.__stall = { waits: 0, late: [], samples: [] };
      p.addEventListener('waiting', () => {
        window.__stall.waits++;
        setTimeout(() => { if (!a.paused && !(p.readyState >= 3 && !p.paused)) window.__stall.late.push(+p.currentTime.toFixed(2)); }, 150);
      });
      // how far the picture has got: a song following a picture that itself went
      // BACK (the browser re-buffering from earlier) is following, not yanked
      window.__vmax = 0;
      p.addEventListener('seeking', () => window.__stall.vseeks.push(+p.currentTime.toFixed(2)));
      window.__stall.vseeks = [];
      window.__stall.iv = setInterval(() => {
        window.__vmax = Math.max(window.__vmax, p.currentTime);
        const want = window.VideoEditor.__test.musicPosAt(p.currentTime);
        if (want != null && !a.paused) window.__stall.samples.push(+(a.currentTime - want).toFixed(3));
        (window.__stall.trace = window.__stall.trace || []).push([+(performance.now() / 1000).toFixed(2), +p.currentTime.toFixed(2), p.readyState, p.paused ? 'P' : 'p', a.paused ? 'MP' : 'mp', +a.currentTime.toFixed(2)].join(' '));
      }, 50);
    });
    await tapPlay(page);
    await sleep(20000);
    const st = await page.evaluate(() => { clearInterval(window.__stall.iv); document.getElementById('vePlayer').pause();
      return Object.assign({ vt: document.getElementById('vePlayer').currentTime, seeks: window.__seeks }, window.__stall); });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    if (process.env.TRACE) console.log(st.trace.join('\n'));
    check(st.waits > 0, 'the throttled picture really did stop to buffer', { waits: st.waits, vt: st.vt });
    check(st.late.length === 0, 'every time it stopped, the song stopped with it', st.late);
    const ahead = st.samples.length ? Math.max(...st.samples) : 0;
    check(ahead < 0.5, 'the song never ran ahead of the picture (it used to by up to 5.7 s)', `${ahead.toFixed(2)} s`);
    const back = st.seeks.filter((x) => x.from - x.to > 0.5 && x.vt > x.vmax - 0.2);
    check(back.length === 0, 'and was never yanked back', { seeks: st.seeks, videoSeeks: st.vseeks });

    console.log('\n=== [F] the bed\'s volume on an iPhone ===');
    check(await page.evaluate(() => window.__acMade) === 0, 'where <audio>.volume works, no AudioContext is ever made');
    check(await page.evaluate(() => Math.abs(document.getElementById('veMusicAudio').volume - 0.25) < 0.01), '…and the bed is simply at its 25%');
    const ios = await open({ ios: true });
    check(await ios.page.evaluate(() => window.__acMade) === 0, 'nothing is wired before a song is chosen and tapped');
    await useSong(ios.page, entry.id);
    await tapPlay(ios.page);
    await sleep(800);
    const g1 = await ios.page.evaluate(() => ({ made: window.__acMade, gain: window.VideoEditor.__test.musicGainValue() }));
    check(g1.made === 1 && g1.gain != null && Math.abs(g1.gain - 0.25) < 0.01, 'on the iPhone the tap wires a gain, and the bed plays at its 25%', g1);
    await ios.page.evaluate(() => window.VideoEditor.__test.setMusicVolume(0.6));
    const g2 = await ios.page.evaluate(() => window.VideoEditor.__test.musicGainValue());
    check(Math.abs(g2 - 0.6) < 0.01, 'the volume slider moves it', g2);
    await tapPlay(ios.page); await tapPlay(ios.page);
    check(await ios.page.evaluate(() => window.__acMade) === 1, 'later taps reuse the same one', await ios.page.evaluate(() => window.__acMade));
  } catch (e) {
    check(false, 'crashed: ' + (e.stack || e.message));
  } finally {
    await done();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
