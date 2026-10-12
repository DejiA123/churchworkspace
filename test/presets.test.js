'use strict';
/*
 * PRESETS — ONE TAP PUTS LAST SUNDAY'S EDIT ON THIS SUNDAY'S SERMON.
 *
 * "Is it possible to have a save preset thing so whenever I edit a different
 * sermon all I need to click is one of the saved presets and it will add the
 * edits, such as the text, background audio, outro?"
 *
 *   [1] the phone's dock has Presets; on a sermon with a name banner, a second
 *       text, music, an ending and Sharpen, Save lists all of it and keeps it
 *   [2] a different, LONGER sermon: Use puts the banner on the whole of it, the
 *       other text where it was, the music, the ending and Sharpen on every
 *       clip — and on the shorts made after it
 *   [3] Use again does not stack the text; hand-typed text is left alone
 *   [4] the preset is on the studio: a reload still has it
 *   [5] deleting asks once ("Delete?"), then deletes
 *
 *   node test/presets.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require('ffmpeg-static');
const PORT = 7387, CODE = 'preset-test-3391';
const WORK = path.join(os.tmpdir(), 'mw-presets-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); ok ? pass++ : fail++; };
const post = (p, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data);
});
const up = async () => { for (let k = 0; k < 80; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; };
const vid = (file, d, colour) => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=640x360:r=15:d=${d}`, '-f', 'lavfi', '-i', `sine=f=220:d=${d}`,
  '-c:v', 'libvpx-vp9', '-b:v', '150k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', file]);

(async () => {
  const A = path.join(MEDIA, 'Sermon one.webm'), B = path.join(MEDIA, 'Sermon two.webm');
  const SONG = path.join(MEDIA, 'Worship bed.mp3'), END = path.join(MEDIA, 'Church outro.webm');
  vid(A, 40, '0x203040'); vid(B, 64, '0x402030'); vid(END, 3, '0x104010');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=330:d=20', '-c:a', 'libmp3lame', SONG]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await up())) throw new Error('server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'no page errors', e.message));
    const open = async (p) => {
      await page.evaluate((p) => window.VideoEditor.openPath(p), p);
      await page.waitForFunction((p) => { const v = document.getElementById('vePlayer'); return v && v.readyState >= 2 && window.VideoEditor.__test.textOverlayCount() === 0; }, p, { timeout: 30000 });
      await sleep(800);
    };
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await open(A);

    console.log('\n[1] save');
    const lib = await page.evaluate(async ({ SONG, END }) => {
      const m = await window.api.library.add('music', SONG); const c = await window.api.library.add('clips', END);
      const T = window.VideoEditor.__test;
      await T.libReload();
      T.useMusic(m.id); T.setMusicVolume(0.6); T.useOutro(c.id);
      T.addTextAt({ text: 'bishop david richman', caps: true, start: 0, end: 40, x: 0.5, y: 0.1, sizePct: 0.035 });
      T.addTextAt({ text: 'Part 2', start: 5, end: 10, x: 0.5, y: 0.8, sizePct: 0.05 });
      T.fxScope('all'); T.setClipFx('sharp', 1);
      T.selectText(null);
      return { music: m.id, outro: c.id };
    }, { SONG, END });
    const dockBtn = page.locator('.cloud-dock button, .cloud-dock [role=button]').filter({ hasText: 'Presets' }).first();
    check(await dockBtn.isVisible(), 'the dock has Presets');
    await dockBtn.tap(); await sleep(500);
    check(await page.locator('#vePresetModal:not(.hidden)').isVisible(), 'it opens the Presets sheet');
    check(/No presets yet/.test(await page.locator('#vePresetModal [data-pre-list]').innerText()), 'with none yet, it says how to make one');
    await page.locator('[data-pre-new]').tap(); await sleep(300);
    const what = await page.locator('[data-pre-what]').innerText();
    check(/BISHOP DAVID RICHMAN/.test(what) && /Music: Worship bed/.test(what) && /Ending: Church outro/.test(what) && /sharpen/.test(what),
      'Save lists what it will add (text in capitals, music, ending, video quality)', what.replace(/\n/g, ' | '));
    await page.locator('#vePreName').fill('Sunday sermon');
    await page.locator('[data-pre-save]').tap(); await sleep(800);
    const card = await page.locator('#vePresetModal .ve-pre-card').allInnerTexts();
    check(card.length === 1 && /Sunday sermon/.test(card[0]), 'it is saved, and listed', card);
    await page.locator('[data-pre-close]').first().tap(); await sleep(300);
    await page.screenshot({ path: path.join(process.env.MW_SHOTS || WORK, 'preset-saved.png') }).catch(() => {});

    console.log('\n[2] a different, longer sermon');
    await page.evaluate(() => { const T = window.VideoEditor.__test; T.clearMusic(); T.clearOutro(); });
    await open(B);
    const before = await page.evaluate(() => ({ text: window.VideoEditor.__test.textOverlayCount(), music: window.VideoEditor.__test.musicState() }));
    check(before.text === 0 && !before.music, 'it starts bare: no text, no music', before);
    await page.evaluate(() => window.VideoEditor.__test.addTextAt({ text: 'typed by hand', start: 20, end: 25 }));
    await page.evaluate(() => window.VideoEditor.__test.selectText(null));
    await dockBtn.tap(); await sleep(800);
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'presets-sheet.png') });
    await page.locator('[data-pre-use]').first().tap(); await sleep(1500);
    const st = await page.evaluate(() => {
      const T = window.VideoEditor.__test;
      const txt = T.textOverlays().map((o) => ({ text: o.text, start: +o.start.toFixed(2), end: +o.end.toFixed(2), caps: T.textStyleOf(o.id).caps }));
      return { txt, music: T.musicState(), outro: T.outroState(), fx: T.clipFx(), shown: !document.querySelector('#vePresetModal:not(.hidden)'),
        toast: [...document.querySelectorAll('.toast, .mw-island, #cloudIsland, [class*="island"]')].map((n) => n.innerText).join(' ') };
    });
    const banner = st.txt.find((o) => /bishop/.test(o.text));
    check(banner && banner.start === 0 && Math.abs(banner.end - 64) < 0.1 && banner.caps, 'the name banner runs the whole of the new, longer sermon, still ALL CAPS', banner);
    const part = st.txt.find((o) => o.text === 'Part 2');
    check(part && part.start === 5 && part.end === 10, 'the other text is where it was', part);
    check(st.txt.some((o) => o.text === 'typed by hand'), 'text typed by hand on this sermon is kept');
    check(st.music && st.music.id === lib.music && Math.abs(st.music.volume - 0.6) < 0.01, 'the music is on, at the volume it was saved at', st.music && { id: st.music.id, volume: st.music.volume });
    check(st.outro && st.outro.id === lib.outro, 'the ending is on', st.outro);
    check(st.fx.length && st.fx.every((f) => f && f.sharp === 1), 'Sharpen is on every clip', st.fx);
    check(/Sunday sermon/.test(st.toast) && /text/.test(st.toast) && /music/.test(st.toast) && /ending/.test(st.toast), 'it says what it put on', st.toast.slice(0, 200));
    const short = await page.evaluate(() => {
      const T = window.VideoEditor.__test;
      T.applyClipsAppend([{ start: 30, end: 50, label: 'New short' }]);
      const s = T.segments().find((x) => Math.abs(x.start - 30) < 0.01 && Math.abs(x.end - 50) < 0.01);
      return T.clipFxOf(s.id);
    });
    check(short && short.sharp === 1, 'a short made after it has Sharpen too', short);

    console.log('\n[3] again');
    await dockBtn.tap(); await sleep(800);
    await page.locator('[data-pre-use]').first().tap(); await sleep(1200);
    const again = await page.evaluate(() => window.VideoEditor.__test.textOverlays().map((o) => o.text));
    check(again.length === 3, 'using it again does not stack the text', again);

    console.log('\n[4] kept on the studio');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.api && window.api.presets, null, { timeout: 30000 });
    const kept = await page.evaluate(() => window.api.presets.list());
    check(kept.length === 1 && kept[0].name === 'Sunday sermon', 'after a reload the preset is still there', kept.map((p) => p.name));

    console.log('\n[5] delete');
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await open(A);
    await dockBtn.tap(); await sleep(800);
    const del = page.locator('[data-pre-del]').first();
    await del.tap(); await sleep(200);
    check(/Delete\?/.test(await del.innerText()), 'the first tap asks "Delete?"');
    check((await page.evaluate(() => window.api.presets.list())).length === 1, '…and has not deleted yet');
    await del.tap(); await sleep(800);
    check((await page.evaluate(() => window.api.presets.list())).length === 0, 'the second tap deletes it');
  } catch (e) {
    check(false, 'ran to the end', e.message);
  } finally {
    await browser.close().catch(() => {});
    srv.kill(); await sleep(600);
    try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {}
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
