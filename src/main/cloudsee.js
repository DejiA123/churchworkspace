'use strict';
/*
 * ►► THE REFRAME'S EYE — "WHICH ONE OF THESE IS PREACHING?" ◄◄
 *
 * WHY THIS EXISTS.
 *
 * Auto-reframe on this PC finds people well: a face model, a body model, a
 * second look at heads it missed. Where it goes wrong is the question after
 * that — WHICH of the people it found is the one the short is about. It answers
 * from colour signatures, mouth movement and screen time, and on a church
 * platform those are fooled again and again: the crozier-bearer standing still
 * in a cream suit, congregation heads in the foreground of a wide shot, a man
 * walking past the lens, a face printed on the backdrop. The operator's verdict
 * was "the reframe is kinda shocking".
 *
 * A vision model answers that question the way a person would — it sees who is
 * holding the microphone and addressing the room.
 *
 * HOW IT IS ASKED, and the two ways that were measured and dropped, all on
 * frames from the church's own "Time of Prayers" service:
 *
 *   • "Where is the man holding the microphone?" as coordinates: his face put
 *     at y = 0.10 when it is at 0.18, x a tenth of the frame out. Estimating
 *     a number is not what these models are good at.
 *   • A numbered box round every person the PC detected, "which box?": right
 *     on hand-drawn boxes, wrong on the real ones — with the preacher hidden
 *     it chose a "face" the detector had found on the backdrop lettering, and
 *     with him too small to detect it chose the box nearest him. Asked to pick
 *     from a list, it picks from the list.
 *   • Each frame ruled into eight numbered COLUMNS, "which column is the
 *     speaker's head in, or 0": over twelve real frames never once on the
 *     wrong person — exact in ten, one column out on a boundary, one cautious
 *     "cannot see him". That is the question asked — with one more rule,
 *     learned on "Thanksgiving Sunday": with a man AND a woman both holding
 *     microphones it chose the woman, who was smiling in the middle of the
 *     stage, in three frames running while the man at the pulpit was the one
 *     talking. Told that the speaker is whoever is talking IN THAT FRAME (mic
 *     at the mouth, mid-word), and to answer 0 when it cannot tell between
 *     two, it answers 0 there — and the PC's own pick, which was right,
 *     stands. The PC then snaps the
 *     answer to the person it detected in that column, so the crop keeps the
 *     detectors' pixel precision (see THE REFEREE in facetrack.js).
 *
 * WHY ONE GRID PICTURE, NOT ONE PICTURE PER FRAME. Measured on the free Groq
 * account: the vision model takes at most THREE pictures per request, and every
 * picture is costed at about 2,100 tokens BEFORE it is looked at, against an
 * allowance of 7,000 input tokens a minute — three frames a minute. Six frames
 * tiled into one 896-wide picture cost ~1,000-1,500 tokens and come back in
 * 0.2 s, with the same answers. A short needs one or two of these.
 *
 * THE KEY. There is no new key. It is the account the caption writer and 🎤
 * Listen already use (cloudwrite.access()), so a church that set up either has
 * set this up too.
 *
 * NOTHING HERE IS FATAL. Every failure is an answer of `{ ok: false, why }`,
 * and the tracker carries on exactly as it did before this existed — but the
 * studio SAYS so. A fallback nobody can see is how the caption writer ran on
 * templates for a month without anyone knowing (see cloudwrite.js).
 */
const cloudwrite = require('./cloudwrite');

/* Vision models, best first, per provider. A PREFERENCE: intersected with what
 * the account really has (GET /models), and walked when one says it cannot see. */
