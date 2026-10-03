'use strict';
/*
 * ►► AI MONTAGE — "HERE ARE MY CLIPS AND PICTURES, MAKE ME SOMETHING THAT GOES VIRAL." ◄◄
 *
 * The operator drops a pile of phone videos and photos on the studio (a
 * conference, a youth camp, a baptism Sunday) and wants a short that people
 * stop scrolling for. That is an EDITOR's job — choosing the opening second,
 * the order, how long each shot stays, where it cuts on the music — so it is
 * given to the strongest model there is, looking at the actual pictures:
 *
 *   1. LOOK   every file is read on the server: where its scenes change, where
 *             it is loudest, and a frame from each moment worth considering.
 *             Photos are one moment each. (analyze)
 *   2. LISTEN the operator's own song, if they chose one: its tempo and where
 *             the beats fall, so shots change ON the beat. (beats)
 *   3. DIRECT Claude Opus 5.5 sees every candidate frame and writes the edit:
 *             the hook, the order, each shot's length and move, the words on
 *             screen and the post caption. Without a Claude key the Groq model
 *             already used elsewhere writes it from descriptions instead, and
 *             without either a rules editor does — never no montage. (direct)
 *   4. CHECK  nothing the model says is trusted: a shot must be one that was
 *             offered, its length is clamped to the footage there is, and the
 *             cuts are snapped onto the song's beats. (finalise)
 *   5. RENDER each shot is encoded to the same settings and the pieces joined
 *             without a second encode, so it fits a 512 MB server. (render)
 *
 * The finished file then opens in the studio like any video, with the song on
 * the music lane and the words as text boxes, so the operator can restyle,
 * caption and export it with everything the studio already does.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');
const jobs = require('./jobs');

const IMG_RE = /\.(jpe?g|png|webp|bmp|tiff?|avif|heic)$/i;
const isImage = (p) => IMG_RE.test(String(p || ''));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round2 = (n) => Math.round(n * 100) / 100;

const ASPECTS = {
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
  '16:9': { w: 1920, h: 1080 },
};
const FPS = 30;
const EFFECTS = ['cut', 'punch_in', 'flash', 'slow_zoom', 'zoom_out', 'slow_motion'];
/* how a shot comes IN from the one before it */
const TRANSITIONS = ['cut', 'fade', 'flash'];
/* something laid ON a video shot while its sound plays on */
const OVERLAY_STYLES = ['cutaway', 'pip'];
const STYLES = {
  hype: 'High energy. Fast cuts (often under a second on a fast song), punch-ins and flashes on the big moments, the most explosive moment first.',
  worship: 'Reverent and uplifting. Unhurried shots of raised hands, faces and light; slow zooms; let moments breathe; build to a climax.',
  emotional: 'Story first. Faces, reactions, tears and embraces; slow motion on the most human moment; words that land like a testimony.',
  cinematic: 'Film-trailer feel. Wide establishing shots, slow pushes, a deliberate rise in pace toward the end, a strong final image.',
  fun: 'Playful and quick. Smiles, laughter, surprises; snappy timing; captions with personality.',
};

/* ------------------------------------------------------------ ffmpeg helpers */

/** Run ffmpeg (in the encoder queue, below the server in priority) and collect what it prints. */
function collect(ffmpegPath, args, { stdout = false, maxBytes = 64 * 1024 * 1024 } = {}) {
  return ff.gated(() => new Promise((resolve, reject) => {
    const proc = ff.lowPriority(jobs.track(spawn(ffmpegPath, ff.capThreads(args), { windowsHide: true })));
    const out = []; let outLen = 0; let err = '';
    proc.stdout.on('data', (d) => { if (stdout && outLen < maxBytes) { out.push(d); outLen += d.length; } });
    proc.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4e6) err = err.slice(-2e6); });
    proc.on('error', (e) => reject(new Error('Could not start ffmpeg: ' + e.message)));
    proc.on('close', (code) => {
      if (jobs.isCancelled()) return reject(new jobs.CancelledError());
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  }));
}

/** Where ffmpeg saw the picture change (seconds), sampled at a few frames a second. */
async function sceneTimes(ctx, file, durationSec) {
  // A long recording is read on its keyframes only (every second or two on a
  // phone) — ten times less decoding on a half-CPU server, and still every
  // scene change worth cutting on.
  const quick = durationSec > 120 ? ['-skip_frame', 'nokey'] : [];
  const { stderr } = await collect(ctx.ffmpeg, ['-hide_banner', ...quick, '-i', file, '-an', '-sn',
    '-vf', "fps=4,scale=-2:144,select='gt(scene,0.28)',metadata=print", '-f', 'null', '-']);
  const out = []; let t = null;
  for (const line of stderr.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) t = parseFloat(m[1]);
    else if (/lavfi\.scene_score=/.test(line) && t != null) out.push(t);
  }
  return out;
}

/** Loudness (dBFS RMS) every half second. */
async function loudness(ctx, file) {
  const { stderr } = await collect(ctx.ffmpeg, ['-hide_banner', '-i', file, '-vn', '-sn',
    '-af', 'aresample=8000,asetnsamples=n=4000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-']);
  const out = []; let t = null;
  for (const line of stderr.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) { t = parseFloat(m[1]); continue; }
    const r = line.match(/RMS_level=(-?[\d.]+|-inf)/);
    if (r && t != null) out.push({ t, db: r[1] === '-inf' ? -90 : parseFloat(r[1]) });
  }
  return out;
}

async function thumb(ctx, file, atSec, dest, image) {
  const args = ['-hide_banner', '-y'];
  if (!image) args.push('-ss', String(Math.max(0, atSec)));
  args.push('-i', file, '-frames:v', '1', '-vf', 'scale=-2:320', '-q:v', '5', dest);
  await collect(ctx.ffmpeg, args);
  return fs.existsSync(dest) ? dest : null;
}

/* ------------------------------------------------------------------ analyze */

/**
 * Every file → the moments worth considering, each with a frame to look at.
 * `budget` caps the number of candidates across all files (each is a picture
 * the director has to look at).
 */
