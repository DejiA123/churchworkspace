'use strict';
/*
 * THE SERVER'S ROOM LEFT IS THE OWNER'S TO SEE.
 *
 * "Let me — I'm the admin of the tool — see how much storage is left on the
 * server, like before, but only me." The first space made on a studio is its
 * owner's. Here:
 *
 *   [1] the owner's My videos says how much is free, always, and that only
 *       they can see it
 *   [2] anyone else's does not — and the server never even sends it to them:
 *       not with the list of videos, not after a delete, not in /api/status
 *
 *   node test/phone-disk-owner.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const PORT = 7402, CODE = 'disk-owner-5180';
const WORK = path.join(os.tmpdir(), 'mw-disk-owner-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); ok ? pass++ : fail++; };
const req = (method, p, token, body) => new Promise((resolve, reject) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const headers = Object.assign({}, token ? { authorization: 'Bearer ' + token } : {}, data ? { 'content-type': 'application/json', 'content-length': data.length } : {});
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, agent: false, headers },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ raw: b, status: res.statusCode }); } }); });
  r.on('error', reject); if (data) r.write(data); r.end();
});
const up = async () => { for (let k = 0; k < 80; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; };

(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await up())) throw new Error('server did not start');
    // the first space is the owner's; the second is someone else's
    const owner = await req('POST', '/api/login', null, { create: true, code: CODE, name: 'Deji Ade', password: 'tester-pass-1', remember: true });
    const member = await req('POST', '/api/login', null, { create: true, code: CODE, name: 'Grace Member', password: 'tester-pass-2', remember: true });
    check(owner.me && owner.me.owner === true && member.me && member.me.owner === false, 'the first space is the owner\'s, the second is not', { owner: owner.me, member: member.me });

    console.log('\n[server] what each is sent');
    const ov = await req('GET', '/api/videos', owner.token);
    const mv = await req('GET', '/api/videos', member.token);
    check(ov.disk && ov.disk.total > 0 && ov.disk.free >= 0, 'the owner\'s list of videos says how much room is left', ov.disk);
    check(mv.ok && Array.isArray(mv.groups) && mv.disk === undefined, 'someone else\'s list does not (the videos are all there)', { disk: mv.disk, groups: (mv.groups || []).length });
    const md = await req('POST', '/api/delete', member.token, { paths: ['/nowhere/nothing.mp4'] });
    check(md.ok && md.disk === undefined, 'nor does a delete tell them', md);
    const od = await req('POST', '/api/delete', owner.token, { paths: ['/nowhere/nothing.mp4'] });
    check(od.ok && od.disk && od.disk.total > 0, '…while it tells the owner', od.disk);
    const os1 = await req('GET', '/api/status', owner.token);
    const ms1 = await req('GET', '/api/status', member.token);
    check(os1.freeBytes > 0 && 'outputDir' in os1, 'the owner\'s status has the free space', { freeBytes: os1.freeBytes });
    check(ms1.ok && ms1.running && !('freeBytes' in ms1) && !('outputDir' in ms1) && !('uploads' in ms1) && !('signedInDevices' in ms1), 'someone else\'s status only says the studio is running', ms1);

    console.log('\n[phone] My videos');
    const look = async (token) => {
      const ctx = await browser.newContext({ ...devices['iPhone 13'] });
      await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, token);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => check(false, 'no page errors', e.message));
      await page.goto(`http://127.0.0.1:${PORT}/#home`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.getElementById('cloudFiles'), null, { timeout: 30000 });
      await sleep(1200);
      await page.evaluate(() => document.getElementById('cloudFiles').click());
      await page.waitForSelector('#cloudFilesModal:not(.hidden)', { timeout: 15000 });
      await sleep(1500);
      const st = await page.evaluate(() => { const d = document.getElementById('cloudFilesDisk'); return { shown: !!d && !d.classList.contains('hidden') && d.offsetHeight > 0, text: d ? d.innerText : '' }; });
      await ctx.close();
      return st;
    };
    const o = await look(owner.token);
    check(o.shown && /free/.test(o.text) && /of .*on the/.test(o.text), 'the owner sees how much is free, of how much', o.text);
    check(/only you can see this/.test(o.text), '…and that only they can see it', o.text);
    const m = await look(member.token);
    check(!m.shown, 'someone else sees no storage line at all', m);
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
