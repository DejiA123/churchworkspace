'use strict';
/*
 * THE VIRAL MONTAGE'S MOMENTS (montage.js) — what a 3¾-hour event (Gospel
 * Jamz Day 1) taught it:
 *   - only whole thoughts are candidates ("…give them your card, and they" is not; "He started it in you." is)
 *   - the same line said three times is kept once
 *   - a long event's candidates come from all of it, not its loudest half hour
 *   - no moment (a run of lines from one stretch) goes on past 14 s
 *   - the giving, bank details and QR codes are never used
 *   - a slide (a picture that does not move) and a dark stage are told apart from a speaker
 *   node test/montage-moments.test.js
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const m = require('../src/main/montage');
let pass = 0, fail = 0;
const ok = (c, name, d) => { console.log((c ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !c ? '  -> ' + JSON.stringify(d) : '')); c ? pass++ : fail++; };
const P = (text, start, end, extra) => Object.assign({ text, start, end, vid: 1, score: 1, words: text.split(' ') }, extra || {});
(async () => {
  ok(m.wholeThought(P('He will finish the work he started in you.', 0, 3)) && m.wholeThought(P('The joy of the Lord is your strength.', 0, 3))
    && m.wholeThought(P('Faith is the substance of things hoped for.', 0, 3)), 'whole thoughts are kept (ending in "you", "for"; starting with "The")');
  ok(!m.wholeThought(P('so you give them your card, and they', 0, 3)) && !m.wholeThought(P('And then he said to them.', 0, 3)) && !m.wholeThought(P('If you can share your testimony,', 0, 3))
    && !m.wholeThought(P('Make some noise for Jesus! Make some noise for Jesus!', 0, 3)) && !m.wholeThought(P('Go to the whole world to to to every creature.', 0, 3))
    && !m.wholeThought(P('My name is Daiji, also known as Pastor Daiji.', 0, 3)), 'cut-off, joined-on, repeated, stammered and self-introduction lines are not');
  const dup = m.goodLines([P('How do you make sure you are representing Christ online?', 10, 14, { score: 2 }), P('So how do you make sure you are representing Christ online?', 20, 24, { score: 1 }),
    P('Pray without ceasing.', 30, 32), P('God is good all the time.', 40, 42)]);
  ok(dup.length === 3 && dup[0].start === 10, 'the same question asked again is kept once (the stronger)', dup.map((p) => p.text));
  const many = []; for (let i = 0; i < 1200; i++) many.push(P('Line ' + i + '.', i * 11, i * 11 + 4, { score: i < 300 ? 3 : 1 }));
  const sp = m.spreadList(many, 420);
  const parts = new Set(sp.map((p) => Math.floor(p.start / (13200 / 12))));
  ok(sp.length === 420 && parts.size === 12, 'a 3½-hour event: the editor is shown lines from every part of it, not only the loudest', { n: sp.length, parts: parts.size });
  const run = [P('a.', 100, 105), P('b.', 105.5, 110.5), P('c.', 111, 116), P('d.', 116.5, 121), P('e.', 900, 904)];
  const short = m.shortMoments(run);
  ok(m.momentsOf(run).length === 2 && short.length === 3 && short.map((p) => p.text).join('') === 'a.b.e.', 'a moment that runs on keeps its first lines (14 s at most)', short.map((p) => p.text));
  ok(['Scan the QR code to give.', 'Our IBAN is on the screen.', 'Bank details are below.', 'Tickets are at the door.'].every((t) => m.HOUSEKEEPING.test(t)), 'the giving, bank details, QR codes and tickets are never used');
  // a slide vs a speaker vs a dark stage
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-moments-'));
  const slide = path.join(dir, 'slide.mp4'), live = path.join(dir, 'live.mp4'), dark = path.join(dir, 'dark.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x5b21b6:s=320x180:d=6', '-vf', "drawbox=x=40:y=40:w=120:h=90:color=white:t=fill", '-pix_fmt', 'yuv420p', slide]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=6', '-pix_fmt', 'yuv420p', live]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=6', '-vf', 'eq=brightness=-0.42', '-pix_fmt', 'yuv420p', dark]);
  const ctx = { ffmpeg };
  const v = {};
  for (const [k, f] of [['slide', slide], ['live', live], ['dark', dark]]) v[k] = await m.stillOrDark(ctx, { start: 0.5, end: 5, cand: { file: f } });
  ok(v.slide.still && !v.live.still && !v.live.dark && v.dark.dark, 'a slide is still, a moving picture is not, a dark stage is dark', v);
  // a video shown inside the stream (a box on a bright slide) is not the live room
  const boxed = path.join(dir, 'boxed.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xdde8f5:s=320x180:d=6', '-vf', 'drawbox=x=100:y=20:w=120:h=150:color=black:t=fill', '-pix_fmt', 'yuv420p', boxed]);
  const vb = await m.stillOrDark(ctx, { start: 0.5, end: 5, cand: { file: boxed } });
  ok(vb.framed && !v.live.framed && !v.dark.framed, 'a video in a box on a slide is seen for what it is; a live picture is not', { vb, live: v.live });
  fs.rmSync(dir, { recursive: true, force: true });
  // the second read, part by part: only the lines the AI keeps are used — banter it drops is replaced from the same part
  {
    const ai = require('../src/main/aaillm');
    const was = { ready: ai.ready, chat: ai.chat };
    let asked = '';
    const ev = (id, text, start) => Object.assign(P(text, start, start + 2.4, { score: 0.8 }), { id, vid: 0 });   // (a moment of about 2.5 s)
    const L = [ev('a1', 'God is not finished with your story yet.', 100), ev('a2', 'Oh, winner man! Oh, winner money!', 2000), ev('a3', 'His grace is enough for every season of your life.', 2100),
      ev('a4', 'Hold fast to what you have, so no one takes your crown.', 4000), ev('a5', 'Jesus is the light that never goes out.', 6000)];
    ai.ready = () => true;
    ai.chat = async ({ prompt }) => {
      asked = prompt;
      // keeps every line it is shown but the banter (a3 first in its part)
      const parts = {};
      for (const blk of prompt.split('PART ').slice(1)) { const k = blk.split('\n')[0].trim(); parts[k] = (blk.match(/\ba\d\b/g) || []).filter((id) => id !== 'a2').sort((x, y) => (y === 'a3') - (x === 'a3')); }
      return JSON.stringify({ parts });
    };
    try {
      const v = await m.vetParts([L[0], L[1], L[3]], L, { lengthSec: 30, eventSec: 7000 }, null);
      ok(v && v.picks[0] === L[0] && v.picks.includes(L[2]) && !v.picks.includes(L[1]) && v.approved.has(L[4]) && !v.approved.has(L[1]) && /winner money/.test(asked),
        'a second read part by part: banter the editor took is replaced by the kept line of that part', v && v.picks.map((p) => p.id));
    } finally { ai.ready = was.ready; ai.chat = was.chat; }
    // the AI names the line to end on: it is in the edit (in place of its part's line) and the edit ends on it
    ai.ready = () => true;
    ai.chat = async ({ prompt }) => {
      const parts = {};
      for (const blk of prompt.split('PART ').slice(1)) { const k = blk.split('\n')[0].trim(); parts[k] = (blk.match(/\ba\d\b/g) || []).filter((id) => id !== 'a2').sort((x, y) => (x === 'a4') - (y === 'a4')); }
      return JSON.stringify({ parts, close: 'a5' });
    };
    try {
      const v = await m.vetParts([L[0], L[1], L[3]], L, { lengthSec: 30, eventSec: 7000 }, null);
      const order = v && m.eventOrder(v.picks, m.eventParts(L, { lengthSec: 30 }), v.close);
      ok(v && v.close === L[4] && v.picks.includes(L[4]) && order[order.length - 1] === L[4] && order[0] === L[0], 'the AI names the closing line: the edit ends on it', order && order.map((p) => p.id));
      // (the same with no close named: the strongest statement ends it, as before)
      ok(m.eventOrder(v.picks, m.eventParts(L, { lengthSec: 30 }), null).length === v.picks.length, 'no closing line named: the edit is ordered as before');
    } finally { ai.ready = was.ready; ai.chat = was.chat; }
    // the extra lines that make up the length go through the same strict read
    ai.ready = () => true;
    ai.chat = async () => JSON.stringify({ keep: ['a3', 'zz'] });
    try {
      const kept = await m.vetLoose([L[1], L[2]], null);
      ok(kept && kept.length === 1 && kept[0] === L[2], 'extra lines: only those the AI keeps are used', kept && kept.map((p) => p.id));
      ai.chat = async () => 'no';
      ok((await m.vetLoose([L[1], L[2]], null)) === null, 'no AI answer: the extra lines are not judged (null)');
    } finally { ai.ready = was.ready; ai.chat = was.chat; }
  }
  // ►► THE SAME PERSON TWICE: told by what the AI says they look like (two takes on one man, two different men)
  {
    const a = m.whoKey('man, navy jumper, white towel'), b = m.whoKey('Man in a dark blue sweater with a white towel');
    const c = m.whoKey('man in a green jumper'), d = m.whoKey('woman in a red dress with a gele'), e = m.whoKey('man in a navy blazer');
    ok(a === 'm|navy|knit|towel' && a === b, 'one man described two ways is one fingerprint', [a, b]);
    ok(m.sameWho(a, b) && !m.sameWho(a, c) && !m.sameWho(a, d) && m.sameWho(m.whoKey('man in a navy jumper'), e) && m.sameWho(a, m.whoKey('man in a dark suit with a white scarf')),
      'the same person matches (navy or black, jumper or suit, towel or scarf: the words change); another colour or a woman does not', [c, d, e]);
    ok(!m.sameWho(m.whoKey('woman in a black dress'), m.whoKey('woman in a black jumper and jeans')), 'a dress and trousers are two people');
    ok(m.whoKey('someone') === '' && !m.sameWho('', a), 'too little said: no fingerprint, never counted as the same');
  }
  // ►► THE PERSON STAYS IN THE PICTURE: followed by the detector, the cut pans with them; one who walks out is not used
  {
    const sp = { cand: { file: 'x.mp4', kind: 'video', w: 1280, h: 720, fileDur: 9000 }, snapLook: { fx: 0.4 } };
    const face = (x) => [{ score: 0.9, face: { x, y: 0.3, w: 0.05, h: 0.09 } }];
    const walker = { people: async (ff, file, t) => face(0.4 + (t - 100) * 0.04) };
    const tr = await m.followIn({ ffmpeg: 'ffmpeg' }, walker, sp, 100, 1080, 1920);
    ok(Array.isArray(tr) && tr.length === 5 && Math.abs(tr[0].fx - 0.336) < 0.01 && Math.abs(tr[4].fx - 0.464) < 0.01, 'a person who moves is followed from 1.6 s before to 1.6 s after', tr);
    const ov = { from: 99, len: 2.5 };
    m.aimCut(ov, Object.assign({}, sp, { track: tr }));
    ok(Math.abs(ov.fx - 0.36) < 0.01 && Math.abs(ov.fx2 - 0.46) < 0.01, 'and the cut pans with them over its own stretch', ov);
    const leaver = { people: async (ff, file, t) => (t > 101 ? [] : face(0.4)) };
    ok((await m.followIn({ ffmpeg: 'ffmpeg' }, leaver, sp, 100, 1080, 1920)) === false, 'one who walks out of the picture: the moment is not used');
    const runner = { people: async (ff, file, t) => face(t > 100.5 ? 0.9 : 0.4) };
    ok((await m.followIn({ ffmpeg: 'ffmpeg' }, runner, sp, 100, 1080, 1920)) === false, 'one gone far across in a moment (out of the cut): not used');
    const blind = { people: async () => [] };
    ok((await m.followIn({ ffmpeg: 'ffmpeg' }, blind, sp, 100, 1080, 1920)) === null, 'the detector does not see the person the AI saw: not judged');
    const still = { from: 99, len: 2.5 };
    m.aimCut(still, sp);
    ok(still.fx === 0.4 && still.fx2 === undefined, 'not followed: cut round where the AI saw them, no pan');
  }
  // ►► WHAT THE AI SAW, KEPT: a frame already looked at is not asked about again (the free vision allowance)
  {
    const see = require('../src/main/cloudsee');
    const was = { ready: see.ready, where: see.whereArePeople };
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-looks-'));
    const vid = path.join(dir2, 'v.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=25:d=4', '-pix_fmt', 'yuv420p', vid]);
    let asked = 0;
    see.ready = () => true;
    see.whereArePeople = async ({ frames }) => { asked++; return { ok: true, answers: Object.fromEntries(frames.map((f) => [f.label, { column: 3, people: 1, who: 'man in a green jumper', sure: true }])) }; };
    try {
      const reqs = [{ file: vid, t: 1, w: 640, h: 360 }, { file: vid, t: 2.5, w: 640, h: 360 }];
      const a = await m.lookAt({ ffmpeg }, reqs, dir2, null, { people: true });
      const n1 = asked;
      const b = await m.lookAt({ ffmpeg }, reqs, dir2, null, { people: true });
      ok(n1 >= 1 && asked === n1 && b[0].who === 'man in a green jumper' && b[1].people === 1 && Math.abs(b[0].fx - a[0].fx) < 1e-9,
        'a frame the AI already described is read back, not asked about again', { n1, asked, a: a[0], b: b[0] });
    } finally { see.ready = was.ready; see.whereArePeople = was.where; fs.rmSync(dir2, { recursive: true, force: true }); }
  }
  // ►► WHO IT IS, WITHOUT ASKING ANYONE: the same top in the same hour is the same person (no AI allowance)
  {
    const W = 200, H = 200, face = { x: 0.5, y: 0.25, w: 0.1, h: 0.12 };
    const frame = (top) => { const rgb = new Uint8Array(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; const c = y > 70 ? top : [200, 160, 130]; rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2]; } return rgb; };
    const navy = m.topColours(frame([20, 30, 90]), W, H, face), navy2 = m.topColours(frame([22, 32, 94]), W, H, face), green = m.topColours(frame([40, 120, 50]), W, H, face);
    ok(navy && Math.abs(navy.reduce((s, x) => s + x, 0) - 1) < 1e-6, 'a top is read as colours (shares that add up to one)');
    ok(m.sameTop({ vid: 0, t: 8220, top: navy }, { vid: 0, t: 8700, top: navy2 }) && !m.sameTop({ vid: 0, t: 8220, top: navy }, { vid: 0, t: 8700, top: green }),
      'the same top eight minutes apart is one person; another colour is someone else', [m.topOverlap(navy, navy2), m.topOverlap(navy, green)]);
    ok(!m.sameTop({ vid: 0, t: 3700, top: navy }, { vid: 0, t: 13190, top: navy2 }), 'the same colour two hours apart is not taken for the same person (many wear navy)');
  }
  // ►► A CLIP EVERY 2.5 SECONDS, THE WORDS WHOLE: one strong line of 2–5.5 s from each part of a long event
  {
    ok(m.MOMENT_EACH === 2.5 && m.partsFor({ lengthSec: 30 }) === 8 && m.partsFor({ lengthSec: 45 }) === 12 && m.partsFor({ lengthSec: 15 }) === 4,
      'a long event: one line for about every 3.8 s asked — 8 in 30 s, 12 in 45 s (the picture moves every 2.5 s)', [m.partsFor({ lengthSec: 30 }), m.partsFor({ lengthSec: 45 })]);
    const W = (text, t0, per) => text.split(' ').map((w, i) => ({ text: w, start: t0 + i * per, end: t0 + i * per + per * 0.8 }));
    const line = (text, t0, per, extra) => { const words = W(text, t0, per); return Object.assign({ text, words, start: words[0].start, end: words[words.length - 1].end, vid: 1, score: 1, cand: { fileDur: 13000 } }, extra || {}); };
    // (a moment can still be held into the silence around it, never into the next words — beatSpans keeps that)
    const a = line('God is good all the time.', 100, 0.33, { padTo: 2.5, prevEnd: 98, nextStart: 106 });
    ok(Math.abs(m.momentSec(a) - 2.5) < 0.02, 'a held line stays within the silence around it', m.momentSec(a));
    ok(Math.abs(m.momentSec(line('God is good all the time.', 100, 0.33)) - (a.end - a.start + 0.23)) < 0.01, 'no hold asked: a line is as long as its words');
    // a 4-second line beats a 2-second scrap: the words are whole and strong, one from each part
    const span = 13200, n = 8, w = span / n;
    const list = [];
    for (let k = 0; k < n; k++) {
      list.push(Object.assign(line('Can we clap for him?', k * w + 60, 0.3), { id: 's' + k, vid: 1, score: 1.2, cand: { fileDur: span } }));
      list.push(Object.assign(line('His grace is enough for every season of your life and every day.', k * w + 300, 0.3), { id: 'l' + k, vid: 1, score: k === 3 ? 3 : 2, cand: { fileDur: span } }));
    }
    const got = m.acrossEvent([list[3], list[5]], list, { lengthSec: 30 });
    ok(got.length === 8 && got.every((p) => p.id[0] === 'l' && p.end - p.start <= 5.5 && p.end - p.start >= 2), 'a long event: one whole, strong line (2–5.5 s) from each of its 8 parts — never the 1-second scraps', got.map((p) => p.id + ':' + (p.end - p.start).toFixed(1)));
    ok(got[0] && got[0].id === 'l1', 'and the editor\'s hook opens it', got[0] && got[0].id);
    ok(/about 2 to 5 seconds/.test(m.talkBrief({ style: 'hype', lengthSec: 30, eventSec: 13200 }, list.slice(0, 2), { compact: true })), 'the editor is told: one whole sentence of 2 to 5 seconds from each part, the picture moving every 2.5 s');
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
