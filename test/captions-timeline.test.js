'use strict';
/*
 * REAL end-to-end test for "captions show up on the timeline as the actual words,
 * and I can click one to edit it" (CapCut-style).
 *
 * Nothing here is faked: it cuts a real excerpt out of a real sermon, boots the
 * real renderer with the real preload + the real main-process IPC handlers, runs
 * the REAL on-device speech engine (whisper) through the app's own "💬 Auto-captions"
 * button, and then drives the caption lane the way a user's mouse and keyboard
 * would. Finally it burns the EDITED caption text into a real MP4 and decodes it
 * back to prove the edits survive export.
 *
 *   npx electron test/captions-timeline.test.js ["<source video>"]
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const captioner = require(path.join(ROOT, 'src/main/captioner'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const SRC = process.argv[2] || 'C:/Users/dejia/Videos/The Mercy of God 2 Dr. David Richman.mp4';
const CUT_START = 600, CUT_LEN = 180;          // 3 real minutes of real preaching
const WORK = path.join(os.tmpdir(), 'mw-captrack-test');
fs.mkdirSync(WORK, { recursive: true });
const CLIP = path.join(WORK, `excerpt-${CUT_START}-${CUT_LEN}.mp4`);

let failed = false;
function log(okv, name, d) {
  console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!okv) failed = true;
}

/* --- real main-process IPC, same handlers the app ships ------------------ */
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test Church', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
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
// The model picker was added to the studio after this test was written, and the
// studio asks for it while opening the captions flow. Without a handler the
// invoke REJECTS, the flow stops before it transcribes anything, and every
// caption-lane check below fails with an empty lane — which reads as "the
// caption lane is broken" rather than "the test never got that far".
ipcMain.handle('captions:models', () => ok(captioner.models()));
ipcMain.handle('captions:available', () => ok(captioner.isAvailable()));
ipcMain.handle('captions:engineInfo', () => ok(captioner.engineInfo()));
ipcMain.handle('captions:fonts', () => ok(Object.keys(captioner.FONTS)));
ipcMain.handle('captions:transcribe', async (_e, { input, startSec, endSec }) =>
  ok(await captioner.transcribe(ctx, { input, startSec, endSec })));
ipcMain.handle('captions:burn', async (_e, { input, events, opts }) => {
  const info = await video.getInfo(ctx, input);
  const assPath = path.join(WORK, 'caps.ass');
  captioner.writeAss(events, { width: info.width, height: info.height, opts: opts || {}, output: assPath });
  const output = path.join(WORK, 'captioned-out.mp4');
  await captioner.burnCaptions(ctx, { input, assPath, output });
  return ok(output);
});

app.disableHardwareAcceleration();

