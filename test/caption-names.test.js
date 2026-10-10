'use strict';
/*
 * "I DON'T LIKE 'THE SPEAKER' AND 'OUR CHURCH'." With no speaker and no
 * church name set, a caption names neither — it is rephrased round them.
 *   node test/caption-names.test.js
 */
const sc = require('../src/main/social-copy');
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (!ok && d !== undefined ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const cases = [
  ['"Especially when the children of God gather together and talk to God over issues," the speaker said at Our Church. In that moment, healing came.',
    '"Especially when the children of God gather together and talk to God over issues." In that moment, healing came.'],
  ['"God is still working" — the speaker', '"God is still working"'],
  ['"Hold on," says the speaker. Keep going.', '"Hold on." Keep going.'],
  ['The speaker reminded us at Our Church that grace is enough. So rest.', 'Grace is enough. So rest.'],
  ['The preacher said at the Sunday Service, God is good.', 'God is good.'],
  ['He is faithful, the speaker said, and He will finish it.', 'He is faithful, and He will finish it.'],
  ['Join us at Our Church this Sunday.', 'Join us this Sunday.'],
  ['Bishop David Richman said grace is enough.', 'Bishop David Richman said grace is enough.'],
  ['Our church family is growing.', 'Our church family is growing.'],
];
for (const [inp, want] of cases) check(sc.dropFaceless(inp) === want, 'rephrased: ' + inp.slice(0, 50), sc.dropFaceless(inp));
check(sc.realChurch('Our Church') === '' && sc.realChurch('The Power House') === 'The Power House', '"Our Church" is the placeholder, not a name');

(async () => {
  let prompt = '';
  const llm = { isAvailable: async () => true, parseJson: JSON.parse,
    chat: async (a) => { if (!prompt) prompt = a.prompt; const cap = 'Ever felt stuck? "Talk to God over issues," the speaker said at Our Church. Healing came. 🙌\n\n#Faith';
      return JSON.stringify({ options: [{ title: 'Stuck?', caption: cap }, { title: 'Two', caption: cap }, { title: 'Three', caption: cap }] }); } };
  const out = await sc.suggest({ mediaPath: '/x/clip.mp4', churchName: 'Our Church', transcript: 'Especially when the children of God gather together and talk to God over issues, every sickness will be solved. Healing came to many people that night.', llm });
  check(/Do NOT refer to the speaker at all/.test(prompt) && /NOBODY HAS TOLD YOU THE CHURCH/.test(prompt) && !/THE CHURCH: Our Church/.test(prompt), 'the writer is told to name neither', prompt.slice(0, 200));
  check(!/the speaker|our church/i.test(out.caption), 'and what it wrote comes out naming neither', out.caption);
  const r = await sc.revise({ caption: out.caption, action: 'shorten', llm: { isAvailable: async () => true, parseJson: JSON.parse, chat: async () => JSON.stringify({ caption: '"Talk to God," the speaker said at Our Church.' }) } });
  check(!/the speaker|our church/i.test(r.caption) && /#Faith/.test(r.caption), 'Shorter / More hype keep it that way (and keep the hashtags)', r.caption);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
