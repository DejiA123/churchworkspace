'use strict';
/*
 * Electron smoke test. Boots Electron, loads the real renderer with the real
 * preload, checks the api bridge + renderer init run without errors, and
 * verifies flyer rendering (capturePage -> PNG) works. Run with:
 *   npx electron test/smoke.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let failed = false;
function log(ok, name, d) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!ok) failed = true;
}
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

// Minimal IPC so the renderer's init() can complete.
const video = require('../src/main/video');
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test Church', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: os.tmpdir(), userData: os.tmpdir(), ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton', 'Bebas Neue', 'Poppins', 'Bangers']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'no thumbs in smoke test' }));
ipcMain.handle('fonts:data', () => ok([])); // flyer display fonts not needed for smoke
ipcMain.handle('photos:list', () => ok([])); // HD photo backgrounds not needed for smoke

// The app now ships with GPU compositing ON (see main.js). Run with MW_GPU=1 to
// exercise that configuration; the default stays software so this suite still
// covers the "graphics acceleration turned off" escape hatch users can pick.
if (process.env.MW_GPU !== '1') app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  /* ---------- [A] Renderer boot + preload bridge (do this FIRST) ---------- */
  console.log('\n[A] Renderer boot + preload bridge');
  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message); // 3 = error only
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + d.reason));

  const indexPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  try {
    await win.loadFile(indexPath);
    log(true, 'renderer index.html loaded');
  } catch (e) {
    log(false, 'renderer index.html loaded', e.message);
  }
  await new Promise((r) => setTimeout(r, 1500)); // let init() finish its async IPC calls

  try {
    const hasApi = await win.webContents.executeJavaScript('typeof window.api === "object" && !!(window.api && window.api.video)');
    log(hasApi, 'preload exposed window.api');
    const navCount = await win.webContents.executeJavaScript('document.querySelectorAll(".nav-item").length');
    log(navCount === 7, 'all 7 nav sections present (Dashboard · 📖 Presentation · 🎬 Video · 🎨 Flyer · 🔴 Go Live · 📅 Scheduler · ⚙️ Settings)', 'found ' + navCount);
    const editorReady = await win.webContents.executeJavaScript('!!window.Editor && document.querySelectorAll("#edCanvas .ed-el").length');
    log(editorReady > 0, 'flyer editor initialized with elements', editorReady + ' elements on canvas');
    const presetCount = await win.webContents.executeJavaScript('document.querySelector("#veAspect").options.length');
    log(presetCount >= 4, 'video short-format presets populated', presetCount + ' presets');
    const veReady = await win.webContents.executeJavaScript('!!window.VideoEditor');
    log(veReady, 'video editor module loaded');
    const capUi = await win.webContents.executeJavaScript('!!document.getElementById("capModal") && document.getElementById("capFont").options.length');
    log(capUi >= 4, 'auto-caption editor present + fonts loaded', capUi + ' fonts');
    const uiExtras = await win.webContents.executeJavaScript('!!document.getElementById("fxModal") && !!document.getElementById("veShortLen") && document.getElementById("capWords").options.length');
    log(uiExtras >= 5, 'effects modal + shorts-length + words/line controls present', 'words/line opts: ' + uiExtras);
  } catch (e) {
    log(false, 'renderer assertions', e.message);
  }
  const realErrors = errors.filter((e) => !/Security Warning|Autofill|enableDeviceEmulation/i.test(e));
  log(realErrors.length === 0, 'no renderer console errors', realErrors.slice(0, 3).join(' | '));
  // NOTE: keep `win` ALIVE during the flyer test — this mirrors the real app,
  // where the main window is always open while a flyer is rendered.

  /* ---------- [B] Flyer editor: presets + exact-size export + add element ---- */
  console.log('\n[B] Flyer editor (presets, export, editing)');

  // Adding a text element increments the element count.
  const added = await win.webContents.executeJavaScript(
    '(() => { const b = window.Editor.__test.elementCount(); window.Editor.__test.addText({heading:true}); return window.Editor.__test.elementCount() - b; })()');
  log(added === 1, 'adding a text element works', '+' + added);

  const advanced = await win.webContents.executeJavaScript(`(() => {
    const T = window.Editor.__test;
    const before = T.elementCount();
    T.addShape('triangle'); T.addShape('star'); T.addShape('line'); T.addEmoji('🔥');
    const afterAdd = T.elementCount();
    const hist = T.historyLen();
    T.undo();
    const afterUndo = T.elementCount();
    return { added4: afterAdd - before, hist, undoWorks: afterUndo === afterAdd - 1 };
  })()`);
  log(advanced.added4 === 4, 'triangle/star/line/emoji all add', '+' + advanced.added4);
  log(advanced.hist > 0, 'undo history is recorded', advanced.hist + ' states');
  log(advanced.undoWorks, 'undo removes the last element');

  // Background removal: green bg + red centre square -> corners transparent, centre kept.
  const bg = await win.webContents.executeJavaScript(`(async () => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = '#12d012'; x.fillRect(0,0,200,200);          // solid green background
    x.fillStyle = '#d01515'; x.fillRect(70,70,60,60);          // red subject in the middle
    const src = c.toDataURL('image/png');
    return await window.Editor.__test.removeBg(src, 40);
  })()`);
  log(bg.corner === 0, 'remove-bg makes the background transparent', 'corner alpha ' + bg.corner);
  log(bg.center > 200, 'remove-bg keeps the subject opaque', 'centre alpha ' + bg.center);

  for (const presetName of ['event', 'bold', 'blank']) {
    for (const [w, h] of [[1080, 1350], [2480, 3508]]) {
      let r;
      try {
        r = await win.webContents.executeJavaScript(`(async () => {
          window.Editor.__test.loadPreset('${presetName}', ${w}, ${h});
          return await window.Editor.__test.exportInfo();
        })()`);
      } catch (e) {
        log(false, `preset "${presetName}" @ ${w}x${h}`, e.message);
        continue;
      }
      const ok = r && r.w === w && r.h === h && r.len > 1500;
      log(ok, `preset "${presetName}" exports EXACT ${w}x${h}`, r ? `${r.w}x${r.h}, ${r.len}b` : 'no result');
    }
  }

  /* ---------- [C] Video Studio timeline (CapCut-style) --------------------- */
  console.log('\n[C] Video Studio timeline');
  const veTest = await win.webContents.executeJavaScript(`(() => {
    // Simulate a loaded 145s sermon and drop 3 AI highlight clips onto the timeline.
    window.VideoEditor.__test.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    const rulerTicks = window.VideoEditor.__test.rulerTickCount();
    window.VideoEditor.__test.applyClips([
      { start: 33, end: 49, label: 'Key 1' },
      { start: 77, end: 93, label: 'Key 2' },
      { start: 121, end: 137, label: 'Key 3' },
    ]);
    const segDom = window.VideoEditor.__test.segmentDomCount();
    const segs = window.VideoEditor.__test.segments();
    // add a manual clip via the timeline API
    window.VideoEditor.__test.addManual(5, 20);
    const afterManual = window.VideoEditor.__test.segmentDomCount();
    return { rulerTicks, segDom, afterManual, firstLeft: segs[0].left, firstWidth: segs[0].width };
  })()`);
  log(veTest.rulerTicks > 0, 'timeline ruler rendered', veTest.rulerTicks + ' ticks');
  log(veTest.segDom === 3, 'AI highlights rendered as 3 timeline segments', veTest.segDom + ' segments');
  log(veTest.firstWidth > 0 && veTest.firstLeft >= 0, 'segments positioned on timeline', `left ${Math.round(veTest.firstLeft)} width ${Math.round(veTest.firstWidth)}`);
  log(veTest.afterManual === 4, 'manual clip adds to timeline', veTest.afterManual + ' segments');

  const newUi = await win.webContents.executeJavaScript(`({
    capExports: !!document.getElementById('veCapExports'),
    lenOpts: Array.from(document.getElementById('veShortLen').options).map(o => o.value),
    perClipCapBtns: document.querySelectorAll('#veClipList [data-cap]').length,
    shortsListed: window.VideoEditor.__test.shortsList().length,
    onTimeline: window.VideoEditor.__test.segments().length,
  })`);
  log(newUi.capExports, '"auto-caption my shorts" toggle present');
  log(newUi.lenOpts[0] === 'auto' && newUi.lenOpts.length === 5, 'shorts length has Auto + 4 fixed options', newUi.lenOpts.join(','));
  // 3 AI clips + 1 hand-made clip are on the timeline, but a SHORT is only ever
  // Long-to-shorts output — the manual one must not appear in the panel.
  log(newUi.perClipCapBtns === 3, 'per-clip 💬 caption button on every short', newUi.perClipCapBtns + ' buttons');
  log(newUi.shortsListed === 3 && newUi.onTimeline === 4,
    'the hand-made clip stays on the timeline and OUT of the Shorts panel',
    `panel=${newUi.shortsListed} timeline=${newUi.onTimeline}`);

  // splitting the BASE video (no clip under playhead) with segments cleared
  const baseSplit = await win.webContents.executeJavaScript(`(() => {
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 }); // clears segments
    const before = T.segmentDomCount();
    T.split(60);                        // empty timeline -> should split the video
    return { before, after: T.segmentDomCount() };
  })()`);
  log(baseSplit.before === 0 && baseSplit.after === 2, 'split works on the base video (no clip needed)', baseSplit.before + ' -> ' + baseSplit.after);

  const capcut = await win.webContents.executeJavaScript(`(() => {
    const T = window.VideoEditor.__test;
    T.applyClips([{ start: 33, end: 49, label: 'A' }, { start: 77, end: 93, label: 'B' }, { start: 121, end: 137, label: 'C' }]);
    const before = T.segmentDomCount();
    T.split(40);                       // inside the 33-49 clip
    const afterSplit = T.segmentDomCount();
    T.setCapEvents([{ start: 1, end: 3, text: 'HELLO CHURCH' }], 33); // clip-relative, offset 33s
    const capText = T.overlayAt(35);   // rel 2s -> visible
    const capNone = T.overlayAt(40);   // rel 7s -> hidden
    return { before, afterSplit, capText, capNone,
      srtGone: !document.querySelector('[data-vtool="captions"]'),
      zoom: !!document.getElementById('veZoom'), del: !!document.getElementById('veDelClip'),
      tlBar: !!document.querySelector('.ve-tl-bar'), capShow: !!document.getElementById('veCapShow') };
  })()`);
  log(capcut.afterSplit === capcut.before + 1, 'split at playhead makes two clips', `${capcut.before} -> ${capcut.afterSplit}`);
  log(capcut.capText === 'HELLO CHURCH', 'LIVE captions render on the preview player', '"' + capcut.capText + '"');
  log(capcut.capNone === null, 'overlay hides between caption lines');
  log(capcut.srtGone, '.srt tool removed from More tools');
  log(capcut.zoom && capcut.del && capcut.tlBar && capcut.capShow, 'timeline toolbar (zoom/delete) + CC toggle present');

  const quickFixes = await win.webContents.executeJavaScript(`(() => {
    // Force the Video Studio view active so the preview container has real layout size.
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    const noTrimBtns = !document.getElementById('veSetIn') && !document.getElementById('veSetOut');
    const reframeToggle = !!document.getElementById('veAutoReframe');
    T.setAspect('wide-16x9');            // 1920x1080 == source AR -> mask hidden
    const maskHiddenOnMatch = !T.cropMaskVisible();
    T.setAspect('reel-9x16');            // 1080x1920 != source AR -> mask visible, width < full
    const maskVisible = T.cropMaskVisible();
    const rect = T.cropFrameRect();
    const matte = T.cropMatteBoxShadow();
    return { noTrimBtns, reframeToggle, maskHiddenOnMatch, maskVisible, rectW: rect.w, rectH: rect.h, matte };
  })()`);
  log(quickFixes.noTrimBtns, 'playhead Set In/Out buttons removed');
  log(quickFixes.reframeToggle, 'auto-reframe (face tracking) toggle present');
  log(quickFixes.maskHiddenOnMatch, 'crop-ratio mask HIDDEN when export ratio matches source', '');
  log(quickFixes.maskVisible && quickFixes.rectW > 0 && quickFixes.rectH > 0, 'crop-ratio mask VISIBLE + sized when ratio changes to 9:16', `${quickFixes.rectW}x${quickFixes.rectH}`);
  // #3: the area outside the 9:16 frame is a SOLID BLACK matte (CapCut look), not a translucent dim.
  log(/rgb\(0, ?0, ?0\)/.test(quickFixes.matte) && !/0\.\d/.test(quickFixes.matte), '9:16 preview mattes outside the frame to SOLID BLACK (CapCut-style)', quickFixes.matte);

  /* ---------- [D] NLE round 2: pan/zoom crop, text overlays, fx preview ---- */
  console.log('\n[D] Timeline overhaul (crop, text, effects preview, tracks)');
  const nle = await win.webContents.executeJavaScript(`(() => {
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 60, width: 1920, height: 1080 });
    T.setAspect('reel-9x16');
    document.getElementById('veAutoReframe').checked = false; // manual crop guide only reflects framing when reframe is OFF

    // manual pan/zoom crop (CapCut canvas: the frame stays FIXED, the video moves/zooms)
    T.setFraming(1, 0.5, 0.5);
    const decisionDefault = T.cropReframeDecision(); // false at default (identical to plain center crop)
    const rectDefault = T.cropFrameRect();
    const scaleDefault = T.canvasScale();
    T.setFraming(2, 0.2, 0.3);
    const decisionCustom = T.cropReframeDecision(); // true once user pans/zooms
    const rectZoomed = T.cropFrameRect();
    const scaleZoomed = T.canvasScale();
    T.resetCrop();
    const decisionAfterReset = T.cropReframeDecision();

    // text overlays
    const before = T.textOverlayCount();
    const id1 = T.addTextAt({ text: 'HELLO', start: 0, end: 30, x: 0.3, y: 0.3 });
    const id2 = T.addTextAt({ text: 'WORLD', start: 40, end: 55, x: 0.7, y: 0.7 });
    const afterAdd = T.textOverlayCount();
    T.seekAndRefresh(10); // inside id1's range only
    const boxesAt10 = T.textBoxDomCount();
    T.seekAndRefresh(45); // inside id2's range only
    const boxesAt45 = T.textBoxDomCount();
    T.seekAndRefresh(35); // inside neither range
    const boxesAt35 = T.textBoxDomCount();
    const trackBlocks = T.textTrackDomCount(); // both always shown on the timeline track

    // live effects preview (CSS, no export)
    T.applyFxPreview({ fxSpeed: 2, fxVol: 1.4, fxBri: 0.15, fxCon: 1.2, fxSat: 1.3, fxRot: 90, fxFlipH: true, fxLook: 'bw' });
    const fx = T.fxPreviewState();
    T.resetFxPreview();
    const fxReset = T.fxPreviewState();

    return {
      decisionDefault, decisionCustom, decisionAfterReset,
      rectDefaultW: rectDefault.w, rectZoomedW: rectZoomed.w, scaleDefault, scaleZoomed,
      before, afterAdd, boxesAt10, boxesAt45, boxesAt35, trackBlocks,
      fx, fxReset,
      hasAudioTrackEl: !!document.getElementById('veAudioTrack'),
      hasTextTrackEl: !!document.getElementById('veTextTrack'),
      hasCapTrackEl: !!document.getElementById('veCapTrack'),
      hasTrackLabels: document.querySelectorAll('.ve-tl-label').length,
      hasAddTextBtn: !!document.getElementById('veAddText'),
      saveButtonsRemoved: !document.getElementById('veBurnText') && !document.getElementById('veSaveOverlays'),
      hasCropResetBtn: !!document.getElementById('veCropReset'),
      fxSpeedIsNumberInput: document.getElementById('fxSpeed').type === 'number',
      fxSpeedMax: document.getElementById('fxSpeed').max,
    };
  })()`);
  log(nle.decisionDefault === false, 'default framing (zoom=1,center) uses the plain center-crop export path');
  log(nle.decisionCustom === true, 'panning/zooming the crop switches export to the custom-framing path');
  log(nle.decisionAfterReset === false, '↺ reset crop returns to the plain center-crop path');
  log(nle.rectZoomedW === nle.rectDefaultW && nle.scaleZoomed > nle.scaleDefault * 1.5, 'CapCut canvas: frame stays FIXED, zooming enlarges the VIDEO under it', `frame ${nle.rectDefaultW}px, scale ${nle.scaleDefault} -> ${nle.scaleZoomed}`);
  log(nle.afterAdd === nle.before + 2, 'adding text overlays works', `${nle.before} -> ${nle.afterAdd}`);
  log(nle.boxesAt10 === 1 && nle.boxesAt45 === 1 && nle.boxesAt35 === 0, 'text overlays show/hide correctly based on the playhead time', `t10=${nle.boxesAt10} t45=${nle.boxesAt45} t35=${nle.boxesAt35}`);
  log(nle.trackBlocks === 2, 'both text overlays appear on the timeline Text track', nle.trackBlocks + ' blocks');
  log(nle.hasAudioTrackEl && nle.hasTextTrackEl && nle.hasCapTrackEl && nle.hasTrackLabels === 5, 'timeline has Video/Text/Captions/Audio/Music tracks with labels', nle.hasTrackLabels + ' labels');
  log(nle.hasAddTextBtn && nle.saveButtonsRemoved && nle.hasCropResetBtn, 'Add text / crop-reset present; separate "Save with text/overlays" buttons removed (exports include them)');
  log(nle.fxSpeedIsNumberInput && Number(nle.fxSpeedMax) >= 100, 'effects speed control extended to 0.1x-100x', 'max=' + nle.fxSpeedMax);
  log(nle.fx.playbackRate === 2 && nle.fx.volume === 0.7, 'live fx preview updates playbackRate + volume', JSON.stringify(nle.fx));
  log(/rotate\(90deg\)/.test(nle.fx.transform) && /scale\(-1,\s*1\)/.test(nle.fx.transform), 'live fx preview updates rotate/flip transform', nle.fx.transform);
  log(/grayscale/.test(nle.fx.filter), 'live fx preview applies the look filter (CSS)', nle.fx.filter);
  log(nle.fxReset.playbackRate === 1 && nle.fxReset.filter === '' && !/rotate|scale\(-/.test(nle.fxReset.transform), 'closing effects resets the live preview (canvas pan/zoom transform may remain)');

  /* ---------- [E] Round 3: text editing, gap-move, linked audio, undo/redo -- */
  console.log('\n[E] Text editing, split-gap-move, linked audio split, undo/redo');
  const round3 = await win.webContents.executeJavaScript(`(() => {
    try {
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });

    // --- 1) text editing: double-click-equivalent edit must actually change the text ---
    const id = T.addTextAt({ text: 'Original', start: 0, end: 999, x: 0.5, y: 0.5 });
    const before = T.textOf(id);
    T.editTextContent(id, 'Sunday 10am service');
    const after = T.textOf(id);

    // --- 2) split -> gap -> move: splitting creates 2 independent clips; moving
    //        one away leaves the ORIGINAL location empty (a real gap) ---
    T.split(60); // splits the bare video at 60s into [0-60] (index 0) and [60-145] (index 1)
    const segsAfterSplit = T.segments();
    const rightId = segsAfterSplit[1].id;
    T.moveClip(rightId, 10); // drag the right piece to start at t=10 (overlapping the left piece is allowed, like a real timeline)
    const segsAfterMove = T.segments();
    const movedSeg = segsAfterMove.find(s => s.id === rightId);
    const gapAtOldSpot = !segsAfterMove.some(s => s.id !== rightId && s.start <= 61 && s.end >= 61 && s.start > 60.5);
    // reset for next checks
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });

    // --- 3) audio is INDEPENDENT: splitting VIDEO must NOT split the audio (#2) ---
    T.split(60);                       // video row active -> splits video only
    const videoSegCount = T.segmentDomCount();
    const audioAfterVideoSplit = T.audioSegDomCount(); // should STAY 1
    // now split the AUDIO explicitly -> audio becomes 2, video unchanged
    T.splitAudio(30);
    const audioAfterAudioSplit = T.audioSegDomCount();
    const videoAfterAudioSplit = T.segmentDomCount();

    // --- 4) undo/redo ---
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    const histAtStart = T.historyLen();
    const undoDisabledInitially = T.undoBtnDisabled();
    T.split(60); // this is a real UI action (splitAtPlayhead) that DOES push history
    const countAfterSplit = T.segmentDomCount();
    const undoEnabledAfterSplit = !T.undoBtnDisabled();
    T.undo();
    const countAfterUndo = T.segmentDomCount();
    const redoEnabledAfterUndo = !T.redoBtnDisabled();
    T.redo();
    const countAfterRedo = T.segmentDomCount();

    return {
      textBefore: before, textAfter: after,
      segsAfterSplitLen: segsAfterSplit.length, movedSegStart: movedSeg && movedSeg.start, gapAtOldSpot,
      videoSegCount, audioAfterVideoSplit, audioAfterAudioSplit, videoAfterAudioSplit,
      undoDisabledInitially, countAfterSplit, undoEnabledAfterSplit, countAfterUndo, redoEnabledAfterUndo, countAfterRedo,
      capBurnLabel: document.getElementById('capBurn').textContent.trim(),
    };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (round3.__error) { console.error('ROUND3 SCRIPT ERROR:\\n' + round3.__error); }
  log(round3.textBefore === 'Original' && round3.textAfter === 'Sunday 10am service', 'double-click text editing actually changes the text', `"${round3.textBefore}" -> "${round3.textAfter}"`);
  log(round3.segsAfterSplitLen === 2, 'split creates exactly 2 independent clips', round3.segsAfterSplitLen + ' clips');
  log(round3.movedSegStart === 10, 'dragging a split clip actually moves it', 'new start=' + round3.movedSegStart);
  log(round3.gapAtOldSpot, 'moving a clip away leaves a GAP at its old timeline position (no other clip fills it)');
  log(round3.videoSegCount === 2 && round3.audioAfterVideoSplit === 1, 'splitting the VIDEO does NOT split the audio (independent tracks)', `video=${round3.videoSegCount} audio=${round3.audioAfterVideoSplit}`);
  log(round3.audioAfterAudioSplit === 2 && round3.videoAfterAudioSplit === 2, 'splitting the AUDIO row splits audio only (video unchanged)', `audio=${round3.audioAfterAudioSplit} video=${round3.videoAfterAudioSplit}`);
  log(round3.undoDisabledInitially === true, 'Undo button starts disabled (nothing to undo yet)');
  log(round3.countAfterSplit === 2 && round3.undoEnabledAfterSplit, 'splitting enables Undo', `count=${round3.countAfterSplit} undoEnabled=${round3.undoEnabledAfterSplit}`);
  log(round3.countAfterUndo === 0 && round3.redoEnabledAfterUndo, 'Undo reverts the split back to 0 clips (and enables Redo)', 'count=' + round3.countAfterUndo);
  log(round3.countAfterRedo === 2, 'Redo re-applies the split', 'count=' + round3.countAfterRedo);
  log(!/burn/i.test(round3.capBurnLabel), '"Burn captions" renamed to plain language', `"${round3.capBurnLabel}"`);

  /* ---------- [F] Round 4: REAL typing path + real clip blocks / gaps ------ */
  console.log('\n[F] Text typing (real DOM path) + real clip blocks & gaps');
  const round4 = await win.webContents.executeJavaScript(`(() => {
    try {
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });

    // 1) The ACTUAL bug: user clicks into an "Add text" box and types.
    const id = T.addTextAt({ text: 'Your text', start: 0, end: 999, x: 0.5, y: 0.5 });
    const typed = T.editByTyping(id, 'Sunday 10am');

    // 2) Video seeds as ONE real clip; splitting it makes two; blocks are opaque.
    const seeded = T.seedFullClip();
    T.setFilmstrip('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC');
    const seedSegId = T.segments()[0].id;
    const opaque = T.segIsOpaque(seedSegId);
    const stripHidden = T.continuousStripHidden();
    const beforeSplit = T.segmentDomCount();
    T.split(72);                       // split the seeded full clip at its middle
    const afterSplit = T.segmentDomCount();

    // 3) Move one piece aside -> a real gap opens at its old spot.
    const segs = T.segments();
    const rightId = segs[1].id;
    T.moveClip(rightId, 5);            // drag right piece near the start
    const segs2 = T.segments();
    const moved = segs2.find(s => s.id === rightId);
    const oldSpotEmpty = !segs2.some(s => s.id !== rightId && s.start <= 100 && s.end >= 100);

    return {
      caretHijacked: typed.caretHijacked, userSelect: typed.userSelect, computedNotNone: typed.computedNotNone, editable: typed.editable, committed: typed.committed,
      seededCount: seeded.count, seededDom: seeded.domCount,
      opaqueSolid: opaque.solid, opaqueImg: opaque.hasImage, stripHidden,
      beforeSplit, afterSplit, movedStart: moved && moved.start, oldSpotEmpty,
    };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (round4.__error) { console.error('ROUND4 SCRIPT ERROR:\\n' + round4.__error); }
  log(round4.caretHijacked === false, 'clicking into a text box no longer hijacks the caret (mousedown not prevented)', 'defaultPrevented=' + round4.caretHijacked);
  log(/text/.test(round4.userSelect || '') && round4.computedNotNone, 'editable text box is selectable (user-select:text, not none)', 'inline=' + round4.userSelect + ' computedNotNone=' + round4.computedNotNone);
  log(round4.editable === true, 'text box becomes contenteditable when editing');
  log(round4.committed === 'Sunday 10am', 'typing into the Add-text box actually changes the text', '"' + round4.committed + '"');
  log(round4.seededCount === 1 && round4.seededDom === 1, 'opening a video seeds it as ONE real clip on the timeline', `count=${round4.seededCount} dom=${round4.seededDom}`);
  log(round4.opaqueSolid === true, 'clip blocks are OPAQUE (so empty track shows as a real gap)', `solidBg=${round4.opaqueSolid} img=${round4.opaqueImg}`);
  log(round4.stripHidden === true, 'the old continuous full-width filmstrip is gone (film lives inside each clip)');
  log(round4.beforeSplit === 1 && round4.afterSplit === 2, 'splitting the seeded video makes two independent clips', `${round4.beforeSplit} -> ${round4.afterSplit}`);
  log(round4.movedStart === 5, 'a split clip can be dragged anywhere on the timeline', 'new start=' + round4.movedStart);
  log(round4.oldSpotEmpty === true, 'dragging a clip away leaves a real GAP (empty track) where it was');

  /* ---------- [G] Overlay lane (picture-in-picture) #1 --------------------- */
  console.log('\n[G] Overlay lane -> picture-in-picture composite');
  const ovl = await win.webContents.executeJavaScript(`(() => {
    try {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    T.split(60);                       // 2 base clips: [0-60] and [60-145]
    const segs = T.segments();
    const id = segs[1].id;
    const footBefore = T.footageOf(id);

    // move the right clip UP to the overlay lane
    T.toggleOverlay(id);
    const lane = T.laneOf(id);
    const count = T.overlayCount();
    const top = T.segTop(id);          // should render in the TOP (overlay) lane -> small top px
    const guideShown = T.overlayGuideVisible();

    // slide the overlay to a DIFFERENT time -> footage unchanged, only WHEN it plays
    T.setOverlayTl(id, 12);
    const tl = T.tlStartOf(id);
    const footAfter = T.footageOf(id);
    const payload = T.overlayPayload();

    // toggling back returns it to the main lane
    T.toggleOverlay(id);
    const laneBack = T.laneOf(id);
    const countBack = T.overlayCount();

    // has the UI controls + IPC bridge (the separate Save button is gone — exports composite automatically)
    const hasBtn = !!document.getElementById('veOverlay');
    const hasIpc = !!(window.api && window.api.video && typeof window.api.video.overlayComposite === 'function');
    return { lane, count, top, guideShown, tl, footBefore, footAfter, payload, laneBack, countBack, hasBtn, hasIpc };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (ovl.__error) { console.error('OVERLAY SCRIPT ERROR:\\n' + ovl.__error); }
  log(ovl.hasBtn && ovl.hasIpc, 'overlay UI controls + composite IPC bridge present');
  log(ovl.lane === 1 && ovl.count === 1, 'moving a clip to the Overlay lane marks it lane 1 (PiP)', `lane=${ovl.lane} count=${ovl.count}`);
  log(ovl.top != null && ovl.top < 40, 'overlay clip renders in the TOP (overlay) lane', 'top=' + ovl.top + 'px');
  log(ovl.guideShown === true, 'the picture-in-picture position guide shows on the preview for the overlay clip');
  log(ovl.tl === 12 && ovl.footBefore && ovl.footAfter && Math.abs(ovl.footAfter.start - ovl.footBefore.start) < 0.01, 'sliding the overlay changes WHEN it plays (tlStart) but NOT its footage', `tlStart=${ovl.tl} footage ${ovl.footBefore && ovl.footBefore.start}->${ovl.footAfter && ovl.footAfter.start}`);
  log(ovl.payload.length === 1 && ovl.payload[0].tlStart === 12 && ovl.payload[0].wFrac > 0, 'export payload carries src range + tlStart + PiP box', JSON.stringify(ovl.payload[0]));
  log(ovl.laneBack === 0 && ovl.countBack === 0, 'toggling again moves the clip back to the main lane', `lane=${ovl.laneBack} count=${ovl.countBack}`);

  /* ---------- [H] Timeline flexibility: snapping + zoom (#6) --------------- */
  console.log('\n[H] Timeline snapping + zoom controls');
  const flex = await win.webContents.executeJavaScript(`(() => {
    try {
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    T.applyClips([{ start: 33, end: 49, label: 'A' }, { start: 77, end: 93, label: 'B' }]);
    const segs = T.segments();
    const bId = segs[1].id;               // exclude clip B when snapping it
    T.setSnap(true);
    const near = T.snapValue(49.4, bId);  // 49.4 is close to clip A's END (49) -> snaps to 49
    T.setSnap(false);
    const noSnap = T.snapValue(49.4, bId);// snapping off -> unchanged
    T.setSnap(true);

    // zoom controls
    const fit = T.fitHook();
    const inZoom = T.zoomInHook();
    const outZoom = T.zoomOutHook();

    return {
      near, noSnap, fit, inZoom, outZoom,
      hasSnapBtn: !!document.getElementById('veSnap'),
      snapBtnOn: document.getElementById('veSnap').classList.contains('on'),
      hasZoomIn: !!document.getElementById('veZoomIn'),
      hasZoomOut: !!document.getElementById('veZoomOut'),
      hasFit: !!document.getElementById('veZoomFit'),
    };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (flex.__error) { console.error('FLEX SCRIPT ERROR:\\n' + flex.__error); }
  log(flex.hasSnapBtn && flex.hasZoomIn && flex.hasZoomOut && flex.hasFit, 'timeline has snap toggle + zoom in/out/fit buttons');
  log(flex.snapBtnOn === true, 'snapping is ON by default (magnet lit)');
  log(Math.abs(flex.near - 49) < 0.001, 'dragging a clip near another edge SNAPS to it', 'snapped 49.4 -> ' + flex.near);
  log(Math.abs(flex.noSnap - 49.4) < 0.001, 'snapping OFF leaves the position untouched', String(flex.noSnap));
  log(flex.inZoom > flex.fit && flex.outZoom < flex.inZoom, 'zoom in/out/fit change the timeline scale', `fit=${flex.fit.toFixed(2)} in=${flex.inZoom.toFixed(2)} out=${flex.outZoom.toFixed(2)}`);

  /* ---------- [I] The "Browse…" button must actually be clickable ---------- */
  console.log('\n[I] Browse button not covered by an overlay layer');
  const browse = await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    const b = document.getElementById('veOpen2');
    const nov = document.getElementById('veNoVid');
    // replicate the REAL "no video loaded" state (as on a fresh launch):
    nov.style.display = 'flex';                 // Browse prompt showing
    document.getElementById('vePlayer').style.display = 'none';
    document.getElementById('veCropMask').classList.add('hidden');   // no video -> crop guide hidden
    document.getElementById('veOverlayGuide').classList.add('hidden');
    document.getElementById('veCapOverlay').classList.add('hidden');
    const r = b.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const topEl = document.elementFromPoint(cx, cy);
    return {
      reachable: !!topEl && (topEl === b || b.contains(topEl)),
      topId: topEl ? (topEl.id || topEl.className || topEl.tagName) : 'none',
      w: Math.round(r.width),
    };
  })()`);
  log(browse.reachable, 'the "Browse…" button is the topmost element at its center (a real click lands on it)', 'topmost=' + browse.topId + ' btnW=' + browse.w);

  /* ---------- [J] Visible text size + gap-aware blank preview -------------- */
  console.log('\n[J] Text is VISIBLE (real px size) + preview goes blank over gaps');
  const gapj = await win.webContents.executeJavaScript(`(() => {
    try {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });

    // 1) text overlays render at a REAL pixel size scaled from the preview height
    //    (was ~1px via %-font-size -> invisible "_"). Explicit sizePct so the
    //    expectation is deterministic regardless of the test window's size.
    T.addTextAt({ text: 'SUNDAY 10AM', start: 0, end: 999, x: 0.5, y: 0.3, sizePct: 0.25 });
    T.seekAndRefresh(5);
    const fontPx = T.textFontPx();
    const ph = document.getElementById('veDrop').clientHeight || 400;
    const expectedPx = Math.max(8, Math.round(0.25 * ph));
    T.clearText();

    // 2) gap-aware preview: full clip -> split twice -> delete the middle -> gap
    T.seedFullClip();
    T.split(60); T.split(100);              // clips: [0-60] [60-100] [100-145]
    const segs = T.segments();
    const mid = segs.find(s => Math.abs(s.start - 60) < 0.01);
    const inClipBefore = (T.seekAndRefresh(80), T.gapMaskVisible()); // 80s inside [60-100] -> no mask
    T.deleteClip(mid.id);                    // now 60..100 is a GAP
    const inGap = (T.seekAndRefresh(80), T.gapMaskVisible());        // gap -> mask (blank preview)
    const backInClip = (T.seekAndRefresh(30), T.gapMaskVisible());   // inside [0-60] -> no mask
    // 3) delete ALL clips -> preview blank everywhere
    T.segments().slice().forEach(s => T.deleteClip(s.id));
    const allGone = T.gapMaskVisible();
    return { fontPx, expectedPx, inClipBefore, inGap, backInClip, allGone };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (gapj.__error) { console.error('GAP SCRIPT ERROR:\\n' + gapj.__error); }
  log(gapj.fontPx != null && Math.abs(gapj.fontPx - gapj.expectedPx) <= 1 && gapj.fontPx > 2, 'text renders at sizePct×previewHeight px (the old %-bug rendered ~1px regardless)', `${gapj.fontPx}px (expected ${gapj.expectedPx}px)`);
  log(gapj.inClipBefore === false, 'preview shows the video while the playhead is over a clip');
  log(gapj.inGap === true, 'preview goes BLANK when the playhead is over a gap (deleted/split-away clip)');
  log(gapj.backInClip === false, 'preview comes back when the playhead re-enters a clip');
  log(gapj.allGone === true, 'removing every clip from the timeline blanks the preview entirely');

  /* ---------- [K] Text style toolbar: custom size / font / colour / bold --- */
  console.log('\n[K] Text style toolbar (custom size, font, colour, bold)');
  const style = await win.webContents.executeJavaScript(`(() => {
    try {
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    const hiddenBefore = !T.textToolsVisible();          // nothing selected -> hidden
    const id = T.addTextAt({ text: 'EDIT ME', start: 0, end: 999, x: 0.5, y: 0.4 });
    T.seekAndRefresh(5);                                  // renders + selects it
    const shownOnSelect = T.textToolsVisible();
    const set = (elId, v) => { const el = document.getElementById(elId); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('vtSize', '12');                                  // make it SMALLER (user ask)
    const smallPx = T.textFontPx();
    set('vtSize', '96');                                  // and much bigger
    const bigPx = T.textFontPx();
    set('vtFont', 'Bebas Neue');
    set('vtColor', '#ffe600');
    document.getElementById('vtBold').click();            // toggle bold off (default true)
    const st = T.textStyleOf(id);
    document.getElementById('vtDelete').click();          // delete via the toolbar
    const goneCount = T.textOverlayCount();
    const hiddenAfter = !T.textToolsVisible();
    return { hiddenBefore, shownOnSelect, smallPx, bigPx, st, goneCount, hiddenAfter };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (style.__error) { console.error('STYLE SCRIPT ERROR:\\n' + style.__error); }
  log(style.hiddenBefore && style.shownOnSelect, 'style toolbar hidden until a text is selected, then appears', `before=${!style.hiddenBefore} onSelect=${style.shownOnSelect}`);
  log(Math.abs(style.smallPx - 12) <= 1, 'user can make the text SMALLER (12px)', style.smallPx + 'px');
  log(Math.abs(style.bigPx - 96) <= 1, 'user can make the text BIGGER (96px)', style.bigPx + 'px');
  log(style.st && style.st.font === 'Bebas Neue', 'font family changes', style.st && style.st.font);
  log(style.st && style.st.color === '#ffe600', 'text colour changes', style.st && style.st.color);
  log(style.st && style.st.bold === false, 'bold toggles');
  log(style.goneCount === 0 && style.hiddenAfter, 'toolbar 🗑 deletes the text and hides itself');

  /* ---------- [L] Shadow-box option, click-away hide, text inside the border  */
  console.log('\n[L] Black text backing + toolbar click-away + text inside drag border');
  const round7 = await win.webContents.executeJavaScript(`(() => {
    try {
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    const id = T.addTextAt({ text: 'STAND OUT', start: 0, end: 999, x: 0.5, y: 0.4, sizePct: 0.2 });
    T.seekAndRefresh(5);

    // 1) black backing toggle (⬛): applies live + stored on the overlay for export
    const bgBefore = T.textBgCss();
    document.getElementById('vtBg').click();
    const bgAfter = T.textBgCss();
    const stOn = T.textStyleOf(id);
    document.getElementById('vtBg').click();       // toggle back off
    const stOff = T.textStyleOf(id);

    // 2) text sits INSIDE the dashed drag border (box hugs the text)
    const g = T.textBoxGeom();
    const inside = g && g.textTop >= g.boxTop - 1 && g.textBottom <= g.boxBottom + 1;
    const hugs = g && (g.boxH - g.textH) < 24;      // border hugs the text, no tall empty box

    // 3) clicking OUTSIDE the text (empty preview) hides the toolbar + deselects
    const shownBefore = T.textToolsVisible();
    document.getElementById('veDrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const shownAfter = T.textToolsVisible();
    const selBox = document.querySelector('#veTextLayer .ve-text-box.sel');
    return { bgBefore, bgAfter, stOnBg: stOn && stOn.bg, stOffBg: stOff && stOff.bg, g, inside, hugs, shownBefore, shownAfter, deselected: !selBox };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (round7.__error) { console.error('ROUND7 SCRIPT ERROR:\\n' + round7.__error); }
  log(/rgba\(0, ?0, ?0, ?0\.7/.test(round7.bgAfter || '') && !/0\.7/.test(round7.bgBefore || ''), '⬛ adds a black backing behind the text (live preview)', `${round7.bgBefore} -> ${round7.bgAfter}`);
  log(round7.stOnBg === true && round7.stOffBg === false, 'the backing is stored on the overlay (so it burns into exports) and toggles off', `on=${round7.stOnBg} off=${round7.stOffBg}`);
  log(round7.inside === true, 'the text sits INSIDE the dashed drag border (not below it)', round7.g ? `text ${Math.round(round7.g.textTop)}..${Math.round(round7.g.textBottom)} vs box ${Math.round(round7.g.boxTop)}..${Math.round(round7.g.boxBottom)}` : 'no geom');
  log(round7.hugs === true, 'the drag border hugs the text (box height ≈ text height)', round7.g ? `boxH=${Math.round(round7.g.boxH)} textH=${Math.round(round7.g.textH)}` : 'no geom');
  log(round7.shownBefore === true && round7.shownAfter === false && round7.deselected, 'clicking outside the text hides the style toolbar + deselects', `before=${round7.shownBefore} after=${round7.shownAfter}`);

  /* ---------- [M] Drag-extend a text block on the timeline (trim handles) --- */
  console.log('\n[M] Text block trim handles: extend length on the timeline');
  const trim = await win.webContents.executeJavaScript(`(() => {
    try {
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    const id = T.addTextAt({ text: 'ON SCREEN', start: 10, end: 15, x: 0.5, y: 0.4 });
    const handles = T.textTrimHandleCount();      // 2 per text block (left + right)
    const before = T.textTimeOf(id);
    // drag the RIGHT edge far to the right -> extends to the END of the sermon
    const afterExtend = T.dragTextEdge(id, 'r', 4000);
    // drag the LEFT edge right a bit -> the text starts later
    const afterLeft = T.dragTextEdge(id, 'l', 60);
    // is the text now visible deep into the video (where before it wasn't)?
    T.seekAndRefresh(120);
    const visibleAt120 = T.textBoxDomCount() >= 1;
    return { handles, before, afterExtend, afterLeft, visibleAt120 };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (trim.__error) { console.error('TRIM SCRIPT ERROR:\\n' + trim.__error); }
  log(trim.handles === 2, 'each text block has 2 trim handles (start + end edges)', trim.handles + ' handles');
  log(trim.afterExtend && trim.afterExtend.end > trim.before.end + 5, 'dragging the RIGHT edge makes the text last longer', trim.before && `${trim.before.end}s -> ${trim.afterExtend && trim.afterExtend.end}s`);
  log(trim.afterExtend && Math.abs(trim.afterExtend.end - 145) < 0.5, 'you can extend the text all the way to the END of the sermon', trim.afterExtend && trim.afterExtend.end + 's of 145s');
  log(trim.afterLeft && trim.afterLeft.start > trim.before.start, 'dragging the LEFT edge changes when the text starts', trim.before && `${trim.before.start}s -> ${trim.afterLeft && trim.afterLeft.start}s`);
  log(trim.visibleAt120 === true, 'the extended text now shows deep into the video (t=120s)');

  /* ---------- [N] Live face-tracking preview: crop frame follows the face ---- */
  console.log('\n[N] Auto-reframe preview: the 9:16 frame follows the speaker');
  const live = await win.webContents.executeJavaScript(`(() => {
    try {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 60, width: 1920, height: 1080 });
    document.getElementById('veAutoReframe').checked = true; // reframe ON -> guide follows the face
    T.setAspect('reel-9x16');                                // portrait -> crop frame visible
    T.setLiveFace(0.2, 0.5); const panAtLeft = T.videoPanX();   // face on the LEFT
    T.setLiveFace(0.8, 0.5); const panAtRight = T.videoPanX();  // face on the RIGHT
    return { visible: T.cropMaskVisible(), panAtLeft, panAtRight,
             hasDetectElement: !!(window.FaceTrack && window.FaceTrack.detectElement) };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (live.__error) { console.error('LIVE SCRIPT ERROR:\\n' + live.__error); }
  log(live.hasDetectElement, 'live single-frame face detector is available for the preview');
  log(live.visible && live.panAtLeft > live.panAtRight + 10, 'the VIDEO slides under the fixed 9:16 canvas to follow the face (left→right)', `pan@0.2=${Math.round(live.panAtLeft)} pan@0.8=${Math.round(live.panAtRight)}`);

  /* ---------- [O] Added text always stays INSIDE the exported frame (9:16) --- */
  console.log('\n[O] Text + auto-reframe: text stays inside the 9:16 export frame');
  const tif = await win.webContents.executeJavaScript(`(() => {
    try {
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 100, width: 1920, height: 1080 }); // 16:9 source
    document.getElementById('veAutoReframe').checked = true;    // auto-reframe ON
    T.setAspect('reel-9x16');
    T.setLiveFace(0.5, 0.5); // deterministic frame position for the checks below
    const id = T.addTextAt({ text: 'JESUS IS LORD', start: 10, end: 30, x: 0.5, y: 0.35 });
    // try to drag the text far OUTSIDE the 9:16 frame -> it must be clamped back in
    const dragged = T.setTextPos(id, 0.02, 0.5);
    const frame = T.cropFrameBox();
    const drop = document.getElementById('veDrop');
    const px = dragged.x * drop.clientWidth;
    const insideGuide = frame && px >= frame.left - 1 && px <= frame.left + frame.width + 1;
    const edgePayload = (T.overlaysForShort(10, 30) || [])[0];
    // re-centre, then inspect the burn payload for a short cut at [10s..30s]
    T.setTextPos(id, 0.5, 0.35);
    const payload = (T.overlaysForShort(10, 30) || [])[0];
    const none = T.overlaysForShort(60, 80); // no overlap -> nothing to burn
    return { dragged, frame, insideGuide, edgePayload, payload, none };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (tif.__error) { console.error('TEXT-FRAME SCRIPT ERROR:\\n' + tif.__error); }
  log(tif.insideGuide === true, 'dragging text outside the 9:16 guide clamps it back inside', tif.frame && `x=${Math.round(tif.dragged.x * 1000) / 1000} frame ${Math.round(tif.frame.left)}..${Math.round(tif.frame.left + tif.frame.width)}px`);
  log(tif.edgePayload && tif.edgePayload.x >= 0.029 && tif.edgePayload.x <= 0.971, 'even edge-dragged text burns INSIDE the short frame (safe area)', tif.edgePayload && `x=${tif.edgePayload.x.toFixed(3)}`);
  log(tif.payload && Math.abs(tif.payload.x - 0.5) < 0.02, 'centred text stays centred in the exported short', tif.payload && `x=${tif.payload.x.toFixed(3)}`);
  log(tif.payload && tif.payload.start === 0 && Math.abs(tif.payload.end - 20) < 0.01, 'burn payload times are clip-relative', tif.payload && `${tif.payload.start}..${tif.payload.end}s`);
  log(tif.none === null, 'text that does not overlap the clip is not burned into it');

  /* ---------- [P] Long-to-shorts rename, audio trim/gap-mute, drag-takes-control -- */
  console.log('\n[P] Rename + functional audio track + drag takes manual control');
  const p = await win.webContents.executeJavaScript(`(() => {
    try {
    const T = window.VideoEditor.__test;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    T.seedFullClip(); // a real load seeds the whole video as one clip — audio checks need the picture present
    const btnText = document.getElementById('veFindHighlights').textContent;

    // audio clips have trim handles; trimming the right edge shortens the sound
    const aud0 = T.audioClips()[0];
    const handles = T.audioTrimHandleCount();
    const trimmed = T.trimAudioEdge(aud0.id, 'r', -200); // drag right edge left
    // audio GAP silences the preview: after the trim, seek past the new end
    T.seekAndRefresh(Math.min(144, trimmed.end + 5));
    const mutedInAudioGap = T.playerMuted();
    T.seekAndRefresh(Math.max(0, trimmed.end - 5));
    const audibleInAudioClip = !T.playerMuted();
    // deleting every audio clip mutes everywhere
    T.removeAudioClip(aud0.id);
    T.seekAndRefresh(10);
    const mutedAfterDeleteAll = T.playerMuted();

    // dragging the canvas while auto-reframe is ON flips to manual framing
    document.getElementById('veAutoReframe').checked = true;
    T.setAspect('reel-9x16');
    const frame = document.getElementById('veCropFrame');
    const r = frame.getBoundingClientRect();
    frame.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + r.width / 2 + 40, clientY: r.top + r.height / 2 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const reframeOffAfterDrag = !document.getElementById('veAutoReframe').checked;
    const framingMoved = T.cropReframeDecision(); // manual framing differs from default now

    // a short whose range overlaps an overlay-lane clip composites it on export
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    T.applyClips([{ start: 20, end: 50, label: 'Main' }, { start: 100, end: 110, label: 'PiP' }]);
    const segs = T.segments();
    T.toggleOverlay(segs[1].id);
    T.setOverlayTl(segs[1].id, 30); // plays 30..40 on the timeline -> overlaps Main 20..50
    const payload = T.overlayPayload();
    const pip = T.pipPayloadForShort(20, 50); // what exporting "Main" would composite
    const pipPartial = T.pipPayloadForShort(35, 50); // short starts MID-overlay -> src shifts
    return { btnText, handles, trimmed, mutedInAudioGap, audibleInAudioClip, mutedAfterDeleteAll,
             reframeOffAfterDrag, framingMoved, payload, pip, pipPartial };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (p.__error) { console.error('P SCRIPT ERROR:\\n' + p.__error); }
  log(/Long to short clips/i.test(p.btnText), 'AI button renamed to "Long to short clips"', `"${(p.btnText || '').trim()}"`);
  log(p.handles === 2, 'audio clip has 2 trim handles (start + end)', p.handles + ' handles');
  log(p.trimmed && p.trimmed.end < 144.9, 'dragging the audio right edge trims where the sound ends', `end=${p.trimmed && Math.round(p.trimmed.end)}s`);
  log(p.mutedInAudioGap === true, 'the preview goes SILENT over an audio gap (trimmed-away region)');
  log(p.audibleInAudioClip === true, 'the preview is audible while inside an audio clip');
  log(p.mutedAfterDeleteAll === true, 'deleting all audio clips mutes the whole preview');
  log(p.reframeOffAfterDrag && p.framingMoved, 'dragging the canvas while auto-reframe is ON takes manual control (and actually pans)', `reframeOff=${p.reframeOffAfterDrag} moved=${p.framingMoved}`);
  log(p.payload && p.payload.length === 1 && p.payload[0].tlStart === 30, 'overlay-lane clip is available for automatic PiP compositing at export', JSON.stringify(p.payload && p.payload[0]));
  log(p.pip && p.pip.length === 1 && p.pip[0].tlStart === 10 && p.pip[0].srcStart === 100 && p.pip[0].srcEnd === 110,
    'exporting a clip auto-composites the overlapping PiP at the right clip-relative time', JSON.stringify(p.pip && p.pip[0]));
  log(p.pipPartial && p.pipPartial[0].tlStart === 0 && Math.abs(p.pipPartial[0].srcStart - 105) < 0.01,
    'a short starting mid-overlay gets the RIGHT PiP footage slice', JSON.stringify(p.pipPartial && p.pipPartial[0]));

  /* ---------- [Q] Deep default, seed hidden from Shorts, audio slices, high text -- */
  console.log('\n[Q] Deep default ON + Shorts panel hides the base video + audio slices + high text');
  const q = await win.webContents.executeJavaScript(`(() => {
    try {
    const T = window.VideoEditor.__test;
    const deepDefault = document.getElementById('veDeep').checked;

    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    // seedFullClip mirrors loadVideo's seeding (incl. the seed flag added below)
    const seeded = T.seedFullClip();
    const cardsWithSeed = document.querySelectorAll('#veClipList .ve-clip').length;
    const exportAllDisabled = document.getElementById('veExportAll').disabled;
    T.split(60); // user edits the base -> both halves STAY the base video, not shorts
    const cardsAfterSplit = document.querySelectorAll('#veClipList .ve-clip').length;
    const timelineAfterSplit = T.segments().length;
    const shortsAfterSplit = T.shortsList().length;

    // audio: waveform is painted INSIDE clips; the track behind is an empty hatch
    const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    T.setWaveformUrl(tiny);
    const aud = T.audioClips()[0];
    const sliceInClip = T.audioSegHasWaveSlice(aud.id);
    const emptyHatch = T.audioTrackBgIsEmptyHatch();

    // text can sit HIGH: small text dragged to the very top clamps just inside
    document.getElementById('veAutoReframe').checked = false;
    T.setAspect('reel-9x16');
    const tid = T.addTextAt({ text: 'HIGH', start: 0, end: 30, x: 0.5, y: 0.5, sizePct: 0.03 });
    T.setTextPos(tid, 0.5, 0.0);
    // measure the text box's TOP edge vs the frame's top (centre-anchored y hides this)
    const boxR = document.querySelector('#veTextLayer .ve-text-box').getBoundingClientRect();
    const dropR = document.getElementById('veDrop').getBoundingClientRect();
    const frameTopAbs = dropR.top + document.getElementById('veCropFrame').offsetTop;
    const highGap = boxR.top - frameTopAbs;
    T.clearText();
    return { deepDefault, seedCount: seeded.count, cardsWithSeed, exportAllDisabled, cardsAfterSplit, timelineAfterSplit, shortsAfterSplit, sliceInClip, emptyHatch, highGap };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (q.__error) { console.error('Q SCRIPT ERROR:\\n' + q.__error); }
  log(q.deepDefault === true, '🧠 Deep mode is ON by default');
  log(q.seedCount === 1 && q.cardsWithSeed === 0 && q.exportAllDisabled === true, 'the seeded "Full video" stays OFF the Shorts panel (and Export all stays off)', `timeline=1 cards=${q.cardsWithSeed}`);
  log(q.cardsAfterSplit === 0 && q.timelineAfterSplit === 2 && q.shortsAfterSplit === 0,
    'splitting the base video does NOT put it in the Shorts panel (both halves stay the base)',
    `timeline=${q.timelineAfterSplit} cards=${q.cardsAfterSplit}`);
  log(q.sliceInClip === true, 'the waveform is painted INSIDE each audio clip (its own slice)');
  log(q.emptyHatch === true, 'the audio track behind the clips is an EMPTY hatch (gaps show no phantom audio)');
  log(q.highGap != null && q.highGap <= 8, 'text can now sit at the very TOP of the frame (top edge within 8px)', `gap=${q.highGap && q.highGap.toFixed(1)}px`);

  // [R] GO LIVE vMix-style switcher + auto-posting scheduler UI
  const r = await win.webContents.executeJavaScript(`(async () => {
    try {
    const nav = !!document.querySelector('.nav-item[data-view="live"]');
    const view = !!document.getElementById('view-live');
    const els = ['vmxOpenPreset','vmxSavePreset','vmxLastPreset','vmxClosePreset','vmxFullscreen',
      'vmxPauseInputs','vmxBasic','vmxSettingsBtn','vmxHelpBtn','vmxPrvCanvas','vmxPgmCanvas',
      'vmxQuickPlay','vmxCut','vmxFTB','vmxTbar','vmxTbarHandle','vmxMasterMeter','vmxInputs',
      'vmxAddInput','vmxRecord','vmxExternal','vmxStream','vmxMultiCorder','vmxPlayList',
      'vmxMixer','vmxMasterMute','vmxStFps','vmxStRender','vmxStCpu']
      .every((id) => !!document.getElementById(id));
    const api = window.LiveStudio && typeof window.LiveStudio.init === 'function' &&
      typeof window.LiveStudio.onShow === 'function' && !!window.LiveStudio.__test &&
      typeof window.LiveStudio.__test.addColor === 'function' &&
      typeof window.LiveStudio.__test.setTbar === 'function';
    const slots = document.querySelectorAll('#vmxSlots .vmx-slot').length;
    // a quick REAL switch: two colour inputs, cut, read the program pixel
    document.querySelector('.nav-item[data-view="live"]').click();
    await new Promise((res) => setTimeout(res, 250));
    const T = window.LiveStudio.__test;
    const a = T.addColor('SmokeRed', '#ff0000');
    const b = T.addColor('SmokeGreen', '#00ff00');
    T.drawNow();
    const pgmRed = T.pgmPixel(640, 360);
    T.setPreview(b.id); T.cut(); T.drawNow();
    const pgmGreen = T.pgmPixel(640, 360);
    T.closeAllInputs();
    // scheduler auto-post UI
    const banner = !!document.getElementById('schedAutoBanner');
    const fbFields = !!document.getElementById('setFbPageId') && !!document.getElementById('setFbToken') && !!document.getElementById('testFb');
    return { nav, view, els, api, slots, pgmRed, pgmGreen, banner, fbFields };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (r.__error) { console.error('R SCRIPT ERROR:\n' + r.__error); }
  log(r.nav && r.view, '[R] 🔴 Go Live: nav item + view exist');
  log(r.els, '[R] Go Live: full vMix board present (presets/monitors/transitions/T-bar/FTB/inputs/Record/Stream/status)');
  log(r.api, '[R] LiveStudio API + switcher test hooks exposed');
  log(r.slots === 4, '[R] 4 configurable transition slots', 'slots=' + r.slots);
  log(r.pgmRed && r.pgmRed[0] > 220 && r.pgmGreen && r.pgmGreen[1] > 220,
    '[R] real switch works: program shows red, then CUT takes green', `red=${r.pgmRed && r.pgmRed.slice(0,3)} green=${r.pgmGreen && r.pgmGreen.slice(0,3)}`);
  log(r.banner, '[R] Scheduler shows the auto-posting status banner');
  log(r.fbFields, '[R] Settings has Facebook Page ID + token + Test connection');

  /* ---------- [S] Live auto-reframe preview: hard leash during a fast walk ---- */
  console.log('\n[S] Live preview hard leash: speaker never drifts past the crop safe-zone mid-walk');
  const s = await win.webContents.executeJavaScript(`(() => {
    try {
    const T = window.VideoEditor.__test;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    // same source shape as the real sermon that surfaced this bug: 1280x720 -> 9:16
    // crops to ~31.7% of frame width, so a lagging preview drifts past the edge fast.
    T.loadFake({ durationSec: 60, width: 1280, height: 720 });
    document.getElementById('veAutoReframe').checked = true;
    T.setAspect('reel-9x16');
    T.resetLiveTrack();
    // initialize the track (2 agreeing ticks, mirrors a real cold start)
    T.liveTick(0.30, 0.5); T.liveTick(0.30, 0.5);
    const start = T.liveFaceState();
    // a real walk: raw face position steps 0.10 of the frame per ~220ms tick
    // (a brisk but ordinary walking pace) -- well inside a single 'moderate glide'
    // tick (dx<0.2) each time, so this exercises the EMA-lag path, not the jump path.
    const steps = [0.45, 0.55, 0.65, 0.75, 0.85];
    const gaps = [];
    for (const cx of steps) { T.liveTick(cx, 0.5); const st = T.liveFaceState(); gaps.push(Math.abs(st.cx - cx)); }
    const finalState = T.liveFaceState();

    // A whip pan / fast stride whose position keeps moving tick-to-tick can
    // NEVER land the ">0.2 delta, then 2 agreeing ticks" confirmation (each new
    // tick disagrees with the previous unconfirmed candidate by more than 0.1).
    // The FIRST tick of a new big-delta sighting deliberately HOLDS (filters a
    // lone phantom); from the SECOND consecutive big-delta tick onward it must
    // leash-drag, never freezing for more than that one initial tick. Feed a
    // cold-started track at 0.30, then a run of big jumps that never mutually
    // agree (a genuinely still-moving subject, not a repeating phantom).
    T.resetLiveTrack();
    T.liveTick(0.30, 0.5); T.liveTick(0.30, 0.5); // init
    const jumpStart = T.liveFaceState();
    const jumpSteps = [0.85, 0.55, 0.90, 0.50, 0.88]; // big swings, no two consecutive within 0.1 of each other
    const jumpGaps = [];
    for (const cx of jumpSteps) { T.liveTick(cx, 0.5); const st = T.liveFaceState(); jumpGaps.push(Math.abs(st.cx - cx)); }
    const jumpFinal = T.liveFaceState();

    // A LONE single-tick phantom (one big-delta reading, immediately followed
    // by a return to near the original position) must have ZERO effect — the
    // real bug found on the actual sermon video: a one-frame face-detector
    // phantom used to tug the crop toward it via the leash before
    // self-correcting; it must now not move the crop at all.
    T.resetLiveTrack();
    T.liveTick(0.30, 0.5); T.liveTick(0.30, 0.5); // init
    const blipBefore = T.liveFaceState();
    T.liveTick(0.85, 0.5); // one isolated big-delta reading
    T.liveTick(0.32, 0.5); // back to near-original (dead-band range) — the phantom does not repeat
    const blipAfter = T.liveFaceState();

    // A STABLE second face (two people in frame) that wins detection for two
    // consecutive ticks while the speaker's face is momentarily missed must
    // NOT steal the crop — the real two-cluster wobble measured on the sermon
    // footage. Only a THIRD consecutive agreeing tick (~660ms — a real camera
    // cut / true relocation) may take it.
    T.resetLiveTrack();
    T.liveTick(0.30, 0.5); T.liveTick(0.30, 0.5); // init
    T.liveTick(0.68, 0.5); T.liveTick(0.68, 0.5); // 2 agreeing far ticks
    const stealAfter2 = T.liveFaceState();
    T.liveTick(0.68, 0.5);                         // 3rd agreeing tick
    const stealAfter3 = T.liveFaceState();

    // POSE VETO: while the pose tracker still sees a body at the tracked spot,
    // a far face candidate is a phantom/other person by definition (bodies
    // don't teleport) — the crop must not move AT ALL, no matter how long the
    // phantom persists.
    T.resetLiveTrack();
    T.liveTick(0.30, 0.5); T.liveTick(0.30, 0.5); // init
    for (let i = 0; i < 6; i++) T.liveTick(0.68, 0.5, 0.31, 0.5); // far face, body still home
    const poseVetoAfter = T.liveFaceState();

    // POSE CORROBORATION: a genuine fast walk where the pose tracker agrees with
    // the face every tick must be followed IMMEDIATELY (leash-bounded, not
    // frozen for multiple ticks like an ambiguous phantom/second-face case) —
    // the real bug that left the crop visibly lagging a moving speaker.
    T.resetLiveTrack();
    T.liveTick(0.30, 0.5, 0.30, 0.5); T.liveTick(0.30, 0.5, 0.30, 0.5); // init
    T.liveTick(0.68, 0.5, 0.68, 0.5); // ONE far tick, pose agrees on THIS tick
    const corroborateAfter1 = T.liveFaceState();

    // COLD-START PHANTOM: a background/decor false-positive repeating for 2
    // consecutive ticks at the very start (before any track exists) must NOT
    // seed the initial anchor when the pose tracker is clearly pointing at the
    // REAL subject elsewhere the whole time — the exact real bug (a floral
    // display mis-detected as a face twice while the speaker's pose was
    // obvious). With no pose data at all, the same 2 agreeing ticks legitimately
    // DO seed a cold start (nothing better to go on) — both are checked here.
    T.resetLiveTrack();
    T.liveTick(0.20, 0.5, 0.70, 0.5); T.liveTick(0.21, 0.5, 0.71, 0.5); // phantom agrees w/ itself, pose says elsewhere
    const coldPhantomHeld = T.liveFaceState();
    T.liveTick(0.72, 0.5, 0.72, 0.5); // now the real subject's face appears, pose corroborates
    const coldPhantomRecovers = T.liveFaceState();

    T.resetLiveTrack();
    T.liveTick(0.20, 0.5); T.liveTick(0.21, 0.5); // same 2 agreeing ticks, but NO pose data at all
    const coldNoPoseSeeds = T.liveFaceState();

    document.getElementById('veAutoReframe').checked = false;
    T.resetLiveTrack();
    return {
      start, gaps, finalState, maxGap: Math.max(...gaps),
      jumpStart, jumpGaps, jumpFinal, firstJumpGap: jumpGaps[0], laterJumpGaps: jumpGaps.slice(1), maxLaterJumpGap: Math.max(...jumpGaps.slice(1)),
      blipBefore, blipAfter,
      stealAfter2, stealAfter3, poseVetoAfter, corroborateAfter1,
      coldPhantomHeld, coldPhantomRecovers, coldNoPoseSeeds,
    };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (s.__error) { console.error('S SCRIPT ERROR:\n' + s.__error); }
  // SAFE=0.30 * cropHalfX (tightened from 0.50 — see applyLiveFaceSample's comment: the
  // 60fps render glide handles all visual smoothing independently now, so the target-layer
  // leash can be tight without costing anything in how the motion looks on screen).
  // cropHalfX = 0.5*(targetAR/srcAR) for a 16:9->9:16 crop, same convention as facetrack.js.
  const sCropHalfX = 0.5 * ((9 / 16) / (1280 / 720));
  const sLeashX = 0.3 * sCropHalfX;
  // The synthetic "walk" steps 0.10 of the frame per 220ms tick (~45% of the
  // frame per second — a sprint, not a pace; real pacing moves ~0.02-0.05/tick
  // and stays in the smooth EMA path throughout). A sprint's readings quickly
  // land >0.2 from the lagging track, which the tracker now treats as a
  // possible relocation: it HOLDS for up to 2 ticks while the readings keep
  // agreeing with each other (this is exactly what makes a stable second face
  // unable to steal the crop — see the steal checks below), then SNAPS onto
  // the subject and stays locked. So the expected shape here is: one smooth
  // EMA tick, ≤2 bounded assessment ticks, then locked-on (small gaps).
  const sSmoothTol = sLeashX * 2.6;
  log(s.start && Math.abs(s.start.cx - 0.30) < 0.01, '[S] live track initializes on the speaker after 2 agreeing ticks', s.start && `cx=${s.start.cx.toFixed(3)}`);
  log(s.maxGap != null && s.maxGap <= 0.35 && s.gaps.slice(3).every((g) => g <= 0.15), '[S] during a sprint-fast walk the crop holds ≤2 assessment ticks (bounded) then locks onto the speaker', s.gaps && `gaps=${s.gaps.map((g) => g.toFixed(3)).join(',')}`);
  log(s.finalState && Math.abs(s.finalState.cx - 0.85) <= sSmoothTol, '[S] the crop keeps closing in on the speaker throughout the walk (never frozen far behind)', s.finalState && `final cx=${s.finalState.cx.toFixed(3)} vs speaker 0.850`);
  log(s.firstJumpGap != null && s.firstJumpGap > sLeashX, '[S] the FIRST tick of a new jump holds still (does not chase a possible lone phantom)', s.firstJumpGap != null && `gap=${s.firstJumpGap.toFixed(3)} > leash=${sLeashX.toFixed(3)}`);
  // While actively assessing a jump, smoothing is suspended (raw-to-raw
  // comparisons only — see applyLiveFaceSample's comment), so this stays leash-tight.
  log(s.maxLaterJumpGap != null && s.maxLaterJumpGap <= sLeashX + 0.005, '[S] a jump that NEVER confirms (position keeps moving) leash-drags from the 2nd tick on, not frozen', s.laterJumpGaps && `gaps=${s.laterJumpGaps.map((g) => g.toFixed(3)).join(',')} leash=${sLeashX.toFixed(3)}`);
  log(s.jumpFinal && Math.abs(s.jumpFinal.cx - s.jumpStart.cx) > 0.1, '[S] the crop actually MOVED during the never-confirming run (proves it did not stay frozen)', s.jumpStart && s.jumpFinal && `${s.jumpStart.cx.toFixed(3)} -> ${s.jumpFinal.cx.toFixed(3)}`);
  log(s.blipBefore && s.blipAfter && Math.abs(s.blipAfter.cx - s.blipBefore.cx) < 0.001, '[S] a LONE single-tick phantom has ZERO effect on the crop, even a tick or two later (the smoothing history never absorbed it)', s.blipBefore && s.blipAfter && `${s.blipBefore.cx.toFixed(3)} -> ${s.blipAfter.cx.toFixed(3)}`);
  log(s.stealAfter2 && Math.abs(s.stealAfter2.cx - 0.30) < 0.001, '[S] a STABLE second face seen for 2 consecutive ticks does NOT steal the crop (holds perfectly still)', s.stealAfter2 && `cx=${s.stealAfter2.cx.toFixed(3)} (still on speaker)`);
  log(s.stealAfter3 && Math.abs(s.stealAfter3.cx - 0.68) < 0.001, '[S] a 3rd consecutive agreeing tick (~660ms — a real cut/relocation) DOES take the crop there', s.stealAfter3 && `cx=${s.stealAfter3.cx.toFixed(3)}`);
  log(s.poseVetoAfter && Math.abs(s.poseVetoAfter.cx - 0.30) < 0.001, '[S] POSE VETO: while a body is still at the tracked spot, a far face NEVER steals — no matter how long it persists', s.poseVetoAfter && `cx=${s.poseVetoAfter.cx.toFixed(3)} after 6 phantom ticks`);
  log(s.corroborateAfter1 && Math.abs(s.corroborateAfter1.cx - 0.68) <= sLeashX + 0.001, '[S] POSE CORROBORATION: a far reading the pose tracker agrees with is followed on the VERY FIRST tick (no hold-to-confirm delay)', s.corroborateAfter1 && `cx=${s.corroborateAfter1.cx.toFixed(3)} (leash bound of 0.68: ${(0.68 - sLeashX).toFixed(3)})`);
  log(s.coldPhantomHeld && s.coldPhantomHeld.cx == null, '[S] COLD START: a repeating background phantom does NOT seed the track while pose points elsewhere', s.coldPhantomHeld && `cx=${s.coldPhantomHeld.cx}`);
  log(s.coldPhantomRecovers && Math.abs(s.coldPhantomRecovers.cx - 0.72) < 0.001, '[S] COLD START: the track seeds correctly on the REAL subject once pose corroborates it', s.coldPhantomRecovers && `cx=${s.coldPhantomRecovers.cx.toFixed(3)}`);
  log(s.coldNoPoseSeeds && Math.abs(s.coldNoPoseSeeds.cx - 0.21) < 0.001, '[S] COLD START: with NO pose data at all, 2 agreeing ticks still seed the track (unchanged fallback)', s.coldNoPoseSeeds && `cx=${s.coldNoPoseSeeds.cx.toFixed(3)}`);

  console.log('\n[T] collapsible sidebar + Go Live on the Dashboard');
  const t = await win.webContents.executeJavaScript(`(() => {
    try {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-dashboard').classList.add('active');
    const sidebar = document.getElementById('sidebar');
    const collapsedBefore = sidebar.classList.contains('collapsed');
    document.getElementById('sidebarToggle').click();
    const collapsedAfterToggle = sidebar.classList.contains('collapsed');
    document.getElementById('sidebarToggle').click(); // restore
    const collapsedAfterRestore = sidebar.classList.contains('collapsed');
    const goLiveCard = document.querySelector('.card.action[data-goto="live"]');
    const hasBadge = !!document.getElementById('dashLiveBadge');
    const hasDesc = !!document.getElementById('dashLiveDesc');
    return { collapsedBefore, collapsedAfterToggle, collapsedAfterRestore, hasGoLiveCard: !!goLiveCard, hasBadge, hasDesc };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (t.__error) { console.error('T SCRIPT ERROR:\n' + t.__error); }
  log(t.hasGoLiveCard, '[T] Dashboard has a Go Live card');
  log(t.hasBadge && t.hasDesc, '[T] Dashboard Go Live card has a live-status badge + description');
  log(t.collapsedAfterToggle === !t.collapsedBefore && t.collapsedAfterRestore === t.collapsedBefore,
    '[T] sidebar toggle flips the collapsed state and back', JSON.stringify(t));

  /* ---------- [U] Captions on the timeline (CapCut-style) ----------------- */
  console.log('\n[U] Captions timeline track: words visible, click-to-edit, move/trim, delete');
  const cap = await win.webContents.executeJavaScript(`(() => {
    try {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    const emptyBefore = T.capTrackEmptyShown();       // hint shows before any captions
    const saveHiddenBefore = !T.capSaveBtnVisible();
    const laneBefore = T.capLaneLabel();
    T.setCapEvents([
      { start: 2, end: 5, text: 'welcome to church' },
      { start: 6, end: 9, text: 'lets open our bibles' },
      { start: 12, end: 15, text: 'god is good' },
      { start: 16, end: 19, text: 'his mercy endures forever' },
    ], 0);
    T.revealCaps();                                    // what generating captions does
    const blocks = T.capTrackBlocks();
    const four = blocks.length === 4;
    const leftOrdered = blocks[0].left < blocks[1].left && blocks[1].left < blocks[2].left; // positioned by time
    const saveShown = T.capSaveBtnVisible();
    const laneAfter = T.capLaneLabel();
    // THE ASK: the actual words are painted on the timeline, big enough to read
    const r0 = T.capBlockReadout(0);
    const readable = T.capWordsReadable();
    const wordsShown = blocks[0].text === 'welcome to church' && r0.fullyVisible && r0.fontPx >= 11 && r0.h >= 24;
    // ONE CLICK drops you into typing that line's words
    T.clickCapBlock(1);
    const clickEdits = T.capEditingIndex() === 1 && T.capEditBoxWidth() >= 200;
    T.typeIntoCapEdit('let us open our Bibles');
    const liveOverlayFollows = true; // (overlay checked in captions-timeline.test.js against a real player)
    T.capEditKey('Enter');
    const editText = T.capEventsState()[1].text === 'let us open our Bibles';
    const editBlock = (T.capTrackBlocks().find(b => b.i === 1) || {}).text === 'let us open our Bibles';
    // Tab hops to the next line; Escape throws a change away
    T.clickCapBlock(2);
    T.capEditKey('Tab');
    const tabbed = T.capEditingIndex() === 3;
    const origThree = T.capEventsState()[3].text;
    T.typeIntoCapEdit('discard me');
    T.capEditKey('Escape');
    const escaped = T.capEventsState()[3].text === origThree && T.capEditingIndex() == null;
    // drag the right edge of the first caption later (keep it on screen longer)
    const end0Before = T.capEventsState()[0].end;
    T.dragCapEdge(0, 'r', 120);
    const end0After = T.capEventsState()[0].end;
    const trimmed = end0After > end0Before;
    // delete the selected caption (click selects + edits; Escape leaves the caret)
    T.clickCapBlock(2);
    T.capEditKey('Escape');
    T.deleteSelectedCap();
    const afterDelete = T.capEventsState().length;
    return { emptyBefore, saveHiddenBefore, laneBefore, four, leftOrdered, saveShown, laneAfter,
             wordsShown, readable, r0, clickEdits, editText, editBlock, tabbed, escaped, trimmed, afterDelete };
    } catch (e) { return { __error: e.message + '\\n' + e.stack }; }
  })()`);
  if (cap.__error) { console.error('U SCRIPT ERROR:\n' + cap.__error); }
  log(cap.emptyBefore && cap.saveHiddenBefore && cap.laneBefore === '💬 Captions', '[U] empty captions lane shows a hint + Save button hidden until captions exist');
  log(cap.four && cap.leftOrdered, '[U] generated captions render as blocks positioned by time');
  log(cap.wordsShown, '[U] a caption block shows its ACTUAL WORDS, readable size', cap.r0 ? `"${cap.r0.text}" ${cap.r0.w}x${cap.r0.h}px @${cap.r0.fontPx}px` : 'no block');
  log(cap.readable && cap.readable.visible > 0 && cap.readable.withWords === cap.readable.visible, '[U] every visible block has room for its words', JSON.stringify(cap.readable));
  log(cap.saveShown && /^💬 Captions \(\d+\)$/.test(cap.laneAfter || ''), '[U] "Save with captions" appears and the lane shows the line count', cap.laneAfter);
  log(cap.clickEdits, '[U] ONE CLICK on a caption block puts the caret in its words');
  log(cap.editText && cap.editBlock, '[U] typing + Enter saves the new words onto the block');
  log(cap.tabbed, '[U] Tab commits and hops to the next caption line');
  log(cap.escaped, '[U] Escape cancels an edit and leaves edit mode');
  log(cap.trimmed, '[U] dragging a caption edge changes its timing');
  log(cap.afterDelete === 3, '[U] Delete removes the selected caption block', cap.afterDelete + ' left');

  console.log(`\n==================  smoke test ${failed ? 'FAILED' : 'PASSED'}  ==================`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
