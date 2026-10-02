'use strict';
/*
 * WHAT THE PREACHER JUST SAID, AS AN INSTRUCTION FOR THE SCREEN.
 *
 * This is the whole brain of 🎤 Listen in the Presentation Studio. Speech comes
 * in as a line of text from whisper; what has to come out is either a clear
 * instruction ("put John 3:16 up", "move on one", "go back") or — far more
 * often — NOTHING AT ALL, because the preacher is simply preaching.
 *
 * Getting the nothing right is the hard half. A sermon is forty minutes of
 * continuous speech and the screen must not twitch once in all of it unless it
 * was actually asked to. Every rule below is therefore written to be narrow on
 * purpose, and test/voice-intent.test.js runs a corpus of real sermon sentences
 * through it that must ALL come back null — "we'll come back to that later",
 * "the next thing Paul says", "he was one of the twelve" — alongside the ones
 * that must fire. A rule that catches one more phrasing is worthless if it also
 * catches an ordinary sentence.
 *
 * Kept pure and free of audio, ffmpeg and Electron so it can be tested by the
 * thousand in milliseconds. The listener that feeds it lives in voicelisten.js.
 */

/* ============================ the books ============================
 *
 * Deliberately NOT bible.js's findBook. That one is built for a search box,
 * where a person typing "is" means Isaiah and a prefix match is a kindness.
 * Against live speech the same generosity is a disaster: "is", "am", "so",
 * "he" and "no" are all book abbreviations, and a sermon says them constantly.
 * Here only whole spoken names count, plus the handful of shortenings people
 * actually SAY out loud ("Corinthians" for 1 Corinthians is not one of them —
 * that is ambiguous, so it is left out and the preacher's "first" decides).
 *
 * The `heard` lists are the other half: what whisper actually writes when it
 * mishears a name. They come from feeding spoken references through the real
 * model (test/voice-speech.test.js), not from imagination.
 */
