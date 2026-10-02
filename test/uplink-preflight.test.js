'use strict';
/*
 * "BOTH STREAMS WERE ON 1080P, BOTH STREAMED PERFECTLY, THEN YOUTUBE BEGAN TO
 *  LAG WITH THE AUDIO SOUNDING WEIRD — FACEBOOK DIDN'T HAVE AN ISSUE AT ALL."
 *
 * Nothing was wrong with the encoding. Both destinations shared one encode and
 * were copied byte for byte; the line simply could not carry both. Measured on
 * the church laptop this was written against: **12.49 Mbps of upload against
 * 12.26 Mbps of demand** — 98% of the line, no headroom at all. TCP cannot
 * split a full line fairly between two platforms, so one keeps its picture and
 * the other starves, and which one starves is decided by routing. Facebook was
 * not healthier. It was first in the queue.
 *
 * The app already coped: it drops picture on the starving destination to keep
 * the preaching clean, and says so. Coping is not knowing. This is the part
 * that tells the operator BEFORE the service instead of after it:
 *
 *   [1] the arithmetic — does this Sunday fit down this line, and if not, what
 *       would? Including the trap that the obvious fix walks straight into;
 *   [2] the measurement, run against the real internet;
 *   [3] the studio: the check, the one-click fix, and the on-air banner that
 *       does not fade away while a service is still going wrong.
 *
 *   npm run test:uplink
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const uplink = require(path.join(ROOT, 'src/main/uplink'));
const { QUALITIES } = require(path.join(ROOT, 'src/main/livestream'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-uplink-'));
const ok = (d) => ({ ok: true, data: d });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, v, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };
const skip = (n, d) => console.log('  SKIP  ' + n + (d ? '  -> ' + d : ''));
const head = (s) => console.log('\n' + s);

const Q1080_6 = QUALITIES['H264 1080p 6mbps AAC 128kbps'];
const Q1080_3 = QUALITIES['H264 1080p 3mbps AAC 128kbps'];

/* ============ [1] the arithmetic, including the service that failed ======= */
head('[1] Does Sunday fit down the line?');

// The exact service from the photograph, on the line actually measured there.
let p = uplink.plan([Q1080_6, Q1080_6], 12.49, QUALITIES);
console.log('    ' + uplink.verdict(p));
check('two 1080p destinations are correctly costed', Math.abs(p.needMbps - 12.256) < 0.01, p.needMbps.toFixed(3) + ' Mbps');
check('THE SERVICE THAT FAILED IS REPORTED AS NOT FITTING — on the line it actually ran on',
  !p.fits, '12.49 Mbps measured vs ' + p.needMbps.toFixed(1) + ' Mbps needed');
check('and it says so BEFORE the service rather than diagnosing it after',
  /will not fit/.test(uplink.verdict(p)));
check('the words explain the confusing part — that one platform stays perfect',
  /one destination will lose its picture .* while the other looks perfect/.test(uplink.verdict(p)));
/* The PRESET NAME is quoted verbatim on purpose — it is what the operator has
 * to find in the dropdown, so "H264 1080p 3mbps AAC 128kbps" must survive. The
 * jargon rule applies to the sentence around it. */
const prose = uplink.verdict(p).replace(/“[^”]*”/g, 'THAT PRESET');
check('no jargon in the words around it', !/TCP|bitrate|throughput|codec|RTMP|encode/i.test(prose), prose.slice(0, 60) + '...');

// Headroom: a plan that exactly fills the pipe is a plan to shed.
const exact = uplink.plan([Q1080_6, Q1080_6], 12.26, QUALITIES);
check('a line that only just equals the demand is NOT called a fit', !exact.fits,
  'needs ' + exact.needMbps.toFixed(1) + ', usable ' + exact.usable.toFixed(1) + ' of 12.26');
check('and the headroom rule is a single named fraction', uplink.USABLE > 0.5 && uplink.USABLE < 0.85,
  Math.round(uplink.USABLE * 100) + '% of measured');
const roomy = uplink.plan([Q1080_6, Q1080_6], 25, QUALITIES);
check('a genuinely fat line is called a fit, with no false alarm', roomy.fits, uplink.verdict(roomy));

