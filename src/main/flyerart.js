'use strict';
/*
 * THE FLYER MAKER'S PAINTER AND ITS ART DIRECTOR — the server half of
 * Home → Flyers (src/cloud/web/cloud-flyer.js draws the flyer itself).
 *
 * A church flyer off Pinterest is three things on top of each other: a
 * dramatic picture (light rays, a mountain at dawn, fire, a crowd with hands
 * up), the people (the pastor, cut out, big), and HUGE words. An image model
 * is superb at the first and hopeless at the last: ask one for "Sunday 19th
 * October, 9AM, 12 Airport Road" and the road comes back misspelt. So the AI
 * paints ONLY the picture, the phone cuts the people out on its own, and the
 * words are set by the flyer's own typesetting — every letter exactly as typed.
 *
 * WHO PAINTS — free, best first:
 *
 *   1. Cloudflare Workers AI — FLUX.2 [klein] (Black Forest Labs' 2026 model),
 *      then FLUX.1 [schnell]. A free Cloudflare account has 10,000 "neurons" a
 *      day with no card: about 70 flyer pictures a day, every day. Needs
 *      CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI: Read).
 *   2. Pollinations — FLUX with no account at all (slower, and it takes turns
 *      with the world). POLLINATIONS_API_KEY, a free key, lifts its limits.
 *   3. Nothing reachable: the flyer still comes out — the phone paints its own
 *      backgrounds (gradients, rays, bokeh) and says how to switch the AI on.
 *
 * WHO WRITES — the art director turns "Sunday Service, 19 Oct" into a picture
 * to paint, the colours to wear and the one word to set in script. Claude when
 * the server has ANTHROPIC_API_KEY (the AI Montage's key), else the free Groq
 * key the captions use, else a few honest rules. It never writes the names,
 * dates or places: those are the operator's, set exactly as typed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const budget = require('./aibudget');   // the day's free allowance, shared fairly (reservations, pacing, a share each, a queue)
const bank = require('./flyerbank');    // the church's picture library: painted once, kept for everyone
const space = require('./space');       // who is asking (their fair share; the pictures they have already seen)

const env = (...names) => { for (const n of names) { const v = String(process.env[n] || '').trim(); if (v) return v; } return ''; };
const cfAccount = () => env('CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID');
const cfToken = () => env('CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_AI_TOKEN');
const polKey = () => env('POLLINATIONS_API_KEY', 'POLLINATIONS_TOKEN');

/* Cloudflare's models, best first. `form`: the FLUX.2 family takes multipart form fields, even for a prompt alone. */
/*
 * WHAT A PICTURE COSTS OF THE FREE 10,000 NEURONS A DAY (Cloudflare's price
 * list, a 1088x1360 flyer picture): FLUX.2 klein about 150, FLUX.1 schnell
 * about 460, Lucid Origin about 3,900, FLUX.2 [dev] about 5,000. The big two
 * spend the whole day in two pictures (that is what happened), so on the free
 * plan the studio paints with klein — which also takes the preacher's photo as
 * a reference — and schnell as its spare. With a paid Workers plan
 * (CLOUDFLARE_PAID=1 on the server) the big ones go first.
 */
const CF_CHEAP = [
  { id: '@cf/black-forest-labs/flux-2-klein-4b', name: 'FLUX.2 klein', form: true, refs: true },
  { id: '@cf/black-forest-labs/flux-1-schnell', name: 'FLUX.1', form: false },
];
const CF_BIG = [
  { id: '@cf/black-forest-labs/flux-2-dev', name: 'FLUX.2 [dev]', form: true, refs: true },
  { id: '@cf/leonardo/lucid-origin', name: 'Lucid Origin', form: false, json: (prompt, size, seed) => ({ prompt: prompt.slice(0, 2000), width: size.w, height: size.h, seed, guidance: 4.5, num_steps: 30 }) },
];
/*
 * ►► THE BEST OF THE FREE ALLOWANCE, WHERE IT SHOWS. ◄◄ FLUX.2 klein 9B paints
 * far better than the 4B for about 1,450 neurons a flyer picture (it takes the
 * preacher's photo as a reference too), and Leonardo's Phoenix 1.0 writes
 * lettering into a picture coherently (about 2,100 at 832x1024). The day's
 * allowance is kept (ledger below): the board's top designs get klein 9B,
 * one AI-lettered title a board gets Phoenix, while there is allowance for
 * them — then the 4B and schnell paint the rest, and the day never runs dry
 * before the cheap ones are used.
 */
const CF_KLEIN9 = { id: '@cf/black-forest-labs/flux-2-klein-9b', name: 'FLUX.2 klein 9B', form: true, refs: true };
const CF_PHOENIX = { id: '@cf/leonardo/phoenix-1.0', name: 'Phoenix 1.0', form: false, json: (prompt, size, seed) => ({ prompt: prompt.slice(0, 2000), width: size.w, height: size.h, seed, guidance: 3.5, num_steps: 25, negative_prompt: 'misspelled text, extra words, gibberish letters, watermark, signature, logo, blurry text' }) };
/*
 * WHAT A PICTURE COSTS, in neurons — Cloudflare's published prices (Workers AI
 * pricing, October 2026), rounded UP where a size falls between tiles: the real
 * daily cap must never be reached (past it, every AI picture fails till midnight).
 *   klein 4B: 26.05 per output 512x512 tile (+5.37 per reference tile)
 *   klein 9B: 1,363.64 for the first megapixel, 181.82 per more (and per reference megapixel), +5%
 *   Phoenix 1.0: 530 per 512 tile + 10 a step;  Lucid Origin: 636 a tile + 12 a step
 *   FLUX.1 schnell: always 1024x1024 — 4 tiles at 4.8 + 9.6 a step;  FLUX.2 dev: 37.5 per tile a step
 */
function neuronsFor(m, size, refs) {
  const tiles = Math.ceil(size.w / 512) * Math.ceil(size.h / 512), mp = (size.w * size.h) / (1024 * 1024);
  // reference photos: the phone sends them at most 496px, but whatever came is priced as up to a megapixel (4 tiles)
  const nRefs = (refs || []).length;
  if (m.id.includes('klein-9b')) return Math.ceil((1363.64 + Math.max(0, mp - 1) * 181.82 + nRefs * 181.82) * 1.05);
  if (m.id.includes('klein-4b')) return Math.ceil(tiles * 26.05 + nRefs * 4 * 5.37);
  if (m.id.includes('schnell')) return Math.ceil(4 * 4.8 + 8 * 9.6);
  if (m.id.includes('phoenix')) return tiles * 530 + 25 * 10;
  if (m.id.includes('lucid')) return tiles * 636 + 30 * 12;
  if (m.id.includes('flux-2-dev')) return Math.ceil((tiles + nRefs) * 37.5 * 25);
  return 5000;
}
const allowanceLeft = () => budget.hardLeft();
const cfPaid = () => /^(1|true|yes)$/i.test(String(process.env.CLOUDFLARE_PAID || ''));
/** The models to try for a picture, best first: the premium one only when asked for (the caller decides with the allowance). */
function cfModels(tier) {
  if (cfPaid()) return [CF_KLEIN9].concat(CF_BIG, CF_CHEAP);
  if (tier === 'premium') return [CF_KLEIN9].concat(CF_CHEAP);
  return CF_CHEAP;
}
// a model that refused (not on this account, a changed name) is skipped for a while, not asked every time
const benched = new Map();
const benchedNow = (id) => (benched.get(id) || 0) > Date.now();

function status() {
  const cf = !!(cfAccount() && cfToken());
  let writer = 'rules';
  if (process.env.ANTHROPIC_API_KEY) writer = 'claude';
  else { try { const cw = require('./cloudwrite'); if (cw.access && cw.access().key) writer = 'groq'; } catch (e) { /* none */ } }
  // the same free Cloudflare account that paints the pictures also has a writer: the art director
  if (writer === 'rules' && cf) writer = 'cloudflare';
  const who = space.person(), r = budget.report(who), lib = bank.report();
  return {
    allowanceLeft: cf && !cfPaid() ? r.left : null,
    // the day as this person finds it: plenty (fresh paintings), limited (fresh and the library), resting (the library)
    level: cf ? r.level : 'none', resetsAt: r.resetsAt, library: lib.pictures, letterings: lib.letterings,
    premium: cf && r.level === 'plenty',
    // AI lettering: fresh while the day allows, from the library (read back, spelt right) after that
    lettering: cf,
    painter: cf ? 'cloudflare' : 'pollinations',
    painterName: cf ? 'FLUX.2 (Cloudflare, free)' : 'FLUX (Pollinations, free)',
    cloudflare: cf,
    pollinationsKey: !!polKey(),
    writer,
  };
}

/* ------------------------------------------------------------- painting */

const NO_TEXT = 'absolutely no text, no letters, no words, no typography, no logos, no watermark, no signature';

/** The prompt a painter actually gets: the scene, the poster look, and the space the words need. */
/*
 * A PHOTOGRAPH, NOT A PAINTING. Asked for a "flyer background … graphic design
 * backdrop", the model drew one: cartoon trees, cartoon candles, a glowing
 * drawn Bible — the flyers looked like clip art. The flyers people save are
 * built on real photographs (a worship stage, a crowd, smoke, sky, fire), so
 * that is what is asked for, in a photographer's words, and the middle is
 * kept clear: that is where the speaker stands.
 */
function paintPrompt(scene, opts = {}) {
  const people = opts.people ? 'no person in the foreground or the middle of the frame, ' : '';
  // the title's own idea, painted as the flyer's key art (chains snapping, a mountain moving, a crown on a throne)
  if (opts.theme) {
    return [
      'Cinematic key art for a church event poster: ' + String(scene || 'heavy chains snapping apart in a burst of sparks').slice(0, 500),
      'epic dramatic photo manipulation, hyper-detailed photoreal textures, volumetric god rays, flying embers and dust, high contrast, rich saturated colour in one hue family, movie poster lighting',
      'the main subject large in the upper half of the frame or to one side, the lower middle darker and simpler, ' + people + 'a deep vignette at the edges',
      'not a cartoon, not clip art, not flat',
      NO_TEXT,
    ].join(', ');
  }
  return [
    'Real photograph: ' + String(scene || 'golden light rays breaking through dramatic clouds at sunrise').slice(0, 500),
    'professional event photography, shot on a full-frame camera, 35mm lens, shallow depth of field, natural film grain, photorealistic, true-to-life textures, cinematic colour grade, atmospheric haze, volumetric light, high dynamic range',
    people + 'one strong light source glowing behind the upper middle of the frame (a sunburst, a spotlight or a bright haze) with volumetric rays, drifting haze and tiny floating dust and ember particles, a deep vignette at the edges',
    'rich saturated colour in one hue family, calm open space across the upper half for a title, the centre softly out of focus',
    'not an illustration, not a drawing, not a painting, not a cartoon, not 3D render, not clip art',
    NO_TEXT,
  ].join(', ');
}

