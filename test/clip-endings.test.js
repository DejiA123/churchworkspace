'use strict';
/*
 * WHERE A CLIP ENDS — the half of the cut that was never being judged.
 *
 * Long-to-shorts has scored clip OPENINGS since the editor pass went in. It
 * never scored the CLOSE, and that is the cut people notice: a real run of
 * "The Outpouring Convention Day 1" produced a 94-second clip that stopped on
 *
 *     "…If daddy said, well, you'll go to somewhere."
 *
 * and threw away the two seconds that made it worth clipping ("You won't see me
 * here."). Every acoustic test passed — there IS a genuine 1.2-second pause
 * right there, because the preacher paused on purpose, for effect, before the
 * punchline. Silence cannot tell a dramatic pause from the end of a thought.
 *
 * The transcript below is the real whisper output for 82:12–83:54 of that
 * recording (times shifted so the passage starts at 0), so these are regression
 * tests against the actual failure, not against invented sermon-shaped text.
 * Usage: node test/clip-endings.test.js
 */
const h = require('../src/main/highlights');
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const S = (t) => [{ start: 0, end: 3, text: t }];

/* ---- [1] closerPenalty: does the thought actually land here? ------------- */
console.log('[1] Does the thought land here?');
const hanging = h.closerPenalty(S("If daddy said, well, you'll go to somewhere."), { text: "You won't see me here." });
const landed = h.closerPenalty(S("You won't see me here."), { text: 'Thank you.' });
check('the real failing ending is penalised', hanging >= 0.8, hanging.toFixed(2));
check('the line it should have run on to is not', landed < 0.2, landed.toFixed(2));
check('…and the good ending scores better than the bad one', landed < hanging, `${landed.toFixed(2)} < ${hanging.toFixed(2)}`);

// The other real one, from the clip that stopped mid-clause.
const midClause = h.closerPenalty(S('When the time came for them to distribute,'), { text: 'God had already spoken.' });
check('stopping on an unfinished subordinate clause is penalised', midClause >= 0.9, midClause.toFixed(2));
const onConjunction = h.closerPenalty(S('He gave them the land and'), null);
check('stopping on a conjunction is penalised', onConjunction >= 0.9, onConjunction.toFixed(2));
// …but a finished sentence that happens to end on an auxiliary is NOT truncated.
const finishedOnAux = h.closerPenalty(S('That is all he did.'), { text: 'Nothing more was needed.' });
check('a full stop after an auxiliary is a real ending, not a truncation', finishedOnAux < 0.55, finishedOnAux.toFixed(2));
const completeSubordinate = h.closerPenalty(S('When you pray, God listens.'), { text: 'Elijah was a man like us.' });
check('a complete "When…" sentence is not treated as hanging', completeSubordinate < 0.55, completeSubordinate.toFixed(2));
const setup = h.closerPenalty(S('Let me tell you what happened next.'), { text: 'It was raining.' });
check('stopping on a promise of what comes next is penalised', setup >= 0.5, setup.toFixed(2));
const scrap = h.closerPenalty(S('Hi.'), { text: 'He wants a place of forgetfulness.' });
check('stopping on a scrap ("Hi.") is penalised', scrap >= 0.55, scrap.toFixed(2));
const resolved = h.closerPenalty(S('I receive this grace in Jesus name.'), { text: 'Somebody say amen.' });
check('a declaration that resolves is rewarded (negative cost)', resolved < 0, resolved.toFixed(2));
const nextResolves = h.closerPenalty(S('God is not finished with you.'), { text: "So that's why you cannot give up." });
check('…but not when the NEXT line completes it', nextResolves > resolved, `${nextResolves.toFixed(2)} > ${resolved.toFixed(2)}`);

/* ---- [2] whisper loops are not clips ------------------------------------ */
console.log('\n[2] Whisper loops are not clips');
const loop = Array.from({ length: 40 }, (_, i) => ({ start: i * 1.6, end: i * 1.6 + 1.5, text: "I'm going to have a dinner." }));
check('40 identical lines is a decoder fault, not a highlight', h.loopiness(loop) > 0.9, h.loopiness(loop).toFixed(2));
const build = 'Through you. Through you. Through you. Apostolic, that is why you are here. It is not just for peanuts. No, no, no. It is for the inheritance.'
  .split(/(?<=[.!?])\s+/).map((t, i) => ({ start: i * 3, end: i * 3 + 2.5, text: t }));
