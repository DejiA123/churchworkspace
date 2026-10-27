'use strict';
/*
 * NO ONE TWICE IN A MONTAGE (montage.js onePerson) — "the same person from the clip is appearing twice; I want
 * different varieties":
 *   - two clear faces decide: alike, one person; unlike, two
 *   - a face that cannot be told (side on, too small, none) never makes someone "new" on a guess: one video within
 *     ten minutes, or the same top, is one person; only clearly other clothes further on are two
 *   - nothing to go by at all: one person
 *   node test/montage-people.test.js
 */
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, name, d) => { console.log((c ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !c ? '  -> ' + JSON.stringify(d) : '')); c ? pass++ : fail++; };
process.env.MW_FACE_MODEL = path.join(__dirname, 'no-such-model.onnx');
const fp = require('../src/main/faceprint');
const mt = require('../src/main/montage');
const unit = (v) => { const n = Math.hypot(...v); return Float32Array.from(v, (x) => x / n); };
const face = (v, q) => Object.assign(unit(v), { q });
const front = { eyes: 30, turn: 0.1, s: 0.9 }, side = { eyes: 30, turn: 0.7, s: 0.8 };
// a top: all its colour in one bin (or spread over two)
const top = (bins) => { const h = new Array(216).fill(0); bins.forEach((b) => { h[b] += 1 / bins.length; }); return h; };
const navy = top([10]), navyToo = top([10, 11]), red = top([200]);
const at = (min, faces, tp) => ({ vid: 0, t: min * 60, faces, top: tp || null });

const host = face([1, 0.1, 0, 0], front), hostSide = face([0.1, 1, 0.2, 0], side), singer = face([0.1, 0, 1, 0], front);
ok(mt._onePerson(at(10, [host]), at(130, [face([1, 0.3, 0.1, 0], front)]), fp) === true, 'the host two hours on, clear faces alike: one person');
ok(mt._onePerson(at(10, [host]), at(12, [singer]), fp) === false, 'two clear faces unlike, two minutes apart: two people');
ok(mt._onePerson(at(136, [host], navy), at(140, [hostSide], navy), fp) === true, 'the man in the navy jumper side on four minutes later: one person (his face side on says nothing)');
ok(mt._onePerson(at(136, [host], navy), at(156, [hostSide], navyToo), fp) === true, '…twenty minutes later, in the same top: one person');
ok(mt._onePerson(at(136, [host], navy), at(180, [hostSide], red), fp) === false, '…someone side on in clearly other clothes, far on: two people');
ok(mt._onePerson(at(50, []), at(150, []), fp) === true, 'nothing to go by at all: taken as one person, never as someone new');
// minutes apart, faces must be plainly unlike: the singer at 60.7 and 62 min, small and side on, read as two people
const singerA = face([1, 0, 0, 0], front), singerB = face([0.24, 0.97, 0, 0], front);
ok(fp.judge([singerA], [singerB]) === false && mt._onePerson(at(60.7, [singerA]), at(62, [singerB]), fp) === true, 'a minute apart, faces only somewhat unlike (0.2+): one person', fp.alikeClear([singerA], [singerB]));
ok(mt._onePerson(at(60.7, [singerA]), at(90, [singerB]), fp) === false, 'half an hour apart, the faces decide');
ok(fp.judge([hostSide], [host]) === null, '(the face side on cannot be told by face)');
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
