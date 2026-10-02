'use strict';
/*
 * CAPTION TRANSITIONS MUST ACTUALLY MOVE.
 *
 * An ASS override tag that libass does not understand is not an error — the line
 * simply renders as if the tag were not there. So checking the generated text
 * proves nothing; the only proof is pixels. For each transition this renders the
 * SAME caption twice — once early (while it should still be animating) and once
 * late (after it has settled) — and requires the two frames to differ. 'None'
 * must show the opposite: two identical frames.
 *
 *   node test/caption-transitions.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const captioner = require('../src/main/captioner');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

const WORK = path.join(os.tmpdir(), 'mw-captrans');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
for (const f of fs.readdirSync(captioner.fontsDir())) {
  if (/\.(ttf|otf)$/i.test(f)) fs.copyFileSync(path.join(captioner.fontsDir(), f), path.join(WORK, f));
}

const LINE_START = 0.0, LINE_END = 2.0;

/** Render the caption at time `t` and return its pixels. */
function frameAt(transition, t) {
  const ass = path.join(WORK, 'c.ass');
  captioner.writeAss([{ start: LINE_START, end: LINE_END, text: 'GLORY' }], {
    width: 480, height: 854, output: ass,
    opts: { font: 'Anton', sizeKey: 'xl', color: '#ffffff', style: 'outline', outline: '#000000', position: 'center', transition },
  });
  const png = path.join(WORK, `${transition}-${String(t).replace('.', '_')}.png`);
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=480x854:d=3',
    '-vf', `ass=${path.basename(ass)}:fontsdir=.`, '-ss', String(t), '-frames:v', '1', '-y', png],
    { cwd: WORK, windowsHide: true });
  const raw = path.join(WORK, 'r.gray');
  execFileSync(ffmpeg, ['-v', 'error', '-i', png, '-vf', 'scale=200:356,format=gray', '-f', 'rawvideo', '-y', raw], { windowsHide: true });
  return fs.readFileSync(raw);
}
const diff = (a, b) => { const n = Math.min(a.length, b.length); let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]); return s / n; };
const ink = (b) => { let s = 0; for (const v of b) s += v; return s / b.length; };

console.log('\n== CAPTION TRANSITIONS: do they actually animate? ==\n');

check('every transition has a name for the picker',
  captioner.CAP_TRANSITIONS.every((t) => t.id && t.name), captioner.CAP_TRANSITIONS.map((t) => t.name).join(', '));

// A transition may never outlast the line it decorates.
const shortTag = captioner.capEnterTag('bounce', 0.12);
const times = [...String(shortTag).matchAll(/\\t\((\d+),(\d+),/g)].map((m) => Number(m[2]));
check('a transition on a very short line is shortened to fit', times.every((v) => v <= 200), shortTag);
check('"none" adds nothing at all', captioner.capEnterTag('none', 1) === '', JSON.stringify(captioner.capEnterTag('none', 1)));

// The control: with no transition the picture is the same early and late.
const noneEarly = frameAt('none', 0.06);
const noneLate = frameAt('none', 1.2);
const noneDiff = diff(noneEarly, noneLate);
check('the caption is actually on screen', ink(noneLate) > 2, 'ink ' + ink(noneLate).toFixed(1));
check('CONTROL — with "none", early and late frames are identical', noneDiff < 0.5, 'diff ' + noneDiff.toFixed(2));

for (const t of captioner.CAP_TRANSITIONS) {
  if (t.id === 'none') continue;
  const early = frameAt(t.id, 0.04);
  const late = frameAt(t.id, 1.2);
  const d = diff(early, late);
  // …and once settled it must look like the plain caption, not stay distorted.
  const settled = diff(late, noneLate);
  const ok = d > 1.0 && settled < 3.0;
  check(`${t.name} animates in, then settles`, ok,
    `moved by ${d.toFixed(1)}, settled to within ${settled.toFixed(1)} of plain`);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (!fail) fs.rmSync(WORK, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