check('…but a preacher repeating a line three times is emphasis', h.loopiness(build) < 0.35, h.loopiness(build).toFixed(2));

/* ---- [3] the real passage: the handover and the punchline ---------------- */
console.log('\n[3] The real 82:12–83:54 passage');
// Real whisper segments. Note the 8.2s hole at 35.60–43.76: the host finishes his
// introduction, the congregation claps, and a DIFFERENT man starts speaking.
const chunks = [
  { start: 0.00, end: 2.96, text: 'that it takes grace to work with you.' },
  { start: 2.96, end: 6.08, text: 'We know that like we know we have eyes.' },
  { start: 6.08, end: 10.08, text: 'That if anybody has nor received grace for sacrificial living' },
  { start: 10.08, end: 13.44, text: 'and sacrificial giving, you will be lost around daddy.' },
  { start: 13.44, end: 18.28, text: 'Because the life of daddy and mommy is total sacrifice.' },
  { start: 18.28, end: 23.12, text: 'There is no other way to explain it, but just total sacrifice.' },
  { start: 23.12, end: 25.56, text: "And this month that I'm bringing on the pulpit" },
  { start: 25.56, end: 29.52, text: 'for the next 20 minutes, it simplifies that, carries that.' },
  { start: 29.52, end: 31.60, text: 'I want you to open up your heart as we welcome' },
  { start: 31.60, end: 34.60, text: 'this O.W.I.O.D. all the way from the United States.' },
  { start: 34.60, end: 35.60, text: 'Thank you.' },
  { start: 43.76, end: 44.56, text: 'Alleluia.' },
  { start: 44.56, end: 46.00, text: 'Amen.' },
  { start: 46.00, end: 49.40, text: 'Please let me sit down.' },
  { start: 49.40, end: 58.32, text: 'What a great privilege to be standing on this altar today.' },
  { start: 58.32, end: 61.32, text: 'My first time in highland.' },
  { start: 61.32, end: 72.32, text: 'And my first time on standing on an altar in highland.' },
  { start: 77.32, end: 82.32, text: 'So I give glory to God for this great privilege.' },
  { start: 82.32, end: 86.32, text: 'And not only that, I want to give thanks to God' },
  { start: 86.32, end: 92.32, text: 'for daddy giving me the permission to be here.' },
  { start: 92.32, end: 96.32, text: "If daddy said, well, you'll go to somewhere." },
  { start: 96.32, end: 98.32, text: "You won't see me here." },
  { start: 98.32, end: 100.32, text: 'So celebrate daddy for me.' },
  { start: 100.32, end: 101.32, text: 'Thank you.' },
];
const sents = h.buildSentences(chunks);
check('the handover shows up as an 8-second hole in the words', h.transitionGap(sents) > 8, h.transitionGap(sents).toFixed(1) + 's');
// …but music UNDER the preacher is not a handover: whisper tags it ♪, which is
// stripped from the text and used to leave a phantom hole the same size.
const withMusic = h.buildSentences([
  { start: 0, end: 4, text: 'My first time in this land.' },
  { start: 4, end: 9, text: '♪♪♪' },
  { start: 9, end: 14, text: 'So I give glory to God for it.' },
]);
check('a ♪ sting between two lines is not read as a break', h.transitionGap(withMusic) < 1,
  h.transitionGap(withMusic).toFixed(1) + 's');
check('…and the ♪ never reaches the words', !/[♪]/.test(withMusic.map((s) => s.text).join(' ')),
  withMusic.map((s) => s.text).join(' | '));

// The delivery-hot window the loudness pass hands over is 2.2–96.3 (the cut that
// shipped). Refine it the way analyzeSermon does, at the app's ✨Auto band.
const got = h.refineToSentences(2.2, 96.3, sents, 45, 100, 90, { autoLen: true });
check('a clip is still found', !!got, got && `${got.start.toFixed(1)}–${got.end.toFixed(1)}`);
if (got) {
  const text = got.sents.map((s) => s.text).join(' ');
  check('it no longer stops on the unfinished "If daddy said…"',
    !/go to somewhere\.$/.test(text.trim()), '…' + text.trim().slice(-46));
  check('it no longer straddles the handover between the two speakers',
    h.transitionGap(got.sents) < 6, h.transitionGap(got.sents).toFixed(1) + 's');
  check('it does not open on the previous speaker mid-sentence',
    !/^that it takes grace/.test(text), text.slice(0, 46) + '…');
}
// Given room to reach it, the punchline is what the clip should run out to.
const roomy = h.refineToSentences(46, 96.3, sents, 40, 60, 50, { autoLen: true });
check('given room, the clip runs on to the punchline it was cutting off',
  roomy && /You won't see me here\.|So celebrate daddy for me\.|Thank you\.$/.test(roomy.sents.map((s) => s.text).join(' ')),
  roomy && '…' + roomy.sents.map((s) => s.text).join(' ').slice(-46));

