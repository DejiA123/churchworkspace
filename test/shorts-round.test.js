'use strict';
/*
 * The "shorts round" — proves the four UI-facing asks of this round in the REAL
 * renderer (real index.html, real preload wiring, real buttons):
 *
 *  [A] Defaults: 🤫 Remove pauses ON, ✨ Auto length targets ~1:30 clips, and the
 *      💬 Auto-caption-all-shorts button exists.
 *  [B] Splitting the uploaded video does NOT put it in the Shorts panel — the
 *      halves stay the timeline base (and joining them back keeps it that way).
 *  [C] 💬 Auto-caption all shorts transcribes ONLY each short's own range
 *      (never the whole video), stores the lines per clip, shows them on the
 *      preview, badges the cards, and arms captions-on-export.
 *  [D] Exporting a captioned short burns the STORED lines (clip-relative,
 *      remapped through removed pauses) without transcribing again.
 *
 * The caption engine is mocked AT THE IPC BOUNDARY (this test's main process
 * answers captions:*), so the renderer runs its true code path end to end and
 * the test records exactly what ranges it asked to transcribe and what events
 * it asked to burn.
 *
 *   npx electron test/shorts-round.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-shortsround-test');
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'src-60s.mp4');
const TOTAL = 60;

let failed = false;
function log(okv, name, d) {
  console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!okv) failed = true;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* --- real main-process IPC, same handlers the app ships (captions mocked) --- */
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test Church', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('shell:showItem', () => ok(true));
ipcMain.handle('shell:openPath', () => ok(true));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'thumbs not needed' }));
ipcMain.handle('video:info', async (_e, { input }) => ok(await video.getInfo(ctx, input)));
ipcMain.handle('video:waveform', async (_e, { input, width, height }) => {
  const output = path.join(WORK, `wave-${Date.now()}.png`);
  await video.waveform(ctx, { input, width: width || 1600, height: height || 90, output });
  return ok(output);
});
ipcMain.handle('video:filmstrip', async (_e, { input, count }) => {
  const output = path.join(WORK, `strip-${Date.now()}.png`);
  await video.filmstrip(ctx, { input, count: count || 16, output });
  return ok(output);
});
ipcMain.handle('fs:readImageDataUrl', async (_e, { path: p }) => {
  const buf = fs.readFileSync(p);
  const ext = (path.extname(p).slice(1) || 'png').toLowerCase();
  return ok(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`);
});
ipcMain.handle('sermon:exportShort', async (_e, { input, startSec, endSec, preset, pieces, label }) => {
  const safe = (label || 'short').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const output = path.join(WORK, `short-${safe}-${Date.now()}.mp4`);
  await video.exportShort(ctx, { input, startSec, endSec, preset: preset || 'reel-9x16', pieces, output });
  return ok(output);
});

/* --- the caption engine, mocked at the IPC boundary ----------------------- */
// A pretend transcript for ANY requested range: three words per clip, at
// 0.5s/2.0s/3.5s into the clip. Deterministic, so timing maths is checkable.
const transcribeCalls = [];
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('captions:engineInfo', () => ok({ available: true }));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:transcribe', (_e, { input, startSec, endSec }) => {
  transcribeCalls.push({ input, startSec, endSec });
  const words = [
    { start: 0.5, end: 1.4, text: 'God' },
    { start: 2.0, end: 2.9, text: 'is' },
    { start: 3.5, end: 4.4, text: 'good' },
  ];
  return ok({ words });
});
const burnCalls = [];
ipcMain.handle('captions:burn', (_e, { input, events, opts, outName, deleteInput }) => {
  burnCalls.push({ input, events, opts, outName, deleteInput });
  const output = path.join(WORK, `${(outName || 'burned').replace(/[^\w.-]+/g, '_')}.mp4`);
  fs.copyFileSync(input, output);
  if (deleteInput) { try { fs.rmSync(input, { force: true }); } catch (er) {} }
  return ok(output);
});

app.disableHardwareAcceleration();

const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  /* ---------- [0] a real 60s source ---------------------------------------- */
  if (!fs.existsSync(SRC)) {
    execFileSync(ffmpeg, ['-y',
      '-f', 'lavfi', '-t', String(TOTAL), '-i', 'color=c=0x2255FF:s=640x360:r=30',
      '-f', 'lavfi', '-t', String(TOTAL), '-i', 'sine=frequency=440:sample_rate=44100',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', SRC], { stdio: 'ignore' });
  }
  const info = await video.getInfo(ctx, SRC);
  log(near(info.durationSec, TOTAL, 0.4), '[0] built a 60s source video', `${info.durationSec.toFixed(1)}s`);

  const win = new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1200);

  /* ---------- [A] the round's new defaults --------------------------------- */
  console.log('\n[A] Defaults');
  const a = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    const T = window.VideoEditor.__test;
    const lenSel = document.getElementById('veShortLen');
    return {
      removePauses: document.getElementById('veRemovePauses').checked,
      deep: document.getElementById('veDeep').checked,
      lenValue: lenSel.value,
      lenLabel: lenSel.options[lenSel.selectedIndex].textContent,
      lenParams: T.lenParams(),
      capBtn: T.capShortsButton(),
    };`);
  if (a.__error) console.error('[A] ' + a.__error);
  log(a.removePauses === true, '🤫 Remove pauses is ON by default');
  log(a.deep === true, '🧠 Deep mode is still ON by default');
  log(a.lenValue === 'auto' && a.lenParams && a.lenParams.idealLen === 90 && a.lenParams.minLen === 60 && a.lenParams.maxLen === 150 && a.lenParams.autoLen === true,
    '✨ Auto length now aims at ~1:30 clips (60–150s band, ideal 90s)', JSON.stringify(a.lenParams));
  log(/1½|1:30/.test(a.lenLabel || ''), 'the dropdown says so', (a.lenLabel || '').trim());
  log(a.capBtn && a.capBtn.disabled === true && /caption/i.test(a.capBtn.text) && /short/i.test(a.capBtn.text),
    '💬 Auto-caption all shorts button exists (disabled until a video loads)', a.capBtn && a.capBtn.text.trim());

  /* ---------- [B] splitting the video never creates "shorts" --------------- */
  console.log('\n[B] Splitting the uploaded video stays OUT of the Shorts panel');
  const b = await js(win, `
    const T = window.VideoEditor.__test;
    const rf = document.getElementById('veAutoReframe'); if (rf) rf.checked = false;
    await T.loadReal(${JSON.stringify(SRC)});
    const loaded = { segs: T.segments().length, cards: T.shortsCards(), capBtnOn: !T.capShortsButton().disabled };
    T.split(30);
    const ids = T.segIds();
    const split = {
      segs: T.segments().length, cards: T.shortsCards(), shorts: T.shortsList().length,
      leftSeed: T.isSeed(ids[0]), rightSeed: T.isSeed(ids[1]),
      exportAllOff: T.exportAllDisabled(),
    };
    // delete the second half, join is not needed — but also prove close-gap keeps seed:
    T.split(45); // 3 pieces now: [0-30][30-45][45-60], all seed
    T.deleteClip(T.segIds()[1]); // bin the middle
    const id = T.clickCloseGap(false);
    const joined = { segs: T.segments().length, cards: T.shortsCards(), seed: T.isSeed(id), btn: (T.exportEditedButton() || {}).text || '' };
    return { loaded, split, joined };`);
  if (b.__error) console.error('[B] ' + b.__error);
  log(b.loaded.segs === 1 && b.loaded.cards === 0 && b.loaded.capBtnOn === true, 'video loads as the seeded base, 0 shorts, caption button armed');
  log(b.split.segs === 2 && b.split.cards === 0 && b.split.shorts === 0, 'SPLIT: two timeline clips, still ZERO cards in the Shorts panel', `segs=${b.split.segs} cards=${b.split.cards}`);
  log(b.split.leftSeed === true && b.split.rightSeed === true, 'both halves stay the timeline base (seed)', `left=${b.split.leftSeed} right=${b.split.rightSeed}`);
  log(b.split.exportAllOff === true, 'Export all stays disabled (nothing pretends to be a short)');
  log(b.joined.seed === true && b.joined.cards === 0, 'CLOSE GAP on the base: joined clip is still the base, still 0 cards');
  log(/0:45/.test(b.joined.btn), 'the 💾 Export video button carries the kept length (0:45)', b.joined.btn.trim());

  /* --- [B2] the exact bug from the user's screenshot: "Clip 120:45-120:45 0s" --- */
  console.log('\n[B2] Splitting in a gap / on a clip edge (what produced the 0s "Clip" cards)');
  const b2 = await js(win, `
    const T = window.VideoEditor.__test;
    await T.loadReal(${JSON.stringify(SRC)});
    // carve the base into two and bin the middle, leaving a real GAP 20s..40s
    T.split(20); T.split(40);
    T.deleteClip(T.segIds()[1]);
    const gap = { segs: T.segments().length, cards: T.shortsCards() };
    // 1) playhead parked exactly on a clip's edge — this is what made 0s clips
    T.split(20);
    const onEdge = { segs: T.segments().length, cards: T.shortsCards(), shorts: T.shortsList().length,
                     zero: T.segments().filter(s => (s.end - s.start) < 0.25).length };
    // 2) playhead inside the empty gap — makes real timeline clips, never shorts
    T.split(30);
    const inGap = { segs: T.segments().length, cards: T.shortsCards(), shorts: T.shortsList().length,
                    zero: T.segments().filter(s => (s.end - s.start) < 0.25).length,
                    exportAllOff: T.exportAllDisabled() };
    // 3) and the manual clip buttons stay off the panel too
    T.addManual(45, 55);
    const manual = { cards: T.shortsCards(), shorts: T.shortsList().length, segs: T.segments().length };
    return { gap, onEdge, inGap, manual };`);
  if (b2.__error) console.error('[B2] ' + b2.__error);
  log(b2.gap.segs === 2 && b2.gap.cards === 0, 'split-split-delete leaves two base clips and a gap, 0 cards');
  log(b2.onEdge.zero === 0 && b2.onEdge.segs === 2,
    'THE BUG: splitting with the playhead ON a clip edge no longer creates 0-second clips',
    `segs=${b2.onEdge.segs} zero-length=${b2.onEdge.zero}`);
  log(b2.onEdge.cards === 0 && b2.onEdge.shorts === 0, '…and puts nothing in the Shorts panel', `cards=${b2.onEdge.cards}`);
  log(b2.inGap.segs === 4 && b2.inGap.zero === 0, 'splitting INSIDE the gap makes two real timeline clips', `segs=${b2.inGap.segs}`);
  log(b2.inGap.cards === 0 && b2.inGap.shorts === 0 && b2.inGap.exportAllOff === true,
    '…and they are timeline clips, NOT shorts (panel empty, Export all off)', `cards=${b2.inGap.cards}`);
  log(b2.manual.cards === 0 && b2.manual.shorts === 0 && b2.manual.segs === 5,
    'a hand-drawn clip is on the timeline but NOT in the Shorts panel', `segs=${b2.manual.segs} cards=${b2.manual.cards}`);

  /* ---------- [C] Auto-caption ALL shorts — and only the shorts ------------- */
  console.log('\n[C] 💬 Auto-caption all shorts');
  const c = await js(win, `
    const T = window.VideoEditor.__test;
    await T.loadReal(${JSON.stringify(SRC)});
    T.applyClips([{ start: 2, end: 10 }, { start: 40, end: 50 }]);
    await T.captionAllShorts();
    const ids = T.segIds();
    const caps0 = T.clipCapEvents(ids[0]);
    const caps1 = T.clipCapEvents(ids[1]);
    return {
      caps0, caps1,
      capExports: document.getElementById('veCapExports').checked,
      badges: document.querySelectorAll('#veClipList .ve-clip-capped').length,
      globalCaps: T.capState().events,
      // every line the lane holds, to prove none covers untouched footage
      laneLines: T.capLines ? T.capLines() : null,
      overlayInClip: T.overlayAt(2.6),
      overlayClip2: T.overlayAt(42.5),
      overlayInGap: T.overlayAt(25),
    };`);
  if (c.__error) console.error('[C] ' + c.__error);
  const calls = transcribeCalls.slice();
  log(calls.length === 2, 'exactly TWO transcriptions ran — one per short', `${calls.length} calls`);
  log(calls.every((x) => x.startSec != null && x.endSec != null), 'every call was RANGE-scoped — the whole video was never transcribed',
    calls.map((x) => `${x.startSec}-${x.endSec}`).join(', '));
  log(calls.some((x) => near(x.startSec, 2, 0.01) && near(x.endSec, 10, 0.01)) && calls.some((x) => near(x.startSec, 40, 0.01) && near(x.endSec, 50, 0.01)),
    'the ranges are the shorts themselves (2–10s and 40–50s)');
  log(c.caps0 && c.caps0.length > 0 && c.caps1 && c.caps1.length > 0, 'both shorts hold their own caption lines', `${c.caps0 && c.caps0.length} + ${c.caps1 && c.caps1.length} lines`);
  log(c.caps0 && c.caps0.every((e2) => e2.start >= 2 && e2.end <= 10.01) && c.caps1 && c.caps1.every((e2) => e2.start >= 40 && e2.end <= 50.01),
    'lines are stored on the SOURCE clock inside each clip', c.caps0 && `first=${c.caps0[0].start}s`);
  log(/God is good/i.test((c.caps0 && c.caps0.map((x) => x.text).join(' ')) || ''), 'the words came through', c.caps0 && c.caps0.map((x) => x.text).join(' '));
  log(c.capExports === true, 'captions-on-export armed automatically');
  log(c.badges === 2, 'both clip cards show the 💬 CC badge', `${c.badges} badges`);
  // The lines DO go on the timeline lane — that is the point, so they can be read
  // and edited. What must stay true is that they only ever cover the shorts: no
  // line may appear over footage that was never transcribed.
  const inShorts = (c.laneLines || []).every((e) =>
    (e.start >= 1.9 && e.end <= 10.1) || (e.start >= 39.9 && e.end <= 50.1));
  log(c.globalCaps > 0 && inShorts,
    'the lines are ON the timeline lane, and only over the shorts (no untouched footage)',
    `${c.globalCaps} lines, all inside the two shorts: ${inShorts}`);
  log(!!c.overlayInClip && /God|is|good/i.test(c.overlayInClip), 'the preview shows a short’s caption at its own time', String(c.overlayInClip));
  log(!!c.overlayClip2, 'the second short’s captions show too', String(c.overlayClip2));
  log(c.overlayInGap == null, 'outside the shorts the preview shows no caption');

  /* --- [C2] the lines are ON THE TIMELINE and editable, like a transcript --- */
  console.log('\n[C2] The captions appear on the 💬 Captions track and can be edited there');
  const c3 = await js(win, `
    const T = window.VideoEditor.__test;
    const blocks = T.capTrackBlocks().length;
    const firstText = (T.capTrackBlocks()[0] || {}).text || '';
    const before = T.capState();
    // retype line 0 exactly as a user does: click the block, type, press Enter
    const typed = await T.editCapByTyping(0, 'GRACE UPON GRACE');
    const afterText = (T.capTrackBlocks()[0] || {}).text || '';
    const ids = T.segIds();
    return {
      blocks, firstText, afterText, typed,
      laneCount: before.events,
      clipLines: (T.clipCapEvents(ids[0]) || []).map(e => e.text),
      overlayShowsEdit: T.overlayAt(2.6),
      saveBtnVisible: T.capSaveBtnVisible(),
      laneLabel: T.capLaneLabel(),
    };`);
  if (c3.__error) console.error('[C2] ' + c3.__error);
  log(c3.blocks > 0, 'the caption lines are drawn as blocks on the Captions track', `${c3.blocks} blocks`);
  log(c3.laneCount === c3.blocks, 'every line on the lane has a block', `lane=${c3.laneCount} blocks=${c3.blocks}`);
  log(/GOD IS GOOD/i.test(c3.firstText || ''), 'a block shows its ACTUAL WORDS', c3.firstText);
  log(c3.typed === true && /GRACE UPON GRACE/.test(c3.afterText || ''),
    'clicking a block and typing REPLACES the words (editable like a transcript)', c3.afterText);
  log(/GRACE UPON GRACE/.test((c3.clipCapEvents || c3.clipLines || []).join(' ')),
    'the edit is what the short now holds — one store, no stale copy', (c3.clipLines || []).join(' | '));
  log(/GRACE UPON GRACE/i.test(String(c3.overlayShowsEdit || '')), 'and the preview shows the edited words', String(c3.overlayShowsEdit));
  log(c3.saveBtnVisible === false, 'the whole-video "Save with captions" button stays hidden for a multi-short set');
  log(/💬 Captions \(\d+\)/.test(c3.laneLabel || ''), 'the lane header shows the line count', (c3.laneLabel || '').trim());

  /* --- [C2b] the per-clip 💬 button must NOT re-transcribe what's already done --- */
  console.log('\n[C2b] The 💬 button on an already-captioned short does not transcribe again');
  const before2b = transcribeCalls.length;
  const c2b = await js(win, `
    const T = window.VideoEditor.__test;
    const ids = T.segIds();
    // exactly what the user does: click the 💬 button on the card
    const clicked = T.clickClipCaption(ids[0]);
    await new Promise(r => setTimeout(r, 400));
    return {
      clicked,
      stillHasLines: (T.clipCapEvents(ids[0]) || []).map(e => e.text),
      capSel: T.capSelIndex(),
      laneCount: T.capState().events,
    };`);
  if (c2b.__error) console.error('[C2b] ' + c2b.__error);
  log(c2b.clicked === true, 'the card’s 💬 button was clicked for real');
  log(transcribeCalls.length === before2b,
    'THE BUG: no new transcription ran — the work was already done',
    `${transcribeCalls.length - before2b} new calls (was ${before2b})`);
  log(/GRACE UPON GRACE/.test((c2b.stillHasLines || []).join(' ')),
    'and the hand-edited words were NOT thrown away', (c2b.stillHasLines || []).join(' | '));
  log(c2b.capSel != null && c2b.capSel >= 0, 'it selected that short’s caption line on the lane instead', `capSel=${c2b.capSel}`);
  log(c2b.laneCount === 2, 'the lane still holds every line (nothing wiped)', `${c2b.laneCount} lines`);

  /* --- [C2c] but a short that was NEVER captioned still gets transcribed --- */
  console.log('\n[C2c] The 💬 button on an uncaptioned short still does the work');
  const before2c = transcribeCalls.length;
  const c2c = await js(win, `
    const T = window.VideoEditor.__test;
    // a brand-new short, never part of the sweep
    T.applyClipsAppend([{ start: 52, end: 58, label: 'Fresh' }]);
    const fresh = T.segIds().find(id => { const l = T.shortsList().find(x => x.id === id); return l && l.label === 'Fresh'; });
    const had = (T.clipCapEvents(fresh) || []).length;
    T.clickClipCaption(fresh);
    await new Promise(r => setTimeout(r, 900));
    return { had, now: (T.clipCapEvents(fresh) || []).map(e => e.text), laneCount: T.capState().events };`);
  if (c2c.__error) console.error('[C2c] ' + c2c.__error);
  log(c2c.had === 0, 'the new short starts with no captions');
  log(transcribeCalls.length === before2c + 1, 'exactly ONE new transcription ran for it',
    `${transcribeCalls.length - before2c} call(s)`);
  const lastCall = transcribeCalls[transcribeCalls.length - 1] || {};
  log(near(lastCall.startSec, 52, 0.01) && near(lastCall.endSec, 58, 0.01),
    'and only over that clip’s own range', `${lastCall.startSec}-${lastCall.endSec}`);
  log((c2c.now || []).length > 0 && c2c.laneCount === 3,
    'its lines joined the SAME lane, alongside the others', `clip=${(c2c.now || []).length} lane=${c2c.laneCount}`);

  /* --- [C3] the EDIT is what gets burned, not the original transcript --- */
  console.log('\n[C3] Exporting burns the edited words');
  burnCalls.length = 0;
  const c4 = await js(win, `
    const T = window.VideoEditor.__test;
    document.getElementById('veCapExports').checked = true;
    await T.exportSegmentFull(T.segIds()[0]);
    return { done: true };`);
  if (c4.__error) console.error('[C3] ' + c4.__error);
  const bEdit = burnCalls[0] || {};
  log(burnCalls.length === 1, 'the short exported with captions', `${burnCalls.length} burn`);
  log(/GRACE UPON GRACE/.test(((bEdit.events || []).map((e) => e.text).join(' '))),
    'THE EDITED LINE is what was burned into the file — not the original transcript',
    (bEdit.events || []).map((e) => e.text).join(' | '));

  // Re-running skips clips that are already captioned at the same range.
  // Counted RELATIVE to this moment — earlier sections legitimately add calls,
  // and a hard-coded total silently turns into a false failure when they do.
  const beforeRerun = transcribeCalls.length;
  const c2 = await js(win, `
    const T = window.VideoEditor.__test;
    await T.captionAllShorts();
    return { done: true };`);
  if (c2.__error) console.error('[C2] ' + c2.__error);
  log(transcribeCalls.length === beforeRerun, 're-running skips already-captioned shorts (no re-transcription)',
    `${transcribeCalls.length - beforeRerun} new calls`);

  /* ---------- [D] export burns the stored lines, without re-transcribing ---- */
  console.log('\n[D] Export burns the captions off the timeline, without re-transcribing');
  burnCalls.length = 0; // [C3] already exported once; measure this export alone
  const beforeExport = transcribeCalls.length;
  const d = await js(win, `
    const T = window.VideoEditor.__test;
    const rf = document.getElementById('veAutoReframe'); if (rf) rf.checked = false;
    document.getElementById('veCapExports').checked = true;
    await T.exportSegmentFull(T.segIds()[0]);
    return { done: true };`);
  if (d.__error) console.error('[D] ' + d.__error);
  log(burnCalls.length === 1, 'the export burned captions onto the short', `${burnCalls.length} burn`);
  const burn = burnCalls[0] || {};
  log(transcribeCalls.length === beforeExport, 'it reused the lines on the timeline — no transcription at export time',
    `${transcribeCalls.length - beforeExport} new transcriptions`);
  const evs = burn.events || [];
  log(evs.length > 0 && evs.every((x) => x.start >= 0 && x.end <= 8.02), 'burned lines are clip-relative (0–8s for the 2–10s short)',
    JSON.stringify(evs.map((x) => [x.start, x.end])));
  // [C2] retyped this line on the timeline, so the burn must carry the EDIT —
  // the transcript is a starting point, the lane is the truth.
  log(/GRACE UPON GRACE/.test((evs[0] || {}).text || ''), 'burned text is what the timeline holds', (evs[0] || {}).text);
  log(!!burn.input && /short-/.test(path.basename(burn.input)), 'burn ran on the exported short file (not the source video)', path.basename(burn.input || ''));

  const relevantErrors = errors.filter((er) => !/net::|favicon|Autofill|ResizeObserver/.test(er));
  log(relevantErrors.length === 0, 'no renderer console errors during the round', relevantErrors[0]);

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); app.exit(1); });