const VOICE_BOOKS = [
  { nr: 1, name: 'Genesis', say: ['genesis'], heard: ['genesee', 'genes is'] },
  { nr: 2, name: 'Exodus', say: ['exodus'], heard: ['exodous'] },
  { nr: 3, name: 'Leviticus', say: ['leviticus'], heard: ['leviticus'] },
  { nr: 4, name: 'Numbers', say: ['numbers'], heard: [] },
  { nr: 5, name: 'Deuteronomy', say: ['deuteronomy'], heard: ['deuteronomy'] },
  { nr: 6, name: 'Joshua', say: ['joshua'], heard: [] },
  { nr: 7, name: 'Judges', say: ['judges'], heard: [] },
  { nr: 8, name: 'Ruth', say: ['ruth'], heard: [] },
  { nr: 9, name: '1 Samuel', say: ['samuel'], numbered: true, heard: ['sam you all'] },
  { nr: 10, name: '2 Samuel', say: ['samuel'], numbered: true, heard: [] },
  { nr: 11, name: '1 Kings', say: ['kings'], numbered: true, heard: [] },
  { nr: 12, name: '2 Kings', say: ['kings'], numbered: true, heard: [] },
  { nr: 13, name: '1 Chronicles', say: ['chronicles'], numbered: true, heard: [] },
  { nr: 14, name: '2 Chronicles', say: ['chronicles'], numbered: true, heard: [] },
  { nr: 15, name: 'Ezra', say: ['ezra'], heard: [] },
  { nr: 16, name: 'Nehemiah', say: ['nehemiah'], heard: ['nehemia'] },
  { nr: 17, name: 'Esther', say: ['esther'], heard: [] },
  { nr: 18, name: 'Job', say: ['job'], heard: [] },
  { nr: 19, name: 'Psalms', say: ['psalms', 'psalm', 'the psalms'], heard: ['salm', 'salms', 'sam'] },
  { nr: 20, name: 'Proverbs', say: ['proverbs', 'proverb'], heard: [] },
  { nr: 21, name: 'Ecclesiastes', say: ['ecclesiastes'], heard: ['ecclesiastes'] },
  { nr: 22, name: 'Song of Solomon', say: ['song of solomon', 'song of songs'], heard: [] },
  { nr: 23, name: 'Isaiah', say: ['isaiah'], heard: ['isiah', 'i saiah'] },
  { nr: 24, name: 'Jeremiah', say: ['jeremiah'], heard: ['jeremia'] },
  { nr: 25, name: 'Lamentations', say: ['lamentations'], heard: [] },
  { nr: 26, name: 'Ezekiel', say: ['ezekiel'], heard: ['ezekial'] },
  { nr: 27, name: 'Daniel', say: ['daniel'], heard: [] },
  { nr: 28, name: 'Hosea', say: ['hosea'], heard: [] },
  { nr: 29, name: 'Joel', say: ['joel'], heard: [] },
  { nr: 30, name: 'Amos', say: ['amos'], heard: [] },
  { nr: 31, name: 'Obadiah', say: ['obadiah'], heard: [] },
  { nr: 32, name: 'Jonah', say: ['jonah'], heard: [] },
  { nr: 33, name: 'Micah', say: ['micah'], heard: [] },
  { nr: 34, name: 'Nahum', say: ['nahum'], heard: [] },
  { nr: 35, name: 'Habakkuk', say: ['habakkuk'], heard: ['habakuk'] },
  { nr: 36, name: 'Zephaniah', say: ['zephaniah'], heard: [] },
  { nr: 37, name: 'Haggai', say: ['haggai'], heard: [] },
  { nr: 38, name: 'Zechariah', say: ['zechariah'], heard: ['zecharia'] },
  { nr: 39, name: 'Malachi', say: ['malachi'], heard: [] },
  { nr: 40, name: 'Matthew', say: ['matthew'], heard: ['mathew', 'matthews'] },
  { nr: 41, name: 'Mark', say: ['mark'], heard: [] },
  { nr: 42, name: 'Luke', say: ['luke'], heard: [] },
  { nr: 43, name: 'John', say: ['john'], heard: ['jon', 'johns'] },
  { nr: 44, name: 'Acts', say: ['acts', 'the acts', 'the acts of the apostles'], heard: ['axe'] },
  { nr: 45, name: 'Romans', say: ['romans'], heard: ['roman'] },
  { nr: 46, name: '1 Corinthians', say: ['corinthians'], numbered: true, heard: ['corinthian', 'corinthans'] },
  { nr: 47, name: '2 Corinthians', say: ['corinthians'], numbered: true, heard: ['corinthian', 'corinthans'] },
  { nr: 48, name: 'Galatians', say: ['galatians'], heard: ['galatian'] },
  { nr: 49, name: 'Ephesians', say: ['ephesians'], heard: ['ephesian', 'efesians'] },
  { nr: 50, name: 'Philippians', say: ['philippians'], heard: ['philippian', 'filipians', 'phillipians'] },
  { nr: 51, name: 'Colossians', say: ['colossians'], heard: ['colossian'] },
  { nr: 52, name: '1 Thessalonians', say: ['thessalonians'], numbered: true, heard: ['thessalonian'] },
  { nr: 53, name: '2 Thessalonians', say: ['thessalonians'], numbered: true, heard: ['thessalonian'] },
  { nr: 54, name: '1 Timothy', say: ['timothy'], numbered: true, heard: [] },
  { nr: 55, name: '2 Timothy', say: ['timothy'], numbered: true, heard: [] },
  { nr: 56, name: 'Titus', say: ['titus'], heard: [] },
  { nr: 57, name: 'Philemon', say: ['philemon'], heard: [] },
  { nr: 58, name: 'Hebrews', say: ['hebrews'], heard: ['hebrew'] },
  { nr: 59, name: 'James', say: ['james'], heard: [] },
  { nr: 60, name: '1 Peter', say: ['peter'], numbered: true, heard: [] },
  { nr: 61, name: '2 Peter', say: ['peter'], numbered: true, heard: [] },
  { nr: 62, name: '1 John', say: ['john'], numbered: true, heard: ['jon'] },
  { nr: 63, name: '2 John', say: ['john'], numbered: true, heard: ['jon'] },
  { nr: 64, name: '3 John', say: ['john'], numbered: true, heard: ['jon'] },
  { nr: 65, name: 'Jude', say: ['jude'], heard: [] },
  { nr: 66, name: 'Revelation', say: ['revelation', 'revelations', 'the revelation'], heard: [] },
];

