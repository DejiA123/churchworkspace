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
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
