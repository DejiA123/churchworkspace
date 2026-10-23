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
  // five popular hashtags at most, never the AI's own (social-copy: what the platforms take)
  plan.hashtags = popularTagsFor(plan, a);
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
  return Object.assign(plan, { postCaption: cap.slice(0, 900) });
}
/* The montage's hashtags (without the #): the speaker's or church's own one, two popular ones about it, then the biggest. */
function popularTagsFor(plan, a) {
  const sc = require('./social-copy');
  const text = [plan.title, plan.concept, plan.postCaption, (plan.hashtags || []).join(' ')].filter(Boolean).join(' ');
  const line = sc.withPopularTags('', sc.STYLES[1], { speaker: a.speaker || '', eventName: a.speaker ? '' : (a.church || ''), text });
  return (line.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1)).slice(0, 5);
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
  // a zoom keeps more of the TOP of the picture than the bottom: that is where heads are (a centred zoom cut them off)
  const sc = (f) => `scale=w='trunc(${W}*(${f})/2)*2':h=-2:eval=frame,crop=${W}:${H}:(iw-ow)/2:(ih-oh)*0.3`;
  const T = t0 ? `(t+${t0.toFixed(3)})` : 't';
  switch (effect) {
    case 'punch_in': return t0 >= 0.3 ? '' : sc(`if(lt(${T},0.3),1.16-0.53*${T},1)`);
    case 'slow_zoom': return sc(`1+0.09*${T}/${dur.toFixed(2)}`);
    case 'zoom_out': return sc(`1.1-0.1*${T}/${dur.toFixed(2)}`);
    case 'flash': return t0 ? '' : 'fade=t=in:st=0:d=0.18:color=white';
    // the talk edit's jump zooms: the same speaker, framed closer, cut to on a word
    case 'hold_in': return sc('1.12');
    case 'hold_tight': return sc('1.18');
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
const HOUSEKEEPING = /\b(turn to|page \w+|announcement|announcements|please be seated|be seated|good morning|good evening|welcome everyone|offering|tithes?|car park|parking|microphone|can you hear me|next slide|iban|bank details|account (number|name)|sort code|qr code|scan (the|this)|donat\w*|give online|sponsor\w*|tickets?|merch\w*|toilets?|restrooms?|fire exits?|wi-?fi|raffle)\b/i;
/* A MOMENT: lines that follow each other in the same video (within a few seconds). "Each moment must not be too long." */
const MOMENT_GAP = 8, MOMENT_MAX = 14;
/* a long event (a whole service, a concert): its lines are taken from several moments, never one stretch */
const LONG_EVENT_SEC = 15 * 60;
/*
 * WHAT THE EDITOR IS SHOWN, FROM A LONG EVENT. A three-hour service has
 * thousands of lines; the editor sees 420. Taking the 420 loudest bunched them
 * in the loudest half hour. Now the event is cut into windows of a few minutes
 * and the best lines of EACH come, so every part of it can be chosen from.
 */
function spreadList(phrases, max = 420) {
  if (phrases.length <= max) return phrases;
  const span = phrases.reduce((m, p) => Math.max(m, p.end), 0);
  const win = Math.max(90, span / 60);
  const buckets = new Map();
  for (const p of phrases) { const k = p.vid + ':' + Math.floor(p.start / win); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(p); }
  const quota = Math.max(2, Math.floor(max / buckets.size));
  const chosen = new Set();
  for (const list of buckets.values()) list.slice().sort((a, b) => b.score - a.score).slice(0, quota).forEach((p) => chosen.add(p));
  if (chosen.size < max) for (const p of phrases.slice().sort((a, b) => b.score - a.score)) { if (chosen.size >= max) break; chosen.add(p); }
  return Array.from(chosen).sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.vid - b.vid || a.start - b.start);
}
/*
 * A COMPLETE THOUGHT. A line that starts mid-sentence ("and they…", "of the…")
 * or stops on a word that needs another ("…so you give them your card, and
 * they") cannot stand on its own in a clip. Nor can the same question asked
 * three times in a row: only the best of near-identical lines is kept.
 */
