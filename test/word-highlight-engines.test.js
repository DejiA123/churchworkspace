'use strict';
/*
 * BOTH CAPTION ENGINES MUST LIGHT UP THE SAME WORD, IN THE SAME PLACE.
 *
 * The studio draws captions twice. The preview and the export rasteriser use
 * CapLayout (Chromium, CSS); the subtitle burner uses libass from an .ass file,
 * and takes over whenever the track would be too long to draw. They are supposed
 * to be one look drawn by two hands — which is a claim that can quietly stop
 * being true, and did before (see the WYSIWYG note in veditor.js).
 *
 * Highlight mode gives them a new way to disagree, because the two express it
 * completely differently: CSS colours one <span> of several; the .ass writes the
 * whole line once per word with an override tag on a different one each time. An
 * off-by-one in either, a word-boundary rule that rounds the other way, or a
 * word gap applied on one side only, and the file stops matching the studio.
 *
 * So: render the same caption at the same instants through BOTH, and require the
 * lit word to land in the same columns.
 *
 *   npx electron test/word-highlight-engines.test.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ffmpegBin = require('ffmpeg-static');
const captioner = require('../src/main/captioner');

const W = 576, H = 1024;
const DIR = path.join(os.tmpdir(), 'mw-hl-engines');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync(captioner.fontsDir())) {
  if (/\.(ttf|otf)$/i.test(f)) fs.copyFileSync(path.join(captioner.fontsDir(), f), path.join(DIR, f));
}

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (c) pass++; else fail++; };

const EVENT = {
  start: 1.0, end: 2.8, text: 'BRINGING HIS SEEDS',
  words: [
    { text: 'BRINGING', start: 1.0, end: 1.5 },
    { text: 'HIS', start: 1.6, end: 1.9 },
    { text: 'SEEDS', start: 2.1, end: 2.8 },
  ],
};
/* Deliberately a look with everything switched on: an outline (whose weight the
 * two engines measure from opposite sides of the glyph), padded word gaps, and
 * negative tracking — the three settings most able to make them drift apart. */
const CFG = {
  font: 'Poppins', family: 'Poppins', sizeKey: 'm', sizePct: 0.05338, style: 'outline',
  color: '#ffffff', outline: '#000000', outlineScale: 1, transition: 'none',
  position: 'bottom', posX: 0.5, posY: 0.7822, width: 1.0,
  wordHighlight: true, wordColor: '#ffff00', wordGap: 0.1, tracking: -0.044,
};
const MOMENTS = [1.2, 1.7, 2.4];   // mid-word, one per word
/* A run with the extras switched off, so the floor of the disagreement between
 * two different text rasterisers can be told apart from a bug in the extras. */
if (process.argv.includes('--plain')) { CFG.wordGap = 0; CFG.tracking = 0; }

