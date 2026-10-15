'use strict';
/*
 * ONE FREE CLOUDFLARE ALLOWANCE, A WHOLE CHURCH (flyerart.js, aibudget.js,
 * flyerbank.js) — no network: Cloudflare's answers and the vision model's
 * reading are stood in for, and the clock is set (19:00 UTC: the day mostly released).
 *   [A] reservations, pacing, a share each — and the kit's save never wipes the ledger
 *   [B] a hundred people at once: never past the day, nobody left without pictures
 *   [C] the church library: painted once, handed to the next person (not twice to the same one)
 *   [D] AI lettering: fresh while the day allows, verified ones kept and shared
 *   [E] Cloudflare's answers: the daily cap (and one heard just after midnight), gateway errors, restarts
 *   node test/flyer-free-ai.test.js
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); } };

(async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'; process.env.CLOUDFLARE_API_TOKEN = 'tok';
  delete process.env.CLOUDFLARE_PAID; delete process.env.POLLINATIONS_API_KEY; delete process.env.CLOUDFLARE_PER_PERSON;
  const fa = require('../src/main/flyerart.js');
  const budget = require('../src/main/aibudget.js');
  const bank = require('../src/main/flyerbank.js');
  const space = require('../src/main/space.js');
  const cs = require('../src/main/cloudsee.js');
  const NOW = Date.parse('2026-10-15T19:00:00Z');
  budget._clock(() => NOW);
  let dir;
  const fresh = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-freeai-'));
    budget._reset(); bank._reset(); fa.init(dir);
  };
  const as = (who, fn) => space.run(null, fn, who);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(9000, 7)]);
  const calls = [];
  let delay = 0, answer = null;
  global.fetch = async (url, opts) => {
    calls.push(String(url).split('/ai/run/')[1] || String(url));
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (answer) return answer(url, opts);
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const ev = { title: 'Prayer Meeting', kind: 'Prayer meeting' };
  const board = (who, extra = {}) => as(who, () => Promise.all([0, 1, 2, 3].map((i) => fa.paint(Object.assign({ scene: 'light ' + i, slot: i, tone: ['own', 'blue', 'red', 'teal'][i], event: ev, tier: i < 2 ? 'premium' : 'normal' }, extra)).catch((e) => ({ error: e.message })))));

  console.log('[A] the allowance: reserved first, paced, a share each');
  fresh();
  await t('prices are Cloudflare’s (a 1024x1280 post is six tiles)', () => {
    const post = fa.sizeFor(1080, 1350);
    assert.deepStrictEqual(post, { w: 1024, h: 1280 });
    assert.strictEqual(fa.neuronsFor({ id: 'flux-2-klein-4b' }, post), 157);
    assert.strictEqual(fa.neuronsFor({ id: 'phoenix-1.0' }, { w: 832, h: 1024 }), 2370);
    assert.strictEqual(fa.neuronsFor({ id: 'flux-1-schnell' }, post), 96);
    const k9 = fa.neuronsFor({ id: 'flux-2-klein-9b' }, post); assert.ok(k9 > 1430 && k9 < 1500, k9);
  });
  await t('the kit’s save never wipes the day’s spend (it used to, every board)', async () => {
    const tk = budget.reserve(1000, 'a'); budget.settle(tk);
    fa.kitSave({ church: 'X' });
    assert.strictEqual(budget.report('a').spent, 1000);
    assert.ok(fs.existsSync(budget.file()));
  });
  await t('reservations: a hundred asking at once get only what the day holds', () => {
    fresh();
    const can = Math.floor(budget.available() / 1500);
    let granted = 0; for (let i = 0; i < 100; i++) if (budget.reserve(1500, 'p' + i)) granted++;
    assert.strictEqual(granted, can);   // what the day holds by now (9,500 at most: the 500 margin is never spent)
    assert.ok(budget.report('x').reserved <= 9500);
  });
  await t('paced: early in the day only part of it is out', () => {
    fresh();
    budget._clock(() => Date.parse('2026-10-15T06:00:00Z'));
    const a = budget.available(); assert.ok(a > 1500 && a < 2700, a);
    budget._clock(() => NOW);
  });
  await t('a share each: with others at it, one person cannot take the day', () => {
    fresh();
    budget.touch('b'); budget.touch('c');
    let got = 0; while (budget.reserve(157, 'a')) got += 157;
    assert.ok(got <= 3000 && got >= 2800, got);
    assert.ok(budget.reserve(157, 'b'), 'the others still can');
  });

  console.log('\n[B] a hundred people making the same flyer at once');
  await t('never past the day; every picture answered (fresh, or the library’s)', async () => {
    fresh(); calls.length = 0; delay = 15;
    const people = Array.from({ length: 100 }, (_, i) => 'u' + i);
    const boards = await Promise.all(people.map((p) => board(p)));
    delay = 0;
    const all = boards.flat(), answered = all.filter((x) => x && (x.file || x.dataUrl)).length;
    const r = budget.report('u0');
    assert.ok(r.spent + r.reserved <= 9500, JSON.stringify(r));
    assert.ok(answered >= all.length * 0.95, answered + ' of ' + all.length);
    assert.ok(calls.length < 120, calls.length + ' Cloudflare calls for 400 pictures');
    // nobody got the same picture twice on one board
    for (const b of boards) { const ids = b.map((x) => x.file).filter(Boolean); assert.strictEqual(new Set(ids).size, ids.length); }
  });

  console.log('\n[C] the church library');
  await t('painted for one, handed to the next — free, and never twice to the same person', async () => {
    fresh(); calls.length = 0;
    // the day is busy (limited): the library comes first
    budget.settle(budget.reserve(7500, 'library', { person: false }));
    const a = await as('anna', () => fa.paint({ scene: 'light', slot: 1, tone: 'blue', event: ev }));
    assert.ok(a.fresh && a.file, 'painted fresh for the first');
    const n = calls.length;
    const b = await as('ben', () => fa.paint({ scene: 'light', slot: 1, tone: 'blue', event: ev }));
    assert.strictEqual(calls.length, n, 'no Cloudflare call');
    assert.ok(b.bank && b.file === a.file);
    const b2 = await as('ben', () => fa.paint({ scene: 'light', slot: 1, tone: 'blue', event: ev }));
    assert.notStrictEqual(b2.file, a.file, 'not the same one again');
  });
  await t('an Easter picture never goes on a prayer-meeting flyer', async () => {
    const e = await as('cara', () => fa.paint({ scene: 'sunrise', slot: 1, tone: 'gold', event: { title: 'Easter Sunday' } }));
    const p = await as('dan', () => fa.paint({ scene: 'x', slot: 1, tone: 'gold', event: ev }).catch(() => null));
    assert.ok(!p || p.file !== e.file);
  });
  await t('a board with the minister’s photo never gets a picture painted without room for them', async () => {
    fresh();
    budget.settle(budget.reserve(7500, 'library', { person: false }));
    const np = await as('eve', () => fa.paint({ scene: 'x', slot: 1, tone: 'blue', event: ev, people: false }));
    const withP = await as('finn', () => fa.paint({ scene: 'x', slot: 1, tone: 'blue', event: ev, people: true }));
    assert.notStrictEqual(withP.file, np.file);
  });
  await t('the owner sees the library and can take a picture off the shelf; nobody else can', async () => {
    const view = space.run(null, () => fa.libraryView(), 'owner1', true);
    assert.ok(view.pictures.length >= 1 && view.allowance && view.allowance.cloudflare);
    assert.throws(() => space.run(null, () => fa.libraryView(), 'member1', false), /owner/);
    assert.throws(() => space.run(null, () => fa.libraryRemove({ id: view.pictures[0].id }), 'member1', false), /owner/);
    const gone = view.pictures[0];
    assert.ok(space.run(null, () => fa.libraryRemove({ id: gone.id }), 'owner1', true).ok);
    assert.ok(!space.run(null, () => fa.libraryView(), 'owner1', true).pictures.some((x) => x.id === gone.id));
    assert.strictEqual(fa.libraryPath(gone.file), '');
  });
  await t('the library’s pictures are served by name, from its folder only', () => {
    const f = fs.readdirSync(path.join(dir, 'flyer-library')).find((n) => /\.png$/.test(n));
    assert.ok(fa.libraryPath(f));
    assert.strictEqual(fa.libraryPath('../flyer-ai/cf-allowance.json'), '');
  });

  console.log('\n[D] AI lettering');
  let reads = [];
  cs.ready = () => true;
  cs.readFlyer = async () => { const r = reads.shift(); if (!r) return { ok: false }; const dark = /^DARK:/.test(r); const tx = r.replace(/^DARK:/, ''); return { ok: true, text: tx, event: tx, legible: !dark }; };
  await t('read back right: kept, and the next person gets it without a painting', async () => {
    fresh(); calls.length = 0; reads = ['PRAYER MEETING'];
    const a = await as('anna', () => fa.paintTitle({ scene: 'x', title: 'Prayer Meeting' }));
    assert.ok(a.checked && a.spelt && a.file && /phoenix/.test(calls[0]));
    const n = calls.length;
    const b = await as('ben', () => fa.paintTitle({ scene: 'x', title: 'Prayer meeting!' }));
    assert.strictEqual(calls.length, n); assert.ok(b.bank && b.file === a.file);
  });
  await t('misspelt once: one more try (within the day), the second kept', async () => {
    fresh(); calls.length = 0; reads = ['BRAEK EVRY CHAN', 'Break Every Chain'];
    const r = await as('anna', () => fa.paintTitle({ scene: 'chains', title: 'Break Every Chain' }));
    assert.strictEqual(calls.length, 2); assert.ok(r.spelt);
  });
  await t('hard to read twice: not offered, and never kept for others', async () => {
    fresh(); reads = ['DARK:PRAYER MEETING', 'DARK:PRAYER MEETING'];
    await assert.rejects(as('anna', () => fa.paintTitle({ scene: 'x', title: 'Prayer Meeting' })), /hard to read twice/);
    assert.strictEqual(bank.report().letterings, 0);
  });
  await t('no reader to check it: offered to this person, never kept for others', async () => {
    fresh(); cs.ready = () => false;
    const r = await as('anna', () => fa.paintTitle({ scene: 'x', title: 'Prayer Meeting' }));
    assert.strictEqual(r.checked, false); assert.ok(r.dataUrl);
    assert.strictEqual(bank.report().letterings, 0);
    cs.ready = () => true;
  });
  await t('the day spent and nothing in the library: refused at once, no Cloudflare call', async () => {
    fresh(); calls.length = 0;
    budget.settle(budget.reserve(9400, 'library', { person: false, paced: false }));
    await assert.rejects(as('anna', () => fa.paintTitle({ title: 'Prayer Meeting' })), /resting/);
    assert.strictEqual(calls.length, 0);
  });

  console.log('\n[E] Cloudflare’s answers');
  await t('“daily free allocation used”: the day is spent at once', async () => {
    fresh();
    answer = () => new Response('3036: you have used up your daily free allocation of 10,000 neurons', { status: 429 });
    await as('anna', () => fa.paint({ scene: 'x', slot: 1, event: ev })).catch(() => null);
    answer = null;
    assert.strictEqual(budget.hardLeft(), 0);
  });
  await t('…but heard for a call booked yesterday, it does not empty the new day', () => {
    fresh();
    budget._clock(() => Date.parse('2026-10-14T23:59:50Z'));
    const tk = budget.reserve(157, 'anna');
    budget._clock(() => Date.parse('2026-10-15T00:00:05Z'));
    budget.exhaust(tk); budget.settle(tk);
    assert.ok(budget.hardLeft() > 9000, budget.hardLeft());
    budget._clock(() => NOW);
  });
  await t('a gateway error (502) costs nothing; a 500 is counted', async () => {
    fresh();
    answer = () => new Response('bad gateway', { status: 502 });
    await as('anna', () => fa.paint({ scene: 'x', slot: 1, event: ev })).catch(() => null);
    assert.strictEqual(budget.report('anna').spent, 0);
    answer = () => new Response('oops', { status: 500 });
    await as('ben', () => fa.paint({ scene: 'x', slot: 2, event: ev })).catch(() => null);
    answer = null;
    assert.ok(budget.report('ben').spent > 0);
  });
  await t('a restart in the middle of a rush counts what was in flight as spent', () => {
    fresh();
    budget.reserve(2370, 'anna');   // open when the server stopped
    budget._reset();                 // a new process reads the ledger
    assert.ok(budget.report('x').spent >= 2370);
  });
  await t('a ledger that cannot be read is closed, not a new full day', () => {
    fresh();
    fs.writeFileSync(budget.file(), '{"day":"2026-10-15","sp'); try { fs.unlinkSync(budget.file() + '.bak'); } catch (e) { /* none */ }
    budget._reset();
    assert.ok(budget.report('x').spent > 5000);
  });
  await t('a long title is not lettered by AI (it misspells long ones)', async () => {
    await assert.rejects(fa.paintTitle({ title: 'The Annual Youth Revival Conference Night' }), /four words/);
  });

  bank.flush();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
