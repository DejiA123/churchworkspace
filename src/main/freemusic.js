'use strict';
/*
 * ►► FREE MUSIC THAT IS SAFE TO POST. ◄◄
 *
 * A post with a popular song baked into it is the post Instagram and TikTok
 * mute, flag or take down — and no app is allowed to attach their in-app
 * library songs to a post it publishes (their posting APIs do not offer it).
 * So the studio carries its own shelf of music that is FREE TO USE: Kevin
 * MacLeod's catalogue (incompetech.com), licensed Creative Commons BY 4.0 —
 * used by millions of creators, fine on every platform as long as the post
 * says whose it is. Every use here adds that credit to the post's caption.
 *
 * Nothing is bundled: a track is fetched from incompetech the first time it is
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
const UA = 'Mozilla/5.0 (compatible; ChurchWorkSpace/1.0; +https://incompetech.com)';
const BASE = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/';
const MOODS = [
  ['uplift', '🙏 Worship & uplifting'],
  ['epic', '🎬 Epic & cinematic'],
  ['hype', '🔥 Hype & upbeat'],
  ['calm', '🕊 Calm & reflective'],
];
/* [title, mood] — the title is the file's name at incompetech */
const TRACKS = [
  ['Inspired', 'uplift'], ['Wholesome', 'uplift'], ['Heartwarming', 'uplift'], ['Ascending the Vale', 'uplift'],
  ['Easy Lemon', 'uplift'], ['Cheery Monday', 'uplift'],
  ['Heroic Age', 'epic'], ['Five Armies', 'epic'], ['Epic Unease', 'epic'], ['Volatile Reaction', 'epic'], ['Crusade - Heavy Industry', 'epic'],
  ['Movement Proposition', 'hype'],   // (Cipher taken off the shelf at the church's request) ['Funkorama', 'hype'], ['Life of Riley', 'hype'], ['Wallpaper', 'hype'],
  ['Dreamer', 'calm'], ['Healing', 'calm'], ['Clean Soul', 'calm'], ['Gymnopedie No 1', 'calm'], ['Meditation Impromptu 01', 'calm'],
  // more to choose from, so "✨ Pick for me" is not the same few songs every time
  // (a title incompetech no longer has is hidden by the check below, never shown)
  ['Dream Culture', 'uplift'], ['Daily Beetle', 'uplift'], ['Amazing Plan', 'uplift'], ['Achaidh Cheide', 'uplift'], ['Bright Wish', 'uplift'],
  ['Impact Prelude', 'epic'], ['Impact Moderato', 'epic'], ['Rite of Passage', 'epic'], ['Prelude and Action', 'epic'], ['Killers', 'epic'], ['Curse of the Scarab', 'epic'],
  ['Monkeys Spinning Monkeys', 'hype'], ['Fluffing a Duck', 'hype'], ['Sneaky Snitch', 'hype'], ['Hep Cats', 'hype'], ['Werq', 'hype'],
  ['Local Forecast - Elevator', 'hype'], ['Pixel Peeker Polka - faster', 'hype'], ['Run Amok', 'hype'], ['Carefree', 'hype'],
  ['Ethereal Relaxation', 'calm'], ['Peaceful Desolation', 'calm'], ['Meditation Impromptu 02', 'calm'], ['Meditation Impromptu 03', 'calm'],
  ['Lightless Dawn', 'calm'], ['Relaxing Piano Music', 'calm'], ['Frost Waltz', 'calm'], ['At Rest', 'calm'],
].map(([title, mood]) => ({ id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), title, mood, url: BASE + encodeURIComponent(title) + '.mp3' }));

const credit = (t) => `Music: “${t.title}” by Kevin MacLeod (incompetech.com) — licensed under Creative Commons: By Attribution 4.0`;

/* which tracks answer — checked once (in the background) and kept for half a day */
let probe = { at: 0, ok: new Map(), running: null };
function head(url, redirects = 0) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: 8000, headers: { 'User-Agent': UA } }, (res) => {
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
      id: t.id, title: t.title, mood: t.mood, credit: credit(t),
      url: t.url,   // for a ▶ preview on the phone, straight from incompetech
      inLibrary: have.has(t.id) ? have.get(t.id).id : null,
    })),
    checked: !!probe.at,
  };
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects.'));
    https.get(url, { headers: { 'User-Agent': UA }, timeout: 60000 }, (res) => {
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
  const entry = await library.add(ctx, video, { kind: 'music', path: tmp, name: t.title + ' · Kevin MacLeod', source: 'free:' + t.id, move: true });
  return Object.assign({}, entry, { credit: credit(t) });
}

/** The credit a post needs for a library song (null for the operator's own). */
// songs taken off the shelf: not offered any more, but a post that already has one still credits it
const RETIRED = [{ id: 'cipher', title: 'Cipher' }];
function creditFor(entry) {
  const id = entry && /^free:/.test(entry.source || '') ? entry.source.slice(5) : null;
  const t = id && (TRACKS.find((x) => x.id === id) || RETIRED.find((x) => x.id === id));
  return t ? credit(t) : null;
}

module.exports = { list, get, creditFor, check, TRACKS, MOODS, _probe: () => probe };
