'use strict';
/*
 * ✨ THE CAPTION WRITER, IN THE REAL PAGES.
 *
 * cloud-write.test.js proves the writing. This proves the two things around it
 * that an operator would actually hit:
 *
 *   1. SETTINGS. Can they choose a writer, paste a key, test it, and see which
 *      one is in use? And — the one that would be found the hard way, on a
 *      Sunday — does pressing SAVE SETTINGS keep the key? The settings patch
 *      replaces a whole section, so `social: { eventName, speakers, allowBait }`
 *      would have quietly deleted `social.cloud` and with it the key, leaving a
 *      button that used to write good captions and now writes template ones,
 *      with nothing on screen to explain it.
 *
 *   2. THE SCHEDULER. Does "✨ Write the title & caption for me" fill the fields,
 *      offer the three options, and SAY which ear heard the clip and which
 *      writer wrote it — so "it's terrible again" has a diagnosis rather than a
 *      shrug.
 *
 *   npx electron test/cloud-write-ui.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const socialCopy = require(path.join(ROOT, 'src/main/social-copy'));
const cloudwrite = require(path.join(ROOT, 'src/main/cloudwrite'));

const WORK = path.join(os.tmpdir(), 'mw-cloudwrite-ui');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const CLIP = path.join(WORK, 'short-Give_me_this_mountain-captioned-20260920-101500.mp4');
fs.writeFileSync(CLIP, 'x');

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERMON = 'Caleb was eighty five years old when he said give me this mountain. He did not look at his '
  + 'age, he looked at the promise of God. If you serve God with the whole of your heart, your blessing is '
  + 'not by chance. Bishop Oke says the door is not locked, it is simply not your turn yet.';

/* ---------------- a store that behaves exactly like the real one ----------
 * Including the shallow top-level merge in settings:update, because that merge
 * IS the bug this file is here to catch. */
let SETTINGS = {
  brand: { churchName: 'The Power House International', primaryColor: '#1f6feb', accentColor: '#f5a623' },
  social: { eventName: 'All Ireland Outpouring', speakers: 'Bishop Francis Wale Oke', allowBait: false },
  accounts: {}, apiKeys: { anthropic: '', image: '', bible: '' },
  listen: { cloud: { on: true, provider: 'groq', key: 'gsk_from_the_listen_panel', model: '' } },
};
const KEEP_NESTED = { social: ['cloud'], listen: ['cloud'] };
const CLOUD_WRITE_DEFAULTS = { on: true, provider: 'groq', key: '', model: '', url: '' };
const cloudWriteCfg = () => Object.assign({}, CLOUD_WRITE_DEFAULTS, (SETTINGS.social || {}).cloud);
function saveCloudWrite(patch) {
  const social = Object.assign({}, SETTINGS.social);
  social.cloud = Object.assign({}, CLOUD_WRITE_DEFAULTS, social.cloud, patch);
  SETTINGS = Object.assign({}, SETTINGS, { social });
  cloudwrite.shareKey((SETTINGS.listen.cloud || {}).provider, (SETTINGS.listen.cloud || {}).key);
  return cloudwrite.configure(social.cloud);
}

const ok = (d) => ({ ok: true, data: d });
ipcMain.handle('settings:get', () => ok(SETTINGS));
ipcMain.handle('settings:update', (_e, { patch }) => {
  const prev = SETTINGS;
  const merged = { ...prev, ...patch };
  for (const [section, keys] of Object.entries(KEEP_NESTED)) {
    if (!patch || !patch[section]) continue;
    for (const k of keys) {
      if (patch[section][k] === undefined && prev[section] && prev[section][k] !== undefined) {
        merged[section] = { ...merged[section], [k]: prev[section][k] };
      }
    }
  }
  SETTINGS = merged;
  return ok(SETTINGS);
});
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('shell:openExternal', (_e, { url }) => { opened.push(url); return ok(true); });
ipcMain.handle('shell:openPath', () => ok(true));
ipcMain.handle('shell:showItem', () => ok(true));
const opened = [];