function sizeFor(w, h) {
  // multiples of 64 the models like, 1024 wide (Cloudflare prices by 512-pixel tiles: 1088 wide paid for a third tile)
  const ar = (+w || 4) / (+h || 5);
  let W = 1024, H = Math.round(W / ar);
  if (H > 1472) { H = 1472; W = Math.round(H * ar); }
  const r64 = (v) => Math.max(256, Math.round(v / 64) * 64);
  return { w: r64(W), h: r64(H) };
}

async function fetchTimed(url, opts = {}, ms = 90000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); } finally { clearTimeout(t); }
}

/** Whatever a painter sent back — raw image bytes, or JSON with a base64 image somewhere in it — as bytes. */
async function imageFrom(res) {
  const type = String(res.headers.get('content-type') || '');
  if (/^image\//i.test(type)) return { buf: Buffer.from(await res.arrayBuffer()), mime: type.split(';')[0] };
  const j = await res.json().catch(() => null);
  const b64 = j && ((j.result && (j.result.image || (Array.isArray(j.result.images) && j.result.images[0]))) || j.image);
  if (!b64 || typeof b64 !== 'string') {
    const why = j && Array.isArray(j.errors) && j.errors[0] ? j.errors[0].message : 'no picture in the answer';
    throw new Error(why);
  }
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(b64);
  const buf = Buffer.from(m ? m[2] : b64, 'base64');
  const mime = m ? m[1] : (buf[0] === 0x89 ? 'image/png' : 'image/jpeg');
  return { buf, mime };
}

/*
 * ONE CLOUDFLARE PAINTING, PAID FOR PROPERLY. Each model's cost is RESERVED
 * from the day before the call (aibudget: nothing can slip past between the
 * look and the spend), the call waits its turn in the queue, and the cost is
 * settled when the picture arrives — or given back when Cloudflare refused
 * before doing any work. A call that timed out or broke on Cloudflare's side
 * is counted as spent: it may have been painted, and the real cap must never
 * be reached. A model the day (or this person's share) cannot afford is
 * skipped for the next, cheaper one. `ctx`: { who, paced, person } for the
 * reservation (the night filler paints for the library: who 'library').
 */
// after a run of failures on Cloudflare's side, a minute's pause (the library answers) rather than spending on errors
let cfDown = { fails: 0, until: 0 };
async function paintCloudflare(prompt, size, seed, refs, tier, only, ctx = {}) {
  const errs = [];
  const who = ctx.who || space.person();
  let short = false;
  if (cfDown.until > Date.now()) throw Object.assign(new Error('Cloudflare is not answering just now'), { short: true });
  for (const m of (only || cfModels(tier))) {
    const benchKey = m.id + (refs ? '+refs' : '');
    if (benchedNow(benchKey)) continue;
    if (refs && !m.refs) continue;   // a picture with the preacher in it needs a model that takes reference photos
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfAccount())}/ai/run/${m.id}`;
    const headers = { authorization: `Bearer ${cfToken()}` };
    let body;
    if (m.form) {
      body = new FormData();
      body.append('prompt', prompt);
      body.append('width', String(size.w));
      body.append('height', String(size.h));
      if (seed != null) body.append('seed', String(seed));
      // FLUX.2 takes reference photos as input_image_0, input_image_1… (multipart)
      (refs || []).slice(0, 4).forEach((r, i) => body.append('input_image_' + i, new Blob([r.buf], { type: r.mime }), 'ref' + i + (r.mime === 'image/png' ? '.png' : '.jpg')));
    } else {
      headers['content-type'] = 'application/json';
      // (FLUX.1 schnell takes a prompt and steps only — and always paints 1024x1024)
      body = JSON.stringify(m.json ? m.json(prompt, size, seed) : { prompt: prompt.slice(0, 2000), steps: 8 });
    }
    const est = neuronsFor(m, size, refs);
    const ticket = budget.reserve(est, who, { paced: ctx.paced, person: ctx.person });
    if (!ticket) { short = true; errs.push(m.name + ': not within today’s allowance'); continue; }
    let billed = false;
    try {
      const out = await budget.turn(who, () => withDeadline(120000, async (signal) => {
        let res;
        try { res = await fetch(url, { method: 'POST', headers, body, signal }); }
        catch (e) { billed = e && e.name === 'AbortError'; throw Object.assign(e, { down: true }); }   // a timeout may still have been painted (and paid)
        if (res.status === 401 || res.status === 403) throw Object.assign(new Error('the Cloudflare token was refused — it needs “Workers AI: Read”'), { fatal: true });
        if (res.status === 429) {
          const t = await res.text().catch(() => '');
          // the day's free neurons are shared by every model: no point asking the next one
          if (/daily free allocation|3036/i.test(t)) { budget.exhaust(ticket); throw Object.assign(new Error('today’s free Cloudflare allowance is used up — it comes back at midnight UTC'), { fatal: true, short: true }); }
          // "capacity temporarily exceeded" (3040) or a rate limit: a short pause for this model (not twenty minutes for everyone)
          const ra = Math.min(300, Math.max(20, Number(res.headers.get('retry-after')) || 45));
          benched.set(benchKey, Date.now() + ra * 1000);
          throw new Error(m.name + ': Cloudflare is busy');
        }
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          if (res.status === 400 || res.status === 404) benched.set(benchKey, Date.now() + 6 * 3600e3);
          // a gateway error comes before any painting (nothing billed); a 500 may come after it
          else if (res.status === 500) billed = true;
          throw Object.assign(new Error(`${m.name}: ${res.status} ${t.slice(0, 160)}`), { down: res.status >= 500 });
        }
        billed = true;   // answered 200: painted (and paid), whatever the answer holds
        return imageFrom(res);   // read under the same deadline: a stalled download is let go too
      }));
      budget.settle(ticket, est);
      cfDown.fails = 0;
      return Object.assign(out, { by: m.name + ' · Cloudflare', model: m.id, cost: est });
    } catch (e) {
      if (billed) budget.settle(ticket, est); else budget.release(ticket);
      if (e.down && ++cfDown.fails >= 3) cfDown = { fails: 0, until: Date.now() + 60e3 };
      errs.push(e.message);
      if (e.queued) { short = true; break; }   // the queue is long: the library answers this one
      if (e.fatal) throw Object.assign(e, { short: !!e.short });
    }
  }
  throw Object.assign(new Error(errs.join('; ') || 'Cloudflare painted nothing'), { short });
}
/* a whole exchange — the request AND reading the answer — under one deadline */
async function withDeadline(ms, fn) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fn(ac.signal); } finally { clearTimeout(t); }
}

async function paintPollinations(prompt, size, seed) {
  const q = `width=${size.w}&height=${size.h}&seed=${seed}&model=flux&nologo=true&enhance=false&safe=true`;
  const key = polKey();
  const tries = [
    // the current gateway (a free key lifts the limits); then the original, keyless one
    { url: `https://gen.pollinations.ai/image/${encodeURIComponent(prompt.slice(0, 900))}?${q}`, headers: key ? { authorization: `Bearer ${key}` } : {} },
    { url: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 900))}?${q}${key ? '&token=' + encodeURIComponent(key) : ''}`, headers: {} },
  ];
  const errs = [];
  for (const t of tries) {
    try {
      const out = await withDeadline(45000, async (signal) => {
        const res = await fetch(t.url, { headers: t.headers, signal });
        if (!res.ok) throw new Error(String(res.status));
        return imageFrom(res);
      }).catch((e) => { errs.push(e.message); return null; });
      if (!out) continue;
      if (out.buf.length < 8000) { errs.push('an empty picture'); continue; }
      return Object.assign(out, { by: 'FLUX · Pollinations' });
    } catch (e) { errs.push(e.message); }
  }
  throw new Error('Pollinations did not paint (' + errs.join(', ') + ')');
}

/* the kind of event a picture is for (the library files it under this): prayer, word, easter, christmas… */
function kindKey(ev) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const hay = [e.season, e.kind, e.title, e.theme].filter(Boolean).join(' ');
  const r = RULES.find((x) => x.rx.test(hay)) || RULES[RULES.length - 1];
  return bank.keyOf(r.script) || 'general';
}
const dataUrlOf = (o) => `data:${o.mime};base64,${o.buf.toString('base64')}`;
const inflight = new Map();   // a slot being painted right now → the library id it will have

/**
 * Paint one background. → { dataUrl, by, prompt, bank? } — or throws with a
 * plain sentence the phone can show (the phone then uses the studio's photos).
 *
 * ►► ONE ALLOWANCE, A HUNDRED PEOPLE. ◄◄ The church's library comes first
 * whenever the day is not plenty: a picture painted earlier for this kind of
 * event, in this light, that THIS person has not seen — free. Fresh paintings
 * go on what the library does not have yet (and are kept in it for the next
 * person); the top design gets FLUX.2 klein 9B only while the day is plenty.
 * Two people asking for the same thing at the same moment share one painting.
 */
async function paint({ scene, w = 1080, h = 1350, seed, people = true, theme = false, tier = 'normal', slot, tone, event } = {}) {
  const who = space.person();
  const prompt = paintPrompt(scene, { people, theme: !!theme });
  const size = sizeFor(w, h);
  const s = Number.isFinite(+seed) ? Math.abs(Math.round(+seed)) % 2147483647 : Math.floor(Math.random() * 1e9);
  const ev = event && typeof event === 'object' ? event : {};
  const kind = kindKey(ev), themeK = theme ? bank.keyOf([ev.title, ev.theme].filter(Boolean).join(' ')) : '';
  const toneId = String(tone || 'own').replace(/[^\w-]/g, '').slice(0, 20) || 'own';
  const top = slot == null ? tier === 'premium' : +slot === 0;
  const q = { shape: bank.shapeOf(size.w, size.h), kind, theme: themeK, tone: toneId, people: people !== false, premium: top };
  const slotKey = [q.shape, themeK ? 'theme:' + themeK : kind, toneId, q.people ? 'p' : 'np'].join('|');
  const recipe = { scene: String(scene || '').slice(0, 600), w: +w || 1080, h: +h || 1350, people: q.people, theme: !!theme, themeText: themeK, kind, tone: toneId, shape: q.shape };
  const cf = !!(cfAccount() && cfToken());
  const lvl = cf ? budget.level(who) : 'resting';
  const errs = [];
  let out = null, fresh = false;
  const fromLibrary = (qq, again) => bank.take(qq || q, who, { again });

  // 1. the library, when the day is not plenty (everyone's fresh paintings are shared out fairly)
  if (lvl !== 'plenty') out = fromLibrary();
  // 2. the same picture being painted for someone else right now: wait for it rather than paint it twice
  //    (holding nothing while waiting — no place in the queue, no reservation; never on one's own painting)
  const flying = inflight.get(slotKey);
  if (!out && cf && lvl !== 'plenty' && flying && flying.owner !== who) {
    // at most a few seconds: then the library (a slow painting is nobody else's wait)
    const id = await Promise.race([flying.id, new Promise((r) => setTimeout(() => r(null), 12000))]);
    if (id) out = bank.takeId(id, who);
    if (!out) out = fromLibrary();
  }
  // 3. a fresh painting, kept in the library for the next person
  if (!out && cf) {
    // the top design gets FLUX.2 klein 9B while the day is plenty — and only if this person can still afford the
    // board's AI-lettered title too (it comes first: lettered once, it serves every flyer with that title after)
    const words = String(ev.title || '').trim().split(/\s+/).filter(Boolean).length;
    const letterFirst = words >= 1 && words <= 4 && !bank.letterStock(ev.title, who);
    const premium = top && lvl === 'plenty' && (!letterFirst || budget.personLeft(who) >= neuronsFor(CF_KLEIN9, size) + neuronsFor(CF_PHOENIX, { w: 832, h: 1024 }));
    const job = paintCloudflare(prompt, size, s, null, premium ? 'premium' : 'normal', null, { who }).then((o) => {
      let e = null;
      // kept for the next person — best effort: a full disk never costs this person their picture
      try { e = bank.add(o.buf, o.mime, { kind, theme: themeK, tone: toneId, shape: q.shape, tier: /klein-9b|flux-2-dev|lucid/.test(o.model || '') ? 'premium' : 'normal', by: o.by, people: q.people, prompt: scene }, who); } catch (er) { e = null; }
      return { o, e };
    });
    const entry = { owner: who, id: job.then((r) => (r.e ? r.e.id : null), () => null) };
    inflight.set(slotKey, entry);
    entry.id.then(() => { if (inflight.get(slotKey) === entry) inflight.delete(slotKey); });
    // kept in the library: the phone loads it from there (and keeps it); if it could not be kept, the picture itself
    try { const r = await job; out = r.e ? Object.assign(bank.handOutNew(r.e), { bank: false }) : { dataUrl: dataUrlOf(r.o), by: r.o.by }; fresh = true; } catch (e) { errs.push(e.message); }
  }
  // 4. the day cannot paint it: the library's best (any light; then any picture for this kind of event)
  if (!out) out = fromLibrary();
  if (!out && themeK) out = fromLibrary(Object.assign({}, q, { theme: '' }));
  if (!out) out = fromLibrary(null, true);   // seen long ago is better than none
  bank.note(slotKey, recipe, !!out);
  const cfWhy = errs.slice();   // why Cloudflare did not paint (said on the phone, never silently)
  // 5. Pollinations: only with a key now (keyless requests are refused there) — or on a server with no Cloudflare at all
  if (!out && (polKey() || !cf)) {
    try { const o = await paintPollinations(prompt, size, s); out = { dataUrl: dataUrlOf(o), by: o.by }; } catch (e) { errs.push(e.message); }
  }
  if (!out) throw new Error(errs.join(' · ') || (cf ? 'today’s free AI pictures are resting and the library has none for this yet' : 'no painter could be reached'));
  return Object.assign(out, { prompt, seed: s, fresh, tone: out.tone || toneId, cfFailed: !fresh && cfWhy.length ? cfWhy.join(' · ').slice(0, 300) : '' });
}

/*
 * ►► THE PREACHER PAINTED INTO THE SCENE. ◄◄ Not a cut-out laid on a picture:
 * their photo goes to FLUX.2 as a reference, and the model paints them into
 * the scene itself — lit by its stage lights, haze round them, the colour of
 * the place on their suit — the way the designers' flyers look. The model may
 * change a face a little, so these are offered as their own designs and the
 * operator looks before posting. Cloudflare only (Pollinations takes no
 * reference photos). → { dataUrl, by, prompt, seed }
 */
function paintWithPrompt(scene, who) {
  return [
    'Photograph for a church event flyer: the man in the reference image, exactly the same person — the same face, skin tone, hairline, beard and clothes — ' + (who || 'preaching with passion') + ', seen from the chest up, in the lower half of the frame and a little off-centre',
    'he stands in this scene: ' + String(scene || 'a worship stage with golden stage lights and haze').slice(0, 400),
    'lit by the scene itself: a strong rim light behind him in the scene\'s colour, soft warm light on his face, atmospheric haze around him, shallow depth of field, the background softly out of focus',
    'the upper third of the frame open and darker for a headline',
    'professional event photography, photorealistic, sharp detail on the face, cinematic colour grade',
    'not an illustration, not a cartoon, not 3D render',
    NO_TEXT,
  ].join(', ');
}
function refOf(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) throw new Error('That reference photo is too big.');
  return { buf, mime: m[1].toLowerCase() };
}
async function paintWith({ scene, w = 1080, h = 1350, seed, refs = [], who } = {}) {
  if (!(cfAccount() && cfToken())) throw new Error('Painting the preacher into the picture needs the free Cloudflare account on the server (see CLOUD.md).');
  const rs = (Array.isArray(refs) ? refs : []).map(refOf).filter(Boolean).slice(0, 2);
  if (!rs.length) throw new Error('No photo of the preacher was sent.');
  const prompt = paintWithPrompt(scene, who);
  const size = sizeFor(w, h);
  const s = Number.isFinite(+seed) ? Math.abs(Math.round(+seed)) % 2147483647 : Math.floor(Math.random() * 1e9);
  const person = space.person();
  // their own photo: never put in the library; klein 9B only while the day is plenty, the 4B (about 160) otherwise
  const out = await paintCloudflare(prompt, size, s, rs, budget.level(person) === 'plenty' ? 'premium' : 'normal', null, { who: person })
    .catch((e) => { throw new Error(e.short ? 'today’s free AI painting is resting — the other designs stand' : e.message); });
  return { dataUrl: dataUrlOf(out), by: out.by, prompt, seed: s };
}

/*
 * ►► THE TITLE LETTERED BY AI, INTO THE PICTURE. ◄◄ What the flyers people
 * save have and a template cannot: the title is part of the art — carved in
 * the rock, burning, in gold standing in the light. Phoenix 1.0 (free on
 * Cloudflare, about two a day) paints the scene with the title lettered into
 * it; the studio adds the minister and the details. An AI can misspell, so the
 * picture is READ back (cloudsee.readFlyer, the free vision model) and kept
 * only when every word of the title is there, spelt right — one more try if
 * not. With no vision model to check, it comes back marked unchecked.
 */
// BRIGHT, every one: "was the text even visible?" — charred stone and dim fire letters on a dark scene were not
const LETTERING = ['huge bright glossy 3D gold metallic lettering with bevelled edges, brilliant highlights and a warm glow behind it',
  'massive bright white chrome 3D lettering with a strong white glow behind it', 'giant blazing letters of white-hot yellow fire with a bright glowing core',
  'bold bright white lettering with a thick gold outline and a soft glow', 'tall elegant bright gold serif lettering glowing against the darker sky'];
function titlePrompt(scene, title, look) {
  return [
    `Church event poster key art with the title "${title}" written across the upper middle in ${look}, every letter spelled exactly ${title.split('').join(' ').toUpperCase().replace(/ {3}/g, ' / ')}`,
    'the lettering is the BRIGHTEST thing in the picture, high contrast against a darker area of sky or shadow directly behind it, every letter crisp and clearly readable from far away',
    'the title is the ONLY text in the image: no other words, letters, numbers, logos or signatures',
    'the scene: ' + String(scene || 'heavenly golden light breaking through dramatic clouds').slice(0, 400),
    'epic cinematic movie-poster composition, dramatic volumetric light, rich saturated colour, hyper-detailed, the lower third darker and simpler, a thin empty strip along the very top',
  ].join(', ');
}
const wordsOf = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1);
async function paintTitle({ scene, title, seed, look, event, fresh: forceFresh } = {}) {
  title = String(title || '').trim().replace(/\s+/g, ' ').slice(0, 32);
  if (!title || title.split(' ').length > 4) throw new Error('AI lettering is for a short title (four words at most).');
  const who = space.person(), forLibrary = who === budget.LIBRARY;
  // the church's library first: this title, lettered earlier, read back spelt right, that this person has not had — free
  if (!forLibrary && !forceFresh) { const lib = bank.takeLetter(title, who); if (lib) return Object.assign(lib, { prompt: '', seed: 0 }); }
  if (!(cfAccount() && cfToken())) throw new Error('AI lettering needs the free Cloudflare account on the server.');
  if (!forLibrary) bank.noteLetter(title, scene);   // asked for: tonight's leftover allowance letters it, if today cannot
  const size = { w: 832, h: 1024 };   // 4 tiles, 25 steps: about 2,370 neurons
  const want = wordsOf(title);
  let cs = null; try { cs = require('./cloudsee'); } catch (e) { cs = null; }
  const style = look || LETTERING[Math.floor(Math.random() * LETTERING.length)];
  let last = null, tries = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = Number.isFinite(+seed) && !attempt ? Math.abs(Math.round(+seed)) % 2147483647 : Math.floor(Math.random() * 1e9);
    const prompt = titlePrompt(scene, title, style);
    let out;
    try { out = await paintCloudflare(prompt, size, s, null, 'premium', [CF_PHOENIX], { who }); }
    catch (e) {
      if (last) break;   // a second try the day cannot afford: the first stands as it is
      throw new Error(e.short ? 'today’s free AI lettering is resting (the church library has none of this title yet) — the designs without it stand' : e.message);
    }
    tries++;
    const dataUrl = dataUrlOf(out);
    last = { dataUrl, by: out.by, prompt, seed: s, checked: false, spelt: null };
    if (!cs || !cs.ready || !cs.ready()) return forLibrary ? null : last;   // unchecked: offered to this person, never kept for others
    const r = await cs.readFlyer({ image: dataUrl, maxWaitMs: 20000 }).catch(() => ({ ok: false }));
    if (!r || !r.ok) return forLibrary ? null : last;
    const seen = new Set(wordsOf([r.text, r.event].join(' ')));
    const ok = want.every((w) => seen.has(w));
    // "was the text even visible?": spelt right is not enough — dark letters on a dark scene are painted again
    const legible = r.legible !== false;
    last = Object.assign(last, { checked: true, spelt: ok, legible, read: (r.event || r.text || '').slice(0, 80) });
    if (ok && legible) {
      // read back right: kept, so every flyer with this title after it can have it free
      let kept = null;
      try { kept = bank.addLetter(out.buf, out.mime, { title, style, by: out.by, checked: true, spelt: true, legible: true, w: size.w, h: size.h }, forLibrary ? null : who); } catch (e) { kept = null; }
      if (kept) { delete last.dataUrl; last.file = kept.file; }
      return last;
    }
  }
  const times = tries > 1 ? 'twice' : 'and today cannot afford another try';
  if (last && last.checked && !last.spelt) throw new Error('the AI misspelt the title ' + times + ' (it read “' + (last.read || '') + '”) — the designs without it stand');
  if (last && last.checked && !last.legible) throw new Error('the AI lettering came out hard to read ' + times + ' — the designs without it stand');
  return last;
}

/*
 * WHICH CLOUDFLARE PAINTERS WORK ON THIS ACCOUNT — each tried once, small,
 * its answer said plainly (run on the server: see CLOUD.md).
 */
async function cfDiagnose() {
  if (!(cfAccount() && cfToken())) return [{ model: 'Cloudflare', ok: false, said: 'no account id / token on the server' }];
  const out = [];
  for (const m of cfModels()) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfAccount())}/ai/run/${m.id}`;
    const headers = { authorization: `Bearer ${cfToken()}` };
    let body;
    if (m.form) { body = new FormData(); body.append('prompt', 'golden light through clouds'); body.append('width', '512'); body.append('height', '512'); }
    else { headers['content-type'] = 'application/json'; body = JSON.stringify(m.json ? Object.assign(m.json('golden light through clouds', { w: 512, h: 512 }, 1), { num_steps: 4 }) : { prompt: 'golden light through clouds', steps: 4 }); }
    const t0 = Date.now();
    try {
      const res = await fetchTimed(url, { method: 'POST', headers, body }, 120000);
      if (!res.ok) { out.push({ model: m.name, ok: false, said: res.status + ' ' + (await res.text().catch(() => '')).slice(0, 160) }); continue; }
      const im = await imageFrom(res);
      out.push({ model: m.name, ok: true, said: Math.round(im.buf.length / 1024) + ' KB in ' + Math.round((Date.now() - t0) / 1000) + 's' });
    } catch (e) { out.push({ model: m.name, ok: false, said: e.message }); }
  }
  return out;
}

