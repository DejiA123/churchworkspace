'use strict';
/*
 * THE SOUND THAT LEAVES THE BUILDING — measured, not asserted.
 *
 * The complaint this exists to answer: "the audio is weird, especially when
 * people sing." Three separate mechanisms could each produce exactly that, and
 * all three are in the NDI-in / stream-out path:
 *
 *   1. the receiver hard-clipping a multichannel NDI feed into a square wave
 *      before the mixer ever sees it,
 *   2. the jitter buffer's fractional read acting as a moving low-pass, so the
 *      top end breathes (inaudible on speech, obvious on cymbals and voices),
 *   3. the mix itself going past full scale on a loud passage, with nothing in
 *      front of the encoder to stop it.
 *
 * Each section below builds a signal whose CORRECT answer is known in advance
 * and measures what actually comes out. "Peak is under the ceiling" is not on
 * its own a pass: a hard clipper also holds the peak under the ceiling, and
 * sounds appalling. So the measure throughout is how much of the output is
 * still the waveform that went in.
 *
 *   npx electron test/broadcast-audio.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { downmixPairs, newMixState } = require(path.join(ROOT, 'src/main/ndi-mix'));
const { TsShedder, ProgramHub, AUDIO_QUALITIES, DEFAULT_AUDIO_QUALITY, audioKbpsFor } = require(path.join(ROOT, 'src/main/livestream'));

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

/* ======================================================================== */
/* [A] The NDI receiver's channel downmix — pure arithmetic, no Electron.    */
/* ======================================================================== */
function sectionA() {
  head('[A] NDI multichannel downmix (src/main/ndi-mix.js)');
  const SR = 48000, NS = 960, PER = NS;          // one 20 ms packet
  const tone = (i, amp) => amp * Math.sin(2 * Math.PI * 440 * (i / SR));

  /** Build interleaved-by-plane channel data. `amps` is one amplitude per channel. */
  const frame = (amps) => {
    const f = new Float32Array(amps.length * PER);
    for (let c = 0; c < amps.length; c++) for (let i = 0; i < NS; i++) f[c * PER + i] = tone(i, amps[c]);
    return f;
  };
  const run = (amps, state, packets = 1) => {
    let r = null, left = null, right = null;
    for (let k = 0; k < packets; k++) {
      left = new Float32Array(NS); right = new Float32Array(NS);
      r = downmixPairs(frame(amps), { channels: amps.length, samples: NS, perChan: PER, sampleRate: SR },
        { left, right }, state);
    }
    let peak = 0;
    for (let i = 0; i < NS; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    return { ...r, peak, left, right };
  };

  // Plain stereo must be BIT-IDENTICAL — this path carries every ordinary NDI
  // source in the building and must not be "improved".
  {
    const st = newMixState();
    const amps = [0.8, 0.8];
    const out = run(amps, st);
    let same = true;
    for (let i = 0; i < NS; i++) if (Math.abs(out.left[i] - tone(i, 0.8)) > 1e-7) same = false;
    check('plain stereo passes through untouched', same && out.gain === 1, `gain=${out.gain}`);
  }

  // The Ableton "Stereo, 3-4" case: first pair silent, programme on the second.
  // Must come through at FULL level, not half.
  {
    const st = newMixState();
    const out = run([0, 0, 0.9, 0.9], st);
    check('programme on channels 3-4 arrives at full level',
      out.active === 1 && Math.abs(out.peak - 0.9) < 0.01, `active=${out.active} peak=${out.peak.toFixed(3)}`);
  }

  // THE BUG: both pairs carrying the same hot programme. Summing gives 1.8,
  // which the old code clipped flat to 1.0 — a square wave.
  {
    const st = newMixState();
    const out = run([0.9, 0.9, 0.9, 0.9], st, 3);
    check('two live pairs are averaged, not summed into a clip',
      out.active === 2 && out.peak <= 1.0 && Math.abs(out.peak - 0.9) < 0.02,
      `active=${out.active} peak=${out.peak.toFixed(3)} (a sum would be 1.80, clipped to 1.00)`);
    // and prove it is still a SINE, which a clipped sum would not be
    let dot = 0, refE = 0, e = 0;
    for (let i = 0; i < NS; i++) { const r = tone(i, 1); dot += out.left[i] * r; refE += r * r; e += out.left[i] * out.left[i]; }
    const purity = e > 0 ? 1 - Math.max(0, e - (dot / refE) * (dot / refE) * refE) / e : 0;
    check('…and what comes out is still the tone that went in', purity > 0.999, `purity ${(purity * 100).toFixed(2)}%`);
  }

  // The divisor must not flap. A pair that goes quiet for one packet cannot be
  // allowed to double the level of the other one mid-word.
  {
    const st = newMixState();
    run([0.9, 0.9, 0.9, 0.9], st, 5);           // both pairs established
    const gap = run([0.9, 0.9, 0, 0], st, 1);    // one packet of silence on pair 2
    check('a one-packet gap on a pair does not double the level',
      gap.gain === 0.5, `gain=${gap.gain}`);
    const later = run([0.9, 0.9, 0, 0], st, 400); // ~8 s later it really has gone
    check('…but a pair silent for seconds does drop out of the mix',
      later.gain === 1, `gain=${later.gain}`);
  }
}

/* ======================================================================== */
/* [B] The NDI jitter buffer's resampler — the real shipped worklet.        */
/* ======================================================================== */
/*
 * The worklet is an AudioWorklet module, so it cannot simply be required. It is
 * evaluated here against the same three globals the audio thread gives it
 * (`AudioWorkletProcessor`, `registerProcessor`, `sampleRate`) and then driven
 * one 128-sample block at a time — the REAL shipped file, deterministically.
 */
function loadWorklet(file, sr) {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer', file), 'utf-8');
  let Klass = null;
  const shim = {
    AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage() {} }; } },
    registerProcessor: (_n, k) => { Klass = k; },
    sampleRate: sr,
  };
  // eslint-disable-next-line no-new-func
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', src)(
    shim.AudioWorkletProcessor, shim.registerProcessor, shim.sampleRate);
  return Klass;
}

