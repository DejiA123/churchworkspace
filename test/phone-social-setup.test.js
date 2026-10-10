'use strict';
/*
 * SOCIAL SCHEDULER SETUP IN AS FEW TAPS AS THE PLATFORMS ALLOW — on a phone.
 *
 * "I need to do a lot to set up the social scheduler — one tap to set it all
 * up." Drives the real Cloud Studio like an iPhone against a stand-in Zernio
 * (https, on this machine) and checks:
 *   [1] with no key: Open Zernio goes to its API keys page; 📋 Paste key reads
 *       the copied key — a wrong key is refused there and then, and nothing
 *       is kept
 *   [2] the right key is kept, and an account already linked on Zernio
 *       (YouTube) is linked here at once, with no Connect
 *   [3] ✨ Set up everything opens ONE window that goes through every other
 *       platform's sign-in in turn (each coming back to the studio, which
 *       opens the next) and ends on a page saying what was linked; a platform
 *       Zernio refuses (free plan full) is said in plain words, the others
 *       still connect
 *   [4] the Accounts sheet fills in by itself while that runs
 *   [5] an unticked platform is left out; the return page's code works once
 *       and a made-up code is refused
 *   [6] a key given to the server (ZERNIO_API_KEY) means nobody is asked
 *
 * Needs Playwright with Chromium; without it this says so and skips.
 *   node test/phone-social-setup.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), https = require('https');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
let PORT = 7395; const ZPORT = 7396, CODE = 'social-setup-test-2210';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-socialsetup-' + process.pid);
fs.mkdirSync(WORK, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
function get(p) { return new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: PORT, path: p, agent: false }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b, location: r.headers.location })); }).on('error', reject)); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }

/* ---- a stand-in Zernio: the endpoints the studio uses, and each platform's "Allow" page ---- */
const GOOD = 'sk_test_' + 'a'.repeat(40), OTHER = 'sk_test_' + 'b'.repeat(40);
const Z = { linked: { youtube: { _id: 'yt1', platform: 'youtube', username: 'gracechurch', displayName: 'Grace Church' } }, refuse: new Set(['instagram']), connects: [] };
function zernio() {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(WORK, 'k.pem'), '-out', path.join(WORK, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  return https.createServer({ key: fs.readFileSync(path.join(WORK, 'k.pem')), cert: fs.readFileSync(path.join(WORK, 'c.pem')) }, (req, res) => {
    const u = new URL(req.url, `https://127.0.0.1:${ZPORT}`);
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname.startsWith('/api/v1/')) {
      if (req.headers.authorization === 'Bearer ' + OTHER && u.pathname === '/api/v1/accounts') return out(200, { accounts: [{ _id: 'elsewhere1', platform: 'tiktok', username: 'someone_else' }] });
      if (req.headers.authorization !== 'Bearer ' + GOOD) return out(401, { error: 'Invalid API key' });
      const p = u.pathname.slice(7);
      if (p === '/accounts') return out(200, { accounts: Object.values(Z.linked) });
      if (p === '/profiles') return out(200, { profiles: [{ _id: 'prof1', isDefault: true }] });
      const m = /^\/connect\/(\w+)$/.exec(p);
      if (m) {
        Z.connects.push({ platform: m[1], redirect: u.searchParams.get('redirect_url') });
        if (Z.refuse.has(m[1])) return out(402, { error: 'free_tier_exceeded: more than 2 accounts needs billing' });
        return out(200, { authUrl: `https://127.0.0.1:${ZPORT}/oauth/${m[1]}?r=${encodeURIComponent(u.searchParams.get('redirect_url'))}` });
      }
      return out(404, { error: 'no' });
    }
    const m = /^\/oauth\/(\w+)$/.exec(u.pathname);
    if (m) {   // the platform's "Allow": linked, and back to where the studio asked
      const plat = m[1];
      Z.linked[plat] = { _id: plat + '9', platform: plat, username: 'grace_' + plat };
      const r = u.searchParams.get('r');
      res.writeHead(302, { location: r + (r.includes('?') ? '&' : '?') + `connected=${plat}&accountId=${plat}9` });
      return res.end();
    }
    res.writeHead(404); res.end();
  }).listen(ZPORT, '127.0.0.1');
}

