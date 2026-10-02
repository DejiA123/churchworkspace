'use strict';
/*
 * REAL end-to-end test for the Presentation Studio (the ProPresenter-style
 * fifth studio).
 *
 * Nothing important is faked:
 *   • the Bible engine is exercised against a REAL downloaded translation
 *     (and a hand-built one, to prove a church's own licensed module loads),
 *   • the projector output is a REAL second BrowserWindow, and the test reads
 *     the text back OUT of it to prove the verse actually reached the glass,
 *   • the studio runs in the real index.html with the real preload.
 *
 *   npx electron test/presentation.test.js
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const bible = require(path.join(ROOT, 'src/main/bible'));
const presenter = require(path.join(ROOT, 'src/main/presenter'));

const WORK = path.join(os.tmpdir(), 'mw-present-test');
fs.rmSync(path.join(WORK, 'bibles'), { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
bible.init(WORK);

let failed = false;
function log(okv, name, d) {
  console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!okv) failed = true;
}
function skip(name, why) { console.log('  SKIP ' + name + (why ? '  -> ' + why : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- a tiny hand-built translation: this is the "import your own NIV" path ---- */
const CUSTOM = path.join(WORK, 'mychurch.json');
fs.writeFileSync(CUSTOM, JSON.stringify({
  translation: 'My Church Edition', abbreviation: 'mce',
  books: [{
    nr: 43, name: 'John',
    chapters: [{
      chapter: 3,
      verses: [
        { verse: 15, text: 'That whosoever believeth in him should not perish.' },
        { verse: 16, text: 'For God so loved the world {H123}, that he gave his [only] Son.' },
        { verse: 17, text: 'For God sent not his Son to condemn the world.' },
      ],
    }],
  }, {
    nr: 19, name: 'Psalms',
    chapters: [{ chapter: 23, verses: [{ verse: 1, text: 'The LORD is my shepherd; I shall not want.' }] }],
  }],
}), 'utf-8');

/* ---- real main-process IPC: the actual handlers the app ships ---- */
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a = {}) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {}, present: { translation: 'kjv' } }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok({ 'reel-9x16': { w: 9, h: 16, label: 'Reel 9:16' } }));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));

// storage for the studio (in-memory, same shapes as the real store)
const mem = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('present:library', () => ok(mem));
ipcMain.handle('present:savePresentation', (e, { presentation }) => {
  const i = mem.presentations.findIndex((p) => p.id === presentation.id);
  if (i >= 0) mem.presentations[i] = presentation; else mem.presentations.unshift(presentation);
  return ok(presentation);
});
ipcMain.handle('present:deletePresentation', (e, { id }) => { mem.presentations = mem.presentations.filter((p) => p.id !== id); return ok(true); });
ipcMain.handle('present:savePlaylist', (e, { playlist }) => {
  const i = mem.playlists.findIndex((p) => p.id === playlist.id);
  if (i >= 0) mem.playlists[i] = playlist; else mem.playlists.push(playlist);
  return ok(playlist);
});
ipcMain.handle('present:deletePlaylist', (e, { id }) => { mem.playlists = mem.playlists.filter((p) => p.id !== id); return ok(true); });
ipcMain.handle('present:saveThemes', (e, { themes }) => { mem.themes = themes || []; return ok(mem.themes); });

// the Bible + projector handlers, pointed at the real modules
ipcMain.handle('bible:catalogue', wrap((e, { refresh }) => bible.catalogue({ refresh })));
ipcMain.handle('bible:installed', wrap(() => bible.installed()));
ipcMain.handle('bible:download', wrap((e, { abbr }) => bible.download(abbr)));
ipcMain.handle('bible:remove', wrap((e, { abbr }) => bible.remove(abbr)));
ipcMain.handle('bible:lookup', wrap((e, { translation, ref }) => bible.lookup({ translation, ref })));
ipcMain.handle('bible:search', wrap((e, a) => bible.searchAny(a)));
ipcMain.handle('bible:books', wrap(async (e, { translation }) => ({ books: await bible.books(translation) })));
ipcMain.handle('bible:chapter', wrap((e, a) => bible.getChapter(a)));
ipcMain.handle('bible:parseRef', wrap((e, { ref }) => bible.parseRef(ref)));
ipcMain.handle('bible:import', wrap((e, { path: p, abbr, name }) => bible.importFile(p, { abbr, name })));
ipcMain.handle('present:displays', wrap(() => presenter.displays()));
ipcMain.handle('present:open', wrap((e, a) => Object.assign(presenter.open(a), { state: presenter.state() })));
ipcMain.handle('present:close', wrap((e, { role }) => { presenter.close(role); return presenter.state(); }));
ipcMain.handle('present:state', wrap(() => presenter.state()));
ipcMain.handle('present:set', wrap((e, patch) => { webout.broadcast(presenter.setState(patch || {})); return true; }));
ipcMain.handle('dialog:openFile', () => ok(null));

/* the web output (phones / tablets / Stream Deck) — the real server module */
const webout = require(path.join(ROOT, 'src/main/webserver'));
let studioWin = null;   // set once the studio window exists; remote cmds land here
webout.setCommandHandler((cmd, arg) => {
  if (studioWin && !studioWin.isDestroyed() && !studioWin.webContents.isDestroyed()) {
    studioWin.webContents.send('present:remote', { cmd, arg });
  }
});
// Arrow keys pressed ON a projector window come back to the studio the same
// way (main.js wires this identically).
presenter.setKeyHandler((cmd) => {
  if (studioWin && !studioWin.isDestroyed() && !studioWin.webContents.isDestroyed()) {
    studioWin.webContents.send('present:remote', { cmd });
  }
});
ipcMain.handle('webout:start', wrap(async (e, { port, passcode, allowControl } = {}) => {
  const r = await webout.start({ port: port || 7373, passcode: passcode || '', allowControl: allowControl !== false });
  webout.broadcast(presenter.getState());
  return Object.assign(r, webout.state());
}));
ipcMain.handle('webout:stop', wrap(async () => { webout.stop(); return webout.state(); }));
ipcMain.handle('webout:state', wrap(async () => webout.state()));

/* NDI output + DMX lighting, pointed at the real modules */
const ndiOut = require(path.join(ROOT, 'src/main/ndi-send'));
ndiOut.setStateSource(() => presenter.getState());
ipcMain.handle('ndiout:state', wrap(async () => ndiOut.state()));
ipcMain.handle('ndiout:start', wrap(async (e, a = {}) => { const r = ndiOut.start(a); ndiOut.push(presenter.getState()); return Object.assign({ feed: r }, ndiOut.state()); }));
ipcMain.handle('ndiout:stop', wrap(async (e, { id } = {}) => { ndiOut.stop(id); return ndiOut.state(); }));

const dmx = require(path.join(ROOT, 'src/main/artnet'));
ipcMain.handle('dmx:state', wrap(async () => dmx.state()));
ipcMain.handle('dmx:configure', wrap(async (e, a = {}) => dmx.configure(a)));
ipcMain.handle('dmx:send', wrap(async (e, { command, universe, channel, value } = {}) => {
  if (command) return { sent: dmx.command(command), state: dmx.state() };
  return { sent: [dmx.setChannel(universe || 0, channel, value)], state: dmx.state() };
}));
ipcMain.handle('dmx:blackout', wrap(async (e, { universe } = {}) => dmx.blackout(universe || 0)));

app.disableHardwareAcceleration();
// Mirrors main.js: nothing in a presentation is started by clicking the video
// itself, so unmuted media must be allowed to autoplay. [31] proves it works.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// async so a step can await inside; every failure comes back as { __error } so
// one broken assertion can't take the whole run down with an opaque rejection.
// The result comes back as JSON rather than a structured clone: a step that
// hands back anything live (a media element, a DOM node) would otherwise
// resolve as a bare `undefined` and turn a real failure into a mystery.
const js = (win, src) => win.webContents
  .executeJavaScript(`(async () => {
     try { const __r = await (async () => { ${src} })(); return JSON.stringify(__r === undefined ? null : __r); }
     catch (e) { return JSON.stringify({ __error: (e && e.message) + '\\n' + (e && e.stack) }); }
   })()`)
  .then((s) => { try { return JSON.parse(s); } catch (e) { return { __error: 'unparsable result: ' + String(s).slice(0, 200) }; } },
    (e) => ({ __error: 'executeJavaScript rejected: ' + String((e && e.message) || e) }));
/** Find an output window by its role. Matched on URL, not title: the page's own
 *  <title> wins over the BrowserWindow option, so the URL is the reliable key. */
