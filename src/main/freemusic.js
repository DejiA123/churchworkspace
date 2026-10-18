'use strict';
/*
 * ►► FREE MUSIC THAT IS SAFE TO POST. ◄◄
 *
 * A post with a popular song baked into it is the post Instagram and TikTok
 * mute, flag or take down — and no app is allowed to attach their in-app
 * library songs to a post it publishes (their posting APIs do not offer it).
 * So the studio carries its own shelf of music that is FREE TO USE: Mixkit's
 * catalogue (mixkit.co) — lo-fi, upbeat, worship, hype — free for social
 * video under the Mixkit licence, no credit needed and no Content ID claims.
 * (Before, the shelf was Kevin MacLeod's incompetech catalogue, CC BY 4.0; a
 * post that already has one of those still carries its credit — RETIRED.)
 *
 * Nothing is bundled: a track is fetched from Mixkit the first time it is
 * chosen and then lives in the music library like any song (source "free:…"),
 * so it is on the music lane, previews on the phone and mixes into exports.
 * Which tracks the server can actually reach is checked once and remembered,
 * so a title that has gone is hidden rather than failing when tapped.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

// a browser's name: some music hosts turn away requests that do not give one
const UA = 'Mozilla/5.0 (compatible; ChurchWorkSpace/1.0)';
// (MW_FREE_MUSIC_BASE: a stand-in for Mixkit, in the tests)
const BASE = process.env.MW_FREE_MUSIC_BASE || 'https://assets.mixkit.co/music/';
const lib = (url) => (/^http:/i.test(url) ? require('http') : https);
const MOODS = [
  ['lofi', '🎧 Lo-fi & chill'],
  ['sermon', '🎹 Sermon · piano & pad'],
  ['upbeat', '☀️ Upbeat & happy'],
  ['uplift', '🙏 Worship & uplifting'],
  ['hype', '🔥 Hype & energy'],
  ['epic', '🎬 Epic & cinematic'],
  ['calm', '🕊 Calm & reflective'],
];
/* [Mixkit id, title, artist, mood] — every one checked to download and play */
const TRACKS = [
  [763, 'Lo-Fi 01', 'Lily J', 'lofi'], [764, 'Lo-Fi 02', 'Lily J', 'lofi'], [766, 'Lo-Fi 04', 'Lily J', 'lofi'],
  [135, 'Sleepy Cat', 'Alejandro Magaña', 'lofi'], [282, 'Sweet September', 'Arulo', 'lofi'], [443, 'Serene View', 'Arulo', 'lofi'],
  [175, 'Digital Clouds', 'Alejandro Magaña', 'lofi'], [234, 'Thinking About You', 'Arulo', 'lofi'], [97, 'Dim The Lights', 'Ahjay Stelino', 'lofi'],
  [988, 'Day Dreamin’ with U', 'Michael Ramir C.', 'lofi'], [331, 'The Hamptons', 'Arulo', 'lofi'], [738, 'Hip Hop 02', 'Lily J', 'lofi'],
  [970, 'Night Sky Hip Hop', 'Michael Ramir C.', 'lofi'], [640, 'Smooth Jazz', 'Francisco Alvear', 'lofi'], [645, 'Dreamy Jazz', 'Francisco Alvear', 'lofi'],
  [685, 'R&B Vibes', 'Grigoriy Nuzhny', 'lofi'], [750, 'Relaxation 04', 'Lily J', 'lofi'], [427, 'New York', 'Arulo', 'lofi'],
  // under a sermon or a prayer: ambient piano over a soft pad, most with a gentle beat
  [22, 'Piano Reflections', 'Ahjay Stelino', 'sermon'], [184, 'Vastness', 'Andrew Ev', 'sermon'], [593, 'Opalescent', 'Eugenio Mininni', 'sermon'],
  [758, 'Romantic 04', 'Lily J', 'sermon'], [726, 'Uplifting Bass', 'Lily J', 'sermon'], [419, 'Pilates and Yoga', 'Arulo', 'sermon'],
  [148, 'Forest Mist Whispers', 'Alejandro Magaña', 'sermon'], [440, 'Infinity', 'Arulo', 'sermon'], [525, 'Spiritual Moment', 'Diego Nava', 'sermon'],
  [749, 'Relaxation 05', 'Lily J', 'sermon'], [760, 'Relaxation 07', 'Lily J', 'sermon'], [586, 'Charlotte', 'Eugenio Mininni', 'sermon'],
  [551, 'Home', 'Eugenio Mininni', 'sermon'], [156, 'Fhloston Paradise Arrival', 'Alejandro Magaña', 'sermon'], [955, 'I Believe 2', 'Michael Ramir C.', 'sermon'],
  [598, 'We Will Get It', 'Eugenio Mininni', 'sermon'], [584, 'Rest Now', 'Eugenio Mininni', 'sermon'],
  [644, 'Upbeat Jazz', 'Francisco Alvear', 'upbeat'], [5, 'Feeling Happy', 'Ahjay Stelino', 'upbeat'], [801, 'Happy Home', 'Michael Ramir C.', 'upbeat'],
  [1076, 'Smile', 'Michael Ramir C.', 'upbeat'], [3, 'Dance with Me', 'Ahjay Stelino', 'upbeat'], [91, 'Summer’s Here', 'Ahjay Stelino', 'upbeat'],
  [288, 'One More Dance', 'Arulo', 'upbeat'], [250, 'Island Beat', 'Arulo', 'upbeat'], [1012, 'Take this Higher', 'Michael Ramir C.', 'upbeat'],
  [1048, 'Turn This Up a Little Louder!', 'Michael Ramir C.', 'upbeat'], [158, 'Happy Times', 'Alejandro Magaña', 'upbeat'], [1147, 'Midnight Funk', 'Michael Ramir C.', 'upbeat'],
  [8, 'Jumping Around', 'Ahjay Stelino', 'upbeat'], [94, 'Traveling Along', 'Ahjay Stelino', 'upbeat'], [1077, 'Sounds Good', 'Michael Ramir C.', 'upbeat'],
  [695, 'Pop 05', 'Grigoriy Nuzhny', 'upbeat'],
  [262, 'Praise the Lord', 'Arulo', 'uplift'], [200, 'Oh Lord', 'Arulo', 'uplift'], [432, 'Angel Watching Me', 'Arulo', 'uplift'],
  [293, 'Lord Knows', 'Arulo', 'uplift'], [1030, 'I Believe in Us', 'Michael Ramir C.', 'uplift'], [1154, 'Reaching Out', 'Michael Ramir C.', 'uplift'],
  [31, 'Dreaming Big', 'Ahjay Stelino', 'uplift'], [839, 'Tears of Joy', 'Michael Ramir C.', 'uplift'], [963, 'Just Keep Walking', 'Michael Ramir C.', 'uplift'],
  [1177, 'I Still Believe', 'Michael Ramir C.', 'uplift'], [487, 'Peace', 'Diego Nava', 'uplift'],
  [51, 'Sports Highlights', 'Ahjay Stelino', 'hype'], [126, 'Trap Electro Vibes', 'Alejandro Magaña', 'hype'], [80, 'Daredevil', 'Ahjay Stelino', 'hype'],
  [349, 'Basketball Training', 'Arulo', 'hype'], [369, 'Need for Speed', 'Arulo', 'hype'], [1068, 'K.O.', 'Michael Ramir C.', 'hype'],
  [32, 'Driving Ambition', 'Ahjay Stelino', 'hype'], [519, 'Motivation Gets in the Way', 'Diego Nava', 'hype'], [1116, 'Pick it Up', 'Michael Ramir C.', 'hype'],
  [676, 'Epical Drums 01', 'Grigoriy Nuzhny', 'epic'], [677, 'Epical Drums 02', 'Grigoriy Nuzhny', 'epic'], [680, 'Epical Drums 05', 'Grigoriy Nuzhny', 'epic'],
  [188, 'Echoes', 'Andrew Ev', 'epic'], [846, 'I Won’t Surrender', 'Michael Ramir C.', 'epic'],
  [79, 'The Journey', 'Ahjay Stelino', 'epic'], [543, 'A New Life', 'Eugenio Mininni', 'epic'], [606, 'Drawing the Sky', 'Eugenio Mininni', 'epic'],
  [109, 'Deep Meditation', 'Alejandro Magaña', 'calm'], [27, 'Serene Moments', 'Ahjay Stelino', 'calm'], [439, 'Tides Turning', 'Arulo', 'calm'],
  [150, 'A Blue Day', 'Alejandro Magaña', 'calm'], [1023, 'Crying Sea', 'Michael Ramir C.', 'calm'], [187, 'Mountains', 'Andrew Ev', 'calm'],
  [594, 'River Flow', 'Eugenio Mininni', 'calm'],
].map(([n, title, artist, mood]) => ({ id: 'mk' + n, title, artist, mood, url: BASE + n + '/' + n + '.mp3' }));

