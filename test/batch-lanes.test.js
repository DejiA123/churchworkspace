'use strict';
process.env.MW_CLOUD_SERVER = '1';
const fs = require('fs'), os = require('os'), path = require('path');
const rpc = require('../src/main/rpc');
const batch = require('../src/main/batch');
const jobs = require('../src/main/jobs');
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
let live = 0, peak = 0, order = [];
const fakeStep = (ms) => async (e, args) => jobs.run(args.jobId, async () => {
  live++; peak = Math.max(peak, live); order.push('start:' + args.label);
  try {
    for (let i = 0; i < 10; i++) {
      if (jobs.isCancelled()) throw new jobs.CancelledError();
      await new Promise((r) => setTimeout(r, ms / 10));
      e.sender.send('job:progress', { jobId: args.jobId, percent: (i + 1) * 10 });
    }
    return { ok: true, data: '/tmp/out-' + args.label + '.mp4' };
  } catch (err) { return err.cancelled ? { ok: false, cancelled: true, error: 'Cancelled' } : { ok: false, error: err.message }; }
  finally { live--; order.push('end:' + args.label); }
});
rpc.registry.set('sermon:exportShort', fakeStep(300));
rpc.registry.set('captions:burnTrack', fakeStep(150));
batch.init(fs.mkdtempSync(path.join(os.tmpdir(), 'mw-batch-lanes-')));
const steps = (l) => [{ channel: 'sermon:exportShort', args: { label: l } }, { channel: 'captions:burnTrack', args: { input: '@@step-0@@', label: l + 'c' } }];
(async () => {
  const b = batch.open({ label: 'Exporting 5 shorts', total: 5 });
  for (let i = 1; i <= 5; i++) batch.add({ id: b.id, label: 'S' + i, steps: steps('S' + i) });
  batch.seal({ id: b.id });
  await new Promise((r) => setTimeout(r, 200));
  let s = batch.list().find((x) => x.id === b.id);
  check('two shorts run at once on a 4-core server', s.items.filter((x) => x.state === 'running').length === 2, JSON.stringify(s.items.map((x) => x.state)));
  check('the batch % counts both', s.pct > 0, s.pct + '%');
  const t0 = Date.now();
  while (batch.list().find((x) => x.id === b.id).state === 'running' && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
  s = batch.list().find((x) => x.id === b.id);
  check('all five made', s.done === 5 && s.state === 'done', JSON.stringify({ done: s.done, state: s.state }));
  check('never more than two steps at once', peak === 2, 'peak ' + peak);
  check('finished time set', !!s.finishedAt);
  check('every output is its own short', new Set(s.items.map((x) => x.output)).size === 5, JSON.stringify(s.items.map((x) => x.output)));
  check('lanes released', batch._batches.get(b.id).lanes === 0 && batch._batches.get(b.id).running === false);
  // cancel mid-way
  peak = 0;
  const c = batch.open({ label: 'Cancel me', total: 4 });
  for (let i = 1; i <= 4; i++) batch.add({ id: c.id, label: 'C' + i, steps: steps('C' + i) });
  await new Promise((r) => setTimeout(r, 120));
  batch.cancel({ id: c.id });
  await new Promise((r) => setTimeout(r, 800));
  s = batch.list().find((x) => x.id === c.id);
  check('Stop stops both running shorts and the queued ones', s.state === 'cancelled' && s.items.every((x) => x.state === 'cancelled'), JSON.stringify(s.items.map((x) => x.state)));
  check('nothing still running after Stop', live === 0, 'live ' + live);
  // one lane when forced
  process.env.MW_BATCH_LANES = '1'; peak = 0;
  const d = batch.open({ label: 'one lane', total: 3 });
  for (let i = 1; i <= 3; i++) batch.add({ id: d.id, label: 'D' + i, steps: steps('D' + i) });
  batch.seal({ id: d.id });
  const t1 = Date.now();
  while (batch.list().find((x) => x.id === d.id).state === 'running' && Date.now() - t1 < 10000) await new Promise((r) => setTimeout(r, 50));
  check('MW_BATCH_LANES=1 keeps one at a time', peak === 1, 'peak ' + peak);
  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})();
