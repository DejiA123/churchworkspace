'use strict';
/*
 * The Bible engine behind the Presentation Studio.
 *
 * Four ways a church gets the translation it actually reads from:
 *
 *  1. THE CATALOGUE (default) — 100+ public-domain / freely-redistributable
 *     translations from getbible.net. Each one downloads ONCE as a single JSON
 *     (~9 MB) into <userData>/bibles and is then permanently offline. This
 *     matters more than it sounds: the church hall's wifi is not something you
 *     want between the preacher and John 3:16 on a Sunday morning.
 *
 *  2. BOLLS.LIFE — the modern translations people actually read from on a
 *     Sunday (NIV, NLT, ESV, NKJV, NASB, AMP, The Message and ~30 more) served
 *     as plain JSON by a public Bible site, no key and no sign-up. Same deal as
 *     the catalogue: one download, then offline forever. See the bolls section.
 *
 *  3. API.BIBLE — a free key from scripture.api.bible unlocks thousands more
 *     versions in hundreds of languages. Looked up live (and cached per chapter).
 *
 *  4. IMPORT A FILE — a church with its own module (a translation it has
 *     licensed, or an export from another Bible tool) can drop it in. Several
 *     common shapes are accepted, see importFile().
 *
 * Everything downstream (lookup, search, the slide builder) talks to ONE shape:
 *     { book, bookNr, chapter, verse, text }
 * so the presenter never has to care which of the three a verse came from.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const CATALOGUE_URL = 'https://api.getbible.net/v2/translations.json';
const TRANSLATION_URL = (abbr) => `https://api.getbible.net/v2/${encodeURIComponent(abbr)}.json`;
const API_BIBLE_BASE = 'https://api.scripture.api.bible/v1';

/* bolls.life — public JSON, no key. Ids in this app are prefixed `bolls:NIV`. */
const BOLLS_LANGS = 'https://bolls.life/static/bolls/app/views/languages.json';
const BOLLS_FULL = (code) => `https://bolls.life/static/translations/${encodeURIComponent(code)}.json`;
const BOLLS_TEXT = (code, book, chap) => `https://bolls.life/get-text/${encodeURIComponent(code)}/${book}/${chap}/`;
const BOLLS_BOOKS = (code) => `https://bolls.life/get-books/${encodeURIComponent(code)}/`;
const BOLLS_FIND = (code, q, limit) =>
  `https://bolls.life/v2/find/${encodeURIComponent(code)}?search=${encodeURIComponent(q)}&limit=${limit}&match_case=false&match_whole=false`;

let ROOT = null;                 // <userData>/bibles
const memCache = new Map();      // abbr -> parsed translation (hot, for the service)
const chapterCache = new Map();  // 'src:abbr:book:chapter' -> verses (API.Bible / bolls)

function init(userDataDir) {
  ROOT = path.join(userDataDir, 'bibles');
  try { fs.mkdirSync(ROOT, { recursive: true }); } catch (e) {}
  return ROOT;
}
const root = () => ROOT || init(path.join(require('os').homedir(), '.church-work-space'));
const filePath = (abbr) => path.join(root(), safeAbbr(abbr) + '.json');
const catalogueFile = () => path.join(root(), '_catalogue.json');
const safeAbbr = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);

/* ============================ book names ============================
 * The canonical 66 in order, with the abbreviations people actually type on a
 * Sunday ("1 cor", "psalm", "song", "rev"). Numbered books are the fiddly part:
 * "1st John", "I John", "1Jn" and "first john" all have to land on 1 John.
 */
