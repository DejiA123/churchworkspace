'use strict';
/*
 * THE SERVER'S CUT-OUT (cutoutai.js) — the tidying of the model's mask:
 *   - only the person (the one large shape) is kept: a speck of smoke or a logo letter apart from them goes
 *   - a pin-hole in them is filled; a real gap (between an arm and the body) stays open
 *   node test/cutoutai.test.js
 */
const c = require('../src/main/cutoutai');
let pass = 0, fail = 0;
const ok = (cond, name, d) => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !cond ? '  -> ' + JSON.stringify(d) : '')); cond ? pass++ : fail++; };

const W = 400, H = 600;
const mask = Buffer.alloc(W * H);
const rect = (x0, y0, x1, y1, v) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * W + x] = v; };
rect(120, 60, 280, 580, 255);      // the person
rect(40, 200, 120, 230, 255);      // an arm out to the side, joined on
rect(190, 300, 194, 304, 0);       // a pin-hole in the jacket
rect(200, 400, 260, 470, 0);       // a real gap (larger: between an arm and the body)
rect(10, 10, 40, 40, 255);         // a speck of stage smoke, apart
rect(330, 500, 360, 540, 255);     // a logo letter, apart
const kp = c.keepPerson(mask, W, H);
const at = (x, y) => kp.keep[Math.min(kp.gh - 1, Math.floor(y * kp.sc)) * kp.gw + Math.min(kp.gw - 1, Math.floor(x * kp.sc))];
ok(kp && kp.specks === 2, 'two shapes apart from the person are found', kp && kp.specks);
ok(at(200, 100) === 1 && at(60, 215) === 1, 'the person is kept, the arm joined to them too');
ok(at(25, 25) === 0 && at(345, 520) === 0, 'the speck of smoke and the logo letter go');
ok(at(192, 302) === 1 && kp.filled[Math.floor(302 * kp.sc) * kp.gw + Math.floor(192 * kp.sc)] === 1, 'a pin-hole in them is filled');
ok(at(230, 435) === 0, 'a real gap stays open (the background between an arm and the body)');
ok(c.keepPerson(Buffer.alloc(W * H), W, H) === null, 'nobody in it: nothing to keep');
ok(/BiRefNet-portrait/.test(c.MODEL_NAME) && /github\.com\/danielgatis\/rembg\/releases/.test(c.MODEL_URL), 'the model: BiRefNet portrait (MIT), as rembg publishes it');
const st = c.status();
ok(typeof st.available === 'boolean' && typeof st.model === 'boolean', 'it says whether it can cut out here', st);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
