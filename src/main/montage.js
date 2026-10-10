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
const crypto = require('crypto');
const ff = require('./ffmpeg');
const jobs = require('./jobs');
const machine = require('./machine');

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
const OVERLAY_STYLES = ['cutaway', 'pip', 'snapshot'];
/* the rules editor's mix: mostly cutaways, every third a box, and every fourth clip a snapshot (a still of it) */
const ruleStyle = (n, cand) => (cand && cand.kind === 'video' && n % 4 === 0) ? 'snapshot' : (n % 3 === 0 ? 'pip' : 'cutaway');
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
    // keeping everything, nothing is cut on a scene change: the loudest moment
    // (for the director's look at the clip) is all that is needed
    if (!full) { try { scenes = await sceneTimes(ctx, v.file, D); } catch (e) { if (e instanceof jobs.CancelledError) throw e; } }
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
          style: { type: 'string', enum: OVERLAY_STYLES, description: '"cutaway" fills the frame; "pip" is a framed box in a corner; "snapshot" freezes one frame of the picture as a tilted white-bordered photo that pops in with a camera flash.' },
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
- Overlays (B-roll) are what make it feel produced: lay a photo or another clip ON TOP of a video shot while that shot's sound carries on — show what is being preached or sung about, a reaction, the crowd, a moment from earlier. "cutaway" fills the frame; "pip" is a framed box in a corner; "snapshot" is a still from a clip popping on screen like a photo just taken (with a flash) — perfect for hype: the crowd jumping, hands raised, the preacher's big moment, frozen for a beat. Use them on video shots whose sound carries (speech, singing, a crowd), 1.5–3.5 s each, never in the first second of the hook. A video shot can carry SEVERAL overlays, each with its own start — on a long clip, bring a picture in every 5–8 seconds so the eye always has something new while the sound tells the story.
- Effects are seasoning: punch_in or flash on the biggest beats, slow_zoom / zoom_out to give photos life, slow_motion for one emotional peak at most. Most shots are a plain "cut".
- On-screen words: one hook in the first shot (max 7 words, curiosity or emotion, no clickbait lies), short beats that carry the story (max 6 words each — one every 4–8 shots, and on a long piece one every 20–30 seconds so the words keep telling it), and a call to action at the end ("cta", e.g. an invitation to come, follow or share). Plain words, no emojis inside the video text, no hashtags in it.
- Respect the faith context: uplifting, sincere, never mocking.
- post_caption: the caption for the post, warm and specific, one or two short lines, at most one emoji. hashtags: 4–8, relevant, without the # sign.
Only use ids from the list. Every shot's seconds must fit the footage that candidate has (photos can be held as long as needed).`;

function describe(c) {
  if (c.kind === 'image') return `${c.id}: PHOTO "${c.name}" (${c.w}x${c.h})`;
  if (c.whole) return `${c.id}: VIDEO "${c.name}", ${c.fileDur}s, plays IN FULL (its seconds are fixed), loudness ${c.loud}, action ${c.energy}${c.hasAudio ? '' : ', silent'}`;
  const len = round2(Math.min(c.fileDur, Math.max(c.end - c.start, 0) + 3));
  return `${c.id}: VIDEO "${c.name}" moment at ${c.start}s–${c.end}s of ${c.fileDur}s, up to ${len}s usable, loudness ${c.loud}, action ${c.energy}${c.hasAudio ? '' : ', silent'}`;
}

/* ------------------------------------------------- the operator's own words */

/*
 * "What's it about?" is the STORY of the montage, so it is honoured however
 * the edit is directed: the AI is told to build the hook, the words on screen,
 * the title, the caption and the hashtags from it; without AI it becomes them;
 * and anything the AI left empty is filled from it. Names, places and dates are
 * kept exactly as the operator wrote them.
 */
const STOP = new Set(('the a an and or but of to in on at for with from by is are was were be been this that these those it its our your my their his her we you they i me us them '
  + 'about into over after before during three two one four five days day night week weekend time all some more most very just so then than as up out').split(' '));

function cleanBrief(b) {
  return String(b == null ? '' : b).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}
/*
 * ►► "WHAT'S IT ABOUT?", IN PARTS. ◄◄ Beside the free words (the brief), the
 * phone asks the few things an editor always wants to know: the occasion, who
 * is speaking, the church, the message to keep to and what people should do
 * next. Each is short, plain text — nothing here is trusted as an instruction.
 */
