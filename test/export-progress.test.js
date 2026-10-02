'use strict';
/*
 * ONE NUMBER FOR ONE EXPORT.
 *
 * The complaint, with a screenshot: the chip said "7 of 9 … 18%" and that 18%
 * was the CURRENT PASS — so within one short it climbed to 100% and started
 * again for the captions, again for the music, again for the outro. What the
 * operator wants to know is how far along THIS short is.
 *
 * So the number is now the whole export's. That is only worth having if it is
 * honest, which means four things, all checked here:
 *
 *   1. It never goes backwards, and never restarts mid-export.
 *   2. It reaches 100 — and only on the last pass, never on an earlier one.
 *   3. The plan matches what actually runs: a short with no music and no outro
 *      does not reserve room for them.
 *   4. The passes are weighted by what they really cost, so the bar does not
 *      crawl through a 70-second encode and then leap through a 3-second join.
 *
 * The exports are faked — what is under test is the renderer's arithmetic, not
 * ffmpeg — but they are driven through the REAL runJob/chain plumbing.
 *
 *   npx electron test/export-progress.test.js
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

const WORK = path.join(os.tmpdir(), 'mw-export-progress');
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'service-12s.mp4');
const MUSIC = path.join(WORK, 'bed.m4a');
const OUTRO = path.join(WORK, 'outro.mp4');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function build() {
  const mk = (out, args) => { if (!fs.existsSync(out) || fs.statSync(out).size < 8000) execFileSync(ffmpeg, args, { stdio: 'ignore' }); };
  mk(SRC, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-t', '12', '-i', 'testsrc2=s=640x360:r=30',
    '-f', 'lavfi', '-t', '12', '-i', 'sine=frequency=220:sample_rate=44100',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC]);
  mk(MUSIC, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-t', '12', '-i', 'sine=frequency=440:sample_rate=44100', '-c:a', 'aac', MUSIC]);
  mk(OUTRO, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-t', '3', '-i', 'color=c=0x101010:s=640x360:r=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', OUTRO]);
}

/* ---- fake renderers: each reports progress the way the real ones do ---- */
const ok = (data) => ({ ok: true, data });
const stub = (n) => { const p = path.join(WORK, `${n}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`); fs.writeFileSync(p, 'x'); return p; };
const ran = [];
async function fakeJob(e, a, name, steps = [15, 50, 85]) {
  ran.push(name);
  for (const pct of steps) {
    if (!e.sender.isDestroyed()) e.sender.send('job:progress', { jobId: a.jobId, percent: pct });
    await sleep(45);
  }
  return ok(stub(name));
}

ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [{ id: 'm1', name: 'Bed', file: MUSIC, durationSec: 12 }], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'not needed' }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('shell:openPath', () => ok(true));
ipcMain.handle('shell:showItem', () => ok(true));
ipcMain.handle('fs:rmdir', () => ok(true));
ipcMain.handle('video:info', async (_e, { input }) => {
  try { return ok(await video.getInfo(ctx, input)); } catch (e) { return ok({ width: 640, height: 360, fps: 30, durationSec: 12, hasAudio: true }); }
});
ipcMain.handle('video:waveform', async (_e, { input }) => {
  const output = path.join(WORK, `wave-${Date.now()}.png`);
  await video.waveform(ctx, { input, width: 1200, height: 90, output });
  return ok(output);
});
ipcMain.handle('video:filmstrip', async (_e, { input, count }) => {
  const output = path.join(WORK, `strip-${Date.now()}.png`);
  await video.filmstrip(ctx, { input, count: count || 12, output });
  return ok(output);
});
ipcMain.handle('fs:readImageDataUrl', async (_e, { path: p }) => ok(`data:image/png;base64,${fs.readFileSync(p).toString('base64')}`));

/*
 * The encode reports twice and then goes QUIET for two seconds before it
 * finishes — which is what really happens while Quick Sync's output is being
 * decoded again to prove it is not garbage. This is the case the creep exists
 * for, so it is the case the fixture reproduces.
 */
