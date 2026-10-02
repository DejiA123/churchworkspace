'use strict';
/*
 * "I cannot add images. I tested it, it doesn't work."
 *
 * The Presentation Studio has always HAD an image button, so the interesting
 * question is not whether the code path exists but whether a picture chosen by
 * an operator ends up on the projector. This drives the real UI — the real
 * buttons, the real file dialog (stubbed to return a real PNG on disk), the
 * real slide grid — and then reads the picture back out of the LIVE OUTPUT
 * element, which is the only place that settles it.
 *
 *   npx electron test/present-media.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'mw-present-media-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
/*
 * Its own Chromium profile, wiped every run.
 *
 * The studio remembers the operator's own media list and which sections of the
 * show desk they left open — in localStorage, which belongs to the profile, not
 * to the page. Sharing the default profile with every other test in the suite
 * meant one run's leftovers became the next run's starting state, and the whole
 * point here is to test what a church sees the first time they open it.
 */
app.setPath('userData', path.join(WORK, 'profile'));

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

/* A real PNG on disk — and one whose NAME has a space and an apostrophe in it,
 * because that is what a church's files are actually called and it is exactly
 * the kind of thing a URL builder gets wrong. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==',
  'base64');
const IMG = path.join(WORK, "Sunday's welcome slide.png");
fs.writeFileSync(IMG, PNG);
const VID = path.join(WORK, 'loop.mp4');
fs.writeFileSync(VID, Buffer.alloc(64));

let nextFile = IMG;
const ok = (data) => ({ ok: true, data });
ipcMain.handle('dialog:openFile', () => ok(nextFile));
ipcMain.handle('settings:get', () => ok({ present: {}, brand: {}, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, p) => ok(Object.assign({ live: {} }, p)));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('present:outputs', () => ok([]));
ipcMain.handle('present:openOutput', () => ok({ ok: true }));
ipcMain.handle('present:closeOutput', () => ok({ ok: true }));
ipcMain.handle('present:push', () => ok(true));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));
const mem = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('present:library', () => ok(mem));
ipcMain.handle('present:savePresentation', (e, { presentation }) => {
  const i = mem.presentations.findIndex((p) => p.id === presentation.id);
  if (i >= 0) mem.presentations[i] = presentation; else mem.presentations.unshift(presentation);
  return ok(presentation);
});
ipcMain.handle('present:deletePresentation', () => ok(true));
ipcMain.handle('present:savePlaylist', (e, { playlist }) => ok(playlist));
ipcMain.handle('present:saveTheme', (e, { theme }) => ok(theme));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  const js = (code) => win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) }; } })()`);

  await js(`document.querySelector('[data-view="present"]').click(); await new Promise(r => setTimeout(r, 500)); return 1;`);

  head('[A] Adding your own picture');
  const T = 'window.Presenter.__test';
  // Start from a clean, ordinary state: one presentation, one slide selected.
  await js(`${T}.newDoc('Welcome', 'song'); ${T}.addSlide(); ${T}.selectSlide(0); return 1;`);

  const added = await js(`return await ${T}.addMediaViaButton();`);
  check('the ＋ Add button puts the picture in the media list',
    added && added.count === 1 && /welcome/i.test(added.names[0] || ''), JSON.stringify(added));

  const tile = await js(`return ${T}.mediaTile(0);`);
  check('…and its thumbnail actually points at the file on disk',
    tile && /Sunday/.test(decodeURIComponent(tile.thumb || '')), tile && tile.thumb);

  head('[B] Putting it on the screen');
  const applied = await js(`return ${T}.clickMediaTile(0);`);
  check('clicking it puts it behind the selected slide',
    applied && applied.bg && applied.bg.type === 'image' && applied.bg.value === IMG,
    JSON.stringify(applied && applied.bg));
  const live = await js(`${T}.go(0); await new Promise(r=>setTimeout(r,150)); return ${T}.liveScreenBg();`);
  check('and the LIVE output really shows that picture',
    live && /Sunday/.test(decodeURIComponent(live)), live);

  head('[C] The failure that used to be silent');
  // No slide selected is an ordinary state — a fresh presentation, or after a
  // delete. Clicking a picture must never just do nothing.
  const noSlide = await js(`${T}.clearSlides(); ${T}.selectSlide(-1); return ${T}.clickMediaTile(0);`);
  check('with no slide to put it on, it says so instead of failing silently',
    noSlide && (noSlide.toast || noSlide.made), JSON.stringify(noSlide));

  head('[D] A picture as a slide of its own');
  await js(`${T}.newDoc('Notices', 'song'); return 1;`);
  const slideAdded = await js(`return await ${T}.addImageSlideViaButton();`);
  check('“Picture” makes the image its own full-screen slide',
    slideAdded && slideAdded.slides >= 1 && slideAdded.bg && slideAdded.bg.type === 'image',
    JSON.stringify(slideAdded));
  const liveImg = await js(`${T}.go(${T}.state().slideIx); await new Promise(r=>setTimeout(r,150)); return ${T}.liveScreenBg();`);
  check('…and that slide goes live as the picture, with no words over it',
    liveImg && /Sunday/.test(decodeURIComponent(liveImg)), liveImg);

  head('[E] Video too — same button, same result');
  await js(`window.__mwNextFile = 1; return 1;`);
  nextFile = VID;
  const vid = await js(`return await ${T}.addMediaViaButton();`);
  check('a video file lands in the same media list', vid && vid.count === 2, JSON.stringify(vid));
  nextFile = IMG;

  /* ====================================================================== */
  head('[G] "I added images but the slide is blank"');
  /*
   * The report: pictures added to the Presentation show as black slides. A
   * background that fails to load paints nothing and says nothing, so the only
   * way to tell "we asked for the wrong file" from "the file will not open" is
   * to actually try to load each one.
   *
   * The names below are the ones that break URL building in practice — a space,
   * an apostrophe, a hash, a percent sign, an ampersand, a non-English letter.
   * Church files are called all of these things.
   */
  const NASTY = [
    'plain.png',
    'Sunday service.png',
    "Pastor's slide.png",
    'notice #2.png',
    '100% free.png',
    'praise & worship.png',
    'Café Sunday.png',
    'Grüße.png',
  ];
  for (const n of NASTY) fs.writeFileSync(path.join(WORK, n), PNG);

  await js(`${T}.newDoc('Awkward names', 'song'); ${T}.clearSlides(); return 1;`);
  for (const n of NASTY) {
    nextFile = path.join(WORK, n);
    await js(`return await ${T}.addImageSlideViaButton();`);
  }
  nextFile = IMG;
  const probe = await js(`return await ${T}.slideBgProbe();`);
  const failed = (probe || []).filter((p) => p.loads === false);
  const missing = (probe || []).filter((p) => !p.url);
  check('every picture added as a slide really has a background set',
    probe && probe.length === NASTY.length && missing.length === 0,
    `${probe && probe.length} slides, ${missing.length} with no background`);
  check('…and every one of them actually loads — no silently black slides',
    failed.length === 0,
    failed.length ? failed.map((p) => path.basename(p.path || '') + ' → ' + p.url).join(' | ') : 'all load');

  /* ====================================================================== */
  head('[H] Your own picture behind the Bible verses');
  /*
   * "I must be able to use it as a Bible background." Scripture slides are made
   * later, from the Bible panel, and take the LOOK's background — so the test
   * is not "can I put a picture on a slide" but "does a verse I add AFTERWARDS
   * land on it".
   */
  nextFile = IMG;
  await js(`${T}.newDoc('Service', 'song'); ${T}.clearSlides(); ${T}.setBgApply('look'); return 1;`);
  const asLook = await js(`return ${T}.clickMediaTile(0);`);
  check('with "Bible & everything" chosen, a picture becomes the Look’s background',
    asLook && asLook.lookBg && asLook.lookBg.type === 'image',
    JSON.stringify(asLook && asLook.lookBg));
  const verseBg = await js(`
    ${T}.addSlide();                    // stands in for a verse added from the Bible panel
    ${T}.selectSlide(0);
    await new Promise(r => setTimeout(r, 60));
    const p = await ${T}.slideBgProbe();
    return p[0];
  `);
  check('…and a slide added afterwards really sits on that picture',
    verseBg && /Sunday/.test(decodeURIComponent(verseBg.url || '')) && verseBg.loads === true,
    JSON.stringify({ url: verseBg && verseBg.url, loads: verseBg && verseBg.loads }));
  await js(`${T}.setBgApply('slide'); return 1;`);

  /* ====================================================================== */
  head('[I] The LIVE monitor really PAINTS the picture');
  /*
   * "It just shows a black background in that live output preview."
   *
   * The monitor draws the same composite the projector draws, and that builds
   * `.lyr-img` layers whose sizing rule lives in layers.js — a stylesheet the
   * studio window never injected (output.html always did). The layer got the
   * right background-image and zero height, so the words appeared over black
   * while the thumbnail two inches away showed the photo. Asking the element
   * what its background is cannot catch that; only measuring it can.
   */
  nextFile = IMG;
  await js(`${T}.newDoc('Live check', 'song'); ${T}.clearSlides(); ${T}.setBgApply('slide'); return 1;`);
  await js(`${T}.addSlide(); ${T}.setSlideText(0, 'This is the day the LORD has made'); ${T}.selectSlide(0); return 1;`);
  await js(`return ${T}.clickMediaTile(0);`);
  const liveProbe = await js(`
    ${T}.go(0);
    await new Promise(r => setTimeout(r, 250));
    return await ${T}.liveScreenBgProbe();`);
  check('the live monitor has a background layer carrying the picture',
    liveProbe && liveProbe.stage === true && /Sunday/.test(decodeURIComponent(liveProbe.url || '')),
    JSON.stringify({ url: liveProbe && liveProbe.url }));
  check('…and that layer FILLS the monitor instead of being zero pixels high',
    liveProbe && liveProbe.covers === true && liveProbe.h > 0,
    liveProbe ? `${liveProbe.w}×${liveProbe.h} in a ${liveProbe.stageW}×${liveProbe.stageH} stage` : 'no probe');
  check('…and the file behind it really loads', liveProbe && liveProbe.loads === true, String(liveProbe && liveProbe.loads));

  head('[F] The panel is not a wall of buttons any more');
  const ui = await js(`return ${T}.showPaneShape();`);
  check('the Show panel groups its sections instead of stacking them all open',
    ui && ui.sections >= 8 && ui.open <= 3,
    `${ui && ui.sections} sections, ${ui && ui.open} open by default`);
  check('the everyday things are the ones that start open',
    ui && ui.openNames && ui.openNames.length && ui.openNames.every((n) => /prop|message|timer|audio/i.test(n)),
    JSON.stringify(ui && ui.openNames));
  const adv = await js(`return ${T}.setAdvanced(true);`);
  check('and the technical sections are one click away, not gone',
    adv && adv.visible > adv.simpleVisible, JSON.stringify(adv));

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
