'use strict';
/*
 * THE VIRAL TALK EDIT (montage.js makeTalk): videos of someone speaking →
 * the strongest lines, hook first, cut into beats with jump zooms, B-roll from
 * the photos, and the words back on the finished video's clock for captions.
 * The hearing is stood in for (no Groq key, no speech model on a test box):
 * each video "says" a script with word times, as Whisper would report them.
 *
 *   node test/montage-talk.test.js
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
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-talk-test-'));

let pass = 0, fail = 0;
const ok = (c, name, d) => { console.log((c ? '  PASS ' : '  FAIL ') + name + (!c && d !== undefined ? '  -> ' + JSON.stringify(d) : '')); c ? pass++ : fail++; };
const make = (args, out) => { execFileSync(ffmpeg, ['-v', 'error', '-y', ...args, out]); return out; };

/* A script, said at a steady pace from `t0`: each sentence a run of words, a
 * pause between sentences — what Whisper's word times look like. */
function say(sentences, t0 = 0.5) {
  const words = [];
  let t = t0;
  for (const s of sentences) {
    for (const w of s.split(' ')) { words.push({ text: w, start: +t.toFixed(2), end: +(t + 0.32).toFixed(2) }); t += 0.38; }
    t += 0.8;
  }
  return words;
}
const SCRIPT = {
  a: ['and so um we were talking about the weekend.', 'Never give up on what God promised you!', 'He is faithful even when you cannot see it.', 'Okay turn to page twelve please.'],
  b: ['Your breakthrough is closer than you think.', 'Why would he bring you this far to leave you?', 'Stop doubting and start believing today!'],
};

