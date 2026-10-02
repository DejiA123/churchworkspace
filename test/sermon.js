'use strict';
/*
 * WHICH REAL SERMON THE TESTS MEASURE AGAINST.
 *
 * A dozen suites and diagnostics had the same recording hard-coded by full
 * path. When that file was deleted they all failed with "No such file or
 * directory" — which looks exactly like a regression and is not one, and cost
 * a while to tell apart.
 *
 * So the path is resolved instead of assumed:
 *   1. $MW_SERMON, if it is set and exists — how to point a run at anything.
 *   2. argv[2], for the suites that already took a path as their first argument.
 *   3. The first candidate below that is actually on disk.
 *
 * Synthesised footage is NOT a substitute here. These suites exist because
 * testsrc2 is a pathological encode, a canvas can never be a stale frame, and
 * a made-up speaker is always centred — every one of those has hidden a real
 * bug in this app before. A suite with no real recording should SKIP and say so
 * loudly, not quietly pass on a fixture that cannot fail.
 */
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  'C:/Users/dejia/Videos/Church Work Space/ANTICIPATING SPIRITUAL WARFARE BY BISHOP DAVID RICHMAN.mp4',
  'C:/Users/dejia/Videos/Thanksgiving Sunday.mp4',
  'C:/Users/dejia/Videos/Pastor Mirella.mp4',
  'C:/Users/dejia/Videos/Word Study with Pastor David Richman.mp4',
];

const usable = (p) => {
  try { return !!p && fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024; } catch (e) { return false; }
};

/**
 * A real recording to measure against, or null.
 * `argvPath` is the suite's own first argument, when it takes one.
 */
function sermonPath(argvPath) {
  if (usable(process.env.MW_SERMON)) return process.env.MW_SERMON;
  if (usable(argvPath)) return argvPath;
  return CANDIDATES.find(usable) || null;
}

/** Say WHY there is nothing to measure, rather than failing on a missing file. */
function noSermon() {
  return '  SKIP — no real recording to measure against.\n'
    + '  Set MW_SERMON to a sermon video, or put one at any of:\n'
    + CANDIDATES.map((c) => '    ' + c).join('\n')
    + '\n  (These suites deliberately do not fall back to synthesised footage:\n'
    + '   testsrc2 is a pathological encode and a made-up speaker is always centred.)';
}

module.exports = { sermonPath, noSermon, CANDIDATES, usable };
