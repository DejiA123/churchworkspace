'use strict';
/*
 * ►► LONG TO SHORTS, PLANNED FROM THE WHOLE SERMON. ◄◄
 *
 * The scan used to pick its candidates by LOUDNESS, transcribe only those
 * stretches, and ask the AI to nudge their endings. Measured on a real
 * 45-minute sermon (Bishop David Richman, "approach God with joy"): of twelve
 * shorts, several opened on "Huh? Oh yes, yes…" or on the preacher chatting
 * with the congregation, two stopped on the first line of the NEXT story ("I
 * went to a church about two years ago."), one stopped a sentence before its
 * payoff ("…the issue is not corrected." — "That can be easily corrected by a
 * supply of the healing virtue of Jesus" came next), and the strongest point of
 * the sermon ("There is no prosperity gospel, no healing gospel, no deliverance
 * gospel — there is only one gospel") was never a candidate at all, because it
 * was not said loudly. Loud is not the same as important.
 *
 * So, when a strong reading model is available, the whole sermon is read:
 *   1. every sentence, numbered, with its time (whatever the ear heard);
 *   2. section by section (each about 2,000 words, overlapping), the model
 *      marks EVERY moment that stands on its own — the sentence the thought
 *      STARTS on, the sentence its point LANDS on, a title, the point in a
 *      line, and how strong it is;
 *   3. each moment is checked here, not trusted: inside the length band, no
 *      opening on a filler or an aside, no closing on the start of a new story;
 *   4. the set is chosen so every section's best point is in it before any
 *      section gets a second.
 *
 * `ask({ system, prompt, maxTokens })` is the model — passed in, so this is
 * testable without one. Returns null when it could not plan (the caller then
 * uses the loudness scan, as before).
 */

// About eight minutes of preaching a section: measured, sections of ~2,000
// words came back with two moments each — eight from 45 minutes, and the core
// point of the sermon among those left out.
const SECTION_WORDS = 1300;
const OVERLAP_SENTS = 8;

