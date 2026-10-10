'use strict';
/*
 * THE AI MONTAGE PAGE ON A PHONE: the new "🔥 Viral talk edit" choice.
 *
 * (based on the phone timeline test's harness) THE PHONE'S TIMELINE, AS CAPCUT HAS IT — in a real browser, on the real
 * Cloud Studio, the way an iPhone uses it.
 *
 *   [A] the white line stays in the middle: at the start, after a swipe, while
 *       playing, at the very end, after a pinch and after Fit — and the start
 *       and the end of the video both reach it
 *   [B] a swipe is a scrub: whatever is under the line is what the picture
 *       shows, and taking the timeline stops playback
 *   [C] nothing jumps on a tap; trim handles belong to the selected clip only;
 *       a first tap on a caption selects it, its handle trims it, a second tap
 *       types into it
 *   [D] the things a review found: a touch on a block the lane redraws cannot
 *       freeze the timeline; Play during a coasting flick keeps playing; a
 *       long press on empty track still draws a clip; a wide screen keeps the
 *       desk's timeline
 *   [E] a caption typed in lower case wears the Case that is chosen
 *
 * Needs Playwright with Chromium (it is not one of the app's dependencies);
 * without it this says so and skips.
 *
 *   node test/phone-timeline.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the phone timeline was not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7396;
const CODE = 'montage-test-5821';
const WORK = path.join(os.tmpdir(), 'mw-phone-montage-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });

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

(async () => {
  // a 40 s picture the browser can play (Chromium here has no H.264), with sound
  const VID = path.join(MEDIA, 'tl.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=40', '-f', 'lavfi', '-i', 'sine=f=220:d=40',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const open = async (ctxOpts) => {
      const ctx = await browser.newContext(ctxOpts);
      await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
      await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
      await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
      await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
      await sleep(1000);
      return page;
    };
    const page = await open({ ...devices['iPhone 13'] });

    await page.evaluate(() => window.MWSocial.openMontage());
    await page.waitForSelector('#cloudMontage [data-mt-mode="talk"]', { timeout: 15000 });
    check(await page.locator('#cloudMontage [data-mt-mode]').count() === 2, 'the montage page asks what kind of edit: music montage or viral talk edit');
    await page.locator('#cloudMontage [data-mt-mode="talk"]').tap();
    await sleep(300);
    const st = () => page.evaluate(() => {
      const go = document.querySelector('#cloudMontage .mt-go');
      return { go: go && go.textContent.trim(), disabled: !!(go && go.disabled),
        order: !!document.querySelector('#cloudMontage [data-mt-order]') && document.querySelector('#cloudMontage [data-mt-order]').closest('section').hidden,
        lens: [...document.querySelectorAll('#cloudMontage [data-mt-len]')].map((b) => b.textContent), caps: !document.getElementById('mtCaps') };
    });
    const a = await st();
    check(/Viral Montage/.test(a.go) && a.disabled, 'the button says "Make my Viral Montage", waiting for a video', a);
    check(a.order && !a.lens.includes('Use everything') && a.caps, 'the talk edit hides Order and "Use everything", and its captions are always on', a);
    const extra = await page.evaluate(() => ({
      narrator: [...document.querySelectorAll('#cloudMontage .mt-sec h3')].some((h) => /Narrator/.test(h.textContent)),
      moods: [...document.querySelectorAll('#cloudMontage [data-mt-mood]')].map((b) => b.textContent),
      pick: !!document.querySelector('#cloudMontage [data-mt-free="auto"].on'),
      songs: document.querySelectorAll('#cloudMontage [data-mt-free]:not([data-mt-free="auto"])').length,
    }));
    check(extra.narrator, 'the Viral Montage offers a narrator', extra);
    check(extra.moods.length === 4 && extra.pick && extra.songs >= 3, 'free, safe-to-post music is on the page by mood — and "✨ Pick for me" is on by default', extra);
    // ✨ Pick for me deals the mood's songs like cards: ten picks in a row, ten different songs
    const dealt = await page.evaluate(() => {
      const D = window.MWCloud._freeDeal;
      const tracks = Array.from({ length: 12 }, (_, i) => ({ id: 'h' + i, mood: 'hype' })).concat([{ id: 'u0', mood: 'uplift' }]);
      try { localStorage.removeItem('mw-free-recent'); } catch (e) {}
      const got = [];
      for (let i = 0; i < 10; i++) { const t = D.deal(tracks, 'hype')[0]; got.push(t.id); D.used(t.id); }
      // all twelve used: the one used longest ago comes round first
      for (let i = 10; i < 12; i++) { const t = D.deal(tracks, 'hype')[0]; got.push(t.id); D.used(t.id); }
      const next = D.deal(tracks, 'hype')[0].id;
      return { got, next, mood: got.every((x) => x[0] === 'h') };
    });
    check(new Set(dealt.got).size === 12 && dealt.mood && dealt.next === dealt.got[0], '"✨ Pick for me" never repeats a song until the whole mood has played, then starts with the oldest', dealt);
    const shelf = await page.evaluate(() => document.querySelectorAll('#cloudMontage [data-mt-free]:not([data-mt-free="auto"])').length);
    check(shelf >= 8, 'and each mood has plenty of songs to pick from', shelf);
    await page.locator('#cloudMontage [data-mt-mood="epic"]').tap();
    await sleep(200);
    check(await page.evaluate(() => [...document.querySelectorAll('#cloudMontage [data-mt-free]:not([data-mt-free="auto"])')].some((b) => /Heroic Age/.test(b.textContent))), 'a mood shows its songs (Epic: "Heroic Age"…)');
    await page.setInputFiles('#mtPick', VID);
    await sleep(800);
    const b = await st();
    check(!b.disabled, 'one video is enough to make a talk edit', b);
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'montage-talk.png'), fullPage: false });
    await page.locator('#cloudMontage [data-mt-mode="music"]').tap();
    await sleep(300);
    const c = await st();
    check(/montage/.test(c.go) && c.disabled, 'the music montage still asks for two or more clips', c);
    // "WHAT'S IT ABOUT?": a tap for the occasion, labelled boxes, the speaker guessed from the file's name
    await page.locator('#cloudMontage [data-mt-mode="talk"]').tap();
    await sleep(300);
    await page.setInputFiles('#mtPick', { name: 'Teaching with Bishop David Richman.webm', mimeType: 'video/webm', buffer: fs.readFileSync(VID) });
    await sleep(800);
    const ab0 = await page.evaluate(() => ({
      occ: document.querySelectorAll('#cloudMontage [data-mt-occ]').length,
      boxes: ['mtAbSpeaker', 'mtAbChurch', 'mtAbFocus', 'mtAbCta', 'mtBrief'].filter((id) => document.getElementById(id)).length,
      guess: [...document.querySelectorAll('#cloudMontage [data-mt-who]')].map((b) => b.dataset.mtWho),
    }));
    check(ab0.occ >= 8 && ab0.boxes === 5, '"What\'s it about?" has occasion taps and labelled boxes: speaker, church, message, call to action, anything else', ab0);
    check(ab0.guess.includes('Bishop David Richman'), 'the speaker is offered from the video\'s own name', ab0.guess);
    await page.locator('#cloudMontage [data-mt-who="Bishop David Richman"]').tap();
    await page.locator('#cloudMontage [data-mt-occ="Sunday service"]').tap();
    await sleep(200);
    await page.fill('#mtAbChurch', 'The Power House');
    await page.fill('#mtAbFocus', 'Faith over fear');
    await page.fill('#mtAbCta', 'Join us Sundays at 10am');
    await page.locator('#cloudMontage [data-mt-song=""]').tap();
    await sleep(200);
    if (process.env.MW_SHOTS) { await page.evaluate(() => document.querySelector('#cloudMontage .mt-about').scrollIntoView()); await sleep(300); await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'montage-about.png'), fullPage: false }); }
    await page.evaluate(() => { window.api.montage.create = async (a) => { window.__mtArgs = a; throw new Error('stopped by the test'); }; });
    await page.locator('#cloudMontage .mt-go').tap();
    for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__mtArgs)); i++) await sleep(250);
    const sent = await page.evaluate(() => ({ about: window.__mtArgs && window.__mtArgs.about, kept: JSON.parse(localStorage.getItem('mw-mt-about') || '{}') }));
    check(sent.about && sent.about.speaker === 'Bishop David Richman' && sent.about.occasion === 'Sunday service' && sent.about.church === 'The Power House'
      && sent.about.focus === 'Faith over fear' && sent.about.cta === 'Join us Sundays at 10am', 'all of it goes to the AI with the montage', sent.about);
    check(sent.kept.speaker === 'Bishop David Richman' && sent.kept.church === 'The Power House' && sent.kept.cta === 'Join us Sundays at 10am' && !sent.kept.focus,
      'speaker, church and call to action are remembered for next time (the message is not)', sent.kept);
    // the studio side: the edit's own words become captions at once, lit up word by word
    await page.evaluate(() => { const x = document.querySelector('#cloudMontage .cp-x, #cloudMontage [data-close]'); if (x) x.click(); });
    const st2 = await page.evaluate(async (vid) => {
      const words = 'never give up on what god promised you he is faithful'.split(' ').map((t, i) => ({ text: t, start: 0.5 + i * 0.4, end: 0.85 + i * 0.4 }));
      await window.VideoEditor.applyMontage({ output: vid, words, talk: true, style: 'hype', texts: [{ start: 0, end: 2.4, text: 'Don’t quit now', role: 'hook' }] });
      const T = window.VideoEditor.__test;
      return { lines: T.capLines().map((l) => l.text), show: document.getElementById('veCapShow').checked, look: document.getElementById('capStyleSel').value, hl: document.getElementById('capWordHl').checked };
    }, VID);
    check(st2.lines.length >= 3 && /NEVER GIVE UP|never give up/i.test(st2.lines[0]) && st2.show, 'the talk edit opens with its captions already on — no second listen', st2);
    check(st2.look === 'boxword' && st2.hl, 'in a look that lights each word up as it is said', st2);
    // THE SCHEDULER: music under a post, laid on by the server before it goes
    const sched = await page.evaluate(async (vid) => {
      window.MWSocial.compose({ files: [vid] });
      await new Promise((r) => setTimeout(r, 1200));
      const sec = [...document.querySelectorAll('#csCompose .cs-sec h4')].find((h) => /Music/.test(h.textContent));
      return { music: !!sec, worship: !!document.querySelector('#csCompose [data-c="mus"][data-v="auto"]'),
        moods: document.querySelectorAll('#csCompose [data-c="musmood"]').length, hint: (document.querySelector('#csCompose .cs-sec .cs-hint') || {}).textContent || '' };
    }, VID);
    check(sched.music && sched.worship && sched.moods === 4, 'a new post offers Music: a worship song picked for you, or free songs by mood', sched);
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'schedule-music.png') });
    const songPath = path.join(MEDIA, 'my-song.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=523:d=6', songPath]);
    const mixed = await page.evaluate(async (a) => {
      const song = await window.api.library.add('music', a.song, 'My song');
      return window.api.social.withMusic({ mediaPath: a.vid, libId: song.id });
    }, { vid: VID, song: songPath });
    let ok2 = false, info = '';
    try { info = execFileSync(require('ffprobe-static').path, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', mixed.path], { encoding: 'utf8' }); ok2 = /video/.test(info) && /audio/.test(info); } catch (e) { info = e.message; }
    check(mixed && mixed.path !== VID && ok2 && mixed.credit === '', 'the server lays the song under the video and posts that copy (your own song needs no credit)', { mixed, info });
    // 🎙 AI VOICE: type a line, it lands on the Sounds row (the server's voice stood in for)
    await page.evaluate(() => { document.getElementById('csCompose') && document.querySelector('#csCompose .cp-x, #csCompose [data-close]') && document.querySelector('#csCompose .cp-x, #csCompose [data-close]').click(); window.MWSocial.go('studio'); });
    await sleep(800);
    const voice = await page.evaluate(async (song) => {
      window.api.audio.voices = async () => ({ installed: true, voices: [{ id: 'am_michael', label: 'Man · American' }, { id: 'af_heart', label: 'Woman · American' }] });
      window.api.audio.say = async (a) => { window.__said = a; return { path: song, durationSec: 2.4, text: a.text }; };
      const before = (window.VideoEditor.__test.sounds ? window.VideoEditor.__test.sounds() : null);
      await window.VideoEditor.aiVoice();
      await new Promise((r) => setTimeout(r, 300));
      const box = document.getElementById('veAiVoice');
      document.getElementById('veAivText').value = 'This message will change the way you pray.';
      document.querySelector('#veAiVoice [data-aiv-voice="af_heart"]').click();
      await new Promise((r) => setTimeout(r, 100));
      document.querySelector('#veAiVoice [data-aiv="add"]').click();
      await new Promise((r) => setTimeout(r, 500));
      const lane = [...document.querySelectorAll('.ve-sfx-track *')].map((e) => e.textContent).join(' ');
      return { opened: !!box, said: window.__said, closed: !document.getElementById('veAiVoice'), lane: /AI voice/.test(lane) };
    }, songPath);
    check(voice.opened && voice.said && voice.said.voice === 'af_heart' && /change the way you pray/.test(voice.said.text), 'AI voice: a typed line is sent to be spoken in the voice picked', voice);
    check(voice.closed && voice.lane, 'and it lands on the Sounds row', voice);
  } catch (e) {
    check(false, 'the test ran to the end', e && e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
