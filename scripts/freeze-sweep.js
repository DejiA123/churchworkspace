'use strict';
/*
 * EVERY FREEZE TEST, RUN SO THE NUMBERS MEAN SOMETHING.
 *
 *   npm run test:freeze-all
 *
 * These suites measure main-thread lateness on a two-core laptop, which makes
 * them honest about real freezes and extremely easy to lie to. Two ways they
 * have already produced confident wrong answers, both handled here:
 *
 *   LEFTOVER PROCESSES. A suite that did not exit leaves a compositor running
 *     at full tilt. golive-freeze reported a fade "stalling the desk for 295 ms"
 *     with five stale copies of the app alive; the identical code measured
 *     37 ms once they were killed. So every suite is preceded by a kill and a
 *     pause, and one is run AT A TIME — two in parallel is enough to fail both.
 *
 *   THE PASS COUNT MOVING between runs of unchanged code is the tell that the
 *     machine, not the app, is being measured. This prints every count so that
 *     is visible, and re-running is the first thing to do before believing a
 *     FAIL.
 *
 * Anything that fails is printed with its line, because "24 PASS / 3 FAIL" on
 * its own is not something anybody can act on.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* The real executable, not the .bin shim. The shim is a .cmd on Windows, which
 * needs a shell to run — and this repo lives under "App Development", so the
 * space in the path then eats the command and every suite reports NO RESULT. */
const ELECTRON = require('electron');

const SUITES = [
  ['present-freeze', 'the Presentation studio — typing, cueing, a two-hour service'],
  ['golive-freeze', 'the switcher — cuts, fades, faders, 200 cuts in a row'],
  ['video-freeze', 'the Video studio — a 90-minute sermon, splits, seeks'],
  ['all-studios-freeze', 'all of them loaded at once, which is what a Sunday is'],
  ['onair-freeze', 'recording and streaming while the desk is driven'],
  ['analyze-block', 'analysing a real 46-minute recording'],
  ['screens-songbank-freeze', 'the projector watchdog and the Songs Bank'],
];

function killStrays() {
  if (process.platform !== 'win32') return;
  spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-Process -Name 'Church Work Space' -ErrorAction SilentlyContinue | Stop-Process -Force"],
  { stdio: 'ignore' });
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const suites = only.length ? SUITES.filter(([n]) => only.some((o) => n.includes(o))) : SUITES;

console.log('== FREEZE SWEEP — ' + suites.length + ' suite(s), one at a time ==\n');
const results = [];
for (const [name, what] of suites) {
  killStrays();
  sleep(5000);                       // let the OS actually reclaim them
  process.stdout.write('  running ' + name + ' … ');
  const r = spawnSync(ELECTRON, [path.join('test', name + '.test.js')],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 480000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.error) console.log('\n      (could not start: ' + r.error.message + ')');
  const tally = (out.match(/^ {2}(\d+) PASS \/ (\d+) FAIL$/m) || []).slice(1).map(Number);
  const fails = out.split('\n').filter((l) => /^ {2}FAIL /.test(l));
  const [p, f] = tally.length ? tally : [0, 0];
  results.push({ name, what, pass: p, fail: f, fails, ran: !!tally.length });
  console.log(tally.length ? `${p} PASS / ${f} FAIL` : 'NO RESULT (crashed or timed out)');
  for (const line of fails) console.log('      ' + line.trim());
}
killStrays();

console.log('\n== SUMMARY ==');
let totP = 0, totF = 0, broken = 0;
for (const r of results) {
  totP += r.pass; totF += r.fail;
  if (!r.ran) broken++;
  const state = !r.ran ? 'DID NOT RUN' : r.fail ? r.fail + ' FAILED' : 'clean';
  console.log(`  ${state.padEnd(12)} ${r.name.padEnd(26)} ${r.what}`);
}
console.log(`\n  ${totP} checks passed, ${totF} failed` + (broken ? `, ${broken} suite(s) did not run` : ''));
if (totF || broken) {
  console.log('\n  Before treating any of that as a regression: check nothing else is running');
  console.log('  (Get-Process "Church Work Space") and run the sweep again. A pass count');
  console.log('  that moves without a code change is the machine talking, not the app.');
}
process.exit(totF || broken ? 1 : 0);