const BOOKS = [
  { nr: 1, name: 'Genesis', abbr: ['gen', 'ge', 'gn'] },
  { nr: 2, name: 'Exodus', abbr: ['exo', 'ex', 'exod'] },
  { nr: 3, name: 'Leviticus', abbr: ['lev', 'le', 'lv'] },
  { nr: 4, name: 'Numbers', abbr: ['num', 'nu', 'nm', 'nb'] },
  { nr: 5, name: 'Deuteronomy', abbr: ['deu', 'dt', 'deut'] },
  { nr: 6, name: 'Joshua', abbr: ['jos', 'josh', 'jsh'] },
  { nr: 7, name: 'Judges', abbr: ['jdg', 'judg', 'jg'] },
  { nr: 8, name: 'Ruth', abbr: ['rut', 'rth', 'ru'] },
  { nr: 9, name: '1 Samuel', abbr: ['1sa', '1sam', '1s'] },
  { nr: 10, name: '2 Samuel', abbr: ['2sa', '2sam', '2s'] },
  { nr: 11, name: '1 Kings', abbr: ['1ki', '1kgs', '1k'] },
  { nr: 12, name: '2 Kings', abbr: ['2ki', '2kgs', '2k'] },
  { nr: 13, name: '1 Chronicles', abbr: ['1ch', '1chr', '1chron'] },
  { nr: 14, name: '2 Chronicles', abbr: ['2ch', '2chr', '2chron'] },
  { nr: 15, name: 'Ezra', abbr: ['ezr', 'ez'] },
  { nr: 16, name: 'Nehemiah', abbr: ['neh', 'ne'] },
  { nr: 17, name: 'Esther', abbr: ['est', 'esth', 'es'] },
  { nr: 18, name: 'Job', abbr: ['job', 'jb'] },
  { nr: 19, name: 'Psalms', abbr: ['psa', 'ps', 'psalm', 'pslm', 'psm'] },
  { nr: 20, name: 'Proverbs', abbr: ['pro', 'pr', 'prov', 'prv'] },
  { nr: 21, name: 'Ecclesiastes', abbr: ['ecc', 'ec', 'eccl', 'qoh'] },
  { nr: 22, name: 'Song of Solomon', abbr: ['sng', 'song', 'sos', 'canticles', 'songofsongs'] },
  { nr: 23, name: 'Isaiah', abbr: ['isa', 'is'] },
  { nr: 24, name: 'Jeremiah', abbr: ['jer', 'je'] },
  { nr: 25, name: 'Lamentations', abbr: ['lam', 'la'] },
  { nr: 26, name: 'Ezekiel', abbr: ['ezk', 'eze', 'ezek'] },
  { nr: 27, name: 'Daniel', abbr: ['dan', 'da', 'dn'] },
  { nr: 28, name: 'Hosea', abbr: ['hos', 'ho'] },
  { nr: 29, name: 'Joel', abbr: ['jol', 'joel', 'jl'] },
  { nr: 30, name: 'Amos', abbr: ['amo', 'am'] },
  { nr: 31, name: 'Obadiah', abbr: ['oba', 'ob', 'obad'] },
  { nr: 32, name: 'Jonah', abbr: ['jon', 'jnh'] },
  { nr: 33, name: 'Micah', abbr: ['mic', 'mc'] },
  { nr: 34, name: 'Nahum', abbr: ['nam', 'nah', 'na'] },
  { nr: 35, name: 'Habakkuk', abbr: ['hab', 'hb'] },
  { nr: 36, name: 'Zephaniah', abbr: ['zep', 'zeph', 'zp'] },
  { nr: 37, name: 'Haggai', abbr: ['hag', 'hg'] },
  { nr: 38, name: 'Zechariah', abbr: ['zec', 'zech', 'zc'] },
  { nr: 39, name: 'Malachi', abbr: ['mal', 'ml'] },
  { nr: 40, name: 'Matthew', abbr: ['mat', 'mt', 'matt'] },
  { nr: 41, name: 'Mark', abbr: ['mrk', 'mk', 'mr'] },
  { nr: 42, name: 'Luke', abbr: ['luk', 'lk', 'lu'] },
  { nr: 43, name: 'John', abbr: ['jhn', 'jn', 'joh'] },
  { nr: 44, name: 'Acts', abbr: ['act', 'ac'] },
  { nr: 45, name: 'Romans', abbr: ['rom', 'ro', 'rm'] },
  { nr: 46, name: '1 Corinthians', abbr: ['1co', '1cor'] },
  { nr: 47, name: '2 Corinthians', abbr: ['2co', '2cor'] },
  { nr: 48, name: 'Galatians', abbr: ['gal', 'ga'] },
  { nr: 49, name: 'Ephesians', abbr: ['eph', 'ep'] },
  { nr: 50, name: 'Philippians', abbr: ['php', 'phil', 'pp'] },
  { nr: 51, name: 'Colossians', abbr: ['col', 'co'] },
  { nr: 52, name: '1 Thessalonians', abbr: ['1th', '1thess', '1thes'] },
  { nr: 53, name: '2 Thessalonians', abbr: ['2th', '2thess', '2thes'] },
  { nr: 54, name: '1 Timothy', abbr: ['1ti', '1tim'] },
  { nr: 55, name: '2 Timothy', abbr: ['2ti', '2tim'] },
  { nr: 56, name: 'Titus', abbr: ['tit', 'ti'] },
  { nr: 57, name: 'Philemon', abbr: ['phm', 'phlm', 'philem'] },
  { nr: 58, name: 'Hebrews', abbr: ['heb', 'hb'] },
  { nr: 59, name: 'James', abbr: ['jas', 'jm', 'jam'] },
  { nr: 60, name: '1 Peter', abbr: ['1pe', '1pet', '1pt'] },
  { nr: 61, name: '2 Peter', abbr: ['2pe', '2pet', '2pt'] },
  { nr: 62, name: '1 John', abbr: ['1jn', '1jo', '1joh'] },
  { nr: 63, name: '2 John', abbr: ['2jn', '2jo', '2joh'] },
  { nr: 64, name: '3 John', abbr: ['3jn', '3jo', '3joh'] },
  { nr: 65, name: 'Jude', abbr: ['jud', 'jde'] },
  { nr: 66, name: 'Revelation', abbr: ['rev', 're', 'apocalypse', 'apoc'] },
];
const bookByNr = (nr) => BOOKS.find((b) => b.nr === nr) || null;

/** "1st John" / "I John" / "first john" -> "1john"; drop spaces, dots, case. */
function normBook(s) {
  let t = String(s || '').toLowerCase().trim()
    .replace(/^(the\s+book\s+of|the\s+gospel\s+(?:according\s+to|of)|book\s+of)\s+/, '')
    .replace(/[.’']/g, '');
  t = t.replace(/^(1st|first|i)\s+/, '1 ').replace(/^(2nd|second|ii)\s+/, '2 ').replace(/^(3rd|third|iii)\s+/, '3 ');
  return t.replace(/\s+/g, '');
}
/** Resolve any way a person might type a book name to its canonical entry. */
function findBook(nameRaw) {
  const q = normBook(nameRaw);
  if (!q) return null;
  for (const b of BOOKS) {
    const canon = normBook(b.name);
    if (canon === q) return b;
    if (b.abbr.some((a) => normBook(a) === q)) return b;
  }
  // prefix match, longest first, so "phil" doesn't beat "philem" for "philemon"
  const pre = BOOKS.filter((b) => normBook(b.name).startsWith(q) || b.abbr.some((a) => normBook(a).startsWith(q)));
  if (pre.length === 1) return pre[0];
  if (pre.length > 1) {
    const exactStart = pre.filter((b) => normBook(b.name).startsWith(q));
    return (exactStart[0] || pre[0]);
  }
  return null;
}

/**
 * Parse a reference the way a person types it into a search box.
 *   "John 3:16"  "jn 3:16-18"  "1 Cor 13"  "Psalm 23:1-6"  "Rev 21:1,3-4"
 * Returns { bookNr, book, chapter, verses: [n…] | null }  (null verses = whole chapter)
 */
function parseRef(input) {
  const raw = String(input || '').trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  // book part = everything before the first chapter number (allowing a leading 1/2/3)
  const m = raw.match(/^((?:[123]\s*)?[^\d]+?)\s*(\d+)?\s*(?::\s*([\d,\s-]+))?$/i);
  if (!m) return null;
  const book = findBook(m[1]);
  if (!book) return null;
  const chapter = m[2] ? parseInt(m[2], 10) : 1;
  let verses = null;
  if (m[3]) {
    verses = [];
    for (const part of m[3].split(',')) {
      const p = part.trim(); if (!p) continue;
      const range = p.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const a = parseInt(range[1], 10), b = parseInt(range[2], 10);
        for (let v = Math.min(a, b); v <= Math.max(a, b); v++) verses.push(v);
      } else if (/^\d+$/.test(p)) verses.push(parseInt(p, 10));
    }
    if (!verses.length) verses = null;
  }
  return { bookNr: book.nr, book: book.name, chapter: Math.max(1, chapter), verses };
}

/** "John 3:16-18" / "John 3" — a tidy label for the slide footer. */
function formatRef(bookName, chapter, verses) {
  if (!verses || !verses.length) return `${bookName} ${chapter}`;
  const sorted = verses.slice().sort((a, b) => a - b);
  const runs = [];
  let s = sorted[0], p = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    if (sorted[i] === p + 1) { p = sorted[i]; continue; }
    runs.push(s === p ? String(s) : `${s}-${p}`);
    s = p = sorted[i];
  }
  return `${bookName} ${chapter}:${runs.join(',')}`;
}