// (words a thought cannot stop on — "…give them your card, and they" — but never "you", "it", "is": "He started it in you." is whole)
const DANGLING_END = /\b(and|or|but|the|a|an|to|of|my|your|our|their|because|if|when|then|than)[,]?$/i;
// (a thought joined on to one left out — "And then…", "Because…" — not "The joy of the Lord…", "That is the truth.")
const MIDDLE_START = /^(and|or|but|of|to|which|because|then|anyway|anyways|no[.,!]|yeah\b|okay\b|ok[.,]|um\b|uh\b|like,|so like\b)/i;
function wholeThought(p) {
  const t = String(p.text || '').trim();
  if (!t || /[—–-]\s*$/.test(t) || DANGLING_END.test(t.replace(/[.!?…]+$/, ''))) return false;
  if (MIDDLE_START.test(t) || /^[a-z]/.test(t) && !/^(i|i'm|i've|god|jesus)\b/i.test(t)) return false;
  // a sentence that ends (a comma, or no stop at all, is a thought cut off)
  if (!/[.!?…]["”’']?$/.test(t)) return false;
  // a line that says the same sentence twice ("Make some noise for Jesus? Make some noise for Jesus?") is one sentence too many
  const sents = t.split(/(?<=[.!?…])\s+/).map((x) => x.toLowerCase().replace(/[^a-z ]/g, '').trim()).filter(Boolean);
  if (sents.length > 1 && new Set(sents).size < sents.length) return false;
  // (or says it again inside another: "Pray, pray without ceasing. Pray without ceasing.")
  if (sents.some((a, i) => a.split(' ').length >= 2 && sents.some((b, j) => j !== i && b.includes(a)))) return false;
  // a stammer ("to to to every creature") reads badly as a caption
  if (/(?:^|\s)([\w']+)(?:,?\s+\1(?=\s|$|[,.!?])){2,}/i.test(t)) return false;
  // a word said twice over, twice in one line ("Stop, stop praying. Ceasing, ceasing.")
  if ((t.match(/\b([\w']+)[,.!]?\s+\1\b/gi) || []).length >= 2) return false;
  // a stutter on a small word ("the the character of God")
  if (/\b(the|a|an|to|of|and|in|is|it|my|we|you)\s+\1\b/i.test(t)) return false;
  // two thoughts run together where one was cut off ("…once and for So the testimony of Jesus…")
  if (/\b(and|or|but|the|a|an|to|of|for|my|your|our|their|because|if|when|then|than|is|are|was)\s+(So|And|But|Then|Because|Now|The|We|They|It)\b/.test(t)) return false;
  // a few words on their own ("Answer.", "Over your life.") are not a moment
  if (t.split(/\s+/).length < 4) return false;
  // an introduction or a shout-out is not a moment ("I am Daiji, also known as…", "follow us on…")
  if (/\b(my name is|also known as|i am \w+ from|shout ?outs?|follow (us|me)|subscribe|link in (the )?bio)\b/i.test(t)) return false;
  return true;
}
const wordsOfLine = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function sameLine(a, b) {
  const A = new Set(wordsOfLine(a.text)), B = wordsOfLine(b.text);
  if (!A.size || !B.length) return false;
  const both = B.filter((w) => A.has(w)).length;
  return both / Math.min(A.size, B.length) >= 0.7;
}
/* the candidates an editor is shown: whole thoughts, each said once (the best of near-identical lines kept) */
function goodLines(list) {
  const whole = list.filter(wholeThought);
  const base = whole.length >= Math.min(12, list.length) ? whole : list;
  const keep = [];
  for (const p of base.slice().sort((a, b) => b.score - a.score)) if (!keep.some((q) => sameLine(p, q))) keep.push(p);
  return keep.sort((a, b) => a.vid - b.vid || a.start - b.start);
}

/* the picks, in play order, grouped into moments (one after another in the same video) */
function momentsOf(picks) {
  const out = [];
  for (const p of picks) {
    const m = out[out.length - 1], last = m && m[m.length - 1];
    if (last && last.vid === p.vid && p.start >= last.start && p.start - last.end <= MOMENT_GAP) m.push(p); else out.push([p]);
  }
  return out;
}
/* no moment longer than MOMENT_MAX seconds: a run that goes on keeps its first lines (the thought as it starts) */
function shortMoments(picks) {
  const keep = [];
  for (const m of momentsOf(picks)) {
    let t = 0;
    m.forEach((p, i) => { const d = p.end - p.start; if (i === 0 || t + d <= MOMENT_MAX) { keep.push(p); t += d; } });
  }
  return keep;
}

/*
 * A LONG EVENT IN 30 SECONDS: the whole of it, not one stretch. The event is cut
 * into equal parts — one for every 2.5 seconds asked — and
 * each part gives at most ONE short line: the editor's choice where it made one
 * there, else the strongest whole thought said in it. The hook first, then the
 * rest in the order they happened (the event, start to finish). On Gospel Jamz
 * Day 1 (3 h 44) the editor's lines all came from one half-hour panel.
 *
 * ►► A CLIP EVERY 2.5 SECONDS — THE WORDS WHOLE. ◄◄ "Let each clip be 2.5 seconds
 * instead of 3.6." That was first done with the WORDS: one sentence of 1.7–2.9 s
 * from each of 12 parts. Only 185 of a 3 h 44 event's lines are that short and
 * whole, and most are stage chat ("Can we clap for him?", "Just a little bit
 * more volume") — both edits were "terrible". Now the PICTURE moves every
 * MOMENT_EACH seconds and the words stay whole: one strong line of 2–5.5
 * seconds from each part (as in the 30 s the church liked), opening on
 * its speaker, and every beat after its first covered whole by a checked
 * moment from another part of the night while the voice carries on.
 */
const MOMENT_EACH = 2.5, LINE_EACH = 3.8, MOMENT_LINE_MIN = 2, MOMENT_LINE_MAX = 5.5;
const partsFor = (opts) => clamp(Math.round((opts.lengthSec || 30) / LINE_EACH), 4, 16);
/*
 * ►► A SECOND READ OF THE LINES, PART BY PART. ◄◄ The editor read 400 lines at
 * once and still took "Oh, winner man! Oh, winner money!". Here the AI reads
 * each part of the event on its own — the line chosen there and the best few
 * others — and keeps only the lines a stranger would feel, best first. Only
 * what it keeps is used, there and as any later replacement. Returns null when
 * no AI answered (the edit stays as it was).
 */
async function vetParts(picks, list, opts, log) {
  const ev = eventParts(list.concat(picks), opts);
  const ok = (p) => p.end - p.start >= MOMENT_LINE_MIN && p.end - p.start <= MOMENT_LINE_MAX && !CROWD.test(p.text) && !HOUSEKEEPING.test(p.text) && !asks(p) && wholeThought(p);
  const parts = [];
  for (let k = 0; k < ev.n; k++) {
    const mine = picks.filter((p) => ev.part(p) === k);
    const more = list.filter((p) => ev.part(p) === k && !mine.includes(p) && ok(p)).sort((a, b) => lineVal(b) - lineVal(a)).slice(0, 6 - Math.min(2, mine.length));
    const c = mine.concat(more);
    if (c.length) parts.push({ k, c });
  }
  if (!parts.length) return null;
  const system = 'You choose the lines for a short viral video of a church event, heard one after another. You only judge the words.';
  const prompt = 'For each part of the event below, keep ONLY the lines that, heard on their own by a stranger scrolling, carry a clear and powerful message about God, faith, hope or life — a line people would quote or share. Be strict: at most 3 per part, and when in doubt, drop it. ' +
    'Drop banter and jokes, crowd work, stage chat, any question (a line that asks is not a line to share), announcements, a line that only makes sense with what came before, a line cut off mid-thought, slang or wordplay a stranger would not follow, and anything unclear. Order the kept ones best first. A part may keep none.\n\n' +
    parts.map((pt) => `PART ${pt.k + 1}\n` + pt.c.map((p) => `${p.id}: ${p.text}`).join('\n')).join('\n\n') +
    '\n\nReply with JSON only: {"parts":{"1":["id","id"],"2":[]}} — every part listed, the ids it keeps, best first.';
  let text = '';
  try { const ai = require('./aaillm'); if (ai.ready()) text = await ai.chat({ system, prompt, json: true, maxTokens: 1500, temperature: 0.2 }); } catch (e) { text = ''; }
  if (!text) { try { const cw = require('./cloudwrite'); if (cw.access && cw.access().key) text = await cw.chat({ system, prompt, json: true, maxTokens: 1500, temperature: 0.2, timeoutMs: 60000, evenIfOff: true }); } catch (e) { text = ''; } }
  let j = null;
  try { const t = String(text || ''); const a = t.indexOf('{'), b = t.lastIndexOf('}'); j = a >= 0 && b > a ? JSON.parse(t.slice(a, b + 1)) : null; } catch (e) { j = null; }
  if (!j || !j.parts || typeof j.parts !== 'object') { if (log) log('vet: no AI read the lines again — kept as chosen'); return null; }
  const byId = new Map(parts.flatMap((pt) => pt.c).map((p) => [p.id, p]));
  const ranked = new Map(), approved = new Set();
  for (const pt of parts) {
    const ids = Array.isArray(j.parts[String(pt.k + 1)]) ? j.parts[String(pt.k + 1)] : [];
    const r = ids.map((id) => byId.get(String(id).trim())).filter((p) => p && pt.c.includes(p));
    ranked.set(pt.k, r); r.forEach((p) => approved.add(p));
  }
  if (!approved.size) { if (log) log('vet: the AI kept no line at all — kept as chosen'); return null; }
  // the hook stays if it was kept; else the best kept line of its part (or of any part)
  const hookPart = picks[0] ? ev.part(picks[0]) : -1;
  const hook = picks[0] && approved.has(picks[0]) ? picks[0] : ((ranked.get(hookPart) || [])[0] || [...approved][0]);
  const out = [hook];
  for (const [k, r] of ranked) { const best = r.find((p) => p !== hook); if (best && k !== ev.part(hook)) out.push(best); }
  if (log) log(`vet: the AI read every part again — kept ${approved.size} line(s); the edit has ${out.length}`);
  return { picks: out, approved };
}

/* where a line falls in the whole event (its videos end to end), and which of its equal parts that is */
function eventParts(all, opts) {
  const vids = [...new Set(all.map((p) => p.vid))].sort((a, b) => a - b);
  const off = new Map(); let t = 0;
  for (const v of vids) { off.set(v, t); t += Math.max(...all.filter((p) => p.vid === v).map((p) => Math.max(p.end, (p.cand && p.cand.fileDur) || 0))); }
  const at = (p) => (off.has(p.vid) ? off.get(p.vid) : 0) + p.start;
  const n = partsFor(opts);
  return { n, at, part: (p) => Math.min(n - 1, Math.floor(at(p) / (t / n))) };
}
const asks = (p) => /\?["”’']?$/.test(String(p.text || '').trim());   // a question to the room, not a line to share
const lineVal = (p) => p.score + messageOf(p) - (p.usedBefore ? 0.5 : 0);
/* the order of a long event's edit: the hook, the event start to finish, and the strongest statement last (the payoff) */
function eventOrder(picks, ev) {
  if (picks.length < 3) return picks;
  const rest = picks.slice(1);
  const ends = rest.filter((p) => /[.!]["”’']?$/.test(p.text.trim()) && !CROWD.test(p.text));
  const pay = (ends.length ? ends : rest).reduce((a, b) => (lineVal(b) > lineVal(a) ? b : a));
  return [picks[0]].concat(rest.filter((p) => p !== pay).sort((a, b) => ev.at(a) - ev.at(b)), [pay]);
}
function acrossEvent(picks, list, opts) {
  const { n, at, part } = eventParts(list.concat(picks), opts);
  const short = (p) => p.end - p.start <= MOMENT_LINE_MAX;
  const taken = new Map();
  // (the hook too: a line longer than LINE_MAX gives way to its part's best line)
  picks.forEach((p) => { const k = part(p); if (!taken.has(k) && short(p) && p.end - p.start >= MOMENT_LINE_MIN) taken.set(k, p); });
  // the parts the editor left empty: their own strongest line (one no earlier take used counts for more)
  const val = lineVal;
  // (about LINE_EACH seconds a line: a much longer one counts for a little less)
  const quick = (p) => val(p) - Math.max(0, p.end - p.start - LINE_EACH - 0.6) * 0.12;
  for (let k = 0; k < n; k++) {
    if (taken.has(k)) continue;
    const best = list.filter((p) => part(p) === k && short(p) && p.end - p.start >= MOMENT_LINE_MIN && !HOUSEKEEPING.test(p.text) && !CROWD.test(p.text) && !asks(p))
      .sort((a, b) => quick(b) - quick(a))[0];
    if (best && val(best) >= 0.4) taken.set(k, best);
  }
  const chosen = [...taken.values()];
  // (the editor's hook when it is a line's length; else the strongest line taken opens the edit)
  const hook = picks[0] && chosen.includes(picks[0]) ? picks[0] : chosen.slice().sort((a, b) => lineVal(b) - lineVal(a))[0] || null;
  const rest = chosen.filter((p) => p !== hook).sort((a, b) => at(a) - at(b));
  return hook ? [hook].concat(rest) : rest;
}

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
  // a word said twice over ("you you're", "to to") is a stumble
  s -= Math.min(0.6, ((p.text.match(/\b(\w+)\s+\1\b/gi) || []).length) * 0.3);
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
- No filler, no "um", no housekeeping (announcements, greetings, "turn to page"), no repeated points, no crowd work from the stage ("how many of you are enjoying…", "make some noise", "I am ready", "are you ready"). Never the giving or offering, bank details, a QR code, sponsors, tickets or logistics. Spoken words only, never the lyrics of a song being sung.
- SHORT MOMENTS: a moment is lines that follow each other in the video. Keep each moment short: one to three lines, never more than about 12 seconds of one stretch. When it is a long event, take moments from several different parts of it (different speakers, different times) and let them build one message.
- SHORT AND SNAPPY: every line a punch of about 2–6 seconds. More short lines beat fewer long ones — a line that runs on loses the scroll. Skip a long line unless it is the best thing said.
- Fit the length asked for. Shorter and tighter beats longer.
Use only ids that are given, each at most once, in the order they should play.
hook_text: a 3–7 word on-screen headline that makes people stop scrolling (not a quote of the first line).
post_caption: the caption for the post, 1–3 short sentences, with a question or a call to share. hashtags: 5–8, no # sign.
vo_intro / vo_outro: ONLY when a narrator is asked for (otherwise leave both empty). vo_intro is spoken by a narrator over B-roll BEFORE the first line: 6–14 words that create curiosity and make people stay ("He was about to give up — then he heard this."). Never a summary, never "in this video". vo_outro is spoken after the last line: 5–12 words, a warm call to follow or share. Plain words a person would say aloud — no emojis, no hashtags.`;

const clock = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
function talkBrief(opts, list, how = {}) {
  const used = list.some((p) => p.usedBefore), hl = list.some((p) => p.hl > 0);
  return `Style: ${opts.style} — ${STYLES[opts.style] || ''}\nTarget length: ${opts.lengthSec} seconds of speech — choose lines that add up to it.`
    + `\nNarrator: ${opts.voice ? 'YES — write vo_intro and vo_outro.' : 'no — leave vo_intro and vo_outro empty.'}`
    + (aboutLines(opts).length ? '\n' + aboutLines(opts).join('\n') : '')
    + (opts.brief ? `\nWhat the operator says it is about: ${opts.brief}` : '')
    + (opts.eventSec >= LONG_EVENT_SEC ? (() => {
      // the whole event in the edit: one short line from each part of it, start to finish
      const n = partsFor(opts), w = opts.eventSec / n, hm = (x) => `${Math.floor(x / 3600)}:${String(Math.floor(x / 60) % 60).padStart(2, '0')}`;
      return `\nThis is a long event (${Math.round(opts.eventSec / 60)} minutes: a whole service or concert). The edit must capture ALL of it, not one stretch: take ONE complete, powerful sentence of about 2 to 5 seconds (the picture cuts to other moments of the night every ${MOMENT_EACH} seconds while the words carry on) from EACH of these ${n} parts — ${Array.from({ length: n }, (_, k) => hm(k * w) + '–' + hm((k + 1) * w)).join(', ')} — different people, different moments, building one message. Never two lines from the same part.`;
    })() : '')
    + (opts.angle ? `\nANGLE FOR THIS EDIT: build it around "${opts.angle}" — the hook and the payoff should serve that idea.` : '')
    + (hl ? '\nLines marked ★ hold the key phrases of the whole message (ranked by AssemblyAI): strong candidates.' : '')
    + (used ? '\nLines marked (used before) were in earlier edits of this video. The operator wants a FRESH edit: choose DIFFERENT lines — use one of those only if nothing else comes close.' : '')
    + (how.compact
      // short form: id | when | words (★ a key phrase, ✗ used before)
      ? `\n\nPhrases (${list.length}) — id | time | words:\n` + list.map((p) => `${p.id} | ${p.vid > 1 ? 'v' + p.vid + ' ' : ''}${clock(p.start)}${p.hl > 0 ? ' ★' + p.hl.toFixed(2) : ''}${p.usedBefore ? ' (used before)' : ''} | ${p.text}`).join('\n')
      : `\n\nPhrases (${list.length}):\n` + list.map((p) => `${p.id} | video ${p.vid} | ${p.start.toFixed(1)}-${p.end.toFixed(1)}s | loud ${p.score}${p.hl > 0 ? ' | ★' + p.hl.toFixed(2) : ''}${p.usedBefore ? ' | (used before)' : ''} | ${p.text}`).join('\n'));
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

/* AssemblyAI's LLM Gateway (aaillm.js): the church's AssemblyAI key, a big model, room for the whole event */
async function talkWithAai(list, opts) {
  let ai;
  try { ai = require('./aaillm'); } catch (e) { return null; }
  if (!ai.ready()) return null;
  const prompt = talkBrief(opts, list, { compact: true })
    + '\n\nReply with JSON only, exactly this shape: {"concept":"","title":"","hook_text":"","post_caption":"","hashtags":[""],"picks":[{"id":"p1"}],"vo_intro":"","vo_outro":""}';
  const text = await ai.chat({ system: TALK_SYSTEM, prompt, json: true, maxTokens: 4000, temperature: 0.9 });
  let plan = null;
  try { const t = String(text || ''); const a = t.indexOf('{'), b = t.lastIndexOf('}'); plan = a >= 0 && b > a ? JSON.parse(t.slice(a, b + 1)) : null; } catch (e) { plan = null; }
  const st = ai.state();
  return plan && Array.isArray(plan.picks) ? { plan, director: 'assemblyai', model: (st.last && st.last.model) || '' } : null;
}

async function talkWithGroq(list, opts) {
  let cw;
  try { cw = require('./cloudwrite'); } catch (e) { return null; }
  if (!cw.access || !cw.access().key) return null;
  /*
   * A free Groq account reads only so much at once ("Please reduce the length
   * of the messages" — 420 lines of a three-hour service was far over it, and
   * the montage fell back to rules). It is shown the best lines from across the
   * event in a short form, fewer if it still says too long.
   */
  for (const n of [140, 80]) {
    const few = spreadList(list, n);
    const prompt = talkBrief(opts, few, { compact: true })
      + '\n\nReply with JSON only, exactly this shape: {"concept":"","title":"","hook_text":"","post_caption":"","hashtags":[""],"picks":[{"id":"p1"}],"vo_intro":"","vo_outro":""}';
    const text = await cw.chat({ system: TALK_SYSTEM, prompt, json: true, maxTokens: 1800, temperature: 0.9, timeoutMs: 90000, evenIfOff: true });   // (warm: a different edit each time)
    const plan = text ? cw.parseJson(text) : null;
    if (plan && Array.isArray(plan.picks)) return { plan, director: 'groq', model: (cw.state && cw.state().model) || 'groq' };
  }
  return null;
}

/** Without an AI: the strongest short line first, then the best lines in the order they were said. */
/* what carries the MESSAGE (a rules edit is built from these), and the crowd work around it (not a clip's line) */
const MESSAGE = /\b(god|jesus|christ|lord|holy spirit|spirit|faith|pray|prayers?|gospel|believe|love|grace|mercy|heaven|salvation|saved|sins?|cross|kingdom|bible|scripture|purpose|power|fire|glory|worship|testimony|hope|fear|nothing|everything|destiny|calling|anointing|freedom|truth)\b/gi;
const CROWD = /\b(are you (guys )?ready|make some noise|come on|give it up|clap|hands up|give a shout|can somebody|say amen|how many of you|are you (guys |all )?(enjoying|having|ready)|(have|has) been enjoying|i'?m ready|i am ready|who is ready|look at the screen|say what you see|that'?s it\. all right|stand up|on your feet|(please|everybody|everyone) (stand|sit|rise|raise)|are we (enjoying|having|ready)|enjoying ourselves|god bless you|(this|that|my|your|our) team|money'?s on|my money|where is everybody|how have you (all |guys )?been|haven'?t seen you|since last year|fast forward|oh my (goodness|days|god)|we pray|let us pray|let'?s pray|my team|you guys|anybody else|where are my|put your hands|shout (it|out|with)|turn to your neighbou?r|let'?s go|round of applause|one more time|do you want to|go again)\b/i;
const messageOf = (p) => Math.min(3, (String(p.text).match(MESSAGE) || []).length) * 0.25 - (CROWD.test(p.text) ? 0.6 : 0);
function talkByRules(list, opts) {
  // without an AI to judge them, a line with an "um" in it or the business of the service is never used
  const clean = list.filter((p) => !HOUSEKEEPING.test(p.text) && !(p.text.match(FILLER_ANY) || []).length);
  if (clean.length >= 2) list = clean;
  const secs = (l) => l.reduce((n, p) => n + (p.end - p.start), 0);
  // nor crowd work from the stage ("how many of you are enjoying…"), when there is enough without it
  const calm = list.filter((p) => !CROWD.test(p.text));
  if (calm.length >= 4 && secs(calm) >= (opts.lengthSec || 30)) list = calm;
  // another take of the same video: only lines no earlier take used, when there are enough of them to fill it
  const fresh = list.filter((p) => !p.usedBefore);
  if (fresh.length >= 4 && secs(fresh) >= (opts.lengthSec || 30)) list = fresh;
  // lines that carry the message, when there are enough of them (a rules edit cannot tell banter from a word)
  const said = list.filter((p) => messageOf(p) > 0);
  if (said.length >= 8 && secs(said) >= (opts.lengthSec || 30)) list = said;
  // a line used in an earlier edit of this video counts for less, and near-equal lines are taken in a new order each time
  const base = new Map(list.map((p) => [p, p.score + messageOf(p) - (p.usedBefore ? 0.5 : 0)]));
  const val = new Map(list.map((p) => [p, base.get(p) + Math.random() * 0.12]));
  // the hook: the strongest line not used before (the variety is in the rest, and in what earlier edits used)
  const hook = list.filter((p) => p.end - p.start >= 1.6 && p.end - p.start <= 6.5).sort((a, b) => base.get(b) - base.get(a))[0] || list[0];
  const rest = list.filter((p) => p !== hook).sort((a, b) => val.get(b) - val.get(a));
  const picked = [hook];
  let total = hook.end - hook.start;
  // a long event: no more than two lines from any one stretch of a few minutes, so the edit is made of different moments
  // (the event in about twelve parts: the edit is built from several of them, not one stretch)
  const long = (opts.eventSec || 0) >= LONG_EVENT_SEC, win = Math.max(180, (opts.eventSec || 0) / 12);
  const zone = (p) => p.vid + ':' + Math.floor(p.start / win);
  const inZone = new Map([[zone(hook), 1]]);
  for (const p of rest) {
    if (total >= opts.lengthSec) break;
    if (p.score < 0.45) break;      // a weak line is not added just to reach the length
    if (long && (inZone.get(zone(p)) || 0) >= 2) continue;
    picked.push(p); total += p.end - p.start;
    inZone.set(zone(p), (inZone.get(zone(p)) || 0) + 1);
  }
  const body = picked.slice(1).sort((a, b) => a.vid - b.vid || a.start - b.start);
  return { plan: { concept: '', title: '', hook_text: '', post_caption: '', hashtags: [], picks: [hook].concat(body).map((p) => ({ id: p.id })) }, director: 'rules', model: '' };
}

/*
 * ►► SOMEONE IN EVERY SECOND — CHECKED ON THE FINISHED VIDEO. ◄◄ "Ensure there
 * is always someone in the video." Every look before the cut is at the source;
 * this looks at what was actually made, every half second (not on a cut, where
 * a flash or a turn is meant to be brief). A moment where the person detector
 * does not find a person — a title card, an empty stage, a slide — is fixed:
 * a B-roll moment there is taken off; a beat of a line is covered, whole, by
 * a moment of the edit that WAS seen to show someone (the words carry on
 * underneath). Returns the number of fixes (0: nothing to do).
 */
async function someoneEverywhere(ctx, file, shots, log, fix = true) {
  let pd = null;
  try { pd = require('./persondetect'); } catch (e) { pd = null; }
  if (!pd || !pd.available()) return 0;
  const dur = shots.reduce((n, sh) => Math.max(n, (sh.at || 0) + sh.seconds), 0);
  const cuts = shots.map((sh) => sh.at || 0);
  const samples = [];
  for (let t = 0.3; t < dur - 0.15; t += 0.5) if (!cuts.some((c) => Math.abs(c - t) < 0.3)) samples.push(round2(t));
  const good = [], bad = [];
  let failed = 0;
  for (const t of samples) {
    jobs.throwIfCancelled();
    let ppl = null;
    // (a frame that will not read is passed over; the check gives up only if the detector keeps failing)
    try { ppl = await pd.people(ctx.ffmpeg, file, t); } catch (e) { if (++failed > 3) { if (log) log('check: the person detector could not look — ' + ((e && e.message) || e)); return 0; } continue; }
    // anyone found at all (on the tall finished frame the detector is less sure of people than on the wide source:
    // 0.5–0.95 for a speaker on Gospel Jamz; a title card or an empty stage gives nothing)
    (ppl && ppl.some((q) => q.score >= 0.5) ? good : bad).push(t);
    // (no one in most of the first looks: the detector does not see this video's people — stop early)
    if (good.length + bad.length === 10 && bad.length >= 7) break;
  }
  if (!bad.length) { if (log) log(`check: someone is seen in all ${samples.length} looks at the finished video`); return 0; }
  if (!fix) { if (log) log(`check: after the fixes, ${bad.length} of ${good.length + bad.length} looks still found no one clearly`); return 0; }
  if (bad.length > (good.length + bad.length) * 0.4) { if (log) log(`check: ${bad.length} of ${good.length + bad.length} looks found no one — the detector is not trusted on this video; left as made`); return 0; }
  const shotAt = (t) => shots.find((sh) => t >= (sh.at || 0) && t < (sh.at || 0) + sh.seconds);
  const overAt = (sh, t) => (sh.overlays || []).find((o) => t >= (sh.at || 0) + (o.start || 0) && t < (sh.at || 0) + (o.start || 0) + o.len);
  // where the finished video was seen to show someone, back in its own clip (a moment to cover with)
  const seen = [];
  for (const t of good) {
    const sh = shotAt(t);
    if (!sh || overAt(sh, t) || sh.cand.kind !== 'video' || sh.from == null) continue;
    seen.push({ cand: sh.cand, t: sh.from + (t - sh.at), fx: sh.fx, sh });
  }
  let fixed = 0, cm = 0;
  for (const t of bad) {
    const sh = shotAt(t);
    if (!sh) continue;
    const o = overAt(sh, t);
    if (o && !o.cover) { sh.overlays.splice(sh.overlays.indexOf(o), 1); fixed++; continue; }
    if (o && o.cover) continue;   // (already covered on an earlier look)
    const pool = seen.filter((m) => m.sh !== sh);
    const m = pool.length ? pool[cm++ % pool.length] : null;
    if (!m) continue;
    sh.overlays = [{ cand: m.cand, style: 'cutaway', start: 0, len: sh.seconds, pos: 'right', cover: true,
      from: round2(clamp(m.t - sh.seconds / 2, 0, Math.max(0, (m.cand.fileDur || 0) - sh.seconds - 0.05))), fx: m.fx == null ? null : round2(m.fx) }];
    fixed++;
  }
  if (log) log(`check: ${bad.length} of ${samples.length} looks at the finished video found no one clearly — ${fixed} fix(es)`);
  return fixed;
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
const MAX_MOVE_ZOOM = 1.18;   // the tightest zoom move (effectChain hold_tight): the share of the cut it still shows
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
/*
 * A SLIDE OR A DARK STAGE. The person detector sees a face on a "Connect with
 * Bishop…" slide (the speaker's photo on it) and says someone is there; a
 * livestream that cut to a graphic while someone prayed put four seconds of
 * social handles in a montage. A graphic does not move: two small grey frames
 * of the line, near its start and its end, are all but identical. A speaker
 * always moves (the mouth, the hands, the camera's own grain). A stage too dark
 * to see is measured the same way. { still, dark, diff, luma }.
 */
async function stillOrDark(ctx, p) {
  const dur = p.end - p.start;
  if (!(dur > 1.2) || !p.cand || !p.cand.file) return null;
  const grab = async (t) => {
    const buf = await collect(ctx.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', p.cand.file, '-frames:v', '1',
      '-vf', 'scale=96:54,format=gray', '-f', 'rawvideo', '-'], { stdout: true, maxBytes: 1 << 20 });
    return (buf && buf.stdout) || Buffer.alloc(0);
  };
  const a = await grab(p.start + 0.4), b = await grab(p.end - 0.4);
  if (a.length < 96 * 54 || b.length < 96 * 54) return null;
  let diff = 0, luma = 0;
  for (let i = 0; i < 96 * 54; i++) { diff += Math.abs(a[i] - b[i]); luma += (a[i] + b[i]) / 2; }
  diff /= 96 * 54; luma /= 96 * 54;
  // the backs of the audience in front of a lit stage: the bottom third black with silhouettes, the top bright
  // (measured on Gospel Jamz: 87–89% of the bottom third near black under a top of 111; a speaker's shot 9–33%)
  const backs = (f) => {
    let black = 0, top = 0;
    for (let i = 36 * 96; i < 54 * 96; i++) if (f[i] < 25) black++;
    for (let i = 0; i < 18 * 96; i++) top += f[i];
    // (or people standing in front of a projected slide, the slide blazing white above them: 226–233 there, a panel 173)
    return (black / (18 * 96) >= 0.6 && top / (18 * 96) >= 60) || (black / (18 * 96) >= 0.25 && top / (18 * 96) >= 200);
  };
  // a video shown INSIDE the stream — in a box on a slide, or a phone video with black bars either side: columns black
  // right through the middle of the picture (measured on Gospel Jamz: 20–64 such columns of 96 there, 0 on a live shot;
  // a dark stage can have a few, so a bright top or bars wider than half the picture are asked for too)
  // (a box has the slide's bright border above it and either side of it — a black stripe from the top, or one at the
  //  edge of the picture, a pole or a curtain, is not one)
  const framed = (f) => {
    const black = [];
    for (let x = 0; x < 96; x++) {
      let k = 0; for (let y = 14; y < 41; y++) if (f[y * 96 + x] < 22) k++;
      let top = 0; for (let y = 0; y < 5; y++) top += f[y * 96 + x];
      black.push(k >= 0.9 * 27 ? (top / 5 >= 90 ? 2 : 1) : 0);
    }
    let boxed = 0;
    for (let x = 0; x < 96;) {
      if (black[x] !== 2) { x++; continue; }
      let e = x; while (e < 96 && black[e] === 2) e++;
      if (x > 2 && e < 94 && e - x >= 4) boxed += e - x;
      x = e;
    }
    // (a phone video between black bars has a picture between them: a black frame, a cut to black, is not one)
    const n = black.filter(Boolean).length;
    let mid = 0, m = 0;
    for (let x = 0; x < 96; x++) if (!black[x]) for (let y = 14; y < 41; y++) { mid += f[y * 96 + x]; m++; }
    return boxed >= 8 || (n >= 50 && m > 0 && mid / m >= 50);
  };
  // (measured on Gospel Jamz: a slide 0.0–0.1, a speaker sitting still 1.1+; a dark stage 38, a lit one 55+)
  return { still: diff < 0.5, dark: luma < 45, crowd: backs(a) || backs(b), framed: framed(a) || framed(b), diff: round2(diff), luma: round2(luma) };
}

async function lookAt(ctx, reqs, tmp, log, { people = true, max = Infinity, frame = null } = {}) {
  const out = reqs.map(() => ({ fx: null, people: null }));
  let see = null;
  try { see = require('./cloudsee'); } catch (e) { see = null; }
  let font = null;
  const tff = await textFfmpeg(ctx);
  try { const f = path.join(require('./captioner').fontsDir(), 'Poppins-Bold.ttf'); if (fs.existsSync(f) && tff) font = f; } catch (e) {}
  if (!reqs.length) return out;
  if (!see || !see.ready() || !font) {
    if (log) log('look: ' + (!see || !see.ready() ? 'no AI to ask' : 'no ffmpeg here can draw the column numbers') + (people ? ' — the person detector alone' : ' — the middle of the picture'));
    if (people) await detectorLook(ctx, reqs.slice(0, max), out, frame, log);
    return out;
  }
  const ctx0 = ctx;
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
      if (typeof a.facing === 'boolean') out[r.i].facing = a.facing;
      if (a.giving) out[r.i].giving = true;
      if (a.screen) out[r.i].screen = true;
      if (a.away) out[r.i].away = true;
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
  if (people) await detectorLook(ctx0, todo, out, frame, log);
  return out;
}

/*
 * ►► THE DETECTOR HAS THE LAST WORD ON WHERE A PERSON IS. ◄◄ "Still out of
 * frame" — the AI's look at the grid put the cut on a poster with a mask drawn
 * on it, beside the singer. persondetect.js finds real people (a face and
 * shoulders, not a picture of one): where it finds someone, the cut is placed
 * on them — the one nearest where the AI looked, else the clearest — holding
 * the head and both shoulders. Where it finds nobody it says nothing: it can
 * miss someone small and far off, so "nobody here" is only ever the AI's call.
 */
async function detectorLook(ctx, reqs, out, frame, log) {
  let pd = null;
  try { pd = require('./persondetect'); } catch (e) { pd = null; }
  if (!pd || !pd.available()) { if (log) log('look: ' + (pd ? pd.why() : 'no person detector') + ' — the AI\'s look stands'); return; }
  let found = 0;
  for (const r of reqs) {
    jobs.throwIfCancelled();
    let ppl = null;
    try { ppl = await pd.people(ctx.ffmpeg, r.file, r.t); } catch (e) { if (log) log('look: the person detector could not look — ' + ((e && e.message) || e)); break; }
    if (!ppl || !ppl.length) continue;
    found++;
    const o = out[r.i != null ? r.i : reqs.indexOf(r)];
    const ai = o.head != null ? o.head : null;
    // the one to keep: nearest where the AI looked (it saw who is singing); else the clearest and biggest
    // a printed face — a giant poster of the speaker stood beside them — is found faintly, its body the whole picture
    // wide (0.55–0.67 on Gospel Jamz; the speaker beside it 0.94): passed over, wherever the AI looked, while anyone else is found
    const printed = (q) => q.body && q.body.x1 - q.body.x0 >= 0.85 && q.score < 0.8;
    const real = ppl.filter((q) => !printed(q)), cands = real.length ? real : ppl;
    const pick = ai != null
      ? cands.reduce((a, b) => (Math.abs(b.face.x - ai) < Math.abs(a.face.x - ai) ? b : a))
      // (the surest find, not the biggest: a singer stood beside a giant poster of her own face, and the crop took the poster)
      : cands.reduce((a, b) => (b.score > a.score + 0.05 || (Math.abs(b.score - a.score) <= 0.05 && b.face.w > a.face.w) ? b : a));
    const head = clamp(pick.face.x, 0, 1);
    o.head = head; o.fx = head; o.seen = 'detector';
    o.people = Math.max(o.people || 0, ppl.length);
    // a poor sighting: only the backs of heads in the audience, or a speaker hidden behind them
    // (a faint find low in the picture; a speaker on a stage is found clearly, in the upper half)
    o.weak = !ppl.some((q) => q.score >= 0.88 || q.face.y <= 0.4);
    // the head and both shoulders: about a face's width and a bit either side of the face
    const L = clamp(head - pick.face.w * 1.25, 0, 1), R = clamp(head + pick.face.w * 1.25, 0, 1);
    o.span = [L, R];
    const win = frame && r.w && r.h ? Math.min(1, (r.h * frame.W / frame.H) / r.w) / (frame.zoom || MAX_MOVE_ZOOM) : null;
    if (win && win < 1 && R - L <= win * 0.92) o.fx = clamp(clamp(head - win / 2, R - win * 0.96, L - win * 0.04) + win / 2, 0, 1);
  }
  if (log) log(`look: the person detector found people in ${found} of ${reqs.length} moments`);
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
  // the big editor (Claude, or a model on AssemblyAI's gateway) wrote the post with the edit: it stands
  if (realOne && (opts.directorBy === 'claude' || opts.directorBy === 'assemblyai')) return { caption: directors, hashtags: tags(P.hashtags) };
  try {
    const cw = require('./cloudwrite');
    let ai = null; try { ai = require('./aaillm'); } catch (e) { ai = null; }
    const viaAai = !!(ai && ai.ready());
    if (viaAai || (cw.access && cw.access().key)) {
      const prompt = `The words spoken in the video, in order:\n${said.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
        + (hook ? `\n\nOn-screen headline: ${hook}` : '')
        + (a.speaker ? `\nSpeaker: ${a.speaker}` : '') + (a.church ? `\nChurch: ${a.church}` : '') + (a.occasion ? `\nOccasion: ${a.occasion}` : '')
        + (a.cta ? `\nCall to action to end with: ${a.cta}` : '')
        + (opts.brief ? `\nThe church's own notes (background only — do not copy them): ${cleanBrief(opts.brief)}` : '')
        + `\nStyle of the video: ${opts.style}.`;
      // the post too: AssemblyAI's model when it is set up (Groq is not used for montages then)
      const text = viaAai ? await ai.chat({ system: POST_SYSTEM, prompt, json: true, maxTokens: 900, temperature: 0.8, timeoutMs: 60000 })
        : await cw.chat({ system: POST_SYSTEM, prompt, json: true, maxTokens: 700, temperature: 0.8, timeoutMs: 45000, evenIfOff: true });
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

/*
 * ►► A FRESH EDIT EACH TIME. ◄◄ "It can't be the same ones again." Which
 * moments each video's Viral Montages used is kept beside the montages
 * (.viral-history.json, by the video's name and size); the next edit of the
 * same video is told which lines were used and asked for different ones, and
 * built round a different key idea of the message.
 */
const historyFile = (output) => path.join(path.dirname(output), '.viral-history.json');
const videoKey = (f) => { try { return path.basename(f) + '|' + fs.statSync(f).size; } catch (e) { return path.basename(f); } };
function loadHistory(output) { try { return JSON.parse(fs.readFileSync(historyFile(output), 'utf8')) || {}; } catch (e) { return {}; } }
/** The spans of this video used by its last three edits. */
function usedSpans(h, file) { return (h[videoKey(file)] || []).slice(-5).flat(); }   // (five takes: each fresh against the four before it)
function saveHistory(output, h0, picks) {
  try {
    // read again now (another montage may have finished while this one was made), and write it whole or not at all
    const h = loadHistory(output);
    const by = new Map();
    for (const p of picks) { const k = videoKey(p.cand.file); if (!by.has(k)) by.set(k, []); by.get(k).push([round2(p.start), round2(p.end)]); }
    for (const [k, spans] of by) h[k] = (h[k] || []).concat([spans]).slice(-6);
    const tmpf = historyFile(output) + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmpf, JSON.stringify(h));
    fs.renameSync(tmpf, historyFile(output));
  } catch (e) { /* only a convenience */ }
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
  const out = beats.map(([a, b], bi) => {
    const first = bi === 0, last = bi === beats.length - 1;
    const from = first ? Math.max(0, ws[a].start - 0.07) : (ws[a - 1].end + ws[a].start) / 2;
    const to = last ? Math.min(fileDur - 0.02, ws[b].end + 0.16) : (ws[b].end + ws[b + 1].start) / 2;
    return { from, to, a, b };
  });
  // a long event's moment is held to about p.padTo seconds: on into the silence after its words, then
  // back into the silence before them — never as far as a word said either side (p.nextStart, p.prevEnd)
  if (p.padTo > 0) {
    const f = out[0], l = out[out.length - 1];
    let short = p.padTo - (l.to - f.from);
    if (short > 0.02) {
      const after = Math.max(0, Math.min(fileDur - 0.02, p.nextStart != null ? p.nextStart - 0.1 : Infinity) - l.to);
      const tail = Math.min(short, after);
      l.to += tail; short -= tail;
      const before = Math.max(0, f.from - (p.prevEnd != null ? p.prevEnd + 0.1 : 0));
      f.from -= Math.min(short, before);
    }
  }
  return out;
}
/** How long a line is on screen: its beats end to end (the hold included). */
const momentSec = (p) => { const b = beatSpans(p); return b[b.length - 1].to - b[0].from; };

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

// the middle of a B-roll clip — of the part of it chosen, when a part was
const brollMid = (c) => ((c.start || 0) + (c.end || c.fileDur || 0)) / 2;
async function makeTalk(ctx, getInfo, { files, parts = null, opts, hear, musicPath, output, onProgress, stage, log, keepAudio }) {
  const say = (a, b) => (p) => onProgress && onProgress(Math.round(a + (b - a) * (clamp(p, 0, 100) / 100)));
  const infos = [];
  for (const f of files) {
    let info = null;
    try { info = await getInfo(ctx, f); } catch (e) { info = null; }
    if (info && info.width && info.height) infos.push({ file: f, info, image: isImage(f) || !(info.durationSec > 0.3) });
  }
  const vids = infos.filter((x) => !x.image);
  if (!vids.length) throw new Error('Add at least one video with someone speaking — a Viral montage is cut from what is said.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-talk-'));
  const history = loadHistory(output);
  try {
    // 1) HEAR
    const cands = [];
    const phrases = [];
    let k = 0;
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      const D = v.info.durationSec;
      // the part the operator chose (the whole video when none): only it is heard, only its lines are used
      const part = parts && parts.get(v.file);
      const A = part ? clamp(part.from, 0, Math.max(0, D - 1)) : 0;
      const B = part ? clamp(part.to, A + 1, D) : D;
      if (part && log) log(`talk: video ${i + 1} — only ${round2(A)}s to ${round2(B)}s`);
      if (stage) stage(vids.length > 1 ? `👂 Listening to video ${i + 1} of ${vids.length}…` : '👂 Listening to every word…');
      let words = [];
      if (v.info.hasAudio && hear) {
        // (nothing from "What's it about?" goes to the ear: the captions are what was said)
        try { words = (await hear(v.file, B, say((i / vids.length) * 40, ((i + 1) / vids.length) * 40), A)) || []; } catch (e) { if (e instanceof jobs.CancelledError || (e && e.cancelled)) throw e; if (log) log('hear failed: ' + e.message); words = []; }
      }
      let loud = [];
      if (v.info.hasAudio) { try { loud = await loudness(ctx, v.file); } catch (e) { if (e instanceof jobs.CancelledError) throw e; } }
      // (a hearing that ignored the part still gives only the part's words)
      if (part) { const hl = words.highlights; words = words.filter((w) => w.start >= A - 0.05 && w.end <= B + 0.05); if (hl) Object.defineProperty(words, 'highlights', { value: hl, enumerable: false }); }
      const c = { id: 'v' + (i + 1), file: v.file, kind: 'video', start: round2(A), end: round2(B), peak: round2((A + B) / 2), whole: true, fileDur: round2(D),
        hasAudio: !!v.info.hasAudio, w: v.info.width, h: v.info.height, name: path.basename(v.file), spoken: words.length >= 4 };
      try { c.thumb = await thumb(ctx, v.file, A + Math.min(1, (B - A) / 3), path.join(tmp, c.id + '.jpg'), false); } catch (e) { c.thumb = null; }
      cands.push(c);
      // short, snappy lines: a phrase ends by about 6 s (it used to run to 9–10)
      const wordAt = new Map(words.map((w, j) => [w, j]));
      for (const p of phrasesOf(words, TALK_LINE_MAX)) {
        if (p.end > B + 0.05 || p.start < A - 0.05) continue;
        // the words said either side of it (a moment held on its speaker stops short of them)
        const j0 = wordAt.get(p.words[0]), j1 = wordAt.get(p.words[p.words.length - 1]);
        const prev = j0 > 0 ? words[j0 - 1] : null, next = j1 != null && j1 < words.length - 1 ? words[j1 + 1] : null;
        p.prevEnd = prev ? prev.end : A; p.nextStart = next ? next.start : B;
        p.id = 'p' + (++k); p.vid = i + 1; p.cand = c; p.score = phraseScore(p, loud);
        // AssemblyAI's key phrases: the line that holds one of the message's most important phrases rises
        p.hl = 0;
        for (const h of (words.highlights || [])) for (const [a, b] of h.at || []) if (a < p.end && b > p.start) p.hl = Math.max(p.hl, h.rank || 0);
        if (p.hl > 0) p.score = round2(p.score + 0.25 * p.hl);
        // used in an earlier Viral Montage of this video: a fresh edit is asked for
        p.usedBefore = usedSpans(history, v.file).some(([a, b]) => a < p.end - 0.2 && b > p.start + 0.2);
        phrases.push(p);
      }
    }
    // the key idea this edit is built round — a different one each time (AssemblyAI's top phrases)
    {
      const keys = [];
      for (const p of phrases) if (p.hl > 0) keys.push([p.hl, p.text]);
      keys.sort((a, b) => b[0] - a[0]);
      const top = keys.slice(0, 8).map((x) => x[1]).filter((t, i, a) => a.indexOf(t) === i);
      if (top.length && !opts.angle) opts.angle = String(top[Math.floor(Math.random() * top.length)]).slice(0, 140);
    }
    if (phrases.length < 2) {
      const e = new Error('No one could be heard speaking in these videos. A Viral montage is cut from what is said — choose “Standard” for clips without speech.');
      e.noSpeech = true;
      throw e;
    }
    // the photos and silent clips become B-roll over the speaker
    const broll = infos.filter((x) => x.image).map((x, j) => ({ id: 'i' + (j + 1), file: x.file, kind: 'image', w: x.info.width, h: x.info.height, fileDur: 0, peak: 0, name: path.basename(x.file) }))
      .concat(cands.filter((c) => !c.spoken));
    for (const b of broll) { if (b.kind === 'image' && !b.thumb) { try { b.thumb = await thumb(ctx, b.file, 0, path.join(tmp, b.id + '.jpg'), true); } catch (e) { b.thumb = null; } } }
    if (onProgress) onProgress(42);
    // 2) CHOOSE
    // (crowd work from the stage never reaches the editor — an AI picked "Where is everybody?" as the hook)
    const calmLines = goodLines(phrases).filter((p) => !CROWD.test(p.text) && !HOUSEKEEPING.test(p.text));
    const list = spreadList(calmLines.length >= 12 ? calmLines : goodLines(phrases), 420);
    // how long the heard event is (a whole service asks for moments from across it)
    opts.eventSec = cands.reduce((n, c) => n + Math.max(0, (c.end || 0) - (c.start || 0)), 0);
    if (stage) stage(process.env.ANTHROPIC_API_KEY ? '🎬 Claude is picking the lines that will stop the scroll…' : '🎬 The AI is picking the lines that will stop the scroll…');
    let d = null;
    try { d = await talkWithClaude(list, opts); } catch (e) { if (log) log('claude: ' + e.message); }
    if (!d) { try { d = await talkWithAai(list, opts); } catch (e) { if (log) log('assemblyai: ' + e.message); } }
    // (AssemblyAI first; Groq only when AssemblyAI's models could not answer — an account without the LLM Gateway —
    //  as an AI's judgement still beats the rules)
    if (!d) { try { d = await talkWithGroq(list, opts); } catch (e) { if (log) log('groq: ' + e.message); } }
    if (!d) d = talkByRules(list, opts);
    if (log) log(`talk: lines chosen by ${d.director}${d.model ? ' (' + d.model + ')' : ''}`);
    opts.directorBy = d.director;
    const byId = new Map(phrases.map((p) => [p.id, p]));
    let picks = [];
    for (const x of (d.plan.picks || [])) { const p = byId.get(String(x && x.id || '').trim()); if (p && !picks.includes(p)) picks.push(p); }
    // what the editor chose is held to the rules it was given: no crowd work, no housekeeping, a whole thought
    // (a line it should not have taken is dropped, and the whole-event step below fills its place)
    { const ok = picks.filter((p) => !CROWD.test(p.text) && !HOUSEKEEPING.test(p.text) && ((opts.eventSec || 0) < LONG_EVENT_SEC || (wholeThought(p) && !asks(p)))); if (ok.length && ok.length < picks.length) { if (log) log(`talk: ${picks.length - ok.length} line(s) the editor chose broke its brief and were left out`); picks = ok; } }
    if (picks.length < 1) picks = talkByRules(list, opts).plan.picks.map((x) => byId.get(x.id)).filter(Boolean);
    // a long event: no moment runs on (whatever the editor chose). A short clip is one stretch by nature, and keeps it.
    const longEvent = (opts.eventSec || 0) >= LONG_EVENT_SEC;
    if (longEvent) {
      const before = picks.length;
      picks = acrossEvent(shortMoments(picks), list, opts);
      if (log) log(`talk: the whole event — one short line from each of ${partsFor(opts)} parts (${before} chosen → ${picks.length})`);
    }
    // a second read, part by part: only lines the AI keeps are used (here and as replacements)
    let approved = null;
    if (longEvent && d.director !== 'rules') {
      if (stage) stage('🎬 Reading every part of the event again for its strongest line…');
      try { const v = await vetParts(picks, list, opts, log); if (v) { picks = v.picks; approved = v.approved; } } catch (e) { if (e instanceof jobs.CancelledError) throw e; if (log) log('vet: ' + e.message); }
    }
    // (a line brought in later — someone not seen, the length not met — comes from a part of the event the edit has not got yet)
    const ev = longEvent ? eventParts(list.concat(picks), opts) : null;
    const newPart = (p, but) => !ev || !picks.some((q) => q !== but && ev.part(q) === ev.part(p));
    const fitsEvent = (p) => !ev || (!asks(p) && (approved ? approved.has(p) : (p.end - p.start <= MOMENT_LINE_MAX && p.end - p.start >= MOMENT_LINE_MIN && !CROWD.test(p.text) && lineVal(p) >= 0.4)));
    // the length asked for, give or take a line (the hook always stays)
    let total = picks.reduce((n, p) => n + (p.end - p.start), 0);
    // (a long event drops its weakest line, not its latest: every part of the event keeps its place if it can)
    const cutAt = () => { if (!longEvent) return picks.length - 2; let w = 1; for (let i = 1; i < picks.length - 1; i++) if (picks[i].score < picks[w].score) w = i; return w; };
    while (picks.length > 2 && total - (picks[cutAt()].end - picks[cutAt()].start) >= opts.lengthSec * 1.15) {
      const cut = picks.splice(cutAt(), 1)[0];   // the last line is the payoff: take the one before it
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
      got.forEach((g, i) => who[i].looks.push({ t: reqs[i].t, fx: g.fx, people: g.people, weak: !!g.weak || g.facing === false || !!g.screen || !!g.away, giving: !!g.giving }));
      // a slide or a dark stage is not a moment, even with a face in it (a speaker's photo on a "connect with" slide)
      for (const p of ps) { if (!p.vis) { try { p.vis = await stillOrDark(ctx, p); } catch (e) { if (e instanceof jobs.CancelledError) throw e; p.vis = null; } } }
    };
    // a line where HALF or more of its looks show nobody is not used; one with only a moment of nobody
    // (a cut to the screen mid-sentence) is kept, and that beat is covered with a moment that shows someone
    // (a still moment is a slide only where the video around it moves: a sermon heard over one still picture is all still,
    //  and then stillness says nothing)
    const stillVideo = () => { const v = picks.filter((p) => p.vis); return v.length >= 2 && v.filter((p) => p.vis.still).length >= v.length * 0.6; };
    const nobody = (p) => !!(p.looks && p.looks.some((l) => l.giving)) || !!(p.vis && ((p.vis.still && !stillVideo()) || p.vis.dark || p.vis.crowd || p.vis.framed)) || !!(p.looks && p.looks.length && p.looks.filter((l) => l.people === 0 || l.weak).length * 2 >= p.looks.length);
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
        // (lines no earlier take used come first: a replacement must not bring the last take back)
        const pool = list.filter((p) => !tried.has(p) && p.end - p.start >= (picks.length ? 1.4 : 0.8) && fitsEvent(p) && newPart(p)).sort((a, b) => (a.usedBefore - b.usedBefore) || (b.score - a.score));
        let added = 0;
        for (let round = 0; round < (ev ? 6 : 3) && tot < opts.lengthSec * 0.9 && pool.length; round++) {
          const batch = pool.splice(0, 6);
          await lookLines(batch);
          for (const p of batch) {
            if (nobody(p)) rejected.add(p);
            if (tot >= opts.lengthSec * 0.9) break;
            if (nobody(p) || !p.looks.some((l) => l.people > 0) || !newPart(p)) continue;
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
    /*
     * ►► THE LENGTH ASKED FOR, EXACTLY. ◄◄ "If I select 30 seconds it must be
     * perfect." The narrator's real length is known now; the lines are fitted
     * to what is left — whole lines only (a sentence is never cut): too long,
     * the weakest middle line goes (never the hook or the payoff); too short,
     * the strongest unused lines that show someone are added before the payoff.
     */
    {
      const secOf = new Map(), lenOf = (p) => { if (!secOf.has(p)) secOf.set(p, momentSec(p)); return secOf.get(p); };   // (on screen, the hold included; asked thousands of times by the fit)
      const sum = (ps) => ps.reduce((n, p) => n + lenOf(p), 0);
      /*
       * 1) THE BEST FIT OF WHAT IS THERE: the narrator in full, its opening line only, or none — each against
       *    every set of the edit's lines to leave out (the hook always stays; the last line left is the payoff).
       *    The one that lands nearest the length wins; the narrator is kept whenever it fits as well, and
       *    fewer lines are left out among equally good fits.
       */
      const introLen = vo.intro ? vo.intro.len + 0.25 : 0, outroLen = vo.outro ? vo.outro.len + 0.6 : 0;
      const configs = [{ intro: !!vo.intro, outro: !!vo.outro }];
      if (vo.outro) configs.push({ intro: !!vo.intro, outro: false });
      if (vo.intro || vo.outro) configs.push({ intro: false, outro: false });
      const rest = picks.slice(1);
      let best = null;
      for (const cf of configs) {
        const w = Math.max(3, opts.lengthSec - (cf.intro ? introLen : 0) - (cf.outro ? outroLen : 0));
        const n = rest.length;
        const masks = n <= 14 ? (1 << n) : 1;
        for (let m = 0; m < masks; m++) {
          let t = lenOf(picks[0]), cost = 0, out = 0;
          for (let i = 0; i < n; i++) { if (m & (1 << i)) { cost += rest[i].score; out++; } else t += lenOf(rest[i]); }
          const miss = Math.abs(t - w);
          const narr = (cf.intro ? 1 : 0) + (cf.outro ? 1 : 0);
          const better = !best || miss < best.miss - 0.3 || (Math.abs(miss - best.miss) <= 0.3 && (narr > best.narr || (narr === best.narr && (out < best.out || (out === best.out && cost < best.cost)))));
          if (better) best = { cf, m, miss, cost, out, narr, w };
        }
      }
      if (best) {
        if (!best.cf.outro && vo.outro) { vo.outro = null; if (log) log('length: the narrator\'s closing line left out, to keep to the length'); }
        if (!best.cf.intro && vo.intro) { vo.intro = null; if (log) log('length: the narrator\'s opening line left out, to keep to the length'); }
        if (rest.length <= 14) { const drop = new Set(rest.filter((_, i) => best.m & (1 << i))); picks = picks.filter((p) => !drop.has(p)); }
      }
      const voLen = (vo.intro ? introLen : 0) + (vo.outro ? outroLen : 0);
      const want = Math.max(3, opts.lengthSec - voLen);
      const ok = (t) => t >= want - 1 && t <= want + 1;
      let tot = sum(picks);
      // (a long list: the greedy way)
      while (tot > want + 1 && picks.length > 2) {
        const m2 = picks.slice(1, -1).map((p) => ({ p, miss: Math.abs(tot - lenOf(p) - want) })).sort((x, y) => x.miss - y.miss)[0];
        if (!m2 || m2.miss >= Math.abs(tot - want)) break;
        picks.splice(picks.indexOf(m2.p), 1); tot = sum(picks);
      }
      const inEdit = () => new Set(picks);
      const pool = list.filter((p) => !inEdit().has(p) && !rejected.has(p) && p.end - p.start >= 1.2 && !HOUSEKEEPING.test(p.text) && !(p.text.match(FILLER_ANY) || []).length && fitsEvent(p))
        .sort((x, y) => (x.usedBefore - y.usedBefore) || (y.score - x.score));
      const showsSomeone = async (cands) => {
        const need = cands.filter((p) => !p.looks);
        if (seen && need.length) await lookLines(need);
        return cands.filter((p) => !seen || (!nobody(p) && (p.looks || []).some((l) => l.people > 0)));
      };
      // 2) too short: the strongest unused lines that show someone, before the payoff
      //    (a long event: the lines the AI kept, in parts not yet in the edit; then any good line there; then a
      //     second line from a part — the length asked for is met, "30 seconds" is 30 seconds)
      const fill = async (from, onePart) => {
        for (let round = 0; round < (ev ? 6 : 3) && tot < want - 1 && from.length; round++) {
          const batch = from.filter((p) => lenOf(p) <= want + 1 - tot + 0.3).slice(0, 6);
          if (!batch.length) break;
          batch.forEach((p) => { from.splice(from.indexOf(p), 1); if (pool.includes(p)) pool.splice(pool.indexOf(p), 1); });
          for (const p of await showsSomeone(batch)) {
            if (tot >= want - 1) break;
            if (lenOf(p) > want + 1 - tot + 0.3 || (onePart && !newPart(p))) continue;
            if (picks.length < 2) picks.push(p); else picks.splice(picks.length - 1, 0, p);
            tot += lenOf(p);
          }
          batch.forEach((p) => { if (!picks.includes(p)) rejected.add(p); });
        }
      };
      await fill(pool, true);
      if (ev && tot < want - 1) {
        const good = (p) => !inEdit().has(p) && !rejected.has(p) && p.end - p.start >= MOMENT_LINE_MIN && p.end - p.start <= MOMENT_LINE_MAX + 0.3
          && !CROWD.test(p.text) && !HOUSEKEEPING.test(p.text) && !(p.text.match(FILLER_ANY) || []).length && wholeThought(p) && !asks(p);
        const loose = () => list.filter(good).sort((x, y) => (x.usedBefore - y.usedBefore) || (lineVal(y) - lineVal(x)));
        const before = tot;
        await fill(loose().filter((p) => newPart(p)), true);
        if (tot < want - 1) await fill(loose(), false);
        if (log && tot > before) log(`length: ${(tot - before).toFixed(1)} s more from good lines beyond the ones the AI kept`);
      }
      // 3) still off: swap a line (any — the hook and payoff too, when needed) for an unused one that shows
      //    someone and lands nearer; up to three swaps
      for (let k = 0; k < 3 && !ok(tot) && pool.length; k++) {
        const opts2 = [];
        for (const p of picks) for (const q of pool) {
          const t2 = tot - lenOf(p) + lenOf(q);
          if (Math.abs(t2 - want) < Math.abs(tot - want) - 0.3 && newPart(q, p)) opts2.push({ p, q, miss: Math.abs(t2 - want), keep: (p === picks[0] || p === picks[picks.length - 1]) ? 1 : 0 });
        }
        opts2.sort((x, y) => (x.miss - y.miss) || (x.keep - y.keep) || (y.q.score - x.q.score));
        const tryQ = [...new Set(opts2.slice(0, 12).map((x) => x.q))].slice(0, 6);
        if (!tryQ.length) break;
        const good = new Set(await showsSomeone(tryQ));
        tryQ.forEach((q) => { if (!good.has(q)) { rejected.add(q); pool.splice(pool.indexOf(q), 1); } });
        const pick = opts2.find((x) => good.has(x.q));
        if (!pick) continue;
        picks[picks.indexOf(pick.p)] = pick.q;
        pool.splice(pool.indexOf(pick.q), 1);
        tot = sum(picks);
      }
      if (ev) picks = eventOrder(picks, ev);
      if (log) log(`length: ${tot.toFixed(1)} s of lines${voLen ? ` + ${voLen.toFixed(1)} s narrator` : ''} for ${opts.lengthSec} s asked`);
    }
    // moments the edit did not use, from every speaking video — B-roll for the narrator and between lines
    // (never a line already seen to show nobody)
    const spare = phrases.filter((p) => !picks.includes(p) && !rejected.has(p) && p.end - p.start >= 1.4).sort((a, b) => b.score - a.score);
    // the B-roll moments too: only ones where someone can be seen (looked at where the snapshot freezes)
    const snapAt = (sp) => round2(clamp(sp.start + Math.min(1.2, (sp.end - sp.start) / 2), 0, Math.max(0, sp.cand.fileDur - 0.1)));
    // the silent clips too (they fill the narrator's stretches and cutaways): looked at where they play, the middle
    const silent = broll.filter((b) => b.kind === 'video');
    if (seen && silent.length) {
      const got = await lookAt(ctx, silent.map((b) => ({ file: b.file, t: round2(Math.max(0, brollMid(b))), w: b.w, h: b.h })), tmp, log, { people: true, frame: ASPECTS[opts.aspect] ? { W: ASPECTS[opts.aspect].w, H: ASPECTS[opts.aspect].h } : { W: 1080, H: 1920 } });
      const out = silent.filter((b, i) => got[i] && got[i].people === 0);
      if (out.length) {
        for (const b of out) broll.splice(broll.indexOf(b), 1);
        if (log) log(`people: ${out.length} silent clip(s) showed nobody and are not used`);
      }
    }
    // spare moments are only used when there are not enough photos and silent clips for every slot
    const slotsFor = Math.max(0, Math.ceil(picks.reduce((n, p) => n + (p.end - p.start), 0) / 5.2) - broll.length) + (opts.voice && !broll.length ? 6 : 0);
    /*
     * A long event: the B-roll is the REST of the event — a moment from every
     * part of it (the worship, the dance, another speaker), so 30 seconds show
     * the whole night. Each is looked at first and kept only where a face can
     * be seen in a lit, moving picture: never a slide, a dark stage or the
     * backs of the audience (they looked random before they were checked).
     */
    const longEv = (opts.eventSec || 0) >= LONG_EVENT_SEC;
    if (longEv) {
      const parts = partsFor(opts) * 2, far = (p) => !picks.some((q) => q.vid === p.vid && Math.abs(q.start - p.start) < 30);
      const span = Math.max(1, ...phrases.map((p) => p.end)), across = [];
      for (let k = 0; k < parts; k++) {
        const best = spare.filter((p) => far(p) && p.start >= k * span / parts && p.start < (k + 1) * span / parts)[0];   // (spare is in score order)
        if (best) across.push(best);
      }
      spare.length = 0; spare.push(...across);
    }
    if (seen && spare.length && (slotsFor > 0 || longEv)) {
      const top = longEv ? spare.slice() : spare.slice(0, Math.min(24, slotsFor + 4));
      const got = await lookAt(ctx, top.map((sp) => ({ file: sp.cand.file, t: snapAt(sp), w: sp.cand.w, h: sp.cand.h })), tmp, log, { people: true, frame: ASPECTS[opts.aspect] ? { W: ASPECTS[opts.aspect].w, H: ASPECTS[opts.aspect].h } : { W: 1080, H: 1920 } });
      top.forEach((sp, i) => { sp.snapLook = got[i]; });
      if (longEv) for (const sp of top) { if (!(sp.snapLook && sp.snapLook.people > 0) || sp.snapLook.weak || sp.snapLook.facing === false) continue; try { sp.vis = sp.vis || await stillOrDark(ctx, sp); } catch (e) { if (e instanceof jobs.CancelledError) throw e; } }
      const good = top.filter((sp) => longEv
        ? !!(sp.snapLook && sp.snapLook.people > 0 && !sp.snapLook.weak && sp.snapLook.facing !== false && !sp.snapLook.giving && !sp.snapLook.screen && !sp.snapLook.away && sp.vis && !sp.vis.still && !sp.vis.dark && !sp.vis.crowd && !sp.vis.framed)
        : !(sp.snapLook && (sp.snapLook.people === 0 || sp.snapLook.giving)));
      // (the few used are spread over the WHOLE event — not the first hour's — and play in the order they happened)
      if (longEv) {
        good.sort((a, b) => a.vid - b.vid || a.start - b.start);
        const k = Math.min(good.length, Math.max(2, picks.length + 1));
        const even = k < 2 ? good.slice() : Array.from({ length: k }, (_, j) => good[Math.round(j * (good.length - 1) / (k - 1))]);
        const restOf = good.filter((p) => !even.includes(p));
        good.length = 0; good.push(...new Set(even), ...restOf);
      }
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
          sh = { cand: br, seconds: len, from: br.kind === 'video' ? round2(clamp(brollMid(br) - len / 2 + n * 1.7, br.start || 0, Math.max(br.start || 0, (br.end || br.fileDur) - len - 0.05))) : null,
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
        // (a long event: a clean cut between lines — a white flash is a frame with no one in it)
        const transition = first && hypeish && (opts.eventSec || 0) < LONG_EVENT_SEC && ((pi === 0 && vo.intro) || pi % 2 === 1) ? 'flash' : 'cut';
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
    /*
     * A LONG EVENT: A NEW PICTURE EVERY BEAT (about MOMENT_EACH seconds). Each line opens on its speaker; every
     * beat after that is covered whole by a moment from another part of the night — checked to show a face, lit,
     * moving, not a slide, a screen or the backs of the audience — while the voice carries on. Each moment is used
     * once; when they run out, the speaker is seen.
     */
    if (longEv) {
      // (and it must LOOK new: a cut from the panel to the same panel half an hour later is no cut at all — a tiny
      //  grey picture of each is compared: the same scene 2–7 apart on Gospel Jamz, a different one 28–81)
      const sigs = new Map();
      const sigAt = async (file, t) => {
        const k = file + '@' + round2(t);
        if (!sigs.has(k)) {
          let b = null;
          try { const r = await collect(ctx.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', 'scale=24:14,format=gray', '-f', 'rawvideo', '-'], { stdout: true, maxBytes: 1 << 16 }); b = r && r.stdout && r.stdout.length >= 336 ? r.stdout : null; } catch (e) { if (e instanceof jobs.CancelledError) throw e; }
          sigs.set(k, b);
        }
        return sigs.get(k);
      };
      const apart = (a, b) => { if (!a || !b) return 99; let d = 0; for (let j = 0; j < 336; j++) d += Math.abs(a[j] - b[j]); return d / 336; };
      const used = new Set(), seenSigs = [];
      for (let i = speechFrom + 1; i < speechTo; i++) {
        const sh = shots[i];
        if (sh.line == null || shots[i - 1].line !== sh.line || sh.cover || sh.seconds < 1 || (sh.overlays || []).length) continue;
        const under = sh.cand && sh.cand.kind === 'video' && sh.from != null ? await sigAt(sh.cand.file, sh.from + sh.seconds / 2) : null;
        let sp = null, spSig = null;
        for (const x of spare) {
          if (used.has(x) || picks.some((q) => q.vid === x.vid && Math.abs(q.start - x.start) < 30)) continue;
          const xs = await sigAt(x.cand.file, snapAt(x));
          if (seenSigs.some((g) => apart(xs, g) < 15)) { used.add(x); continue; }   // (a scene already cut to)
          if (apart(xs, under) < 15) continue;                                         // (the scene already on screen)
          sp = x; spSig = xs; break;
        }
        if (!sp) break;
        used.add(sp); if (spSig) seenSigs.push(spSig);
        const len = round2(sh.seconds);
        const ov = { cand: sp.cand, style: 'cutaway', start: 0, len, pos: 'right', from: round2(clamp(snapAt(sp) - len / 2, 0, Math.max(0, sp.cand.fileDur - len - 0.05))) };
        if (sp.snapLook && sp.snapLook.fx != null) ov.fx = round2(sp.snapLook.fx);
        sh.overlays.push(ov);
      }
    }
    for (let i = speechFrom + 1; i < speechTo && !longEv; i += 2) {
      const sh = shots[i];
      if (sh.seconds < 2 || sh.cover) continue;
      const len = round2(Math.min(broll.length ? 2.2 : 1.6, sh.seconds - 0.5));
      if (broll.length && bi < broll.length) {
        const o = broll[bi++];
        sh.overlays.push({ cand: o, style: 'cutaway', start: 0.25, len, pos: i % 4 === 1 ? 'right' : 'left', from: o.kind === 'video' ? round2(clamp(brollMid(o) - len / 2, o.start || 0, Math.max(o.start || 0, (o.end || o.fileDur) - len - 0.05))) : null });
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
        const snap = !longEv && sb++ % 3 !== 2;   // (a long event: cutaways that play, no camera-flash stills)
        const ol = snap ? round2(Math.min(1.5, sh.seconds - 0.5)) : len;
        const at0 = snap ? sp.start + Math.min(1.2, (sp.end - sp.start) / 2) : longEv ? snapAt(sp) - ol / 2 : sp.start + 0.2;   // (round the frame that was checked)
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
    await render(ctx, plan, { aspect: opts.aspect, keepAudio: true, output, base: baseOf(output), tmp, onProgress: say(50, 90) });
    // someone in every second: the finished video is looked at, and cut again once where it showed no one
    if (stage) stage('👀 Checking someone is seen in every second…');
    let fixes = 0;
    try { fixes = await someoneEverywhere(ctx, output, shots, log); } catch (e) { if (e instanceof jobs.CancelledError) throw e; if (log) log('check: ' + e.message); }
    if (fixes) {
      if (stage) stage('✂️ Cutting again, with someone in every second…');
      await render(ctx, plan, { aspect: opts.aspect, keepAudio: true, output, base: baseOf(output), tmp, onProgress: say(90, 97) });
      try { await someoneEverywhere(ctx, output, shots, log, false); } catch (e) { if (e instanceof jobs.CancelledError) throw e; }
    }
    const voices = [vo.intro, vo.outro].filter(Boolean);
    if (voices.length) {
      if (stage) stage('🎙 Laying the narrator on…');
      for (const f of [output, baseOf(output)]) if (fs.existsSync(f)) await laySpeech(ctx, f, voices, tmp);
    }
    saveHistory(output, history, picks);   // the next edit of this video is asked for different lines
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
async function make(ctx, getInfo, { mediaPaths, ranges, musicPath, style, lengthSec, full, aspect, brief, about, keepAudio, keepOrder, output, onProgress, stage, log, mode, hear, voice, angle }) {
  const files = (mediaPaths || []).filter((p) => p && fs.existsSync(p)).slice(0, 60);
  // the part of each video to use ("from which part to which part"), by file
  const partOf = new Map();
  (mediaPaths || []).forEach((p, i) => { const r = Array.isArray(ranges) ? ranges[i] : null; if (p && r && (r.from > 0 || r.to > 0)) partOf.set(p, { from: Math.max(0, +r.from || 0), to: +r.to > 0 ? +r.to : Infinity }); });
  if (!files.length) throw new Error('Add some videos or pictures first.');
  if (mode === 'talk') {
    const topts = {
      voice: voice || null,
      style: STYLES[style] ? style : 'hype',
      lengthSec: clamp(Number(lengthSec) || 45, 10, 600),
      aspect: ASPECTS[aspect] ? aspect : '9:16',
      brief: cleanBrief(brief),
      about: cleanAbout(about),
      // a take of several: the idea this one is built around (the others' lines are already marked "used before")
      angle: typeof angle === 'string' && angle.trim() ? angle.trim().slice(0, 200) : undefined,
    };
    return makeTalk(ctx, getInfo, { files, parts: partOf, opts: topts, hear, musicPath, output, onProgress, stage, log, keepAudio });
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
  try {
    if (require('./aaillm').ready()) { let vision = false; try { const cw = require('./cloudwrite'); vision = !!(cw.access && cw.access().key); } catch (e) {} return { director: 'assemblyai', model: '', vision, last: require('./aaillm').state().last, tries: require('./aaillm').state().tries }; }
  } catch (e) {}
  try { const cw = require('./cloudwrite'); if (cw.access && cw.access().key) return { director: 'groq', model: '', vision: true }; } catch (e) {}
  return { director: 'rules', model: '' };
}

module.exports = {
  stillOrDark, goodLines, wholeThought, sameLine, talkBrief, vetParts, eventParts, acrossEvent, beatSpans, momentSec, partsFor, MOMENT_EACH,
  spreadList, momentsOf, shortMoments, HOUSEKEEPING, cleanAbout, withAbout, aboutLines, phrasesOf, phraseScore, talkByRules, fromBrief, cleanBrief, make, remake, loadProject, sidecarOf, baseOf, analyze, beats, finalise, directByRules, directorStatus, PLAN_SCHEMA, ASPECTS, STYLES, EFFECTS, TRANSITIONS, OVERLAY_STYLES, _direct: direct };