/* ---- [3b] the SECOND real one: a cliffhanger that read as a clean landing --- */
console.log('\n[3b] The real 96:51–97:50 passage (the cliffhanger)');
// The first fix shipped a clip ending on "But you might have forgotten." — short,
// declarative, full stop, landing in a real pause, so the closer test REWARDED it.
// The next four lines say what he might have forgotten, and the payoff is
// "Your inheritance is settled." 47 seconds later.
const cliff = h.closerPenalty(S('But you might have forgotten.'), { text: 'The other 10 have died.' });
check('a cliffhanger ending is penalised, not rewarded', cliff >= 0.55, cliff.toFixed(2));
const turn = h.closerPenalty(S('But God has spoken over your life.'), { text: 'Elijah was a man like us.' });
check('…while "But God…" — the turn — is still a real landing', turn < 0, turn.toFixed(2));
const settled = h.closerPenalty(S('Your inheritance is settled.'), { text: 'There is nobody.' });
check('the line it should have run on to scores better', settled < cliff, `${settled.toFixed(2)} < ${cliff.toFixed(2)}`);
const stillFine = h.closerPenalty(S('That is the mercy of God!'), { text: 'Now the genealogy runs for pages.' });
check('a normal declaration is untouched by the connective rule', stillFine < 0, stillFine.toFixed(2));

const cliffChunks = [
  { start: 0.0, end: 1.5, text: 'So, it went to Joshua.' },
  { start: 1.5, end: 2.3, text: 'Joshua,' },
  { start: 4.0, end: 6.0, text: "I can't go for your life." },
  { start: 6.0, end: 7.6, text: 'You are my leader.' },
  { start: 7.6, end: 9.2, text: 'But you might have forgotten.' },
  { start: 10.3, end: 12.1, text: 'The other 10 have died.' },
  { start: 12.1, end: 14.2, text: 'The time God you are still alive.' },
  { start: 14.2, end: 16.0, text: 'Two of us were there.' },
  { start: 16.0, end: 21.9, text: 'When Moses, the seventh of the Lord, spoke through God,' },
  { start: 21.9, end: 29.9, text: 'that the land that I went to 45 years ago shall be mine and my descendant.' },
  { start: 29.9, end: 36.9, text: 'So, I come, referently to you, that the lot you are doing, give it to others.' },
  { start: 36.9, end: 38.0, text: 'Thank you for that.' },
  { start: 38.0, end: 40.4, text: 'But my own is not by lot.' },
  { start: 41.8, end: 43.4, text: 'I have claimed my home.' },
  { start: 44.3, end: 48.9, text: '45 years ago, my heart was holy with the law.' },
  { start: 48.9, end: 54.4, text: 'If you stop God holy with your heart with the law, no body can cheat you.' },
  { start: 56.2, end: 58.4, text: 'Your inheritance is settled.' },
  { start: 59.4, end: 61.6, text: 'There is no body.' },
];
const cliffSents = h.buildSentences(cliffChunks);
// The loudness window ended at 9.2 — right on the cliffhanger, which is where the
// shipped clip stopped. Given the following lines, it must run past it.
const past = h.refineToSentences(0, 9.2, cliffSents, 20, 62, 45, { autoLen: true });
check('the clip runs past the cliffhanger', past && past.end > 9.2, past && `${past.start.toFixed(1)}–${past.end.toFixed(1)}`);
if (past) {
  const t = past.sents.map((s) => s.text).join(' ').trim();
  check('it does not stop on "But you might have forgotten."', !/forgotten\.$/.test(t), '…' + t.slice(-52));
  // Any of the passage's real landings will do — what must not happen is stopping
  // on the setup, on "Thank you for that.", or on the bare vocative "Joshua,".
  check('it reaches a line that actually resolves',
    /(I have claimed my home\.|no body can cheat you\.|Your inheritance is settled\.|But my own is not by lot\.)$/.test(t),
    '…' + t.slice(-52));
}

