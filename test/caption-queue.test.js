'use strict';
/*
 * TAKING TURNS (fairqueue.js) — many people captioning at once on one server.
 *   [1] only `slots` run at a time; the rest wait instead of failing
 *   [2] turns go round the PEOPLE: one person's 14 shorts never lock out the next person
 *   [3] a waiting job is told its place in the line, and told when it starts
 *   [4] cancelled while waiting: it leaves the line, the others move up
 *   [5] a job started from another job's turn still runs as itself (cancel, owner)
 *   [6] a failing job frees its turn
 *
 *   node test/caption-queue.test.js
 */
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const fq = require(path.join(__dirname, '..', 'src/main/fairqueue'));
let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${m}${d != null && !c ? '  -> ' + JSON.stringify(d) : ''}`); };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n[1]-[3] two at a time, round the people');
  {
    const q = fq.create({ slots: 2 });
    const order = [], gates = {}, waits = {};
    const job = (who, n) => q.run(who, async () => { order.push(who + n); await new Promise((r) => { gates[who + n] = r; }); return who + n; },
      { onWait: (k) => { (waits[who + n] = waits[who + n] || []).push(k); } });
    // Ann sends 4 shorts, then Ben 1 and Cal 1
    const all = [job('ann', 1), job('ann', 2), job('ann', 3), job('ann', 4)];
    await tick();
    all.push(job('ben', 1), job('cal', 1));
    await tick();
    ok(order.join() === 'ann1,ann2' && q.state().running === 2 && q.state().waiting === 4, 'two run, four wait', { order, st: q.state() });
    ok(waits.ben1.slice(-1)[0] === 1 && waits.cal1.slice(-1)[0] === 2 && waits.ann3.slice(-1)[0] === 3, 'Ben is next, then Cal, then Ann\'s third', waits);
    gates.ann1(); await tick();
    ok(order[2] === 'ben1', 'a slot frees: Ben goes before Ann\'s third short', order);
    ok(waits.ben1.slice(-1)[0] === 0 && waits.cal1.slice(-1)[0] === 1, 'Ben is told he started; Cal is now next', waits);
    gates.ann2(); await tick();
    ok(order[3] === 'cal1', '…then Cal', order);
    gates.ben1(); gates.cal1(); await tick();
    gates.ann3 && gates.ann3(); await tick(); gates.ann4 && gates.ann4();
    const res = await Promise.all(all);
    ok(res.join() === 'ann1,ann2,ann3,ann4,ben1,cal1' && order.join() === 'ann1,ann2,ben1,cal1,ann3,ann4', 'everyone gets their answer', { res, order });
  }

  console.log('\n[4] cancelled while waiting');
  {
    const cancelled = new Set();
    const q = fq.create({ slots: 1, isCancelled: (id) => cancelled.has(id) });
    let open;
    const a = q.run('ann', () => new Promise((r) => { open = r; }), { jobId: 'a' });
    const seen = [];
    const b = q.run('ben', async () => 'b', { jobId: 'b' });
    const c = q.run('cal', async () => 'c', { jobId: 'c', onWait: (n) => seen.push(n) });
    await tick();
    cancelled.add('b');
    let why = null;
    try { await b; } catch (e) { why = e; }
    await tick();
    ok(why && why.cancelled, 'the cancelled job leaves the line as Cancelled', why && why.message);
    ok(seen.join() === '2,1', 'the one behind it moves up', seen);
    open('a');
    const ra = await a, rc = await c; await tick();
    ok(ra === 'a' && rc === 'c' && q.state().running === 0 && q.state().waiting === 0, 'the rest finish; the line is empty', q.state());
  }

  console.log('\n[5] each job runs as itself');
  {
    const als = new AsyncLocalStorage();
    const q = fq.create({ slots: 1 });
    let open;
    const first = als.run('job-ann', () => q.run('ann', () => new Promise((r) => { open = r; })));
    const told = [];
    const second = als.run('job-ben', () => q.run('ben', async () => { await tick(1); return als.getStore(); }, { onWait: () => told.push(als.getStore()) }));
    await tick();
    open();     // Ben starts from the end of Ann's turn
    await first;
    ok(await second === 'job-ben', 'started from Ann\'s finished turn, Ben\'s job still sees itself (so cancel and his space work)', await second);
    ok(told.length >= 2 && told.every((s) => s === 'job-ben'), 'the "waiting" news goes to Ben\'s space, not to Ann\'s', told);
  }

  console.log('\n[6] a failure frees the turn');
  {
    const q = fq.create({ slots: 1 });
    const a = q.run('ann', async () => { throw new Error('no speech'); });
    const b = q.run('ben', async () => 'b');
    let err = null; try { await a; } catch (e) { err = e; }
    ok(err && err.message === 'no speech' && await b === 'b', 'Ann\'s error is hers; Ben still runs');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
