'use strict';
/*
 * THE WORD BEING SPOKEN MUST BE THE ONE THAT LIGHTS UP.
 *
 * "Highlight mode" is a claim about pixels at a moment in time, and every part
 * of it can be got wrong in a way that reads fine in the generated file:
 *
 *   - the colour can land on the wrong word (an off-by-one between the words the
 *     transcriber timed and the words that are actually drawn),
 *   - it can land at the wrong TIME (a window that starts on the previous word's
 *     end stamp rather than on this word's start),
 *   - it can leak (two words lit at once, or the override never closed so the
 *     rest of the line changes colour too),
 *   - or the line can MOVE as the colour travels, which is the thing that makes
 *     a cheap caption look cheap.
 *
 * So this renders real frames and measures them. For a three-word line it asks
 * for the picture in the middle of each word and checks that the coloured run of
 * pixels is where that word is — and only there — while the line's total ink and
 * its outline never move.
 *
 *   node test/word-highlight.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const captioner = require('../src/main/captioner');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (c) pass++; else fail++; };

const W = 576, H = 1024;
const WORK = path.join(os.tmpdir(), 'mw-wordhl');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
for (const f of fs.readdirSync(captioner.fontsDir())) {
  if (/\.(ttf|otf)$/i.test(f)) fs.copyFileSync(path.join(captioner.fontsDir(), f), path.join(WORK, f));
}

const EVENT = {
  start: 1.0, end: 2.5, text: 'BRINGING HIS SEEDS',
  words: [
    { text: 'BRINGING', start: 1.0, end: 1.4 },
    { text: 'HIS', start: 1.6, end: 1.8 },
    { text: 'SEEDS', start: 2.0, end: 2.5 },
  ],
};
const OPTS = {
  // An explicit size, because 'm' at 576 wide puts this line off both edges —
  // and a caption clipped at both edges passes "it did not move" for the wrong
  // reason. Every measurement below wants the whole line inside the frame.
  font: 'Poppins', sizeKey: 'm', sizePct: 0.042, color: '#ffffff', outline: '#000000', style: 'outline',
  position: 'bottom', transition: 'none', wordHighlight: true, wordColor: '#ffff00', wordGap: 0.1,
};

/** Render the caption at `t` and return the columns holding white and yellow ink. */
function scanAt(t, opts) {
  const ass = path.join(WORK, 'c.ass');
  captioner.writeAss([EVENT], { width: W, height: H, output: ass, opts: opts || OPTS });
  const png = path.join(WORK, 't-' + String(t).replace('.', '_') + '.png');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=3`,
    '-ss', String(t), '-vf', 'ass=c.ass:fontsdir=.', '-frames:v', '1', '-y', png], { cwd: WORK });
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { cwd: WORK, maxBuffer: 1 << 28 });
  const white = [], yellow = [];
  let ink = 0;
  for (let x = 0; x < W; x++) {
    let w = 0, y = 0;
    for (let row = 0; row < H; row++) {
      const i = (row * W + x) * 3, r = raw[i], g = raw[i + 1], b = raw[i + 2];
      if (r >= 200 && g >= 200 && b >= 200) w++;
      else if (r >= 200 && g >= 200 && b <= 110) y++;
    }
    ink += w + y;
    if (w >= 3) white.push(x);
    if (y >= 3) yellow.push(x);
  }
  const span = (a) => (a.length ? [a[0], a[a.length - 1]] : null);
  return { white: span(white), yellow: span(yellow), yellowCols: yellow.length, ink };
}

console.log('WORD HIGHLIGHT');

// Mid-word moments, and one just after the line starts (before any word's own
// end stamp) so a window that opened late would show up as no colour at all.
const at1 = scanAt(1.2), at2 = scanAt(1.7), at3 = scanAt(2.2);

check('every moment draws the whole line',
  !!(at1.white || at1.yellow) && !!(at2.white || at2.yellow) && !!(at3.white || at3.yellow));
check('a word is lit at every moment',
  at1.yellow && at2.yellow && at3.yellow,
  `1.2s=${JSON.stringify(at1.yellow)} 1.7s=${JSON.stringify(at2.yellow)} 2.2s=${JSON.stringify(at3.yellow)}`);

// The three words run left to right, so the lit run must march right and never
// overlap the previous one.
if (at1.yellow && at2.yellow && at3.yellow) {
  check('the light moves left to right, word by word',
    at1.yellow[1] < at2.yellow[0] && at2.yellow[1] < at3.yellow[0],
    `${at1.yellow} then ${at2.yellow} then ${at3.yellow}`);
  // Exactly ONE word lit: the coloured run must be a single block, not the
  // whole line. The first word is the widest of the three, so cap against it.
  const lineW = Math.max(...[at1, at2, at3].map((s) => (s.white ? s.white[1] - s.white[0] : 0)));
  const lit = at2.yellow[1] - at2.yellow[0];
  check('only one word is lit, not the line', lit < lineW * 0.6, `lit ${lit}px of a ${lineW}px line`);
}

// The line must not shuffle as the colour travels: same ink, same extent.
const extent = (s) => {
  const a = [s.white, s.yellow].filter(Boolean);
  return [Math.min(...a.map((e) => e[0])), Math.max(...a.map((e) => e[1]))];
};
const e1 = extent(at1), e2 = extent(at2), e3 = extent(at3);
check('the line does not move as the light travels',
  Math.abs(e1[0] - e2[0]) <= 1 && Math.abs(e1[1] - e2[1]) <= 1
  && Math.abs(e1[0] - e3[0]) <= 1 && Math.abs(e1[1] - e3[1]) <= 1,
  `${e1} / ${e2} / ${e3}`);
const inkSpread = Math.max(at1.ink, at2.ink, at3.ink) - Math.min(at1.ink, at2.ink, at3.ink);
check('the same words are on screen throughout',
  inkSpread <= Math.max(at1.ink, at2.ink, at3.ink) * 0.03,
  `ink ${at1.ink}/${at2.ink}/${at3.ink}`);

// …and the highlight is genuinely opt-in: the same line without it is all white.
const off = scanAt(1.7, Object.assign({}, OPTS, { wordHighlight: false }));
check('no highlight unless it is asked for', !off.yellow, JSON.stringify(off.yellow));
check('turning it off does not change the words', off.white && at2.white
  && Math.abs(extent(off)[0] - e2[0]) <= 2 && Math.abs(extent(off)[1] - e2[1]) <= 2,
  `${extent(off)} vs ${e2}`);

/* The colour must switch on the WORD's moment, not on some average. Between
 * "HIS" ending (1.8s) and "SEEDS" starting (2.0s) the speaker has drawn breath;
 * the highlight holds on the word just said rather than dropping out, which is
 * what stops it flickering through every natural pause. */
const gap = scanAt(1.9);
check('the light holds through a breath instead of flickering off',
  gap.yellow && at2.yellow && Math.abs(gap.yellow[0] - at2.yellow[0]) <= 2,
  `pause 1.9s=${JSON.stringify(gap.yellow)}, "HIS" was ${JSON.stringify(at2.yellow)}`);

/* A hand-retyped line loses its word timings. It must still light up — shared
 * out across the words it now has — rather than silently going plain. */
const retyped = { start: 1.0, end: 2.5, text: 'SOME OTHER WORDS', words: EVENT.words };
captioner.writeAss([retyped], { width: W, height: H, output: path.join(WORK, 'r.ass'), opts: OPTS });
const rass = fs.readFileSync(path.join(WORK, 'r.ass'), 'utf-8');
const rlines = rass.split('\n').filter((l) => l.startsWith('Dialogue:'));
check('a retyped line still follows the voice', rlines.length === 3, rlines.length + ' dialogue lines');

/* One word per line is a legitimate caption ("SIR"), and it should be lit whole
 * rather than skipped for having no neighbours. */
const solo = { start: 0.5, end: 1.2, text: 'SIR', words: [{ text: 'SIR', start: 0.5, end: 1.2 }] };
captioner.writeAss([solo], { width: W, height: H, output: path.join(WORK, 's.ass'), opts: OPTS });
const sass = fs.readFileSync(path.join(WORK, 's.ass'), 'utf-8');
check('a one-word line is lit whole', /Dialogue:.*\\1c&H00FFFF&\}SIR/.test(sass));

/* The words the transcriber timed and the words that get drawn must be the same
 * list. cleanCaptionText drops a token that was only punctuation, and if the
 * timings did not drop with it every word after it would light up one place
 * late. */
const built = captioner.buildCaptionEvents([
  { text: 'AND', start: 0, end: 0.3 },
  { text: '…', start: 0.3, end: 0.4 },
  { text: "I'VE", start: 0.4, end: 0.7 },
  { text: 'met.', start: 0.7, end: 1.0 },
], { wordsPerLine: 4, textCase: 'upper' });
const ev = built[0] || {};
check('a dropped token takes its timing with it',
  ev.text === "AND I'VE MET" && ev.words && ev.words.length === 3
  && ev.words.map((w) => w.text).join(' ') === ev.text,
  JSON.stringify(ev.text) + ' words=' + JSON.stringify((ev.words || []).map((w) => w.text)));

/* ------------------------- where a line ENDS -------------------------
 *
 * A caption line is at most N words, but it also ends at a full stop and at a
 * pause. Chopping strictly every three puts the end of one sentence and the
 * start of the next on the same line — which reads wrong, and is not what
 * hand-made short-form captions do: on a professionally cut teaching, a quarter
 * of the lines are one or two words, and those are the ones followed by a
 * breath (0.47s at the third quartile, against 0.9s at the ninetieth for gaps
 * in general).
 */
const grouped = captioner.buildCaptionEvents([
  { text: 'over', start: 0.0, end: 0.2 },
  { text: 'to', start: 0.2, end: 0.4 },
  { text: 'you', start: 0.4, end: 0.6 },
  { text: 'sir.', start: 0.6, end: 0.9 },
  { text: 'one', start: 1.5, end: 1.7 },   // …a breath here
  { text: 'more', start: 1.7, end: 1.9 },
  { text: 'time', start: 1.9, end: 2.2 },
], { wordsPerLine: 3, textCase: 'upper' });
const gtext = grouped.map((e) => e.text).join(' | ');
check('three words fill a line', grouped[0] && grouped[0].text === 'OVER TO YOU', gtext);
check('a full stop ends the line early', grouped[1] && grouped[1].text === 'SIR', gtext);
check('and the next phrase starts a new one', grouped[2] && grouped[2].text === 'ONE MORE TIME', gtext);

const breath = captioner.buildCaptionEvents([
  { text: 'follow', start: 0.0, end: 0.3 },
  { text: 'me', start: 0.3, end: 0.6 },
  // no punctuation at all — only the silence says the phrase ended
  { text: 'from', start: 1.4, end: 1.6 },
  { text: 'ireland', start: 1.6, end: 2.0 },
], { wordsPerLine: 3, textCase: 'upper' });
check('a pause alone ends a line, with no punctuation to go on',
  breath.length === 2 && breath[0].text === 'FOLLOW ME',
  breath.map((e) => e.text).join(' | '));

/* The same pause, but with timings shaped the way `--dtw` leaves them: each
 * word already runs up to the next one's start, so the space between them is
 * always zero and only the STRIDE shows the silence. Without that second test
 * the effect would quietly stop working on exactly the timings that are worth
 * having. */
const dtwShaped = captioner.buildCaptionEvents([
  { text: 'follow', start: 0.0, end: 0.3 },
  { text: 'me', start: 0.3, end: 1.4 },     // end already extended to the next start
  { text: 'from', start: 1.4, end: 1.6 },
  { text: 'ireland', start: 1.6, end: 2.0 },
], { wordsPerLine: 3, textCase: 'upper' });
check('a pause is still found when the ends were stretched to meet the next word',
  dtwShaped.length === 2 && dtwShaped[0].text === 'FOLLOW ME',
  dtwShaped.map((e) => e.text).join(' | '));

const nogap = captioner.buildCaptionEvents([
  { text: 'a', start: 0, end: 0.2 }, { text: 'b', start: 0.2, end: 0.4 },
  { text: 'c', start: 0.4, end: 0.6 }, { text: 'd', start: 0.6, end: 0.8 },
], { wordsPerLine: 3, textCase: 'upper' });
check('unbroken speech still fills lines to the count',
  nogap.length === 2 && nogap[0].text === 'A B C', nogap.map((e) => e.text).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
