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
 *   [7] "Two Facebook pages, Instagram, TikTok — and YouTube — it must be
 *       free": when the free Zernio account (2 places) is full, the sheet asks
 *       for another free one; both Facebook pages go on the second, YouTube
 *       on a third — five accounts, three free Zernio accounts, no billing
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

/* ---- a stand-in Zernio: per-key accounts with Zernio's 2 free places, profiles, each platform's "Allow" ---- */
const GOOD = 'sk_test_' + 'a'.repeat(40), GOOD2 = 'sk_test_' + 'c'.repeat(40), GOOD3 = 'sk_test_' + 'd'.repeat(40), OTHER = 'sk_test_' + 'b'.repeat(40);
const Z = { keys: { [GOOD]: { accounts: [{ _id: 'tiktok1', platform: 'tiktok', username: 'gracechurch', displayName: 'Grace Church' }], profiles: 1, billing: false },
  [GOOD2]: { accounts: [], profiles: 1, billing: false }, [GOOD3]: { accounts: [], profiles: 1, billing: false }, [OTHER]: { accounts: [{ _id: 'elsewhere1', platform: 'tiktok', username: 'someone_else' }], profiles: 1, billing: false } },
  connects: [], seq: 0 };
function zernio() {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(WORK, 'k.pem'), '-out', path.join(WORK, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  return https.createServer({ key: fs.readFileSync(path.join(WORK, 'k.pem')), cert: fs.readFileSync(path.join(WORK, 'c.pem')) }, (req, res) => {
    const u = new URL(req.url, `https://127.0.0.1:${ZPORT}`);
    const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname.startsWith('/api/v1/')) {
      const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const K = Z.keys[key];
      if (!K) return out(401, { error: 'Invalid API key' });
      const p = u.pathname.slice(7);
      if (p === '/accounts') return out(200, { accounts: K.accounts });
      if (p === '/profiles' && req.method === 'POST') { K.profiles++; return out(201, { profile: { _id: 'prof' + K.profiles } }); }
      if (p === '/profiles') return out(200, { profiles: [{ _id: 'prof1', isDefault: true }] });
      const m = /^\/connect\/(\w+)$/.exec(p);
      if (m) {
        const profileId = u.searchParams.get('profileId');
        Z.connects.push({ platform: m[1], key: key.slice(-4), profileId, redirect: u.searchParams.get('redirect_url') });
        if (K.accounts.length >= 2 && !K.billing) return out(402, { error: 'free_tier_exceeded: Add a payment method to connect more than 2 accounts.' });
        // one account per platform per profile, as Zernio keeps it
        if (K.accounts.some((a) => a.platform === m[1] && a.profileId === profileId)) return out(409, { error: 'This profile already has a ' + m[1] + ' account' });
        return out(200, { authUrl: `https://127.0.0.1:${ZPORT}/oauth/${m[1]}?k=${encodeURIComponent(key)}&pr=${encodeURIComponent(profileId)}&r=${encodeURIComponent(u.searchParams.get('redirect_url'))}` });
      }
      return out(404, { error: 'no' });
    }
    const m = /^\/oauth\/(\w+)$/.exec(u.pathname);
    if (m) {   // the platform's "Allow": linked on that key, and back to where the studio asked
      const plat = m[1], n = ++Z.seq;
      Z.keys[u.searchParams.get('k')].accounts.push({ _id: plat + n, platform: plat, profileId: u.searchParams.get('pr'), username: 'grace_' + plat, displayName: plat === 'facebook' ? 'Grace Church Page ' + n : undefined });
      const r = u.searchParams.get('r');
      res.writeHead(302, { location: r + (r.includes('?') ? '&' : '?') + `connected=${plat}&accountId=${plat}${n}` });
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
    check(acc.accounts.some((a) => a.platform === 'tiktok' && a.via === 'zernio'), 'TikTok, already on Zernio, is linked at once', acc.accounts);
    check(/TikTok was already on Zernio/.test(after) && /Set up everything/.test(after), 'it says so, and offers ✨ Set up everything', after.slice(0, 300));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'setup-2-ready.png') });

    // [3] + [4] + [7]: Instagram and two Facebook pages, no YouTube
    const picks = await page.$$eval('#csConnect .cs-pick', (bs) => bs.map((b) => b.textContent.trim()));
    check(picks.join(',') === 'YouTube,Instagram,Facebook,2nd page', 'it offers the ones not yet connected, and a 2nd Facebook page', picks);
    await page.tap('#csConnect .cs-pick[data-p="youtube"]');
    await page.tap('#csConnect .cs-pick[data-p="facebook2"]');
    const [win] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), page.tap('#csConnect [data-k="setup"]')]);
    await win.waitForLoadState('load').catch(() => {});
    await win.waitForFunction(() => /All set|Nearly there|Nothing/.test(document.title), null, { timeout: 30000 }).catch(() => {});
    const end = await win.evaluate(() => ({ title: document.title, text: document.body.innerText, url: location.href }));
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'setup-3-done.png') });
    check(end.url.startsWith(`http://127.0.0.1:${PORT}/social/next/`), 'the sign-ins end on the studio\'s own page', end.url);
    check(end.title === 'Nearly there' && /Instagram ✓ @grace_instagram/.test(end.text), 'Instagram takes the free account\'s 2nd place', end.text);
    check(/Facebook — Your free Zernio account is full/.test(end.text) && /Facebook \(2nd page\) —/.test(end.text) && /another free Zernio account/.test(end.text) && /Paste the new key/.test(end.text),
      'with the free account full, the page says the way on is ANOTHER FREE Zernio account — not billing', end.text);
    check(Z.connects.every((c) => c.redirect && c.redirect.startsWith(`http://127.0.0.1:${PORT}/social/next/`)), 'each sign-in was told to come back to the studio', Z.connects);
    check(/Back to the studio/.test(end.text), 'with a way back to the studio');
    await page.bringToFront();
    await page.waitForSelector('#csConnect [data-k="paste2"]', { timeout: 12000 }).catch(() => {});
    const sheet = await page.$eval('#csConnect', (n) => n.innerText);
    check(!!(await page.$('#csConnect [data-k="paste2"]')) && /another free one/i.test(sheet), 'the sheet stops waiting and offers 📋 Paste the new key', sheet.slice(0, 400));
    const rows = await page.$$eval('#csConnect .cs-plat.linked', (r) => r.map((x) => x.dataset.plat));
    check(['tiktok', 'instagram'].every((p) => rows.includes(p)), 'the Accounts sheet filled in by itself', rows);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'setup-4-second.png') });
    await win.reload();
    check(await win.title() === 'Nearly there' && /Instagram ✓/.test(await win.evaluate(() => document.body.innerText)), 'reloading the results page shows the same results');
    await win.close();

    // the card is still there when the sheet is opened again (the person went off to make the account)
    await page.evaluate(() => { const c = document.querySelector('#csConnect .cp-close, #csConnect [data-close], #csConnect button[aria-label="Close"]'); if (c) c.click(); });
    await sleep(500);
    await page.evaluate(() => window.MWSocial.openConnect());
    await page.waitForSelector('#csConnect [data-k="paste2"]', { timeout: 8000 }).catch(() => {});
    check(!!(await page.$('#csConnect [data-k="paste2"]')), 'Paste the new key is still offered after the sheet is closed and opened again');
    // the FIRST key pasted again is refused: it gives no more places
    await page.evaluate((k) => navigator.clipboard.writeText(k), GOOD);
    await page.tap('#csConnect [data-k="paste2"]');
    await page.waitForSelector('#csConnect .cs-note.bad', { timeout: 10000 }).catch(() => {});
    const same = await page.$eval('#csConnect', (n) => n.innerText);
    check(/same key as one you already added/i.test(same) && !(await page.evaluate(async () => (await window.api.social.accounts()).keys.zoFb)), 'the first key pasted as the second is refused, and not kept', same.slice(0, 200));

    // the second free key: both Facebook pages go on it
    await page.evaluate((k) => navigator.clipboard.writeText(k), GOOD2);
    await page.tap('#csConnect [data-k="paste2"]');
    await page.waitForSelector('#csConnect [data-k="setup"]', { timeout: 15000 }).catch(() => {});
    const picks2 = await page.$$eval('#csConnect .cs-pick', (bs) => bs.map((b) => b.textContent.trim() + (b.classList.contains('on') ? '+' : '')));
    check(picks2.includes('Facebook+') && picks2.includes('2nd page+'), 'after pasting it, Set up everything still has Facebook and the 2nd page ticked', picks2);
    const [win2] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), page.tap('#csConnect [data-k="setup"]')]);
    await win2.waitForFunction(() => /All set|Nearly there|Nothing/.test(document.title), null, { timeout: 30000 }).catch(() => {});
    const end2 = await win2.evaluate(() => ({ title: document.title, text: document.body.innerText }));
    if (SHOTS) await win2.screenshot({ path: path.join(SHOTS, 'setup-5-allset.png') });
    check(end2.title === 'All set' && /Facebook ✓ Grace Church Page/.test(end2.text) && /Facebook \(2nd page\) ✓ Grace Church Page/.test(end2.text), 'both Facebook pages are connected', end2.text);
    const fbConn = Z.connects.filter((c) => c.platform === 'facebook' && c.key === GOOD2.slice(-4));
    check(fbConn.length === 2 && fbConn[0].profileId !== fbConn[1].profileId, 'on the second free account, the 2nd page in a profile of its own', fbConn);
    check(!Z.keys[GOOD].billing && !Z.keys[GOOD2].billing && Z.keys[GOOD].accounts.length === 2 && Z.keys[GOOD2].accounts.length === 2, 'all four on two free Zernio accounts — 2 each, no billing',
      [Z.keys[GOOD].accounts.length, Z.keys[GOOD2].accounts.length]);
    await win2.close();
    await page.bringToFront();
    await page.waitForFunction(() => document.querySelectorAll('#csConnect .cs-plat.linked').length >= 4, null, { timeout: 12000 }).catch(() => {});
    const rows2 = await page.$$eval('#csConnect .cs-plat.linked', (r) => r.map((x) => x.dataset.plat));
    check(rows2.filter((p) => p === 'facebook').length === 2 && rows2.includes('tiktok') && rows2.includes('instagram'), 'the sheet lists TikTok, Instagram and both Facebook pages', rows2);
    const disk0 = JSON.parse(fs.readFileSync(path.join(WORK, 'd1', 'workstation.json'), 'utf-8')).socialAccounts;
    check(disk0.filter((a) => a.platform === 'facebook').every((a) => a.token === GOOD2) && disk0.find((a) => a.platform === 'instagram').token === GOOD,
      'each account posts with the key of the Zernio account it is on', disk0.map((a) => [a.platform, a.token.slice(-4)]));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'setup-6-sheet.png') });

    // "I forgot to mention YouTube": a fifth account, on a third free Zernio account
    await page.tap('#csConnect [data-k="unskip"]');
    await page.waitForSelector('#csConnect [data-k="paste2"]', { timeout: 8000 }).catch(() => {});
    const third = await page.$eval('#csConnect', (n) => n.innerText);
    check(!!(await page.$('#csConnect [data-k="paste2"]')) && /third free Zernio account/.test(third), 'asking for YouTube too, with two free accounts full, it offers a third free one', third.slice(0, 300));
    await page.evaluate((k) => navigator.clipboard.writeText(k), GOOD3);
    await page.tap('#csConnect [data-k="paste2"]');
    await page.waitForSelector('#csConnect [data-k="setup"]', { timeout: 15000 }).catch(() => {});
    const [win3] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }), page.tap('#csConnect [data-k="setup"]')]);
    await win3.waitForFunction(() => /All set|Nearly there|Nothing/.test(document.title), null, { timeout: 30000 }).catch(() => {});
    const end3 = await win3.evaluate(() => ({ title: document.title, text: document.body.innerText }));
    check(end3.title === 'All set' && /YouTube ✓/.test(end3.text), 'YouTube is connected', end3.text);
    check(Z.keys[GOOD3].accounts.length === 1 && Z.keys[GOOD3].accounts[0].platform === 'youtube' && ![GOOD, GOOD2, GOOD3].some((k) => Z.keys[k].billing),
      'five accounts on three free Zernio accounts (2 + 2 + 1), no billing', [GOOD, GOOD2, GOOD3].map((k) => Z.keys[k].accounts.map((a) => a.platform)));
    await win3.close(); await page.bringToFront();
    await page.waitForFunction(() => document.querySelectorAll('#csConnect .cs-plat.linked').length >= 5, null, { timeout: 12000 }).catch(() => {});
    check((await page.$$('#csConnect .cs-plat.linked')).length === 5, 'the sheet lists all five');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'setup-7-five.png') });

    // a removed Facebook page is not brought back by "+ Add": a sign-in lets the person pick the new one
    const fbs = (await page.evaluate(async () => (await window.api.social.accounts()).accounts)).filter((a) => a.platform === 'facebook');
    await page.evaluate((id) => window.api.social.unlink(id), fbs[0].id);
    Z.keys[GOOD].billing = Z.keys[GOOD2].billing = true;   // places on Zernio are still taken (the removed page keeps its own)
    const again = await page.evaluate(() => window.api.social.linkStart('facebook', true));
    check(!!again.url && !again.account, '"+ Add another Facebook page" after removing one opens a sign-in, never the removed page', again);
    Z.keys[GOOD].billing = Z.keys[GOOD2].billing = false;
    const claimNow = await page.evaluate(() => window.api.social.linkClaim('facebook', true));
    check(claimNow.pending === true, 'and the removed page is not claimed back in its place', claimNow);

    // a removed account stays removed; a key from ANOTHER Zernio account takes nothing over
    const ig = (await page.evaluate(async () => (await window.api.social.accounts()).accounts)).find((a) => a.platform === 'instagram');
    await page.evaluate((id) => window.api.social.unlink(id), ig.id);
    await page.evaluate((k) => window.api.social.setKeys({ zoApiKey: k }), GOOD);
    let now = (await page.evaluate(async () => (await window.api.social.accounts()).accounts));
    check(!now.some((a) => a.platform === 'instagram'), 'a removed account is not brought back by saving the key again', now.map((a) => a.platform));
    await page.evaluate((k) => window.api.social.setKeys({ zoApiKey: k }), OTHER);
    const disk = JSON.parse(fs.readFileSync(path.join(WORK, 'd1', 'workstation.json'), 'utf-8')).socialAccounts;
    const tk = disk.filter((a) => a.platform === 'tiktok');
    check(tk.length === 1 && tk[0].zoAccountId === 'tiktok1' && tk[0].token === GOOD, 'a key from another Zernio account neither takes over the linked TikTok nor adds a second one', tk.map((a) => [a.zoAccountId, a.token.slice(-4)]));
    await page.evaluate((k) => window.api.social.setKeys({ zoApiKey: k }), GOOD);

    // [5]
    Z.keys[GOOD].billing = true; Z.connects.length = 0;
    await page.evaluate(() => window.MWSocial.openConnect());
    await page.waitForSelector('#csConnect .cs-pick', { timeout: 10000 });
    for (const p of await page.$$eval('#csConnect .cs-pick.on', (bs) => bs.map((b) => b.dataset.p))) await page.tap(`#csConnect .cs-pick[data-p="${p}"]`);
    const allSet = await page.$eval('#csConnect', (n) => n.innerText);
    check(!(await page.$('#csConnect [data-k="setup"]')) && /All set/.test(allSet) && !!(await page.$('#csConnect [data-k="unskip"]')),
      'with the rest unticked it says All set (no greyed-out button), with a way to connect them after all', allSet.slice(0, 200));
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
