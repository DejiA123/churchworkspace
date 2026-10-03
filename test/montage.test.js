'use strict';
/*
 * AI Montage (src/main/montage.js): the beat finder, the plan checker, what is
 * asked of Claude (with the SDK stood in for, so no key and no network), and a
 * real montage rendered end to end on a 512 MB setting.
 *
 *   npm run test:montage
 */
process.env.MW_MEMORY_MB = '512';
delete process.env.ANTHROPIC_API_KEY;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ff = require(path.join(ROOT, 'src/main/ffmpeg'));
const video = require(path.join(ROOT, 'src/main/video'));
const montage = require(path.join(ROOT, 'src/main/montage'));
const ffmpeg = ff.resolveFfmpeg();
const ctx = { ffmpeg, ffprobe: ff.resolveFfprobe() };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-montage-test-'));

let failed = false;
const log = (ok, name, detail) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
};
const make = (args, out) => { execFileSync(ffmpeg, ['-v', 'error', '-y', ...args, out]); return out; };

(async () => {
  console.log('\nTHE BEAT');
  for (const bpm of [95, 128, 150]) {
    const p = 60 / bpm;
    const song = make(['-f', 'lavfi', '-i', `aevalsrc='0.7*sin(2*PI*55*t)*exp(-20*mod(t,${p}))+0.1*sin(2*PI*660*t)*exp(-30*mod(t+${p / 2},${p}))':s=44100:d=30`], path.join(WORK, `s${bpm}.wav`));
    const b = await montage.beats(ctx, song);
    const off = Math.min(...b.beats.slice(0, 6).map((t) => { const r = t % p; return Math.min(r, p - r); }));
    log(Math.abs(b.bpm - bpm) <= 1, `a ${bpm} BPM song is heard as ${b.bpm} BPM`);
    log(off < 0.05, `and its beats fall on the kick, not the hi-hat between (${off.toFixed(3)} s out)`);
  }

  console.log('\nTHE PLAN IS CHECKED, NOT TRUSTED');
  const cands = [
    { id: 'c1', kind: 'video', file: '/v/a.mp4', start: 2, end: 5, peak: 3, fileDur: 10, score: 0.9, w: 1920, h: 1080 },
    { id: 'c2', kind: 'video', file: '/v/b.mp4', start: 0, end: 2, peak: 1, fileDur: 2, score: 0.7, w: 1080, h: 1920 },
    { id: 'c3', kind: 'image', file: '/v/p.jpg', start: 0, end: 0, peak: 0, fileDur: 0, score: 0.5, w: 1200, h: 1600 },
  ];
  const music = { bpm: 120, interval: 0.5, beats: Array.from({ length: 120 }, (_, i) => i * 0.5) };
  const plan = montage.finalise({
    shots: [
      { id: 'c1', seconds: 1.3, effect: 'punch_in', focus: 'center' },
      { id: 'nope', seconds: 2, effect: 'cut', focus: 'center' },
      { id: 'c2', seconds: 9, effect: 'warp-drive', focus: 'top' },
      { id: 'c3', seconds: 2.2, effect: 'slow_zoom', focus: 'center' },
      { id: 'c1', seconds: 1, effect: 'cut', focus: 'center' },
    ],
    texts: [{ at_shot: 0, span_shots: 2, text: 'He was not ready for this', role: 'hook' }, { at_shot: 9, span_shots: 1, text: 'lost', role: 'beat' }],
    hashtags: ['#church', 'youth camp'], post_caption: 'What a night', title: 'Camp', concept: 'x',
  }, cands, { lengthSec: 30 }, music);
  log(plan.shots.length === 4, 'a shot the director made up is dropped', plan.shots.length + ' shots');
  log(plan.shots[1].effect === 'cut' && plan.shots[1].focus === 'top', 'an effect that does not exist becomes a plain cut');
  log(plan.shots[1].seconds <= 2, 'a shot is never longer than its footage', plan.shots[1].seconds + ' s from a 2 s clip');
  const onBeat = plan.shots.every((s) => Math.abs((s.at / 0.5) - Math.round(s.at / 0.5)) < 0.02);
  log(onBeat, 'every cut lands on a beat', plan.shots.map((s) => s.at).join(', '));
  log(plan.shots[3].from > plan.shots[0].from, 'a moment used twice carries on rather than repeating', `${plan.shots[0].from} → ${plan.shots[3].from}`);
  log(plan.texts.length === 1 && plan.texts[0].start === 0 && plan.texts[0].end === round(plan.shots[2].at), 'words are timed to their shots; one pointing nowhere is dropped', JSON.stringify(plan.texts));
  log(plan.hashtags.join(',') === 'church,youthcamp', 'hashtags lose their # and spaces');

  console.log('\nWHAT CLAUDE IS ASKED');
  const seen = [];
  class FakeBadRequest extends Error {}
  const fake = function Anthropic() {
    const create = async (body) => {
      seen.push(body);
      if (body.fallbacks) throw new FakeBadRequest('fallbacks not available on this account');
      return { model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
        concept: 'Open on the jump.', title: 'Camp night', post_caption: 'Best night', hashtags: ['camp'],
        shots: [{ id: 'c2', seconds: 1, effect: 'flash', focus: 'center' }, { id: 'c1', seconds: 2, effect: 'cut', focus: 'center' }],
        texts: [{ at_shot: 0, span_shots: 1, text: 'Wait for it', role: 'hook' }],
      }) }] };
    };
    this.messages = { create };
    this.beta = { messages: { create } };
  };
  fake.BadRequestError = FakeBadRequest;
  require.cache[require.resolve('@anthropic-ai/sdk')] = { id: 'sdk', filename: 'sdk', loaded: true, exports: fake };
  const thumbs = cands.map((c) => { c.thumb = make(['-f', 'lavfi', '-i', 'color=c=purple:s=180x320:d=1', '-frames:v', '1'], path.join(WORK, c.id + '.jpg')); return c; });
  process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
  const got = await montage._direct(thumbs, { style: 'hype', lengthSec: 15, aspect: '9:16', brief: 'Youth camp' }, music);
  delete process.env.ANTHROPIC_API_KEY;
  const first = seen[0] || {}, second = seen[1] || {};
  const images = (first.messages && first.messages[0].content.filter((b) => b.type === 'image').length) || 0;
  log(got.director === 'claude' && got.plan.shots.length === 2, 'Claude directs when there is a key', got.director);
  log(first.model === 'claude-opus-5-5', 'the model is Claude Opus 5.5', first.model);
  log(images === 3, 'it is shown every candidate frame', images + ' pictures');
  log(first.output_config && first.output_config.format && first.output_config.format.type === 'json_schema' && first.output_config.effort === 'high',
    'it answers to a schema, thinking hard', JSON.stringify(first.output_config && { effort: first.output_config.effort, type: first.output_config.format.type }));
  log(first.thinking && first.thinking.type === 'adaptive', 'adaptive thinking');
  log(first.fallbacks === 'default' && second.model && !second.fallbacks, 'a refused fallback setting is retried without it');
  const noKey = await montage._direct(thumbs, { style: 'hype', lengthSec: 15, aspect: '9:16', brief: 'Youth camp worship' }, null);
  log(noKey.director === 'rules' || noKey.director === 'groq', 'without a key it still directs (' + noKey.director + ')');

  console.log('\nA REAL MONTAGE, ON A 512 MB SETTING');
  const v1 = make(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=300:d=8', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], path.join(WORK, 'wide.mp4'));
  const v2 = make(['-f', 'lavfi', '-i', 'testsrc=s=720x1280:r=30:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'], path.join(WORK, 'tall.mp4'));
  const ph = make(['-f', 'lavfi', '-i', 'testsrc2=s=1200x1600:d=1', '-frames:v', '1'], path.join(WORK, 'photo.jpg'));
  const song = path.join(WORK, 's128.wav');
  const out = path.join(WORK, 'montage.mp4');
  const stages = [];
  const res = await montage.make(ctx, video.getInfo, { mediaPaths: [v1, v2, ph], musicPath: song, style: 'hype', lengthSec: 10, aspect: '9:16',
    brief: 'Camp night', keepAudio: true, output: out, stage: (s) => stages.push(s), onProgress: () => {} });
  const info = await video.getInfo(ctx, out);
  log(fs.existsSync(out) && info.width === 1080 && info.height === 1920, 'a 1080×1920 file comes out', `${info.width}x${info.height}`);
  log(Math.abs(info.durationSec - res.duration) < 0.4 && res.duration >= 8, 'as long as planned', `${info.durationSec.toFixed(2)} s for ${res.duration} s`);
  log(info.hasAudio, 'with sound (silence where a clip or photo had none)');
  log(res.bpm && Math.abs(res.bpm - 128) <= 1 && res.texts.length === 1 && res.texts[0].text === 'Camp night', 'cut to the song, with the operator’s words as the hook', `${res.bpm} BPM, ${JSON.stringify(res.texts)}`);
  log(stages.length >= 3, 'it says what it is doing', stages.join(' / '));

  console.log('\nKEEP EVERYTHING');
  const fullPlan = montage.finalise({
    shots: [
      { id: 'c3', seconds: 2.5, effect: 'slow_zoom', focus: 'center', transition: 'cut' },
      { id: 'c1', seconds: 1, effect: 'slow_motion', focus: 'center', transition: 'fade' },
      { id: 'c1', seconds: 1, effect: 'cut', focus: 'center', transition: 'cut' },
    ],
    texts: [], hashtags: [], post_caption: '', title: '', concept: '',
  }, cands.map((c) => Object.assign({}, c, c.kind === 'video' ? { whole: true, start: 0, end: c.fileDur } : {})), { full: true, lengthSec: 15 }, null);
  log(fullPlan.shots.length === 3 && new Set(fullPlan.shots.map((x) => x.cand.id)).size === 3, 'every file is in it once — one the director skipped is added, a repeat dropped', fullPlan.shots.map((x) => x.cand.id).join(','));
  const v1shot = fullPlan.shots.find((x) => x.cand.id === 'c1');
  log(v1shot && v1shot.from === 0 && Math.abs(v1shot.seconds - 9.95) < 0.06 && v1shot.effect === 'cut', 'a video plays whole, from the start (no slow motion on a whole clip)', v1shot && `${v1shot.from}+${v1shot.seconds}`);
  log(fullPlan.shots[0].transition === 'cut' && v1shot.transition === 'fade', 'the transitions are kept (and the first shot just starts)');
  const outAll = path.join(WORK, 'all.mp4');
  const resAll = await montage.make(ctx, video.getInfo, { mediaPaths: [v1, v2, ph], musicPath: null, style: 'worship', full: true, aspect: '9:16',
    brief: '', keepAudio: true, output: outAll, onProgress: () => {} });
  const infoAll = await video.getInfo(ctx, outAll);
  const want = 8 + 6;
  log(resAll.full && resAll.shots.length === 3 && infoAll.durationSec >= want, 'nothing is cut out: both clips whole plus the photo', `${infoAll.durationSec.toFixed(2)} s from ${want} s of video + a photo`);
  log(resAll.shots.some((x) => x.transition === 'fade'), 'and they are blended (a fade between different kinds of shot)', resAll.shots.map((x) => x.transition).join(','));

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(failed ? '\n❌ montage test failed' : '\n✅ montage test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function round(n) { return Math.round(n * 100) / 100; }