/* ============================ http ============================ */
function getJson(url, { headers = {}, redirects = 0, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects.'));
    const req = https.get(url, { headers: Object.assign({ 'User-Agent': 'ChurchWorkSpace', Accept: 'application/json' }, headers) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getJson(res.headers.location, { headers, redirects: redirects + 1, onProgress }));
      }
      if (res.statusCode === 401 || res.statusCode === 403) { res.resume(); return reject(new Error('That Bible API key was rejected. Check it in Settings.')); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Bible server said ${res.statusCode}.`)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0; const chunks = [];
      res.on('data', (c) => {
        chunks.push(c); got += c.length;
        if (onProgress) onProgress(total ? Math.min(99, Math.round((got / total) * 100)) : Math.min(95, Math.round(got / 120000)));
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(new Error('The Bible server sent something unreadable.')); }
      });
    });
    req.on('error', (e) => reject(new Error('Could not reach the Bible server: ' + e.message)));
    req.setTimeout(120000, () => { req.destroy(new Error('The Bible server took too long.')); });
  });
}

/* ============================ catalogue ============================ */
/**
 * Every translation on offer, merged from four places: what's already
 * downloaded (always listed, even offline), the getbible catalogue and the
 * bolls.life list (both cached to disk so they survive a dead connection), and
 * anything imported by hand.
 */
async function catalogue({ refresh } = {}) {
  let cat = null;
  if (!refresh) { try { cat = JSON.parse(fs.readFileSync(catalogueFile(), 'utf-8')); } catch (e) {} }
  if (!cat) {
    try {
      const raw = await getJson(CATALOGUE_URL);
      cat = Object.values(raw).map((t) => ({
        abbr: safeAbbr(t.abbreviation), name: t.translation, language: t.language || t.lang || '',
        lang: t.lang || '', direction: t.direction || 'LTR', source: 'getbible',
        about: String(t.distribution_about || t.description || '').slice(0, 400),
      })).filter((t) => t.abbr);
      try { fs.writeFileSync(catalogueFile(), JSON.stringify(cat), 'utf-8'); } catch (e) {}
    } catch (e) {
      try { cat = JSON.parse(fs.readFileSync(catalogueFile(), 'utf-8')); } catch (e2) { cat = []; }
    }
  }
  const byAbbr = new Map(cat.map((t) => [t.abbr, Object.assign({}, t, { installed: false })]));
  // The modern translations sit alongside the public-domain ones rather than in
  // a separate list — a volunteer looking for "NIV" should find it by typing NIV.
  try { for (const t of await bollsCatalogue({ refresh })) if (!byAbbr.has(t.abbr)) byAbbr.set(t.abbr, t); } catch (e) {}
  const have = installed();
  for (const t of have) {
    const hit = byAbbr.get(t.abbr);
    if (hit) Object.assign(hit, { installed: true, sizeBytes: t.sizeBytes, source: t.source || hit.source });
    else byAbbr.set(t.abbr, Object.assign({ installed: true }, t));
  }
  const list = Array.from(byAbbr.values());
  // installed first, then English, then everything else alphabetically — the
  // list a media volunteer scrolls should start with what they can actually use
  list.sort((a, b) =>
    (b.installed ? 1 : 0) - (a.installed ? 1 : 0)
    || (a.lang === 'en' ? 0 : 1) - (b.lang === 'en' ? 0 : 1)
    || String(a.name).localeCompare(String(b.name)));
  return list;
}

/** Translations sitting on this machine, usable with the network unplugged. */
/** "…including Apocrypha (without glosses)" names books this app never shows. */
function withoutApocrypha(name) {
  return String(name || '').replace(/,?\s*(including|with)\s+(the\s+)?apocrypha\b.*$/i, '').trim();
}

function installed() {
  let files = [];
  try { files = fs.readdirSync(root()).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch (e) { return []; }
  const out = [];
  for (const f of files) {
    const p = path.join(root(), f);
    try {
      const st = fs.statSync(p);
      const head = readHead(p);
      out.push({
        // The id inside the file wins over the file name: `bollsniv.json` is
        // `bolls:NIV`, and that is the id the catalogue and the picker use.
        abbr: head.abbreviation || path.basename(f, '.json'),
        // …and no mention of it in the name either (see load(): the books are gone).
        name: withoutApocrypha(head.translation || path.basename(f, '.json').toUpperCase()),
        language: head.language || '', lang: head.lang || '', direction: head.direction || 'LTR',
        source: head.source || 'getbible', sizeBytes: st.size, installed: true,
      });
    } catch (e) {}
  }
  return out;
}
/** Read just the metadata off the front of a translation file (they're ~9 MB). */
function readHead(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(900);
    const n = fs.readSync(fd, buf, 0, 900, 0);
    fs.closeSync(fd);
    const s = buf.slice(0, n).toString('utf-8');
    const pick = (k) => { const m = s.match(new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"')); return m ? m[1] : ''; };
    return {
      translation: pick('translation'), abbreviation: pick('abbreviation'), language: pick('language'),
      lang: pick('lang'), direction: pick('direction'), source: pick('source'),
    };
  } catch (e) { return {}; }
}

/** Download a translation for permanent offline use. */
async function download(abbr, { onProgress } = {}) {
  if (isBolls(abbr)) return downloadBolls(abbr, { onProgress });
  const a = safeAbbr(abbr);
  if (!a) throw new Error('Pick a translation first.');
  const data = await getJson(TRANSLATION_URL(a), { onProgress });
  if (!data || !Array.isArray(data.books) || !data.books.length) throw new Error('That translation came back empty.');
  const norm = normalizeTranslation(data, a, 'getbible');
  fs.mkdirSync(root(), { recursive: true });
  const tmp = filePath(a) + '.part';
  fs.writeFileSync(tmp, JSON.stringify(norm), 'utf-8');
  fs.renameSync(tmp, filePath(a));
  memCache.delete(a);
  if (onProgress) onProgress(100);
  return { abbr: a, name: norm.translation, books: norm.books.length, sizeBytes: fs.statSync(filePath(a)).size };
}

function remove(abbr) {
  const a = safeAbbr(abbr);
  try { fs.rmSync(filePath(a), { force: true }); } catch (e) {}
  memCache.delete(a);
  return true;
}

/**
 * Coerce whatever we were handed into the one internal shape:
 *   { translation, abbreviation, lang, language, direction, source,
 *     books: [ { nr, name, chapters: [ { chapter, verses: [ { verse, text } ] } ] } ] }
 */
function normalizeTranslation(data, abbr, source) {
  const books = (data.books || []).map((b) => ({
    nr: Number(b.nr) || 0,
    name: b.name || (bookByNr(Number(b.nr)) || {}).name || '',
    chapters: (b.chapters || []).map((c) => ({
      chapter: Number(c.chapter) || 0,
      verses: (c.verses || []).map((v) => ({ verse: Number(v.verse) || 0, text: cleanVerse(v.text) })),
    })),
  })).filter((b) => b.nr && b.chapters.length);
  return {
    translation: data.translation || data.name || abbr.toUpperCase(),
    abbreviation: abbr,
    lang: data.lang || '', language: data.language || '', direction: data.direction || 'LTR',
    source: source || 'import',
    books,
  };
}
/** Strip Strong's numbers/markup that some public-domain modules carry inline. */
function cleanVerse(t) {
  return String(t == null ? '' : t)
    .replace(/\{[^}]*\}/g, '')          // {Strongs} / {morph} braces
    .replace(/<[^>]*>/g, '')            // stray tags
    .replace(/\[([^\]]*)\]/g, '$1')     // [added words] keep the word, drop the brackets
    .replace(/\s+/g, ' ')
    .trim();
}

/** Load a downloaded translation (cached in memory — a service hits this constantly). */
function load(abbr) {
  const a = safeAbbr(abbr);
  if (memCache.has(a)) return memCache.get(a);
  const p = filePath(a);
  if (!fs.existsSync(p)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; }
  /*
   * THE 66 BOOKS, NEVER THE APOCRYPHA. "I don't want Apocrypha" — and one of
   * the King James downloads carries fourteen extra books (Tobit, Judith,
   * Maccabees…). They are dropped here, where every Bible is read, so no
   * search, lookup, verse finder or picker anywhere in the app can reach them.
   */
  if (data && Array.isArray(data.books)) data.books = data.books.filter((b) => !(Number(b.nr) > 66));
  // Only ever keep two in memory — someone comparing translations shouldn't
  // gradually eat 100 MB of RAM over a long service.
  if (memCache.size >= 2) memCache.delete(memCache.keys().next().value);
  memCache.set(a, data);
  return data;
}
const isInstalled = (abbr) => fs.existsSync(filePath(abbr));

/* ============================ API.Bible ============================ */
async function apiBibleVersions(key) {
  if (!key) throw new Error('Add your free API.Bible key in Settings first.');
  const res = await getJson(`${API_BIBLE_BASE}/bibles`, { headers: { 'api-key': key } });
  return (res.data || []).map((b) => ({
    abbr: 'apib:' + b.id, name: `${b.abbreviationLocal || b.abbreviation} — ${b.name}`,
    language: (b.language && b.language.name) || '', lang: (b.language && b.language.id) || '',
    source: 'api.bible', installed: false, apiId: b.id,
  }));
}
/** Fetch one chapter from API.Bible and normalise it to our verse shape. */
async function apiBibleChapter(key, bibleId, bookNr, chapter) {
  const ck = `apib:${bibleId}:${bookNr}:${chapter}`;
  if (chapterCache.has(ck)) return chapterCache.get(ck);
  const usfm = USFM_IDS[bookNr];
  if (!usfm) throw new Error('Unknown book.');
  const res = await getJson(
    `${API_BIBLE_BASE}/bibles/${encodeURIComponent(bibleId)}/chapters/${usfm}.${chapter}?content-type=text&include-verse-numbers=true&include-titles=false&include-notes=false`,
    { headers: { 'api-key': key } });
  const content = (res.data && res.data.content) || '';
  // "[1] In the beginning… [2] And the earth…" -> one entry per verse
  const verses = [];
  const re = /\[(\d+)\]\s*([\s\S]*?)(?=\[\d+\]|$)/g;
  let m;
  while ((m = re.exec(content)) !== null) verses.push({ verse: parseInt(m[1], 10), text: cleanVerse(m[2]) });
  if (!verses.length && content.trim()) verses.push({ verse: 1, text: cleanVerse(content) });
  chapterCache.set(ck, verses);
  return verses;
}
const USFM_IDS = {
  1: 'GEN', 2: 'EXO', 3: 'LEV', 4: 'NUM', 5: 'DEU', 6: 'JOS', 7: 'JDG', 8: 'RUT', 9: '1SA', 10: '2SA',
  11: '1KI', 12: '2KI', 13: '1CH', 14: '2CH', 15: 'EZR', 16: 'NEH', 17: 'EST', 18: 'JOB', 19: 'PSA', 20: 'PRO',
  21: 'ECC', 22: 'SNG', 23: 'ISA', 24: 'JER', 25: 'LAM', 26: 'EZK', 27: 'DAN', 28: 'HOS', 29: 'JOL', 30: 'AMO',
  31: 'OBA', 32: 'JON', 33: 'MIC', 34: 'NAM', 35: 'HAB', 36: 'ZEP', 37: 'HAG', 38: 'ZEC', 39: 'MAL', 40: 'MAT',
  41: 'MRK', 42: 'LUK', 43: 'JHN', 44: 'ACT', 45: 'ROM', 46: '1CO', 47: '2CO', 48: 'GAL', 49: 'EPH', 50: 'PHP',
  51: 'COL', 52: '1TH', 53: '2TH', 54: '1TI', 55: '2TI', 56: 'TIT', 57: 'PHM', 58: 'HEB', 59: 'JAS', 60: '1PE',
  61: '2PE', 62: '1JN', 63: '2JN', 64: '3JN', 65: 'JUD', 66: 'REV',
};

/* ============================ bolls.life ============================
 *
 * NIV, NLT, ESV, NKJV, NASB, AMP and The Message are what most churches read
 * from, and bolls.life publishes all of them as plain JSON over ordinary HTTP —
 * no key, no account, no SDK. Two endpoints matter:
 *
 *   • the WHOLE translation as one file (~7 MB) — downloaded once and then
 *     permanently offline, exactly like the getbible catalogue;
 *   • ONE CHAPTER, live — so a verse still comes up if the offline copy was
 *     never fetched (or was deleted off this machine).
 *
 * Ids carry a `bolls:` prefix (`bolls:NIV`) so they can never collide with a
 * getbible abbreviation; on disk `safeAbbr` flattens that to `bollsniv.json`.
 */
const BOLLS_PREFIX = 'bolls:';
const isBolls = (a) => String(a || '').toLowerCase().startsWith(BOLLS_PREFIX);
const bollsCode = (a) => String(a || '').slice(BOLLS_PREFIX.length).toUpperCase().replace(/[^A-Z0-9]/g, '');
/** The code a human should see: `bolls:NIV` -> `NIV`. Anything else is unchanged. */
const displayCode = (a) => (isBolls(a) ? bollsCode(a) : String(a || '').toUpperCase());

/* Shown before the site has ever been reached, so the seven names a church asks
 * for are in the list on a first run with no wifi. Real names arrive with the
 * live catalogue and overwrite these. */
const BOLLS_FALLBACK = [
  ['NIV', 'New International Version'], ['NIV2011', 'New International Version (2011)'],
  ['NLT', 'New Living Translation'], ['ESV', 'English Standard Version'],
  ['NKJV', 'New King James Version'], ['NASB', 'New American Standard Bible'],
  ['AMP', 'Amplified Bible'], ['MSG', 'The Message'],
  ['CSB17', 'Christian Standard Bible'], ['NET', 'New English Translation'],
  ['BSB', 'Berean Standard Bible'], ['NRSVCE', 'New Revised Standard Version'],
];

/** Every translation bolls.life offers, cached to disk so the list survives a dead line. */
async function bollsCatalogue({ refresh } = {}) {
  const cacheFile = path.join(root(), '_bolls.json');
  let langs = null;
  if (!refresh) { try { langs = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')); } catch (e) {} }
  if (!langs) {
    try {
      langs = await getJson(BOLLS_LANGS);
      try { fs.mkdirSync(root(), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(langs), 'utf-8'); } catch (e) {}
    } catch (e) {
      try { langs = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')); } catch (e2) { langs = null; }
    }
  }
  if (!Array.isArray(langs)) {
    return BOLLS_FALLBACK.map(([code, name]) => ({
      abbr: BOLLS_PREFIX + code, name, language: 'English', lang: 'en', direction: 'LTR',
      source: 'bolls', installed: false,
    }));
  }
  const out = [];
  for (const group of langs) {
    const language = String((group && group.language) || '').trim();
    for (const t of (group && group.translations) || []) {
      const code = String(t.short_name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code) continue;
      out.push({
        abbr: BOLLS_PREFIX + code, name: t.full_name || code, language,
        lang: /^english/i.test(language) ? 'en' : '', direction: /hebrew|arabic/i.test(language) ? 'RTL' : 'LTR',
        source: 'bolls', installed: false,
      });
    }
  }
  return out;
}

/**
 * Verse text off bolls.life, made fit for a projector.
 *
 * Three things ride along in the markup and none of them belong on a screen:
 * Strong's numbers (`For<S>1063</S> God`), footnote markers, and — the one that
 * actually embarrasses you on a Sunday — the SECTION HEADING, which is glued to
 * the front of the first verse under it: John 3:1 arrives as
 * "Jesus Teaches Nicodemus<br/>Now there was a man…".
 *
 * A heading can only be told from scripture by its shape, so three gates have
 * to agree before anything is thrown away (measured over 3,684 verses of
 * NIV/MSG/NLT/NKJV/AMP/ESV/NASB — 82 cuts, every one a real heading):
 *   1. it ends with NO punctuation — "he leads me beside quiet waters," is text;
 *   2. what follows starts a sentence — poetry continues in lower case;
 *   3. it is title case — this is the gate that saves the Message's
 *      "Even when the way goes through<br/>Death Valley," from being eaten.
 */
const HEAD_SMALL = /^(a|an|and|as|at|but|by|for|from|in|of|on|or|the|to|with|is|his|her|my|me|you|your|it|be|so|not|who|why|how)$/i;
function looksTitleCased(s) {
  const words = String(s).replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').split(/\s+/).filter(Boolean);
  const judged = words.filter((w) => w.length > 1 && !HEAD_SMALL.test(w));
  if (!judged.length) return words.length > 0;          // "ב Beth" — a Psalm 119 letter
  return judged.filter((w) => /^[\p{Lu}\p{N}]/u.test(w)).length / judged.length >= 0.7;
}
function stripHeadings(text) {
  let cur = String(text);
  for (let i = 0; i < 3; i++) {                          // "BOOK I / Psalms 1–41 / Psalm 1" stacks up
    const m = cur.match(/^([^<]{1,60}?)<br\s*\/?>\s*([\s\S]*)$/i);
    if (!m) break;
    const head = m[1].trim(), rest = m[2].trim();
    if (!head || !rest) break;
    if (/[.,;:!?"”'’)\]—–-]$/.test(head)) break;
    if (!/^["“‘'(\p{Lu}\p{N}]/u.test(rest)) break;
    if (!looksTitleCased(head)) break;
    cur = rest;
  }
  return cur;
}
function cleanBolls(text) {
  return cleanVerse(
    stripHeadings(String(text == null ? '' : text)
      .replace(/<S>[\s\S]*?<\/S>/gi, '')                 // Strong's numbers, glued to the word
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, ' ')       // footnote markers
      .replace(/<f[^>]*>[\s\S]*?<\/f>/gi, ' '))
      .replace(/<br\s*\/?>/gi, ' '));                    // poetry line breaks -> one flowing verse
}

/** The whole translation in one file — this is what makes it offline for good. */
async function downloadBolls(id, { onProgress } = {}) {
  const code = bollsCode(id);
  if (!code) throw new Error('Pick a translation first.');
  const rows = await getJson(BOLLS_FULL(code), { onProgress });
  if (!Array.isArray(rows) || !rows.length) throw new Error('That translation came back empty.');
  const packed = fromFlatArray(rows.map((r) => ({ book: Number(r.book), chapter: r.chapter, verse: r.verse, text: cleanBolls(r.text) })));
  if (!packed.books.length) throw new Error('That translation came back in a shape this app could not read.');
  const abbr = BOLLS_PREFIX + code;
  const norm = normalizeTranslation(packed, abbr, 'bolls');
  norm.abbreviation = abbr;
  norm.translation = (await bollsName(code)) || code;
  norm.lang = 'en'; norm.language = 'English';
  fs.mkdirSync(root(), { recursive: true });
  const tmp = filePath(abbr) + '.part';
  fs.writeFileSync(tmp, JSON.stringify(norm), 'utf-8');
  fs.renameSync(tmp, filePath(abbr));
  memCache.delete(safeAbbr(abbr));
  if (onProgress) onProgress(100);
  return { abbr, name: norm.translation, books: norm.books.length, sizeBytes: fs.statSync(filePath(abbr)).size };
}
async function bollsName(code) {
  try {
    const hit = (await bollsCatalogue()).find((t) => bollsCode(t.abbr) === code);
    return hit ? hit.name : '';
  } catch (e) { return ''; }
}

/** One chapter, live — the path taken when nothing has been downloaded yet. */
async function bollsChapter(code, bookNr, chapter) {
  const ck = `bolls:${code}:${bookNr}:${chapter}`;
  if (chapterCache.has(ck)) return chapterCache.get(ck);
  const rows = await getJson(BOLLS_TEXT(code, bookNr, chapter));
  if (!Array.isArray(rows) || !rows.length) throw new Error(`Chapter ${chapter} isn't in ${(bookByNr(bookNr) || {}).name || 'that book'} for this translation.`);
  const verses = rows.map((r) => ({ verse: Number(r.verse) || 0, text: cleanBolls(r.text) })).filter((v) => v.verse);
  chapterCache.set(ck, verses);
  return verses;
}

/** Word search against the live site, for a translation that isn't downloaded. */
async function bollsFind(code, query, limit, bookNr) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const res = await getJson(BOLLS_FIND(code, q, Math.max(1, Math.min(200, limit * 3))));
  const rows = (res && res.results) || [];
  const out = [];
  for (const r of rows) {
    const b = bookByNr(Number(r.book));
    if (!b || (bookNr && b.nr !== bookNr)) continue;
    out.push({
      book: b.name, bookNr: b.nr, chapter: Number(r.chapter), verse: Number(r.verse),
      text: cleanBolls(r.text), reference: `${b.name} ${r.chapter}:${r.verse}`, score: 1,
    });
  }
  return out.slice(0, limit);
}

/** Chapter counts for a translation that hasn't been downloaded (drives the pickers). */
async function bollsChapterCounts(code) {
  const rows = await getJson(BOLLS_BOOKS(code));
  const map = new Map((rows || []).map((r) => [Number(r.bookid), Number(r.chapters) || 0]));
  return map;
}

/* ============================ reading ============================ */
/** Every verse of one chapter, from whichever source that translation lives in. */
async function getChapter({ translation, bookNr, chapter, apiKey }) {
  if (String(translation || '').startsWith('apib:')) {
    const id = String(translation).slice(5);
    return apiBibleChapter(apiKey, id, bookNr, chapter);
  }
  // A bolls translation that was never downloaded (or has been deleted) still
  // reads — it just needs the line to be up at that moment.
  if (isBolls(translation) && !isInstalled(translation)) return bollsChapter(bollsCode(translation), bookNr, chapter);
  const t = load(translation);
  if (!t) throw new Error(`"${translation}" isn't downloaded yet — get it from the Bible panel and it works offline for good.`);
  const b = t.books.find((x) => x.nr === bookNr);
  if (!b) throw new Error('That book is not in this translation.');
  const c = b.chapters.find((x) => x.chapter === chapter);
  if (!c) throw new Error(`Chapter ${chapter} isn't in ${bookByNr(bookNr).name} for this translation.`);
  return c.verses;
}

/**
 * How many verses each chapter of a book has, straight out of the downloaded
 * translation — [null, 6, 12, …] indexed by chapter number.
 *
 * Only 🎤 Listen uses this, and only to settle one ambiguity: "Psalm one
 * nineteen" is Psalm 119, while "John three sixteen" is John 3:16. Both are two
 * spoken numbers after a book, and the only thing that tells them apart is that
 * Psalm 1 has six verses so a nineteenth cannot exist. Returns null when the
 * translation is not downloaded locally, and the caller then leaves the
 * chapter-then-verse reading alone, which is right far more often anyway.
 */
function verseCounts(translation, bookNr) {
  const t = load(translation);
  if (!t) return null;
  const b = t.books.find((x) => x.nr === bookNr);
  if (!b) return null;
  const out = [];
  for (const c of b.chapters) out[c.chapter] = (c.verses || []).length;
  return out;
}

/** How many chapters a book has (drives the chapter picker). */
function chapterCount(translation, bookNr) {
  const t = load(translation);
  if (!t) return 0;
  const b = t.books.find((x) => x.nr === bookNr);
  return b ? b.chapters.length : 0;
}

/**
 * The one call the Presentation Studio makes: a reference in, verses out.
 * `ref` is anything parseRef understands.
 */
async function lookup({ translation, ref, apiKey }) {
  const parsed = typeof ref === 'string' ? parseRef(ref) : ref;
  if (!parsed) throw new Error(`Couldn't read "${ref}" as a Bible reference. Try something like "John 3:16" or "Psalm 23".`);
  const verses = await getChapter({ translation, bookNr: parsed.bookNr, chapter: parsed.chapter, apiKey });
  const want = parsed.verses;
  const picked = (want ? verses.filter((v) => want.includes(v.verse)) : verses)
    .map((v) => ({ book: parsed.book, bookNr: parsed.bookNr, chapter: parsed.chapter, verse: v.verse, text: v.text }));
  if (!picked.length) throw new Error(`${formatRef(parsed.book, parsed.chapter, want)} isn't in this translation.`);
  const head = load(translation);
  return {
    reference: formatRef(parsed.book, parsed.chapter, picked.map((v) => v.verse)),
    // `code` is what goes on the slide footer — "NIV", never "bolls:NIV".
    translation, code: displayCode(translation), translationName: (head && head.translation) || displayCode(translation),
    book: parsed.book, bookNr: parsed.bookNr, chapter: parsed.chapter,
    chapterVerses: verses.length,
    verses: picked,
  };
}

/**
 * Full-text search across a downloaded translation ("the Lord is my shepherd").
 * Linear scan of an in-memory array — ~31k verses, which is nothing, and it
 * keeps the whole thing dependency-free and offline.
 */
function search({ translation, query, limit = 60, bookNr }) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const t = load(translation);
  if (!t) throw new Error(`"${translation}" isn't downloaded yet.`);
  const needle = q.toLowerCase();
  const words = needle.split(/\s+/).filter(Boolean);
  const out = [];
  for (const b of t.books) {
    if (bookNr && b.nr !== bookNr) continue;
    for (const c of b.chapters) {
      for (const v of c.verses) {
        const low = v.text.toLowerCase();
        // whole phrase scores best; otherwise every word has to be in there
        const phrase = low.includes(needle);
        if (!phrase && !words.every((w) => low.includes(w))) continue;
        out.push({
          book: b.name, bookNr: b.nr, chapter: c.chapter, verse: v.verse, text: v.text,
          reference: `${b.name} ${c.chapter}:${v.verse}`, score: phrase ? 2 : 1,
        });
        if (out.length >= limit * 4) break;
      }
    }
  }
  out.sort((a, b) => b.score - a.score || a.bookNr - b.bookNr || a.chapter - b.chapter || a.verse - b.verse);
  return out.slice(0, limit);
}

