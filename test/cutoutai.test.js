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

// ►► ONLY WHAT IS THEM — a body from the pose (33 points), and what stands in front of them
{
  const W2 = 600, H2 = 1000;
  // a man standing: head at the top, shoulders 0.2 of the width apart, hands at the waist, feet at the bottom
  const pt = (x, y) => ({ x: x / W2, y: y / H2, v: 0.99 });
  const lm = Array.from({ length: 33 }, () => pt(300, 120));
  Object.assign(lm, { 0: pt(300, 120), 7: pt(275, 115), 8: pt(325, 115), 11: pt(240, 220), 12: pt(360, 220), 13: pt(225, 380), 14: pt(375, 380),
    15: pt(230, 520), 16: pt(370, 520), 17: pt(232, 545), 18: pt(368, 545), 19: pt(235, 550), 20: pt(365, 550), 21: pt(245, 535), 22: pt(355, 535),
    23: pt(260, 520), 24: pt(340, 520), 25: pt(262, 720), 26: pt(338, 720), 27: pt(265, 920), 28: pt(335, 920), 29: pt(258, 940), 30: pt(342, 940), 31: pt(285, 950), 32: pt(315, 950) });
  const body = () => { const m = Buffer.alloc(W2 * H2); const r = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W2 + x] = 255; };
    r(270, 70, 330, 170); r(230, 200, 370, 520); r(210, 210, 240, 540); r(360, 210, 390, 540); r(250, 520, 350, 950); return m; };
  const at2 = (m, x, y) => m[y * W2 + x];
  const plain = body();
  const t1 = c.tidyMask(plain, W2, H2, lm);
  ok(t1.waistUp == null && at2(plain, 300, 900) > 200 && at2(plain, 300, 300) > 200 && at2(plain, 300, 100) > 200, 'nothing in front of him: all of him, head to feet', t1);
  const chair = body(); for (let y = 560; y < 700; y++) for (let x = 60; x < 250; x++) chair[y * W2 + x] = 255;   // a chair against his leg
  const t2 = c.tidyMask(chair, W2, H2, lm);
  ok(at2(chair, 90, 600) === 0 && at2(chair, 300, 300) > 200, 'a chair at his side goes; he stays', t2);
  const lectern = body(); for (let y = 600; y < 1000; y++) for (let x = 150; x < 450; x++) lectern[y * W2 + x] = 255;   // a lectern in front of his legs
  const lectern2 = Uint8Array.from(lectern);
  const t3 = c.tidyMask(lectern, W2, H2, lm);
  ok(t3.waistUp != null && at2(lectern, 300, 950) > 200 && at2(lectern, 300, 300) > 200 && at2(lectern, 300, 100) > 200, 'a lectern in front of him: found, and all of him kept, head to feet (no line across his chest)', t3);
  const t4 = c.tidyMask(lectern2, W2, H2, lm, { waistUp: true });
  ok(t4.waistUp != null && at2(lectern2, 300, 950) === 0 && at2(lectern2, 300, 300) > 200 && at2(lectern2, 300, 100) > 200, 'asked for: him from the waist up, faded out above it', t4);
  ok(c.tidyMask(body(), W2, H2, null).waistUp == null, 'no pose from the phone: the mask as the model made it');
  ok(c.bodyGate([{ x: 0.5 }], W2, H2, 10, 10) === null, 'a pose that is not one: no gate');
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