// The recommendation, and the trap it must not fall into.
check('it recommends a real preset the operator can actually pick',
  !!(p.recommend && QUALITIES[p.recommend.key]), p.recommend && p.recommend.key);
check('the recommendation genuinely fits the measured line',
  p.recommend.totalMbps <= p.usable, p.recommend.totalMbps.toFixed(1) + ' <= ' + p.usable.toFixed(1));
/*
 * A SMALLER PICTURE IS THE ANSWER, and this used to assert the opposite.
 *
 * "Keep the size they chose, just spend less on it" is the intuitive fix and it
 * is the one that produced the yellow banner on YouTube every service: 1080p
 * has a price, and a 1080p stream sent for less than that price is reported as
 * under-fed for the whole broadcast however healthy it looks here. The right
 * recommendation is the biggest picture this line can pay for IN FULL — the
 * size is kept only when the line can genuinely afford it.
 */
const streamrate = require(path.join(ROOT, 'src/main/streamrate'));
const recQ = p.recommend.quality;
const recSide = Math.min(recQ.width, recQ.height);
check('the recommendation is a picture this line can pay for at the platform’s own rate',
  (recQ.videoKbps || 0) >= streamrate.recommendedKbps(recQ.width, recQ.height, recQ.fps || 30),
  `${recQ.width}x${recQ.height} at ${recQ.videoKbps} kbps, platform wants `
  + streamrate.recommendedKbps(recQ.width, recQ.height, recQ.fps || 30));
check('and it is smaller than the 1080p they had, because this line cannot feed 1080p',
  recSide < 1080 && p.recommend.keepsSize === false, `${recQ.width}x${recQ.height}`);
{
  // …and on a line that CAN afford it, the size they chose is kept.
  const fat = uplink.plan([Q1080_6, Q1080_6], 40, QUALITIES, 30);
  check('a line with room keeps 1080p rather than shrinking it for no reason',
    fat.fits, fat.fits ? 'fits at 40 Mbps' : uplink.verdict(fat));
}
/*
 * The trap: lowering only the struggling destination is the obvious move and it
 * silently starts a SECOND live encode, which fails in a way indistinguishable
 * from bad internet. The recommendation must be one preset for all of them.
 */
const { reEncodedAmong } = require(path.join(ROOT, 'src/main/livestream'));
const rec = QUALITIES[p.recommend.key];
check('ONE preset for every destination, so nothing is re-encoded — the trap the obvious fix falls into',
  reEncodedAmong([rec, rec], 30).length === 0, 'both on ' + p.recommend.key);
/*
 * Lowering only the struggling destination used to start that second encode.
 * It cannot any more — a destination's bitrate is no longer a dial at all, so
 * two destinations of the same size are identical whatever presets they were
 * given (see platformKbps). What still splits them is a smaller PICTURE, which
 * is a real second encode and must still be reported.
 */
check('two destinations of the same size can no longer differ enough to be re-encoded',
  reEncodedAmong([Q1080_6, Q1080_3], 30).length === 0,
  'both are rated at what the platform charges for 1080p');
check('...whereas giving one a SMALLER PICTURE really would re-encode it',
  reEncodedAmong([Q1080_6, QUALITIES['H264 720p 2.5mbps AAC 128kbps']], 30).length > 0,
  'destination ' + (reEncodedAmong([Q1080_6, QUALITIES['H264 720p 2.5mbps AAC 128kbps']], 30)
    .map((i) => i + 1).join(',')) + ' would be re-encoded');

// One destination reads differently from two.
const single = uplink.plan([Q1080_6], 8, QUALITIES);
check('with one destination the wording is not about "the other one"',
  !/the other looks perfect/.test(uplink.verdict(single)) && /needs/.test(uplink.verdict(single)));
check('nothing configured yet is not an error', !uplink.plan([], 10, QUALITIES).count);