/**
 * Search whichever way this translation can be searched: the offline copy if
 * there is one, otherwise bolls.life's own index. The panel calls this one.
 */
async function searchAny({ translation, query, limit = 60, bookNr }) {
  if (isBolls(translation) && !isInstalled(translation)) return bollsFind(bollsCode(translation), query, limit, bookNr);
  return search({ translation, query, limit, bookNr });
}

/**
 * A last-resort chapter count per book, in canonical order.
 *
 * Only used when the source cannot be asked (an API.Bible version, or nothing
 * chosen yet) — never to paper over a translation that really is missing books,
 * because offering a chapter that isn't there produces an error instead of
 * scripture.
 */
const CHAPTERS = [
  50, 40, 27, 36, 34, 24, 21, 4, 31, 24, 22, 25, 29, 36, 10, 13, 10, 42, 150, 31,
  12, 8, 66, 52, 5, 48, 12, 14, 3, 9, 1, 4, 7, 3, 3, 3, 2, 14, 4, 28,
  16, 24, 21, 28, 16, 16, 13, 6, 6, 4, 4, 5, 3, 6, 4, 3, 1, 13, 5, 5,
  3, 5, 1, 1, 1, 22,
];

/** The 66 books with a chapter count for this translation (drives the pickers). */
async function books(translation) {
  const t = String(translation || '');
  if (t && isBolls(t) && !isInstalled(t)) {
    try {
      const counts = await bollsChapterCounts(bollsCode(t));
      return BOOKS.map((b) => ({ nr: b.nr, name: b.name, chapters: counts.get(b.nr) || 0 }));
    } catch (e) { /* fall through to whatever is on disk */ }
  }
  const out = BOOKS.map((b) => ({ nr: b.nr, name: b.name, chapters: t ? chapterCount(t, b.nr) : 0 }));
  // Nothing could be counted at all — an API.Bible version, say, which is only
  // ever read a chapter at a time. Offer the canonical numbers rather than an
  // empty picker.
  if (out.every((b) => !b.chapters)) return BOOKS.map((b, i) => ({ nr: b.nr, name: b.name, chapters: CHAPTERS[i] }));
  return out;
}