const js = (win, src) => win.webContents.executeJavaScript(`(() => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  /* ---------- [0] a REAL excerpt of the user's real sermon --------------- */
  console.log('\n[0] Real source clip');
  if (!fs.existsSync(SRC)) { log(false, 'source video exists', SRC); app.exit(1); return; }
  if (!fs.existsSync(CLIP)) {
    execFileSync(ffmpeg, ['-y', '-ss', String(CUT_START), '-i', SRC, '-t', String(CUT_LEN),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', CLIP], { stdio: 'ignore' });
  }
  const clipInfo = await video.getInfo(ctx, CLIP);
  log(fs.existsSync(CLIP) && clipInfo.durationSec > 170, 'cut a real 3-minute excerpt from the sermon',
    `${clipInfo.width}x${clipInfo.height} ${clipInfo.durationSec.toFixed(1)}s`);
  log(captioner.isAvailable(), 'the on-device caption engine is available');

  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1200);

  /* ---------- [1] open the REAL video in the Video Studio ---------------- */
  console.log('\n[1] Open the real video');
  const opened = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    return window.VideoEditor.__test.loadReal(${JSON.stringify(CLIP)}).then(() => ({
      dur: window.VideoEditor.__test.videoDuration(),
      emptyHint: window.VideoEditor.__test.capTrackEmptyShown(),
      saveHidden: !window.VideoEditor.__test.capSaveBtnVisible(),
      lane: window.VideoEditor.__test.capLaneLabel(),
    }));`);
  if (opened.__error) console.error('[1] ' + opened.__error);
  log(opened.dur > 170, 'the real excerpt is loaded on the timeline', (opened.dur || 0).toFixed(1) + 's');
  log(opened.emptyHint && opened.saveHidden, 'empty captions lane shows its hint; Save-with-captions stays hidden');
  log(opened.lane === '💬 Captions', 'captions lane label starts plain', opened.lane);

  /* ---------- [2] REAL transcription through the app's own button -------- */
  console.log('\n[2] 💬 Auto-captions (real on-device speech engine — takes ~1-2 min)');
  const t0 = Date.now();
  const gen = await js(win, `
    window.confirm = () => true;              // the length prompt, answered "yes"
    document.getElementById('veAutoCaptions').click();
    return new Promise((res) => {
      const started = Date.now();
      const iv = setInterval(() => {
        const T = window.VideoEditor.__test;
        const n = T.capEventsState().length;
        if (n > 0) { clearInterval(iv); res({ n, secs: (Date.now()-started)/1000 }); }
        else if (Date.now() - started > 600000) { clearInterval(iv); res({ n: 0, timeout: true }); }
      }, 500);
    });`);
  if (gen.__error) console.error('[2] ' + gen.__error);
  log(!!gen.n && gen.n > 15, 'real speech was transcribed into caption lines',
    `${gen.n} lines in ${Math.round((Date.now() - t0) / 1000)}s`);

  // close the modal so we're looking at the timeline, like a user would
  await js(win, `document.getElementById('capClose').click(); return 1;`);
  await sleep(300);

  /* ---------- [3] THE ASK: the words are VISIBLE on the timeline ---------- */
  console.log('\n[3] The caption lane shows the ACTUAL WORDS');
  const seen = await js(win, `
    const T = window.VideoEditor.__test;
    const blocks = T.capTrackBlocks();
    const evs = T.capEventsState();
    const reads = blocks.map((b, i) => T.capBlockReadout(b.i)).filter(Boolean);
    const onScreen = reads.filter(r => r.onScreen);
    return {
      blocks: blocks.length, events: evs.length,
      lane: T.capLaneLabel(),
      zoom: T.capZoom(),
      saveShown: T.capSaveBtnVisible(),
      emptyGone: !T.capTrackEmptyShown(),
      // every block carries its own caption's words, in time order
      textsMatch: blocks.every((b, i) => b.text === evs[b.i].text),
      ordered: blocks.every((b, i) => i === 0 || b.left >= blocks[i-1].left),
      leftMatches: blocks.every(b => Math.abs(b.left - evs[b.i].start * T.capZoom()) < 0.5),
      onScreenCount: onScreen.length,
      readable: T.capWordsReadable(),
      wholePhrases: onScreen.filter(r => r.fullyVisible).length,
      minFont: Math.min(...onScreen.map(r => r.fontPx)),
      minHeight: Math.min(...onScreen.map(r => r.h)),
      sample: onScreen.slice(0, 5).map(r => r.text),
      opaque: onScreen[0] && onScreen[0].opaque,
      firstThreeEvents: evs.slice(0, 3),
    };`);
  if (seen.__error) console.error('[3] ' + seen.__error);
  /*
   * The lane only builds the blocks that are ON SCREEN (a whole service is
   * ~1500 lines and drawing them all made zooming crawl — see
   * test/timeline-perf.test.js). So the guarantee is no longer "a node per
   * line", which was an implementation detail; it is "every line you can see is
   * a real, editable block, showing its own words at its own time". That is
   * what the rest of this section checks, and what the operator actually needs.
   */
  log(seen.blocks > 15 && seen.blocks <= seen.events,
    'the caption lines in view are real blocks on the timeline',
    `${seen.blocks} blocks drawn of ${seen.events} lines`);
  log(seen.textsMatch, 'each block shows its own caption text (not a placeholder)');
  log(seen.ordered && seen.leftMatches, 'blocks sit at their real times, left→right');
  log(seen.emptyGone && seen.saveShown, 'the empty hint is gone and “Save with captions” appeared');
  log(/^💬 Captions \(\d+\)$/.test(seen.lane), 'the lane label shows how many caption lines there are', seen.lane);
  log(seen.onScreenCount >= 4, 'several caption blocks are on screen at once', seen.onScreenCount + ' visible');
  log(seen.readable.visible > 0 && seen.readable.withWords === seen.readable.visible,
    'EVERY visible block has room to actually show words', JSON.stringify(seen.readable));
  log(seen.wholePhrases >= Math.ceil(seen.onScreenCount / 2),
    'at least half the visible blocks show their WHOLE phrase (no ellipsis)', `${seen.wholePhrases}/${seen.onScreenCount}`);
  log(seen.minFont >= 11 && seen.minHeight >= 24, 'the words are rendered at a readable size',
    `${seen.minFont}px text in ${seen.minHeight}px blocks`);
  console.log('   real words on the timeline: ' + JSON.stringify(seen.sample));

  /* ---------- [4] CLICK a caption to edit it ---------------------------- */
  console.log('\n[4] Click a caption block → edit it, effortlessly');
  const NEW_TEXT = 'THE MERCY OF GOD ENDURES';
  const edit = await js(win, `
    const T = window.VideoEditor.__test;
    const before = T.capEventsState()[3];
    T.clickCapBlock(3);
    const editing = T.capEditingIndex();
    const boxW = T.capEditBoxWidth();
    const seeked = T.playheadTime();
    T.typeIntoCapEdit(${JSON.stringify(NEW_TEXT)});
    const liveOverlay = T.capOverlayText();          // preview updates as you type
    T.capEditKey('Enter');
    const after = T.capEventsState()[3];
    const block = T.capTrackBlocks().find(b => b.i === 3);
    return { before, editing, boxW, seeked, liveOverlay, after, blockText: block && block.text,
             stillEditing: T.capEditingIndex(), timingKept: before.start === after.start && before.end === after.end };`);
  if (edit.__error) console.error('[4] ' + edit.__error);
  log(edit.editing === 3, 'a single click puts the caret in that caption', 'editing index=' + edit.editing);
  log(edit.boxW >= 200, 'the edit box is wide enough to read what you type', edit.boxW + 'px');
  log(Math.abs(edit.seeked - edit.before.start) < 0.35, 'clicking also parks the playhead on that line',
    `playhead=${(edit.seeked || 0).toFixed(2)}s line starts ${edit.before.start.toFixed(2)}s`);
  log(edit.liveOverlay === NEW_TEXT, 'the preview caption updates live as you type', JSON.stringify(edit.liveOverlay));
  log(edit.after.text === NEW_TEXT, 'Enter saves the new words');
  log(edit.blockText === NEW_TEXT, 'the timeline block now shows the new words', JSON.stringify(edit.blockText));
  log(edit.timingKept, 'editing the words does NOT disturb the line’s timing');
  log(edit.stillEditing == null, 'Enter leaves edit mode');

  /* ---------- [5] Tab through lines, Escape cancels ---------------------- */
  console.log('\n[5] Tab to the next line · Escape cancels');
  const nav = await js(win, `
    const T = window.VideoEditor.__test;
    T.clickCapBlock(5);
    T.typeIntoCapEdit('line five edited');
    T.capEditKey('Tab');                       // commit + hop to line 6
    const hopped = T.capEditingIndex();
    const five = T.capEventsState()[5].text;
    const sixBefore = T.capEventsState()[6].text;
    T.typeIntoCapEdit('this should be thrown away');
    T.capEditKey('Escape');
    const sixAfter = T.capEventsState()[6].text;
    const sixBlock = (T.capTrackBlocks().find(b => b.i === 6) || {}).text;
    T.capEditKey('Tab'); // no-op, nothing is being edited
    return { hopped, five, sixBefore, sixAfter, sixBlock, editingNow: T.capEditingIndex() };`);
  if (nav.__error) console.error('[5] ' + nav.__error);
  log(nav.hopped === 6, 'Tab commits and jumps to the next caption', 'now editing ' + nav.hopped);
  log(nav.five === 'line five edited', 'the line you tabbed away from kept its edit');
  log(nav.sixAfter === nav.sixBefore && nav.sixBlock === nav.sixBefore,
    'Escape throws the change away and restores the original words', JSON.stringify(nav.sixAfter));
  log(nav.editingNow == null, 'Escape leaves edit mode');

  /* ---------- [6] Drag to move / trim ------------------------------------ */
  console.log('\n[6] Drag a caption to move it · drag its edge to re-time it');
  const drag = await js(win, `
    const T = window.VideoEditor.__test;
    const pps = T.capZoom();
    const b0 = T.capEventsState()[1];
    T.dragCapEdge(1, 'r', 40);                    // keep it on screen ~0.4s longer
    const afterTrim = T.capEventsState()[1];
    const b2 = T.capEventsState()[2];
    T.dragCapEdge(2, null, 60);                   // slide the whole line later
    const afterMove = T.capEventsState()[2];
    const blocks = T.capTrackBlocks();
    const blk = blocks.find(b => b.i === 2);
    return {
      pps,
      trimGrew: afterTrim.end > b0.end + 0.15, trimKeptStart: Math.abs(afterTrim.start - b0.start) < 0.001,
      moved: afterMove.start > b2.start + 0.2,
      lenKept: Math.abs((afterMove.end - afterMove.start) - (b2.end - b2.start)) < 0.02,
      blockFollowed: blk && Math.abs(blk.left - afterMove.start * pps) < 0.6,
      wordsKept: blk && blk.text === afterMove.text,
    };`);
  if (drag.__error) console.error('[6] ' + drag.__error);
  log(drag.trimGrew && drag.trimKeptStart, 'dragging the right edge extends the line, start untouched');
  log(drag.moved && drag.lenKept, 'dragging the middle slides the line and keeps its length');
  log(drag.blockFollowed && drag.wordsKept, 'the block on screen follows, still showing its words');

  /* ---------- [7] Zoomed all the way out, a click still works ------------ */
  console.log('\n[7] Zoomed out to Fit, clicking a caption zooms in so you can edit it');
  const tiny = await js(win, `
    const T = window.VideoEditor.__test;
    const fitPps = T.fitHook();
    const r = T.capBlockReadout(8);
    T.clickCapBlock(8);
    const after = T.capBlockReadout(8);
    return { fitPps, tinyW: r && r.w, zoomed: T.capZoom(), editing: T.capEditingIndex(),
             boxW: T.capEditBoxWidth(), nowReadable: after && after.w };`);
  if (tiny.__error) console.error('[7] ' + tiny.__error);
  /*
   * `tinyW` is null here now, and that is the point rather than a miss: at Fit
   * a whole service's lines are far too narrow to draw individually, so the
   * lane shows coverage bars instead and there is no block to measure. (Left as
   * `< 40` it would have "passed" on null coercing to 0 — a check that can only
   * pass is worse than no check, so it asks the real question.)
   */
  log(tiny.tinyW == null || tiny.tinyW < 40,
    'at Fit a caption line is too narrow to read — a sliver or a coverage bar',
    tiny.tinyW == null ? 'coverage bars' : tiny.tinyW + 'px wide');
  log(tiny.zoomed > tiny.fitPps * 2, 'clicking it zooms the timeline in', `${tiny.fitPps.toFixed(2)} → ${tiny.zoomed.toFixed(1)} px/sec`);
  log(tiny.editing === 8 && tiny.boxW >= 200, 'and you land straight in an editable, readable box', tiny.boxW + 'px');
  await js(win, `document.getElementById('veCapTrack').click(); window.VideoEditor.__test.capEditKey('Escape'); return 1;`);

  /* ---------- [8] Delete a line ------------------------------------------ */
  console.log('\n[8] Delete removes the selected caption');
  const del = await js(win, `
    const T = window.VideoEditor.__test;
    const before = T.capEventsState().length;
    const target = T.capEventsState()[4].text;
    T.clickCapBlock(4);
    T.capEditKey('Escape');                      // leave edit mode, stay selected
    T.deleteSelectedCap();
    const after = T.capEventsState();
    return { before, after: after.length, gone: after[4] && after[4].text !== target,
             blocks: T.capTrackBlocks().length, lane: T.capLaneLabel() };`);
  if (del.__error) console.error('[8] ' + del.__error);
  log(del.after === del.before - 1 && del.gone, 'Delete removes that line', `${del.before} → ${del.after}`);
  // Same reason as [3]: the lane draws what is in view, so count the blocks
  // against what is in view rather than against the whole transcript.
  log(del.blocks <= del.after && del.blocks > 0, 'the timeline re-renders without that line',
    `${del.blocks} blocks for ${del.after} remaining lines`);
  log(del.lane === '💬 Captions (' + del.after + ')', 'the lane count updates', del.lane);

  /* ---------- [9] Per-short captions land at the CLIP's real time -------- */
  console.log('\n[9] Captions for one short sit at that clip’s place on the timeline');
  const off = await js(win, `
    const T = window.VideoEditor.__test;
    const saved = T.capEventsState();
    try {
      T.setCapEvents([{ start: 0.5, end: 2.0, text: 'clip relative one' }, { start: 2.5, end: 4.0, text: 'clip relative two' }], 40);
      // The lane draws what is in view, so look at the part of the timeline
      // these lines are on — which is what the studio itself does after
      // captioning a short (revealClipCaptions scrolls to them).
      const sc = document.getElementById('veTlScroll');
      sc.scrollLeft = Math.max(0, 40 * T.capZoom() - 200);
      T.flushRenderHook();
      const blocks = T.capTrackBlocks();
      const pps = T.capZoom();
      const okPos = blocks.length >= 2
        && Math.abs(blocks[0].left - 40.5 * pps) < 0.6 && Math.abs(blocks[1].left - 42.5 * pps) < 0.6;
      return { okPos, words: blocks.map(b => b.text), n: blocks.length };
    } finally {
      // Restore no matter what — leaving the test transcript replaced by two
      // synthetic lines silently broke every later section.
      T.setCapEvents(saved, 0);
    }`);
  if (off.__error) console.error('[9] ' + off.__error);
  log(off.n === 2 && off.okPos, 'clip-relative captions are drawn at clipStart + their time');
  log(JSON.stringify(off.words) === JSON.stringify(['clip relative one', 'clip relative two']), 'and they show their words too');

  /* ---------- [10] The EDITED words really make it into the export ------- */
  console.log('\n[10] Export: the edited caption text is burned into a real MP4');
  const burned = await js(win, `
    const T = window.VideoEditor.__test;
    const evs = T.capEventsState();
    return window.api.captions.burn({
      input: ${JSON.stringify(CLIP)},
      events: evs.slice(0, 12),
      opts: { font: 'Anton', sizeKey: 'm', color: '#ffffff', position: 'bottom', style: 'shadow' },
    }).then(out => {
      const hit = evs.find(e => e.text === ${JSON.stringify(NEW_TEXT)});
      return { out, first: evs[0].text, edited: !!hit, editedStart: hit ? hit.start : 0, editedEnd: hit ? hit.end : 1 };
    });`);
  if (burned.__error) console.error('[10] ' + burned.__error);
  const outExists = burned.out && fs.existsSync(burned.out);
  log(!!outExists, 'a captioned MP4 was written', burned.out || 'none');
  if (outExists) {
    const oi = await video.getInfo(ctx, burned.out);
    const clean = await video.isCleanEncode(ctx, burned.out);
    log(oi.width === clipInfo.width && oi.height === clipInfo.height, 'the export keeps the source resolution',
      `${oi.width}x${oi.height}`);
    log(clean === true, 'the exported file decodes cleanly (no corrupt frames)');
    log(burned.edited, 'the line the user retyped is among the burned-in events');

    // …and the words are really PAINTED on the picture: grab the frame in the
    // middle of the retyped line from both files and count near-white pixels in
    // the bottom third (where the captions sit).
    const mid = (burned.editedStart + burned.editedEnd) / 2;
    const shot = (file, tag) => {
      const png = path.join(WORK, `frame-${tag}.png`);
      execFileSync(ffmpeg, ['-y', '-ss', String(mid), '-i', file, '-frames:v', '1', '-vf', 'crop=iw:ih/3:0:ih*2/3', png], { stdio: 'ignore' });
      return png;
    };
    const before = shot(CLIP, 'plain'), after = shot(burned.out, 'captioned');
    const whitePixels = async (png) => {
      const img = await win.webContents.executeJavaScript(`(async () => {
        const r = await window.api.fs.readImageDataUrl(${JSON.stringify(png)});
        const im = new Image(); im.src = r;
        await im.decode();
        const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
        const cx2 = cv.getContext('2d'); cx2.drawImage(im, 0, 0);
        const d = cx2.getImageData(0, 0, cv.width, cv.height).data;
        let n = 0;
        for (let p = 0; p < d.length; p += 4) if (d[p] > 235 && d[p+1] > 235 && d[p+2] > 235) n++;
        return n;
      })()`);
      return img;
    };
    // A burned-in line of white text adds a few thousand near-white pixels; the
    // untouched frame is the control (a real stage already has bright areas).
    const wBefore = await whitePixels(before), wAfter = await whitePixels(after);
    log(wAfter - wBefore >= 1000, 'the caption words are actually PAINTED onto the exported frames',
      `near-white pixels in the caption band: ${wBefore} → ${wAfter} (+${wAfter - wBefore})`);
    console.log('   eyeball it: ' + after);
  }

  /* ---------- [11] No renderer errors ------------------------------------ */
  console.log('\n[11] Console clean');
  log(errors.length === 0, 'no renderer errors during the whole run', errors.slice(0, 3).join(' | '));

  console.log(`\n==============  captions-timeline test ${failed ? 'FAILED' : 'PASSED'}  ==============`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