// openings that are never the start of a thought
const FILLER_OPEN_RX = /^(?:(?:huh|hmm+|oh|ah|uh|um|okay|ok|yes|yeah|no|alright|all right|right|amen|hallelujah|come on|you know|so|well|and|thank you|praise the lord|praise god|glory)[\s.,!?…-]*)+$/i;
const ASIDE_RX = /\b(how are you|you'?re looking (?:so )?(?:good|nice|beautiful)|good (?:morning|afternoon|evening)|turn to your neighbou?r|give (?:god|the lord|him) a (?:hand|clap|shout)|please (?:sit|be seated)|can you hear me|is (?:the|this) (?:mic|microphone)|testing)\b/i;
// a closing sentence that is really the first line of something new
const NEW_STORY_RX = /\b(i went to|one day|(?:a|some|many|two|three|few) (?:days?|weeks?|months?|years?) ago|let me tell you|there was a (?:man|woman|boy|girl|time|lady|guy)|i remember (?:when|the)|when i was|i met a|the other day)\b/i;

const words = (t) => String(t || '').split(/\s+/).filter(Boolean).length;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The sermon in sections the model can read in one go (sentence indexes). */
function sections(sents, perSection = SECTION_WORDS, overlap = OVERLAP_SENTS) {
  const out = [];
  let i = 0;
  while (i < sents.length) {
    let w = 0, j = i;
    while (j < sents.length && (w < perSection || j === i)) { w += words(sents[j].text); j++; }
    out.push([i, j - 1]);
    if (j >= sents.length) break;
    i = Math.max(i + 1, j - overlap);
  }
  return out;
}

function promptFor(sents, [a, b], { minLen, maxLen, idealLen }) {
  const lines = [];
  for (let k = a; k <= b; k++) lines.push(`[${k}] (${clock(sents[k].start)}) ${sents[k].text}`);
  const system = 'You are the best short-form video editor for church and ministry content. You find the moments in a sermon that work on their own as short videos, and you cut them exactly where a thought starts and where its point lands. You reply with JSON only.';
  const prompt = `Below is part of a sermon, one sentence per line: [number] (time) words. The transcript is automatic, so a few words may be misheard.

${lines.join('\n')}

Find EVERY moment in this part that would work as a standalone short video: a complete thought someone who never heard the rest of the sermon would understand and remember — a teaching point, a declaration, a story WITH its point, a powerful line and what leads to it. A part this size usually has 3 to 6 such moments; list them all, even the good-but-not-best ones (they are chosen from later). Do not skip a point because it is said quietly or simply — the main teaching of the sermon is often said calmly.

For each moment:
- "from": the number of the sentence where the thought STARTS. Never start on a filler ("Huh?", "Oh yes, yes", "Okay", "Amen"), on the preacher chatting with someone in the room ("How are you? You're looking so good"), on an announcement, or in the middle of a story or a list. If the line before is needed to understand it, start there.
- "to": the number of the sentence where its point LANDS — the payoff, the conclusion, the line that makes it worth sharing. Never stop one sentence before the payoff, and never end on the first line of a new story or a new point ("I went to a church about two years ago.").
- It should run between ${minLen} and ${maxLen} seconds (use the times), ideally about ${idealLen}.
- "title": 3 to 10 words a person would put on the video to make people watch — a natural phrase or a short question in the preacher's own words, never a list of keywords.
- "point": the point of the moment, in one short sentence.
- "strength": 1 to 10, how strongly it works as a short on its own.

Moments must not overlap. Reply with only: {"moments":[{"from":0,"to":0,"title":"","point":"","strength":0}]}`;
  return { system, prompt };
}

function parseMoments(text) {
  if (!text) return null;
  let j = null;
  const s = String(text);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { j = null; } }
  const list = j && Array.isArray(j.moments) ? j.moments : null;
  if (!list) return null;
  return list.map((m) => ({
    from: Math.round(+m.from), to: Math.round(+m.to),
    title: String(m.title || '').replace(/\s+/g, ' ').trim(),
    point: String(m.point || '').replace(/\s+/g, ' ').trim(),
    strength: Math.max(0, Math.min(10, +m.strength || 0)),
  })).filter((m) => Number.isFinite(m.from) && Number.isFinite(m.to) && m.to >= m.from);
}

/** Hold a moment to the rules; returns the repaired moment or null. */
function vet(m, sents, [a, b], { minLen, maxLen }) {
  let from = Math.max(a, m.from), to = Math.min(b, m.to);
  if (to < from) return null;
  const dur = () => sents[to].end - sents[from].start;
  // no opening on a filler or an aside — nor with an aside a line or two in
  // ("Let me be serious. A pastor has to… Faithful, how are you?")
  for (let k = from; k <= Math.min(to - 1, from + 2); k++) if (ASIDE_RX.test(sents[k].text)) from = k + 1;
  while (from < to && (FILLER_OPEN_RX.test(sents[from].text.trim()) || ASIDE_RX.test(sents[from].text) || words(sents[from].text) <= 1)) from++;
  // no closing on the first line of something new, a filler, a lone word, or
  // the short question that opens the NEXT point ("Where did you see Jesus?")
  const setupQ = (t) => /\?\s*$/.test(t) && words(t) <= 7 && /^(where|what|how|who|why|when|which|do you|did you|have you|are you|is it)\b/i.test(t.trim());
  while (to > from && (NEW_STORY_RX.test(sents[to].text) || FILLER_OPEN_RX.test(sents[to].text.trim()) || words(sents[to].text) <= 1 || setupQ(sents[to].text))) to--;
  // too long: the payoff is kept and the run-up shortened
  while (dur() > maxLen * 1.08 && from < to) from++;
  if (dur() > maxLen * 1.08) return null;
  // too short to be a short — unless it is one of the strongest moments
  const floor = m.strength >= 8 ? Math.max(15, minLen * 0.45) : Math.max(20, minLen * 0.75);
  if (dur() < floor) return null;
  const title = cleanTitle(m.title);
  return { from, to, start: sents[from].start, end: sents[to].end, title, point: m.point, strength: m.strength };
}