async function analyze(ctx, getInfo, files, { tmp, budget = 44, onProgress, full = false } = {}) {
  const say = (p) => { if (onProgress) onProgress(Math.round(p)); };
  const infos = [];
  for (const f of files) {
    let info = null;
    try { info = await getInfo(ctx, f); } catch (e) { info = null; }
    if (info && info.width && info.height) infos.push({ file: f, info, image: isImage(f) || !(info.durationSec > 0.3) });
  }
  if (!infos.length) throw new Error('None of those files could be read as a video or a picture.');
  const videos = infos.filter((x) => !x.image);
  const images = infos.filter((x) => x.image);
  // Photos are one moment each; what is left of the budget is shared by the
  // videos in proportion to their length (a 3-minute clip has more in it).
  const forVideos = Math.max(videos.length, budget - images.length);
  const totalLen = videos.reduce((n, v) => n + v.info.durationSec, 0) || 1;
  const cands = [];
  let k = 0, step = 0;
  const steps = videos.length * 2 + infos.length;
  for (const v of videos) {
    const D = v.info.durationSec;
    let scenes = [], loud = [];
    try { scenes = await sceneTimes(ctx, v.file, D); } catch (e) { if (e instanceof jobs.CancelledError) throw e; }
    say((++step / steps) * 70);
    if (v.info.hasAudio) { try { loud = await loudness(ctx, v.file); } catch (e) { if (e instanceof jobs.CancelledError) throw e; } }
    say((++step / steps) * 70);
    // shots: between scene changes, merged when tiny and split when long
    const cuts = [0, ...scenes.filter((t) => t > 0.4 && t < D - 0.4), D];
    let segs = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1];
      if (segs.length && b - a < 0.7) { segs[segs.length - 1].end = b; continue; }
      segs.push({ start: a, end: b });
    }
    const split = [];
    for (const s of segs) {
      const len = s.end - s.start;
      if (len <= 6) { split.push(s); continue; }
      const n = Math.ceil(len / 4);
      for (let j = 0; j < n; j++) split.push({ start: s.start + (len * j) / n, end: s.start + (len * (j + 1)) / n });
    }
    segs = split;
    const dbAt = (a, b) => {
      const xs = loud.filter((p) => p.t >= a && p.t < b).map((p) => p.db);
      return xs.length ? xs.reduce((m, x) => m + x, 0) / xs.length : -60;
    };
    const peakAt = (a, b) => {
      let best = null;
      for (const p of loud) if (p.t >= a && p.t < b && (!best || p.db > best.db)) best = p;
      return best ? best.t : (a + b) / 2;
    };
    for (const s of segs) {
      s.db = dbAt(s.start, s.end);
      s.loud = clamp((s.db + 50) / 40, 0, 1);
      s.peak = peakAt(s.start, s.end);
      // a shot that cuts often around it is where things HAPPEN
      s.energy = clamp(scenes.filter((t) => t > s.start - 2 && t < s.end + 2).length / 4, 0, 1);
      s.score = 0.55 * s.loud + 0.3 * s.energy + 0.15 * clamp((s.end - s.start) / 3, 0, 1);
    }
    // KEEP EVERYTHING: the whole clip is one shot; its frame is its best moment
    if (full) {
      const best = segs.slice().sort((x, y) => y.score - x.score)[0] || { peak: D / 2, loud: 0, energy: 0, score: 0.5 };
      cands.push({ id: 'c' + (++k), file: v.file, kind: 'video', start: 0, end: round2(D), peak: round2(best.peak), whole: true,
        fileDur: round2(D), loud: round2(best.loud || 0), energy: round2(best.energy || 0), score: round2(best.score || 0.5),
        hasAudio: !!v.info.hasAudio, w: v.info.width, h: v.info.height, name: path.basename(v.file) });
      continue;
    }
    const want = clamp(Math.round((forVideos * D) / totalLen), 1, 8);
    // best first, then spread out (no two picks from the same few seconds)
    const picked = [];
    for (const s of segs.slice().sort((x, y) => y.score - x.score)) {
      if (picked.length >= want) break;
      if (picked.some((p) => Math.abs(p.peak - s.peak) < 2.5)) continue;
      picked.push(s);
    }
    picked.sort((x, y) => x.start - y.start);
    for (const s of picked) {
      const id = 'c' + (++k);
      cands.push({ id, file: v.file, kind: 'video', start: round2(s.start), end: round2(s.end), peak: round2(s.peak),
        fileDur: round2(D), loud: round2(s.loud), energy: round2(s.energy), score: round2(s.score),
        hasAudio: !!v.info.hasAudio, w: v.info.width, h: v.info.height, name: path.basename(v.file) });
    }
  }
  for (const im of images) {
    cands.push({ id: 'c' + (++k), file: im.file, kind: 'image', start: 0, end: 0, peak: 0, fileDur: 0,
      loud: 0, energy: 0, score: 0.5, hasAudio: false, w: im.info.width, h: im.info.height, name: path.basename(im.file) });
  }
  // a frame of each candidate, for the director to look at
  for (const c of cands) {
    try { c.thumb = await thumb(ctx, c.file, c.kind === 'image' ? 0 : c.peak, path.join(tmp, c.id + '.jpg'), c.kind === 'image'); }
    catch (e) { if (e instanceof jobs.CancelledError) throw e; c.thumb = null; }
    say(70 + (++step / steps) * 30);
  }
  return cands;
}

/* -------------------------------------------------------------------- beats */

/**
 * Tempo and beat times of a song: an onset curve (rises in loudness), the tempo
 * that repeats best in it (70–180 BPM), and the beat phase that lands on the
 * most onsets. Good enough to cut on; it is a montage, not a DJ set.
 */
