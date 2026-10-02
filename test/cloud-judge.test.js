'use strict';
/*
 * ☁️ CLOUD AI for ✂️ Long-to-shorts (llmjudge.makeCloudJudge), against a fake
 * account so every answer is known exactly.
 *
 *   node test/cloud-judge.test.js
 */
const llmjudge = require('../src/main/llmjudge');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d !== undefined ? '  -> ' + d : '')); c ? pass++ : fail++; };

function fakeAccount({ reachable = true, replies = [], why = '' } = {}) {
  const calls = [];
  return {
    calls,
    reachable: () => reachable,
    ready: () => false,                    // the CAPTION writer is switched off — must not matter
    state: () => ({ model: 'openai/gpt-oss-120b', usingModel: 'openai/gpt-oss-120b', providerName: 'Groq', why }),
    chat: async (a) => { calls.push(a); const r = replies.shift(); return typeof r === 'function' ? r(a) : (r == null ? '' : r); },
  };
}

(async () => {
  console.log('\n[1] Only when the account can be reached');
  check('no key → no judge (the rules run, and the studio says why)', llmjudge.makeCloudJudge({ cloudwrite: fakeAccount({ reachable: false }) }) === null);
  const acct = fakeAccount();
  const j = llmjudge.makeCloudJudge({ cloudwrite: acct });
  check('a key → a judge, even with the caption writer switched off', !!j && j.cloud === true, j && j.modelName);
  check('it is given more room than the PC\'s small model', j.maxEndingCalls >= 24 && j.maxOffer > 8 && j.rankWeight > 1.2 && j.fullText === true,
    JSON.stringify({ endings: j.maxEndingCalls, offer: j.maxOffer, weight: j.rankWeight }));

  console.log('\n[2] Where should this clip end?');
  acct.calls.length = 0;
  const options = [{ i: 4, text: 'But you might have forgotten.' }, { i: 5, text: 'Your inheritance is settled.' }, { i: 6, text: 'Now turn with me.' }];
  const fakeReplies = (arr) => { const a = fakeAccount({ replies: arr }); return { a, judge: llmjudge.makeCloudJudge({ cloudwrite: a }) }; };
  let { a, judge } = fakeReplies(['{"end": 2}']);
  const e1 = await judge.ending({ opening: 'God has not forgotten you.', chosen: 4, options });
  check('the payoff line is chosen over the set-up', e1 && e1.i === 5 && e1.changed === true, JSON.stringify(e1));
  check('asked as JSON, at temperature 0, past the caption writer\'s off switch', a.calls[0].json === true && a.calls[0].temperature === 0 && a.calls[0].evenIfOff === true);
  check('…with room for a reasoning model to think before it answers', a.calls[0].maxTokens >= 600, a.calls[0].maxTokens);
  ({ a, judge } = fakeReplies(['{"end": 9}']));
  check('a line that was not offered is ignored', (await judge.ending({ opening: 'x', chosen: 4, options })) === null);
  ({ a, judge } = fakeReplies(['Sure! I think {"end": 1} is right.']));
  const e3 = await judge.ending({ opening: 'x', chosen: 4, options });
  check('JSON inside prose is still read; the same answer as the rules is "unchanged"', e3 && e3.changed === false);

  console.log('\n[3] Which clips stand alone?');
  const clips = [1, 2, 3].map((id) => ({ id, opening: 'open ' + id, ending: 'end ' + id, text: `Clip ${id} middle words that decide whether it stays on one point.` }));
  ({ a, judge } = fakeReplies(['{"scores": {"1": 9, "2": 3, "3": 7}}']));
  const sc = await judge.rank({ clips });
  check('every clip scored', sc && sc.get('1') === 9 && sc.get('2') === 3 && sc.get('3') === 7);
  check('the model reads each clip\'s WHOLE text, not just its edges', /middle words that decide/.test(a.calls[0].prompt) && !/opens: "open 1"/.test(a.calls[0].prompt));
  ({ a, judge } = fakeReplies(['{"scores": {"1": 9}}']));
  check('a model that scored one clip in three has not done the job', (await judge.rank({ clips })) === null);
  // measured: gpt-oss once echoed the format example back as all zeros
  ({ a, judge } = fakeReplies(['{"scores": {"1": 0, "2": 0, "3": 0}}']));
  check('every clip given the same score is not a ranking (no clip is thrown out on it)', (await judge.rank({ clips })) === null);
  check('…and the format example it is shown has no real numbers to copy', /<0-10>/.test(a.calls[0].prompt) && !/"1": 0/.test(a.calls[0].prompt));

  console.log('\n[4] Titles are the speaker\'s own words');
  const tclips = [{ id: 1, text: 'Your inheritance is settled and nobody can take it from you.' }, { id: 2, text: 'Grace found me when I was not looking for it.' }];
  ({ a, judge } = fakeReplies(['{"titles": {"1": "Your inheritance is settled", "2": "The day Pastor James met Jesus in Lagos"}}']));
  const tt = await judge.titles({ clips: tclips });
  check('a grounded title is kept', tt && tt.get('1') === 'Your inheritance is settled');
  check('an invented one is thrown away', tt && !tt.has('2'));

  console.log('\n[5] When the cloud does not answer, it says why');
  ({ a, judge } = { a: fakeAccount({ replies: [''], why: 'the free allowance is used up for the moment' }) });
  judge = llmjudge.makeCloudJudge({ cloudwrite: a });
  const none = await judge.rank({ clips });
  check('no answer → no change to the ranking', none === null);
  check('…and the reason is kept for the studio to show', judge.stats.failed === 1 && /allowance/.test(judge.stats.why), judge.stats.why);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
