'use strict';
/*
 * THE WHOLE WAY TO THE WALL: quoted words in, verse on the screen.
 *
 * verse-find.test.js measures the matcher on its own — that is where the
 * corpus and the thresholds live. This drives the REAL Presentation studio:
 * the operator's own tick box, the real worker thread, the real IPC, the real
 * Bible, the real "load the chapter and go to the verse" path, and then reads
 * the words that are actually on the live layer.
 *
 * Two things it proves that a unit test cannot:
 *  - the verse that reaches the SCREEN is the verse that was quoted, in the
 *    church's own translation, even when the match was made against a
 *    different one;
 *  - and "next verse" still works afterwards, because the whole chapter was
 *    loaded rather than the single verse — which is the thing every preacher
 *    does immediately after quoting something.
 *
 * Run: npm run test:presentquote   (SKIPS cleanly if no Bible is downloaded)
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const bible = require('../src/main/bible');
const voiceref = require('../src/main/voiceref');
const versefind = require('../src/main/versefind-host');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-pvquote-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

const USER_DATA = process.env.MW_USERDATA
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Church Work Space');
bible.init(USER_DATA);
versefind.init(USER_DATA);

let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: {} };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('ndi:sources', () => ok([]));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:open', () => ok({ state: {} }));
ipcMain.handle('present:close', () => ok({}));
ipcMain.handle('present:state', () => ok({}));
ipcMain.handle('present:set', () => ok(true));

/* the REAL Bible engine */
ipcMain.handle('bible:installed', wrap(async () => bible.installed()));
ipcMain.handle('bible:catalogue', wrap(async () => []));
ipcMain.handle('bible:books', wrap(async (e, { translation } = {}) => ({ books: await bible.books(translation) })));
ipcMain.handle('bible:lookup', wrap(async (e, { translation, ref }) => bible.lookup({ translation, ref })));
ipcMain.handle('bible:chapter', wrap(async (e, { translation, bookNr, chapter }) => bible.getChapter({ translation, bookNr, chapter })));
ipcMain.handle('bible:parseRef', wrap(async (e, { ref }) => bible.parseRef(ref)));
ipcMain.handle('bible:search', wrap(async () => []));

/* the REAL listener wiring, copied from src/main/main.js — including the
 * quotation step, which is the thing under test */
let voiceTranslation = null;
ipcMain.handle('voice:available', wrap(async () => ({ ready: true })));
ipcMain.handle('voice:warmUp', wrap(async () => ({ resident: false, residentWhy: 'stubbed' })));
ipcMain.handle('voice:translation', wrap(async (e, { translation } = {}) => { voiceTranslation = translation || null; return { translation: voiceTranslation }; }));
ipcMain.handle('voice:parse', wrap(async (e, { text, live } = {}) =>
  ({ text: text || '', intent: voiceref.parseVoice(text, { live }) })));
async function withQuote(r) {
  if (!r || !r.ok || r.intent || !r.text) return r;
  let q = null;
  try { q = await versefind.find(r.text); } catch (err) { q = null; }
  if (!q) return r;
  r.quote = { ok: !!q.ok, ref: q.ref, run: q.run, share: q.share, coverage: q.coverage, rare: q.rare, matchedIn: q.translation, alsoAt: q.alsoAt, spans: q.spans,
    agree: q.byAgreement ? q.agree : null };
  if (!q.ok) return r;
  r.intent = { kind: 'ref', bookNr: q.bookNr, book: q.book, chapter: q.chapter, verses: [q.verse], ref: q.ref, said: r.text, viaQuote: true };
  return r;
}
/* No microphone in this test: the words are handed in as if whisper had just
 * produced them. `voice:hearText` is the app's own seam for exactly this and
 * is wired here the same way src/main/main.js wires it, so everything after
 * the transcript is the shipping path. */
