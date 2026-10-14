'use strict';
/*
 * THE BEST OF THE FREE CLOUDFLARE ALLOWANCE (flyerart.js) — no network: the
 * Cloudflare answers and the vision model's reading are stood in for.
 *   [A] the board's top pictures get FLUX.2 klein 9B while the day can afford
 *       it, the rest the cheap 4B; the day's spend is kept, and the cheap
 *       painters always keep a reserve
 *   [B] AI lettering (Phoenix 1.0): kept when the title reads back spelt
 *       right; one more try when not; refused after two misspellings; marked
 *       unchecked when no vision model can read it; never past the allowance
 *   node test/flyer-free-ai.test.js
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); } };

(async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'; process.env.CLOUDFLARE_API_TOKEN = 'tok';
  delete process.env.CLOUDFLARE_PAID;
  const fa = require('../src/main/flyerart.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-freeai-'));
  fa.init(dir);
  const cs = require('../src/main/cloudsee.js');
  // a tiny PNG, as Cloudflare would send
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const big = Buffer.concat([png, Buffer.alloc(9000)]);
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(String(url).split('/ai/run/')[1] || String(url));
    return new Response(big, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const ledgerOf = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'flyer-kit', 'cf-allowance.json'), 'utf8')); } catch (e) { return { spent: 0 }; } };

  console.log('[A] the better painter for the top designs, within the day');
  await t('a premium picture is painted by FLUX.2 klein 9B', async () => {
    calls.length = 0;
    const r = await fa.paint({ scene: 'light', tier: 'premium' });
    assert.ok(/klein-9b/.test(calls[0]), calls.join());
    assert.ok(/klein 9B/.test(r.by), r.by);
  });
  await t('an ordinary one by the cheap 4B', async () => {
    calls.length = 0;
    await fa.paint({ scene: 'light' });
    assert.ok(/klein-4b/.test(calls[0]), calls.join());
  });
  await t('the day\'s spend is kept', () => { const l = ledgerOf(); assert.ok(l.spent > 1500 && l.spent < 1800, JSON.stringify(l)); });
  await t('the status says what is left', () => { const st = fa.status(); assert.strictEqual(st.cloudflare, true); assert.ok(st.allowanceLeft > 8000 && st.premium && st.lettering, JSON.stringify(st)); });
  await t('near the end of the day: premium falls back to the cheap painter (a reserve is always kept)', async () => {
    fs.writeFileSync(path.join(dir, 'flyer-kit', 'cf-allowance.json'), JSON.stringify({ day: new Date().toISOString().slice(0, 10), spent: 8200 }));
    calls.length = 0;
    await fa.paint({ scene: 'light', tier: 'premium' });
    assert.ok(/klein-4b/.test(calls[0]), calls.join());
    assert.strictEqual(fa.status().premium, false);
  });
  await t('a new day starts with the whole allowance again', () => {
    fs.writeFileSync(path.join(dir, 'flyer-kit', 'cf-allowance.json'), JSON.stringify({ day: '2020-01-01', spent: 9999 }));
    assert.ok(fa.status().allowanceLeft === 10000);
  });

  console.log('\n[B] the title lettered by AI, read back before it is offered');
  let reads = [];
  cs.ready = () => true;
  cs.readFlyer = async () => { const r = reads.shift(); return r ? { ok: true, text: r, event: r } : { ok: false }; };
  await t('Phoenix paints it; spelt right, it is kept and marked checked', async () => {
    calls.length = 0; reads = ['BREAK EVERY CHAIN'];
    const r = await fa.paintTitle({ scene: 'chains', title: 'Break Every Chain' });
    assert.ok(/phoenix/.test(calls[0]), calls.join());
    assert.ok(r.checked && r.spelt && /^data:image\/png/.test(r.dataUrl));
    assert.ok(/"Break Every Chain"/.test(r.prompt) && /ONLY text/.test(r.prompt));
  });
  await t('misspelt once: one more try, the second kept', async () => {
    calls.length = 0; reads = ['BRAEK EVRY CHAN', 'Break Every Chain'];
    const r = await fa.paintTitle({ scene: 'chains', title: 'Break Every Chain' });
    assert.strictEqual(calls.length, 2); assert.ok(r.spelt);
  });
  await t('misspelt twice: refused (the other designs stand)', async () => {
    reads = ['BRAEK', 'BREK EVRY'];
    await assert.rejects(fa.paintTitle({ scene: 'chains', title: 'Break Every Chain' }), /misspelt/);
  });
  await t('no vision model to read it: offered, marked unchecked', async () => {
    fs.writeFileSync(path.join(dir, 'flyer-kit', 'cf-allowance.json'), JSON.stringify({ day: new Date().toISOString().slice(0, 10), spent: 0 }));
    cs.ready = () => false;
    const r = await fa.paintTitle({ scene: 'x', title: 'Prayer Meeting' });
    assert.strictEqual(r.checked, false);
    cs.ready = () => true;
  });
  await t('a long title is not lettered by AI (it misspells long ones)', async () => {
    await assert.rejects(fa.paintTitle({ title: 'The Annual Youth Revival Conference Night' }), /four words/);
  });
  await t('never past the allowance: refused when the day is nearly used', async () => {
    fs.writeFileSync(path.join(dir, 'flyer-kit', 'cf-allowance.json'), JSON.stringify({ day: new Date().toISOString().slice(0, 10), spent: 7600 }));
    await assert.rejects(fa.paintTitle({ title: 'Prayer Meeting' }), /allowance/);
    assert.strictEqual(fa.status().lettering, false);
  });
  await t('Cloudflare says the day is used: the ledger knows it at once', async () => {
    fs.writeFileSync(path.join(dir, 'flyer-kit', 'cf-allowance.json'), JSON.stringify({ day: new Date().toISOString().slice(0, 10), spent: 0 }));
    global.fetch = async () => new Response('you have used up your daily free allocation of 10,000 neurons', { status: 429 });
    await assert.rejects(fa.paint({ scene: 'x', tier: 'premium' }).catch((e) => { throw e; }));
    assert.strictEqual(fa.status().allowanceLeft, 0);
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