(async () => {
  console.log('\nPHRASES');
  {
    const ph = montage.phrasesOf(say(['one two three four five.', 'six seven eight nine ten.']));
    ok(ph.length === 2 && /^one/.test(ph[0].text) && /^six/.test(ph[1].text), 'a full stop and a pause end a phrase — never a sentence cut in two', ph.map((p) => p.text));
    const scrap = montage.phrasesOf([{ text: 'Amen', start: 0, end: 0.4 }, { text: 'and', start: 0.6, end: 0.8 }, { text: 'hallelujah', start: 0.85, end: 1.3 }, { text: 'church', start: 1.35, end: 1.7 }]);
    ok(scrap.length === 1, 'a two-word scrap joins the words beside it', scrap.map((p) => p.text));
  }

  console.log('\nA TALK EDIT, END TO END');
  const A = make(['-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=16', '-f', 'lavfi', '-i', 'sine=f=220:d=16', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast'], path.join(WORK, 'preacher-a.mp4'));
  const B = make(['-f', 'lavfi', '-i', 'testsrc=s=360x640:r=30:d=12', '-f', 'lavfi', '-i', 'sine=f=330:d=12', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast'], path.join(WORK, 'preacher-b.mp4'));
  const P = make(['-f', 'lavfi', '-i', 'color=c=orange:s=800x600', '-frames:v', '1'], path.join(WORK, 'crowd.jpg'));
  const heard = { [A]: say(SCRIPT.a), [B]: say(SCRIPT.b) };
  const hear = async (file) => heard[file] || [];
  const out = path.join(WORK, 'montage-talk.mp4');
  const stages = [];
  const t0 = Date.now();
  const res = await montage.make(ctx, video.getInfo, {
    mediaPaths: [A, B, P], style: 'hype', lengthSec: 15, aspect: '9:16', output: out, mode: 'talk', hear,
    stage: (s) => stages.push(s), onProgress: () => {},
  });
  console.log(`  (made in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  ok(res && res.mode === 'talk' && fs.existsSync(out), 'the edit is made', res && res.mode);
  const info = await video.getInfo(ctx, out);
  ok(Math.abs(info.durationSec - res.duration) < 0.4 && info.width === 1080 && info.height === 1920, 'it is a 9:16 1080p video as long as the plan says', { file: info.durationSec, plan: res.duration });
  ok(info.hasAudio, 'with the speaker\'s voice');
  const allWords = res.words.map((w) => w.text.replace(/[.,!?]/g, '').toLowerCase());
  ok(res.words.length > 0 && /never/.test(allWords.slice(0, 2).join(' ')), 'without an AI, the strongest line opens it: "Never give up…"', allWords.slice(0, 6));
  ok(!allWords.includes('um') && !/page twelve/.test(allWords.join(' ')), 'filler and housekeeping ("um", "turn to page twelve") are left out', allWords.join(' '));
  const vids = new Set(res.shots.map((s) => s.file));
  ok(vids.has(A) && vids.has(B), 'lines from BOTH videos are mixed into one edit');
  const fx = new Set(res.shots.map((s) => s.effect));
  ok(res.shots[0].effect === 'punch_in' && fx.size >= 3, 'the first beat punches in, and the framing keeps changing (jump zooms)', [...fx]);
  const longest = Math.max(...res.shots.map((s) => s.seconds));
  ok(longest <= 4.6, 'no beat is held long — constant movement', longest);
  ok(res.words.every((w) => w.start >= -0.01 && w.end <= res.duration + 0.05 && w.end > w.start), 'every caption word sits inside the finished video, on its clock');
  // the words land where they are said: each word's time falls inside the shot it came from
  ok(res.overlays.length >= 1 && res.overlays[0].file === P, 'the photo is laid over the speaker as B-roll', res.overlays.map((o) => path.basename(o.file)));
  ok(res.texts.length === 0 || res.texts[0].role === 'hook', 'a headline, when there is one, is the hook');
  ok(stages.some((s) => /Listening/.test(s)) && stages.some((s) => /picking the lines/.test(s)), 'it says what it is doing, step by step', stages);
  ok(fs.existsSync(montage.sidecarOf(out)), 'the edit is saved beside the video, to rearrange later');

  console.log('\nCLAUDE DIRECTS');
  {
    const seen = [];
    const fake = function Anthropic() {
      const create = async (body) => {
        seen.push(body);
        // the phrase list is in the prompt: pick "Why would he…" first, then "Never give up…"
        const txt = body.messages[0].content;
        const id = (re) => { const m = txt.split('\n').find((l) => re.test(l)); return m ? m.split(' | ')[0].trim() : ''; };
        return { model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
          concept: 'Question, then the promise.', title: 'He did not bring you this far', hook_text: 'Don’t quit now',
          post_caption: 'Who needs this today?', hashtags: ['faith', '#jesus'],
          picks: [{ id: id(/Why would he/) }, { id: id(/Never give up/) }, { id: 'p999' }],
        }) }] };
      };
      this.messages = { create }; this.beta = { messages: { create } };
    };
    fake.BadRequestError = class extends Error {};
    require.cache[require.resolve('@anthropic-ai/sdk')] = { id: 'sdk', filename: 'sdk', loaded: true, exports: fake };
    process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
    const out2 = path.join(WORK, 'montage-talk-claude.mp4');
    const r2 = await montage.make(ctx, video.getInfo, { mediaPaths: [A, B], style: 'cinematic', lengthSec: 15, aspect: '9:16', output: out2, mode: 'talk', hear });
    delete process.env.ANTHROPIC_API_KEY;
    const body = seen[0] || {};
    ok(/Never give up on what God promised you!/.test(body.messages[0].content) && /video 2/.test(body.messages[0].content), 'Claude is shown every phrase from every video, with which video and when');
    ok(body.output_config && body.output_config.format && body.output_config.format.type === 'json_schema', 'and answers in a fixed shape');
    const w = r2.words.map((x) => x.text.toLowerCase()).join(' ');
    ok(/^why would he/.test(w) && /never give up/.test(w) && w.indexOf('why') < w.indexOf('never'), 'its lines play in its order — a line from video 2 first, then video 1', w.slice(0, 80));
    ok(r2.director === 'claude' && r2.texts[0] && r2.texts[0].text === 'Don’t quit now' && r2.hashtags.includes('jesus'), 'its headline, title and hashtags come through (an unknown id is ignored)', { d: r2.director, t: r2.texts, h: r2.hashtags });
    ok(new Set(r2.shots.map((x) => x.effect)).has('slow_zoom'), 'a cinematic edit moves with slow pushes');
  }

  console.log('\nA NARRATOR, AND B-ROLL FROM THE VIDEOS THEMSELVES');
  {
    // the voice engine stood in for (the real one fetches its model from the internet)
    const vox = require(path.join(ROOT, 'src/main/voiceover'));
    const said = [];
    vox._setEngine({ generate: async (text, o) => { said.push({ text, voice: o.voice }); return { save: async (out) => make(['-f', 'lavfi', '-i', 'sine=f=900:d=2.2'], out) }; } });
    const out3 = path.join(WORK, 'montage-talk-voice.mp4');
    const r3 = await montage.make(ctx, video.getInfo, { mediaPaths: [A, B], style: 'hype', lengthSec: 15, aspect: '9:16', output: out3, mode: 'talk', hear, voice: 'bf_emma', brief: 'Youth night' });
    ok(said.length === 2 && said.every((x) => x.voice === 'bf_emma'), 'the narrator speaks an opening and a closing line, in the voice chosen', said);
    ok(Array.isArray(r3.narrator) && r3.narrator.length === 2, 'the result says what the narrator said', r3.narrator);
    const first = r3.words.slice(0, 3).map((w) => w.text).join(' ');
    ok(first.toLowerCase().startsWith(said[0].text.toLowerCase().split(' ').slice(0, 3).join(' ')), 'the narrator\'s words are captioned first', first);
    const firstSpoken = r3.words.find((w) => /never|why|your|stop/i.test(w.text));
    ok(firstSpoken && firstSpoken.start >= 2.2, 'the speaker comes in after the narrator', firstSpoken);
    const i3 = await video.getInfo(ctx, out3);
    ok(Math.abs(i3.durationSec - r3.duration) < 0.4 && i3.hasAudio, 'the file is as long as the plan, with sound', { file: i3.durationSec, plan: r3.duration });
    // the narrator really is in the sound: loud 900 Hz in the first two seconds
    const m = /mean_volume: (-?[\d.]+)/.exec(String(require('child_process').spawnSync(ffmpeg, ['-hide_banner', '-t', '1.5', '-ss', '0.3', '-i', out3, '-af', 'bandpass=f=900:w=100,volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr));
    ok(m && +m[1] > -35, 'the narrator\'s voice is in the finished sound', m && m[1]);
    // (a snapshot comes as the still it froze, kept beside the montage: <name>.snap-N.jpg)
    ok(r3.overlays.length >= 1 && r3.overlays.every((o) => o.file === A || o.file === B || (o.style === 'snapshot' && /\.snap-\d+\.jpg$/.test(o.file))), 'with no photos, other moments of the videos are cut in as B-roll', r3.overlays.map((o) => path.basename(o.file)));
    vox._setEngine({ generate: async () => { throw new Error('no model here'); } });
    const r4 = await montage.make(ctx, video.getInfo, { mediaPaths: [A], style: 'cinematic', lengthSec: 10, aspect: '9:16', output: path.join(WORK, 'm4.mp4'), mode: 'talk', hear, voice: 'am_michael' });
    ok(!r4.narrator && /no model here/.test(r4.narratorWhy), 'a voice that cannot be made leaves the narrator out, and says why — the edit still comes', r4.narratorWhy);
  }

  console.log('\nONE LANDSCAPE VIDEO: FULL SCREEN, ROUND THE SPEAKER — SHORT LINES, SNAPSHOTS');
  {
    // a 16:9 "service": red on the left, green in the middle, blue on the right (the speaker stands right)
    const L = make(['-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=30:d=40', '-f', 'lavfi', '-i', 'color=c=0x00c000:s=1280x720:r=30:d=40', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=30:d=40',
      '-f', 'lavfi', '-i', 'sine=f=220:d=40', '-filter_complex', '[0:v]crop=427:720:0:0[a];[1:v]crop=426:720:427:0[b];[2:v]crop=427:720:853:0[c];[a][b][c]hstack=3[v]', '-map', '[v]', '-map', '3:a', '-shortest',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast'], path.join(WORK, 'service-16x9.mp4'));
    // a long run of speech, as one hour of a service sounds: long sentences, short ones
    const long = say(['This is a very long sentence that keeps going and going without stopping for breath at all.', 'Never give up!', 'God is faithful to every promise he has ever made to you and your house.', 'Why are you afraid?', 'Stop doubting and start believing today!', 'He will finish what he started in you.',
      'Your miracle is on the way.', 'Praise him in the storm!', 'The enemy is a liar.', 'Lift your hands and worship.'], 0.5);
    const hear1 = async () => long;
    const see = require(path.join(ROOT, 'src/main/cloudsee'));
    const realReady = see.ready, realWho = see.whoIsSpeaking;
    const grids = [];
    see.ready = () => true;
    see.whoIsSpeaking = async ({ image, frames }) => { grids.push(image); return { ok: true, answers: Object.fromEntries(frames.map((f) => [f.label, { column: 7, sure: true }])) }; };
    const outR = path.join(WORK, 'fill-right.mp4');
    let r;
    try { r = await montage.make(ctx, video.getInfo, { mediaPaths: [L], style: 'hype', lengthSec: 12, aspect: '9:16', output: outR, mode: 'talk', hear: hear1 }); }
    finally { see.ready = realReady; see.whoIsSpeaking = realWho; }
    const colourAt = (file, t, y) => {
      const buf = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=40:40:520:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      return [buf[0], buf[1], buf[2]];
    };
    const ir = await video.getInfo(ctx, outR);
    ok(ir.width === 1080 && ir.height === 1920, 'a 9:16 edit of a 16:9 video is 1080×1920', [ir.width, ir.height]);
    ok(grids.length >= 1, 'the speaker was looked for', grids.length);
    // a moment with nothing laid over it (a snapshot shows the whole original picture, middle and all)
    const clear = (res, t) => !(res.overlays || []).some((o) => t >= o.at - 0.2 && t <= o.at + o.seconds + 0.2);
    let t = r.duration * 0.55;
    for (let x = r.duration * 0.3; x < r.duration - 0.5; x += 0.25) if (clear(r, x)) { t = x; break; }
    const top = colourAt(outR, t, 120), mid = colourAt(outR, t, 940), bot = colourAt(outR, t, 1760);
    const blue = (c) => c[2] > 150 && c[0] < 90 && c[1] < 90;
    ok(blue(top) && blue(mid) && blue(bot), 'the picture fills the frame top to bottom — no blurred bands — cropped round the speaker on the right', { top, mid, bot });
    // with nothing to ask: still full screen, the middle of the picture
    const outC = path.join(WORK, 'fill-centre.mp4');
    const rc = await montage.make(ctx, video.getInfo, { mediaPaths: [L], style: 'hype', lengthSec: 15, aspect: '9:16', output: outC, mode: 'talk', hear: hear1 });
    const green = (c) => c[1] > 120 && c[0] < 90 && c[2] < 90;
    let tc = rc.duration * 0.55;
    for (let x = rc.duration * 0.3; x < rc.duration - 0.5; x += 0.25) if (clear(rc, x)) { tc = x; break; }
    ok(green(colourAt(outC, tc, 120)) && green(colourAt(outC, tc, 1760)), 'with no AI to ask, it still fills the frame (the middle of the picture)', [colourAt(outC, tc, 120), colourAt(outC, tc, 1760)]);
    // short lines: nothing from a phrase longer than about 6.5 s
    const lines = montage.phrasesOf(long, 6.5);
    ok(lines.every((p) => p.end - p.start <= 7.6), 'a long run of speech is cut into short lines (≤ ~7 s)', lines.map((p) => +(p.end - p.start).toFixed(1)));
    ok(r.overlays.some((o) => o.style === 'snapshot'), 'one video, no photos: its best moments come back as snapshots', r.overlays.map((o) => o.style));
  }

  console.log('\nNOTHING SAID');
  let err = null;
  try {
    await montage.make(ctx, video.getInfo, { mediaPaths: [A], style: 'hype', lengthSec: 15, output: path.join(WORK, 'm2.mp4'), mode: 'talk', hear: async () => [] });
  } catch (e) { err = e; }
  ok(err && /AI Standard Montage/.test(err.message), 'a video with no one speaking says to use the music montage instead', err && err.message);

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