/* ============================ numbers ============================ */
const ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16,
  seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40,
  fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90,
};
const isNumWord = (w) => ONES[w] != null || TENS[w] != null || ORDINALS[w] != null || w === 'hundred';

/**
 * Spoken numbers to digits, one run of number words at a time.
 *
 * "chapter twenty three verse one" -> "chapter 23 verse 1"
 * "psalm one hundred and nineteen" -> "psalm 119"
 *
 * The join rules are the ones English actually uses out loud: tens absorb a
 * following unit (twenty + three = 23), hundred multiplies what came before
 * (one + hundred = 100) and absorbs what follows (100 + nineteen = 119), and
 * anything else starts a new number — which is what keeps "three sixteen" two
 * numbers, because that is how "John three sixteen" is meant.
 */
function digitsFor(words) {
  const out = [];
  let cur = null, pendingHundred = false;
  const flush = () => { if (cur != null) out.push(cur); cur = null; pendingHundred = false; };
  for (const w of words) {
    // "a hundred AND nineteen" — the and belongs to the number, not after it
    if (w === 'and' && pendingHundred) continue;
    if (w === 'hundred') {
      if (cur == null) cur = 1;
      cur *= 100; pendingHundred = true; continue;
    }
    const unit = ONES[w] != null ? ONES[w] : ORDINALS[w];
    const ten = TENS[w];
    if (ten != null) {
      if (pendingHundred) { cur += ten; pendingHundred = false; }
      else { flush(); cur = ten; }
      continue;
    }
    if (unit != null) {
      if (pendingHundred) { cur += unit; pendingHundred = false; }
      // a bare ten's slot waiting for its unit: twenty + three
      else if (cur != null && cur % 10 === 0 && cur >= 20 && cur < 100 && unit < 10) cur += unit;
      else { flush(); cur = unit; }
      continue;
    }
    flush();
  }
  flush();
  return out;
}
function spokenNumbers(text) {
  const words = text.split(' ');
  const out = [];
  let run = [];
  const spill = () => { if (run.length) { out.push(...digitsFor(run).map(String)); run = []; } };
  for (const w of words) {
    // "and" only continues a number when a hundred is waiting for its tail
    if (isNumWord(w) || (w === 'and' && run.length && run[run.length - 1] === 'hundred')) { run.push(w); continue; }
    spill();
    out.push(w);
  }
  spill();
  return out.join(' ');
}

/* ============================ text ============================ */
function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9:\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * WHISPER STUTTERS, AND THE STUTTER USED TO EAT THE INSTRUCTION.
 *
 * On a short phrase the model often emits the same words several times over —
 * reported from a real service, "verse five" came back as `verse 5 verse 5
 * verse`, and "next verse" as `next verse next verse`. The second happened to
 * survive because its pattern is unanchored; the first did not match anything
 * at all and the screen never moved, which from the desk looks exactly like the
 * feature ignoring you.
 *
 * So an immediately repeated run of words collapses to one before anything is
 * parsed. Only IMMEDIATE repeats, longest first: "verse 5 verse 5" is a stutter,
 * "verse 5 and then verse 5" is somebody saying it twice on purpose and is left
 * alone. The dangling half-repeat a stutter leaves behind ("… verse") goes too,
 * but only when it is a prefix of the run it follows.
 */
