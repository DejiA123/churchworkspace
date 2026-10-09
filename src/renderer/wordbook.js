'use strict';
/*
 * THE WORD BOOK — the same wrong word is never corrected twice.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * whisper small.en hears a sermon well enough, but it has never heard of the
 * church, the preacher, or half the book names, so every single week the same
 * handful of words come out wrong in the same way — and every week they get
 * retyped by hand, forty rows at a time, before the short can go out. Medium.en
 * does not fix it (measured: same words, three times the wait), and a custom
 * `--prompt` makes it dramatically WORSE (66% of words differ — see
 * test/captions-accuracy.test.js). So the fix cannot live in the decoder.
 *
 * It lives here instead, AFTER the decode, as plain text arithmetic:
 *
 *   1. WHAT YOU FIX ONCE IN THIS VIDEO IS FIXED EVERYWHERE IN IT, instantly —
 *      correct one line and every other line saying the same wrong thing
 *      changes with it, including the word timings underneath, so re-breaking
 *      the lines later cannot resurrect it.
 *   2. WHAT YOU FIX IS REMEMBERED, and applied to every transcription from then
 *      on, in every video, before the words ever reach the screen.
 *   3. WORDS IT HAS NEVER SEEN SPELLED WRONG BEFORE but which SOUND like a word
 *      in the book are fixed too — "EZEKIAL"/"EZEKEEL" land on "Ezekiel"
 *      without anybody having typed those two variants in.
 *
 * WHY IT CANNOT MAKE THINGS SLOWER
 *
 * There is no second pass over the audio and no model involved: this is hash
 * lookups over the word list that whisper already produced. A three-hour
 * sermon's 30,000 words go through it in single-digit milliseconds — several
 * thousand times less than the transcription that produced them.
 * test/wordbook.test.js holds that budget as a hard assertion.
 *
 * WHY IT CANNOT MAKE THE CAPTIONS WORSE
 *
 * The two dangerous moves are (a) rewriting an ordinary English word into
 * somebody's name and (b) learning a correction that was only right once. So:
 *
 *   • the sound-alike layer NEVER touches a common English word, never fires on
 *     anything under four letters, and needs the sound to match exactly (or by
 *     one sound, for long words) AND the spelling to be close;
 *   • A CORRECTION OF ONE EVERYDAY WORD INTO ANOTHER IS NEVER STORED BARE.
 *     "he's" → "it's" is true of the sentence it was typed in and false of the
 *     next one, and counting how often it was typed does not change that — a
 *     real church's book ended up with 142 such rules, including `he's → it's`
 *     and `it's → he's` both switched on, cancelling each other out. So a
 *     single-everyday-word change is WIDENED with the unchanged words either
 *     side of it ("he's not" → "it's not"), taken from the line or, when the
 *     line is one word long, from the caption lines around it. With no context
 *     anywhere it is not remembered at all: it stands on the line it was made
 *     on, which is all it was ever evidence for. A correction of a word that is
 *     NOT English ("a fee shins" → "Ephesians") needs none of this — it is
 *     trusted at once, because whisper inventing a non-word is not a judgement.
 *
 * Nothing in this file touches the DOM, the disk or Electron — which is what
 * lets the studio (window.WordBook) and the main process
 * (require('../renderer/wordbook.js')) run the SAME code. One definition, so
 * the fix you see in the caption window and the fix the next transcription gets
 * cannot drift apart.
 */
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WordBook = api;
}(function () {
  /** Bump when the stored shape changes in a way older books must be migrated for.
   *  2 — single everyday words are no longer stored bare, only widened with the
   *      words around them; books written under rule 1 are tidied on load. */
  const VERSION = 3;

  /* The longest run of words a single fix may span. "a fee shins" is three;
   * beyond four a "correction" is really a rewrite of the sentence, and
   * rewrites are not something to repeat automatically on future videos. */
  const MAX_N = 4;

  /* --- the sound-alike gates. Every one of these is a guard against turning an
   *     ordinary word into a name; they are named constants so the test can
   *     print them next to the false-positive count they buy. --- */
  const SOUND_MIN_TERM_LEN = 5;   // a term shorter than this is not distinctive enough to attract anything
  const SOUND_MIN_KEY = 3;        // …nor is one whose sound boils down to fewer letters than this
  const SOUND_MIN_HEARD_LEN = 4;  // never re-spell a tiny word
  const SOUND_SIM_ONE = 0.55;     // one heard word -> term: how close the SPELLING must also be
  const SOUND_SIM_MANY = 0.40;    // several heard words -> one term (the sound match is longer, so this can be looser)
  const SOUND_NEAR_LEN = 7;       // only long words may match on a NEARLY-equal sound…
  const SOUND_NEAR_SIM = 0.82;    // …and then the spelling has to be very close indeed
  const SOUND_MIN_KEY_MANY = 4;   // joining words together needs MORE sound to be sure, not less
  const SOUND_UNCOMMON_RATIO = 0.6; // …and the run has to be mostly not-English to begin with

  /* ------------------------------------------------------------------ *
   * Ordinary English. Nothing in here is ever re-spelled by the
   * sound-alike layer, and a correction FROM one of these words is
   * treated as a judgement call rather than an obvious mishearing.
   * ------------------------------------------------------------------ */
  const COMMON_WORDS = new Set((
    'a able about above accept according account across act action activity actually add address admit adult affect after again against age agency agent ago agree agreement ahead air all allow almost alone along already also although always among amount analysis and animal another answer any anyone anything appear apply approach area argue arm around arrive art article artist as ask assume at attack attention attorney audience author authority available avoid away ' +
    'baby back bad bag ball bank bar base be beat beautiful beauty because become bed been before begin beginning behavior behind being believe benefit best better between beyond big bill billion bit black blood blue board body book born both box boy break bring brother budget build building business but buy by ' +
    'call camera campaign can cancer candidate capital car card care career carry case catch cause cell center central century certain certainly chair challenge chance change character charge check child choice choose church citizen city civil claim class clean clear clearly close coach cold collection college color come commercial common community company compare computer concern condition conference congress consider consumer contain continue control cost could country couple course court cover create crime cultural culture cup current customer cut ' +
    'dark data daughter day dead deal death debate decade decide decision deep defense degree democrat describe design despite detail determine develop development die difference different difficult dinner direction director discover discuss discussion disease do doctor dog door down draw dream drive drop drug during ' +
    'each early east easy eat economic economy edge education effect effort eight either election else employee end energy enjoy enough enter entire environment especially establish even evening event ever every everybody everyone everything evidence exactly example executive exist expect experience expert explain eye ' +
    'face fact factor fail fall family far fast father fear federal feel feeling few field fight figure fill film final finally financial find fine finger finish fire firm first fish five floor fly focus follow food foot for force foreign forget form former forward four free friend from front full fund future ' +
    'game garden gas general generation get girl give glass go goal good govern government great green ground group grow growth guess gun guy ' +
    'hair half hand hang happen happy hard have he head health hear heart heat heavy help her here herself high him himself his history hit hold home hope hospital hot hotel hour house how however huge human hundred husband ' +
    'i idea identify if image imagine impact important improve in include including increase indeed indicate individual industry information inside instead institution interest interesting international interview into investment involve is issue it item its itself ' +
    'job join just ' +
    'keep key kid kill kind kitchen know knowledge ' +
    'land language large last late later laugh law lawyer lay lead leader learn least leave left leg legal less let letter level lie life light like likely line list listen little live local long look lose loss lot love low ' +
    'machine magazine main maintain major majority make man manage management manager many market marriage material matter may maybe me mean measure media medical meet meeting member memory mention message method middle might military million mind minute miss mission model modern moment money month more morning most mother mouth move movement movie much music must my myself ' +
    'name nation national natural nature near nearly necessary need network never new news newspaper next nice night no none nor north not note nothing notice now number ' +
    'occur of off offer office officer official often oh oil ok old on once one only onto open operation opportunity option or order organization other others our out outside over own owner ' +
    'page pain painting paper parent part participant particular particularly partner party pass past patient pattern pay peace people per perform performance perhaps period person personal phone physical pick picture piece place plan plant play player point police policy political politics poor popular population position positive possible power practice prepare present president pressure pretty prevent price private probably problem process produce product production professional professor program project property protect prove provide public pull purpose push put ' +
    'quality question quickly quite ' +
    'race radio raise range rate rather reach read ready real reality realize really reason receive recent recently recognize record red reduce reflect region relate relationship religious remain remember remove report represent republican require research resource respond response responsibility rest result return reveal rich right rise risk road rock role room rule run ' +
    'safe same save say scene school science scientist score sea season seat second section security see seek seem sell send senior sense series serious serve service set seven several sex sexual shake share she shoot short shot should shoulder show side sign significant similar simple simply since sing single sister sit site situation six size skill skin small smile so social society soldier some somebody someone something sometimes son song soon sort sound source south southern space speak special specific speech spend sport spring staff stage stand standard star start state statement station stay step still stock stop store story strategy street strong structure student study stuff style subject success successful such suddenly suffer suggest summer support sure surface system ' +
    'table take talk task tax teach teacher team technology television tell ten tend term test than thank that the their them themselves then theory there these they thing think third this those though thought thousand threat three through throughout throw thus time to today together tonight too top total tough toward town trade traditional training travel treat treatment tree trial trip trouble true truth try turn tv two type ' +
    'under understand unit until up upon us use usually ' +
    'value various very victim view violence visit voice vote ' +
    'wait walk wall want war watch water way we weapon wear week weight well west western what whatever when where whether which while white who whole whom whose why wide wife will win wind window wish with within without woman women word work worker world worry would write writer wrong ' +
    'yard yeah year yes yet you young your yourself ' +
    /* the small change of ordinary speech that the top-1000 list misses, and the
     * everyday words a preacher says most — none of which may ever be re-spelled */
    'am are was were been being do does did done has have had having cannot can not don doesn didn won isn aren wasn weren couldn shouldn wouldn haven hasn hadn ain gonna gotta wanna ' +
    'able above almost alright anybody anymore anyway apart arm ask asked asking away back behind believe believed believing bible bit bless blessed blessing blessings born bread break broken brother brothers brought build built burden call called calling came care carry cast caught chapter cheap child children choose chose christian christians church churches clean come comes coming cross crown cry crying daily dark day days dead death deep deliver door doubt down dry early earth easy eat empty end enemy enemies enter even evening ever every everybody everyone everything evil eye eyes face fail faith faithful fall fallen family far fast father fear feed feel fell fight filled find fine finish fire first flesh follow followed food fool foot forever forget forgive forgiven forgiveness found free friend friends fruit full gate gave get gift gifts girl give given giving glad glory go god going gone good grace grateful great greater ground grow guard hallelujah hand hands happy hard hate head heal healed healing hear heard heart hearts heaven heavy hell help here hide high hold holy home honest honour honor hope hour house how humble hungry hurt husband ' +
    /* Church English. These are ordinary words a preacher says every Sunday and
     * whisper spells correctly — so they are PROTECTED here rather than listed
     * as sound-alike targets. A word the decoder already knows does not need a
     * word book; it needs to be left alone, and a word that is left alone can
     * never be turned into somebody's name by accident. */
    'pastor pastors pastoral preacher preachers bishop bishops deacon deacons deaconess elder elders minister ministers ministry ministries sermon sermons temple temples altar altars gospel gospels apostle apostles apostolic disciple disciples discipleship prophet prophets prophecy prophesy prophetic priest priests priesthood angel angels archangel saint saints psalm psalms hymn hymns choir chorister usher ushers congregation congregations fellowship worship worshipper praise prayer prayers blessing blessings miracle miracles testimony testimonies offering offerings covenant baptism baptise baptize baptized baptised communion sacrament sacraments crucifixion crucified resurrection ascension incarnation salvation redemption redeemer forgiveness righteousness righteous repentance repent holiness sanctuary sanctify sanctified sanctification justification atonement anointing anointed intercession consecration deliverance dedication thanksgiving scripture scriptures verse verses chapter chapters parable parables commandment commandments beatitudes tithe tithes tithing offertory evangelism evangelist evangelical charismatic pentecostal devotion devotional meditation supplication petition fasting pulpit chalice genealogy crusade revival sovereign sovereignty providence eternal eternity everlasting hallowed beloved merciful gracious glorify magnify exalt edify blasphemy idolatry iniquity transgression reconciliation regeneration predestination omnipotent omniscient omnipresent rapture tribulation millennium antichrist apostasy epistle heaven heavenly hell grace mercy faith faithful glory spirit spiritual soul cross calvary christian christians church gentile gentiles israelite israelites samaritan centurion nazarene levitical messianic chronicles revelation revelations ' +
    'inside instead into it join journey joy judge just keep kept kind king kingdom knee kneel knew know known lack lamb last late laugh law lay lead leader learn leave led left let letter lie life lift light like listen little live lives living long look lord lose lost loud love loved loving low made make man many mark marriage married mean meant mercy mercies message middle might mighty mind minister ministry miracle miracles moment money month morning mother mountain mouth move moved moving much must name near need needs never new next night no none nothing now number obey offer offering old one only open order other our out over own pain pardon parent pass past path patience pay peace people perfect pick place plan play please poor power powerful praise pray prayed prayer prayers preach preacher present press promise promised prophet protect proud pure purpose put quiet raise reach read ready real reason receive record refuse rejoice remain remember repent rest restore return reward rich right rise river road rock room root run sacrifice sad safe said saint saints sake salvation same save saved saviour savior say scripture season seat second see seed seek seen self send sent serve servant service set seven shall shame share sharp sheep shepherd shine short shout show sick side sight sign silence simple sin sing single sinner sins sister sit slow small smile so soft some son song soon sorrow sorry soul sound speak special spirit spiritual spoke stand start stay stone stood stop store storm story straight strange strength strong stumble suffer sun sunday sure sweet sword table take taken talk teach teacher tear tears tell temple tempt test testify thank thanks that their them then there these they thing think third this those thou though thought three throne through throw thy time today together told tomorrow tongue took touch toward town tree true trust truth try turn twelve two under understand until up upon us use vain victory village visit voice wait wake walk wall want war warm wash watch water way we weak wealth week weep welcome well went were what when where which while white who whole why wicked wide wife will win wind wine wing wisdom wise wish with within without witness woman wonder wonderful word words work works world worry worship worth would wound write wrong yes yesterday yet you young your youth zeal'
  ).split(/\s+/).filter(Boolean));

  /* ------------------------------------------------------------------ *
   * The vocabulary the app ALREADY knows on a fresh install — the books
   * of the Bible, the people and the places in them, and the words a
   * church service is built out of. These are not corrections; they are
   * the targets the sound-alike layer is allowed to aim at, so that
   * "HABAKUK", "EZEKIAL" and "THESSALONIANS" spelled six ways all land
   * on one spelling without anybody having taught it a thing.
   *
   * Deliberately NOT in here: any word that is also ordinary English —
   * Acts, Job, Mark, Numbers, Judges, Kings, Ruth, James. A term that is
   * an everyday word would pull everyday speech towards itself, which is
   * exactly the failure this feature must not have. (isSoundTerm() drops
   * them anyway; leaving them out keeps the list honest about its job.)
   * ------------------------------------------------------------------ */
  const SEED_TERMS = (
    /* books */
    'Genesis Exodus Leviticus Deuteronomy Joshua Samuel Nehemiah Esther Proverbs Ecclesiastes Isaiah Jeremiah Lamentations Ezekiel Daniel Hosea Obadiah Jonah Micah Nahum Habakkuk Zephaniah Haggai Zechariah Malachi Matthew Romans Corinthians Galatians Ephesians Philippians Colossians Thessalonians Timothy Titus Philemon Hebrews Peter ' +
    /* people */
    'Abraham Abram Sarah Isaac Rebekah Jacob Joseph Benjamin Judah Moses Aaron Miriam Caleb Deborah Gideon Samson Naomi David Solomon Elijah Elisha Jehoshaphat Hezekiah Josiah Nebuchadnezzar Belshazzar Mordecai Melchizedek Methuselah Bathsheba Absalom Jonathan Nathan Jezebel Gabriel Michael Zacharias Elizabeth Herod Pilate Barabbas Caiaphas Nicodemus Zacchaeus Lazarus Martha Magdalene Matthias Barnabas Stephen Philip Cornelius Ananias Sapphira Silas Priscilla Aquila Apollos Onesimus Lydia Dorcas Demas Felix Festus Agrippa Thomas Andrew Bartholomew Thaddaeus Zebedee Simeon ' +
    /* …and the ones speech recognition gets wrong most ("Methabosheth",
     * "Jehovah Jire", "Zarababel", measured on the live server). A sound-alike
     * name is only safe if no ordinary English sounds like it, and the first
     * list of these was NOT: it was vetted against a dictionary of headwords,
     * which has "jar" but not "jars", and never against pairs of words — and on
     * the live studio "the false prophets" became "Theophilus prophets",
     * "raised us up" became "Erastus up" and "jars of clay" "Jairus of clay".
     * Every name below has now been run through this matcher, on its own, over
     * 2.1 million words of real English (the King James Bible and 17 other
     * books), a 94,000-word frequency list with every inflection, and all 25
     * million pairs of the 5,000 commonest words — and kept only if all it ever changes
     * is itself, or another spelling of the same person (Zorobabel, Bezaleel).
     * 50 that pulled anything else are left out (Arimathea took the place
     * Ramath, Elimelech the place Alammelech) — Theophilus ("the false"),
     * Erastus ("raised us"), Jairus ("jars"), Trophimus ("true famous"),
     * Ebenezer, Shadrach, Meshach and Abednego among them. Whisper spells those
     * right anyway, and a caption that can no longer say "jars" is too high a
     * price. test/wordbook.test.js keeps the reviewer's examples as checks. */
    'Mephibosheth Zerubbabel Jireh Shaddai Nissi Rapha Shammah Azariah Japheth Pharaoh Othniel Manoah Orpah Peninnah Hophni Uriah Adonijah Shimei Hushai Rehoboam Gehazi Athaliah Uzziah Tobiah Vashti Artaxerxes Obededom Elihu Enoch Eutychus Epaphroditus Aeneas Aristarchus Berea Thyatira Joppa Zarephath Achaia Goshen Moriah Gibeah Jabbok Jephthah Delilah Bezalel Ephratah Bethphage Zedekiah Jehoiachin Goliath Belteshazzar ' +
    /* God, and the names of God */
    'Jesus Christ Messiah Immanuel Emmanuel Yahweh Jehovah Adonai Elohim Almighty Trinity ' +
    /* places */
    'Jerusalem Bethlehem Nazareth Galilee Judea Samaria Capernaum Bethany Bethel Jericho Jordan Sinai Horeb Golgotha Gethsemane Emmaus Damascus Antioch Corinth Ephesus Philippi Thessalonica Colossae Galatia Macedonia Athens Patmos Babylon Assyria Nineveh Egypt Canaan Gomorrah Sodom Bethsaida Hebron Shiloh Gilgal Megiddo Armageddon Euphrates ' +
    /* what a church service is made of */
    'Alleluia Hosanna Hosannah Selah Shalom Yeshua Passover Pentecost Tabernacle Eucharist Sanhedrin Synagogue Pharisee Pharisees Sadducee Sadducees Levite Levites Nazirite Zealot Publican Scribes Rabbi Rabboni Maranatha Doxology Liturgy Liturgical Benediction Novena Rosary Vespers Matins Presbyter Presbytery Archbishop Archdeacon Curate Verger Acolyte Cantor Precentor Firstfruits Almsgiving Propitiation Expiation Imputation Justified Predestined Cherubim Seraphim Cherub Seraph Myrrh Frankincense Manna Shekinah Ephod Phylactery Menorah Shofar Talmud Torah Pentateuch Apocrypha Septuagint Vulgate Parousia Kerygma Koinonia Agape Eschatology Soteriology Ecclesiology Christology Theophany Hermeneutics Exegesis Homiletics Homily Catechism Catechist Chrism Paschal Advent Epiphany Lenten Eastertide Whitsun Trinitarian Charismata Glossolalia Intercessor Intercessors Backslider Backsliding Bethesda Siloam Gilead Gehenna Sheol Abaddon Beelzebub Belial Leviathan Behemoth Nephilim Rephaim Philistine Philistines Amalekite Amalekites Moabite Moabites Edomite Edomites Midianite Midianites Hittite Hittites Jebusite Ammonite Canaanite Canaanites Ninevite Chaldean Chaldeans Babylonian Babylonians Assyrian Assyrians Corinthian Ephesian Thessalonian Galatian Colossian Philippian Macedonian Judean Galilean Nazarethite '
  
  ).split(/\s+/).filter(Boolean);

  /* ---------------------------------------------------------------- *
   * Normalising: how two spellings of the same thing are compared.
   * ---------------------------------------------------------------- */

  /** The word with its edge punctuation and its case taken off. The apostrophe
   *  INSIDE a word is part of it (don't, God's), so only the edges are trimmed. */
  function normWord(w) {
    return String(w == null ? '' : w)
      .replace(/[’ʼ´`]/g, "'")
      .toLowerCase()
      .replace(/^[^a-z0-9']+/, '')
      .replace(/[^a-z0-9']+$/, '')
      .replace(/^'+/, '')
      .replace(/'+$/, '');
  }

  /** A whole phrase reduced to the same canonical form, one space between words. */
  function normPhrase(s) {
    return String(s == null ? '' : s).split(/\s+/).map(normWord).filter(Boolean).join(' ');
  }

  /** Split one token into [leading punctuation, the word, trailing punctuation],
   *  so a replacement can keep the comma or the full stop that was hanging off it. */
  function splitAffix(t) {
    const s = String(t == null ? '' : t);
    const m = /^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}]*)$/u.exec(s) || [s, '', s, ''];
    return { pre: m[1] || '', core: m[2] || '', post: m[3] || '' };
  }

  /** Just the letters, for spelling-distance work. */
  const lettersOf = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z]/g, '');

  /**
   * How a word SOUNDS, as a short key (Metaphone). Two spellings with the same
   * key are two ways of writing the same noise: EZEKIEL and EZEKIAL both give
   * ESKL, which is what lets a spelling nobody has ever typed before be
   * recognised as one that has.
   */
  function soundKey(s) {
    let w = lettersOf(s).toUpperCase();
    if (!w) return '';
    if (/^(AE|GN|KN|PN|WR)/.test(w)) w = w.slice(1);
    else if (w[0] === 'X') w = 'S' + w.slice(1);
    else if (/^WH/.test(w)) w = 'W' + w.slice(2);
    const isV = (c) => c === 'A' || c === 'E' || c === 'I' || c === 'O' || c === 'U';
    let out = '';
    for (let i = 0; i < w.length; i++) {
      const c = w[i], p = w[i - 1] || '', n = w[i + 1] || '', n2 = w[i + 2] || '';
      if (c === p && c !== 'C') continue;                 // a doubled letter is one sound
      switch (c) {
        case 'A': case 'E': case 'I': case 'O': case 'U':
          if (i === 0) out += c; break;                   // vowels only count at the front
        case 'B': if (!(i === w.length - 1 && p === 'M')) out += 'B'; break;
        case 'C':
          if (n === 'I' && n2 === 'A') out += 'X';
          else if (n === 'H') out += (p === 'S' ? 'K' : 'X');
          else if (n === 'I' || n === 'E' || n === 'Y') out += 'S';
          else out += 'K';
          break;
        case 'D':
          if (n === 'G' && (n2 === 'E' || n2 === 'Y' || n2 === 'I')) { out += 'J'; i++; }
          else out += 'T';
          break;
        case 'G':
          if (n === 'H') { if (isV(n2)) out += 'K'; }     // GH is silent unless a vowel follows
          else if (n === 'N') { /* silent: sign, reign */ }
          else if (n === 'I' || n === 'E' || n === 'Y') out += 'J';
          else out += 'K';
          break;
        case 'H':
          if (isV(p) && !isV(n)) break;                   // silent after a vowel with none after
          if (p === 'C' || p === 'S' || p === 'P' || p === 'T' || p === 'G') break;
          out += 'H'; break;
        case 'K': if (p !== 'C') out += 'K'; break;
        case 'P': if (n === 'H') { out += 'F'; i++; } else out += 'P'; break;
        case 'Q': out += 'K'; break;
        case 'S':
          if (n === 'H') { out += 'X'; i++; }
          else if (n === 'I' && (n2 === 'O' || n2 === 'A')) out += 'X';
          else out += 'S';
          break;
        case 'T':
          if (n === 'I' && (n2 === 'O' || n2 === 'A')) out += 'X';
          else if (n === 'H') { out += '0'; i++; }
          else if (!(n === 'C' && n2 === 'H')) out += 'T';
          break;
        case 'V': out += 'F'; break;
        case 'W': case 'Y': if (isV(n)) out += c; break;
        case 'X': out += 'KS'; break;
        case 'Z': out += 'S'; break;
        default: out += c;                                // F J L M N R
      }
    }
    return out;
  }

  /**
   * The same key with a leading vowel dropped.
   *
   * "EPHESIANS" keys as EFXNS; heard as three words, "a fee shins" keys as
   * AFXNS. Identical noise, different first letter — because whisper heard the
   * opening vowel as a different vowel, which is the single most common way a
   * long name comes apart. Matching happens on this form so that difference
   * cannot hide the match.
   */
  const keyBody = (k) => (k && /^[AEIOU]/.test(k) ? k.slice(1) : k || '');

  /** Ordinary English (or too short to be worth re-spelling). */
  function isCommonWord(w) {
    const n = normWord(w);
    if (!n) return true;
    if (n.length <= 3) return true;
    if (COMMON_WORDS.has(n)) return true;
    // plurals / tenses of a common word are common too
    if (n.endsWith('s') && COMMON_WORDS.has(n.slice(0, -1))) return true;
    if (n.endsWith('es') && COMMON_WORDS.has(n.slice(0, -2))) return true;
    if (n.endsWith('ed') && COMMON_WORDS.has(n.slice(0, -2))) return true;
    if (n.endsWith('ing') && COMMON_WORDS.has(n.slice(0, -3))) return true;
    if (n.indexOf("'") > 0 && COMMON_WORDS.has(n.split("'")[0])) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   * KNOWN WORDS — what the BUILT-IN names may never replace.
   *
   * COMMON_WORDS above is 1,400 words. Every other real word was fair game
   * for the built-in Bible names, and the 25-million-pair sweep found 583 of
   * the 100,000 commonest English words being re-spelled: "plate" -> Pilate,
   * "divide" -> David, "sales" -> Silas, "salmon" -> Solomon, "romance" ->
   * Romans, "manual" -> Immanuel, "the ceiling" -> Thessalonica — and real
   * people's names too: "Simon" -> Simeon, "Steven" -> Stephen, "Pastor
   * Watson" -> "Pastor Whitsun".
   *
   * So a built-in name now only replaces what is NOT a word: 79,000 English
   * words (SCOWL, the list spell checkers use, every English spelling), 12,500
   * common first names and surnames, and 150 hand-checked places and words
   * ("Ibadan", "Ghanaian", "Syrian"), in wordbook-english.js. A heard
   * word on that list is what was said. What is left for the built-in names is
   * what whisper actually gets wrong — "Methabosheth", "Zarababel",
   * "Ezekial". A name the operator put in the book themselves keeps the
   * older, looser rule: they chose it, and "Wally Oak" -> "Wale Oke" is the
   * reason they did.
   *
   * If the list cannot be loaded the built-in names do not sound-match at all
   * (they still count as spelled right): a missing safety list must make the
   * book more careful, never less.
   * ------------------------------------------------------------------ */
  const KNOWN = (function () {
    let src = null;
    try {
      src = (typeof window !== 'undefined' && window.WordBookEnglish)
        || (typeof require === 'function' ? require('./wordbook-english.js') : null);
    } catch (e) { src = null; }
    if (typeof src !== 'string' || !src) return null;
    const set = new Set();
    let prev = '';
    for (const e of src.split(' ')) {
      if (!e) continue;
      const c = e.charCodeAt(0);
      const k = c <= 57 ? c - 48 : c - 87;           // 0-9, then a-z for 10-35
      prev = prev.slice(0, k) + e.slice(1);
      set.add(prev);
    }
    return set;
  }());

  /** Real English or a real person's name (possessive and plural forms too). */
  function isKnownWord(w) {
    const n = normWord(w);
    if (!n || isCommonWord(n)) return true;
    if (!KNOWN) return true;
    if (KNOWN.has(n)) return true;
    const bare = n.replace(/'s$|s'$|'$/, (x) => (x === "s'" ? 's' : ''));
    if (bare !== n && (KNOWN.has(bare) || isCommonWord(bare))) return true;
    // "Watsons", "Simmonses" and the like: a known name with a plural ending
    if (/s$/.test(n) && KNOWN.has(n.slice(0, -1))) return true;
    // "nothin'", "shakin'", "flippin'": the word with its g dropped
    if (/in$/.test(n) && KNOWN.has(n + 'g')) return true;
    return false;
  }

  /** Edit distance, small strings only. */
  function levenshtein(a, b) {
    a = String(a); b = String(b);
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /** 1 = the same spelling, 0 = nothing in common. */
  function similarity(a, b) {
    const la = lettersOf(a), lb = lettersOf(b);
    const max = Math.max(la.length, lb.length);
    if (!max) return 0;
    return 1 - (levenshtein(la, lb) / max);
  }

  /* ---------------------------------------------------------------- *
   * Case: a replacement has to wear the case of what it replaced.
   * ---------------------------------------------------------------- */

  /** Title Case that leaves the apostrophe alone: god's -> God's, not God'S. */
  function smartTitle(s) {
    return String(s).toLowerCase().replace(/(^|[\s\-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }

  const isShout = (s) => /[A-Z]/.test(s) && !/[a-z]/.test(s) && lettersOf(s).length >= 2;

  /**
   * Dress `rep` in the case of `sample`.
   *
   * ALL CAPS is the app's default caption case, so the common path is simply
   * "shout it back". Otherwise the stored spelling wins — it is the spelling the
   * operator chose — except that a lower-case stored word at the start of a
   * capitalised sample keeps its capital.
   */
  function matchCase(sample, rep) {
    const s = String(sample == null ? '' : sample);
    if (isShout(s)) return String(rep).toUpperCase();
    if (/^[A-Z]/.test(s) && rep === String(rep).toLowerCase()) return String(rep).charAt(0).toUpperCase() + String(rep).slice(1);
    return String(rep);
  }

  /* ---------------------------------------------------------------- *
   * Compiling the book into something that can be looked up per word.
   * ---------------------------------------------------------------- */

  /** May this term be a sound-alike target? (See the comment on SEED_TERMS.) */
  function isSoundTerm(text) {
    const n = normPhrase(text);
    if (!n) return false;
    const letters = lettersOf(n);
    if (letters.length < SOUND_MIN_TERM_LEN) return false;
    if (n.split(' ').every((w) => isCommonWord(w))) return false;
    return soundKey(n).length >= SOUND_MIN_KEY;
  }

  /**
   * Turn the stored book into lookup tables. Cheap (a few hundred entries), and
   * done once per change rather than once per word.
   */

  /* The names of God that are two words — the list above is split on spaces.
   * Vetted the same way ("El Elyon" pulled "lowly in", and is left out). */
  const SEED_PHRASES = ['Jehovah Jireh', 'Jehovah Nissi', 'Jehovah Rapha', 'Jehovah Shalom', 'Jehovah Shammah',
    'Jehovah Tsidkenu', 'Jehovah Rohi', 'El Shaddai', 'El Roi', 'El Olam'];

  /* Built-in names that are also everyday first names. Whisper spells these
   * right every time, so as sound-alike targets they could only ever take
   * someone else's name: "André" -> "Andrew", "Petri" -> "Peter", "McHale" ->
   * "Michael". They stay in the book as spellings, just never as something to
   * sound like. (The built-in names in the top 1,000 US first names, 1990 Census.) */
  const SEED_SPELLED_RIGHT = new Set((
    'Joshua Samuel Esther Isaiah Jeremiah Daniel Jonah Micah Matthew Timothy Peter Abraham Sarah Isaac Rebekah ' +
    'Jacob Joseph Benjamin Moses Aaron Miriam Caleb Deborah Naomi David Solomon Elijah Josiah Jonathan Nathan ' +
    'Gabriel Michael Elizabeth Martha Stephen Philip Cornelius Silas Priscilla Lydia Felix Thomas Andrew Jesus ' +
    'Emmanuel Bethany Jordan'
  ).toLowerCase().split(' '));

  function compile(book) {
    const b = book || {};
    const fixes = new Map();
    // The first word of every correction. A sermon is thirty thousand words and
    // a book is a few dozen corrections, so the question asked of nearly every
    // word is "could anything start here?" — and that has to be one hash lookup,
    // not four string joins. This is what keeps spreading a correction through a
    // three-hour video instant enough to run while somebody is typing.
    const fixHeads = new Set();
    let maxN = 0;
    for (const f of (b.fixes || [])) {
      if (!f || f.on === false) continue;
      const from = normPhrase(f.from);
      const to = String(f.to == null ? '' : f.to).trim();
      if (!from || !to) continue;
      if (normPhrase(to) === from) continue;              // a fix that changes nothing
      if (fixes.has(from)) continue;                      // first one wins; the store keeps them unique anyway
      fixes.set(from, { to, id: f.id || null });
      fixHeads.add(from.split(' ')[0]);
      maxN = Math.max(maxN, Math.min(MAX_N, from.split(' ').length));
    }
    // Every spelling the operator has ASKED for is also something to sound like:
    // the right-hand side of their own corrections, plus the names they typed in,
    // plus the vocabulary the app ships with.
    const termTexts = [];
    for (const f of (b.fixes || [])) if (f && f.on !== false && f.to) termTexts.push(String(f.to));
    for (const t of (b.terms || [])) if (t && t.text) termTexts.push(String(t.text));
    const ownTerms = termTexts.length;   // everything before this the operator chose; after it, built in
    if (b.seed !== false) for (const t of SEED_TERMS.concat(SEED_PHRASES)) termTexts.push(t);

    const sound = new Map();          // key body -> [term…]
    const near = new Map();           // key body with one letter missing -> [term…]
    const seen = new Set();
    const terms = [];
    const builtIn = new Set();        // built-in names only (not also in the operator's own book)
    termTexts.forEach((raw, idx) => {
      const text = String(raw).trim();
      const n = normPhrase(text);
      if (!n || seen.has(n)) return;
      seen.add(n);
      terms.push(text);
      if (idx >= ownTerms) builtIn.add(text);
      if (idx >= ownTerms && SEED_SPELLED_RIGHT.has(n)) return;
      if (!isSoundTerm(n)) return;
      const kb = keyBody(soundKey(n));
      if (kb.length < SOUND_MIN_KEY) return;
      const arr = sound.get(kb);
      if (arr) arr.push(text); else sound.set(kb, [text]);
      const addNear = (v) => { const a2 = near.get(v); if (a2) a2.push(text); else near.set(v, [text]); };
      addNear(kb);
      for (let i = 0; i < kb.length; i++) addNear(kb.slice(0, i) + kb.slice(i + 1));
    });
    const enabled = b.enabled !== false;
    return {
      enabled,
      soundOn: enabled && b.soundAlike !== false && sound.size > 0,
      fixes, maxN, fixHeads, sound, near, terms, builtIn, termSet: seen,
      // The sound of a word is worked out once per distinct run of words, not
      // once per time it is said: a sermon says the same few thousand words over
      // and over, and this is what keeps a three-hour one in milliseconds.
      memo: new Map(),
      empty: !enabled || (fixes.size === 0 && sound.size === 0),
    };
  }

  /* ---------------------------------------------------------------- *
   * Matching one run of words.
   * ---------------------------------------------------------------- */

  /** Look the exact phrase up in the book. */
  function lookupFix(m, gram) {
    const f = m.fixes.get(gram);
    return f ? { to: f.to, why: 'book', id: f.id } : null;
  }

  /**
   * Does this run of heard words sound like a word in the book?
   *
   * `cores` are the heard words with their punctuation off. Every gate here is
   * a refusal to guess: a common English word is never touched, a short word is
   * never touched, and a match needs the SOUND to line up and the SPELLING to be
   * in the same neighbourhood.
   */
  function lookupSound(m, cores, ctx) {
    const n = cores.length;
    const joined = ctx.gram;
    const letters = ctx.letters;
    if (letters < (n === 1 ? SOUND_MIN_HEARD_LEN : SOUND_MIN_TERM_LEN)) return null;
    // A run of words that is ALREADY ordinary English is not a mishearing, it is
    // a sentence. "GRACE IS" sounds near enough to "GRACIOUS" to be matched on
    // noise alone, and rewriting it would be the worst thing this feature could
    // do — so a match needs at least one word that is not everyday English to
    // have gone wrong in the first place.
    if (!ctx.uncommon) return null;
    // Joining several heard words into one written word is the strongest claim
    // this layer makes, so it takes the most evidence: enough SOUND to be sure
    // (a three-letter noise like "the vine" is not), and a run that is mostly
    // NOT ordinary English, which is what a mangled name looks like.
    if (n > 1 && ctx.uncommon / Math.max(1, letters) < SOUND_UNCOMMON_RATIO) return null;
    let key = m.memo.get(joined);
    if (key === undefined) { key = soundKey(joined); if (m.memo.size < 60000) m.memo.set(joined, key); }
    const kb = keyBody(key);
    if (kb.length < (n === 1 ? SOUND_MIN_KEY : SOUND_MIN_KEY_MANY)) return null;
    const minSim = n === 1 ? SOUND_SIM_ONE : SOUND_SIM_MANY;
    const normJoined = joined;          // `cores` arrive normalised, so this IS the normal form
    // A BUILT-IN name only replaces what is not a word (see KNOWN WORDS): one
    // heard word that is not real English or a known name, or a run that is
    // mostly made of such words.
    const strange = ctx.strange != null ? ctx.strange
      : cores.reduce((a, w) => a + (isKnownWord(w) ? 0 : lettersOf(w).length), 0);
    const builtInMay = n === 1 ? strange > 0 : strange / Math.max(1, letters) >= SOUND_UNCOMMON_RATIO;

    let best = null;
    /* Two refusals guard every candidate:
     *  - the words already say it, so there is nothing to fix;
     *  - one of the words on its own already IS the term, which means this run
     *    is the right word plus something else, and swallowing the something
     *    else would delete a word the preacher said. ("PROVERBS I" is Proverbs
     *    followed by "I", not a mangled "Proverbs".) */
    const consider = (term, sim) => {
      const nt = normPhrase(term);
      if (nt === normJoined) { best = 'stop'; return; }
      if (n > 1 && cores.indexOf(nt) >= 0) return;
      // …nor may a run swallow a word that is ALREADY a name spelled right:
      // "Babylon in" is Babylon then "in", not "Babylonian"; "Canaan to" is not
      // "Canaanite". (A name that is part of the term is fine: "Jehovah Jire".)
      if (n > 1 && m.termSet) {
        const tw = nt.split(' ');
        for (const c of cores) if (m.termSet.has(c) && tw.indexOf(c) < 0) return;
      }
      if (best === 'stop') return;
      if (!builtInMay && m.builtIn && m.builtIn.has(term)) return;
      if (!best || sim > best.sim) best = { to: term, sim };
    };
    const exact = m.sound.get(kb);
    if (exact) {
      for (const term of exact) {
        if (best === 'stop') return null;
        const sim = similarity(joined, term);
        if (sim >= minSim) consider(term, sim);
        else if (normPhrase(term) === normJoined) return null;
      }
    }
    if (best === 'stop') return null;
    if (best) return { to: best.to, why: 'sound', sim: best.sim };
    // A long word may also match a sound that is ONE sound out (whisper dropping
    // a syllable), but then the spelling has to be nearly right as well. The
    // candidates come out of a hash: two keys one edit apart always share a
    // one-letter deletion, so a handful of lookups replaces a scan of the whole
    // vocabulary — which is the difference between this being free and this
    // being the slowest thing in the caption pipeline.
    if (n === 1 && letters >= SOUND_NEAR_LEN) {
      const seen = new Set();
      const tryBucket = (arr) => {
        for (const term of (arr || [])) {
          if (seen.has(term)) continue;
          seen.add(term);
          if (levenshtein(keyBody(soundKey(term)), kb) > 1) continue;
          const sim = similarity(joined, term);
          if (sim >= SOUND_NEAR_SIM) consider(term, sim);
        }
      };
      tryBucket(m.near.get(kb));
      for (let i = 0; i < kb.length; i++) tryBucket(m.near.get(kb.slice(0, i) + kb.slice(i + 1)));
    }
    if (best === 'stop') return null;
    return best ? { to: best.to, why: 'sound', sim: best.sim } : null;
  }

  /**
   * Walk a list of tokens, longest phrase first, and return the replacements.
   * Shared by the word-timed path and the plain-text path so the two can never
   * decide differently about the same sentence.
   *
   * Returns [{ i, n, to, why }] in order, non-overlapping.
   */
  function planReplacements(cores, m) {
    const plan = [];
    const len = cores.length;
    const maxFix = Math.min(MAX_N, m.maxN || 0);
    const maxSound = m.soundOn ? MAX_N : 0;
    const top = Math.max(maxFix, maxSound);
    if (!top) return plan;
    /* Everything that depends only on ONE word is worked out once per word here,
     * not once per word per phrase length. It is the difference between 30,000
     * and 120,000 passes over the same strings, and this runs on a list that can
     * be a three-hour sermon long. */
    const norms = cores.map(normWord);
    const letters = maxSound ? norms.map((w) => lettersOf(w).length) : null;
    const uncommon = maxSound ? norms.map((w, k) => (isCommonWord(w) ? 0 : letters[k])) : null;
    const strange = maxSound ? norms.map((w, k) => (uncommon[k] && !isKnownWord(w) ? letters[k] : 0)) : null;
    for (let i = 0; i < len; i++) {
      if (!norms[i]) continue;
      const room = Math.min(top, len - i);
      // Can anything at all start here? Two cheap questions before a single
      // string is built: does any correction begin with this word, and is there
      // a word within reach that is not ordinary English (which every mishearing
      // has, or it would not be one).
      const mayFix = maxFix > 0 && m.fixHeads.has(norms[i]);
      let maySound = false;
      if (maxSound) {
        for (let k = 0; k < room; k++) if (uncommon[i + k]) { maySound = true; break; }
      }
      if (!mayFix && !maySound) continue;
      let hit = null, hitN = 0;
      let gram = '', nLetters = 0, nUncommon = 0, nStrange = 0, broke = false;
      for (let n = 1; n <= room; n++) {
        if (!norms[i + n - 1]) { broke = true; break; }   // punctuation-only token inside the run
        gram = n === 1 ? norms[i] : gram + ' ' + norms[i + n - 1];
        if (maxSound) { nLetters += letters[i + n - 1]; nUncommon += uncommon[i + n - 1]; nStrange += strange[i + n - 1]; }
        // Longest first is decided by walking forward and keeping the last hit:
        // building the phrases in one pass beats slicing a new array per length.
        if (mayFix && n <= maxFix) {
          const f = lookupFix(m, gram);
          if (f) { hit = f; hitN = n; }
        }
        if ((!hit || hitN < n) && maySound && n <= maxSound && nUncommon
            && (n > 1 || (uncommon[i] && letters[i] >= SOUND_MIN_HEARD_LEN))) {
          let so = lookupSound(m, norms.slice(i, i + n), { gram, letters: nLetters, uncommon: nUncommon, strange: nStrange });
          /*
           * A NAME WITH ITS 's IS STILL THAT NAME. "Goliath's sword", "the
           * Goliaths in your life", "Ezekiel's wheel" sound like the name and
           * were replaced by it, the 's and the s thrown away ("Ezekiel wheel").
           * The name plus its ending is left as it was said; a misspelling with
           * one ("Ezekial's") gets the name back WITH its ending. (Found by review.)
           * The stem goes through every gate a word on its own would, and a
           * built-in name never takes it when the WHOLE word is real English:
           * "debris" is not "Deborahs", "amenities" not "Ammonites".
           */
          if (n === 1) {
            const suf = /^(.+?)(['’]s|s['’]|s)$/i.exec(norms[i]);
            if (suf) {
              const stem = suf[1];
              const tail = (/^(.+?)(['’]s|s['’]|s)$/i.exec(cores[i]) || [])[2] || suf[2];
              if (so && normPhrase(stem) === normPhrase(so.to)) so = null;          // the name itself, with its ending
              else if (/['’]/.test(suf[2])) {
                // only an apostrophe says "name + ending" for sure: a bare s is
                // as often part of the word ("Euphrates" is not "Ephratahs")
                // the name the STEM sounds like, given its ending back ("Ezekial's" -> "Ezekiel's")
                const sl = lettersOf(stem).length;
                const st = isCommonWord(stem) ? null
                  : lookupSound(m, [stem], { gram: stem, letters: sl, uncommon: sl, strange: strange[i] && !isKnownWord(stem) ? sl : 0 });
                if (st && !/s$/i.test(normPhrase(st.to))) so = Object.assign({}, st, { to: String(st.to) + tail });
                else if (st) so = null;
              }
            }
          }
          if (so) { hit = so; hitN = n; }
        }
      }
      if (broke && !hit) continue;
      if (hit) { plan.push({ i, n: hitN, to: hit.to, why: hit.why, id: hit.id || null }); i += hitN - 1; }
    }
    return plan;
  }

  /**
   * Fix a list of TIMED words (what whisper hands back, and what the caption
   * lines are re-broken from).
   *
   * When three heard words become one written word, the three timings become
   * one span; when one becomes two, the span is split by word length. Either
   * way the words still start when they were said, which is the only thing the
   * caption lane cares about.
   */
  function applyToWords(words, m, opts) {
    const src = words || [];
    if (!m || m.empty || !src.length) return { words: src, changes: [], count: 0 };
    const parts = src.map((w) => splitAffix(w.text));
    const cores = parts.map((p) => p.core);
    const plan = planReplacements(cores, m);
    if (!plan.length) return { words: src, changes: [], count: 0 };

    const out = [];
    const changes = [];
    let pi = 0;
    for (let i = 0; i < src.length; i++) {
      const p = plan[pi];
      if (!p || p.i !== i) { out.push(src[i]); continue; }
      pi++;
      const span = src.slice(i, i + p.n);
      const sample = cores.slice(i, i + p.n).join(' ');
      const rep = matchCase(sample, p.to);
      const repWords = rep.split(/\s+/).filter(Boolean);
      const start = span[0].start, end = span[span.length - 1].end;
      const total = repWords.reduce((n2, w) => n2 + w.length + 1, 0) || 1;
      let t = start;
      for (let k = 0; k < repWords.length; k++) {
        const d = ((end - start) * (repWords[k].length + 1)) / total;
        const pre = k === 0 ? parts[i].pre : '';
        const post = k === repWords.length - 1 ? parts[i + p.n - 1].post : '';
        out.push(Object.assign({}, span[Math.min(k, span.length - 1)], {
          start: k === 0 ? start : t,
          end: k === repWords.length - 1 ? end : Math.min(end, t + d),
          text: pre + repWords[k] + post,
        }));
        t += d;
      }
      changes.push({ from: sample, to: rep, why: p.why, id: p.id || null, at: start });
      i += p.n - 1;
    }
    if (opts && opts.dry) return { words: src, changes, count: changes.length };
    return { words: out, changes, count: changes.length };
  }

  /** The same walk over one line of caption text. */
  function applyToText(text, m) {
    const s = String(text == null ? '' : text);
    if (!m || m.empty || !s.trim()) return { text: s, changes: [], count: 0 };
    const toks = s.split(/(\s+)/);                        // keep the whitespace, so the line comes back looking the same
    const idx = [];
    for (let i = 0; i < toks.length; i++) if (!/^\s*$/.test(toks[i])) idx.push(i);
    const parts = idx.map((i) => splitAffix(toks[i]));
    const cores = parts.map((p) => p.core);
    const plan = planReplacements(cores, m);
    if (!plan.length) return { text: s, changes: [], count: 0 };
    const changes = [];
    // Right to left, so the indexes ahead of a replacement stay valid.
    for (let k = plan.length - 1; k >= 0; k--) {
      const p = plan[k];
      const sample = cores.slice(p.i, p.i + p.n).join(' ');
      const rep = matchCase(sample, p.to);
      const first = idx[p.i], last = idx[p.i + p.n - 1];
      toks.splice(first, last - first + 1, parts[p.i].pre + rep + parts[p.i + p.n - 1].post);
      changes.unshift({ from: sample, to: rep, why: p.why, id: p.id || null });
    }
    return { text: toks.join(''), changes, count: changes.length };
  }

  /**
   * Fix a list of caption lines as ONE stream of words that happens to be cut
   * into lines.
   *
   * This is not the same job as fixing each line on its own, and the difference
   * is the whole feature on a real shorts caption: the operator's Words/line is
   * often 1, so "A FEE SHINS" is not a line — it is three lines. Fixing lines
   * one at a time would never see the phrase at all.
   *
   * When a phrase that spans a break is replaced, the replacement goes on the
   * line the phrase STARTED on, and the lines it ate are dropped with their time
   * folded into it — so the words still appear when they were said, and no line
   * is left blank on the screen.
   */
  function applyAcrossLines(lines, m) {
    const src = lines || [];
    if (!m || m.empty || !src.length) return { lines: src, changes: [], count: 0, linesChanged: 0, dropped: 0 };
    const toks = [];
    src.forEach((l, li) => {
      String(l.text == null ? '' : l.text).split(/\s+/).filter(Boolean).forEach((t) => {
        const a2 = splitAffix(t);
        toks.push({ li, pre: a2.pre, core: a2.core, post: a2.post });
      });
    });
    const cores = toks.map((t) => t.core);
    const plan = planReplacements(cores, m);
    if (!plan.length) return { lines: src, changes: [], count: 0, linesChanged: 0, dropped: 0 };

    const parts = src.map(() => []);
    const touched = new Set();
    const changes = [];
    let pi = 0;
    for (let i = 0; i < toks.length; i++) {
      const p = plan[pi];
      if (!p || p.i !== i) { parts[toks[i].li].push(toks[i].pre + toks[i].core + toks[i].post); continue; }
      pi++;
      const span = toks.slice(i, i + p.n);
      const sample = cores.slice(i, i + p.n).join(' ');
      const rep = matchCase(sample, p.to);
      parts[span[0].li].push(span[0].pre + rep + span[span.length - 1].post);
      for (const t of span) touched.add(t.li);
      changes.push({ from: sample, to: rep, why: p.why, id: p.id || null });
      i += p.n - 1;
    }

    const out = [];
    let linesChanged = 0, dropped = 0;
    src.forEach((l, li) => {
      if (!touched.has(li)) { out.push(l); return; }
      const text = parts[li].join(' ');
      if (!text) {
        // Every word on this line went into an earlier one. Give that line the
        // time this one held, so the corrected words stay on screen as long as
        // the spoken ones did.
        dropped++;
        const prev = out[out.length - 1];
        if (prev) out[out.length - 1] = Object.assign({}, prev, { end: Math.max(prev.end, l.end) });
        return;
      }
      linesChanged++;
      out.push(Object.assign({}, l, { text }));
    });
    return { lines: out, changes, count: changes.length, linesChanged, dropped };
  }

  /** Fix a whole list of caption lines ({start,end,text}), each on its own. */
  function applyToLines(lines, m) {
    const src = lines || [];
    if (!m || m.empty || !src.length) return { lines: src, changes: [], count: 0, linesChanged: 0 };
    const changes = [];
    let linesChanged = 0;
    const out = src.map((l) => {
      const r = applyToText(l.text, m);
      if (!r.count) return l;
      linesChanged++;
      for (const c of r.changes) changes.push(c);
      return Object.assign({}, l, { text: r.text });
    });
    return { lines: out, changes, count: changes.length, linesChanged };
  }

  /* ---------------------------------------------------------------- *
   * Learning: what actually changed when a line was retyped.
   * ---------------------------------------------------------------- */

  /** Longest-common-subsequence blocks: the runs that differ, aligned. */
  function diffBlocks(a, b) {
    const n = a.length, m = b.length;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const blocks = [];
    let i = 0, j = 0, cur = null;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        if (cur) { blocks.push({ ai: cur.ai, aj: i, bi: cur.bi, bj: j }); cur = null; }
        i++; j++;
      } else {
        if (!cur) cur = { ai: i, bi: j };
        if (j >= m) i++;
        else if (i >= n) j++;
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
        else j++;
      }
    }
    if (cur) blocks.push({ ai: cur.ai, aj: i, bi: cur.bi, bj: j });
    return blocks;
  }

  /**
   * What did this edit teach?
   *
   * before/after are one caption line as it was and as it now reads. The answer
   * is a list of {from, to} — the runs of words that were swapped, with the
   * spelling stored the way it should be WRITTEN rather than the way it was
   * typed into an ALL-CAPS line.
   *
   * Insertions and deletions teach nothing (a word added is not a word misheard)
   * and are skipped, as is anything longer than four words either side, which is
   * a rewrite rather than a correction.
   */
  /*
   * WHAT AN EDIT MAY TEACH FOR EVER: A MISHEARING, NOT A REWRITE.
   *
   * Measured on a real church's book: 113 corrections learned from retyped
   * lines, and almost all of them were two different sentences paired up word
   * by word — "it is" → "meetings" (applied 113 times), "in the" → "on the"
   * (330 times), "we are" → "we have been" (195), "to the" → "to take charge"
   * (174), "to God" → "to Galway", "Satan" → "shout". Every one of them true
   * of the line it came from and wrong in every sermon after it.
   *
   * What a speech recogniser actually gets wrong, again and again, is a word
   * it could not know — a name, a place — written as something that is NOT a
   * word ("waliwke", "cardiffa"), or split into ordinary words that SOUND like
   * it ("a fee shins" → Ephesians). So a learned correction is kept only when
   * it is one of those two, and the two sides sound alike. Swapping one real word for another
   * depends on the sentence, and is left to the sentence it was typed in.
   * (A correction typed into the panel by hand is the operator's call, as ever.)
   */
  const SEED_SET = new Set(SEED_TERMS.map((t) => normPhrase(t)));
  const LEARN_ALIKE = 0.55;
  const NAME_ALIKE = 0.7;      // a name for the same number of real words must sound closer still
  function learnable(from, to) {
    const f = normPhrase(from), t = normPhrase(to);
    if (!f || !t) return false;
    const fw = f.split(' '), tw = t.split(' ');
    const letters = (s) => s.replace(/[^a-z]/g, '');
    const alike = Math.max(similarity(letters(f), letters(t)), similarity(soundKey(f), soundKey(t)));
    // what was heard is not a word at all ("waliwke", "cardiffa")…
    if (fw.some((w) => !isKnownWord(w))) return alike >= LEARN_ALIKE;
    // …or a name heard as ordinary words, more of them than the name has ("a fee shins" → Ephesians)
    if (fw.length > tw.length && tw.some((w) => !isCommonWord(w))) return alike >= LEARN_ALIKE;
    /*
     * …or a NAME heard as as many real words ("Pastor okay" → Pastor Oke,
     * "bakery" → Bakare): the correction writes a capitalised word that was not
     * there, and it sounds very like what was heard. "to God" → "to Galway"
     * and "Galilee" → "Galway" do not sound alike enough, and "is this" → "is
     * bishop" writes no name.
     */
    const heard = new Set(fw);
    // what was heard may not itself be a Bible name: "of Galilee" → "of Galway" swaps one place for another
    if (fw.some((w) => !tw.includes(w) && SEED_SET.has(w))) return false;
    const raw = String(to == null ? '' : to).split(/\s+/).filter(Boolean);
    // (a short name counts: "Oke", "Ade", "Obi" — every word of three letters is "common" to isCommonWord)
    const name = raw.some((w) => /^[A-Z]/.test(w) && !heard.has(normWord(w)) && normWord(w).length >= 3
      && (normWord(w).length <= 3 || !isCommonWord(w)));
    // …and never a real word on its own: "okay" → Oke would rename every "okay" in every sermon
    return name && fw.length >= 2 && alike >= NAME_ALIKE;              // otherwise real words for real words: the sentence decides
  }
  /* "chorine thians thirteen" → "Corinthians 13": the name is the lesson, the verse number is not */
  const NUMBERISH = /^(\d+[a-z]*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third)$/;
  function withoutNumbers(from, to) {
    const fw = from.split(' '), tw = to.split(' ');
    while (fw.length > 1 && NUMBERISH.test(normWord(fw[fw.length - 1]))) fw.pop();
    while (tw.length > 1 && NUMBERISH.test(normWord(tw[tw.length - 1]))) tw.pop();
    return { from: fw.join(' '), to: tw.join(' ') };
  }

  function learnFromEdit(before, after, ctx) {
    const A = String(before == null ? '' : before).split(/\s+/).filter(Boolean);
    const B = String(after == null ? '' : after).split(/\s+/).filter(Boolean);
    const na = A.map(normWord), nb = B.map(normWord);
    if (!na.length || !nb.length) return [];
    const shouted = isShout(String(after));
    // The words on either side of this LINE, when the studio can supply them.
    const prev = String((ctx && ctx.prev) || '').split(/\s+/).filter(Boolean);
    const next = String((ctx && ctx.next) || '').split(/\s+/).filter(Boolean);
    const out = [];
    for (const blk of diffBlocks(na, nb)) {
      const fromWords = na.slice(blk.ai, blk.aj).filter(Boolean);
      const toWordsRaw = B.slice(blk.bi, blk.bj).map((w) => splitAffix(w).core).filter(Boolean);
      if (!fromWords.length || !toWordsRaw.length) continue;              // pure add / pure delete
      if (fromWords.length > MAX_N || toWordsRaw.length > MAX_N) continue; // a rewrite, not a fix
      let from = fromWords.join(' ');
      let to = toWordsRaw.map((w) => canonicalCase(w, shouted)).join(' ');
      if (!from || !to) continue;
      if (normPhrase(to) === from) continue;                              // only the case or a comma changed

      /*
       * ONE EVERYDAY WORD SWAPPED FOR ANOTHER IS NOT A VOCABULARY FACT.
       *
       * "he's" → "it's" is true of the sentence it was typed in and false of the
       * next one; stored as a bare word it fights every later sermon, and it
       * fights ITSELF — a real book from a real church had `he's → it's` and
       * `it's → he's` both switched on, cancelling each other out, among 142
       * entries learned the same way. No amount of repetition makes a homophone
       * context-free, so counting sightings was the wrong gate entirely.
       *
       * What makes it safe is the words either side. "he's not" → "it's not" is
       * a specific enough claim to be worth keeping and cannot capsize an
       * ordinary sentence. So a single-common-word change is WIDENED with the
       * unchanged words around it, taken from the line — or, when the line is
       * one word long (Words/line 1, which is what a shorts caption usually
       * is), from the caption lines either side of it.
       *
       * If no context exists anywhere, nothing is stored: the edit stands on the
       * line it was made on, which is all it was ever evidence for.
       */
      // (a real word, everyday or not: "okay" → Oke is true after "Pastor", never on its own)
      const bare = fromWords.length === 1 && isKnownWord(from);
      if (bare) {
        const left = blk.ai > 0 ? na[blk.ai - 1] : (prev.length ? normWord(prev[prev.length - 1]) : '');
        const right = blk.aj < na.length ? na[blk.aj] : (next.length ? normWord(next[0]) : '');
        if (!left && !right) continue;                 // nothing anchors it — do not remember it
        const lTo = blk.bi > 0 ? splitAffix(B[blk.bi - 1]).core : (prev.length ? prev[prev.length - 1] : '');
        const rTo = blk.bj < B.length ? splitAffix(B[blk.bj]).core : (next.length ? next[0] : '');
        from = [left, from, right].filter(Boolean).join(' ');
        to = [left ? canonicalCase(lTo, shouted) : '', to, right ? canonicalCase(rTo, shouted) : '']
          .filter(Boolean).join(' ');
        if (normPhrase(to) === normPhrase(from)) continue;
        if (from.split(' ').length > MAX_N) continue;
      }
      if (!learnable(from, to)) {
        const n = withoutNumbers(from, to);
        if (n.from === from || !learnable(n.from, n.to)) continue;   // a rewrite of the sentence, not a mishearing
        from = n.from; to = n.to;
      }
      out.push({
        from,
        to,
        // A widened phrase is specific, so it is trusted like any other phrase.
        // Nothing reaches here as a bare everyday word any more.
        risky: false,
        widened: bare,
      });
    }
    return out;
  }

  /**
   * How to STORE a word the operator typed into an all-caps line.
   *
   * They typed EPHESIANS because every line in the window is shouted, not
   * because the word is shouted — so an unusual word is stored Title Case (it is
   * almost always a name), an ordinary English word is stored lower case, and
   * anything typed in mixed case is stored exactly as typed, because then they
   * really did choose. The caption itself is shouted again on the way out by
   * matchCase(), so the burned line is unaffected either way; this only decides
   * what the Word Book panel shows and what a Normal-case caption gets.
   */
  function canonicalCase(word, shouted) {
    const w = String(word);
    if (!shouted || !isShout(w)) return w;
    const low = w.toLowerCase();
    // a short word that is not everyday English is a name ("OKE", "ADE", "OBI"), not "oke"
    const n = normWord(low);
    if (n.length <= 3 && /^[a-z]+$/.test(n) && !COMMON_WORDS.has(n)) return smartTitle(low);
    return isCommonWord(low) ? low : smartTitle(low);
  }

  /* ---------------------------------------------------------------- *
   * A one-off matcher for "fix this everywhere, now" — the exact
   * corrections just made, and nothing else. No sound-alike guessing:
   * these are the operator's own words, applied literally.
   * ---------------------------------------------------------------- */
  function matcherFor(pairs) {
    return compile({
      enabled: true,
      soundAlike: false,
      seed: false,
      fixes: (pairs || []).map((p) => ({ from: p.from, to: p.to, on: true })),
      terms: [],
    });
  }

  return {
    VERSION, MAX_N, learnable, hasKnownList: !!KNOWN,
    COMMON_WORDS, SEED_TERMS,
    SOUND_MIN_TERM_LEN, SOUND_MIN_HEARD_LEN, SOUND_SIM_ONE, SOUND_SIM_MANY, SOUND_NEAR_LEN, SOUND_NEAR_SIM,
    SOUND_MIN_KEY, SOUND_MIN_KEY_MANY, SOUND_UNCOMMON_RATIO,
    normWord, normPhrase, splitAffix, lettersOf, soundKey, keyBody, isCommonWord, isKnownWord, isSoundTerm,
    levenshtein, similarity, smartTitle, isShout, matchCase, canonicalCase,
    compile, matcherFor, planReplacements,
    applyToWords, applyToText, applyToLines, applyAcrossLines,
    diffBlocks, learnFromEdit,
  };
}));