async function beats(ctx, music) {
  const SR = 11025, HOP = 256;
  const { stdout } = await collect(ctx.ffmpeg, ['-hide_banner', '-i', music, '-vn', '-ac', '1', '-ar', String(SR),
    '-t', '600', '-f', 's16le', '-'], { stdout: true });
  const n = Math.floor(stdout.length / 2);
  if (n < SR * 2) return null;
  const frames = Math.floor(n / HOP);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * HOP, e = i + HOP; i < e; i++) { const v = stdout.readInt16LE(i * 2) / 32768; s += v * v; }
    env[f] = Math.log(1e-6 + s / HOP);
  }
  // onsets, smoothed over a few frames: a beat that falls between two analysis
  // frames must still line up with the next one
  const raw = new Float32Array(frames);
  for (let f = 1; f < frames; f++) raw[f] = Math.max(0, env[f] - env[f - 1]);
  const flux = new Float32Array(frames);
  for (let f = 2; f < frames - 2; f++) flux[f] = 0.15 * raw[f - 2] + 0.2 * raw[f - 1] + 0.3 * raw[f] + 0.2 * raw[f + 1] + 0.15 * raw[f + 2];
  const fps = SR / HOP;
  const ac = (lagF) => {
    let s = 0, k = 0;
    for (let f = Math.ceil(lagF) + 2; f < frames - 2; f++) {
      const g = f - lagF, i = Math.floor(g), w = g - i;
      s += flux[f] * (flux[i] * (1 - w) + flux[i + 1] * w);
      k++;
    }
    return k ? s / k : 0;
  };
  let best = { bpm: 120, score: -1 };
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    // the true beat lines up with itself one AND two beats on
    let sc = ac(lag) + 0.5 * ac(2 * lag);
    if (bpm >= 90 && bpm <= 140) sc *= 1.05; // where most songs are counted
    if (sc > best.score) best = { bpm, score: sc };
  }
  // …then finely: half a BPM out drifts a quarter of a second over a minute
  const coarse = best.bpm;
  for (let bpm = coarse - 0.6; bpm <= coarse + 0.6; bpm += 0.05) {
    const lag = (60 / bpm) * fps;
    const sc = (ac(lag) + 0.5 * ac(2 * lag) + 0.33 * ac(4 * lag)) * (bpm >= 90 && bpm <= 140 ? 1.05 : 1);
    if (sc > best.score) best = { bpm: Math.round(bpm * 100) / 100, score: sc };
  }
  const period = (60 / best.bpm) * fps;
  // WHERE the beats fall is chosen on plain (not log) loudness rises, so the
  // kick drum outweighs a hi-hat between beats
  const lin = new Float32Array(frames);
  for (let f = 1; f < frames; f++) lin[f] = Math.max(0, Math.exp(env[f]) - Math.exp(env[f - 1]));
  let phase = 0, top = -1;
  for (let p = 0; p < period; p += 0.5) {
    let s = 0;
    for (let f = p; f < frames - 1; f += period) { const i = Math.round(f); s += lin[i] + 0.5 * (lin[i - 1] || 0) + 0.5 * (lin[i + 1] || 0); }
    if (s > top) { top = s; phase = p; }
  }
  // Lock on: find the real hit near each predicted beat and fit a straight line
  // through them. The slope IS the tempo, measured over the whole song, so a
  // grid that was 1% fast no longer drifts off the music by the last chorus.
  // Tried from the phase found AND half a beat later — a slightly wrong tempo
  // can leave the grid on the off-beat (the hi-hat), and the kick is the beat.
  const lockOn = (ph0) => {
    // follow the beat hit by hit (each one found tells where to look for the
    // next), then fit the line through the hits actually found
    let p = period, c = ph0, last = -1, sum = 0;
    const xs = [], ys = [];
    let k = 0;
    while (c < frames - 1) {
      const lo = Math.max(1, Math.round(c - p * 0.2)), hi = Math.min(frames - 1, Math.round(c + p * 0.2));
      let bi = -1, bv = 0;
      for (let i = lo; i <= hi; i++) if (lin[i] > bv) { bv = lin[i]; bi = i; }
      if (bi >= 0 && bv > 0) {
        if (last >= 0) p = 0.85 * p + 0.15 * clamp(bi - last, period * 0.9, period * 1.1);
        xs.push(k); ys.push(bi); sum += bv; last = bi; c = bi + p;
      } else c += p;
      k++;
    }
    if (xs.length < 8) return { per: period, ph: ph0, hits: sum };
    const mx = xs.reduce((q, v) => q + v, 0) / xs.length, my = ys.reduce((q, v) => q + v, 0) / ys.length;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    let per = sxy / sxx, ph = my - per * mx;
    if (!(per > period * 0.9 && per < period * 1.1)) { per = period; ph = ph0; }
    while (ph - per >= 0) ph -= per;
    while (ph < 0) ph += per;
    return { per, ph, hits: sum };
  };
  const A = lockOn(phase), Bq = lockOn((phase + period / 2) % period);
  const { per, ph } = Bq.hits > A.hits * 1.1 ? Bq : A;
  const bpm = Math.round((60 * fps / per) * 10) / 10;
  const out = [];
  for (let f = ph; f < frames; f += per) out.push(round2(f / fps));
  return { bpm, interval: round2(per / fps), beats: out, duration: round2(n / SR) };
}

