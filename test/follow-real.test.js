'use strict';
/*
 * ►► FOLLOW THE READING, ON REAL READINGS FROM THIS CHURCH ◄◄
 *
 * "Follow the reading is confused and is not good." Every earlier test read ONE
 * verse, in clean text, at a steady pace, into a quiet room. This church reads
 * the way churches do: a verse, the pastor's comment, "Go on", the next verse —
 * and whisper hears "Belia" for Belial and "loud voice, loud voice, glorify God"
 * for "with a loud voice glorified God" on the way.
 *
 * test/fixtures/real-readings.json is six readings from this church's own
 * services, exactly as whisper transcribed them (the Video Studio's caption
 * cache). Each is replayed through the REAL studio the way the cloud ear
 * delivers it — a finished phrase at the end of every segment the endpointer
 * would cut, a 12 s look-back every 6.67 s, and the fast local look-back once a
 * verse is under way — with the studio's clock driven by the transcript's, so
 * its timers behave as they would in the room. And again with the edges of
 * every look-back damaged the way a real recogniser damages them.
 *
 * Before the tracker, on these six: the screen went back and forth (Joshua 14
 * 3→4→3→4, 1 Timothy 1 9→10→9→10), jumped to 1 Thessalonians 2:14 in the
 * middle of 1 Timothy 1, put up Psalm 24:9 while 24:7 was read, and sat on
 * Luke 17:15 while the reader went on to 16 and 17.
 *
 *   npx electron test/follow-real.test.js      (SKIPS with no Bible)
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const bible = require('../src/main/bible');
const voiceref = require('../src/main/voiceref');
const versefind = require('../src/main/versefind-host');

const READINGS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'real-readings.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-followreal-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const USER_DATA = process.env.MW_USERDATA || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Church Work Space');
bible.init(USER_DATA);
versefind.init(USER_DATA);

let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: {} };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
for (const ch of ['video:presets', 'present:state', 'present:open', 'present:close']) ipcMain.handle(ch, () => ok({}));
for (const ch of ['scheduler:list', 'fonts:data', 'photos:list', 'live:screenSources', 'present:displays', 'bible:catalogue', 'bible:search']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('ndi:sources', () => ok([]));
ipcMain.handle('present:set', () => ok(true));
ipcMain.handle('bible:installed', wrap(async () => bible.installed()));
ipcMain.handle('bible:books', wrap(async (e, { translation } = {}) => ({ books: await bible.books(translation) })));
ipcMain.handle('bible:lookup', wrap(async (e, { translation, ref }) => bible.lookup({ translation, ref })));
ipcMain.handle('bible:chapter', wrap(async (e, { translation, bookNr, chapter }) => bible.getChapter({ translation, bookNr, chapter })));
ipcMain.handle('bible:parseRef', wrap(async (e, { ref }) => bible.parseRef(ref)));
let voiceTranslation = null;
ipcMain.handle('voice:available', wrap(async () => ({ ready: true })));
ipcMain.handle('voice:warmUp', wrap(async () => ({ resident: false })));
ipcMain.handle('voice:translation', wrap(async (e, { translation } = {}) => { voiceTranslation = translation || null; return { translation: voiceTranslation }; }));
ipcMain.handle('voice:parse', wrap(async (e, { text, live } = {}) => ({ text: text || '', intent: voiceref.parseVoice(text, { live }) })));
async function withQuote(r) {
  if (!r || !r.ok || r.intent || !r.text) return r;
  let q = null;
  try { q = await versefind.find(r.text); } catch (err) { q = null; }
  if (!q) return r;
  r.quote = { ok: !!q.ok, ref: q.ref, run: q.run, share: q.share, coverage: q.coverage, rare: q.rare, matchedIn: q.translation, alsoAt: q.alsoAt, spans: q.spans };
  if (!q.ok) return r;
  r.intent = { kind: 'ref', bookNr: q.bookNr, book: q.book, chapter: q.chapter, verses: [q.verse], ref: q.ref, said: r.text, viaQuote: true };
  return r;
}
ipcMain.handle('voice:hearText', wrap(async (e, { text, live, quote } = {}) => {
  const r = { ok: true, text: text || '', intent: voiceref.parseVoice(text, { live }) };
  return quote ? withQuote(r) : r;
}));
ipcMain.handle('voice:quotePrepare', wrap(async (e, { translation } = {}) => versefind.prepare(translation || voiceTranslation || null)));
ipcMain.handle('voice:quoteState', wrap(async () => versefind.state()));
ipcMain.handle('voice:quoteFind', wrap(async (e, { text } = {}) => versefind.find(text)));

app.disableHardwareAcceleration();
const js = (win, code) => win.webContents.executeJavaScript(
  `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
const T = 'window.Presenter.__test';

function timedWords(segs) {
  const out = [];
  for (const s of segs) {
    const w = s.text.split(/\s+/).filter(Boolean);
    const d = Math.max(0.01, s.end - s.start) / Math.max(1, w.length);
    w.forEach((x, i) => out.push({ w: x, t: s.start + d * (i + 1) }));
  }
  return out;
}
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
function edges(ws, noisy) {
  if (!noisy || ws.length < 4) return ws;
  const a = ws.slice();
  const cut = (w) => (w.length > 3 ? w.slice(Math.ceil(w.length / 2)) : '');
  let r = rnd();
  if (r < 0.35) a.shift(); else if (r < 0.7) a[0] = cut(a[0]);
  r = rnd();
  if (r < 0.3) a.pop(); else if (r < 0.55) a[a.length - 1] = a[a.length - 1].slice(0, Math.max(1, Math.floor(a[a.length - 1].length / 2)));
  return a.filter(Boolean);
}

app.whenReady().then(async () => {
  console.log('\n== FOLLOW THE READING, ON REAL READINGS FROM THIS CHURCH ==\n');
  const installed = bible.installed().map((t) => t.abbr);
  if (!installed.length) { console.log('  SKIP  no Bible translation is downloaded'); app.exit(0); return; }
  const display = installed.includes('kjv') ? 'kjv' : installed[0];
  const errs = [];
  const win = new BrowserWindow({ show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 3) errs.push(m); });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1300);
  await js(win, `document.querySelector('.nav-item[data-view="present"]').click(); await new Promise((r)=>setTimeout(r,400)); return true;`);
  await js(win, `${T}.setTranslation ? await ${T}.setTranslation(${JSON.stringify(display)}) : null; return true;`);
  await js(win, `window.__now = Date.now(); Date.now = () => window.__now; return 1;`);
  await js(win, `return await ${T}.listen.setQuote(true);`);
  await js(win, `${T}.listen.setFollow(true); return 1;`);
  const base = 1.9e12;
  const setClock = (sec) => js(win, `window.__now = ${Math.round(base + sec * 1000)}; return 1;`);
  const where = () => js(win, `const c = ${T}.listen.context(); const t = ${T}.listen.followTarget(); return { book: c && c.book, chapter: c && c.chapter, verse: t ? t.verse : null };`);

  /** Replay one reading; returns every place the screen went, in order. */
  async function replay(R, noisy) {
    seed = 12345;
    const tw = timedWords(R.segs);
    await setClock(R.from - 1);
    await js(win, `${T}.setVersesPerSlide(1); await ${T}.find(${JSON.stringify(R.open)}); ${T}.sendVerseLive(${R.verse}); ${T}.listen.resetReading(); ${T}.listen.forgetLast(); return 1;`);
    const start = await where();
    const path = [start];
    const ev = [];
    for (const s of R.segs) if (s.end - s.start < 8) ev.push({ t: s.end, kind: 'phrase', text: s.text });
    for (let t = R.from + 6.67; t <= R.to + 6.67; t += 6.67) ev.push({ t, kind: 'look' });
    ev.sort((a, b) => a.t - b.t);
    const win12 = (t, w) => edges(tw.filter((x) => x.t > t - w && x.t <= t).map((x) => x.w), noisy).join(' ');
    let closeNext = Infinity;
    const one = async (t, kind, text) => {
      await setClock(t);
      if (kind === 'close') await js(win, `return ${T}.listen.closeLookText(${JSON.stringify(text)});`);
      else await js(win, `return await ${T}.listen.hearText(${JSON.stringify(text)}, ${kind === 'look' ? '{ partial: true }' : '{}'});`);
      const now = await where();
      const last = path[path.length - 1];
      if (now.book !== last.book || now.chapter !== last.chapter || now.verse !== last.verse) path.push(now);
      const f = await js(win, `return ${T}.listen.follow();`);
      if (f && f.closeWant) { if (closeNext === Infinity) closeNext = t + 1.1; } else closeNext = Infinity;
    };
    for (const e of ev) {
      while (closeNext <= e.t) { const tt = closeNext; closeNext = tt + 1.1; const x = win12(tt, 4.5); if (x) await one(tt, 'close', x); }
      const text = e.kind === 'phrase' ? e.text : win12(e.t, 12);
      if (text) await one(e.t, e.kind, text);
    }
    return path;
  }

  const EXPECT = {
    'Luke 17': { ends: [19, 20], via: [16] },
    '2 Corinthians 6': { ends: [18, 18], via: [16, 17] },
    'Joshua 14': { ends: [10, 11], via: [2, 3, 4, 7, 8] },
    '1 Timothy 1': { ends: [16, 17], via: [10, 11, 12, 13, 14, 15] },
    'Psalms 24': { ends: [8, 8], via: [7], never: [9] },
    'Matthew 25': { ends: [4, 5], via: [3] },
  };
  for (const noisy of [false, true]) {
    console.log(`\n[${noisy ? 'B' : 'A'}] ${noisy ? 'every look-back cut at its edges, as a real recogniser cuts them' : 'the transcript as whisper wrote it'}`);
    for (const R of READINGS) {
      const p = await replay(R, noisy);
      const x = EXPECT[R.open] || { ends: [0, 999], via: [] };
      const trail = p.map((s) => `${s.chapter}:${s.verse}`).join(' → ');
      const inChapter = p.every((s) => s.book === p[0].book && s.chapter === p[0].chapter);
      let forward = true;
      for (let i = 1; i < p.length; i++) if (p[i].verse < p[i - 1].verse) forward = false;
      const seen = new Set(p.map((s) => s.verse));
      const last = p[p.length - 1].verse;
      const ok = inChapter && forward && last >= x.ends[0] && last <= x.ends[1]
        && (x.via || []).every((v) => seen.has(v)) && !(x.never || []).some((v) => seen.has(v));
      log(ok, `${R.label}`, `${trail}` + (inChapter ? '' : '  ✗ LEFT THE CHAPTER') + (forward ? '' : '  ✗ WENT BACKWARDS'));
    }
  }

  console.log('\n[C] "Go on" said after the page has already turned is the pastor agreeing, not a second step');
  {
    await setClock(100000);
    await js(win, `${T}.setVersesPerSlide(1); await ${T}.find('John 1'); ${T}.sendVerseLive(1); ${T}.listen.resetReading(); ${T}.listen.forgetLast(); return 1;`);
    const t = await js(win, `return ${T}.listen.followTarget();`);
    await js(win, `return await ${T}.listen.hearText(${JSON.stringify(t.text)}, { partial: true });`);
    const a = (await where()).verse;
    await setClock(100004);
    await js(win, `${T}.listen.forgetLast(); return await ${T}.listen.hearText('Go on.');`);
    const b = (await where()).verse;
    await setClock(100030);
    await js(win, `${T}.listen.forgetLast(); return await ${T}.listen.hearText('Go on.');`);
    const c = (await where()).verse;
    log(a === 2, 'reading verse 1 to the end turns the page to verse 2', 'verse ' + a);
    log(b === 2, '…and the pastor\'s "Go on" right after it does NOT push it on to 3', 'verse ' + b);
    log(c === 3, '…while a "Go on" that is a genuine instruction still moves it', 'verse ' + c);
  }

  console.log('\n[D] Console');
  const real = errs.filter((m) => !/Autofill|devtools|Electron Security|preload/i.test(m));
  log(real.length === 0, 'no renderer errors', real.slice(0, 3).join(' | '));
  console.log(failed ? '\n============  FAILED  ============\n' : '\n============  ALL PASSED  ============\n');
  try { versefind.stop(); } catch (e) {}
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
