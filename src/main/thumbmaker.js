'use strict';
/*
 * ►► THE YOUTUBE THUMBNAIL MAKER — its server half (Home → Thumbnails). ◄◄
 *
 * An 18-minute sermon cut goes on YouTube, and what makes people tap it is one
 * picture, 1280×720: the pastor, big, mid-word, an expression worth stopping
 * for, and three to five huge words that say what the message is. The phone
 * builds that picture (cloud-flyer.js, Thumbnail mode — the same layers, cut
 * out and lettering as the flyers); this is what only the server can do:
 *
 *   • frames()  — the moments worth a thumbnail: frames from the whole video,
 *     each looked at by the person detector (autothumb.rankFrames: the speaker
 *     there, big, sharp, lit), the best few kept, never two from the same
 *     moment, the vision AI's favourite first when it is switched on;
 *   • frameAt() — any moment the operator scrubs to, sharp enough to print;
 *   • ideas()   — what to WRITE on it: the sermon is listened to (the cloud's
 *     Whisper, else this machine's) and an AI writes the thumbnail lines a
 *     church's YouTube editor would, from what the pastor actually preached.
 *     No AI: a few honest lines from the words and the video's own name.
 *
 * Nothing here is allowed to fail the screen: no detector, no AI, no speech,
 * each falls back a step, and the operator can always type their own words.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('./ffmpeg');

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ------------------------------------------------------------ the frames */

/** One frame as a JPEG data URL, its longer side `width` (a 9:16 short comes out tall, not huge). */
async function frameJpeg(ctx, input, t, width) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ytthumb-'));
  try {
    const out = path.join(dir, 'f.jpg');
    await ff.runFfmpeg(ctx.ffmpeg, ['-ss', String(Math.max(0, +t || 0)), '-i', input, '-frames:v', '1',
      '-vf', `scale=w=${Math.round(width)}:h=${Math.round(width)}:force_original_aspect_ratio=decrease:flags=lanczos`, '-q:v', '2', '-y', out], {});
    if (!fs.existsSync(out) || !fs.statSync(out).size) throw new Error('that moment of the video could not be read');
    return 'data:image/jpeg;base64,' + fs.readFileSync(out).toString('base64');
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* gone */ } }
}

async function durationOf(ctx, input) {
  const video = require('./video');
  const info = await video.getInfo(ctx, input).catch(() => null);
  return (info && info.durationSec) || 0;
}

/**
 * The best moments for a thumbnail, best first:
 * { dur, by, frames: [{ t, url, face: {x,y,w,h} | null }] }.
 */
async function frames(ctx, { input, n = 6 } = {}) {
  if (!input || !fs.existsSync(input)) throw new Error('That video is not on the studio any more.');
  const dur = await durationOf(ctx, input);
  if (!(dur > 0)) throw new Error('That file does not look like a video.');
  n = clamp(Math.round(+n) || 6, 1, 8);
  // from the whole video (not its first and last moments: a cut, a fade, the end card), one look every ~25 s
  const a = Math.min(3, dur * 0.04), b = Math.max(a + 0.1, dur - Math.min(4, dur * 0.06));
  const count = clamp(Math.round(dur / 25), Math.min(12, Math.max(n, 4)), 40);
  const times = [];
  for (let i = 0; i < count; i++) times.push(+(a + ((i + 0.5) / count) * (b - a)).toFixed(2));
  let ranked = [];
  try { ranked = await require('./autothumb').rankFrames(ctx, input, times); } catch (e) { ranked = []; }
  if (!ranked.length) ranked = times.map((t, i) => ({ t, score: 0 - i * 1e-6, face: null }));
  // the best few, spread out: never two from the same moment of the sermon
  const gap = Math.max(1.5, dur / (n * 3));
  const pick = [];
  for (const c of ranked) {
    if (pick.some((x) => Math.abs(x.t - c.t) < gap)) continue;
    pick.push(c);
    if (pick.length === n) break;
  }
  for (const c of ranked) { if (pick.length >= n) break; if (!pick.includes(c)) pick.push(c); }
  let by = pick.some((c) => c.face) ? 'detector' : 'detail';
  // the vision AI's favourite of the top four (what a detector cannot judge: eyes open, an expression) goes first
  try {
    const cs = require('./cloudsee');
    const fin = pick.filter((c) => c.face).slice(0, 4);
    if (cs.ready() && fin.length >= 2) {
      const image = await require('./autothumb').strip(ctx, input, fin.map((c) => c.t));
      const r = image ? await cs.pickThumb({ image, count: fin.length }) : null;
      if (r && r.ok && fin[r.best]) { pick.splice(pick.indexOf(fin[r.best]), 1); pick.unshift(fin[r.best]); by = 'ai'; }
    }
  } catch (e) { /* the detector's order stands */ }
  const out = [];
  for (const c of pick) {
    try {
      const f = c.face;
      out.push({ t: c.t, url: await frameJpeg(ctx, input, c.t, 1280), face: f ? { x: +f.x.toFixed(4), y: +f.y.toFixed(4), w: +f.w.toFixed(4), h: +f.h.toFixed(4) } : null });
    } catch (e) { /* that one could not be read: the rest */ }
  }
  if (!out.length) throw new Error('No pictures could be read from that video.');
  return { dur, by, frames: out };
}