function sectionB() {
  head('[B] NDI jitter-buffer resampler (src/renderer/ndi-audio-worklet.js)');
  const SR = 48000;
  const Proc = loadWorklet('ndi-audio-worklet.js', SR);
  check('the shipped worklet loads and registers', !!Proc);
  if (!Proc) return;

  /**
   * Push a steady tone in and read the output back.
   *
   * 9 kHz is chosen deliberately: it is where a two-point linear interpolator
   * is losing serious level (about 1.7 dB at worst) while still being a
   * frequency a congregation and a cymbal genuinely occupy. A tone that comes
   * out at a WOBBLING level is the "swishy, crusty" artefact; a tone that comes
   * out flat is a resampler doing its job.
   */
  const measure = (freq) => {
    const p = new Proc({ processorOptions: { targetMs: 60 } });
    const out = [];
    let written = 0;
    const feed = (n) => {
      const l = new Float32Array(n), r = new Float32Array(n);
      for (let i = 0; i < n; i++) { l[i] = Math.sin(2 * Math.PI * freq * ((written + i) / SR)); r[i] = l[i]; }
      written += n;
      p.push(l, r);
    };
    feed(Math.round(SR * 0.2));                    // prime the cushion
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let b = 0; b < 400; b++) {                 // ~1.07 s of output
      feed(128);                                    // sender keeps pace
      L.fill(0); R.fill(0);
      p.process([], [[L, R]]);
      for (let i = 0; i < 128; i++) out.push(L[i]);
    }
    // envelope, measured over 10 ms windows, ignoring the priming at the front
    const W = Math.round(SR * 0.01);
    const env = [];
    for (let s = W * 4; s + W < out.length; s += W) {
      let pk = 0;
      for (let i = s; i < s + W; i++) pk = Math.max(pk, Math.abs(out[i]));
      env.push(pk);
    }
    return { min: Math.min(...env), max: Math.max(...env), windows: env.length };
  };

  const hi = measure(9000);
  check('a 9 kHz tone survives the jitter buffer at full level',
    hi.min > 0.9, `worst window ${(20 * Math.log10(hi.min)).toFixed(2)} dB (linear interpolation loses up to −1.7 dB)`);
  check('…and its level does not wobble as the read position drifts',
    hi.max - hi.min < 0.05, `spread ${(hi.max - hi.min).toFixed(4)}`);
  const lo = measure(1000);
  check('speech-band content is untouched', lo.min > 0.98, `worst ${lo.min.toFixed(4)}`);
}