/* ------------------------------------------------------------------ direct */

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['concept', 'title', 'shots', 'texts', 'overlays', 'post_caption', 'hashtags'],
  properties: {
    concept: { type: 'string', description: 'One sentence: the idea of this edit and why it will hold attention.' },
    title: { type: 'string' },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'seconds', 'effect', 'focus', 'transition'],
        properties: {
          id: { type: 'string', description: 'A candidate id from the list, e.g. "c4".' },
          transition: { type: 'string', enum: TRANSITIONS, description: 'How this shot comes in from the previous one: a hard cut, a fade through black, or a white flash.' },
          seconds: { type: 'number', description: 'How long the shot stays on screen.' },
          effect: { type: 'string', enum: EFFECTS },
          focus: { type: 'string', enum: ['center', 'top', 'bottom'], description: 'Which part of the picture to keep when it is cropped to the frame.' },
        },
      },
    },
    texts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['at_shot', 'span_shots', 'text', 'role'],
        properties: {
          at_shot: { type: 'integer', description: 'Index (0-based) into shots where the words appear.' },
          span_shots: { type: 'integer', description: 'How many shots the words stay on for (1 or more).' },
          text: { type: 'string' },
          role: { type: 'string', enum: ['hook', 'beat', 'cta'] },
        },
      },
    },
    overlays: {
      type: 'array',
      description: 'B-roll laid ON TOP of a video shot while that shot keeps playing its sound.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['on_shot', 'id', 'style', 'start', 'seconds'],
        properties: {
          on_shot: { type: 'integer', description: 'Index (0-based) of the VIDEO shot it goes over.' },
          id: { type: 'string', description: 'The candidate shown on top (a photo or another clip).' },
          style: { type: 'string', enum: OVERLAY_STYLES, description: '"cutaway" fills the frame; "pip" is a framed box in a corner.' },
          start: { type: 'number', description: 'Seconds into that shot where it appears.' },
          seconds: { type: 'number', description: 'How long it stays (1–4).' },
        },
      },
    },
    post_caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You are the best short-form video editor working today: you cut church and ministry content that goes viral on TikTok, Instagram Reels and YouTube Shorts.
You are given candidate moments from the operator's own uploaded videos and photos, each with an id and a frame. Build ONE edit from them.

What makes it work:
- The first 1.5 seconds decide everything. Open on the single most arresting image (motion, emotion, a face, a crowd, a surprise) — never on a slow establishing shot.
- Give it an arc: hook, build, peak, payoff. Vary rhythm; save one strong moment for the end so people watch to the last frame (and loop it).
- Faces and genuine emotion beat scenery. Avoid near-duplicate frames back to back. Skip blurry, dark or empty frames.
- When there is music, cut lengths are multiples of the beat; faster songs mean shorter shots. Without music, 1.2–3 s per shot.
- Transitions (how each shot comes in): mostly "cut" on the beat; "fade" through black to change place, time or mood; "flash" (white) to hit a big moment. Never two fades in a row on a fast edit.
- Overlays (B-roll) are what make it feel produced: lay a photo or another clip ON TOP of a video shot while that shot's sound carries on — show what is being preached or sung about, a reaction, the crowd, a moment from earlier. "cutaway" fills the frame; "pip" is a framed box in a corner. Use them on video shots whose sound carries (speech, singing, a crowd), 1.5–3.5 s each, a few per edit, never in the first second of the hook.
- Effects are seasoning: punch_in or flash on the biggest beats, slow_zoom / zoom_out to give photos life, slow_motion for one emotional peak at most. Most shots are a plain "cut".
- On-screen words: one hook in the first shot (max 7 words, curiosity or emotion, no clickbait lies), a few short beats that carry the story (max 6 words each), and an optional call to action at the end. Plain words, no emojis inside the video text, no hashtags in it.
- Respect the faith context: uplifting, sincere, never mocking.
- post_caption: the caption for the post, warm and specific, one or two short lines, at most one emoji. hashtags: 4–8, relevant, without the # sign.
Only use ids from the list. Every shot's seconds must fit the footage that candidate has (photos can be held as long as needed).`;

function describe(c) {
  if (c.kind === 'image') return `${c.id}: PHOTO "${c.name}" (${c.w}x${c.h})`;
  if (c.whole) return `${c.id}: VIDEO "${c.name}", ${c.fileDur}s, plays IN FULL (its seconds are fixed), loudness ${c.loud}, action ${c.energy}${c.hasAudio ? '' : ', silent'}`;
  const len = round2(Math.min(c.fileDur, Math.max(c.end - c.start, 0) + 3));
  return `${c.id}: VIDEO "${c.name}" moment at ${c.start}s–${c.end}s of ${c.fileDur}s, up to ${len}s usable, loudness ${c.loud}, action ${c.energy}${c.hasAudio ? '' : ', silent'}`;
}

function briefOf(opts, music) {
  const lines = [
    `Style: ${opts.style} — ${STYLES[opts.style] || STYLES.hype}`,
    opts.full
      ? `KEEP EVERYTHING: the operator wants nothing cut out. Use EVERY candidate exactly once. Videos play in full — you choose the ORDER, how each one comes in (transition), its effect and focus. Photos: 2–5 s each, with motion. Blend it all into one flowing piece with the words on screen. Frame: ${opts.aspect}.`
      : `Target length: about ${opts.lengthSec} seconds${opts.lengthSec >= 90 ? ' (a longer piece: build it in movements — a hook, then sections that each rise and land; strong moments may return)' : ''}. Frame: ${opts.aspect}.`,
    music ? `Music: the operator's own song, ${music.bpm} BPM (one beat = ${music.interval}s). Shot lengths should be whole numbers of beats.` : 'No music chosen: the clips\' own sound plays.',
  ];
  if (opts.brief) lines.push(`What the operator says it is about: "${String(opts.brief).slice(0, 500)}"`);
  return lines.join('\n');
}

/** Claude Opus 5.5, looking at every candidate frame. */
async function directWithClaude(cands, opts, music) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const Client = Anthropic.default || Anthropic;
  const client = new Client({ maxRetries: 2, timeout: 8 * 60 * 1000 });
  const model = process.env.MW_MONTAGE_MODEL || 'claude-opus-5-5';
  const content = [{ type: 'text', text: briefOf(opts, music) + `\n\n${cands.length} candidates follow, each as a line and its frame.` }];
  for (const c of cands) {
    content.push({ type: 'text', text: describe(c) });
    if (c.thumb) {
      try {
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(c.thumb).toString('base64') } });
      } catch (e) { /* the line alone */ }
    }
  }
  content.push({ type: 'text', text: 'Now write the edit.' });
  const body = {
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  };
  let res;
  try {
    // A declined request is re-run on Anthropic's recommended fallback model
    // instead of coming back empty.
    res = await client.beta.messages.create(Object.assign({}, body, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }));
  } catch (e) {
    if (e instanceof Client.BadRequestError) res = await client.messages.create(body);
    else throw e;
  }
  if (!res || res.stop_reason === 'refusal') return null;
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let plan = null;
  try { plan = JSON.parse(text); } catch (e) { plan = null; }
  return plan ? { plan, director: 'claude', model: res.model || model } : null;
}

