'use strict';
/*
 * GEMINI'S WORDS, WHISPER'S TIMING (captionfuse.fuseGemini + geminiear.js,
 * wired into the studio's own captions:transcribe in main.js).
 *
 * Measured on a real 45-minute sermon: of 129 Whisper mistakes two reviewers
 * found, Gemini had the right words in 71 and the same mistake in only 7 —
 * most of them both Whisper ears made together. So the caption takes Gemini's
 * words and Whisper's timing:
 *   [1] a word both Whisper ears got wrong is Gemini's, in the old word's time
 *   [2] the same word in both: Whisper's timing, Gemini's spelling; quotes and fillers never come in
 *   [3] what Gemini left out stays — unless the second Whisper ear did not hear it either
 *   [4] words only Gemini heard go in where there is room, or where the second ear heard them too
 *   [5] the same words written another way change nothing
 *   [6] where the two do not line up (a skipped or invented passage), Whisper stays
 *   [7] overlapping stretches decide only their own part; the span's ends are decided too
 *   [8] Gemini, free tier: best model, day limits, busy models, time limits, three at a time
 *   [9] end to end through captions:transcribe, with fake Groq + Gemini
 *
 *   node test/caption-third.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fuse = require(path.join(ROOT, 'src/main/captionfuse'));
const gem = require(path.join(ROOT, 'src/main/geminiear'));
let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${m}${d != null && !c ? '  -> ' + JSON.stringify(d) : ''}`); };
/** words of `txt`, one every 0.4 s from t0 (each 0.35 s long) */
const WS = (txt, t0 = 1.2, step = 0.4) => txt.split(' ').map((x, i) => ({ text: x, start: +(t0 + i * step).toFixed(2), end: +(t0 + i * step + 0.35).toFixed(2) }));
const CH = (text, extra) => [Object.assign({ from: 0, to: 60, text }, extra || {})];
const said = (ws) => ws.map((w) => w.text).join(' ');
const F = (w, a, text, extra, opts) => fuse.fuseGemini(w, a, CH(text, extra), opts);

