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
  }
  // ►► 2.5 SECONDS A MOMENT on a long event: one part per 2.5 s asked, short whole sentences, held to 2.5 s in the silence around them
  {
    ok(m.MOMENT_EACH === 2.5 && m.partsFor({ lengthSec: 30 }) === 12 && m.partsFor({ lengthSec: 15 }) === 6 && m.partsFor({ lengthSec: 60 }) === 24,
      'a long event: one part (one moment) for every 2.5 s asked — 12 in 30 s, 24 in 60 s', [m.partsFor({ lengthSec: 30 }), m.partsFor({ lengthSec: 60 })]);
    const W = (text, t0, per) => text.split(' ').map((w, i) => ({ text: w, start: t0 + i * per, end: t0 + i * per + per * 0.8 }));
    const line = (text, t0, per, extra) => { const words = W(text, t0, per); return Object.assign({ text, words, start: words[0].start, end: words[words.length - 1].end, vid: 1, score: 1, cand: { fileDur: 13000 } }, extra || {}); };
    // 1.8 s of words, a long silence after: held on to 2.5 s
    const a = line('God is good all the time.', 100, 0.33, { padTo: 2.5, prevEnd: 98, nextStart: 106 });
    ok(Math.abs(m.momentSec(a) - 2.5) < 0.02 && m.beatSpans(a)[0].from > 99.9, 'a short line holds on its speaker into the silence after it, to 2.5 s', { sec: m.momentSec(a), spans: m.beatSpans(a) });
    // the next words come 0.3 s after: the hold stops before them, and takes the rest from the silence before
    const b = line('God is good all the time.', 100, 0.33, { padTo: 2.5, prevEnd: 98.8, nextStart: a.end + 0.3 });
    const bs = m.beatSpans(b);
    ok(bs[bs.length - 1].to <= b.nextStart - 0.1 + 1e-6 && bs[0].from >= b.prevEnd + 0.1 - 1e-6 && Math.abs(m.momentSec(b) - 2.5) < 0.02,
      'never into the next words (nor the ones before): the rest of the hold is taken from the silence before it', { spans: bs, prevEnd: b.prevEnd, nextStart: b.nextStart });
    // words close on both sides: it stays as long as its own words
    const c = line('God is good all the time.', 100, 0.33, { padTo: 2.5, prevEnd: 99.9, nextStart: a.end + 0.2 });
    ok(m.momentSec(c) < 2.2 && Math.abs(m.beatSpans(c)[0].from - (c.start - 0.07)) < 1e-6, 'words said right before and after: no hold (a word is never cut into)', m.momentSec(c));
    ok(Math.abs(m.momentSec(line('God is good all the time.', 100, 0.33)) - (a.end - a.start + 0.23)) < 0.01, 'a short video (no padTo): lines are as they were');
    // one line from each part: a 4-second line (even the editor's hook) gives way to the part's short one
    const span = 13200, n = 12, w = span / n;
    const list = [];
    for (let k = 0; k < n; k++) {
      list.push(Object.assign(line('Jesus is the light that never goes out.', k * w + 60, 0.3), { id: 's' + k, vid: 1, score: k === 5 ? 3 : 1.2, cand: { fileDur: span } }));
      list.push(Object.assign(line('His grace is enough for every season of your life and every single day you live.', k * w + 300, 0.3), { id: 'l' + k, vid: 1, score: 2, cand: { fileDur: span } }));
    }
    const got = m.acrossEvent([list[1], list[3]], list, { lengthSec: 30 });
    ok(got.length === 12 && got.every((p) => p.end - p.start <= 2.9 && p.end - p.start >= 1.7), 'a long event: one short line (1.7–2.9 s) from each of its 12 parts — not the 4-second hook the editor chose', got.map((p) => p.id + ':' + (p.end - p.start).toFixed(1)));
    ok(got[0] && got[0].id === 's5', 'and the edit opens on the strongest short line when the editor\'s hook was too long for a moment', got[0] && got[0].id);
        ok(/about 2 to 3 seconds/.test(m.talkBrief({ style: 'hype', lengthSec: 30, eventSec: 13200 }, list.slice(0, 2), { compact: true })), 'the editor is told: one short sentence of about 2 to 3 seconds from each part');
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
