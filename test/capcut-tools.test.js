'use strict';
/*
 * CAPCUT'S ADJUST AND VIDEO QUALITY TOOLS, ON THE PHONE — and the preview is
 * the export. Brilliance, Clarity, HSL, Curves, Colour wheel, Highlights,
 * Shadows, Whites, Blacks, Temp, Hue, Fade, Vignette, Grain; Enhance quality,
 * Reduce image noise, Remove flickers, Optical flow.
 *
 *   [A] the tools are there (the Adjust row, the Quality tab, the editors);
 *   [B] PREVIEW = EXPORT: the frame on screen (the grade layer, with the
 *       browser's grade over it) against the same frame through the export's
 *       own ffmpeg recipe (video.js fxVideo), block by block;
 *   [C] each editor sets what it says (HSL, a curve dragged, a wheel dragged,
 *       the Quality switches), and each is ONE undo step.
 *
 *   node test/capcut-tools.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { ({ chromium, devices } = require('/opt/node-tools/node_modules/playwright')); }
const ffmpeg = require('ffmpeg-static');
const video = require('../src/main/video');

const ROOT = path.join(__dirname, '..');
const PORT = 7433;
const CODE = 'capcut-test-6610';
const WORK = path.join(os.tmpdir(), 'mw-capcut-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(data);
  });
}
async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; }
    catch (e) { await sleep(250); }
  }
  return false;
}
const W = 640, H = 360, B = 16;   // compared in 16×16 blocks (grain is noise: its blocks keep their mean)
/** Block means of an RGBA or RGB picture. */
function blocks(px, ch) {
  const bw = W / B, bh = H / B, out = new Float64Array(bw * bh * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * ch, o = (Math.floor(y / B) * bw + Math.floor(x / B)) * 3;
    out[o] += px[i]; out[o + 1] += px[i + 1]; out[o + 2] += px[i + 2];
  }
  return out.map((v) => v / (B * B));
}
const meanAbs = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const worst = (a, b) => { const d = []; for (let i = 0; i < a.length; i++) d.push(Math.abs(a[i] - b[i])); d.sort((x, y) => x - y); return d[Math.floor(d.length * 0.98)]; };