function deStutter(text) {
  let w = text.split(' ').filter(Boolean);
  for (let again = true; again;) {
    again = false;
    for (let n = Math.min(8, w.length >> 1); n >= 1 && !again; n--) {
      for (let i = 0; i + 2 * n <= w.length; i++) {
        let same = true;
        for (let k = 0; k < n && same; k++) if (w[i + k] !== w[i + n + k]) same = false;
        if (!same) continue;
        w = w.slice(0, i + n).concat(w.slice(i + 2 * n));
        again = true;
        break;
      }
    }
  }
  // …and the tail of a stutter that was cut off part-way through
  for (let n = Math.min(5, w.length - 1); n >= 1; n--) {
    const tail = w.slice(w.length - n), before = w.slice(w.length - 2 * n, w.length - n);
    if (before.length === n && tail.every((x, k) => x === before[k])) { w = w.slice(0, w.length - n); n = Math.min(5, w.length - 1) + 1; }
  }
  for (let n = 3; n >= 1; n--) {
    if (w.length <= n) continue;
    const head = w.slice(0, n), tail = w.slice(w.length - n);
    if (tail.every((x, k) => x === head[k]) && w.length >= 2 * n + 1) { w = w.slice(0, w.length - n); break; }
  }
  return w.join(' ');
}

/* ============================ commands ============================
 *
 * Every one of these has to be something a person says TO the screen, not
 * something they might say while preaching. "next verse" is safe. A bare "next"
 * is not — "next week", "next time", "the next thing" — so it is only accepted
 * with a noun that means the screen, or with an explicit "go to".
 */
/*
 * Note the digits. Everything here runs AFTER spokenNumbers, so a spoken "one"
 * has already become "1" — matching the word would never fire.
 *
 * The bare-count forms ("back one", "move on one") are anchored to the end of
 * what was said, because unanchored they are ordinary English: "I'll be back
 * one day", "we moved on one step at a time". Utterances arrive here one spoken
 * phrase at a time, so ending on the count is exactly what an instruction to the
 * screen looks like and a sentence carrying on is exactly what preaching looks
 * like.
 */
const NEXT_RE = [
  /\b(?:go(?:ing)?\s+(?:on\s+)?to\s+the|on\s+to\s+the|lets\s+(?:go\s+to\s+the|read\s+the)|and\s+the|now\s+the|read\s+the)\s+next\s+(?:verse|slide|1|line)\b/,
  /\bnext\s+(?:verse|slide)\b/,
  /\b(?:move|carry|go)\s+on\s+1\s*$/,
  // The noun is not optional. Without it this caught "and so we go on to the
  // next THING he teaches" — a sentence, not an instruction.
  /\b(?:move|carry|go)\s+on\s+to\s+the\s+next\s+(?:verse|slide|1|one)\b/,
  /\bnext\s+1\s+please\b/,
];
const PREV_RE = [
  // "previous" only, never "last": "the LAST verse of that song says it best"
  // is preaching, and it was firing until the sermon corpus caught it.
  /\bprevious\s+(?:verse|slide)\b/,
  /\bgo\s+back\s+to\s+the\s+(?:previous|last)\s+(?:verse|slide)\b/,
  /\b(?:go\s+)?back\s+(?:1|a)\s*(?:verse|slide)?\s*$/,
  /\bthe\s+verse\s+before\s+(?:that|this)\b/,
];
/* "verse twelve" on its own only means the screen when a passage is already on
 * it — otherwise "verse twelve says" is just preaching about verse twelve. */
const JUMP_RE = [
  /\b(?:go\s+to|jump\s+to|look\s+at|turn\s+to|back\s+to|down\s+to|over\s+to)\s+verse\s+(\d+)\b/,
  /\bverse\s+(\d+)\s+please\b/,
];
const CLEAR_RE = [/\b(?:clear|blank|black)\s+the\s+screen\b/, /\bscreen\s+off\b/, /\btake\s+(?:it|that)\s+(?:off|down)\b/];

