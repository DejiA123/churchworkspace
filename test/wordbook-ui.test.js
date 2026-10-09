'use strict';
/*
 * THE WORD BOOK, driven through the real captions window.
 *
 * "I have to make many corrections after the captions are generated, even
 *  repeated ones, and it's slowing me down."
 *
 * So the thing to prove is not that a matcher matches — test/wordbook.test.js
 * does that — but that RETYPING ONE LINE IN THE REAL WINDOW is enough. This
 * boots the actual studio, opens the actual 💬 window on a short, types into the
 * actual row, and then asks:
 *
 *   • did the other lines saying the same wrong thing change too?
 *   • did the WORD TIMINGS underneath change, so that choosing a different
 *     Words/line cannot quietly bring the wrong word back?
 *   • did it reach the main process's book on disk — the one the NEXT
 *     transcription will read?
 *   • and does an everyday word ("there" → "their") stay on its own line,
 *     instead of being rewritten all over a sermon that is full of them?
 *
 * The main process here is the REAL src/main/wordbook.js against a temporary
 * profile — not a stub — because "it was remembered" is the whole feature.
 *
 *   npx electron test/wordbook-ui.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'mw-wordbook-ui-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, p) => ok(p));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({ 'reel-9x16': { w: 9, h: 16, label: 'Reel 9:16' } }));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('captions:engineInfo', () => ok({ available: true }));
ipcMain.handle('captions:models', () => ok([
  { id: 'small.en', name: 'Small — much more accurate', sizeMB: 466, installed: true, downloadable: true, inUse: true },
]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('present:outputs', () => ok([]));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));

/* THE REAL BOOK, on a real (temporary) disk. Wired exactly as main.js wires it. */
const wordbook = require('../src/main/wordbook.js');
const engine = require('../src/renderer/wordbook.js');
const window0 = { isCommon: (w) => engine.isCommonWord(w) };
const BOOKDIR = path.join(WORK, 'profile');
fs.mkdirSync(BOOKDIR, { recursive: true });
wordbook.init(BOOKDIR);
ipcMain.handle('wordbook:get', () => ok(wordbook.view()));
ipcMain.handle('wordbook:options', (e, o) => ok(wordbook.setOptions(o)));
ipcMain.handle('wordbook:addFix', (e, { from, to }) => ok(wordbook.addFix({ from, to, src: 'user' })));
ipcMain.handle('wordbook:updateFix', (e, { id, patch }) => ok(wordbook.updateFix(id, patch)));
ipcMain.handle('wordbook:removeFix', (e, { id }) => ok(wordbook.removeFix(id)));
ipcMain.handle('wordbook:addTerm', (e, { text }) => ok(wordbook.addTerm(text)));
ipcMain.handle('wordbook:removeTerm', (e, { id }) => ok(wordbook.removeTerm(id)));
ipcMain.handle('wordbook:learn', (e, { edits }) => ok(wordbook.learnFromEdits(edits)));

/* A sermon that says the same wrong thing over and over — which is the actual
 * complaint. Word timings included, because they are half of what has to be
 * corrected and the half nobody sees. */
const WORDS = [
  ['TURN', 61.0, 61.3], ['WITH', 61.3, 61.6], ['ME', 61.6, 61.8], ['TO', 61.8, 62.0],
  ['A', 62.0, 62.2], ['FEE', 62.2, 62.5], ['SHINS', 62.5, 63.1], ['THREE', 63.1, 63.5],
  ['BECAUSE', 64.0, 64.5], ['A', 64.5, 64.7], ['FEE', 64.7, 65.0], ['SHINS', 65.0, 65.6],
  ['TELLS', 65.6, 66.0], ['US', 66.0, 66.2],
  ['AND', 67.0, 67.3], ['THERE', 67.3, 67.7], ['BOOK', 67.7, 68.1], ['WAS', 68.1, 68.4], ['OPEN', 68.4, 68.9],
  ['THERE', 69.5, 69.9], ['IS', 69.9, 70.1], ['A', 70.1, 70.3], ['REASON', 70.3, 70.9],
  ['WE', 71.5, 71.8], ['READ', 71.8, 72.2], ['A', 72.2, 72.4], ['FEE', 72.4, 72.7], ['SHINS', 72.7, 73.3],
  ['AGAIN', 73.3, 73.8],
  ['AND', 74.5, 74.8], ['HABAKUK', 74.8, 75.6], ['SAID', 75.6, 76.0],
].map(([text, start, end]) => ({ text, start, end }));

