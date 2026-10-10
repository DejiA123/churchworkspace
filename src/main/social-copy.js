'use strict';
/**
 * VIRAL TITLE + CAPTION for a post, from whatever the app already knows.
 *
 * The button has to work on every machine, instantly, offline — so this is built
 * in two layers:
 *
 *   1. a rule engine that always runs. Its raw material is the FILE NAME, which
 *      for anything this app produced is the spoken hook itself
 *      ("short-Sister_Marela_God_bless_you-captioned-20260818.mp4"), because
 *      Long-to-shorts names each clip after the line it found. That is a far
 *      better seed than it sounds.
 *   2. the local thinking model, when the church has installed one — same seed,
 *      better sentences. If it is missing, slow, or answers with nonsense, the
 *      rule engine's answer is what ships.
 *
 * Everything here is pure and synchronous except `suggest`, so the wording can
 * be tested without a model, a network or a GPU.
 */

/* Words that are file-naming debris, never part of the hook. */
const NOISE = /^(short|clip|final|export|render|video|copy|new|edit|edited|captioned|reframed|v\d+|\d{6,}|\d{4}-\d{2}-\d{2})$/i;

/** The spoken hook buried in a file name, as readable words. */
function hookFromFilename(file) {
  const base = String(file || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const words = base
    .split(/[-_\s.]+/)
    .filter((w) => w && !NOISE.test(w))
    // a trailing 8-digit date and 6-digit time are the app's own stamp
    .filter((w) => !/^\d{5,}$/.test(w));
  const text = words.join(' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 3) return '';
  // Title-case only words that are not already shouting.
  return text.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/* ---------------------- what the clip actually SAYS ----------------------
 *
 * A file name is a poor substitute for the words. "short-Sister_Marela_God_bless
 * _you" tells you a name and a greeting; the clip might be four minutes on
 * Caleb's faith. Copy written from the name is therefore confidently wrong,
 * which for a church is worse than copy that is merely dull.
 *
 * So the transcript is the source, and the file name is only the fallback for
 * a clip with no speech in it (a music bed, a flyer, a title card).
 */

/** Sentences, from a raw transcript. */
function sentencesOf(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\s*\n+\s*/)
    .map((x) => x.trim())
    .filter((x) => x.split(/\s+/).length >= 3);
}

/* Words that mark a line worth pulling out — a promise, an instruction, a
 * declaration. Weighted rather than absolute: this picks the BEST line present,
 * it never requires one. */
const STRONG = /\b(god|jesus|lord|faith|grace|glory|spirit|pray|prayer|blessed|blessing|believe|receive|power|anointing|breakthrough|victory|healing|promise|purpose|destiny|today|never|always|every|must|will|can|remember|listen|watch|hear)\b/gi;

/** Score a candidate line for how well it would work as a hook. */
function hookScore(s) {
  const words = s.split(/\s+/).length;
  if (words < 4 || words > 26) return -1;               // too short to mean anything, too long to read
  let score = (s.match(STRONG) || []).length * 2;
  if (/[!?]$/.test(s)) score += 2;                       // a question or a shout stops a scroll
  if (/^(you|we|god|jesus|the lord|if|when|somebody|everybody)\b/i.test(s)) score += 2;
  // Short-form copy lives on direct address — a line that speaks TO the viewer
  // beats one that merely describes something.
  if (/\b(you|your|yours)\b/i.test(s)) score += 2;
  if (words >= 6 && words <= 14) score += 2;             // the length that fits on a screen
  if (/\b(um+|uh+|erm)\b/i.test(s)) score -= 3;
  return score;
}

/**
 * The most quotable line in the clip, plus a short summary of the rest.
 * Returns null when there is not enough speech to say anything honest about.
 *
 * `quotes` and `full` are what a hosted model gets and what the whole quality
 * of the copy turns on. A model handed twelve sentences writes about twelve
 * sentences; handed the clip, it writes about the clip. The cap is generous on
 * purpose — the models this now talks to have context measured in hundreds of
 * thousands of tokens, and the old 1,200-character ceiling was sized for a 1.5B
 * model running on a church PC.
 */
const FULL_CAP = 9000;
function readTranscript(text) {
  const sentences = sentencesOf(text);
  if (!sentences.length) return null;
  const total = sentences.join(' ').split(/\s+/).length;
  if (total < 12) return null;                           // a few stray words is not a sermon
  const scored = sentences
    .map((s) => ({ s, sc: hookScore(s) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc);
  const best = scored.length ? scored[0].s : null;
  const hook = (best || sentences[0]).replace(/\s*[,;:]\s*$/, '');
  /*
   * THE FIVE MOST QUOTABLE LINES, NOT JUST THE ONE.
   *
   * The best line by score is not always the best line to BUILD A POST ON — it
   * may repeat the title, or be the one the video already puts on screen. Three
   * options in three voices need three different ways in, so the writer is
   * handed the shortlist and picks, rather than being handed one line and
   * having to paraphrase it three times. That is most of why the three options
   * used to read like the same option.
   */
  const quotes = [];
  for (const { s } of scored) {
    const q = s.replace(/\s*[,;:]\s*$/, '');
    // near-duplicates add nothing to a shortlist
    if (quotes.some((x) => x.slice(0, 28).toLowerCase() === q.slice(0, 28).toLowerCase())) continue;
    quotes.push(q.length > 180 ? q.slice(0, 177).replace(/\s+\S*$/, '') + '…' : q);
    if (quotes.length >= 5) break;
  }
  return {
    hook: hook.length > 120 ? hook.slice(0, 117).replace(/\s+\S*$/, '') + '…' : hook,
    quotes,
    // The opening is what a caption should paraphrase; the whole thing is what
    // the model reads.
    summary: sentences.slice(0, 12).join(' ').slice(0, 1200),
    full: sentences.join(' ').slice(0, FULL_CAP),
    words: total,
  };
}

/** A stable pick, so the same file does not shuffle its wording every press. */
function pick(list, seed) {
  let h = 0;
  for (const c of String(seed || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

/** Strip the things a model likes to add that would look wrong in a caption. */
function tidy(s, max) {
  let t = String(s == null ? '' : s).trim();
  t = t.replace(/^["'“”`]+|["'“”`]+$/g, '');
  /*
   * A model that opened a title with a quotation mark and then had it stripped
   * leaves the CLOSING one behind: `Lord speak to me..." ✨`. Cheap to spot —
   * an odd number of quote marks — and it is the kind of thing an operator
   * notices immediately and the writer never will.
   */
  const marks = (t.match(/["“”]/g) || []).length;
  if (marks % 2 === 1) t = t.replace(/["“”]/, '');
  t = t.replace(/^(title|caption)\s*[:\-–]\s*/i, '');
  t = t.replace(new RegExp(String.fromCharCode(13), 'g'), '');
  if (max && t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '').trim();
  return t;
}

/* =========================== THE HOUSE STYLE ============================
 *
 * One title and one caption was never what a media team needs. What they need
 * is a CHOICE, written the way each platform actually reads, and written to the
 * same standard every time — which is exactly what a good editor gives you:
 *
 *   Option 1  Bold & Visionary       Instagram Reels & YouTube Shorts
 *   Option 2  High-Energy & Prophetic  TikTok
 *   Option 3  Deep & Inspiring       Facebook & Instagram Feed
 *
 * Each is a Title with an emoji or two, a caption of two to four real sentences,
 * and a line of hashtags. The house rules below are not suggestions; they are
 * the difference between copy that can be posted as-is and copy that has to be
 * rewritten every time:
 *
 *   • THE EVENT IS ALWAYS NAMED in the caption ("at the All Ireland
 *     Outpouring"). A clip that could have been filmed anywhere is worth less
 *     than one that plants a flag.
 *   • THE SPEAKER IS ALWAYS NAMED, and gets their own hashtag. Which speaker is
 *     worked out from the words in the clip, so a service with four preachers
 *     credits the right one.
 *   • NO EM DASHES. Ever. A colon or a comma says the same thing and does not
 *     read as machine-written.
 *   • NO "#SermonClip", and no engagement bait ("Drop an AMEN", "Type AMEN in
 *     the comments") unless it is asked for. Both make a church account look
 *     like a content farm.
 *   • Nothing is invented. Verses, names, places and claims come from what was
 *     actually said, or they do not appear.
 */

/** The three options, in order. `voice` steers both the rules and the model. */
const STYLES = [
  {
    id: 'bold',
    label: 'Bold & Visionary',
    platforms: 'Instagram Reels & YouTube Shorts',
    voice: 'bold and visionary, declarative, present tense, speaking to the reader',
    titleEmoji: ['⚡📖', '🔥✨', '🕊️🔥', '⚡🙌'],
    endEmoji: '🔥✨',
  },
  {
    id: 'energy',
    label: 'High-Energy & Prophetic',
    platforms: 'TikTok',
    voice: 'high energy and prophetic, short punchy sentences, urgent',
    titleEmoji: ['‼️🔥', '🔥', '📖🔥', '‼️'],
    endEmoji: '🙏⚡',
  },
  {
    id: 'deep',
    label: 'Deep & Inspiring',
    platforms: 'Facebook & Instagram Feed',
    voice: 'reflective and inspiring, longer sentences, opens with a direct quote from the clip',
    titleEmoji: ['📖', '🙌', '📖✨'],
    endEmoji: '🙌✨',
  },
];

/* Hashtags that are always wrong for a church account. */
const BANNED_TAGS = /^#(sermonclip|sermonclips|clip|clips|fyp|foryou|foryoupage|viral|trending)$/i;
/* Phrases the operator asked never to see again. */
const BAIT = /\b(drop (an|a) \w+ in the comments?|type \w+ in the comments?|comment \w+ (below|if|in)|smash that|like and subscribe|double tap)\b[^.!?]*[.!?]?/gi;

/* =========================== THE MACHINE TELLS ============================
 *
 * A caption is not judged on whether it is grammatical. It is judged in the
 * half second before somebody keeps scrolling, and the fastest way to lose that
 * half second is to sound like software. These are the phrases that do it:
 * every one of them is a stock LLM opener or a filler that says nothing about
 * THIS clip, and "In this powerful message" is worth the whole list on its own
 * because a model reaches for it unprompted nearly every time.
 *
 * They are REPLACED rather than deleted where deleting would leave a hole, and
 * the prompt forbids them as well. Both ends, as with every other house rule
 * here: a model told nine rules will eventually forget one.
 */
const TELLS = [
  [/\bin this (powerful|incredible|amazing|profound|moving|inspiring)\s+(message|word|clip|sermon|video|teaching)[,:]?\s*/gi, ''],
  [/\bin this (message|word|clip|sermon|video|teaching)[,:]?\s*/gi, ''],
  [/\b(delve|dive|delves|dives|delving|diving)\s+(deep(ly)?\s+)?into\b/gi, 'goes into'],
  [/\ba testament to\b/gi, 'proof of'],
  [/\bin today'?s fast[- ]paced world[,]?\s*/gi, ''],
  [/\bbuckle up[,.!]?\s*/gi, ''],
  [/\bgame[- ]chang(er|ing)\b/gi, 'turning point'],
  [/\bat the end of the day[,]?\s*/gi, ''],
  [/\blet'?s face it[,]?\s*/gi, ''],
  [/\bwithout further ado[,]?\s*/gi, ''],
  [/\bwatch till the end\b[^.!?]*[.!?]?/gi, ''],
  [/\byou won'?t believe what happens next\b[^.!?]*[.!?]?/gi, ''],
  [/\bstay tuned\b[^.!?]*[.!?]?/gi, ''],
  [/\bthis is your sign\b/gi, 'this is for you'],
];

/* Four emoji in a caption is a voice. Fourteen is a machine having a moment. */
const EMOJI_RX = /(\p{Extended_Pictographic}️?)/gu;
const MAX_EMOJI = 5;

/**
 * House-style clean-up, applied to EVERYTHING — the rules' own output and the
 * model's alike, so the standard does not depend on which one answered.
 */
function houseStyle(text, opts) {
  const o = opts || {};
  let t = String(text == null ? '' : text);
  // Em and en dashes read as machine-written. A colon carries the same weight
  // when it joins two clauses; elsewhere a comma does.
  t = t.replace(/\s*[—–]\s*/g, (m, i, s) => {
    const after = s.slice(i + m.length);
    return /^[a-z]/.test(after) ? ': ' : ', ';
  });
  t = t.replace(/\s*--\s*/g, ': ');
  if (!o.allowBait) t = t.replace(BAIT, '').replace(/[ \t]{2,}/g, ' ');
  for (const [rx, to] of TELLS) t = t.replace(rx, to);
  // strip banned tags wherever they appear
  t = t.split(/(\s+)/).filter((w) => !BANNED_TAGS.test(w.trim())).join('');
  /*
   * Emoji are capped from the END, not the start: the ones that earn their
   * place are the one or two that close a line, and a model that has sprayed
   * them has sprayed them through the middle. The hashtag line is left alone —
   * it has none — and so is a title, which is allowed its pair.
   */
  if (!o.title) {
    const found = t.match(EMOJI_RX);
    if (found && found.length > MAX_EMOJI) {
      let over = found.length - MAX_EMOJI;
      t = t.replace(EMOJI_RX, (m) => (over-- > 0 ? '' : m));
    }
  }
  // Taking a phrase out can leave a lower-case sentence opening or a stranded
  // space before punctuation. Tidy both, or the cure looks worse than the tell.
  t = t.replace(/\s+([,.!?;:])/g, '$1');
  t = t.replace(/(^|[.!?]\s+|\n)([a-z])/g, (m, pre, c) => pre + c.toUpperCase());
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
  return t.trim();
}

/*
 * HOW OFTEN A WHOLE WORD APPEARS IN A LUMP OF SPEECH — and deliberately not
 * with a regex built out of a string.
 *
 * A word boundary written into a string literal is one missing backslash away
 * from being a BACKSPACE character (JavaScript reads '\b' one way and
 * '' quite another), and it then matches nothing, silently, for ever. That
 * exact mistake shipped in the invented-name guard below and quietly rewrote a
 * name the clip really did say. Padding both sides and asking for a plain
 * substring cannot go wrong in that way, and it is faster besides.
 */
function countWord(haystack, word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (w.length < 2) return 0;
  const padded = ' ' + String(haystack || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  const needle = ' ' + w + ' ';
  let n = 0, at = padded.indexOf(needle);
  while (at >= 0) { n++; at = padded.indexOf(needle, at + 1); }
  return n;
}
/** "Bishop Francis Wale Oke" -> "#BishopFrancisWaleOke" */
function tagOf(name) {
  const t = String(name || '').replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return t ? '#' + t : '';
}

/**
 * Which of the church's speakers is in THIS clip.
 *
 * A convention has four preachers and crediting the wrong one is the single
 * most embarrassing thing this feature could do, so the answer comes from the
 * words in the clip: the configured name whose surname is actually said. With
 * nothing to go on it returns the first configured speaker, or nothing at all,
 * rather than guessing between them.
 */
function whoIsSpeaking(transcript, speakers) {
  const list = (speakers || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return '';
  const said = String(transcript || '').toLowerCase();
  if (said) {
    let best = '', bestHits = 0;
    for (const name of list) {
      const parts = name.replace(/^(bishop|pastor|rev(erend)?|dr|apostle|prophet|evangelist|mrs?|mr)\.?\s+/gi, '')
        .split(/\s+/).filter((w) => w.length > 2);
      if (!parts.length) continue;
      // the surname is the discriminator; a first name alone is too common
      const surname = parts[parts.length - 1].toLowerCase();
      const hits = countWord(said, surname);
      if (hits > bestHits) { bestHits = hits; best = name; }
    }
    if (best) return best;
  }
  return list.length === 1 ? list[0] : '';
}

/* ===================== NAMES IT WAS NEVER TOLD =============================
 *
 * ►► THE WORST THING THIS FEATURE CAN DO, AND IT DID IT ON THE FIRST TRY. ◄◄
 *
 * Asked to write about a clip with no speaker configured and no name anywhere
 * in the transcript, a hosted model produced "Pastor James delivered this at
 * The Power House International" — in all three options. The prompt says in as
 * many words never to invent names. It invented one anyway, because a caption
 * about a sermon WANTS an attribution and the model would rather supply one
 * than leave the shape empty.
 *
 * A church posting a real person's ministry under a name that does not exist is
 * not a wording problem, it is a credibility problem, and it is exactly the
 * class of thing that has to be enforced on the way OUT. So: any titled name in
 * the copy has to be either one the operator configured, or one actually spoken
 * in the clip. Anything else becomes "the speaker", which is true.
 */
const TITLED_RX = /\b(Pastor|Bishop|Rev(?:erend)?|Apostle|Prophet(?:ess)?|Evangelist|Deacon|Minister|Dr|Brother|Sister)\.?\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){0,2})/g;

/*
 * ►► NO "THE SPEAKER", NO "OUR CHURCH". ◄◄ When nobody has said who is
 * speaking or what the church is called, a caption names neither — it is
 * rephrased round them, never padded with "the speaker said at Our Church"
 * ("Our Church" is only the app's placeholder for a name never set).
 */
const realChurch = (n) => { const t = String(n || '').trim(); return /^(our|my|the) church$/i.test(t) ? '' : t; };
const SAID = '(?:says|said|shares|shared|reminds us|reminded us|declares|declared|tells us|told us|explains|explained|preached|prayed|proclaims|proclaimed|teaches|taught)';
const NOBODY = '(?:the|our) (?:speaker|preacher|pastor|minister)';
function dropFaceless(text) {
  let t = String(text == null ? '' : text);
  if (!t) return t;
  // the placeholder name, wherever it landed (first: the patterns below read past it)
  t = t.replace(/\s+(?:at|in|from|with)\s+our church\b/gi, '').replace(/\bour church\b/g, 'church');
  // "…issues," the speaker said at Our Church.  ->  "…issues."
  t = t.replace(new RegExp(`,(["”'’])\\s*${NOBODY}\\s+${SAID}(?:\\s+(?:at|during|in|on)\\s+[^.!?\\n"]+)?\\s*([.!?])`, 'gi'), '$2$1');
  // "…issues" says the speaker.  /  , the speaker said,
  t = t.replace(new RegExp(`(["”'’])\\s*,?\\s*${SAID}\\s+${NOBODY}(?:\\s+(?:at|during|in|on)\\s+[^.!?\\n"]+)?`, 'gi'), '$1');
  t = t.replace(new RegExp(`,\\s*${NOBODY}\\s+${SAID}(?:\\s+(?:at|during|in|on)\\s+[^.!?,\\n"]+)?\\s*,`, 'gi'), ',');
  t = t.replace(new RegExp(`,\\s*${NOBODY}\\s+${SAID}(?:\\s+(?:at|during|in|on)\\s+[^.!?,\\n"]+)?(?=[.!?])`, 'gi'), '');
  // "— the speaker" after a quote
  t = t.replace(new RegExp(`\\s*[—–-]\\s*${NOBODY}\\b`, 'gi'), '');
  // "The speaker reminded us that grace is enough."  ->  "Grace is enough."
  t = t.replace(new RegExp(`(^|[.!?]\\s+|\\n)${NOBODY}\\s+(?:${SAID}|reminds|reminded|told|tells)(?:\\s+us)?(?:\\s+(?:at|during|in|on)\\s+[^,.!?\\n"]+(?=,))?(?:\\s+that|\\s*,)?\\s+(\\S)`, 'gi'),
    (m, lead, ch) => lead + ch.toUpperCase());
  // a quote left ending in a comma: "Hold on,". -> "Hold on."
  t = t.replace(/,(["”'’])\s*\./g, '.$1');
  return t.replace(/ {2,}/g, ' ').replace(/ ([,.!?])/g, '$1');
}

function stripInventedNames(text, { speaker, transcript, churchName }) {
  let t = String(text == null ? '' : text);
  if (!t) return t;
  const said = String(transcript || '').toLowerCase();
  const known = String(speaker || '').toLowerCase();
  const church = String(churchName || '').toLowerCase();
  return t.replace(TITLED_RX, (whole, title, name) => {
    const full = (title + ' ' + name).toLowerCase();
    // The person the operator told us about, however they are styled.
    if (known && (known.includes(name.toLowerCase()) || full.includes(known))) return whole;
    // …or a name the clip really says. The surname is the discriminator, the
    // same way whoIsSpeaking decides it.
    const parts = name.split(/\s+/);
    const surname = parts[parts.length - 1].toLowerCase();
    if (said && countWord(said, surname) > 0) return whole;
    // A church can be called "St Andrew's" — do not rewrite its own name.
    if (church && church.includes(name.toLowerCase())) return whole;
    return 'the speaker';   // (dropFaceless then writes the attribution out)
  });
}

/** Sentence-case a hook so it can open a caption without shouting. */
function asSentence(s) {
  let t = String(s || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  if (t === t.toUpperCase()) t = t.charAt(0) + t.slice(1).toLowerCase();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…"]$/.test(t) ? t : t + '.';
}

/** A handful of subject hashtags drawn from what was actually said. */
const TOPIC_TAGS = [
  [/\b(revival|outpour|awaken)/i, ['#Revival', '#SpiritualAwakening', '#HolySpiritOutpouring']],
  [/\b(pray|prayer|interced|fast)/i, ['#PrayerAndFasting', '#Intercession']],
  [/\b(bishop|consecrat|ordain|apostolic|office)/i, ['#ApostolicGrace', '#KingdomLeadership', '#Consecration']],
  [/\b(youth|young|generation|children)/i, ['#YouthAwakening', '#NextGeneration']],
  [/\b(heal|deliver|breakthrough|miracle)/i, ['#Breakthrough', '#HealingPower']],
  [/\b(faith|believe|trust)/i, ['#FaithInAction', '#WalkByFaith']],
  [/\b(salvation|born again|saved|repent)/i, ['#Salvation', '#BornAgain']],
  [/\b(bless|multipl|increase|prosper|elevat|promot)/i, ['#DivineElevation', '#KingdomGrowth']],
  [/\b(grace|mercy|love)/i, ['#GraceAndMercy'],],
  [/\b(word|scripture|bible|verse|gospel)/i, ['#GospelTruth', '#BiblicalTruth']],
];
const FALLBACK_TAGS = ['#KingdomMinded', '#ChristianInspiration', '#SpiritualGrowth', '#FaithInAction', '#GospelTruth'];
const PLATFORM_TAGS = {
  bold: ['#ChristianReels'],
  energy: ['#ChristianTikTok', '#ChurchTok'],
  deep: ['#ChristianInspiration'],
};

function topicTagsFor(text, want) {
  const out = [];
  for (const [rx, tags] of TOPIC_TAGS) {
    if (rx.test(text)) for (const t of tags) if (!out.includes(t)) out.push(t);
    if (out.length >= want) break;
  }
  for (const t of FALLBACK_TAGS) { if (out.length >= want) break; if (!out.includes(t)) out.push(t); }
  return out.slice(0, want);
}

/** The hashtag line: speaker, event, then subject, then the platform's own. */
function tagLine(style, { speaker, eventName, text }) {
  const tags = [];
  const st = tagOf(speaker); if (st) tags.push(st);
  const et = tagOf(eventName); if (et) tags.push(et);
  for (const t of topicTagsFor(text || '', 5)) if (!tags.includes(t)) tags.push(t);
  for (const t of (PLATFORM_TAGS[style.id] || [])) if (!tags.includes(t)) tags.push(t);
  return tags.filter((t) => !BANNED_TAGS.test(t)).slice(0, 9).join(' ');
}

/* Closing lines that say something true about the reader instead of asking them
 * for something. Seeded off the clip so one file always reads the same way, and
 * three different ones never land on the same sentence. */
const CLOSERS = {
  bold: [
    'Read it twice. The second time is the one that costs you something.',
    'Nothing about that is theory. It is meant to be walked out this week.',
    'That is not encouragement. That is an instruction with your name on it.',
  ],
  energy: [
    'Sit with that one for a minute.',
    'Some of you needed to hear exactly that today.',
    'That is the line. Everything else is detail.',
  ],
  deep: [
    'Whatever season you are in, that is still true of you today.',
    'It is worth staying with that thought a little longer than feels comfortable.',
    'Some words are worth carrying into the week. That is one of them.',
  ],
};

/**
 * One option, written by the rules alone. Always produces something postable,
 * so the button works on a machine with no model installed and with no internet.
 *
 * It will never be as good as a model reading the clip, and it is not trying to
 * be. What it CAN do, and what it did not used to, is open on the speaker's own
 * words rather than on a stock sentence: the strongest line in the clip is the
 * strongest line the rules have, and burying it under "A word for this season"
 * was throwing away the only real material they had. Each voice now takes a
 * DIFFERENT line off the shortlist, so three options are three posts.
 */
function ruleOption(style, ctx) {
  const { hook, speaker, eventName, churchName, summary, allowBait, quotes, seed } = ctx;
  // The event is the flag worth planting. With no event set, the church's own
  // name is the next best thing, and better than a caption from nowhere.
  const church = realChurch(churchName);
  const at = eventName ? `at the ${eventName}` : (church ? `at ${church}` : '');
  const who = speaker || 'the preacher';
  const emoji = style.titleEmoji[0];
  const idx = STYLES.findIndex((s) => s.id === style.id);
  const list = (quotes && quotes.length ? quotes : (hook ? [hook] : []));
  // Each voice gets its own line where there is one to give it.
  const mine = list.length ? list[Math.min(idx, list.length - 1)] : '';
  const quoted = String(mine || '').replace(/^["']|["']$/g, '').replace(/[.…]+$/, '');

  // The title is the hook itself, trimmed to something that fits a phone.
  let titleCore = String(hook || 'A word for you today').replace(/[."'…]+$/g, '').trim();
  if (titleCore.length > 90) titleCore = titleCore.slice(0, 87).replace(/\s+\S*$/, '');
  titleCore = titleCore.charAt(0).toUpperCase() + titleCore.slice(1);
  const title = `${titleCore} ${emoji}`.trim();

  const closer = pick(CLOSERS[style.id] || CLOSERS.deep, (seed || '') + style.id);
  const opener = quoted
    ? (style.id === 'energy' ? asSentence(quoted) : `"${quoted}"`)
    : asSentence(hook || 'A word for you today');
  // Who said it and where — one sentence, never two, and never bolted on the end.
  const attribution = speaker
    ? `${who}, ${at || 'in this service'}.`
    : (at ? `Spoken ${at}.` : '');
  const extra = (style.id === 'deep' && summary)
    ? asSentence(summary.split(/(?<=[.!?])\s+/)
        .filter((x) => !quoted || x.toLowerCase().indexOf(quoted.toLowerCase().slice(0, 24)) < 0)
        .slice(0, 2).join(' '))
    : '';
  const body = [opener, attribution, extra, `${closer} ${style.endEmoji}`].filter(Boolean);
  const caption = houseStyle(body.join(' ') + '\n\n'
    + tagLine(style, { speaker, eventName, text: `${hook} ${summary || ''}` }), { allowBait });
  return {
    id: style.id, label: style.label, platforms: style.platforms,
    title: houseStyle(title, { allowBait, title: true }).slice(0, 100),
    caption,
  };
}

/* ===================== WHAT ACTUALLY STOPS A THUMB ========================
 *
 * The first version of this prompt asked for "two to four real sentences" and
 * listed the things never to do. It got grammatical, accurate, forgettable
 * copy, because accuracy is the floor and nothing in it described the job.
 *
 * The job is the half second before somebody scrolls past. Everything below is
 * about that half second, and every line of it is a decision:
 *
 *   • THE FIRST LINE IS THE WHOLE POST. Instagram and Facebook show roughly
 *     125 characters and then "… more"; TikTok shows one line. So the opening
 *     line is specified separately from the caption, must stand alone, and is
 *     the thing the model is told to spend its effort on.
 *   • TENSION BEFORE PAYOFF. A summary tells you what you would learn; a hook
 *     makes you need to know. "Caleb was 85 when he asked for a mountain" is
 *     the same fact as "a message about perseverance" and a different post.
 *   • THE SPEAKER'S OWN WORDS. A verbatim quote outperforms a paraphrase of
 *     it, and it is also the one form that cannot drift from what was said,
 *     which for a church is the rule that outranks engagement.
 *   • SECOND PERSON. Copy that speaks TO one person beats copy about a topic.
 *   • NO PREAMBLE, NO SUMMARY VOICE. Both are how a model fills space.
 *
 * And what is NOT asked for matters as much: no engagement bait, no
 * #SermonClip, no manufactured urgency. Those raise a number and cost the
 * account its voice, and the operator ruled on them already.
 */
function buildPrompt({ hook, kind, churchName, eventName, speaker, durationSec, transcript, allowBait, quotes, flyer }) {
  const read = flyer || (transcript ? readTranscript(transcript) : null);
  const secs = Math.round(durationSec || 0);
  const what = kind === 'image' ? 'a photo or flyer' : `a ${secs || 'short'}${secs ? '-second' : ''} vertical clip`;
  const shortlist = (quotes && quotes.length ? quotes : (read && read.quotes) || []).slice(0, 5);
  const rules = [
    eventName ? `EVERY caption must say that this happened at the ${eventName}. Work it into a sentence, do not bolt it on the end.` : '',
    speaker ? `The speaker is ${speaker}. Name them in every caption, and use ${tagOf(speaker)} as the first hashtag.`
      : 'NOBODY HAS TOLD YOU WHO IS SPEAKING. Do NOT invent a name for them. Do NOT refer to the speaker at all: no '
        + 'name, no "the speaker", no "the preacher", no "the pastor", no "he" or "she". '
        + 'Quote their words without saying who said them, or put the idea in your own '
        + 'words. You MAY name anyone the words above actually name, spelled exactly as '
        + 'they are spelled there, and you must never change a name inside a quote.',
    churchName ? '' : 'NOBODY HAS TOLD YOU THE CHURCH\'S NAME. Do not name a church, and never write "our church" or "at church" as a place.',
    'NEVER use an em dash or en dash (— or –). Use a colon or a comma instead.',
    'NEVER use the hashtag #SermonClip, #fyp, #viral or #trending.',
    allowBait ? '' : 'NEVER ask for engagement. No "Drop an AMEN in the comments", no "Type AMEN", no "comment below", no "like and subscribe".',
    'Use British spelling (honour, fulfil, realise).',
    'Never invent Bible verses, names, places, dates or claims that are not in the words above. If you are not certain a verse reference is right, do not give one.',
    'Two or three emoji in a caption. Never one per sentence.',
    'NEVER open with "In this powerful message", "Dive into", "A testament to", "Buckle up", "Stay tuned" or anything like them.',
    'No "watch till the end", no fake urgency, no clickbait that the clip does not deliver.',
  ].filter(Boolean);
  const lines = [
    'You are the best short-form social copywriter in the world, and you write for a church.',
    'Your captions are read by people scrolling at speed who have never heard of this church.',
    'Reply with JSON only, no other text.',
    '',
    `THE POST: ${what} from a church service.`,
    churchName ? `THE CHURCH: ${churchName}` : '',
    '',
    read ? (flyer ? 'WHAT IS PRINTED ON THE FLYER (this is the only source of fact you have — give the event, day, time and place exactly as printed):' : 'WHAT IS ACTUALLY SAID IN IT (this is the only source of fact you have):') : '',
    read ? '"""' : '', read ? (read.full || read.summary) : '', read ? '"""' : '',
    '',
    shortlist.length ? 'THE MOST QUOTABLE LINES IN IT, strongest first:' : '',
    ...shortlist.map((q, i) => `  ${i + 1}. "${q}"`),
    (!shortlist.length && hook) ? `The strongest line in it is: "${hook}"` : '',
    '',
    'NOT EVERY CLIP IS A SERMON. It may be an announcement, a welcome, a notice,',
    'a song, a testimony or a prayer. Write what this clip ACTUALLY IS: a notice',
    'about next Sunday is a clear, warm notice, not a profound truth about life.',
    'Forcing a reflective ending onto an announcement is the fastest way to look',
    'like a machine wrote it.',
    '',
    'HOW TO WRITE THE FIRST LINE, which is the only line most people will read:',
    '  - Under 12 words. It must make sense on its own, with nothing after it.',
    '  - Open tension, do not summarise. Something surprising, a sharp question,',
    '    a claim that needs finishing, or the speaker\'s own words in quote marks.',
    '  - Speak to ONE person: "you", not "we" and not "believers".',
    '  - Be concrete. A specific detail from the clip beats a spiritual abstraction.',
    '  - Never start with the church name, the event name, or "In this...".',
    '',
    'THEN THE REST OF THE CAPTION:',
    '  - Two to four short sentences that pay the first line off, all of them about',
    '    what is ACTUALLY said in the words above. Vary the sentence lengths.',
    flyer ? '  - Say clearly what is happening, when and where, exactly as printed, and why someone should come.' : '  - Quote the words directly at least once, word for word from above.',
    (speaker || eventName || churchName) ? '  - Name the speaker and where it happened, naturally, inside a sentence, using only what you were told above.' : '  - Do NOT say who spoke or where: make it about the words and the reader.',
    '  - End on a line that lands: something true about the reader, not a request.',
    '  - Then a blank line, then 6 to 9 hashtags on the last line, mixing big ones',
    '    with two or three that are specific to this subject.',
    '',
    'Write THREE options, in this order and in these voices:',
    ...STYLES.map((s, i) => `  ${i + 1}. "${s.label}" for ${s.platforms}: ${s.voice}.`),
    'They must be genuinely DIFFERENT posts: a different opening line, a different',
    'quote and a different angle each time. Three rewrites of one idea is a failure.',
    '',
    'Each option is:',
    '  "title"    — under 70 characters, the thumbnail/headline, ending in one or two emoji, no hashtags.',
    '  "hook"     — the first line of the caption, under 12 words, no hashtags.',
    '  "caption"  — the WHOLE caption INCLUDING that first line, then the hashtag line.',
    '',
    'Rules, all of them absolute:',
    ...rules.map((r) => '  - ' + r),
    '',
    'JSON: {"options":[{"title":"...","hook":"...","caption":"..."},{"title":"...","hook":"...","caption":"..."},{"title":"...","hook":"...","caption":"..."}]}',
  ];
  // A rule that did not apply leaves a blank line behind it; two blank lines in
  // a row read to a model as a section break that is not there.
  return lines.filter((x, i) => x !== '' || (i > 0 && lines[i - 1] !== '')).join('\n');
}

/**
 * THE SECOND PASS: mark it, then fix it.
 *
 * A model writing three options in one go spends most of its effort on the
 * first and coasts through the other two, and it never re-reads any of them.
 * Asking it to score its own work against the one thing that matters — would a
 * stranger stop — and rewrite whatever failed is the cheapest quality gain
 * available here: one extra call, about a second and a half, and it reliably
 * rescues the weak opening line that a single pass leaves in options 2 and 3.
 *
 * It is only ever run against a hosted model (see `llm.polish`). On a 1.5B
 * model on a church PC it would cost a minute and make the copy worse.
 */
function buildPolishPrompt({ options, eventName, speaker, allowBait }) {
  return [
    'You are a ruthless short-form copy editor. Reply with JSON only, no other text.',
    '',
    'Below are three social captions for the same church video clip.',
    'Score each one out of 10 on ONE question only: would a stranger scrolling at',
    'speed stop on the first line? A summary scores 3. A line that opens tension,',
    'names a concrete detail, or quotes the speaker scores 8 or more.',
    '',
    'Then REWRITE every option that scored below 8 so that it would score 9,',
    'changing as little else as possible. Keep every fact, every quote and every',
    'hashtag line exactly as they are: you are sharpening the writing, not',
    'inventing anything. Options that already score 8 or more come back untouched.',
    '',
    'These still hold in anything you rewrite:',
    eventName ? `  - the caption must still say it happened at the ${eventName}` : '',
    speaker ? `  - the caption must still name ${speaker}` : '',
    '  - no em dash or en dash, ever',
    allowBait ? '' : '  - never ask for engagement, likes, comments or follows',
    '  - British spelling',
    '  - never invent anything that is not already in the caption',
    '  - no "In this powerful message", no "dive into", no "stay tuned"',
    '',
    ...options.flatMap((o, i) => [
      `OPTION ${i + 1} (${o.label}):`,
      'title: ' + o.title,
      'caption: """', o.caption, '"""', '',
    ]),
    'JSON: {"options":[{"score":7,"title":"...","caption":"..."},{"score":9,"title":"...","caption":"..."},{"score":6,"title":"...","caption":"..."}]}',
  ].filter(Boolean).join('\n');
}

/**
 * The button's answer: three options, in the house style.
 *
 * The rules always produce all three, so the button works on a machine with no
 * model installed. When a model IS there it rewrites them, and everything it
 * returns goes back through houseStyle() — the standard is enforced on the way
 * out, not merely requested on the way in, because a model that has been told
 * six rules will eventually forget one.
 */
async function suggest({ mediaPath, kind = 'video', churchName: churchIn = '', eventName = '', speakers = [],
  durationSec = 0, transcript = '', allowBait = false, llm = null, signal, quick = false, flyer = null } = {}) {
  const churchName = realChurch(churchIn);
  /*
   * A FLYER'S WORDS ARE ALL FACT. They are short lines ("FRIDAY 24 OCT",
   * "7PM"), which the transcript reader drops as too short to be sentences —
   * so a flyer is handed to the writer whole, as what is printed on it.
   */
  const flyerText = flyer ? [flyer.event && `Event: ${flyer.event}`, flyer.date && `Date: ${flyer.date}`, flyer.time && `Time: ${flyer.time}`,
    flyer.place && `Place: ${flyer.place}`, flyer.people && flyer.people.length && `People: ${flyer.people.join(', ')}`,
    flyer.theme && `Theme: ${flyer.theme}`, flyer.contact && `Contact: ${flyer.contact}`, transcript && `Every word on it: ${transcript}`].filter(Boolean).join('\n') : '';
  const read = flyer ? { full: flyerText, summary: flyerText, quotes: [], hook: flyer.event || '', words: flyerText.split(/\s+/).length }
    : transcript ? readTranscript(transcript) : null;
  const hook = (read && read.hook) || hookFromFilename(mediaPath) || '';
  const speaker = whoIsSpeaking(transcript, speakers);
  const ctx = { hook, speaker, eventName, churchName, allowBait,
                summary: read ? read.summary : '', quotes: read ? read.quotes : null,
                seed: String(mediaPath || '') + hook };
  const base = {
    options: STYLES.map((st) => ruleOption(st, ctx)),
    source: read ? 'heard' : 'rules', heard: !!read, hook, speaker, eventName,
    words: read ? read.words : 0,
  };
  base.title = base.options[0].title;
  base.caption = base.options[0].caption;
  if (!llm) return base;
  let available = false;
  try { available = await llm.isAvailable(); } catch (e) { available = false; }
  if (!available) return base;

  /** Everything a model wrote goes through this before anybody sees it. */
  const dress = (raw) => {
    let usedModel = false;
    const options = STYLES.map((st, i) => {
      const o = raw[i] || {};
      const guard = (x) => (speaker ? stripInventedNames(x, { speaker, transcript, churchName }) : dropFaceless(stripInventedNames(x, { speaker, transcript, churchName })));
      const title = houseStyle(guard(tidy(o.title, 100)), { allowBait, title: true });
      let caption = houseStyle(guard(tidy(o.caption, 2100)), { allowBait });
      // Judged on what the MODEL wrote, before the repairs below: appending a
      // hashtag line to "Hi" would otherwise make a useless answer look usable.
      const wroteSomething = caption.length >= 30;
      // The two things the operator will notice immediately if they are missing.
      if (eventName && caption && caption.toLowerCase().indexOf(eventName.toLowerCase()) < 0) {
        const said = 'Recorded at the ' + eventName + '.';
        const tagsAt = caption.lastIndexOf('\n\n#');
        caption = tagsAt > 0
          ? caption.slice(0, tagsAt) + '\n\n' + said + caption.slice(tagsAt)
          : caption + '\n\n' + said;
      }
      if (!/#\w/.test(caption)) {
        caption += '\n\n' + tagLine(st, { speaker, eventName, text: hook + ' ' + (read ? read.summary : '') });
      }
      const fb = base.options[i];
      if (!raw[i]) return fb;   // the model only wrote some of them
      const keepTitle = title.length >= 6, keepCaption = wroteSomething;
      if (keepTitle || keepCaption) usedModel = true;
      return {
        id: st.id, label: st.label, platforms: st.platforms,
        title: keepTitle ? title : fb.title,
        caption: keepCaption ? caption : fb.caption,
      };
    });
    return { options, usedModel };
  };

  try {
    const out = await llm.chat({
      prompt: buildPrompt({ hook, kind, churchName, eventName, speaker, durationSec, transcript, allowBait, flyer: flyer ? read : null,
                           quotes: read ? read.quotes : null }),
      maxTokens: 1800, temperature: 0.85, json: true, signal,
    });
    const j = llm.parseJson ? llm.parseJson(out) : JSON.parse(out);
    let raw = (j && (j.options || j.Options)) || [];
    // A model that ignored the three-option shape and answered with a single
    // title and caption has still written something usable, and throwing it
    // away to fall back to the rules would be the worse answer. Its one take
    // becomes option 1; the rules keep the other two voices covered.
    if (!Array.isArray(raw) || !raw.length) {
      if (j && (j.title || j.caption)) raw = [{ title: j.title, caption: j.caption }];
      else return base;
    }
    const first = dress(raw);
    // Nothing of the model's survived the house style, so it did not write this.
    if (!first.usedModel) return base;
    let options = first.options;
    let polished = false;

    /*
     * THE SECOND PASS — hosted models only.
     *
     * It is allowed to change the WORDING and nothing else, and it only wins
     * where it actually improved something: an option comes back only if the
     * editor both scored it below 8 and returned a caption of real length for
     * it. Anything else and pass one stands. That asymmetry is deliberate —
     * the downside of a bad rewrite (a caption that no longer names the event,
     * or quotes something that was never said) is far worse than the upside of
     * a slightly sharper opening line.
     */
    /*
     * `quick` is what a BATCH asks for. The second pass doubles the tokens a
     * caption costs, and on a free tier metered per minute that is the
     * difference between eight clips all being written by the model and two of
     * them being written and six falling back to templates. One clip the
     * operator is watching gets the full treatment; twenty of them get pass one,
     * which is the pass that does most of the work anyway.
     */
    if (llm.polish && !quick) {
      try {
        const crit = await llm.chat({
          prompt: buildPolishPrompt({ options, eventName, speaker, allowBait }),
          maxTokens: 1800, temperature: 0.7, json: true, signal,
        });
        const cj = llm.parseJson ? llm.parseJson(crit) : JSON.parse(crit);
        const cr = (cj && (cj.options || cj.Options)) || [];
        if (Array.isArray(cr) && cr.length) {
          const merged = options.map((o, i) => {
            const c = cr[i];
            if (!c) return o;
            const score = Number(c.score);
            // A high score means "leave it alone", and a rewrite that came back
            // shorter than half the original is a model that lost the plot.
            if (Number.isFinite(score) && score >= 8) return o;
            const cap = houseStyle(dropFaceless(stripInventedNames(tidy(c.caption, 2100), { speaker, transcript, churchName })), { allowBait });
            if (cap.length < Math.max(60, o.caption.length * 0.5)) return o;
            if (eventName && cap.toLowerCase().indexOf(eventName.toLowerCase()) < 0) return o;
            if (speaker && cap.toLowerCase().indexOf(speaker.toLowerCase()) < 0) return o;
            if (!/#\w/.test(cap)) return o;
            polished = true;
            const t = houseStyle(dropFaceless(stripInventedNames(tidy(c.title, 100), { speaker, transcript, churchName })), { allowBait, title: true });
            return Object.assign({}, o, { caption: cap, title: t.length >= 6 ? t : o.title });
          });
          options = merged;
        }
      } catch (e) { /* pass one stands */ }
    }
    return Object.assign({}, base, {
      options, title: options[0].title, caption: options[0].caption,
      source: 'ai', polished,
    });
  } catch (e) {
    return base;
  }
}

/** Back-compat: one option, the way the button used to answer. */
function ruleCopy(opts) {
  const o = opts || {};
  const read = o.transcript ? readTranscript(o.transcript) : null;
  const hook = (o.hook || (read && read.hook) || hookFromFilename(o.mediaPath) || '').trim();
  const speaker = whoIsSpeaking(o.transcript, o.speakers);
  const one = ruleOption(STYLES[0], {
    hook, speaker, eventName: o.eventName || '', churchName: o.churchName || '',
    summary: read ? read.summary : '', quotes: read ? read.quotes : null,
    allowBait: !!o.allowBait, seed: String(o.mediaPath || '') + hook,
  });
  return { title: one.title, caption: one.caption, source: read ? 'heard' : 'rules', hook, heard: !!read };
}

/*
 * ✨ CHANGE THE CAPTION THE PERSON IS LOOKING AT: shorter, more hype, or a
 * fresh take — keeping every fact, quote, name and the hashtag line. Nothing
 * new is invented: the caption itself is the only source of fact, so a name
 * the writer adds that is not in it is taken out again (stripInventedNames).
 */
const REVISE = {
  shorten: 'Make it SHORTER: about half the length. Keep the first line strong, keep the best quote, keep the hashtag line.',
  hype: 'Make it MORE EXCITING: more energy and momentum, punchier sentences, an opening line that stops the scroll. Still true, still warm, no fake urgency, no engagement bait.',
  calmer: 'Make it CALMER and more reflective: gentle, sincere, unhurried.',
  rewrite: 'Write a FRESH version: a different opening line and angle, the same facts and the same quote.',
  custom: '',
};
async function revise({ title = '', caption = '', action = 'rewrite', instruction = '', llm = null, churchName = '', allowBait = false } = {}) {
  const was = { title: String(title || ''), caption: String(caption || '') };
  if (!was.caption.trim()) return Object.assign({ source: 'unchanged', why: 'There is no caption to change yet.' }, was);
  if (!llm || !(await llm.isAvailable())) return Object.assign({ source: 'unchanged', why: 'No AI writer is set up.' }, was);
  const ask = action === 'custom' ? String(instruction || '').slice(0, 300) : (REVISE[action] || REVISE.rewrite);
  const prompt = [
    'You edit social media captions for a church. Reply with JSON only: {"title": "...", "caption": "..."}.',
    '',
    'THE CAPTION NOW:', '"""', was.caption, '"""',
    was.title ? `THE TITLE NOW: ${was.title}` : '',
    '',
    `WHAT TO DO: ${ask}`,
    'Rules: keep every fact, name, date, place and quote exactly as they are; never invent new ones. Keep the hashtags on the last line, after a blank line.',
    'NEVER use an em dash or en dash. Two or three emoji at most. British spelling.',
    allowBait ? '' : 'Never ask for engagement (no "drop an AMEN", no "comment below").',
    'The title is for YouTube: under 70 characters, no hashtags, no emoji.',
  ].filter((x) => x !== '').join('\n');
  try {
    const raw = await llm.chat({ prompt, maxTokens: 900, temperature: action === 'rewrite' ? 0.9 : 0.6, json: true });
    const r = (llm.parseJson ? llm.parseJson(raw) : JSON.parse(raw)) || {};
    const guard = (x) => dropFaceless(stripInventedNames(x, { speaker: '', transcript: was.caption + ' ' + was.title, churchName: realChurch(churchName) }));
    const cap = houseStyle(guard(tidy(r.caption || '', 2100)), { allowBait });
    const t = r.title ? houseStyle(guard(tidy(r.title, 100)), { allowBait, title: true }) : was.title;
    if (!cap || cap.length < 8) return Object.assign({ source: 'unchanged', why: 'The writer did not give a usable caption.' }, was);
    // the hashtag line comes back if the writer dropped it
    let out = cap;
    if (/#\w/.test(was.caption) && !/#\w/.test(cap)) {
      const paras = was.caption.split(/\n\s*\n/);
      const tags = paras.filter((x) => /^\s*#/.test(x)).pop() || (was.caption.match(/#\w+/g) || []).join(' ');
      if (tags) out = cap.trimEnd() + '\n\n' + tags.trim();
    }
    return { title: t || was.title, caption: out, source: 'ai' };
  } catch (e) {
    return Object.assign({ source: 'unchanged', why: (e && e.message) || 'The writer did not answer.' }, was);
  }
}

module.exports = {
  suggest, revise, dropFaceless, realChurch, ruleCopy, ruleOption, hookFromFilename, readTranscript, sentencesOf, hookScore,
  buildPrompt, buildPolishPrompt, tidy, houseStyle, tagOf, tagLine, whoIsSpeaking, asSentence,
  stripInventedNames, STYLES, TELLS,
};