/* ======================================================================== */
/* [D] Stream-side policy: one encode, copied — never a second AAC pass.   */
/* ======================================================================== */
function sectionD() {
  head('[D] What each destination does with the sound');
  const hub = new ProgramHub();
  hub.cfg = { width: 1280, height: 720, videoKbps: 2500, audioKbps: 160, fps: 30, format: 'mp4' };
  const rtmp = (audioKbps, width = 1280, height = 720) =>
    ({ kind: 'rtmp', q: { width, height, audioKbps, videoKbps: 2500 }, fps: 30 });

  check('a destination configured for 128k copies the 160k broadcast',
    hub._canCopyAudio(rtmp(128)) === true);
  check('a low-bandwidth destination (96k) copies it too',
    hub._canCopyAudio(rtmp(96)) === true,
    're-encoding a lossy stream into a lossier one buys nothing and costs cymbals');
  check('a recording always copies',
    hub._canCopyAudio({ kind: 'file', q: { audioKbps: 96 }, fps: 30 }) === true);
  // The one case that still re-encodes, so the rule is a rule and not "always true"
  hub.cfg.audioKbps = 320;
  check('an absurdly over-specified hub (320k → 96k ask) still re-encodes',
    hub._canCopyAudio(rtmp(96)) === false);
  hub.cfg.audioKbps = 160;

  // A destination whose SIZE differs cannot copy the picture — that is the
  // second encode that makes one platform stutter while the other is fine.
  check('a same-size destination copies the picture', hub._canCopyVideo(rtmp(128, 1280, 720)) === true);
  check('a different-size destination has to re-encode', hub._canCopyVideo(rtmp(128, 1920, 1080)) === false,
    'this is what the Streaming Settings warning is about');

  check('the sound quality list offers a music-grade default',
    audioKbpsFor(DEFAULT_AUDIO_QUALITY) >= 160,
    `${DEFAULT_AUDIO_QUALITY} = ${audioKbpsFor(DEFAULT_AUDIO_QUALITY)} kbps of ${AUDIO_QUALITIES.length} options`);
  check('an unknown id falls back to the default rather than 0',
    audioKbpsFor('nonsense') === audioKbpsFor(DEFAULT_AUDIO_QUALITY));
}