/* ============================ import ============================ */
/**
 * Load a translation the church has its own licence for. Accepted shapes:
 *   • getbible-style  { translation, abbreviation, books:[{nr,name,chapters:[{chapter,verses:[{verse,text}]}]}] }
 *   • flat array      [ { book|book_name, chapter, verse, text }, … ]
 *   • flat object     { "Genesis": { "1": { "1": "In the beginning…" } } }
 * That covers the exports of nearly every Bible tool a volunteer is likely to have.
 */
function importFile(srcPath, { abbr, name } = {}) {
  if (!srcPath || !fs.existsSync(srcPath)) throw new Error('That file could not be found.');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(srcPath, 'utf-8')); }
  catch (e) { throw new Error('That file is not readable JSON. Export your Bible as JSON and try again.'); }

  let data = null;
  if (raw && Array.isArray(raw.books)) data = raw;
  else if (Array.isArray(raw)) data = fromFlatArray(raw);
  else if (raw && typeof raw === 'object') data = fromNestedObject(raw);
  if (!data || !data.books || !data.books.length) throw new Error('No verses were found in that file.');

  const a = safeAbbr(abbr || data.abbreviation || path.basename(srcPath, path.extname(srcPath)));
  if (!a) throw new Error('Give the translation a short code (like "niv").');
  const norm = normalizeTranslation(data, a, 'import');
  norm.translation = name || data.translation || a.toUpperCase();
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(filePath(a), JSON.stringify(norm), 'utf-8');
  memCache.delete(a);
  const verses = norm.books.reduce((s, b) => s + b.chapters.reduce((n, c) => n + c.verses.length, 0), 0);
  return { abbr: a, name: norm.translation, books: norm.books.length, verses };
}
function fromFlatArray(arr) {
  const byBook = new Map();
  for (const r of arr) {
    const bookName = r.book_name || r.book || r.b;
    // A NUMBER is a book number, always. Letting findBook see it first is a
    // trap: "1" prefix-matches 1 Samuel, so Genesis would import as 1 Samuel.
    const numeric = typeof bookName === 'number' || /^\d+$/.test(String(bookName || ''));
    const b = (numeric ? bookByNr(Number(bookName)) : null) || findBook(bookName);
    if (!b) continue;
    const ch = Number(r.chapter != null ? r.chapter : r.c), vs = Number(r.verse != null ? r.verse : r.v);
    const text = r.text != null ? r.text : r.t;
    if (!ch || !vs || text == null) continue;
    if (!byBook.has(b.nr)) byBook.set(b.nr, { nr: b.nr, name: b.name, chapters: new Map() });
    const bk = byBook.get(b.nr);
    if (!bk.chapters.has(ch)) bk.chapters.set(ch, []);
    bk.chapters.get(ch).push({ verse: vs, text });
  }
  return packBooks(byBook);
}
function fromNestedObject(obj) {
  const byBook = new Map();
  for (const [bookName, chapters] of Object.entries(obj)) {
    const b = findBook(bookName);
    if (!b || !chapters || typeof chapters !== 'object') continue;
    for (const [chNo, verses] of Object.entries(chapters)) {
      const ch = Number(chNo); if (!ch || !verses || typeof verses !== 'object') continue;
      if (!byBook.has(b.nr)) byBook.set(b.nr, { nr: b.nr, name: b.name, chapters: new Map() });
      const bk = byBook.get(b.nr);
      if (!bk.chapters.has(ch)) bk.chapters.set(ch, []);
      for (const [vNo, text] of Object.entries(verses)) {
        const vs = Number(vNo); if (!vs) continue;
        bk.chapters.get(ch).push({ verse: vs, text: typeof text === 'string' ? text : (text && text.text) || '' });
      }
    }
  }
  return packBooks(byBook);
}
function packBooks(byBook) {
  const books = Array.from(byBook.values())
    .sort((a, b) => a.nr - b.nr)
    .map((b) => ({
      nr: b.nr, name: b.name,
      chapters: Array.from(b.chapters.entries())
        .sort((x, y) => x[0] - y[0])
        .map(([chapter, verses]) => ({ chapter, verses: verses.sort((x, y) => x.verse - y.verse) })),
    }));
  return { books };
}

module.exports = {
  init, root, catalogue, installed, isInstalled, download, remove, importFile,
  // the whole translation, for anything that has to walk every verse (versefind.js)
  load,
  lookup, search, searchAny, books, getChapter, chapterCount, verseCounts, parseRef, formatRef, findBook, normBook,
  apiBibleVersions, BOOKS, bookByNr, cleanVerse,
  // bolls.life (the modern translations)
  isBolls, bollsCode, displayCode, bollsCatalogue, cleanBolls, BOLLS_FALLBACK,
};
