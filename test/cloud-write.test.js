'use strict';
/*
 * ✨ THE CAPTION WRITER, AFTER THE COMPLAINT.
 *
 * "Can the write-a-caption-from-the-video be better? Let the Groq AI listen to
 * the video and do the write, because at the moment it's terrible."
 *
 * There were three separate reasons it was terrible, and a better prompt only
 * fixes one of them:
 *
 *   1. THE WORDS were usually a GUESS. With no speech engine installed — the
 *      normal case — the copy was written from the file name. With one, it was
 *      `base.en` in fast mode over the first 150 seconds.
 *   2. THE WRITER was usually the RULES. The local thinking model is an
 *      optional 1-2 GB download most machines never make, so the button was a
 *      template with the nouns swapped, twelve posts a week, from one account.
 *   3. THE BRIEF said "two to four real sentences" and listed prohibitions. It
 *      never described the job, which is the half second before a stranger
 *      scrolls past.
 *
 * This checks all three, offline. Nothing here touches the network: the cloud
 * writer is driven through a fake `fetch`, which is also the only honest way to
 * test what happens when a provider retires a model or refuses a key.
 *
 *   node test/cloud-write.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const copy = require(path.join(__dirname, '..', 'src/main/social-copy'));
const cloudwrite = require(path.join(__dirname, '..', 'src/main/cloudwrite'));
const cloudspeech = require(path.join(__dirname, '..', 'src/main/cloudspeech'));

/** A tiny real video with a real audio track, for the file-listening half. */
function makeClip() {
  try {
    const ffmpeg = require('ffmpeg-static');
    const dir = path.join(os.tmpdir(), 'mw-cloudwrite-test');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'clip-8s.mp4');
    if (!fs.existsSync(file) || fs.statSync(file).size < 5000) {
      execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-t', '8', '-i', 'color=c=0x204060:s=320x180:r=15',
        '-f', 'lavfi', '-t', '8', '-i', 'sine=frequency=200:sample_rate=44100',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', file], { stdio: 'ignore' });
    }
    return { ok: true, file };
  } catch (e) { return { ok: false, why: (e && e.message) || 'no ffmpeg' }; }
}

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); ok ? pass++ : fail++; };

const EVENT = 'All Ireland Outpouring';
const SPEAKERS = ['Bishop Francis Wale Oke', 'Pastor John Ahern'];
const SERMON = 'Good morning church. Caleb was eighty five years old when he stood in front of Joshua '
  + 'and said give me this mountain. He did not look at his age, he looked at the promise of God. '
  + 'Somebody say amen. If you serve God with the whole of your heart, your blessing is not by chance. '
  + 'There are people in this room who have been waiting eleven years for one door to open. '
  + 'I want to tell you today that the door is not locked, it is simply not your turn yet. '
  + 'And when it is your turn, nothing on this earth will be able to hold it shut. '
  + 'Bishop Oke told us that the youth of Europe will come to Christ in this generation.';

/* ---- a fake fetch, so the cloud path is exercised without a network ---- */
const realFetch = global.fetch;
function fakeFetch(plan, opts0) {
  const calls = [];
  const o = opts0 || {};
  global.fetch = async (url, opts) => {
    /*
     * The writer asks the provider WHICH MODELS IT HAS before it asks any of
     * them anything (see discoverModels). That is a GET with no body, and it is
     * answered here the way a real provider answers it - with `have`, or with a
     * 500 when a test wants to prove the static list still carries the feature.
     */
    if (!opts || !opts.body) {
      calls.push({ url, models: true });
      if (o.have === null) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => 'no' };
      const have = o.have || ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'whisper-large-v3'];
      return { ok: true, status: 200, headers: { get: () => null },
               json: async () => ({ data: have.map((id) => ({ id })) }), text: async () => '' };
    }
    const body = JSON.parse(opts.body);
    calls.push({ url, model: body.model, messages: body.messages, headers: opts.headers, body });
    const r = plan(body, calls.length);
    return {
      ok: r.status === undefined || r.status === 200,
      status: r.status || 200,
      headers: { get: (n) => (r.headers ? (r.headers[String(n).toLowerCase()] || null) : null) },
      json: async () => r.json,
      text: async () => (r.text != null ? r.text : JSON.stringify(r.json || {})),
    };
  };
  return calls;
}
const said = (text) => ({ json: { choices: [{ message: { content: text } }] } });