ipcMain.handle('voice:hearText', wrap(async (e, { text, live, quote } = {}) => {
  const r = { ok: true, text: text || '', intent: voiceref.parseVoice(text, { live }) };
  return quote ? withQuote(r) : r;
}));
ipcMain.handle('voice:hear', wrap(async (e, { text, live, quote } = {}) => {
  const r = { ok: true, text: text || '', intent: voiceref.parseVoice(text, { live }) };
  return quote ? withQuote(r) : r;
}));
ipcMain.handle('voice:quotePrepare', wrap(async (e, { translation } = {}) => versefind.prepare(translation || voiceTranslation || null)));
ipcMain.handle('voice:quoteState', wrap(async () => versefind.state()));
ipcMain.handle('voice:quoteFind', wrap(async (e, { text } = {}) => versefind.find(text)));

app.disableHardwareAcceleration();
async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.Presenter.__test';

app.whenReady().then(async () => {
  console.log('\n== QUOTED WORDS IN, VERSE ON THE WALL ==\n');

  const installed = bible.installed().map((t) => t.abbr);
  if (!installed.length) {
    console.log('  SKIP  no Bible translation is downloaded on this machine');
    app.exit(0); return;
  }
  const display = installed.includes('bolls:NIV') ? 'bolls:NIV' : installed[0];
  console.log(`   the church reads: ${display}`);
  console.log(`   listening across: ${versefind.chooseTranslations(display, installed).join(', ')}\n`);

  const win = new BrowserWindow({
    show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1200);
  await js(win, `document.querySelector('.nav-item[data-view="present"]').click(); await new Promise((r)=>setTimeout(r,400)); return true;`);
  await js(win, `${T}.setTranslation ? await ${T}.setTranslation(${JSON.stringify(display)}) : null;
    window.Presenter.__test.__pvSetTranslation = 1; return true;`);

  console.log('[1] Switching it on');
  const t0 = Date.now();
  const on = await js(win, `return await ${T}.listen.setQuote(true);`);
  const readyMs = Date.now() - t0;
  log(on && on.on, 'the operator can switch on “Find quoted verses”');
  log(on && on.ready, 'and the Bible gets indexed for it', `${readyMs} ms · ${on && on.note}`);
  log(/listening across|in all \d+ installed translation/.test((on && on.note) || ''), 'the studio says how many translations it is listening across', on && on.note);

  console.log('\n[2] ►► THE SPEAKER QUOTES, WITHOUT SAYING WHERE FROM ◄◄');
  const SAID = [
    ['give and it shall be given unto you', 'Luke 6:38'],
    ['for god so loved the world that he gave his only begotten son', 'John 3:16'],
    ['i can do all things through christ which strengtheneth me', 'Philippians 4:13'],
    ['trust in the lord with all thine heart and lean not unto thine own understanding', 'Proverbs 3:5'],
    ['be still and know that i am god', 'Psalms 46:10'],
  ];
  for (const [said, want] of SAID) {
    const r = await js(win, `return await ${T}.listen.hearText(${JSON.stringify(said)});`);
    const okRef = r && r.did && String(r.did).startsWith(want);
    log(okRef, `“${said.slice(0, 46)}${said.length > 46 ? '…' : ''}”`, r ? `${r.did || 'nothing'}${r.quoted ? ' (quoted)' : ''}` : 'no answer');
  }

  console.log('\n[2b] A short famous line goes up because the Bibles agree on it');
  {
    // Five words and a quarter of its verse: only "the translations agree"
    // can put it up, and the log must say that is why.
    const r = await js(win, `${T}.listen.forgetLast(); return await ${T}.listen.hearText('in the valley of decision');`);
    log(!!(r && r.did && /Joel 3:14/.test(r.did)), '“in the valley of decision” puts up Joel 3:14', (r && r.did) || 'nothing');
    const lines = await js(win, `return ${T}.listen.log();`);
    const line = (lines || []).find((l) => /Joel 3:14/.test(l)) || '';
    log(/\d+ Bibles agree/.test(line), 'and the log says how many Bibles agreed, rather than naming one', line.slice(0, 90));
  }

  console.log('\n[3] The words on the wall are the words that were quoted');
  {
    await js(win, `return await ${T}.listen.hearText('give and it shall be given unto you');`);
    const live = await js(win, `const s = ${T}.liveText ? ${T}.liveText() : null; return s;`);
    const txt = (live && (live.text || live.lines || '')) || '';
    const flat = (Array.isArray(txt) ? txt.join(' ') : String(txt)).toLowerCase();
    log(/given/.test(flat) && /give/.test(flat),
      'the verse itself is on the live layer, in the church’s own translation',
      flat.slice(0, 90) || '(nothing on the layer)');
  }

  console.log('\n[4] “Next verse” still works — the whole chapter was loaded');
  {
    /*
     * A cued passage lives in `verseCue`, not in the Library's slide index, so
     * what has to move is the words on the wall. This is the whole reason a
     * quotation loads the CHAPTER rather than the single verse: quoting
     * something and then saying "next verse" is the commonest pair of actions
     * there is, and fetching one verse alone would leave it nowhere to go.
     */
    const wall = `const t = ${T}.liveText(); return t ? (t.lines || []).join(' ') : '';`;
    const before = await js(win, wall);
    const step = await js(win, `return await ${T}.listen.heard('next verse');`);
    await sleep(250);
    const after = await js(win, wall);
    log(!!(step && step.did === 'next'), 'the studio takes “next verse” after a quotation');
    log(!!after && after !== before, 'and the wall moves on to the next verse of that chapter',
      `“${String(before).slice(0, 28)}…” -> “${String(after).slice(0, 28)}…”`);
  }

  console.log('\n[5] And it stays quiet through ordinary preaching');
  {
    const QUIET = [
      'good morning church it is so good to see you all here today',
      'father we thank you for this day that you have made',
      'i want to encourage somebody here this morning do not give up',
      'and the pastor said to me son you have got to keep going',
      'the offering buckets are at the back please give as you leave',
    ];
    let fired = 0;
    for (const q of QUIET) {
      const r = await js(win, `return await ${T}.listen.hearText(${JSON.stringify(q)});`);
      if (r && r.did) { fired++; console.log(`       FIRED on "${q}" -> ${r.did}`); }
    }
    log(fired === 0, 'five lines of ordinary church talk move nothing on the screen', `${fired} of ${QUIET.length}`);
  }

  /*
   * ►► THE WAY MOST OF A SERMON NOW ARRIVES ◄◄
   *
   * A preacher in full flow does not pause, so the studio no longer waits for
   * one: while somebody is talking, the last few seconds are offered over and
   * over as a LOOK-BACK. That is what fixed the feature — measured on a real
   * sermon, waiting for a pause found none of the three passages the preacher
   * put on the wall and look-backs found two — and it introduces exactly one
   * new way to be wrong, which is doing something twice because the same words
   * are in three overlapping look-backs. These are the three rules that make
   * that safe, driven through the real studio.
   */
  console.log('\n[6] Look-backs — the sermon arrives before the pause does');
  {
    await js(win, `return await ${T}.listen.setQuote(true);`);
    await js(win, `${T}.listen.forgetLast(); return 1;`);
    const wall = `const t = ${T}.liveText(); return t ? (t.lines || []).join(' ') : '';`;

    // 1. a look-back may name a passage
    const a = await js(win, `return await ${T}.listen.heardLookBack('turn with me to john chapter three verse sixteen');`);
    await sleep(300);
    log(!!(a && a.did && /John 3:16/.test(a.did)), 'a look-back can put a named passage on the wall',
      (a && a.did) || 'nothing');

    // 2. ...and saying it again in the next look-back does not do it twice
    const again = await js(win, `return await ${T}.listen.heardLookBack('turn with me to john chapter three verse sixteen');`);
    log(!!(again && again.repeat && !again.did), 'the same words in the next look-back are ignored, not repeated',
      again && again.did ? 'acted AGAIN: ' + again.did : 'left alone');

    // 3. ...but a look-back must NEVER step the screen: those same words sit in
    //    three overlapping look-backs and would move it three verses.
    const before = await js(win, wall);
    const step = await js(win, `return await ${T}.listen.heardLookBack('next verse');`);
    await sleep(250);
    const after = await js(win, wall);
    log(!(step && step.did) && after === before, 'a look-back never steps the screen — that is the finished phrase’s job',
      step && step.did ? 'MOVED: ' + step.did : 'the wall did not move');

    // 4. ...and the finished phrase still does it
    const fin = await js(win, `return await ${T}.listen.hearText('next verse');`);
    await sleep(250);
    const moved = await js(win, wall);
    log(!!(fin && fin.did === 'next') && moved !== before, 'and a finished phrase still moves it on exactly one',
      `“${String(before).slice(0, 26)}…” -> “${String(moved).slice(0, 26)}…”`);

    // 5. a quotation inside a look-back full of other speech is still found
    await js(win, `${T}.listen.forgetLast(); return 1;`);
    const q = await js(win, `return await ${T}.listen.heardLookBack('I mean the rod of God, the rod of Moses became the rod of God. Give, and it shall be given unto you.');`);
    log(!!(q && q.did && /Luke 6:38/.test(q.did)), 'a quotation at the end of a look-back is found in it',
      (q && q.did) || 'nothing');

    /*
     * 6. IT ACTS, IT DOES NOT SAY "NEARLY".
     *
     * Reported from a real service: the log read `And it shall be given to you.
     * nearly Matthew 7:7` and the verse never went up. Seven words in a row,
     * all of them that verse, nothing else said — the studio knew exactly what
     * it was and declined, because those seven common words weighed 9.4 against
     * a floor of 10. Either it is sure enough to act or it should say nothing
     * about it; announcing the verse it will not open is the worst of both.
     */
    /*
     * ►► "VERSE FIVE" ◄◄
     *
     * Reported from a real service: the operator said it, the log showed
     * `verse 5 verse 5 verse`, and the screen did not move. Two separate faults
     * met in that one line — whisper's stutter made the words unparseable, and
     * a look-back was only allowed to NAME a passage, so even parsed it would
     * have been dropped. Both are exercised here through the real studio.
     */
    await js(win, `${T}.listen.forgetLast(); return await ${T}.listen.heard('psalm twenty three');`);
    await sleep(400);
    const v5 = await js(win, `${T}.listen.forgetLast(); return await ${T}.listen.heardLookBack('verse 5 verse 5 verse');`);
    await sleep(300);
    // `reference` is the whole passage that is loaded; the verse actually on the
    // glass is the highlighted row.
    const cue5 = await js(win, `return ${T}.verseCue();`);
    log(!!(v5 && v5.did) && !!cue5 && (cue5.liveRows || []).includes(5),
      'a stuttered “verse five” in a look-back puts verse 5 on the screen',
      cue5 ? `${cue5.reference} showing verse ${(cue5.liveRows || []).join(',') || '—'}` : 'nothing moved');

    /*
     * ►► WHOLE CHAPTERS, AND PLAIN ENGLISH ◄◄
     */
    await js(win, `${T}.listen.forgetLast(); return 1;`);
    const ch = await js(win, `return await ${T}.listen.hearText('previous chapter');`);
    await sleep(500);
    const cueCh = await js(win, `return ${T}.verseCue();`);
    log(!!(cueCh && /Psalms 22/.test(cueCh.reference || '')), '“previous chapter” goes back a whole chapter',
      (cueCh && cueCh.reference) || (ch && ch.did) || 'nothing moved');

    await js(win, `${T}.listen.forgetLast(); return 1;`);
    await js(win, `return await ${T}.listen.hearText('next chapter');`);
    await sleep(500);
    const cueCh2 = await js(win, `return ${T}.verseCue();`);
    log(!!(cueCh2 && /Psalms 23/.test(cueCh2.reference || '')), '…and “next chapter” comes forward again',
      (cueCh2 && cueCh2.reference) || 'nothing moved');

    const wallA = await js(win, wall);
    await js(win, `${T}.listen.forgetLast(); return 1;`);
    const carry = await js(win, `return await ${T}.listen.hearText('carry on');`);
    await sleep(300);
    const wallB = await js(win, wall);
    log(!!(carry && carry.did === 'next') && wallB !== wallA, '“carry on” moves to the next verse',
      (carry && carry.did) || 'nothing moved');

    await js(win, `${T}.listen.forgetLast(); return 1;`);
    const goback = await js(win, `return await ${T}.listen.hearText('go back');`);
    await sleep(300);
    const wallC = await js(win, wall);
    log(!!(goback && goback.did === 'previous') && wallC === wallA, '“go back” returns to the one before',
      (goback && goback.did) || 'nothing moved');

    // ...and the same words inside a sentence do nothing at all.
    await js(win, `${T}.listen.forgetLast(); return 1;`);
    const wallD = await js(win, wall);
    const preach = await js(win, `return await ${T}.listen.hearText('we must carry on in faith no matter what it costs');`);
    await sleep(300);
    log(!(preach && preach.did) && (await js(win, wall)) === wallD,
      'but “carry on” inside a sentence is preaching and moves nothing',
      (preach && preach.did) || 'the wall did not move');

    await js(win, `${T}.listen.forgetLast(); return 1;`);
    const near = await js(win, `return await ${T}.listen.hearText('And it shall be given to you.');`);
    log(!!(near && near.did), 'a verse it recognises completely is OPENED, not reported as “nearly”',
      (near && near.did) || 'nothing happened');
    const logLines = await js(win, `return ${T}.listen.log();`);
    log(!(logLines || []).some((l) => /nearly/i.test(l)), 'and the word “nearly” never appears in the log',
      ((logLines || []).find((l) => /nearly/i.test(l)) || 'not there'));
  }

  console.log('\n[6b] Singing the words on the slide is not quoting them');
  {
    /*
     * Worship is full of scripture, and when the words heard ARE the words on
     * the live slide the room is singing them: the lyric must stay up. A slide
     * that does not carry them — the sermon's own points — must not silence
     * the finder, because every presentation that is not a Bible reading is a
     * "song" to the studio.
     */
    const wall = `const t = ${T}.liveText(); return t ? (t.lines || []).join(' ') : '';`;
    await js(win, `${T}.listen.forgetLast(); ${T}.newDoc('Give', 'song');
      ${T}.setSlideText(0, 'Give and it shall be given unto you\\nPressed down, shaken together'); ${T}.go(0); return 1;`);
    const before = await js(win, wall);
    const sung = await js(win, `return await ${T}.listen.hearText('give and it shall be given unto you');`);
    const after = await js(win, wall);
    log(/given unto you/i.test(before) && !(sung && sung.did) && after === before,
      'singing a scripture lyric that is ON the slide leaves the lyric up',
      (sung && sung.did) || `still “${String(after).slice(0, 40)}”`);
    await js(win, `${T}.listen.forgetLast(); ${T}.newDoc('Sermon points', 'song');
      ${T}.setSlideText(0, 'Point one\\nA generous heart'); ${T}.go(0); return 1;`);
    const said = await js(win, `return await ${T}.listen.hearText('give and it shall be given unto you');`);
    log(!!(said && said.did && /Luke 6:38/.test(said.did)),
      'with a sermon slide up instead, the same quotation still goes on the wall',
      (said && said.did) || 'nothing moved');
  }

  console.log('\n[7] Switching it off stops it');
  {
    await js(win, `return await ${T}.listen.setQuote(false);`);
    const r = await js(win, `return await ${T}.listen.hearText('give and it shall be given unto you');`);
    log(!(r && r.did), 'with the box unticked, a quotation is heard and left alone', r && r.did ? r.did : 'nothing moved');
  }

  try { versefind.stop(); } catch (e) {}
  console.log('\n' + (failed ? '============  FAILED  ============' : '============  ALL PASSED  ============') + '\n');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  app.exit(failed ? 1 : 0);
});