/** The frame at `t` seconds, sharp (1920 wide), for the moment the operator chose. */
async function frameAt(ctx, { input, t = 0, width = 1920 } = {}) {
  if (!input || !fs.existsSync(input)) throw new Error('That video is not on the studio any more.');
  const dur = await durationOf(ctx, input);
  const at = clamp(+t || 0, 0, Math.max(0, dur - 0.1));
  return { t: at, url: await frameJpeg(ctx, input, at, clamp(+width || 1920, 320, 1920)) };
}

/* -------------------------------------------------------------- the words */

const HEARD = new Map();   // path|size|mtime -> Promise<transcript text>
const LISTEN_CLOUD_SEC = 900, LISTEN_HERE_SEC = 150;

/** What the sermon says (the first fifteen minutes in the cloud; two and a half on this machine). '' if nothing could listen. */
function hear(ctx, input, dur) {
  let st = null; try { st = fs.statSync(input); } catch (e) { return Promise.resolve(''); }
  const key = [input, st.size, st.mtimeMs].join('|');
  if (HEARD.has(key)) return HEARD.get(key);
  const p = (async () => {
    try {
      const cloudspeech = require('./cloudspeech');
      if (cloudspeech.fileReady()) {
        const words = await cloudspeech.transcribeFile({ input, startSec: 0, endSec: dur ? Math.min(dur, LISTEN_CLOUD_SEC) : LISTEN_CLOUD_SEC, maxSec: LISTEN_CLOUD_SEC });
        if (words !== null) return String(words || '');
      }
    } catch (e) { /* this machine, then */ }
    try {
      const captioner = require('./captioner');
      if (await captioner.isAvailable()) {
        const res = await captioner.transcribe(ctx, { input, startSec: 0, endSec: Math.min(LISTEN_HERE_SEC, dur || LISTEN_HERE_SEC), fast: true });
        return ((res && res.words) || []).map((w) => w.text).join(' ').trim();
      }
    } catch (e) { /* nothing can listen */ }
    return '';
  })();
  HEARD.set(key, p);
  p.then((t) => { if (!t) HEARD.delete(key); }, () => HEARD.delete(key));
  if (HEARD.size > 50) HEARD.delete(HEARD.keys().next().value);
  return p;
}

const SYSTEM = 'You write the words on YouTube thumbnails for church sermon videos — the way the best church channels do '
  + '(Elevation, Transformation Church, Hillsong, RCCG, Dunamis): three to five huge words that make someone stop scrolling and tap, '
  + 'true to what the preacher actually said. Curiosity, a promise, a turn of phrase, a bold claim from the message — never clickbait that '
  + 'the sermon does not deliver, never a full sentence of small words, never the date or the church name, no emoji, no hashtags, no quotation marks. '
  + 'Each line is 2 to 5 words, at most 28 characters. Pick ONE word in each line to set in the accent colour (the word that carries it). '
  + 'Also give a short YouTube video title (under 70 characters) and three background pictures to paint behind the preacher '
  + '(atmosphere only: light, sky, stage haze, fire, a landscape — no people, no words in the picture).';
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lines', 'title', 'scenes'],
  properties: {
    lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'key'], properties: { text: { type: 'string' }, key: { type: 'string' } } } },
    title: { type: 'string' },
    scenes: { type: 'array', items: { type: 'string' } },
  },
};