/* ==================== SAID ON ITS OWN, TO THE SCREEN ====================
 *
 * "Carry on." "Go on." "Next one." "Go back." "Verse five." These are what an
 * operator actually says, and none of them can be recognised by pattern alone,
 * because every one is also ordinary preaching: "we must carry on in faith",
 * "go on, somebody!", "let us go back to what Paul said". The pattern is not
 * what makes them safe. Two other things do.
 *
 * FIRST, THEY MUST BE THE WHOLE UTTERANCE. Speech arrives here one phrase at a
 * time, so somebody who stops talking after "carry on" has said an instruction,
 * and somebody who carries straight on into "in faith" has not. A filler in
 * front ("ok", "right", "and") is allowed because that is how people speak; a
 * single word after it is not. This is the same reasoning that anchors the
 * bare-count forms above, applied to the whole phrase instead of its end.
 *
 * SECOND, THERE MUST BE SOMETHING TO NAVIGATE. A relative instruction with no
 * passage on the screen cannot have meant the screen, so these are refused
 * outright unless a chapter is up. That is what keeps them silent through the
 * thirty-nine minutes of a sermon when nothing is cued.
 *
 * Deliberately NOT here: "come on" ("come on somebody!" is said constantly and
 * means nothing to the screen), and a bare "next" or "back" on their own, which
 * the sermon corpus caught firing before.
 */
const LEAD = '(?:(?:ok|okay|alright|right|so|and|now|yes|yeah|please)\\s+){0,2}';
const TAIL = '(?:\\s+please|\\s+now|\\s+then)?';
const whole = (body) => new RegExp('^' + LEAD + '(?:' + body + ')' + TAIL + '$');
const BARE_NEXT_RE = [
  whole('go on|carry on|move on|moving on|next one|next 1|onward|onwards|continue|go ahead|keep going|go forward|forward'),
  whole('(?:go|move|carry) on to the next(?: one)?'),
];
const BARE_PREV_RE = [
  whole('go back|previous one|previous 1|1 back|back 1|the 1 before|the one before'),
];
/*
 * WHOLE CHAPTERS. "Previous chapter" is the chapter before this one, which is
 * also — when somebody has read straight through — the one they were on a
 * moment ago. Crossing a book boundary is deliberate: chapter 1 of Mark going
 * back should land on the end of Matthew, because that is where the text is,
 * and refusing to move at a boundary reads as the feature being broken.
 */
const CHAPTER_RE = [
  { re: whole('(?:(?:go|move|carry)\\s+(?:on\\s+)?to\\s+the\\s+|and\\s+the\\s+|now\\s+the\\s+|read\\s+the\\s+)?next\\s+chapter'), d: 1 },
  { re: whole('(?:(?:go|move)\\s+(?:back\\s+)?to\\s+the\\s+|back\\s+to\\s+the\\s+|read\\s+the\\s+)?(?:previous|last)\\s+chapter'), d: -1 },
  { re: whole('the\\s+chapter\\s+before(?:\\s+(?:that|this))?'), d: -1 },
  { re: whole('the\\s+chapter\\s+after(?:\\s+(?:that|this))?'), d: 1 },
  { re: whole('(?:go\\s+)?back\\s+a\\s+chapter'), d: -1 },
  { re: whole('(?:go\\s+)?on\\s+a\\s+chapter'), d: 1 },
];

/* ============================ the book in a sentence ============================ */
function bookAliases() {
  const out = [];
  for (const b of VOICE_BOOKS) {
    for (const a of b.say.concat(b.heard || [])) out.push({ alias: a, book: b });
  }
  // longest first so "song of solomon" wins over "song", "1 john" over "john"
  return out.sort((x, y) => y.alias.length - x.alias.length);
}
const ALIASES = bookAliases();
/*
 * "1st Corinthians" as well as "1 Corinthians". spokenNumbers has already
 * turned a spoken "first" into "1", but whisper sometimes writes the ordinal
 * itself — it produced "1st Corinthians Chapter 13 Verse 4" on the very same
 * sentence it wrote as "1 Corinthians" a moment earlier, and without these
 * three the whole reference was thrown away.
 */
const ORDINAL_PREFIX = /(?:^|\s)(1st|2nd|3rd|1|2|3|first|second|third|one|two|three)\s+$/;

