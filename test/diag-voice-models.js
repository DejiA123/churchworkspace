'use strict';
/*
 * WHICH SPEECH MODEL, AND HOW MUCH AUDIO AT A TIME.
 *
 * The model was chosen against the Windows synthesiser saying short, clean
 * instructions, and it got every one of them right. A preacher in a hall on a
 * PA is a completely different signal, and on real preaching the same model
 * hears "I went by the feet of the slough" for "I went by the field of the
 * slothful" and "Acts of the Six" for "Acts chapter 6" — which is the whole
 * feature failing, silently, on the only input that matters.
 *
 * So: real recorded preaching, cut the way the live ear cuts it, through every
 * candidate configuration, scored on WHAT IT WOULD HAVE PUT ON THE WALL —
 * spoken references found, quotations matched, and the wall-clock cost of each.
 *
 *   node test/diag-voice-models.js "<audio>" [startSec] [durSec] [--win=6] [--hop=2]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const captioner = require('../src/main/captioner');
captioner.init(require('path').join(require('os').homedir(),'AppData','Roaming','Church Work Space'));
const voicelisten = require('../src/main/voicelisten');
const voiceref = require('../src/main/voiceref');
const whisperfast = require('../src/main/whisperfast');

const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
const input = args[0];
const startSec = parseFloat(args[1] || '0');
const durSec = parseFloat(args[2] || '120');
const WIN = parseFloat(flags.win || '6');      // seconds of audio handed over at once
const HOP = parseFloat(flags.hop || '2');      // how often that happens
const RATE = 16000;

function pcmOf(file, from, dur) {
  const raw = path.join(os.tmpdir(), 'mw-vm-' + Date.now() + '.raw');
  execFileSync(ffmpeg, ['-v', 'error', '-ss', String(from), '-t', String(dur), '-i', file,
    '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-y', raw]);
  const b = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2));
}

/*
 * WHAT THE PREACHER ACTUALLY SAID IN THIS PASSAGE, and therefore what the
 * feature should have done. Read off a careful transcription of the audio, not
 * off any model under test. Times are the seconds within the window in which
 * the words are spoken, so a config only scores by being right AND on time.
 */
const TARGETS = {
  'sermon10@0': [
    { at: [24, 36], kind: 'quote', want: /^Proverbs 13:23$/, said: 'there is much food in the tillage of the poor, but there is that is destroyed for want of judgment' },
    { at: [36, 46], kind: 'quote', want: /^Proverbs 24:3[01]$/, said: 'I went by the field of the slothful' },
    { at: [86, 100], kind: 'ref', want: /^Acts 6/, said: 'Acts chapter 6' },
  ],
};

(async () => {
  const pcm = pcmOf(input, startSec, durSec);
  const key = path.basename(input, path.extname(input)) + '@' + startSec;
  const targets = TARGETS[key] || [];

  let vf = null; const indexes = [];
  try {
    vf = require('../src/main/versefind');
    const bible = require('../src/main/bible');
    bible.init(path.join(os.homedir(), 'AppData', 'Roaming', 'Church Work Space'));
    const abbrs = vf.chooseTranslations(null, bible.installed().map((t) => t.abbr));
    for (const a of abbrs) { const ix = await vf.indexFor(a, bible.load); if (ix) indexes.push(ix); }
  } catch (e) { console.log('no quote matching: ' + e.message); }

  // Fixed windows, so every configuration sees exactly the same audio and the
  // comparison is about the model rather than about the segmentation.
  const winN = Math.round(WIN * RATE), hopN = Math.round(HOP * RATE);
  const windows = [];
  for (let end = winN; end <= pcm.length; end += hopN) windows.push({ from: end - winN, to: end });
  console.log('\n' + path.basename(input) + ' ' + startSec + 's +' + durSec + 's — '
    + windows.length + ' windows of ' + WIN + 's every ' + HOP + 's, ' + indexes.length + ' translation(s) indexed');

  const configs = [
    { name: 'base.en  resident', model: 'base.en', fast: true },
    { name: 'small.en resident', model: 'small.en', fast: true },
  ].filter((c) => voicelisten.available(c.model));

  for (const cfg of configs) {
    whisperfast.stop && whisperfast.stop();
    const times = [];
    const hits = new Map();          // target index -> what it found, first time
    const wrong = [];                // everything else it would have put on the wall
    let loops = 0;
    for (const w of windows) {
      const seg = pcm.subarray(w.from, w.to);
      const t0 = Date.now();
      const r = await voicelisten.hear({ pcm16: seg, modelId: cfg.model, fast: cfg.fast });
      times.push(Date.now() - t0);
      const text = (r.text || '');
      // whisper repeating itself is a distinctive failure and worth counting
      const words = text.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length > 12 && new Set(words).size < words.length * 0.45) loops++;
      const endAt = w.to / RATE;
      let found = null, kind = null;
      if (r.intent && r.intent.kind === 'ref') { found = r.intent.book + ' ' + r.intent.chapter; kind = 'ref'; }
      else if (!r.intent && indexes.length && text) {
        let q = null; try { q = vf.findAcross(indexes, text); } catch (e) {}
        if (q && q.ok) { found = q.ref; kind = 'quote'; }
      }
      if (!found) continue;
      let claimed = false;
      targets.forEach((tg, i) => {
        if (endAt < tg.at[0] || endAt > tg.at[1] + WIN) return;
        if (tg.kind === kind && tg.want.test(found)) { claimed = true; if (!hits.has(i)) hits.set(i, { found, at: endAt }); }
      });
      // Anything else it decided to put on the wall. Running thirty times a
      // minute instead of once a phrase multiplies the chances of a wrong one,
      // and a wrong verse mid-sermon is the failure this feature cannot afford.
      if (!claimed) wrong.push({ at: endAt, kind, found, text: text.slice(0, 90) });
    }
    const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)];
    console.log('\n  ' + cfg.name.padEnd(20)
      + ' median ' + String(q(times, 0.5)).padStart(5) + 'ms   p90 ' + String(q(times, 0.9)).padStart(5) + 'ms'
      + '   repeats ' + loops + '/' + windows.length
      + '   found ' + hits.size + '/' + targets.length + '   WRONG ' + wrong.length);
    targets.forEach((tg, i) => {
      const h = hits.get(i);
      console.log('      ' + (h ? 'HIT  ' : 'MISS ') + tg.kind.padEnd(6) + '"' + tg.said.slice(0, 52) + '"'
        + (h ? '  -> ' + h.found + ' at ' + h.at.toFixed(0) + 's' : ''));
    });
    const seen = new Set();
    for (const w of wrong) {
      const k = w.kind + w.found;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log('      WRONG ' + w.kind.padEnd(6) + w.found.padEnd(18) + 'at ' + w.at.toFixed(0) + 's  "' + w.text + '"');
    }
  }
  console.log('');
  process.exit(0);
})().catch((e) => { console.log('FAILED: ' + ((e && e.stack) || e)); process.exit(1); });