/* --------------------------------------------------------- art direction */

const LOOKS = ['glory', 'fire', 'encounter', 'miracle', 'bible', 'prophetic', 'sunday', 'lineup', 'script', 'scenic', 'light', 'joinus', 'didone', 'upper', 'theme', 'mountain', 'breaking', 'spirit', 'jericho', 'unique', 'thanks', 'mantle', 'urgency', 'harvest'];

const DIRECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scenes: { type: 'array', items: { type: 'string' }, description: 'Three different background pictures to paint, each one vivid sentence' },
    palette: { type: 'array', items: { type: 'string' }, description: 'Four hex colours: deep background, mid, accent, highlight' },
    scriptWord: { type: 'string', description: 'One word to set in flowing script, e.g. Sunday, Worship, Glory' },
    kicker: { type: 'string', description: 'A short line above the title, 1-4 words, e.g. WORSHIP WITH US THIS' },
    looks: { type: 'array', items: { type: 'string', enum: LOOKS } },
  },
  required: ['scenes', 'palette', 'scriptWord', 'kicker', 'looks'],
};

const DIRECTOR_SYSTEM = `You are the art director of a top Nigerian church media team whose event flyers are the ones everyone saves on Pinterest: dramatic, glossy, colourful, cinematic.
You are given the event. Decide:
- scenes: SIX pictures for an image model, each one sentence. The FIRST THREE paint the title or theme itself, literally, as the KEY ART of the flyer — the way the flyers everyone saves are built around one dramatic picture of the title's own idea: BREAK EVERY CHAIN: heavy iron chains snapping apart in a burst of sparks in a fiery cave; MOUNTAIN MOVERS: a colossal mountain splitting, rocks flying, white doves and golden light bursting out; WATER FROM THE ROCK: water gushing from a split rock in firelight; ENTHRONEMENT: a jewelled crown glowing on a throne under a beam of light; JERICHO HOUR: massive ancient city gates swinging open, light pouring through; THE DOCTRINES OF FAITH: a robed figure walking between parted walls of sea; BRAND NEW BEGINNING: a man running out through a shattered door into blinding light; PRAYER: hands lifted in silhouette against a blazing sunrise; HARVEST: a golden wheat field at sunset under a dramatic sky. Three DIFFERENT takes on the idea (a different subject, angle or light each), each with its main subject large in the UPPER HALF or to ONE SIDE, the lower middle darker and simpler (the minister stands in front there), epic and cinematic like a movie poster. The LAST THREE are atmosphere for the same event: a worship stage with coloured spotlights and haze, a crowd with raised hands seen from behind out of focus, sunlight breaking through real clouds, real fire and sparks, smoke lit in colour — matching the event's mood and season (Easter: sunrise over hills; Christmas: warm golden bokeh; prayer: deep blue haze and one beam of light). Never ask for text, letters, logos or close-up faces.
- palette: four hex colours that will grade the picture and colour the type (deep, mid, accent, highlight). Bold and saturated: purple & gold, royal blue & white, crimson & gold, teal & lime, magenta & cyan.
- scriptWord: one word for flowing script lettering across the speaker, usually the service day or the heart of the theme.
- kicker: a short uppercase line above the title.
- looks: the layouts that fit best, best first, from: glory (two enormous white stacked words with a small yellow connector tag between, the minister in front — "Glory to Glory", any short title), fire (a burning italic distressed title, embers, the minister in front, the date down the side — PUSH, 6 HOURS PRAYER WATCH, prayer nights), encounter (ministers in warm light with the title across them and the details on labels — worship, praise, concerts), miracle (the minister lit from behind with a wide bold title below — miracle, healing, special services), bible (a gold serif title with a red JOIN US tab and a 'with PASTOR' badge — Bible study, midweek, teaching), prophetic (a red ribbon over a blazing gold title — Night of …, prophetic, prayer), sunday (the title as tall as the flyer with the preacher walking out of it — Sunday service), lineup (several ministers in a row each named — conferences, conventions, concerts), script (one word in flowing script with capitals around — special Sunday, celebrations, Christmas, Easter), scenic (a landscape, one huge word, the preacher on a card — teaching series, retreats), light (a bright page, bold dark title, red script word — workers' meetings, men's and women's fellowships), joinus (JOIN US THIS SUNDAY: huge white geometric capitals on a tilt over vivid purple, the hosts in front, the details on angled bands — Sunday service, youth, any invitation), didone (GLORY OF GOD: an elegant thin high-contrast serif title in white over a loud fiery picture, the minister below, a band of three coloured cells — glory, worship, thanksgiving, anniversaries), upper (UPPER ROOM: a super-heavy wide title lit hot white to gold with a script word across it, the details in boxes — prayer, revival, any bold one- or two-word title), theme (BREAK EVERY CHAIN: no cut-out, the theme painted, the title filled with the picture's own fire and breaking apart — themes, campaigns, revivals), mountain (MOUNTAIN EXPERIENCE: a heavy italic title filled with the sky, the minister in front, small badges round him — retreats, experiences, outdoor), breaking (BREAKING INVISIBLE Barriers: tall white distressed capitals, a signature script word across them, the minister to the side — breakthrough, deliverance, anointing services), spirit (SPIRIT OF DAVID: up to three ministers in rank over a gold-foil title with its little word on a badge — concerts, conferences, guest ministers), jericho (JERICHO HOUR: a BRIGHT white page, a two-tone heavy title on the left, the minister big on the right with his name on a ribbon — weekly hours, prayer, any bold title), unique (UNIQUE EXPERIENCE: a bright warm page, a red line over a dark one, two ministers, the details on a tilted cream banner — music, worship, two guests), thanks (THANKSGIVING: a white sky, a gold script word over a red and gold title, the people below — thanksgiving, anniversaries, celebrations), mantle (PROPHETIC MANTLE SERVICE: cream and gold, a tall elegant gold serif title, the minister at the foot — prophetic, special services, end of fast), urgency (URGENCY: the main minister big, the others in a named row along the foot — conferences with several ministers), harvest (THE HARVEST: the ministers in two named rows above a huge title — all-night services, conventions, many ministers).
Answer with JSON only.`;

