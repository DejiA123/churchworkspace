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

const env = (...names) => { for (const n of names) { const v = String(process.env[n] || '').trim(); if (v) return v; } return ''; };
const cfAccount = () => env('CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID');
const cfToken = () => env('CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_AI_TOKEN');
const polKey = () => env('POLLINATIONS_API_KEY', 'POLLINATIONS_TOKEN');

/* Cloudflare's models, best first. `form`: the FLUX.2 family takes multipart form fields, even for a prompt alone. */
const CF_MODELS = [
  { id: '@cf/black-forest-labs/flux-2-klein-4b', name: 'FLUX.2', form: true },
  { id: '@cf/black-forest-labs/flux-1-schnell', name: 'FLUX.1', form: false },
];
// a model that refused (not on this account, a changed name) is skipped for a while, not asked every time
const benched = new Map();
const benchedNow = (id) => (benched.get(id) || 0) > Date.now();

function status() {
  const cf = !!(cfAccount() && cfToken());
  let writer = 'rules';
  if (process.env.ANTHROPIC_API_KEY) writer = 'claude';
  else { try { const cw = require('./cloudwrite'); if (cw.access && cw.access().key) writer = 'groq'; } catch (e) { /* none */ } }
  return {
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
function paintPrompt(scene, opts = {}) {
  const people = opts.people ? 'no people in the foreground (the speakers are added later), ' : '';
  return [
    String(scene || 'dramatic heavenly light rays breaking through clouds').slice(0, 600),
    'premium church event flyer background, cinematic, high contrast, rich saturated colour grading, dramatic volumetric lighting, depth, bokeh, ultra detailed, 8k, professional graphic design backdrop',
    people + 'clean open space in the upper half for a big headline',
    NO_TEXT,
  ].join(', ');
}

function sizeFor(w, h) {
  // multiples of 64 the models like, as big as they paint well (about 1.5 megapixels): the flyer is HD
  const ar = (+w || 4) / (+h || 5);
  let W = 1088, H = Math.round(W / ar);
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

async function paintCloudflare(prompt, size, seed) {
  const errs = [];
  for (const m of CF_MODELS) {
    if (benchedNow(m.id)) continue;
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfAccount())}/ai/run/${m.id}`;
    const headers = { authorization: `Bearer ${cfToken()}` };
    let body;
    if (m.form) {
      body = new FormData();
      body.append('prompt', prompt);
      body.append('width', String(size.w));
      body.append('height', String(size.h));
      if (seed != null) body.append('seed', String(seed));
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({ prompt: prompt.slice(0, 2000), steps: 8, seed });
    }
    try {
      const res = await fetchTimed(url, { method: 'POST', headers, body }, 120000);
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('the Cloudflare token was refused — it needs “Workers AI: Read”'), { fatal: true });
      if (res.status === 429) throw Object.assign(new Error('today’s free Cloudflare allowance is used up (it comes back at 01:00)'), { fatal: true });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        if (res.status === 400 || res.status === 404) benched.set(m.id, Date.now() + 6 * 3600e3);
        throw new Error(`${m.name}: ${res.status} ${t.slice(0, 160)}`);
      }
      const out = await imageFrom(res);
      return Object.assign(out, { by: m.name + ' · Cloudflare' });
    } catch (e) {
      errs.push(e.message);
      if (e.fatal) throw e;
    }
  }
  throw new Error(errs.join('; ') || 'Cloudflare painted nothing');
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
      const res = await fetchTimed(t.url, { headers: t.headers }, 120000);
      if (!res.ok) { errs.push(`${res.status}`); continue; }
      const out = await imageFrom(res);
      if (out.buf.length < 8000) { errs.push('an empty picture'); continue; }
      return Object.assign(out, { by: 'FLUX · Pollinations' });
    } catch (e) { errs.push(e.message); }
  }
  throw new Error('Pollinations did not paint (' + errs.join(', ') + ')');
}

/**
 * Paint one background. → { dataUrl, by, prompt } — or throws with a plain
 * sentence the phone can show (the phone then paints its own).
 */
async function paint({ scene, w = 1080, h = 1350, seed, people = true } = {}) {
  const prompt = paintPrompt(scene, { people });
  const size = sizeFor(w, h);
  const s = Number.isFinite(+seed) ? Math.abs(Math.round(+seed)) % 2147483647 : Math.floor(Math.random() * 1e9);
  let out = null;
  const errs = [];
  if (cfAccount() && cfToken()) {
    try { out = await paintCloudflare(prompt, size, s); } catch (e) { errs.push(e.message); }
  }
  if (!out) {
    try { out = await paintPollinations(prompt, size, s); } catch (e) { errs.push(e.message); }
  }
  if (!out) throw new Error(errs.join(' · ') || 'no painter could be reached');
  return { dataUrl: `data:${out.mime};base64,${out.buf.toString('base64')}`, by: out.by, prompt, seed: s };
}

/* --------------------------------------------------------- art direction */

const LOOKS = ['slab', 'giant', 'lineup', 'presents', 'script', 'joinus', 'breakthrough', 'torn', 'scenic', 'themebox'];

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
- scenes: THREE different background pictures for an image model to paint behind the flyer. Each is one vivid sentence describing only the scenery and light (e.g. "golden heavenly light rays bursting through purple storm clouds over a misty mountain range at dawn", "an energetic worship concert stage with blue and magenta spotlights, haze and confetti, crowd silhouettes with raised hands far in the distance", "broken iron chains floating against a glowing sunrise sky over the sea"). Match the event's theme and season (Easter: empty tomb at sunrise, three crosses on a hill; Christmas: warm golden bokeh, star over Bethlehem; prayer: candlelight, kneeling silhouette; Bible study: open Bible with glowing pages). Never ask for text, letters, logos or faces close up.
- palette: four hex colours that will grade the picture and colour the type (deep, mid, accent, highlight). Bold and saturated: purple & gold, royal blue & white, crimson & gold, teal & lime, magenta & cyan.
- scriptWord: one word for flowing script lettering across the speaker, usually the service day or the heart of the theme.
- kicker: a short uppercase line above the title.
- looks: the layouts that fit best, best first, from: slab (a bold yellow slab-serif title, a red JOIN US tab, the pastor under a round 'with PASTOR' badge — Bible study, midweek, a named service), giant (the title in two or three enormous stacked lines filling the flyer, the minister in front, a date | time | venue row — PUSH, PROPHETIC PRAYER MEETING, 6 HOURS PRAYER WATCH), lineup (several ministers in a row with their names, a gold title under them — concerts, conventions, harvest nights), presents (one minister in the middle, "PRESENTS" at the top, a bold title across him — miracle service, special service), script (a big script word over the pastor, like a Sunday service flyer), joinus (huge stacked JOIN US THIS SUNDAY with speakers below and a slanted info band), breakthrough (giant textured 3D title for a conference/crusade, light background), torn (black-and-white photo with torn paper strip, modern), scenic (italic gradient title over a landscape, retreat/experience), themebox (theme in a black ragged box with serif lettering, prayer retreat/programme).
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

async function directWithGroq(f) {
  const cw = require('./cloudwrite');
  const text = await cw.chat({
    system: DIRECTOR_SYSTEM + '\nJSON keys: scenes (array of 3 strings), palette (array of 4 hex strings), scriptWord, kicker, looks (array).',
    prompt: fieldsText(f), json: true, maxTokens: 900, temperature: 0.9, evenIfOff: true, timeoutMs: 25000,
  });
  return text ? cw.parseJson(text) : null;
}

/* The rules, for a server with no writer: the season and the kind of service pick the picture. */
const RULES = [
  { rx: /easter|resurrection|risen|good\s*friday|palm\s*sunday|calvary|cross/i, scenes: ['three wooden crosses on a hill silhouetted against a glowing golden sunrise with god rays through clouds', 'the empty stone tomb with the stone rolled away, brilliant white light pouring out at dawn, lilies', 'a radiant sunrise over green hills with heavenly beams of light and soft white doves'], palette: ['#2a0d45', '#6b2fa3', '#f6c343', '#ffffff'], script: 'Easter', kicker: 'CELEBRATE WITH US', looks: ['script', 'scenic', 'themebox'] },
  { rx: /christmas|carol|nativity|advent/i, scenes: ['warm golden christmas bokeh lights with a bright star shining over bethlehem at night', 'a glowing nativity star above a desert night sky, deep blue and gold, sparkles', 'luxurious red and gold christmas ornaments and soft bokeh, cinematic'], palette: ['#2b0306', '#8d0f1f', '#f5c84c', '#ffffff'], script: 'Christmas', kicker: 'JOIN US FOR', looks: ['script', 'breakthrough', 'themebox'] },
  { rx: /crossover|new\s*year|watch\s*night|31st|countdown/i, scenes: ['spectacular golden fireworks over a city skyline at midnight with sparkles', 'a glowing clock and golden confetti bursting in dark blue space', 'heavenly gate of light opening in the night sky with golden sparks'], palette: ['#05081a', '#1a2a6b', '#f2c14e', '#ffffff'], script: 'Crossover', kicker: 'CROSS OVER WITH US', looks: ['joinus', 'breakthrough', 'script'] },
  { rx: /prayer|pray|vigil|intercess|fasting|night\s*of/i, scenes: ['a silhouette kneeling in prayer on a mountain top under a starry sky with a beam of light from heaven', 'hundreds of warm candles glowing in a dark sanctuary, soft smoke, golden light', 'broken iron chains falling apart against a fiery sunrise sky, sparks'], palette: ['#0a0716', '#3b1670', '#ff9d2e', '#ffffff'], script: 'Prayer', kicker: 'A NIGHT OF', looks: ['giant', 'themebox', 'scenic'] },
  { rx: /bible\s*stud|word|scripture|teaching|midweek|tuesday/i, scenes: ['an open bible with glowing golden pages and light rising from it on a wooden table, dark background', 'ancient scrolls and an open bible under a single shaft of heavenly light, dust particles', 'a lamp shining on an open bible, warm amber light and deep blue shadows'], palette: ['#071022', '#123a6b', '#eec158', '#ffffff'], script: 'Word', kicker: 'DIGGING DEEPER', looks: ['slab', 'scenic', 'themebox'] },
  { rx: /youth|teen|campus|student|party|jam/i, scenes: ['an energetic concert stage with neon magenta and cyan lights, haze, confetti', 'colourful neon light trails and lens flares on a dark purple background', 'a festival crowd with raised hands silhouetted against bright stage lights'], palette: ['#120429', '#5b1bb5', '#ff2fd6', '#19e0ff'], script: 'Vibes', kicker: 'IT’S A', looks: ['joinus', 'torn', 'breakthrough'] },
  { rx: /conference|crusade|revival|convention|summit|breakthrough|retreat|camp/i, scenes: ['a vast crowd with hands raised under blinding stage lights and golden god rays', 'fire and golden sparks rising against a dramatic dark red sky', 'majestic misty mountains at sunrise with rays of light breaking through clouds'], palette: ['#1a0303', '#7a1414', '#f5a623', '#ffffff'], script: 'Glory', kicker: '2026', looks: ['giant', 'lineup', 'breakthrough'] },
  { rx: /thanksgiving|anniversary|harvest|birthday|celebrat/i, scenes: ['golden confetti and balloons with warm bokeh lights, celebration', 'elegant gold and purple abstract light waves with sparkles', 'golden wheat field at sunset with warm sunbeams'], palette: ['#1a0b2e', '#4b1d7a', '#f2c94c', '#ffffff'], script: 'Thanksgiving', kicker: 'COME CELEBRATE', looks: ['script', 'breakthrough', 'joinus'] },
  { rx: /worship|praise|sunday|service|.*/i, scenes: ['heavenly golden light rays bursting through dramatic purple and blue clouds', 'a worship concert stage with blue spotlights and haze, crowd silhouettes with raised hands', 'soft glowing bokeh lights and lens flare in royal purple and gold'], palette: ['#1a0638', '#5b21b6', '#f5c542', '#ffffff'], script: 'Sunday', kicker: 'WORSHIP WITH US THIS', looks: ['script', 'joinus', 'presents'] },
];

function directByRules(f) {
  const hay = [f.season, f.kind, f.title, f.theme, f.notes].filter(Boolean).join(' ');
  const r = RULES.find((x) => x.rx.test(hay)) || RULES[RULES.length - 1];
  let script = r.script;
  if (r === RULES[RULES.length - 1] && f.dayName) script = f.dayName;
  return { scenes: r.scenes.slice(), palette: r.palette.slice(), scriptWord: script, kicker: r.kicker, looks: r.looks.slice() };
}

const HEX = /^#[0-9a-f]{6}$/i;
function clean(d, f) {
  const base = directByRules(f);
  if (!d || typeof d !== 'object') return Object.assign(base, { by: 'rules', looks: Array.from(new Set(base.looks.concat(LOOKS))) });
  const scenes = (Array.isArray(d.scenes) ? d.scenes : []).map((s) => String(s || '').trim()).filter((s) => s.length > 8).slice(0, 3);
  const palette = (Array.isArray(d.palette) ? d.palette : []).map((c) => String(c || '').trim()).filter((c) => HEX.test(c)).slice(0, 4);
  const looks = (Array.isArray(d.looks) ? d.looks : []).filter((l) => LOOKS.includes(l));
  return {
    scenes: scenes.length ? scenes.concat(base.scenes).slice(0, 3) : base.scenes,
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

/** The event → what to paint and how it should look. Never throws: the rules are always there. */
async function direct(fields = {}) {
  const f = fields || {};
  const st = status();
  let d = null, by = 'rules';
  try {
    if (st.writer === 'claude') { d = await directWithClaude(f); by = 'claude'; }
  } catch (e) { d = null; }
  if (!d && (st.writer === 'groq' || st.writer === 'claude')) {
    try { d = await directWithGroq(f); by = 'groq'; } catch (e) { d = null; }
  }
  if (!d) by = 'rules';
  const out = clean(d, f);
  if (by === 'rules') {
    const board = (readKit().inspo || []).filter((i) => (i.palette || []).length === 4);
    if (board.length && Math.random() < 0.6) out.palette = board[Math.floor(Math.random() * board.length)].palette.slice();
  }
  return Object.assign(out, { by, photos: stockPhotos(f, out.scenes) });
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
function init(userData) { KIT_DIR = path.join(userData, 'flyer-kit'); }
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

module.exports = { inspoAdd, inspoRemove, stockPhotos, stockPath, PHOTO_TAGS, status, paint, direct, init, kitGet, kitSave, kitPic, kitUsed, paintPrompt, sizeFor, directByRules, imageFrom, LOOKS };
