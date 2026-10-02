'use strict';
/*
 * 🎤 LISTEN, AGAINST A REAL SERMON.
 *
 * Everything else that tests this feature speaks at it with the Windows
 * synthesiser: clean, close, unaccented, no room. A preacher in a hall on a PA
 * is none of those things, and the difference is not a detail — it is the whole
 * question of whether the feature works on a Sunday.
 *
 * So this takes real recorded preaching, runs the REAL endpointer over it to
 * cut it into phrases exactly where the live one would, and puts each phrase
 * through the REAL speech model and the REAL matchers. What comes out is the
 * three numbers that matter: how long a phrase takes, what it heard, and what
 * it would have put on the wall.
 *
 *   node test/diag-voice-real.js "<audio-or-video>" [startSec] [durSec] [--model=tiny.en] [--ac=auto] [--quiet]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { endpointer, BLOCK_MS } = require('../src/renderer/voiceear');
const voicelisten = require('../src/main/voicelisten');
const voiceref = require('../src/main/voiceref');

const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
const input = args[0];
const startSec = parseFloat(args[1] || '0');
const durSec = parseFloat(args[2] || '120');
const MODEL = flags.model || 'tiny.en';
const RATE = 16000;

function pcmOf(file, from, dur) {
  const wav = path.join(os.tmpdir(), 'mw-voice-real-' + Date.now() + '.raw');
  execFileSync(ffmpeg, ['-v', 'error', '-ss', String(from), '-t', String(dur), '-i', file,
    '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-y', wav]);
  const b = fs.readFileSync(wav);
  fs.rmSync(wav, { force: true });
  return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2));
}

/** The live path's own endpointer, fed the same block RMS the worklet posts. */
function phrasesOf(pcm) {
  const per = Math.round(RATE * BLOCK_MS / 1000);
  const ep = endpointer();
  const out = [];
  for (let i = 0, b = 0; i + per <= pcm.length; i += per, b++) {
    let s = 0;
    for (let k = 0; k < per; k++) { const v = pcm[i + k] / 32768; s += v * v; }
    const ph = ep.push(Math.sqrt(s / per));
    if (ph) out.push({ from: ph.start * per, to: Math.min(pcm.length, (ph.end + 1) * per) });
  }
  return out;
}

(async () => {
  if (!voicelisten.available(MODEL)) { console.log('speech engine not installed'); process.exit(1); }
  const pcm = pcmOf(input, startSec, durSec);
  const phrases = phrasesOf(pcm);
  const spoken = phrases.reduce((a, p) => a + (p.to - p.from), 0) / RATE;
  console.log('\n' + path.basename(input) + '  ' + startSec + 's +' + durSec + 's   model ' + MODEL);
  console.log(phrases.length + ' phrases, ' + spoken.toFixed(1) + 's of speech in ' + durSec + 's '
    + '(' + (100 * spoken / durSec).toFixed(0) + '% talking)\n');

  let vf = null; const indexes = [];
  try {
    vf = require('../src/main/versefind');
    const bible = require('../src/main/bible');
    bible.init(flags.userdata || path.join(os.homedir(), 'AppData', 'Roaming', 'Church Work Space'));
    const abbrs = vf.chooseTranslations(flags.display || null, bible.installed().map((t) => t.abbr));
    for (const a of abbrs) { const ix = await vf.indexFor(a, bible.load); if (ix) indexes.push(ix); }
    console.log('quote matching across: ' + indexes.map((i) => i.translation).join(', ') + '\n');
  } catch (e) { console.log('quote matching unavailable: ' + e.message + '\n'); }

  const times = [], lens = [];
  let fired = 0, quoted = 0;
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i];
    const seg = pcm.subarray(p.from, p.to);
    const secs = (p.to - p.from) / RATE;
    const t0 = Date.now();
    const r = await voicelisten.hear({ pcm16: seg, modelId: MODEL, fast: flags.fast !== undefined });
    const ms = Date.now() - t0;
    times.push(ms); lens.push(secs);
    let q = null;
    if (vf && indexes.length && !r.intent && r.text) {
      try { q = vf.findAcross(indexes, r.text) || null; } catch (e) { q = null; }
    }
    if (r.intent) fired++;
    if (q && q.ok) quoted++;
    if (flags.quiet === undefined) {
      const at = (startSec + p.from / RATE).toFixed(1);
      console.log(`${at}s  ${secs.toFixed(1)}s speech  ${String(ms).padStart(5)}ms  ${(ms / Math.max(0.1, secs)).toFixed(2)}x`
        + (r.intent ? '  [' + r.intent.kind + (r.intent.ref ? ' ' + r.intent.ref : '') + ']' : '')
        + (q && q.ok ? '  [QUOTE ' + q.ref + ' share ' + q.share.toFixed(2) + ']' : (q && q.ref ? '  (nearly ' + q.ref + ' ' + q.share.toFixed(2) + ')' : '')));
      console.log('        "' + r.text + '"');
    }
  }
  const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)];
  console.log('\n  latency per phrase: median ' + q(times, 0.5) + 'ms  p90 ' + q(times, 0.9) + 'ms  max ' + Math.max(...times) + 'ms');
  console.log('  phrase length:      median ' + q(lens, 0.5).toFixed(1) + 's  max ' + Math.max(...lens).toFixed(1) + 's');
  console.log('  instructions fired: ' + fired + '   quotations matched: ' + quoted + '\n');
})().catch((e) => { console.log('FAILED: ' + ((e && e.stack) || e)); process.exit(1); });