ipcMain.handle('social:cloudState', () => ok(cloudwrite.state()));
ipcMain.handle('social:cloudSet', (_e, patch) => ok(saveCloudWrite(patch || {})));
ipcMain.handle('social:cloudTest', async (_e, patch) => {
  if (patch) saveCloudWrite(patch);
  const r = await cloudwrite.test();
  return ok(Object.assign({}, r, { state: cloudwrite.state() }));
});

/* The handler, in the same shape main.js builds it: a cloud writer when there
 * is one, and the words it was given. Transcription is stubbed — what is under
 * test here is the wiring and the wording, not whisper. */
let TRANSCRIPT = SERMON;
let HEARD_BY = 'cloud';
ipcMain.handle('social:suggestCopy', async (_e, a) => {
  const cloudReady = cloudwrite.ready();
  const writer = cloudReady
    ? { isAvailable: () => cloudwrite.isAvailable(), chat: (x) => cloudwrite.chat(x),
        parseJson: (t) => cloudwrite.parseJson(t), polish: true }
    : null;
  const out = await socialCopy.suggest({
    mediaPath: a.mediaPath, kind: a.kind, churchName: SETTINGS.brand.churchName,
    eventName: SETTINGS.social.eventName,
    speakers: String(SETTINGS.social.speakers || '').split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean),
    allowBait: !!SETTINGS.social.allowBait, transcript: TRANSCRIPT, llm: writer,
    // As main.js does: a batch asks for the quick version, which skips the
    // second editing pass and halves what a caption costs.
    quick: !!a.quick,
  });
  return ok(Object.assign({}, out, {
    // As in main.js: the ear having LISTENED and heard nothing is a different
    // answer from no ear having run at all, and the wording turns on it.
    heardBy: HEARD_BY,
    wroteBy: out.source === 'ai' ? (cloudReady ? 'cloud' : 'local') : 'rules',
    writerName: cloudReady ? cloudwrite.state().providerName : '',
    writerWhy: out.source === 'ai' ? '' : (cloudwrite.state().why || ''),
  }));
});
ipcMain.handle('social:planSchedule', () => ok([]));
ipcMain.handle('dialog:openFile', (_e, a) => ok((a && a.multi) || BULK.length ? BULK : CLIP));

/* ---- the cloud, faked at the socket ---- */
const THREE = JSON.stringify({ options: [
  { title: 'He was 85 and still asked for a mountain ⚡',
    caption: 'Caleb was 85 when he asked for a mountain.\n\n"He did not look at his age, he looked at the promise of God." '
      + 'Bishop Francis Wale Oke, preaching at the All Ireland Outpouring.\nYour age was never the thing in the way.\n\n'
      + '#BishopFrancisWaleOke #AllIrelandOutpouring #FaithInAction #Revival #GospelTruth #ChristianReels' },
  { title: 'The door is not locked 🔥',
    caption: 'The door is not locked. It is not your turn yet.\n\nBishop Francis Wale Oke at the All Ireland Outpouring, '
      + 'on the years that feel like nothing is moving.\nSome of you needed that today.\n\n'
      + '#BishopFrancisWaleOke #AllIrelandOutpouring #Breakthrough #Revival #FaithInAction #ChristianTikTok' },
  { title: 'Your blessing is not by chance 📖',
    caption: '"Your blessing is not by chance."\n\nBishop Francis Wale Oke, at the All Ireland Outpouring, on what it costs '
      + 'to serve God with the whole of your heart.\nThat is still true of you today.\n\n'
      + '#BishopFrancisWaleOke #AllIrelandOutpouring #GraceAndMercy #WalkByFaith #GospelTruth #ChristianInspiration' },
] });
let netCalls = 0;     // chat calls only — the model listing is not one of them
let CHAT_DELAY = 0;   // make every answer cost what a real one costs
let CHAT_STATUS = null;  // …or make the provider refuse, the way a retired model does
let BULK = [];        // what the bulk file picker hands back
global.fetch = async (url, opts) => {
  /*
   * The writer asks WHICH MODELS THIS ACCOUNT HAS before it asks any of them to
   * write anything (see discoverModels in cloudwrite.js). That is a GET with no
   * body; answering it here keeps the test on the real path instead of the
   * "could not list them" fallback.
   */
  if (!opts || !opts.body) {
    return { ok: true, status: 200, headers: { get: () => null },
             json: async () => ({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }] }),
             text: async () => '' };
  }
  netCalls++;
  const body = JSON.parse(opts.body);
  if (CHAT_DELAY) await sleep(CHAT_DELAY);
  if (CHAT_STATUS) {
    return { ok: false, status: CHAT_STATUS.status, headers: { get: () => null },
             json: async () => ({}), text: async () => CHAT_STATUS.text };
  }
  const isPolish = /ruthless/i.test((body.messages[0] || {}).content || '')
    || body.messages.some((m) => /ruthless/i.test(m.content || ''));
  const content = isPolish ? JSON.stringify({ options: [{ score: 9 }, { score: 9 }, { score: 9 }] }) : THREE;
  return { ok: true, status: 200, headers: { get: () => null },
           json: async () => ({ choices: [{ message: { content } }] }),
           text: async () => content };
};