/** Columns holding yellow (and any) caption ink, from raw RGB. */
function scan(rgb, w, h) {
  const yel = [], ink = [];
  for (let x = 0; x < w; x++) {
    let y = 0, i2 = 0;
    for (let row = 0; row < h; row++) {
      const i = (row * w + x) * 3, r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      if (r >= 200 && g >= 200) { i2++; if (b <= 120) y++; }
    }
    if (y >= 3) yel.push(x);
    if (i2 >= 3) ink.push(x);
  }
  const span = (a) => (a.length ? [a[0], a[a.length - 1]] : null);
  return { yellow: span(yel), ink: span(ink) };
}
const rgbOfPng = (p) => execFileSync(ffmpegBin, ['-v', 'error', '-i', p, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { maxBuffer: 1 << 28 });

/** libass: write the .ass the burner writes, render one frame, scan it. */
function assAt(t) {
  const ass = path.join(DIR, 'c.ass');
  captioner.writeAss([EVENT], { width: W, height: H, output: ass, opts: CFG });
  const png = path.join(DIR, 'ass-' + String(t).replace('.', '_') + '.png');
  execFileSync(ffmpegBin, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=4`,
    '-ss', String(t), '-vf', 'ass=c.ass:fontsdir=.', '-frames:v', '1', '-y', png], { cwd: DIR });
  return scan(rgbOfPng(png), W, H);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 200,
    webPreferences: { contextIsolation: false, nodeIntegration: false } });
  const page = path.join(DIR, 'p.html');
  const capLayoutSrc = path.join(__dirname, '..', 'src', 'renderer', 'caplayout.js').replace(/\\/g, '/');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><body><script src="file:///${capLayoutSrc}"></script></body>`);
  await win.loadFile(page);

  const fontCss = captioner.FONT_LIST.filter((f) => f.file)
    .map((f) => {
      const p = path.join(captioner.fontsDir(), f.file);
      if (!fs.existsSync(p)) return '';
      const src = 'url(data:font/ttf;base64,' + fs.readFileSync(p).toString('base64') + ') format("truetype")';
      return [f.family, f.name].filter((v, i, a) => v && a.indexOf(v) === i)
        .map((n) => '@font-face{font-family:"' + n + '";src:' + src + ';font-weight:100 900;font-display:block;}').join('');
    }).join('');

  console.log('THE TWO CAPTION ENGINES, ON THE SAME CAPTION');
  const cssResults = await win.webContents.executeJavaScript(`(async () => {
    const CFG = ${JSON.stringify(CFG)}, EVENT = ${JSON.stringify(EVENT)}, MOMENTS = ${JSON.stringify(MOMENTS)};
    const css = ${JSON.stringify(fontCss)};
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    /*
     * @font-face in a <style> is loaded LAZILY — document.fonts.ready resolves
     * before anything has asked for the face, so CapLayout would wrap the line
     * against Arial and break it in the wrong place. Loading each face
     * explicitly is what makes the measurement real; without it this test
     * silently compares a two-line caption with a one-line one.
     */
    for (const m of css.matchAll(/@font-face\{font-family:"([^"]+)";src:(url\([^)]*\)[^;]*);/g)) {
      try { const ff = new FontFace(m[1], m[2]); await ff.load(); document.fonts.add(ff); } catch (e) {}
    }
    await document.fonts.ready;
    window.CapLayout.forgetMeasurements();
    const words = window.CapLayout.wordTimes(EVENT);
    const L = window.CapLayout.layout(EVENT.text, CFG, ${W}, ${H});
    const out = [];
    for (const t of MOMENTS) {
      const hl = window.CapLayout.activeWord(words, t);
      const body = '<div style="position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#000;">'
        + window.CapLayout.html(EVENT.text, CFG, ${W}, ${H}, { layout: L, state: { hl } }) + '</div>';
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">'
        + '<foreignObject x="0" y="0" width="${W}" height="${H}">'
        + '<div xmlns="http://www.w3.org/1999/xhtml" style="width:${W}px;height:${H}px;margin:0;overflow:hidden;">'
        + '<style>' + css + '</style>' + body + '</div></foreignObject></svg>';
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
      const c = document.createElement('canvas'); c.width = ${W}; c.height = ${H};
      const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, ${W}, ${H}).data;
      const yel = [], ink = [];
      for (let x = 0; x < ${W}; x++) {
        let y = 0, i2 = 0;
        for (let row = 0; row < ${H}; row++) {
          const i = (row * ${W} + x) * 4, r = d[i], g = d[i+1], b = d[i+2];
          if (r >= 200 && g >= 200) { i2++; if (b <= 120) y++; }
        }
        if (y >= 3) yel.push(x);
        if (i2 >= 3) ink.push(x);
      }
      const span = (a) => (a.length ? [a[0], a[a.length-1]] : null);
      out.push({ t, hl, yellow: span(yel), ink: span(ink), lines: L.lines });
    }
    return out;
  })()`);

  const assResults = MOMENTS.map((t) => assAt(t));

  // 1. Both engines agree the SAME word is lit at each moment.
  MOMENTS.forEach((t, i) => {
    const a = assResults[i], c = cssResults[i];
    check(`t=${t}s: both engines light a word`, !!(a.yellow && c.yellow),
      `libass=${JSON.stringify(a.yellow)} css=${JSON.stringify(c.yellow)}`);
  });

  // 2. …and in the same columns. The two rasterisers hint and antialias
  //    differently, so the tolerance is a few pixels of a 576-wide frame, not
  //    zero — but a wrong WORD is tens of pixels out, which this catches.
  const TOL = 4;
  MOMENTS.forEach((t, i) => {
    const a = assResults[i].yellow, c = cssResults[i].yellow;
    if (!a || !c) { check(`t=${t}s: lit word in the same place`, false, 'one engine drew nothing'); return; }
    const d0 = Math.abs(a[0] - c[0]), d1 = Math.abs(a[1] - c[1]);
    check(`t=${t}s: lit word in the same place`, d0 <= TOL && d1 <= TOL,
      `libass ${a} vs css ${c} (left off by ${d0}px, right by ${d1}px)`);
  });

  // 3. The LINE is the same width in both — this is what catches a word gap or
  //    a tracking setting that only one of them honours.
  MOMENTS.forEach((t, i) => {
    const a = assResults[i].ink, c = cssResults[i].ink;
    if (!a || !c) { check(`t=${t}s: same line width`, false, 'one engine drew nothing'); return; }
    const wa = a[1] - a[0], wc = c[1] - c[0];
    check(`t=${t}s: same line width`, Math.abs(wa - wc) <= 10, `libass ${wa}px vs css ${wc}px`);
  });

  // 4. The word moves. Three moments, three different places — otherwise every
  //    check above would pass on a caption that never changed.
  const moved = (r) => r[0].yellow && r[1].yellow && r[2].yellow
    && r[0].yellow[1] < r[1].yellow[0] && r[1].yellow[1] < r[2].yellow[0];
  check('libass moves the light word by word', moved(assResults),
    assResults.map((r) => JSON.stringify(r.yellow)).join(' '));
  check('the preview engine moves it too', moved(cssResults),
    cssResults.map((r) => JSON.stringify(r.yellow)).join(' '));

  console.log(`\n${pass} passed, ${fail} failed`);
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