// Mixkit's licence asks for no credit — the caption stays the church's own
const credit = () => '';

/* which tracks answer — checked once (in the background) and kept for half a day */
let probe = { at: 0, ok: new Map(), running: null };
function head(url, redirects = 0) {
  return new Promise((resolve) => {
    const req = lib(url).request(url, { method: 'HEAD', timeout: 8000, headers: { 'User-Agent': UA } }, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) return resolve(head(new URL(res.headers.location, url).href, redirects + 1));
      // gone = the site says so (404/410); anything else (a block, a hiccup) is "don't know", and the song stays on the shelf
      if (res.statusCode === 200) resolve(true);
      else if (res.statusCode === 404 || res.statusCode === 410) resolve(false);
      else resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}
function check() {
  if (probe.running) return probe.running;
  if (Date.now() - probe.at < 12 * 3600 * 1000 && probe.ok.size) return Promise.resolve();
  probe.running = (async () => {
    const ok = new Map();
    await Promise.all(TRACKS.map(async (t) => ok.set(t.id, await head(t.url))));
    // nothing answered at all = the server is offline, not every song gone: try again next time
    if ([...ok.values()].some((v) => v !== null)) { probe.ok = ok; probe.at = Date.now(); }
  })().finally(() => { probe.running = null; });
  return probe.running;
}

/** The shelf, by mood: each track with whether it can be had and whether it is already in the library. */
async function list(library, { wait = false } = {}) {
  const p = check();
  if (wait) await p;
  const have = new Map(((library && library.list().music) || []).filter((m) => /^free:/.test(m.source || '')).map((m) => [m.source.slice(5), m]));
  return {
    moods: MOODS.map(([id, name]) => ({ id, name })),
    tracks: TRACKS.filter((t) => probe.ok.get(t.id) !== false).map((t) => ({
      id: t.id, title: t.title, artist: t.artist, mood: t.mood, credit: credit(t),
      url: t.url,   // the file at Mixkit (the phone previews it through the server)
      inLibrary: have.has(t.id) ? have.get(t.id).id : null,
    })),
    checked: !!probe.at,
  };
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects.'));
    lib(url).get(url, { headers: { 'User-Agent': UA }, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => out.close(() => resolve(dest)));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timed out')); });
  });
}

/**
 * A track into the music library (once) — the library entry, with its credit.
 */
async function get(ctx, video, library, id) {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) throw new Error('That song is not on the free music shelf.');
  const have = ((library.list().music) || []).find((m) => m.source === 'free:' + t.id && m.file && fs.existsSync(m.file));
  if (have) return Object.assign({}, have, { credit: credit(t) });
  const tmp = path.join(os.tmpdir(), `mw-free-${t.id}-${Date.now()}.mp3`);
  try {
    await download(t.url, tmp);
    if (!(fs.statSync(tmp).size > 20000)) throw new Error('the file came back empty');
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (er) {}
    probe.ok.set(t.id, false);
    throw new Error(`“${t.title}” could not be fetched right now (${e.message}). Try another song.`);
  }
  const entry = await library.add(ctx, video, { kind: 'music', path: tmp, name: t.title + ' by ' + t.artist, source: 'free:' + t.id, move: true });
  return Object.assign({}, entry, { credit: credit(t) });
}

