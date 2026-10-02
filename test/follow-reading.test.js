'use strict';
/*
 * ►► FOLLOWING THE READING, THE WAY THE MICROPHONE ACTUALLY DELIVERS IT ◄◄
 *
 * test/read-along.test.js measures the decision, and it passed all 29 of its
 * checks while the feature was, in the operator's word, shocking. It passed
 * because every case handed the matcher THE WHOLE VERSE IN ONE STRING, and the
 * ear has never once done that. What the ear produces is the last six seconds,
 * over and over, overlapping — and everything that was wrong lived in the gap
 * between those two things:
 *
 *   1. A LOOK-BACK IS ABOUT FOURTEEN WORDS. `minVerseShare` asks for a third of
 *      the verse, so any verse over ~40 words could not clear the bar in a
 *      single window however perfectly it was read. Measured at 135 wpm:
 *      Ephesians 1:3 (44 words) and Matthew 5:44-45 (52) never turned at all.
 *
 *   2. THE QUOTATION MATCHER CLAIMED EVERY READING. Somebody reading the verse
 *      on the wall is, to versefind, a person quoting that verse — and it is
 *      right, and its answer is useless. It produced a `ref` intent, so
 *      followReading was never even called, and the studio re-sent the SAME
 *      verse live. With both boxes ticked the page could not turn. That is
 *      exactly what the operator's screenshot shows.
 *
 *   3. ON THE CLOUD EAR IT TURNED UP TO SIX SECONDS LATE, because the cloud
 *      cadence is one look-back every 6.7 s — correct for a free allowance that
 *      must last a service, and far too slow for a word the studio is expecting.
 *
 * So this file replays real verses at a real reading rate through the REAL
 * studio, one window at a time, and asks the only questions that matter: did it
 * turn, when, and did it ever turn early.
 *
 *   npx electron test/follow-reading.test.js      (SKIPS with no Bible)
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const bible = require('../src/main/bible');
const voiceref = require('../src/main/voiceref');
const versefind = require('../src/main/versefind-host');
const RA = require('../src/renderer/readalong.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-follow-'));
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

ipcMain.handle('bible:installed', wrap(async () => bible.installed()));
ipcMain.handle('bible:catalogue', wrap(async () => []));
ipcMain.handle('bible:books', wrap(async (e, { translation } = {}) => ({ books: await bible.books(translation) })));
ipcMain.handle('bible:lookup', wrap(async (e, { translation, ref }) => bible.lookup({ translation, ref })));
ipcMain.handle('bible:chapter', wrap(async (e, { translation, bookNr, chapter }) => bible.getChapter({ translation, bookNr, chapter })));
ipcMain.handle('bible:parseRef', wrap(async (e, { ref }) => bible.parseRef(ref)));
ipcMain.handle('bible:search', wrap(async () => []));

let voiceTranslation = null;
ipcMain.handle('voice:available', wrap(async () => ({ ready: true })));
ipcMain.handle('voice:warmUp', wrap(async () => ({ resident: false, residentWhy: 'stubbed' })));
ipcMain.handle('voice:translation', wrap(async (e, { translation } = {}) => { voiceTranslation = translation || null; return { translation: voiceTranslation }; }));
ipcMain.handle('voice:parse', wrap(async (e, { text, live } = {}) =>
  ({ text: text || '', intent: voiceref.parseVoice(text, { live }) })));
/* The REAL quotation step, wired as src/main/main.js wires it — because half of
 * what was wrong is what this does to a reading. */
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
ipcMain.handle('voice:hear', wrap(async (e, { text, live, quote } = {}) => {
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

/* ---------------- the microphone, as a clock ---------------- */
const WPM = 135;                                  // reading scripture aloud
const WPS = WPM / 60;
const CADENCE = {
  pc:    { name: 'this PC   (6s window, every 1.2s)',  win: 6,  hop: 1.2 },
  cloud: { name: 'cloud ear (12s window, every 6.7s)', win: 12, hop: 6.7 },
};
/** `text` read aloud, each word stamped with the second it lands on. */
function spoken(text, startSec) {
  const w = String(text).replace(/[^A-Za-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  return w.map((word, i) => ({ word: word.toLowerCase(), t: startSec + (i + 1) / WPS }));
}
const lookBack = (track, now, win) =>
  track.filter((x) => x.t > now - win && x.t <= now).map((x) => x.word).join(' ');

app.whenReady().then(async () => {
  console.log('\n== FOLLOWING THE READING, THROUGH THE REAL STUDIO ==\n');
  const installed = bible.installed().map((t) => t.abbr);
  if (!installed.length) { console.log('  SKIP  no Bible translation is downloaded'); app.exit(0); return; }
  const display = installed.includes('bolls:NIV') ? 'bolls:NIV' : installed[0];
  console.log(`   the church reads: ${display}\n`);

  const errs = [];
  const win = new BrowserWindow({ show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 3) errs.push(m); });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1300);
  await js(win, `document.querySelector('.nav-item[data-view="present"]').click(); await new Promise((r)=>setTimeout(r,400)); return true;`);
  await js(win, `${T}.setTranslation ? await ${T}.setTranslation(${JSON.stringify(display)}) : null; return true;`);

  /** Put a passage up, one verse to a screen, and switch the follower on. */
  async function openAt(ref, verse) {
    return js(win, `
      ${T}.setVersesPerSlide(1);
      await ${T}.find(${JSON.stringify(ref)});
      ${T}.sendVerseLive(${verse});
      ${T}.listen.setFollow(true);
      ${T}.listen.resetReading();
      return ${T}.listen.followTarget();`);
  }
  const shownVerse = () => js(win, `const t = ${T}.listen.followTarget(); return t ? t.verse : null;`);

  /**
   * Read `text` aloud into the studio one look-back at a time, exactly as the
   * ear would hand them over, and report when the page turned.
   */
  async function readAloud(text, cad, startVerse, { after = '', quote = false } = {}) {
    const verseTrack = spoken(text, 0);
    const endsAt = verseTrack.length ? verseTrack[verseTrack.length - 1].t : 0;
    const track = verseTrack.concat(spoken(after || 'and he went on to say something else entirely', endsAt));
    let firedAt = null, firedAtVerse = null;
    for (let now = cad.hop; now < endsAt + 14 && firedAt == null; now += cad.hop) {
      const heard = lookBack(track, now, cad.win);
      if (!heard) continue;
      const r = await js(win, `return await ${T}.listen.hearText(${JSON.stringify(heard)}, { partial: true });`);
      if (r && r.__error) { console.error('   ' + r.__error); break; }
      const v = await shownVerse();
      if (v !== startVerse) { firedAt = now; firedAtVerse = v; }
    }
    return { firedAt, endsAt, lag: firedAt == null ? null : +(firedAt - endsAt).toFixed(1), verse: firedAtVerse };
  }

  /* =================================================================== */
  console.log('[1] ►► THE READING ACTUALLY TURNS THE PAGE — long verses included ◄◄');
  {
    // Verse texts come from the church's own Bible, so this is what is really
    // on the screen rather than a string typed into a test.
    const PASSAGES = [['John 1', 1], ['John 3', 16], ['Romans 8', 28], ['Ephesians 1', 3], ['Matthew 5', 44]];
    let turned = 0, worst = 0;
    for (const [ref, verse] of PASSAGES) {
      const t = await openAt(ref, verse);
      if (!t || t.__error || !t.text) { log(false, `${ref}:${verse} is on the screen`, JSON.stringify(t)); continue; }
      const words = t.text.split(/\s+/).length;
      const r = await readAloud(t.text, CADENCE.pc, verse);
      if (r.firedAt != null) { turned++; worst = Math.max(worst, Math.abs(r.lag)); }
      log(r.firedAt != null, `${ref}:${verse} (${words} words) read aloud turns the page`,
        r.firedAt != null ? `moved to verse ${r.verse}, ${r.lag >= 0 ? '+' : ''}${r.lag}s from the last word` : 'never turned');
    }
    log(turned === PASSAGES.length, 'every one of them turned', `${turned}/${PASSAGES.length}`);
    log(worst <= 2.5, 'and none of them was more than a beat out', `worst ${worst}s`);
  }

  /* =================================================================== */
  console.log('\n[1b] >> ON THE CLOUD EAR, THE PAGE USED TO TURN SECONDS LATE <<');
  {
    /*
     * The cloud ear offers one look-back every 6.7 s, which is what the free
     * allowance sustains for a whole service and is the right answer for a
     * transcript. It is the wrong answer for a word the studio is already
     * expecting: measured, the page turned anywhere from 0.1 to 5.9 SECONDS
     * after the last word, and five seconds is long enough that the reader has
     * moved on and the congregation has looked away.
     *
     * Close-follow is the fix. The moment the tape shows somebody is inside the
     * verse on the screen, a SHORT look-back runs on THIS PC about once a
     * second, purely to catch the end of it. It never touches the cloud, so it
     * cannot spend the allowance. Both runs below are the same reading at the
     * same rate; the only difference is whether the fast channel is allowed.
     */
    const CLOSE_HOP = 1.1, CLOSE_WIN = 4.5;
    async function readWithCadence(text, verse, useClose) {
      const vt = spoken(text, 0);
      const endsAt = vt[vt.length - 1].t;
      const track = vt.concat(spoken('and he went on to say something else', endsAt));
      let nextLook = CADENCE.cloud.hop, nextClose = Infinity, fired = null;
      for (let now = 0.1; now <= endsAt + 12 && fired == null; now = +(now + 0.1).toFixed(1)) {
        let winSec = 0;
        if (now >= nextLook) { winSec = CADENCE.cloud.win; nextLook += CADENCE.cloud.hop; }
        else if (useClose && now >= nextClose) { winSec = CLOSE_WIN; nextClose += CLOSE_HOP; }
        if (!winSec) continue;
        const heard = lookBack(track, now, winSec);
        if (!heard) continue;
        const r = await js(win, `return await ${T}.listen.hearText(${JSON.stringify(heard)}, { partial: true });`);
        if (r && r.__error) { console.error('   ' + r.__error); break; }
        if ((await shownVerse()) !== verse) { fired = now; break; }
        if (useClose) {
          const f = await js(win, `return ${T}.listen.follow();`);
          if (f.closeWant) { if (nextClose === Infinity) nextClose = now + CLOSE_HOP; }
          else nextClose = Infinity;
        }
      }
      return fired == null ? null : +(fired - endsAt).toFixed(1);
    }
    const t = await openAt('John 3', 16);
    const slow = await readWithCadence(t.text, 16, false);
    await openAt('John 3', 16);
    const fast = await readWithCadence(t.text, 16, true);
    log(slow != null && fast != null, 'the page turns either way', `slow ${slow}s / fast ${fast}s`);
    log(fast != null && slow != null && fast <= slow,
      '>> the fast local look-back turns it sooner after the last word <<',
      `${slow}s without it, ${fast}s with it`);
    log(fast != null && Math.abs(fast) <= 1.5,
      'and it lands within a beat of the last word, which is what it has to feel like',
      `${fast >= 0 ? '+' : ''}${fast}s`);
  }

  /* =================================================================== */
  console.log('\n[2] ►► WITH “Find quoted verses” ALSO ON — the two no longer fight ◄◄');
  {
    await js(win, `return await ${T}.listen.setQuote(true);`);
    const t = await openAt('John 1', 1);
    const r = await readAloud(t.text, CADENCE.pc, 1, { quote: true });
    log(r.firedAt != null && r.verse === 2,
      'reading John 1:1 aloud moves ON to verse 2, instead of the search putting verse 1 up again',
      r.firedAt != null ? `verse ${r.verse}` : 'never turned — the quotation matcher claimed it');
    const lines = await js(win, `return ${T}.listen.log();`);
    const followed = (lines || []).filter((l) => /read to the end/.test(l)).length;
    log(followed > 0, 'and the log says it followed the reading, not that it found a quotation',
      (lines || []).slice(-2).join(' | ').slice(0, 120));

    // …and a quotation of some OTHER verse must still work exactly as before.
    await js(win, `${T}.listen.forgetLast(); return 1;`);
    const other = await js(win, `return await ${T}.listen.hearText('give and it shall be given unto you');`);
    log(!!(other && other.did && /Luke 6:38/.test(other.did)),
      '►► a quotation of a DIFFERENT verse still opens it — the other feature is untouched ◄◄',
      (other && other.did) || 'nothing');

    /*
     * AND THE ONE THAT A PREFIX TEST GETS WRONG. With John 11 on the wall, a
     * quotation of John 1:1 is a genuine quotation of a different chapter — but
     * "John 11:1-57" starts with the characters "John 1", so a string compare
     * reads it as "they are only reading what is up there" and swallows it.
     */
    await js(win, `${T}.setVersesPerSlide(1); await ${T}.find('John 11'); ${T}.sendVerseLive(1); return 1;`);
    await js(win, `${T}.listen.forgetLast(); return 1;`);
    const far = await js(win, `return await ${T}.listen.hearText('in the beginning was the word and the word was with god and the word was god');`);
    log(!!(far && far.did && /^John 1:1$/.test(far.did)),
      'John 1:1 quoted while John 11 is on the wall still opens John 1:1',
      (far && far.did) || 'nothing');
  }

  /* =================================================================== */
  console.log('\n[3] ►► IT MUST NOT TURN EARLY — the failure that gets it switched off ◄◄');
  {
    await js(win, `return await ${T}.listen.setQuote(false);`);
    const t = await openAt('John 3', 16);
    const half = t.text.split(/\s+/).slice(0, Math.ceil(t.text.split(/\s+/).length / 2)).join(' ');
    const r = await readAloud(half, CADENCE.pc, 16, { after: 'now what does that mean for us this morning' });
    log(r.firedAt == null, 'reading only HALF the verse and then preaching leaves the screen alone',
      r.firedAt != null ? `it turned to verse ${r.verse}` : 'stayed on verse 16');

    // Talking ABOUT a verse quotes it in fragments, out of order.
    await openAt('John 3', 16);
    const talk = [
      'now john three sixteen is a verse everybody knows',
      'for god so loved the world it says and that word loved is the one to sit with',
      'he gave his son is the part we hurry past',
      'and whoever believes in him well what does believing actually mean',
    ];
    for (const line of talk) await js(win, `return await ${T}.listen.hearText(${JSON.stringify(line)}, { partial: true });`);
    log((await shownVerse()) === 16, 'preaching AROUND the verse leaves the screen alone', 'verse ' + (await shownVerse()));
  }

  /* =================================================================== */
  console.log('\n[4] ►► ONE READING TURNS ONE PAGE ◄◄');
  {
    // The same words arrive in three or four overlapping look-backs. Before the
    // tape carried a "spent" mark, that was three or four verses.
    const t = await openAt('Psalms 23', 1);
    const track = spoken(t.text, 0);
    const endsAt = track[track.length - 1].t;
    for (let now = 1.2; now < endsAt + 8; now += 1.2) {
      const heard = lookBack(track, now, 6);
      if (heard) await js(win, `return await ${T}.listen.hearText(${JSON.stringify(heard)}, { partial: true });`);
    }
    const v = await shownVerse();
    log(v === 2, 'a verse read once advances exactly one verse, however many look-backs carried it',
      'ended on verse ' + v);
  }

  /* =================================================================== */
  console.log('\n[5] The tape: what the decision is actually made on');
  {
    await openAt('John 1', 1);
    const words = 'in the beginning was the word and the word was with god'.split(' ');
    // Three heavily overlapping windows, the way the ear really hands them over.
    for (const n of [6, 9, 12]) {
      await js(win, `return await ${T}.listen.hearText(${JSON.stringify(words.slice(Math.max(0, n - 6), n).join(' '))}, { partial: true });`);
    }
    const f = await js(win, `return ${T}.listen.follow();`);
    log(f.tape === 'in the beginning was the word and the word was with god',
      'overlapping look-backs are welded into ONE continuous reading, in real words',
      '“' + f.tape + '”');
    log(!/\b(\w+) \1\b/.test(f.tape) && f.tape.split(' ').length === 12,
      'and the overlap is welded, not repeated', f.tape.split(' ').length + ' words');
    log(f.last && f.last.reading === true,
      'it knows a reading is under way, which is what arms the fast look-back',
      f.last ? `run ${f.last.run}, ${f.last.tailGap} words still to go` : 'no reading');
    log(f.closeWant === true, '…and the fast local look-back really is armed', 'closeWant=' + f.closeWant);
  }

  /* =================================================================== */
  console.log('\n[6] Stale words never turn a page');
  {
    await openAt('John 1', 1);
    await js(win, `return await ${T}.listen.hearText('in the beginning was the word and the word was with god and the word was god', { partial: true });`);
    log((await shownVerse()) === 2, 'the reading turned it once', 'verse ' + (await shownVerse()));
    // The very same words again, as the next overlapping look-back would carry
    // them. Verse 2 must NOT turn on words that belong to verse 1.
    await js(win, `return await ${T}.listen.hearText('in the beginning was the word and the word was with god and the word was god', { partial: true });`);
    log((await shownVerse()) === 2, '…and the same words again do not turn it a second time',
      'verse ' + (await shownVerse()));

    // A new passage wipes the slate: nothing said before it was on the screen
    // may move it.
    await openAt('Romans 8', 28);
    const f = await js(win, `return ${T}.listen.follow();`);
    log(f.tape === '', 'putting a new passage up forgets everything heard before it', `“${f.tape}”`);
  }

  /* =================================================================== */
  console.log('\n[7] Switched off, it does nothing at all');
  {
    await openAt('John 1', 1);
    await js(win, `${T}.listen.setFollow(false); return 1;`);
    await js(win, `return await ${T}.listen.hearText('in the beginning was the word and the word was with god and the word was god', { partial: true });`);
    log((await shownVerse()) === 1, 'with the box unticked the page stays where the operator put it',
      'verse ' + (await shownVerse()));
  }

  console.log('\n[8] Console');
  const real = errs.filter((m) => !/Autofill|devtools|Electron Security|preload/i.test(m));
  log(real.length === 0, 'no renderer errors', real.slice(0, 3).join(' | '));

  console.log(failed ? '\n============  FAILED  ============\n' : '\n============  ALL PASSED  ============\n');
  try { versefind.stop(); } catch (e) {}
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