const ABOUT_KEYS = ['occasion', 'speaker', 'church', 'focus', 'cta'];
function cleanAbout(a) {
  const out = {};
  if (!a || typeof a !== 'object') return out;
  for (const k of ABOUT_KEYS) {
    const v = cleanBrief(a[k]).slice(0, k === 'cta' || k === 'focus' ? 160 : 80);
    if (v) out[k] = v;
  }
  return out;
}
/** What the edit is about in one line, for when no AI is there: the operator's words, else the message, else the occasion. */
function briefText(opts) {
  const a = opts.about || {};
  return opts.brief || a.focus || [a.occasion, a.church].filter(Boolean).join(' at ') || '';
}
/** The parts, told to the AI. */
function aboutLines(opts) {
  const a = opts.about || {};
  const L = [];
  if (a.occasion) L.push(`Occasion: ${a.occasion}.`);
  if (a.speaker) L.push(`Speaker: ${a.speaker} — spell the name exactly like this wherever it appears (title, caption, words on screen).`);
  if (a.church) L.push(`Church / ministry: ${a.church} — spell it exactly like this.`);
  if (a.focus) L.push(`THE MESSAGE TO KEEP TO: "${a.focus}". Choose the moments that carry this message above everything else; the hook and the payoff should land it.`);
  if (a.cta) L.push(`Call to action, in the operator's words: "${a.cta}". End the post caption with it${opts.voice ? ', and make the narrator\'s closing line say it in plain spoken words' : ''}.`);
  return L;
}
/** The caption and hashtags always carry the call to action, the speaker and the church, however the edit was directed. */
function withAbout(plan, about) {
  const a = about || {};
  if (!a.cta && !a.speaker && !a.church) return plan;
  // whole words only: "Ade" is not named by "made"
  const esc = (x) => String(x).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = (txt, x) => new RegExp('(^|[^\\p{L}\\p{N}])' + esc(x) + '(?![\\p{L}\\p{N}])', 'iu').test(String(txt || ''));
  let cap = String(plan.postCaption || '').trim();
  // the call to action goes LAST — taken out wherever the AI put it, and put back at the end
  // (only when it closes the caption — one inside a sentence stays where it is)
  let ctaAt = false;
  if (a.cta) {
    const end = new RegExp('\\s*' + esc(a.cta) + '[\\s.!]*$', 'iu');
    if (end.test(cap)) { cap = cap.replace(end, '').trim(); ctaAt = true; }
  }
  if (a.speaker && !named(cap, a.speaker)) cap = [cap, `🎤 ${a.speaker}${a.church && !named(cap, a.church) ? ' · ' + a.church : ''}`].filter(Boolean).join('\n\n');
  else if (a.church && !named(cap, a.church)) cap = [cap, `⛪ ${a.church}`].filter(Boolean).join('\n\n');
  if (a.cta && (ctaAt || !named(cap, a.cta))) cap = [cap, a.cta].filter(Boolean).join('\n\n');
  const tags = (plan.hashtags || []).slice();
  for (const name of [a.church, a.speaker]) {
    const t = String(name || '').replace(/[^\p{L}\p{N}]+/gu, '');
    if (t.length >= 3 && t.length <= 30 && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.unshift(t);
  }
  return Object.assign(plan, { postCaption: cap.slice(0, 900), hashtags: tags.slice(0, 12) });
}
const words = (t) => String(t).split(' ').filter(Boolean);
const tidy = (t) => String(t).replace(/^[\s,;:.!?\-–—"'“”]+|[\s,;:\-–—"'“”]+$/g, '').trim();

/** The operator's words → a hook, story beats, a caption and hashtags. */
function fromBrief(brief) {
  const b = cleanBrief(brief);
  if (!b) return null;
  // clauses: sentences, dashes, colons and semicolons, then commas
  const clauses = b.split(/(?:[.!?;:]+\s+|\s+[—–-]\s+|\s*[—–]\s*|\n)/).map(tidy).filter(Boolean);
  let first = clauses[0] || b;
  if (words(first).length < 2 && clauses[1]) first = first + ' ' + clauses[1];
  // a short sentence is kept whole (a name like "The Power House church" is
  // never cut in half); a longer one gives its first seven words
  const hook = tidy(words(first).slice(0, words(first).length <= 9 ? 9 : 7).join(' '));
  const rest = clauses.slice(words(clauses[0] || '').length >= 2 ? 1 : 2).join(', ');
  const beats = rest.split(/\s*,\s*|\s+and\s+(?=\w+\s+\w+)/).map(tidy).filter((x) => words(x).length >= 1)
    .map((x) => tidy(words(x).slice(0, 6).join(' '))).slice(0, 3);
  const caption = b.charAt(0).toUpperCase() + b.slice(1);
  const tags = [];
  for (const w of words(b.toLowerCase().replace(/[^\p{L}\p{N}\s#]/gu, ' '))) {
    const t = w.replace(/^#/, '');
    if (t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t) && !tags.includes(t)) tags.push(t);
    if (tags.length >= 4) break;
  }
  for (const t of ['church', 'faith']) if (!tags.includes(t)) tags.push(t);
  return { text: b, hook, beats, caption: caption.length > 300 ? caption.slice(0, 297).replace(/\s+\S*$/, '') + '…' : caption, hashtags: tags };
}

function briefOf(opts, music) {
  const lines = [
    `Style: ${opts.style} — ${STYLES[opts.style] || STYLES.hype}`,
    opts.full
      ? `KEEP EVERYTHING: the operator wants nothing cut out. Use EVERY candidate exactly once. Videos play in full — you choose the ORDER, how each one comes in (transition), its effect and focus. PHOTOS: lay most of them ON the videos as overlays, spread right through each clip (a picture every 5–8 s, matched to what is being said or shown, mostly "cutaway", sometimes "pip"), while the clip's own sound plays on; a few may stand on their own between videos (2–5 s, with motion) as a breath. NEVER put the photos in a block after the videos. Blend it all into one flowing piece with the words on screen. Frame: ${opts.aspect}.`
      : `Target length: about ${opts.lengthSec} seconds${opts.lengthSec >= 90 ? ' (a longer piece: build it in movements — a hook, then sections that each rise and land; strong moments may return)' : ''}. Frame: ${opts.aspect}.`,
    music ? `Music: the operator's own song, ${music.bpm} BPM (one beat = ${music.interval}s). Shot lengths should be whole numbers of beats.` : 'No music chosen: the clips\' own sound plays.',
  ];
  if (opts.keepOrder) lines.push('ORDER IS THE OPERATOR\'S: the candidates are listed in the order they chose. Keep the shots in that order — do not reorder them. You still choose lengths, effects, transitions, overlays and words.');
  lines.push(...aboutLines(opts));
  if (opts.brief) {
    lines.push(`WHAT IT IS ABOUT, in the operator's own words: "${cleanBrief(opts.brief)}"`);
    lines.push('This is the story of the edit. Choose and order the shots to tell it. The hook, every word on screen, the title, the post caption and the hashtags must be about THIS — use its names, places, dates and numbers exactly as written, and never invent details it does not give.');
  }
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

/*
 * ►► GROQ LOOKS TOO. ◄◄
 * Groq's free vision models take only a handful of pictures per request, so
 * the candidate frames are laid out on CONTACT SHEETS — up to sixteen tiles
 * each, every tile stamped with its id — and three sheets carry forty-odd
 * moments in one look. The model then directs from what it SEES, like Claude
 * does, instead of from a list of loudness numbers.
 */
let hasDrawtext = null; // not every ffmpeg build has it (the bundled one has no freetype)
async function canDrawText(ctx) {
  if (hasDrawtext !== null) return hasDrawtext;
  try { const { stdout } = await collect(ctx.ffmpeg, ['-hide_banner', '-filters'], { stdout: true }); hasDrawtext = /\bdrawtext\b/.test(stdout.toString()); }
  catch (e) { hasDrawtext = false; }
  return hasDrawtext;
}

async function contactSheets(ctx, cands, tmp) {
  let font = null;
  try { const f = path.join(require('./captioner').fontsDir(), 'Poppins-Bold.ttf'); if (fs.existsSync(f) && await canDrawText(ctx)) font = f; } catch (e) {}
  const esc = (t) => String(t).replace(/[\\:']/g, '\\$&');
  const fontArg = font ? `:fontfile='${esc(font)}'` : '';
  const tiles = [];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const out = path.join(tmp, `tile-${String(i).padStart(3, '0')}.jpg`);
    const label = font ? `,drawtext=text='${esc(c.id)}'${fontArg}:fontsize=34:fontcolor=yellow:box=1:boxcolor=black@0.75:boxborderw=6:x=8:y=8` : '';
    const vf = `scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2:color=0x101014${label}`;
    const args = c.thumb ? ['-hide_banner', '-y', '-i', c.thumb, '-vf', vf, '-frames:v', '1', '-q:v', '4', out]
      : ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=0x101014:s=256x256:d=1', '-vf', vf.replace(/^scale[^,]*,pad[^,]*/, 'null'), '-frames:v', '1', out];
    try { await collect(ctx.ffmpeg, args); } catch (e) { if (e instanceof jobs.CancelledError) throw e; }
    tiles.push(fs.existsSync(out) ? out : null);
  }
  const sheets = [];
  for (let k = 0; k < tiles.length; k += 16) {
    const group = tiles.slice(k, k + 16);
    const dirK = path.join(tmp, `sheet-${k}`);
    fs.mkdirSync(dirK, { recursive: true });
    group.forEach((t, j) => { try { if (t) fs.copyFileSync(t, path.join(dirK, `t${String(j).padStart(3, '0')}.jpg`)); } catch (e) {} });
    const cols = Math.min(4, group.length), rows = Math.ceil(group.length / cols);
    const out = path.join(tmp, `sheet-${k}.jpg`);
    try {
      await collect(ctx.ffmpeg, ['-hide_banner', '-y', '-framerate', '1', '-i', path.join(dirK, 't%03d.jpg'),
        '-vf', `tile=${cols}x${rows}:padding=4:color=0x000000`, '-frames:v', '1', '-q:v', '4', out]);
    } catch (e) { if (e instanceof jobs.CancelledError) throw e; }
    if (fs.existsSync(out)) sheets.push({ file: out, ids: cands.slice(k, k + 16).map((c) => c.id), cols });
  }
  return { sheets, labelled: !!font };
}

async function directWithGroqVision(cands, opts, music, ctx, tmp) {
  let cw, see;
  try { cw = require('./cloudwrite'); see = require('./cloudsee'); } catch (e) { return null; }
  const a = cw.access && cw.access();
  if (!a || !a.key || !a.url || !ctx || !tmp) return null;
  const models = ((see.VISION && see.VISION[a.provider]) || []).slice(0, 3);
  if (a.provider === 'custom' && a.model) models.unshift(a.model);
  if (!models.length) return null;
  const { sheets, labelled } = await contactSheets(ctx, cands, tmp);
  if (!sheets.length) return null;
  const where = sheets.map((sh, i) => `Sheet ${i + 1}: ${sh.ids.join(', ')} (${labelled ? 'each tile is stamped with its id' : `tiles in reading order, ${sh.cols} per row`})`).join('\n');
  const prompt = briefOf(opts, music) + '\n\nCandidates:\n' + cands.map(describe).join('\n')
    + '\n\nThe pictures are contact sheets of those candidates — look at them to choose:\n' + where
    + '\n\nReply with JSON only, exactly this shape: {"concept":"","title":"","shots":[{"id":"c1","seconds":2,"effect":"cut","focus":"center","transition":"cut"}],'
    + '"texts":[{"at_shot":0,"span_shots":1,"text":"","role":"hook"}],"overlays":[{"on_shot":1,"id":"c5","style":"cutaway","start":0.8,"seconds":2}],"post_caption":"","hashtags":[""]}. Effects: '
    + EFFECTS.join(', ') + '. Transitions: ' + TRANSITIONS.join(', ') + '. Overlay styles: ' + OVERLAY_STYLES.join(', ') + '.';
  const content = [{ type: 'text', text: prompt }];
  for (const sh of sheets.slice(0, 4)) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + fs.readFileSync(sh.file).toString('base64') } });
  for (const model of models) {
    const body = { model, temperature: 0.7, max_tokens: 6000, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }] };
    if (/qwen3/i.test(model)) body.reasoning_effort = 'none';
    let res;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120000);
      try { res = await fetch(a.url, { method: 'POST', headers: a.headers, body: JSON.stringify(body), signal: ac.signal }); }
      finally { clearTimeout(timer); }
    } catch (e) { continue; }
    if (!res || !res.ok) continue;
    let j = null; try { j = await res.json(); } catch (e) { j = null; }
    const plan = cw.parseJson(cw.textFrom(j) || '');
    if (plan && Array.isArray(plan.shots) && plan.shots.length) return { plan, director: 'groq', model, vision: true };
  }
  return null;
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
  const fb = fromBrief(briefText(opts));
  const hook0 = fb ? fb.hook : '';
  if (opts.full) {
    // everything, strongest first, photos spread between the videos, a fade
    // wherever it moves from one file to the next kind of thing
    // the videos strongest first; the photos after them, which finalise lays
    // through the videos as B-roll (spreadPhotos) — or, with no video, in order
    const vids = cands.filter((c) => c.kind === 'video').sort((a, b) => b.score - a.score);
    const pics = cands.filter((c) => c.kind === 'image');
    const order = vids.concat(pics);
    const shots = order.map((c, i) => ({
      id: c.id, seconds: c.kind === 'image' ? 3 : c.fileDur, focus: 'center',
      effect: c.kind === 'image' ? (i % 2 ? 'zoom_out' : 'slow_zoom') : (i === 0 ? 'punch_in' : 'cut'),
      transition: i === 0 ? 'cut' : (order[i - 1].kind !== c.kind ? 'fade' : (i % 3 === 0 ? 'flash' : 'cut')),
    }));
    return { plan: { concept: 'Everything kept, blended into one piece.', title: hook0 || 'Highlights', shots,
      texts: briefTexts(fb, shots.length), overlays: [],
      post_caption: fb ? fb.caption : '', hashtags: fb ? fb.hashtags : [] }, director: 'rules', model: '' };
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
  // the operator's own words open it, carry it and caption it
  return { plan: { concept: 'Strongest moments first, cut to the rhythm.', title: hook0 || 'Highlights', shots,
    texts: briefTexts(fb, shots.length),
    overlays: rulesOverlays(shots, cands),
    post_caption: fb ? fb.caption : '', hashtags: fb ? fb.hashtags : [] }, director: 'rules', model: '' };
}

/** The brief's hook on the first shots and its beats spread through the rest. */
function briefTexts(fb, n) {
  if (!fb || !n) return [];
  const out = [{ at_shot: 0, span_shots: Math.min(2, n), text: fb.hook, role: 'hook' }];
  const free = n - 2;
  fb.beats.forEach((t, k) => {
    if (free < 1) return;
    const at = Math.min(n - 1, 2 + Math.floor(((k + 0.5) * free) / Math.max(1, fb.beats.length)));
    if (out.some((x) => x.at_shot === at)) return;
    out.push({ at_shot: at, span_shots: 1, text: t, role: 'beat' });
  });
  return out;
}

async function direct(cands, opts, music, log, ctx, tmp) {
  for (const [name, fn] of [['Claude', directWithClaude], ['Groq (looking)', directWithGroqVision], ['Groq', directWithGroq]]) {
    try {
      const r = await fn(cands, opts, music, ctx, tmp);
      if (r && r.plan && Array.isArray(r.plan.shots) && r.plan.shots.length) return r;
    } catch (e) {
      if (e instanceof jobs.CancelledError) throw e;
      if (log) log(`${name} could not direct the montage: ${e && e.message}`);
    }
  }
  return directByRules(cands, opts, music);
}

/* ----------------------------------------------------------------- finalise */

/*
 * ►► PHOTOS GO ON THE VIDEOS, NOT AFTER THEM. ◄◄
 * Keeping everything, a director that ordered the videos and left the photos
 * (or that the plan topped up with what it skipped) put every picture in one
 * block after the last clip: forty photos at the end of nine minutes of video.
 * Those photos become B-roll laid THROUGH the videos instead — about every six
 * and a half seconds a picture for three, mostly full-frame, now and then a
 * framed box, the clip's own sound carrying on underneath — in the order they
 * were given. What the videos cannot carry stands between them, spread out,
 * never piled up at the end. Photos the director placed between videos stay.
 */
const OV_EVERY = 6.5, OV_LEN = 3;
function spreadPhotos(shots) {
  const isVid = (s) => s.cand.kind === 'video';
  const lastV = shots.map(isVid).lastIndexOf(true);
  if (lastV < 0) return;                                   // photos only: nothing to lay them on
  // after the last video, or a third photo in a row between videos
  let run = 0;
  const movable = shots.filter((s, i) => {
    if (isVid(s)) { run = 0; return false; }
    run++;
    return i > lastV || run > 2;
  });
  if (!movable.length) return;
  for (const m of movable) shots.splice(shots.indexOf(m), 1);
  const vids = shots.filter(isVid);
  // a clip of 5.5 s or more carries one picture; longer, one every 6.5 s —
  // closer (down to every 5 s: three of picture, two of the clip) when there
  // are more photos than that, so they do not pile up between the clips
  const capAt = (every) => vids.map((v) => Math.max(0, (v.seconds >= OV_LEN + 2.5 ? Math.max(1, Math.floor((v.seconds - 1.5) / every)) : 0) - (v.ovReq || []).length));
  let cap = capAt(OV_EVERY);
  for (let every = OV_EVERY - 0.5; every >= 5 - 1e-9 && cap.reduce((a, b) => a + b, 0) < movable.length; every -= 0.5) cap = capAt(every);
  const total = cap.reduce((a, b) => a + b, 0);
  // a few always stand between the videos — a breath between clips
  // every photo goes ON a clip; one stands alone only when the clips are full
  const stand = Math.max(0, movable.length - total);
  const onTop = movable.length - stand;
  // overlay pictures shared across the videos by how much each can carry, in order
  // every clip that can carry one gets one first, then the rest by how much more each can take
  const want = cap.map(() => 0);
  let left = onTop;
  cap.forEach((c, j) => { if (c > 0 && left > 0) { want[j] = 1; left--; } });
  const more = cap.map((c, j) => c - want[j]);
  const room = more.reduce((a, b) => a + b, 0);
  if (room > 0 && left > 0) {
    const share = more.map((m) => (m / room) * left);
    share.forEach((x, j) => { want[j] += Math.floor(x); });
    let rest = onTop - want.reduce((a, b) => a + b, 0);
    share.map((x, j) => [x - Math.floor(x), j]).sort((a, b) => b[0] - a[0]).forEach(([, j]) => { if (rest > 0 && want[j] < cap[j]) { want[j]++; rest--; } });
  }
  // standalone pictures: spread evenly through the gaps between videos
  const gaps = Math.max(1, vids.length - 1);
  const standAt = new Array(vids.length).fill(0);
  for (let k = 0; k < stand; k++) standAt[Math.min(vids.length - 1, Math.floor(((k + 0.5) * gaps) / stand))]++;
  // a gap that would hold more than two gives the rest back to the clips as
  // B-roll wherever there is still room at the closest spacing
  const most = capAt(5);
  for (let j = 0; j < vids.length; j++) {
    while (standAt[j] > 2) {
      const k = most.findIndex((m, i) => m > want[i]);
      if (k < 0) break;
      want[k]++; standAt[j]--;
    }
  }
  let p = 0, styleN = 0;
  vids.forEach((v, j) => {
    v.ovReq = v.ovReq || [];
    const n = want[j];
    for (let k = 0; k < n && p < movable.length; k++) {
      const start = ((k + 0.5) * v.seconds) / n - OV_LEN / 2;
      v.ovReq.push({ cand: movable[p].cand, style: ruleStyle(++styleN, movable[p++].cand), start, seconds: OV_LEN });
    }
    // the standalone ones go after this video
    // (more than two between clips — only when the clips are already full of
    // pictures — become a quick burst, two seconds each, not a slideshow)
    let at = shots.indexOf(v) + 1;
    for (let k = 0; k < standAt[j] && p < movable.length; k++) {
      const m = movable[p++];
      m.transition = k === 0 ? 'fade' : 'cut';
      if (standAt[j] > 2) m.seconds = 2;
      shots.splice(at++, 0, m);
    }
  });
  while (p < movable.length) shots.push(movable[p++]);      // (only if every count above was short)
}

/*
 * ►► A TIMED MONTAGE LAYS ITS PHOTOS OVER THE CLIPS TOO. ◄◄
 * With a length chosen (15 s … 10 min) the photos the director picked stood
 * as their own shots — in a test with 30 photos, none over a clip and half of
 * them after the last one. They now go ON the video shots, spread through the
 * edit, while the clip's sound carries on; the time they took is given back
 * to the video shots (as far as each has footage), so the length is still
 * the one asked for. The opening shot keeps its hook clear.
 */
function layPhotosOverClips(shots) {
  const isVid = (s) => s.cand.kind === 'video';
  const vids = shots.filter(isVid);
  const pics = shots.filter((s) => !isVid(s));
  if (!vids.length || !pics.length) return;
  let freed = pics.reduce((n, s) => n + s.seconds, 0);
  for (const m of pics) shots.splice(shots.indexOf(m), 1);
  // a picture the director already laid over a clip is not laid a second time
  const already = new Set(vids.flatMap((v) => (v.ovReq || []).map((o) => o.cand.id)));
  for (let k = pics.length - 1; k >= 0; k--) if (already.has(pics[k].cand.id)) pics.splice(k, 1);
  // the freed time back to the clips, each up to the footage it has
  for (let pass = 0; pass < 4 && freed > 0.05; pass++) {
    const room = vids.map((v) => Math.max(0, (v.cand.fileDur - 0.05) * (v.slow ? 2 : 1) - v.seconds));
    const total = room.reduce((a, b) => a + b, 0);
    if (total <= 0.05) break;
    const give = Math.min(freed, total);
    vids.forEach((v, i) => { const add = (room[i] / total) * give; v.seconds += add; });
    freed -= give;
  }
  // which clips carry them: spread through the edit, skipping the hook
  const hosts = vids.filter((v, i) => v.seconds >= 1.5 && !(shots.indexOf(v) === 0 && vids.length > 1));
  if (!hosts.length) return;
  const capOf = (v) => Math.max(1, Math.floor((v.seconds - 0.5) / 4));
  // round the clips, one picture at a time, so they spread through the edit
  const want = hosts.map(() => 0);
  let left = pics.length;
  for (let k = 0; left > 0 && k < pics.length * hosts.length; k++) {
    const j = k % hosts.length;
    if (want[j] < capOf(hosts[j])) { want[j]++; left--; }
  }
  let p = 0, styleN = 0;
  hosts.forEach((v, j) => {
    const n = want[j];
    for (let i = 0; i < n && p < pics.length; i++) {
      const seg = v.seconds / n;
      const len = clamp(seg * 0.65, 1, OV_LEN);
      v.ovReq.push({ cand: pics[p].cand, style: ruleStyle(++styleN, pics[p++].cand), start: i * seg + (seg - len) / 2, seconds: len });
    }
  });
}

/*
 * Keeping the operator's order: each photo belongs to the video it was put
 * after (photos before the first video, to the first one). A video carries
 * its own photos as B-roll, spread through it, as many as fit at the closest
 * spacing; the rest stand right after it, in order — as a quick burst when
 * there are more than two. Photos-only montages are left exactly as ordered.
 */
function keepOrderPhotos(shots) {
  const isVid = (s) => s.cand.kind === 'video';
  if (!shots.some(isVid)) return;
  // Photos added AFTER every video (the usual way: the clips first, then the
  // pictures) belong to no clip in particular — they were all landing on the
  // last one and piling up after it. They are laid through ALL the clips, in
  // order, by spreadPhotos below. Photos placed between clips stay with the
  // clip before them.
  const lastV = shots.map(isVid).lastIndexOf(true);
  const loose = shots.slice(lastV + 1);
  shots.splice(lastV + 1);
  const own = new Map();
  let owner = shots.find(isVid);
  for (const sh of shots) {
    if (isVid(sh)) { owner = sh; if (!own.has(sh)) own.set(sh, []); continue; }
    if (!own.has(owner)) own.set(owner, []);
    own.get(owner).push(sh);
  }
  const vids = shots.filter(isVid);
  shots.length = 0;
  let styleN = 0;
  for (const v of vids) {
    const pics = own.get(v) || [];
    v.ovReq = v.ovReq || [];
    const fit = Math.max(0, (v.seconds >= OV_LEN + 2.5 ? Math.max(1, Math.floor((v.seconds - 1.5) / 5)) : 0) - v.ovReq.length);
    const on = pics.slice(0, fit), after = pics.slice(fit);
    on.forEach((m, k) => {
      const start = ((k + 0.5) * v.seconds) / on.length - OV_LEN / 2;
      v.ovReq.push({ cand: m.cand, style: ruleStyle(++styleN, m.cand), start, seconds: OV_LEN });
    });
    shots.push(v);
    after.forEach((m, k) => {
      m.transition = k === 0 ? 'fade' : 'cut';
      if (after.length > 2) m.seconds = 2;
      shots.push(m);
    });
  }
  if (loose.length) { shots.push(...loose); spreadPhotos(shots); }
}

/**
 * The model's plan made safe and exact: known shots only, lengths that fit the
 * footage, cuts on the beat, words timed to the shots they belong to.
 */
function finalise(raw, cands, opts, music) {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const shots = [];
  const fromRaw = new Map();   // the director's shot index → the shot it became
  (raw.shots || []).forEach((s, ri) => {
    const c = byId.get(String(s && s.id || '').trim());
    if (!c) return;
    const before = shots.length;
    addShot(s, c);
    if (shots.length > before) fromRaw.set(ri, shots[shots.length - 1]);
  });
  function addShot(s, c) {
    let effect = EFFECTS.includes(s.effect) ? s.effect : 'cut';
    const focus = ['center', 'top', 'bottom'].includes(s.focus) ? s.focus : 'center';
    const transition = TRANSITIONS.includes(s.transition) ? s.transition : 'cut';
    if (opts.full) {
      // every file once, videos whole (slow motion would double a whole clip)
      if (shots.some((x) => x.cand.id === c.id)) return;
      if (effect === 'slow_motion') effect = 'cut';
      const sec = c.kind === 'video' ? Math.max(0.4, c.fileDur - 0.05) : clamp(Number(s.seconds) || 3, 1.5, 6);
      shots.push({ cand: c, seconds: sec, effect, focus, slow: false, transition, ovReq: [] });
      return;
    }
    let sec = clamp(Number(s.seconds) || 2, 0.4, 12);
    const slow = effect === 'slow_motion' && c.kind === 'video';
    if (c.kind === 'video') sec = Math.min(sec, (c.fileDur - 0.05) * (slow ? 2 : 1));
    if (sec < 0.4) return;
    shots.push({ cand: c, seconds: sec, effect, focus, slow, transition, ovReq: [] });
  }
  // the director's B-roll, held on the shot it was asked for until the timing is known
  for (const o of (raw.overlays || [])) {
    const base = fromRaw.get(Math.round(Number(o && o.on_shot)));
    const oc = byId.get(String(o && o.id || '').trim());
    if (base && oc) base.ovReq.push({ cand: oc, style: o.style, start: Number(o.start), seconds: Number(o.seconds) });
  }
  /*
   * ►► THE OPERATOR'S ORDER. ◄◄
   * Asked to keep their order, the shots follow the order the files were put
   * in (within one file, its moments in time order), whatever the director
   * did. Keeping everything, each photo then goes on the video it was placed
   * after (see spreadPhotos).
   */
  if (opts.keepOrder) {
    const ord = (c) => (Number.isFinite(c.order) ? c.order : 1e6);
    shots.forEach((sh, k) => { sh._k = k; });
    shots.sort((a, b) => ord(a.cand) - ord(b.cand) || (a.cand.peak || 0) - (b.cand.peak || 0) || a._k - b._k);
    shots.forEach((sh) => { delete sh._k; });
  }
  // no more pictures on a shot than it can carry, one at a time with the clip
  // between them (keeping everything, the ones that do not fit stand on their own)
  for (const sh of shots) {
    const room = sh.cand.kind === 'video' ? Math.max(0, Math.floor((sh.seconds - 1.5) / (OV_LEN + 1))) : 0;
    if (sh.ovReq.length > room) sh.ovReq = sh.ovReq.sort((a, b) => (a.start || 0) - (b.start || 0)).slice(0, room);
  }
  if (!opts.full) layPhotosOverClips(shots);
  if (opts.full) {
    // nothing the operator gave is left out, even if the director skipped it
    // (a photo shown as an overlay counts as shown)
    const onTop = new Set(shots.flatMap((sh) => sh.ovReq.map((o) => o.cand.id)));
    for (const c of cands) {
      if (shots.some((x) => x.cand.id === c.id) || onTop.has(c.id)) continue;
      shots.push({ cand: c, seconds: c.kind === 'video' ? Math.max(0.4, c.fileDur - 0.05) : 3,
        effect: c.kind === 'image' ? 'slow_zoom' : 'cut', focus: 'center', slow: false, transition: 'fade', ovReq: [] });
    }
    if (opts.keepOrder) {
      const ord = (c) => (Number.isFinite(c.order) ? c.order : 1e6);
      shots.sort((a, b) => ord(a.cand) - ord(b.cand));
      keepOrderPhotos(shots);
    } else spreadPhotos(shots);
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
  // overlays: known pictures or clips over a VIDEO shot long enough to carry
  // them — as many as fit, each clear of the next, kept out of the hook's
  // first second, and on the beat when there is a song
  shots.forEach((base, i) => {
    base.overlays = [];
    if (base.cand.kind !== 'video' || base.seconds < (opts.full ? 2.2 : 1.5)) return;
    const reqs = (base.ovReq || []).filter((o) => o.cand.id !== base.cand.id)
      .map((o) => ({ ...o, start: Number.isFinite(o.start) ? o.start : 0.8 })).sort((a, b) => a.start - b.start);
    let free = i === 0 ? 1.2 : 0.3;
    for (const o of reqs) {
      let start = clamp(o.start, free, base.seconds - 1.2);
      let len = clamp(Number(o.seconds) || 2.5, 1, 4);
      if (music && music.beats && music.beats.length > 4) {
        // the picture lands on a beat and stays a whole number of them
        const abs = base.at + start;
        let best = null;
        for (const b of music.beats) { if (b < base.at + free - 1e-6) continue; if (best == null || Math.abs(b - abs) < Math.abs(best - abs)) best = b; if (b > abs + music.interval) break; }
        if (best != null) start = best - base.at;
        len = Math.max(music.interval, Math.round(len / music.interval) * music.interval);
      }
      start = round2(start);
      len = round2(Math.min(len, base.seconds - start - 0.15));
      if (len < (opts.full ? 1 : 0.8) || start < free - 1e-6) continue;
      const ov = { cand: o.cand, style: OVERLAY_STYLES.includes(o.style) ? o.style : 'cutaway', start, len, pos: ((i + base.overlays.length) % 2 ? 'left' : 'right') };
      if (o.cand.kind === 'video') ov.from = round2(clamp(o.cand.peak - len / 2, 0, Math.max(0, o.cand.fileDur - len - 0.05)));
      base.overlays.push(ov);
      free = start + len + 1.0;   // at least a second of the clip itself between pictures
    }
    delete base.ovReq;
  });
  const texts = [];
  for (const x of (raw.texts || [])) {
    // the director counted ITS shots; follow that shot to where it ended up
    const ri = Math.round(Number(x && x.at_shot));
    let i = fromRaw.has(ri) ? shots.indexOf(fromRaw.get(ri)) : ri;
    // its shot became a picture laid over a clip: the words go with the next shot still there
    if (i < 0 && fromRaw.has(ri)) {
      for (let r = ri + 1; i < 0 && fromRaw.has(r); r++) i = shots.indexOf(fromRaw.get(r));
      for (let r = ri - 1; i < 0 && r >= 0; r--) if (fromRaw.has(r)) i = shots.indexOf(fromRaw.get(r));
    }
    const text = String((x && x.text) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text || !(i >= 0 && i < shots.length)) continue;
    const span = clamp(Math.round(Number(x.span_shots) || 1), 1, shots.length - i);
    const last = shots[i + span - 1];
    const start = shots[i].at;
    const end = round2(Math.min(duration, Math.max(last.at + last.seconds, start + 1.2)));
    texts.push({ start, end, text, role: ['hook', 'beat', 'cta'].includes(x.role) ? x.role : 'beat' });
  }
  let tags = (Array.isArray(raw.hashtags) ? raw.hashtags : []).map((h) => String(h).replace(/^#+/, '').replace(/\s+/g, '')).filter(Boolean).slice(0, 10);
  // whatever the director left empty, the operator's own words fill
  const fb = fromBrief(briefText(opts));
  if (fb) {
    if (!texts.some((x) => x.role === 'hook') && fb.hook) {
      const first = shots[0];
      texts.unshift({ start: 0, end: round2(Math.min(duration, Math.max(first.seconds, 2.5))), text: fb.hook, role: 'hook' });
    }
    if (!tags.length) tags = fb.hashtags.slice();
  }
  return {
    concept: String(raw.concept || '').slice(0, 300),
    title: String(raw.title || (fb && fb.hook) || '').slice(0, 100),
    postCaption: String(raw.post_caption || (fb && fb.caption) || '').slice(0, 600),
    hashtags: tags,
    shots, texts, duration,
  };
}

/* ------------------------------------------------------------------- render */

function fitChain(c, W, H, focus, scale = 1, tag = '', fx = null, track = null) {
  const w = W * scale, h = H * scale;
  const y = focus === 'top' ? '0' : focus === 'bottom' ? '(ih-oh)' : '(ih-oh)/2';
  // ALWAYS FULL SCREEN: "even if I upload a 16:9 video and select 9:16 … no
  // gaps at the top and bottom, the video should just zoom in to cover the
  // gap". The picture is zoomed until it covers the whole frame and the spare
  // edges are cut off — never shown whole over a blurred copy of itself.
  // Across, it is cut round the person in it when the shot knows where they
  // stand (`fx`, 0 left … 1 right — findSpeakers), else round the middle.
  const at = typeof fx === 'number' && Number.isFinite(fx) ? clamp(fx, 0, 1) : 0.5;
  let x = at === 0.5 ? '(iw-ow)/2' : `'min(max(iw*${at.toFixed(3)}-ow/2,0),iw-ow)'`;
  // TRACKING: the cut pans with the person — from where they stand as the shot starts to where they are as it
  // ends (`track.fx2`), smoothly over its `dur` seconds; `t0` is how far into the shot this piece begins
  if (track && typeof track.fx2 === 'number' && Number.isFinite(track.fx2) && track.dur > 0 && Math.abs(track.fx2 - at) > 0.01) {
    const b = clamp(track.fx2, 0, 1), d = Math.max(0.1, track.dur), t0 = Math.max(0, track.t0 || 0);
    const u = `min(max((t+${t0.toFixed(3)})/${d.toFixed(3)},0),1)`;
    x = `'min(max(iw*(${at.toFixed(3)}+${(b - at).toFixed(3)}*${u})-ow/2,0),iw-ow)'`;
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:${x}:${y},setsar=1`;
}

/** `t0`: where in the shot this piece starts, so a zoom carries on across the sections of one shot. */
function effectChain(effect, W, H, dur, t0 = 0) {
  const sc = (f) => `scale=w='trunc(${W}*(${f})/2)*2':h=-2:eval=frame,crop=${W}:${H}`;
  const T = t0 ? `(t+${t0.toFixed(3)})` : 't';
  switch (effect) {
    case 'punch_in': return t0 >= 0.3 ? '' : sc(`if(lt(${T},0.3),1.16-0.53*${T},1)`);
    case 'slow_zoom': return sc(`1+0.09*${T}/${dur.toFixed(2)}`);
    case 'zoom_out': return sc(`1.1-0.1*${T}/${dur.toFixed(2)}`);
    case 'flash': return t0 ? '' : 'fade=t=in:st=0:d=0.18:color=white';
    // the talk edit's jump zooms: the same speaker, framed closer, cut to on a word
    case 'hold_in': return sc('1.12');
    case 'hold_tight': return sc('1.24');
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

/*
 * ►► A MONTAGE IS QUICK ON A SMALL SERVER. ◄◄
 * Timed on one core: a 3-second photo shot 5.6 s on 'veryfast', 2.0 s on
 * 'ultrafast'; ten seconds of 1080p video 9.4 s → 4.9 s. The pieces are the
 * finished file (they are joined without another encode), so they are made at
 * CRF 20 rather than the draft trick's lower number — a clean picture for a
 * social post at a sensible size. A desktop keeps 'medium' at CRF 18.
 *
 * And a 4K iPhone clip cost more to DECODE than to encode: ten seconds of 4K
 * 10-bit HEVC took 15 s just to read. Skipping the decoder's loop filter took
 * that to 9.6 s; shrunk to 1080 wide, the difference does not show.
 */
/* …with x264's deblocking, CABAC and two B-frames switched back on (ultrafast
 * drops them): on the operator's own clip that halved the file — 9.3 → 4.4
 * Mbit/s, a ten-minute montage 700 → 330 MB, the size a phone can actually
 * save — at a slightly HIGHER likeness to the source (SSIM 0.9895 → 0.9908),
 * for about a tenth more encoding time. */
const encodeOpts = () => (machine.small()
  ? ['-preset', 'ultrafast', '-crf', '23', '-x264-params', 'no-deblock=0:cabac=1:bframes=2']
  // a big server with no GPU (Oracle's free Ampere box): quick, with the bits to look right
  : machine.fastEncode() ? ['-preset', 'superfast', '-crf', '23', '-maxrate', '8M', '-bufsize', '16M']   // see quickPreset in ffmpeg.js
    : ['-preset', 'medium', '-crf', '18']);
const bigSource = (c, W, H) => !!(c && c.kind === 'video' && c.w && c.h && c.w * c.h > 2.5 * W * H);
const decodeOpts = (c, W, H) => (bigSource(c, W, H) ? ['-skip_loop_filter', 'all'] : []);

/**
 * One shot → a piece encoded exactly like every other piece, so they join
 * without re-encoding. A video shot carrying several pictures is made in
 * SECTIONS, one picture each (one ffmpeg holds one picture, so a long clip
 * with ten photos never needs ten in memory at once), and its sound is made
 * once for the whole shot and laid under them — no seam where sections meet.
 */
async function renderShot(ctx, s, W, H, keepAudio, out, next) {
  const ovs = s.overlays || [];
  if (s.cand.kind !== 'video' || ovs.length <= 1) return renderPiece(ctx, s, W, H, keepAudio, out, next, { overlay: ovs[0] });
  const dur = s.seconds;
  const totalFrames = Math.max(1, Math.round(dur * FPS));
  // cut halfway between one picture's end and the next one's start
  const cuts = [0];
  for (let k = 1; k < ovs.length; k++) cuts.push(Math.round(((ovs[k - 1].start + ovs[k - 1].len + ovs[k].start) / 2) * FPS));
  cuts.push(totalFrames);
  const base = out.replace(/\.mp4$/, '');
  const parts = [];
  for (let k = 0; k < ovs.length; k++) {
    const f0 = cuts[k], f1 = cuts[k + 1];
    if (f1 <= f0) continue;
    const t0 = f0 / FPS, len = (f1 - f0) / FPS;
    const sub = { ...s, from: round2(s.from + t0 / (s.slow ? 2 : 1)), need: round2(len / (s.slow ? 2 : 1)) + 0.05, seconds: len,
      transition: k === 0 ? s.transition : 'cut' };
    const o = { ...ovs[k], start: ovs[k].start - t0 };
    const part = `${base}-part${k}.mp4`;
    await renderPiece(ctx, sub, W, H, false, part, k === ovs.length - 1 ? next : null,
      { overlay: o, videoOnly: true, t0, effectDur: dur, frames: f1 - f0 });
    parts.push(part);
  }
  // the whole shot's sound, once
  const sound = `${base}-sound.m4a`;
  const edge = edgeFades(s, next, dur);
  const aargs = ['-hide_banner', '-y'];
  const withSound = keepAudio && s.cand.hasAudio && !s.mute;
  let a;
  if (withSound) {
    aargs.push('-ss', String(s.from), '-t', String(s.need + 0.1), '-i', s.cand.file);
    a = `[0:a]${s.slow ? 'atempo=0.5,' : ''}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${dur.toFixed(3)}${edge.a ? ',' + edge.a : ''}[a]`;
  } else {
    aargs.push('-f', 'lavfi', '-t', String(dur + 0.1), '-i', 'anullsrc=r=48000:cl=stereo');
    a = '[0:a]anull[a]';
  }
  aargs.push('-filter_complex', a, '-map', '[a]', '-t', String(totalFrames / FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', sound);
  await ff.runFfmpeg(ctx.ffmpeg, aargs);
  const list = `${base}-parts.txt`;
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await ff.runFfmpeg(ctx.ffmpeg, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', sound,
    '-map', '0:v', '-map', '1:a', '-c', 'copy', '-video_track_timescale', '30000', out]);
  for (const p of parts.concat([sound, list])) { try { fs.unlinkSync(p); } catch (e) {} }
  return out;
}

async function renderPiece(ctx, s, W, H, keepAudio, out, next, { overlay = null, videoOnly = false, t0 = 0, effectDur = 0, frames = 0 } = {}) {
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
    args.push('-ss', String(s.from), '-t', String(s.need + 0.1), ...decodeOpts(c, W, H), '-i', c.file);
    const fx = effectChain(s.effect, W, H, effectDur || dur, t0);
    base = `[0:v]${s.slow ? 'setpts=2.0*PTS,' : ''}${fitChain(c, W, H, s.focus, 1, 'b', s.fx, { fx2: s.fx2, t0, dur: effectDur || dur })}${fx ? ',' + fx : ''}${s.grade ? ',' + s.grade : ''},fps=${FPS}`;
  }
  let graph;
  let nextInput = 1;
  const o = overlay;
  if (o) {
    /*
     * B-ROLL: the picture changes, the sound does not. The overlay fades in
     * and out over the base shot, which keeps playing (and keeps its audio)
     * underneath: a full-frame cutaway with a gentle push, or a framed box.
     */
    const oc = o.cand;
    // A photo is read and fitted ONCE, then held for the overlay's length. Fed
    // with -loop 1 it was decoded and resized again for every frame — a 12 MP
    // picture thirty times a second, the slowest part of the whole montage.
    /*
     * A SNAPSHOT is a still: one frame of the clip (kept as a picture next to
     * the montage, see stillsFor) or the photo itself, held for its length.
     */
    const snap = o.style === 'snapshot';
    const still = snap && (o.still && fs.existsSync(o.still) ? o.still : (oc.kind === 'image' ? oc.file : null));
    let grab = '';
    if (still || oc.kind === 'image') args.push('-i', still || oc.file);
    else if (snap) { args.push('-ss', String(o.from || 0), '-t', '0.5', ...decodeOpts(oc, W, H), '-i', oc.file); grab = 'trim=end_frame=1,setpts=PTS-STARTPTS,'; }
    else args.push('-ss', String(o.from || 0), '-t', String(o.len + 0.2), ...decodeOpts(oc, W, H), '-i', oc.file);
    nextInput = 2;
    let fit, move = '';
    let x = '0', y = '0';
    if (snap) {
      /*
       * "Take screenshots from the video and add them as hype": the frame pops
       * on like a photo just taken — a white-bordered print, a little tilted
       * (left or right by turns), in the middle, with a camera flash.
       */
      const bw = Math.round((W * (W > H ? 0.5 : 0.74)) / 2) * 2, bh = Math.round((H * (W > H ? 0.62 : 0.5)) / 2) * 2;
      const b = Math.max(6, Math.round(Math.min(W, H) * 0.02));
      const a = o.pos === 'left' ? '-0.06' : '0.06';
      fit = `scale=${bw}:${bh}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,pad=iw+${2 * b}:ih+${2 * b}:${b}:${b}:white,setsar=1,`
        + `format=rgba,rotate=${a}:c=none:ow=rotw(${a}):oh=roth(${a}),scale=trunc(iw/2)*2:trunc(ih/2)*2`;
      x = '(W-w)/2';
      y = `(H-h)/2-${Math.round(H * 0.04)}`;
    } else if (o.style === 'pip') {
      const pw = Math.round((W * (W > H ? 0.34 : 0.5)) / 2) * 2, ph = Math.round((H * 0.34) / 2) * 2;
      fit = `scale=${pw}:${ph}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,pad=iw+12:ih+12:6:6:white,setsar=1`;
      x = o.pos === 'left' ? '44' : `W-w-44`;
      y = `${Math.round(H * 0.11)}`;
    } else if (oc.kind === 'image' && oc.w / oc.h > (W / H) * 1.25) {
      /*
       * A photo much wider than the frame (a landscape picture in a 9:16
       * short) FILLS it and glides across, the way a trailer shows a wide
       * shot — instead of a small picture over a blur. It travels the middle
       * part of the picture, left to right or right to left by turns.
       */
      const ph = H % 2 ? H + 1 : H;
      fit = `scale=-2:${ph},setsar=1`;
      const a = o.pos === 'left' ? '0.62-0.24*t/' : '0.38+0.24*t/';
      move = `crop=${W}:${H}:x='(iw-${W})*(${a}${o.len.toFixed(2)})':y=0`;
    } else {
      fit = fitChain(oc, W, H, 'center', 1, 'o', o.fx);
      move = `scale=w='trunc(${W}*(1+0.07*t/${o.len.toFixed(2)})/2)*2':h=-2:eval=frame,crop=${W}:${H}`;
    }
    const hold = (oc.kind === 'image' || snap) ? `,loop=loop=${Math.ceil((o.len + 0.2) * FPS)}:size=1:start=0,setpts=N/${FPS}/TB` : '';
    const look = `${grab}${fit}${hold}${move ? ',' + move : ''}`;
    // (a cover over a whole beat goes on and off with the cut — no fade at all, not one frame of what it covers)
    const fin = snap ? 0.1 : 0.25;
    const fades = o.cover ? '' : `fade=t=in:st=0:d=${fin}:alpha=1,fade=t=out:st=${Math.max(0, o.len - 0.25).toFixed(3)}:d=0.25:alpha=1,`;
    const ov = `[1:v]${look},fps=${FPS},format=yuva420p,${fades}`
      + `trim=0:${o.len.toFixed(3)},setpts=PTS-STARTPTS+${o.start.toFixed(3)}/TB[ov]`;
    // the camera flash: the whole frame goes white for a blink as the snapshot lands
    const flash = snap ? `,drawbox=x=0:y=0:w=iw:h=ih:color=white@0.8:t=fill:enable='between(t,${o.start.toFixed(3)},${(o.start + 0.07).toFixed(3)})'` : '';
    graph = `${base}[bv];${ov};[bv][ov]overlay=${x}:${y}:eof_action=pass:enable='between(t,${o.start.toFixed(3)},${(o.start + o.len).toFixed(3)})'${flash}${edge.v ? ',' + edge.v : ''},format=yuv420p[v]`;
  } else {
    graph = `${base}${edge.v ? ',' + edge.v : ''},format=yuv420p[v]`;
  }
  if (videoOnly) {
    args.push('-filter_complex', graph, '-map', '[v]', '-an', ...(frames ? ['-frames:v', String(frames)] : ['-t', String(dur)]),
      '-c:v', 'libx264', ...encodeOpts(), '-r', String(FPS), '-pix_fmt', 'yuv420p', '-video_track_timescale', '30000', out);
    await ff.runFfmpeg(ctx.ffmpeg, args);
    return out;
  }
  const withSound = keepAudio && c.kind === 'video' && c.hasAudio && !s.mute;
  let a;
  if (withSound) {
    a = `[0:a]${s.slow ? 'atempo=0.5,' : ''}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${dur.toFixed(3)}${edge.a ? ',' + edge.a : ''}[a]`;
  } else {
    args.push('-f', 'lavfi', '-t', String(dur + 0.1), '-i', 'anullsrc=r=48000:cl=stereo');
    a = `[${nextInput}:a]anull[a]`;
  }
  args.push('-filter_complex', `${graph};${a}`, '-map', '[v]', '-map', '[a]', '-t', String(dur),
    '-c:v', 'libx264', ...encodeOpts(), '-r', String(FPS), '-pix_fmt', 'yuv420p',
    '-video_track_timescale', '30000', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', out);
  await ff.runFfmpeg(ctx.ffmpeg, args);
  return out;
}

/*
 * ►► THE STUDIO GETS THE OVERLAYS AS ITS OWN CLIPS. ◄◄
 * "I should be able to see the overlays on another line in the timeline, in
 * case I need to adjust them myself." The finished montage has its pictures
 * burned in — it is what Files shows and what is saved — but the studio opens
 * the same edit WITHOUT them (baseOf) and lays each one back on an overlay row
 * (VideoEditor.applyMontage), where it can be moved, trimmed, resized or taken
 * off, and the studio's export puts them on. Only the shots that carry
 * overlays are made twice; every other piece is shared through the cache.
 */
const baseOf = (output) => path.join(path.dirname(output), '.montage-edit', path.basename(output));

/*
 * A snapshot of a clip is kept as a picture beside the montage, so the
 * studio can lay it back on as a photo (the frame it froze, not the clip
 * playing on) and the export puts on the same still.
 */
async function stillsFor(ctx, plan, output) {
  const dir = path.dirname(baseOf(output));
  const stem = path.basename(output).replace(/\.[^.]+$/, '');
  let k = 0;
  for (const sh of plan.shots) {
    for (const o of sh.overlays || []) {
      if (o.style !== 'snapshot' || !o.cand || o.cand.kind !== 'video') continue;
      const file = path.join(dir, `${stem}.snap-${++k}.jpg`);
      try {
        fs.mkdirSync(dir, { recursive: true });
        await ff.runFfmpeg(ctx.ffmpeg, ['-hide_banner', '-y', '-ss', String(o.from || 0), '-i', o.cand.file, '-frames:v', '1', '-q:v', '2', file]);
        if (fs.existsSync(file)) o.still = file;
      } catch (e) { o.still = null; }   // the render takes the frame itself instead
    }
  }
}

async function render(ctx, plan, { aspect, keepAudio, output, base, tmp, onProgress }) {
  const { w: W, h: H } = ASPECTS[aspect] || ASPECTS['9:16'];
  await stillsFor(ctx, plan, output);
  /*
   * Pieces are independent, so a server with more than one CPU makes several
   * at once (the encoder gate still decides how many fit in its memory); on
   * one CPU this is the same one-after-another as before.
   */
  const n = plan.shots.length;
  const pieces = new Array(n);
  const bare = new Array(n);      // the same shots without their overlays, for the studio
  const jobsList = plan.shots.map((sh, i) => ({ i, shot: sh, into: pieces }));
  if (base) {
    plan.shots.forEach((sh, i) => {
      if ((sh.overlays || []).length) jobsList.push({ i, shot: Object.assign({}, sh, { overlays: [] }), into: bare, tag: '-bare' });
    });
  }
  let next = 0, done = 0;
  const worker = async () => {
    while (next < jobsList.length) {
      const { i, shot, into, tag = '' } = jobsList[next++];
      const t0 = Date.now();
      const out = path.join(tmp, `shot-${String(i).padStart(3, '0')}${tag}.mp4`);
      const key = pieceKey(shot, plan.shots[i + 1], W, H, keepAudio);
      if (!fromCache(key, out)) {
        await renderShot(ctx, shot, W, H, keepAudio, out, plan.shots[i + 1]);
        toCache(key, out);
      }
      into[i] = out;
      if (process.env.MW_MONTAGE_PROFILE) { const sh = shot; console.log('[piece]', i + tag, sh.cand.kind, sh.cand.w + 'x' + sh.cand.h, sh.seconds.toFixed(1) + 's', sh.effect, sh.slow ? 'slow' : '', (sh.overlays || []).length ? 'overlays:' + sh.overlays.length : '', ((Date.now() - t0) / 1000).toFixed(1) + 's'); }
      done++;
      if (onProgress) onProgress(Math.round((done / jobsList.length) * 95));
    }
  };
  const lanes = Math.max(1, Math.min(4, machine.cpus(), jobsList.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  const join = async (list, out, name) => {
    const txt = path.join(tmp, name);
    fs.writeFileSync(txt, list.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    await ff.runFfmpeg(ctx.ffmpeg, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', '-movflags', '+faststart', out]);
  };
  await join(pieces, output, 'pieces.txt');
  // where each shot REALLY starts in the joined file (each piece runs a few ms past its planned length — on a
  // long montage the planned sum drifts a third of a second): the Edit-the-montage preview plays from these
  try {
    let at = 0;
    for (let i = 0; i < pieces.length; i++) {
      plan.shots[i].realAt = round2(at);
      const d = await pieceDuration(ctx, pieces[i]);
      at += d > 0 ? d : plan.shots[i].seconds;
    }
  } catch (e) { /* the planned positions stand */ }
  if (base) {
    try { fs.rmSync(base, { force: true }); } catch (e) {}
    if (bare.some(Boolean)) {
      fs.mkdirSync(path.dirname(base), { recursive: true });
      await join(pieces.map((p, i) => bare[i] || p), base, 'bare.txt');
    }
  }
  pruneCache();
  if (onProgress) onProgress(100);
  return output;
}

/*
 * ►► A SHOT ALREADY MADE IS NOT MADE AGAIN. ◄◄
 * Every finished piece is kept, named by everything that decides how it looks
 * and sounds (the file and its size/date, the moment, the effect, the way in
 * and out, the pictures on it, the frame, the encoder). Remaking a montage
 * after moving a clip re-encodes only the shots whose neighbours changed —
 * the rest are picked up as they are. Old pieces are swept away.
 */
const PIECES = path.join(os.tmpdir(), 'mw-montage-pieces');
const PIECES_MAX = 1536 * 1024 * 1024;
function fileSig(f) { try { const st = fs.statSync(f); return st.size + ':' + Math.round(st.mtimeMs); } catch (e) { return '0'; } }
function pieceKey(s, next, W, H, keepAudio) {
  const c = s.cand;
  return crypto.createHash('sha1').update(JSON.stringify({
    v: 4, f: c.file, sig: fileSig(c.file), k: c.kind, w: c.w, h: c.h, a: !!c.hasAudio,
    sec: s.seconds, from: s.from, need: s.need, e: s.effect, fo: s.focus, fx: s.fx == null ? null : s.fx, fx2: s.fx2 == null ? null : s.fx2, sl: !!s.slow, tr: s.transition, nt: next ? next.transition : null, gr: s.grade || null, mu: !!s.mute,
    ov: (s.overlays || []).map((o) => [o.cand.file, fileSig(o.cand.file), o.cand.kind, o.cand.w, o.cand.h, o.style, o.start, o.len, o.pos, o.from, o.fx == null ? null : o.fx, !!o.cover]),
    W, H, keepAudio: !!keepAudio, enc: encodeOpts(),
  })).digest('hex');
}
function fromCache(key, out) {
  const f = path.join(PIECES, key + '.mp4');
  try {
    if (!fs.existsSync(f)) return false;
    try { fs.linkSync(f, out); } catch (e) { fs.copyFileSync(f, out); }
    const now = new Date(); try { fs.utimesSync(f, now, now); } catch (e) {}
    return true;
  } catch (e) { return false; }
}
function toCache(key, out) {
  try {
    fs.mkdirSync(PIECES, { recursive: true });
    const f = path.join(PIECES, key + '.mp4');
    if (fs.existsSync(f)) return;
    try { fs.linkSync(out, f); } catch (e) { fs.copyFileSync(out, f); }
  } catch (e) { /* a full disk just means no reuse next time */ }
}
function pruneCache() {
  try {
    const now = Date.now();
    const all = fs.readdirSync(PIECES).map((n) => { const f = path.join(PIECES, n); try { const st = fs.statSync(f); return { f, size: st.size, t: st.mtimeMs }; } catch (e) { return null; } }).filter(Boolean);
    let total = 0;
    for (const x of all.sort((a, b) => b.t - a.t)) {
      total += x.size;
      if (now - x.t > 24 * 3600 * 1000 || total > PIECES_MAX) { try { fs.unlinkSync(x.f); } catch (e) {} }
    }
  } catch (e) {}
}

/* ------------------------------------------------------------- the project
 *
 * The montage's own edit, saved beside the video (<video>.montage.json): the
 * clips and pictures it was made from (with a small frame of each), and every
 * shot — which clip, which moment, how long, how it comes in, what lies on
 * it. The phone shows it shot by shot to rearrange, and remake() builds the
 * video again from the rearranged plan without asking the AI again.
 */
const sidecarOf = (output) => output + '.montage.json';
function thumbData(f) {
  try { return f && fs.existsSync(f) ? 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64') : null; } catch (e) { return null; }
}
function projectOf(plan, cands, { aspect, keepAudio, style, full }, meta = {}) {
  const C = {};
  for (const c of cands) {
    C[c.id] = { id: c.id, kind: c.kind, file: c.file, name: c.name || path.basename(c.file), w: c.w, h: c.h, hasAudio: !!c.hasAudio,
      fileDur: c.fileDur || 0, peak: c.peak || 0, start: c.start || 0, end: c.end || 0, whole: !!c.whole, thumb: c.thumbData || thumbData(c.thumb) };
  }
  const shotAt = (t) => { let k = 0; plan.shots.forEach((s, i) => { if (t >= s.at - 0.01) k = i; }); return k; };
  return {
    v: 1, aspect, keepAudio: keepAudio !== false, style, full: !!full,
    title: meta.title || plan.title || '', postCaption: meta.postCaption || plan.postCaption || '', hashtags: meta.hashtags || plan.hashtags || [],
    cands: C,
    shots: plan.shots.map((s) => ({
      cid: s.cand.id, seconds: s.seconds, from: s.from == null ? null : s.from, need: s.need == null ? null : s.need,
      at: typeof s.realAt === 'number' ? s.realAt : null,   // where it really starts in the made file (Edit-the-montage preview)
      effect: s.effect, focus: s.focus, fx: s.fx == null ? null : s.fx, fx2: s.fx2 == null ? null : s.fx2, slow: !!s.slow, transition: s.transition, grade: s.grade || null, mute: !!s.mute,
      overlays: (s.overlays || []).map((o) => ({ cid: o.cand.id, style: o.style, start: o.start, len: o.len, pos: o.pos, from: o.from == null ? null : o.from, fx: o.fx == null ? null : o.fx, cover: !!o.cover })),
    })),
    texts: (plan.texts || []).map((t) => {
      const a = shotAt(t.start), b = shotAt(Math.max(t.start, t.end - 0.05));
      return { shot: a, span: Math.max(1, b - a + 1), text: t.text, role: t.role };
    }),
  };
}
function saveProject(output, project) {
  try { fs.writeFileSync(sidecarOf(output), JSON.stringify(project)); } catch (e) { /* the video is what matters */ }
}
/** The montage a path stands for: its edit copy (baseOf) maps back to the montage itself. */
const montageOf = (p) => (p && path.basename(path.dirname(p)) === '.montage-edit' ? path.join(path.dirname(path.dirname(p)), path.basename(p)) : p);
function loadProject(output) {
  try { return JSON.parse(fs.readFileSync(sidecarOf(montageOf(output)), 'utf8')); } catch (e) { return null; }
}

/** Pictures laid evenly through a shot, each clear of the next and of the hook. */
function spaceOverlays(list, seconds, first) {
  const n = list.length;
  if (!n) return [];
  const lo = first ? 1.2 : 0.3;
  const room = Math.max(0, seconds - lo - 0.15);
  const len = clamp(Math.min(OV_LEN, room / n - 1), 0.8, OV_LEN);
  const fit = Math.max(0, Math.floor((room + 1) / (len + 1)));
  return list.slice(0, fit).map((o, k) => {
    const slot = room / Math.min(n, fit);
    return Object.assign({}, o, { start: round2(lo + k * slot + Math.max(0, (slot - len) / 2)), len: round2(len) });
  });
}

/**
 * Build the montage again from an edited plan. `edits.shots` is the new order:
 * [{ key, transition?, overlays: [{ cid, style }] }] where `key` is the index
 * of a shot in the saved project (a shot's moment and length come from there —
 * nothing the phone sends names a file). Pictures that stayed where they were
 * keep their timing; a shot whose pictures changed has them spaced again.
 */
async function remake(ctx, { project, edits, output, onProgress, stage }) {
  if (!project || !project.cands || !Array.isArray(project.shots)) throw new Error('This montage has no saved edit to change.');
  const C = project.cands;
  const want = (edits && Array.isArray(edits.shots)) ? edits.shots : project.shots.map((s, key) => ({ key, overlays: s.overlays }));
  const shots = [];
  const oldIdx = [];
  want.forEach((w) => {
    const base = project.shots[Math.round(Number(w && w.key))];
    if (!base) return;
    const c = C[base.cid];
    if (!c || !fs.existsSync(c.file)) return;
    const sh = {
      cand: c, seconds: base.seconds, from: base.from, need: base.need, effect: base.effect, focus: base.focus, fx: typeof base.fx === 'number' ? base.fx : null, fx2: typeof base.fx2 === 'number' ? base.fx2 : null, slow: !!base.slow, grade: base.grade || null, mute: !!base.mute,
      transition: TRANSITIONS.includes(w.transition) ? w.transition : base.transition, overlays: [],
    };
    // the pictures on it: kept as they were, or spaced again if they changed
    const asked = (Array.isArray(w.overlays) ? w.overlays : base.overlays).filter((o) => o && C[o.cid] && C[o.cid].id !== c.id && fs.existsSync(C[o.cid].file));
    const same = asked.length === base.overlays.length && asked.every((o, k) => o.cid === base.overlays[k].cid);
    if (c.kind === 'video' && asked.length) {
      const list = asked.map((o, k) => {
        const was = same ? base.overlays[k] : null;
        return { cand: C[o.cid], style: OVERLAY_STYLES.includes(o.style) ? o.style : 'cutaway', start: was ? was.start : 0, len: was ? was.len : OV_LEN,
          pos: (k % 2 ? 'left' : 'right'), from: was && was.from != null ? was.from : null, fx: was && typeof was.fx === 'number' ? was.fx : null, cover: !!(was && was.cover) };
      });
      const firstShot = shots.length === 0;
      sh.overlays = (same && !(firstShot && list.some((o) => o.start < 1.2))) ? list : spaceOverlays(list, sh.seconds, firstShot);
      sh.overlays.forEach((o) => {
        if (o.cand.kind === 'video' && o.from == null) o.from = round2(clamp((o.cand.peak || 0) - o.len / 2, 0, Math.max(0, (o.cand.fileDur || 0) - o.len - 0.05)));
      });
    }
    shots.push(sh);
    oldIdx.push(Math.round(Number(w.key)));
  });
  if (!shots.length) throw new Error('There is nothing left in this montage to make.');
  shots[0].transition = 'cut';
  let t = 0;
  for (const s of shots) { s.at = round2(t); t += s.seconds; }
  const duration = round2(t);
  // the words follow their shots; the hook stays on the opening one
  const texts = [];
  for (const x of (project.texts || [])) {
    let i = x.role === 'hook' ? 0 : oldIdx.indexOf(x.shot);
    if (i < 0) continue;
    const span = clamp(Math.round(Number(x.span) || 1), 1, shots.length - i);
    const last = shots[i + span - 1];
    texts.push({ start: shots[i].at, end: round2(Math.min(duration, Math.max(last.at + last.seconds, shots[i].at + 1.2))), text: x.text, role: x.role });
  }
  const plan = { shots, texts, duration, title: project.title, postCaption: project.postCaption, hashtags: project.hashtags };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-montage-'));
  try {
    if (stage) stage(`🎞 Remaking it — ${shots.length} shots`);
    await render(ctx, plan, { aspect: project.aspect, keepAudio: project.keepAudio !== false, output, base: baseOf(output), tmp, onProgress });
    const cands = Object.values(C).map((c) => Object.assign({}, c, { thumbData: c.thumb }));
    saveProject(output, projectOf(plan, cands, project, plan));
    return resultOf(plan, output, project, {});
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

/** What the phone is told about a finished montage (made or remade). */
function resultOf(plan, output, opts, extra) {
  withAbout(plan, opts.about);
  return Object.assign({
    output,
    duration: plan.duration,
    aspect: opts.aspect,
    style: opts.style,
    concept: plan.concept || '',
    title: plan.title,
    postCaption: plan.postCaption,
    hashtags: plan.hashtags,
    texts: plan.texts,
    full: !!opts.full,
    project: true,
    cuts: plan.shots.slice(1).map((s) => s.at),
    // the edit without its overlays, which the studio opens and lays them on (see baseOf)
    base: fs.existsSync(baseOf(output)) ? baseOf(output) : null,
    overlays: plan.shots.flatMap((s) => (s.overlays || []).map((o) => ({
      at: round2(s.at + o.start), seconds: o.len, style: o.style, file: o.still || o.cand.file,
      kind: o.still ? 'image' : o.cand.kind, w: o.cand.w, h: o.cand.h, from: o.still || o.from == null ? 0 : o.from, pos: o.pos || 'right',
      // where across a cutaway it is cut to fill the frame (round its person), for the studio
      fx: !o.still && typeof o.fx === 'number' ? o.fx : null,
      cover: !!o.cover,   // covers a whole beat: on and off with the cut, no fade
    }))),
    shots: plan.shots.map((s) => ({ at: s.at, seconds: s.seconds, effect: s.effect, transition: s.transition, file: s.cand.file, kind: s.cand.kind, from: s.from == null ? null : s.from })),
  }, extra);
}

/* ===================================================== THE TALK EDIT
 *
 * ►► "ADD MY VIDEOS — THE AI CUTS THE BEST THINGS SAID INTO ONE VIRAL VIDEO." ◄◄
 *
 * The music montage above is cut from what the clips LOOK like. A preacher, a
 * testimony, a youth leader's talk goes viral on what is SAID, so this edit is
 * cut from the words:
 *
 *   1. HEAR    every video is transcribed (Groq's Whisper, then the Word Book),
 *              and its words grouped into phrases — never a sentence cut in two.
 *   2. CHOOSE  the director reads every phrase from every video and builds the
 *              story: the most arresting line FIRST (the hook), then lines that
 *              follow on from each other and rise, ending on the line people
 *              will quote. Claude when the server has it, Groq otherwise, and a
 *              scorer of its own (energy, length, punch words) without either.
 *   3. MOVE    constant engagement: a long line is cut into beats of two or
 *              three seconds at word boundaries, and each beat is framed
 *              differently — punch in, closer, wide, a slow push — the jump
 *              zooms of every viral talking edit. A cinematic grade on all of
 *              it, a flash between lines on a hype edit, and any photos or
 *              silent clips laid over as B-roll while the voice carries on.
 *   4. WORDS   the words heard come back on the finished video's own clock, so
 *              the studio puts captions on at once (word by word lit up) —
 *              they go into the export — with the hook as a headline.
 */
const TALK_LINE_MAX = 6.5;
const TALK_GRADES = {
  hype: 'eq=contrast=1.08:saturation=1.2',
  cinematic: 'eq=contrast=1.1:saturation=0.94:gamma=0.97,vignette=PI/4.6',
  worship: 'eq=contrast=1.04:saturation=1.08:brightness=0.012',
  emotional: 'eq=contrast=1.05:saturation=0.98,vignette=PI/5.2',
  fun: 'eq=contrast=1.06:saturation=1.28',
};
/* each beat framed differently from the one before — the cycle a viral talking edit uses */
const TALK_MOVES = {
  hype: ['punch_in', 'hold_in', 'cut', 'hold_tight', 'slow_zoom', 'hold_in'],
  cinematic: ['slow_zoom', 'hold_in', 'zoom_out', 'slow_zoom', 'hold_tight', 'cut'],
  worship: ['slow_zoom', 'hold_in', 'zoom_out', 'cut'],
  emotional: ['slow_zoom', 'hold_in', 'slow_zoom', 'hold_tight'],
  fun: ['punch_in', 'hold_tight', 'cut', 'hold_in', 'punch_in'],
};
const PUNCH = /\b(never|always|god|jesus|lord|christ|holy|spirit|love|power|believe|faith|miracle|today|now|secret|truth|change|changed|why|how|stop|listen|you|your|everything|nothing|die|life|heaven|hell|grace|free|fear|pray|prayer|blessed|promise|destiny|purpose|win|victory)\b/gi;
const FILLER_START = /^(and|so|um+|uh+|er+|like|but|okay|ok|you know)\b/i;
const FILLER_ANY = /\b(um+|uh+|er+|erm)\b/gi;
/* the business of a service — not what anyone shares */
const HOUSEKEEPING = /\b(turn to|page \w+|announcement|announcements|please be seated|be seated|good morning|good evening|welcome everyone|offering|tithes?|car park|parking|microphone|can you hear me|next slide)\b/i;

/** Heard words → phrases: a pause, a full stop or nine seconds ends one. */
function phrasesOf(words, maxSec = 9) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => String(w.text || '').trim()).filter(Boolean).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    if (text) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text, words: cur });
    cur = [];
  };
  for (const w of words) {
    if (!w || !(w.end > w.start) || !String(w.text || '').trim()) continue;
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 0.55
      || (cur.length >= 4 && /[.!?]["'”’)]?$/.test(String(prev.text).trim()))
      || w.end - cur[0].start > maxSec)) flush();
    cur.push(w);
  }
  flush();
  // a two-word scrap joins the phrase it belongs to when they are close
  for (let i = out.length - 1; i > 0; i--) {
    const a = out[i - 1], b = out[i];
    if ((b.end - b.start < 1.1 || b.words.length < 3) && b.start - a.end < 0.4 && b.end - a.start <= maxSec + 1) {
      out.splice(i - 1, 2, { start: a.start, end: b.end, text: (a.text + ' ' + b.text).trim(), words: a.words.concat(b.words) });
    }
  }
  return out;
}

/** How much a phrase grabs, on its own: energy, a good length, punch words, ! and ?. */
function phraseScore(p, loud) {
  const len = p.end - p.start;
  let s = 0;
  if (loud && loud.length) {
    const xs = loud.filter((x) => x.t >= p.start && x.t <= p.end).map((x) => x.db);
    if (xs.length) s += clamp((xs.reduce((a, b) => a + b, 0) / xs.length + 40) / 25, 0, 1.2);
  }
  s += len >= 2 && len <= 6 ? 0.6 : len < 1.2 ? -0.5 : len > 8 ? -0.1 : 0.2;
  s += Math.min(0.9, ((p.text.match(PUNCH) || []).length) * 0.18);
  if (/!/.test(p.text)) s += 0.3;
  if (/\?/.test(p.text)) s += 0.25;
  if (FILLER_START.test(p.text)) s -= 0.35;
  s -= Math.min(0.9, ((p.text.match(FILLER_ANY) || []).length) * 0.45);
  if (HOUSEKEEPING.test(p.text)) s -= 1;
  if (p.words.length < 3) s -= 0.4;
  return round2(s);
}

const TALK_SCHEMA = {
  type: 'object',
  properties: {
    concept: { type: 'string' },
    title: { type: 'string' },
    hook_text: { type: 'string' },
    post_caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    picks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
    vo_intro: { type: 'string' },
    vo_outro: { type: 'string' },
  },
  required: ['concept', 'title', 'hook_text', 'post_caption', 'hashtags', 'picks', 'vo_intro', 'vo_outro'],
  additionalProperties: false,
};
const TALK_SYSTEM = `You are the best short-form video editor working today. You cut sermons, testimonies and talks into clips that go viral on TikTok, Instagram Reels and YouTube Shorts — videos people watch to the end, share and quote.

You are given every phrase spoken in one or more videos (id, which video, when, how loud, the words). Build ONE edit from them:
- THE HOOK FIRST: open with the single most arresting line — a bold claim, a question, a striking promise, an emotional peak. It may come from anywhere. It must make sense with no context.
- THEN THE STORY: lines that follow on from each other so the whole thing reads as one clear message that rises. Every line must make sense after the one before it. Never use a line that starts mid-thought or depends on something left out. Lines from different videos may be mixed and matched when they continue the same thought.
- THE PAYOFF LAST: end on the most quotable, memorable line — the one people will put in the comments.
- No filler, no "um", no housekeeping (announcements, greetings, "turn to page"), no repeated points.
- SHORT AND SNAPPY: every line a punch of about 2–6 seconds. More short lines beat fewer long ones — a line that runs on loses the scroll. Skip a long line unless it is the best thing said.
- Fit the length asked for. Shorter and tighter beats longer.
Use only ids that are given, each at most once, in the order they should play.
hook_text: a 3–7 word on-screen headline that makes people stop scrolling (not a quote of the first line).
post_caption: the caption for the post, 1–3 short sentences, with a question or a call to share. hashtags: 5–8, no # sign.
vo_intro / vo_outro: ONLY when a narrator is asked for (otherwise leave both empty). vo_intro is spoken by a narrator over B-roll BEFORE the first line: 6–14 words that create curiosity and make people stay ("He was about to give up — then he heard this."). Never a summary, never "in this video". vo_outro is spoken after the last line: 5–12 words, a warm call to follow or share. Plain words a person would say aloud — no emojis, no hashtags.`;

function talkBrief(opts, list) {
  return `Style: ${opts.style} — ${STYLES[opts.style] || ''}\nTarget length: about ${opts.lengthSec} seconds of speech.`
    + `\nNarrator: ${opts.voice ? 'YES — write vo_intro and vo_outro.' : 'no — leave vo_intro and vo_outro empty.'}`
    + (aboutLines(opts).length ? '\n' + aboutLines(opts).join('\n') : '')
    + (opts.brief ? `\nWhat the operator says it is about: ${opts.brief}` : '')
    + `\n\nPhrases (${list.length}):\n` + list.map((p) => `${p.id} | video ${p.vid} | ${p.start.toFixed(1)}-${p.end.toFixed(1)}s | loud ${p.score} | ${p.text}`).join('\n');
}

async function talkWithClaude(list, opts) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const Client = Anthropic.default || Anthropic;
  const client = new Client({ maxRetries: 2, timeout: 6 * 60 * 1000 });
  const model = process.env.MW_MONTAGE_MODEL || 'claude-opus-5-5';
  const body = {
    model, max_tokens: 12000, thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: TALK_SCHEMA } },
    system: TALK_SYSTEM,
    messages: [{ role: 'user', content: talkBrief(opts, list) + '\n\nNow build the edit.' }],
  };
  let res;
  try { res = await client.beta.messages.create(Object.assign({}, body, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })); } catch (e) {
    if (e instanceof Client.BadRequestError) res = await client.messages.create(body); else throw e;
  }
  if (!res || res.stop_reason === 'refusal') return null;
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let plan = null;
  try { plan = JSON.parse(text); } catch (e) { plan = null; }
  return plan && Array.isArray(plan.picks) ? { plan, director: 'claude', model: res.model || model } : null;
}

async function talkWithGroq(list, opts) {
  let cw;
  try { cw = require('./cloudwrite'); } catch (e) { return null; }
  if (!cw.access || !cw.access().key) return null;
  const prompt = talkBrief(opts, list)
    + '\n\nReply with JSON only, exactly this shape: {"concept":"","title":"","hook_text":"","post_caption":"","hashtags":[""],"picks":[{"id":"p1"}],"vo_intro":"","vo_outro":""}';
  const text = await cw.chat({ system: TALK_SYSTEM, prompt, json: true, maxTokens: 2500, temperature: 0.5, timeoutMs: 90000, evenIfOff: true });
  const plan = text ? cw.parseJson(text) : null;
  return plan && Array.isArray(plan.picks) ? { plan, director: 'groq', model: (cw.state && cw.state().model) || 'groq' } : null;
}

/** Without an AI: the strongest short line first, then the best lines in the order they were said. */
function talkByRules(list, opts) {
  // without an AI to judge them, a line with an "um" in it or the business of the service is never used
  const clean = list.filter((p) => !HOUSEKEEPING.test(p.text) && !(p.text.match(FILLER_ANY) || []).length);
  if (clean.length >= 2) list = clean;
  const hook = list.filter((p) => p.end - p.start >= 1.6 && p.end - p.start <= 6.5).sort((a, b) => b.score - a.score)[0] || list[0];
  const rest = list.filter((p) => p !== hook).sort((a, b) => b.score - a.score);
  const picked = [hook];
  let total = hook.end - hook.start;
  for (const p of rest) {
    if (total >= opts.lengthSec) break;
    if (p.score < 0.45) break;      // a weak line is not added just to reach the length
    picked.push(p); total += p.end - p.start;
  }
  const body = picked.slice(1).sort((a, b) => a.vid - b.vid || a.start - b.start);
  return { plan: { concept: '', title: '', hook_text: '', post_caption: '', hashtags: [], picks: [hook].concat(body).map((p) => ({ id: p.id })) }, director: 'rules', model: '' };
}

/** The narrator's lines laid on a finished file, each at its moment (the picture is copied, not re-encoded). */
async function laySpeech(ctx, file, parts, tmp) {
  const out = path.join(tmp, 'vo-mix-' + path.basename(file));
  const args = ['-hide_banner', '-y', '-i', file];
  const chains = [];
  parts.forEach((p, i) => {
    args.push('-i', p.wav);
    const ms = Math.max(0, Math.round(p.at * 1000));
    chains.push(`[${i + 1}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1.6,adelay=${ms}|${ms}[n${i}]`);
  });
  const mix = `[0:a]${parts.map((_, i) => `[n${i}]`).join('')}amix=inputs=${parts.length + 1}:normalize=0:duration=first,alimiter=limit=0.95[a]`;
  args.push('-filter_complex', chains.concat(mix).join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out);
  await ff.runFfmpeg(ctx.ffmpeg, args);
  // (a fresh file, never written through a link another copy shares)
  fs.rmSync(file, { force: true });
  fs.copyFileSync(out, file);
  try { fs.rmSync(out, { force: true }); } catch (e) {}
}

/*
 * ►► FULL SCREEN, ROUND THE SPEAKER. ◄◄ "I selected 9:16 … there is a blur top
 * and bottom; the video is meant to cover the full screen." A landscape clip in
 * a vertical edit was shown whole over a blurred copy of itself. In the Viral
 * Montage it now FILLS the frame — cropped round the person speaking, found by
 * the same eye the reframe uses (cloudsee.js: frames ruled into eight numbered
 * columns, "which column is the speaker's head in"). Asked once per moment, six
 * moments to a picture; whatever it cannot tell (or with no AI to ask), the
 * middle of the picture. A wrong guess costs a centred crop, never the blur.
 */
// 12 columns on a bigger frame: an eighth of the picture was too coarse to keep a person whole in a 9:16 cut
const SPEAK_COLS = 12, SPEAK_TILE_W = 384, SPEAK_TILE_H = 216, SPEAK_MAX_FRAMES = 48;
const MAX_MOVE_ZOOM = 1.24;   // the tightest zoom move (effectChain hold_tight): the share of the cut it still shows
const needsCrop = (c, W, H) => c && c.kind === 'video' && c.w && c.h && Math.abs(Math.log((c.w / c.h) / (W / H))) >= 0.42;
/* An ffmpeg that can draw text, for the column numbers: the bundled one cannot
 * (no freetype), the system's usually can (the server image installs it). */
let textFf = undefined;
async function textFfmpeg(ctx) {
  if (textFf !== undefined) return textFf;
  textFf = null;
  for (const bin of [ctx.ffmpeg, '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']) {
    try { const { stdout } = await collect(bin, ['-hide_banner', '-filters'], { stdout: true }); if (/\bdrawtext\b/.test(stdout.toString())) { textFf = bin; break; } }
    catch (e) { /* not there */ }
  }
  return textFf;
}
async function findSpeakers(ctx, reqs, tmp, log, frame = null) {
  return (await lookAt(ctx, reqs, tmp, log, { people: true, max: SPEAK_MAX_FRAMES, frame })).map((x) => (x.fx == null ? 0.5 : x.fx));
}
/**
 * The AI's look at moments of the videos, six frames to a grid: for each
 * request `{ file, t, w, h }`, `{ fx, people }` — where across the picture the
 * person to keep stands (0 left … 1 right, null when it could not tell) and how
 * many people can be seen (0 = nobody: an empty stage, a screen; null = not
 * asked or no answer). `people:false` asks only for the speaker's column.
 */
let lookRun = 0;
async function lookAt(ctx, reqs, tmp, log, { people = true, max = Infinity, frame = null } = {}) {
  const out = reqs.map(() => ({ fx: null, people: null }));
  let see = null;
  try { see = require('./cloudsee'); } catch (e) { see = null; }
  let font = null;
  const tff = await textFfmpeg(ctx);
  try { const f = path.join(require('./captioner').fontsDir(), 'Poppins-Bold.ttf'); if (fs.existsSync(f) && tff) font = f; } catch (e) {}
  if (!see || !see.ready() || !font || !reqs.length) { if (log && reqs.length) log('look: ' + (!see || !see.ready() ? 'no AI to ask' : 'no ffmpeg here can draw the column numbers') + ' — the middle of the picture'); return out; }
  ctx = Object.assign({}, ctx, { ffmpeg: tff });
  const esc = (t) => String(t).replace(/[\\:']/g, '\\$&');
  const T = SPEAK_TILE_W, TH = SPEAK_TILE_H, cw = T / SPEAK_COLS;
  const LETTERS = 'ABCDEF';
  const todo = reqs.slice(0, max).map((r, i) => Object.assign({ i }, r));
  if (reqs.length > todo.length && log) log(`look: ${reqs.length - todo.length} moments past the first ${max} were not looked at`);
  // each look in its own folder: a frame that would not come out must never be stood in for by an older one
  const run = ++lookRun;
  for (let g = 0; g * 6 < todo.length; g++) {
    jobs.throwIfCancelled();   // Cancel is answered between grids, not after all of them
    const part = todo.slice(g * 6, g * 6 + 6);
    const dir = path.join(tmp, `spk-${run}-${g}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let k = 0; k < part.length; k++) {
      const r = part[k];
      // the frame, ruled into numbered columns, its letter top right (as the reframe draws it)
      const lines = Array.from({ length: SPEAK_COLS - 1 }, (_, j) => `drawbox=x=${Math.round(cw * (j + 1))}:y=0:w=1:h=ih:color=white@0.55:t=fill`).join(',');
      const nums = Array.from({ length: SPEAK_COLS }, (_, j) => `drawtext=text='${j + 1}':fontfile='${esc(font)}':fontsize=13:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=2:x=${Math.round(cw * j + cw / 2 - (j >= 9 ? 8 : 4))}:y=h-17`).join(',');
      const letter = `drawtext=text='${LETTERS[k]}':fontfile='${esc(font)}':fontsize=18:fontcolor=white:box=1:boxcolor=black:boxborderw=4:x=w-tw-8:y=6`;
      const vf = `scale=${T}:${TH}:force_original_aspect_ratio=decrease,pad=${T}:${TH}:(ow-iw)/2:(oh-ih)/2:color=black,${lines},${nums},${letter}`;
      const fr = path.join(dir, `f${k + 1}.jpg`);
      try { await collect(ctx.ffmpeg, ['-hide_banner', '-y', '-ss', String(Math.max(0, r.t)), '-i', r.file, '-frames:v', '1', '-vf', vf, '-q:v', '4', fr]); }
      catch (e) { if (e instanceof jobs.CancelledError) throw e; }
      // a frame that would not come out is a black tile, so every later letter stays on its own frame
      if (!fs.existsSync(fr)) { try { await collect(ctx.ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${T}x${TH}:d=1`, '-vf', letter, '-frames:v', '1', fr]); } catch (e) { if (e instanceof jobs.CancelledError) throw e; } }
    }
    const grid = path.join(dir, 'grid.jpg');
    try { await collect(ctx.ffmpeg, ['-hide_banner', '-y', '-framerate', '1', '-start_number', '1', '-i', path.join(dir, 'f%d.jpg'), '-vf', `tile=3x${Math.ceil(part.length / 3)}:padding=4:color=black`, '-frames:v', '1', '-q:v', '4', grid]); }
    catch (e) { if (e instanceof jobs.CancelledError) throw e; continue; }
    if (!fs.existsSync(grid)) continue;
    let ans = null;
    const ask = people && see.whereArePeople ? see.whereArePeople : see.whoIsSpeaking;
    try { ans = await ask({ image: 'data:image/jpeg;base64,' + fs.readFileSync(grid).toString('base64'), frames: part.map((_, k) => ({ label: LETTERS[k] })), columns: SPEAK_COLS }); }
    catch (e) { ans = null; }
    if (!ans || !ans.ok) { if (log) log('look: ' + ((ans && ans.why) || 'no answer') + ' — the middle of the picture'); break; }
    part.forEach((r, k) => {
      const a = ans.answers[LETTERS[k]];
      if (!a) return;
      if (typeof a.people === 'number') out[r.i].people = a.people;
      if (!(a.column > 0)) return;
      // the column's middle on the ruled tile → across the clip's own picture (a tile pads a clip of another shape)
      const ar = (r.w && r.h) ? r.w / r.h : 16 / 9;
      const shown = Math.min(T, TH * ar), left = (T - shown) / 2;
      const at = (x) => clamp((x - left) / shown, 0, 1);
      const head = at((a.column - 0.5) * cw);
      out[r.i].fx = head;
      out[r.i].head = head;
      /*
       * KEEP THE WHOLE PERSON. The cut shows `win` of the picture's width; where
       * the person reaches from `left` to `right` (head and shoulders) and that
       * fits, the cut is placed to hold all of it — as near centred on the head
       * as it can be — instead of on the head alone, which left a shoulder, or
       * half a face by an edge, outside the frame.
       */
      // (the zoom moves — hold_tight 1.24x, punch_in, hold_in — show less than the cut: fit the person to the
      // narrowest of them, so a shoulder made room for is not zoomed back out of the frame)
      const win = frame && r.w && r.h ? Math.min(1, (r.h * frame.W / frame.H) / r.w) / (frame.zoom || MAX_MOVE_ZOOM) : null;
      if (win && win < 1 && a.left && a.right) {
        const L = at((a.left - 1) * cw), R = at(a.right * cw);
        out[r.i].span = [L, R];
        if (R - L <= win * 0.92) {
          const x0 = clamp(head - win / 2, R - win * 0.96, L - win * 0.04);
          out[r.i].fx = clamp(x0 + win / 2, 0, 1);
        } else {
          // wider than the frame (two people side by side): their middle
          out[r.i].fx = clamp((L + R) / 2, 0, 1);
        }
      }
      // a column with no count (an older answer) still means someone is there
      if (out[r.i].people == null && people) out[r.i].people = 1;
    });
  }
  return out;
}

/**
 * Where across each shot to cut it so it fills the frame round its person:
 * sets `fx` on every video shot (and every video cutaway laid over one) whose
 * shape is not the frame's. A shot that is one beat of a spoken LINE (`line`,
 * an index into `picks`) shares one look with the other beats of that line.
 * With no AI to look, everything is cut round the middle — still full screen.
 */
async function aimShots(ctx, shots, aspect, { picks = null, tmp, log, stage } = {}) {
  const { w: W, h: H } = ASPECTS[aspect] || ASPECTS['9:16'];
  const reqs = [], back = [];
  const want = (cand, t, put) => { if (!needsCrop(cand, W, H)) return; reqs.push({ file: cand.file, t: round2(clamp(t, 0, Math.max(0, (cand.fileDur || 0) - 0.1))), w: cand.w, h: cand.h }); back.push(put); };
  const lineAt = new Map();
  shots.forEach((sh) => {
    if (sh.fx != null) { /* already aimed (a line's own looks) */ } else if (sh.line != null && picks && picks[sh.line]) {
      // one look per LINE, shared by its beats (it is the same speaker, a second or two apart)
      if (!lineAt.has(sh.line)) { const p = picks[sh.line]; lineAt.set(sh.line, []); want(p.cand, (p.start + p.end) / 2, (fx) => lineAt.get(sh.line).forEach((x) => { x.fx = fx; })); }
      if (needsCrop(sh.cand, W, H)) lineAt.get(sh.line).push(sh);
    } else if (sh.cand.kind === 'video') want(sh.cand, (sh.from || 0) + (sh.need || sh.seconds) / 2, (fx) => { sh.fx = fx; });
    for (const o of sh.overlays || []) if (o.style === 'cutaway' && o.cand.kind === 'video' && o.fx == null) want(o.cand, (o.from || 0) + o.len / 2, (fx) => { o.fx = fx; });
  });
  if (!reqs.length) return;
  if (stage) stage('🎯 Finding the speaker in every moment, to fill the frame…');
  let fxs = reqs.map(() => 0.5);
  try { fxs = await findSpeakers(ctx, reqs, tmp, log, { W, H }); } catch (e) { if (e instanceof jobs.CancelledError) throw e; if (log) log('speakers: ' + e.message); }
  back.forEach((put, i) => put(fxs[i] == null ? 0.5 : fxs[i]));
}

/*
 * ►► THE POST CAPTION, WRITTEN FOR SOCIAL MEDIA. ◄◄ The director is asked for
 * a caption along with its picks, and often leaves it thin or empty — and the
 * fallback was the operator's own "What's it about?" words, copied. Now the
 * caption is written on its own, once the edit is known, from the words that
 * are actually SAID in it: a first line that stops the scroll, the message in
 * a sentence or two, who and where, a question or a call to share, and
 * hashtags people search. The operator's notes are background, never pasted.
 */
const POST_SYSTEM = `You write the captions for a church's short videos on Instagram, TikTok, Facebook and YouTube Shorts — captions people read to the end, comment on and share.
Write ONE caption for the video whose spoken words you are given:
- Line 1: a scroll-stopping hook — the most powerful idea of the video in your own words, or its best line quoted exactly. Max 12 words. One fitting emoji is fine.
- Then 1–3 short lines on the message: what it means for the viewer's life, warm and direct ("you"), true to what is said. No sermon summary, no "in this video".
- Name the speaker and church only if they are given, spelt exactly as given.
- End with ONE call to engage: a question to answer in the comments, or "Share this with someone who needs it", or the call to action given.
- Short lines with a blank line between them. 2–4 emojis in the whole caption at most. Never invent facts, dates, places or scripture references that are not in the words or the notes.
- hashtags: 8–12, no # sign, no spaces — a mix of broad (faith, jesus, christian, church, sermon, motivation) and specific to the message (e.g. faithoverfear, breakthrough); include the church or speaker as a hashtag only if given.
Reply with JSON only: {"caption":"…","hashtags":["…"]}`;
async function writeTalkPost(picks, opts, P, hook) {
  const said = picks.map((p) => String(p.text || (p.words || []).map((w) => w.text).join(' ')).trim()).filter(Boolean);
  const a = opts.about || {};
  const tags = (list) => (Array.isArray(list) ? list : []).map((h) => String(h).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]+/gu, '')).filter((h) => h.length >= 2).slice(0, 12);
  // the director's own, when it wrote a real one (not a copy of the notes)
  const notes = cleanBrief(opts.brief).toLowerCase();
  const directors = String(P.post_caption || '').trim();
  const realOne = directors.length >= 60 && !(notes && directors.toLowerCase().includes(notes.slice(0, 40)));
  try {
    const cw = require('./cloudwrite');
    if (cw.access && cw.access().key) {
      const prompt = `The words spoken in the video, in order:\n${said.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
        + (hook ? `\n\nOn-screen headline: ${hook}` : '')
        + (a.speaker ? `\nSpeaker: ${a.speaker}` : '') + (a.church ? `\nChurch: ${a.church}` : '') + (a.occasion ? `\nOccasion: ${a.occasion}` : '')
        + (a.cta ? `\nCall to action to end with: ${a.cta}` : '')
        + (opts.brief ? `\nThe church's own notes (background only — do not copy them): ${cleanBrief(opts.brief)}` : '')
        + `\nStyle of the video: ${opts.style}.`;
      const text = await cw.chat({ system: POST_SYSTEM, prompt, json: true, maxTokens: 700, temperature: 0.8, timeoutMs: 45000, evenIfOff: true });
      const j = text ? cw.parseJson(text) : null;
      const cap = j && String(j.caption || '').trim();
      if (cap && cap.length >= 40) return { caption: cap, hashtags: tags(j.hashtags).length ? tags(j.hashtags) : tags(P.hashtags) };
    }
  } catch (e) { /* the fallback below */ }
  if (realOne) return { caption: directors, hashtags: tags(P.hashtags) };
  // no AI to write it: the strongest line actually said leads, then a call to share — never the notes, copied
  const best = said.slice().sort((x, y) => Math.abs(x.split(' ').length - 12) - Math.abs(y.split(' ').length - 12))[0] || said[0] || '';
  const quote = best.length > 160 ? best.slice(0, 157).replace(/\s+\S*$/, '') + '…' : best;
  const lines = [quote ? `“${quote.replace(/^["“]|["”]$/g, '')}” 🙌` : (hook || '')];
  if (said.length > 1 && said[0] !== best) lines.push(said[0].length > 140 ? said[0].slice(0, 137).replace(/\s+\S*$/, '') + '…' : said[0]);
  lines.push('Which line spoke to you? Tell us in the comments 👇 — and share this with someone who needs it today.');
  const base = tags(P.hashtags);
  const fallbackTags = base.length ? base : ['faith', 'jesus', 'church', 'sermon', 'christian', 'gospel', 'hope', 'godisgood'];
  return { caption: lines.filter(Boolean).join('\n\n'), hashtags: fallbackTags };
}

/** A finished piece's length, as the join counts it (its container's duration). */
async function pieceDuration(ctx, file) {
  if (!ctx.ffprobe) return 0;
  return new Promise((resolve) => {
    require('child_process').execFile(ctx.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { windowsHide: true, timeout: 20000 },
      (err, out) => resolve(err ? 0 : (parseFloat(String(out).trim()) || 0)));
  });
}

/** A line cut into its beats (about 2.4 s each, cut between words): their source spans and word ranges — the same cut the edit makes. */
function beatSpans(p) {
  const ws = p.words || [];
  if (!ws.length) return [{ from: p.start, to: p.end, a: 0, b: -1 }];
  const beats = [];
  let b0 = 0;
  for (let j = 1; j < ws.length; j++) {
    const lenSoFar = ws[j - 1].end - ws[b0].start;
    const left = ws[ws.length - 1].end - ws[j].start;
    if (lenSoFar >= 2.2 && left >= 1.1) { beats.push([b0, j - 1]); b0 = j; }
  }
  beats.push([b0, ws.length - 1]);
  const fileDur = (p.cand && p.cand.fileDur) || Infinity;
  return beats.map(([a, b], bi) => {
    const first = bi === 0, last = bi === beats.length - 1;
    const from = first ? Math.max(0, ws[a].start - 0.07) : (ws[a - 1].end + ws[a].start) / 2;
    const to = last ? Math.min(fileDur - 0.02, ws[b].end + 0.16) : (ws[b].end + ws[b + 1].start) / 2;
    return { from, to, a, b };
  });
}

/** Where the person stands across a line's picture at source time `t`, from its looks (between two, in proportion); null when no look saw anyone. */
function fxAtLook(p, t) {
  const L = (p.looks || []).filter((l) => l.fx != null && l.people !== 0).sort((a, b) => a.t - b.t);
  if (!L.length) return null;
  if (L.length === 1 || t <= L[0].t) return L[0].fx;
  if (t >= L[L.length - 1].t) return L[L.length - 1].fx;
  // between the two looks either side of `t`, in proportion
  let k = 0;
  while (k < L.length - 2 && t > L[k + 1].t) k++;
  const a = L[k], b = L[k + 1];
  return a.fx + (b.fx - a.fx) * ((t - a.t) / Math.max(0.01, b.t - a.t));
}

async function makeTalk(ctx, getInfo, { files, opts, hear, musicPath, output, onProgress, stage, log, keepAudio }) {
  const say = (a, b) => (p) => onProgress && onProgress(Math.round(a + (b - a) * (clamp(p, 0, 100) / 100)));
  const infos = [];
  for (const f of files) {
    let info = null;
    try { info = await getInfo(ctx, f); } catch (e) { info = null; }
    if (info && info.width && info.height) infos.push({ file: f, info, image: isImage(f) || !(info.durationSec > 0.3) });
  }
  const vids = infos.filter((x) => !x.image);
  if (!vids.length) throw new Error('Add at least one video with someone speaking — the Viral Montage is cut from what is said.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-talk-'));
  try {
    // 1) HEAR
    const cands = [];
    const phrases = [];
    let k = 0;
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      const D = v.info.durationSec;
      if (stage) stage(vids.length > 1 ? `👂 Listening to video ${i + 1} of ${vids.length}…` : '👂 Listening to every word…');
      let words = [];
      if (v.info.hasAudio && hear) {
        // (nothing from "What's it about?" goes to the ear: the captions are what was said)
        try { words = (await hear(v.file, D, say((i / vids.length) * 40, ((i + 1) / vids.length) * 40))) || []; } catch (e) { if (e instanceof jobs.CancelledError || (e && e.cancelled)) throw e; if (log) log('hear failed: ' + e.message); words = []; }
      }
      let loud = [];
      if (v.info.hasAudio) { try { loud = await loudness(ctx, v.file); } catch (e) { if (e instanceof jobs.CancelledError) throw e; } }
      const c = { id: 'v' + (i + 1), file: v.file, kind: 'video', start: 0, end: round2(D), peak: round2(D / 2), whole: true, fileDur: round2(D),
        hasAudio: !!v.info.hasAudio, w: v.info.width, h: v.info.height, name: path.basename(v.file), spoken: words.length >= 4 };
      try { c.thumb = await thumb(ctx, v.file, Math.min(1, D / 3), path.join(tmp, c.id + '.jpg'), false); } catch (e) { c.thumb = null; }
      cands.push(c);
      // short, snappy lines: a phrase ends by about 6 s (it used to run to 9–10)
      for (const p of phrasesOf(words, TALK_LINE_MAX)) {
        if (p.end > D) continue;
        p.id = 'p' + (++k); p.vid = i + 1; p.cand = c; p.score = phraseScore(p, loud);
        phrases.push(p);
      }
    }
    if (phrases.length < 2) {
      const e = new Error('No one could be heard speaking in these videos. The Viral Montage is cut from what is said — choose “AI Standard Montage” for clips without speech.');
      e.noSpeech = true;
      throw e;
    }
    // the photos and silent clips become B-roll over the speaker
    const broll = infos.filter((x) => x.image).map((x, j) => ({ id: 'i' + (j + 1), file: x.file, kind: 'image', w: x.info.width, h: x.info.height, fileDur: 0, peak: 0, name: path.basename(x.file) }))
      .concat(cands.filter((c) => !c.spoken));
    for (const b of broll) { if (b.kind === 'image' && !b.thumb) { try { b.thumb = await thumb(ctx, b.file, 0, path.join(tmp, b.id + '.jpg'), true); } catch (e) { b.thumb = null; } } }
    if (onProgress) onProgress(42);
    // 2) CHOOSE
    const list = phrases.length > 420 ? phrases.slice().sort((a, b) => b.score - a.score).slice(0, 420).sort((a, b) => a.vid - b.vid || a.start - b.start) : phrases;
    if (stage) stage(process.env.ANTHROPIC_API_KEY ? '🎬 Claude is picking the lines that will stop the scroll…' : '🎬 The AI is picking the lines that will stop the scroll…');
    let d = null;
    try { d = await talkWithClaude(list, opts); } catch (e) { if (log) log('claude: ' + e.message); }
    if (!d) { try { d = await talkWithGroq(list, opts); } catch (e) { if (log) log('groq: ' + e.message); } }
    if (!d) d = talkByRules(list, opts);
    const byId = new Map(phrases.map((p) => [p.id, p]));
    let picks = [];
    for (const x of (d.plan.picks || [])) { const p = byId.get(String(x && x.id || '').trim()); if (p && !picks.includes(p)) picks.push(p); }
    if (picks.length < 1) picks = talkByRules(list, opts).plan.picks.map((x) => byId.get(x.id)).filter(Boolean);
    // the length asked for, give or take a line (the hook always stays)
    let total = picks.reduce((n, p) => n + (p.end - p.start), 0);
    while (picks.length > 2 && total - (picks[picks.length - 2].end - picks[picks.length - 2].start) >= opts.lengthSec * 1.15) {
      const cut = picks.splice(picks.length - 2, 1)[0];   // the last line is the payoff: take the one before it
      total -= cut.end - cut.start;
    }
    /*
     * 2b) SOMEONE ON SCREEN, ALWAYS. The AI looks at every chosen line (two
     * frames of it — near its start and near its end) and counts the people.
     * A line that shows nobody — the camera on an empty stage, the screen, the
     * slides — is not used, and the next strongest lines that DO show someone
     * take its place. The looks are kept: they say where to cut each beat so
     * the person stays in the 9:16 frame, and how to pan with them (FULL SCREEN).
     */
    // near its start and its end — and in its middle when it runs on (a cut to a title graphic mid-sentence is caught too)
    // a look in the middle of EVERY beat, and near the line's start and end — so each beat is cut round
    // its person, the crop pans between them, and a beat that cuts away to nobody is caught
    const looksAt = (p) => {
      const ts = [];
      const add = (t) => { if (!ts.some((x) => Math.abs(x - t) < 0.6)) ts.push(t); };
      const spans = beatSpans(p);
      add(spans[0].from + 0.3);
      spans.forEach((b) => add((b.from + b.to) / 2));
      add(spans[spans.length - 1].to - 0.3);
      return ts.sort((a, b) => a - b);
    };
    const lookLines = async (ps) => {
      const reqs = [], who = [];
      ps.forEach((p) => { p.looks = []; looksAt(p).forEach((t) => { reqs.push({ file: p.cand.file, t: round2(clamp(t, 0, Math.max(0, p.cand.fileDur - 0.1))), w: p.cand.w, h: p.cand.h }); who.push(p); }); });
      if (!reqs.length) return;
      const got = await lookAt(ctx, reqs, tmp, log, { people: true, frame: ASPECTS[opts.aspect] ? { W: ASPECTS[opts.aspect].w, H: ASPECTS[opts.aspect].h } : { W: 1080, H: 1920 } });
      got.forEach((g, i) => who[i].looks.push({ t: reqs[i].t, fx: g.fx, people: g.people }));
    };
    // a line where HALF or more of its looks show nobody is not used; one with only a moment of nobody
    // (a cut to the screen mid-sentence) is kept, and that beat is covered with a moment that shows someone
    const nobody = (p) => !!(p.looks && p.looks.length && p.looks.filter((l) => l.people === 0).length * 2 >= p.looks.length);
    if (stage) stage('👀 Making sure someone can be seen in every line…');
    await lookLines(picks);
    const seen = picks.some((p) => p.looks.some((l) => l.people != null));
    const rejected = new Set();
    if (seen) {
      const empty = picks.filter(nobody);
      empty.forEach((p) => rejected.add(p));
      const chosen = picks.slice();
      if (empty.length) {
        picks = picks.filter((p) => !nobody(p));
        let tot = picks.reduce((n, p) => n + (p.end - p.start), 0);
        const tried = new Set(picks.concat(empty));
        // the strongest lines that were not chosen — short ones too when nothing chosen survived (someone on screen beats a longer line)
        const pool = list.filter((p) => !tried.has(p) && p.end - p.start >= (picks.length ? 1.4 : 0.8)).sort((a, b) => b.score - a.score);
        let added = 0;
        for (let round = 0; round < 3 && tot < opts.lengthSec * 0.9 && pool.length; round++) {
          const batch = pool.splice(0, 6);
          await lookLines(batch);
          for (const p of batch) {
            if (nobody(p)) rejected.add(p);
            if (tot >= opts.lengthSec * 0.9) break;
            if (nobody(p) || !p.looks.some((l) => l.people > 0)) continue;
            if (picks.length < 2) picks.push(p); else picks.splice(picks.length - 1, 0, p);   // before the payoff, which stays last
            tot += p.end - p.start; added++;
          }
        }
        if (!picks.length) {
          picks = chosen;
          if (log) log('people: no line with someone in it could be found — kept as chosen');
        } else if (log) log(`people: ${empty.length} line(s) showed nobody and were left out; ${added} line(s) with someone in them took their place`);
      }
      const unchecked = picks.filter((p) => !p.looks || !p.looks.some((l) => l.people != null)).length;
      if (unchecked && log) log(`people: ${unchecked} line(s) could not be checked (the AI did not answer) — kept`);
    }
    if (onProgress) onProgress(50);
    // the narrator, when asked for: the director's words (or the operator's own hook), in a real voice
    const P = d.plan || {};
    const fb0 = fromBrief(briefText(opts));
    const vo = { intro: null, outro: null, why: '' };
    if (opts.voice) {
      const say1 = String(P.vo_intro || (fb0 && fb0.hook) || 'You need to hear this.').replace(/\s+/g, ' ').trim().slice(0, 160);
      const say2 = String(P.vo_outro || (opts.about && opts.about.cta) || 'Share this with someone who needs it today.').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (stage) stage('🎙 Recording the narrator…');
      try {
        const vox = require('./voiceover');
        for (const [k, text] of [['intro', say1], ['outro', say2]]) {
          const wav = path.join(tmp, `vo-${k}.wav`);
          await vox.speak(text, { voice: opts.voice, out: wav });
          let len = 0;
          try { len = (await getInfo(ctx, wav)).durationSec || 0; } catch (e) { len = 0; }
          if (len > 0.4) vo[k] = { wav, text, len: round2(len) };
        }
      } catch (e) {
        if (e instanceof jobs.CancelledError) throw e;
        vo.why = (e && e.message) || 'the voice could not be made';
        if (log) log('voiceover: ' + vo.why);
      }
    }
    // moments the edit did not use, from every speaking video — B-roll for the narrator and between lines
    // (never a line already seen to show nobody)
    const spare = phrases.filter((p) => !picks.includes(p) && !rejected.has(p) && p.end - p.start >= 1.4).sort((a, b) => b.score - a.score);
    // the B-roll moments too: only ones where someone can be seen (looked at where the snapshot freezes)
    const snapAt = (sp) => round2(clamp(sp.start + Math.min(1.2, (sp.end - sp.start) / 2), 0, Math.max(0, sp.cand.fileDur - 0.1)));
    // the silent clips too (they fill the narrator's stretches and cutaways): looked at where they play, the middle
    const silent = broll.filter((b) => b.kind === 'video');
    if (seen && silent.length) {
      const got = await lookAt(ctx, silent.map((b) => ({ file: b.file, t: round2(Math.max(0, (b.fileDur || 0) / 2)), w: b.w, h: b.h })), tmp, log, { people: true, frame: ASPECTS[opts.aspect] ? { W: ASPECTS[opts.aspect].w, H: ASPECTS[opts.aspect].h } : { W: 1080, H: 1920 } });
      const out = silent.filter((b, i) => got[i] && got[i].people === 0);
      if (out.length) {
        for (const b of out) broll.splice(broll.indexOf(b), 1);
        if (log) log(`people: ${out.length} silent clip(s) showed nobody and are not used`);
      }
    }
    // spare moments are only used when there are not enough photos and silent clips for every slot
    const slotsFor = Math.max(0, Math.ceil(picks.reduce((n, p) => n + (p.end - p.start), 0) / 5.2) - broll.length) + (opts.voice && !broll.length ? 6 : 0);
    if (seen && spare.length && slotsFor > 0) {
      const top = spare.slice(0, Math.min(24, slotsFor + 4));
      const got = await lookAt(ctx, top.map((sp) => ({ file: sp.cand.file, t: snapAt(sp), w: sp.cand.w, h: sp.cand.h })), tmp, log, { people: true, frame: ASPECTS[opts.aspect] ? { W: ASPECTS[opts.aspect].w, H: ASPECTS[opts.aspect].h } : { W: 1080, H: 1920 } });
      top.forEach((sp, i) => { sp.snapLook = got[i]; });
      const good = top.filter((sp) => !(sp.snapLook && sp.snapLook.people === 0));
      if (log && good.length < top.length) log(`people: ${top.length - good.length} B-roll moment(s) showed nobody and were left out`);
      spare.length = 0; spare.push(...good);
    }
    let spareAt = 0;
    const nextSpare = (notFile) => {
      for (let n = 0; n < spare.length; n++) {
        const p = spare[(spareAt + n) % spare.length];
        if (notFile && p.cand.file === notFile && spare.some((x) => x.cand.file !== notFile)) continue;
        spareAt = (spareAt + n + 1) % spare.length;
        return p;
      }
      return null;
    };
    // 3) MOVE — every line into beats, each framed differently
    const moves = TALK_MOVES[opts.style] || TALK_MOVES.hype;
    const grade = TALK_GRADES[opts.style] || TALK_GRADES.hype;
    const shots = [];
    const capWords = [];
    let at = 0, m = 0;
    /* the narrator's stretch: quick B-roll cuts, the videos' own sound off, the voice laid on after */
    const voStretch = (part, isIntro) => {
      if (!part) return;
      const want = part.len + (isIntro ? 0.25 : 0.6);
      const startAt = at;
      let left = want, n = 0;
      while (left > 0.35) {
        const len = round2(left < 2.2 ? left : 1.5);
        const br = broll.length ? broll[(n + (isIntro ? 0 : 1)) % broll.length] : null;
        let sh;
        if (br) {
          sh = { cand: br, seconds: len, from: br.kind === 'video' ? round2(clamp(br.fileDur / 2 - len / 2 + n * 1.7, 0, Math.max(0, br.fileDur - len - 0.05))) : null,
            need: br.kind === 'video' ? len : undefined, effect: br.kind === 'image' ? 'slow_zoom' : moves[m++ % moves.length], focus: 'center', slow: false, transition: 'cut', grade, overlays: [], mute: true };
        } else {
          const sp = nextSpare(null) || picks[n % picks.length];
          // round the moment that was looked at (and seen to show someone)
          const mid = sp.snapLook ? snapAt(sp) : sp.start + len / 2;
          const from = round2(clamp(mid - len / 2, 0, Math.max(0, sp.cand.fileDur - len - 0.05)));
          sh = { cand: sp.cand, seconds: len, from, need: len, effect: n === 0 && isIntro ? 'punch_in' : moves[m++ % moves.length], focus: 'center', slow: false, transition: 'cut', grade, overlays: [], mute: true };
        }
        sh.at = round2(at);
        shots.push(sh);
        at = round2(at + len); left -= len; n++;
      }
      part.at = round2(startAt + (isIntro ? 0.05 : 0.2));
      // the narrator's words as captions too, spread over what is said (a voice has no word clock)
      const ws = part.text.split(' ').filter(Boolean);
      const per = part.len / Math.max(1, ws.length);
      ws.forEach((w, i) => capWords.push({ text: w, start: round2(part.at + i * per), end: round2(part.at + (i + 1) * per - 0.03) }));
    };
    voStretch(vo.intro, true);
    const speechFrom = shots.length;
    picks.forEach((p, pi) => {
      const ws = p.words;
      // beats of about 2.6 s, cut between words (beatSpans — the same cut the looks were taken at)
      const spans = beatSpans(p);
      spans.forEach(({ from, to, a, b }, bi) => {
        const first = bi === 0, last = bi === spans.length - 1;
        const need = round2(Math.max(0.4, to - from));
        const effect = pi === 0 && bi === 0 && !vo.intro ? 'punch_in' : moves[m++ % moves.length];
        const hypeish = opts.style === 'hype' || opts.style === 'fun';
        const transition = first && hypeish && ((pi === 0 && vo.intro) || pi % 2 === 1) ? 'flash' : 'cut';
        const sh = { cand: p.cand, seconds: need, from: round2(from), need, effect, focus: 'center', slow: false, transition, grade, overlays: [], at: round2(at), line: pi };
        // TRACKING: cut round the person, panning with them from where they stand at this beat's start to its end
        // framed from THIS beat's own looks (a camera that cuts from wide to close between beats is not blended):
        // one look holds there, two or more pan from the first to the last; none borrows the line's nearest
        const own = (p.looks || []).filter((l) => l.fx != null && l.people !== 0 && l.t >= from - 0.05 && l.t <= from + need + 0.05).sort((x, y) => x.t - y.t);
        const fa = own.length ? own[0].fx : fxAtLook(p, from + need / 2);
        const fb = own.length > 1 ? own[own.length - 1].fx : null;
        if (fa != null) { sh.fx = round2(fa); if (fb != null && Math.abs(fb - fa) > 0.02) sh.fx2 = round2(fb); }
        // a beat whose own look saw nobody (the camera on the screen for a moment): covered below
        if ((p.looks || []).some((l) => l.people === 0 && l.t >= from - 0.05 && l.t <= from + need + 0.05)) sh.cover = true;
        for (const w of ws.slice(a, b + 1)) {
          const s0 = at + (w.start - from), s1 = at + (w.end - from);
          capWords.push({ text: w.text, start: round2(Math.max(at, s0)), end: round2(Math.min(at + need, Math.max(s0 + 0.05, s1))) });
        }
        shots.push(sh);
        at = round2(at + need);
      });
    });
    const speechTo = shots.length;
    voStretch(vo.outro, false);
    shots[0].transition = 'cut';
    /*
     * B-ROLL OVER THE SPEAKER — the mix and match: while the voice carries on,
     * the picture cuts away to a photo, a silent clip, or another moment of the
     * videos (a different video where there is one), then back.
     */
    /*
     * COVER: a beat whose look saw nobody (inside a line that is otherwise on
     * the speaker) is covered, whole, by a moment that was SEEN to show someone
     * — another look at the speaker, or a checked B-roll moment — while the
     * words carry on underneath. Never a frame of an empty stage.
     */
    const seenMoments = [];
    picks.forEach((p) => (p.looks || []).forEach((l) => { if (l.people > 0) seenMoments.push({ cand: p.cand, t: l.t, fx: l.fx, p }); }));
    for (const sp of spare) if (sp.snapLook && sp.snapLook.people > 0) seenMoments.push({ cand: sp.cand, t: snapAt(sp), fx: sp.snapLook.fx, p: sp });
    let cm = 0, covered = 0;
    for (let i = speechFrom; i < speechTo; i++) {
      const sh = shots[i];
      if (!sh.cover) continue;
      // a moment from another line first (the same face, a different moment)
      const pool = seenMoments.filter((x) => x.p !== picks[sh.line]);
      const use = pool.length ? pool : seenMoments;
      const m = use.length ? use[cm++ % use.length] : null;
      const photo = broll.find((b) => b.kind === 'image');
      if (m) {
        sh.overlays = [{ cand: m.cand, style: 'cutaway', start: 0, len: sh.seconds, pos: 'right', cover: true,
          from: round2(clamp(m.t - sh.seconds / 2, 0, Math.max(0, (m.cand.fileDur || 0) - sh.seconds - 0.05))), fx: m.fx == null ? null : round2(m.fx) }];
        covered++;
      } else if (photo) {
        sh.overlays = [{ cand: photo, style: 'cutaway', start: 0, len: sh.seconds, pos: 'right', cover: true, from: null }];
        covered++;
      }
    }
    if (covered && log) log(`people: ${covered} beat(s) that cut away to nobody are covered with a moment that shows someone`);
    let bi = 0, sb = 0;
    for (let i = speechFrom + 1; i < speechTo; i += 2) {
      const sh = shots[i];
      if (sh.seconds < 2 || sh.cover) continue;
      const len = round2(Math.min(broll.length ? 2.2 : 1.6, sh.seconds - 0.5));
      if (broll.length && bi < broll.length) {
        const o = broll[bi++];
        sh.overlays.push({ cand: o, style: 'cutaway', start: 0.25, len, pos: i % 4 === 1 ? 'right' : 'left', from: o.kind === 'video' ? round2(clamp(o.fileDur / 2 - len / 2, 0, Math.max(0, o.fileDur - len - 0.05))) : null });
      } else {
        /*
         * One video and no photos: the edit's own best unused moments go over it,
         * on every other beat — mostly SNAPSHOTS (a still of the moment popping on
         * with a camera flash, the best of them first: `spare` is in score order),
         * now and then a cutaway that plays. Constant engagement, never a beat
         * that runs on with nothing new to look at.
         */
        const sp = nextSpare(sh.cand.file);
        if (!sp) continue;
        const snap = sb++ % 3 !== 2;
        const ol = snap ? round2(Math.min(1.5, sh.seconds - 0.5)) : len;
        const at0 = snap ? sp.start + Math.min(1.2, (sp.end - sp.start) / 2) : sp.start + 0.2;
        const ov = { cand: sp.cand, style: snap ? 'snapshot' : 'cutaway', start: snap ? 0.35 : 0.3, len: ol, pos: sb % 2 ? 'left' : 'right',
          from: round2(clamp(at0, 0, Math.max(0, sp.cand.fileDur - ol - 0.05))) };
        if (!snap && sp.snapLook && sp.snapLook.fx != null) ov.fx = round2(sp.snapLook.fx);   // already looked at: cut round its person
        sh.overlays.push(ov);
      }
    }
    const duration = at;
    const hook = String(P.hook_text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const texts = hook ? [{ start: 0, end: round2(Math.min(duration, Math.max(2.4, shots[0].seconds + (shots[1] ? shots[1].seconds : 0)))), text: hook, role: 'hook' }] : [];
    const fb = fromBrief(briefText(opts));
    // THE POST: written for social media from what is SAID in the edit (not the operator's notes, copied)
    if (stage) stage('✍️ Writing the post caption and hashtags…');
    const post = await writeTalkPost(picks, opts, P, hook);
    const plan = {
      concept: String(P.concept || '').slice(0, 300),
      title: String(P.title || hook || (fb && fb.hook) || '').slice(0, 100),
      postCaption: post.caption.slice(0, 900),
      hashtags: post.hashtags,
      shots, texts, duration,
    };
    // FULL SCREEN: every landscape moment is cropped to fill, round its speaker
    await aimShots(ctx, shots, opts.aspect, { picks, tmp, log, stage });
    // 4) RENDER
    if (stage) stage(`✂️ Cutting ${picks.length} lines into ${shots.length} beats — zooms, grade and B-roll…`);
    await render(ctx, plan, { aspect: opts.aspect, keepAudio: true, output, base: baseOf(output), tmp, onProgress: say(50, 97) });
    const voices = [vo.intro, vo.outro].filter(Boolean);
    if (voices.length) {
      if (stage) stage('🎙 Laying the narrator on…');
      for (const f of [output, baseOf(output)]) if (fs.existsSync(f)) await laySpeech(ctx, f, voices, tmp);
    }
    withAbout(plan, opts.about);   // the caption carries the call to action, speaker and church — in the saved edit too
    saveProject(output, projectOf(plan, cands.concat(broll), { aspect: opts.aspect, keepAudio: true, style: opts.style, full: false }, plan));
    return resultOf(plan, output, opts, {
      director: d.director, model: d.model, mode: 'talk', words: capWords,
      lines: picks.length, music: !!musicPath,
      narrator: voices.length ? voices.map((v) => v.text) : null, narratorWhy: opts.voice && !voices.length ? (vo.why || 'no voice') : '',
    });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

/* --------------------------------------------------------------------- make */

/**
 * The whole job. `stage(name)` says what is happening (for the phone), and
 * `onProgress(pct)` how far through the whole thing it is.
 */
async function make(ctx, getInfo, { mediaPaths, musicPath, style, lengthSec, full, aspect, brief, about, keepAudio, keepOrder, output, onProgress, stage, log, mode, hear, voice }) {
  const files = (mediaPaths || []).filter((p) => p && fs.existsSync(p)).slice(0, 60);
  if (!files.length) throw new Error('Add some videos or pictures first.');
  if (mode === 'talk') {
    const topts = {
      voice: voice || null,
      style: STYLES[style] ? style : 'hype',
      lengthSec: clamp(Number(lengthSec) || 45, 10, 600),
      aspect: ASPECTS[aspect] ? aspect : '9:16',
      brief: cleanBrief(brief),
      about: cleanAbout(about),
    };
    return makeTalk(ctx, getInfo, { files, opts: topts, hear, musicPath, output, onProgress, stage, log, keepAudio });
  }
  const opts = {
    style: STYLES[style] ? style : 'hype',
    full: !!full || lengthSec === 'all' || Number(lengthSec) === 0,
    lengthSec: clamp(Number(lengthSec) || 30, 8, 600), // up to ten minutes
    aspect: ASPECTS[aspect] ? aspect : '9:16',
    brief: cleanBrief(brief),
    about: cleanAbout(about),
    keepOrder: !!keepOrder,
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-montage-'));
  const part = (a, b) => (p) => onProgress && onProgress(Math.round(a + (b - a) * (p / 100)));
  try {
    if (stage) stage('👀 Watching every clip and picture…');
    // a longer edit needs more moments to choose from (still within what one look can take)
    const budget = clamp(Math.round(opts.lengthSec / 2.5), 44, 90);
    const cands = await analyze(ctx, getInfo, files, { tmp, onProgress: part(0, 35), full: opts.full, budget });
    cands.forEach((c) => { c.order = files.indexOf(c.file); });
    // keeping their order, the director is shown the files in that order too
    if (opts.keepOrder) cands.sort((a, b) => a.order - b.order || (a.start || 0) - (b.start || 0));
    let music = null;
    if (musicPath && fs.existsSync(musicPath)) {
      if (stage) stage('🎵 Finding the beat of your song…');
      try { music = await beats(ctx, musicPath); } catch (e) { if (e instanceof jobs.CancelledError) throw e; music = null; }
    }
    if (onProgress) onProgress(38);
    if (stage) stage(process.env.ANTHROPIC_API_KEY ? '🎬 Claude is directing your edit…' : '🎬 The AI is watching your shots and directing…');
    const d = await direct(cands, opts, music, log, ctx, tmp);
    if (onProgress) onProgress(50);
    const plan = finalise(d.plan, cands, opts, music);
    // FULL SCREEN: a clip of another shape is cut to fill the frame, round its person
    await aimShots(ctx, plan.shots, opts.aspect, { tmp, log, stage });
    if (stage) stage(opts.full ? `🎞 Blending all ${files.length} together…` : `✂️ Cutting ${plan.shots.length} shots together…`);
    await render(ctx, plan, { aspect: opts.aspect, keepAudio: keepAudio !== false, output, base: baseOf(output), tmp, onProgress: part(50, 100) });
    // the edit itself, beside the video, so it can be rearranged later
    withAbout(plan, opts.about);   // the caption carries the call to action, speaker and church — in the saved edit too
    saveProject(output, projectOf(plan, cands, { aspect: opts.aspect, keepAudio, style: opts.style, full: opts.full }, plan));
    return resultOf(plan, output, opts, { director: d.director, model: d.model, bpm: music ? music.bpm : null });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

/** Which director the montage would use right now (for the phone to say so). */
function directorStatus() {
  if (process.env.ANTHROPIC_API_KEY) return { director: 'claude', model: process.env.MW_MONTAGE_MODEL || 'claude-opus-5-5' };
  try { const cw = require('./cloudwrite'); if (cw.access && cw.access().key) return { director: 'groq', model: '', vision: true }; } catch (e) {}
  return { director: 'rules', model: '' };
}

module.exports = { cleanAbout, withAbout, aboutLines, phrasesOf, phraseScore, talkByRules, fromBrief, cleanBrief, make, remake, loadProject, sidecarOf, baseOf, analyze, beats, finalise, directByRules, directorStatus, PLAN_SCHEMA, ASPECTS, STYLES, EFFECTS, TRANSITIONS, OVERLAY_STYLES, _direct: direct };
