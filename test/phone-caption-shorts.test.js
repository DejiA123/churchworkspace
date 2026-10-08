'use strict';
/*
 * "9 shorts captioned — 0 line on the Captions track. I don't see the
 *  generated captions, what is going on"
 *
 * Export all freezes a copy of every short before it starts (armExport) and
 * lets each go when that short is done. A page killed part-way — the iPhone
 * crashes the export-resume work was about — never got to let them go, and the
 * rolling save had already written them into the project. Reopened, every
 * short still carried an old frozen copy WITH caption lines in it, so "already
 * captioned?" said yes (and the card showed CC) while the real 💬 track was
 * empty: Auto-caption skipped them all and reported "captioned — 0 lines". The
 * shorts that DID fail (Groq or Gemini at their limit) were left out without a
 * word.
 *
 * The real phone editor, on a real cloud server; the caption answer is the
 * shape the server gives now (Gemini's words, Whisper's timing):
 *   [1] a project never saves an export's frozen copy of a short
 *   [2] shorts carrying a stale frozen copy, with an empty track, ARE captioned
 *   [3] a short that could not be captioned is named, with the reason
 *
 *   NODE_PATH=$(npm root -g) node test/phone-caption-shorts.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright).');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7617;
const CODE = 'caption-shorts-test-7617';
const WORK = path.join(os.tmpdir(), 'mw-phone-caption-shorts-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d).slice(0, 900) : '')); ok ? pass++ : fail++; };
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

/** An answer as the server gives it now: Gemini's words on Whisper's timing, clip-relative. */
function answer(text) {
  const words = text.split(' ').map((t, i) => ({ text: t, start: +(0.4 + i * 0.35).toFixed(2), end: +(0.7 + i * 0.35).toFixed(2), src: i % 4 ? 'both' : 'gemini' }));
  return {
    words, segments: words, durationSec: 30, model: 'whisper-large-v3', fixed: 0, fixedWords: '', engine: 'cloud',
    engineName: 'Groq — Whisper Large v3 + Google Gemini 3.6 Flash', cloudSec: 6, pcSec: 0, cloudWhy: '',
    check: { checked: true, model: 'whisper-large-v3-turbo', alt: words.map((w) => ({ text: w.text.toLowerCase(), start: w.start, end: w.end })), doubts: 0,
      third: { model: 'gemini-3.6-flash', heard: 1, failed: 0, why: '', replaced: 3, settled: 2, texts: [{ from: 0, to: 6, text }] },
      relisten: { windows: 1, suspects: 0, changed: 0, changes: [] }, ms: { first: 900, others: 2100, proofread: 4000 } },
  };
}

(async () => {
  const VID = path.join(MEDIA, 'sermon.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=30', '-f', 'lavfi', '-i', 'sine=f=220:d=30',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.__test, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });

    const A = { a: answer('And what usually happen is that when people do not have joy in approaching God'), b: answer('That shall not be you. I said that shall not be you') };
    const out = await page.evaluate(async (A) => {
      const T = window.VideoEditor.__test;
      const shorts = [['One', 1, 7], ['Two', 10, 16], ['Three', 20, 26]].map(([n, a, b]) => { const s = T.addShort(a, b); s.label = n; return s; });
      // what a page killed mid-export left behind: a frozen copy WITH captions, the real track empty
      for (const s of shorts) {
        s.__snap = { capEvents: [{ start: s.start + 0.5, end: s.start + 1.5, text: 'STALE LINE' }] };
        s.__task = 'an-export-long-gone';
        s._capKey = s.start.toFixed(2) + '|' + s.end.toFixed(2);
      }
      const saved = T.collectSession();
      const savedFrozen = (saved.timeline.segments || []).filter((x) => x.__snap || x.__task).length;
      const calls = [];
      window.api.captions.engineInfo = async () => ({ available: true });
      window.api.captions.transcribe = async (args) => {
        calls.push(args.startSec);
        if (args.startSec > 15) throw new Error('the free allowance is used up for the moment');
        return JSON.parse(JSON.stringify(args.startSec < 5 ? A.a : A.b));
      };
      const toasts = [];
      const real = window.__toast;
      window.__toast = (m, kind) => { toasts.push({ kind, m }); return real && real(m, kind); };
      await T.captionAllShorts();
      window.__toast = real;
      const lines = T.capLines();
      return { savedFrozen, calls, lines, last: toasts[toasts.length - 1] };
    }, A);

    console.log('\n[1] a saved project never carries an export\'s frozen copy');
    check(out.savedFrozen === 0, 'no short is saved with __snap / __task', out.savedFrozen);

    console.log('\n[2] a stale frozen copy does not count as captioned');
    check(out.calls.length === 3, 'every short was really heard (none skipped on a stale copy)', out.calls);
    check(out.lines.length > 4 && !out.lines.some((l) => /STALE/.test(l.text)), 'its lines are on the real 💬 track', out.lines.slice(0, 4));
    check(out.lines.some((l) => /HAPPEN IS THAT|happen is that/i.test(l.text)) && out.lines.some((l) => /SHALL NOT/i.test(l.text)), 'the words of both shorts are there');
    check(out.lines.every((l) => (l.start >= 1 && l.end <= 7.05) || (l.start >= 10 && l.end <= 16.05)), 'on the recording\'s clock, inside their shorts', out.lines.map((l) => [l.start, l.end]));

    console.log('\n[3] a short that could not be captioned is said, with why');
    const m = (out.last && out.last.m) || '';
    check(/2 shorts captioned — \d+ lines on the/.test(m), 'the count is of shorts really captioned, and their lines', m);
    check(/1 could not be captioned \(“Three”\): the free allowance is used up/.test(m) && /again to try just those/.test(m), 'the one that failed is named, with the reason and what to do', m);
    check(out.last && out.last.kind === 'error', '…shown as needing attention, not as all good', out.last);
    check(!errors.length, 'no page errors', errors);
  } catch (e) {
    console.error('FATAL', e); fail++;
  } finally {
    await browser.close();
    srv.kill();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