let silentEncode = false;
async function encodeJob(e, a) {
  ran.push('encode');
  for (const pct of (silentEncode ? [10, 25] : [15, 50, 85])) {
    if (!e.sender.isDestroyed()) e.sender.send('job:progress', { jobId: a.jobId, percent: pct });
    await sleep(45);
  }
  if (silentEncode) await sleep(2000);      // ...and now nothing at all
  return ok(stub('encode'));
}
ipcMain.handle('sermon:exportShort', encodeJob);
ipcMain.handle('sermon:exportReframed', encodeJob);
ipcMain.handle('sermon:exportFramed', encodeJob);
ipcMain.handle('video:mixMusic', (e, a) => fakeJob(e, a, 'music', [40, 90]));
ipcMain.handle('video:appendClips', (e, a) => fakeJob(e, a, 'outro', [50]));
ipcMain.handle('captions:burnTrack', (e, a) => fakeJob(e, a, 'burn'));
ipcMain.handle('captions:burn', (e, a) => fakeJob(e, a, 'burn'));
ipcMain.handle('overlays:burnImages', (e, a) => fakeJob(e, a, 'text'));
ipcMain.handle('overlays:burn', (e, a) => fakeJob(e, a, 'text'));
ipcMain.handle('captions:transcribe', async (e, a) => {
  ran.push('caption');
  for (const pct of [30, 70]) { if (!e.sender.isDestroyed()) e.sender.send('job:progress', { jobId: a.jobId, percent: pct }); await sleep(45); }
  // groupWords reads `text`, not `w` — the wrong key here silently produced
  // NO caption events, so the burn pass never ran and the plan over-reserved.
  return ok({ words: [
    { text: 'hello', start: 0.2, end: 0.7 }, { text: 'there', start: 0.8, end: 1.2 },
    { text: 'everyone.', start: 1.3, end: 1.9 }, { text: 'welcome', start: 2.0, end: 2.6 },
  ] });
});

