'use strict';
/*
 * CapCut's moving words, measured.
 *
 *  1. Animated caption looks: the five ways the spoken word is picked out
 *     (colour, karaoke, word by word, box, pop) drawn by CapLayout — the code
 *     both the preview and the export rasteriser use — and the subtitle
 *     fallback's version of the same five.
 *  2. Text that arrives (fade / rise / pop / zoom): real exports, sampled
 *     pixel by pixel at moments through the arrival, against the same numbers
 *     the preview draws from. And the preview's copy of those numbers is
 *     checked against the export's, so the two cannot drift apart.
 *
 *   node test/text-anim.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const captioner = require('../src/main/captioner');

const ctx = { ffmpeg, ffprobe };
const WORK = path.join(os.tmpdir(), 'mw-text-anim');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
let failed = false;
const log = (ok, name, detail) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
};

/* ------------------------------------------------------------ CapLayout */
function loadCapLayout() {
  const sandbox = { window: {}, document: { createElement: () => ({ getContext: () => ({ measureText: (s) => ({ width: String(s).length * 50 }) }) }) } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'caplayout.js'), 'utf8'), sandbox);
  return sandbox.window.CapLayout;
}
const spans = (html) => [...html.matchAll(/<span style="([^"]*)">([^<]*)<\/span>/g)].map((m) => ({ css: m[1], text: m[2] }));

function captionModes() {
  console.log('ANIMATED CAPTION LOOKS (CapLayout)');
  const CL = loadCapLayout();
  const base = { style: 'outline', color: '#ffffff', outline: '#000000', wordHighlight: true, wordColor: '#8b5cf6', wordInk: '#ffffff', wordGap: 0.12 };
  const L = (mode) => ({ m: CL.metricsAt(Object.assign({}, base, { wordMode: mode }), 40, 1000), cfg: Object.assign({}, base, { wordMode: mode }) });
  const line = 'GOD IS GOOD';
  const has = (s, c) => s.css.includes('color:' + c);

  let w = spans(CL.lineHtml(L('color'), line, 0, 1));
  log(w.length === 3 && !has(w[0], '#8b5cf6') && has(w[1], '#8b5cf6') && !has(w[2], '#8b5cf6'), 'colour: only the word being said changes colour');

  w = spans(CL.lineHtml(L('karaoke'), line, 0, 1));
  log(has(w[0], '#8b5cf6') && has(w[1], '#8b5cf6') && !has(w[2], '#8b5cf6'), 'karaoke: every word already said stays lit');

  w = spans(CL.lineHtml(L('reveal'), line, 0, 1));
  log(!/visibility:hidden/.test(w[0].css) && !/visibility:hidden/.test(w[1].css) && /visibility:hidden/.test(w[2].css),
    'word by word: the word not yet said is hidden (and still takes its place)');
  w = spans(CL.lineHtml(L('reveal'), line, 0, -1));
  log(w.length === 3 && w.every((x) => /visibility:hidden/.test(x.css)), 'word by word: before the first word nothing shows');

  w = spans(CL.lineHtml(L('box'), line, 0, 1));
  const px = (css, prop) => { const m = css.match(new RegExp('(?:^|;)' + prop + ':(-?[\\d.]+)px')); return m ? Number(m[1]) : 0; };
  const pad = (() => { const m = w[1].css.match(/padding:0 (-?[\d.]+)px/); return m ? Number(m[1]) : NaN; })();
  const takes = px(w[1].css, 'margin-left') + px(w[1].css, 'margin-right') + 2 * pad;
  const gap = 0.12 * 40;
  log(/background:#8b5cf6/.test(w[1].css) && has(w[1], '#ffffff') && !/background/.test(w[0].css),
    'box: the word being said sits on the coloured block, in the ink colour');
  log(Math.abs(takes - gap) < 0.01, 'box: the block costs no room — no word of the line moves', `net ${takes.toFixed(2)}px = gap ${gap.toFixed(2)}px`);

  w = spans(CL.lineHtml(L('pop'), line, 0, 1));
  log(/transform:scale\(1\.18\)/.test(w[1].css) && !/transform/.test(w[0].css) && !/transform/.test(w[2].css), 'pop: the word being said grows, in place');

  // In a boxed look the band stays on the line, the colour on the word.
  const boxedCfg = Object.assign({}, base, { style: 'box', wordMode: 'karaoke', wordColor: '#ffd54a' });
  const bhtml = CL.lineHtml({ m: CL.metricsAt(boxedCfg, 40, 1000), cfg: boxedCfg }, line, 0, 0);
  log(/^<span style="[^"]*background:#000000/.test(bhtml) && (bhtml.match(/background:/g) || []).length === 1,
    'a banded look keeps ONE band per line under the lit words');

  log(CL.wordModeOf({ wordMode: 'nonsense' }) === 'color', 'an unknown mode falls back to colour');
}