/** The Groq model the studio already uses, reading descriptions (no pictures). */
async function directWithGroq(cands, opts, music) {
  let cw;
  try { cw = require('./cloudwrite'); } catch (e) { return null; }
  if (!cw.access || !cw.access().key) return null;
  const prompt = briefOf(opts, music) + '\n\nCandidates:\n' + cands.map(describe).join('\n')
    + '\n\nReply with JSON only, exactly this shape: {"concept":"","title":"","shots":[{"id":"c1","seconds":2,"effect":"cut","focus":"center","transition":"cut"}],'
    + '"texts":[{"at_shot":0,"span_shots":1,"text":"","role":"hook"}],"overlays":[{"on_shot":1,"id":"c5","style":"cutaway","start":0.8,"seconds":2}],"post_caption":"","hashtags":[""]}. Effects: ' + EFFECTS.join(', ') + '. Overlay styles: ' + OVERLAY_STYLES.join(', ') + '.';
  const text = await cw.chat({ system: SYSTEM, prompt, json: true, maxTokens: 2500, temperature: 0.7, timeoutMs: 60000, evenIfOff: true });
  const plan = text ? cw.parseJson(text) : null;
  return plan && Array.isArray(plan.shots) ? { plan, director: 'groq', model: (cw.state && cw.state().model) || 'groq' } : null;
}

/** Rules' B-roll: photos laid over the longest video shots, alternating full-frame and boxed. */
function rulesOverlays(shots, cands) {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const pics = cands.filter((c) => c.kind === 'image');
  if (!pics.length) return [];
  const long = shots.map((s, i) => ({ s, i, c: byId.get(s.id) }))
    .filter((x) => x.c && x.c.kind === 'video' && x.s.seconds >= 3)
    .sort((a, b) => b.s.seconds - a.s.seconds).slice(0, Math.min(4, pics.length));
  return long.map((x, k) => ({ on_shot: x.i, id: pics[k % pics.length].id, style: k % 2 ? 'pip' : 'cutaway',
    start: Math.min(1, x.s.seconds * 0.25), seconds: Math.min(3, x.s.seconds * 0.5) }));
}