app.disableHardwareAcceleration();
const js = (w, src) => w.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

app.whenReady().then(async () => {
  cloudwrite.configure(cloudWriteCfg());
  cloudwrite.shareKey('groq', SETTINGS.listen.cloud.key);

  const errs = [];
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 3) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1500);

  /* =================================================================== */
  console.log('\n[1] Settings: the operator can see and choose who writes');
  const panel = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-settings').classList.add('active');
    await new Promise(r => setTimeout(r, 300));
    const sel = document.getElementById('cwEngine');
    return {
      there: !!sel,
      choices: sel ? [...sel.options].map(o => o.text) : [],
      value: sel ? sel.value : null,
      status: (document.getElementById('cwStatus') || {}).textContent,
      shared: (document.getElementById('cwShared') || {}).textContent,
      setupOpen: !document.getElementById('cwSetup').classList.contains('hidden'),
      models: [...document.getElementById('cwModel').options].map(o => o.text),
    };`);
  if (panel.__error) console.error('[1] ' + panel.__error);
  log(panel.there, 'the writer picker is on the Settings page');
  log(panel.choices.some((c) => /free cloud/i.test(c)), 'the free cloud writer leads the list', panel.choices.join(' | '));
  log(panel.choices.some((c) => /rules/i.test(c)), 'and the built-in rules are still an option anybody can pick');
  log(/ready/i.test(panel.status || ''), 'it says whether it is actually ready to write', panel.status);
  log(/🎤 Listen/.test(panel.shared || ''),
    '►► it says the key is the one already set up for 🎤 Listen, instead of asking for it again ◄◄', panel.shared);
  log(panel.models.length >= 2, 'a model can be chosen, with fallbacks behind it', panel.models.length + ' models');

  console.log('\n[2] Test it, from the operator’s chair');
  const tested = await js(win, `
    document.getElementById('cwTest').click();
    await new Promise(r => setTimeout(r, 700));
    return { result: document.getElementById('cwTestResult').textContent,
             status: document.getElementById('cwStatus').textContent };`);
  if (tested.__error) console.error('[2] ' + tested.__error);
  log(/✅/.test(tested.result), 'pressing Test asks the real service and reports the round trip', tested.result);
  log(/ms/.test(tested.result), '…in milliseconds, which is the question being asked');

  /* =================================================================== */
  console.log('\n[3] ►► Pressing Save Settings must not delete the key ◄◄');
  const before = JSON.stringify(SETTINGS.social.cloud || null);
  const saved = await js(win, `
    document.getElementById('setEventName').value = 'All Ireland Outpouring 2026';
    document.getElementById('saveSettings').click();
    await new Promise(r => setTimeout(r, 600));
    return document.getElementById('toast').textContent;`);
  if (saved.__error) console.error('[3] ' + saved.__error);
  log(/saved/i.test(saved), 'the save went through', saved);
  log(SETTINGS.social.eventName === 'All Ireland Outpouring 2026', 'the event name really was written',
    SETTINGS.social.eventName);
  log(JSON.stringify(SETTINGS.social.cloud || null) === before,
    'and the writer’s own settings survived the save', JSON.stringify(SETTINGS.social.cloud));
  log(cloudwrite.ready(), '…so the writer is still ready afterwards');

  /* =================================================================== */
  console.log('\n[4] The Scheduler button, with the cloud writer on');
  netCalls = 0;
  const wrote = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-scheduler').classList.add('active');
    document.getElementById('pickPostMedia').click();
    await new Promise(r => setTimeout(r, 400));
    document.getElementById('sWriteForMe').click();
    await new Promise(r => setTimeout(r, 1200));
    return {
      title: document.getElementById('sTitle').value,
      caption: document.getElementById('sCaption').value,
      cards: document.querySelectorAll('#copyOptions .copy-opt').length,
      toast: document.getElementById('toast').textContent,
    };`);
  if (wrote.__error) console.error('[4] ' + wrote.__error);
  log(/85|mountain/i.test(wrote.title), 'the cloud writer’s title is in the field', wrote.title);
  log(wrote.cards === 3, 'all three options are offered as cards', wrote.cards + ' cards');
  log(/All Ireland Outpouring/.test(wrote.caption), 'the caption plants the flag');
  log(/#BishopFrancisWaleOke/.test(wrote.caption), 'and credits the speaker first in the hashtags');
  log(wrote.caption.split('\n')[0].split(/\s+/).length <= 12,
    'the first line stands on its own, which is all most people will read',
    JSON.stringify(wrote.caption.split('\n')[0]));
  log(netCalls === 2, 'it wrote, then went back and edited itself', netCalls + ' calls');

  console.log('\n[5] …and it SAYS who heard the clip and who wrote the words');
  log(/Groq/i.test(wrote.toast), 'the writer is named', wrote.toast);
  log(/cloud speech model/i.test(wrote.toast), 'so is the ear');

  /* =================================================================== */
  console.log('\n[5b] >> WRITE CAPTIONS FOR ALL OF THEM <<');
  {
    /*
     * The operator's complaint was about this button specifically. Two things
     * were wrong with it and they compound:
     *
     *   - it wrote the clips ONE AT A TIME, and almost all of that time is spent
     *     waiting on a machine somewhere else, so eight clips took eight waits;
     *   - and when the writer could not answer, the rules filled every card in
     *     with template copy that LOOKED finished, with nothing to say the model
     *     had never been asked.
     */
    BULK = Array.from({ length: 8 }, (_, i) => {
      const f = path.join(WORK, 'WhatsApp Video 2026-09-21 at ' + (9 + i) + '.00.mp4');
      fs.writeFileSync(f, 'x');
      return f;
    });
    CHAT_DELAY = 300;                 // every answer costs the same as a real one
    netCalls = 0;
    const run = await js(win, `
      const t0 = Date.now();
      document.getElementById('pickPostBatch').click();
      await new Promise(r => setTimeout(r, 500));
      const files = document.querySelectorAll('#bulkList .bulk-item').length;
      document.getElementById('bulkWriteAll').click();
      // long enough for four lanes, nowhere near long enough for eight in a row
      for (let i = 0; i < 60 && document.getElementById('bulkWriteAll').disabled; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      return {
        files, ms: Date.now() - t0,
        toast: document.getElementById('toast').textContent,
        states: [...document.querySelectorAll('#bulkList .bi-state')].map(e => e.textContent),
        caps: [...document.querySelectorAll('#bulkList .bi-cap')].map(e => e.value),
        titles: [...document.querySelectorAll('#bulkList .bi-title')].map(e => e.value),
      };`);
    if (run.__error) console.error('[5b] ' + run.__error);
    log(run.files === 8, 'eight clips are in the batch', run.files + ' files');
    log(run.titles.every((t) => t && t.length > 8), 'every one of them got a title',
      run.titles.filter((t) => t && t.length > 8).length + '/8');
    log(run.states.every((s) => /written by/.test(s)),
      '>> and every one was written by the AI, not by the rules <<',
      run.states[0]);
    /*
     * Eight answers at 300 ms each is 2.4 s in a row. Four lanes is two rounds,
     * about 0.6 s of waiting — so anything under a second and a half proves they
     * really did overlap, without being so tight that a slow machine fails it.
     */
    log(run.ms < 1500, '>> they were written four at a time, not one after another <<',
      run.ms + ' ms for 8 clips at ' + CHAT_DELAY + ' ms each (in a row would be ' + (8 * CHAT_DELAY) + ' ms)');
    log(netCalls === 8, 'a batch spends ONE call per clip, not two', netCalls + ' calls for 8 clips');
    log(/in \d+s/.test(run.toast) && /all by/.test(run.toast),
      'and it says how long it took and who wrote them', run.toast);
  }

  console.log('\n[5c] >> AND WHEN THE WRITER CANNOT ANSWER, IT SAYS SO <<');
  {
    // Exactly what the operator hit: every model retired underneath it.
    CHAT_STATUS = { status: 404, text: '{"error":{"code":"model_not_found","message":"gone"}}' };
    const run = await js(win, `
      document.getElementById('bulkWriteAll').click();
      for (let i = 0; i < 60 && document.getElementById('bulkWriteAll').disabled; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      return {
        toast: document.getElementById('toast').textContent,
        cls: (document.getElementById('toast').className || ''),
        states: [...document.querySelectorAll('#bulkList .bi-state')].map(e => e.textContent),
        caps: [...document.querySelectorAll('#bulkList .bi-cap')].map(e => e.value),
      };`);
    if (run.__error) console.error('[5c] ' + run.__error);
    log(run.caps.every((c) => c && c.length > 40),
      'the operator still gets something postable for every clip', run.caps.length + ' captions');
    log(/rules/i.test(run.toast) && /error/.test(run.cls),
      '>> but it is reported as a PROBLEM, not as a success <<', run.toast);
    log(/Settings/.test(run.toast), 'and it points at the one place that can fix it');
    log(run.states.every((s) => /^📝/.test(s)),
      'every card is marked as rules-written rather than looking like the real thing',
      run.states[0]);
    CHAT_STATUS = null; CHAT_DELAY = 0;
  }

  /* =================================================================== */
  console.log('\n[6] With no key at all it still works, and says what is missing');
  saveCloudWrite({ on: false });
  cloudwrite.shareKey('groq', '');
  const rules = await js(win, `
    document.getElementById('sTitle').value = '';
    document.getElementById('sWriteForMe').click();
    await new Promise(r => setTimeout(r, 900));
    return { title: document.getElementById('sTitle').value,
             caption: document.getElementById('sCaption').value,
             toast: document.getElementById('toast').textContent };`);
  if (rules.__error) console.error('[6] ' + rules.__error);
  log(rules.title.length > 8 && rules.caption.length > 40, 'the button still produces a postable caption', rules.title);
  log(/All Ireland Outpouring/.test(rules.caption), 'still with the event in it');
  log(/rules/i.test(rules.toast) && /Settings/.test(rules.toast),
    'and it points at the setting that would make it better instead of just being worse', rules.toast);

  console.log('\n[7] A clip with nothing said in it is not written about anyway');
  TRANSCRIPT = ''; HEARD_BY = 'cloud';
  const silent = await js(win, `
    document.getElementById('sWriteForMe').click();
    await new Promise(r => setTimeout(r, 900));
    return { title: document.getElementById('sTitle').value,
             toast: document.getElementById('toast').textContent };`);
  if (silent.__error) console.error('[7] ' + silent.__error);
  log(/Give Me This Mountain/i.test(silent.title), 'it falls back to the file name', silent.title);
  log(/no speech/i.test(silent.toast), 'and says so, rather than implying it listened', silent.toast);

  console.log('\n[8] Console');
  const real = errs.filter((m) => !/Autofill|devtools|Electron Security|preload/i.test(m));
  log(real.length === 0, 'no renderer errors', real.slice(0, 3).join(' | '));

  console.log(failed ? '\n❌ FAILED\n' : '\n✅ ALL PASSED\n');
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
