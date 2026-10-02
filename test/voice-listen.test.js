'use strict';
/*
 * 🎤 LISTEN — SOMEBODY SPEAKS, AND THE RIGHT VERSE GOES ON THE WALL.
 *
 * Not a mock anywhere in the important part. A sentence is SPOKEN (Windows'
 * own voice, saved as audio), those samples go through the real speech engine
 * in the main process, the real parser decides what they meant, and the real
 * Presentation Studio puts the real verse on the real projector surface. What
 * this checks is the words that end up on the glass.
 *
 * The three things the operator asked for, in order:
 *   1. say a reference          -> that passage appears
 *   2. say "next verse"         -> it moves on one
 *   3. say "previous verse"     -> it moves back
 *
 * …and the fourth, which is the one that decides whether this can be left
 * running during a service: a stretch of ORDINARY PREACHING is spoken at it and
 * the screen must not move at all.
 *
 * Windows only, because it borrows the operating system's speech synthesiser to
 * do the talking. Everywhere else it says so and skips rather than pretending.
 *
 *   npx electron test/voice-listen.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const bible = require('../src/main/bible');
const voicelisten = require('../src/main/voicelisten');
const voiceref = require('../src/main/voiceref');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-voice-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false, passed = 0;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (v) passed++; else failed = true; };
const skip = (n, d) => console.log('  SKIP  ' + n + (d ? '  -> ' + d : ''));

/* ---------------------- a small Bible, really imported ----------------------
 * The lookup path is the app's own; only the corpus is small, so the test stays
 * offline and quick without faking the part being tested. */
const FIX = [];
const add = (book, chapter, verse, text) => FIX.push({ book, chapter, verse, text });
for (let v = 1; v <= 20; v++) add('John', 3, v, `John three verse ${v}. For God so loved the world, part ${v}.`);
for (let v = 1; v <= 23; v++) add('Philippians', 4, v, `Philippians four verse ${v}. Rejoice in the Lord always, part ${v}.`);
for (let v = 1; v <= 6; v++) add('Psalms', 1, v, `Psalm one verse ${v}. Blessed is the man, part ${v}.`);
for (let v = 1; v <= 6; v++) add('Psalms', 23, v, `Psalm twenty three verse ${v}. The Lord is my shepherd, part ${v}.`);
for (let v = 1; v <= 176; v++) add('Psalms', 119, v, `Psalm one nineteen verse ${v}. Thy word is a lamp, part ${v}.`);
for (let v = 1; v <= 39; v++) add('Romans', 8, v, `Romans eight verse ${v}. There is therefore now no condemnation, part ${v}.`);
for (let v = 1; v <= 31; v++) add('Isaiah', 40, v, `Isaiah forty verse ${v}. They that wait upon the Lord, part ${v}.`);
for (let v = 1; v <= 13; v++) add('1 Corinthians', 13, v, `First Corinthians thirteen verse ${v}. Love is patient, part ${v}.`);
for (let v = 1; v <= 48; v++) add('Matthew', 5, v, `Matthew five verse ${v}. Blessed are the poor in spirit, part ${v}.`);

/* ------------------------------- speech ------------------------------- */
const SAY_PS1 = path.join(tmp, 'say.ps1');
fs.writeFileSync(SAY_PS1, `param([string]$Out,[string]$Text,[string]$Voice)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice($Voice) } catch { }
$s.Rate = -1
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($Out,$fmt); $s.Speak($Text); $s.SetOutputToNull(); $s.Dispose()
`, 'utf8');
let clipNo = 0;
/** Say something out loud and hand back the samples, as base64 16-bit PCM. */
function speak(text, voice = 'Microsoft Hazel Desktop') {
  const wav = path.join(tmp, `clip${clipNo++}.wav`);
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SAY_PS1,
    '-Out', wav, '-Text', text, '-Voice', voice], { windowsHide: true, stdio: 'ignore' });
  const b = fs.readFileSync(wav);
  let pos = 12, data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4), sz = b.readUInt32LE(pos + 4);
    if (id === 'data') { data = b.slice(pos + 8, pos + 8 + sz); break; }
    pos += 8 + sz + (sz & 1);
  }
  if (!data) throw new Error('no samples in ' + wav);
  return data.toString('base64');
}