function fieldsText(f) {
  const lines = [];
  const board = (readKit().inspo || []).filter((i) => i.notes || i.scene).slice(0, 8);
  if (board.length) {
    lines.push('THIS CHURCH\'S INSPIRATION BOARD — flyers they love. Let their style steer yours (never copy their words):');
    board.forEach((i) => lines.push(`- ${i.notes}${i.look ? ' [closest layout: ' + i.look + ']' : ''}${i.scene ? ' Picture: ' + i.scene : ''}`));
    lines.push('');
  }
  const add = (k, v) => { if (v) lines.push(`${k}: ${String(v).slice(0, 200)}`); };
  add('Event', f.title); add('Theme', f.theme); add('Kind', f.kind); add('Season', f.season);
  add('Date', f.dateText); add('Time', f.time); add('Church', f.church);
  if (Array.isArray(f.speakers) && f.speakers.length) add('Speakers', f.speakers.map((s) => s.name || s).join(', '));
  add('Notes', f.notes);
  return lines.join('\n');
}

async function directWithClaude(f) {
  const Anthropic = require('@anthropic-ai/sdk');
  const Client = Anthropic.default || Anthropic;
  const client = new Client({ maxRetries: 1, timeout: 90 * 1000 });
  const body = {
    model: process.env.MW_FLYER_MODEL || 'claude-opus-5-5',
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: DIRECTION_SCHEMA } },
    system: DIRECTOR_SYSTEM,
    messages: [{ role: 'user', content: fieldsText(f) }],
  };
  const res = await client.messages.create(body);
  if (!res || res.stop_reason === 'refusal') return null;
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