/* ----------------------------------------------- the subtitle fallback */
function assModes() {
  console.log('\nTHE SUBTITLE FALLBACK, SAME LOOKS');
  const ev = [{ start: 1, end: 2.5, text: 'GOD IS GOOD', words: [
    { text: 'GOD', start: 1, end: 1.4 }, { text: 'IS', start: 1.5, end: 1.8 }, { text: 'GOOD', start: 1.9, end: 2.5 }] }];
  const lines = (mode) => {
    const out = path.join(WORK, `hl-${mode}.ass`);
    captioner.writeAss(ev, { width: 1080, height: 1920, output: out,
      opts: { style: 'outline', color: '#ffffff', outline: '#000000', wordHighlight: true, wordColor: '#8b5cf6', wordMode: mode, transition: 'none' } });
    return fs.readFileSync(out, 'utf8').split('\n').filter((l) => l.startsWith('Dialogue'));
  };
  const lit = '\\1c&HF65C8B&';
  let d = lines('karaoke');
  log(d.length === 3 && (d[1].split(lit).length - 1) === 2 && (d[2].split(lit).length - 1) === 3, 'karaoke: word 2 lights two words, word 3 lights three');
  d = lines('reveal');
  log(d.length === 3 && (d[0].split('\\alpha&HFF&').length - 1) === 2 && (d[2].split('\\alpha&HFF&').length - 1) === 0, 'word by word: unsaid words are invisible, then none are');
  d = lines('pop');
  log(d.length === 3 && d.every((l) => l.includes('\\fscx118')), 'pop: the spoken word is drawn larger');
  d = lines('color');
  log(d.length === 3 && d.every((l) => (l.split(lit).length - 1) === 1), 'colour: exactly one word lit per moment');
}

/* --------------------------------- the preview's copy of the arrival */
function sameNumbers() {
  console.log('\nPREVIEW AND EXPORT AGREE ON THE ARRIVAL');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'veditor.js'), 'utf8');
  const grab = (re) => { const m = src.match(re); if (!m) throw new Error('missing ' + re); return m[0]; };
  const code = [
    'const clamp = (v, a, b) => Math.min(b, Math.max(a, v));',
    grab(/const TEXT_RISE = [\d.]+;/),
    grab(/function textAnimTimes\(len\) \{[\s\S]*?\n {2}\}/),
    grab(/function textAnimScale\(anim, p\) \{[\s\S]*?\n {2}\}/),
    'module.exports = { TEXT_RISE, textAnimTimes, textAnimScale };',
  ].join('\n');
  const m = { exports: {} };
  new Function('module', code)(m);
  const R = m.exports;
  let worst = 0;
  for (const a of ['fade', 'rise', 'pop', 'zoom']) for (let p = 0; p <= 1.0001; p += 0.05) worst = Math.max(worst, Math.abs(R.textAnimScale(a, p) - video.textAnimScale(a, p)));
  log(worst < 1e-9, 'the same scale at every point of every arrival', 'worst ' + worst);
  const lens = [0.4, 1, 2, 5, 30];
  log(lens.every((l) => JSON.stringify(R.textAnimTimes(l)) === JSON.stringify(video.textAnimTimes(l))) && R.TEXT_RISE === video.TEXT_RISE,
    'the same in/out timings and the same rise');
}