(async () => {
  console.log('\n[1] a mishearing both Whisper ears share');
  {
    const w = WS('they were looking for how to attract God on the same to bring God into reality and answers');
    const r = F(w, w, 'They were looking for how to attract God on the scene, to bring God into reality and answers.');
    ok(/attract God on the scene, to bring God/.test(said(r.words)), 'Gemini\'s word goes in', said(r.words));
    const nw = r.words.find((x) => x.text === 'scene,'), old = w.find((x) => x.text === 'same');
    ok(nw && nw.start === old.start && nw.end === old.end && nw.src === 'gemini', '…in exactly the old word\'s time, marked as Gemini\'s', { nw, old });
    ok(r.stats.overruled === 1 && !r.words.some((x) => x.long), 'one word overruling both Whisper ears is not a "long" overrule', r.stats);
    const w2 = WS('so you have read daddies and when you have read that the first time you go to him');
    const a2 = WS('so you have red daddies and when you have a little dad the first time you go to him');
    const r2 = F(w2, a2, 'So you have real daddies, and when you have real dad, the first time you go to him.');
    ok(said(r2.words) === 'So you have real daddies, and when you have real dad, the first time you go to him.', 'three different hearings: Gemini\'s', said(r2.words));
  }

  console.log('\n[2] the same words');
  {
    const w = WS('and he said go to your mom first and let me know what your mom said');
    const r = F(w, w, '"And he said, “Go to your mom first, and let me know what your mom said.”" Um, uh.');
    ok(said(r.words) === 'And he said, Go to your mom first, and let me know what your mom said.', 'Gemini\'s spelling and punctuation, without quotation marks or fillers', said(r.words));
    ok(r.words.every((x, i) => x.start === w[i].start && x.end === w[i].end && x.src === 'both'), '…every word keeps Whisper\'s timing, marked as heard by both');
    const w3 = WS('a passage the model was unsure of is heard the same by Gemini here');
    w3.forEach((x) => { x.unsure = true; });
    ok(F(w3, w3, 'A passage the model was unsure of is heard the same by Gemini here.').words.every((x) => !x.unsure), 'Whisper\'s own doubt is settled where Gemini heard the same');
  }

  console.log('\n[3] what Gemini left out');
  {
    const w = WS('so so we we are going to pray right now for the nation of Nigeria today amen');
    const r = F(w, w, 'So we are going to pray right now for the nation of Nigeria today, amen.', { atStart: true });
    ok(/^so so we we are/i.test(said(r.words)) && r.stats.kept >= 2, 'repeated words both Whisper ears heard stay', [said(r.words), r.stats]);
    const a1 = w.filter((x, i) => i !== 1 && i !== 3);
    ok(/^So we are going/.test(said(F(w, a1, 'So we are going to pray right now for the nation of Nigeria today, amen.', { atStart: true }).words)), '…repeats the second ear did not hear either are gone',
      said(F(w, a1, 'So we are going to pray right now for the nation of Nigeria today, amen.', { atStart: true }).words));
    const w2 = WS('and run after them ask them praying for forever say wow this is my child');
    const a2 = w2.filter((x) => x.text !== 'praying' && x.text !== 'for');      // the second ear: the same moments, without them
    const r2 = F(w2, a2, 'And run after them, ask them forever, say, wow, this is my child.');
    ok(!/praying/.test(said(r2.words)) && r2.stats.removed === 2, 'words neither Gemini nor the second ear heard are gone', said(r2.words));
    // the second ear's timing drifts: its "that" falls where Whisper put the invented word
    const w4 = WS('please do not let anybody know praying. that this is not the situation at all');
    const a4 = w4.filter((x) => x.text !== 'praying.').map((x) => (x.text === 'that' ? Object.assign({}, x, { start: 3.2, end: 3.5 }) : x));
    const r4 = F(w4, a4, "Please don't let anybody know that this is not the situation at all.");
    ok(!/praying/.test(said(r4.words)), '…even when the second ear\'s timing drifts into the gap', said(r4.words));
    const w3 = WS('we serve a living God praying. and he hears us when we pray');
    const a3 = w3.filter((x) => x.text !== 'praying.');
    ok(said(F(w3, a3, 'We serve a living God and He hears us when we pray.').words).startsWith('We serve a living God. And'), '…a removed word that ended a sentence hands back its full stop',
      said(F(w3, a3, 'We serve a living God and He hears us when we pray.').words));
  }

  console.log('\n[4] words only Gemini heard');
  {
    const w = WS('you may have a you have to approach him as a father with joy');
    // the second ear heard "problem" in the moment Whisper stretched "a" over
    const a = w.slice(0, 3).concat([{ text: 'a', start: 2.4, end: 2.6 }, { text: 'problem', start: 2.6, end: 2.95 }], w.slice(4));
    const r = F(w, a, 'You may have a problem. You have to approach him as a father with joy.');
    const p = r.words.find((x) => x.text === 'problem.');
    const before = r.words[r.words.indexOf(p) - 1], after = r.words[r.words.indexOf(p) + 1];
    ok(p && p.start >= before.end - 1e-6 && p.end <= after.start + 1e-6 && p.end > p.start, 'a word Whisper dropped (the second ear heard it) goes in, between its neighbours', { before, p, after });
    const w2 = WS('telling them as are making the ark the corner piece must be gold');
    const r2 = F(w2, w2, 'Telling them, as you are making the ark, the corner piece must be gold.');
    ok(!/as you are/.test(said(r2.words)), 'no room in Whisper\'s timing and no second ear: not added', said(r2.words));
    const a2b = w2.slice(0, 3).concat([{ text: 'as', start: 2.0, end: 2.15 }, { text: 'we', start: 2.15, end: 2.35 }], w2.slice(4));
    ok(/as you are making/i.test(said(F(w2, a2b, 'Telling them, as you are making the ark, the corner piece must be gold.').words)),
      '…but where the second ear heard a word there too ("we"), Gemini\'s goes in', said(F(w2, a2b, 'Telling them, as you are making the ark, the corner piece must be gold.').words));
    const w3 = WS('the Lord is my shepherd').concat(WS('I shall not want for anything at all', 4.0));
    const r3 = F(w3, w3, 'The Lord is my shepherd, the Lord God, I shall not want for anything at all.');
    ok(/shepherd, the Lord God, I shall/.test(said(r3.words)), 'where Whisper left a gap, words only Gemini heard fill it', said(r3.words));
  }

  console.log('\n[5] the same words, written another way');
  {
    const w = WS('we are gonna read it now and it is every day that God loves us all');
    const r = F(w, w, "We are going to read it now and it's everyday that God loves us all.");
    ok(/gonna read/.test(said(r.words)) && /it is every day/.test(said(r.words)), 'gonna / going to, it is / it\'s, every day / everyday: Whisper\'s stays', said(r.words));
  }

  console.log('\n[6] where the two do not line up');
  {
    const w = WS('and the Lord said to Moses go down to Egypt and tell Pharaoh let my people go');
    const r = F(w, w, 'Thank you for watching. Please like and subscribe to our channel for more.');
    ok(said(r.words) === said(w) && r.stats.skipped === 1, 'an answer that is not this stretch at all changes nothing', r.stats);
    const w2 = WS('first we pray then we worship and the pastor reads the word for today and then we give');
    const r2 = F(w2, w2, 'First we pray, then we worship, and the brothers and sisters of the choir come forward to sing three songs from the hymn book before the offering, and then we give.');
    ok(/the pastor reads the word for today/.test(said(r2.words)), 'a long passage only Gemini wrote does not replace what Whisper heard', said(r2.words));
    const w3 = WS('the grace of our Lord', 1.2, 0.4).concat(WS('be with you', 3.2, 0.3));
    const r3 = F(w3, w3, 'The grace of our Lord Jesus Christ and the love of God and the fellowship be with you.');
    ok(/Lord be with you/.test(said(r3.words)) || /Lord,? be with you/.test(said(r3.words)), 'more words than fit in the time Whisper heard: not squeezed in', said(r3.words));
  }

  {
    const w = WS('it is a mighty God ha ha ha ha it is a mighty God ha ha ha ha no liars enter the kingdom of heaven');
    const r = F(w, w, 'It is a mighty God. Hey, is that my tig? No liars enter the kingdom of heaven.');
    ok(/ha ha ha ha no liars/i.test(said(r.words)), 'a stretch Gemini summed up in far fewer words keeps Whisper\'s', said(r.words));
  }

  console.log('\n[7] overlapping stretches');
  {
    const w = WS('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 0.2, 0.5);
    const words = w.map((x) => Object.assign({}, x, { text: x.text.replace('seven', 'heaven') }));
    const chunks = [
      { from: 0, to: 5.5, own0: 0, own1: 4, atStart: true, text: 'One two three four five six seven eight nine ten eleven' },
      { from: 2.5, to: 8.3, own0: 4, own1: 8.3, atEnd: true, text: 'Six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen' },
    ];
    const r = fuse.fuseGemini(words, words, chunks);
    ok(said(r.words).split(' ').filter((t) => /^seven/i.test(t)).length === 1 && !/heaven/.test(said(r.words)), 'a word in both stretches is decided once', said(r.words));
    const w2 = WS('father who art in heaven hallowed be thy name thy kingdom come', 0.1);
    const r2 = fuse.fuseGemini(WS('farther who art in heaven hallowed be thy name thy kingdom come', 0.1), w2, [{ from: 0, to: 30, atStart: true, atEnd: true, text: 'Father, who art in heaven, hallowed be thy name, thy kingdom come.' }]);
    ok(said(r2.words).startsWith('Father, who art') && said(r2.words).endsWith('kingdom come.'), 'the first and last words of a span are decided too', said(r2.words));
  }

  console.log('\n[7b] a long overrule is listed');
  {
    const w = WS('he said to me go and sell all you have and give to the poor and follow');
    const r = F(w, w, 'He said to me, go and tell all the people you see to give to the poor and follow.');
    ok(r.words.some((x) => x.long) && r.stats.long === 1, 'Gemini overruling BOTH Whisper ears on a long phrase is marked for a look', r.stats);
  }

  console.log('\n[7c] found by review');
  {
    const mono = (ws) => ws.every((w, i) => w.end >= w.start && (i === 0 || w.start >= ws[i - 1].start - 1e-6));
    // two stretches that both claim the end (a span 3 s past a stretch edge): nothing done twice, no crash
    const w = WS('they say ask them praying for forever say wow this is my child Thank you.', 290, 0.8);
    const a = w.filter((x) => !/^(praying|for|Thank|you\.)$/.test(x.text));
    const both = [{ from: 0, to: 303, own0: 0, own1: 300, atStart: true, atEnd: true, text: 'They say ask them forever, say wow, this is my child.' },
      { from: 294, to: 303, own0: 300, atEnd: true, text: 'They say ask them forever, say wow, this is my child.' }];
    let r1 = null, err = null;
    try { r1 = fuse.fuseGemini(w, a, both); } catch (e) { err = e; }
    ok(!err && /ask them forever, say wow, this is my child/i.test(said(r1.words)) && !/forever say wow.*forever/i.test(said(r1.words)), 'two stretches claiming the same end: each change made once, no crash', err ? err.message : said(r1.words));
    // a block running over a seam: the first decision on a word stands, nothing doubled or lost
    const s2 = WS('amazing grace how sweat a town that saved a wretch like me I once was lost', 7.0, 0.5);
    const seam = [
      { from: 0, to: 10.6, own0: 0, own1: 10, atStart: true, text: 'Amazing grace, how sweet the sound which saved a wretch like me.' },
      { from: 9.4, to: 20, own0: 10, own1: 20, atEnd: true, text: 'Amazing grace how sweat a town saved a wretch like me, I once was lost.' },
    ];
    const r2 = fuse.fuseGemini(s2, s2.filter((x) => x.text !== 'that'), seam);
    const t2 = said(r2.words);
    ok((t2.match(/saved/g) || []).length === 1 && !/which that|that that/.test(t2) && mono(r2.words), 'a change at a seam is made once (nothing lost, nothing doubled, still in order)', t2);
    // a word only Gemini heard, in a long silence with nothing to say when: not guessed
    const w3 = WS('and we give him all the glory', 1.0).concat(WS('let us stand and pray', 45));
    const r3 = F(w3, null, 'And we give Him all the glory. Amen. Let us stand and pray.', { atStart: true, atEnd: true });
    ok(!r3.words.some((x) => /^amen/i.test(x.text)), 'an "Amen." somewhere in a 40 s song is not held on screen for 40 s', r3.words.filter((x) => /amen/i.test(x.text)));
    const a3 = w3.concat([{ text: 'amen', start: 4.1, end: 4.5 }]).sort((p, q) => p.start - q.start);
    const r3b = F(w3, a3, 'And we give Him all the glory. Amen. Let us stand and pray.', { atStart: true, atEnd: true });
    const am = r3b.words.find((x) => /^amen/i.test(x.text));
    ok(am && am.start >= 4.0 && am.end <= 4.6, '…but where the second ear heard it, it goes in at the second ear\'s time', am);
    // Gemini's notes about the room are never words
    const w4 = WS('you have your week but God said you will be healed today');
    const r4 = F(w4, w4, 'You have your week. (Laughter) But God said, *applause* you will be healed today.');
    ok(!/laughter|applause/i.test(said(r4.words)), '"(Laughter)", "*applause*": not caption words', said(r4.words));
    // more words than the old ones' time: spread into the room around them, in order, never past the next word
    const w5 = WS('brothers and sisters', 0.6, 0.4).concat([{ text: 'oh', start: 3.4, end: 3.6 }], WS('let us pray now', 3.6, 0.4));
    const r5 = F(w5, null, 'Brothers and sisters, the Lord said go down to Egypt. Let us pray now.', { atStart: true, atEnd: true });
    const lt = r5.words.find((x) => /^let$/i.test(x.text)), eg = r5.words.find((x) => /^egypt/i.test(x.text));
    ok(mono(r5.words) && (!eg || eg.end <= lt.start + 1e-6), 'new words never run past the next word, and stay in order', r5.words.map((x) => [x.text, x.start, x.end]));
    // a repeat both Whisper ears heard stays, even though Gemini tidied it away
    const w6 = WS('I know that we we are going to the nation');
    const r6 = F(w6, w6, 'I know that we are going to the nation.');
    ok(/that we we are/i.test(said(r6.words)), '"we we" that both Whisper ears heard is kept', said(r6.words));
    // Gemini only left out a repeat: the words it kept keep their own Whisper times
    const w7 = [{ text: 'so', start: 1.0, end: 1.2 }, { text: 'so', start: 1.2, end: 1.4 }, { text: 'we', start: 4.0, end: 4.2 }, { text: 'we', start: 4.2, end: 4.4 }].concat(WS('are going to pray now amen', 4.4, 0.3));
    const a7 = w7.filter((x, i) => i !== 1 && i !== 3);
    const r7 = F(w7, a7, 'So we are going to pray now, amen.', { atStart: true, atEnd: true });
    const we = r7.words.find((x) => /^we$/i.test(x.text));
    ok(/^So we are going/.test(said(r7.words)) && we && we.start >= 4.0, '"so so … we we" → "So we", each word still at its own time', r7.words.slice(0, 3));
  }

  console.log('\n[8] Gemini, free tier');
  {
    process.env.GEMINI_API_KEY = 'test-gemini';
    const order = ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-preview-tts'];
    const listing = { models: order.map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) };
    const asked = [];
    const fake = (dayGone) => async (url, o) => {
      if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => listing };
      const model = decodeURIComponent((/models\/([^:]+):generateContent/.exec(url) || [])[1] || '');
      asked.push(model);
      if (dayGone.includes(model)) return { ok: false, status: 429, json: async () => ({ error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 250', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }) };
      const body = JSON.parse(o.body);
      ok(body.contents[0].parts[0].inline_data.mime_type === 'audio/flac', 'the audio goes as lossless FLAC (' + model + ')');
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Speaker 1: Good morning [music] church.' }] } }] }) };
    };
    gem._reset();
    ok(await gem.pickModel(fake([])) === 'gemini-2.5-flash', 'the newest full flash model is chosen — never lite, pro or a speech model');
    const r = await gem.hear(Buffer.from('fLaC'), { fetchImpl: fake(['gemini-2.5-flash']), waits: [1] });
    ok(r.model === 'gemini-2.5-pro' || r.model === 'gemini-2.0-flash', 'a model whose day is used up is set aside for the next', { r, asked });
    ok(r.text === 'Good morning church.', 'labels and [music] notes are not words', r.text);
    gem._reset(); asked.length = 0;
    const span = await gem.transcribeSpan({ input: 'x', from: 0, to: 900, chunkSec: 300, encode: async () => Buffer.from('fLaC'),
      fetchImpl: fake(order), waits: [1], retryAfterMs: 1 });
    ok(span.chunks.length === 0 && span.failed === 3 && /used up/.test(span.why), 'every model used up: the rest of the span is not tried in vain', span);
    // (flash-lite is in the list too now: its own daily allowance, after every flash)
    ok(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'].every((m) => asked.filter((x) => x === m).length <= 3) && asked.length <= 12,
      '…each model asked at most once per stretch already under way, then it stops', asked);
    gem._reset();

    // a request that hangs is given up (and the stretch counted), never waited on for ever
    const hang = async (url, o) => {
      if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => listing };
      return new Promise((resolve, reject) => o.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    };
    const t0 = process.hrtime.bigint();
    const hung = await gem.hear(Buffer.from('x'), { fetchImpl: hang, waits: [1], timeoutMs: 200 }).catch((e) => e);
    ok(hung instanceof Error && /no answer in time/.test(hung.message) && Number(process.hrtime.bigint() - t0) / 1e6 < 2000, 'a hung request gives up after its time limit', hung && hung.message);
    gem._reset();

    // newer models: as little thinking as they allow; a setting refused is stepped down, then left out
    process.env.MW_GEMINI_MODEL = 'gemini-3-flash';
    const configs = [];
    const think = async (url, o) => {
      const b = JSON.parse(o.body); configs.push(JSON.stringify(b.generationConfig.thinkingConfig || null));
      ok(b.safetySettings && b.safetySettings.every((x) => x.threshold === 'BLOCK_NONE'), 'scripture is never filtered out (safety: BLOCK_NONE)');
      if (configs.length < 3) return { ok: false, status: 400, json: async () => ({ error: { message: 'bad thinking' } }) };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ thought: true, text: 'Let me think' }, { text: 'Amen.' }] }, finishReason: 'STOP' }] }) };
    };
    const th = await gem.hear(Buffer.from('x'), { fetchImpl: think, waits: [1] });
    ok(configs.join('|') === '{"thinkingLevel":"minimal"}|{"thinkingLevel":"low"}|null' && th.text === 'Amen.', 'minimal → low → none; its thoughts are not the transcript', { configs, th });
    // measured: a stretch once came back translated into Arabic — asked again in English, never used
    const tries = [];
    const arabic = (times) => async (url, o) => {
      tries.push(JSON.parse(o.body).contents[0].parts[1].text);
      const t = tries.length <= times ? 'بغض النظر عن الأسباب التي جعلتك ترغب' : 'Whatever the reasons that made you want to remember the story.';
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: 'STOP' }] }) };
    };
    const ar1 = await gem.hear(Buffer.from('x'), { fetchImpl: arabic(1), waits: [1] });
    ok(ar1.text.startsWith('Whatever the reasons') && tries.length === 2 && /Do not translate/.test(tries[1]), 'an answer in another language is asked again, firmly, in English', { ar1, tries: tries.length });
    tries.length = 0;
    const ar2 = await gem.hear(Buffer.from('x'), { fetchImpl: arabic(2), waits: [1] }).catch((e) => e);
    ok(ar2 instanceof Error && /another language/.test(ar2.message), '…and never used if it comes back translated again', ar2 && ar2.message);
    ok(/never translate/.test(gem.promptFor([])) && gem.latinShare('Olúwa ṣeun Ọlọ́run, amen') === 1, 'the prompt says English; Yoruba letters count as written in English letters');
    // a stretch held back (recitation/safety) with nothing written is a failed stretch, not an empty one
    const held = await gem.hear(Buffer.from('x'), { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'RECITATION' }] }) }), waits: [1] }).catch((e) => e);
    ok(held instanceof Error && /recitation/.test(held.message), 'a stretch Gemini held back is said, not taken as silence', held && held.message);
    delete process.env.MW_GEMINI_MODEL; gem._reset();

    // three stretches at once, and back in order whatever order they finish in
    let live = 0, most = 0, k = 0;
    const slow = async (url, o) => {
      if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => listing };
      const me = ++k; live++; most = Math.max(most, live);
      await new Promise((r) => setTimeout(r, me % 2 ? 120 : 20));
      live--;
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'part ' + me }] }, finishReason: 'STOP' }] }) };
    };
    const enc = async (input, a) => Buffer.from(String(a));
    const heardAt = [];
    const enc2 = async (input, a, d) => { heardAt.push([a, +(a + d).toFixed(3)]); return Buffer.from(String(a)); };
    const sp = await gem.transcribeSpan({ input: 'x', from: 100, to: 1600, chunkSec: 300, encode: enc2, fetchImpl: slow, waits: [1] });
    ok(most === 3 && sp.chunks.length === 5 && sp.failed === 0, 'a 25-minute span: five stretches, three at a time', { most, n: sp.chunks.length });
    ok(sp.chunks.every((c, i) => c.own0 === i * 300 && c.own1 === Math.min(1500, (i + 1) * 300)), '…in order, each deciding its own five minutes on the span\'s clock', sp.chunks);
    ok(sp.chunks.every((c, i) => c.from === Math.max(0, c.own0 - 6) && c.to === Math.min(1500, c.own1 + 6)) && sp.chunks[0].atStart && sp.chunks[4].atEnd && !sp.chunks[2].atStart,
      '…heard 6 s past its edges (no word falls between two stretches)', sp.chunks.map((c) => [c.from, c.to, c.atStart, c.atEnd]));
    ok(heardAt.some(([a, b]) => a === 394 && b === 706), '…the audio sent is that wider window', heardAt);
    gem._reset();

    // "high demand": one short wait, then another model hears that stretch
    const seenBusy = [];
    const busyFetch = async (url) => {
      if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => listing };
      const model = decodeURIComponent((/models\/([^:]+):generateContent/.exec(url) || [])[1] || '');
      seenBusy.push(model);
      if (model === 'gemini-2.5-flash') return { ok: false, status: 503, json: async () => ({ error: { code: 503, message: 'This model is currently experiencing high demand.' } }) };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'heard by ' + model }] }, finishReason: 'STOP' }] }) };
    };
    const hb = await gem.hear(Buffer.from('x'), { fetchImpl: busyFetch, waits: [1] });
    ok(hb.model !== 'gemini-2.5-flash' && seenBusy.filter((m) => m === 'gemini-2.5-flash').length === 2, 'a busy model: waited once, then the next model heard it', seenBusy);
    gem._reset();

    // a stretch that failed for a passing reason is asked once more at the end
    let calls = 0;
    const flaky = async (url) => {
      if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }) };
      calls++;
      if (calls === 2 || calls === 3) return { ok: false, status: 500, json: async () => ({ error: { message: 'internal' } }) };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok ' + calls }] }, finishReason: 'STOP' }] }) };
    };
    const fl = await gem.transcribeSpan({ input: 'x', from: 0, to: 600, chunkSec: 300, encode: enc, fetchImpl: flaky, waits: [1], together: 1, retryAfterMs: 1 });
    ok(fl.chunks.length === 2 && fl.failed === 0 && !fl.why, 'a stretch that failed is heard again at the end: nothing missing', fl);
    gem._reset();

    console.log('\n[8b] found by review');
    const listing1 = { models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.8-pro-preview', supportedGenerationMethods: ['generateContent'] }] };
    ok(gem.rankModel('gemini-2.0-flash') > gem.rankModel('gemini-3.8-pro-preview'), 'every flash model ranks above any pro');
    ok(gem.rankModel('gemini-2.0-flash') > gem.rankModel('gemini-3.8-flash-lite') && gem.rankModel('gemini-2.0-flash-lite') > gem.rankModel('gemini-3.8-pro'), 'flash-lite after every flash, before pro');
    const longDaily = { error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details. ' + 'x'.repeat(520), status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' }] } };
    let n429 = 0;
    const day = async (url) => {
      if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => listing1 };
      n429++; return { ok: false, status: 429, json: async () => longDaily };
    };
    gem._reset();
    const t8 = Date.now();
    const d8 = await gem.hear(Buffer.from('x'), { fetchImpl: day, waits: [5000, 5000, 5000] }).catch((e) => e);
    ok(d8 instanceof Error && d8.exhausted && Date.now() - t8 < 2000 && n429 === 2, 'a used-up day is seen at once (no waiting on each model)', { ms: Date.now() - t8, n429, msg: d8 && d8.message });
    const until = [...gem._spent().values()][0];
    const pac = gem.nextPacificMidnight(Date.UTC(2026, 9, 8, 6, 51));
    ok(until && until - Date.now() <= 25 * 3600e3 && new Date(pac).toISOString() === '2026-10-08T07:01:00.000Z'
      && new Date(gem.nextPacificMidnight(Date.UTC(2026, 11, 8, 6, 51))).toISOString() === '2026-12-08T08:01:00.000Z', 'set aside until just after Pacific midnight (summer and winter time)', new Date(pac).toISOString());
    let dTries = 0;
    const down = async (url) => { if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => listing1 }; dTries++; throw new Error('getaddrinfo ENOTFOUND'); };
    gem._reset();
    const t9 = Date.now();
    const sp9 = await gem.transcribeSpan({ input: 'x', from: 0, to: 2700, chunkSec: 300, encode: async () => Buffer.from('f'), fetchImpl: down, waits: [1], together: 1, retryAfterMs: 1 });
    ok(sp9.chunks.length === 0 && sp9.failed === 9 && dTries <= 4 && Date.now() - t9 < 3000 && /could not reach/.test(sp9.why), 'Gemini unreachable: given up after the first stretch, quickly', { dTries, ms: Date.now() - t9, why: sp9.why });
    let kTries = 0;
    const badKey = async (url) => { if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => listing1 }; kTries++; return { ok: false, status: 400, json: async () => ({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }) }; };
    gem._reset();
    const sp10 = await gem.transcribeSpan({ input: 'x', from: 0, to: 900, chunkSec: 300, encode: async () => Buffer.from('f'), fetchImpl: badKey, waits: [1], together: 1, retryAfterMs: 1 });
    ok(sp10.chunks.length === 0 && /refused the key/.test(sp10.why) && kTries <= 2, 'a refused key: said once, not retried stretch by stretch', { kTries, why: sp10.why });
    gem._reset();
    const sp11 = await gem.transcribeSpan({ input: 'x', from: 0, to: 303, chunkSec: 300, encode: async () => Buffer.from('f'), fetchImpl: async (url) => (/\/models\?/.test(url)
      ? { ok: true, status: 200, json: async () => listing1 } : { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Amen.' }] }, finishReason: 'STOP' }] }) }), waits: [1] });
    ok(sp11.chunks.length === 2 && !sp11.chunks[0].atEnd && sp11.chunks[1].atEnd && sp11.chunks[0].atStart && !sp11.chunks[1].atStart, 'a 303 s span: only the last stretch is the end', sp11.chunks.map((c) => [c.atStart, c.atEnd]));
    const jobsMod = require(path.join(ROOT, 'src/main/jobs'));
    gem._reset();
    const hangG = async (url, o) => (/\/models\?/.test(url) ? { ok: true, status: 200, json: async () => listing1 }
      : new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const t12 = Date.now();
    setTimeout(() => jobsMod.cancel('job-cancel-test'), 300);
    const c12 = await jobsMod.run('job-cancel-test', () => gem.hear(Buffer.from("x"), { fetchImpl: hangG, waits: [1], timeoutMs: 60000 })).catch((e) => e);
    ok(c12 && (c12.cancelled || jobsMod.isCancelError(c12)) && Date.now() - t12 < 2000, 'Cancel stops a request still waiting on Gemini, at once', { ms: Date.now() - t12, err: c12 && c12.message });
    gem._reset();
  }


  console.log('\n[9] end to end: captions:transcribe, Gemini\'s words with Whisper\'s timing');
  {
    const os = require('os'), fs = require('fs');
    const INPUT = path.join(__dirname, 'fixtures', 'sermon-dry.flac');
    const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-third-'));
    require(path.join(ROOT, 'src/cloud/electron-shim')).install({ dataDir: path.join(WORK, 'userData'), mediaDir: WORK, version: 'test' });
    const sched = require(path.join(ROOT, 'src/main/scheduler'));
    if (sched.Scheduler) sched.Scheduler.prototype.start = function () { return this; };
    require(path.join(ROOT, 'src/main/autopost')).startHeartbeat = () => ({ stop() {} });
    const rpc = require(path.join(ROOT, 'src/main/rpc'));
    require(path.join(ROOT, 'src/main/main.js'));
    await new Promise((r) => setTimeout(r, 600));
    const cs = require(path.join(ROOT, 'src/main/cloudspeech'));
    let SAY = {
      'whisper-large-v3': 'and the presence of God came on the same and sad peace be still today',
      'whisper-large-v3-turbo': 'and the presents of God came on the same and said peace be still today',
    };
    let GEM = 'And the presence of God came on the scene and said, peace, be still today.';
    const W = (txt) => ({
      words: txt.split(' ').map((x, i) => ({ word: x, start: 0.2 + i * 0.4, end: 0.55 + i * 0.4 })),
      segments: [{ start: 0.2, end: 0.2 + txt.split(' ').length * 0.4, text: txt, avg_logprob: -0.2, no_speech_prob: 0, compression_ratio: 1.2 }],
    });
    const seen = { gemini: 0, reader: 0, read: 0 };
    global.fetch = async (url, o) => {
      url = String(url);
      if (/generativelanguage/.test(url) && /\/models\?/.test(url)) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }) };
      if (/generativelanguage/.test(url) && /proofreading/.test(o.body)) { seen.read++; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"fixes":[]}' }] }, finishReason: 'STOP' }] }) }; }
      if (/generativelanguage/.test(url)) { seen.gemini++; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: GEM }] }, finishReason: 'STOP' }] }) }; }
      if (/chat\/completions/.test(url)) { seen.reader++; return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) }; }
      const m = o.body.get('model');
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => W(SAY[m]) };
    };
    process.env.GEMINI_API_KEY = 'test-gemini';
    gem._reset();
    cs.configure({ on: true, provider: 'groq', key: 'gsk_test' });
    const run = async () => { const res = await rpc.invoke('captions:transcribe', { input: INPUT, startSec: 0, endSec: 6, model: 'cloud' }); return res && res.ok !== undefined ? res.data : res; };
    const out = await run();
    const text = out && out.words.map((w) => w.text).join(' ');
    ok(seen.gemini === 1 && seen.reader === 0 && seen.read === 1, 'Gemini heard the clip once and proofread it once; no other AI was asked', seen);
    ok(out && out.check.relisten && out.check.relisten.windows === 1 && out.check.relisten.changed === 0, '…the proofreader found nothing to put right here', out && out.check.relisten);
    ok(text === 'And the presence of God came on the scene and said, peace, be still today.', 'the caption is Gemini\'s: "on the scene", "said"', text);
    const sc = out && out.words.find((w) => w.text === 'scene');
    ok(sc && Math.abs(sc.start - (0.2 + 8 * 0.4)) < 0.01, '…with Whisper\'s timing', sc);
    const t = out && out.check && out.check.third;
    ok(t && t.model === 'gemini-2.5-flash' && t.heard === 1 && t.replaced === 3 && t.stretches === 1, 'the answer says what the third ear did', t);
    ok(out && !out.words.some((w) => w.doubt) && t.settled >= 1, 'nothing Gemini settled is left listed for a look (presence/presents, sad/said)', out && out.words.filter((w) => w.doubt));
    ok(t && Array.isArray(t.texts) && /on the scene/.test(t.texts[0].text), 'what Gemini heard comes back with the answer', t && t.texts);
    ok(out && / \+ Google Gemini 2\.5 Flash$/.test(out.engineName), 'and the answer names both ears', out && out.engineName);

    // Gemini overrules BOTH Whisper ears on a long phrase: its words, listed for a look with Whisper's hearing offered
    SAY = { 'whisper-large-v3': 'and he said go and sell all you have and give to the poor today', 'whisper-large-v3-turbo': 'and he said go and sell all you have and give to the poor today' };
    GEM = 'And he said, go and tell all the people you see to give to the poor today.';
    const out2 = await run();
    const d = out2 && out2.words.filter((w) => w.doubt).map((w) => w.text);
    ok(out2 && /go and tell all the people you see to give/.test(out2.words.map((w) => w.text).join(' ')), 'a long overrule: Gemini\'s words', out2 && out2.words.map((w) => w.text).join(' '));
    ok(d && d.length >= 4 && d.includes('tell'), '…listed for a look', d);
    ok(out2 && out2.check.alt.some((w) => w.text === 'sell'), '…with what Whisper heard as the one-tap alternative', out2 && out2.check.alt.map((w) => w.text).join(' '));

    // the Groq allowance used up: this server's own model gives the timing, Gemini still gives the words
    {
      const captioner = require(path.join(ROOT, 'src/main/captioner'));
      const real = { transcribe: captioner.transcribe, isAvailable: captioner.isAvailable };
      const pcWords = 'and the presence of God came on the same and sad peace be still today'.split(' ').map((x, i) => ({ text: x, start: 0.2 + i * 0.4, end: 0.55 + i * 0.4 }));
      captioner.isAvailable = () => true;
      captioner.transcribe = async () => ({ words: pcWords.map((w) => Object.assign({}, w)), segments: [], durationSec: 6 });
      GEM = 'And the presence of God came on the scene and said, peace, be still today.';
      const before = global.fetch;
      global.fetch = async (url, o) => {
        if (/groq\.com\/openai\/v1\/audio/.test(String(url))) return { ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '3600' : null) }, json: async () => ({}) };
        return before(url, o);
      };
      seen.gemini = 0;
      const out4 = await run();
      global.fetch = before; captioner.transcribe = real.transcribe; captioner.isAvailable = real.isAvailable;
      const t4 = out4 && out4.words.map((w) => w.text).join(' ');
      ok(out4 && out4.engine === 'pc' && /used up/.test(out4.cloudWhy || ''), 'Groq used up: heard on this server, and the answer says why', out4 && { engine: out4.engine, why: out4.cloudWhy });
      ok(t4 === 'And the presence of God came on the scene and said, peace, be still today.' && seen.gemini === 1, '…but the words are still Gemini\'s ("on the scene")', t4);
      ok(out4 && / \+ Google Gemini 2\.5 Flash$/.test(out4.engineName || '') && out4.check && out4.check.third.heard === 1, '…and the answer names both', out4 && out4.engineName);
      // …and when Gemini cannot be heard either, the answer still says so, and why
      captioner.isAvailable = () => true;
      captioner.transcribe = async () => ({ words: pcWords.map((w) => Object.assign({}, w)), segments: [], durationSec: 6 });
      global.fetch = async (url, o) => {
        if (/groq\.com\/openai\/v1\/audio/.test(String(url))) return { ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '3600' : null) }, json: async () => ({}) };
        if (/generativelanguage/.test(String(url)) && !/\/models\?/.test(String(url))) return { ok: false, status: 429, json: async () => ({ error: { message: 'Quota exceeded, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }) };
        return before(url, o);
      };
      gem._reset();
      const out4b = await run();
      global.fetch = before; captioner.transcribe = real.transcribe; captioner.isAvailable = real.isAvailable; gem._reset();
      ok(out4b && out4b.words.length === 15 && out4b.check && out4b.check.third && out4b.check.third.heard === 0 && /used up/.test(out4b.check.third.why), 'Groq and Gemini both used up: the server\'s words, and the answer says why Gemini is missing', out4b && { n: out4b.words.length, t: out4b.words.map((w) => w.text).join(' ') });
    }

    // a Gemini key, but Gemini's day is used up: Whisper's words, every one of them (measured live:
    // a bug here once handed back NO words at all whenever Gemini could not be heard)
    {
      const before = global.fetch;
      global.fetch = async (url, o) => {
        if (/generativelanguage/.test(String(url)) && !/\/models\?/.test(String(url))) {
          return { ok: false, status: 429, json: async () => ({ error: { message: 'Quota exceeded, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }) };
        }
        return before(url, o);
      };
      gem._reset();
      const out5 = await run();
      global.fetch = before; gem._reset();
      const t5 = out5 && out5.words.map((w) => w.text).join(' ');
      ok(out5 && out5.words.length === 15 && /he said go and sell all you have and give to the poor today/.test(t5), 'Gemini used up: the captions are Whisper\'s — all 15 words, none lost', t5);
      ok(out5 && out5.check.third && out5.check.third.heard === 0 && /used up/.test(out5.check.third.why) && !/Gemini/.test(out5.engineName), '…and the answer says Gemini could not be heard, and why', out5 && out5.check.third);
    }

    // Remove pauses by the words works (found by review: a stray reference made every search throw)
    {
      SAY = { 'whisper-large-v3': 'and the presence of God came on the scene and said peace be still today', 'whisper-large-v3-turbo': 'and the presence of God came on the scene and said peace be still today' };
      const sp = await rpc.invoke('video:speechPauses', { input: INPUT, startSec: 0, endSec: 6, minSilenceSec: 0.7, padSec: 0.12, jobId: 'pause-test' });
      const pv = sp && sp.ok !== undefined ? sp.data : sp;
      ok(pv && !pv.fallback && pv.engine === 'cloud' && pv.transcript && pv.transcript.words.length === 15, 'Remove pauses (by the words) answers with the words, no error', sp && (sp.error || { fallback: pv.fallback, why: pv.why, engine: pv.engine, n: pv.transcript && pv.transcript.words.length }));
    }

    // what the proofreader doubted and the audio could not settle is listed — also with no second ear
    {
      const before = global.fetch;
      SAY = { 'whisper-large-v3': 'and the presence of God came on the scene and sad peace be still today', 'whisper-large-v3-turbo': 'fail' };
      GEM = 'And the presence of God came on the scene and sad, peace, be still today.';
      global.fetch = async (url, o) => {
        url = String(url);
        if (/generativelanguage/.test(url) && /proofreading/.test(o.body)) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"fixes":[{"line":1,"heard":"sad,","likely":"said,"}]}' }] }, finishReason: 'STOP' }] }) };
        if (/generativelanguage/.test(url) && /Clip 1:/.test(o.body)) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"answers":[{"clip":1,"choice":0}]}' }] }, finishReason: 'STOP' }] }) };
        if (/audio\/transcriptions/.test(url) && o.body.get('model') === 'whisper-large-v3-turbo') return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
        return before(url, o);
      };
      gem._reset();
      const out6 = await run();
      global.fetch = before; gem._reset();
      const d6 = out6 && out6.words.filter((w) => w.doubt).map((w) => w.text);
      ok(out6 && out6.check && !out6.check.checked && out6.check.relisten && out6.check.relisten.unsure === 1 && d6 && d6.length >= 1 && /sad/.test(d6.join(' ')), 'no second ear, the audio could not settle "sad": still listed for a look', { d6, rl: out6 && out6.check.relisten });
      GEM = 'And the presence of God came on the scene and said, peace, be still today.';
    }

    // no Gemini key: exactly the captions there were before
    SAY = { 'whisper-large-v3': 'and the presence of God came on the same and sad peace be still today', 'whisper-large-v3-turbo': 'and the presents of God came on the same and said peace be still today' };
    delete process.env.GEMINI_API_KEY; seen.gemini = 0;
    const out3 = await run();
    ok(seen.gemini === 0 && out3 && !out3.check.third && /on the same/.test(out3.words.map((w) => w.text).join(' ')) && !/Gemini/.test(out3.engineName), 'no key: no third ear, nothing else changes', out3 && out3.check);
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
