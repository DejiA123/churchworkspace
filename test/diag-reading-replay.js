'use strict';
/*
 * REAL READINGS, REPLAYED THROUGH THE REAL STUDIO.
 *
 * "Follow the reading is confused." Every earlier test read ONE verse in clean
 * text at a steady rate. A church does not: somebody reads a verse, the pastor
 * comments, says "Go on", the reader reads the next — and whisper hears
 * "Belia" for Belial on the way. This takes real transcripts of this church's
 * own services (the Video Studio's whisper cache, on this machine) and replays
 * a passage exactly as the ear would deliver it:
 *
 *   - a finished PHRASE at the end of each spoken segment (what the endpointer
 *     sends; one over 8 s is capped and, on the cloud ear, dropped);
 *   - a 12 s LOOK-BACK every 6.67 s (the cloud ear's pace);
 *   - once the follower is armed, a 4.5 s CLOSE look every 1.1 s (this PC).
 *
 * The studio's clock is driven with the replay (Date.now is the transcript's
 * time), so its timers — the 25 s tape expiry, the repeat guards — behave as
 * they would in the room.
 *
 *   npx electron test/diag-reading-replay.js <passages.json> <corpus.json>
 *   passages: [{ file, from, to, open: 'Luke 17', verse: 12, label }]
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const bible = require('../src/main/bible');
const voiceref = require('../src/main/voiceref');
const versefind = require('../src/main/versefind-host');

const PASSAGES = JSON.parse(fs.readFileSync(process.argv[2] || process.env.MW_PASSAGES, 'utf8'));
const CORPUS = JSON.parse(fs.readFileSync(process.argv[3] || process.env.MW_CORPUS, 'utf8'));
const QUOTE = process.env.MW_QUOTE !== '0';
const OUT = process.env.MW_OUT || '';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-replay-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
/*
 * A real recogniser hands back each look-back separately, and its EDGES are
 * where two recognitions of the same seconds disagree: the first word is often
 * cut in half, the last one too. MW_NOISE=1 does that to every window (seeded,
 * so a run is repeatable) — which is what the tape's stitching has to survive.
 */
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const NOISE = process.env.MW_NOISE === '1';
function edges(ws) {
  if (!NOISE || ws.length < 4) return ws;
  const a = ws.slice();
  const cut = (w) => (w.length > 3 ? w.slice(Math.ceil(w.length / 2)) : '');
  let r = rnd();
  if (r < 0.35) a.shift(); else if (r < 0.7) a[0] = cut(a[0]);
  r = rnd();
  if (r < 0.3) a.pop(); else if (r < 0.55) a[a.length - 1] = a[a.length - 1].slice(0, Math.max(1, Math.floor(a[a.length - 1].length / 2)));
  return a.filter(Boolean);
}
const windowText = (tw, now, win) => edges(tw.filter((x) => x.t > now - win && x.t <= now).map((x) => x.w)).join(' ');

app.whenReady().then(async () => {
  const installed = bible.installed().map((t) => t.abbr);
  const display = process.env.MW_DISPLAY || (installed.includes('kjv') ? 'kjv' : installed[0]);
  const win = new BrowserWindow({ show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1300);
  await js(win, `document.querySelector('.nav-item[data-view="present"]').click(); await new Promise((r)=>setTimeout(r,400)); return true;`);
  await js(win, `${T}.setTranslation ? await ${T}.setTranslation(${JSON.stringify(display)}) : null; return true;`);
  // The studio's clock is the transcript's clock from here on.
  await js(win, `window.__realNow = Date.now.bind(Date); window.__now = Date.now(); Date.now = () => window.__now; return 1;`);
  if (QUOTE) await js(win, `return await ${T}.listen.setQuote(true);`);
  await js(win, `${T}.listen.setFollow(true); return 1;`);

  const report = [];
  for (const P of PASSAGES) {
    const c = CORPUS.find((x) => x.file === P.file);
    if (!c) { console.log('  no transcript for', P.file); continue; }
    const segs = c.segs.filter((s) => s.start >= P.from && s.start < P.to);
    const tw = timedWords(segs);
    const base = 1.9e12;
    const setClock = (sec) => js(win, `window.__now = ${Math.round(base + sec * 1000)}; return 1;`);
    await setClock(P.from - 1);
    await js(win, `${T}.setVersesPerSlide(1); await ${T}.find(${JSON.stringify(P.open)}); ${T}.sendVerseLive(${P.verse}); ${T}.listen.resetReading(); ${T}.listen.forgetLast(); return 1;`);
    const shown = async () => { const r = await js(win, `const c = ${T}.listen.context(); const t = ${T}.listen.followTarget(); return { ref: c && c.ref, verse: t ? t.verse : null, book: c && c.book, chapter: c && c.chapter };`); return r; };
    let cur = await shown();
    const tl = [{ t: P.from, why: 'operator opens ' + P.open + ':' + P.verse, at: cur }];
    // events in time order
    const ev = [];
    for (const s of segs) if (s.end - s.start < 8) ev.push({ t: s.end, kind: 'phrase', text: s.text });
    for (let t = P.from + 6.67; t <= P.to + 6.67; t += 6.67) ev.push({ t, kind: 'look' });
    ev.sort((a, b) => a.t - b.t);
    let closeNext = Infinity;
    const doOne = async (t, kind, text) => {
      await setClock(t);
      let r;
      if (kind === 'close') r = await js(win, `return ${T}.listen.closeLookText(${JSON.stringify(text)});`);
      else r = await js(win, `return await ${T}.listen.hearText(${JSON.stringify(text)}, ${kind === 'look' ? '{ partial: true }' : '{}'});`);
      const now = await shown();
      const f = await js(win, `return ${T}.listen.follow();`);
      if (now.ref !== cur.ref || now.verse !== cur.verse) {
        const did = r && (typeof r === 'string' ? r : (r.did || (r.followed ? 'follow' : '')));
        tl.push({ t: Math.round(t), why: `${kind}: ${did || '?'}`, heard: (text || '').slice(-90), at: now });
        cur = now;
      }
      if (f && f.closeWant) { if (closeNext === Infinity) closeNext = t + 1.1; } else closeNext = Infinity;
    };
    for (const e of ev) {
      // close looks due before this event
      while (closeNext <= e.t) {
        const tt = closeNext;
        const text = windowText(tw, tt, 4.5);
        closeNext = tt + 1.1;
        if (text) await doOne(tt, 'close', text);
      }
      const text = e.kind === 'phrase' ? e.text : windowText(tw, e.t, 12);
      if (!text) continue;
      await doOne(e.t, e.kind, text);
    }
    report.push({ label: P.label || (P.file + ' ' + P.open), tl });
    console.log(`\n=== ${P.label || P.open} (${P.file} ${P.from}-${P.to}s)`);
    for (const x of tl) console.log(`  ${String(x.t).padStart(6)}s  -> ${String(x.at.ref || '').padEnd(22)} ${x.why}${x.heard ? '  «…' + x.heard + '»' : ''}`);
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  win.destroy();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