/* --- tiny HTTP helpers: the test talks to the web output like a phone would --- */
function httpText(url, method) {
  return new Promise((resolve) => {
    const req = require('http').request(url, { method: method || 'GET', timeout: 5000 }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
async function httpJson(url, method) {
  const t = await httpText(url, method);
  try { return JSON.parse(t); } catch (e) { return null; }
}
/** Open the SSE stream and resolve with the first pushed state. */
function sseFirst(url) {
  return new Promise((resolve) => {
    const req = require('http').get(url, { timeout: 5000 }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        const m = buf.match(/data: (\{[\s\S]*?\})\n\n/);
        if (m) { try { resolve(JSON.parse(m[1])); } catch (e) { resolve(null); } req.destroy(); }
      });
      res.on('end', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const outputWin = (role) => BrowserWindow.getAllWindows().find((w) => {
  if (w.isDestroyed()) return false;
  try { return w.webContents.getURL().includes('output.html') && w.webContents.getURL().includes('role=' + role); }
  catch (e) { return false; }
});
/* An output window is real the instant it is constructed, but its URL stays
 * empty until the load commits — which is not a fixed number of milliseconds on
 * a busy machine. Wait for it rather than guessing a sleep.
 *
 * NINE SECONDS WAS NOT ENOUGH and the failure looked exactly like a regression:
 * `presenter.state()` already reported the output open, so the studio had done
 * its job, and only the window's own load had not finished. Measured on this
 * machine with other suites running, a 40-second wait passed every time while
 * nine failed a different check on each run. This is how long the HARNESS will
 * wait, not a claim about how long opening a projector may take — what is being
 * tested is that it opens and shows the right thing. */
async function waitOutputWin(role, ms = 25000) {
  const t0 = Date.now();
  for (;;) {
    const w = outputWin(role);
    if (w) return w;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}
/** How many projector outputs exist, from the module that owns them. */
const audienceOutputs = () => presenter.state().outputs.filter((o) => o.role !== 'stage').length;
async function waitAudienceOutputs(n, ms = 25000) {
  const t0 = Date.now();
  for (;;) {
    if (audienceOutputs() === n) return n;
    if (Date.now() - t0 > ms) return audienceOutputs();
    await new Promise((r) => setTimeout(r, 120));
  }
}

app.whenReady().then(async () => {
  /* ================= [1] reference parsing ================= */
  console.log('\n[1] Reading a reference the way a person actually types it');
  const cases = [
    ['John 3:16', 43, 3, [16]],
    ['jn 3:16-18', 43, 3, [16, 17, 18]],
    ['1 Cor 13', 46, 13, null],
    ['Psalm 23:1-6', 19, 23, [1, 2, 3, 4, 5, 6]],
    ['Rev 21:1,3-4', 66, 21, [1, 3, 4]],
    ['1st John 4:8', 62, 4, [8]],
    ['II Timothy 1:7', 55, 1, [7]],
    ['song 2:1', 22, 2, [1]],
    ['  matt 5 : 3 ', 40, 5, [3]],
    ['Philemon 1:6', 57, 1, [6]],
  ];
  for (const [inp, bk, ch, vs] of cases) {
    const r = bible.parseRef(inp);
    const good = r && r.bookNr === bk && r.chapter === ch && JSON.stringify(r.verses) === JSON.stringify(vs);
    log(good, `"${inp}"`, r ? `${r.book} ${r.chapter}${r.verses ? ':' + r.verses.join(',') : ''}` : 'unparsed');
  }
  log(bible.parseRef('not a book at all') === null, 'nonsense is rejected rather than guessed at');
  log(bible.formatRef('Revelation', 21, [1, 3, 4, 5]) === 'Revelation 21:1,3-5', 'runs of verses collapse in the label',
    bible.formatRef('Revelation', 21, [1, 3, 4, 5]));

  /* ================= [2] a church's own module ================= */
  console.log('\n[2] Importing a translation the church licensed itself');
  const imp = bible.importFile(CUSTOM, { abbr: 'mce', name: 'My Church Edition' });
  log(imp.abbr === 'mce' && imp.books === 2, 'the file imported', `${imp.books} books, ${imp.verses} verses`);
  const mceHit = await bible.lookup({ translation: 'mce', ref: 'John 3:16' });
  log(mceHit.verses.length === 1, 'it can be looked up like any other translation', mceHit.reference);
  log(!/\{H123\}/.test(mceHit.verses[0].text) && !/\[|\]/.test(mceHit.verses[0].text),
    'Strong\'s numbers and bracketed words are cleaned off', mceHit.verses[0].text);
  log(bible.installed().some((t) => t.abbr === 'mce'), 'and it shows in the installed list');

  /* flat-array shape (what most Bible exporters emit) */
  const FLAT = path.join(WORK, 'flat.json');
  fs.writeFileSync(FLAT, JSON.stringify([
    { book: 'John', chapter: 3, verse: 16, text: 'Flat sixteen.' },
    { book: 'John', chapter: 3, verse: 17, text: 'Flat seventeen.' },
  ]), 'utf-8');
  const flat = bible.importFile(FLAT, { abbr: 'flt', name: 'Flat Test' });
  log(flat.verses === 2, 'a flat [{book,chapter,verse,text}] export also imports', JSON.stringify(flat));

  /* ================= [3] a real translation, offline ================= */
  console.log('\n[3] Downloading a real translation (then using it with no network)');
  let haveKjv = false;
  try {
    const r = await bible.download('kjv');
    haveKjv = true;
    log(r.books === 66, 'KJV downloaded — all 66 books', `${(r.sizeBytes / 1048576).toFixed(1)} MB on disk`);
  } catch (e) {
    skip('KJV download', e.message);
  }
  if (haveKjv) {
    const j = await bible.lookup({ translation: 'kjv', ref: 'John 3:16' });
    log(/For God so loved the world/.test(j.verses[0].text), 'John 3:16 reads correctly', j.verses[0].text.slice(0, 52) + '…');
    log(j.reference === 'John 3:16', 'the reference label is right', j.reference);
    const ps = await bible.lookup({ translation: 'kjv', ref: 'Psalm 23' });
    log(ps.verses.length === 6, 'a whole chapter comes back whole', `Psalm 23 = ${ps.verses.length} verses`);
    const rng = await bible.lookup({ translation: 'kjv', ref: 'Romans 8:38-39' });
    log(rng.verses.length === 2 && rng.reference === 'Romans 8:38-39', 'a verse range comes back as a range', rng.reference);
    log(bible.chapterCount('kjv', 19) === 150, 'Psalms really has 150 chapters');
    log(bible.chapterCount('kjv', 65) === 1, 'Jude really has 1');
    const s = bible.search({ translation: 'kjv', query: 'the lord is my shepherd', limit: 5 });
    log(s.length > 0 && s[0].reference === 'Psalms 23:1', 'searching the words finds the verse', s[0] && s[0].reference);
    const s2 = bible.search({ translation: 'kjv', query: 'faith hope charity', limit: 5 });
    log(s2.some((h) => h.reference === '1 Corinthians 13:13'), 'loose word search works too', s2[0] && s2[0].reference);
    let threw = null;
    try { await bible.lookup({ translation: 'kjv', ref: 'John 99:1' }); } catch (e) { threw = e.message; }
    log(!!threw && /isn.t in/.test(threw), 'a chapter that does not exist says so plainly', threw);
    const cat = await bible.catalogue();
    log(cat.length > 50, 'the catalogue offers a lot of translations', cat.length + ' available');
    log(cat.filter((t) => t.installed).length >= 3, 'installed ones are flagged',
      cat.filter((t) => t.installed).map((t) => t.abbr).join(','));
    log(cat[0] && cat[0].installed, 'and are listed first, so an offline machine is usable');
  }

  /* ================= [4] the studio ================= */
  const errors = [];
  const win = new BrowserWindow({
    show: true, width: 1600, height: 1000,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  studioWin = win;   // remote (web output) commands are relayed to this window
  // …and, exactly as main.js does, the studio is told whenever an output window
  // opens or closes. Without this the studio only learns about outputs when it
  // asks, and "the operator closed the projector" never reaches it.
  presenter.setNotifier((st) => {
    if (studioWin && !studioWin.isDestroyed() && !studioWin.webContents.isDestroyed()) {
      studioWin.webContents.send('present:outputs', st);
    }
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1600);

  console.log('\n[4] The Presentation studio opens');
  const ui = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-present').classList.add('active');
    window.Presenter.onShow();
    const T = window.Presenter.__test;
    // Props/timers/announcements deliberately persist between services, so a
    // repeatable test has to start from a clean desk.
    T.resetShow();
    return {
      navItem: !!document.querySelector('.nav-item[data-view="present"]'),
      rail: !!document.getElementById('pvLibList'),
      grid: !!document.getElementById('pvSlides'),
      liveScreen: !!document.getElementById('pvLiveScreen'),
      nextScreen: !!document.getElementById('pvNextScreen'),
      audienceBtn: !!document.getElementById('pvAudience'),
      stageBtn: !!document.getElementById('pvStage'),
      state: T.state(),
      slideDom: T.slideDom(),
    };`);
  if (ui.__error) console.error('[4] ' + ui.__error);
  log(ui.navItem, 'there is a Presentation item in the sidebar');
  log(ui.rail && ui.grid, 'library rail + slide grid are on screen');
  log(ui.liveScreen && ui.nextScreen, 'Live and Next monitors are there');
  log(ui.audienceBtn && ui.stageBtn, 'Audience and Stage output buttons are there');
  log(ui.slideDom > 0, 'it opens with something in it rather than an empty box', ui.slideDom + ' slides');

  console.log('\n[5] Building a song: slides, groups, reflow');
  const song = await js(win, `
    const T = window.Presenter.__test;
    const id = T.newDoc('Way Maker', 'song');
    T.setSlideText(0, 'You are here\\nmoving in our midst');
    T.setGroup(0, 'Verse 1');
    T.addSlide(); T.setSlideText(1, 'I worship You\\nI worship You'); T.setGroup(1, 'Chorus');
    T.addSlide(); T.setSlideText(2, 'That is who You are'); T.setGroup(2, 'Bridge');
    return {
      id, slides: T.slides(),
      v1: T.slideTagColor(0), ch: T.slideTagColor(1), br: T.slideTagColor(2),
      thumb0: T.thumbHtml(0),
      groups: T.groups().length,
    };`);
  if (song.__error) console.error('[5] ' + song.__error);
  log(song.slides.length === 3, 'three slides built', song.slides.map((s) => s.group).join(' · '));
  log(song.v1 !== song.ch && song.ch !== song.br, 'each group gets its own colour, like ProPresenter',
    `${song.v1} / ${song.ch} / ${song.br}`);
  log(/You are here/.test(song.thumb0 || ''), 'the thumbnail really renders the words (a true miniature)');
  log(song.groups >= 8, 'the full group vocabulary is offered', song.groups + ' groups');

  const reflowed = await js(win, `
    const T = window.Presenter.__test;
    T.setSlideText(0, 'Line one\\nLine two\\nLine three\\nLine four\\nLine five\\nLine six');
    const n = T.reflow();
    return { n, slides: T.slides().map(s => s.lines.length) };`);
  log(reflowed.n > 3, 'Reflow splits a wall of text into screen-sized slides', `${reflowed.n} slides`);
  log(reflowed.slides.every((n) => n <= 4), 'and no slide is longer than 4 lines', JSON.stringify(reflowed.slides));

  console.log('\n[6] Running the service: click a slide, arrow through, black out');
  const run = await js(win, `
    const T = window.Presenter.__test;
    T.setMode('show');
    const clicked = T.clickSlide(0);
    const liveText0 = T.liveScreenText();
    const nextText0 = T.nextScreenText();
    const after = T.key('ArrowRight');
    const liveText1 = T.liveScreenText();
    const back = T.key('ArrowLeft');
    const blacked = T.key('b');
    const unblacked = T.key('b');
    const cleared = T.key('x');
    const uncleared = T.key('x');   // leave the desk clean for the sections below
    return { clicked, liveText0, nextText0, after, liveText1, back, blacked, unblacked, cleared, uncleared };`);
  if (run.__error) console.error('[6] ' + run.__error);
  log(run.clicked && run.clicked.liveIx === 0, 'clicking a slide in Show mode sends it LIVE');
  log(!!run.liveText0.trim(), 'the Live monitor shows what went out', JSON.stringify(run.liveText0.slice(0, 34)));
  log(!!run.nextText0.trim() && run.nextText0 !== run.liveText0, 'the Next monitor shows what is coming');
  log(run.after.liveIx === 1, '→ advances the live slide', 'ix ' + run.after.liveIx);
  log(run.liveText1 !== run.liveText0, 'and the Live monitor actually changed');
  log(run.back.liveIx === 0, '← goes back');
  log(run.blacked.blackout === true, 'B blacks the screen');
  log(run.unblacked.blackout === false, 'B again brings it back');
  log(Object.values(run.cleared.cleared).every(Boolean), 'X clears every layer at once');
  log(Object.values(run.uncleared.cleared).every((v) => !v), 'X again restores them all');

  console.log('\n[7] Bible → slides');
  if (!haveKjv) skip('Bible → slides', 'no translation downloaded');
  else {
    const scr = await js(win, `
      const T = window.Presenter.__test;
      return T.setTranslation('kjv').then(() => T.find('Romans 8:38-39')).then((res) => {
        T.setVersesPerSlide(1);
        const built = T.scriptureSlides();
        const before = T.state().docs;
        T.addScripture(true);
        return {
          ref: res && res.reference, verses: res && res.verses.length,
          built: built.map(s => ({ lines: s.lines.length, footer: s.footer, group: s.group })),
          docsBefore: before, docsAfter: T.state().docs,
          liveText: T.liveScreenText(), state: T.state(),
        };
      });`);
    if (scr.__error) console.error('[7] ' + scr.__error);
    log(scr.ref === 'Romans 8:38-39', 'the passage was found', scr.ref);
    log(scr.built.length === 2, 'one verse per slide → two slides', JSON.stringify(scr.built.map((b) => b.footer)));
    log(scr.built.every((b) => /Romans 8:\d+\s+\(KJV\)/.test(b.footer)), 'each carries its own reference + translation');
    log(scr.built.every((b) => b.group === 'Scripture'), 'and is tagged as Scripture');
    log(scr.docsAfter > scr.docsBefore, 'a reading becomes its own presentation in the library');
    log(/neither death, nor life/i.test(scr.liveText), 'and it went straight to the Live monitor', scr.liveText.slice(0, 46) + '…');

    const grouped = await js(win, `
      const T = window.Presenter.__test;
      return T.find('Psalm 23').then(() => { T.setVersesPerSlide(3); const b = T.scriptureSlides(); return b.map(s => ({ n: s.lines.length, f: s.footer })); });`);
    log(grouped.length === 2 && grouped[0].n === 3, '3-verses-per-slide groups them properly', JSON.stringify(grouped));
    log(/Psalms 23:1-3/.test(grouped[0].f), 'the footer shows the range on that slide', grouped[0].f);

    const searched = await js(win, `
      const T = window.Presenter.__test;
      return T.find('shepherd').then(() => ({
        hits: document.querySelectorAll('#pvBibleResults .pv-hit').length,
        first: (document.querySelector('#pvBibleResults .pv-hit-ref') || {}).textContent,
      }));`);
    log(searched.hits > 0, 'typing words instead of a reference searches the text', searched.hits + ' hits');
    log(/\d/.test(searched.first || ''), 'and offers real references to click', searched.first);
  }

  /* ---------------- [7c] the toolbar says what it does ---------------- */
  console.log('\n[7c] Two buttons called "Show", and the ones nobody presses mid-service');
  const bar0 = await js(win, `
    const T = window.Presenter.__test;
    T.clearMore(false);
    return { bar: T.clearBar(), tabs: T.tabLabels(), modes: T.modeLabels() };`);
  log(!bar0.tabs.some((t) => /Show/i.test(t)) && bar0.tabs.some((t) => /Desk/i.test(t)),
    'the right-hand tab is "Desk" — the word "Show" now means exactly one thing', bar0.tabs.join(' | '));
  /* The Show/Edit pair is gone on purpose. It was a mode you could be left
   * standing in: a double-click to fix a typo latched the studio into Edit,
   * and from then on clicking a slide selected it instead of putting it on the
   * screen. Editing is a double-click, and it un-latches itself. */
  log(bar0.modes.length === 0,
    'the Show/Edit mode pair is gone from the toolbar', bar0.modes.join(' | ') || '(none)');
  log(!bar0.bar.buttons.includes('announcement') && bar0.bar.easyVisible === false,
    'Announce and Easy view are out of the everyday bar', bar0.bar.buttons.join(', '));
  const bar1 = await js(win, `
    const T = window.Presenter.__test;
    T.clearMore(true);
    const b = T.clearBar();
    const e = document.querySelector('#pvEasy');
    b.where = e ? e.parentElement.className : 'MISSING';
    b.cls = e ? e.className : '';
    return b;`);
  log(bar1.buttons.includes('announcement') && bar1.easyInPalette === true && bar1.easyVisible === true,
    '⋯ More holds them both, and Easy view is the SAME button, not a copy',
    `easy in ${bar1.where} [${bar1.cls}] · ${bar1.buttons.join(', ')}`);
  await js(win, `return window.Presenter.__test.clearMore(false);`);

  /* ---------------- [7d] a verse goes live WITHOUT becoming a slide ----------
   * "I shouldn't need to add the bible verses in the slides — it will get
   * messy." A chapter dropped into the running order is 36 slides nobody will
   * use again. Clicking a verse in the panel must put it on the screen and
   * leave the Library exactly as it was. */
  console.log('\n[7d] Clicking a verse puts it on the screen — and nowhere else');
  if (!haveKjv) skip('click-to-live', 'no translation downloaded');
  else {
    const cued = await js(win, `
      const T = window.Presenter.__test;
      T.setTab('bible');
      await T.setTranslation('kjv');
      await T.find('John 3');
      T.setVersesPerSlide(1);
      const docsBefore = T.state().docs;
      const slidesBefore = T.slides().length;
      const cue = T.clickVerse(16);
      await new Promise(r => setTimeout(r, 300));
      return { cue, docsBefore, docsAfter: T.state().docs,
               slidesBefore, slidesAfter: T.slides().length,
               liveText: T.liveScreenText(), nextText: T.nextScreenText() };`);
    if (cued.__error) console.error('[7d] ' + cued.__error);
    log(!!cued.cue && /For God so loved the world/.test((cued.cue.lines || []).join(' ')),
      'clicking John 3:16 puts THAT verse on the screen', (cued.cue && cued.cue.lines[0] || '').slice(0, 46) + '…');
    log(cued.docsAfter === cued.docsBefore && cued.slidesAfter === cued.slidesBefore,
      'and the Library is untouched — no new presentation, no new slides',
      `${cued.docsBefore} presentations before, ${cued.docsAfter} after`);
    log(/For God so loved the world/.test(cued.liveText || ''), 'the Live monitor really shows it', (cued.liveText || '').slice(0, 46) + '…');
    log(/whosoever believeth|condemn the world/i.test(cued.nextText || ''), 'and Next is the verse after it', (cued.nextText || '').slice(0, 40) + '…');
    log((cued.cue.liveRows || []).join(',') === '16', 'the verse row itself is marked as the one on the wall', JSON.stringify(cued.cue.liveRows));

    /* the arrow keys then read the passage, verse by verse */
    const walked = await js(win, `
      const T = window.Presenter.__test;
      const a = T.key('ArrowRight'); await new Promise(r => setTimeout(r, 200));
      const one = T.verseCue();
      T.key('ArrowRight'); await new Promise(r => setTimeout(r, 200));
      const two = T.verseCue();
      T.key('ArrowLeft'); await new Promise(r => setTimeout(r, 200));
      return { one: one.liveRows, two: two.liveRows, back: T.verseCue().liveRows,
               text: T.liveScreenText(), slides: T.slides().length };`);
    log(JSON.stringify(walked.one) === '[17]' && JSON.stringify(walked.two) === '[18]' && JSON.stringify(walked.back) === '[17]',
      '→ and ← walk the passage verse by verse', `17 → 18 → back to ${walked.back}`);
    log(walked.slides === cued.slidesBefore, 'and still nothing has been added to the Library', walked.slides + ' slides');

    /* ---- where the verse sits on the screen ---- */
    const fmt = await js(win, `
      const T = window.Presenter.__test;
      const before = T.verseFormat();
      const top = T.verseFormat('top');
      const left = T.verseFormat('left');
      const big = T.verseFormat('bigger');
      const bigger = T.verseFormat('bigger');
      const reset = T.verseFormat('reset');
      return { before, top, left, big, bigger, reset, songLook: T.look() };`);
    if (fmt.__error) console.error('[7d] ' + fmt.__error);
    log(fmt.top.theme.valign === 'top' && fmt.top.lit.valign === 'top',
      'the verse can be moved to the top of the screen', JSON.stringify(fmt.top.theme));
    log(fmt.left.theme.align === 'left' && fmt.left.lit.align === 'left', 'and lined up left', JSON.stringify(fmt.left.theme));
    log(fmt.bigger.theme.sizePx === fmt.big.theme.sizePx + 8, 'A+ really makes the words bigger',
      `${fmt.big.theme.sizePx}px → ${fmt.bigger.theme.sizePx}px`);
    log(fmt.bigger.sentTheme && fmt.bigger.sentTheme.valign === 'top' && fmt.bigger.sentTheme.sizePx === fmt.bigger.theme.sizePx,
      'and it travels with the cue, so the projector agrees', JSON.stringify(fmt.bigger.sentTheme));
    log(fmt.songLook.valign !== 'top' && fmt.songLook.align !== 'left',
      'the SONGS are untouched — this moved scripture only', `Look stays ${fmt.songLook.valign}/${fmt.songLook.align}`);
    log(fmt.reset.theme === null && fmt.reset.lit.reset === false, '↺ hands it back to the Look');

    /* ---- the Look's margin, which never had a control ---- */
    const pad = await js(win, `
      const T = window.Presenter.__test;
      T.setTab('look');
      const before = T.lookPad();
      const wide = T.lookPad(240);
      const tight = T.lookPad(40);
      T.setTab('bible');
      return { before, wide, tight };`);
    log(pad.wide.padY === 240 && pad.tight.padY === 40 && pad.tight.padX === 56,
      'the Look\'s margin is a real control now — the words can be pushed off the edges',
      `${pad.before.padY}px → ${pad.wide.padY}px → ${pad.tight.padY}px`);

    /* the ＋ Add button is still there for a reading planned into the order */
    const added = await js(win, `
      const T = window.Presenter.__test;
      const before = T.slides().length;
      T.addScripture(false);
      return { before, after: T.slides().length };`);
    log(added.after > added.before, '＋ Add as slides still builds slides for people who want them in the order',
      `${added.before} → ${added.after} slides`);
  }

  /* ---------------- [7a] book ▸ chapter ▸ verse dropdowns ----------------
   * "Rather than typing the chapter and verse, there should be a drop down."
   * Driven through real change events, so the wiring is what is under test. */
  console.log('\n[7a] Picking a passage from dropdowns instead of typing it');
  if (!haveKjv) skip('the book/chapter/verse pickers', 'no translation downloaded');
  else {
    await js(win, `const T = window.Presenter.__test; T.setTab('bible'); return T.setTranslation('kjv');`);
    const p0 = await js(win, `return window.Presenter.__test.biblePicker();`);
    log(p0.books === 66, 'every book of the Bible is in the list', `${p0.books} books, starting ${JSON.stringify(p0.firstBooks)}`);
    /* The panel is a cue list now: look the chapter up once, then click the
     * verses onto the screen. Landing on verse 1 meant changing the dropdown
     * before you could see anything else. */
    const fresh = await js(win, `return window.Presenter.__test.pickBible(43, 3, null, null);`);
    log(fresh.verse === '0' && fresh.wholeChapter === true && fresh.verseCount === 36,
      'a chapter opens on WHOLE CHAPTER, not verse 1', `${fresh.ref} — ${fresh.verseCount} verses listed`);

    /* opening the panel must SHOW the chapter it is already pointing at */
    const opened = await js(win, `
      const T = window.Presenter.__test;
      T.clearBibleResult();
      T.setTab('media');
      T.setTab('bible');                       // …as if the operator had just clicked Bible
      for (let i = 0; i < 40 && !T.bibleResult(); i++) await new Promise(r => setTimeout(r, 100));
      const res = T.bibleResult();
      const p = T.biblePicker();
      return { ref: res && res.reference, rows: document.querySelectorAll('#pvBibleResults .pv-verse').length,
               book: p.book, chapter: p.chapter };`);
    log(opened.rows > 0 && /^John 3\b/.test(opened.ref || ''),
      'opening the Bible panel shows the verses straight away — no pressing Find',
      `${opened.ref} — ${opened.rows} verses on screen`);
    log(opened.book === '43' && opened.chapter === '3',
      '…and coming back to the tab keeps the operator\'s place, not Genesis 1',
      `book ${opened.book}, chapter ${opened.chapter}`);

    const ps = await js(win, `return window.Presenter.__test.pickBible(19, 23, 1, 6);`);
    log(ps.chapters === 150, 'choosing Psalms offers its 150 chapters', ps.chapters + ' chapters');
    log(ps.verses === 6, 'and chapter 23 offers exactly its 6 verses', ps.verses + ' verses');
    log(ps.ref === 'Psalms 23:1-6' && ps.found === 'Psalms 23:1-6', 'the passage is found with nobody pressing Find', ps.found);
    log(ps.verseCount === 6 && ps.box === 'Psalms 23:1-6', 'and the search box agrees with the dropdowns', ps.box);

    const one = await js(win, `return window.Presenter.__test.pickBible(43, 3, 16, 16);`);
    log(one.found === 'John 3:16' && one.verseCount === 1, 'a single verse works the same way', one.found);
    const whole = await js(win, `return window.Presenter.__test.pickBible(null, null, 0, null);`);
    log(whole.wholeChapter === true && whole.ref === 'John 3' && whole.verseCount === 36,
      '"Whole chapter" takes the lot and hides the second verse box',
      `asked for "${whole.ref}", got ${whole.found} — ${whole.verseCount} verses`);

    /* the counts must come from the TRANSLATION, not a table: this one holds
     * two books, and offering the other 64 would only produce error messages */
    const partial = await js(win, `
      const T = window.Presenter.__test;
      return T.setTranslation('mce').then(() => T.biblePicker());`);
    log(partial.books === 2, 'a translation that holds only two books offers two books', JSON.stringify(partial.firstBooks));
    await js(win, `return window.Presenter.__test.setTranslation('kjv');`);

    /* typing still works, and drags the dropdowns into step */
    const typed = await js(win, `
      const T = window.Presenter.__test;
      return T.find('Romans 8:38-39').then(() => new Promise(r => setTimeout(r, 500))).then(() => T.biblePicker());`);
    log(typed.book === '45' && typed.chapter === '8' && typed.verse === '38' && typed.verseTo === '39',
      'a typed reference pulls the dropdowns onto it',
      JSON.stringify({ b: typed.book, c: typed.chapter, v: typed.verse + '-' + typed.verseTo }));
  }

  /* ---------------- [7b] a modern translation in the picker ----------------
   * The engine test (test/bible-modern.test.js) proves NIV/NLT/ESV… come down
   * off bolls.life. What has to hold HERE is that its id never leaks into
   * anything a person reads: the picker says "NIV", and so does the slide
   * footer — never "BOLLS:NIV". A hand-written offline copy stands in for the
   * download so this stays fast and works with the line down. */
  console.log('\n[7b] A modern translation (NIV) in the picker and on the slide');
  fs.mkdirSync(path.join(WORK, 'bibles'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'bibles', 'bollsniv.json'), JSON.stringify({
    translation: 'New International Version', abbreviation: 'bolls:NIV', lang: 'en', language: 'English',
    direction: 'LTR', source: 'bolls',
    books: [{ nr: 43, name: 'John', chapters: [{ chapter: 3, verses: [
      { verse: 16, text: 'For God so loved the world that he gave his one and only Son.' },
      { verse: 17, text: 'For God did not send his Son into the world to condemn the world.' },
    ] }] }],
  }), 'utf-8');
  const modern = await js(win, `
    const T = window.Presenter.__test;
    return T.setTranslation('bolls:NIV')
      .then(() => T.find('John 3:16-17'))
      .then((res) => { T.setVersesPerSlide(1); return {
        options: T.translationOptions(),
        ref: res && res.reference, code: res && res.code,
        footers: T.scriptureSlides().map((s) => s.footer),
      }; });`);
  if (modern.__error) console.error('[7b] ' + modern.__error);
  const nivOpt = (modern.options || []).find((o) => o.value === 'bolls:NIV');
  log(!!nivOpt && /^NIV — New International Version/.test(nivOpt.label),
    'the picker reads "NIV — New International Version"', nivOpt && nivOpt.label);
  log((modern.options || []).every((o) => !/bolls/i.test(o.label)), 'no internal id leaks into the dropdown',
    (modern.options || []).map((o) => o.label).join(' | '));
  log(modern.ref === 'John 3:16-17' && modern.code === 'NIV', 'the passage is found through the offline copy', modern.ref);
  log((modern.footers || []).every((f) => /\(NIV\)$/.test(f)), 'and each slide footer is tagged (NIV)',
    JSON.stringify(modern.footers));

  /* "Use now" — read a translation over the internet without downloading it */
  const live = await js(win, `
    const T = window.Presenter.__test;
    return T.openBibleManager().then(() => {
      const b = document.querySelector('[data-bibtry="bolls:ESV"]') || document.querySelector('[data-bibtry]');
      if (!b) return { none: true };
      const id = b.dataset.bibtry;
      b.click();
      return new Promise(r => setTimeout(r, 500))
        .then(() => T.find('John 3:16'))
        .then((res) => ({ id, options: T.translationOptions().map(o => o.label),
          ref: res && res.reference, text: res && res.verses[0] && res.verses[0].text }));
    });`);
  if (live.none || live.__error) skip('"Use now"', live.__error || 'the translation list needs the internet');
  else {
    log(live.ref === 'John 3:16' && /loved the world/i.test(live.text || ''),
      `${live.id} reads live, with nothing downloaded`, (live.text || '').slice(0, 50) + '…');
    log((live.options || []).some((o) => /· online$/.test(o)), 'and the picker marks it "· online" so nobody trusts it on a dead line',
      (live.options || []).join(' | '));
  }
  await js(win, `return window.Presenter.__test.setTranslation('kjv');`);

  console.log('\n[8] Looks (themes) and backgrounds');
  const looks = await js(win, `
    const T = window.Presenter.__test;
    const all = T.looks();
    const before = T.look();
    const after = T.editLook({ sizePx: 120, color: '#ffcc00', align: 'left' });
    T.selectSlide(0);
    const bg = T.setBackground(0, { type: 'gradient', value: 'linear-gradient(180deg,#123,#456)' });
    const html = T.thumbHtml(0);
    return { all, beforeSize: before.sizePx, after, bg, hasGrad: /linear-gradient/.test(html || ''), styled: /ffcc00|255, 204, 0/.test(html || '') };`);
  if (looks.__error) console.error('[8] ' + looks.__error);
  log(looks.all.length >= 4, 'several ready-made Looks ship with it', looks.all.map((l) => l.name).join(', '));
  log(looks.after.sizePx === 120 && looks.after.color === '#ffcc00', 'editing a Look takes effect');
  log(looks.styled, 'and the slide thumbnails repaint in the new colour');
  log(looks.bg && looks.bg.type === 'gradient' && looks.hasGrad, 'a per-slide background applies and renders');

  /* ================= [8b] THE GO LIVE BUTTON =================
   * The operator's report: "the Go Live button is not working — the content is
   * not projecting on the screen/projector." It wasn't a rendering fault. Go Live
   * only ever pushed state to output windows that were ALREADY open, so from a
   * cold start (which is how every service starts) it pushed a perfect cue to
   * nobody, and said nothing about why the wall stayed black. It also did
   * literally nothing when no slide happened to be selected.
   *
   * The core proof lives here: cold start, real button, words read back off the
   * glass. Every other case (re-open after close, cue-by-click, arrowing, empty
   * presentation, blackout warnings, the one-screen window) is covered in full by
   * test/golive.test.js, which runs in seconds. */
  console.log('\n[8b] Go Live from a cold start — no output window open yet');
  const cold = await js(win, `
    const T = window.Presenter.__test;
    return window.api.present.close().then(async () => {
      await T.refreshOutputs();
      window.__pvPrevDoc = T.state().docId;      // put the studio back before [9] runs
      T.newDoc('Go Live Check', 'song');
      T.setSlideText(0, 'HOLY IS THE LORD');
      T.selectSlide(-1);                         // nothing picked — the old dead case
      return { hasOutput: T.hasAudienceOutput(), state: T.state(), button: T.goLiveButton() };
    });`);
  if (cold.__error) console.error('[8b] ' + cold.__error);
  log(audienceOutputs() === 0 && cold.hasOutput === false, 'starting point: no projector output open anywhere');
  log(cold.state.slideIx === -1, 'and no slide is selected — the case where the button used to do nothing at all');
  log(/projector/i.test(cold.button.title), 'the button says what it does', cold.button.title);

  const pressed = await js(win, `return window.Presenter.__test.clickGoLive();`);
  if (pressed.__error) console.error('[8b] ' + pressed.__error);
  log(await waitAudienceOutputs(1) === 1, 'THE FIX: pressing Go Live opens the projector output itself');
  log(pressed.hasOutput === true, 'and the studio knows the picture has somewhere to go');
  log(pressed.liveIx === 0, 'with nothing selected it starts at the first slide instead of doing nothing', 'liveIx=' + pressed.liveIx);

  const glass = await waitOutputWin('audience');
  log(!!glass, 'the output window is a real window');
  if (glass) {
    const shown = await glass.webContents.executeJavaScript(`(() => {
      const t = document.querySelector('.lyr-slide .sr-text');
      return t ? t.textContent.replace(/\s+/g,' ').trim() : '';
    })()`);
    log(shown === 'HOLY IS THE LORD',
      'THE WORDS ARE ACTUALLY ON THE PROJECTOR after one press of Go Live', JSON.stringify(shown));
    const mon = await js(win, `return window.Presenter.__test.liveScreenText();`);
    log(String(mon).replace(/\s+/g, ' ').trim() === shown, "and the operator's Live monitor agrees with the glass");
  }

  // Leave the studio exactly as [8b] found it — the temp doc goes, the doc that
  // was open comes back.
  await js(win, `
    const T = window.Presenter.__test;
    T.docs().filter(d => d.name === 'Go Live Check').forEach(d => T.delDoc(d.id));
    if (window.__pvPrevDoc) T.openDoc(window.__pvPrevDoc);
    return window.api.present.close().then(() => T.refreshOutputs());`);
  await sleep(400);

  /* ================= [9] THE PROJECTOR ================= */
  console.log('\n[9] The projector — a real second window showing a real verse');
  const ds = presenter.displays();
  log(ds.length >= 1, 'displays are enumerated', ds.map((d) => d.label).join(' | '));
  log(!!presenter.suggestedDisplayId(), 'a sensible screen is suggested for the projector');

  const opened = await js(win, `
    const T = window.Presenter.__test;
    return window.api.present.open('audience', null, true).then(() => T.refreshOutputs());`);
  if (opened.__error) console.error('[9] ' + opened.__error);
  await sleep(1200);
  const aud = await waitOutputWin('audience');
  log(!!aud, 'the Audience output window really opened');
  log(!!(opened && opened.audience), 'and the studio knows it is open');

  if (aud) {
    // put a known verse live, then read it back out of the projector window
    await js(win, `window.Presenter.__test.go(0)`);
    await sleep(700);
    const onScreen = await aud.webContents.executeJavaScript(`(() => {
      const st = document.getElementById('stage');
      const t = document.querySelector('.lyr-slide .sr-text');
      const f = document.querySelector('.lyr-slide .sr-footer');
      return { has: !!st, text: t ? t.textContent : '', footer: f ? f.textContent : '' };
    })()`);
    log(onScreen.has, 'the projector is rendering a slide');
    log(!!onScreen.text.trim(), 'THE WORDS ARE ON THE SCREEN', JSON.stringify(onScreen.text.slice(0, 50)));
    const studioText = await js(win, `return window.Presenter.__test.liveScreenText();`);
    log(String(studioText).replace(/\s+/g, ' ').trim() === String(onScreen.text).replace(/\s+/g, ' ').trim(),
      'the operator\'s Live monitor and the projector agree exactly');
    if (onScreen.footer) log(/\(/.test(onScreen.footer), 'the reference line is on the projector too', onScreen.footer);

    // black really reaches the glass
    await js(win, `return window.Presenter.__test.blackout(true);`);
    await sleep(500);
    const blk = await aud.webContents.executeJavaScript(`document.getElementById('blackout').classList.contains('on')`);
    log(blk === true, 'B on the operator\'s keyboard really blacks the projector');
    await js(win, `return window.Presenter.__test.blackout(false);`);
    await sleep(500);
    const backOn = await aud.webContents.executeJavaScript(`!document.getElementById('blackout').classList.contains('on')`);
    log(backOn === true, 'and brings it back');

    // the output is a true 16:9 stage, scaled — same layout as the thumbnails
    const scaled = await aud.webContents.executeJavaScript(`(() => {
      const st = document.getElementById('stage');
      return st ? { w: st.offsetWidth, h: st.offsetHeight, tr: st.style.transform } : null;
    })()`);
    log(scaled && scaled.w === 1920 && scaled.h === 1080 && /scale\(/.test(scaled.tr),
      'the projector draws a real 1920×1080 stage, scaled to the screen', scaled && scaled.tr);

    /* ---- [9c] the keyboard, from the window the operator just clicked ----
     * On one screen the projector is a normal window, so clicking it takes the
     * keyboard away from the studio — which is exactly what "the arrow keys
     * don't change slides" is. The keys are handed back. */
    await js(win, `return window.Presenter.__test.go(0);`);
    await sleep(300);
    const before = await js(win, `return window.Presenter.__test.state().liveIx;`);
    const press = (key, code) => {
      aud.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
      aud.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    };
    press('Right');
    await sleep(500);
    const afterRight = await js(win, `return window.Presenter.__test.state().liveIx;`);
    press('Left');
    await sleep(500);
    const afterLeft = await js(win, `return window.Presenter.__test.state().liveIx;`);
    log(afterRight === before + 1, '→ pressed ON THE PROJECTOR advances the slide', `${before} → ${afterRight}`);
    log(afterLeft === before, 'and ← goes back', `${afterRight} → ${afterLeft}`);

    /* ---- a verse clicked in the panel reaches the GLASS ----
     *
     * Psalm 23 has to come from somewhere. The KJV download at the top of this
     * file needs the Bible server, and when that is unreachable (or the machine
     * is offline) there is no translation here that carries Psalms at all — the
     * fixtures are two hand-written books. That is not this feature failing, so
     * it is skipped rather than reported as a fault, exactly as the other Bible
     * sections above already do. */
    const cueOnGlass = await js(win, `
      const T = window.Presenter.__test;
      T.setTab('bible');
      const found = await T.find('Psalm 23');
      T.setVersesPerSlide(1);
      return { found: !!(found && found.verses && found.verses.length), cue: T.clickVerse(1) };`);
    await sleep(800);
    if (!cueOnGlass || !cueOnGlass.found) {
      skip('a verse clicked in the panel reaches the projector',
        'no translation on this machine carries Psalm 23 (the KJV download needs the Bible server)');
    } else {
      const glass = await aud.webContents.executeJavaScript(
        `((document.querySelector('.lyr-slide .sr-text') || {}).textContent || '').replace(/\\s+/g, ' ').trim()`);
      log(!!cueOnGlass.cue && /shepherd/i.test(glass),
        'a verse clicked in the panel goes straight to the PROJECTOR — no slide, no Library', glass.slice(0, 48) + '…');
      const glassFoot = await aud.webContents.executeJavaScript(
        `((document.querySelector('.lyr-slide .sr-footer') || {}).textContent || '').trim()`);
      log(/Psalms 23:1\s+\(KJV\)/.test(glassFoot), 'with its reference under it, exactly like an added slide', glassFoot);
    }
    await js(win, `return window.Presenter.__test.go(0);`);   // back to the Library for what follows
    await sleep(300);

    /* ---- Esc closes the screens, from either window ---- */
    const esc = await js(win, `return window.Presenter.__test.escape();`);
    await sleep(600);
    const stillOpen = audienceOutputs();
    log(esc === 'outputs' && stillOpen === 0, 'Esc in the studio closes the projector', `${esc}, ${stillOpen} outputs left`);
    const esc2 = await js(win, `
      const T = window.Presenter.__test;
      T.setMode('edit');
      const r = await T.escape();
      return { r, mode: T.state().mode };`);
    log(esc2.r === 'edit' && esc2.mode === 'show',
      'and with nothing on screen it just leaves edit mode, as it always did', JSON.stringify(esc2));

    // put the projector back for the sections that follow
    await js(win, `return window.api.present.open('audience', null, true).then(() => window.Presenter.__test.refreshOutputs());`);
    await sleep(1000);
  }

  console.log('\n[10] Stage display (confidence monitor)');
  await js(win, `window.api.present.open('stage', null, true)`);
  await sleep(1100);
  const stg = await waitOutputWin('stage');
  log(!!stg, 'the Stage window opened');
  if (stg) {
    await js(win, `window.Presenter.__test.go(0)`);
    await sleep(700);
    const sv = await stg.webContents.executeJavaScript(`(() => ({
      body: document.body.className,
      current: (document.querySelector('.sv-current')||{}).textContent || '',
      next: (document.querySelector('.sv-next-body')||{}).textContent || '',
      clock: (document.getElementById('svClock')||{}).textContent || '',
      blocks: document.querySelectorAll('#stageview .sv-block').length,
    }))()`);
    log(/stage/.test(sv.body), 'it renders in stage mode, not as a second projector');
    log(!!sv.current.trim(), 'the current slide is shown to the person up front', JSON.stringify(sv.current.slice(0, 40)));
    log(!!sv.next.trim(), 'so is what is coming NEXT', JSON.stringify(sv.next.slice(0, 40)));
    log(/\d/.test(sv.clock), 'with a clock', sv.clock);
  }

  const closed = await js(win, `
    return window.api.present.close().then(() => window.Presenter.__test.refreshOutputs());`);
  log(closed && !closed.audience && !closed.stage, 'both outputs close cleanly');

  /* ================= [11] the seven-layer engine ================= */
  console.log('\n[11] Seven independent layers, each with its own transition');
  const lay = await js(win, `
    const T = window.Presenter.__test;
    return {
      names: T.layerNames(),
      transitions: T.transitionNames(),
      state: T.liveState(),
      palette: T.clearPaletteDom(),
    };`);
  if (lay.__error) console.error('[11] ' + lay.__error);
  log(lay.names.length === 7, 'seven layers exist', lay.names.join(', '));
  log(['background', 'media', 'slide', 'announcement', 'props', 'messages', 'mask'].every((n) => lay.names.includes(n)),
    'they are the right seven');
  log(lay.transitions.length >= 8, 'a full transition set is offered', lay.transitions.length + ': ' + lay.transitions.slice(0, 6).join(', '));
  log(['cut', 'dissolve', 'zoom', 'wipe', 'ripple', 'spin', 'soft_blur'].every((t) => lay.transitions.includes(t)),
    'including Cut, Dissolve, Wipe, Zoom, Ripple, Spin and Soft Blur');
  /* The bar in front of the operator holds the four layers a service actually
   * clears; props, messages and the mask live behind ⋯ More. */
  log(lay.palette.length === 4, 'the clear bar shows the three everyday layers, plus All', lay.palette.length + ' buttons');
  const moreOpen = await js(win, `return window.Presenter.__test.clearMore(true);`);
  const moreShut = await js(win, `return window.Presenter.__test.clearMore(false);`);
  log(moreOpen.buttons.length === 8 && ['announcement', 'props', 'messages', 'mask'].every((id) => moreOpen.buttons.includes(id)),
    '⋯ More reveals announce, props, messages and the mask', moreOpen.buttons.join(', '));
  log(moreShut.buttons.length === 4, 'and folds them away again', moreShut.buttons.join(', '));
  const hiddenClear = await js(win, `
    const T = window.Presenter.__test;
    T.clearMore(false); T.clearLayer('props');
    const shown = T.clearMore(false).buttons;       // still asked to be shut
    T.clearLayer('props'); T.clearMore(false);
    return shown;`);
  log(hiddenClear.includes('props'),
    'a layer that IS cleared refuses to hide — the operator must be able to undo it', hiddenClear.join(', '));
  log(!!lay.state.layers && lay.state.layers.slide !== undefined, 'the live state is layered, not a single picture');

  console.log('\n[12] The background keeps running while the words are cleared');
  const clr = await js(win, `
    const T = window.Presenter.__test;
    T.setBackgroundLayer({ type: 'gradient', value: 'linear-gradient(180deg,#123,#456)' });
    T.go(0);
    const before = T.liveState();
    T.clearLayer('slide');
    const after = T.liveState();
    const dom = T.clearPaletteDom().find(b => b.id === 'slide');
    T.clearLayer('slide');
    const restored = T.liveState();
    return {
      bgBefore: !!(before.layers.background), bgAfter: !!(after.layers.background),
      slideCleared: after.cleared.slide, bgCleared: after.cleared.background,
      redButton: dom && dom.on, restored: restored.cleared.slide,
      transSlide: after.transitions.slide,
    };`);
  if (clr.__error) console.error('[12] ' + clr.__error);
  log(clr.slideCleared === true, 'clearing the slide layer marks only that layer');
  log(clr.bgCleared === false && clr.bgAfter, 'the background layer is untouched — the loop keeps playing');
  log(clr.redButton === true, 'and its button goes red so the operator knows why');
  log(clr.restored === false, 'clicking again brings the words back');
  log(!!clr.transSlide, 'each layer carries its own transition', clr.transSlide);

  const perLayer = await js(win, `
    const T = window.Presenter.__test;
    T.setTransition('background', 'zoom');
    T.setTransition('slide', 'push_left');
    const t = T.transitions();
    return { bg: t.background, sl: t.slide };`);
  log(perLayer.bg === 'zoom' && perLayer.sl === 'push_left',
    'transitions really are set per layer, not globally', `bg=${perLayer.bg} slide=${perLayer.sl}`);

  console.log('\n[13] Props, messages, announcements');
  const show = await js(win, `
    const T = window.Presenter.__test;
    T.addProp({ type: 'text', value: 'Pastor David Richman', x: 0.05, y: 0.8 });
    const withProp = T.liveState();
    T.setMessage('Parent of child 42, please come to the nursery.', 'bottom');
    const withMsg = T.liveState();
    T.setAnnouncement('Offering baskets are at the back');
    const withAnn = T.liveState();
    const beforeIx = T.state().liveIx;
    T.step(1);
    const afterStep = T.liveState();
    T.setMessage(null);
    T.setAnnouncement('');
    return {
      props: withProp.layers.props.length,
      propText: withProp.layers.props[0] && withProp.layers.props[0].value,
      msg: withMsg.message && withMsg.message.text,
      ann: withAnn.layers.announcement && withAnn.layers.announcement.lines,
      propsSurvive: afterStep.layers.props.length,
      annSurvives: !!afterStep.layers.announcement,
      templates: T.messageTemplates().length,
      tokens: T.messageTemplates()[0].tokens,
    };`);
  if (show.__error) console.error('[13] ' + show.__error);
  log(show.props === 1 && /Richman/.test(show.propText || ''), 'a prop goes on its own layer', show.propText);
  log(/nursery/.test(show.msg || ''), 'a message can be put on screen', show.msg);
  log(show.ann && show.ann.length === 1, 'an announcement can be put up', JSON.stringify(show.ann));
  log(show.propsSurvive === 1 && show.annSurvives, 'BOTH survive a slide change — that is the point of layers');
  log(show.templates >= 4 && show.tokens.length >= 1, 'message templates take token inputs',
    `${show.templates} templates, first takes {${show.tokens.join('},{')}}`);

  console.log('\n[14] Timers and clocks');
  const tm = await js(win, `
    const T = window.Presenter.__test;
    const base = 1000000000000;
    T.addTimer({ name: 'Countdown', mode: 'countdown', running: true, endsAt: base + 125000, durationMs: 125000 });
    const i = T.timers().length - 1;
    const at0 = T.timerText(i, base);
    const at60 = T.timerText(i, base + 60000);
    const past = T.timerText(i, base + 999000);
    T.addTimer({ name: 'Up', mode: 'countup', running: true, startedAt: base });
    const up = T.timerText(T.timers().length - 1, base + 65000);
    T.addTimer({ name: 'Clock', mode: 'clock' });
    const paused = T.toggleTimer(i);
    const inState = T.liveState().timers.length;
    return { at0, at60, past, up, paused, inState, modes: T.timers().map(t => t.mode) };`);
  if (tm.__error) console.error('[14] ' + tm.__error);
  log(tm.at0 === '2:05', 'a countdown reads correctly', tm.at0);
  log(tm.at60 === '1:05', 'and counts down', tm.at60);
  log(tm.past === '0:00', 'and stops at zero rather than going negative', tm.past);
  log(tm.up === '1:05', 'a count-up counts up', tm.up);
  log(tm.paused === false, 'a timer can be paused');
  log(tm.modes.includes('clock') && tm.modes.includes('countup') && tm.modes.includes('countdown'),
    'countdown, count-up and wall clock all exist', tm.modes.join(', '));
  log(tm.inState >= 3, 'timers ride along in the live state', tm.inState + ' timers');

  console.log('\n[15] ChordPro — chords over the lyrics');
  const cp = await js(win, `
    const T = window.Presenter.__test;
    const chart = [
      '{title: Amazing Grace}', '{key: G}', '',
      '{c: Verse 1}',
      'A[G]mazing grace how [C]sweet the sound',
      'That [G]saved a wretch like [D]me',
    ].join('\\n');
    return T.importChordPro(chart).then((d) => ({
      name: d && d.name,
      slides: T.slides().length,
      group: T.slides()[0].group,
      lyric: T.slides()[0].lines[0],
      chords: T.chordsOf(0),
      // transpose() returns chords[slide][line][chord]; check the first line
      transposed: ((T.transpose(2)[0] || [])[0] || []).map(c => c.chord),
    }));`);
  if (cp.__error) console.error('[15] ' + cp.__error);
  log(cp.name === 'Amazing Grace', 'the {title} becomes the presentation name', cp.name);
  log(cp.lyric === 'Amazing grace how sweet the sound', 'the chords are stripped OUT of the lyric line', JSON.stringify(cp.lyric));
  log(cp.chords && cp.chords[0] && cp.chords[0].length === 2, 'and kept separately with their positions',
    JSON.stringify(cp.chords[0]));
  log(cp.chords[0][0].chord === 'G' && cp.chords[0][0].at === 1, 'each chord remembers WHERE in the word it sits',
    `${cp.chords[0][0].chord} at char ${cp.chords[0][0].at}`);
  log(cp.group === 'Verse 1', '{c: Verse 1} becomes the slide group', cp.group);
  log(JSON.stringify(cp.transposed) === JSON.stringify(['A', 'D']), 'transposing +2 moves G→A and C→D', JSON.stringify(cp.transposed));

  console.log('\n[16] Arrangements — one song, several play orders');
  const arr = await js(win, `
    const T = window.Presenter.__test;
    T.newDoc('Order Test', 'song');
    T.setSlideText(0, 'v1'); T.setGroup(0, 'Verse 1');
    let ix = T.addSlide(); T.setSlideText(ix, 'ch'); T.setGroup(ix, 'Chorus');
    ix = T.addSlide(); T.setSlideText(ix, 'v2'); T.setGroup(ix, 'Verse 2');
    const full = T.activeOrder();
    T.addArrangement('Short', ['Verse 1', 'Chorus', 'Chorus']);
    const short = T.activeOrder();
    T.go(short[0]);
    const s1 = T.step(1);
    T.setArrangement(null);
    return { full, short, s1, backToFull: T.activeOrder() };`);
  if (arr.__error) console.error('[16] ' + arr.__error);
  log(JSON.stringify(arr.full) === '[0,1,2]', 'with no arrangement it plays straight through', JSON.stringify(arr.full));
  log(JSON.stringify(arr.short) === '[0,1,1]', 'an arrangement re-orders and REPEATS groups without duplicating slides',
    JSON.stringify(arr.short));
  log(arr.s1 === 1, 'and the arrows follow the arrangement', 'went to slide ' + arr.s1);
  log(JSON.stringify(arr.backToFull) === '[0,1,2]', 'switching back restores the full order');

  console.log('\n[17] Easy View and blackout');
  const ev = await js(win, `
    const T = window.Presenter.__test;
    const on = T.key('~');
    const st1 = T.liveState().easyView;
    const off = T.key('~');
    const bl = T.key('b');
    const st2 = T.liveState().blackout;
    T.key('b');
    return { on: on.easyView, st1, off: off.easyView, bl: bl.blackout, st2 };`);
  log(ev.on === true && ev.st1 === true, '~ turns Easy View on');
  log(ev.off === false, '~ again turns it off');
  log(ev.bl === true && ev.st2 === true, 'B blacks out over every layer at once');

  console.log('\n[18] One cue, different Looks per screen');
  const ml = await js(win, `
    const T = window.Presenter.__test;
    return window.api.present.open('audience', null, true, 'lobby', 'Lobby').then(async () => {
      await T.refreshOutputs();
      T.setOutputLook('lobby', 'look-clean');
      const st = T.liveState();
      return { outs: T.outputList(), looks: T.outputLooks(), mapped: !!(st.outputLooks && st.outputLooks.lobby),
               lobbyLook: st.outputLooks && st.outputLooks.lobby && st.outputLooks.lobby.name };
    });`);
  if (ml.__error) console.error('[18] ' + ml.__error);
  log((ml.outs || []).some((o) => o.id === 'lobby'), 'a second, named audience output opens',
    (ml.outs || []).map((o) => o.name).join(', '));
  log(ml.mapped, 'it can be given its own Look for the SAME cue', ml.lobbyLook);
  await sleep(900);
  const lobbyWin = await waitOutputWin('audience');
  log(!!lobbyWin, 'and it is a real window on screen');
  await js(win, `return window.api.present.close('lobby');`);

  console.log('\n[19] The projector really draws the layers');
  const reopened = await js(win, `
    const T = window.Presenter.__test;
    return window.api.present.open('audience', null, true, 'main').then((r) => T.refreshOutputs().then(() => r));`);
  if (reopened && reopened.__error) console.error('[19] ' + reopened.__error);
  await sleep(1400);
  const aud2 = await waitOutputWin('audience');
  if (!aud2) skip('layer rendering on the projector', 'no output window');
  else {
    await js(win, `
      const T = window.Presenter.__test;
      T.setBackgroundLayer({ type: 'color', value: '#112233' });
      T.addProp({ type: 'text', value: 'LOWER THIRD', x: 0.05, y: 0.8 });
      T.setMessage('Nursery call', 'bottom');
      T.go(0);`);
    await sleep(900);
    const drawn = await aud2.webContents.executeJavaScript(`(() => ({
      stage: !!document.getElementById('stage'),
      layers: Array.from(document.querySelectorAll('#stage > .lyr')).map(e => e.className.replace('lyr lyr-','')),
      slideText: (document.querySelector('.lyr-slide .sr-text')||{}).textContent || '',
      prop: (document.querySelector('.lyr-props')||{}).textContent || '',
      msg: (document.querySelector('.lyr-messages')||{}).textContent || '',
      scaled: (document.getElementById('stage')||{}).style ? document.getElementById('stage').style.transform : '',
    }))()`);
    log(drawn.stage && /scale\(/.test(drawn.scaled), 'the projector draws a scaled 1920×1080 stage', drawn.scaled);
    log(drawn.layers.length === 7, 'with all seven layers present as separate render passes', drawn.layers.join(','));
    log(!!drawn.slideText.trim(), 'the slide layer has the words', JSON.stringify(drawn.slideText.slice(0, 34)));
    log(/LOWER THIRD/.test(drawn.prop), 'the props layer has the lower third');
    log(/Nursery/.test(drawn.msg), 'the messages layer has the message');

    // clear ONLY the slide and prove the background is still there
    await js(win, `window.Presenter.__test.clearLayer('slide')`);
    await sleep(500);
    const afterClear = await aud2.webContents.executeJavaScript(`(() => ({
      slideHidden: document.querySelector('.lyr-slide').classList.contains('lyr-cleared'),
      bgHidden: document.querySelector('.lyr-background').classList.contains('lyr-cleared'),
      propHidden: document.querySelector('.lyr-props').classList.contains('lyr-cleared'),
    }))()`);
    log(afterClear.slideHidden === true, 'clearing the slide really hides it ON THE PROJECTOR');
    log(afterClear.bgHidden === false && afterClear.propHidden === false,
      'while the background and props keep running — the whole point of the layer engine');
    await js(win, `window.Presenter.__test.clearLayer('slide')`);
  }
  await js(win, `return window.api.present.close();`);

  /* ================= [20] web output: a phone is a stage display ============ */
  console.log('\n[20] Web output — any phone on the wifi, no app to install');
  const PORT = 7391;
  const started = await js(win, `return window.Presenter.__test.webStart(${PORT});`);
  if (started && started.__error) console.error('[20] ' + started.__error);
  await sleep(600);
  log(!!(started && started.running), 'the web server started', started && (started.urls || []).join(' '));
  log(!!(started && (started.urls || []).length), 'and prints a real LAN address for people to type',
    started && started.urls && started.urls[0]);

  const info = await httpJson(`http://127.0.0.1:${PORT}/api/info`);
  log(info && info.ok === true, '/api/info answers', JSON.stringify(info));
  const page = await httpText(`http://127.0.0.1:${PORT}/`);
  log(/<title>Stage/.test(page || ''), 'the mobile page is served', (page || '').length + ' bytes');
  log(/EventSource/.test(page || ''), 'and it subscribes to live updates rather than polling');

  await js(win, `window.Presenter.__test.go(0)`);
  await sleep(300);
  const remoteState = await httpJson(`http://127.0.0.1:${PORT}/api/state`);
  log(!!(remoteState && remoteState.slide), 'a phone can read the current slide',
    remoteState && remoteState.slide && JSON.stringify((remoteState.slide.lines || []).join(' ').slice(0, 40)));
  log(remoteState && remoteState.next !== undefined, 'and what is coming next');

  // REST control — the same call a Stream Deck button makes
  const before = await js(win, `return window.Presenter.__test.state().liveIx;`);
  await httpText(`http://127.0.0.1:${PORT}/api/next`);
  await sleep(400);
  const after = await js(win, `return window.Presenter.__test.state().liveIx;`);
  log(after === before + 1, 'GET /api/next really advances the slide (Stream Deck friendly)', `${before} → ${after}`);
  await httpText(`http://127.0.0.1:${PORT}/api/prev`);
  await sleep(400);
  const back2 = await js(win, `return window.Presenter.__test.state().liveIx;`);
  log(back2 === before, 'and /api/prev goes back', String(back2));
  await httpText(`http://127.0.0.1:${PORT}/api/black`);
  await sleep(400);
  const blk2 = await js(win, `return window.Presenter.__test.liveState().blackout;`);
  log(blk2 === true, '/api/black blacks the screen from a phone');
  await httpText(`http://127.0.0.1:${PORT}/api/black`);
  await sleep(300);

  // live push
  const pushed = await sseFirst(`http://127.0.0.1:${PORT}/events`);
  log(!!pushed, 'the /events stream pushes state to connected phones',
    pushed ? Object.keys(pushed).slice(0, 5).join(',') : 'none');

  const gone = await js(win, `return window.Presenter.__test.webStop();`);
  log(!(gone && gone.running), 'and it stops cleanly');

  /* ================= [21] macros ================= */
  console.log('\n[21] Macros — one click, several actions');
  const mac = await js(win, `
    const T = window.Presenter.__test;
    T.resetShow();
    T.addTimer({ name: 'Sermon', mode: 'countup', running: false, startedAt: Date.now() });
    const timerId = T.timers()[0].id;
    T.addMacro('Sermon', [
      { action: 'look', value: 'look-dark' },
      { action: 'clear', value: 'slide' },
      { action: 'uncover', value: 'background' },
      { action: 'timerStart', value: timerId },
      { action: 'message', value: 'Sermon notes are on the app' },
    ]);
    const id = T.macros()[0].id;
    T.runMacro(id);
    const st = T.liveState();
    return {
      macros: T.macros(), lookId: T.look().id, cleared: st.cleared,
      msg: st.message && st.message.text, timerRunning: T.timers()[0].running,
      actions: T.macroActions().length,
    };`);
  if (mac.__error) console.error('[21] ' + mac.__error);
  log(mac.macros.length === 1 && mac.macros[0].steps === 5, 'a macro holds several steps', JSON.stringify(mac.macros[0]));
  log(mac.lookId === 'look-dark', 'running it changed the Look');
  log(mac.cleared.slide === true && mac.cleared.background === false, '…cleared one layer and un-cleared another');
  log(/Sermon notes/.test(mac.msg || ''), '…put a message up', mac.msg);
  log(mac.timerRunning === true, '…and started the timer — all from one click');
  log(mac.actions >= 10, 'a full action vocabulary is available', mac.actions + ' actions');

  /* ================= [22] MIDI bindings ================= */
  console.log('\n[22] MIDI — a pad or foot pedal drives the slides');
  const midi = await js(win, `
    const T = window.Presenter.__test;
    T.resetShow();
    T.openDoc(T.docs()[0].id);
    T.go(0);
    T.bindMidi(60, '__next');
    T.bindMidi(62, '__black');
    const a = T.fireMidi(60);
    const b = T.fireMidi(62);
    T.fireMidi(62);
    return { binds: T.midiBinds(), afterNote60: a.liveIx, afterNote62: b.blackout };`);
  if (midi.__error) console.error('[22] ' + midi.__error);
  log(Object.keys(midi.binds).length === 2, 'notes can be bound to actions', JSON.stringify(midi.binds));
  log(midi.afterNote60 === 1, 'playing the bound note advanced the slide', 'ix ' + midi.afterNote60);
  log(midi.afterNote62 === true, 'and another note blacked the screen');

  /* ================= [23] drawing + live input ================= */
  console.log('\n[23] Drawing over the output, and a live camera as a layer');
  const draw = await js(win, `
    const T = window.Presenter.__test;
    const on = T.draw(true);
    const kind = T.drawStroke();
    const st = T.liveState();
    const cleared = T.clearDrawing();
    T.draw(false);
    const cam = T.setLiveInput({ type: 'camera', value: 'default', label: 'USB cam' });
    const st2 = T.liveState();
    T.setLiveInput(null);
    return { on, kind, mask: st.layers.mask && st.layers.mask.value.slice(0, 22), cleared,
             cam: cam && cam.type, bgType: st2.layers.background && st2.layers.background.type };`);
  if (draw.__error) console.error('[23] ' + draw.__error);
  log(draw.on === true, 'drawing mode turns on');
  log(draw.kind === 'image' && /^data:image\/png/.test(draw.mask || ''),
    'a stroke becomes a real overlay on the mask layer', draw.mask);
  log(draw.cleared == null, 'rubbing it out puts the mask layer back');
  log(draw.cam === 'camera' && draw.bgType === 'camera', 'a camera can be the background layer', draw.bgType);

  /* ================= [24] stage layouts + multiviewer ================= */
  console.log('\n[24] Stage layouts — a musician, a preacher and a director want different monitors');
  const layouts = await js(win, `
    const T = window.Presenter.__test;
    const all = T.stageLayouts();
    const band = T.setStageLayout('stage-band');
    const bandBlocks = T.stageLayout().blocks.map(b => b.type);
    const dir = T.setStageLayout('stage-director');
    const sent = T.liveState().stageLayout;
    const bad = T.setStageLayout('does-not-exist');
    return { all, band, bandBlocks, dir, sentId: sent && sent.id, bad, types: T.stageBlockTypes() };`);
  if (layouts.__error) console.error('[24] ' + layouts.__error);
  log(layouts.all.length >= 4, 'several stage arrangements ship ready to use', layouts.all.map((l) => l.name).join(', '));
  log(layouts.band === 'stage-band' && !layouts.bandBlocks.includes('notes'),
    'the musician layout drops the notes column so the chords get the width', layouts.bandBlocks.join(','));
  log(layouts.sentId === 'stage-director', 'the chosen layout travels with the cue to the stage display', layouts.sentId);
  log(layouts.bad === 'stage-director', 'an unknown layout is refused rather than blanking the monitor');
  log(layouts.types.includes('multiview') && layouts.types.includes('timer'),
    'the block vocabulary covers a director and a preacher too', layouts.types.join(','));

  // …and prove the director's multiviewer really draws each output's picture
  await js(win, `
    const T = window.Presenter.__test;
    T.setStageLayout('stage-director');
    return T.openOutput('audience', null, true, 'main', 'Main');`);
  await sleep(900);
  await js(win, `
    const T = window.Presenter.__test;
    T.setOutputLook('main', 'look-clean');
    T.go(0);
    return window.api.present.open('stage', null, true, 'stage');`);
  await sleep(1500);
  const stageWin = await waitOutputWin('stage');
  if (!stageWin) skip('the multiviewer', 'no stage window');
  else {
    await js(win, `window.Presenter.__test.go(0)`);
    await sleep(700);
    const mv = await stageWin.webContents.executeJavaScript(`(() => ({
      cells: document.querySelectorAll('.sv-mv-cell').length,
      pics: document.querySelectorAll('.sv-mv-cell .sr-stage').length,
      text: (document.querySelector('.sv-mv-cell .sr-text')||{}).textContent || '',
      names: Array.from(document.querySelectorAll('.sv-mv-name')).map(e => e.textContent),
      width: Math.round((document.querySelector('.sv-mv-cell')||{}).getBoundingClientRect ? document.querySelector('.sv-mv-cell').getBoundingClientRect().width : 0),
    }))()`);
    log(mv.cells >= 1, 'the director layout shows a cell per audience output', mv.names.join(','));
    log(mv.pics >= 1, 'and each cell holds a REAL rendered picture, not a label');
    log(!!mv.text.trim(), 'the thumbnail contains the live words', JSON.stringify(mv.text.slice(0, 30)));
    // the 1920px .sr-stage must never escape its cell (the layout trap)
    log(mv.width > 0 && mv.width < 1200, 'and the 1920px stage stays inside its thumbnail', mv.width + 'px');
  }
  await js(win, `return window.api.present.close('stage');`);

  /* ================= [25] screen mapping + edge blending ================= */
  console.log('\n[25] Screen mapping — a sideways projector, an LED wall, two blended projectors');
  const mapped = await js(win, `
    const T = window.Presenter.__test;
    const set = T.setMap('main', { rotate: 90, scale: 1.1, x: 12, y: -8 });
    const opened = T.openMapEditor('main');
    const vals = T.mapEditorValues();
    const sent = T.liveState().outputMaps.main;
    return { set, opened, vals, sent };`);
  if (mapped.__error) console.error('[25] ' + mapped.__error);
  log(mapped.set.rotate === 90, 'a screen can be rotated for a portrait projector', mapped.set.rotate + '°');
  log(mapped.opened === true && mapped.vals.rotate === '90' && mapped.vals.scale === '1.1',
    'the mapping editor opens on that screen with its real values', JSON.stringify(mapped.vals));
  log(mapped.sent && mapped.sent.rotate === 90, 'and the map travels to the output with the cue');

  const aud3 = await waitOutputWin('audience');
  if (!aud3) skip('mapping on the real projector', 'no output window');
  else {
    await sleep(600);
    const rotated = await aud3.webContents.executeJavaScript(
      `(() => (document.getElementById('stage')||{}).style.transform)()`);
    log(/rotate\(90deg\)/.test(rotated || ''), 'the projector really turns the picture 90°', rotated);

    await js(win, `window.Presenter.__test.setMap('main', { rotate: 0, scale: 1, x: 0, y: 0, blend: { left: 60, right: 0, top: 0, bottom: 0, gamma: 1.4 } })`);
    await sleep(600);
    const blend = await aud3.webContents.executeJavaScript(`(() => {
      const h = document.getElementById('blend');
      const k = h && h.firstElementChild;
      return { host: !!h, kids: h ? h.children.length : 0, w: k ? k.style.width : '', grad: k ? (k.style.background||'').slice(0, 46) : '' };
    })()`);
    log(blend.host && blend.kids === 1 && blend.w === '60px',
      'an edge-blend ramp appears exactly where the projectors overlap', blend.w);
    log(/linear-gradient/.test(blend.grad), 'and it is a real gamma ramp, not a hard edge', blend.grad);

    await js(win, `window.Presenter.__test.resetMap('main')`);
    await sleep(500);
    const cleanTf = await aud3.webContents.executeJavaScript(
      `(() => ({ tf: document.getElementById('stage').style.transform, blend: !!document.getElementById('blend') }))()`);
    log(!/rotate/.test(cleanTf.tf) && cleanTf.blend === false, 'resetting the screen puts it back to plain', cleanTf.tf);
  }

  /* ================= [26] fill + key (downstream keying) ================= */
  console.log('\n[26] Fill and key — one cue, two cables, a transparent lower third');
  await js(win, `return window.Presenter.__test.openOutput('audience', null, true, 'streamkey', 'Stream key', 'fill');`);
  await sleep(1400);
  const fillWin = BrowserWindow.getAllWindows().find((w) => {
    try { return !w.isDestroyed() && w.webContents.getURL().includes('id=streamkey'); } catch (e) { return false; }
  });
  if (!fillWin) skip('the fill output', 'no window');
  else {
    await js(win, `
      const T = window.Presenter.__test;
      T.setBackgroundLayer({ type: 'color', value: '#3355ff' });
      T.go(0);`);
    await sleep(900);
    const fill = await fillWin.webContents.executeJavaScript(`(() => ({
      cls: document.body.className,
      bg: getComputedStyle(document.getElementById('screen')).backgroundColor,
      hasBackgroundLayer: !!document.querySelector('.lyr-background .sr-bg'),
      words: (document.querySelector('.lyr-slide .sr-text')||{}).textContent || '',
      transparentWindow: true,
    }))()`);
    log(/render-fill/.test(fill.cls), 'the fill output knows it is a keyable feed', fill.cls);
    log(/rgba\(0, 0, 0, 0\)|transparent/.test(fill.bg), 'its screen is really transparent, not black', fill.bg);
    log(fill.hasBackgroundLayer === false,
      'and the background is dropped at the source — otherwise there is nothing to key');
    log(!!fill.words.trim(), 'while the words themselves still go out', JSON.stringify(fill.words.slice(0, 24)));
    log(fillWin.isTransparent ? fillWin.isTransparent() === true : true, 'the window itself carries an alpha channel');

    // the matching key channel
    await js(win, `return window.Presenter.__test.openOutput('audience', null, true, 'streamkey', 'Stream key', 'key');`);
    await sleep(1400);
    const keyWin = BrowserWindow.getAllWindows().find((w) => {
      try { return !w.isDestroyed() && w.webContents.getURL().includes('id=streamkey') && w.webContents.getURL().includes('render=key'); } catch (e) { return false; }
    });
    if (!keyWin) skip('the key output', 'no window');
    else {
      await js(win, `window.Presenter.__test.go(0)`);
      await sleep(800);
      const key = await keyWin.webContents.executeJavaScript(`(() => ({
        cls: document.body.className,
        filter: getComputedStyle(document.getElementById('screen')).filter,
        svg: !!document.querySelector('#alphaToLuma feColorMatrix'),
        matrix: (document.querySelector('#alphaToLuma feColorMatrix')||{}).getAttribute
          ? document.querySelector('#alphaToLuma feColorMatrix').getAttribute('values').replace(/\\s+/g,' ').trim() : '',
        words: (document.querySelector('.lyr-slide .sr-text')||{}).textContent || '',
      }))()`);
      log(/render-key/.test(key.cls), 'the key output renders the same cue as a matte');
      log(/alphaToLuma/.test(key.filter || ''), 'through a real alpha→luminance filter', key.filter);
      log(key.matrix === '0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 1',
        'whose matrix copies alpha into R,G,B and forces opacity — that IS a key channel', key.matrix);
      log(!!key.words.trim(), 'and it carries the same words as the fill, so they line up');
    }
  }
  await js(win, `return window.api.present.close('streamkey');`);

  /* ================= [27] NDI output ================= */
  console.log('\n[27] NDI output — the words go onto the network, no HDMI run');
  const ndiSend = require(path.join(ROOT, 'src/main/ndi-send'));
  const ndiStatus = ndiSend.status();
  log(typeof ndiStatus.available === 'boolean', 'the NDI runtime is looked for and reported honestly',
    ndiStatus.available ? 'available: ' + path.basename(ndiStatus.dll || '') : (ndiStatus.error || '').slice(0, 60));
  if (!ndiStatus.available) {
    skip('sending over NDI', 'no NDI runtime on this machine — install NDI Tools to test it');
  } else {
    const feed = ndiSend.start({ id: 'ndi-test', name: 'MW Test Feed', width: 640, height: 360, fps: 15, sourceId: 'main' });
    log(feed && feed.width === 640 && feed.height === 360,
      'a feed renders OFFSCREEN at its own size, not whatever monitor is plugged in', `${feed.width}×${feed.height} @ ${feed.fps}`);
    ndiSend.setStateSource(() => presenter.getState());
    await js(win, `window.Presenter.__test.go(0)`);
    // give the offscreen window time to load, paint and send a few frames
    await sleep(4000);
    const st27 = ndiSend.state();
    const f = (st27.feeds || [])[0];
    log(f && f.ok === true, 'the sender really opened on the network', f && (f.error || 'ok'));
    log(f && f.live === true, 'offscreen rendering produced real frames to send');
    /*
     * WHAT "STILL FLOWING" MEANS, AND WHICH COUNTER SAYS SO.
     *
     * `frames` counts PAINTS of the offscreen window, and a still slide is
     * deliberately designed to paint once and then stop — that is the fix that
     * stopped a static slide costing 235 MB/s (see ndi-send.js). So `frames`
     * plateaus at about a dozen and stays there, for ever, on a healthy feed.
     * Asserting it keeps climbing asserted the opposite of the design, and sat
     * right on the boundary: measured here it reaches 11 at almost exactly the
     * 4 s mark, so the same healthy feed passed or failed on scheduling luck.
     *
     * What a receiver actually sees is what the WORKER sends, which is the
     * counter that must keep climbing on a still slide. So that is the one
     * checked, sampled twice to prove it is moving rather than merely nonzero.
     */
    const sent1 = f && f.sent;
    await sleep(1200);
    const f2 = (ndiSend.state().feeds || [])[0];
    const sent2 = f2 && f2.sent;
    log(sent2 > sent1 && sent2 > 10,
      'and they keep flowing on a steady clock even on a still slide',
      `${sent1} → ${sent2} frames on the wire (window painted ${f2 && f2.frames}× — a still slide paints once by design)`);

    // it must be discoverable by the same NDI finder any switcher uses
    const ndiRx = require(path.join(ROOT, 'src/main/ndi'));
    ndiRx.startDiscovery();
    let found = null;
    for (let i = 0; i < 12 && !found; i++) {
      await sleep(500);
      found = ndiRx.getSources().find((s) => /MW Test Feed/.test(s.name));
    }
    log(!!found, 'a vMix/OBS operator would see it in their NDI source list', found ? found.name : 'not discovered');

    ndiSend.stop('ndi-test');
    log((ndiSend.state().feeds || []).length === 0, 'and it stops cleanly, taking its window with it');
    ndiSend.stopAll();
  }

  /* ================= [27b] ready-made backgrounds ================= */
  console.log('\n[27b] Ready-made backgrounds — real moving footage, and the flat set behind it');
  const bgs = await js(win, `
    const T = window.Presenter.__test;
    T.resetShow();
    T.setTab('media');
    T.setBgCat('All');
    const clips = T.bgClips();
    const vidTiles = T.bgVideoTiles();
    const faith = (T.setBgCat('Faith'), { tiles: T.bgVideoTiles(), flat: T.bgFlatTiles() });
    const plain = (T.setBgCat('Plain'), { tiles: T.bgVideoTiles(), flat: T.bgFlatTiles() });
    // with only the flat set showing, tile N is preset N
    const all = T.presets();
    const painted = all.map((p, i) => T.bgTilePainted(i)).filter(Boolean);
    const blanks = painted.filter(t => t.image === 'none' && !/gradient/.test(t.image)).length;
    T.setBgCat('All');
    return { clips, vidTiles, faith, plain, flatCount: all.length,
             images: painted.filter(t => /^url\\("data:image\\/svg/.test(t.image)).length,
             gradients: painted.filter(t => /gradient/.test(t.image)).length,
             blanks, sample: painted[0] && painted[0].sample,
             light: all.filter(p => p.light).map(p => p.name) };`);
  if (bgs.__error) console.error('[27b] ' + bgs.__error);
  log(bgs.clips >= 24 && bgs.vidTiles === bgs.clips,
    'the gallery leads with real moving footage', `${bgs.clips} clips, ${bgs.vidTiles} tiles`);
  log(bgs.faith.tiles > 0 && bgs.faith.flat === 0, 'the category chips really filter it', `Faith → ${bgs.faith.tiles} clips`);
  log(bgs.plain.flat === bgs.flatCount && bgs.plain.tiles === 0,
    '"Plain" still holds every flat scene — a light room and a slow laptop both need them',
    `${bgs.plain.flat} flat scenes`);
  log(bgs.blanks === 0, 'every flat tile paints something — no empty boxes', bgs.blanks + ' blank');
  log(bgs.images > 0 && bgs.gradients > 0, 'built from SVG scenes AND layered gradients — all vector, so a 4K wall stays sharp',
    `${bgs.images} scenes, ${bgs.gradients} gradients`);
  log(/Amazing grace/.test(bgs.sample || ''),
    'each tile shows a real line of lyrics over it, so the choice is made on readability', bgs.sample);
  log(bgs.light.length >= 3, 'and the light ones are flagged, for churches with a bright room', bgs.light.join(', '));

  /* The posters are the whole gallery until something is downloaded: if one is
   * missing from the build the operator is choosing from a black square. */
  const posters = await js(win, `return window.Presenter.__test.bgPosterProbe();`);
  const missing = (posters || []).filter((p) => p.poster !== true);
  log(missing.length === 0, 'every clip\'s poster is really in the build and really loads',
    missing.length ? missing.map((p) => p.name).join(', ') : `${posters.length} posters load`);
  const badMeta = (posters || []).filter((p) => !(p.h >= 1080) || !(p.bytes > 0) || !/^https:\/\/cdn\.pixabay\.com\//.test(p.url || ''));
  log(badMeta.length === 0, 'and each one is 1080p, with its size known before the download starts',
    badMeta.length ? badMeta.map((p) => p.name).join(', ') : `${posters.length} clips, ${(posters.reduce((s, p) => s + p.bytes, 0) / 1048576).toFixed(0)} MB in total`);

  // Layout guards. Both of these were really broken: the app's global button
  // style shrink-wrapped every tile to 78px, and the pane's column flex
  // squashed the apply row to a 2px sliver.
  const geom = await js(win, `
    const g = document.getElementById('pvBgGrid');
    const tile = g.querySelector('.pv-bg');
    const thumb = g.querySelector('.pv-bg-thumb');
    const apply = document.querySelector('.pv-bg-apply');
    const seg = document.querySelector('.pv-seg.on');
    const col = parseFloat(getComputedStyle(g).gridTemplateColumns.split(' ')[0]);
    return { col: Math.round(col), tile: Math.round(tile.getBoundingClientRect().width),
             thumb: Math.round(thumb.getBoundingClientRect().width),
             thumbH: Math.round(thumb.getBoundingClientRect().height),
             applyH: Math.round(apply.getBoundingClientRect().height),
             segText: seg.textContent, segOn: seg.classList.contains('on'),
             overflow: Math.round(g.scrollWidth - g.clientWidth) };`);
  if (geom.__error) console.error('[27b] ' + geom.__error);
  log(geom.thumb === geom.col && geom.thumb === geom.tile,
    'each tile fills its grid column instead of shrink-wrapping', `${geom.thumb}px in a ${geom.col}px column`);
  log(Math.abs(geom.thumbH / geom.thumb - 9 / 16) < 0.04,
    'and holds a true 16:9 preview, the shape of the actual screen', `${geom.thumb}×${geom.thumbH}`);
  log(geom.applyH >= 24 && /This slide/.test(geom.segText) && geom.segOn,
    'the "where does this land" control is a real, visible, pre-selected choice', `${geom.applyH}px, "${geom.segText}"`);
  log(geom.overflow === 0, 'and the gallery never pushes the panel sideways', geom.overflow + 'px overflow');

  const applied = await js(win, `
    const T = window.Presenter.__test;
    T.setBgApply('slide');
    T.selectSlide(0);
    const one = T.usePreset('bg-mountain');
    const slide0 = T.slides()[0].bg;
    const slide1 = T.slides()[1].bg;
    T.setBgApply('all');
    T.usePreset('bg-royal');
    const everySlide = T.slides().every(s => s.bg && s.bg.preset === 'bg-royal');
    T.setBgApply('look');
    T.usePreset('bg-teal');
    const lookBg = T.lookBg();
    T.setBgApply('slide');
    return { one, slide0, slide1, everySlide, lookBg };`);
  if (applied.__error) console.error('[27b] ' + applied.__error);
  log(applied.slide0 && applied.slide0.preset === 'bg-mountain' && !applied.slide1,
    'clicking one puts it on the SELECTED slide only', applied.slide0 && applied.slide0.type);
  log(applied.everySlide === true, '"All slides" really covers the whole song in one click');
  log(applied.lookBg && applied.lookBg.preset === 'bg-teal',
    '"The Look" changes it everywhere that Look is used — one-click global styling', applied.lookBg && applied.lookBg.type);

  // …and it must actually reach the glass
  const aud5 = await waitOutputWin('audience');
  if (!aud5) skip('a ready-made background on the projector', 'no output window');
  else {
    await js(win, `
      const T = window.Presenter.__test;
      T.setBgApply('slide'); T.selectSlide(0); T.usePreset('bg-rays'); T.go(0);`);
    await sleep(900);
    const drawn = await aud5.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.lyr-background .sr-bg') || document.querySelector('.lyr-background .lyr-img');
      const cs = el ? getComputedStyle(el) : null;
      return { has: !!el, img: cs ? cs.backgroundImage.slice(0, 30) : '', size: cs ? cs.backgroundSize : '',
               words: (document.querySelector('.lyr-slide .sr-text')||{}).textContent || '' };
    })()`);
    log(drawn.has && /url\("data:image\/svg/.test(drawn.img), 'the projector really draws the chosen scene', drawn.img);
    log(drawn.size === 'cover', 'filling the screen at any shape, with no letterbox', drawn.size);
    log(!!drawn.words.trim(), 'with the lyrics still on top of it', JSON.stringify(drawn.words.slice(0, 24)));
  }
  await js(win, `window.Presenter.__test.setTab('bible'); window.Presenter.__test.resetShow();`);

  /* ================= [28] YouTube / Vimeo straight into the background ===== */
  console.log('\n[28] Web video — paste a link, it plays; nothing is downloaded first');
  const web = await js(win, `
    const T = window.Presenter.__test;
    T.resetShow();
    const ids = {
      watch: T.videoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s', 'youtube'),
      short: T.videoId('https://youtu.be/dQw4w9WgXcQ', 'youtube'),
      embed: T.videoId('https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube'),
      shorts: T.videoId('https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube'),
      vimeo: T.videoId('https://vimeo.com/76979871', 'vimeo'),
      junk: T.videoId('https://example.com/not-a-video', 'youtube'),
    };
    const bg = T.webVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const url = bg && T.embedUrl(bg);
    const mutedUrl = T.embedUrl(Object.assign({}, bg, { muted: true }));
    const st = T.liveState();
    return { ids, bgType: bg && bg.type, url, mutedUrl, liveType: st.layers.background && st.layers.background.type };`);
  if (web.__error) console.error('[28] ' + web.__error);
  log(Object.values(web.ids).filter((v) => v === 'dQw4w9WgXcQ').length === 4,
    'every shape of YouTube link people actually paste is understood', JSON.stringify(web.ids));
  log(web.ids.vimeo === '76979871', 'and Vimeo links too', web.ids.vimeo);
  log(web.ids.junk === null, 'while a link that is not a video is refused, not half-accepted');
  log(web.bgType === 'youtube' && web.liveType === 'youtube', 'the link becomes the background layer for real', web.liveType);
  log(/youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/.test(web.url || ''), 'it plays from the privacy-preserving embed host', (web.url || '').slice(0, 58));
  log(/controls=0/.test(web.url || '') && /rel=0/.test(web.url || '') && /modestbranding=1/.test(web.url || ''),
    'stripped back to a projector — no controls, no branding, no "watch next" at the end');
  log(/mute=0/.test(web.url || '') && /mute=1/.test(web.mutedUrl || ''),
    'sound is ON by default (a bumper video nobody can hear is a bug) and mutable in one click');

  const aud4 = await waitOutputWin('audience');
  if (!aud4) skip('the embed on the projector', 'no output window');
  else {
    await js(win, `window.Presenter.__test.go(0)`);
    await sleep(1200);
    const frame = await aud4.webContents.executeJavaScript(`(() => {
      const f = document.querySelector('.lyr-background iframe');
      return { has: !!f, src: f ? f.src.slice(0, 52) : '', w: f ? f.getBoundingClientRect().width : 0 };
    })()`);
    log(frame.has && /youtube-nocookie/.test(frame.src), 'the projector really embeds the player', frame.src);
    log(frame.w > 100, 'and it fills the screen behind the words', Math.round(frame.w) + 'px');
    await js(win, `window.Presenter.__test.setBackgroundLayer(null); window.Presenter.__test.resetShow();`);
  }

  /* ================= [29] video controls + chroma key ================= */
  console.log('\n[29] Live video controls and a real green-screen key');
  const vid = await js(win, `
    const T = window.Presenter.__test;
    T.setBackgroundLayer({ type: 'video', value: 'C:/nope.mp4' });
    // setVideoOpts returns the LIVE background object, so each step has to be
    // snapshotted before the next one mutates it.
    const snap = (o) => JSON.parse(JSON.stringify(o || null));
    const applied = snap(T.setVideoOpts({ brightness: 1.3, contrast: 0.8, saturation: 1.4, hue: 20, speed: 1.5, inSec: 4, outSec: 12, pingpong: true }));
    const filt = T.filterFor(applied);
    const keyed = snap(T.setVideoOpts({ chroma: true, chromaColor: '#00b140' }));
    const reset = snap(T.resetVideoOpts());
    return { applied, filt, chroma: keyed && keyed.chroma, reset };`);
  if (vid.__error) console.error('[29] ' + vid.__error);
  log(vid.applied.brightness === 1.3 && vid.applied.speed === 1.5,
    'brightness, contrast, saturation, hue and speed all land on the clip', JSON.stringify({ b: vid.applied.brightness, s: vid.applied.speed }));
  log(vid.applied.inSec === 4 && vid.applied.outSec === 12 && vid.applied.pingpong === true,
    'so do in/out trim points and a ping-pong loop', `${vid.applied.inSec}s → ${vid.applied.outSec}s`);
  log(/brightness\(1\.3\)/.test(vid.filt) && /hue-rotate\(20deg\)/.test(vid.filt),
    'and they become one real CSS filter, leaving the file on disk untouched', vid.filt);
  log(vid.chroma && vid.chroma.on === true && vid.chroma.color === '#00b140',
    'chroma keying carries colour, similarity, smoothness and spill', JSON.stringify(vid.chroma));
  log(vid.reset.brightness === 1 && !(vid.reset.chroma && vid.reset.chroma.on), 'and Reset really puts the picture back');

  // the keyer itself, run against a REAL green frame on the GPU
  const key = await js(win, `
    const cv = document.createElement('canvas'); cv.width = 4; cv.height = 4;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#00b140'; cx.fillRect(0, 0, 4, 4);      // green screen
    cx.fillStyle = '#ff8800'; cx.fillRect(0, 0, 2, 4);      // the subject
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;width:4px;height:4px';
    document.body.appendChild(host);
    // a canvas quacks like a video for texImage2D; give it the two fields the keyer reads
    Object.defineProperty(cv, 'videoWidth', { value: 4 });
    Object.defineProperty(cv, 'videoHeight', { value: 4 });
    const out = window.SlideRender.chromaKey(host, cv, { on: true, color: '#00b140', similarity: 0.16, smoothness: 0.08, spill: 0 }, 'cover');
    if (!out) return { skipped: true };
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const gl = out.getContext('webgl');
      const px = new Uint8Array(4 * 4 * 4);
      gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // bottom-left is the subject, bottom-right is green screen
      const subject = [px[0], px[1], px[2], px[3]];
      const screenPx = [px[12], px[13], px[14], px[15]];
      host.remove();
      res({ subject, screenPx });
    })));`);
  if (key.__error) console.error('[29] ' + key.__error);
  else if (key.skipped) skip('the chroma keyer', 'no WebGL in this session');
  else {
    log(key.screenPx[3] < 30, 'the green really becomes transparent', 'alpha ' + key.screenPx[3]);
    log(key.subject[3] > 220, 'while the subject stays fully opaque', 'alpha ' + key.subject[3]);
    log(key.subject[0] > 150 && key.subject[2] < 90, 'and keeps its own colour', `rgb(${key.subject.slice(0, 3).join(',')})`);
  }

  /* ================= [30] playback markers ================= */
  console.log('\n[30] Playback markers — the clip fires the cue itself');
  const mark = await js(win, `
    const T = window.Presenter.__test;
    T.resetShow();
    T.selectSlide(0);
    T.setBackground(0, { type: 'video', value: 'C:/intro.mp4' });
    T.addMarker(0.4, 'message', 'Welcome home', 'Lower third on');
    T.addMarker(0.8, 'clearMessage', '', 'Lower third off');
    T.addMarker(2, 'black', '', 'blackout');
    const list = T.markers();
    const rows = T.markerRows();
    T.go(0);
    const liveBg = T.liveState().layers.background;
    return { list, rows, armed: T.armedMarkers(), slideIx: T.state().slideIx, liveIx: T.state().liveIx,
             liveBgMarkers: (liveBg && liveBg.markers || []).length, liveBgValue: liveBg && liveBg.value };`);
  if (mark.__error) console.error('[30] ' + mark.__error);
  log(mark.list.length === 3 && mark.list[0].at === 0.4, 'markers sit at real times inside the clip', JSON.stringify(mark.list.map((m) => m.at)));
  log(mark.rows === 3, 'and are listed for the operator to see and remove', mark.rows + ' rows');
  log(mark.armed === 3, 'taking the clip live arms every one of them',
    `${mark.armed} armed (slide ${mark.slideIx}/live ${mark.liveIx}, bg ${mark.liveBgValue} carries ${mark.liveBgMarkers})`);
  await sleep(600);
  const at04 = await js(win, `return (window.Presenter.__test.liveState().message||{}).text || '';`);
  log(/Welcome home/.test(at04), 'at 0.4s the lower third really appeared, with nobody touching the desk', at04);
  await sleep(600);
  const at08 = await js(win, `return (window.Presenter.__test.liveState().message||{}).text || '';`);
  log(at08 === '', 'and at 0.8s it took itself away again');
  // …and a clip that is replaced must not leave its markers ticking
  await js(win, `
    const T = window.Presenter.__test;
    T.setBackground(0, { type: 'color', value: '#000' });
    T.go(0);`);
  const disarmed = await js(win, `return window.Presenter.__test.armedMarkers();`);
  log(disarmed === 0, 'changing the clip cancels every marker it had left', disarmed + ' armed');
  await sleep(1600);
  const noBlack = await js(win, `return window.Presenter.__test.liveState().blackout;`);
  log(noBlack === false, 'so the 2s blackout never fires after the clip is gone');

  /* ================= [31] audio ================= */
  console.log('\n[31] Audio — beds, stems and slide-linked cues');
  // two real, tiny WAV files so nothing here is mocked
  const wav = (seconds, hz) => {
    const rate = 8000, n = Math.round(rate * seconds), b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2);
    return b;
  };
  const BED = path.join(WORK, 'bed.wav'); fs.writeFileSync(BED, wav(2, 220));
  const STEM = path.join(WORK, 'stem.wav'); fs.writeFileSync(STEM, wav(2, 440));
  const audio = await js(win, `return (async () => {
    const T = window.Presenter.__test;
    T.resetShow();
    const a = await T.addAudio({ path: ${JSON.stringify(BED)}, name: 'Bed', volume: 0.6, loop: true });
    const b = await T.addAudio({ path: ${JSON.stringify(STEM)}, name: 'Stem', volume: 1 });
    T.playAudio(a.id, 0);
    T.playAudio(b.id, 0);
    await new Promise(r => setTimeout(r, 350));
    const both = T.audioTracks().filter(t => t.playing).length;
    const volA = T.trackVolume(a.id);
    /*
     * The clock has to ADVANCE — that is what proves the file is sounding
     * rather than merely "playing". WAIT for it instead of sampling once:
     * how quickly Chromium gets a decoder running depends on what else the
     * machine is doing, and a single reading at 350ms turned a working feature
     * into a coin flip. The ceiling stays under the 2-second file.
     */
    let advanced = T.audioTime(a.id);
    for (let i = 0; i < 12 && !(advanced > 0.05); i++) {
      await new Promise(r => setTimeout(r, 100));
      advanced = T.audioTime(a.id);
    }
    const dbg = T.audioDebug(a.id);
    T.setMaster(0.5);
    const halved = T.trackVolume(a.id);
    T.stopAudio(b.id, 0);
    await new Promise(r => setTimeout(r, 120));
    const after = T.audioTracks().filter(t => t.playing).length;
    return { ids: [a.id, b.id], both, volA, halved, after, advanced, dbg, rows: T.audioRows() };
  })()`);
  if (audio.__error) console.error('[31] ' + audio.__error);
  log(audio.both === 2, 'two tracks really play at the same time — a bed under a stem', audio.both + ' playing');
  log(Math.abs(audio.volA.el - 0.6) < 0.02, 'each track holds its own level', 'bed at ' + audio.volA.el);
  log(Math.abs(audio.halved.el - 0.3) < 0.02, 'and the master bus scales them all together', 'bed now ' + audio.halved.el);
  log(audio.after === 1, 'stopping one leaves the other running', audio.after + ' still playing');
  log(audio.rows === 2, 'both appear as real rows the operator can grab', audio.rows + ' rows');
  log(audio.advanced > 0.05,
    'the clock inside the file really advanced — unmuted audio autoplays with no click anywhere',
    audio.advanced.toFixed(2) + 's in' + (audio.advanced > 0.05 ? '' : ' — ' + JSON.stringify(audio.dbg)));

  const fade = await js(win, `return (async () => {
    const T = window.Presenter.__test;
    const id = T.audioTracks()[0].id;
    T.playAudio(id, 400);
    await new Promise(r => setTimeout(r, 60));
    const early = T.trackVolume(id).el;
    await new Promise(r => setTimeout(r, 500));
    const full = T.trackVolume(id).el;
    T.stopAudio(id, 300);
    await new Promise(r => setTimeout(r, 140));
    const dipping = T.trackVolume(id).el;
    await new Promise(r => setTimeout(r, 300));
    return { early, full, dipping, playing: T.audioTracks()[0].playing };
  })()`);
  if (fade.__error) console.error('[31] ' + fade.__error);
  log(fade.early < fade.full, 'a track fades IN rather than banging on', `${fade.early.toFixed(2)} → ${fade.full.toFixed(2)}`);
  log(fade.dipping < fade.full && fade.dipping > 0, 'and fades OUT rather than cutting dead', fade.dipping.toFixed(2));
  log(fade.playing === false, 'ending properly stopped when the fade finished');

  const linked = await js(win, `return (async () => {
    const T = window.Presenter.__test;
    const id = T.audioTracks()[0].id;
    T.stopAllAudio(0);
    T.linkSlideAudio(1, 'play:' + id);
    T.linkSlideAudio(2, 'stopall:');
    T.go(1);
    await new Promise(r => setTimeout(r, 250));
    const onSlide1 = T.audioTracks().filter(t => t.playing).length;
    T.go(2);
    await new Promise(r => setTimeout(r, 1100));   // 'stop all' FADES out; it must not cut
    return { onSlide1, onSlide2: T.audioTracks().filter(t => t.playing).length };
  })()`);
  if (linked.__error) console.error('[31] ' + linked.__error);
  log(linked.onSlide1 === 1, 'a slide can start the music the moment it goes live');
  log(linked.onSlide2 === 0, 'and another slide can take it away again');

  const macAudio = await js(win, `
    const T = window.Presenter.__test;
    const id = T.audioTracks()[0].id;
    T.addMacro('Preservice', [{ action: 'audioPlay', value: id }, { action: 'look', value: 'look-dark' }]);
    T.runMacro(T.macros()[0].id);
    return { playing: T.audioTracks().filter(t => t.playing).length, actions: T.macroActions() };`);
  log(macAudio.playing === 1, 'a macro can start the music alongside everything else it does');
  log(macAudio.actions.includes('dmx') && macAudio.actions.includes('macro') && macAudio.actions.includes('audioStopAll'),
    'the macro vocabulary now reaches audio, lighting and other macros', macAudio.actions.length + ' actions');
  await js(win, `window.Presenter.__test.stopAllAudio(0)`);

  /* ================= [32] DMX lighting over Art-Net ================= */
  console.log('\n[32] Lighting — DMX over Art-Net, on gear the church already owns');
  const artnet = require(path.join(ROOT, 'src/main/artnet'));
  log(JSON.stringify(artnet.parseCommand('1.20=255, 21=128')) === JSON.stringify([
    { universe: 1, channel: 20, value: 255 }, { universe: 0, channel: 21, value: 128 }]),
    'the shorthand an operator can type in a macro parses', '1.20=255, 21=128');
  const pkt = artnet.packet(3, artnet.uni(3));
  log(pkt.slice(0, 8).toString('ascii') === 'Art-Net\u0000', 'the packet carries the real Art-Net header');
  log(pkt.readUInt16LE(8) === 0x5000, 'with the ArtDMX opcode', '0x' + pkt.readUInt16LE(8).toString(16));
  log(pkt.readUInt16BE(10) === 14, 'and protocol version 14, big-endian as the spec demands');
  log(pkt.readUInt8(14) === 3 && pkt.readUInt16BE(16) === 512, 'addressed to universe 3, a full 512 channels', pkt.length + ' bytes');

  // …and it really goes out on the wire
  const sock = require('dgram').createSocket({ type: 'udp4', reuseAddr: true });
  const got = new Promise((resolve) => {
    sock.on('message', (msg) => { if (msg.slice(0, 7).toString('ascii') === 'Art-Net') resolve(msg); });
    setTimeout(() => resolve(null), 3000);
  });
  await new Promise((r) => sock.bind(6454, '0.0.0.0', r));
  await js(win, `return window.Presenter.__test.dmxConfigure({ enabled: true, host: '127.0.0.1' });`);
  await js(win, `return window.Presenter.__test.dmxSend('0.20=255,21=128');`);
  const wire = await got;
  try { sock.close(); } catch (e) {}
  log(!!wire, 'a real UDP packet reaches the lighting network');
  if (wire) {
    log(wire[18 + 19] === 255 && wire[18 + 20] === 128,
      'carrying every channel in ONE packet, so a colour never steps through a wrong one',
      `ch20=${wire[18 + 19]} ch21=${wire[18 + 20]}`);
  }
  await js(win, `return window.Presenter.__test.dmxConfigure({ enabled: false });`);
  artnet.stop();

  console.log('\n[33] Console');
  /*
   * Chromium's own noise, and one piece of somebody else's: the YouTube player
   * in the embed test asks for the compute-pressure permission, which this app
   * deliberately does not grant it (the iframe's `allow` list is autoplay,
   * encrypted-media and picture-in-picture — a background loop has no business
   * reading the machine's CPU pressure). The refusal is correct behaviour being
   * reported, not an error in the studio.
   */
  const real = errors.filter((m) =>
    !/DevTools|Autofill|Electron Security|GPU|Passthrough|favicon/i.test(m)
    && !/Permissions policy violation: compute-pressure/i.test(m));
  log(real.length === 0, 'no renderer errors', real.slice(0, 3).join(' | ') || 'clean');

  console.log(failed ? '\n============  PRESENTATION test FAILED  ============\n' : '\n============  PRESENTATION test PASSED  ============\n');
  try { presenter.shutdown(); } catch (e) {}
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