(async () => {
  // a still, colourful picture (every frame the same: the two decoders see the very same picture)
  const PNG = path.join(WORK, 'still.png'), VID = path.join(MEDIA, 'still.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=1:d=1`, '-frames:v', '1', PNG]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-loop', '1', '-i', PNG, '-f', 'lavfi', '-i', 'sine=f=220:d=12', '-t', '12', '-r', '15',
    '-c:v', 'libvpx-vp9', '-crf', '12', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-shortest', VID]);
  const exportFrame = (fx) => {
    const vf = video.fxVideo(fx);
    return execFileSync(ffmpeg, ['-v', 'error', '-ss', '3', '-i', VID, '-frames:v', '1', '-vf', (vf ? vf + ',' : '') + 'format=rgb24', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 64 << 20 });
  };

  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  let browser;
  try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }); }
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(1200);
    await page.evaluate(() => { const p = document.getElementById('vePlayer'); p.pause(); p.currentTime = 3; });
    await sleep(800);
    const T = (fn, ...a) => page.evaluate(([fn, a]) => window.VideoEditor.__test[fn](...a), [fn, a]);
    const fxNow = () => page.evaluate(() => { const T = window.VideoEditor.__test; const id = T.fxClipIds()[0]; return T.clipFxOf(id); });

    console.log('\n=== [A] the tools are there ===');
    await T('openFx', 'adjust');
    await sleep(300);
    const adj = await page.evaluate(() => [...document.querySelectorAll('#fxModal [data-adj]')].map((b) => b.querySelector('span').textContent));
    const want = ['Brightness', 'Contrast', 'Saturation', 'Sharpen', 'Brilliance', 'Clarity', 'HSL', 'Curves', 'Colour wheel', 'Highlights', 'Shadows', 'Whites', 'Blacks', 'Temp', 'Hue', 'Fade', 'Vignette', 'Grain'];
    check(want.every((x) => adj.includes(x)), 'the Adjust row has every CapCut tool', adj);
    const qrows = await page.evaluate(() => [...document.querySelectorAll('#fxModal [data-fxpane="quality"] .fxq-qtx b')].map((b) => b.textContent));
    check(['Enhance quality', 'Reduce image noise', 'Auto adjust', 'Remove flickers', 'Optical flow', 'Stabilize'].every((x) => qrows.includes(x)), 'the Quality tab has CapCut\'s Video quality tools', qrows);
    for (const [btn, ed] of [['fxHsl', 'fxHsl'], ['fxCurves', 'fxCurves'], ['fxWheels', 'fxWheels'], ['fxClar', 'fxClar']]) {
      await page.click(`#fxModal [data-adj="${btn}"]`);
      const shown = await page.evaluate((ed) => [...document.querySelectorAll('#fxModal [data-fxpane="adjust"] > [data-for]')].filter((x) => !x.classList.contains('hidden')).map((x) => x.dataset.for), ed);
      check(shown.length === 1 && shown[0] === ed, `tapping ${btn.slice(2)} shows its own editor, and only it`, shown);
    }
    const sliderSeen = await page.evaluate(() => { const r = document.getElementById('fxClar').getBoundingClientRect(); return r.width > 100 && r.height > 10; });
    check(sliderSeen, 'the Clarity slider is on screen, full width');

    console.log('\n=== [B] the preview is the export, frame for frame ===');
    // what is on screen: the grade layer (if up) with the browser's grade over it, else the player with its grade
    const shot = () => page.evaluate(() => {
      const p = document.getElementById('vePlayer'), cv = document.getElementById('veSharpCv');
      const on = !!(cv && cv.classList.contains('on'));
      const src = on ? cv : p;
      const c = document.createElement('canvas'); c.width = 640; c.height = 360;
      const g = c.getContext('2d');
      g.filter = (src.style.filter || 'none');
      g.drawImage(src, 0, 0, 640, 360);
      return { on, filter: src.style.filter, px: Array.from(g.getImageData(0, 0, 640, 360).data) };
    });
    const reset = async () => { await page.evaluate(() => { const b = document.getElementById('fxReset'); if (!b.disabled) b.click(); }); await sleep(500); };
    const setFx = async (fx) => {
      await reset();
      for (const [k, v] of Object.entries(fx)) await T('setClipFx', k, v);
      await sleep(900);
    };
    await reset();
    const base = await shot();
    const exp0 = blocks(exportFrame({}), 3), pre0 = blocks(base.px, 4);
    const baseDiff = meanAbs(exp0, pre0);
    check(baseDiff < 3, 'untouched: the screen and the file agree (the two decoders)', baseDiff.toFixed(2));
    const CASES = [
      ['the colour tools (Temp, Hue, Brilliance, Highlights, Shadows, Whites, Blacks, Fade)', { temp: 0.6, hue: 0.15, bril: 0.4, hi: -0.4, sh: 0.5, wh: 0.3, bl: -0.3, fade: 0.25 }],
      ['HSL, Curves and the Colour wheels', { hsl: { red: [0.3, 0.6, 0.2], blue: [-0.3, 0.5, -0.3], green: [0, -0.8, 0] }, curves: { m: [[0, 0], [0.3, 0.2], [0.7, 0.82], [1, 1]], b: [[0, 0.08], [1, 0.9]] }, wheels: { lift: [0.3, -0.2, 0.1], gain: [-0.25, 0.3, 0] } }],
      ['Clarity, Sharpen and Vignette', { clar: 0.8, sharp: 1.2, vig: 0.7 }],
      ['less Clarity (softer)', { clar: -0.8 }],
      ['Grain', { grain: 0.7 }],
      ['everything with Brightness, Contrast, Saturation, a filter and Enhance quality', { bri: 0.1, con: 1.25, sat: 1.3, look: 'warm', temp: -0.4, clar: 0.3, vig: 0.4, enh: 1, hsl: { yellow: [0.2, 0.4, 0] } }],
      ['Reduce image noise (Strong)', { dn: 0.9 }],
    ];
    for (const [name, fx] of (process.env.CASES ? JSON.parse(process.env.CASES) : CASES)) {
      await setFx(fx);
      const s = await shot();
      const pre = blocks(s.px, 4), exp = blocks(exportFrame(fx), 3);
      const d = meanAbs(pre, exp), w98 = worst(pre, exp), moved = meanAbs(exp, exp0);
      const needsLayer = !(Object.keys(fx).every((k) => ['bri', 'con', 'sat', 'look'].includes(k)));
      check(s.on === needsLayer && d < baseDiff + 2.5 && w98 < 10 && (moved > 2 || name.startsWith('Grain') || name.startsWith('Reduce')),
        `${name}: the preview matches the export`, `layer ${s.on}, mean diff ${d.toFixed(2)} (98% of blocks within ${w98.toFixed(1)}), the tools moved the picture by ${moved.toFixed(1)}`);
    }
    // grain is noise: the same amount of it on both (its spread, against the untouched picture)
    {
      // (measured against a frame the grade layer drew too, with next to nothing to do: the layer and the
      //  plain player upsample colour differently at sharp edges, which is not grain)
      const NIL = { temp: 0.005 };
      await setFx(NIL);
      const nil = await shot();
      await setFx({ grain: 0.7 });
      const s = await shot();
      // (grain is noise in brightness only: its spread in brightness)
      const Y = (p, i, c) => 0.299 * p[i * c] + 0.587 * p[i * c + 1] + 0.114 * p[i * c + 2];
      const spread = (a, ca, b0, cb) => { let m = 0, m2 = 0, n = 0; for (let i = 0; i < W * H; i++) { const d = Y(a, i, ca) - Y(b0, i, cb); m += d; m2 += d * d; n++; } m /= n; return Math.sqrt(m2 / n - m * m); };
      const e0 = exportFrame({}), gp = spread(s.px, 4, nil.px, 4), ge = spread(exportFrame({ grain: 0.7 }), 3, e0, 3);
      check(gp > 2.5 && Math.abs(gp - ge) < ge * 0.15, 'Grain: as much of it on screen as in the file', `on screen ±${gp.toFixed(2)}, in the file ±${ge.toFixed(2)}`);
    }
    await reset();
    check(!(await shot()).on, 'Reset: the grade layer goes, the plain picture is back');

    console.log('\n=== [C] the editors, and one undo step each ===');
    const canUndo = () => page.evaluate(() => !document.getElementById('veUndo').disabled);
    const undo = async () => { await page.evaluate(() => { const b = document.getElementById('veUndo'); b.click(); }); await sleep(700); };
    await sleep(1200);
    // HSL: pick blue, raise its saturation
    await page.click('#fxModal [data-fxtab="adjust"]');
    await page.click('#fxModal [data-adj="fxHsl"]');
    await page.click('#fxHslBands [data-band="blue"]');
    await page.evaluate(() => { const el = document.getElementById('fxHslS'); el.value = '0.6'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(1200);
    let f = await fxNow();
    check(f && f.hsl && f.hsl.blue && f.hsl.blue[1] === 0.6 && !f.hsl.red, 'HSL: blue\'s saturation, and only blue', f && f.hsl);
    await page.click('#fxHslBands [data-band="red"]');
    await page.evaluate(() => { const el = document.getElementById('fxHslH'); el.value = '-0.4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(1200);
    f = await fxNow();
    check(f.hsl.red && f.hsl.red[0] === -0.4 && f.hsl.blue[1] === 0.6, 'HSL: a second colour keeps the first', f.hsl);
    await undo();
    f = await fxNow();
    check(f && f.hsl && !f.hsl.red && f.hsl.blue, 'undo takes back the red only', f && f.hsl);
    await undo();
    f = await fxNow();
    check(!f || !f.hsl, 'undo again: no HSL left', f);

    // Curves: drag the middle of the line up
    await page.click('#fxModal [data-adj="fxCurves"]');
    await sleep(200);
    const box = await page.evaluate(() => { const r = document.getElementById('fxCurveCv').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const P = (x, y) => ({ x: box.x + 10 + x * (box.w - 20), y: box.y + 10 + (1 - y) * (box.h - 20) });
    const drag = async (from, to, steps = 6) => {
      await page.evaluate(([a, b, steps]) => {
        const cv = document.getElementById('fxCurveCv');
        const ev = (type, p) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: p.x, clientY: p.y, pointerId: 7, isPrimary: true }));
        ev('pointerdown', a);
        for (let i = 1; i <= steps; i++) ev('pointermove', { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps });
        ev('pointerup', b);
      }, [from, to, steps]);
      await sleep(700);
    };
    await drag(P(0.5, 0.5), P(0.5, 0.7));
    f = await fxNow();
    const mid = f && f.curves && f.curves.m && f.curves.m.find((p) => Math.abs(p[0] - 0.5) < 0.03);
    check(!!mid && Math.abs(mid[1] - 0.7) < 0.03, 'Curves: a point dragged up from the middle of the line', f && f.curves);
    await page.click('#fxCurveCh [data-curve="r"]');
    await drag(P(1, 1), P(1, 0.8));
    f = await fxNow();
    check(f.curves.r && f.curves.r[f.curves.r.length - 1][1] < 0.85 && f.curves.m, 'Curves: the red curve\'s end pulled down, the RGB curve kept', f.curves);
    // double-tap the middle point of RGB: it goes
    await page.click('#fxCurveCh [data-curve="m"]');
    await page.evaluate((p) => {
      const cv = document.getElementById('fxCurveCv');
      for (let k = 0; k < 2; k++) {
        cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: p.x, clientY: p.y, pointerId: 8 }));
        cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: p.x, clientY: p.y, pointerId: 8 }));
      }
    }, P(0.5, 0.7));
    await sleep(700);
    f = await fxNow();
    check(f && !f.curves.m && f.curves.r, 'Curves: double-tapping a point takes it away (a straight line is no curve)', f && f.curves);
    await undo();
    f = await fxNow();
    check(f && f.curves.m && f.curves.r, 'undo puts the point back', f && f.curves);
    await undo();
    f = await fxNow();
    check(f && f.curves.m && !f.curves.r, 'undo again: the red curve, in one step (however long the drag)', f && f.curves);
    await undo();
    f = await fxNow();
    check(!f || !f.curves, 'undo again: no curve left', f);

    // a tap that only picks a point is not a change
    await drag(P(0, 0), P(0, 0), 1);
    check(!(await fxNow()), 'tapping the line\'s end without moving it changes nothing');

    // Wheels: drag the Highlights wheel's dot towards red
    await page.click('#fxModal [data-adj="fxWheels"]');
    await sleep(200);
    const wb = await page.evaluate(() => { const r = document.querySelector('#fxWheels [data-wheel="gain"] .fxq-wheel-ring').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await page.evaluate((wb) => {
      const ring = document.querySelector('#fxWheels [data-wheel="gain"] .fxq-wheel-ring');
      const ev = (type, x, y) => ring.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 9 }));
      const cx = wb.x + wb.w / 2, cy = wb.y + wb.h / 2;
      ev('pointerdown', cx, cy);
      for (let i = 1; i <= 8; i++) ev('pointermove', cx + (wb.w * 0.3) * i / 8, cy);
      ev('pointerup', cx + wb.w * 0.3, cy);
    }, wb);
    await sleep(700);
    f = await fxNow();
    check(f && f.wheels && f.wheels.gain && Math.abs(f.wheels.gain[0] - 0.6) < 0.05 && Math.abs(f.wheels.gain[1]) < 0.05, 'Colour wheel: the Highlights dot dragged towards red', f && f.wheels);
    const puck = await page.evaluate(() => document.querySelector('#fxWheels [data-wheel="gain"] .fxq-puck').style.left);
    check(parseFloat(puck) > 75, 'the dot sits where it was dragged', puck);
    await page.evaluate(() => { const el = document.getElementById('fxWheelL'); el.value = '0.3'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(700);
    f = await fxNow();
    check(f.wheels.gain[2] === 0.3 && /Highlights/.test(await page.evaluate(() => document.getElementById('fxWheelLName').textContent)), 'its brightness slider is the Highlights wheel\'s', f.wheels);
    for (let i = 0; i < 2; i++) await undo();
    f = await fxNow();
    check(!f || !f.wheels, 'two undos: the wheel is back in the middle', f);

    // Quality
    await page.click('#fxModal [data-fxtab="quality"]');
    await sleep(200);
    await page.click('#fxModal [data-fxpane="quality"] label.fxq-switch:has(#fxEnh)');
    await sleep(700);
    await page.click('#fxDnChips [data-dn="0.9"]');
    await sleep(1100);
    await page.click('#fxModal [data-fxpane="quality"] label.fxq-switch:has(#fxFlick)');
    await sleep(700);
    f = await fxNow();
    check(f && f.enh === 1 && f.dn === 0.9 && f.flick === 1, 'Enhance quality, Reduce noise (Strong) and Remove flickers are kept on the clip', f);
    check(await page.evaluate(() => document.querySelector('#fxDnChips [data-dn="0.9"]').classList.contains('on')), '"Strong" is lit');
    check((await shot()).on, 'and the preview draws them');
    const vf = video.fxVideo(f);
    check(/deflicker/.test(vf) && /hqdn3d/.test(vf) && /gblur/.test(vf) && /convolution/.test(vf), 'the export recipe has them: flicker removal, noise removal, and Enhance\'s detail', vf.slice(0, 160));
    await page.click('#fxModal [data-fxpane="quality"] label.fxq-switch:has(#fxFlow)');
    check(await page.evaluate(() => document.getElementById('fxFlow').checked), 'Optical flow switches on (for a slowed copy)');
    await undo();
    check(!(await page.evaluate(() => document.getElementById('fxFlow').checked)), 'undo switches Optical flow back off');
    for (let i = 0; i < 6 && await canUndo(); i++) await undo();
    f = await fxNow();
    check(!f, 'undo all the way: the clip is untouched again', f);
  } catch (e) {
    check(false, 'the test ran to the end', e.message);
  } finally {
    await done();
    console.log(`\n${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
  }
})();
