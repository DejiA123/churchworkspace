'use strict';
/*
 * ►► THE HEARING PANEL, FROM THE OPERATOR'S CHAIR ◄◄
 *
 * The engine underneath is tested by test/cloud-listen.test.js. This is about
 * the thing a church actually touches: a picker that says who is listening, a
 * box to paste a free key into, and a Test button that answers in milliseconds
 * measured from THIS building.
 *
 * The checks are shaped by what has gone wrong in this panel before. Twice now
 * the studio has REPORTED one speech model while RUNNING another (see
 * resolveModel in voicelisten.js, and test/listen-model.test.js), and both times
 * nothing threw — the label simply lied, and an operator trusted it. Adding a
 * second engine doubles the number of ways that can happen, so the assertion
 * that matters most here is the same one: what the panel says is listening is
 * what is actually listening.
 *
 * It also covers the plumbing that would otherwise fail silently in a service:
 * that switching engine really reaches the settings store, that a key is never
 * sent back to the page, and that the setup for the engine NOT in use is out of
 * the way rather than sitting there inviting a wrong click.
 *
 *   npm run test:cloud-listen-ui
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cloudlisten-'));
app.setPath('userData', path.join(WORK, 'ud'));

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });

/*
 * The REAL cloudspeech module, with a fake settings store around it — which is
 * the same shape main.js wires up. Faking the module instead would test a mock;
 * what is wanted here is that the page and the real engine agree.
 */
const cloudspeech = require('../src/main/cloudspeech');
const voicelisten = require('../src/main/voicelisten');
let saved = { on: false, provider: 'groq', key: '', model: '', url: '' };
const saveCloud = (patch) => { saved = Object.assign({}, saved, patch); return cloudspeech.configure(saved); };
let opened = '';

ipcMain.handle('voice:cloudState', () => ok(cloudspeech.state()));
ipcMain.handle('voice:cloudSet', (e, patch) => ok(saveCloud(patch || {})));
ipcMain.handle('voice:cloudTest', async (e, patch) => {
  if (patch) saveCloud(patch);
  const r = await cloudspeech.test();
  return ok(Object.assign({}, r, { state: cloudspeech.state() }));
});
ipcMain.handle('voice:cadence', () => ok(cloudspeech.ready() ? cloudspeech.cadence() : null));
ipcMain.handle('voice:available', () => ok({
  ready: voicelisten.available(), how: voicelisten.how(),
  cadence: cloudspeech.ready() ? cloudspeech.cadence() : null,
}));
ipcMain.handle('voice:warmUp', () => ok({
  warm: true, modelId: 'base.en', resident: false, residentWhy: '', how: voicelisten.how(),
}));
ipcMain.handle('shell:openExternal', (e, { url }) => { opened = url; return ok(true); });

const mem = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel' }, accounts: {}, apiKeys: {}, present: { translation: 'kjv' } }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', appVersion: '9.9.9-test' }));
ipcMain.handle('present:library', () => ok(mem));
for (const ch of ['scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'present:displays',
  'bible:installed', 'bible:catalogue', 'live:screenSources', 'live:destinations', 'bgvideo:installed']) {
  ipcMain.handle(ch, () => ok([]));
}
// The local model catalogue, so the "This PC" side of the picker is real too.
ipcMain.handle('captions:models', () => ok([
  { id: 'base.en', name: 'Base — bundled', installed: true, sizeMB: 74 },
  { id: 'small.en', name: 'Small — better', installed: false, sizeMB: 466 },
]));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('present:set', () => ok(true));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('bible:books', () => ok({ books: [] }));
ipcMain.handle('voice:quoteState', () => ok({ ready: false }));
// Panels this test does not exercise, stubbed only so their absence does not
// scroll a page of handler errors past the checks that matter.
ipcMain.handle('phone:state', () => ok({ enabled: false }));
ipcMain.handle('cloud:state', () => ok({ running: false }));
ipcMain.handle('llm:status', () => ok({ installed: false, models: [], runtime: false }));
ipcMain.handle('captions:fontList', () => ok(['Arial']));

const js = (win, src) => win.webContents
  .executeJavaScript(`(async () => {
     try { const __r = await (async () => { ${src} })(); return JSON.stringify(__r === undefined ? null : __r); }
     catch (e) { return JSON.stringify({ __error: (e && e.message) + '\\n' + (e && e.stack) }); }
   })()`)
  .then((s) => { try { return JSON.parse(s); } catch (e) { return { __error: 'unparsable: ' + String(s).slice(0, 200) }; } },
    (e) => ({ __error: 'rejected: ' + String((e && e.message) || e) }));

