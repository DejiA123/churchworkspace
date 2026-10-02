'use strict';
/*
 * THE PRO TIMELINE LAYOUT (v2.79) — "Video Studio: C · Pro timeline", driven
 * for real on a playable clip.
 *
 *  [A] the four columns are there, side by side, and nothing spills sideways
 *  [B] no SOURCE monitor (v2.80, the operator's call): the Program monitor
 *      takes its room — and dragging the picture there still frames the short
 *  [C] …whatever the short's shape
 *  [D] the inspector's tabs show one panel at a time and remember the last one
 *  [E] ✂ Blade cuts the clip exactly where it is clicked; V / C switch tools
 *  [F] J / K / L shuttle
 *  [G] the timeline handle resizes the timeline, and the monitors follow
 *  [H] line icons replaced the emoji — and every label kept its text
 *  [I] the lane names never resize their column, so the track never moves
 *      between pressing a trim handle and dragging it
 *
 *   npx electron test/pro-layout.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const captioner = require(path.join(ROOT, 'src/main/captioner'));
const WORK = path.join(os.tmpdir(), 'mw-prolayout-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));
const CLIP = path.join(WORK, 'wide40.mp4');
execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=40',
  '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=40',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', CLIP]);

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d !== undefined ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const ctx = () => ({ ffmpeg: require('ffmpeg-static'), ffprobe: require('ffprobe-static').path });

ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, p) => ok(p));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: captioner.fontsDir() }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
for (const ch of ['scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'bible:installed', 'bible:catalogue', 'present:outputs', 'live:screenSources', 'bgvideo:installed']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('captions:engineInfo', () => ok({ available: true }));
ipcMain.handle('captions:models', () => ok([{ id: 'small.en', name: 'Small — much more accurate', sizeMB: 466, installed: true, inUse: true }]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('video:info', wrap((e, { input }) => video.getInfo(ctx(), input)));
ipcMain.handle('video:thumbnail', wrap(async (e, { input, timeSec }) => { const o = path.join(WORK, 't-' + Date.now() + '.png'); await video.thumbnail(ctx(), { input, timeSec, output: o }); return o; }));
ipcMain.handle('video:filmstrip', wrap(async (e, { input, count }) => { const o = path.join(WORK, 's-' + Date.now() + '.png'); await video.filmstrip(ctx(), { input, count: count || 16, output: o }); return o; }));
ipcMain.handle('video:waveform', wrap(async (e, { input }) => { const o = path.join(WORK, 'w-' + Date.now() + '.png'); await video.waveform(ctx(), { input, output: o }); return o; }));
ipcMain.handle('fs:readImageDataUrl', wrap((e, { path: p }) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')));

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1700, height: 1000, show: true,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 3) console.log('    [renderer] ' + msg); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1400);
  const js = (code) => win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.stack || e) }; } })()`);
  const T = 'window.VideoEditor.__test';
  const R = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; })()`;
  await js(`document.querySelector('[data-view="video"]').click(); await new Promise(r => setTimeout(r, 400)); return 1;`);
  await js(`await ${T}.loadReal(${JSON.stringify(CLIP)}); return 1;`);
  for (let i = 0; i < 40; i++) { await sleep(300); if (await js(`const p = document.getElementById('vePlayer'); return !!(p && p.readyState >= 2);`)) break; }
  await js(`${T}.applyClips([{ start: 5, end: 25, label: 'Grace is free' }, { start: 27, end: 38, label: 'His mercy is new' }]); document.getElementById('vePlayer').currentTime = 9.5; return 1;`);
  await sleep(900);

  head('[A] Three columns, one screen');
  const L = await js(`return { bin: ${R('.ve-bin')}, src: ${R('#veSource')}, mon: ${R('#veMonitors')}, prog: ${R('.ve-left')}, insp: ${R('.ve-side')}, tl: ${R('#veTimeline')}, top: ${R('.ve-topbar')}, tlbar: ${R('.ve-tl-bar')},
    view: ${R('#view-video')}, sideways: document.getElementById('view-video').scrollWidth - document.getElementById('view-video').clientWidth };`);
  check('Shorts bin | Program | Inspector, left to right, side by side',
    L.bin && L.prog && L.insp && L.bin.r <= L.prog.x && L.prog.r <= L.insp.x && Math.abs(L.bin.y - L.insp.y) < 2,
    JSON.stringify({ bin: L.bin && Math.round(L.bin.x), prog: L.prog && Math.round(L.prog.x), insp: L.insp && Math.round(L.insp.x) }));
  check('…with the timeline across the bottom, under all three', L.tl.y >= L.bin.b && L.tl.x <= L.bin.x + 1 && L.tl.r >= L.insp.r - 1);
  check('the toolbar and the timeline bar are ONE line each', L.top.h <= 52 && L.tlbar.h <= 50, JSON.stringify({ top: L.top.h, tlbar: L.tlbar.h }));
  check('nothing spills sideways', L.sideways <= 0, L.sideways);

  head('[B] No source monitor — the Program monitor has the room');
  check('a 9:16 short of a 16:9 recording shows NO source monitor', !L.src || L.src.w === 0, JSON.stringify(L.src));
  check('…and the Program monitor fills the space between the bin and the inspector', L.prog.w >= L.mon.w - 2, JSON.stringify({ prog: L.prog.w, mon: L.mon.w }));
  // Framing by hand is still there: drag the picture on the program monitor.
  const before = await js(`return ${T}.framingNow ? ${T}.framingNow() : null;`);
  const drag = await js(`const f = document.getElementById('veCropFrame'); const r = f.getBoundingClientRect();
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2, dx = r.width * 0.3;
    f.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x0, clientY: y0, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x0 + dx, clientY: y0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x0 + dx, clientY: y0 }));
    await new Promise(r2 => setTimeout(r2, 150));
    return { reframe: document.getElementById('veAutoReframe').checked, framing: ${T}.framingNow ? ${T}.framingNow() : null };`);
  check('dragging the program picture takes the framing by hand (auto-reframe steps aside)', drag.reframe === false, JSON.stringify(drag));
  check('…and moves the crop (dragging the video right shows more of its LEFT)', drag.framing && before && drag.framing.offsetX < before.offsetX - 0.02,
    JSON.stringify({ before, after: drag.framing }));
  await js(`document.getElementById('veAutoReframe').checked = true; document.getElementById('veAutoReframe').dispatchEvent(new Event('change')); return 1;`);

  head('[C] …whatever the short\'s shape');
  const solo = await js(`const sel = document.getElementById('veAspect'); const wide = [...sel.options].find(o => /16:9|YouTube|Landscape/i.test(o.textContent));
    if (!wide) return { skipped: true };
    sel.value = wide.value; sel.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 400));
    const s = { wide: document.getElementById('veSource').getBoundingClientRect().width };
    sel.value = 'reel-9x16'; sel.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 400));
    s.tall = document.getElementById('veSource').getBoundingClientRect().width;
    return s;`);
  check('16:9 and 9:16 alike: still no source monitor', solo.skipped || (solo.wide === 0 && solo.tall === 0), JSON.stringify(solo));

  head('[D] The inspector');
  const tabs = await js(`const out = {};
    for (const t of ['reframe', 'audio', 'look', 'export', 'captions']) {
      document.querySelector('.ve-insp-tabs [data-insp="' + t + '"]').click();
      out[t] = [...document.querySelectorAll('.ve-insp-panel')].filter(p => !p.classList.contains('hidden')).map(p => p.dataset.panel);
    }
    document.querySelector('.ve-insp-tabs [data-insp="audio"]').click();
    out.saved = localStorage.getItem('mw-ve-insp');
    out.where = { fill: !!document.querySelector('.ve-insp-panel[data-panel="reframe"] #veFill'), denoise: !!document.querySelector('.ve-insp-panel[data-panel="audio"] #veDenoise'),
      quality: !!document.querySelector('.ve-insp-panel[data-panel="export"] #veQuality'), capModel: !!document.querySelector('.ve-insp-panel[data-panel="captions"] #veCapModel'),
      aspect: !!document.querySelector('.ve-left .ve-mon-head #veAspect') };
    out.tabsFit = [...document.querySelectorAll('.ve-insp-tabs button')].every(b => b.getBoundingClientRect().right <= document.querySelector('.ve-insp-tabs').getBoundingClientRect().right + 1);
    return out;`);
  check('each tab shows exactly its own panel', ['reframe', 'audio', 'look', 'export', 'captions'].every((t) => JSON.stringify(tabs[t]) === JSON.stringify([t])), JSON.stringify(tabs));
  check('…and the last one chosen is remembered', tabs.saved === 'audio', tabs.saved);
  check('every setting is where it belongs (format on the program monitor)', Object.values(tabs.where).every(Boolean), JSON.stringify(tabs.where));
  check('all five tabs fit across the inspector', tabs.tabsFit);

  head('[E] ✂ Blade');
  const blade = await js(`const before = ${T}.segments().length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    const on = document.getElementById('view-video').classList.contains('ve-blade');
    const seg = document.querySelector('#veSegments .ve-seg[data-id]');
    const tr = document.getElementById('veTrack').getBoundingClientRect();
    const px = ${T}.pxPerSecNow ? ${T}.pxPerSecNow() : null;
    const x = tr.left + 15 * px, r = seg.getBoundingClientRect();
    seg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: r.top + r.height / 2, button: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: r.top + r.height / 2 }));
    await new Promise(r2 => setTimeout(r2, 150));
    const segs = ${T}.segments().map(s => [s.start, s.end]).sort((a, b) => a[0] - b[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
    return { before, on, after: segs.length, segs, off: !document.getElementById('view-video').classList.contains('ve-blade') };`);
  check('C picks up the blade', blade.on === true);
  check('one click on a clip cuts it in two', blade.after === blade.before + 1, JSON.stringify(blade.segs));
  check('…exactly where it was clicked (15 s)', blade.segs.some((s) => Math.abs(s[1] - 15) < 0.1) && blade.segs.some((s) => Math.abs(s[0] - 15) < 0.1), JSON.stringify(blade.segs));
  check('V puts the blade down', blade.off === true);

  head('[F] J / K / L');
  const sh = await js(`const p = document.getElementById('vePlayer'); p.pause(); p.currentTime = 20; await new Promise(r => setTimeout(r, 300));
    const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('l'); await new Promise(r => setTimeout(r, 400)); const playing = !p.paused, r1 = p.playbackRate;
    key('l'); await new Promise(r => setTimeout(r, 150)); const r2 = p.playbackRate;
    key('k'); await new Promise(r => setTimeout(r, 150)); const stopped = p.paused, r3 = p.playbackRate;
    const t0 = p.currentTime; key('j'); const ts = [];
    for (let i = 0; i < 7; i++) { await new Promise(r => setTimeout(r, 100)); ts.push(+p.currentTime.toFixed(3)); }
    const t1 = p.currentTime;
    key('k'); await new Promise(r => setTimeout(r, 200));
    return { playing, r1, r2, stopped, r3, back: t0 - t1, ts };`);
  check('L plays, and L again plays faster', sh.playing && sh.r1 === 1 && sh.r2 === 1.5, JSON.stringify(sh));
  check('K stops, back at normal speed', sh.stopped && sh.r3 === 1);
  check('J rewinds', sh.back > 0.3, sh.back && sh.back.toFixed(2));

  head('[G] The timeline handle');
  const tl = await js(`localStorage.removeItem('mw-ve-tlh');
    const sp = document.getElementById('veTlSplit'), r = sp.getBoundingClientRect();
    const h0 = document.getElementById('veTimeline').getBoundingClientRect().height, m0 = document.getElementById('veMonitors').getBoundingClientRect().height;
    sp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 20, clientY: r.top + 2, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 20, clientY: r.top + 82 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 400));
    const h1 = document.getElementById('veTimeline').getBoundingClientRect().height, m1 = document.getElementById('veMonitors').getBoundingClientRect().height;
    return { h0, h1, m0, m1, saved: localStorage.getItem('mw-ve-tlh') };`);
  check('dragging the handle down makes the timeline shorter by as much', Math.abs((tl.h0 - tl.h1) - 80) < 4, JSON.stringify(tl));
  check('…and the monitors taller', tl.m1 > tl.m0 + 60, JSON.stringify({ m0: tl.m0, m1: tl.m1 }));
  check('…and the height is remembered', +tl.saved === Math.round(tl.h1), tl.saved);

  head('[H] Line icons, and every label kept its words');
  const ic = await js(`const btns = [...document.querySelectorAll('#view-video .ve-topbar button, #view-video .ve-tl-bar button, #view-video .ve-transport button')];
    const withIcon = btns.filter(b => b.querySelector('.mi'));
    const emojiShown = btns.filter(b => { const t = [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join(''); return /[\\u{1F300}-\\u{1FAFF}\\u2600-\\u27BF]/u.test(t); }).map(b => b.id || b.textContent);
    const music = document.getElementById('veMusic');
    return { total: btns.length, withIcon: withIcon.length, emojiShown, musicText: music.textContent, play: document.getElementById('vePlay').textContent,
      drawn: getComputedStyle(document.querySelector('#veOpen .mi')).maskImage || getComputedStyle(document.querySelector('#veOpen .mi')).webkitMaskImage };`);
  check('the toolbar, timeline bar and transport buttons draw line icons', ic.withIcon >= ic.total - 2, `${ic.withIcon} of ${ic.total}`);
  check('…and no colour emoji is drawn on them any more', ic.emojiShown.length === 0, JSON.stringify(ic.emojiShown));
  check('…while each label\'s text is exactly what it was ("🎵 Music", "▶")', ic.musicText === '🎵 Music' && ic.play === '▶', JSON.stringify({ music: ic.musicText, play: ic.play }));
  check('…and the icon really is painted (a mask image)', /url\(/.test(ic.drawn || ''), String(ic.drawn).slice(0, 40));
  const relabel = await js(`const p = document.getElementById('vePlayer'); p.play(); await new Promise(r => setTimeout(r, 300));
    const b = document.getElementById('vePlay'); const r = { text: b.textContent, icon: (b.querySelector('.mi') || {}).dataset ? b.querySelector('.mi').dataset.i : null }; p.pause(); return r;`);
  check('a label the studio rewrites (▶ → ⏸) gets its new icon too', relabel.text === '⏸' && relabel.icon === 'pause', JSON.stringify(relabel));

  /*
   * [I] The lane names used to SIZE their column: "CAPTIONS" in this type is
   * wider than 74px, so the column grew to fit it — and whenever the studio
   * rewrote that label (the icon gone until icons.js put it back) it shrank
   * again for that moment. The track beside it moved 16px, so a trim measured
   * in that moment landed 4–5 s from where the handle was let go. Measured in
   * the SAME task as the rewrite and the press, which is the only place it
   * ever showed.
   */
  head('[I] The timeline never moves under the mouse');
  const still = await js(`
    const tr = () => Math.round(document.getElementById('veTrack').getBoundingClientRect().left * 10) / 10;
    const col = () => Math.round(document.querySelector('.ve-tl-labels').getBoundingClientRect().width * 10) / 10;
    const at = () => ({ track: tr(), col: col() });
    const before = at();
    const lbl = document.getElementById('veCapLabel');
    const was = lbl.textContent;
    lbl.textContent = '💬 Captions (1234)';
    const relabelled = at();
    lbl.textContent = was;
    await new Promise((r) => setTimeout(r, 50));
    const h = document.querySelector('#veSegments .ve-seg .ve-seg-h.l');
    const hr = h.getBoundingClientRect();
    h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: hr.left + 4, clientY: hr.top + 4, button: 0 }));
    const pressed = at();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: hr.left + 4, clientY: hr.top + 4 }));
    await new Promise((r) => setTimeout(r, 50));
    const labels = [...document.querySelectorAll('.ve-tl-labels .ve-tl-label')].map((l) => [l.scrollWidth, l.clientWidth]);
    return { before, relabelled, pressed, after: at(), labels };`);
  check('rewriting a lane name does not move the track', still.relabelled && still.relabelled.track === still.before.track, JSON.stringify([still.before, still.relabelled]));
  check("pressing a clip's trim handle does not move the track before the drag", still.pressed && still.pressed.track === still.before.track && still.after.track === still.before.track,
    JSON.stringify([still.before, still.pressed, still.after]));
  check('every lane name fits inside its column', Array.isArray(still.labels) && still.labels.every(([sw, cw]) => sw <= cw + 1), JSON.stringify(still.labels));

  try { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(WORK, 'pro-layout.png'), img.toPNG()); } catch (e) {}
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  console.log('  screenshot: ' + WORK);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
