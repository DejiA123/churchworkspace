'use strict';
/*
 * THE SPEECH MODEL, KEPT LOADED.
 *
 * The ordinary path (voicelisten.js) runs whisper-cli once per phrase, and that
 * costs ~215 ms of process and DLL startup plus ~318 ms of model load EVERY
 * TIME — over half the wait, paid again and again for a model that never
 * changes. This module calls the same whisper library directly and keeps the
 * model in memory, which takes a phrase from ~790 ms to ~300 ms.
 *
 * IT IS OFF UNTIL SOMEBODY TURNS IT ON, and it is written to be provably safe
 * before it is used at all, because the failure mode of a wrong guess here is
 * not a wrong answer — it is a native crash that takes the whole studio down in
 * the middle of a service.
 *
 * WHY THIS IS SAFER THAN IT LOOKS.
 *
 * The dangerous part of calling a C library from here is `whisper_full_params`:
 * a ~300-byte struct passed BY VALUE, whose layout is fixed by a header this
 * app cannot see and which changes between whisper releases. Building one by
 * hand from a guessed layout is how you corrupt memory. So it is never built:
 *
 *   1. The LIBRARY fills it in. whisper_full_default_params() returns a fully
 *      initialised struct; it is kept as an opaque block and handed straight
 *      back. Every field this code does not care about keeps whatever the
 *      library chose, whatever version it is.
 *   2. The block is deliberately OVERSIZED (512 bytes against a real ~304), so
 *      the library can only ever read inside it. Nothing is read past the end
 *      of anyone's allocation.
 *   3. Only six fields are written, and every one of them is pinned by a
 *      LANDMARK first — a neighbouring field whose default value is distinctive
 *      enough to identify the layout: 16384, 0.01, 2.4, 0.6, -1.0, 5. Fifteen
 *      of them are checked. If a single one is off, this module refuses to run
 *      and the ordinary whisper-cli path is used instead.
 *
 * So a whisper build with a different layout does not crash — it declines.
 *
 * The calls go through koffi's async form on purpose: whisper_full takes ~300 ms
 * and the main process is answering IPC for all five studios. Measured, the
 * event loop keeps turning throughout.
 */
const fs = require('fs');
const path = require('path');
const captioner = require('./captioner');

/* Bigger than the real struct has ever been (~304 bytes, VAD params included),
 * so the library reads only inside what we own. */
const PARAMS_BYTES = 512;

let lib = null;          // the loaded library + bound functions
let ready = null;        // { ctx, defaults, model }
let refused = null;      // why the fast path is not available, in words

/**
 * The fifteen values that say "this is the layout we know".
 *
 * They are the library's OWN defaults, read back out of the struct it just
 * filled in. Together they pin every offset written to in transcribe():
 * n_threads sits beside n_max_text_ctx, audio_ctx between the token thresholds
 * and the sampling ones, the print flags in the packed booleans at 24.
 */
function layoutFaults(p) {
  const i32 = (o) => p.readInt32LE(o);
  const f32 = (o) => p.readFloatLE(o);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const checks = [
    ['n_max_text_ctx@8=16384', i32(8) === 16384],
    ['thold_pt@32=0.01', near(f32(32), 0.01)],
    ['thold_ptsum@36=0.01', near(f32(36), 0.01)],
    ['audio_ctx@56=0', i32(56) === 0],
    ['max_initial_ts@120=1', f32(120) === 1],
    ['length_penalty@124=-1', f32(124) === -1],
    ['temperature_inc@128=0.2', near(f32(128), 0.2)],
    ['entropy_thold@132=2.4', near(f32(132), 2.4)],
    ['logprob_thold@136=-1', f32(136) === -1],
    ['no_speech_thold@140=0.6', near(f32(140), 0.6)],
    ['greedy.best_of@144=5', i32(144) === 5],
    ['beam.beam_size@148=-1', i32(148) === -1],
    ['no_context@21', p[21] === 1],
    ['no_timestamps@22', p[22] === 0],
    ['print_progress@25', p[25] === 1],
    ['print_timestamps@27', p[27] === 1],
  ];
  return checks.filter(([, ok]) => !ok).map(([n]) => n);
}

/** Where the engine and its model are — the same ones the CLI path uses. */
function paths(modelId = 'tiny.en') {
  const p = captioner.whisperPaths();
  if (!p.cliFound) return null;
  const model = (captioner.modelFor ? captioner.modelFor(modelId) : null) || p.modelTiny || p.model;
  if (!model || !fs.existsSync(model)) return null;
  return { dir: path.dirname(p.cli), model };
}

/**
 * Load the library and the model. Returns true when the fast path is usable.
 * Never throws: everything that can go wrong ends as `refused` and the caller
 * quietly keeps using whisper-cli.
 */