/* The lines as the window shows them: three words each, the way they are built. */
const LINES = [];
for (let i = 0; i < WORDS.length; i += 3) {
  const g = WORDS.slice(i, i + 3);
  LINES.push({ start: g[0].start, end: g[g.length - 1].end, text: g.map((w) => w.text).join(' ') });
}

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
  const T = 'window.VideoEditor.__test';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await js(`document.querySelector('[data-view="video"]').click(); await new Promise(r => setTimeout(r, 400)); return 1;`);

  head('The shared matcher is loaded in the studio, not a second copy of it');
  {
    const w = await js(`return { has: !!window.WordBook, seeds: (window.WordBook && window.WordBook.SEED_TERMS || []).length };`);
    check('window.WordBook is the same module the main process requires', w.has === true);
    check(`…and it ships knowing ${w.seeds} Bible and church words`, w.seeds > 200, String(w.seeds));
  }

  head('Retyping ONE line fixes every other line that says the same thing');
  await js(`
    ${T}.loadFake({ durationSec: 600, width: 1920, height: 1080 });
    ${T}.applyClips([{ start: 60, end: 90, label: 'Grace' }]);
    ${T}.seedCaps(${JSON.stringify(LINES)}, ${JSON.stringify(WORDS)});
    return 1;`);
  // The real 💬 Auto-captions button, on captions that are already there.
  await js(`document.getElementById('veAutoCaptions').click(); await new Promise(r => setTimeout(r, 400)); return 1;`);
  {
    const st = await js(`return ${T}.capModal();`);
    check('the captions window is open with the sermon in it', st.open && st.rows === LINES.length,
      `${st.rows} rows`);
    const before = await js(`return ${T}.capLinesText();`);
    const wrong = before.filter((t) => /FEE SHINS|A FEE/.test(t)).length;
    check(`${wrong} lines say the same wrong thing before anything is corrected`, wrong >= 3, JSON.stringify(before.slice(0, 4)));
  }
  {
    // The row holding the first "A FEE SHINS" — retyped exactly as a person would.
    const i = await js(`return ${T}.capLinesText().findIndex((t) => t.indexOf('A FEE SHINS') >= 0);`);
    const line = await js(`return ${T}.capLinesText()[${i}];`);
    const fixedLine = line.replace('A FEE SHINS', 'EPHESIANS');
    await js(`${T}.editCapRow(${i}, ${JSON.stringify(fixedLine)}); return 1;`);
    await wait(400);
    const after = await js(`return { lines: ${T}.capLinesText(), words: ${T}.capWordsText(), note: ${T}.capFixNote() };`);
    const all = after.lines.join(' | ');
    const words = all.split(/[^A-Z]+/).filter(Boolean);
    // The other two are SPLIT ACROSS LINES ("TO A FEE" / "SHINS THREE BECAUSE"),
    // which is the normal shape of a shorts caption and the case a line-by-line
    // fix would miss completely.
    check('every other line with the same mistake is corrected too — including the ones split across a line break',
      words.indexOf('FEE') < 0 && words.indexOf('SHINS') < 0 && words.filter((w) => w === 'EPHESIANS').length === 3,
      all);
    check('the word timings underneath are corrected as well',
      after.words.indexOf('SHINS') < 0 && after.words.filter((w) => w === 'EPHESIANS').length === 3,
      JSON.stringify(after.words.slice(0, 10)));
    check('and it says so, above the words', /other line/.test(after.note), after.note);
  }

  head('…so choosing a different Words/line cannot bring the wrong word back');
  {
    await js(`document.getElementById('capWords').value = '2';
      document.getElementById('capWords').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250)); return 1;`);
    const lines = await js(`return ${T}.capLinesText();`);
    check('re-breaking the lines at 2 words keeps EPHESIANS', !lines.some((t) => /FEE SHINS|SHINS/.test(t))
      && lines.some((t) => /EPHESIANS/.test(t)), JSON.stringify(lines.slice(0, 6)));
    await js(`document.getElementById('capWords').value = '3';
      document.getElementById('capWords').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250)); return 1;`);
  }

  head('An everyday word is a judgement call, and stays on its own line');
  {
    // Re-seed, so this section reads the sermon it means to read rather than
    // whatever the previous section left on the lane.
    await js(`${T}.seedCaps([{ start: 61, end: 62, text: 'AND THERE BOOK' },
                             { start: 63, end: 64, text: 'WAS LYING OPEN' },
                             { start: 65, end: 66, text: 'THERE IS A REASON' },
                             { start: 67, end: 68, text: 'IT WAS THERE' }], null); return 1;`);
    const i = await js(`return ${T}.capLinesText().findIndex((t) => t.indexOf('THERE BOOK') >= 0);`);
    check('the sermon has a "THERE BOOK" line to correct', i >= 0, String(i));
    const line = await js(`return ${T}.capLinesText()[${i}];`);
    await js(`${T}.editCapRow(${i}, ${JSON.stringify(line.replace('THERE BOOK', 'THEIR BOOK'))}); return 1;`);
    await wait(400);
    const after = await js(`return { lines: ${T}.capLinesText(), note: ${T}.capFixNote() };`);
    check('the line typed on is corrected', after.lines.some((t) => /THEIR BOOK/.test(t)));
    check('but the two legitimate "THERE"s in the same sermon are left completely alone',
      after.lines.filter((t) => t.split(' ').indexOf('THERE') >= 0).length === 2,
      JSON.stringify(after.lines.filter((t) => /THERE|THEIR/.test(t))));
    /*
     * THE RULE CHANGED, DELIBERATELY — twice. It used to store "there → their"
     * bare (a real book grew 142 such rules); then widened with the words around
     * it, and a real book grew "in the → on the", "it is → meetings" and a
     * hundred more. A real word for a real word depends on the sentence: the
     * line typed on is corrected, and nothing is remembered (engine.learnable).
     */
    check('and nothing about "their" is claimed as remembered',
      !/their/i.test(after.note || ''), after.note);
  }

  head('It reached the book on disk — the one the NEXT transcription reads');
  {
    const view = wordbook.view();
    const eph = view.fixes.find((f) => f.from === 'a fee shins');
    check('the correction is in the main process\'s book', !!eph && eph.to === 'Ephesians',
      JSON.stringify(view.fixes.map((f) => `${f.from}=>${f.to}${f.on ? '' : ' (waiting)'}`)));
    const bare = view.fixes.find((f) => f.from === 'there');
    const phrase = view.fixes.find((f) => f.from.split(' ').length > 1 && /their/.test(f.to));
    check('the everyday word is NOT written down on its own', !bare, JSON.stringify(bare || null));
    check('…nor as the phrase it was typed in (it depends on the sentence)', !phrase,
      JSON.stringify(phrase));
    const next = wordbook.apply([
      { start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'fee' }, { start: 2, end: 3, text: 'shins' },
      { start: 3, end: 4, text: 'chapter' }, { start: 4, end: 5, text: 'four' },
    ]);
    check('a brand-new transcription of the same words now comes out RIGHT, with no editing at all',
      next.count === 1 && next.entries.map((e) => e.text).join(' ') === 'Ephesians chapter four',
      next.entries.map((e) => e.text).join(' '));
    wordbook.flushSync();
    const onDisk = JSON.parse(fs.readFileSync(path.join(BOOKDIR, 'word-book.json'), 'utf-8'));
    check('and it survives the app being closed', (onDisk.fixes || []).some((f) => f.from === 'a fee shins'));
  }

  head('The Word Book panel: see it, switch it off, delete it');
  {
    const wb = await js(`return await ${T}.openWordBook(true);`);
    check('the panel opens with the corrections in it', wb.open && wb.fixes.length >= 1,
      JSON.stringify(wb.fixes.map((f) => f.from + '→' + f.to)));
    check('the button says how much it knows', /\(\d+\)/.test(wb.button), wb.button);
    check('every correction in the book is a name or a phrase — nothing bare and everyday',
      wb.fixes.every((f) => f.from.split(' ').length > 1 || !window0.isCommon(f.from)),
      JSON.stringify(wb.fixes.map((f) => f.from)));
    check('it says it already knows the Bible words', /Bible and church words/.test(wb.count), wb.count);

    const id = wb.fixes.find((f) => f.from === 'a fee shins').id;
    const offView = await js(`return await ${T}.wbToggle(${JSON.stringify(id)}, false);`);
    check('a correction can be switched off', offView.fixes.find((f) => f.id === id).on === false);
    check('…and that reached the store', wordbook.view().fixes.find((f) => f.id === id).on === false);
    await js(`return await ${T}.wbToggle(${JSON.stringify(id)}, true);`);
    check('…and back on again', wordbook.view().fixes.find((f) => f.id === id).on === true);
  }

  head('A name typed in by hand fixes spellings nobody has ever typed');
  {
    const wb = await js(`return await ${T}.wbAddName('Adeboye');`);
    check('the name is added', wb.names.indexOf('Adeboye') >= 0, JSON.stringify(wb.names));
    await js(`await ${T}.openWordBook(false); return 1;`);
    // A line the operator has never corrected, spelled a way nobody has typed.
    await js(`${T}.seedCaps([{ start: 61, end: 63, text: 'PASTOR ADABOYE PRAYED' },
                              { start: 63, end: 65, text: 'AND HABAKUK SAID' },
                              { start: 65, end: 67, text: 'THE PASTOR IS HERE' }], null); return 1;`);
    const r = await js(`return await ${T}.clickFixNow();`);
    check('🪄 Fix these words now corrects the name it has never seen misspelled',
      r.lines[0] === 'PASTOR ADEBOYE PRAYED', JSON.stringify(r.lines));
    check('…and a Bible name it was never taught at all', r.lines[1] === 'AND HABAKKUK SAID', JSON.stringify(r.lines));
    check('…and leaves the ordinary English word "PASTOR" completely alone',
      r.lines[2] === 'THE PASTOR IS HERE', JSON.stringify(r.lines));
    check('it reports what it did', /Fixed 2 words/.test(r.note), r.note);
  }

  head('Nothing is fixed behind the operator\'s back');
  {
    const undone = await js(`
      document.getElementById('capList').blur();
      ${T}.undo(); await new Promise(r => setTimeout(r, 200));
      return ${T}.capLinesText();`);
    check('Ctrl+Z puts a whole sweep back in one go',
      Array.isArray(undone) && undone[0] === 'PASTOR ADABOYE PRAYED', JSON.stringify(undone));
  }

  head('Switching the whole thing off leaves the captions exactly as heard');
  {
    await js(`return await ${T}.openWordBook(true);`);
    await js(`const c = document.getElementById('capWbOn'); c.checked = false;
      c.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200)); return 1;`);
    check('the store agrees it is off', wordbook.view().enabled === false);
    const off = wordbook.apply([{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'fee' }, { start: 2, end: 3, text: 'shins' }]);
    check('and a transcription is left exactly as whisper heard it', off.count === 0,
      off.entries.map((e) => e.text).join(' '));
    await js(`const c = document.getElementById('capWbOn'); c.checked = true;
      c.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(r => setTimeout(r, 200)); return 1;`);
    check('…and switching it back on restores it', wordbook.view().enabled === true);
  }

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('\nFATAL: ' + (e && e.stack || e)); app.exit(1); });