/* ------------------------------------------------- real exports */
const W = 540, H = 960;
const BOX = { x: 170, y: 400, w: 200, h: 100 };        // the "text" — a solid yellow block
const C = { x: BOX.x + BOX.w / 2, y: BOX.y + BOX.h / 2 };
const pixel = (file, t, x, y) => [...execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
  '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];
// how much of the yellow is showing over the blue: 0 = none, 1 = all
const yellow = (rgb) => Math.max(0, Math.min(1, ((rgb[0] + rgb[1]) / 2) / 253));

async function exports() {
  console.log('\nTEXT THAT ARRIVES, IN THE EXPORTED FILE');
  const base = path.join(WORK, 'base.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${W}x${H}:d=6:r=30`,
    '-f', 'lavfi', '-i', 'sine=f=300:d=6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base]);
  const png = path.join(WORK, 'txt.png');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=yellow:s=${W}x${H},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(X,${BOX.x},${BOX.x + BOX.w - 1})*between(Y,${BOX.y},${BOX.y + BOX.h - 1}),255,0)'`,
    '-frames:v', '1', png]);
  const S = 1, E = 4;
  const { inD, outD } = video.textAnimTimes(E - S);
  const im = (anim) => ({ path: png, start: S, end: E, anim, cx: C.x / W, cy: C.y / H });
  const out = {};
  const t0 = Date.now();
  for (const a of ['none', 'fade', 'rise', 'pop', 'zoom']) {
    out[a] = path.join(WORK, `anim-${a}.mp4`);
    await video.burnImageOverlays(ctx, { input: base, images: [im(a)], output: out[a], onProgress: () => {} });
  }
  log(true, 'five exports made', `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const dur = (f) => Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
  log(Object.values(out).every((f) => Math.abs(dur(f) - 6) < 0.1), 'every export keeps the full length (the text never cuts the video short)');

  const mid = 2.5;
  // None: on for its window, off outside it
  log(yellow(pixel(out.none, 0.5, C.x, C.y)) < 0.05 && yellow(pixel(out.none, S + 0.05, C.x, C.y)) > 0.95 && yellow(pixel(out.none, 4.5, C.x, C.y)) < 0.05,
    'no animation: on at its start, off at its end');

  // Fade: the alpha the preview draws, at the frame ffmpeg shows
  const at = S + inD / 2;
  // Seeking to t decodes the first frame AT or after t — that is the frame sampled.
  const fr = (t) => Math.ceil(t * 30 - 1e-6) / 30;
  const want = (fr(at) - S) / inD;
  const got = yellow(pixel(out.fade, at, C.x, C.y));
  log(Math.abs(got - want) < 0.06, 'fade: half-way through the arrival it is half there', `${got.toFixed(2)} vs ${want.toFixed(2)}`);
  log(yellow(pixel(out.fade, mid, C.x, C.y)) > 0.95, 'fade: fully there in the middle');
  const late = E - outD / 2;
  const wantOut = (E - fr(late)) / outD;
  const gotOut = yellow(pixel(out.fade, late, C.x, C.y));
  log(Math.abs(gotOut - wantOut) < 0.06, 'fade: leaves over its last quarter-second', `${gotOut.toFixed(2)} vs ${wantOut.toFixed(2)}`);
  log(yellow(pixel(out.fade, S - 0.2, C.x, C.y)) < 0.05 && yellow(pixel(out.fade, E + 0.2, C.x, C.y)) < 0.05, 'fade: nothing before or after its window');

  // Rise: starts below its place. Just inside the TOP edge is still empty early on.
  const early = S + 0.04;
  const dy = video.TEXT_RISE * H * Math.pow(1 - (fr(early) - S) / inD, 2);
  log(dy > 10 && yellow(pixel(out.rise, early, C.x, BOX.y + 3)) < 0.05 && yellow(pixel(out.rise, early, C.x, BOX.y + BOX.h + Math.floor(dy) - 3)) > 0.02,
    'rise: arrives from below its place', `${dy.toFixed(1)} px low`);
  const col = [...execFileSync(ffmpeg, ['-v', 'error', '-ss', String(early), '-i', out.rise, '-frames:v', '1',
    '-vf', `format=rgb24,crop=1:${H}:${C.x}:0`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];
  let top = -1;
  for (let y = 0; y < H; y++) if (yellow(col.slice(y * 3, y * 3 + 3)) > 0.02) { top = y; break; }
  log(Math.abs(top - (BOX.y + dy)) <= 2, 'rise: the export is exactly as low as the preview says', `top edge at ${top}, preview ${(BOX.y + dy).toFixed(1)}`);
  log(yellow(pixel(out.rise, mid, C.x, BOX.y + 3)) > 0.95 && yellow(pixel(out.rise, mid, C.x, BOX.y + BOX.h + 3)) < 0.05, 'rise: settles exactly where it was placed');

  // Pop: small first (a corner is empty while the middle is not), then exactly in place
  const k0 = video.textAnimScale('pop', (fr(early) - S) / inD);
  log(k0 < 0.75 && yellow(pixel(out.pop, early, BOX.x + 4, BOX.y + 4)) < 0.05 && yellow(pixel(out.pop, early, C.x, C.y)) > 0.02,
    'pop: starts small, around its own middle', `scale ${k0.toFixed(2)}`);
  log(yellow(pixel(out.pop, mid, BOX.x + 4, BOX.y + 4)) > 0.95 && yellow(pixel(out.pop, mid, BOX.x - 4, BOX.y - 4)) < 0.05, 'pop: lands at exactly its placed size');

  // Zoom: large first (outside the box is covered), then in place
  const kz = video.textAnimScale('zoom', (fr(early) - S) / inD);
  log(kz > 1.2 && yellow(pixel(out.zoom, early, BOX.x - 10, C.y)) > 0.02, 'zoom: starts larger than it lands', `scale ${kz.toFixed(2)}`);
  log(yellow(pixel(out.zoom, mid, BOX.x - 10, C.y)) < 0.05 && yellow(pixel(out.zoom, mid, C.x, C.y)) > 0.95, 'zoom: lands at exactly its placed size');

  // The captions route lays the text on in the same pass — same animation there.
  const track = { band: { x: 0, y: 0, w: W, h: 64 }, fps: 30, authorW: W, authorH: H, frames: [{ png: null, dur: 6 }] };
  const both = path.join(WORK, 'with-captions.mp4');
  await video.burnCaptionTrack(ctx, { input: base, track, output: both, images: [im('fade')], onProgress: () => {} });
  const g2 = yellow(pixel(both, at, C.x, C.y));
  log(Math.abs(g2 - want) < 0.06 && yellow(pixel(both, mid, C.x, C.y)) > 0.95, 'the same arrival when text rides along with the captions', g2.toFixed(2));

  // The subtitle fallback for text carries the arrival too.
  const ass = path.join(WORK, 'ovl.ass');
  captioner.writeOverlayAss([{ text: 'Hi', x: 0.5, y: 0.5, start: S, end: E, anim: 'rise' }, { text: 'Yo', x: 0.5, y: 0.5, start: S, end: E, anim: 'pop' }],
    { width: 1080, height: 1920, output: ass });
  const d = fs.readFileSync(ass, 'utf8').split('\n').filter((l) => l.startsWith('Dialogue'));
  log(/\\fad\(350,250\)/.test(d[0]) && /\\move\(540,1075,540,960,0,350\)/.test(d[0]) && /\\t\(0,245,\\fscx108\\fscy108\)/.test(d[1]),
    'the subtitle fallback fades, rises and pops on the same clock');
}

(async () => {
  captionModes();
  assModes();
  sameNumbers();
  await exports();
  console.log(failed ? '\n❌ text animation test failed' : '\n✅ text animation test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