/* ---- [4] openers that are really continuations --------------------------- */
console.log('\n[4] Openers that are really continuations');
check('a mid-flow repair is not an opening', h.openerPenalty(S('I mean, the defence had up there.')) >= 0.5,
  h.openerPenalty(S('I mean, the defence had up there.')).toFixed(2));
check('a bare "Amen." is not an opening', h.openerPenalty(S('Amen.')) > 0,
  h.openerPenalty(S('Amen.')).toFixed(2));
check('a real opening line still scores zero', h.openerPenalty(S('God is not finished with you.')) === 0);

/* ---- [5] topic seams ----------------------------------------------------- */
console.log('\n[5] Cut where the topic changes');
const a = { text: 'Faith is a decision you make every single morning.' };
const b = { text: 'That decision about faith changes your whole morning.' };
const c = { text: 'Now the genealogy in the second chapter runs for pages.' };
check('a sentence that carries on the subject is not a seam', h.topicSeam(a, b) < 0.5, h.topicSeam(a, b).toFixed(2));
check('a sentence that changes the subject is', h.topicSeam(a, c) > 0.8, h.topicSeam(a, c).toFixed(2));

/* ---- [5b] whisper's chunks are not sentences ----------------------------- */
console.log("\n[5b] Whisper's chunks are not sentences");
// Real Small-model output: 8-second chunks holding several sentences and
// breaking mid-phrase. Splitting only at chunk edges made one 16-second
// "sentence" out of six, and every edge decision then used the wrong units.
const coarse = h.buildSentences([
  { start: 95.0, end: 103.0, text: 'Joshua and Caleb was there. Joshua was the leader. Are you hearing me? Joshua was' },
  { start: 103.0, end: 109.4, text: 'the leader. The man did not say because we went together. We are at the same level' },
]);
// six real sentences, where splitting on chunk edges alone would have given two
check('the chunks are split into their real sentences', coarse.length === 6, coarse.length + ' sentences');
check('a sentence broken across two chunks is put back together',
  coarse.some((s) => /^Joshua was the leader\.$/.test(s.text.trim())),
  coarse.map((s) => s.text).join(' | '));
check('every sentence but the trailing one ends on real punctuation',
  coarse.slice(0, -1).every((s) => /[.!?…]$/.test(s.text.trim())),
  coarse.map((s) => s.text.trim().slice(-1)).join(''));
check('the split sentences stay inside the chunk they came from',
  coarse[0].start >= 95 && coarse[coarse.length - 1].end <= 109.4,
  `${coarse[0].start.toFixed(1)}..${coarse[coarse.length - 1].end.toFixed(1)}`);

/* ---- [6] where the preacher LETS IT SIT --------------------------------- */
console.log('\n[6] Where the preacher lets it sit');
// Both endings below are grammatically fine and both land in silence. The only
// thing separating them is HOW LONG that silence runs — which is the speaker's
// own judgement about where the thought finished, and on a real passage was the
// difference between the cut a human makes and the one that reads as too soon:
//   "That is a package for you."  1.20s   vs   "You are my leader."  0.80s
const sitChunks = [
  { start: 0.0, end: 6.0, text: 'God is not looking for your ability at all.' },
  { start: 6.2, end: 12.0, text: 'He is looking for your availability.' },
  { start: 12.3, end: 18.0, text: 'That is the whole point of this morning.' },
  { start: 18.4, end: 24.0, text: 'I said it to my son last week.' },
  { start: 24.2, end: 30.0, text: 'He looked at me and he smiled.' },
  // a line beyond every candidate ending, so each one can be judged by what
  // follows it rather than by running out of transcript
  { start: 30.4, end: 36.0, text: 'Grace will do that in a home.' },
];
const sitSents = h.buildSentences(sitChunks);
const withRoom = (longAt) => h.refineToSentences(0, 30, sitSents, 15, 32, 24, {
  autoLen: true,
  room: { start: () => 1.0, end: (t) => (Math.abs(t - longAt) < 0.3 ? 1.4 : 0.4) },
});
const sitEarly = withRoom(18.0);
const sitLate = withRoom(30.0);
check('the clip ends where the long silence is', sitEarly && Math.abs(sitEarly.end - 18) < 0.01,
  sitEarly && `ends ${sitEarly.end}`);
check('…and follows it when the long silence moves', sitLate && Math.abs(sitLate.end - 30) < 0.01,
  sitLate && `ends ${sitLate.end}`);

console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
process.exit(fail === 0 ? 0 : 1);