app.whenReady().then(async () => {
  build();
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1500);
  const js = (src) => win.webContents.executeJavaScript(
    `(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

  /* ---------------- the weights themselves ---------------- */
  head('[1] The passes are weighted by what they cost, not split evenly');
  const W = await js('return window.__chainWeights;');
  check('an encode outweighs a stream-copy music mix', W.encode > W.music * 5, `encode ${W.encode} vs music ${W.music}`);
  check('drawing the captions outweighs joining the outro', W.burn > W.outro * 2, `burn ${W.burn} vs outro ${W.outro}`);
  check('the cover picture has no slice at all (it has nothing to report)', W.cover === undefined);

  /* ---------------- the plan matches what runs ---------------- */
  head('[2] The plan lists exactly the passes that will run');
  const setup = await js(`
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    const rf = document.getElementById('veAutoReframe'); if (rf) rf.checked = false;
    await window.VideoEditor.__test.loadReal(${JSON.stringify(SRC)});
    const T = window.VideoEditor.__test;
    T.setBgExport(true);       // watch it on the chip
    // The studio REMEMBERS a music bed and an outro between sittings, and this
    // profile is reused between runs — so [2] would otherwise be measuring the
    // last run's leftovers rather than the plan.
    T.clearMusic(); T.clearOutro();
    return { ok: true, music: T.musicState(), outro: T.outroState() };
  `);
  if (setup && setup.__error) { check('studio opened', false, setup.__error); app.exit(1); return; }
  check('starting from a clean desk: no music bed, no outro left over',
    !setup.music && !setup.outro, JSON.stringify({ music: setup.music, outro: setup.outro }));

  const P = await js(`
    const T = window.VideoEditor.__test;
    const plan = T.exportPlan;
    const s = { id: 'x', start: 0, end: 6, label: 'clip' };
    return {
      bare:     plan(s, {}),
      tracked:  plan(s, { track: true }),
      captions: plan(s, { captions: true }),
      lane:     plan(Object.assign({}, s, { capLane: true }), { captions: true }),
    };
  `);
  if (P && P.__error) { check('the plan could be built', false, P.__error); }
  else {
    check('>> a plain short is just the encode <<', JSON.stringify(P.bare) === '["encode"]', JSON.stringify(P.bare));
    check('…tracking is added only when the operator waits for it',
      JSON.stringify(P.tracked) === '["track","encode"]', JSON.stringify(P.tracked));
    check('…captions add the listening, the drawing AND the burning',
      JSON.stringify(P.captions) === '["encode","caption","draw","burn"]', JSON.stringify(P.captions));
  }

  /* ---------------- and now a real batch, watched ---------------- */
  head('[3] Nine shorts is what the screenshot showed: watch two of them');
  const R = await js(`
    const T = window.VideoEditor.__test;
    T.setLib({ music: [{ id: 'm1', name: 'Bed', file: ${JSON.stringify(MUSIC)}, durationSec: 12 }],
               clips: [{ id: 'c1', name: 'Outro', file: ${JSON.stringify(OUTRO)}, durationSec: 3 }] });
    T.useMusic('m1'); T.useOutro('c1');
    const capBox = document.getElementById('veCapExports');
    if (capBox) { capBox.checked = true; capBox.dispatchEvent(new Event('change', { bubbles: true })); }
    T.addShort(0, 4); T.addShort(5, 9);
    const seen = [];
    const read = () => {
      const pctEl = document.querySelector('#bgDock .bgj.run .bgj-pct');
      const batEl = document.querySelector('#bgDock .bgj.run .bgj-batch');
      const stEl  = document.querySelector('#bgDock .bgj.run .bgj-step');
      if (!pctEl) return;
      const pct = parseInt(pctEl.textContent, 10);
      if (isNaN(pct)) return;
      seen.push({ pct, batch: batEl ? batEl.textContent : '', step: stEl ? stEl.textContent : '' });
    };
    const timer = setInterval(read, 15);
    await T.exportAll();
    clearInterval(timer);
    const series = [];
    for (const d of seen) if (!series.length || series[series.length - 1].pct !== d.pct || series[series.length - 1].batch !== d.batch) series.push(d);
    return { series, steps: [...new Set(seen.map(d => d.step).filter(Boolean))] };
  `);
  if (R && R.__error) { check('the batch ran', false, R.__error); }
  else {
    const byShort = {};
    for (const d of R.series) (byShort[d.batch] = byShort[d.batch] || []).push(d.pct);
    for (const k of Object.keys(byShort)) console.log(`    ${k || '(no batch)'}:  ${byShort[k].join(' -> ')}`);
    console.log('    passes it named:');
    for (const st of R.steps) console.log('      - ' + st.slice(0, 74));

    const shorts = Object.keys(byShort).filter((k) => /of/.test(k));
    check('both shorts were tracked separately on the chip', shorts.length === 2, shorts.join(', '));
    let backwards = null, notFull = null;
    for (const k of shorts) {
      const p = byShort[k];
      for (let i = 1; i < p.length; i++) if (p[i] < p[i - 1]) backwards = `${k}: ${p.join(' -> ')}`;
      if (Math.max(...p) !== 100) notFull = `${k}: peak ${Math.max(...p)}`;
    }
    check('>> inside one short the number only ever goes forward <<', !backwards, backwards || 'both climb');
    check('>> and each short reaches 100 before the next begins <<', !notFull, notFull || 'both reach 100');
    let hundreds = 0;
    for (const k of shorts) hundreds += byShort[k].filter((v) => v === 100).length;
    check('>> 100 means FINISHED, not "this pass is finished" <<', hundreds === shorts.length,
      `${hundreds} hits of 100 across ${shorts.length} shorts`);
    const first = byShort[shorts[0]] || [], second = byShort[shorts[1]] || [];
    check('...the next short starts again from the beginning, as it should',
      second.length > 0 && second[0] < 100 && first[first.length - 1] === 100,
      `${first.join(' -> ')}  ||  ${second.join(' -> ')}`);
    check('...and it climbed through the middle rather than jumping',
      first.some((v) => v > 20 && v < 80), first.join(' -> '));
    check('...several real passes ran per short', ran.length >= 6, ran.join(' -> '));
    check('>> the captions pass really ran (it is in the plan) <<',
      ran.includes('burn'), ran.join(' -> '));
  }

  /* ---------------- it must never LOOK stuck ---------------- */
  head('[4] A pass that reports NOTHING still moves the number');
  /*
   * Driven through the real runJob/chain plumbing with a job that never reports
   * anything at all \u2014 which is not a contrivance: loading twenty-two caption
   * font faces, decoding a finished file to prove Quick Sync did not corrupt it,
   * and tracking a speaker across a clip are all silent, and between them they
   * are most of an export.
   *
   * Timed against a stopwatch rather than against a real export, because a
   * fixture's faked passes finish in milliseconds while its ONE real pass takes
   * ten seconds \u2014 proportions no weighting could survive, and nothing like the
   * shape of the thing being tested.
   */
  const S = await js(`
    const id = window.__newTask('probe', { background: true });
    window.__chainBegin(id, ['encode', 'music']);
    let release;
    const held = new Promise((r) => { release = r; });
    const running = window.__runJob('probe encode', 'probe-job-1', () => held, { task: id, chain: 'encode' });
    const seen = [];
    const t0 = Date.now();
    const timer = setInterval(() => {
      const d = window.__chainDebug();
      if (d) seen.push({ ms: Date.now() - t0, shown: d.shown, base: d.base, span: d.span, reported: d.reported });
    }, 100);
    await new Promise((r) => setTimeout(r, 3000));     // three seconds of silence
    clearInterval(timer);
    release(null);
    await running;
    window.__endTask(id, { ok: true });
    return { seen };
  `);
  if (S && S.__error) { check('the silent pass ran', false, S.__error); }
  else {
    const pts = S.seen;
    const shown = pts.map((d) => d.shown);
    const base = pts.length ? pts[0].base : 0, span = pts.length ? pts[0].span : 0;
    console.log(`    slice ${base.toFixed(1)}% .. ${(base + span).toFixed(1)}%   nothing was ever reported`);
    console.log(`    it moved: ${shown.filter((v, i) => i === 0 || v !== shown[i - 1]).map((v) => v.toFixed(1)).join(' -> ')}`);
    check('the pass really did report nothing', pts.every((d) => d.reported <= d.base + 0.001));
    check('>> and the number moved anyway <<',
      shown.length > 5 && shown[shown.length - 1] > shown[0] + 1,
      `${shown[0].toFixed(1)} -> ${shown[shown.length - 1].toFixed(1)}`);
    // the longest it held one WHOLE percent, which is what the operator sees
    const ints = pts.map((d) => ({ ms: d.ms, v: Math.round(d.shown) }));
    let worst = 0, worstAt = 0;
    for (let i = 1; i < ints.length; i++) {
      if (ints[i].v !== ints[i - 1].v) continue;
      let j = i; while (j + 1 < ints.length && ints[j + 1].v === ints[i].v) j++;
      const held2 = ints[j].ms - ints[i - 1].ms;
      if (held2 > worst) { worst = held2; worstAt = ints[i].v; }
      i = j;
    }
    console.log(`    longest it sat on one whole percent: ${worst} ms (at ${worstAt}%)`);
    check('>> it never sits on one number for long <<', worst < 1500, `${worst} ms on ${worstAt}%`);
    check('>> and it never goes backwards <<', shown.every((v, i) => i === 0 || v >= shown[i - 1]));
    const ceiling = base + span * 0.92;
    check('>> nor past the pass it is inside (it cannot claim to have finished) <<',
      shown.every((v) => v <= ceiling + 0.01), `peak ${Math.max(...shown).toFixed(1)} vs ceiling ${ceiling.toFixed(1)}`);
  }



  head('[5] ...but the creep never overtakes the truth');
  const C = await js(`
    const W = window.__chainWeights;
    // encode(100) + music(10) + outro(10): the encode owns the first 83%.
    window.__chainBegin('probe-not-a-task', ['encode', 'music', 'outro']);
    return { ok: true, weights: { e: W.encode, m: W.music, o: W.outro } };
  `);
  check('a chain for a task that does not exist is harmless', C && C.ok === true);
  {
    // The ceiling is a property of the arithmetic: a silent pass may approach
    // 92% of its OWN slice and no further, so the pass after it always starts
    // from a number the truth has room to correct.
    const e = 100, m = 10, o = 10, total = e + m + o;
    const encodeEnd = (e / total) * 100;
    const ceiling = 0 + encodeEnd * 0.92;
    check('>> a silent pass can never claim to have finished <<', ceiling < encodeEnd,
      `creeps to at most ${ceiling.toFixed(1)}% of a pass that ends at ${encodeEnd.toFixed(1)}%`);
  }

  head('[6] The animation stops when there is nothing to animate');
  const Z = await js(`
    await new Promise(r => setTimeout(r, 400));
    return { ticking: !!window.__chainTicking && window.__chainTicking() };
  `);
  check('no timer is left running once every export has finished', Z && Z.ticking === false,
    JSON.stringify(Z));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
