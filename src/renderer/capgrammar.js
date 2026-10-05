'use strict';
/*
 * ✍ THE CAPTION GRAMMAR CHECKER — "a Grammarly kind of thing in the captions
 *   window, to correct grammatical errors per line or overall".
 *
 * WHAT A CAPTION'S "GRAMMAR" ACTUALLY IS
 *
 * A burned-in caption is not prose. Full stops, commas, question marks and
 * quotes are stripped before anything is drawn (cleanCapText / captioner.
 * cleanCaptionText: "punctuation earns nothing on a caption"), lines are three
 * or four words long, and the words are what the preacher SAID. So the checks
 * that matter here are word-level, and every one of them is a mistake a viewer
 * would actually see:
 *
 *   • missing apostrophes          DONT → DON'T, IM → I'M, THATS → THAT'S
 *   • the wrong sound-alike word   YOUR GOING → YOU'RE GOING, MORE THEN → MORE THAN,
 *                                  ITS A → IT'S A, COULD OF → COULD HAVE
 *   • a / an                       A AMAZING → AN AMAZING, AN BLESSING → A BLESSING
 *   • a stuttered word             THE THE → THE, I I → I
 *   • what speech recognition does to a sermon
 *                                  HOLY GOAT → HOLY GHOST, LET US PREY → LET US PRAY,
 *                                  BEGOTTEN SUN → BEGOTTEN SON, ALTER CALL → ALTAR CALL
 *   • names that must be capitals  god → God, jesus → Jesus, ephesians → Ephesians,
 *                                  i → I   (only when the captions are in Normal case —
 *                                  in ALL CAPS there is nothing to fix, and in lower
 *                                  case the small letters are the look, not a mistake)
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It never adds punctuation (it would be stripped at the burn anyway), never
 * re-phrases, and never "corrects" an everyday word where the sentence could
 * legitimately be either: "their" and "there" are only touched inside a pattern
 * that cannot be right ("THEIR IS", "THERE GOING"). A suggestion that might be
 * wrong is worse than no suggestion, because a proof-reader who learns to
 * click Fix without reading is a proof-reader who publishes the mistake.
 *
 * CONTEXT CROSSES LINES. At one word a line — what a short's captions often
 * are — "HOLY" and "GOAT" are two separate lines, so every rule is run over
 * the line WITH the tail of the line before it and the head of the line after
 * it, and only the edits that land on this line are reported for it.
 *
 * THE AI HALF lives in the main process (it needs the network), but its guard
 * lives here: vetAiLine() refuses any suggestion that rewrote the line rather
 * than corrected it, and puts the answer back into the caption's own case. The
 * same file runs in the studio (window.CapGrammar) and in the main process
 * (require), so the rule the operator sees and the rule the AI is held to
 * cannot drift apart.
 *
 * Nothing here touches the DOM, the disk or the network.
 */