/* a video's own name, when it says something ("Faith Over Fear (Pastor Mike)" yes; "IMG_2041", "sermon-cut-2026-10-19" no) */
function nameWords(input) {
  let s = path.basename(String(input || '')).replace(/\.[a-z0-9]+$/i, '');
  // who preached it is not the words on the picture ("Faith Over Fear (Pastor Mike)", "… - Rev. Dr. Ade")
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\b(pastor|pst|rev(erend)?|bishop|apostle|prophet(ess)?|dr|evangelist|minister|elder|deacon(ess)?|min)\b\.?(\s+(dr\.?|rev\.?))?(\s+[A-Z][\w’']*){0,2}/gi, ' ');
  s = s.replace(/[_]+/g, ' ').replace(/\b(img|mov|vid|dsc|pxl|export(ed)?|final|cut|edit(ed)?|copy|v\d+|\d{2,}[\d-]*|short|clip|sermon|video|720p|1080p|4k|hd)\b/gi, ' ')
    .replace(/[-–—()[\]{}]+/g, ' ').replace(/\s+/g, ' ').trim();
  const w = s.split(' ').filter((x) => /[a-z]{2,}/i.test(x));
  return w.length >= 2 && w.length <= 8 ? w.join(' ') : '';
}

const KEYWORDS = /\b(god|jesus|christ|lord|spirit|faith|grace|mercy|fire|glory|power|love|hope|fear|heaven|blessing|breakthrough|healing|miracle|victory|free|freedom|purpose|destiny|storm|mountain|battle|war|promise|word|prayer|praise|worship|kingdom|cross|blood|life|light|darkness|enemy|devil|giants?|walls?|chains?|door|season|wait|rest|peace|joy|strength|broken|restore|rise|stand|move|shift|now|again)\b/i;
const STOP = /^(the|a|an|and|or|but|so|to|of|in|on|at|for|with|is|are|was|were|be|it|this|that|you|your|we|our|i|my|me|he|his|she|her|they|them|their|not|no|do|does|did|have|has|had|will|can|just|all|from|up|out|if|as|by)$/i;
const STD = ['GOD IS NOT DONE', 'DON’T GIVE UP NOW', 'YOUR SEASON IS CHANGING', 'HE STILL MOVES MOUNTAINS', 'FAITH OVER FEAR', 'THIS CHANGES EVERYTHING'];

/** Lines by rule (no writer): the video's name, a short strong phrase the preacher said, then the classics. */
function linesByRules(text, input) {
  const out = [];
  const add = (s) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (!t || t.length > 32 || out.some((x) => x.text === t)) return;
    const words = t.split(' ');
    const key = words.find((w) => KEYWORDS.test(w)) || words.slice().sort((x, y) => y.length - x.length)[0];
    out.push({ text: t, key });
  };
  add(nameWords(input));
  // a short whole thing the preacher said (3–6 words) with a word that carries a sermon in it — said more than once first
  const seen = new Map();
  for (let c of String(text || '').split(/[.!?;:,\n]+/)) {
    c = c.replace(/[^\w’' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    for (let k = 0; k < 4; k++) c = c.replace(/^(and|but|so|now|listen|church|amen|hallelujah|i tell you|i say|i said|you know|because|well|oh|yes|look)\s+/i, '');
    const w = c.split(' ').filter(Boolean);
    if (w.length < 3 || w.length > 6 || c.length > 32 || !w.some((x) => KEYWORDS.test(x)) || (STOP.test(w[w.length - 1]) && !/^(you|me|us|him|them)$/i.test(w[w.length - 1]))) continue;
    const k = c.toLowerCase();
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  [...seen.entries()].sort((x, y) => y[1] - x[1] || x[0].length - y[0].length).slice(0, 3).forEach(([k]) => add(k));
  STD.forEach(add);
  return out.slice(0, 6);
}

function cleanLines(list) {
  const out = [];
  for (const l of Array.isArray(list) ? list : []) {
    const text = String((l && l.text) || l || '').replace(/["“”#]|\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (!text || text.split(' ').length > 6 || text.length > 34 || out.some((x) => x.text === text)) continue;
    const words = text.split(' ');
    const k = String((l && l.key) || '').toUpperCase().replace(/[^\w’']/g, '');
    out.push({ text, key: words.find((w) => w.replace(/[^\w’']/g, '') === k) || words.slice().sort((x, y) => y.length - x.length)[0] });
  }
  return out;
}

function promptFor(text, input, hint) {
  const name = nameWords(input);
  return [
    name ? `The video is called: ${name}` : '',
    hint ? `The operator's own idea for it: ${hint}` : '',
    text ? `What the preacher says (transcript, may have recognition errors):\n${String(text).slice(0, 14000)}` : 'There is no transcript: write strong, general lines for a sermon video.',
    'Give 6 thumbnail lines, best first, all different in angle.',
  ].filter(Boolean).join('\n\n');
}

/**
 * The words for the thumbnail: { lines: [{ text, key }], title, scenes, by, heard }.
 * `hint` is anything the operator typed. Never throws.
 */
async function ideas(ctx, { input, hint = '' } = {}) {
  const dur = input && fs.existsSync(input) ? await durationOf(ctx, input) : 0;
  const text = input && fs.existsSync(input) ? await hear(ctx, input, dur).catch(() => '') : '';
  const prompt = promptFor(text, input, String(hint || '').slice(0, 200));
  let got = null, by = 'rules';
  try {
    const cw = require('./cloudwrite');
    const raw = await cw.chat({ system: SYSTEM + '\nAnswer with ONE JSON object only: {"lines":[{"text":"…","key":"…"}],"title":"…","scenes":["…"]}.', prompt, json: true, maxTokens: 900, temperature: 0.9, evenIfOff: true, timeoutMs: 30000 });
    got = raw ? cw.parseJson(raw) : null; if (got) by = 'groq';
  } catch (e) { got = null; }
  let lines = cleanLines(got && got.lines);
  if (lines.length < 3) { lines = lines.concat(linesByRules(text, input).filter((l) => !lines.some((x) => x.text === l.text))).slice(0, 6); if (!got) by = 'rules'; }
  const scenes = (got && Array.isArray(got.scenes) ? got.scenes : []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 4);
  const title = String((got && got.title) || nameWords(input) || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return { lines, title, scenes, by, heard: !!text };
}

module.exports = { frames, frameAt, ideas, linesByRules, cleanLines, nameWords, _heard: HEARD };