app.whenReady().then(async () => {
  console.log('== HEARING PANEL ==');
  const win = new BrowserWindow({
    show: false, width: 1600, height: 1000,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  const pageErrors = [];
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 3) pageErrors.push(msg); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1800);
  await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-present').classList.add('active');
    window.Presenter.onShow();
    return true;`);
  await sleep(600);
  // Opening the microphone list is what draws this panel, which is also what
  // happens when an operator clicks into it.
  await js(win, `await window.Presenter.__test.refreshMics(); return true;`);
  await sleep(700);

  /* ------------------------------------------------------------------ */
  console.log('\n[1] Who is listening, offered as a choice');
  const picker = await js(win, `
    const sel = document.getElementById('pvListenEngine');
    return { found: !!sel, options: [...sel.options].map(o => ({ v: o.value, t: o.textContent })), value: sel.value };`);
  log(picker.found === true, 'the Hearing picker is on the page');
  log(picker.options.some((o) => o.v === 'cloud:groq'), 'the free cloud ear is offered',
    (picker.options.find((o) => o.v === 'cloud:groq') || {}).t);
  /*
   * It has to say "free" in the first few words, not somewhere after them. The
   * rail this picker lives in is about 420 px wide and a <select> truncates
   * without mercy: "Cloud — Whisper Large v3 Turbo (free)" arrives on screen as
   * "Cloud — Whisper Lar", which answers none of the question a church has.
   */
  log(/^free/i.test(((picker.options.find((o) => o.v === 'cloud:groq') || {}).t || '').trim()),
    'and it says it is free BEFORE the part that gets truncated away');
  log(picker.options.some((o) => o.v === 'local'), 'this PC is still offered, for a hall with no internet',
    (picker.options.find((o) => o.v === 'local') || {}).t);
  log(picker.options.some((o) => o.v === 'cloud:openrouter'), 'so is OpenRouter, for a church that already has an account');
  log(picker.value === 'local', 'and nothing is sent anywhere until somebody chooses it', picker.value);

  /* ------------------------------------------------------------------ */
  console.log('\n[2] Only the setup that belongs to the chosen engine is on show');
  const offBefore = await js(win, `
    return { cloudBox: !document.getElementById('pvListenCloudBox').classList.contains('hidden'),
             modelRow: !document.getElementById('pvListenModelRow').classList.contains('hidden'),
             fastRow: !document.getElementById('pvListenFastRow').classList.contains('hidden') };`);
  log(offBefore.cloudBox === false, 'on "this PC" the key box is out of the way');
  log(offBefore.modelRow === true, '…and the on-this-PC model picker is there');

  const switched = await js(win, `
    const sel = document.getElementById('pvListenEngine');
    sel.value = 'cloud:groq';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    return { cloudBox: !document.getElementById('pvListenCloudBox').classList.contains('hidden'),
             modelRow: !document.getElementById('pvListenModelRow').classList.contains('hidden'),
             fastRow: !document.getElementById('pvListenFastRow').classList.contains('hidden'),
             blurb: document.getElementById('pvListenCloudBlurb').textContent,
             models: [...document.getElementById('pvListenCloudModel').options].map(o => o.value),
             getBtn: document.getElementById('pvListenCloudGet').textContent };`);
  log(switched.cloudBox === true, 'choosing the cloud ear brings up its setup');
  log(switched.modelRow === false, '…and puts the on-this-PC model picker away');
  /* "Faster replies" keeps a whisper model resident on this machine. With the
   * cloud ear there is no such model, so leaving the tick box there would be a
   * setting that cannot do anything — which is worse than no setting. */
  log(switched.fastRow === false, '…along with "Faster replies", which means nothing without a local model');
  log(/free/i.test(switched.blurb), 'it says plainly what it costs', JSON.stringify(switched.blurb));
  log(switched.models.indexOf('whisper-large-v3-turbo') === 0,
    'and the full-size Whisper model is what it will use', switched.models.join(', '));
  log(/free key/i.test(switched.getBtn), 'with one button to go and get a key', switched.getBtn);

  /* ------------------------------------------------------------------ */
  console.log('\n[3] The choice reaches the engine, not just the dropdown');
  const reached = await js(win, `return await window.api.voice.cloudState();`);
  log(reached.on === true && reached.provider === 'groq',
    'main really is set to the cloud ear now', `on=${reached.on} provider=${reached.provider}`);
  log(reached.hasKey === false, '…but it is not READY, because there is no key yet');
  log(reached.ready === false, 'so nothing would be sent');

  const gotKey = await js(win, `
    const btn = document.getElementById('pvListenCloudGet');
    btn.click();
    await new Promise(r => setTimeout(r, 200));
    return true;`);
  log(gotKey === true && /console\.groq\.com/.test(opened),
    'the button opens the free sign-up page in a browser', opened);

  /* ------------------------------------------------------------------ */
  console.log('\n[4] Pasting a key');
  const pasted = await js(win, `
    const k = document.getElementById('pvListenCloudKey');
    k.focus(); k.value = 'gsk_pretend_key_for_the_test';
    k.dispatchEvent(new Event('blur'));
    await new Promise(r => setTimeout(r, 500));
    const st = await window.api.voice.cloudState();
    return { boxShows: k.value, hasKey: st.hasKey, ready: st.ready };`);
  log(pasted.hasKey === true, 'the key reaches main');
  log(pasted.ready === true, '…and the cloud ear is now the one that will answer');
  /*
   * The key must never come back to the page. It is in a settings file the
   * operator owns; echoing it into the DOM puts it on every screen share and
   * every screenshot of a Sunday morning problem.
   */
  log(/^•+$/.test(pasted.boxShows), 'but the key itself is never shown back', JSON.stringify(pasted.boxShows));

  /* ------------------------------------------------------------------ */
  console.log('\n[5] What the panel SAYS is listening is what IS listening');
  const label = await js(win, `
    await window.Presenter.__test.noteListenModel();
    await new Promise(r => setTimeout(r, 300));
    return { note: document.getElementById('pvListenModelNote').textContent,
             fuel: document.getElementById('pvListenCloudNote').textContent };`);
  const how = voicelisten.how();
  log(/whisper-large-v3-turbo/.test(label.note),
    'the label names the cloud model, not a local one that is being asked nothing',
    JSON.stringify(label.note));
  log(how.via === 'cloud', 'and main agrees that is what would answer', how.via);

  /* ------------------------------------------------------------------ */
  console.log('\n[6] Test, from this building, on this key');
  const tested = await js(win, `
    document.getElementById('pvListenCloudTest').click();
    await new Promise(r => setTimeout(r, 12000));
    return document.getElementById('pvListenCloudNote').textContent;`);
  /*
   * A made-up key must come back REFUSED and say so. The failure this is
   * guarding is not "the test fails" — it is a Test button that goes quiet, or
   * claims success, and sends an operator into a service believing a key works.
   */
  log(/⚠️/.test(String(tested)) && /refused|not answer/i.test(String(tested)),
    'a made-up key is reported as refused, in words', JSON.stringify(tested));
  log(!/% of this hour/.test(String(tested)),
    '…and the answer is not overwritten by the allowance readout redrawing behind it');
  const after = await js(win, `return await window.api.voice.cloudState();`);
  log(after.ready === false, '…and the engine stops asking rather than retrying all service',
    `cooling ${Math.round(after.cooling / 1000)}s: ${after.why}`);

  /* ------------------------------------------------------------------ */
  console.log('\n[7] Going back to this PC');
  const back = await js(win, `
    const sel = document.getElementById('pvListenEngine');
    sel.value = 'local';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    const st = await window.api.voice.cloudState();
    return { on: st.on, cloudBox: !document.getElementById('pvListenCloudBox').classList.contains('hidden'),
             modelRow: !document.getElementById('pvListenModelRow').classList.contains('hidden'),
             cadence: await window.api.voice.cadence() };`);
  log(back.on === false, 'switching back really switches the cloud ear off');
  log(back.cloudBox === false && back.modelRow === true, '…and the panel goes back to the local model picker');
  log(back.cadence === null, 'and the ear goes back to its own pace, which has no allowance to respect');

  console.log('\n[8] Console');
  log(pageErrors.length === 0, 'no renderer errors', pageErrors.slice(0, 3).join(' | ') || 'clean');

  console.log(failed ? '\n====  HEARING PANEL FAILED  ====\n' : '\n====  HEARING PANEL PASSED  ====\n');
  win.destroy();
  app.quit();
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
