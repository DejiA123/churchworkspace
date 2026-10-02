'use strict';
/*
 * WHICH MODEL 🎤 LISTEN IS ACTUALLY HEARD WITH.
 *
 * Two bugs live in this corner, both of the same family — code that REPORTS one
 * thing and DOES another — and both are guarded here because neither produced
 * an error when it happened, only a worse service.
 *
 *   1. THE DOTLESS ID. `modelFor()` decided "the operator named a model" with
 *      `kind.includes('.')`, which worked only because every id happened to end
 *      in `.en`. `large-v3-turbo` has no dot in it, so choosing Turbo fell past
 *      that branch and silently got whatever bestModel() fancied instead.
 *
 *   2. THE LIE. Honouring a model's NAME is not the same as having its FILE.
 *      An id that was never downloaded resolved to the name while `modelFor`
 *      fell back to bestModel() and loaded something else — so `engine()`
 *      reported Turbo while Medium ran. The picker shows that reported id to
 *      the operator, and Medium is 3.2x SLOWER THAN REAL TIME on this machine,
 *      so Listen would quietly drop look-backs and fall behind the preacher
 *      with the studio insisting it was using the best model available.
 *
 * So the assertion that matters most here is simply: WHAT IT SAYS IT IS USING
 * IS WHAT IT LOADED. Everything else follows from that.
 *
 * The ladder itself is the third thing: automatic must climb to Small and must
 * NEVER choose Medium or Turbo on its own, because neither can keep up with a
 * live service — Listen asks for a 6-second look-back every 1.2 s.
 *
 *   node test/listen-model.test.js
 */
const path = require('path');
const os = require('os');

const captioner = require('../src/main/captioner');
captioner.init(process.env.MW_USERDATA
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Church Work Space'));
const voicelisten = require('../src/main/voicelisten');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

/** The model file an engine actually opened, as a bare id. */
const loadedId = (e) => (e ? path.basename(e.model).replace(/^ggml-/, '').replace(/\.bin$/, '') : null);

if (!voicelisten.available()) {
  console.log('\nSKIP listen-model: the speech engine is not installed on this machine\n');
  process.exit(0);
}

const all = captioner.models();
const installed = all.filter((m) => m.installed).map((m) => m.id);
console.log('\n== WHICH MODEL LISTEN IS HEARD WITH ==');
console.log('   known: ' + all.map((m) => m.id + (m.installed ? '*' : '')).join(' ') + '   (*=installed)');

/* ===================================================================== */
head('[1] ►► WHAT IT REPORTS IS WHAT IT LOADED ◄◄');
{
  const cases = [undefined, '', 'auto', ...all.map((m) => m.id), 'not-a-model'];
  let worst = null;
  for (const id of cases) {
    const e = voicelisten.engine(id);
    if (!e) continue;
    if (e.modelId !== loadedId(e)) worst = worst || { id, said: e.modelId, got: loadedId(e) };
  }
  check('every request resolves to the model it actually opens', !worst,
    worst ? `asked ${worst.id}: says ${worst.said}, loads ${worst.got}` : `${cases.length} requests checked`);
}

/* ===================================================================== */
head('[2] AUTOMATIC CLIMBS, BUT NOT PAST WHAT CAN KEEP UP');
{
  const auto = voicelisten.engine(undefined);
  check('automatic resolves to something', !!auto, auto && auto.modelId);
  check('…and never to Medium or Turbo on its own',
    !!auto && auto.modelId !== 'medium.en' && auto.modelId !== 'large-v3-turbo',
    auto && auto.modelId);
  check('…and it is one of the ladder\'s own rungs',
    !!auto && captioner.SCAN_AUTO.concat(['base.en']).includes(auto.modelId),
    `ladder = ${captioner.SCAN_AUTO.join(' > ')} > base.en`);
  // The ladder is shared with the shorts scanner on purpose; if someone adds a
  // rung here, that scan inherits it and a 30-minute scan becomes 90 minutes.
  check('the ladder still refuses Medium and Turbo',
    !captioner.SCAN_AUTO.includes('medium.en') && !captioner.SCAN_AUTO.includes('large-v3-turbo'),
    captioner.SCAN_AUTO.join(', '));
}

/* ===================================================================== */
head('[3] AN EXPLICIT CHOICE IS AN INSTRUCTION — when it can be honoured');
{
  for (const id of installed) {
    const e = voicelisten.engine(id);
    check(`explicit "${id}" is used exactly as asked`, !!e && e.modelId === id, e && e.modelId);
  }
  const missing = all.filter((m) => !m.installed).map((m) => m.id);
  for (const id of missing) {
    const e = voicelisten.engine(id);
    check(`"${id}" is not downloaded, so it falls back instead of pretending`,
      !!e && e.modelId !== id && e.modelId === loadedId(e), e && `using ${e.modelId}`);
  }
  if (!missing.length) console.log('  NOTE  every model is installed here, so the fallback case is not exercised');
}

/* ===================================================================== */
head('[4] THE DOTLESS ID (the bug that made Turbo unselectable)');
{
  const dotless = all.filter((m) => !m.id.includes('.'));
  check('the catalogue really does contain an id with no dot in it',
    dotless.length > 0, dotless.map((m) => m.id).join(', ') || 'none — this guard is now vacuous');
  /*
   * modelFor must decide "this is a named model" from the LIST, not from the
   * spelling. Proved without needing Turbo on disk: a dotless id that is not
   * installed must still be RECOGNISED (and so fall back honestly) rather than
   * being treated as a keyword like 'base' or 'tiny'.
   */
  for (const m of dotless) {
    const e = voicelisten.engine(m.id);
    check(`"${m.id}" is recognised as a model id, not parsed as a keyword`,
      !!e && e.modelId === loadedId(e), e && `-> ${e.modelId}`);
  }
}

console.log(`\n==== Listen model: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
