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

  console.log('\n“WHAT’S IT ABOUT?” IS HONOURED EVERYWHERE');
  const brief = 'Youth camp 2026 — three days of worship, games and baptisms';
  const fbx = montage.fromBrief(brief);
  log(fbx.hook === 'Youth camp 2026', 'the first clause becomes the hook', fbx.hook);
  log(fbx.beats.join(' | ') === 'three days of worship | games and baptisms', 'the rest become short beats', fbx.beats.join(' | '));
  log(fbx.caption === brief && fbx.hashtags.includes('worship') && fbx.hashtags.includes('church'), 'and the caption and hashtags', fbx.hashtags.join(','));
  log(montage.fromBrief('   ') === null && montage.fromBrief('baptism').hook === 'baptism', 'an empty brief adds nothing; one word still works');
  const odd = montage.fromBrief('  🙏 Revival night: 400 souls, healing & joy <3  \n');
  log(odd.hook === '🙏 Revival night' && odd.beats.includes('healing & joy <3'), 'emoji, numbers and symbols survive as written', JSON.stringify(odd.beats));
  // no AI: the brief is the hook, the beats, the caption and the tags
  const rb = montage.directByRules(thumbs, { style: 'hype', lengthSec: 15, aspect: '9:16', brief }, music);
  const rp = montage.finalise(rb.plan, thumbs, { lengthSec: 15, brief }, music);
  log(rp.texts[0] && rp.texts[0].text === 'Youth camp 2026' && rp.texts[0].role === 'hook' && rp.texts[0].start === 0, 'without AI: the hook opens it');
  log(rp.texts.filter((x) => x.role === 'beat').length >= 1, 'its beats appear later on', rp.texts.map((x) => x.text).join(' / '));
  log(rp.postCaption === brief && rp.title === 'Youth camp 2026' && rp.hashtags.length >= 3, 'and it is the title, the caption and the hashtags');
  // an AI that forgot: the brief fills the gaps, never overrides what it wrote
  const forgot = montage.finalise({ shots: [{ id: 'c1', seconds: 3, effect: 'cut', focus: 'center', transition: 'cut' }], texts: [], hashtags: [], post_caption: '', title: '', concept: '' }, cands, { lengthSec: 15, brief }, null);
  log(forgot.texts[0] && forgot.texts[0].text === 'Youth camp 2026' && forgot.postCaption === brief && forgot.hashtags.length, 'an AI that left the hook and caption empty is filled in from it');
  const kept = montage.finalise({ shots: [{ id: 'c1', seconds: 3, effect: 'cut', focus: 'center', transition: 'cut' }], texts: [{ at_shot: 0, span_shots: 1, text: 'They came hungry', role: 'hook' }], hashtags: ['youthcamp'], post_caption: 'Three days we will never forget', title: 'Camp', concept: '' }, cands, { lengthSec: 15, brief }, null);
  log(kept.texts.length === 1 && kept.texts[0].text === 'They came hungry' && kept.postCaption === 'Three days we will never forget', 'and what the AI did write is left alone');
  // what the AI is told
  seen.length = 0;
  process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
  await montage._direct(thumbs, { style: 'hype', lengthSec: 15, aspect: '9:16', brief }, music);
  delete process.env.ANTHROPIC_API_KEY;
  const said = ((seen[0] && seen[0].messages[0].content[0].text) || '');
  log(said.includes(brief) && /story of the edit/.test(said) && /exactly as written/.test(said), 'Claude is given the words verbatim, as the story to tell');

  console.log('\nGROQ LOOKS AT THE SHOTS TOO (contact sheets)');
  const realCw = require.cache[require.resolve(path.join(ROOT, 'src/main/cloudwrite'))];
  const cwPath = require.resolve(path.join(ROOT, 'src/main/cloudwrite'));
  const realFetch = global.fetch;
  const sentG = [];
  require.cache[cwPath] = { id: cwPath, filename: cwPath, loaded: true, exports: Object.assign({}, require(cwPath), {
    access: () => ({ provider: 'groq', key: 'test', url: 'https://example.invalid/chat', headers: { 'content-type': 'application/json' } }),
    chat: async () => '',
  }) };
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body); sentG.push(body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ concept: 'seen', title: 'Camp', post_caption: '', hashtags: [], texts: [], overlays: [],
      shots: [{ id: 'c2', seconds: 1.5, effect: 'cut', focus: 'center', transition: 'cut' }, { id: 'c1', seconds: 2, effect: 'flash', focus: 'center', transition: 'flash' }] }) } }] }) };
  };
  const tmpG = fs.mkdtempSync(path.join(WORK, 'g-'));
  const gotG = await montage._direct(thumbs, { style: 'hype', lengthSec: 15, aspect: '9:16', brief: '' }, music, (m) => console.log('    (director said: ' + m + ')'), ctx, tmpG);
  global.fetch = realFetch;
  if (realCw) require.cache[cwPath] = realCw; else delete require.cache[cwPath];
  const g0 = sentG[0] || { messages: [{}, { content: [] }] };
  const pics = (g0.messages[1].content || []).filter((c) => c.type === 'image_url');
  log(gotG.director === 'groq' && gotG.vision && gotG.plan.shots.length === 2, 'without a Claude key, Groq directs from what it SEES', gotG.director + (gotG.vision ? ' (looking)' : ''));
  log(pics.length >= 1 && pics.length <= 4 && /^data:image\/jpeg;base64,/.test(pics[0].image_url.url), 'every candidate goes on contact sheets — within Groq’s pictures-per-request', pics.length + ' sheet(s)');
  log(/qwen|llama-4/.test(g0.model || ''), 'on a vision model', g0.model);
  const sheet = fs.readdirSync(tmpG).find((f) => /^sheet-\d+\.jpg$/.test(f));
  log(!!sheet, 'the sheet is a real picture', sheet);
  if (sheet && process.env.KEEP_SHEET) fs.copyFileSync(path.join(tmpG, sheet), process.env.KEEP_SHEET);

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
  log(resAll.full && resAll.shots.length + resAll.overlays.length === 3 && infoAll.durationSec >= want - 0.2, 'nothing is cut out: both clips whole plus the photo', `${infoAll.durationSec.toFixed(2)} s from ${want} s of video + a photo`);
  log(resAll.overlays.length === 1, 'and the photo is laid over a clip rather than tacked on the end', JSON.stringify(resAll.overlays.map((o) => o.style)));

  console.log('\nB-ROLL ON TOP, THE SOUND CARRIES ON');
  const ovPlan = montage.finalise({
    shots: [{ id: 'c1', seconds: 6, effect: 'cut', focus: 'center', transition: 'cut' }, { id: 'c3', seconds: 2, effect: 'slow_zoom', focus: 'center', transition: 'fade' }],
    overlays: [
      { on_shot: 0, id: 'c3', style: 'pip', start: 0.2, seconds: 9 },
      { on_shot: 0, id: 'c2', style: 'cutaway', start: 1, seconds: 1 },
      { on_shot: 1, id: 'c2', style: 'cutaway', start: 0.5, seconds: 1 },
      { on_shot: 0, id: 'nope', style: 'pip', start: 1, seconds: 1 },
    ],
    texts: [], hashtags: [], post_caption: '', title: '', concept: '',
  }, cands, { lengthSec: 30 }, null);
  const o0 = ovPlan.shots[0].overlays[0];
  log(o0 && o0.style === 'pip' && o0.cand.id === 'c3', 'an overlay lands on its video shot');
  log(o0 && o0.start >= 1.2 && o0.start + o0.len <= ovPlan.shots[0].seconds, 'kept out of the hook’s first second and inside its shot', o0 && `${o0.start}+${o0.len} of ${ovPlan.shots[0].seconds}`);
  log(ovPlan.shots[0].overlays.length === 1 && !ovPlan.shots[1].overlays.length, 'no more than a 6 s shot can carry, and never over a photo (it has no sound to carry)');

  console.log('\nPHOTOS GO ON THE VIDEOS, NOT AFTER THEM');
  const longCands = [
    { id: 'v1', kind: 'video', file: 'a.mov', start: 0, end: 44, peak: 10, fileDur: 44, whole: true, hasAudio: true, w: 576, h: 1024, score: 0.6 },
    { id: 'v2', kind: 'video', file: 'b.mov', start: 0, end: 66, peak: 20, fileDur: 66, whole: true, hasAudio: true, w: 464, h: 832, score: 0.5 },
    { id: 'v3', kind: 'video', file: 'c.mov', start: 0, end: 10, peak: 5, fileDur: 10, whole: true, hasAudio: true, w: 1920, h: 1080, score: 0.4 },
  ];
  for (let k = 1; k <= 12; k++) longCands.push({ id: 'p' + k, kind: 'image', file: `p${k}.jpg`, start: 0, end: 0, peak: 0, fileDur: 0, hasAudio: false, w: k % 2 ? 1600 : 1066, h: k % 2 ? 1066 : 1600, score: 0.5 });
  // what a director did with the real photos: every video, then every photo
  const atEnd = montage.finalise({
    shots: longCands.map((c) => ({ id: c.id, seconds: 3, effect: c.kind === 'image' ? 'slow_zoom' : 'cut', focus: 'center', transition: 'cut' })),
    texts: [{ at_shot: 0, span_shots: 1, text: 'The Power House', role: 'hook' }], hashtags: [], post_caption: '', title: '', concept: '',
  }, longCands, { full: true, lengthSec: 0 }, null);
  const lastVid = atEnd.shots.map((x) => x.cand.kind).lastIndexOf('video');
  const ovs = atEnd.shots.flatMap((x) => x.overlays.map((o) => ({ o, x })));
  const standing = atEnd.shots.filter((x) => x.cand.kind === 'image');
  log(lastVid === atEnd.shots.length - 1, 'no photo is left in a pile after the last video', atEnd.shots.map((x) => x.cand.id).join(','));
  log(ovs.length >= 9 && ovs.length + standing.length === 12, 'most become B-roll over the videos, and every photo is still shown once', `${ovs.length} on top, ${standing.length} between`);
  log(atEnd.shots.filter((x) => x.cand.kind === 'video').every((v) => v.overlays.length >= 1 || v.seconds < 8), 'spread through every clip long enough to carry one', atEnd.shots.map((x) => x.cand.id + ':' + x.overlays.length).join(' '));
  log(atEnd.shots.every((x) => x.overlays.every((o, k) => o.start + o.len <= x.seconds && (!k || o.start >= x.overlays[k - 1].start + x.overlays[k - 1].len + 0.99))), 'each picture inside its clip, with the clip itself between them');
  log(ovs.some(({ o }) => o.style === 'pip') && ovs.some(({ o }) => o.style === 'cutaway'), 'mostly full-frame, sometimes a framed box');
  log(atEnd.texts[0] && atEnd.texts[0].start === 0, 'the hook stays on the opening shot');
  let run = 0, worst = 0;
  for (const x of atEnd.shots) { run = x.cand.kind === 'image' ? run + 1 : 0; worst = Math.max(worst, run); }
  log(worst <= 2, 'never more than two photos in a row between clips', 'longest run ' + worst);
  const iv = 60 / 96, bts = [];
  for (let t = 0.21; t < 140; t += iv) bts.push(Math.round(t * 1000) / 1000);
  const ovBeat = montage.finalise({
    shots: longCands.map((c) => ({ id: c.id, seconds: 3, effect: 'cut', focus: 'center', transition: 'cut' })),
    texts: [], hashtags: [], post_caption: '', title: '', concept: '',
  }, longCands, { full: true, lengthSec: 0 }, { bpm: 96, interval: iv, beats: bts });
  const offs = ovBeat.shots.flatMap((x) => x.overlays.map((o) => Math.min(...bts.map((b) => Math.abs(b - (x.at + o.start))))));
  const lens = ovBeat.shots.flatMap((x) => x.overlays.map((o) => o.len / iv));
  console.log('\nTHE OPERATOR\'S OWN ORDER');
  const V = (id, o, d) => ({ id, kind: 'video', file: id, start: 0, end: d, peak: d / 3, fileDur: d, whole: true, hasAudio: true, w: 576, h: 1024, score: 0.5, order: o });
  const P = (id, o) => ({ id, kind: 'image', file: id, start: 0, end: 0, peak: 0, fileDur: 0, hasAudio: false, w: 1600, h: 1066, score: 0.5, order: o });
  const oc = [P('pA', 0), V('vB', 1, 30), P('p1', 2), P('p2', 3), V('vA', 4, 20), P('p3', 5), P('p4', 6), P('p5', 7), P('p6', 8), P('p7', 9), V('vC', 10, 6)];
  const scrambled = { shots: [oc[10], oc[4], oc[1], ...oc.filter((x) => x.kind === 'image')].map((x) => ({ id: x.id, seconds: 3, effect: 'cut', focus: 'center', transition: 'cut' })), texts: [], hashtags: [], post_caption: '', title: '', concept: '' };
  const mine = montage.finalise(scrambled, oc, { full: true, keepOrder: true }, null);
  const sig = mine.shots.map((x) => x.cand.id + (x.overlays.length ? '[' + x.overlays.map((o) => o.cand.id).join(',') + ']' : '')).join(' ');
  log(mine.shots.filter((x) => x.cand.kind === 'video').map((x) => x.cand.id).join(',') === 'vB,vA,vC', 'the videos play in the order they were put in, whatever the director did', sig);
  log(sig === 'vB[pA,p1,p2] vA[p3,p4,p5] p6 p7 vC', 'each photo goes over the video before it (or the first one); what will not fit follows it, in order');
  const mineShort = montage.finalise({ shots: [oc[10], oc[4], oc[1], oc[4], oc[1]].map((x) => ({ id: x.id, seconds: 3, effect: 'cut', focus: 'center', transition: 'cut' })), texts: [], hashtags: [], post_caption: '', title: '', concept: '' },
    oc.map((x) => ({ ...x, whole: false })), { full: false, keepOrder: true, lengthSec: 15 }, null);
  log(mineShort.shots.map((x) => x.cand.id).join(',') === 'vB,vB,vA,vA,vC', 'a timed montage keeps that order too', mineShort.shots.map((x) => x.cand.id).join(','));

  log(offs.length >= 9 && Math.max(...offs) < 0.02 && lens.every((n) => Math.abs(n - Math.round(n)) < 0.05), 'with a song, every picture comes in ON a beat and stays whole beats', `${offs.length} pictures, worst ${Math.max(...offs).toFixed(3)} s off`);
  const ovOut = path.join(WORK, 'ov.mp4');
  const base = make(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], path.join(WORK, 'talk.mp4'));
  const resOv = await montage.make(ctx, video.getInfo, { mediaPaths: [base, ph], full: true, style: 'worship', aspect: '9:16', keepAudio: true, output: ovOut, onProgress: () => {} });
  log(resOv.overlays.length === 1, 'the montage lays the photo over the talking clip', JSON.stringify(resOv.overlays));
  const o = resOv.overlays[0] || { at: 1.5, seconds: 1 };
  const vol = require('child_process').spawnSync(ffmpeg, ['-hide_banner', '-ss', String(o.at + 0.3), '-t', String(Math.max(0.3, o.seconds - 0.6)), '-i', ovOut, '-af', 'volumedetect', '-vn', '-f', 'null', '-']).stderr.toString();
  const mean = parseFloat((vol.match(/mean_volume:\s*(-?[\d.]+)/) || [])[1]);
  log(mean > -40, 'and the clip’s sound keeps playing under it', mean + ' dB');

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(failed ? '\n❌ montage test failed' : '\n✅ montage test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function round(n) { return Math.round(n * 100) / 100; }