/**
 * Where a book is named in the sentence, and which one.
 *
 * Numbered books need the number that was spoken in front of them — "first
 * Corinthians", "second Timothy", "three john". Without one, an ambiguous name
 * ("Corinthians", "Kings") is refused rather than guessed, because guessing
 * puts the wrong passage on the wall in front of a congregation. "John" is the
 * exception people expect: unqualified it is the gospel, not the letters.
 */
function findBookIn(text) {
  let best = null;
  for (const { alias, book } of ALIASES) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(alias, from);
      if (at < 0) break;
      from = at + 1;
      const before = text[at - 1], after = text[at + alias.length];
      if ((before !== undefined && before !== ' ') || (after !== undefined && after !== ' ')) continue;
      const pre = ORDINAL_PREFIX.exec(text.slice(0, at));
      const spokenNr = pre ? ({ 1: 1, '1st': 1, first: 1, one: 1, 2: 2, '2nd': 2, second: 2, two: 2, 3: 3, '3rd': 3, third: 3, three: 3 })[pre[1]] : null;
      let chosen = book;
      if (book.numbered) {
        if (!spokenNr) {
          // Unqualified: the gospel of John is what "John" means; the rest are
          // genuinely ambiguous and are left alone.
          if (book.name.endsWith('John')) chosen = VOICE_BOOKS.find((b) => b.nr === 43);
          else continue;
        } else {
          const wanted = VOICE_BOOKS.find((b) => b.numbered
            && b.say.includes(book.say[0]) && b.name.startsWith(String(spokenNr) + ' '));
          if (!wanted) continue;
          chosen = wanted;
        }
      } else if (spokenNr && book.nr === 43 && spokenNr <= 3) {
        // "first john" said while the plain gospel alias matched
        chosen = VOICE_BOOKS.find((b) => b.name === `${spokenNr} John`) || book;
      }
      const start = spokenNr && (book.numbered || chosen.name !== book.name)
        ? at - String(pre[1]).length - 1 : at;
      const cand = { book: chosen, at: Math.max(0, start), end: at + alias.length };
      // the LAST reference in a sentence is the one being turned to
      if (!best || cand.at >= best.at) best = cand;
      break;
    }
  }
  return best;
}

/* ============================ chapter and verse ============================ */
/**
 * The numbers after a book name, in the orders people say them.
 *
 * `verseCount(bookNr, chapter)` is optional but worth passing: it is what tells
 * "psalm one nineteen" (Psalm 119, said as two numbers) from "john three
 * sixteen" (John 3:16). Chapter 1 of Psalms has six verses, so verse 19 cannot
 * exist there and 119 is the only reading that survives. Without it the
 * chapter-then-verse reading is assumed, which is right far more often.
 */
function chapterVerse(tail, book, verseCount) {
  const t = tail.trim();
  let m;
  if ((m = /^chapters?\s+(\d+)\s*(?:verses?|vs|v)\s+(\d+)(?:\s*(?:-|to|through|and)\s*(\d+))?/.exec(t))) {
    return { chapter: +m[1], from: +m[2], to: m[3] ? +m[3] : null };
  }
  if ((m = /^chapters?\s+(\d+)\b/.exec(t))) return { chapter: +m[1], from: null, to: null };
  if ((m = /^(\d+)\s*[:\-]\s*(\d+)(?:\s*(?:-|to|through)\s*(\d+))?/.exec(t))) {
    return { chapter: +m[1], from: +m[2], to: m[3] ? +m[3] : null };
  }
  if ((m = /^(\d+)\s+(?:verses?|vs|v)\s+(\d+)(?:\s*(?:-|to|through|and)\s*(\d+))?/.exec(t))) {
    return { chapter: +m[1], from: +m[2], to: m[3] ? +m[3] : null };
  }
  if ((m = /^(\d+)\s+(\d+)(?:\s*(?:-|to|through)\s*(\d+))?/.exec(t))) {
    const a = +m[1], b = +m[2];
    if (verseCount) {
      const n = verseCount(book.nr, a);
      // Psalm 1 has 6 verses, so "psalm one nineteen" cannot be 1:19 — it is 119.
      if (n != null && b > n) {
        const joined = parseInt(String(a) + String(b), 10);
        if (verseCount(book.nr, joined) != null) return { chapter: joined, from: null, to: null };
      }
    }
    return { chapter: a, from: b, to: m[3] ? +m[3] : null };
  }
  if ((m = /^(\d+)\b/.exec(t))) return { chapter: +m[1], from: null, to: null };
  // "Jude verse 4", "3 John verse 4" — the one-chapter letters are referred to
  // by verse alone, and that is the only place chapter 1 can be assumed.
  if ((m = /^(?:verses?|vs|v)\s+(\d+)(?:\s*(?:-|to|through|and)\s*(\d+))?/.exec(t))) {
    return { chapter: 1, from: +m[1], to: m[2] ? +m[2] : null };
  }
  return null;
}