function startStudio(dataDir, env) {
  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  return spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', dataDir, '--media', path.join(dataDir, 'media')],
    { stdio: 'ignore', env: Object.assign({}, process.env, { ZERNIO_API_BASE: `https://127.0.0.1:${ZPORT}/api/v1`, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, env || {}) });
}
async function phone(browser) {
  const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/#scheduler`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.MWSocial && window.api && window.api.social, null, { timeout: 30000 });
  return { ctx, page };
}

(async () => {
  const zs = zernio();
  const browser = await chromium.launch();
  let srv = startStudio(path.join(WORK, 'd1'));
  const SHOTS = process.env.MW_SHOTS || '';
  try {
    if (!(await waitUp())) throw new Error('no server');
    const { ctx, page } = await phone(browser);
    await page.evaluate(() => window.MWSocial.openConnect());
    await page.waitForSelector('#csConnect [data-k="paste"]', { timeout: 10000 });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'setup-1-key.png') });

    // [1]
    const open = await page.$eval('#csConnect a.cs-wide', (a) => a.href);
    check(open === 'https://zernio.com/settings/api-keys', 'Open Zernio goes straight to its API keys page', open);
    await page.evaluate(() => navigator.clipboard.writeText('sk_test_WRONGWRONGWRONGWRONG'));
    await page.tap('#csConnect [data-k="paste"]');
    await page.waitForSelector('#csConnect .cs-note.bad', { timeout: 15000 }).catch(() => {});
    const wrong = await page.$eval('#csConnect', (n) => n.innerText);
    check(/did not accept that key/i.test(wrong), 'a wrong key is refused there and then', wrong.slice(0, 200));
    check(!(await page.evaluate(async () => (await window.api.social.accounts()).keys.zo)), 'and it is not kept');

    // [2]
    await page.evaluate((k) => navigator.clipboard.writeText('  ' + k + '\n'), GOOD);
    await page.tap('#csConnect [data-k="paste"]');
    await page.waitForSelector('#csConnect [data-k="setup"]', { timeout: 15000 }).catch(() => {});
    const after = await page.$eval('#csConnect', (n) => n.innerText);
    const acc = await page.evaluate(async () => window.api.social.accounts());
    check(acc.keys.zo, 'the copied key is kept (spaces and line breaks round it are fine)');
    check(acc.accounts.some((a) => a.platform === 'youtube' && a.via === 'zernio'), 'YouTube, already on Zernio, is linked at once', acc.accounts);
    check(/YouTube was already on Zernio/.test(after) && /Set up everything/.test(after), 'it says so, and offers ✨ Set up everything', after.slice(0, 300));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'setup-2-ready.png') });

    // [3] + [4]
    const picks = await page.$$eval('#csConnect .cs-pick', (bs) => bs.map((b) => b.textContent.trim()));
    check(picks.join(',') === 'TikTok,Instagram,Facebook', 'it offers just the ones not yet connected', picks);
    const [win] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), page.tap('#csConnect [data-k="setup"]')]);
    await win.waitForLoadState('load').catch(() => {});
    await win.waitForFunction(() => /All set|Nearly there|Nothing/.test(document.title), null, { timeout: 30000 }).catch(() => {});
    const end = await win.evaluate(() => ({ title: document.title, text: document.body.innerText, url: location.href }));
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'setup-3-done.png') });
    check(end.url.startsWith(`http://127.0.0.1:${PORT}/social/next/`), 'the sign-ins end on the studio\'s own page', end.url);
    check(end.title === 'Nearly there' && /TikTok ✓ @grace_tiktok/.test(end.text) && /Facebook ✓ @grace_facebook/.test(end.text), 'TikTok and Facebook were signed in to, one after the other, in one window', end.text);
    check(/Instagram — Zernio’s free plan is full/.test(end.text) && /free plan covers 2 accounts/i.test(end.text), 'Instagram, refused by Zernio, is said in plain words', end.text);
    check(Z.connects.every((c) => c.redirect && c.redirect.startsWith(`http://127.0.0.1:${PORT}/social/next/`)), 'each sign-in was told to come back to the studio', Z.connects);
    check(/Back to the studio/.test(end.text), 'with a way back to the studio');
    await page.bringToFront();
    await page.waitForFunction(() => document.querySelectorAll('#csConnect .cs-plat.linked').length >= 3, null, { timeout: 12000 }).catch(() => {});
    const rows = await page.$$eval('#csConnect .cs-plat.linked', (r) => r.map((x) => x.dataset.plat));
    check(['tiktok', 'youtube', 'facebook'].every((p) => rows.includes(p)), 'the Accounts sheet filled in by itself', rows);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'setup-4-sheet.png') });

    const note = await page.waitForFunction(() => { const n = document.querySelector('#csConnect .cs-note.warn'); return n && n.textContent; }, null, { timeout: 12000 }).then((h) => h.jsonValue()).catch(() => '');
    check(/Instagram/.test(note) && /billing/.test(note), 'when the run ends the sheet stops waiting and says what was not connected, and why', note);
    check(!(await page.$('#csConnect a.cs-big')), 'and offers Set up everything again (not a stale Start the sign-ins)');
    await win.reload();
    check(await win.title() === 'Nearly there' && /TikTok ✓/.test(await win.evaluate(() => document.body.innerText)), 'reloading the results page shows the same results');
    await win.close();

    // a removed account stays removed; a key from ANOTHER Zernio account takes nothing over
    const fb = (await page.evaluate(async () => (await window.api.social.accounts()).accounts)).find((a) => a.platform === 'facebook');
    await page.evaluate((id) => window.api.social.unlink(id), fb.id);
    await page.evaluate((k) => window.api.social.setKeys({ zoApiKey: k }), GOOD);
    let now = (await page.evaluate(async () => (await window.api.social.accounts()).accounts));
    check(!now.some((a) => a.platform === 'facebook'), 'a removed account is not brought back by saving the key again', now.map((a) => a.platform));
    await page.evaluate((k) => window.api.social.setKeys({ zoApiKey: k }), OTHER);
    const disk = JSON.parse(fs.readFileSync(path.join(WORK, 'd1', 'workstation.json'), 'utf-8')).socialAccounts;
    const tk = disk.filter((a) => a.platform === 'tiktok');
    check(tk.length === 1 && tk[0].zoAccountId === 'tiktok9' && tk[0].token === GOOD, 'a key from another Zernio account neither takes over the linked TikTok nor adds a second one', tk.map((a) => [a.zoAccountId, a.token.slice(-4)]));
    await page.evaluate((k) => window.api.social.setKeys({ zoApiKey: k }), GOOD);

    // [5]
    Z.refuse.clear(); Z.connects.length = 0;
    await page.tap('#csConnect .cs-pick[data-p="instagram"]');   // untick the one left
    check(await page.$eval('#csConnect [data-k="setup"]', (b) => b.disabled), 'with everything unticked there is nothing to set up');
    const code = await page.evaluate(async () => (await window.api.social.setupStart({ origin: location.origin, platforms: ['instagram'] })).url.split('/').pop());
    const first = await get('/social/next/' + code);
    check(first.status === 302 && /oauth\/instagram/.test(first.location), 'the return page opens the next sign-in', first);
    const fake = await get('/social/next/' + 'f'.repeat(36));
    check(fake.status === 200 && /run out/.test(fake.body), 'a made-up code is refused');
    const bad = await get('/social/next/../../api/me');
    check(bad.status !== 302, 'and nothing else is reachable through it', bad.status);
    await ctx.close();
  } catch (e) {
    check(false, 'the test ran to the end', e.message);
  } finally { srv.kill(); }

  // [6]
  await sleep(500);
  PORT = 7397;
  srv = startStudio(path.join(WORK, 'd2'), { ZERNIO_API_KEY: GOOD });
  try {
    if (!(await waitUp())) throw new Error('no server 2');
    const { ctx, page } = await phone(browser);
    await page.evaluate(() => window.MWSocial.openConnect());
    await page.waitForSelector('#csConnect [data-k="setup"], #csConnect [data-k="paste"]', { timeout: 10000 });
    check(!(await page.$('#csConnect [data-k="paste"]')) && !!(await page.$('#csConnect [data-k="setup"]')), 'with ZERNIO_API_KEY on the server nobody is asked for a key — it goes straight to Set up everything');
    await ctx.close();
  } catch (e) {
    check(false, 'the server-key test ran to the end', e.message);
  } finally {
    srv.kill(); await browser.close(); zs.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