function cleanTitle(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/[.,;:!]+$/, '').trim();
  if (!t) return '';
  const wc = t.split(' ').length;
  if (wc < 2 || wc > 14) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const overlaps = (x, y, gap = 0) => x.start < y.end + gap && y.start < x.end + gap;

/** Every section's best point first, then the strongest of the rest. */
function choose(moments, maxClips, secs, gap = 2) {
  const chosen = [];
  const fits = (m) => chosen.every((c) => !overlaps(c, m, gap));
  const bySec = secs.map(() => []);
  for (const m of moments) bySec[m.sec].push(m);
  bySec.forEach((l) => l.sort((x, y) => y.strength - x.strength));
  for (const l of bySec) {
    const best = l.find((m) => m.strength >= 5 && fits(m));
    if (best && chosen.length < maxClips) chosen.push(best);
  }
  for (const m of moments.slice().sort((x, y) => y.strength - x.strength)) {
    if (chosen.length >= maxClips) break;
    if (!chosen.includes(m) && m.strength >= 4 && fits(m)) chosen.push(m);
  }
  return chosen.sort((x, y) => x.start - y.start);
}

/*
 * ►► THE EDGES, LOOKED AT AGAIN. ◄◄
 * Reading eight minutes at once, the model marks the right MOMENTS but now and
 * then stops one sentence short of the payoff (measured: "…people who have
 * spent 30 millions on a child." — the landing, "That can be easily corrected
 * by a supply of the healing virtue of Jesus", was the next line). So every
 * chosen short's two edges are shown to it on their own — the lines around the
 * start, the lines around the end, numbered — and it says where the thought
 * really starts and where its point really lands. One call for all of them.
 */
function edgePrompt(items) {
  const blocks = items.map((it) => {
    const s = it.startLines.map(([n, t]) => `  [${n}] ${t}`).join('\n');
    const e = it.endLines.map(([n, t]) => `  [${n}] ${t}`).join('\n');
    return `Short ${it.id} — "${it.title}" (now starts at [${it.from}], ends at [${it.to}])\nAround the START:\n${s}\nAround the END:\n${e}`;
  });
  const system = 'You are the best short-form video editor for sermons. You decide exactly where a short starts and ends. You reply with JSON only.';
  const prompt = `Each short below is a moment cut from a sermon. For each, you see the numbered sentences around where it starts and around where it ends.

${blocks.join('\n\n')}

For every short choose:
- "from": the sentence where the thought really STARTS — not mid-story, not on a filler or an aside to someone in the room, and not so early that it begins with the end of the previous point.
- "to": the sentence where its point really LANDS — the payoff that makes it worth sharing. If the point is completed one or two sentences after the current end, end there. Never end on the first line of a new story or point, or on a question that opens the next point.
Use only the sentence numbers shown. Reply with only: {"edges":[{"id":1,"from":0,"to":0}]}`;
  return { system, prompt };
}
async function refineEdges(moments, S, { ask, minLen, maxLen, retryWaits }) {
  if (!moments.length) return 0;
  const items = moments.map((m, k) => {
    const sl = [], el = [];
    for (let n = Math.max(0, m.from - 3); n <= Math.min(S.length - 1, m.from + 2); n++) sl.push([n, S[n].text]);
    for (let n = Math.max(0, m.to - 2); n <= Math.min(S.length - 1, m.to + 4); n++) el.push([n, S[n].text]);
    return { id: k + 1, title: m.title, from: m.from, to: m.to, startLines: sl, endLines: el, sMin: sl[0][0], sMax: sl[sl.length - 1][0], eMin: el[0][0], eMax: el[el.length - 1][0] };
  });
  const { system, prompt } = edgePrompt(items);
  let j = null;
  for (let attempt = 0; ; attempt++) {
    let out = '';
    try { out = await ask({ system, prompt, maxTokens: 2500 }); } catch (e) { if (e && e.cancelled) throw e; out = ''; }
    const s = String(out || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { j = null; } }
    if ((j && Array.isArray(j.edges)) || attempt >= retryWaits.length) break;
    await new Promise((r) => setTimeout(r, retryWaits[attempt]));
  }
  if (!j || !Array.isArray(j.edges)) return 0;
  let moved = 0;
  for (const e of j.edges) {
    const it = items.find((x) => x.id === Math.round(+e.id));
    if (!it) continue;
    const m = moments[it.id - 1];
    const from = Math.round(+e.from), to = Math.round(+e.to);
    if (!(from >= it.sMin && from <= it.sMax && to >= it.eMin && to <= it.eMax && to > from)) continue;
    if (from === m.from && to === m.to) continue;
    const v = vet({ from, to, title: m.title, point: m.point, strength: m.strength }, S, [Math.min(it.sMin, m.from), Math.max(it.eMax, m.to)], { minLen, maxLen });
    if (!v) continue;
    Object.assign(m, { from: v.from, to: v.to, start: v.start, end: v.end });
    moved++;
  }
  return moved;
}