const VISION = {
  groq: ['qwen/qwen3.8-27b', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct'],
  openai: ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4o'],
  openrouter: ['google/gemini-2.5-flash', 'openai/gpt-4.1-mini', 'qwen/qwen2.5-vl-72b-instruct', 'meta-llama/llama-4-maverick'],
  custom: [],
};
/* Names that are worth a try when nothing preferred is there any more. */
const LOOKS_VISUAL = /vl\b|vision|llama-4|qwen3\.[5-9]|qwen3\.\d+-\d+b|gemma-3|gemma-4|pixtral|gpt-4o|gpt-4\.1|gemini/i;
/* Errors that mean "this model does not take pictures" or "is not there".
 * Narrow on purpose: Groq's "Too many images provided" also says "image", and
 * that one is OUR mistake — reading it as "cannot see" would blacklist the only
 * vision model the free account has. */
const CANT_SEE = /(does not|doesn't) support (image|vision|multimodal)|(image|vision|multimodal)[^.]{0,30}not (supported|available|enabled)|not a (vision|multimodal) model|content must be a string|image_url is only supported/i;
const OUR_FAULT = /too many images|image (is )?too large|too big|exceeds|maximum/i;
const GONE = /model_not_found|model_decommissioned|does not exist|decommissioned|no endpoints found|is not a valid model/i;

/* What a particular model needs asking differently. Qwen 3 on Groq thinks out
 * loud unless told not to, and a picture-picking question needs no thinking. */
const TUNE = [
  [/qwen3/i, { reasoning_effort: 'none' }],
  [/gpt-oss|^o[134](-|$)|^gpt-5/i, { reasoning_effort: 'low' }],
];
const tuneFor = (m) => TUNE.reduce((o, [rx, x]) => (rx.test(m) ? Object.assign(o, x) : o), {});

const health = { asked: 0, ok: 0, failed: 0, why: '', model: '', lastMs: 0, lastAt: 0 };
const blocked = new Map();   // model -> until (out of allowance, or cannot see)
const blockedWhy = new Map(); // model -> what to tell the operator while it is parked
let seen = { at: 0, provider: '', ids: null };

async function discover(a) {
  if (!a.modelsUrl || !a.key) return null;
  if (seen.ids && seen.provider === a.provider && Date.now() - seen.at < 3600e3) return seen.ids;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    let res;
    try { res = await fetch(a.modelsUrl, { headers: { authorization: 'Bearer ' + a.key }, signal: ac.signal }); }
    finally { clearTimeout(t); }
    if (!res.ok) return null;
    const j = await res.json();
    const ids = ((j && (j.data || j.models)) || []).map((m) => m && (m.id || m.name)).filter(Boolean);
    seen = { at: Date.now(), provider: a.provider, ids: ids.length ? ids : null };
    return seen.ids;
  } catch (e) { return null; }
}

function ladder(a, have) {
  const out = [];
  const add = (id) => { if (id && !out.includes(id) && !(blocked.get(id) > Date.now())) out.push(id); };
  if (a.provider === 'custom' && a.model) add(a.model);
  if (health.model && (!have || have.includes(health.model))) add(health.model);
  for (const id of VISION[a.provider] || []) if (!have || have.includes(id)) add(id);
  if (have) for (const id of have) if (LOOKS_VISUAL.test(id)) add(id);
  return out;
}

function ready() {
  const a = cloudwrite.access();
  return !!(a.key && a.url);
}

function state() {
  const a = cloudwrite.access();
  return {
    ready: ready(), provider: a.provider, providerName: a.providerName, free: a.free,
    model: health.model || (VISION[a.provider] || [])[0] || a.model || '',
    asked: health.asked, ok: health.ok, failed: health.failed, why: health.why,
    lastMs: health.lastMs, lastAt: health.lastAt,
  };
}

/** The question, for frames ruled into `n` numbered columns. */
const systemFor = (n) => [
  'You help a church media team turn a sermon recording into vertical (9:16) shorts.',
  'The crop must follow THE PERSON SPEAKING to the congregation: the preacher, teacher, worship leader or whoever is addressing the room — usually the one holding a microphone or standing at the pulpit.',
  'The image is a grid of separate video frames. Each frame has a white capital LETTER on black in its top-right corner.',
  `Each frame is ruled into ${n} equal vertical columns, numbered 1 (left) to ${n} (right) along its bottom edge.`,
  "For each frame, give the number of the column the speaker's HEAD is in. If the speaker cannot be seen in that frame, answer 0.",
  'NOT the speaker: congregation members, people walking past or sitting in front of the camera, musicians or singers in the background, helpers or interpreters beside the speaker, faces on posters, screens or the backdrop.',
  'Judge each frame by what is happening IN THAT FRAME: the speaker is the person talking at that moment — a microphone at or near their mouth, mouth open mid-word, addressing the room. Standing in the middle, being dressed up, smiling or holding a microphone down by their side is not speaking.',
  'If two or more people could be the speaker and you cannot tell which one is talking in that frame, answer 0.',
  'Never guess: if you cannot see who is speaking, 0 is the right answer.',
  `Reply with JSON only: {"frames":[{"frame":"A","column":<0..${n}>,"sure":<true|false>}]}`,
].join('\n');
const SYSTEM = systemFor(8);
/*
 * ►► WHERE ARE THE PEOPLE? (the Viral Montage) ◄◄ Not only who is speaking:
 * HOW MANY people can be seen — so a moment with nobody in it (an empty
 * stage, the screen, slides, lights) is never chosen — and where the one to
 * keep in a narrow 9:16 crop stands: the speaker when it is clear, otherwise
 * the most prominent person.
 */
const peopleSystemFor = (n) => [
  'You help a church media team cut a sermon or service recording into a vertical (9:16) video. Every frame will be cropped to a narrow vertical strip, and a person must always be seen in it.',
  'The image is a grid of separate video frames. Each frame has a white capital LETTER on black in its top-right corner.',
  `Each frame is ruled into ${n} equal vertical columns, numbered 1 (left) to ${n} (right) along its bottom edge.`,
  'For each frame give two answers:',
  'people: how many real people can clearly be seen in the frame, up to 9. A frame with no person in it is 0: an empty stage or room, a screen, slides, song lyrics, a title graphic or designed text (an intro, a sermon title, a countdown, a lower third on its own), an animated or patterned background, a logo, lights, a building, or a black or blurred frame. A congregation or crowd counts as people.',
  "column: the column of the HEAD of the person the crop should keep: the one speaking or leading if you can tell (a microphone at the mouth, at the pulpit, addressing the room), otherwise the most prominent person (the closest, largest or most in focus). When people is 0, column is 0.",
  'Faces on posters, screens, backdrops or photos on the wall are NOT people.',
  `Reply with JSON only: {"frames":[{"frame":"A","people":<0..9>,"column":<0..${n}>,"sure":<true|false>}]}`,
].join('\n');

/** The first balanced JSON object in a reply (models wrap JSON in fences and prose). */
const parseJson = (t) => cloudwrite.parseJson(t);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ASK_TIMEOUT_MS = 15000;
// One question at a time: the allowance is per minute per model, and a batch
// export tracks the next short while this one encodes.
let queue = Promise.resolve();

/**
 * frames: [{ label: 'A' }, ...] in the grid's order, each ruled into `columns`
 * numbered columns; image: a JPEG data URL of the grid. Returns
 * { ok: true, answers: { A: { column, sure } },
 * model, ms } or { ok: false, why }.
 */
function whoIsSpeaking(args) {
  const run = queue.then(() => ask(args), () => ask(args));
  queue = run.catch(() => {});
  return run;
}
/** The same grid, asked how many people each frame shows and where the one to keep stands:
 *  answers: { A: { people, column, sure } } (people 0 = nobody to be seen). */
function whereArePeople(args) { return whoIsSpeaking(Object.assign({}, args, { people: true })); }

async function ask({ image, frames, columns = 8, maxWaitMs = 45000, people = false } = {}) {
  const a = cloudwrite.access();
  health.asked++;
  const fail = (why) => { health.failed++; health.why = why; return { ok: false, why }; };
  if (!a.key) return fail('no AI key yet — paste the free Groq key in the Reframe tab');
  if (!a.url) return fail('no address for that AI service');
  if (!image || !/^data:image\//.test(image) || !Array.isArray(frames) || !frames.length) return fail('nothing to look at');
  const labels = frames.map((f) => String(f.label));
  const t0 = Date.now();
  const have = await discover(a);
  const list = ladder(a, have);
  if (!list.length) {
    // every vision model is PARKED, not missing: say why (measured: a used-up
    // daily allowance was being reported as "no model can look at pictures")
    const parked = [...blocked.entries()].filter(([m, until]) => until > Date.now() && blockedWhy.has(m));
    if (parked.length) {
      const [m, until] = parked.sort((x, y) => x[1] - y[1])[0];
      return fail(blockedWhy.get(m) + ` — back in about ${Math.max(1, Math.ceil((until - Date.now()) / 60000))} min`);
    }
    return fail(`${a.providerName} has no model here that can look at pictures`);
  }

  let waited = 0, lastWhy = '', retried = false;
  const noJson = new Set();   // models that choke on the JSON envelope (see cloudwrite: json_validate_failed)
  for (let k = 0; k < list.length; k++) {
    const model = list[k];
    const body = Object.assign({
      model, temperature: 0, max_tokens: 60 + 40 * frames.length,
      messages: [
        { role: 'system', content: people ? peopleSystemFor(columns) : systemFor(columns) },
        { role: 'user', content: [
          { type: 'text', text: `${frames.length} frame${frames.length === 1 ? '' : 's'}: ${frames.map((f) => f.label).join(', ')}. Each is ruled into ${columns} columns.` },
          { type: 'image_url', image_url: { url: image } },
        ] },
      ],
    }, tuneFor(model));
    if (!noJson.has(model)) body.response_format = { type: 'json_object' };
    let res, errText = '';
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), ASK_TIMEOUT_MS);
      try { res = await fetch(a.url, { method: 'POST', headers: a.headers, body: JSON.stringify(body), signal: ac.signal }); }
      finally { clearTimeout(timer); }
    } catch (e) {
      // A healthy answer takes about a second. One that has not come in
      // fifteen is a stalled connection, not a slow model — measured: three in
      // a row hung for the full 30 s, and the same request a moment later came
      // back in 1.0 s. So a hang is given ONE fresh try before it fails.
      if (!retried) { retried = true; k--; continue; }
      return fail(e && e.name === 'AbortError' ? 'the AI did not answer in time' : 'could not reach the AI (no internet?)');
    }
    if (!res || typeof res.ok !== 'boolean') return fail('the AI answered with nothing');
    if (res.ok) {
      let j = null; try { j = await res.json(); } catch (e) {}
      const parsed = parseJson(cloudwrite.textFrom(j));
      const rows = parsed && (parsed.frames || parsed.pictures);
      if (!Array.isArray(rows)) { lastWhy = model + ' answered something that was not a list of frames'; continue; }
      const answers = {};
      for (const r of rows) {
        const L = String(r && (r.frame != null ? r.frame : r.picture) || '').trim().toUpperCase();
        if (!labels.includes(L)) continue;
        const n = Math.round(Number(r.column != null ? r.column : r.speaker));
        // a column past the last one is not an answer at all — neither "here" nor "nobody"
        if (!Number.isFinite(n) || n < 0 || n > columns) continue;
        answers[L] = { column: n, sure: r.sure !== false };
        if (people) {
          const c = Math.round(Number(r.people));
          answers[L].people = Number.isFinite(c) && c >= 0 ? Math.min(9, c) : null;
        }
      }
      if (!Object.keys(answers).length) { lastWhy = model + ' did not answer about any frame'; continue; }
      health.ok++; health.why = ''; health.model = model; health.lastMs = Date.now() - t0; health.lastAt = Date.now();
      return { ok: true, answers, model, ms: health.lastMs };
    }
    try { errText = (await res.text()).slice(0, 500); } catch (e) {}
    if (res.status === 401 || res.status === 403) return fail('the AI key was refused — check it in Settings');
    if (res.status === 400 && /json_validate_failed|failed to generate json/i.test(errText) && !noJson.has(model)) { noJson.add(model); k--; continue; }
    // "currently over capacity" (a busy moment on the free tier) is a wait,
    // like a used-up allowance — not a broken model and not a reason to give up
    const busy = res.status === 503 || /over capacity|overloaded|try again/i.test(errText);
    if (busy && res.status !== 429) {
      const wait = 3000 * (1 + Math.min(3, Math.floor(waited / 3000)));
      if (waited + wait <= maxWaitMs) { waited += wait; await sleep(wait); k--; continue; }
      lastWhy = 'the AI service is too busy at the moment';
      continue;
    }
    if (res.status === 429) {
      // FULL, NOT BROKEN: the free allowance is per minute. Waiting half a
      // minute is far better than following the wrong man for the whole short,
      // and the export is waiting for this short's tracking anyway.
      const wait = cloudwrite.waitMs(res.headers.get('retry-after')) || cloudwrite.waitMs(res.headers.get('x-ratelimit-reset-tokens')) || 20000;
      if (waited + wait <= maxWaitMs) { waited += wait + 300; await sleep(wait + 300); k--; continue; }
      blocked.set(model, Date.now() + wait);
      // Say WHICH allowance and WHEN it comes back: the free vision model has
      // 200,000 tokens a DAY (rolling) as well as 7,000 a minute, and "for the
      // moment" reads very differently from "for eight minutes".
      const mins = Math.max(1, Math.ceil(wait / 60000));
      const which = /per day|TPD|RPD/i.test(errText) ? 'the free daily AI allowance is used up' : 'the free AI allowance is used up for the moment';
      blockedWhy.set(model, which);
      lastWhy = which + ` — back in about ${mins} min`;
      continue;
    }
    if ((res.status === 400 || res.status === 404) && !OUR_FAULT.test(errText) && (GONE.test(errText) || CANT_SEE.test(errText))) {
      blocked.set(model, Date.now() + 6 * 3600e3); blockedWhy.delete(model);
      lastWhy = model + (GONE.test(errText) ? ' is not there any more' : ' cannot look at pictures');
      continue;
    }
    // too many / too big a picture is OUR mistake, not the model's
    lastWhy = `the AI answered ${res.status}${errText ? ' (' + errText.replace(/\s+/g, ' ').slice(0, 120) + ')' : ''}`;
    break;
  }
  return fail(lastWhy || 'no AI model would answer');
}

module.exports = { VISION, whoIsSpeaking, whereArePeople, state, ready, SYSTEM, _health: () => health, _blocked: () => blocked };
