'use strict';
/*
 * THE CAPTIONS WINDOW, ROUND v2.78 — driven for real, in Electron, on a real
 * playable clip:
 *
 *   ▶  "There should be a play button in the captions window so it is easy for
 *       me to listen and edit the captions."
 *   ✍  "A Grammarly kind of thing… correct grammatical errors per line or overall."
 *   ☁️  "Could the Groq API do the captions… the API is the main/default for
 *       captions", "the option to use the API for the remove pauses", "option
 *       for the API for the grammar check".
 *
 * The network is stubbed at the IPC boundary (captions:cloud, captions:grammar,
 * captions:transcribe, video:speechPauses) — the real provider is proved by
 * test/cloud-captions-live.test.js and the rules by test/caption-grammar.test.js.
 * What is proved HERE is that the window really plays, stops where it should,
 * underlines, fixes, undoes, and asks for the cloud by default.
 *
 *   npx electron test/caption-listen-proofread.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const captioner = require(path.join(ROOT, 'src/main/captioner'));
const WORK = path.join(os.tmpdir(), 'mw-capv278-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));
const CLIP = path.join(WORK, 'sermon40.mp4');
const ffmpeg = require('ffmpeg-static');
execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x223355:s=640x360:r=30:d=40',
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
ipcMain.handle('captions:models', () => ok([
  { id: 'base.en', name: 'Base (ships with the app)', sizeMB: 148, bundled: true, installed: true, downloadable: false, inUse: false },
  { id: 'small.en', name: 'Small — much more accurate', sizeMB: 466, bundled: false, installed: true, downloadable: true, inUse: true },
]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));
ipcMain.handle('shell:openExternal', () => ok(true));
ipcMain.handle('video:info', wrap((e, { input }) => video.getInfo(ctx(), input)));
ipcMain.handle('video:thumbnail', wrap(async (e, { input, timeSec }) => { const o = path.join(WORK, 't-' + Date.now() + '.png'); await video.thumbnail(ctx(), { input, timeSec, output: o }); return o; }));
ipcMain.handle('video:filmstrip', wrap(async (e, { input, count }) => { const o = path.join(WORK, 's-' + Date.now() + '.png'); await video.filmstrip(ctx(), { input, count: count || 16, output: o }); return o; }));
ipcMain.handle('video:waveform', wrap(async (e, { input }) => { const o = path.join(WORK, 'w-' + Date.now() + '.png'); await video.waveform(ctx(), { input, output: o }); return o; }));
ipcMain.handle('fs:readImageDataUrl', wrap((e, { path: p }) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')));

/* ---- the cloud, at the IPC boundary ---- */
let cloudReady = true;
ipcMain.handle('captions:cloud', () => ok({ ready: cloudReady, provider: 'groq', providerName: 'Groq', model: 'whisper-large-v3-turbo', free: true, why: '', keyUrl: 'https://console.groq.com/keys' }));
const grammarCalls = [];
ipcMain.handle('captions:grammar', (e, a) => {
  grammarCalls.push(a);
  const fixes = (a.lines || []).filter((l) => /BEGOTTEN SUN/.test(l.text)).map((l) => ({ i: l.i, text: l.text.replace('SUN', 'SON'), why: 'misheard: Son' }));
  return ok({ fixes, checked: (a.lines || []).length, by: 'Groq — test', rejected: 0, failedBatches: 0 });
});
const transcribeCalls = [];
ipcMain.handle('captions:transcribe', (e, a) => {
  transcribeCalls.push(a);
  const words = ['AND', 'HE', 'GAVE', 'HIS', 'ONLY', 'BEGOTTEN', 'SUN'].map((t, k) => ({ text: t, start: 1 + k * 0.4, end: 1.3 + k * 0.4 }));
  return ok({ words, segments: words, engine: a.model === 'cloud' ? 'cloud' : 'pc', engineName: 'Groq — Whisper Large v3 Turbo', cloudMs: 1100, fixed: 0 });
});
const pauseCalls = { speech: 0, silence: 0 };
let speechFallback = false;
ipcMain.handle('video:speechPauses', (e, a) => {
  pauseCalls.speech++;
  if (speechFallback) return ok({ fallback: true, why: 'no internet (test)' });
  return ok({ silences: [{ start: a.startSec + 2, end: a.startSec + 3 }], engine: 'cloud', removedSeconds: 1,
    transcript: { words: [{ text: 'GRACE', start: 0.5, end: 0.9 }], engine: 'cloud', cloudMs: 900, fixed: 0 } });
});
ipcMain.handle('video:detectSilence', (e, a) => { pauseCalls.silence++; return ok({ silences: [{ start: a.startSec + 4, end: a.startSec + 5 }] }); });

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: true,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 3) console.log('    [renderer] ' + msg); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1400);
  const js = (code) => win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.stack || e) }; } })()`);
  const T = 'window.VideoEditor.__test';
  await js(`document.querySelector('[data-view="video"]').click(); await new Promise(r => setTimeout(r, 400)); return 1;`);
  await js(`await ${T}.loadReal(${JSON.stringify(CLIP)}); return 1;`);
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { await sleep(300); ready = await js(`const p = document.getElementById('vePlayer'); return !!(p && p.readyState >= 2 && p.duration > 30);`); }
  check('a real, playable 40-second clip is open', ready === true);

  head('[0] ☁️ The cloud is the default ear for captions');
  const cl = await js(`return await ${T}.refreshCapCloud();`);
  check('a Groq key moves the captions to the cloud — once, even from a saved PC model', cl && cl.pref === 'cloud', JSON.stringify(cl && cl.pref));
  check('…and the window will listen in the cloud', await js(`return ${T}.capHearsInCloud();`) === true);
  const opts = await js(`return [...document.querySelectorAll('#capModelSel option')].map(o => o.value + '=' + o.textContent);`);
  check('the Hearing list offers ☁️ Groq cloud, and says Automatic means it', opts.some((o) => o.startsWith('cloud=☁️')) && /Automatic — ☁️ Groq/.test(opts[0]), JSON.stringify(opts.slice(0, 3)));
  const top = await js(`const s = document.getElementById('veCapModel'); return { v: s.value, opts: [...s.options].map(o => o.value) };`);
  check('…and so does the studio\'s own Caption accuracy picker', top.v === 'cloud' && top.opts.includes('cloud'), JSON.stringify(top));
  await js(`${T}.setCapModel('small.en'); return 1;`);

  // A short at 5–35 s with captions on it — mistakes planted.
  const id = await js(`
    ${T}.applyClips([{ start: 5, end: 35, label: 'Grace' }]);
    const words = [];
    const lines = [
      { start: 6.0, end: 8.0, text: 'I DONT KNOW WHAT' },
      { start: 9.0, end: 11.0, text: 'HE GAVE HIS ONLY BEGOTTEN SUN' },
      { start: 12.0, end: 14.0, text: 'THE THE WORD OF GOD' },
      { start: 15.0, end: 17.0, text: 'YOUR GOING TO BE BLESSED' },
      { start: 18.0, end: 20.0, text: 'LET US PREY' },
      { start: 21.0, end: 23.0, text: 'AMEN AND AMEN' },
    ];
    for (const l of lines) { const t = l.text.split(' '); t.forEach((w, k) => words.push({ text: w.toLowerCase(), start: l.start + k * (l.end - l.start) / t.length, end: l.start + (k + 1) * (l.end - l.start) / t.length })); }
    ${T}.seedCaps(lines, words);
    return ${T}.segments()[0].id;
  `);
  await js(`${T}.clickClipCaption(${JSON.stringify(id)}); await new Promise(r => setTimeout(r, 300)); return 1;`);

  head('[A] ▶ Listening while you fix');
  let st = await js(`return ${T}.capPlayerState();`);
  check('the window has a play bar, and every line its own ▶', st.playLabel === '▶' && st.rowPlayButtons === 6, JSON.stringify({ play: st.playLabel, rows: st.rowPlayButtons }));
  await js(`${T}.clickRowPlay(1); return 1;`);
  await sleep(500);
  st = await js(`return ${T}.capPlayerState();`);
  check('a line\'s ▶ plays THAT line', !st.paused && st.t >= 8.8 && st.t < 11.1 && st.line && st.line.i === 1, JSON.stringify({ paused: st.paused, t: st.t }));
  check('…the line being spoken lights up', st.nowRow === 1, st.nowRow);
  check('…and the big button shows ⏸', st.playLabel === '⏸', st.playLabel);
  await sleep(2400);
  st = await js(`return ${T}.capPlayerState();`);
  check('…and stops at the end of the line, not in the next one', st.paused && st.t >= 10.9 && st.t <= 11.45, JSON.stringify({ paused: st.paused, t: st.t }));

  await js(`document.getElementById('capPlayLoop').checked = true; ${T}.clickRowPlay(4); return 1;`);
  await sleep(2900);
  st = await js(`return ${T}.capPlayerState();`);
  check('🔁 Loop line: past the end of the line it goes round again', !st.paused && st.t >= 17.8 && st.t < 20.2, JSON.stringify({ paused: st.paused, t: st.t }));
  await js(`document.getElementById('capPlayLoop').checked = false; document.getElementById('vePlayer').pause(); return 1;`);

  await js(`${T}.seekPlayer(1); ${T}.capTogglePlay(); return 1;`);
  await sleep(400);
  st = await js(`return ${T}.capPlayerState();`);
  check('▶ from outside the short starts at the short, not where the playhead was', !st.paused && st.t >= 5 && st.t < 6, JSON.stringify({ t: st.t }));
  check('…and the time reads from the start of the short', /^0:0[01] \/ 0:30$/.test(st.time), st.time);
  await js(`document.getElementById('vePlayer').pause(); ${T}.seekPlayer(34.2); ${T}.capTogglePlay(); return 1;`);
  await sleep(1600);
  st = await js(`return ${T}.capPlayerState();`);
  check('…and stops at the end of the short instead of running on', st.paused && st.t <= 35.4, JSON.stringify({ paused: st.paused, t: st.t }));

  // Ctrl+Space from inside a line being typed in.
  await js(`${T}.seekPlayer(12); const inp = document.querySelector('#capList .cap-text[data-i="2"]'); inp.focus();
    inp.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, bubbles: true, cancelable: true })); return 1;`);
  await sleep(500);
  st = await js(`return ${T}.capPlayerState();`);
  check('Ctrl+Space plays even while the cursor is in a line', !st.paused, JSON.stringify({ paused: st.paused, t: st.t }));
  const typed = await js(`const inp = document.querySelector('#capList .cap-text[data-i="2"]'); inp.value = inp.value + ' '; inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200)); return ${T}.capPlayerState();`);
  check('⌨ typing pauses the sound, and says so', typed.paused && typed.typePausedAt != null && /paused while you type/.test(typed.time), JSON.stringify({ paused: typed.paused, time: typed.time }));
  await js(`const inp = document.querySelector('#capList .cap-text[data-i="2"]'); inp.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, bubbles: true, cancelable: true })); return 1;`);
  await sleep(250);
  st = await js(`return ${T}.capPlayerState();`);
  check('…and Ctrl+Space carries on from a second before it stopped', !st.paused && st.t < typed.typePausedAt + 0.2 && st.t >= typed.typePausedAt - 1.3, JSON.stringify({ from: typed.typePausedAt, now: st.t }));
  await js(`document.getElementById('vePlayer').pause(); const inp = document.querySelector('#capList .cap-text[data-i="2"]'); inp.value = 'THE THE WORD OF GOD'; inp.blur(); return 1;`);
  await js(`const s = document.getElementById('capPlayRate'); s.value = '0.75'; s.dispatchEvent(new Event('change')); return 1;`);
  st = await js(`return ${T}.capPlayerState();`);
  check('0.75× slows the clip down for checking a fast speaker', Math.abs(st.rate - 0.75) < 0.001, st.rate);

  head('[B] ✍ The proof-reader, per line');
  let g = await js(`return ${T}.capGrammar();`);
  const badged = g.rows.filter((r) => r.badge).map((r) => r.i);
  check('the lines with mistakes carry a badge — and only those', JSON.stringify(badged) === '[0,1,2,3,4]', JSON.stringify(g.rows.map((r) => [r.i, r.badge])));
  check('…the wrong words are underlined under the very letters', JSON.stringify(g.rows[0].marks) === '["DONT"]' && g.rows[3].marks.includes('YOUR'), JSON.stringify(g.rows.map((r) => r.marks)));
  check('…and the button at the top counts them', /Fix 5 mistakes/.test(g.summary), g.summary);
  await js(`document.querySelector('#capList .cap-g-badge[data-g-i="0"]').click(); return 1;`);
  g = await js(`return ${T}.capGrammar();`);
  check('a badge opens what is wrong with that line', g.rows[0].chips === 1 && /DONT.*DON'T/.test(g.rows[0].card), g.rows[0].card);
  await js(`document.querySelector('#capList .cap-sugg-chip[data-gfix="0"]').click(); return 1;`);
  g = await js(`return ${T}.capGrammar();`);
  check('…and one click fixes it', g.rows[0].text === "I DON'T KNOW WHAT" && !g.rows[0].badge, g.rows[0].text);
  check('…in the one caption store the export reads', (await js(`return ${T}.capLinesText()[0];`)) === "I DON'T KNOW WHAT");
  await js(`${T}.undo(); await new Promise(r => setTimeout(r, 50)); return 1;`);
  check('Ctrl+Z puts it back', (await js(`return ${T}.capLinesText()[0];`)) === 'I DONT KNOW WHAT');
  await js(`document.querySelector('#capList .cap-g-badge[data-g-i="4"]').click(); document.querySelector('#capList [data-gignore="4"]').click(); return 1;`);
  g = await js(`return ${T}.capGrammar();`);
  check('Ignore drops the badge on that line', !g.rows[4].badge && /Fix 4 mistakes/.test(g.summary), JSON.stringify([g.rows[4].badge, g.summary]));

  head('[C] ✨ The AI, per line and overall');
  const callsBefore = grammarCalls.length;
  await js(`await ${T}.aiProofread(1); return 1;`);
  const one = grammarCalls[grammarCalls.length - 1];
  check('✨ on one line sends that line, with the lines around it for meaning',
    grammarCalls.length === callsBefore + 1 && one.lines.length === 1 && one.lines[0].i === 1 && one.before.length === 1 && one.after.length === 2,
    JSON.stringify({ lines: one.lines.length, before: one.before.length, after: one.after.length }));
  check('…in the captions\' case, keeping the speaker\'s exact words by default', one.caseMode === 'upper' && one.mode === 'exact', JSON.stringify([one.caseMode, one.mode]));
  g = await js(`return ${T}.capGrammar();`);
  check('…and its suggestion appears under the line, marked ✨ AI', /✨ AI/.test(g.rows[1].card || '') && /SON/.test(g.rows[1].card || ''), g.rows[1].card);
  const r2 = await js(`return await ${T}.aiProofread(null);`);
  check('✨ AI proofread overall reads every line in the short', grammarCalls[grammarCalls.length - 1].lines.length === 6, grammarCalls[grammarCalls.length - 1].lines.length);
  check('…and says who read them', r2 && /Groq/.test(r2.by || ''), JSON.stringify(r2));

  head('[D] ✍ Fix all — one click, one Ctrl+Z');
  const fixed = await js(`return ${T}.fixAllGrammar();`);
  const after = await js(`return ${T}.capLinesText();`);
  check('every underlined mistake and the AI\'s line are fixed', fixed === 4
    && after.join('|') === "I DON'T KNOW WHAT|HE GAVE HIS ONLY BEGOTTEN SON|THE WORD OF GOD|YOU'RE GOING TO BE BLESSED|LET US PREY|AMEN AND AMEN",
    JSON.stringify(after));
  check('…and the window says there is nothing left', /No mistakes/.test((await js(`return ${T}.capGrammar();`)).summary));
  const rebuilt = await js(`return ${T}.setCapWordsPerLine(3).map(e => e.text);`);
  check('re-breaking the lines afterwards does NOT bring the mistakes back (the words underneath were fixed too)',
    rebuilt.some((t) => /DON'T/.test(t)) && rebuilt.some((t) => /SON/.test(t)) && !rebuilt.some((t) => /DONT|SUN/.test(t)) && !rebuilt.join(' ').includes('THE THE'),
    JSON.stringify(rebuilt));
  await js(`${T}.undo(); ${T}.undo(); await new Promise(r => setTimeout(r, 50)); return 1;`);
  check('Ctrl+Z takes the whole fix back in one go', (await js(`return ${T}.capLinesText();`)).join('|').includes('I DONT KNOW WHAT|HE GAVE HIS ONLY BEGOTTEN SUN|THE THE WORD OF GOD'),
    JSON.stringify(await js(`return ${T}.capLinesText();`)));

  head('[E] The layout still fits — on a small laptop, and beside the video');
  win.setSize(1280, 720);
  await sleep(500);
  await js(`document.querySelectorAll('#capList .cap-g-badge:not(.hidden)').forEach(b => b.click()); return 1;`);
  const lay = await js(`return ${T}.capModalLayout();`);
  const ov = await js(`return ${T}.capModalOverlaps();`);
  check('1280×720 with suggestion cards open: the words are readable', lay && lay.listH >= 100 && lay.visibleRows >= 2, JSON.stringify({ listH: lay && lay.listH, rows: lay && lay.visibleRows }));
  check('…the Save button is still there', lay && lay.footVisible, lay && lay.footClippedBy);
  check('…nothing overlaps or is squeezed', ov && !ov.overlaps.length && !ov.squashed.length, JSON.stringify(ov && { o: ov.overlaps, s: ov.squashed }));
  // The card's own buttons must be reachable: a card wider than its row hid
  // "Ignore" off the right edge and put a sideways scrollbar under the words.
  const wide = await js(`const l = document.getElementById('capList'); const lb = l.getBoundingClientRect();
    return { sideways: l.scrollWidth - l.clientWidth,
      hidden: [...l.querySelectorAll('.cap-sugg button')].filter(b => b.getBoundingClientRect().right > lb.right + 1).map(b => b.textContent) };`);
  check('…and every button on a suggestion card is on screen, with no sideways scroll', wide.sideways <= 0 && !wide.hidden.length, JSON.stringify(wide));
  /*
   * "Captions editor: 1 · Beside the video" — the editor takes the studio over:
   * the words on the right, full height; the PROGRAM monitor large on the left
   * with the listening bar under it; no backdrop over the picture.
   */
  win.setSize(1500, 950);
  await sleep(600);
  const beside = await js(`await new Promise(r => setTimeout(r, 300));
    const b = document.querySelector('#capModal .cap-box').getBoundingClientRect();
    const f = document.querySelector('#capModal .cap-foot').getBoundingClientRect();
    const d = document.getElementById('veDrop').getBoundingClientRect();
    const pl = document.getElementById('capPlayer').getBoundingClientRect();
    const bg = getComputedStyle(document.getElementById('capModal')).backgroundColor;
    return Object.assign(${T}.capBeside(), { right: Math.round(b.right), w: innerWidth, top: Math.round(b.top), bottom: Math.round(b.bottom), h: innerHeight,
      footIn: f.bottom <= b.bottom + 1, bg, dropRight: Math.round(d.right), dropH: Math.round(d.height), boxLeft: Math.round(b.left),
      playerUnder: pl.top >= d.bottom - 1 && pl.right <= b.left + 1 });`);
  check('💬 the captions open BESIDE the video: the words on the right edge, full height', beside.beside && Math.abs(beside.right - beside.w) <= 1 && beside.top <= 1 && Math.abs(beside.bottom - beside.h) <= 1, JSON.stringify(beside));
  check('…the program monitor fills the left, clear of the words, and taller than in the studio', beside.capmode && beside.dropRight <= beside.boxLeft + 1 && beside.dropH > 500, JSON.stringify({ dropRight: beside.dropRight, boxLeft: beside.boxLeft, dropH: beside.dropH }));
  check('…the listening bar sits under the picture', beside.playerUnderPicture && beside.playerUnder, JSON.stringify(beside));
  check('…with no dark backdrop over the picture, and the Save button in view', /rgba\(0, 0, 0, 0\)|transparent/.test(beside.bg) && beside.footIn, beside.bg);
  await sleep(200);
  try { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(WORK, 'captions-beside.png'), img.toPNG()); } catch (e) {}
  try { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(WORK, 'captions-window.png'), img.toPNG()); } catch (e) {}
  const closed = await js(`return ${T}.closeCapModal();`);
  st = await js(`return ${T}.capPlayerState();`);
  check('closing the window puts the studio\'s preview back to normal speed', !closed.open && st.rate === 1, st.rate);
  await sleep(300);
  const back = await js(`return Object.assign(${T}.capBeside(), { home: !!document.querySelector('#capModal .cap-box #capPlayer') });`);
  check('…and gives the studio back: no take-over, and the listening bar home in the window', !back.capmode && !back.beside && back.home, JSON.stringify(back));

  head('[F] ☁️ Captions are heard in the cloud, and proof-read by themselves');
  await js(`${T}.setCapModel('cloud'); return 1;`);
  const pref = await js(`return ${T}.capModelPref();`);
  await js(`${T}.setCapEvents([], 0); return 1;`);
  const gBefore = grammarCalls.length;
  await js(`await ${T}.captionAllShorts(); return 1;`);
  await sleep(400);
  const tc = transcribeCalls[transcribeCalls.length - 1];
  check('💬 Auto-caption all shorts asks for the cloud ear', pref === 'cloud' && tc && tc.model === 'cloud', JSON.stringify({ pref, model: tc && tc.model }));
  check('…and says who heard it', /☁️ Heard by Groq/.test(await js(`return ${T}.capFixNote();`) || ''), await js(`return ${T}.capFixNote();`));
  check('…and the new lines go to the AI proof-reader by themselves ("auto")', grammarCalls.length === gBefore + 1, `${grammarCalls.length - gBefore} call(s)`);
  await js(`document.getElementById('capGrammarAuto').checked = false; return 1;`);

  head('[G] 🤫 Remove pauses, by the words');
  check('the pause finder defaults to ☁️ by the words', (await js(`return ${T}.pauseHow();`)) === 'cloud');
  const segId = await js(`return ${T}.segments()[0].id;`);
  const rp = await js(`return await ${T}.removePauses([${JSON.stringify(segId)}]);`);
  check('…and asks the cloud, not silencedetect', pauseCalls.speech === 1 && pauseCalls.silence === 0 && rp && rp.byWords === 1, JSON.stringify({ calls: pauseCalls, rp }));
  const cuts = await js(`return ${T}.cutsFor(${JSON.stringify(segId)});`);
  check('…and the pause it found becomes a cut on the short', Array.isArray(cuts) && cuts.length === 1 && cuts[0].start === 7 && cuts[0].end === 8, JSON.stringify(cuts));
  // Words heard ONCE (to find the pauses) are not reused for the captions any more:
  // captions are published, so they are heard twice by two models and compared.
  check('…but captioning that short hears it again, twice (words heard once are never reused for captions)', !(await js(`return ${T}.cachedCloudWords(${JSON.stringify(segId)});`)));
  speechFallback = true;
  const rp2 = await js(`return await ${T}.removePauses([${JSON.stringify(segId)}]);`);
  check('no internet: it falls back to silence on this PC, and says why', pauseCalls.silence === 1 && rp2 && rp2.bySilence === 1 && /no internet/.test(rp2.why), JSON.stringify(rp2));

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  console.log('  screenshots: ' + WORK);
  win.destroy();
  app.exit(fail ? 1 : 0);
// A script that fails to PARSE rejects instead of returning { __error } — without
// this the suite sat there until the runner's timeout instead of failing.
}).catch((e) => { console.error('FATAL ' + (e && e.stack || e)); app.exit(1); });
