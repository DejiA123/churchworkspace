'use strict';
/*
 * THE SECOND HEAD: EVERY QUOTE IN A POST IS THE WORDS (social-copy.js fixQuotes).
 *
 * "Make those AI write-ups better: a second head, like the captions in the
 * Video Studio — accurate with the words." Every quote the writer puts in a
 * caption is looked for in the words — the captions the church checked when
 * there are any, else what was heard — capitals and punctuation ignored:
 *   [1] a quote that is the words, word for word, stands
 *   [2] a misquote becomes the stretch of the words closest to it
 *   [3] shouted (ALL CAPS) captions are quoted in ordinary sentence case, the
 *       capitals the writer gave a name kept
 *   [4] a quote with nothing close is left, and counted; a word or two in
 *       quote marks is a phrase, not a quote
 *   [5] suggest(): the writer is GIVEN the checked words, and what it wrote
 *       is checked against them
 *   [6] revise(): a rewrite that tidied a quote has it put back
 *   [7] the harder ones: a statement turned into a question, a real question,
 *       a quote begun mid-sentence, British ‘single quotes’, an apostrophe,
 *       two sentences from captions, a name as the captions spell it
 *
 *   node test/social-quotes.test.js
 */
const sc = require('../src/main/social-copy');

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };

(async () => {
  const heard = 'You know, God is not finished with you yet. He will complete the work He started, and nothing you did can stop Him.';
  const caps = 'YOU KNOW GOD IS NOT FINISHED WITH YOU YET HE WILL COMPLETE THE WORK HE STARTED BISHOP DAVID RICHMAN SAID AT THE POWER HOUSE';

  console.log('[1] a quote that is the words stands');
  let r = sc.fixQuotes('“God is not finished with you yet,” and that is the point.', heard);
  check(r.fixed === 0 && r.unsure === 0 && r.text === '“God is not finished with you yet,” and that is the point.', 'word for word (capitals and commas aside): left exactly as written', r);
  r = sc.fixQuotes('"GOD IS NOT FINISHED with you YET"', heard);
  check(r.fixed === 0 && /GOD IS NOT FINISHED/.test(r.text), 'capitals do not make it a misquote', r);

  console.log('[2] a misquote becomes the words');
  r = sc.fixQuotes('Ever felt stuck? "God is not done with you yet." 🙌', heard);
  check(r.fixed === 1 && /"God is not finished with you yet\.?"/.test(r.text) && /Ever felt stuck\?/.test(r.text) && /🙌/.test(r.text),
    'a tidied quote ("done") is put back to what was said ("finished"), the rest of the caption untouched', r);
  r = sc.fixQuotes('“He will finish the work that He began.”', heard);
  check(r.fixed === 1 && /He will complete the work He started/.test(r.text), 'a paraphrase in quote marks becomes the words it paraphrased', r);

  console.log('[3] shouted captions, quoted ordinarily');
  r = sc.fixQuotes('“God is not done with you,” Bishop David Richman said.', caps);
  check(r.fixed === 1 && /^“God is not finished with you( yet)?,?”/.test(r.text) && !/GOD IS/.test(r.text), 'ALL CAPS caption words are quoted in sentence case, God with its capital', r);
  r = sc.fixQuotes('"Bishop David Richman said at the Power House"', caps.replace('BISHOP DAVID RICHMAN SAID AT THE POWER HOUSE', 'BISHOP DAVID RICHMOND SAID AT THE POWER HOUSE'));
  check(r.fixed === 1 && /Bishop David Richmond/.test(r.text), 'a name is the checked words\' spelling, with the capitals the writer gave the rest', r);

  console.log('[4] nothing close, and phrases');
  r = sc.fixQuotes('As the Bible says, "the joy of the Lord is your strength."', heard);
  check(r.fixed === 0 && r.unsure === 1 && /the joy of the Lord is your strength/.test(r.text), 'a quote with nothing close in the words is left as it is, and counted', r);
  r = sc.fixQuotes('This is a "new season" for you.', heard);
  check(r.fixed === 0 && r.unsure === 0 && /"new season"/.test(r.text), 'two words in quote marks are a phrase, not a quote', r);
  r = sc.fixQuotes('"God is not done"', '');
  check(r.fixed === 0 && r.text === '"God is not done"', 'no words to check against: nothing changes', r);

  console.log('[5] suggest(): the writer is given the checked words, and checked against them');
  let prompt = '';
  const llm = {
    isAvailable: async () => true,
    parseJson: (t) => JSON.parse(t),
    chat: async ({ prompt: p }) => {
      prompt = p;
      const cap = 'Ever felt stuck? "God is not done with you." Bishop David Richman said it plainly: the work He started, He will complete. 🙌';
      return JSON.stringify({ options: [{ title: 'Not done yet', hook: 'Ever felt stuck?', caption: cap }, { title: 'Two', hook: 'x', caption: cap }, { title: 'Three', hook: 'x', caption: cap }] });
    },
  };
  const out = await sc.suggest({ mediaPath: '/x/short-Not_finished.mp4', kind: 'video', durationSec: 40, transcript: heard.replace('finished', 'fin ished'),
    checked: caps, speakers: ['Bishop David Richman'], llm, quick: true });
  check(/THE CHECKED WORDS/.test(prompt) && prompt.includes(caps) && /checked words are right/.test(prompt),
    'the writer is given the checked caption words, and told they win over what the machine heard', prompt.slice(0, 200));
  check(out.source === 'ai' && /"God is not finished with you( yet)?\.?"/.test(out.caption) && out.quotesFixed >= 1 && out.quotesFrom === 'captions',
    'what it wrote is checked against them: its misquote is the captions\' words now', { caption: out.caption, quotesFixed: out.quotesFixed, from: out.quotesFrom });
  const rulesOnly = await sc.suggest({ mediaPath: '/x/short.mp4', kind: 'video', transcript: '', checked: caps, speakers: [], llm: null });
  check(rulesOnly && rulesOnly.caption && !/GOD IS NOT/.test(rulesOnly.caption), 'with no writer, the rules quote the checked words — not shouted', rulesOnly.caption);

  console.log('[6] revise(): a rewrite keeps the quote as the post had it');
  const was = 'Ever felt stuck? "God is not finished with you yet." Come as you are. 🙌\n\n#faith #jesus';
  const rlm = { isAvailable: async () => true, parseJson: (t) => JSON.parse(t),
    chat: async () => JSON.stringify({ title: 'Fresh', caption: 'Still waiting? "God is not done with you." He keeps His word. ✨' }) };
  const rv = await sc.revise({ caption: was, title: 'T', action: 'rewrite', llm: rlm });
  check(rv.source === 'ai' && /"God is not finished with you( yet)?\.?"/.test(rv.caption) && !/""/.test(rv.caption) && /Still waiting\?/.test(rv.caption) && /#faith #jesus$/.test(rv.caption),
    'the fresh take is kept — with its quote put back to the words, and the post\'s hashtags', rv.caption);

  console.log('[7] the harder ones, word for word what comes out');
  const H = 'You know, God is not finished with you yet. He will complete the work He started, and nothing you did can stop Him. Don\u2019t give up on yourself today. Are you ready to receive?';
  const C = 'YOU KNOW GOD IS NOT FINISHED WITH YOU YET HE WILL COMPLETE THE WORK HE STARTED BISHOP DAVID RICHMAN SAID AT THE POWER HOUSE ARE YOU READY TO RECEIVE';
  const cases = [
    ['a statement turned into a question is the statement again', '\u201cIs God not done with you yet?\u201d', H, '\u201cGod is not finished with you yet.\u201d'],
    ['a real question keeps its question mark', '\u201cAre you ready to receive it?\u201d', H, '\u201cAre you ready to receive?\u201d'],
    ['a quote begun mid-sentence stays small, with no joining word pulled in', 'He reminds you that \u201cnothing you do can stop Him.\u201d', H, 'He reminds you that \u201cnothing you did can stop Him.\u201d'],
    ['British single quotes, ending as the writer ended it', '\u2018God is not done with you yet,\u2019 he said.', H, '\u2018God is not finished with you yet,\u2019 he said.'],
    ['an apostrophe inside single quotes', '\u2018Don\u2019t give up on yourself now\u2019 is the word.', H, '\u2018Don\u2019t give up on yourself today\u2019 is the word.'],
    ['two sentences from captions keep their stop and capitals', '\u201cGod is not done with you yet. He will finish the work He started.\u201d', C, '\u201cGod is not finished with you yet. He will complete the work He started.\u201d'],
    ['from captions: a statement turned into a question', '\u201cIs God not done with you yet?\u201d', C, '\u201cGod is not finished with you yet.\u201d'],
    ['from captions: a real question', '\u201cAre you ready to receive it?\u201d', C, '\u201cAre you ready to receive?\u201d'],
    ['from captions: the name as the captions spell it', '\u201cBishop David Richmond said it at the Power House\u201d', C, '\u201cBishop David Richman said at the Power House\u201d'],
    ['a writer\u2019s small letters put right (God, I)', 'Then: \u201cgod is not done with you. i will complete it\u201d', 'You know God is not finished with you. I will complete it. Amen.', 'Then: \u201cGod is not finished with you. I will complete it\u201d'],
  ];
  for (const [name, inp, src, want] of cases) { const got = sc.fixQuotes(inp, src).text; check(got === want, name, { got, want }); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