function start({ modelId = 'tiny.en' } = {}) {
  const want = paths(modelId);
  /*
   * ASKING FOR A DIFFERENT MODEL USED TO GET THE OLD ONE. `ready` was checked
   * without looking at WHICH model was loaded, so once anything had started
   * tiny.en, every later request for base.en was answered, truthfully, with
   * "yes, the fast path is available" — and silently recognised with tiny.
   * That is invisible from the outside and would have made every accuracy
   * measurement of a model change a measurement of the wrong model.
   */
  if (ready) { if (!want || ready.model === want.model) return !!ready; stop(); }
  if (refused) return false;
  const where = want;
  if (!where) { refused = 'the speech engine is not installed'; return false; }
  try {
    /*
     * THE LIBRARY IS LOADED ONCE, THE MODEL AS OFTEN AS ASKED. koffi refuses to
     * declare a struct type twice, so doing all of this again to change model
     * threw "type already exists" — which was caught, stored as `refused`, and
     * turned the fast path off permanently the first time anybody switched.
     */
    if (!lib) {
      const koffi = require('koffi');
      /* whisper-cli calls ggml_backend_load_all() before it does anything; without
       * a registered backend, whisper_init dies on an assert rather than
       * returning null, so this has to happen first. */
      const ggml = koffi.load(path.join(where.dir, 'ggml.dll'));
      try { ggml.func('void ggml_backend_load_all_from_path(const char *dir)')(where.dir); }
      catch (e) { ggml.func('void ggml_backend_load_all()')(); }

      const w = koffi.load(path.join(where.dir, 'whisper.dll'));
      koffi.struct('whisper_full_params_blob', { raw: koffi.array('uint8_t', PARAMS_BYTES) });
      const fns = {
        defaults: w.func('whisper_full_params_blob whisper_full_default_params(int strategy)'),
        init: w.func('void * whisper_init_from_file(const char *path)'),
        full: w.func('int whisper_full(void *ctx, whisper_full_params_blob params, const float *samples, int n)'),
        nSegments: w.func('int whisper_full_n_segments(void *ctx)'),
        segment: w.func('const char * whisper_full_get_segment_text(void *ctx, int i)'),
        free: w.func('void whisper_free(void *ctx)'),
      };
      const defaults = Buffer.from(fns.defaults(0).raw);
      const faults = layoutFaults(defaults);
      if (faults.length) {
        refused = 'this whisper build lays its settings out differently (' + faults.join(', ') + ')';
        return false;
      }
      lib = fns; lib.defaultParams = defaults;
    }
    const ctx = lib.init(where.model);
    if (!ctx) { refused = 'the model would not load'; return false; }
    ready = { ctx, defaults: lib.defaultParams, model: where.model };
    return true;
  } catch (e) {
    refused = e && e.message ? e.message : String(e);
    return false;
  }
}

/**
 * One phrase of 16 kHz mono float samples in, the text out.
 *
 * Rejects rather than crashing if anything is off, so the caller can fall back
 * to the CLI for that phrase and carry on.
 */
function transcribe(samples, { audioCtx = 0, threads = 4, fallback = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!ready) return reject(new Error(refused || 'the fast path is not started'));
    if (!samples || !samples.length) return resolve('');
    /*
     * These are exactly the flags voicelisten passes whisper-cli — `-nt -sns
     * -nf -bo 1 -t N -ac N` — and they have to be, because the CLI's answers
     * are what every accuracy measurement for this feature was made against.
     *
     * The pair at the end is not optional and not independent. Without
     * suppress_nst the model rambles: one clip came back as the same sentence
     * twenty-two times over. Without no_timestamps it appends a hallucinated
     * extra segment: "Isaiah 40 verse 31" became "Isaiah 40 verse 31 I'm 40
     * verse 31", which threw the reference away entirely. whisper-cli sets
     * both, so this does too — dropping either one costs accuracy in a
     * different way, which is how the first attempt at this managed to look
     * fixed while it was still wrong.
     */
    const p = Buffer.from(ready.defaults);
    p.writeInt32LE(Math.max(1, Math.min(8, threads)), 4);        // n_threads
    p[22] = 1;                                                   // no_timestamps, as -nt
    p[24] = 0; p[25] = 0; p[26] = 0; p[27] = 0;                  // it must not print to our stdout
    p[114] = 1;                                                  // suppress_nst, as -sns
    if (audioCtx) p.writeInt32LE(audioCtx, 56);                  // audio_ctx
    p.writeFloatLE(fallback ? 0.2 : 0, 128);                     // temperature_inc: 0 turns the escape off
    p.writeInt32LE(1, 144);                                      // greedy best_of 1
    try {
      lib.full.async(ready.ctx, { raw: Array.from(p) }, samples, samples.length, (err, rc) => {
        if (err) return reject(err);
        if (rc !== 0) return reject(new Error('the speech model returned ' + rc));
        try {
          let text = '';
          const n = lib.nSegments(ready.ctx);
          for (let i = 0; i < n; i++) text += lib.segment(ready.ctx, i);
          resolve(text.replace(/\s+/g, ' ').trim());
        } catch (e) { reject(e); }
      });
    } catch (e) { reject(e); }
  });
}

/** Let the model go — on shutdown, or when the switch is turned off. */
function stop() {
  if (ready && lib) { try { lib.free(ready.ctx); } catch (e) {} }
  ready = null;
}
const isReady = () => !!ready;
/** Why it is not available, for the studio to show rather than fail silently. */
const why = () => refused;

module.exports = { start, stop, transcribe, isReady, why, layoutFaults, PARAMS_BYTES };
