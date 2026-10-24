'use strict';
/*
 * FACES TOLD APART (faceprint.js) — "never the same person twice", by face, on the server:
 *   - the face is lined up where a face-print model expects it: a face turned and smaller, its eyes, nose and mouth
 *     land on the 112×112 places
 *   - two pictures are of one person when a face of one is like a face of the other (OpenCV's 0.363); a picture
 *     with no face tells nothing
 *   - not on this machine (no model) → not available, and nothing is asked
 *   node test/faceprint.test.js
 */
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, name, d) => { console.log((c ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !c ? '  -> ' + JSON.stringify(d) : '')); c ? pass++ : fail++; };

process.env.MW_FACE_MODEL = path.join(__dirname, 'no-such-model.onnx');
const fp = require('../src/main/faceprint');

// a face turned 20°, half the size, somewhere in a 400×300 picture: where its points are
const TPL = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [56.1396, 92.2848]];
const a = 20 * Math.PI / 180, k = 0.5, tx = 210, ty = 90;
const place = ([x, y]) => [k * (Math.cos(a) * x - Math.sin(a) * y) + tx, k * (Math.sin(a) * x + Math.cos(a) * y) + ty];
const pts = TPL.map(place);
const T = fp._similarity(pts, TPL);
const back = pts.map(([x, y]) => [T.ca * x - T.sb * y + T.tx, T.sb * x + T.ca * y + T.ty]);
ok(back.every((p, i) => Math.hypot(p[0] - TPL[i][0], p[1] - TPL[i][1]) < 1e-6), 'the turn, size and shift are found from the eyes, nose and mouth', back);

// the picture: a white dot at each point (on black); lined up, the dots are where the face-print model wants them
const W = 400, H = 300, rgb = new Uint8Array(W * H * 3);
for (const [x, y] of pts) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const o = ((Math.round(y) + dy) * W + Math.round(x) + dx) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = 255; }
const out = fp._align(rgb, W, H, { eyeR: pts[0], eyeL: pts[1], nose: pts[2], mouth: pts[3] });
const at = (x, y) => out[Math.round(y) * 112 + Math.round(x)];
ok(out.length === 3 * 112 * 112, 'the face comes out 112×112, in three planes');
ok(TPL.every(([x, y]) => at(x, y) > 60), 'its eyes, nose and mouth land on their places', TPL.map(([x, y]) => Math.round(at(x, y))));
ok(at(10, 10) === 0 && at(100, 20) === 0, 'and nothing else is lit');

// likeness: the closest pair of faces
const unit = (v) => { const n = Math.hypot(...v); return Float32Array.from(v, (x) => x / n); };
const host = unit([1, 0.2, 0, 0]), hostAgain = unit([0.9, 0.35, 0.1, 0]), singer = unit([0, 0, 1, 0.3]);
ok(fp.samePerson([singer, host], [hostAgain]), 'the host two hours on, beside someone else: the same person', fp.likeness([singer, host], [hostAgain]));
ok(!fp.samePerson([singer], [host]), 'two different people are not', fp.likeness([singer], [host]));
ok(!fp.samePerson([], [host]) && fp.likeness([], [host]) === -1, 'a picture with no face to tell by says nothing');
ok(fp.SAME > 0.3 && fp.SAME < 0.4, "OpenCV's own line for SFace", fp.SAME);

ok(!fp.available(), 'no model here: not available');
fp.printsAt('ffmpeg', 'x.mp4', 10, 0.5, 1280, 720).then((r) => {
  ok(Array.isArray(r) && r.length === 0, 'and asked anyway, it tells nothing (the montage goes on by what they wear)', r);
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
});