/* Cloudflare Workers AI's free writers, best first (a model the account lacks is skipped) */
// (llama-3.1-8b-instruct was retired by Cloudflare on 30 May 2026)
const CF_WRITERS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fast'];
// what one art direction costs of the day (a ~1,500-token prompt, up to 1,200 tokens back, at the 70B's prices), rounded up
const WRITER_NEURONS = 300;
function jsonIn(text) {
  if (text && typeof text === 'object') return text;
  const t = String(text || ''); const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}
async function directWithCloudflare(f) {
  const system = DIRECTOR_SYSTEM + '\nAnswer with ONE JSON object only, no prose, with keys: scenes (array of 6 strings), palette (array of 4 hex strings like "#1a0638"), scriptWord (string), kicker (string), looks (array of layout names).';
  const until = Date.now() + 30000;   // the whole art direction, never longer than this — then the pool
  const who = space.person();
  for (const id of CF_WRITERS) {
    if (benchedNow(id)) continue;
    const left = until - Date.now(); if (left < 4000) break;
    // the same allowance as the pictures: set aside first (it used to be spent and never written down)
    const ticket = budget.reserve(WRITER_NEURONS, who);
    if (!ticket) return null;   // the day is for the pictures now: the rules direct this one
    let billed = false;
    try {
      // the request and its answer under one deadline (a stalled answer is let go, and counted)
      const r = await withDeadline(Math.min(25000, left), async (signal) => {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfAccount())}/ai/run/${id}`, {
          method: 'POST', headers: { authorization: `Bearer ${cfToken()}`, 'content-type': 'application/json' }, signal,
          body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: fieldsText(f) + '\n(Surprise me: this is request ' + Math.floor(Math.random() * 1e6) + ', so make the six scenes different from any you gave before.)' }], max_tokens: 1200, temperature: 1.0 }),
        });
        if (res.ok) billed = true;
        return { status: res.status, ok: res.ok, text: res.ok ? '' : await res.text().catch(() => ''), j: res.ok ? await res.json().catch(() => null) : null };
      });
      if (r.status === 400 || r.status === 404) { benched.set(id, Date.now() + 6 * 3600e3); budget.release(ticket); continue; }
      if (r.status === 429) { budget.release(ticket); if (/daily free allocation|3036/i.test(r.text)) { budget.exhaust(ticket); return null; } continue; }
      if (!r.ok) { if (r.status === 500) budget.settle(ticket, WRITER_NEURONS); else budget.release(ticket); continue; }
      const j = r.j;
      const u = j && j.result && j.result.usage;
      // what it really used, when Cloudflare says (its prices for the 70B: about 27 a thousand tokens in, 205 out)
      const used = u && u.prompt_tokens != null ? Math.ceil((+u.prompt_tokens || 0) * 0.0267 + (+u.completion_tokens || 0) * 0.2048) + 5 : WRITER_NEURONS;
      budget.settle(ticket, Math.min(WRITER_NEURONS * 2, used));
      const d = jsonIn(j && j.result && j.result.response);
      if (d && Array.isArray(d.scenes) && d.scenes.length) return d;
    } catch (e) { if (billed || (e && e.name === 'AbortError')) budget.settle(ticket, WRITER_NEURONS); else budget.release(ticket); /* the next writer */ }
  }
  return null;
}

async function directWithGroq(f) {
  const cw = require('./cloudwrite');
  const text = await cw.chat({
    system: DIRECTOR_SYSTEM + '\nJSON keys: scenes (array of 6 strings), palette (array of 4 hex strings), scriptWord, kicker, looks (array).',
    prompt: fieldsText(f), json: true, maxTokens: 900, temperature: 0.9, evenIfOff: true, timeoutMs: 25000,
  });
  return text ? cw.parseJson(text) : null;
}

/* The rules, for a server with no writer: the season and the kind of service pick the picture. */
const RULES = [
  { rx: /easter|resurrection|risen|good\s*friday|palm\s*sunday|calvary|cross/i, scenes: ['a real sunrise over green hills with golden sun rays through clouds, lens flare, photograph', 'soft white and gold light rays through morning mist over a field at dawn, shallow depth of field', 'a church stage at sunrise service with warm golden spotlights and haze, out of focus'], palette: ['#2a0d45', '#6b2fa3', '#f6c343', '#ffffff'], script: 'Easter', kicker: 'CELEBRATE WITH US', looks: ['didone', 'script', 'glory', 'scenic'] },
  { rx: /christmas|carol|nativity|advent/i, scenes: ['warm golden christmas fairy lights bokeh in a dark room, shallow depth of field', 'a church auditorium decorated with red and gold lights, out of focus, warm haze', 'deep blue night sky with soft golden bokeh and sparkles, photograph'], palette: ['#2b0306', '#8d0f1f', '#f5c84c', '#ffffff'], script: 'Christmas', kicker: 'JOIN US FOR', looks: ['didone', 'script', 'encounter', 'glory'] },
  { rx: /crossover|new\s*year|watch\s*night|31st|countdown/i, scenes: ['real golden fireworks over a city skyline at midnight, long exposure photograph', 'golden confetti falling in front of bright stage lights, out of focus, haze', 'a concert stage with white and gold beams of light and smoke at night'], palette: ['#05081a', '#1a2a6b', '#f2c14e', '#ffffff'], script: 'Crossover', kicker: 'CROSS OVER WITH US', looks: ['upper', 'fire', 'spirit', 'glory', 'lineup'] },
  { rx: /prayer|pray|vigil|intercess|fasting|night\s*of/i, scenes: ['a single beam of white light through blue haze in a dark auditorium, photograph', 'warm amber stage light and smoke in a dark church, a crowd with raised hands far in the background out of focus', 'dramatic orange sunrise clouds with rays of light, real sky photograph'], palette: ['#0a0716', '#3b1670', '#ff9d2e', '#ffffff'], script: 'Prayer', kicker: 'A NIGHT OF', looks: ['upper', 'breaking', 'prophetic', 'fire', 'theme', 'glory'] },
  { rx: /bible\s*stud|word|scripture|teaching|midweek|tuesday/i, scenes: ['a dim church auditorium with warm amber stage lights and haze, bookshelves out of focus at the sides', 'deep navy blue background with warm golden bokeh lights and soft haze, photograph', 'morning light through tall windows in a quiet library, dust in the light beams, shallow depth of field'], palette: ['#071022', '#123a6b', '#eec158', '#ffffff'], script: 'Word', kicker: 'DIGGING DEEPER', looks: ['bible', 'mountain', 'didone', 'scenic', 'glory'] },
  { rx: /youth|teen|campus|student|party|jam/i, scenes: ['an energetic concert stage with magenta and cyan spotlights, haze and confetti, photograph', 'a festival crowd with raised hands silhouetted against bright stage lights, out of focus', 'neon purple and blue stage lights with smoke, shallow depth of field'], palette: ['#120429', '#5b1bb5', '#ff2fd6', '#19e0ff'], script: 'Vibes', kicker: 'IT’S A', looks: ['joinus', 'upper', 'fire', 'spirit', 'lineup', 'script'] },
  { rx: /conference|crusade|revival|convention|summit|breakthrough|retreat|camp/i, scenes: ['a vast crowd with hands raised under blinding white and gold stage lights, seen from behind, out of focus', 'real fire and golden sparks rising against a dark red background, photograph', 'dramatic sunrise over misty mountains with rays of light, real landscape photograph'], palette: ['#1a0303', '#7a1414', '#f5a623', '#ffffff'], script: 'Glory', kicker: '2026', looks: ['spirit', 'breaking', 'theme', 'mountain', 'fire', 'lineup', 'miracle'] },
  { rx: /thanksgiving|anniversary|harvest|birthday|celebrat/i, scenes: ['golden confetti falling with warm bokeh lights, celebration, photograph', 'a church stage with purple and gold lights and haze, out of focus', 'a golden wheat field at sunset with warm sun rays, photograph'], palette: ['#1a0b2e', '#4b1d7a', '#f2c94c', '#ffffff'], script: 'Thanksgiving', kicker: 'COME CELEBRATE', looks: ['didone', 'spirit', 'script', 'encounter', 'glory'] },
  { rx: /worship|praise|sunday|service|.*/i, scenes: ['sunlight breaking through dramatic purple and gold clouds, real sky photograph', 'a worship concert stage with blue spotlights and haze, crowd with raised hands far away out of focus', 'soft royal purple and gold bokeh lights with lens flare, shallow depth of field'], palette: ['#1a0638', '#5b21b6', '#f5c542', '#ffffff'], script: 'Sunday', kicker: 'WORSHIP WITH US THIS', looks: ['joinus', 'glory', 'didone', 'sunday', 'upper', 'encounter'] },
];

/*
 * WHEN NO AI CAN WRITE: never the same three pictures again. The event's own
 * scenes, then a wide pool of what church flyers are built on — six picked at
 * random every time, so "New pictures" really is new.
 */
const POOL = [
  'real flames and glowing embers rising into a dark night sky, photograph',
  'white light bursting through a crack in dark rock, dust in the beams, photograph',
  'a lighthouse beam sweeping over a dark stormy sea at night, long exposure photograph',
  'an ancient parchment scroll and a quill on a wooden desk in a single beam of window light, dark background, shallow depth of field',
  'a lantern glowing on a misty forest path at night, warm light, photograph',
  'sunlight streaming through stained glass windows into a dark cathedral, coloured light on the floor, photograph',
  'white doves flying through golden rays of light against a blue sky, photograph',
  'a huge crowd with hands raised at an outdoor night service, stage lights and haze, seen from behind, out of focus',
  'thunderclouds lit from within by lightning over a dark plain, dramatic real sky photograph',
  'golden light rays breaking through heavy clouds over the ocean at sunset, photograph',
  'a misty mountain range at dawn with layers of blue ridges and a glowing sky, landscape photograph',
  'city lights at night seen from a rooftop, deep blue hour, soft bokeh, photograph',
  'light trails and lens flares of a concert stage, purple and gold, long exposure photograph',
  'water drops and ripples catching golden light on a dark lake, macro photograph',
  'a path of light leading up a hill to a glowing horizon at dawn, photograph',
  'red velvet curtains and golden stage lights in an empty theatre, haze, photograph',
  'smoke swirling in coloured stage light against a black background, photograph',
  'warm golden sunrise over a quiet field with morning mist, photograph',
  'an open bible on a pulpit under a soft spotlight in a dark auditorium, out of focus at the edges',
  'the silhouette of a cross on a hill against a blazing orange sky, real photograph',
];
/* the title's own idea, when no AI can be asked: its words → the key art the designers would paint */
const THEME_ART = [
  [/chain|bondage|captiv|free(dom)?\b|deliver|loose/i, ['heavy iron chains snapping apart in a burst of sparks and fire inside a dark fiery cave, broken links flying', 'a man silhouetted on a cliff edge tearing broken chains from his wrists against a blazing orange sky']],
  [/mountain|mover|moved|hill/i, ['a colossal mountain splitting apart, rocks flying through the air, white doves and golden light bursting out of the crack', 'a man standing on a misty mountain summit with arms raised as golden rays break through storm clouds']],
  [/rock|water|river|rain|well|spring|flow/i, ['water gushing in a torrent from a split boulder in a desert canyon lit by firelight and sunbeams', 'a mighty waterfall of light pouring from storm clouds into a dark valley']],
  [/crown|throne|king|reign|enthron|kingdom|royal/i, ['a jewelled golden crown glowing on a dark throne under a single beam of light, dust in the air', 'a hand reaching down from the clouds placing a radiant crown, golden light rays']],
  [/gate|door|open|jericho|wall/i, ['massive ancient stone city gates swinging open with brilliant light pouring through, dust and doves', 'ancient walls crumbling and falling with light blazing through the breach, rubble flying']],
  [/sea|faith|red sea|part|exodus/i, ['a robed figure walking between towering parted walls of sea water, a glowing path of light ahead', 'a stormy sea parting under a beam of light from the sky']],
  [/new|begin|fresh|level|next|season/i, ['a man running out through a shattered wooden door into blinding white light, splinters flying', 'a sunrise bursting over a new horizon with a long path of light leading to it']],
  [/fire|altar|revival|burn|flame|pentecost|holy ghost|spirit/i, ['a stone altar engulfed in towering flames, sparks rising into a dark sky', 'tongues of fire descending through a column of light with a white dove, embers everywhere']],
  [/break|breakthrough|barrier|shatter|smash/i, ['a fist smashing through cracked stone with light bursting out of the cracks, shards flying', 'a wall of glass shattering into a thousand glowing shards in golden light']],
  [/harvest|thanksgiving|bless|abundan|overflow/i, ['a golden wheat field at sunset under a dramatic sky, warm light rays', 'golden light pouring like a river into an overflowing vessel, sparkles rising']],
  [/eagle|rise|soar|wing|mount up/i, ['a great eagle soaring through dark storm clouds into golden light', 'an eagle with spread wings above the clouds at sunrise']],
  [/sword|war|battle|army|victory|conquer/i, ['a glowing sword thrust into a rock with lightning striking around it', 'an army of light standing on a ridge under a storm sky, banners flying']],
  [/prayer|pray|intercess|vigil|watch|fast/i, ['hands lifted in silhouette against a blazing sunrise with rays of light', 'a lone figure kneeling on a rock in a beam of light breaking through a night storm']],
  [/word|bible|study|scripture|teach/i, ['an ancient open book glowing with golden light on a stone table, light rays and dust', 'a lighthouse beam sweeping over a dark stormy sea at night']],
  [/glory|light|shine|radiant/i, ['blinding glory light bursting through parting storm clouds, golden rays', 'a cross of light standing on a hill as heavy clouds part above it']],
];
function themeArt(f) {
  const hay = [f.title, f.theme].filter(Boolean).join(' ');
  const hits = THEME_ART.filter(([rx]) => rx.test(hay)).flatMap(([, a]) => a);
  return hits;
}
const pick = (arr, n) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };
function directByRules(f) {
  const hay = [f.season, f.kind, f.title, f.theme, f.notes].filter(Boolean).join(' ');
  const r = RULES.find((x) => x.rx.test(hay)) || RULES[RULES.length - 1];
  let script = r.script;
  if (r === RULES[RULES.length - 1] && f.dayName) script = f.dayName;
  // the title's own idea first (key art), then the event's atmosphere
  const art = pick(themeArt(f), 3);
  const atmos = pick(r.scenes, 3).concat(pick(POOL.filter((p) => !r.scenes.includes(p)), 3));
  const scenes = art.concat(pick(atmos, 6 - art.length));
  return { scenes, themeScenes: art.length, palette: r.palette.slice(), scriptWord: script, kicker: r.kicker, looks: r.looks.slice() };
}

const HEX = /^#[0-9a-f]{6}$/i;
function clean(d, f) {
  const base = directByRules(f);
  if (!d || typeof d !== 'object') return Object.assign(base, { by: 'rules', looks: Array.from(new Set(base.looks.concat(LOOKS))) });
  const scenes = (Array.isArray(d.scenes) ? d.scenes : []).map((s) => String(s || '').trim().slice(0, 400)).filter((s) => s.length > 8).slice(0, 6);
  const palette = (Array.isArray(d.palette) ? d.palette : []).map((c) => String(c || '').trim()).filter((c) => HEX.test(c)).slice(0, 4);
  const looks = (Array.isArray(d.looks) ? d.looks : []).filter((l) => LOOKS.includes(l));
  return {
    // the AI's first three are its key art (DIRECTOR_SYSTEM)
    themeScenes: scenes.length >= 3 ? 3 : base.themeScenes,
    scenes: scenes.length ? Array.from(new Set(scenes.concat(base.scenes))).slice(0, 6) : base.scenes,
    palette: palette.length === 4 ? palette : base.palette,
    scriptWord: String(d.scriptWord || '').replace(/[^\p{L}' -]/gu, '').trim().slice(0, 14) || base.scriptWord,
    kicker: String(d.kicker || '').trim().slice(0, 32) || base.kicker,
    looks: Array.from(new Set(looks.concat(base.looks, LOOKS))),
  };
}

/*
 * THE PHOTO LIBRARY THE APP SHIPS WITH (src/renderer/assets/photos — real
 * Unsplash photographs: fire, light rays, stages, mountains, clouds). They are
 * on screen the moment Make is pressed, while the AI paints; and they are the
 * flyer's pictures on a day no painter can be reached. Each is described in a
 * few words, and the ones closest to the event are offered first.
 */
const PHOTO_DIR = path.join(__dirname, '..', 'renderer', 'assets', 'photos');
const PHOTO_TAGS = {
  'fire-flames.jpg': 'fire flame flames burn revival holy ghost pentecost power',
  'fire-embers.jpg': 'fire embers sparks burn revival night prayer power',
  'storm-fire-sky.jpg': 'fire sky storm dramatic warfare breakthrough power crusade',
  'storm-lightning.jpg': 'storm lightning power warfare thunder prophetic',
  'smoke-red.jpg': 'red smoke fire warfare breaking chains',
  'smoke-crimson.jpg': 'crimson red smoke blood cross good friday',
  'smoke-teal.jpg': 'teal smoke mist calm',
  'sky-rays.jpg': 'light rays heaven glory clouds sunday worship easter',
  'sky-rays-dark.jpg': 'light rays heaven dark clouds glory prayer',
  'clouds-gold.jpg': 'gold clouds heaven glory sunday thanksgiving',
  'clouds-dark-gold.jpg': 'dark gold clouds heaven glory prophetic',
  'glow-gold.jpg': 'gold glow light celebration thanksgiving',
  'bokeh-gold.jpg': 'gold bokeh lights celebration christmas thanksgiving anniversary',
  'bokeh-gold-rain.jpg': 'gold bokeh rain celebration christmas',
  'concert-fire-glow.jpg': 'concert stage worship night praise music crowd fire',
  'concert-gold.jpg': 'concert stage worship praise music crowd gold',
  'concert-neon.jpg': 'concert neon youth party praise music crowd',
  'party-confetti.jpg': 'party confetti youth celebration crossover new year',
  'worship-gold.jpg': 'worship hands raised praise sunday service gold',
  'worship-blue.jpg': 'worship hands raised praise night blue',
  'worship-sunset.jpg': 'worship sunset hands raised praise',
  'surrender-sunrise.jpg': 'surrender sunrise prayer worship retreat',
  'jesus-worship.jpg': 'worship jesus easter cross',
  'praying-hands.jpg': 'prayer praying hands intercession fasting',
  'bible-open.jpg': 'bible study word scripture teaching tuesday',
  'mountain-night.jpg': 'mountain night stars retreat experience prayer',
  'highlands-green.jpg': 'mountain green highlands retreat experience harvest',
  'stars-night.jpg': 'stars night vigil prayer watch',
  'stars-purple.jpg': 'stars purple night vigil worship',
  'galaxy.jpg': 'galaxy stars night prophetic glory',
  'royal-purple.jpg': 'royal purple glory sunday worship',
  'city-night.jpg': 'city night outreach crusade youth',
  'city-gold.jpg': 'city gold outreach conference',
  'rain-street.jpg': 'rain outpouring abundance',
  'soldiers-march.jpg': 'army soldiers warfare battle',
  'soldiers-ridge.jpg': 'army soldiers warfare conference',
  'soldier-watch.jpg': 'army soldier watch night warfare',
};
function stockPhotos(f, scenes) {
  // the event's own words count three times what the painter's scene words do
  const bag = (txt) => new Set(String(txt || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2));
  const own = bag([f.title, f.theme, f.kind, f.season, f.notes].filter(Boolean).join(' '));
  const scene = bag((scenes || []).join(' '));
  let have = [];
  try { have = fs.readdirSync(PHOTO_DIR).filter((n) => PHOTO_TAGS[n]); } catch (e) { return []; }
  // a photo's first word is what it IS (praying-hands: "prayer") — matching it counts most
  const scored = have.map((n) => { const tags = PHOTO_TAGS[n].split(' '); return { n, s: (own.has(tags[0]) ? 4 : 0) + tags.reduce((a, t) => a + (own.has(t) ? 3 : 0) + (scene.has(t) ? 1 : 0), 0) + Math.random() * 0.5 }; });
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 4).map((x) => x.n);
}
function stockPath(name) {
  if (!PHOTO_TAGS[name]) return '';
  const full = path.join(PHOTO_DIR, name);
  return fs.existsSync(full) ? full : '';
}

/*
 * ONE ART DIRECTION FOR AN EVENT, NOT A HUNDRED. When the whole church makes
 * flyers for Friday's prayer meeting, the writer is asked once; for a quarter
 * of an hour the same direction serves everyone (its scenes in a new order
 * each time — the pictures, the lights and the layouts make every board its
 * own). The free writers have limits too, and so does the allowance.
 */
const DIRECTED = new Map();
const directKey = (f) => bank.keyOf([f.title, f.theme, f.kind, f.season, f.dateText].join(' ')) + '|' + (f.speakers || []).map((x) => x && x.name).join(',');
/* a shared direction, for one more board: the same ideas, each set (key art, atmosphere) in a new order */
function directionFor(base, f) {
  const out = JSON.parse(JSON.stringify(base));
  const n = Math.min(out.themeScenes || 0, out.scenes.length);
  out.scenes = pick(out.scenes.slice(0, n), n).concat(pick(out.scenes.slice(n), out.scenes.length - n));
  return Object.assign(out, { photos: stockPhotos(f, out.scenes), shared: true });
}
async function directFresh(f) {
  const st = status();
  let d = null, by = 'rules';
  try {
    if (st.writer === 'claude') { d = await directWithClaude(f); by = 'claude'; }
  } catch (e) { d = null; }
  if (!d && (st.writer === 'groq' || st.writer === 'claude')) {
    try { d = await directWithGroq(f); by = 'groq'; } catch (e) { d = null; }
  }
  if (!d && st.cloudflare) {
    try { d = await directWithCloudflare(f); by = 'cloudflare'; } catch (e) { d = null; }
  }
  if (!d) by = 'rules';
  return Object.assign(clean(d, f), { by });
}
/** The event → what to paint and how it should look. Never throws: the rules are always there. */
async function direct(fields = {}) {
  const f = fields || {};
  const key = directKey(f), hit = DIRECTED.get(key);
  // the same event asked again within the quarter hour (or while it is being asked): one writer call serves all
  if (hit && Date.now() - hit.at < 15 * 60e3) {
    const base = await hit.p.catch(() => null);
    if (base) return directionFor(base, f);
  }
  const p = directFresh(f);
  const entry = { at: Date.now(), p: p.then((o) => (o.by === 'rules' ? null : o)) };
  entry.p.catch(() => {});
  DIRECTED.set(key, entry);
  if (DIRECTED.size > 200) DIRECTED.delete(DIRECTED.keys().next().value);
  const out = await p.catch(() => Object.assign(clean(null, f), { by: 'rules' }));
  if (out.by === 'rules') {
    if (DIRECTED.get(key) === entry) DIRECTED.delete(key);   // the rules are no writer's answer: the next one asks again
    const board = (readKit().inspo || []).filter((i) => (i.palette || []).length === 4);
    if (board.length && Math.random() < 0.6) out.palette = board[Math.floor(Math.random() * board.length)].palette.slice();
  }
  return Object.assign(JSON.parse(JSON.stringify(out)), { photos: stockPhotos(f, out.scenes) });
}

/* ------------------------------------------------------------- the kit */

/*
 * THE CHURCH'S FLYER KIT — what every flyer says and nobody should type twice:
 * the church's name and logo, the address, the phone and the handles, the
 * people who preach (each with their photo already cut out), and the week's
 * services (Tuesday Bible Study, Friday prayer meeting, Sunday service). Kept
 * on the server, so every phone of the media team has the same kit.
 */
let KIT_DIR = path.join(os.tmpdir(), 'mw-flyer-kit');
function init(userData) {
  KIT_DIR = path.join(userData, 'flyer-kit');
  // their own folders: the kit's tidy-up (kitSave) removes whatever in its folder is not the kit — it used to remove the ledger
  budget.init(path.join(userData, 'flyer-ai'), path.join(KIT_DIR, 'cf-allowance.json'));
  bank.init(path.join(userData, 'flyer-library'));
}
const kitFile = () => path.join(KIT_DIR, 'kit.json');

const DEFAULT_KIT = {
  church: '', logo: '', address: '', phone: '', handles: '', colour: '',
  speakers: [],
  services: [
    { id: 'sun', day: 0, name: 'Sunday Service', time: '10:00AM', kind: 'Sunday service' },
    { id: 'tue', day: 2, name: 'Bible Study', time: '7:00PM', kind: 'Bible study' },
    { id: 'fri', day: 5, name: 'Prayer Meeting', time: '7:00PM', kind: 'Prayer meeting' },
  ],
};

function readKit() {
  try { return Object.assign({}, DEFAULT_KIT, JSON.parse(fs.readFileSync(kitFile(), 'utf8'))); } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_KIT)); }
}

/* A picture in the kit is a file next to kit.json; the phone gets it back as a data URL. */
function picIn(name) {
  if (!name || /[\\/]/.test(name)) return '';
  try {
    const buf = fs.readFileSync(path.join(KIT_DIR, name));
    const mime = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) { return ''; }
}
function picOut(dataUrl, stem) {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return '';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) throw new Error('That picture is too big (over 6 MB).');
  fs.mkdirSync(KIT_DIR, { recursive: true });
  const name = `${String(stem || 'pic').replace(/[^\w-]+/g, '_').slice(0, 30)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()}`;
  fs.writeFileSync(path.join(KIT_DIR, name), buf);
  return name;
}

const str = (v, n) => String(v == null ? '' : v).slice(0, n || 200);
const safeName = (n) => (typeof n === 'string' && /^[\w-]+\.(png|jpg|webp)$/i.test(n) ? n : '');

/* a speaker's picture bank: their file names (an older kit had one `photo`) */
const photosOf = (s) => (Array.isArray(s.photos) ? s.photos : s.photo ? [s.photo] : []).map(safeName).filter(Boolean);

/*
 * The kit itself is small: names and file names. The pictures come one at a
 * time (kitPic), when the phone draws them — a church with six preachers and
 * a bank of ten photos each would otherwise send 20 MB every time it opened.
 */
function kitGet() {
  const k = readKit();
  return Object.assign({}, k, {
    logoUrl: picIn(k.logo),
    speakers: (k.speakers || []).map((s) => ({ id: s.id, name: s.name || '', role: s.role || '', photos: photosOf(s), last: s.last || '' })),
    inspo: (k.inspo || []).map((i) => ({ id: i.id, thumb: i.thumb, palette: i.palette || [], notes: i.notes || '', look: i.look || '' })),
  });
}
function kitPic(name) {
  const n = safeName(name);
  if (!n) throw new Error('No such picture.');
  const url = picIn(n);
  if (!url) throw new Error('That picture is no longer in the kit.');
  return url;
}

/**
 * Save the kit. A picture that is new comes as a data URL (the logo as
 * `logoUrl`, a speaker's in `photos`); one already kept comes as its file name.
 */
function kitSave(next = {}) {
  const old = readKit();
  const k = {
    church: str(next.church, 120), address: str(next.address, 240), phone: str(next.phone, 80),
    handles: str(next.handles, 120), colour: HEX.test(next.colour || '') ? next.colour : '',
    logo: old.logo, speakers: [], services: [], inspo: old.inspo || [],
  };
  if (next.logoUrl === '') k.logo = '';
  else if (/^data:image\//.test(next.logoUrl || '') && next.logoUrl !== picIn(old.logo)) k.logo = picOut(next.logoUrl, 'logo');
  for (const s of (Array.isArray(next.speakers) ? next.speakers : []).slice(0, 40)) {
    const id = str(s.id, 40) || 'sp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const photos = [];
    for (const p of (Array.isArray(s.photos) ? s.photos : []).slice(0, 40)) {
      if (/^data:image\//.test(p || '')) photos.push(picOut(p, 'speaker'));
      else if (safeName(p) && fs.existsSync(path.join(KIT_DIR, p))) photos.push(p);
    }
    // (an older phone sends one new photo as photoUrl)
    if (/^data:image\//.test(s.photoUrl || '')) photos.unshift(picOut(s.photoUrl, 'speaker'));
    k.speakers.push({ id, name: str(s.name, 80), role: str(s.role, 60), photos: photos.filter(Boolean), last: safeName(s.last) });
  }
  for (const s of (Array.isArray(next.services) ? next.services : []).slice(0, 14)) {
    const day = Math.round(+s.day);
    if (!(day >= 0 && day <= 6) || !s.name) continue;
    k.services.push({ id: str(s.id, 40) || 'sv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), day, name: str(s.name, 60), time: str(s.time, 40), kind: str(s.kind, 60), speaker: str(s.speaker, 40), venue: str(s.venue, 200) });
  }
  /*
   * PRESETS — the details a church types again and again (WORD STUDY, 7PM, the
   * hall's address, who preaches), saved under a name and put back with one
   * tap; and what was last typed for each service, filled in by itself.
   */
  const fieldsOf = (f) => {
    const o = {};
    for (const key of ['title', 'theme', 'time', 'time2', 'venue', 'extra', 'phone', 'handles', 'notes']) if (f && f[key] != null) o[key] = str(f[key], key === 'notes' ? 400 : 200);
    return o;
  };
  const presetOf = (p) => ({ fields: fieldsOf(p.fields), speakers: (Array.isArray(p.speakers) ? p.speakers : []).map((x) => str(x, 40)).slice(0, 8), size: str(p.size, 20) });
  k.presets = (Array.isArray(next.presets) ? next.presets : old.presets || []).slice(0, 40)
    .filter((p) => p && p.name).map((p) => Object.assign({ id: str(p.id, 40) || 'pr' + Date.now().toString(36), name: str(p.name, 60) }, presetOf(p)));
  const lastIn = next.lastFor && typeof next.lastFor === 'object' ? next.lastFor : old.lastFor || {};
  k.lastFor = {};
  for (const key of Object.keys(lastIn).slice(-30)) if (/^[\w:.-]{1,60}$/.test(key) && lastIn[key]) k.lastFor[key] = presetOf(lastIn[key]);
  // tidy: pictures no longer in the kit go
  const keep = new Set([k.logo].concat(...k.speakers.map((s) => s.photos), k.inspo.map((i) => i.thumb)).filter(Boolean));
  try { for (const n of fs.readdirSync(KIT_DIR)) if (n !== 'kit.json' && !keep.has(n)) fs.unlinkSync(path.join(KIT_DIR, n)); } catch (e) { /* none yet */ }
  fs.mkdirSync(KIT_DIR, { recursive: true });
  fs.writeFileSync(kitFile(), JSON.stringify(k, null, 1));
  return kitGet();
}

/*
 * ►► THE INSPIRATION BOARD. ◄◄ "Search Pinterest by itself every week" is the
 * one thing this cannot do honestly: Pinterest has no public search API for
 * apps like this, and its terms forbid robots reading its pages. So the board
 * is fed the way designers feed theirs — a screenshot of a flyer someone loved
 * — and each is read once: its colours (worked out on the phone) and, when the
 * server has Claude, a few lines on what makes it work (the title treatment,
 * the layout, the picture). The art director reads the board before every
 * flyer, so the church's taste steers every design that follows.
 */
const INSPO_MAX = 60;
async function inspoNotes(dataUrl) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const Client = Anthropic.default || Anthropic;
  const client = new Client({ maxRetries: 1, timeout: 90 * 1000 });
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      notes: { type: 'string', description: 'Two sentences: what makes this flyer striking — the title lettering, the layout, the picture, the colours.' },
      look: { type: 'string', enum: LOOKS },
      scene: { type: 'string', description: 'The background picture in one sentence, as a prompt for an image model (no people close up, no text).' },
      palette: { type: 'array', items: { type: 'string' } },
    },
    required: ['notes', 'look', 'scene', 'palette'],
  };
  const res = await client.messages.create({
    model: process.env.MW_FLYER_MODEL || 'claude-opus-5-5',
    max_tokens: 2000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: 'You study church event flyers for a design team. Describe the design of the flyer you are shown so it can inspire new ones. Never copy its words, names or dates.',
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: m[1].toLowerCase(), data: m[2] } },
      { type: 'text', text: 'What makes this flyer work? Which of the layouts is it closest to? Describe its background picture, and give its four main colours as hex (deep, mid, accent, highlight).' },
    ] }],
  });
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const j = JSON.parse(text);
  return { notes: String(j.notes || '').slice(0, 400), look: LOOKS.includes(j.look) ? j.look : '', scene: String(j.scene || '').slice(0, 300), palette: (j.palette || []).filter((c) => HEX.test(c)).slice(0, 4) };
}

/** Add a flyer to the board: { thumb (small JPEG), image (for the reader), palette (from the phone) } */
async function inspoAdd({ thumb, image, palette } = {}) {
  const k = readKit();
  const name = picOut(thumb, 'inspo');
  if (!name) throw new Error('That is not a picture.');
  let read = null;
  try { read = await inspoNotes(image || thumb); } catch (e) { read = null; }
  const pal = (read && read.palette.length === 4 ? read.palette : (Array.isArray(palette) ? palette : []).filter((c) => HEX.test(c)).slice(0, 4));
  const item = { id: 'in' + Date.now().toString(36), thumb: name, palette: pal, notes: read ? read.notes : '', look: read ? read.look : '', scene: read ? read.scene : '', at: new Date().toISOString() };
  k.inspo = [item].concat(k.inspo || []).slice(0, INSPO_MAX);
  writeKit(k);
  return item;
}
function inspoRemove({ id } = {}) {
  const k = readKit();
  const it = (k.inspo || []).find((x) => x.id === id);
  k.inspo = (k.inspo || []).filter((x) => x.id !== id);
  if (it && safeName(it.thumb)) { try { fs.unlinkSync(path.join(KIT_DIR, it.thumb)); } catch (e) { /* gone */ } }
  writeKit(k);
  return true;
}
function writeKit(k) { fs.mkdirSync(KIT_DIR, { recursive: true }); fs.writeFileSync(kitFile(), JSON.stringify(k, null, 1)); }

/*
 * ONE PICTURE INTO A SPEAKER'S BANK. A bulk add sends each photo as it is cut
 * out — thirty cut-outs in a single save would be a request of 60 MB, and one
 * that fails would lose them all.
 */
function kitAddPhoto({ speaker, dataUrl, name } = {}) {
  const k = readKit();
  let s = (k.speakers || []).find((x) => x.id === speaker);
  if (!s) {
    if (!speaker || !name) throw new Error('That speaker is not in the kit.');
    s = { id: str(speaker, 40), name: str(name, 80), role: '', photos: [] };
    k.speakers = (k.speakers || []).concat(s);
  }
  const file = picOut(dataUrl, 'speaker');
  if (!file) throw new Error('That is not a picture.');
  s.photos = photosOf(s).concat(file).slice(-40);
  delete s.photo;
  writeKit(k);
  return file;
}

/* Which of a speaker's pictures a flyer used last — the next flyer starts from the one after it. */
function kitUsed({ speaker, photo } = {}) {
  const k = readKit();
  const s = (k.speakers || []).find((x) => x.id === speaker);
  if (!s || !safeName(photo)) return false;
  s.last = photo;
  fs.mkdirSync(KIT_DIR, { recursive: true });
  fs.writeFileSync(kitFile(), JSON.stringify(k, null, 1));
  return true;
}

/*
 * ►► THE NIGHT FILLER: NOTHING OF THE DAY GOES TO WASTE. ◄◄ The allowance
 * does not carry over — what is not painted by midnight UTC is simply lost. So
 * in the last hours of the day (from 21:00 UTC, keeping a little back for late
 * flyers until 23:00) whatever is left paints for the church's LIBRARY: first
 * the titles people asked to have AI-lettered and could not (read back, spelt
 * right — or not kept), then the pictures people asked for most that the
 * library has fewest of, from the very requests they made. And just after the
 * reset, a little of the new day readies the library for the services of the
 * next two days (the kit's week). Runs inside the server, every ten minutes.
 */
let fillerTimer = null, filling = false, prewarmed = { day: '', spent: 0 };
function startFiller() {
  if (fillerTimer) return;
  // a tick a minute after boot (a server restarted often still fills), then every ten minutes after each one ends
  const next = (ms) => { fillerTimer = setTimeout(async () => { try { await fillerTick(); } catch (e) { /* never the server's end */ } if (fillerTimer) next(10 * 60e3); }, ms); if (fillerTimer.unref) fillerTimer.unref(); };
  next(60e3);
}
function stopFiller() { if (fillerTimer) clearTimeout(fillerTimer); fillerTimer = null; }
async function fillerTick(now = Date.now(), opts = {}) {
  if (filling || !(cfAccount() && cfToken()) || cfPaid()) return { painted: 0, letters: 0, why: 'not now' };
  filling = true;
  try {
    const d = new Date(now), mins = d.getUTCHours() * 60 + d.getUTCMinutes(), day = d.toISOString().slice(0, 10);
    let room = 0, mode = '';
    if (mins >= 23 * 60 + 55) return { painted: 0, letters: 0, why: 'too near midnight' };   // nothing started that would cross it
    if (mins >= 21 * 60) { room = budget.hardLeft() - (mins < 23 * 60 ? 1500 : 0); mode = 'end of day'; }
    else if (mins < 6 * 60) {
      if (prewarmed.day !== day) prewarmed = { day, spent: 0 };
      // a little of the new day: at most 15% of it, and never more than half of what the pace has released
      room = Math.min(budget.available() / 2, budget.DAY() * 0.15 - prewarmed.spent); mode = 'morning';
    }
    if (room < 160) return { painted: 0, letters: 0, why: 'no room' };
    const usersWaiting = () => budget.report(budget.LIBRARY).queueUsers > 0 || (Date.now() - now > 9 * 60e3);
    const max = opts.max || 8;
    let painted = 0, letters = 0, spentHere = 0;
    const L = budget.LIBRARY;
    const asLibrary = (fn) => space.run(null, fn, L);
    const spentNow = () => budget.report(L).spent;
    const want = bank.wanted();
    // 1. letterings asked for and not had (only with the reader to check them: a misspelling is never kept)
    let cs = null; try { cs = require('./cloudsee'); } catch (e) { cs = null; }
    if (mode === 'end of day' && cs && cs.ready && cs.ready()) {
      for (const t of want.titles) {
        if (usersWaiting() || painted + letters >= max || room - spentHere < neuronsFor(CF_PHOENIX, { w: 832, h: 1024 }) * 2) break;
        const before = spentNow();
        try { const r = await asLibrary(() => paintTitle({ title: t.title, scene: t.scene, fresh: true })); if (r) letters++; } catch (e) { /* the next */ }
        spentHere += Math.max(0, spentNow() - before);
      }
    }
    // 2. the pictures people asked for most, of which the library has fewest
    const jobs = want.slots.filter((x) => x.have < 6).map((x) => x.recipe);
    // the morning: the services of the next two days, from what was asked for them before (or the rules' scenes)
    if (mode === 'morning') {
      const kit = readKit(), soon = [d.getUTCDay(), (d.getUTCDay() + 1) % 7, (d.getUTCDay() + 2) % 7];
      const kinds = new Set((kit.services || []).filter((sv) => soon.includes(sv.day)).map((sv) => kindKey({ title: sv.name, kind: sv.kind })));
      jobs.sort((a, b) => (kinds.has(b.kind) ? 1 : 0) - (kinds.has(a.kind) ? 1 : 0));
      for (const k of kinds) {
        if (jobs.some((r) => r.kind === k)) continue;
        const sv = (kit.services || []).find((x) => kindKey({ title: x.name, kind: x.kind }) === k);
        const scenes = directByRules({ title: sv ? sv.name : k, kind: sv ? sv.kind : k }).scenes.slice(0, 2);
        scenes.forEach((sc) => jobs.push({ scene: sc, w: 1080, h: 1350, people: true, theme: false, kind: k, tone: 'own', shape: 'post' }));
      }
    }
    for (const r of jobs) {
      if (usersWaiting() || painted + letters >= max || room - spentHere < 200) break;   // people first, always
      const before = spentNow();
      try {
        const out = await asLibrary(() => paintFor(r));
        if (out) painted++;
      } catch (e) { if (/allowance|resting/i.test(e.message)) break; }
      spentHere += Math.max(0, spentNow() - before);
    }
    if (mode === 'morning') prewarmed.spent += spentHere;
    return { painted, letters, mode, spent: spentHere };
  } finally { filling = false; }
}
/* one library picture from a recorded request (the light's words are already in its scene) */
async function paintFor(r) {
  const size = sizeFor(r.w, r.h);
  const prompt = paintPrompt(r.scene, { people: r.people !== false, theme: !!r.theme });
  const o = await paintCloudflare(prompt, size, Math.floor(Math.random() * 1e9), null, 'normal', null, { who: budget.LIBRARY });
  return bank.add(o.buf, o.mime, { kind: r.kind, theme: r.themeText || '', tone: r.tone, shape: r.shape || bank.shapeOf(size.w, size.h), tier: 'normal', by: o.by, people: r.people !== false, prompt: r.scene }, null);
}

const libraryPath = (name) => bank.filePath(name);
module.exports = { libraryPath, startFiller, stopFiller, fillerTick, kindKey, paintTitle, titlePrompt, neuronsFor, cfDiagnose, paintWith, paintWithPrompt, kitAddPhoto, inspoAdd, inspoRemove, stockPhotos, stockPath, PHOTO_TAGS, status, paint, direct, init, kitGet, kitSave, kitPic, kitUsed, paintPrompt, sizeFor, directByRules, imageFrom, LOOKS };