/* ======================================================================== */
/* [C] The broadcast limiter — inside the real renderer.                    */
/* ======================================================================== */
async function sectionC(win) {
  head('[C] Broadcast limiter (src/renderer/limiter-worklet.js)');
  const js = (code) => win.webContents.executeJavaScript(code);

  const ready = await js('window.LiveStudio.__test.limiterReady()');
  check('the look-ahead limiter loads on the audio thread', ready === true);

  const state = await js('window.LiveStudio.__test.limiterState()');
  check('it is ON by default and the master bus runs through it',
    state.on === true && state.routedThrough === 'worklet', JSON.stringify(state.routedThrough));
  // The default must be the transparent one. The compressor this replaces was
  // always levelling, which is what made singing sound as if it were breathing.
  check('…and it defaults to the transparent safety net, not a levelling effect',
    state.style === 'safety', state.style);
  const idle = await js('window.LiveStudio.__test.measureLimiter({ amp: 0.6, freq: 300, seconds: 0.4, ceilingDb: -1, driveDb: 0 })');
  check('…so an ordinary mix goes out completely untouched',
    Math.abs(idle.peak - 0.6) < 0.005 && idle.meter.grDb < 0.01,
    `peak ${idle.peak.toFixed(4)}, ${idle.meter.grDb.toFixed(3)} dB held down`);

  /*
   * A sine at +6 dBFS. Every honest limiter holds the peak at the ceiling; the
   * question that separates a limiter from a clipper is what SHAPE comes out.
   */
  const hot = await js('window.LiveStudio.__test.measureLimiter({ amp: 2, freq: 220, seconds: 0.5, ceilingDb: -1 })');
  const ceil = Math.pow(10, -1 / 20);
  check('a mix 6 dB over full scale comes out under the ceiling',
    hot.peak <= ceil + 1e-4, `peak ${hot.peakDb.toFixed(2)} dBFS (ceiling −1.00)`);
  check('…and it is still a sine wave, not a clipped one',
    hot.purity > 0.995, `${(hot.purity * 100).toFixed(2)}% of the output is the original tone`);
  check('…without the guarantee-clamp ever having to fire',
    hot.meter && hot.meter.hardClips === 0, `hardClips=${hot.meter && hot.meter.hardClips}`);
  check('…and it reports how much it held down', hot.meter && hot.meter.grDb > 3,
    `${hot.meter && hot.meter.grDb.toFixed(1)} dB of gain reduction`);

  /*
   * THE TRANSIENT. Silence, then full blast — the first consonant of a sung
   * line. A limiter that reacts after the fact lets the front of this through
   * at whatever level it arrives; look-ahead is exactly what stops that.
   */
  const burst = await js('window.LiveStudio.__test.measureLimiter({ amp: 3, freq: 900, seconds: 0.6, ceilingDb: -1, shape: "burst" })');
  check('a sudden 10 dB transient never gets past the ceiling',
    burst.peak <= ceil + 1e-4, `peak ${burst.peakDb.toFixed(2)} dBFS`);
  check('…with no clamping needed, i.e. the look-ahead really looked ahead',
    burst.meter && burst.meter.hardClips === 0, `hardClips=${burst.meter && burst.meter.hardClips}`);

  // A quiet mix must come out untouched: this is a safety net, not a sound.
  const quiet = await js('window.LiveStudio.__test.measureLimiter({ amp: 0.3, freq: 440, seconds: 0.3, ceilingDb: -1 })');
  check('a mix with headroom passes through unchanged',
    Math.abs(quiet.peak - 0.3) < 0.005 && quiet.purity > 0.999,
    `peak ${quiet.peak.toFixed(4)} purity ${(quiet.purity * 100).toFixed(2)}%`);

  // A tighter ceiling really is tighter (the setting does something).
  const tight = await js('window.LiveStudio.__test.measureLimiter({ amp: 2, freq: 220, seconds: 0.4, ceilingDb: -3 })');
  check('the ceiling setting is honoured', tight.peak <= Math.pow(10, -3 / 20) + 1e-4,
    `peak ${tight.peakDb.toFixed(2)} dBFS at a −3 dB ceiling`);

  // Drive: "Loud & even" must actually hold a loud mix down more than "Safety net".
  const driven = await js('window.LiveStudio.__test.measureLimiter({ amp: 0.7, freq: 220, seconds: 0.4, ceilingDb: -1, driveDb: 8 })');
  const undriven = await js('window.LiveStudio.__test.measureLimiter({ amp: 0.7, freq: 220, seconds: 0.4, ceilingDb: -1, driveDb: 0 })');
  check('“Loud & even” evens out a mix that “Safety net” leaves alone',
    driven.meter.grDb > 3 && undriven.meter.grDb < 0.1,
    `driven −${driven.meter.grDb.toFixed(1)} dB vs safety −${undriven.meter.grDb.toFixed(2)} dB`);
  check('…and still comes out clean', driven.purity > 0.99, `${(driven.purity * 100).toFixed(2)}%`);

  // Switching it off must really bypass it (an operator has to be able to).
  await js('window.LiveStudio.__test.setLimiter({ on: false })');
  const off = await js('window.LiveStudio.__test.limiterState()');
  check('turning it off takes it out of the chain', off.routedThrough === 'bypassed');
  await js('window.LiveStudio.__test.setLimiter({ on: true, style: "broadcast" })');
  const back = await js('window.LiveStudio.__test.limiterState()');
  check('and turning it back on restores it', back.routedThrough === 'worklet' && back.style === 'broadcast');

  const panel = await js('window.LiveStudio.__test.openLimiterModal()');
  check('the limiter panel opens from the Master strip', panel === true);
}