/* ============================ the whole job ============================ */
/**
 * One line of heard speech -> one instruction for the screen, or null.
 *
 * `live` describes what is on the wall right now ({ bookNr, chapter, verse }),
 * which is what lets "verse twelve" and "next verse" mean anything at all.
 */
function parseVoice(raw, { live = null, verseCount = null } = {}) {
  const text = spokenNumbers(deStutter(normalise(raw)));
  if (!text) return null;
  // Something has to be on the screen before a relative instruction can mean it.
  const onScreen = !!(live && live.chapter);

  const hit = findBookIn(text);
  if (hit) {
    const cv = chapterVerse(text.slice(hit.end), hit.book, verseCount);
    if (cv) {
      const verses = cv.from == null ? null
        : (cv.to ? range(cv.from, cv.to) : [cv.from]);
      return {
        kind: 'ref', bookNr: hit.book.nr, book: hit.book.name,
        chapter: cv.chapter, verses,
        ref: verses ? `${hit.book.name} ${cv.chapter}:${verses[0]}${verses.length > 1 ? '-' + verses[verses.length - 1] : ''}`
          : `${hit.book.name} ${cv.chapter}`,
        said: raw,
      };
    }
  }

  // A bare "verse 12" only counts against a passage already on the screen.
  for (const re of JUMP_RE) {
    const m = re.exec(text);
    if (m && onScreen) return { kind: 'verse', verse: +m[1], said: raw };
  }
  /*
   * …and "verse five" SAID ON ITS OWN is the commonest way of all to ask for
   * one. It was refused until now — reported from a real service, the operator
   * said "verse five", the log showed it, and the screen did not move. What
   * makes it safe is the same rule as the phrases below: nothing else in the
   * utterance, and a passage already up. "Verse twelve says that God is
   * faithful" is a sentence and stays preaching.
   */
  {
    const m = whole('verse\\s+(\\d+)').exec(text);
    if (m && onScreen) return { kind: 'verse', verse: +m[1], said: raw };
  }
  for (const c of CHAPTER_RE) {
    const m = c.re.exec(text);
    if (!m || !onScreen) continue;
    return { kind: 'chapter', delta: c.d, said: raw };
  }
  if (NEXT_RE.some((re) => re.test(text))) return { kind: 'next', said: raw };
  if (PREV_RE.some((re) => re.test(text))) return { kind: 'prev', said: raw };
  if (onScreen && BARE_NEXT_RE.some((re) => re.test(text))) return { kind: 'next', said: raw };
  if (onScreen && BARE_PREV_RE.some((re) => re.test(text))) return { kind: 'prev', said: raw };
  if (CLEAR_RE.some((re) => re.test(text))) return { kind: 'clear', said: raw };
  return null;
}
const range = (a, b) => {
  const lo = Math.min(a, b), hi = Math.max(a, b), out = [];
  for (let v = lo; v <= hi && out.length < 200; v++) out.push(v);
  return out;
};

module.exports = { parseVoice, spokenNumbers, normalise, findBookIn, chapterVerse, VOICE_BOOKS };
