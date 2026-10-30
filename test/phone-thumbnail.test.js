'use strict';
/*
 * THE YOUTUBE THUMBNAIL STUDIO on a phone (Home → Thumbnails; cloud-flyer.js,
 * Thumbnail mode; thumbmaker.js on the server). Checks:
 *   - Home has a Thumbnails tile, and it opens the studio
 *   - a video in My Uploads has a Thumbnail button that opens it with that video
 *   - the server offers the video's best moments (16:9 pictures, times on them)
 *   - the words: lines offered (from the sermon, or by rule), the first one on
 *     it already; typing your own, and tapping the word that goes in colour
 *   - "Pick a moment" scrubs the video and takes the moment chosen
 *   - the photo bank: a photo tapped opens big (Dark / Light / Checks behind
 *     the cut-out, zoom, Fix cut-out), and Use this photo takes it
 *   - Make: a board of six YouTube looks, each 1280×720, with the words on them
 *   - the editor: Layouts offers the six thumbnail looks; Save gives a
 *     1920×1080 JPEG under 2 MB; Keep puts it in My Uploads
 * The AI painter is stood in for (no network in a test). MW_THUMB_VIDEO=<file>
 * uses a real recording (a person in it: the cut-out is checked too);
 * MW_SHOTS=<dir> saves screenshots.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the thumbnail studio was not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;

const ROOT = path.join(__dirname, '..');
const PORT = 7461;
const CODE = 'thumbnail-test-5521';
const WORK = path.join(os.tmpdir(), 'mw-thumb-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const SHOTS = process.env.MW_SHOTS || '';

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
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
  for (let k = 0; k < 60; k++) {
    try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); }
  }
  return false;
}
async function until(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) { v = await page.evaluate(fn, arg); if (v && v.ok) return v; await sleep(250); }
  return v;
}

(async () => {
  const VID = path.join(MEDIA, 'Faith Over Fear (Pastor Mike).mp4');
  if (process.env.MW_THUMB_VIDEO) fs.copyFileSync(process.env.MW_THUMB_VIDEO, VID);
  else {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=40', '-f', 'lavfi', '-i', 'sine=f=220:d=40',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', VID]);
  }
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore', env: Object.assign({}, process.env, { ANTHROPIC_API_KEY: '', GROQ_API_KEY: '', CLOUDFLARE_API_TOKEN: '' }) });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, acceptDownloads: true });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.MWFlyerStudio && window.MWFlyerStudio.openThumb && document.querySelector('.ch-tool[data-home="thumbs"]'), null, { timeout: 30000 });
    // the painter stood in for: a gradient, at once (the real one is on the internet)
    await page.evaluate(() => {
      window.__painted = 0;
      // (the studio's own photographs stand in for the paintings: light, fire, a stage)
      const pics = ['concert-fire-glow.jpg', 'sky-rays-dark.jpg', 'worship-blue.jpg'];
      window.api.flyer.paint = async (a) => ({ dataUrl: '/flyerphotos/' + pics[window.__painted++ % pics.length], by: 'test painter', w: a.w, h: a.h });
    });
    // the church's own name (the flyers' kit): the thumbnails are signed with it
    // …and a preacher with a photo in the bank (the flyers' own banks: cut-out portraits)
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 600; c.height = 800;
      const x = c.getContext('2d');
      x.fillStyle = '#8d5524'; x.beginPath(); x.ellipse(300, 230, 110, 140, 0, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#1e3a8a'; x.beginPath(); x.moveTo(60, 800); x.quadraticCurveTo(80, 420, 300, 400); x.quadraticCurveTo(520, 420, 540, 800); x.fill();
      const k = await window.api.flyer.kitGet();
      await window.api.flyer.kitSave(Object.assign({}, k, { church: 'Grace Life Chapel', speakers: [{ id: 'spmike', name: 'Pastor Mike Adeyemi', photos: [] }] }));
      await window.api.flyer.kitAddPhoto('spmike', c.toDataURL('image/png'), 'Pastor Mike Adeyemi');
    });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'thumb-0-home.png') });

    // ── Home → Thumbnails
    const tile = await page.evaluate(() => { const b = document.querySelector('.ch-tool[data-home="thumbs"]'); return b && { text: b.textContent.trim(), w: b.getBoundingClientRect().width }; });
    check(!!tile && /Thumbnails/.test(tile.text) && tile.w > 60, 'Home has a Thumbnails tile', tile);
    await page.locator('.ch-tool[data-home="thumbs"]').tap();
    let s = await until(page, () => { const b = document.querySelector('.cp-thumb .th-choose'); return { ok: !!b, title: (document.querySelector('.cp-thumb') || {}).textContent || '' }; });
    check(s && s.ok, 'the tile opens the thumbnail studio, asking for a video', s && s.title.slice(0, 80));
    await page.evaluate(() => { const x = document.querySelector('.cp-thumb .cp-close, .cp-thumb [data-close], .cp-thumb .cp-x'); if (x) x.click(); });
    await sleep(500);

    // ── My Uploads → the video → Thumbnail
    await page.evaluate((p) => window.MWCloud.viewFile(p), VID);
    await page.waitForSelector('#cloudViewer [data-cv="thumb"]', { timeout: 10000 }).catch(() => {});
    const vb = await page.evaluate(() => { const b = document.querySelector('#cloudViewer [data-cv="thumb"]'); return b ? b.textContent.trim() : null; });
    check(vb === 'Thumbnail', 'a video in My Uploads has a Thumbnail button', vb);
    if (vb) await page.locator('#cloudViewer [data-cv="thumb"]').tap();
    s = await until(page, () => {
      const fr = [...document.querySelectorAll('.cp-thumb .th-fr[data-fr] img')];
      const ideas = [...document.querySelectorAll('.cp-thumb .th-idea')].map((b) => b.textContent);
      return { ok: fr.length >= 4 && fr.every((i) => i.naturalWidth > 0) && ideas.length >= 3, frames: fr.map((i) => [i.naturalWidth, i.naturalHeight]), ideas,
        vid: (document.querySelector('.cp-thumb .th-vid b') || {}).textContent, line: (document.querySelector('.cp-thumb [data-th="line"]') || {}).value,
        on: document.querySelectorAll('.cp-thumb .th-fr.on').length, times: [...document.querySelectorAll('.cp-thumb .th-fr[data-fr] small')].map((x) => x.textContent) };
    }, null, 120000);
    check(s && s.ok && s.vid === 'Faith Over Fear (Pastor Mike)', 'it opens with that video, and the server offers its best moments', s);
    check(s && s.frames.length && s.frames.every(([w, h]) => Math.abs(w / h - 16 / 9) < 0.02) && s.times.every((t) => /^\d+:\d\d$/.test(t)) && s.on === 1, 'the moments are 16:9 pictures with their time on them, the best one chosen', s && { frames: s.frames, times: s.times, on: s.on });
    check(s && s.line && s.ideas.includes(s.line) && s.ideas.some((l) => /FAITH OVER FEAR/.test(l)) && !s.ideas.some((l) => /PASTOR|MIKE/.test(l)),
      'lines to put on it are offered (the video’s own name among them, not the preacher’s), the first one already on it', s && { line: s.line, ideas: s.ideas });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'thumb-1-make.png') });

    // ── typing your own words, and the word in colour
    await page.locator('.cp-thumb [data-th="line"]').fill('God is not done with you');
    await page.locator('.cp-thumb [data-th="line"]').press('Enter');
    await sleep(300);
    let k = await page.evaluate(() => ({ keys: [...document.querySelectorAll('.cp-thumb .th-key')].map((b) => b.textContent), on: (document.querySelector('.cp-thumb .th-key.on') || {}).textContent }));
    check(k.keys.join(' ') === 'GOD IS NOT DONE WITH YOU' && !!k.on, 'typed words come up as chips, one of them in colour', k);
    await page.locator('.cp-thumb .th-key', { hasText: /^DONE$/ }).tap();
    await sleep(200);
    k = await page.evaluate(() => (document.querySelector('.cp-thumb .th-key.on') || {}).textContent);
    check(k === 'DONE', 'tapping a word makes it the word in colour', k);

    // ── Pick a moment
    await page.locator('.cp-thumb .th-fr.th-tool[data-act="scrub"]').tap();
    await page.waitForSelector('.cp-thumb .th-scrub input[type="range"]', { timeout: 5000 });
    await page.evaluate(() => { const r = document.querySelector('.cp-thumb .th-scrub input[type="range"]'); r.value = String(Math.floor(+r.max * 0.6)); r.dispatchEvent(new Event('input')); });
    s = await until(page, () => { const i = document.querySelector('.cp-thumb .th-scrub-pic img'); return { ok: !!(i && i.naturalWidth), t: (document.querySelector('.cp-thumb [data-th="scrubT"]') || {}).textContent }; }, null, 20000);
    check(s && s.ok, 'Pick a moment scrubs the video, the picture following', s);
    await page.locator('.cp-thumb [data-act="usemoment"]').tap();
    s = await until(page, () => { const on = document.querySelector('.cp-thumb .th-fr.on'); return { ok: !!(on && on.dataset.act === 'scrub' && on.querySelector('img')), t: on && on.textContent }; }, null, 20000);
    check(s && s.ok, 'Use this moment takes it (it comes first, chosen)', s);
    // back to the AI's best moment for the board
    await page.locator('.cp-thumb .th-fr[data-fr="0"]').tap();
    await sleep(200);
    // ── also on it: the preacher, a small line, the date
    await page.locator('.cp-thumb [data-th="preacher"]').fill('Pastor Mike Adeyemi');
    await page.locator('.cp-thumb [data-th="when"]').fill('Sun 19 Oct · 10AM');
    await page.locator('.cp-thumb .th-chip[data-kicker="Part 2"]').tap();
    await sleep(200);
    const ex = await page.evaluate(() => { const t = window.MWFlyerStudio._state.th; return { preacher: t.preacher, kicker: t.kicker, when: t.when, church: t.showChurch, kept: localStorage.getItem('mw-thumb-extra') }; });
    check(ex.preacher === 'Pastor Mike Adeyemi' && ex.kicker === 'Part 2' && /10AM/.test(ex.when) && ex.church && /Mike Adeyemi/.test(ex.kept || ''), 'the preacher, a small line and the date go on it (the preacher is remembered for next time)', ex);

    // ── Make
    await page.locator('.cp-thumb [data-act="tmake"]').tap();
    s = await until(page, () => {
      const cards = [...document.querySelectorAll('.cp-thumb .fs-card')];
      const st = window.MWFlyerStudio._state;
      return { ok: cards.length === 12 && !st.th.cutting && cards.every((c) => c.querySelector('canvas').width > 100), n: cards.length,
        looks: st.designs.map((d) => d.look), sizes: st.designs.map((d) => d.w + 'x' + d.h), names: cards.map((c) => c.querySelector('small').textContent),
        person: !!st.th.person, words: st.designs.map((d) => d.layers.filter((l) => l.type === 'text').map((l) => l.text).join(' ')) };
    }, null, 90000);
    check(s && s.ok && s.sizes.every((z) => z === '1280x720') && new Set(s.looks).size === 12, 'Make: a board of twelve different YouTube looks, each 1280×720', s);
    check(s && s.words.every((w) => /DONE/.test(w.toUpperCase())), 'every design has the words on it', s && s.words);
    check(s && s.words.filter((w) => /ADEYEMI/i.test(w)).length >= 10 && s.words.filter((w) => /PART 2/i.test(w)).length >= 8 && s.words.filter((w) => /10AM/i.test(w)).length >= 8,
      'the preacher’s name, the small line and the date are on the designs', s && s.words);
    check(s && s.words.filter((w) => /Grace Life Chapel/i.test(w)).length >= 10, 'the church’s name signs the designs', s && s.words);
    if (process.env.MW_THUMB_VIDEO) check(s && s.person, 'the preacher is cut out of the moment (a real recording)', s && s.person);
    s = await until(page, () => ({ ok: window.__painted >= 3 && window.MWFlyerStudio._state.th.bgs.some((b) => /^tha:/.test(b.key)), painted: window.__painted }), null, 20000);
    check(s && s.ok, 'the AI paints backgrounds for the board (three)', s);
    await sleep(800);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'thumb-2-board.png'), fullPage: false });
    if (SHOTS) {
      // each design, full size, to look at
      const urls = await page.evaluate(() => window.MWFlyerStudio._state.designs.map((d) => { const c = window.MWFlyer.render(d, document.createElement('canvas'), 1); return c.toDataURL('image/jpeg', 0.9); }));
      urls.forEach((u, i) => fs.writeFileSync(path.join(SHOTS, `thumb-design-${i + 1}.jpg`), Buffer.from(u.split(',')[1], 'base64')));
    }

    // ── the editor
    await page.locator('.cp-thumb .fs-card').first().tap();
    await page.waitForSelector('.cp-thumb #fsCanvas', { timeout: 10000 });
    const tools = await page.evaluate(() => [...document.querySelectorAll('.cp-thumb .fs-tool span')].map((x) => x.textContent));
    check(tools.includes('Words') && tools.includes('Layouts') && tools.includes('Video frame') && !tools.includes('Size'), 'the editor has the thumbnail tools (Words, Layouts, Video frame)', tools);
    await page.locator('.cp-thumb .fs-tool[data-t="looks"]').tap();
    s = await until(page, () => { const l = [...document.querySelectorAll('.cp-thumb .fs-look small')].map((x) => x.textContent); return { ok: l.length === 12, l }; }, null, 10000);
    check(s && s.ok && s.l.includes('One word') && s.l.includes('Light page') && s.l.includes('Gold serif'), 'Layouts offers the twelve thumbnail looks', s);
    await page.locator('.cp-thumb .fs-look', { hasText: 'One word' }).tap();
    await sleep(500);
    const lk = await page.evaluate(() => window.MWFlyerStudio._state.scene.look);
    check(lk === 'ytword', 'tapping one changes the design to it', lk);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'thumb-3-editor.png') });

    // ── Save: a JPEG YouTube takes
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.locator('.cp-thumb [data-ed="save"]').tap()]);
    let info = null;
    if (dl) {
      const f = path.join(WORK, 'saved.jpg'); await dl.saveAs(f);
      const pr = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', f]).toString().trim();
      info = { name: dl.suggestedFilename(), size: fs.statSync(f).size, pr };
    }
    check(info && info.pr === 'mjpeg,1920,1080' && info.size < 2 * 1048576 && info.size > 50000 && /thumbnail\.jpg$/.test(info.name), 'Save gives a 1920×1080 JPEG under 2 MB, named for its words', info);

    // ── Keep: into My Uploads
    await page.locator('.cp-thumb [data-ed="post"]').tap();
    s = await until(page, () => ({ ok: /Kept in My Uploads/.test(document.body.innerText), label: (document.querySelector('.cp-thumb [data-ed="post"]') || {}).textContent }), null, 20000);
    // (an upload goes to the person's own space)
    const kept = fs.readdirSync(WORK, { recursive: true }).filter((n) => /thumbnail\.jpg$/i.test(String(n)) && !/\.part-/.test(String(n)));
    check(s && s.ok && kept.length === 1, 'Keep puts it in My Uploads', { s, kept });

    // ── the photo bank: the preacher's own photo instead of the video's cut-out
    await page.locator('.cp-thumb [data-ed="back"]').tap();
    await sleep(300);
    await page.locator('.cp-thumb .cp-foot [data-act="back"]').tap();
    s = await until(page, () => {
      const b = [...document.querySelectorAll('.cp-thumb .th-bank [data-bank] img')];
      return { ok: b.length === 1 && b[0].naturalWidth > 0, chips: [...document.querySelectorAll('.cp-thumb [data-banksp]')].map((x) => x.textContent.trim()),
        add: !!document.querySelector('.cp-thumb [data-act="bankadd"]'), newp: !!document.querySelector('.cp-thumb [data-act="banknew"]') };
    }, null, 20000);
    check(s && s.ok && s.chips[0] && /Mike Adeyemi/.test(s.chips[0]) && s.add && s.newp, 'the Thumbnails page has the photo bank: the church’s preachers, their cut-out photos, Add photos and New preacher', s);
    // tapped, a bank photo opens BIG — the cut-out exactly as kept, to check it — and Use takes it
    const openBig = () => until(page, () => {
      const v = document.querySelector('.fs-vb'), cv = v && v.querySelector('canvas');
      if (!v || !cv || cv.width < 10 || v.classList.contains('fs-vb-wait')) return null;
      const px = (x, y) => Array.from(cv.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3));
      return { title: v.querySelector('.fs-vb-top b').textContent, w: cv.width, h: cv.height, corner: px(5, 5), face: px(300, 230),
        bgs: [...v.querySelectorAll('[data-bg]')].map((x) => x.textContent), on: (v.querySelector('[data-bg].on') || {}).textContent,
        use: !!v.querySelector('[data-vb="use"]'), fix: !!v.querySelector('[data-vb="fix"]'), chosen: !!window.MWFlyerStudio._state.th.bank };
    }, null, 15000);
    await page.locator('.cp-thumb .th-bank [data-bank]').first().tap();
    s = await openBig();
    check(s && /Mike Adeyemi/.test(s.title) && s.w === 600 && s.h === 800 && s.bgs.join() === 'Dark,Light,Checks' && s.on === 'Dark' && s.use && s.fix && !s.chosen,
      'tapping a bank photo opens it big — full size, its speaker named, Dark / Light / Checks behind it, Use and Fix cut-out (nothing chosen yet)', s);
    check(s && s.face.join() === '141,85,36' && s.corner.join() === '35,26,58', 'it is the cut-out exactly as kept, over the dark', s && { face: s.face, corner: s.corner });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'thumb-bank-big.png') });
    await page.locator('.fs-vb [data-bg="light"]').tap();
    s = await openBig();
    check(s && s.on === 'Light' && s.corner.join() === '255,255,255' && s.face.join() === '141,85,36', 'Light puts white behind the same cut-out (a leftover edge shows on one or the other)', s);
    await page.locator('.fs-vb .fs-viewer-pic').dblclick();
    await sleep(300);
    const zz = await page.evaluate(() => { const c = document.querySelector('.fs-vb canvas'); const m = /scale\(([\d.]+)\)/.exec(c.style.transform); return m ? +m[1] : 0; });
    check(zz > 1.5, 'a double tap zooms in to look at the edges', zz);
    // Fix cut-out: the cut-out tool, on this photo
    await page.locator('.fs-vb [data-vb="fix"]').tap();
    s = await until(page, () => (document.querySelector('#cutModal:not(.hidden)') && !document.querySelector('.fs-vb') ? true : null), null, 15000);
    check(!!s, 'Fix cut-out opens the cut-out tool on it (the big view steps aside)', s);
    await page.evaluate(() => document.getElementById('cutCancel').click());
    await sleep(500);
    await page.locator('.cp-thumb .th-bank [data-bank]').first().tap();
    s = await openBig();
    check(s && s.use && !s.chosen, 'closed without a new cut, the photo is as it was', s);
    await page.locator('.fs-vb [data-vb="use"]').tap();
    await sleep(300);
    s = await page.evaluate(() => ({ big: !!document.querySelector('.fs-vb'), on: !!document.querySelector('.cp-thumb .th-bank .th-bp.on'), behind: !!document.querySelector('.cp-thumb .th-fr.th-behind'), bank: !!window.MWFlyerStudio._state.th.bank }));
    check(!s.big && s.on && s.behind && s.bank, 'Use this photo chooses it (the big view closes), the video’s moment marked as going behind it', s);
    await page.locator('.cp-thumb [data-act="tmake"]').tap();
    s = await until(page, () => {
      const st = window.MWFlyerStudio._state;
      const ims = st.designs.map((d) => d.layers.filter((l) => l.type === 'image' && l.speaker === 'spmike').length);
      return { ok: st.designs.length >= 11 && !st.th.cutting && /^kp:/.test(st.th.person) && ims.filter((n) => n > 0).length >= 10, person: st.th.person, n: st.designs.length, ims };
    }, null, 60000);
    check(s && s.ok, 'Make puts the bank photo on the designs (the preacher’s own, so “Their photos” swaps it in the editor)', s);
    if (SHOTS) {
      const u = await page.evaluate(() => window.MWFlyer.render(window.MWFlyerStudio._state.designs[0], document.createElement('canvas'), 1).toDataURL('image/jpeg', 0.9));
      fs.writeFileSync(path.join(SHOTS, 'thumb-bank.jpg'), Buffer.from(u.split(',')[1], 'base64'));
    }

    // ── New post → Thumbnail: made from the post's own video, and "Use" puts it on the post
    await page.evaluate(() => { const x = window.MWFlyerStudio._state.panel; if (x) x.close(); });
    await sleep(400);
    await page.evaluate((p) => window.MWSocial.compose({ files: [p] }), VID);
    s = await until(page, () => { const c = document.querySelector('#csbCover'); return { ok: !!(c && c.querySelector('[data-c="covermake"]') && c.querySelector('[data-c="coverpick"]')), t: c && c.textContent }; }, null, 15000);
    check(s && s.ok, 'New post has a Thumbnail section for a video: Make a thumbnail, or a picture', s);
    await page.locator('#csbCover [data-c="covermake"]').tap();
    s = await until(page, () => { const st = window.MWFlyerStudio._state; return { ok: !!(st.panel && st.mode === 'thumb' && st.th.onUse && st.th.video), vid: st.th.video }; }, null, 15000);
    check(s && s.ok && s.vid === VID, 'it opens the thumbnail studio with the post’s own video', s);
    await page.waitForSelector('.cp-thumb [data-act="tmake"]:not([disabled])', { timeout: 60000 });
    await page.locator('.cp-thumb [data-act="tmake"]').tap();
    await page.waitForFunction(() => document.querySelectorAll('.cp-thumb .fs-card').length >= 11 && !window.MWFlyerStudio._state.th.cutting, null, { timeout: 60000 });
    await page.locator('.cp-thumb .fs-card').first().tap();
    await page.waitForSelector('.cp-thumb [data-ed="post"]', { timeout: 10000 });
    const useLabel = await page.evaluate(() => document.querySelector('.cp-thumb [data-ed="post"]').textContent.trim());
    check(useLabel === 'Use', 'from New post the editor says Use (not Keep)', useLabel);
    await page.locator('.cp-thumb [data-ed="post"]').tap();
    s = await until(page, () => { const i = document.querySelector('#csbCover .csb-cover img'); return { ok: !!(i && i.naturalWidth > 0) && !document.querySelector('.cp-thumb'), src: i && i.getAttribute('src'), w: i && i.naturalWidth, h: i && i.naturalHeight }; }, null, 30000);
    check(s && s.ok && /thumbnail\.jpg/.test(decodeURIComponent(s.src || '')) && s.w === 1920 && s.h === 1080, 'Use brings the thumbnail back onto the post (1920×1080), the studio closed', s);
    if (SHOTS) { await page.evaluate(() => { const c = document.querySelector('#csbCover'); if (c) c.scrollIntoView(); }); await sleep(300); await page.screenshot({ path: path.join(SHOTS, 'thumb-post.png') }); }
    await page.locator('#csbCover [data-c="coverdel"]').tap();
    await sleep(300);
    s = await page.evaluate(() => ({ img: !!document.querySelector('#csbCover .csb-cover img'), make: !!document.querySelector('#csbCover [data-c="covermake"]') }));
    check(!s.img && s.make, 'Remove takes it off again', s);
  } catch (e) {
    check(false, 'the run finished', e.stack || e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