(async () => {
  /* =================================================================== */
  console.log('\n[1] The brief now describes the job, not just the prohibitions');
  const p = copy.buildPrompt({
    hook: 'Your blessing is not by chance', kind: 'video', durationSec: 58,
    churchName: 'The Power House International', eventName: EVENT,
    speaker: 'Bishop Francis Wale Oke', transcript: SERMON,
  });
  check('it says the first line is the only line most people read', /only line most people will read/i.test(p));
  check('it caps that line at a length a phone actually shows', /Under 12 words/.test(p));
  check('it asks for tension instead of a summary', /do not summarise/i.test(p));
  check('it asks the writer to speak to one person', /Speak to ONE person/.test(p));
  check('it asks for the speaker’s own words, word for word', /word for word/i.test(p));
  check('it forbids the stock machine openers', /In this powerful message/.test(p) && /Buckle up/.test(p));
  check('it forbids fake urgency', /no fake urgency/i.test(p));
  check('it demands three DIFFERENT posts, not three rewrites of one',
    /Three rewrites of one idea is a failure/.test(p));

  console.log('\n[2] …and it hands over the whole clip, not twelve sentences');
  check('the transcript goes in', /give me this mountain/.test(p));
  check('and so does the shortlist of quotable lines', /THE MOST QUOTABLE LINES/.test(p));
  const read = copy.readTranscript(SERMON);
  check('the shortlist has several distinct lines in it', read.quotes.length >= 3, read.quotes.length + ' lines');
  check('they really are different lines',
    new Set(read.quotes.map((q) => q.slice(0, 20))).size === read.quotes.length);
  check('the full transcript is carried, not a 1200-character slice',
    read.full.length > 400 && read.full.indexOf('youth of Europe') > 0, read.full.length + ' chars');

  console.log('\n[3] The rules fallback opens on what was SAID');
  const rules = await copy.suggest({ mediaPath: 'short-Give_me_this_mountain.mp4', eventName: EVENT,
    speakers: SPEAKERS, transcript: SERMON });
  check('option 1 opens on a line from the clip', /Caleb|mountain|blessing|door/i.test(rules.options[0].caption.split('\n')[0]),
    rules.options[0].caption.split('\n')[0].slice(0, 80));
  const openers = rules.options.map((o) => o.caption.split(/[.\n]/)[0].trim());
  check('and the three options do not all open the same way',
    new Set(openers).size === 3, openers.map((o) => o.slice(0, 32)).join(' | '));
  check('none of them is the old stock closer',
    !/Stand in agreement, take it to heart/.test(rules.options.map((o) => o.caption).join('\n')));

  console.log('\n[4] The machine tells are stripped, whoever wrote them');
  const tellish = copy.houseStyle('In this powerful message, Bishop Oke delves into the promise. '
    + 'It is a testament to faith. Buckle up, stay tuned for more! At the end of the day, God is faithful.');
  check('"In this powerful message" is gone', !/in this powerful/i.test(tellish), tellish);
  check('"delves into" is gone', !/delve/i.test(tellish));
  check('"a testament to" is gone', !/testament to/i.test(tellish));
  check('"buckle up" and "stay tuned" are gone', !/buckle up|stay tuned/i.test(tellish));
  check('"at the end of the day" is gone', !/end of the day/i.test(tellish));
  check('what it left still reads as sentences', /^[A-Z]/.test(tellish) && tellish.length > 30, tellish);
  const sprayed = copy.houseStyle('God 🙌 is 🔥 good ✨ all 🙏 the 💪 time 🕊️ and 📖 his ⚡ mercy 🎉 endures 👑 for ever 🌟.');
  check('an emoji per word is cut back to a voice',
    (sprayed.match(/\p{Extended_Pictographic}/gu) || []).length <= 5,
    (sprayed.match(/\p{Extended_Pictographic}/gu) || []).length + ' emoji');

  console.log('\n[4b] >> A NAME IT WAS NEVER TOLD <<');
  {
    /*
     * Asked to write about a clip with no speaker configured and no name
     * anywhere in the transcript, a hosted model produced "Pastor James
     * delivered this at The Power House International" - in all three options,
     * with the prompt saying in as many words never to invent names. A church
     * posting a real person's ministry under a name that does not exist is not
     * a wording problem, and it is the kind of thing that has to be enforced on
     * the way OUT rather than merely requested on the way in.
     */
    const T = 'The next item will be led by Bishop David Richman. Please remain in your seats.';
    const fixed = (x, o) => copy.stripInventedNames(x, o || { transcript: T });
    check('>> an invented name becomes "the speaker" <<',
      fixed('Pastor James delivered this word.') === 'the speaker delivered this word.',
      fixed('Pastor James delivered this word.'));
    check('...but a name the clip ACTUALLY says is kept',
      fixed('Led by Bishop David Richman.') === 'Led by Bishop David Richman.',
      fixed('Led by Bishop David Richman.'));
    check('...and so is the one the operator configured',
      fixed('Bishop Francis Wale Oke preached.', { speaker: 'Bishop Francis Wale Oke' })
        === 'Bishop Francis Wale Oke preached.');
    check('...and the church keeps its own name',
      fixed('A word from Pastor Andrews.', { churchName: 'Pastor Andrews Memorial' })
        === 'A word from Pastor Andrews.');

    // The whole path, not just the helper: a model that invents one anyway.
    const INVENTED = JSON.stringify({ options: [
      { title: 'A word for you', caption: 'Pastor James delivered this at the church.\n\n#Faith #Hope #Grace #Jesus #Church #Word' },
      { title: 'Another word', caption: 'Pastor James again, with feeling.\n\n#Faith #Hope #Grace #Jesus #Church #Word' },
      { title: 'One more', caption: 'And once more, Pastor James.\n\n#Faith #Hope #Grace #Jesus #Church #Word' },
    ] });
    fakeFetch(() => said(INVENTED));
    cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
    const out = await copy.suggest({ mediaPath: 'x.mp4', transcript: SERMON,
      llm: { isAvailable: () => cloudwrite.isAvailable(), chat: (a) => cloudwrite.chat(a),
             parseJson: (t) => cloudwrite.parseJson(t) } });
    check('>> and it is scrubbed on the way out of the real writer <<',
      !/Pastor James/.test(out.options.map((o) => o.title + o.caption).join(' ')),
      out.options[0].caption.split('\n')[0]);
  }

  console.log('\n[4c] The prompt says which of those two rules applies');
  {
    const named = copy.buildPrompt({ hook: 'x', kind: 'video', speaker: 'Bishop David Richman', transcript: SERMON });
    const unnamed = copy.buildPrompt({ hook: 'x', kind: 'video', transcript: SERMON });
    check('with a speaker configured it is told to name them', /Name them in every caption/.test(named));
    check('with nobody configured it is told not to invent one', /Do NOT invent a name/.test(unnamed));
    check('...but it MAY use a name the clip itself says',
      /MAY name anyone the words above actually name/.test(unnamed));
    check('and it is told not every clip is a sermon',
      /NOT EVERY CLIP IS A SERMON/.test(unnamed) && /announcement/.test(unnamed));
  }

  /* =================================================================== */
  console.log('\n[5] The cloud writer: a real answer through a fake network');
  const THREE = JSON.stringify({ options: [
    { title: 'He was 85 and still asked for a mountain ⚡',
      hook: 'Caleb was 85 when he asked for a mountain.',
      caption: 'Caleb was 85 when he asked for a mountain.\n\n"He did not look at his age, he looked at the promise of God." '
        + 'Bishop Francis Wale Oke, preaching at the All Ireland Outpouring.\nYour age was never the thing standing in the way.\n\n'
        + '#BishopFrancisWaleOke #AllIrelandOutpouring #FaithInAction #Revival #GospelTruth #ChristianReels' },
    { title: 'The door is not locked 🔥',
      hook: 'The door is not locked. It is not your turn yet.',
      caption: 'The door is not locked. It is not your turn yet.\n\nEleven years of waiting, and Bishop Francis Wale Oke '
        + 'says at the All Ireland Outpouring that nothing on earth holds it shut when it is.\nSome of you needed that today.\n\n'
        + '#BishopFrancisWaleOke #AllIrelandOutpouring #Breakthrough #Revival #FaithInAction #ChristianTikTok' },
    { title: 'Your blessing is not by chance 📖',
      hook: '"Your blessing is not by chance."',
      caption: '"Your blessing is not by chance."\n\nBishop Francis Wale Oke, at the All Ireland Outpouring, on what it '
        + 'costs to serve God with the whole of your heart.\nThat is still true of you today.\n\n'
        + '#BishopFrancisWaleOke #AllIrelandOutpouring #GraceAndMercy #WalkByFaith #GospelTruth #ChristianInspiration' },
  ] });
  let calls = fakeFetch(() => said(THREE));
  cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
  check('it reports itself ready once there is a key', cloudwrite.ready());
  const ai = await copy.suggest({
    mediaPath: 'short-Give_me_this_mountain.mp4', eventName: EVENT, speakers: SPEAKERS, transcript: SERMON,
    llm: { isAvailable: () => cloudwrite.isAvailable(), chat: (a) => cloudwrite.chat(a),
           parseJson: (t) => cloudwrite.parseJson(t) },
  });
  check('the model’s copy is what came back', ai.source === 'ai' && /85/.test(ai.title), ai.title);
  // calls[0] is now the "which models do you have" request (see discoverModels),
  // so the thing to look at is the first one that actually asked for writing.
  const wrote = calls.filter((c) => !c.models);
  check('it went to the right service', /api\.groq\.com/.test(wrote[0].url), wrote[0].url);
  check('and asked one of the big models, not the little one',
    /120b|70b|kimi|qwen3/i.test(wrote[0].model), wrote[0].model);
  check('all three options survived', ai.options.length === 3 && ai.options.every((o) => o.caption.length > 80));
  check('the first line of each one stands alone under 12 words',
    ai.options.every((o) => o.caption.split('\n')[0].trim().split(/\s+/).length <= 12),
    ai.options.map((o) => o.caption.split('\n')[0].split(/\s+/).length).join(', '));

  console.log('\n[6] The second pass sharpens what it scored low and leaves the rest');
  const POLISH = JSON.stringify({ options: [
    { score: 9 },
    { score: 5, title: 'Eleven years, and the door was never locked 🔥',
      caption: 'Eleven years of waiting. The door was never locked.\n\nBishop Francis Wale Oke, at the All Ireland '
        + 'Outpouring: it is not your turn yet, and when it is, nothing on earth holds it shut.\nSome of you needed that today.\n\n'
        + '#BishopFrancisWaleOke #AllIrelandOutpouring #Breakthrough #Revival #FaithInAction #ChristianTikTok' },
    { score: 4, title: 'Too short', caption: 'Nope.' },
  ] });
  calls = fakeFetch((body, n) => said(n === 1 ? THREE : POLISH));
  const polished = await copy.suggest({
    mediaPath: 'short-Give_me_this_mountain.mp4', eventName: EVENT, speakers: SPEAKERS, transcript: SERMON,
    llm: { isAvailable: () => cloudwrite.isAvailable(), chat: (a) => cloudwrite.chat(a),
           parseJson: (t) => cloudwrite.parseJson(t), polish: true },
  });
  check('it really did go back for a second pass', calls.length === 2, calls.length + ' calls');
  const lastMsg = (c) => c.messages[c.messages.length - 1].content;
  check('the editing brief carries the three captions', /OPTION 3/.test(lastMsg(calls[1])));
  check('an option it scored 9 is left exactly as it was',
    polished.options[0].caption === ai.options[0].caption);
  check('an option it scored 5 is replaced by the rewrite',
    /never locked/i.test(polished.options[1].caption), polished.options[1].caption.split('\n')[0]);
  check('►► a "rewrite" that threw the caption away is REFUSED ◄◄',
    polished.options[2].caption.length > 80 && !/^Nope/.test(polished.options[2].caption),
    polished.options[2].caption.split('\n')[0].slice(0, 60));
  check('it says a second pass happened', polished.polished === true);

  console.log('\n[7] A rewrite that dropped the event or the speaker is refused too');
  const BAD_POLISH = JSON.stringify({ options: [
    { score: 3, title: 'Anywhere at all 🔥',
      caption: 'A word for you today.\n\nSomebody somewhere said something true about faith and it '
        + 'was good, and here it is for you now to think about at your leisure.\n\n#Faith #Jesus #Church #Bible #Hope #Grace' },
    { score: 9 }, { score: 9 },
  ] });
  calls = fakeFetch((body, n) => said(n === 1 ? THREE : BAD_POLISH));
  const refused = await copy.suggest({
    mediaPath: 'x.mp4', eventName: EVENT, speakers: SPEAKERS, transcript: SERMON,
    llm: { isAvailable: () => cloudwrite.isAvailable(), chat: (a) => cloudwrite.chat(a),
           parseJson: (t) => cloudwrite.parseJson(t), polish: true },
  });
  check('the option that lost the event name is not used',
    refused.options[0].caption.includes(EVENT), refused.options[0].caption.split('\n')[0]);
  check('and the first pass stands instead', /85|mountain/i.test(refused.options[0].caption));

  /* =================================================================== */
  console.log('\n[8] Every way the cloud can let you down');
  cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
  calls = fakeFetch(() => ({ status: 401, text: 'invalid api key' }));
  const refusedKey = await cloudwrite.chat({ prompt: 'x' });
  check('a refused key gives nothing back rather than throwing', refusedKey === '');
  check('…and it says why, in words an operator can act on',
    /key was refused/i.test(cloudwrite.state().why), cloudwrite.state().why);
  check('…and it stands down instead of asking ten more times', cloudwrite.state().cooling > 0);

  cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
  calls = fakeFetch(() => ({ status: 429, text: 'rate limited' }));
  await cloudwrite.chat({ prompt: 'x' });
  check('a used-up free allowance is reported as exactly that',
    /allowance/i.test(cloudwrite.state().why), cloudwrite.state().why);

  console.log('\n[9] >> A model that was retired does not break the button <<');
  cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
  {
    // The HEAD of the ladder is the one that has gone; everything below answers.
    let head = '';
    calls = fakeFetch((body) => {
      if (!head) head = body.model;
      return body.model === head
        ? { status: 400, text: '{"error":{"code":"model_not_found","message":"' + body.model + ' does not exist"}}' }
        : said('{"ok":true}');
    });
    const after = await cloudwrite.chat({ prompt: 'x' });
    const asked = calls.filter((c) => !c.models).map((c) => c.model);
    check('it walks down to the next model instead of failing', after !== '', JSON.stringify(after));
    check('...having genuinely tried the retired one first', asked[0] === head, asked.join(' -> '));
    check('and it remembers which one answered',
      cloudwrite.state().usingModel === asked[1], cloudwrite.state().usingModel);
  }

  console.log('\n[9b] >> AND THE ONE THAT ACTUALLY BROKE IT <<');
  /*
   * A reasoning model asked for JSON spends its budget thinking and answers
   * 400 json_validate_failed - measured on the operator's own account with
   * gpt-oss-120b. That is not a dead model and not a bad key: the same model
   * answers perfectly with the JSON envelope dropped. It was being treated as a
   * plain failure, so three captions in a row put the writer into a ten-minute
   * sulk and every clip after that was written by the rules. That is the
   * template copy the operator was looking at.
   */
  cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
  {
    calls = fakeFetch((body) => (body.response_format
      ? { status: 400, text: '{"error":{"code":"json_validate_failed","message":"Failed to generate JSON."}}' }
      : said('{"ok":true}')));
    const out = await cloudwrite.chat({ prompt: 'x', json: true });
    const asked = calls.filter((c) => !c.models);
    check('>> it retries the SAME model with the JSON envelope dropped <<', out !== '', JSON.stringify(out));
    check('...the same model, not the next one down',
      asked.length >= 2 && asked[0].model === asked[1].model, asked.map((c) => c.model).join(' -> '));
    check('...and the retry really did drop response_format',
      !!(asked[1] && !asked[1].body.response_format));
    check('the writer is NOT left sulking after it', cloudwrite.state().cooling === 0,
      cloudwrite.state().cooling + 'ms . ' + (cloudwrite.state().why || 'no complaint'));
  }

  console.log('\n[9c] Empty content is the same fault wearing a different hat');
  cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
  {
    // gpt-oss puts its deliberation in `reasoning` and, given a small budget,
    // has nothing left for `content`.
    calls = fakeFetch((body) => (body.response_format
      ? { json: { choices: [{ message: { content: '', reasoning: 'thinking...' } }] } }
      : said('{"ok":true}')));
    const out = await cloudwrite.chat({ prompt: 'x', json: true });
    check('an empty answer gets the same second chance, not a cool-down', out !== '', JSON.stringify(out));
  }

  console.log('\n[9d] It asks the provider what it actually has');
  cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
  {
    // An account with ONLY a model that is not in the preference list at all.
    calls = fakeFetch(() => said('{"ok":true}'), { have: ['some-new-model-nobody-has-heard-of', 'whisper-large-v3'] });
    const out = await cloudwrite.chat({ prompt: 'x' });
    const asked = calls.filter((c) => !c.models).map((c) => c.model);
    check('>> a provider that renamed everything still gets a caption written <<',
      out !== '' && asked[0] === 'some-new-model-nobody-has-heard-of', asked.join(' -> '));
    check('...and it does not try to write with the speech model', !asked.includes('whisper-large-v3'));
  }

  console.log('\n[9e] ...and carries on when it cannot ask');
  cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
  {
    calls = fakeFetch(() => said('{"ok":true}'), { have: null });
    const out = await cloudwrite.chat({ prompt: 'x' });
    const asked = calls.filter((c) => !c.models).map((c) => c.model);
    check('a provider that will not list its models falls back to the built-in order',
      out !== '' && asked.length === 1, asked.join(' -> '));
  }

  console.log('\n[9f] >> A FULL model is not a broken one <<');
  /*
   * Groq meters TOKENS PER MINUTE, per model, with a separate bucket for each.
   * Measured on the operator's account: 8,000 TPM each, and one caption costs
   * about 1,400 - so a single model runs dry after five or six of them. Writing
   * a batch of eight produced two good captions and six templates, because a
   * 429 was treated as "the service is unwell" and stood the writer down for ten
   * minutes. The next model down has its own untouched eight thousand.
   */
  cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
  {
    let full = '';
    calls = fakeFetch((body) => {
      if (!full) full = body.model;
      return body.model === full
        ? { status: 429, text: '{"error":{"message":"Rate limit reached ... tokens per minute (TPM)"}}',
            headers: { 'x-ratelimit-reset-tokens': '57.682s' } }
        : said('{"ok":true}');
    });
    const out = await cloudwrite.chat({ prompt: 'x' });
    const asked = calls.filter((c) => !c.models).map((c) => c.model);
    check('>> it writes the caption with the next model instead of giving up <<',
      out !== '', asked.join(' -> '));
    check('...and the writer is NOT left standing down', cloudwrite.state().cooling === 0,
      cloudwrite.state().cooling + 'ms');
    check('the full model is stood aside for as long as the provider said',
      Math.abs((cloudwrite._limited().get(full) || 0) - Date.now() - 57682) < 2000,
      Math.round(((cloudwrite._limited().get(full) || 0) - Date.now()) / 1000) + 's');

    // ...and the NEXT caption does not waste a round trip on the full one.
    const before = calls.length;
    await cloudwrite.chat({ prompt: 'x' });
    const again = calls.slice(before).filter((c) => !c.models).map((c) => c.model);
    check('the next caption does not knock on that door again', !again.includes(full), again.join(' -> '));
  }

  console.log('\n[9g] ...and when every one of them is full');
  cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
  {
    calls = fakeFetch(() => ({ status: 429, text: 'tokens per minute (TPM)',
      headers: { 'x-ratelimit-reset-tokens': '12s' } }));
    const out = await cloudwrite.chat({ prompt: 'x' });
    check('it gives the rules the caption', out === '');
    check('...and says it is an allowance, in words, with how long',
      /allowance/i.test(cloudwrite.state().why) && /\ds/.test(cloudwrite.state().why),
      cloudwrite.state().why);
    check('...and comes back in about that long, not in ten minutes',
      cloudwrite.state().cooling > 0 && cloudwrite.state().cooling < 30000,
      Math.round(cloudwrite.state().cooling / 1000) + 's');
  }

  console.log('\n[9h] A batch asks for the quick version');
  // [9g] left it standing down on purpose; a fresh configure clears that, the
  // same way saving the settings does.
  cloudwrite.configure({ on: true, provider: 'groq', key: 'gsk_test', model: '' });
  {
    calls = fakeFetch(() => said(THREE));
    const quick = await copy.suggest({
      mediaPath: 'x.mp4', eventName: EVENT, speakers: SPEAKERS, transcript: SERMON, quick: true,
      llm: { isAvailable: () => cloudwrite.isAvailable(), chat: (a) => cloudwrite.chat(a),
             parseJson: (t) => cloudwrite.parseJson(t), polish: true },
    });
    const wrote = calls.filter((c) => !c.models);
    check('>> a batch write costs ONE call, not two <<', wrote.length === 1, wrote.length + ' calls');
    check('...and still comes back written by the model', quick.source === 'ai', quick.options[0].title);
    check('...and did not claim to have been edited twice', quick.polished !== true);
  }


  console.log('\n[10] The key is shared with 🎤 Listen, not asked for twice');
  cloudwrite.configure({ on: true, provider: 'groq', key: '', model: '' });
  cloudwrite.shareKey('groq', '');
  check('with no key anywhere it is not ready', !cloudwrite.ready());
  cloudwrite.shareKey('groq', 'gsk_from_the_listen_panel');
  check('the ear’s key makes the writer ready', cloudwrite.ready());
  check('…and the panel says so rather than showing a key you did not type here',
    cloudwrite.state().borrowingKey === true && cloudwrite.state().hasKey === false);
  cloudwrite.shareKey('openrouter', 'sk-or-someone-elses');
  check('a key for a DIFFERENT service is not borrowed', !cloudwrite.ready());

  console.log('\n[11] Switched off, it is simply not there');
  cloudwrite.configure({ on: false, provider: 'groq', key: 'gsk_test' });
  check('off means off', !cloudwrite.ready() && (await cloudwrite.chat({ prompt: 'x' })) === '');

  /* =================================================================== */
  console.log('\n[12] ►► And the OTHER half: the cloud listening to the video ◄◄');
  // "Let the Groq AI thing listen to the video and do the write." The writing
  // is only as good as the words, and the words used to come from base.en over
  // the first 150 seconds — or, most of the time, from the file name.
  const clip = makeClip();
  check('built a clip with sound in it', clip.ok, clip.why || clip.file);
  if (clip.ok) {
    cloudspeech.configure({ on: false, provider: 'groq', key: 'gsk_test', model: '' });
    check('a FILE can be transcribed even with the live ear switched off',
      cloudspeech.fileReady() && !cloudspeech.ready());

    const posts = [];
    global.fetch = async (url, opts) => {
      // The audio really did arrive as a multipart upload, encoded, not as raw WAV.
      const fd = opts.body;
      posts.push({ url, model: fd.get('model'), size: (fd.get('file') || {}).size || 0,
                   name: (fd.get('file') || {}).name || '' });
      return { ok: true, status: 200, headers: { get: () => null },
               json: async () => ({ text: 'Caleb was eighty five when he said give me this mountain.' }) };
    };
    const heard = await cloudspeech.transcribeFile({ input: clip.file, startSec: 0, endSec: 8, maxSec: 900 });
    check('the words come back', /give me this mountain/i.test(heard || ''), JSON.stringify(heard));
    check('it went to the transcription endpoint, not the chat one',
      /audio\/transcriptions/.test(posts[0].url), posts[0].url);
    check('with the full-size Whisper model', /whisper-large/.test(posts[0].model), posts[0].model);
    check('and the audio was compressed first, not sent as raw WAV',
      /\.ogg$/.test(posts[0].name) && posts[0].size > 0 && posts[0].size < 40000,
      `${posts[0].name}, ${posts[0].size} bytes for 8s`);

    // Long clips are chunked rather than posted as one enormous request.
    posts.length = 0;
    await cloudspeech.transcribeFile({ input: clip.file, startSec: 0, endSec: 8, maxSec: 8 });
    check('a short clip is one request', posts.length === 1, posts.length + ' requests');

    console.log('\n[13] …and when it cannot, this PC still gets its turn');
    global.fetch = async () => ({ ok: false, status: 500, headers: { get: () => null },
                                  json: async () => ({}), text: async () => 'boom' });
    const failed = await cloudspeech.transcribeFile({ input: clip.file, startSec: 0, endSec: 8 });
    check('►► a failure returns null, which is what makes the PC take over ◄◄',
      failed === null, JSON.stringify(failed));
    check('…and it does NOT put the live ear into a sulk, which is a different feature',
      cloudspeech.state().cooling === 0, cloudspeech.state().cooling + 'ms');

    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null },
                                  json: async () => ({ text: '' }) });
    const silent = await cloudspeech.transcribeFile({ input: clip.file, startSec: 0, endSec: 8 });
    check('a clip with no speech answers "" — an answer, not a failure',
      silent === '', JSON.stringify(silent));
  }

  global.fetch = realFetch;
  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { global.fetch = realFetch; console.error(e); process.exit(1); });