/* ------------------------------- harness ------------------------------- */
let store = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel' }, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', () => ok({}));
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
for (const ch of ['video:presets', 'scheduler:list', 'accounts:list', 'fonts:data', 'photos:list',
  'live:screenSources', 'bgvideo:installed']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('present:library', () => ok(store));
ipcMain.handle('present:savePresentation', wrap((e, { presentation }) => { store.presentations = [presentation]; return presentation; }));
ipcMain.handle('present:saveThemes', wrap((e, { themes }) => { store.themes = themes; return themes; }));
ipcMain.handle('present:savePlaylist', wrap(() => true));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('phone:state', () => ok({ running: false }));
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

/* the REAL listener, wired exactly as src/main/main.js wires it */
let voiceTranslation = null;
const verseCountCache = new Map();
function verseCountSync(bookNr, chapter) {
  if (!voiceTranslation) return null;
  const key = voiceTranslation + ':' + bookNr;
  if (!verseCountCache.has(key)) {
    let c = null; try { c = bible.verseCounts(voiceTranslation, bookNr); } catch (e) {}
    verseCountCache.set(key, c);
  }
  const c = verseCountCache.get(key);
  return c && c[chapter] != null ? c[chapter] : null;
}
ipcMain.handle('voice:available', wrap(async () => ({ ready: voicelisten.available() })));
ipcMain.handle('voice:warmUp', wrap(async () => ({ warm: await voicelisten.warmUp({}) })));
ipcMain.handle('voice:translation', wrap(async (e, { translation } = {}) => { voiceTranslation = translation || null; verseCountCache.clear(); return { translation: voiceTranslation }; }));
ipcMain.handle('voice:parse', wrap(async (e, { text, live } = {}) =>
  ({ text: text || '', intent: voiceref.parseVoice(text, { live, verseCount: verseCountSync }) })));
ipcMain.handle('voice:hear', wrap(async (e, { pcm, live } = {}) => {
  const buf = pcm && pcm.buffer ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) : Buffer.from(pcm || []);
  const pcm16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  return voicelisten.hear({ pcm16, live, verseCount: verseCountSync });
}));

app.disableHardwareAcceleration();
async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.Presenter.__test';