/**
 * sents: [{start, end, text}] — the whole sermon, in order.
 * Returns { moments: [...], sections, failed } or null.
 */
async function planShorts({ sents, minLen = 60, maxLen = 150, idealLen = 90, maxClips = 20, ask, onProgress = null, cancelled = () => false, retryWaits = [20000, 40000, 60000] } = {}) {
  const S = (sents || []).filter((s) => s && s.text && s.end > s.start);
  if (S.length < 8 || typeof ask !== 'function') return null;
  const secs = sections(S);
  const all = [];
  let failed = 0;
  for (let k = 0; k < secs.length; k++) {
    if (cancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    const { system, prompt } = promptFor(S, secs[k], { minLen, maxLen, idealLen });
    let got = null;
    for (let attempt = 0; ; attempt++) {
      let out = '';
      try { out = await ask({ system, prompt, maxTokens: 3000 }); } catch (e) { if (e && e.cancelled) throw e; out = ''; }
      got = parseMoments(out);
      if (got || attempt >= retryWaits.length) break;
      // the free allowance refills by the minute: wait, then ask again
      const until = Date.now() + retryWaits[attempt];
      while (Date.now() < until) {
        if (cancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!got) failed++;
    for (const m of got || []) {
      const v = vet(m, S, secs[k], { minLen, maxLen });
      if (v) all.push(Object.assign(v, { sec: k }));
    }
    if (onProgress) { try { onProgress((k + 1) / secs.length); } catch (e) {} }
  }
  // a section the model never answered is a hole in the sermon: say so (the caller falls back if too many)
  if (failed > secs.length / 2) return null;
  // the same moment found from two overlapping sections: the stronger reading wins
  all.sort((x, y) => y.strength - x.strength);
  const uniq = [];
  for (const m of all) {
    const dup = uniq.find((u) => overlaps(u, m) && Math.min(u.end, m.end) - Math.max(u.start, m.start) > 0.5 * Math.min(u.end - u.start, m.end - m.start));
    if (!dup) uniq.push(m);
  }
  const picked = choose(uniq, maxClips, secs);
  let edgesMoved = 0;
  try { edgesMoved = await refineEdges(picked, S, { ask, minLen, maxLen, retryWaits }); } catch (e) { if (e && e.cancelled) throw e; }
  // an edge that moved may now touch a neighbour: the later one gives way at the seam
  picked.sort((x, y) => x.start - y.start);
  for (let k = 1; k < picked.length; k++) {
    const p = picked[k - 1], m = picked[k];
    if (m.from <= p.to) { m.from = p.to + 1; if (m.from <= m.to) m.start = S[m.from].start; }
  }
  const moments = picked.filter((m) => m.from <= m.to).map((m) => Object.assign(m, {
    sents: S.slice(m.from, m.to + 1),
    text: S.slice(m.from, m.to + 1).map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(),
  }));
  return { moments, sections: secs.length, failed, found: uniq.length, edgesMoved };
}

module.exports = { planShorts, sections, parseMoments, vet, choose, promptFor, refineEdges, edgePrompt, _rx: { FILLER_OPEN_RX, ASIDE_RX, NEW_STORY_RX } };
