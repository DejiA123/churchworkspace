'use strict';
/*
 * A batch whose phone stopped handing shorts over (closed, locked, flat
 * battery) sat at "Preparing on your phone… 0 of 18" for ever. After 30
 * minutes with nothing to run and nothing new, it is closed, says how many of
 * the planned shorts were sent, and keeps whatever was made.
 *
 *   node test/batch-stall.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const batch = require('../src/main/batch');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

batch.init(fs.mkdtempSync(path.join(os.tmpdir(), 'mw-batch-stall-')));
const a = batch.open({ label: 'Exporting 18 shorts', total: 18 });
check('a new batch is running, waiting for the phone', a.state === 'running' && a.received === 0);

skew = 10 * 60e3;
let now = batch.list().find((x) => x.id === a.id);
check('ten minutes on, it is still waiting (the phone may be tracking a long short)', now.state === 'running' && !now.stalled);

skew = 31 * 60e3;
now = batch.list().find((x) => x.id === a.id);
check('half an hour with nothing sent: closed, not left at 0% for ever', now.state !== 'running', now.state);
check('…and it says the phone stopped before sending its shorts', !!now.stalled && now.stalled.planned === 18 && now.stalled.sent === 0, JSON.stringify(now.stalled));

const c = batch.open({ label: 'Cancelled one', total: 3 });
batch.cancel({ id: c.id });
skew += 31 * 60e3;
now = batch.list().find((x) => x.id === c.id);
check('a batch someone stopped stays "stopped", not "stalled"', now.state === 'cancelled' && !now.stalled);

Date.now = realNow;
console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
process.exit(fail ? 1 : 0);