/** No AI at all: strongest first, the rest in an alternating, varied order. */
function directByRules(cands, opts, music) {
  const hook0 = String(opts.brief || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ');
  if (opts.full) {
    // everything, strongest first, photos spread between the videos, a fade
    // wherever it moves from one file to the next kind of thing
    const vids = cands.filter((c) => c.kind === 'video').sort((a, b) => b.score - a.score);
    const pics = cands.filter((c) => c.kind === 'image');
    const order = [];
    const gap = vids.length ? Math.max(1, Math.ceil(pics.length / vids.length)) : pics.length;
    let pi = 0;
    for (const v of vids) { order.push(v); for (let j = 0; j < gap && pi < pics.length; j++) order.push(pics[pi++]); }
    while (pi < pics.length) order.push(pics[pi++]);
    const shots = order.map((c, i) => ({
      id: c.id, seconds: c.kind === 'image' ? 3 : c.fileDur, focus: 'center',
      effect: c.kind === 'image' ? (i % 2 ? 'zoom_out' : 'slow_zoom') : (i === 0 ? 'punch_in' : 'cut'),
      transition: i === 0 ? 'cut' : (order[i - 1].kind !== c.kind ? 'fade' : (i % 3 === 0 ? 'flash' : 'cut')),
    }));
    return { plan: { concept: 'Everything kept, blended into one piece.', title: hook0 || 'Highlights', shots,
      texts: hook0 ? [{ at_shot: 0, span_shots: 1, text: hook0, role: 'hook' }] : [], overlays: rulesOverlays(shots, cands), post_caption: '', hashtags: [] }, director: 'rules', model: '' };
  }
  const pool = cands.slice().sort((a, b) => b.score - a.score);
  const per = music ? music.interval * (music.bpm > 120 ? 2 : 1) * (opts.style === 'worship' || opts.style === 'cinematic' ? 2 : 1) : 2;
  const shots = [];
  let total = 0, i = 0;
  const fx = ['punch_in', 'cut', 'cut', 'flash', 'cut', 'slow_zoom'];
  while (total < opts.lengthSec && shots.length < 300) {
    const c = pool[i % pool.length];
    i++;
    const sec = c.kind === 'image' ? per * 1.5 : per;
    shots.push({ id: c.id, seconds: sec, effect: c.kind === 'image' ? (shots.length % 2 ? 'zoom_out' : 'slow_zoom') : fx[shots.length % fx.length], focus: 'center' });
    total += sec;
  }
  // the operator's own words, if they gave any, open it
  const hook = String(opts.brief || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ');
  return { plan: { concept: 'Strongest moments first, cut to the rhythm.', title: hook || 'Highlights', shots,
    texts: hook ? [{ at_shot: 0, span_shots: Math.min(2, shots.length), text: hook, role: 'hook' }] : [],
    overlays: rulesOverlays(shots, cands),
    post_caption: '', hashtags: [] }, director: 'rules', model: '' };
}

async function direct(cands, opts, music, log) {
  for (const [name, fn] of [['Claude', directWithClaude], ['Groq', directWithGroq]]) {
    try {
      const r = await fn(cands, opts, music);
      if (r && r.plan && Array.isArray(r.plan.shots) && r.plan.shots.length) return r;
    } catch (e) {
      if (e instanceof jobs.CancelledError) throw e;
      if (log) log(`${name} could not direct the montage: ${e && e.message}`);
    }
  }
  return directByRules(cands, opts, music);
}

/* ----------------------------------------------------------------- finalise */

/**
 * The model's plan made safe and exact: known shots only, lengths that fit the
 * footage, cuts on the beat, words timed to the shots they belong to.
 */
function finalise(raw, cands, opts, music) {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const shots = [];
  for (const s of (raw.shots || [])) {
    const c = byId.get(String(s && s.id || '').trim());
    if (!c) continue;
    let effect = EFFECTS.includes(s.effect) ? s.effect : 'cut';
    const focus = ['center', 'top', 'bottom'].includes(s.focus) ? s.focus : 'center';
    const transition = TRANSITIONS.includes(s.transition) ? s.transition : 'cut';
    if (opts.full) {
      // every file once, videos whole (slow motion would double a whole clip)
      if (shots.some((x) => x.cand.id === c.id)) continue;
      if (effect === 'slow_motion') effect = 'cut';
      const sec = c.kind === 'video' ? Math.max(0.4, c.fileDur - 0.05) : clamp(Number(s.seconds) || 3, 1.5, 6);
      shots.push({ cand: c, seconds: sec, effect, focus, slow: false, transition });
      continue;
    }
    let sec = clamp(Number(s.seconds) || 2, 0.4, 12);
    const slow = effect === 'slow_motion' && c.kind === 'video';
    if (c.kind === 'video') sec = Math.min(sec, (c.fileDur - 0.05) * (slow ? 2 : 1));
    if (sec < 0.4) continue;
    shots.push({ cand: c, seconds: sec, effect, focus, slow, transition });
  }
  if (opts.full) {
    // nothing the operator gave is left out, even if the director skipped it
    // (a photo shown as an overlay counts as shown)
    const onTop = new Set((raw.overlays || []).map((o) => String(o && o.id || '').trim()));
    for (const c of cands) {
      if (shots.some((x) => x.cand.id === c.id) || onTop.has(c.id)) continue;
      shots.push({ cand: c, seconds: c.kind === 'video' ? Math.max(0.4, c.fileDur - 0.05) : 3,
        effect: c.kind === 'image' ? 'slow_zoom' : 'cut', focus: 'center', slow: false, transition: 'fade' });
    }
  }
  if (!shots.length) throw new Error('The montage plan had no usable shots.');
  if (shots[0]) shots[0].transition = 'cut';
  // the length asked for, give or take a shot
  const target = clamp(Number(opts.lengthSec) || 30, 8, 600);
  let total = shots.reduce((n, s) => n + s.seconds, 0);
  while (!opts.full && shots.length > 3 && total - shots[shots.length - 1].seconds >= target * 1.1) {
    total -= shots.pop().seconds;
  }
  // on the beat: every cut moves to the nearest beat after the last one
  if (music && music.beats && music.beats.length > 4) {
    const minGap = music.interval * (music.bpm > 140 ? 2 : 1) * 0.9;
    let at = 0;
    const B = music.beats;
    for (const s of shots) {
      if (opts.full && s.cand.kind === 'video') { at += s.seconds; continue; }
      const want = at + s.seconds;
      // a video shot can only reach as far as its footage: the cut goes on the
      // last beat it CAN reach, never past the end of the clip and off the beat
      const most = s.cand.kind === 'video' ? at + (s.cand.fileDur - 0.05) * (s.slow ? 2 : 1) : Infinity;
      let best = null;
      for (const b of B) {
        if (b < at + minGap - 1e-6) continue;
        if (b > most + 1e-6) break;
        if (best == null || Math.abs(b - want) < Math.abs(best - want)) best = b;
        if (b > want + music.interval * 2) break;
      }
      s.seconds = best != null ? best - at : Math.min(s.seconds, most - at);
      at += s.seconds;
    }
  }
  // where in its file each video shot comes from: around the moment's peak
  let t = 0;
  const nth = new Map(); // the second use of a moment carries on from where the first left off
  for (const s of shots) {
    const c = s.cand;
    s.seconds = round2(Math.max(0.4, s.seconds));
    s.at = round2(t);
    if (c.kind === 'video' && opts.full) {
      s.from = 0; s.need = round2(s.seconds);
    } else if (c.kind === 'video') {
      const need = s.seconds / (s.slow ? 2 : 1);
      const n = nth.get(c.id) || 0;
      nth.set(c.id, n + 1);
      let from = c.peak - need * 0.4 + n * need;
      from = clamp(from, 0, Math.max(0, c.fileDur - need - 0.02));
      s.from = round2(from);
      s.need = round2(need);
    }
    t += s.seconds;
  }
  const duration = round2(t);
  // overlays: a known picture or clip, over a VIDEO shot long enough to carry it
  for (const o of (raw.overlays || [])) {
    const i = Math.round(Number(o && o.on_shot));
    const base = shots[i];
    const oc = byId.get(String(o && o.id || '').trim());
    if (!base || !oc || base.overlay || base.cand.kind !== 'video' || oc.id === base.cand.id || base.seconds < 2.2) continue;
    const style = OVERLAY_STYLES.includes(o.style) ? o.style : 'cutaway';
    const start = round2(clamp(Number(o.start) || 0.8, i === 0 ? 1.2 : 0.3, base.seconds - 1.2));
    const len = round2(clamp(Number(o.seconds) || 2, 1, Math.min(4, base.seconds - start - 0.15)));
    if (len < 1) continue;
    const ov = { cand: oc, style, start, len, pos: (i % 2 ? 'left' : 'right') };
    if (oc.kind === 'video') ov.from = round2(clamp(oc.peak - len / 2, 0, Math.max(0, oc.fileDur - len - 0.05)));
    base.overlay = ov;
  }
  const texts = [];
  for (const x of (raw.texts || [])) {
    const i = Math.round(Number(x && x.at_shot));
    const text = String((x && x.text) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text || !(i >= 0 && i < shots.length)) continue;
    const span = clamp(Math.round(Number(x.span_shots) || 1), 1, shots.length - i);
    const last = shots[i + span - 1];
    const start = shots[i].at;
    const end = round2(Math.min(duration, Math.max(last.at + last.seconds, start + 1.2)));
    texts.push({ start, end, text, role: ['hook', 'beat', 'cta'].includes(x.role) ? x.role : 'beat' });
  }
  const tags = (Array.isArray(raw.hashtags) ? raw.hashtags : []).map((h) => String(h).replace(/^#+/, '').replace(/\s+/g, '')).filter(Boolean).slice(0, 10);
  return {
    concept: String(raw.concept || '').slice(0, 300),
    title: String(raw.title || '').slice(0, 100),
    postCaption: String(raw.post_caption || '').slice(0, 600),
    hashtags: tags,
    shots, texts, duration,
  };
}

/* ------------------------------------------------------------------- render */

function fitChain(c, W, H, focus, scale = 1, tag = '') {
  const w = W * scale, h = H * scale;
  const ar = c.w / c.h, tar = W / H;
  const y = focus === 'top' ? '0' : focus === 'bottom' ? '(ih-oh)' : '(ih-oh)/2';
  // close enough to the frame's shape: fill it; otherwise the whole picture
  // over a blurred copy of itself (a landscape clip in a 9:16 short)
  if (Math.abs(Math.log(ar / tar)) < 0.42) {
    return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-ow)/2:${y},setsar=1`;
  }
  return `split[fa${tag}][fb${tag}];[fa${tag}]scale=${Math.round(w / 4)}:${Math.round(h / 4)}:force_original_aspect_ratio=increase,crop=${Math.round(w / 4)}:${Math.round(h / 4)},boxblur=10:2,eq=brightness=-0.06,scale=${w}:${h}[bg${tag}];`
    + `[fb${tag}]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg${tag}];[bg${tag}][fg${tag}]overlay=(W-w)/2:(H-h)/2,setsar=1`;
}

function effectChain(effect, W, H, dur) {
  const sc = (f) => `scale=w='trunc(${W}*(${f})/2)*2':h=-2:eval=frame,crop=${W}:${H}`;
  switch (effect) {
    case 'punch_in': return sc('if(lt(t,0.3),1.16-0.53*t,1)');
    case 'slow_zoom': return sc(`1+0.09*t/${dur.toFixed(2)}`);
    case 'zoom_out': return sc(`1.1-0.1*t/${dur.toFixed(2)}`);
    case 'flash': return 'fade=t=in:st=0:d=0.18:color=white';
    default: return '';
  }
}

/*
 * Blending without a second encode: a "fade" is the outgoing shot dipping to
 * black and the incoming one rising from it, a "flash" a burst of white — each
 * done on the EDGES of the two pieces as they are encoded, so the pieces still
 * join with a plain copy. The sound eases out and in across every join.
 */
function edgeFades(s, next, dur) {
  const v = [], a = [];
  const inT = s.transition, outT = next ? next.transition : null;
  if (inT === 'fade') { v.push(`fade=t=in:st=0:d=0.35`); a.push(`afade=t=in:st=0:d=0.3`); }
  else if (inT === 'flash') v.push(`fade=t=in:st=0:d=0.2:color=white`);
  else a.push(`afade=t=in:st=0:d=0.03`);
  if (outT === 'fade') { v.push(`fade=t=out:st=${Math.max(0, dur - 0.35).toFixed(3)}:d=0.35`); a.push(`afade=t=out:st=${Math.max(0, dur - 0.3).toFixed(3)}:d=0.3`); }
  else if (outT === 'flash') v.push(`fade=t=out:st=${Math.max(0, dur - 0.12).toFixed(3)}:d=0.12:color=white`);
  else a.push(`afade=t=out:st=${Math.max(0, dur - 0.03).toFixed(3)}:d=0.03`);
  return { v: v.join(','), a: a.join(',') };
}

/** One shot → a piece encoded exactly like every other piece, so they join without re-encoding. */
async function renderShot(ctx, s, W, H, keepAudio, out, next) {
  const c = s.cand, dur = s.seconds;
  const edge = edgeFades(s, next, dur);
  const args = ['-hide_banner', '-y'];
  let base;
  if (c.kind === 'image') {
    // a photo comes alive: a slow push in or pull out (zoompan makes the frames)
    const frames = Math.max(2, Math.round(dur * FPS));
    args.push('-i', c.file);
    const zoomIn = s.effect !== 'zoom_out';
    const z = zoomIn ? `1+0.12*on/${frames}` : `1.12-0.12*on/${frames}`;
    base = `[0:v]${fitChain(c, W, H, s.focus, 2, 'b')},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`
      + (s.effect === 'flash' && s.transition !== 'flash' ? ',fade=t=in:st=0:d=0.18:color=white' : '');
  } else {
    args.push('-ss', String(s.from), '-t', String(s.need + 0.1), '-i', c.file);
    const fx = effectChain(s.effect, W, H, dur);
    base = `[0:v]${s.slow ? 'setpts=2.0*PTS,' : ''}${fitChain(c, W, H, s.focus, 1, 'b')}${fx ? ',' + fx : ''},fps=${FPS}`;
  }
  let graph;
  let nextInput = 1;
  const o = s.overlay;
  if (o) {
    /*
     * B-ROLL: the picture changes, the sound does not. The overlay fades in
     * and out over the base shot, which keeps playing (and keeps its audio)
     * underneath: a full-frame cutaway with a gentle push, or a framed box.
     */
    const oc = o.cand;
    if (oc.kind === 'image') args.push('-loop', '1', '-t', String(o.len + 0.2), '-i', oc.file);
    else args.push('-ss', String(o.from || 0), '-t', String(o.len + 0.2), '-i', oc.file);
    nextInput = 2;
    let look;
    let x = '0', y = '0';
    if (o.style === 'pip') {
      const pw = Math.round((W * (W > H ? 0.34 : 0.5)) / 2) * 2, ph = Math.round((H * 0.34) / 2) * 2;
      look = `scale=${pw}:${ph}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,pad=iw+12:ih+12:6:6:white,setsar=1`;
      x = o.pos === 'left' ? '44' : `W-w-44`;
      y = `${Math.round(H * 0.11)}`;
    } else {
      look = `${fitChain(oc, W, H, 'center', 1, 'o')},scale=w='trunc(${W}*(1+0.07*t/${o.len.toFixed(2)})/2)*2':h=-2:eval=frame,crop=${W}:${H}`;
    }
    const ov = `[1:v]${look},fps=${FPS},format=yuva420p,fade=t=in:st=0:d=0.25:alpha=1,fade=t=out:st=${Math.max(0, o.len - 0.25).toFixed(3)}:d=0.25:alpha=1,`
      + `trim=0:${o.len.toFixed(3)},setpts=PTS-STARTPTS+${o.start.toFixed(3)}/TB[ov]`;
    graph = `${base}[bv];${ov};[bv][ov]overlay=${x}:${y}:eof_action=pass:enable='between(t,${o.start.toFixed(3)},${(o.start + o.len).toFixed(3)})'${edge.v ? ',' + edge.v : ''},format=yuv420p[v]`;
  } else {
    graph = `${base}${edge.v ? ',' + edge.v : ''},format=yuv420p[v]`;
  }
  const withSound = keepAudio && c.kind === 'video' && c.hasAudio;
  let a;
  if (withSound) {
    a = `[0:a]${s.slow ? 'atempo=0.5,' : ''}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${dur.toFixed(3)}${edge.a ? ',' + edge.a : ''}[a]`;
  } else {
    args.push('-f', 'lavfi', '-t', String(dur + 0.1), '-i', 'anullsrc=r=48000:cl=stereo');
    a = `[${nextInput}:a]anull[a]`;
  }
  args.push('-filter_complex', `${graph};${a}`, '-map', '[v]', '-map', '[a]', '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-r', String(FPS), '-pix_fmt', 'yuv420p',
    '-video_track_timescale', '30000', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', out);
  await ff.runFfmpeg(ctx.ffmpeg, args);
  return out;
}

async function render(ctx, plan, { aspect, keepAudio, output, tmp, onProgress }) {
  const { w: W, h: H } = ASPECTS[aspect] || ASPECTS['9:16'];
  const pieces = [];
  for (let i = 0; i < plan.shots.length; i++) {
    pieces.push(await renderShot(ctx, plan.shots[i], W, H, keepAudio, path.join(tmp, `shot-${String(i).padStart(3, '0')}.mp4`), plan.shots[i + 1]));
    if (onProgress) onProgress(Math.round(((i + 1) / plan.shots.length) * 95));
  }
  const list = path.join(tmp, 'pieces.txt');
  fs.writeFileSync(list, pieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await ff.runFfmpeg(ctx.ffmpeg, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output]);
  if (onProgress) onProgress(100);
  return output;
}

/* --------------------------------------------------------------------- make */

/**
 * The whole job. `stage(name)` says what is happening (for the phone), and
 * `onProgress(pct)` how far through the whole thing it is.
 */
async function make(ctx, getInfo, { mediaPaths, musicPath, style, lengthSec, full, aspect, brief, keepAudio, output, onProgress, stage, log }) {
  const files = (mediaPaths || []).filter((p) => p && fs.existsSync(p)).slice(0, 60);
  if (!files.length) throw new Error('Add some videos or pictures first.');
  const opts = {
    style: STYLES[style] ? style : 'hype',
    full: !!full || lengthSec === 'all' || Number(lengthSec) === 0,
    lengthSec: clamp(Number(lengthSec) || 30, 8, 600), // up to ten minutes
    aspect: ASPECTS[aspect] ? aspect : '9:16',
    brief: brief ? String(brief).slice(0, 500) : '',
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-montage-'));
  const part = (a, b) => (p) => onProgress && onProgress(Math.round(a + (b - a) * (p / 100)));
  try {
    if (stage) stage('👀 Watching every clip and picture…');
    // a longer edit needs more moments to choose from (still within what one look can take)
    const budget = clamp(Math.round(opts.lengthSec / 2.5), 44, 90);
    const cands = await analyze(ctx, getInfo, files, { tmp, onProgress: part(0, 35), full: opts.full, budget });
    let music = null;
    if (musicPath && fs.existsSync(musicPath)) {
      if (stage) stage('🎵 Finding the beat of your song…');
      try { music = await beats(ctx, musicPath); } catch (e) { if (e instanceof jobs.CancelledError) throw e; music = null; }
    }
    if (onProgress) onProgress(38);
    if (stage) stage(process.env.ANTHROPIC_API_KEY ? '🎬 Claude is directing your edit…' : '🎬 Directing your edit…');
    const d = await direct(cands, opts, music, log);
    if (onProgress) onProgress(50);
    const plan = finalise(d.plan, cands, opts, music);
    if (stage) stage(opts.full ? `🎞 Blending all ${plan.shots.length} together…` : `✂️ Cutting ${plan.shots.length} shots together…`);
    await render(ctx, plan, { aspect: opts.aspect, keepAudio: keepAudio !== false, output, tmp, onProgress: part(50, 100) });
    return {
      output,
      duration: plan.duration,
      aspect: opts.aspect,
      director: d.director,
      model: d.model,
      concept: plan.concept,
      title: plan.title,
      postCaption: plan.postCaption,
      hashtags: plan.hashtags,
      texts: plan.texts,
      bpm: music ? music.bpm : null,
      full: opts.full,
      overlays: plan.shots.filter((s) => s.overlay).map((s) => ({ at: round2(s.at + s.overlay.start), seconds: s.overlay.len, style: s.overlay.style, file: s.overlay.cand.file })),
      shots: plan.shots.map((s) => ({ at: s.at, seconds: s.seconds, effect: s.effect, transition: s.transition, file: s.cand.file, kind: s.cand.kind, from: s.from == null ? null : s.from })),
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

/** Which director the montage would use right now (for the phone to say so). */
function directorStatus() {
  if (process.env.ANTHROPIC_API_KEY) return { director: 'claude', model: process.env.MW_MONTAGE_MODEL || 'claude-opus-5-5' };
  try { const cw = require('./cloudwrite'); if (cw.access && cw.access().key) return { director: 'groq', model: '' }; } catch (e) {}
  return { director: 'rules', model: '' };
}

module.exports = { make, analyze, beats, finalise, directByRules, directorStatus, PLAN_SCHEMA, ASPECTS, STYLES, EFFECTS, TRANSITIONS, OVERLAY_STYLES, _direct: direct };