/** The credit a post needs for a library song (null for the operator's own). */
// songs taken off the shelf: not offered any more, but a post that already has one still credits it
const RETIRED = ['Cipher', 'Inspired', 'Wholesome', 'Heartwarming', 'Ascending the Vale', 'Easy Lemon', 'Cheery Monday',
  'Heroic Age', 'Five Armies', 'Epic Unease', 'Volatile Reaction', 'Crusade - Heavy Industry', 'Movement Proposition',
  'Dreamer', 'Healing', 'Clean Soul', 'Gymnopedie No 1', 'Meditation Impromptu 01', 'Dream Culture', 'Daily Beetle', 'Amazing Plan',
  'Achaidh Cheide', 'Bright Wish', 'Impact Prelude', 'Impact Moderato', 'Rite of Passage', 'Prelude and Action', 'Killers',
  'Curse of the Scarab', 'Monkeys Spinning Monkeys', 'Fluffing a Duck', 'Sneaky Snitch', 'Hep Cats', 'Werq', 'Local Forecast - Elevator',
  'Pixel Peeker Polka - faster', 'Run Amok', 'Carefree', 'Ethereal Relaxation', 'Peaceful Desolation', 'Meditation Impromptu 02',
  'Meditation Impromptu 03', 'Lightless Dawn', 'Relaxing Piano Music', 'Frost Waltz', 'At Rest',
].map((title) => ({ id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), title }));
const macLeod = (t) => `Music: “${t.title}” by Kevin MacLeod (incompetech.com) — licensed under Creative Commons: By Attribution 4.0`;
function creditFor(entry) {
  const id = entry && /^free:/.test(entry.source || '') ? entry.source.slice(5) : null;
  if (!id) return null;
  if (TRACKS.some((x) => x.id === id)) return credit() || null;
  const old = RETIRED.find((x) => x.id === id);
  return old ? macLeod(old) : null;
}

module.exports = { list, get, creditFor, check, TRACKS, MOODS, _probe: () => probe };