app.whenReady().then(async () => {
  console.log('\n== 🎤 LISTEN: speak, and the right verse goes up ==\n');

  if (process.platform !== 'win32') {
    skip('the whole test', 'it borrows Windows\' speech synthesiser to do the talking');
    app.quit(); return;
  }
  if (!voicelisten.available()) {
    console.log('  FAIL  the speech engine is not installed — nothing can be heard');
    failed = true; app.quit(); return;
  }

  /* ---- a translation, imported through the app's own importer ---- */
  bible.init(tmp);
  const fixFile = path.join(tmp, 'fixture.json');
  fs.writeFileSync(fixFile, JSON.stringify(FIX), 'utf8');
  const imported = bible.importFile(fixFile, { abbr: 'tst', name: 'Test Bible' });
  log(imported.verses > 300, 'a Bible is installed to read from', `${imported.books} books, ${imported.verses} verses`);
  voiceTranslation = 'tst';

  const t0 = Date.now();
  await voicelisten.warmUp({});
  console.log(`   speech engine warm in ${Date.now() - t0} ms\n`);

  const win = new BrowserWindow({
    show: false, width: 1500, height: 940,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);

  const ready = await js(win, `
    document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const T = ${T};
    await T.setTranslation('tst');
    T.setTab('bible');
    await new Promise((r) => setTimeout(r, 300));
    return { books: T.biblePicker().books, tab: T.tab ? T.tab() : 'bible' };
  `);
  log(!!ready && ready.books > 0, 'the Presentation Studio is open on the Bible panel',
    ready && ready.__error ? ready.__error : `${ready && ready.books} books in the picker`);

  /** Speak a line at the studio and report what the screen did. */
  async function say(text, voice) {
    const b64 = speak(text, voice);
    const t = Date.now();
    const r = await js(win, `return await ${T}.listen.hearPcm(${JSON.stringify(b64)});`);
    const cue = await js(win, `return ${T}.verseCue();`);
    return { r, cue, ms: Date.now() - t };
  }
  const onScreen = (cue) => (cue && cue.lines ? cue.lines.join(' ').replace(/\s+/g, ' ').trim() : '(nothing)');

  /* ============ 1. say a reference, and it goes up ============ */
  console.log('[1] "Turn with me to John chapter three verse sixteen."');
  {
    const { r, cue, ms } = await say('Turn with me to John chapter three verse sixteen.');
    log(onScreen(cue).indexOf('John three verse 16') >= 0, 'John 3 verse 16 is the one on the screen',
      cue ? `${cue.reference} #${cue.ix} — "${onScreen(cue)}"` : `nothing (heard: ${r && r.log})`);
    log(!!cue && cue.chunks >= 20, '…and the whole chapter is loaded behind it, so it can move on',
      cue ? `${cue.chunks} verses ready to step through` : 'none');
    console.log(`   heard and acted in ${ms} ms`);
  }

  /* ============ 2. "next verse" moves it on ============ */
  console.log('\n[2] "Next verse."');
  {
    const before = await js(win, `return ${T}.verseCue();`);
    const { cue, ms } = await say('Next verse.');
    log(!!cue && cue.ix === before.ix + 1, 'the screen moved on exactly one',
      `${before.ix} -> ${cue && cue.ix} — "${onScreen(cue)}"`);
    log(onScreen(cue).indexOf('verse 17') >= 0, '…and it is verse 17 that is showing', onScreen(cue));
    console.log(`   heard and acted in ${ms} ms`);
  }

  /* ============ 3. "previous verse" puts it back ============ */
  console.log('\n[3] "Previous verse."');
  {
    const before = await js(win, `return ${T}.verseCue();`);
    const { cue } = await say('Previous verse.');
    log(!!cue && cue.ix === before.ix - 1, 'the screen went back exactly one',
      `${before.ix} -> ${cue && cue.ix} — "${onScreen(cue)}"`);
    log(onScreen(cue).indexOf('verse 16') >= 0, '…and verse 16 is showing again', onScreen(cue));
  }

  /* ============ 4. jumping straight to a verse ============ */
  console.log('\n[4] "Go to verse twelve."');
  {
    const { cue } = await say('Go to verse twelve.');
    log(onScreen(cue).indexOf('verse 12') >= 0, 'verse 12 is on the screen', onScreen(cue));
  }

  /* ============ 5. a different book altogether ============ */
  console.log('\n[5] "Let\'s read Philippians chapter four verse six."');
  {
    const { cue, r } = await say("Let's read Philippians chapter four verse six.");
    log(onScreen(cue).indexOf('Philippians four verse 6') >= 0, 'the passage changed book',
      cue ? `${cue.reference} #${cue.ix} — "${onScreen(cue)}"` : `nothing (heard: ${r && r.log})`);
  }

  /* ============ 6. a second voice, so it is not one accent ============ */
  console.log('\n[6] A different speaker: "Isaiah forty verse thirty one."');
  {
    const { cue, r } = await say('Isaiah forty verse thirty one.', 'Microsoft Zira Desktop');
    log(onScreen(cue).indexOf('Isaiah forty verse 31') >= 0, 'it followed a different voice too',
      cue ? `${cue.reference} #${cue.ix} — "${onScreen(cue)}"` : `nothing (heard: ${r && r.log})`);
  }

  /* ====== 7. THE ONE THAT DECIDES IT: preaching must move nothing ====== */
  console.log('\n[7] Ordinary preaching — the screen must not move');
  {
    const sermon = [
      'Good morning church, and welcome to the house of God.',
      'We will come back to that in a moment.',
      'The next thing I want you to see is how Paul responds.',
      'He was one of the twelve who followed him.',
      'Next week we are starting a new series.',
      'I have three points this morning.',
      'That happened three or four times in his ministry.',
      'Anxiety is loud, but prayer is louder.',
    ];
    const before = await js(win, `return ${T}.verseCue();`);
    let moved = 0;
    for (const line of sermon) {
      const { cue } = await say(line);
      const same = cue && before && cue.reference === before.reference && cue.ix === before.ix;
      if (!same) { moved++; console.log(`   MOVED on: "${line}" -> ${cue && cue.reference} #${cue && cue.ix}`); }
    }
    log(moved === 0, `${sermon.length} sentences of preaching left the screen exactly where it was`,
      moved ? `${moved} of them moved it` : 'it did not move');
  }

  /* ============ 8. and it can still be told to clear ============ */
  console.log('\n[8] "Clear the screen."');
  {
    const { r } = await say('Clear the screen.');
    const black = await js(win, `return document.getElementById('pvBlack').classList.contains('on');`);
    log(black === true, 'the screen went black on the word', `blackout ${black} (heard: ${r && r.log})`);
  }

  /* ============ 9. choosing which microphone to listen to ============
   *
   * A PC's own microphone will not hear a preacher across a hall, so the one
   * being listened to has to be the operator's choice and has to stick.
   */
  console.log('\n[9] The microphone picker');
  {
    const list = await js(win, `return await ${T}.listen.mics();`);
    log(!!list && Array.isArray(list.options) && list.options.length > 0,
      'the picker offers something', list && list.options ? `${list.options.length} option(s)` : String(list && list.__error));
    const real = list.options.filter((o) => o.value);
    log(list.options[0] && list.options[0].value === '' && /default/i.test(list.options[0].label),
      'the first choice is the default microphone, so it works untouched',
      list.options[0] ? list.options[0].label : 'none');
    log(!list.options.some((o) => o.value === 'default' || o.value === 'communications'),
      'the OS alias entries are not offered as separate microphones',
      list.options.map((o) => o.value || '(default)').join(', ') || 'none');

    if (!real.length) {
      skip('picking a named microphone', 'this machine has no audio input devices to pick from');
    } else {
      const pick = await js(win, `return await ${T}.listen.pickMic(${JSON.stringify(real[0].value)});`);
      log(pick && pick.chosen === real[0].value && pick.saved === real[0].value,
        'picking one selects it and records it', `${real[0].label} -> ${pick && pick.chosen}`);
      const kept = await js(win, `
        const raw = JSON.parse(localStorage.getItem('mw-pv') || '{}');
        return { stored: raw.listenMic };
      `);
      log(kept && kept.stored === real[0].value, '…and it is remembered for the next service',
        `stored ${JSON.stringify(kept && kept.stored)}`);

      /* The desk feed gets unplugged between one Sunday and the next. */
      const gone = await js(win, `
        const T = ${T};
        // pretend the chosen device is no longer attached
        const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
        navigator.mediaDevices.enumerateDevices = async () =>
          (await real()).filter((d) => d.deviceId !== ${JSON.stringify(real[0].value)});
        const after = await T.listen.mics();
        navigator.mediaDevices.enumerateDevices = real;
        return after;
      `);
      const marked = gone && gone.options.find((o) => o.value === real[0].value);
      log(!!marked && /not connected/i.test(marked.label),
        'an unplugged microphone is shown as unplugged, not silently swapped',
        marked ? marked.label : gone && gone.options.map((o) => o.label).join(' | '));
      log(gone && gone.saved === real[0].value, '…and the choice is not thrown away',
        `still ${JSON.stringify(gone && gone.saved)}`);

      await js(win, `return await ${T}.listen.pickMic('');`);
    }
  }

  console.log(`\n${passed} passed${failed ? ', SOMETHING FAILED' : ', nothing failed'}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  app.exit(failed ? 1 : 0);
});