/* ======================================================================== */
/* [E] Destination mismatch — the thing that makes one platform sound bad.  */
/* ======================================================================== */
async function sectionE(win) {
  head('[E] Two destinations, one encode');
  const js = (code) => win.webContents.executeJavaScript(code);
  // Facebook 720p + YouTube 1080p: the classic church setup, and the one that
  // silently costs a whole second encode.
  const mixed = await js(`(() => {
    const st = window.LiveStudio.__test.rawStreams();
    st[0].key = 'fbkey'; st[0].dest = 'facebook'; st[0].quality = 'Facebook H264 720p 2.5mbps AAC 128kbps';
    st[1].key = 'ytkey'; st[1].dest = 'youtube';  st[1].quality = 'H264 1080p 4.5mbps AAC 128kbps';
    return window.LiveStudio.__test.mismatchedDestinations();
  })()`);
  check('a 720p + 1080p pair is reported as mismatched', mixed.length === 1 && mixed[0] === 1,
    `slots ${JSON.stringify(mixed)}`);

  const matched = await js('window.LiveStudio.__test.matchDestinations(1)');
  const after = await js('window.LiveStudio.__test.mismatchedDestinations()');
  check('“use this quality for all of them” fixes it in one click',
    after.length === 0 && matched[0] === matched[1], `${matched[0]} / ${matched[1]}`);

  const q = await js('window.LiveStudio.__test.programQualityFor([])');
  check('the shared encode carries music-grade sound for every destination',
    q.audioKbps >= 160, `${q.audioKbps} kbps`);

  /*
   * The Sound dropdown, in the REAL dialog.
   *
   * This is not a formality: the renderer only falls back to fetching the
   * preset tables over IPC when the preload did NOT hand them over
   * synchronously, and in the shipped app it always does. So a list that
   * exists only on the IPC path is a list nobody ever sees — the dropdown
   * would have offered exactly one option in production while every test that
   * stubbed the IPC passed.
   */
  const sound = await js(`(() => {
    window.LiveStudio.__test.openStreamSettings();
    const sel = document.querySelector('#vmxSsAudioQ');
    return sel ? { options: [...sel.options].map(o => o.value), value: sel.value } : null;
  })()`);
  check('the Sound dropdown really offers every option in the shipped app',
    sound && sound.options.length === AUDIO_QUALITIES.length,
    JSON.stringify(sound && sound.options));
  check('…and starts on the music-grade default', sound && sound.value === DEFAULT_AUDIO_QUALITY,
    sound && sound.value);
}

/* ---------------------------------------------------------------------- */
const WORK = path.join(os.tmpdir(), 'mw-bcaudio-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
/* Its own Chromium profile, wiped every run: the limiter remembers the
 * operator's choice in localStorage, and a previous run's choice is not the
 * default this test exists to check. */
app.setPath('userData', path.join(WORK, 'profile'));
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ live: {}, brand: {}, accounts: {}, apiKeys: {} }));
ipcMain.handle('settings:update', (e, p) => ok(Object.assign({ live: {} }, p)));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('present:outputs', () => ok([]));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('artnet:state', () => ok({ on: false }));
ipcMain.handle('live:engine', () => ok({ label: 'test', preference: 'auto', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
const { QUALITIES, QUALITY_GROUPS, LEGACY_QUALITY, DEFAULT_QUALITY, DESTINATIONS } = require(path.join(ROOT, 'src/main/livestream'));
ipcMain.handle('live:destinations', () => ok({
  destinations: DESTINATIONS, qualities: QUALITIES, qualityGroups: QUALITY_GROUPS,
  legacyQuality: LEGACY_QUALITY, defaultQuality: DEFAULT_QUALITY,
  audioQualities: AUDIO_QUALITIES, defaultAudioQuality: DEFAULT_AUDIO_QUALITY,
}));

app.whenReady().then(async () => {
  sectionA();
  sectionB();
  sectionD();

  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false },
  });
  // WebCodecs and AudioWorklet need a real page origin — a data: URL will not do.
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await new Promise((r) => setTimeout(r, 1500));
  await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-view="live"]').click();
    await new Promise(r => setTimeout(r, 400));
    return true;
  })()`);

  try { await sectionC(win); } catch (e) { check('[C] limiter section ran', false, String(e && e.message || e)); }
  try { await sectionE(win); } catch (e) { check('[E] destination section ran', false, String(e && e.message || e)); }

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
