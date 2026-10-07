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

  console.log('\nNOTHING SAID');
  let err = null;
  try {
    await montage.make(ctx, video.getInfo, { mediaPaths: [A], style: 'hype', lengthSec: 15, output: path.join(WORK, 'm2.mp4'), mode: 'talk', hear: async () => [] });
  } catch (e) { err = e; }
  ok(err && /Music montage/.test(err.message), 'a video with no one speaking says to use the music montage instead', err && err.message);

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
