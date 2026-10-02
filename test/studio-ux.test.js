'use strict';
/*
 * Video Studio usability round — every one of these is something the user hit:
 *
 *  1. Auto-reframe should already be ticked when the app opens.
 *  2. The preview should expand, and go full screen, to preview the export.
 *  3. Captions default to ALL CAPS.
 *  4. …in Bebas Neue.
 *  5. …with the Outline look.
 *  6. Zooming and trimming on the timeline must not lag.
 *  7. While the video plays, scrolling the timeline must not snap back.
 *  8. There must be a way to clear all captions.
 *
 *   npx electron test/studio-ux.test.js
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

const WORK = path.join(os.tmpdir(), 'mw-studio-ux');
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'ux-60s.mp4');

let failed = false;
function log(okv, name, d) {
  console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!okv) failed = true;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

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
// the real font list the app ships (see src/main/captioner.js FONTS)
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton', 'Bebas Neue', 'Poppins', 'Bangers']));
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
const js = (win, src) => win.webContents.executeJavaScript(`(() => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
// Same, but marked as a user gesture. requestFullscreen() is gated on transient
// activation, so a synthetic click alone can never open it — a real click in the
// app can, and this is how a test says "a real person pressed this".
const jsUser = (win, src) => win.webContents.executeJavaScript(`(() => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  if (!fs.existsSync(SRC)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-t', '60', '-i', 'testsrc2=s=1280x720:r=30',
      '-f', 'lavfi', '-t', '60', '-i', 'sine=frequency=440:sample_rate=44100',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
  }

  const errors = [];
  // VISIBLE on purpose: requestFullscreen is a no-op on a hidden window, and the
  // full-screen preview is one of the things being tested.
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
    return window.VideoEditor.__test.loadReal(${JSON.stringify(SRC)}).then(() => ({ dur: window.VideoEditor.__test.videoDuration() }));`);
  if (boot.__error) console.error('[boot] ' + boot.__error);
  log(near(boot.dur, 60, 0.6), 'a 60s video is loaded in the Video Studio', (boot.dur || 0).toFixed(1) + 's');

  /* ---------- [1] auto-reframe ON by default ------------------------------ */
  console.log('\n[1] 🎯 Auto-reframe is already ticked');
  const rf = await js(win, `
    // A fresh install has no remembered frame fill. The profile is shared with
    // every other suite, and one left on Blur turns auto-reframe off (it needs
    // a crop to follow), which would fail this for a reason no church can hit.
    window.VideoEditor.__test.forgetExportPrefs();
    const el = document.getElementById('veAutoReframe');
    return { checked: el.checked, markup: el.outerHTML.includes('checked'), reframeOn: window.VideoEditor.__test.capDefaults().reframe };`);
  if (rf.__error) console.error('[1] ' + rf.__error);
  log(rf.checked === true, 'the checkbox is ticked when the app opens');
  log(rf.markup === true, 'and it is ticked in the MARKUP, so a fresh install gets it too');
  log(rf.reframeOn === true, 'the exporter sees auto-reframe as ON');

  /* ---------- [3][4][5] caption defaults ---------------------------------- */
  console.log('\n[2] Caption defaults: ALL CAPS · Bebas Neue · Outline');
  const caps = await js(win, `
    const T = window.VideoEditor.__test;
    // a fresh install has nothing saved — that is what "by default" means
    const fresh = T.forgetCapStyle();
    const d = T.capDefaults();
    d.fresh = fresh; d.key = T.capStyleKey();
    return d;`);
  if (caps.__error) console.error('[2] ' + caps.__error);
  log(caps.case === 'upper', 'Case is ALL CAPS', caps.case);
  log(caps.font === 'Bebas Neue', 'Font is Bebas Neue', caps.font);
  log(caps.style === 'outline' && caps.fresh === 'outline', 'Style is Outline', caps.style);
  log(caps.key === 'mw-cap-style-v2',
    'the saved-style key was bumped, so an old stored look cannot override the new default', caps.key);

  const sticky = await js(win, `
    const T = window.VideoEditor.__test;
    T.pickCapStyle('neon');                          // the user chooses something else
    const picked = T.capDefaults().style;
    const stored = localStorage.getItem(T.capStyleKey());
    T.pickCapStyle('outline');                       // …and back
    return { picked, stored, back: T.capDefaults().style };`);
  if (sticky.__error) console.error('[2c] ' + sticky.__error);
  log(sticky.picked === 'neon' && sticky.stored === 'neon',
    'but a look you pick yourself is still remembered', `${sticky.picked} / stored=${sticky.stored}`);
  log(sticky.back === 'outline', 'and you can switch back to Outline');
  log(caps.cfg.font === 'Bebas Neue' && caps.cfg.style === 'outline' && caps.cfg.styleId === 'outline',
    'and that is what the BURNER is handed, not just what the dropdown shows',
    `font=${caps.cfg.font} style=${caps.cfg.style} outline=${caps.cfg.outline}`);
  log(caps.cfg.outline === '#000000', 'the outline is black — readable over any footage', caps.cfg.outline);

  // the case setting has to actually reach the words
  const cased = await js(win, `
    const T = window.VideoEditor.__test;
    T.setCapWords([
      { start: 0.5, end: 1.0, text: 'and' }, { start: 1.0, end: 1.5, text: 'he' }, { start: 1.5, end: 2.0, text: 'said' },
      { start: 2.2, end: 2.7, text: 'peace' }, { start: 2.7, end: 3.2, text: 'be' }, { start: 3.2, end: 3.9, text: 'still.' },
    ], 0);
    return { lines: (window.VideoEditor.__test.capLines ? T.capLines() : []), blocks: T.capTrackBlocks().map(b => b.text), count: T.capCount() };`);
  if (cased.__error) console.error('[2b] ' + cased.__error);
  const someText = (cased.blocks || []).join(' ');
  log(cased.count > 0, 'real word timings grouped into caption lines', cased.count + ' lines');
  log(someText.length > 0 && someText === someText.toUpperCase(),
    'every caption line comes out in CAPITALS', JSON.stringify(cased.blocks));

  /* ---------- [8] clear all captions -------------------------------------- */
  console.log('\n[3] 🧹 Clear captions');
  const clearUi = await js(win, `
    const T = window.VideoEditor.__test;
    return { visible: T.clearCapsBtnVisible(), before: T.capState() };`);
  log(clearUi.visible === true, 'the Clear captions button shows once there are captions');
  log(clearUi.before.events > 0, 'there are captions to clear', clearUi.before.events + ' lines');

  const cleared = await js(win, `
    const T = window.VideoEditor.__test;
    window.confirm = () => true;                    // the real button asks first
    T.clickClearCaps();
    return { after: T.capState(), btn: T.clearCapsBtnVisible(), label: T.capLaneLabel(), empty: T.capTrackEmptyShown(), saveBtn: T.capSaveBtnVisible() };`);
  if (cleared.__error) console.error('[3] ' + cleared.__error);
  log(cleared.after.events === 0 && cleared.after.words === 0 && cleared.after.target === null && cleared.after.mode === null,
    'every caption is gone — lines, word timings and the clip they belonged to',
    JSON.stringify(cleared.after));
  log(cleared.empty === true, 'the caption lane shows its empty hint again');
  log(cleared.btn === false && cleared.saveBtn === false, 'the Clear and Save buttons hide themselves again');
  log(/💬 Captions$/.test(cleared.label || ''), 'the lane label drops its count', cleared.label);

  const undone = await js(win, `
    const T = window.VideoEditor.__test;
    T.undo();
    const back = T.capState();
    T.redo();
    return { back, afterRedo: T.capState() };`);
  if (undone.__error) console.error('[3b] ' + undone.__error);
  log(undone.back.events > 0, 'Ctrl+Z brings every caption back (no re-transcribing)', undone.back.events + ' lines');
  log(undone.afterRedo.events === 0, 'and redo clears them again');

  // …but an UNRELATED undo must never wipe a transcript
  const unrelated = await js(win, `
    const T = window.VideoEditor.__test;
    T.undo();                                        // captions back
    const before = T.capCount();
    T.addClipAtPlayhead ? T.addClipAtPlayhead() : document.getElementById('veAddClip').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    T.undo();                                        // undo the CLIP, not the captions
    return { before, after: T.capCount() };`);
  if (unrelated.__error) console.error('[3c] ' + unrelated.__error);
  log(unrelated.after === unrelated.before && unrelated.before > 0,
    'undoing an unrelated edit leaves the captions alone',
    `${unrelated.before} lines before, ${unrelated.after} after`);

  const noCaps = await js(win, `
    const T = window.VideoEditor.__test;
    window.confirm = () => true;
    T.clickClearCaps();                              // clear them for the rest of the run
    let threw = null;
    try { T.clickClearCaps(); } catch (e) { threw = e.message; }   // clearing nothing
    return { threw, count: T.capCount() };`);
  log(noCaps.threw === null && noCaps.count === 0, 'clearing when there is nothing to clear is harmless', noCaps.threw || 'ok');

  /* ---------- [6] the timeline must not lag ------------------------------- */
  console.log('\n[4] Zooming and trimming stay smooth');
  const zoom = await js(win, `
    const T = window.VideoEditor.__test;
    T.split(20); T.split(40);                        // three clips to repaint
    T.setZoomPx(20);
    // 30 zoom steps back to back, the way a wheel actually fires
    const during = T.countRenders(() => { for (let i = 0; i < 30; i++) T.zoomStep(1.03); });
    const pending = T.renderPending();
    const onFlush = T.countRenders(() => T.flushRender());
    return { during, pending, onFlush, px: T.pxPerSec(), blocks: document.querySelectorAll('#veSegments .ve-seg').length };`);
  if (zoom.__error) console.error('[4] ' + zoom.__error);
  // Before this change each step rebuilt every lane AND the clip cards synchronously —
  // 30 steps meant 30 full rebuilds. Coalescing means a burst can never cost more
  // repaints than the screen can actually show.
  log(zoom.during === 0, '30 rapid zoom steps trigger ZERO synchronous rebuilds (was 30)', zoom.during + ' rebuilds');
  log(zoom.pending === true, 'they collapse into a single pending frame');
  log(zoom.onFlush === 1, 'which paints exactly once', zoom.onFlush + ' rebuild');
  log(zoom.blocks >= 3, 'and the clips are still drawn afterwards', zoom.blocks + ' blocks');

  const trim = await js(win, `
    const T = window.VideoEditor.__test;
    T.setZoomPx(20);
    const id = T.segIds()[0];
    const before = T.keptOf(id);
    // 40 mousemoves of a real right-edge trim (mousedown → moves → mouseup)
    const r = T.dragTrim(id, 'r', 40);
    T.flushRender();
    const after = T.keptOf(id);
    return { r, before: +before.end.toFixed(2), after: +after.end.toFixed(2), lists: document.querySelectorAll('#veClipList .ve-clip').length };`);
  if (trim.__error) console.error('[4b] ' + trim.__error);
  log(trim.r.moves === 0, 'the 40 mousemoves of a trim cost ZERO rebuilds (was 40)', trim.r.moves + ' rebuilds');
  log(trim.r.down <= 1 && trim.r.up <= 1,
    'one on mouse-down to select, one on mouse-up to put the other lanes back in step',
    `down=${trim.r.down} up=${trim.r.up}`);
  log(trim.after < trim.before, 'and the clip really was trimmed', `end ${trim.before}s → ${trim.after}s`);
  log(trim.lists >= 1, 'the clip cards are rebuilt once the drag ends', trim.lists + ' cards');

  const expand = await js(win, `
    const T = window.VideoEditor.__test;
    const id = T.segIds()[0];
    const before = T.keptOf(id);
    // …and dragging that shortened edge back OUT is just as smooth
    const r = T.dragTrim(id, 'r', 40, +1);
    T.flushRender();
    return { r, before: +before.end.toFixed(2), after: +T.keptOf(id).end.toFixed(2) };`);
  if (expand.__error) console.error('[4c] ' + expand.__error);
  log(expand.r.moves === 0, 'expanding a shortened clip back out is also free', expand.r.moves + ' rebuilds');
  log(expand.after > expand.before, 'and the clip really did grow back', `end ${expand.before}s → ${expand.after}s`);

  /* ---------- [7] scrolling while playing --------------------------------- */
  console.log('\n[5] Scrolling the timeline while the video plays');
  const follow = await js(win, `
    const T = window.VideoEditor.__test;
    T.fitHook();
    T.setZoomPx(40);                                  // zoomed in, so the timeline scrolls
    T.flushRender();
    T.setFollowHook(true);
    T.fakePlaying(true);
    T.seekAndRefresh(30);                             // playhead mid-video, view follows
    const followingAt = T.scrollLeft();
    const stillFollowing = T.followOn();
    // now the user drags the timeline somewhere else WHILE it plays
    T.userScroll(0);
    const followAfterScroll = T.followOn();
    const parked = T.scrollLeft();
    // the next playback frame must NOT drag the view back
    T.seekAndRefresh(31);
    const afterTick = T.scrollLeft();
    return { followingAt, stillFollowing, followAfterScroll, parked, afterTick, btnOn: document.getElementById('veFollow').classList.contains('on') };`);
  if (follow.__error) console.error('[5] ' + follow.__error);
  log(follow.stillFollowing === true && follow.followingAt > 0,
    'while playing, the view follows the playhead as before', 'scrollLeft=' + follow.followingAt);
  log(follow.followAfterScroll === false, 'scrolling the timeline yourself switches following OFF');
  log(follow.btnOn === false, 'and the 🎯 button shows it is off');
  log(follow.afterTick === follow.parked,
    'THE BUG: the next playback frame no longer yanks you back to the playhead',
    `stayed at ${follow.afterTick} (playhead is at ${follow.followingAt})`);

  const refollow = await js(win, `
    const T = window.VideoEditor.__test;
    document.getElementById('veFollow').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const on = T.followOn();
    T.seekAndRefresh(35);
    const moved = T.scrollLeft();
    T.fakePlaying(false);
    return { on, moved, btnOn: document.getElementById('veFollow').classList.contains('on') };`);
  if (refollow.__error) console.error('[5b] ' + refollow.__error);
  log(refollow.on === true && refollow.btnOn === true, 'clicking 🎯 starts following again');
  log(refollow.moved > 0, 'and the view catches up with the playhead', 'scrollLeft=' + refollow.moved);

  const replay = await js(win, `
    const T = window.VideoEditor.__test;
    T.setFollowHook(false);
    document.getElementById('vePlayer').dispatchEvent(new Event('play'));
    return T.followOn();`);
  log(replay === true, 'pressing play starts following again too (the common case)');

  /* ---------- [2] bigger preview + full screen ---------------------------- */
  console.log('\n[6] A bigger preview, and full screen');
  const big = await js(win, `
    const T = window.VideoEditor.__test;
    const before = { tl: T.timelineHeight(), pv: T.previewHeight(), big: T.previewBig() };
    T.setPreviewBigHook(true);
    const after = { tl: T.timelineHeight(), pv: T.previewHeight(), big: T.previewBig() };
    return { before, after, btnOn: document.getElementById('veBigger').classList.contains('on'), hasFull: T.fullBtnExists() };`);
  if (big.__error) console.error('[6] ' + big.__error);
  log(big.before.big === false && big.after.big === true, 'the ⤢ button turns the bigger preview on');
  log(big.after.pv > big.before.pv + 40,
    'the picture really does get bigger', `${Math.round(big.before.pv)}px → ${Math.round(big.after.pv)}px`);
  log(big.after.tl < big.before.tl,
    'the timeline gives up the height (it is still there, still editable)',
    `${Math.round(big.before.tl)}px → ${Math.round(big.after.tl)}px`);
  log(big.after.tl > 100, 'and the lanes are still usable, not collapsed', Math.round(big.after.tl) + 'px');
  log(big.btnOn === true, 'the button shows it is on');
  log(big.hasFull === true, 'there is a full-screen button and a way back out of it');

  const shrink = await js(win, `
    const T = window.VideoEditor.__test;
    T.setPreviewBigHook(false);
    return { tl: T.timelineHeight(), big: T.previewBig() };`);
  log(shrink.big === false && near(shrink.tl, big.before.tl, 2), 'clicking it again puts the timeline back',
    Math.round(shrink.tl) + 'px');

  // the crop matte must survive a resize — that's what makes the big preview honest
  const matte = await js(win, `
    const T = window.VideoEditor.__test;
    T.setPreviewBigHook(true);
    const bigRect = T.cropFrameRect();
    T.setPreviewBigHook(false);
    const smallRect = T.cropFrameRect();
    return { bigRect, smallRect, shadow: T.cropMatteBoxShadow() };`);
  if (matte.__error) console.error('[6b] ' + matte.__error);
  const arOf = (r) => (r && r.h ? r.w / r.h : 0);
  log(matte.bigRect.h > matte.smallRect.h,
    'the 9:16 export frame grows with the preview', `${matte.smallRect.w}x${matte.smallRect.h} → ${matte.bigRect.w}x${matte.bigRect.h}`);
  log(near(arOf(matte.bigRect), 9 / 16, 0.02) && near(arOf(matte.smallRect), 9 / 16, 0.02),
    'and it stays exactly 9:16 at both sizes — you are seeing the real export framing',
    `${arOf(matte.bigRect).toFixed(3)} vs ${(9 / 16).toFixed(3)}`);

  /* ---------- [2b] REAL full screen --------------------------------------- */
  console.log('\n[6b] ⛶ Full screen — the export framing, filling the display');
  let entered = false, left = false;
  win.on('enter-html-full-screen', () => { entered = true; });
  win.on('leave-html-full-screen', () => { left = true; });

  const beforeFs = await js(win, `
    const T = window.VideoEditor.__test;
    T.setPreviewBigHook(false);
    return { rect: T.cropFrameRect(), pv: T.previewHeight() };`);

  await jsUser(win, `document.getElementById('veFull').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;`);
  await sleep(1200);
  const inFs = await js(win, `
    const T = window.VideoEditor.__test;
    const el = document.fullscreenElement;
    return {
      isPreview: el === document.getElementById('veDrop'),
      rect: T.cropFrameRect(), pv: T.previewHeight(),
      exitVisible: getComputedStyle(document.getElementById('veFsExit')).display !== 'none',
      capOverlayInside: !!document.getElementById('veDrop').querySelector('#veCapOverlay'),
      textLayerInside: !!document.getElementById('veDrop').querySelector('#veTextLayer'),
      matte: T.cropMatteBoxShadow(),
    };`);
  if (inFs.__error) console.error('[6b] ' + inFs.__error);
  log(entered === true && inFs.isPreview === true, 'the ⛶ button really puts the PREVIEW into full screen');
  log(inFs.pv > beforeFs.pv * 1.8, 'the picture fills the display', `${Math.round(beforeFs.pv)}px → ${Math.round(inFs.pv)}px`);
  log(inFs.rect.h > beforeFs.rect.h * 1.8 && near(inFs.rect.w / inFs.rect.h, 9 / 16, 0.02),
    'the 9:16 export frame scales up with it and stays exactly 9:16',
    `${beforeFs.rect.w}x${beforeFs.rect.h} → ${inFs.rect.w}x${inFs.rect.h} (AR ${(inFs.rect.w / inFs.rect.h).toFixed(3)})`);
  log(/rgb\(0, 0, 0\)/.test(inFs.matte || ''), 'everything outside the export frame is still matted solid black', inFs.matte);
  log(inFs.capOverlayInside && inFs.textLayerInside,
    'captions and text overlays come along — this is the real export preview, not a bare video');
  log(inFs.exitVisible === true, 'and there is a visible way back out (no need to know about Esc)');

  await jsUser(win, `document.getElementById('veFsExit').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;`);
  await sleep(1200);
  const outFs = await js(win, `
    const T = window.VideoEditor.__test;
    return { el: document.fullscreenElement === null, rect: T.cropFrameRect(), pv: T.previewHeight() };`);
  log(left === true && outFs.el === true, 'the Exit button leaves full screen');
  log(near(outFs.rect.h, beforeFs.rect.h, 3) && near(outFs.pv, beforeFs.pv, 3),
    'and the preview goes back to exactly the size it was',
    `${outFs.rect.w}x${outFs.rect.h} vs ${beforeFs.rect.w}x${beforeFs.rect.h}`);

  /* ---------- console clean ---------------------------------------------- */
  console.log('\n[7] Console clean');
  log(errors.length === 0, 'no renderer errors during the whole run', errors.slice(0, 3).join(' | '));

  console.log('\n' + (failed ? '==============  studio-ux test FAILED  ==============' : '==============  studio-ux test PASSED  =============='));
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
