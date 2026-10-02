'use strict';
/*
 * The FREE, on-device editor pass that ranks Long-to-shorts candidates — and the
 * copyright-free music filter. No API key, no network, nothing paid.
 *
 * Every check below is written as "an editor would prefer X over Y", using
 * sermon-shaped text, so a regression shows up as the WRONG CLIP WINNING rather
 * than as a number drifting.
 * Usage: node test/editor-score.test.js
 */
const h = require('../src/main/highlights');
const library = require('../src/main/library');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

/** Build a candidate the way analyzeSermon does: text + its sentence array. */
function cand(text, base = 2.0) {
  const sents = text.split(/(?<=[.!?])\s+/).filter(Boolean).map((t, i) => ({ start: i * 5, end: i * 5 + 4, text: t }));
  return { start: 0, end: 90, score: base, total: base, text, sentsArr: sents };
}
const rank = (pool) => { h.scoreLikeAnEditor(pool); return pool.slice().sort((a, b) => b.total - a.total); };

(async () => {
  /* ---------------- [1] the opener test ----------------------------------- */
  console.log('[1] Can a stranger follow it from the first word?');
  const dangling = cand('So he told them that it would happen anyway. And then they went.');
  const clean = cand('God is not finished with you. He has a plan for your life.');
  check('a bare connective opener is penalised', h.openerPenalty(dangling.sentsArr, dangling.text) > 0.6,
    `dangling=${h.openerPenalty(dangling.sentsArr, dangling.text).toFixed(2)}`);
  check('a self-contained opener is not', h.openerPenalty(clean.sentsArr, clean.text) === 0,
    `clean=${h.openerPenalty(clean.sentsArr, clean.text)}`);
  const pronoun = cand('He walked into that room and said nothing at all. They just stared.');
  check('a bare pronoun opener is penalised (who is "he"?)', h.openerPenalty(pronoun.sentsArr, pronoun.text) > 0.5,
    h.openerPenalty(pronoun.sentsArr, pronoun.text).toFixed(2));
  const namedFast = cand('He is the God who makes a way. God will finish what he started.');
  check('…but forgiven when the clip names its subject immediately',
    h.openerPenalty(namedFast.sentsArr, namedFast.text) < h.openerPenalty(pronoun.sentsArr, pronoun.text),
    `named=${h.openerPenalty(namedFast.sentsArr, namedFast.text).toFixed(2)} vs bare=${h.openerPenalty(pronoun.sentsArr, pronoun.text).toFixed(2)}`);

  /* ---------------- [2] is it about ONE thing? ----------------------------- */
  console.log('\n[2] Is it about one thing?');
  const focused = cand('Faith is not a feeling. Faith is a decision you make. That decision changes everything about your faith.');
  const wandering = cand('Faith is not a feeling. The weather was terrible yesterday. My cousin bought a motorcycle.');
  check('a clip circling one subject scores high cohesion', h.cohesion(focused.sentsArr) >= 0.5, h.cohesion(focused.sentsArr).toFixed(2));
  check('a wandering clip scores low', h.cohesion(wandering.sentsArr) === 0, h.cohesion(wandering.sentsArr).toFixed(2));

  /* ---------------- [3] the preacher's build ------------------------------- */
  console.log('\n[3] Repetition, quotable lines, scripture reading');
  const triad = cand('God will restore your years. God will restore your health. God will restore your family.');
  check('three sentences opening the same way = full anaphora score', h.anaphora(triad.sentsArr) === 1);
  check('no repetition = none', h.anaphora(focused.sentsArr) < 1);
  check('a short weighty declaration is quotable', h.quotableLine(cand('I decree it is done in the name of Jesus!').sentsArr) > 0.7,
    h.quotableLine(cand('I decree it is done in the name of Jesus!').sentsArr).toFixed(2));
  const reading = cand('Leviticus chapter 1 verse 3. Genesis 12:1. Romans 8:28. Isaiah chapter 40.');
  check('bare verse citations are flagged as reading aloud', h.readingAloud(reading.text) > 0.7, h.readingAloud(reading.text).toFixed(2));
  check('commentary around a verse is not', h.readingAloud('Romans 8:28 says all things work together. You have to believe that for your life today, you really do.') < 0.5,
    h.readingAloud('Romans 8:28 says all things work together. You have to believe that for your life today, you really do.').toFixed(2));

  /* ---------------- [4] the whole pass, as an editor would judge ----------- */
  console.log('\n[4] The pass picks what an editor would pick');
  // Deliberately give the WORST clip the BEST audio score, as a loud but empty
  // passage really would have — the words must be able to overrule the volume.
  const pool = [
    cand('So then he said that to them and it went on like that for a while. And anyway that was that.', 3.2), // loud + empty
    cand('God will restore your years. God will restore your health. God will restore your family. Receive it in the name of Jesus!', 1.4),
    cand('Leviticus chapter 1 verse 3. Genesis 12:1. Romans 8:28. Numbers chapter 6 verse 24.', 2.6),
  ];
  const ordered = rank(pool);
  check('the loud-but-empty fragment does NOT win', ordered[0] !== pool[0],
    `winner starts "${ordered[0].text.slice(0, 28)}…"`);
  check('the passage that builds and lands wins', ordered[0] === pool[1]);
  check('the read-aloud verse list is pushed down', ordered[ordered.length - 1] === pool[2] || ordered[1] !== pool[2],
    ordered.map((o) => o.total.toFixed(2)).join(' > '));
  check('every candidate carries its editor breakdown', pool.every((c) => c.editor && typeof c.editor.cohesion === 'number'));
  check('the breakdown explains the empty fragment', pool[0].editor.dangling > 0.6, JSON.stringify(pool[0].editor));

  /* --- distinctiveness is RELATIVE: the same words everywhere score low --- */
  const generic = 'The Lord is good and the Lord is faithful to his people always.';
  const samey = [cand(generic, 2), cand(generic, 2), cand(generic, 2),
    cand('Sacrificial giving costs you something real. Sacrificial giving is worship. That kind of giving moves heaven.', 2)];
  h.scoreLikeAnEditor(samey);
  check('a clip saying what every other clip says is NOT distinctive', samey[0].editor.distinct < samey[3].editor.distinct,
    `generic=${samey[0].editor.distinct} vs distinctive=${samey[3].editor.distinct}`);

  /* --- an empty / no-transcript pool must not throw --- */
  check('an empty pool is safe', Array.isArray(h.scoreLikeAnEditor([])) && h.scoreLikeAnEditor(null) === null);
  const noText = [{ start: 0, end: 60, score: 1, total: 1, text: '' }];
  h.scoreLikeAnEditor(noText);
  check('a candidate with no words still gets a finite total', Number.isFinite(noText[0].total), String(noText[0].total));

  /* ---------------- [5] the card explains itself in plain English ---------- */
  console.log('\n[5] The card says WHY, in plain English');
  // mirror the pipeline: contentScoreV2 runs before the badge is computed
  for (const c of pool) c.contentScore = h.contentScoreV2(c.text, c.sentsArr);
  const vr = h.viralityAndReasons(pool[1], 3.2, true);
  check('a strong clip gets a high badge', vr.virality >= 70, `v=${vr.virality}`);
  check('and a human-readable reason', vr.reasons.length > 0 && /repetition|quotable|one point|distinctive|hook|declaration/i.test(vr.reasons.join(' ')),
    vr.reasons.join(' · '));
  const vrBad = h.viralityAndReasons(pool[0], 3.2, true);
  check('a mid-thought clip is called out as one', /mid-thought/i.test(vrBad.reasons.join(' ')), vrBad.reasons.join(' · '));

  /* ---------------- [6] no paid dependency anywhere ------------------------ */
  console.log('\n[6] Nothing here costs money');
  const pkg = require('../package.json');
  check('no Anthropic SDK in the shipped dependencies', !Object.keys(pkg.dependencies || {}).some((d) => /anthropic/i.test(d)),
    Object.keys(pkg.dependencies || {}).join(', '));
  check('highlights.js requires nothing but child_process + jobs',
    !/require\(['"](?!\.\/jobs|child_process)/.test(require('fs').readFileSync(require.resolve('../src/main/highlights.js'), 'utf8')));

  /* ---------------- [7] copyright-free music markers ----------------------- */
  console.log('\n[7] YouTube copyright-free detection');
  const freeYes = [
    { title: 'Peaceful Worship Piano — No Copyright Music', uploader: 'Chill Beats' },
    { title: 'Uplifting Gospel Instrumental', uploader: 'NCS — No Copyright Sounds' },
    { title: 'Cinematic Background (Royalty Free)', uploader: 'Someone' },
    { title: 'Soft piano | copyright free | free to use', uploader: 'x' },
    { title: 'Ambient worship', uploader: 'YouTube Audio Library' },
    { title: 'Emotional strings [Non-Copyright]', uploader: 'y' },
  ];
  const freeNo = [
    { title: 'Way Maker (Live)', uploader: 'Sinach' },
    { title: 'Oceans - Hillsong UNITED', uploader: 'Hillsong UNITED' },
    { title: 'Top 40 hits 2026', uploader: 'Vevo' },
  ];
  check('recognises every declared-free style of title/channel', freeYes.every((e) => library.looksCopyrightFree(e)),
    freeYes.filter((e) => !library.looksCopyrightFree(e)).map((e) => e.title).join(' | ') || 'all matched');
  check('never mislabels commercial worship tracks as free', freeNo.every((e) => !library.looksCopyrightFree(e)),
    freeNo.filter((e) => library.looksCopyrightFree(e)).map((e) => e.title).join(' | ') || 'none matched');

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