/* ======================= [3] the studio =============================== */
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', () => ok({}));
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
for (const ch of ['video:presets', 'scheduler:list', 'accounts:list', 'fonts:data', 'photos:list',
  'live:screenSources', 'bible:installed', 'bible:catalogue', 'bible:books']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:savePresentation', wrap((e, a) => (a || {}).presentation));
ipcMain.handle('present:savePlaylist', wrap((e, a) => (a || {}).playlist));
ipcMain.handle('present:saveThemes', wrap((e, a) => (a || {}).themes));
ipcMain.handle('live:destinations', () => ok({ qualities: [], groups: [], audio: [] }));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('phone:state', () => ok({ running: false }));
ipcMain.handle('bgvideo:installed', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('ndi:sources', () => ok([]));
ipcMain.handle('live:copyCheck', wrap(async (e, { qualities, fps } = {}) => {
  const qs = (qualities || []).map((q) => (typeof q === 'string' ? QUALITIES[q] : q)).filter(Boolean);
  return { reEncoded: reEncodedAmong(qs, fps), tolerance: 1.35 };
}));
/* The REAL handler's shape, with the measurement stubbed to a known line so the
 * studio's behaviour is tested rather than the weather. */
let FAKE_MBPS = 12.49;
ipcMain.handle('live:uplinkTest', wrap(async (e, { qualities } = {}) => {
  const qs = (qualities || []).map((q) => (typeof q === 'string' ? QUALITIES[q] : q)).filter(Boolean);
  const pl = uplink.plan(qs, FAKE_MBPS, QUALITIES);
  return Object.assign({ ok: true, mbps: FAKE_MBPS, host: 'test' }, pl, { verdict: uplink.verdict(pl) });
}));

app.disableHardwareAcceleration();

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) + '\\n' + (e && e.stack || '') }; } })()`);
}

app.whenReady().then(async () => {
  console.log('== WILL SUNDAY FIT DOWN THIS LINE? ==');

  head('[2] Measuring the real line');
  const t0 = Date.now();
  const meas = await uplink.measure();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!meas.ok) {
    skip('the real measurement', meas.error + ' (offline?)');
  } else {
    console.log(`    measured ${meas.mbps.toFixed(2)} Mbps up via ${meas.host} in ${secs}s `
      + `(samples ${meas.samples.map((s) => s.toFixed(1)).join(', ')})`);
    check('it measures a real upload speed off this machine', meas.mbps > 0.2, meas.mbps.toFixed(2) + ' Mbps');
    check('and does it quickly enough to run before a service', +secs < 60, secs + 's');
    const real = uplink.plan([Q1080_6, Q1080_6], meas.mbps, QUALITIES);
    console.log('    verdict on THIS connection: ' + uplink.verdict(real));
    check('it reaches a verdict about this actual connection', typeof real.fits === 'boolean',
      real.fits ? 'two 1080p streams would fit here' : 'two 1080p streams would NOT fit here');
  }

  head('[3] In the studio');
  const win = new BrowserWindow({ show: true, width: 1500, height: 940,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1600);
  const setup = await js(win, `
    document.querySelector('.nav-item[data-view="live"]').click();
    await new Promise(r => setTimeout(r, 600));
    return !!window.LiveStudio;`);
  if (setup && setup.__error) { console.error(setup.__error); app.exit(1); return; }

  // Two destinations, same 1080p preset — the exact configuration that failed.
  const dlg = await js(win, `
    const L = window.LiveStudio.__test;
    if (!L || !L.setStreams) return { missing: true };
    L.setStreams([
      { num: 1, dest: 'facebook', key: 'k1', quality: ${JSON.stringify('H264 1080p 6mbps AAC 128kbps')} },
      { num: 2, dest: 'youtube',  key: 'k2', quality: ${JSON.stringify('H264 1080p 6mbps AAC 128kbps')} },
    ]);
    L.openStreamSettings();
    await new Promise(r => setTimeout(r, 300));
    return { html: document.querySelector('.vmx-streamsettings') ? document.querySelector('.vmx-streamsettings').textContent : '' };`);
  if (dlg && dlg.missing) {
    skip('the studio half', 'live.js exposes no __test hooks for stream slots');
  } else if (dlg && dlg.__error) {
    console.error(dlg.__error); app.exit(1); return;
  } else {
    check('the dialog offers to check the upload before going live', /Check my upload speed/i.test(dlg.html || ''),
      /Check my upload speed/i.test(dlg.html || '') ? 'button present' : (dlg.html || '').slice(0, 90));
    const after = await js(win, `
      const b = document.getElementById('vmxSsUplink');
      if (!b) return { noBtn: true };
      b.click();
      for (let i = 0; i < 60 && !document.getElementById('vmxSsFit'); i++) await new Promise(r => setTimeout(r, 100));
      const box = document.querySelector('.vmx-streamsettings');
      return { text: box ? box.textContent : '', fit: !!document.getElementById('vmxSsFit') };`);
    check('pressing it reaches a verdict about this service', /Mbps/.test(after.text || ''),
      (after.text || '').match(/Your upload measured[^.]*\./) ? (after.text.match(/Your upload measured[^.]*\./) || [])[0] : 'no verdict');
    check('and offers the one-click fix when it does not fit', after.fit === true);
    const fitted = await js(win, `
      const b = document.getElementById('vmxSsFit');
      if (!b) return { noBtn: true };
      b.click();
      await new Promise(r => setTimeout(r, 300));
      return window.LiveStudio.__test.streamQualities();`);
    /* Asserted as a PROPERTY, not as a preset name: which preset fits depends
     * on the line this machine actually measured, and pinning the name here
     * made the check pass or fail on somebody else's broadband. */
    // The line the STUDIO measured, read back out of the sentence it showed the
    // operator — so the check is against the same number they were given.
    const shown = ((after.text || '').match(/Your upload measured ([\d.]+) Mbps/) || [])[1];
    const mbps = Number(shown) || 0;
    const fitsNow = Array.isArray(fitted) && fitted.length === 2 && fitted[0] === fitted[1]
      && mbps > 0 && uplink.plan(fitted.map((k) => QUALITIES[k]), mbps, QUALITIES, 30).fits;
    check('ONE CLICK PUTS EVERY DESTINATION ON A QUALITY THAT FITS', fitsNow,
      JSON.stringify(fitted) + ' against ' + mbps.toFixed(1) + ' Mbps measured');
    check('and they still match each other, so nothing is re-encoded',
      Array.isArray(fitted) && reEncodedAmong(fitted.map((k) => QUALITIES[k]), 30).length === 0);
  }

  // The banner that must not fade away.
  const banner = await js(win, `
    const L = window.LiveStudio.__test;
    if (!L || !L.fakeBandwidth) return { missing: true };
    L.fakeBandwidth({ destId: 'd2', shedding: true, reason: 'upload', message: 'is falling behind your upload speed.' });
    await new Promise(r => setTimeout(r, 200));
    const el = document.getElementById('vmxShedBanner');
    const shown = { there: !!el, text: el ? el.textContent : '' };
    await new Promise(r => setTimeout(r, 14000));            // longer than any toast
    const still = !!document.getElementById('vmxShedBanner');
    L.fakeBandwidth({ destId: 'd2', shedding: false, message: 'is keeping up again.' });
    await new Promise(r => setTimeout(r, 300));
    return Object.assign(shown, { stillThereAfter14s: still, goneWhenFixed: !document.getElementById('vmxShedBanner') });`);
  if (banner && banner.missing) {
    skip('the on-air banner', 'live.js exposes no __test hook for bandwidth events');
  } else if (banner && banner.__error) {
    console.error(banner.__error);
  } else {
    check('a destination losing picture raises a banner on the switcher', banner.there);
    check('it names the destination and says what to change', /Destination 2/.test(banner.text || '')
      && /upload cannot carry/i.test(banner.text || ''), (banner.text || '').slice(0, 80));
    check('IT IS STILL THERE FOURTEEN SECONDS LATER — a toast would have gone',
      banner.stillThereAfter14s);
    check('and it disappears the moment the destination recovers', banner.goneWhenFixed);
  }

  console.log(`\n  ${pass} PASS / ${fail} FAIL`);
  await sleep(200);
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