(function (factory) {
  const WB = (typeof window !== 'undefined' && window.WordBook)
    || (typeof require === 'function' ? require('./wordbook.js') : null);
  const api = factory(WB);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CapGrammar = api;
}(function (WB) {
  /* ------------------------------------------------------------------ *
   * Words and case
   * ------------------------------------------------------------------ */
  const keyOf = (s) => String(s == null ? '' : s).replace(/[’ʼ´`]/g, "'").toLowerCase();
  const letters = (s) => String(s || '').replace(/[^A-Za-z]/g, '');
  const isShout = (s) => { const l = letters(s); return l.length >= 2 && l === l.toUpperCase(); };

  function splitAffix(t) {
    if (WB && WB.splitAffix) return WB.splitAffix(t);
    const s = String(t == null ? '' : t);
    const m = /^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}]*)$/u.exec(s) || [s, '', s, ''];
    return { pre: m[1] || '', core: m[2] || '', post: m[3] || '' };
  }

  /** The tokens of a line, with where each one sits in the original text. */
  function tokenize(text) {
    const s = String(text == null ? '' : text);
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(s))) {
      const a = splitAffix(m[0]);
      out.push({ raw: m[0], start: m.index, end: m.index + m[0].length, pre: a.pre, core: a.core, post: a.post, key: keyOf(a.core) });
    }
    return out;
  }

  /**
   * Which case the line is written in. ALL CAPS is the app's default caption
   * case and is read off the line itself (an imported or retyped line may not
   * match the dropdown); lower and Title are the dropdown's say-so, because a
   * lower-case line in Normal mode is just a sentence that needs its capitals.
   */
  function lineStyle(text, caseMode) {
    if (isShout(text)) return 'upper';
    if (caseMode === 'upper' && !/[a-z]/.test(String(text || ''))) return 'upper';
    if (caseMode === 'lower') return 'lower';
    if (caseMode === 'title') return 'title';
    return 'none';
  }
  const capFirst = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const titleWord = (w) => String(w).split(/(\s+)/).map((p) => (/\S/.test(p) ? capFirst(p.toLowerCase()) : p)).join('');

  /** A canonical replacement, dressed in the line's case. */
  function dress(canon, sampleCore, style) {
    const c = String(canon == null ? '' : canon);
    if (!c) return '';
    if (style === 'upper') return c.toUpperCase();
    if (style === 'lower') return c.toLowerCase();
    if (style === 'title') return titleWord(c);
    // Normal: the replacement's own capitals win (God, I'm); otherwise a
    // capitalised original keeps its capital.
    if (/[A-Z]/.test(c)) return c;
    if (/^[A-Z]/.test(String(sampleCore || ''))) return capFirst(c);
    return c;
  }

  /* ------------------------------------------------------------------ *
   * The word lists
   * ------------------------------------------------------------------ */

  /* Missing apostrophes. Only spellings that are not themselves words: "well",
   * "were", "ill", "wed", "shed", "lets", "its" and "id" are all real words and
   * are handled in context, or not at all. */
  const CONTRACTIONS = {
    dont: "don't", doesnt: "doesn't", didnt: "didn't", cant: "can't", couldnt: "couldn't",
    wouldnt: "wouldn't", shouldnt: "shouldn't", wasnt: "wasn't", werent: "weren't", isnt: "isn't",
    arent: "aren't", havent: "haven't", hasnt: "hasn't", hadnt: "hadn't", wont: "won't", aint: "ain't",
    mustnt: "mustn't", neednt: "needn't", im: "I'm", ive: "I've", youre: "you're", youve: "you've",
    youll: "you'll", youd: "you'd", theyre: "they're", theyve: "they've", theyll: "they'll", theyd: "they'd",
    weve: "we've", hes: "he's", shes: "she's", thats: "that's", whats: "what's", wheres: "where's",
    theres: "there's", heres: "here's", whos: "who's", itll: "it'll", itd: "it'd", shouldve: "should've",
    couldve: "could've", wouldve: "would've", mustve: "must've", mightve: "might've", yall: "y'all",
    cmon: "c'mon", oclock: "o'clock",
  };
  /* The pronoun I, and its contractions, when written small. */
  const PRONOUN_I = { i: 'I', "i'm": "I'm", "i've": "I've", "i'll": "I'll", "i'd": "I'd" };

  /*
   * Names that are always names. The Bible's books, people and places come from
   * the Word Book's own vocabulary (one list, two jobs) — but only the part of
   * it that is NAMES: the rest of that list is church words like "tabernacle"
   * and "rabbi", which are ordinary nouns and must stay small.
   */
  const PROPER = new Map();
  const addProper = (s) => String(s).split(/\s+/).filter(Boolean).forEach((w) => PROPER.set(w.toLowerCase(), w));
  if (WB && Array.isArray(WB.SEED_TERMS)) {
    const cut = WB.SEED_TERMS.indexOf('Alleluia');
    addProper((cut > 0 ? WB.SEED_TERMS.slice(0, cut) : []).join(' '));
  }
  addProper('Jesus Christ Bible Satan Christian Christians Christianity Messiah Christmas Easter Pentecost '
    + 'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February April June July September October November December '
    + 'Nigeria Nigerian Nigerians Ghana Ghanaian Ghanaians Africa African Africans America American Americans England English London '
    + 'Lagos Abuja Britain British Europe European Canada Israel Israelite Israelites Jew Jews Jewish Gentile Gentiles '
    + 'John Luke Paul Mary Ruth James Jude Joel Amos Silas Moses Elijah Abraham David Isaiah Jeremiah Ezekiel');
  // Book names that are also everyday words: a capital only before a number.
  ['proverbs', 'exodus', 'revelation', 'genesis'].forEach((w) => PROPER.delete(w));
  const BOOK_BEFORE_NUMBER = {
    mark: 'Mark', job: 'Job', acts: 'Acts', kings: 'Kings', judges: 'Judges', numbers: 'Numbers',
    exodus: 'Exodus', proverbs: 'Proverbs', psalm: 'Psalm', psalms: 'Psalm', revelation: 'Revelation',
    revelations: 'Revelation', chronicles: 'Chronicles', genesis: 'Genesis', lamentations: 'Lamentations',
  };
  const isNumberish = (k) => /^\d/.test(k || '') || /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|chapter)$/.test(k || '');

  /* A word that is doubled because the speaker stumbled, not because the
   * sentence says it twice. "That that", "had had", "holy holy holy" and
   * "far far away" are all real English, so only these are ever offered. */
  const STUTTER = new Set(('the a an i we you he she they it and but to of in is was are were my our your this for with '
    + "as at be will can do if or me us them him her his its i'm we're you're they're there their has have not on from by "
    + 'when what who because').split(' '));

  /* Comparatives, after which "then" is always "than". */
  const COMPARATIVE = new Set(('more less better worse greater bigger rather other smaller higher stronger older younger '
    + 'faster further farther larger fewer sooner easier harder richer poorer deeper wiser sweeter longer shorter louder').split(' '));

  /* What can follow "its" only if it is really "it's". */
  const AFTER_ITS = new Set(('a an the not going gonna been so very all about like just me you him her us them '
    + 'okay ok true good great finished done over because what how when who where real written getting coming '
    + 'never always still already there here').split(' '));
  /* What can follow "your" only if it is really "you're". */
  const AFTER_YOUR = new Set('going gonna not welcome the a an very really always never still already trying'.split(' '));

  /* ------------------------------------------------------------------ *
   * The rules. Each one looks at the joined context — the tail of the line
   * before, this line, the head of the line after — and proposes edits to
   * single tokens: { at, to, kind, why, caseOnly }. `to: ''` deletes the word.
   * ------------------------------------------------------------------ */
  const K = (C, i) => (C[i] ? C[i].key : '');

  /* Fixed phrases that speech recognition produces in a sermon and that are
   * never right as written. Same number of words in and out, so a phrase split
   * across two caption lines can still be fixed one word per line. */
  const PHRASES = [
    ['holy goat', 'Holy Ghost', 'misheard'],
    ['holy ghost', 'Holy Ghost', 'name of God', true],
    ['holy spirit', 'Holy Spirit', 'name of God', true],
    ['let us prey', 'let us pray', 'pray, not prey'],
    ["let's prey", "let's pray", 'pray, not prey'],
    ['lets prey', "let's pray", 'pray, not prey'],
    ['we prey', 'we pray', 'pray, not prey'],
    ['i prey', 'I pray', 'pray, not prey'],
    ['prey for', 'pray for', 'pray, not prey'],
    ['prey that', 'pray that', 'pray, not prey'],
    ['prays the lord', 'praise the Lord', 'praise, not prays'],
    ['prays god', 'praise God', 'praise, not prays'],
    ['prays be', 'praise be', 'praise, not prays'],
    ['alter call', 'altar call', 'altar, not alter'],
    ['the alter', 'the altar', 'altar, not alter'],
    ['begotten sun', 'begotten Son', 'Son, not sun'],
    ['son of god', 'Son of God', 'name of Jesus', true],
    ['piece be with you', 'peace be with you', 'peace, not piece'],
    ['prince of piece', 'Prince of Peace', 'peace, not piece'],
    ['piece of god', 'peace of God', 'peace, not piece'],
    ['perfect piece', 'perfect peace', 'peace, not piece'],
    ['sole winning', 'soul winning', 'soul, not sole'],
    ['sole winners', 'soul winners', 'soul, not sole'],
    ['oh my sole', 'oh my soul', 'soul, not sole'],
    ['o my sole', 'O my soul', 'soul, not sole'],
    ['false profits', 'false prophets', 'prophets, not profits'],
    ['false profit', 'false prophet', 'prophet, not profit'],
    ['profit of god', 'prophet of God', 'prophet, not profit'],
    ['profits of god', 'prophets of God', 'prophets, not profits'],
    ['the lords prayer', "the Lord's Prayer", 'missing apostrophe'],
    ["the lord's prayer", "the Lord's Prayer", 'name of the prayer', true],
    ['lords supper', "Lord's Supper", 'missing apostrophe'],
    ['jesus name', "Jesus' name", 'missing apostrophe'],
    ['your welcome', "you're welcome", "you're = you are"],
    ['could of', 'could have', '"could have", not "could of"'],
    ['would of', 'would have', '"would have", not "would of"'],
    ['should of', 'should have', '"should have", not "should of"'],
    ['must of', 'must have', '"must have", not "must of"'],
    ['might of', 'might have', '"might have", not "might of"'],
    ['to much', 'too much', 'too = very'],
    ['to many', 'too many', 'too = very'],
    ['there going', "they're going", "they're = they are"],
    ['there gonna', "they're gonna", "they're = they are"],
    ['their is', 'there is', 'there is, not their is'],
    ['their are', 'there are', 'there are, not their are'],
    ['their was', 'there was', 'there was, not their was'],
    ['their were', 'there were', 'there were, not their were'],
    ["it's own", 'its own', 'its own (no apostrophe)'],
    ['suppose to', 'supposed to', 'supposed to'],
    ['every since', 'ever since', 'ever since'],
  ].map(([from, to, why, caseOnly]) => ({ from: from.split(' '), to: to.split(' '), why, caseOnly: !!caseOnly }));
  const GODS_WHAT = new Set(('word love grace glory presence power kingdom people children house plan promise promises '
    + 'favour favor mercy spirit son name hand heart time way voice will goodness faithfulness blessing blessings').split(' '));
  const PROPHET_NAMES = new Set('isaiah jeremiah elijah elisha ezekiel daniel jonah samuel nathan moses hosea joel amos micah habakkuk malachi zechariah'.split(' '));

  function runRules(C) {
    const edits = [];
    const add = (at, to, kind, why, caseOnly, group) => edits.push({ at, to, kind, why, caseOnly: !!caseOnly, group: group == null ? 'r' + at + kind : group });

    // Phrases first, so their edits take precedence over the single-word rules.
    for (let i = 0; i < C.length; i++) {
      for (const p of PHRASES) {
        if (i + p.from.length > C.length) continue;
        let hit = true;
        for (let j = 0; j < p.from.length; j++) if (C[i + j].key !== p.from[j]) { hit = false; break; }
        if (!hit) continue;
        const grp = 'p' + i + p.from.join('_');
        for (let j = 0; j < p.from.length; j++) {
          const caseOnly = p.caseOnly || keyOf(p.to[j]) === C[i + j].key;
          add(i + j, p.to[j], caseOnly ? 'case' : 'word', p.why, caseOnly, grp);
        }
      }
    }

    for (let i = 0; i < C.length; i++) {
      const k = C[i].key;
      if (!k) continue;
      const prev = K(C, i - 1), next = K(C, i + 1);

      // missing apostrophes
      if (Object.prototype.hasOwnProperty.call(CONTRACTIONS, k) && CONTRACTIONS[k]) {
        add(i, CONTRACTIONS[k], 'apostrophe', 'missing apostrophe');
      }
      // "its" that is really "it's"
      if (k === 'its' && AFTER_ITS.has(next)) add(i, "it's", 'word', "it's = it is");
      // "your" that is really "you're"
      if (k === 'your' && AFTER_YOUR.has(next)) add(i, "you're", 'word', "you're = you are");
      // than / then
      if (k === 'then' && COMPARATIVE.has(prev)) add(i, 'than', 'word', 'than, after a comparison');
      // lose / loose
      if (k === 'loose' && /^(will|to|not|never|gonna|can|could|might|don't|dont|shall|would|cannot)$/.test(prev)) add(i, 'lose', 'word', 'lose, not loose');
      // used to
      if (k === 'use' && next === 'to' && /^(i|we|you|they|he|she|it|who)$/.test(prev) && /^(be|go|have|say|think|do|come|sing|pray|know|live|work|tell)$/.test(K(C, i + 2))) add(i, 'used', 'word', '"used to"');
      // alot
      if (k === 'alot') add(i, 'a lot', 'word', '"a lot" is two words');
      // God's + noun
      if (k === 'gods' && GODS_WHAT.has(next) && prev !== 'the' && prev !== 'false' && prev !== 'other') add(i, "God's", 'apostrophe', "God's (belonging to God)");
      // "the profit isaiah"
      if ((k === 'profit') && PROPHET_NAMES.has(next)) add(i, 'prophet', 'word', 'prophet, not profit');

      // a / an
      if ((k === 'a' || k === 'an') && next && /^[a-z]/.test(next) && !/^(plan|grade|option|type|class|vitamin|letter|point|part|section|exhibit)$/.test(prev)) {
        const v = soundsVowel(next);
        if (v === true && k === 'a') add(i, 'an', 'word', '"an" before a vowel sound');
        if (v === false && k === 'an') add(i, 'a', 'word', '"a" before a consonant sound');
      }

      // the stammer
      if (prev && k === prev && STUTTER.has(k)) add(i, '', 'repeat', 'word said twice');

      // capitals
      if (PRONOUN_I[k]) add(i, PRONOUN_I[k], 'case', '"I" is always a capital', true);
      if (k === 'god' || k === "god's") {
        if (!/^(a|false|another|foreign|strange|pagan|other|any|no|every|little)$/.test(prev)) add(i, k === 'god' ? 'God' : "God's", 'case', 'God is a name', true);
      }
      if ((k === 'lord' || k === "lord's") && (/^(the|our|my|o|oh|dear|risen|sovereign|mighty|almighty|praise|thank|bless)$/.test(prev) || /^(jesus|god|almighty|christ)$/.test(next))) {
        add(i, k === 'lord' ? 'Lord' : "Lord's", 'case', 'Lord is a name here', true);
      }
      if (PROPER.has(k)) add(i, PROPER.get(k), 'case', 'a name', true);
      if (BOOK_BEFORE_NUMBER[k] && isNumberish(next)) {
        add(i, BOOK_BEFORE_NUMBER[k], k === 'psalms' ? 'word' : 'case', k === 'psalms' ? 'one psalm: "Psalm 23"' : 'a book of the Bible', k !== 'psalms');
      }
    }
    return edits;
  }

  /**
   * Does this word start with a vowel SOUND? true / false, or null when the
   * spelling cannot say (digits, acronyms).
   */
  function soundsVowel(w) {
    const k = keyOf(w).replace(/[^a-z']/g, '');
    if (!k) return null;
    if (/^(hour|honest|honou?r|heir|herb)/.test(k)) return true;
    if (/^(uni|use|usu|uti|ute|ura|ure|uro|eu|ewe|one|once|ubiq|uk)/.test(k)) return false;
    return /^[aeiou]/.test(k);
  }

  /* ------------------------------------------------------------------ *
   * Checking
   * ------------------------------------------------------------------ */
  const TAIL = 3;

  /**
   * Everything wrong with one line, and the line with all of it fixed.
   *
   *   { text, fixed, issues: [{ start, end, from, to, kind, why, id }] }
   *
   * `start`/`end` are character offsets into `text`, for underlining.
   * opts: { caseMode, prev, next }  — prev/next are the neighbouring lines' text.
   */
  function checkLine(text, opts) {
    const o = opts || {};
    const src = String(text == null ? '' : text);
    const style = lineStyle(src, o.caseMode);
    const toks = tokenize(src);
    const before = tokenize(o.prev || '').slice(-TAIL).map((t) => Object.assign(t, { inLine: false }));
    const after = tokenize(o.next || '').slice(0, TAIL).map((t) => Object.assign(t, { inLine: false }));
    const C = before.concat(toks.map((t, li) => Object.assign({}, t, { inLine: true, li })), after);
    const raw = runRules(C);

    // One edit per token: the first rule to claim it (phrases run first).
    const byTok = new Map();
    for (const e of raw) {
      const t = C[e.at];
      if (!t || !t.inLine || byTok.has(t.li)) continue;
      if (e.caseOnly && (style === 'upper' || style === 'lower' || style === 'title')) continue;
      const dressed = e.to === '' ? '' : dress(e.to, t.core, style);
      if (dressed === t.core) continue;             // already right
      byTok.set(t.li, Object.assign({}, e, { dressed }));
    }

    // Group consecutive edits from the same rule into one issue ("Holy Ghost").
    const issues = [];
    const lis = [...byTok.keys()].sort((a, b) => a - b);
    for (const li of lis) {
      const e = byTok.get(li);
      const last = issues[issues.length - 1];
      if (last && last.group === e.group && last.b === li) {
        last.b = li + 1;
        last.edits.push({ li, dressed: e.dressed });
        if (!e.caseOnly) { last.kind = e.kind; last.why = e.why; }
        continue;
      }
      issues.push({ a: li, b: li + 1, group: e.group, kind: e.kind, why: e.why, edits: [{ li, dressed: e.dressed }] });
    }

    const out = issues.map((g) => {
      const span = toks.slice(g.a, g.b);
      const fromText = src.slice(span[0].start, span[span.length - 1].end);
      const toWords = span.map((t, j) => {
        const ed = g.edits.find((x) => x.li === g.a + j);
        if (!ed) return t.raw;
        if (ed.dressed === '') return '';
        return t.pre + ed.dressed + t.post;
      }).filter((w) => w !== '');
      // A deletion eats the space before it too, so "THE THE" → "THE" and not "THE ".
      let start = span[0].start;
      const end = span[span.length - 1].end;
      if (!toWords.length && g.a > 0) start = toks[g.a - 1].end;
      return {
        start, end, from: fromText, to: toWords.join(' '), kind: g.kind, why: g.why,
        id: keyOf(fromText) + '→' + keyOf(toWords.join(' ')),
      };
    });

    let fixed = src;
    for (let i = out.length - 1; i >= 0; i--) fixed = fixed.slice(0, out[i].start) + out[i].to + fixed.slice(out[i].end);
    fixed = tidySpaces(fixed);
    if (tidySpaces(src) !== src && !out.length) {
      out.push({ start: 0, end: src.length, from: src, to: tidySpaces(src), kind: 'space', why: 'extra spaces', id: 'space' });
    }
    return { text: src, fixed, issues: out, style };
  }

  const tidySpaces = (s) => String(s).replace(/\s+/g, ' ').replace(/\s+([!])/g, '$1').trim();

  /** Every line, each checked against its neighbours. `ignored(i, issue)` may veto. */
  function checkLines(lines, opts) {
    const L = (lines || []).map((x) => String(x == null ? '' : x));
    return L.map((t, i) => checkLine(t, Object.assign({}, opts, { prev: L[i - 1] || '', next: L[i + 1] || '' })));
  }

  /** Apply ONE issue to the text it was found in. */
  function applyIssue(text, issue) {
    const s = String(text == null ? '' : text);
    if (!issue) return s;
    return tidySpaces(s.slice(0, issue.start) + issue.to + s.slice(issue.end));
  }

  /* ------------------------------------------------------------------ *
   * The AI half: the brief, the parser, and the guard.
   * ------------------------------------------------------------------ */

  /**
   * The same strip the burn does — a caption has no full stops, commas,
   * question marks or quotes. Must stay identical to cleanCapText in
   * veditor.js and cleanCaptionText in captioner.js.
   */
  function stripCaptionPunct(t) {
    return String(t)
      .replace(/[’ʼ]/g, "'")
      .replace(/["“”„‟«»‹›″＂‘]/g, '')
      .replace(/[?？¿]/g, '')
      .replace(/[…⋯]/g, ' ')
      .replace(/[.,。．，、]/g, (m, i, s) => (/\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '') ? m : ''))
      .replace(/\s+/g, ' ')
      .trim();
  }

  const wordsOf = (s) => String(s || '').split(/\s+/).map((w) => keyOf(w).replace(/[^a-z0-9']/g, '')).filter(Boolean);
  function lcs(a, b) {
    const n = a.length, m = b.length;
    let prev = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      const cur = new Array(m + 1).fill(0);
      for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      prev = cur;
    }
    return prev[m];
  }

  /**
   * Word-level diff of two lines, for showing a suggestion: which words stay,
   * which go, which arrive. [{ text, op: 'same' | 'del' | 'add' }]
   */
  function diffWords(a, b) {
    const A = String(a || '').split(/\s+/).filter(Boolean), B = String(b || '').split(/\s+/).filter(Boolean);
    const n = A.length, m = B.length;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { out.push({ text: B[j], op: 'same' }); i++; j++; }
      else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ text: B[j], op: 'add' }); j++; }
      else { out.push({ text: A[i], op: 'del' }); i++; }
    }
    return out;
  }

  /** Edit distance between two short strings. */
  function lev(x, y) {
    const n = x.length, m = y.length;
    if (!n) return m; if (!m) return n;
    let prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i++) {
      const cur = [i];
      for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[m];
  }
  /** The same letters with the spaces moved — two letters' slack at most (case ignored). */
  function soundsSame(x, y) {
    const a = String(x).replace(/[^a-z0-9]/g, ''), b = String(y).replace(/[^a-z0-9]/g, '');
    if (!a || !b || Math.abs(a.length - b.length) > 2) return false;
    return lev(a, b) <= Math.min(2, Math.max(1, Math.floor(Math.max(a.length, b.length) / 3)));
  }

  /** Two words a recogniser could mistake for each other: same first letter, or nearly the same letters. */
  function closeWords(x, y) {
    const a = String(x).replace(/[^a-z0-9]/g, ''), b = String(y).replace(/[^a-z0-9]/g, '');
    if (!a || !b) return false;
    return a[0] === b[0] || soundsSame(a, b);
  }
  /** The word-level edit as one-for-one swaps: true when every change is a sound-alike swap (see vetAiLine). */
  function soundAlikeSwaps(A, B, tidy) {
    const ops = diffWords(A.join(' '), B.join(' '));
    const swaps = [];
    let dels = [], adds = [], loose = 0;
    const flush = () => {
      const n = Math.min(dels.length, adds.length);
      for (let k = 0; k < n; k++) swaps.push([dels[k], adds[k]]);
      loose += dels.length - n + adds.length - n;
      dels = []; adds = [];
    };
    for (const o of ops) {
      if (o.op === 'same') flush();
      else if (o.op === 'del') dels.push(o.text);
      else adds.push(o.text);
    }
    flush();
    if (!swaps.length || loose > (tidy ? 1 : 0)) return false;
    if (swaps.length > Math.max(1, Math.ceil(A.length / 2))) return false;
    return swaps.every(([x, y]) => closeWords(x, y));
  }

  /*
   * ►► "KEEP THEIR EXACT WORDS" MEANS NO WORD IN AND NO WORD OUT. ◄◄
   *
   * Measured on the live server, on a sermon whose captions were already 98.9%
   * right: the automatic AI check (Groq's gpt-oss-20b) made eleven "sure" fixes
   * and TEN were wrong — the error rate went from 1.1% to 3.0%. Almost all of
   * them were the same mistake: a caption line is three words cut out of a
   * sentence ("LIE THOUGH IT", "BECOME NEW ZACCHAEUS"), the model read the
   * fragment as a broken sentence and "fixed" it by DELETING the words that
   * belong to the next one — "though it", "Zacchaeus", "this", "the" — or
   * pushed a word into the line ("PHILIPPINES CHAPTER 4 VERSE"). The old limit
   * counted changes, and two deleted words in a three-word line were within it.
   *
   * A misheard word is a SWAP: the right word for one that sounds like it. So in
   * exact mode every change must be one of
   *   • one word for a word that sounds like it   (face → faith, sun → Son)
   *   • the same sounds re-spaced                  (is real → Israel, a men → Amen)
   *   • a word the recogniser said twice, once     (the the → the)
   * and anything else — a word dropped, a word added, a word swapped for one
   * that sounds nothing like it ("by" → "power") — is not a correction.
   */
  const lettersOnly = (w) => String(w || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  /** How a word starts to the ear: the silent letters some spellings start with go
   *  ("who"/"whole" start with an h sound, every other wh- with a w). */
  const heardStart = (w) => w.replace(/^(ps|pn|kn|gn|wr)/, (m) => m[1]).replace(/^ph/, 'f').replace(/^who/, 'ho').replace(/^wh/, 'w');
  /*
   * The first SOUND, for the "starts the same" gate. Letters lie about it in
   * both directions: "cent" and "sent" start alike, "hour" and "our" do (the h
   * is silent, and many accents drop it anyway), so do "eight" and "ate" — any
   * two words that open on a vowel. Found by review: the first letter alone
   * refused all of these ordinary homophone corrections.
   */
  function firstSound(w) {
    if (/^h?[aeiouy]/.test(w)) return 'V';
    if (/^c[eiy]/.test(w)) return 's';
    const c = w[0];
    return c === 'k' || c === 'q' || c === 'c' ? 'k' : c === 'z' ? 's' : c;
  }
  /** The consonants after the first sound — what survives an accent's vowels. */
  const skeleton = (w) => w[0] + w.slice(1).replace(/[aeiouyhw]/g, '');
  const likeness = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);
  function soundAlike(x, y) {
    // ("eight", "night", "though": a gh before a t, or at the end, is not heard)
    const a = heardStart(lettersOnly(x)).replace(/gh(?=t|$)/g, ''), b = heardStart(lettersOnly(y)).replace(/gh(?=t|$)/g, '');
    if (!a || !b) return false;
    if (soundsSame(a, b)) return true;
    if (firstSound(a) !== firstSound(b)) return false;
    // a silent or dropped h is not a letter of difference
    const bare = (w) => (/^h[aeiouy]/.test(w) ? w.slice(1) : w);
    return likeness(a, b) >= 0.5 || likeness(bare(a), bare(b)) >= 0.5 || likeness(skeleton(a), skeleton(b)) >= 0.5;
  }
  function onlySwaps(A, B) {
    const ops = diffWords(A.join(' '), B.join(' '));
    let dels = [], adds = [], prev = null, ok = true;
    const flush = (next) => {
      if (!dels.length && !adds.length) return;
      if (dels.length === adds.length) { if (!dels.every((d, k) => soundAlike(d, adds[k]))) ok = false; }
      else if (dels.length && adds.length && soundsSame(dels.join(''), adds.join(''))) { /* re-spaced */ }
      else if (!adds.length && dels.every((d, k) => d === prev || d === next || d === dels[k - 1] || d === dels[k + 1])) { /* said twice */ }
      else ok = false;
      dels = []; adds = [];
    };
    for (const o of ops) {
      if (o.op === 'same') { flush(o.text); prev = o.text; } else if (o.op === 'del') dels.push(o.text); else adds.push(o.text);
    }
    flush(null);
    return ok;
  }

  /**
   * Is the AI's version of a line a CORRECTION of it, or a rewrite? Returns the
   * line to offer (in the caption's own case) or null.
   *
   * The model is asked for corrections and told not to rephrase; this is where
   * that is enforced, because a model told not to do something is a model that
   * sometimes does it. A caption is what the preacher said, and a "better"
   * sentence they did not say is a wrong caption however well it reads.
   *
   * mode 'exact' (default) — at most half the words may change, min 2.
   * mode 'tidy'            — a little more room, for real grammar slips.
   */
  function vetAiLine(orig, suggested, opts) {
    const o = opts || {};
    const src = String(orig == null ? '' : orig);
    let t = stripCaptionPunct(String(suggested == null ? '' : suggested)).replace(/[^\p{L}\p{N}'’\- !&%$£#@]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return { ok: false, reason: 'empty' };
    const a = wordsOf(src), b = wordsOf(t);
    if (!b.length) return { ok: false, reason: 'empty' };
    const same = lcs(a, b);
    const changed = (a.length - same) + (b.length - same);
    const tidy = o.mode === 'tidy';
    const limit = tidy ? Math.max(3, Math.ceil(a.length * 0.6)) : Math.max(2, Math.ceil(a.length * 0.5));
    /*
     * A mishearing is often the same SOUNDS cut into different words — "is
     * real" for "Israel", "a men" for "Amen", "for giving" for "forgiving".
     * Counted in words that is a big change (two out, one in) and it was
     * thrown away as a rewrite, though it is the most typical fix there is.
     * So when the words differ a lot but the LETTERS barely do, it is a
     * respacing of what was heard, not a new sentence.
     */
    const respaced = changed > limit && Math.abs(b.length - a.length) <= 2 && soundsSame(a.join(''), b.join(''));
    /*
     * ►► WORD FOR A SOUND-ALIKE WORD, more than once in a short line. ◄◄
     * Captions run three words a line, so "FACE THAT WERE" -> "FAITH THAT WE"
     * is two thirds of the line — and was thrown away as a rewrite, leaving the
     * operator to fix both by hand. Counted word by word it is two swaps, each
     * keeping its word's sound (face/faith, were/we); a rewrite swaps in words
     * that sound like nothing that was there. So: every changed word replaced
     * one-for-one by a word that starts the same or sounds alike, nothing added
     * or dropped, at most half the line (rounded up) — a correction.
     */
    const swapped = changed > limit && !respaced && soundAlikeSwaps(a, b, tidy);
    if (changed > limit && !respaced && !swapped) return { ok: false, reason: 'rewrote the line' };
    if (!tidy && !onlySwaps(a, b)) return { ok: false, reason: 'added, dropped or replaced words' };
    // the same words in a different order is a rewrite, however small
    if (a.length === b.length && a.join(' ') !== b.join(' ') && a.slice().sort().join(' ') === b.slice().sort().join(' ')) return { ok: false, reason: 'reordered the words' };
    if (Math.abs(b.length - a.length) > (tidy ? 3 : 2)) return { ok: false, reason: 'changed the length' };
    const style = lineStyle(src, o.caseMode);
    if (style === 'upper') t = t.toUpperCase();
    else if (style === 'lower') t = t.toLowerCase();
    else if (style === 'title') t = titleWord(t);
    if (tidySpaces(t) === tidySpaces(src)) return { ok: false, reason: 'no change' };
    return { ok: true, text: tidySpaces(t) };
  }

  /*
   * ►► READ THE WHOLE SERMON FIRST. ◄◄
   * The proof-reader used to see forty caption lines and two either side —
   * no idea what the sermon was about, which passage was being preached,
   * who the people in it were or how the church spells its own name. A
   * misheard word is only wrong IN CONTEXT ("the lamb of guard" is nonsense
   * only if you know it is about the Lamb of God), so it missed most of them
   * and the operator fixed them by hand. Now the transcript is read once for
   * notes — topic, scriptures quoted, names, recurring words and mishearings
   * — and every batch is corrected with those notes, the church's own Word
   * Book, and a wide stretch of what was said either side.
   */
  const BRIEF_SCHEMA = {
    type: 'object',
    properties: {
      topic: { type: 'string' },
      speaker: { type: 'string' },
      scriptures: { type: 'array', items: { type: 'string' } },
      names: { type: 'array', items: { type: 'string' } },
      terms: { type: 'array', items: { type: 'string' } },
      mishearings: { type: 'array', items: { type: 'object', properties: { heard: { type: 'string' }, meant: { type: 'string' } }, required: ['heard', 'meant'], additionalProperties: false } },
    },
    required: ['topic', 'speaker', 'scriptures', 'names', 'terms', 'mishearings'],
    additionalProperties: false,
  };
  const FIX_SCHEMA = {
    type: 'object',
    properties: {
      fixes: { type: 'array', items: { type: 'object', properties: {
        n: { type: 'integer' }, text: { type: 'string' }, why: { type: 'string' }, sure: { type: 'boolean' },
      }, required: ['n', 'text', 'why', 'sure'], additionalProperties: false } },
    },
    required: ['fixes'],
    additionalProperties: false,
  };

  function buildBriefPrompt(transcript) {
    const system = [
      'You are helping correct the captions of a church sermon video. The transcript below was written by speech recognition,',
      'so some words are misheard as other words that sound alike. Read it all and write the notes a careful editor would want',
      'beside them while correcting the captions:',
      '- topic: what the sermon is about, in one or two sentences',
      '- speaker: who is preaching, if it is said (else "")',
      '- scriptures: every Bible passage read or quoted, as "Book chapter:verse — the words as the Bible has them"',
      '  (use the translation the preacher seems to use; only passages that are really there)',
      '- names: people, places, churches, ministries and events, spelled correctly',
      '- terms: words and phrases that come up again and again (spelled as they should be)',
      '- mishearings: words the speech recognition clearly got wrong, as heard -> meant — especially sounds the speaker\'s',
      '  accent makes it swap again and again (e.g. "face" -> "faith", "were" -> "we")',
      'Reply with JSON only: {"topic":"","speaker":"","scriptures":[],"names":[],"terms":[],"mishearings":[{"heard":"","meant":""}]}',
    ].join('\n');
    return { system, prompt: 'Transcript:\n' + String(transcript || '') };
  }
  function parseBrief(answer) {
    const j = firstJson(answer);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const list = (v, n) => (Array.isArray(v) ? v : []).map((x) => String(x == null ? '' : x).trim().slice(0, 200)).filter(Boolean).slice(0, n);
    const mis = (Array.isArray(j.mishearings) ? j.mishearings : [])
      .filter((m) => m && m.heard && m.meant && String(m.heard).trim().toLowerCase() !== String(m.meant).trim().toLowerCase())
      .slice(0, 30).map((m) => ({ heard: String(m.heard).trim().slice(0, 60), meant: String(m.meant).trim().slice(0, 60) }));
    const b = { topic: String(j.topic || '').trim().slice(0, 400), speaker: String(j.speaker || '').trim().slice(0, 80),
      scriptures: list(j.scriptures, 25), names: list(j.names, 40), terms: list(j.terms, 40), mishearings: mis };
    return b.topic || b.scriptures.length || b.names.length || b.terms.length ? b : null;
  }
  /** The notes, as the lines that go in front of every batch. */
  function briefText(b) {
    if (!b) return '';
    const out = [];
    if (b.topic) out.push('Topic: ' + b.topic);
    if (b.speaker) out.push('Speaker: ' + b.speaker);
    if (b.scriptures && b.scriptures.length) out.push('Scripture in this sermon:\n' + b.scriptures.map((x) => '  - ' + x).join('\n'));
    if (b.names && b.names.length) out.push('Names: ' + b.names.join(', '));
    if (b.terms && b.terms.length) out.push('Recurring words: ' + b.terms.join(', '));
    if (b.mishearings && b.mishearings.length) out.push('Mishearings seen in this transcript: ' + b.mishearings.map((m) => `"${m.heard}" -> "${m.meant}"`).join('; '));
    return out.join('\n');
  }

  /**
   * The brief for one batch. `batch` is [{ n, text, context }] — n is the
   * number the model refers to; context rows (old callers) are shown for
   * meaning but never returned. `opts`: mode, brief (notes object), terms
   * (the church's own spellings), known ([{from,to}] the editor fixed
   * before), before / after (the passage either side, as plain text).
   */
  function buildAiPrompt(batch, opts) {
    const o = opts || {};
    const tidy = o.mode === 'tidy';
    const system = [
      'You correct the burned-in captions of a church sermon video. Speech recognition wrote them, so some words are',
      'misheard as other words that sound alike, and your job is to make every line say what the preacher actually said.',
      '',
      'Read for meaning first: the caption lines run on from one another and a sentence usually spans several lines.',
      'Use the sermon notes, the passage before and after, and the lines around each one to work out what was really said —',
      'a word that sounds right but makes no sense where it stands is almost always a mishearing.',
      '',
      'Correct:',
      "- misheard words: 'holy goat' -> 'Holy Ghost', 'is real' -> 'Israel', 'a men' -> 'Amen', 'the lamb of guard' -> 'the Lamb of God',",
      "  'let us prey' -> 'let us pray', 'cavalry' -> 'Calvary' (the cross), 'only begotten sun' -> 'only begotten Son', 'sums' -> 'Psalms'",
      '- words split or joined wrongly by the recogniser, spelling mistakes, missing apostrophes',
      "- the wrong sound-alike word (there/their/they're, your/you're, its/it's, to/too, then/than, a/an, know/no, whole/hole)",
      "- sounds the speaker's accent makes the recogniser swap: 'face' for 'faith', 'tree' for 'three', 'tink' for 'think',",
      "  'world' for 'word', 'work' for 'walk', 'leave' for 'live', and small words it hears wrong ('were' for 'we', 'his' for 'is')",
      "  — two of these can be in one short line ('face that were receive' -> 'faith that we receive')",
      '- a word accidentally repeated by the recogniser (the the -> the)',
      '- capitals for God, Jesus, Lord, Holy Spirit/Holy Ghost, He/Him only where the speaker means God and the line already uses capitals that way,',
      '  books of the Bible, people, places and the church\'s own names',
      '- scripture the preacher is plainly quoting: the words as the Bible has them, where the recogniser garbled them',
      tidy
        ? '- clear grammar slips, keeping the speaker\'s own words and voice as far as possible'
        : '- nothing else: keep the speaker\'s own words, even informal spoken grammar, false starts and repeated phrases they really said',
      '',
      'Never rephrase or improve the wording, never add words that were not said, never add punctuation (captions have',
      'no full stops, commas or question marks), and never move words from one line to another.',
      'Lines may be written in ALL CAPS; answer in normal sentence case — the app puts the caps back.',
      '',
      'For each line you change, say if you are sure: true when the line as it stands is clearly wrong and your version',
      'is clearly what was said; false when it is a judgement call. Leave a line alone when you cannot tell.',
      '',
      'Reply with JSON only, listing ONLY the lines you changed:',
      '{"fixes":[{"n":12,"text":"the corrected line","why":"3 to 6 words","sure":true}]}',
      'If nothing needs fixing reply {"fixes":[]}.',
    ].join('\n');
    const parts = [];
    const notes = typeof o.brief === 'string' ? o.brief : briefText(o.brief);
    if (notes) parts.push('SERMON NOTES (from the whole transcript):\n' + notes);
    const terms = (o.terms || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 60);
    if (terms.length) parts.push('WORDS THIS CHURCH USES — spell them exactly like this: ' + terms.join(', '));
    const known = (o.known || []).filter((k) => k && k.from && k.to).slice(0, 40);
    if (known.length) parts.push('CORRECTIONS THE EDITOR HAS MADE BEFORE (the same mishearings come back): ' + known.map((k) => `"${k.from}" -> "${k.to}"`).join('; '));
    if (o.before) parts.push('WHAT WAS SAID JUST BEFORE (for meaning only):\n' + o.before);
    const rows = (batch || []).map((r) => (r.context ? `(${r.n}) ${r.text}   <- context only, do not return` : `${r.n} | ${r.text}`));
    parts.push('CAPTION LINES TO CHECK (number | text):\n' + rows.join('\n'));
    if (o.after) parts.push('WHAT IS SAID RIGHT AFTER (for meaning only):\n' + o.after);
    return { system, prompt: parts.join('\n\n') };
  }

  /** Pull the first balanced JSON value out of an answer (models wrap it in prose). */
  function firstJson(text) {
    const s = String(text || '');
    for (let start = 0; start < s.length; start++) {
      const open = s[start];
      if (open !== '{' && open !== '[') continue;
      const close = open === '{' ? '}' : ']';
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { break; } }
        }
      }
    }
    return null;
  }

  /** The model's answer → [{ n, text, why }] for numbers that were really asked about. */
  function parseAiFixes(answer, batch) {
    const j = firstJson(answer);
    const list = Array.isArray(j) ? j : (j && Array.isArray(j.fixes) ? j.fixes : null);
    if (!list) return null;
    const asked = new Map((batch || []).filter((r) => !r.context).map((r) => [Number(r.n), r]));
    const out = [];
    const seen = new Set();
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      const n = Number(f.n != null ? f.n : (f.line != null ? f.line : f.i));
      if (!asked.has(n) || seen.has(n)) continue;
      const text = typeof f.text === 'string' ? f.text : (typeof f.fixed === 'string' ? f.fixed : null);
      if (text == null) continue;
      seen.add(n);
      out.push({ n, text, why: String(f.why || f.reason || '').slice(0, 80), sure: f.sure === true || f.sure === 'true' });
    }
    return out;
  }

  return {
    tokenize, lineStyle, dress, soundsVowel,
    checkLine, checkLines, applyIssue, tidySpaces,
    stripCaptionPunct, diffWords, vetAiLine, buildAiPrompt, parseAiFixes, firstJson, soundsSame,
    buildBriefPrompt, parseBrief, briefText, BRIEF_SCHEMA, FIX_SCHEMA,
    CONTRACTIONS, PHRASES, STUTTER, PROPER,
  };
}));
