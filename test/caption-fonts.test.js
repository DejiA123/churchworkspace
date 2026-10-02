'use strict';
/*
 * EVERY CAPTION FONT MUST ACTUALLY RENDER.
 *
 * A font name in a dropdown proves nothing: libass matches on the family recorded
 * INSIDE the file, and when it cannot find that family it does not fail — it
 * quietly substitutes another face and the operator gets Arial where they picked
 * Rubik. That is exactly what happens if the registry says "Rubik" when the file
 * calls itself "Rubik ExtraBold".
 *
 * So this burns a real caption with each registered font and checks two things:
 *   1. libass never reports a font-substitution for it, and
 *   2. the rendered pixels actually DIFFER from the same words in another face
 *      (the check that would catch a silent fallback even if libass went quiet).
 *
 *   node test/caption-fonts.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const captioner = require('../src/main/captioner');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

const WORK = path.join(os.tmpdir(), 'mw-capfonts');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

/** One frame of black with "HAMBURGEFONS" drawn in `family`, as raw gray bytes. */
function renderWith(family, outPng) {
  const ass = path.join(WORK, 'x.ass');
  fs.writeFileSync(ass, [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 640', 'PlayResY: 360', 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: D,${family},64,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,10,10,10,1`, '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.00,0:00:02.00,D,,0,0,0,,HAMBURGEFONS',
  ].join('\n'), 'utf-8');

  // The font files are COPIED next to the subtitle file and referenced as
  // `fontsdir=.` — which is exactly what burnCaptions does, for a concrete
  // reason: a Windows path contains a colon, and the colon is what separates
  // options inside an ffmpeg filter, so `fontsdir=C:/...` never parses.
  const r = spawnSync(ffmpeg, ['-v', 'info', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=1',
    '-vf', `ass=${path.basename(ass)}:fontsdir=.`,
    '-frames:v', '1', '-y', outPng], { cwd: WORK, windowsHide: true, encoding: 'buffer' });
  if (!fs.existsSync(outPng)) throw new Error('ffmpeg drew nothing: ' + String(r.stderr || '').slice(-400));
  return String(r.stderr || '');
}
function pixels(png) {
  const raw = path.join(WORK, 'r.gray');
  execFileSync(ffmpeg, ['-v', 'error', '-i', png, '-vf', 'scale=160:90,format=gray', '-f', 'rawvideo', '-y', raw], { windowsHide: true });
  return fs.readFileSync(raw);
}
const diff = (a, b) => {
  const n = Math.min(a.length, b.length);
  let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
};
const inkOf = (buf) => { let s = 0; for (const v of buf) s += v; return s / buf.length; };

// Make every bundled face visible to libass in the working folder.
for (const ff of fs.readdirSync(captioner.fontsDir())) {
  if (/\.(ttf|otf)$/i.test(ff)) fs.copyFileSync(path.join(captioner.fontsDir(), ff), path.join(WORK, ff));
}

console.log('\n== CAPTION FONTS: does every one actually render? ==\n');

const list = captioner.FONT_LIST;
check('the registry is not empty', list.length > 5, list.length + ' fonts');

// Every bundled name must point at a file that is really there.
const dir = captioner.fontsDir();
const missing = list.filter((f) => f.file && !fs.existsSync(path.join(dir, f.file))).map((f) => f.name);
check('every bundled font ships with a file', missing.length === 0, missing.join(', ') || 'all present');

// A face libass could not find is the whole point of this test — render a name
// that certainly does not exist and keep its pixels as the "fallback" signature.
const bogusPng = path.join(WORK, 'bogus.png');
renderWith('ZzNotARealFontZz', bogusPng);
const fallback = pixels(bogusPng);
check('the fallback signature rendered (something was drawn)', inkOf(fallback) > 1, 'ink ' + inkOf(fallback).toFixed(1));

const shapes = [];
for (const f of list) {
  const png = path.join(WORK, f.name.replace(/\W+/g, '_') + '.png');
  const log = renderWith(f.family, png);
  const px = pixels(png);
  const substituted = /fontselect:.*(not found|Failed)|Using default font family|font.*not found/i.test(log);
  const drewSomething = inkOf(px) > 1;
  // Arial is the system face and IS the fallback on a bare machine — exclude it
  // from the "differs from fallback" rule rather than pretend otherwise.
  const mustDiffer = !!f.file;
  const d = diff(px, fallback);
  const ok = drewSomething && !substituted && (!mustDiffer || d > 1.5);
  check(`${f.name} renders`, ok,
    `${substituted ? 'libass SUBSTITUTED; ' : ''}ink ${inkOf(px).toFixed(1)}, differs from fallback by ${d.toFixed(1)}`);
  shapes.push({ name: f.name, px });
}

// …and they must differ from EACH OTHER, or several names are one face.
let clashes = 0;
for (let i = 0; i < shapes.length; i++) {
  for (let k = i + 1; k < shapes.length; k++) {
    if (diff(shapes[i].px, shapes[k].px) < 0.8) { console.log(`      (${shapes[i].name} ≈ ${shapes[k].name})`); clashes++; }
  }
}
check('no two fonts render identically', clashes === 0, clashes + ' identical pair(s)');

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (!fail) fs.rmSync(WORK, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
