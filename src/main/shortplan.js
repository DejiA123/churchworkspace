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
const WIDE_WORDS = 12000;   // about 80 minutes of preaching in one reading
const OVERLAP_SENTS = 8;

// openings that are never the start of a thought
const FILLER_OPEN_RX = /^(?:(?:huh|hmm+|oh|ah|uh|um|okay|ok|yes|yeah|no|alright|all right|right|amen|hallelujah|come on|you know|so|well|and|thank you|praise the lord|praise god|glory)[\s.,!?…-]*)+$/i;
// (and the preacher checking on the room — measured on a live sermon: a short opened on
// "Are you here, young lady?" and another closed on "can you see what I'm talking about?")
const ASIDE_RX = /\b(how are you|you'?re looking (?:so )?(?:good|nice|beautiful)|good (?:morning|afternoon|evening)|turn to your neighbou?r|give (?:god|the lord|him) a (?:hand|clap|shout)|please (?:sit|be seated)|can you hear me|is (?:the|this) (?:mic|microphone)|testing|are you (?:here|there|with me|with here|listening|following)|can you see what i'?m (?:talking about|saying)|are you listening to what|is that clear)\b|\b(?:do you (?:understand|get it)|you understand)\s*\??\s*$/i;
// a closing sentence that is really the first line of something new
const NEW_STORY_RX = /\b(i went to|one day|(?:a|some|many|two|three|few) (?:days?|weeks?|months?|years?) ago|let me tell you|there was a (?:man|woman|boy|girl|time|lady|guy)|i remember (?:when|the)|when i was|i met a|the other day)\b/i;

const words = (t) => String(t || '').split(/\s+/).filter(Boolean).length;
// opens by pointing back at something said before it
const LEANS_RX = /^(that'?s?|this|these|those|it|he|she|they|him|her|them|which|so that|and that|but that)\b(?! is why| is how| is what)/i;
/*
 * A word no church short may carry. In a sermon it is a mishearing (measured:
 * AssemblyAI wrote "…then f— it" for a line the preacher did not swear in) —
 * but the captions would show it: such a line never opens or closes a short,
 * and a short with one inside it is left out.
 */
const PROFANE_RX = /\b(f+u+c+k\w*|sh[i1]t+\w*|bitch\w*|bastard\w*|asshole\w*|motherf\w*|dickhead\w*|goddamn\w*|damn it)\b/i;
const STOPS_RX = /[.!?…]["')\]]?\s*$/;
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

function promptFor(sents, [a, b], { minLen, maxLen, idealLen, wide = false }) {
  const lines = [];
  // a blank line where AssemblyAI heard a new paragraph begin (a pause, a turn in the thought)
  const paras = sents.slice(a, b + 1).some((x) => x.para);
  for (let k = a; k <= b; k++) {
    if (paras && k > a && sents[k].para) lines.push('');
    lines.push(`[${k}] (${clock(sents[k].start)}) ${sents[k].text}`);
  }
  // seconds turned into sentences for THIS part (a model adds up times badly; it counts lines well)
  const per = Math.max(1, (sents[b].end - sents[a].start) / Math.max(1, b - a + 1));
  const nMin = Math.max(2, Math.round(minLen / per)), nIdeal = Math.max(nMin, Math.round(idealLen / per)), nMax = Math.max(nIdeal, Math.round(maxLen / per));
  const system = 'You are the best short-form video editor for church and ministry content. You find the moments in a sermon that work on their own as short videos, and you cut them exactly where a thought starts and where its point lands. You reply with JSON only.';
  const what = wide ? 'Below is a whole sermon' : 'Below is part of a sermon';
  const prompt = `${what}, one sentence per line: [number] (time) words. The transcript is automatic, so a few words may be misheard.${paras ? ' A blank line marks where the speaker paused and moved on — a new paragraph; a moment usually starts at the start of a paragraph and ends at the end of one.' : ''}

${lines.join('\n')}

Find EVERY moment in this ${wide ? 'sermon' : 'part'} that would work as a standalone short video: a complete thought someone who never heard the rest of the sermon would understand and remember — a teaching point, a declaration, a story WITH its point, a powerful line and what leads to it. ${wide ? 'A whole sermon usually has 10 to 20 such moments — list at least 12' : 'A part this size usually has 3 to 6 such moments'}; list them all, even the good-but-not-best ones (they are chosen from later). Do not skip a point because it is said quietly or simply — the main teaching of the sermon is often said calmly. A story must start where the story starts (who, where, what happened) — never on a line that leans on something not in the short ("The other day I went to meet him", "That is why…", or a sentence opening with "But", "And" or "So" that continues the point before).

For each moment:
- "from": the number of the sentence where the thought STARTS. Never start on a filler ("Huh?", "Oh yes, yes", "Okay", "Amen"), on the preacher chatting with someone in the room ("How are you? You're looking so good"), on an announcement, or in the middle of a story or a list. If the line before is needed to understand it, start there.
- "to": the number of the sentence where its point LANDS — the payoff, the conclusion, the line that makes it worth sharing. Never stop one sentence before the payoff, and never end on the first line of a new story or a new point ("I went to a church about two years ago."). A moment never STARTS on the conclusion of the point before it ("That response is what you call answer.") — that line belongs to the previous moment.
- LENGTH: it must run between ${minLen} and ${maxLen} seconds, ideally about ${idealLen}. Here that is about ${nMin} to ${nMax} sentences (ideally about ${nIdeal}) — so "to" minus "from" should be at least ${Math.max(1, nMin - 1)}. A single strong line is NOT a moment on its own: take in the setup before it and the follow-through after it until the whole stretch is one complete piece of teaching or one whole story with its point. Check the times: shorter than ${minLen} seconds is too short.
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
function vet(m, sents, [a, b], { minLen, maxLen, idealLen, noGrow = false }) {
  let from = Math.max(a, m.from), to = Math.min(b, m.to);
  if (to < from) return null;
  const dur = () => sents[to].end - sents[from].start;
  // a start that leans on the line before it ("That exactly how God is…",
  // "He said…") takes that line too, while it fits
  for (let k = 0; k < 2 && from > 0 && LEANS_RX.test(sents[from].text.trim()) && sents[to].end - sents[from - 1].start <= maxLen; k++) from--;
  // a start mid-sentence ("nothing is greater than…" — "On earth" left on the line before): its sentence's start
  for (let k = 0; k < 2 && from > 0 && /^[a-z]/.test(sents[from].text.trim()) && !STOPS_RX.test(sents[from - 1].text.trim()) && sents[to].end - sents[from - 1].start <= maxLen * 1.05; k++) from--;
  // an ending with no full stop was cut mid-phrase ("…What you effect"): the
  // sentence it belongs to is finished, while it fits
  for (let k = 0; k < 2 && to + 1 < sents.length && !/[.!?…]["')\]]?\s*$/.test(sents[to].text.trim()) && sents[to + 1].end - sents[from].start <= maxLen * 1.05; k++) to++;
  // no opening on a filler or an aside — nor with an aside a line or two in
  // ("Let me be serious. A pastor has to… Faithful, how are you?")
  for (let k = from; k <= Math.min(to - 1, from + 2); k++) if (ASIDE_RX.test(sents[k].text)) from = k + 1;
  while (from < to && (FILLER_OPEN_RX.test(sents[from].text.trim()) || ASIDE_RX.test(sents[from].text) || words(sents[from].text) <= 1)) from++;
  // no closing on the first line of something new, a filler, a lone word, or
  // the short question that opens the NEXT point ("Where did you see Jesus?")
  const setupQ = (t) => /\?\s*$/.test(t) && words(t) <= 7 && /^(where|what|how|who|why|when|which|do you|did you|have you|are you|is it)\b/i.test(t.trim());
  while (to > from && (NEW_STORY_RX.test(sents[to].text) || FILLER_OPEN_RX.test(sents[to].text.trim()) || ASIDE_RX.test(sents[to].text) || words(sents[to].text) <= 1 || setupQ(sents[to].text))) to--;
  // never open or close on a word no church short may carry; one inside it: not a short
  while (to > from && PROFANE_RX.test(sents[to].text)) to--;
  while (from < to && PROFANE_RX.test(sents[from].text)) from++;
  for (let k = from; k <= to; k++) if (PROFANE_RX.test(sents[k].text)) return null;
  // it lands on a full stop: an end left on a comma ("He cannot understand it,") goes back to the last
  // whole sentence — three lines at most, never into the setup
  if (!STOPS_RX.test(sents[to].text.trim())) {
    let k = to;
    while (k > from + 2 && to - k < 3 && !STOPS_RX.test(sents[k].text.trim())) k--;
    if (STOPS_RX.test(sents[k].text.trim())) to = k;
  }
  // too long: the payoff is kept and the run-up shortened
  while (dur() > maxLen * 1.08 && from < to) from++;
  if (dur() > maxLen * 1.08) return null;
  /*
   * SHORTER THAN ASKED: THE THOUGHT AROUND IT. Measured on a church's
   * 50-minute sermon with Auto (about 1:30, never under 1:00): the AI's
   * moments came back 28-39 seconds — the punchline alone — and were kept.
   * A moment shorter than the length asked for takes whole lines around it —
   * the run-up first (the setup a payoff needs), then what follows — toward
   * the ideal length, never past the longest, never across an aside or into
   * the next story; then it finishes on a full stop.
   */
  const want = Math.min(maxLen, Math.max(minLen, idealLen || minLen));
  // (a weak moment is not stretched into a short: only one the AI rated strong grows)
  if (!noGrow && dur() < minLen && (m.strength || 0) >= 6) {
    const f0 = from, t0 = to;
    for (let k = 0; k < 80 && dur() < want; k++) {
      // a story's first line is where it starts — nothing before it; a long pause is where one thing ends and the next begins
      const gap = (i) => sents[i + 1].start - sents[i].end;
      const back = from > 0 && !NEW_STORY_RX.test(sents[from].text) && gap(from - 1) < 2 && !ASIDE_RX.test(sents[from - 1].text) && !PROFANE_RX.test(sents[from - 1].text) && !FILLER_OPEN_RX.test(sents[from - 1].text.trim()) && sents[to].end - sents[from - 1].start <= maxLen;
      const fwd = to + 1 < sents.length && gap(to) < 2 && !NEW_STORY_RX.test(sents[to + 1].text) && !PROFANE_RX.test(sents[to + 1].text) && sents[to + 1].end - sents[from].start <= maxLen;
      // the run-up no longer than what follows: a payoff keeps its setup, the point keeps going
      const before = sents[f0].start - (from > 0 ? sents[from - 1].start : sents[from].start);
      const after = (to + 1 < sents.length ? sents[to + 1].end : sents[to].end) - sents[t0].end;
      if (back && (!fwd || before <= after)) from--;
      else if (fwd) to++;
      else break;
    }
    for (let k = 0; k < 3 && to + 1 < sents.length && !/[.!?…]["')\]]?\s*$/.test(sents[to].text.trim()) && !PROFANE_RX.test(sents[to + 1].text) && sents[to + 1].end - sents[from].start <= maxLen; k++) to++;
    while (from < t0 && (FILLER_OPEN_RX.test(sents[from].text.trim()) || ASIDE_RX.test(sents[from].text) || words(sents[from].text) <= 1)) from++;
  }
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
    const best = l.find((m) => m.strength >= 4 && fits(m));
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
    const s = it.startLines.map(([n, t, p]) => `  ${p ? '¶' : ' '}[${n}] ${t}`).join('\n');
    const e = it.endLines.map(([n, t, p]) => `  ${p ? '¶' : ' '}[${n}] ${t}`).join('\n');
    return `Short ${it.id} — "${it.title}"${it.point ? ' — its point: ' + it.point : ''} (now starts at [${it.from}], ends at [${it.to}])\nAround the START:\n${s}\nAround the END:\n${e}`;
  });
  const system = 'You are the best short-form video editor for sermons. You decide exactly where a short starts and ends. You reply with JSON only.';
  const prompt = `Each short below is a moment cut from a sermon. For each, you see the numbered sentences around where it starts and around where it ends.

${blocks.join('\n\n')}

For every short choose:
- "from": the sentence where the thought really STARTS — not mid-story, not on a filler or an aside to someone in the room, and not so early that it begins with the end of the previous point. Not on a sentence that opens with "But", "And", "So" or "Because" leaning on what came before — start where the thought itself begins.
- "to": the sentence where ITS POINT (given above) really LANDS — the payoff that makes it worth sharing. If the point is completed one or two sentences after the current end, end there; if the current end runs on into another story, a side remark or a word to someone in the room ("Are you here, young lady?"), end earlier, on the line that lands the point. Never end on the first line of a new story or point, or on a question that opens the next point.
Use only the sentence numbers shown.${items.some((it) => it.startLines.concat(it.endLines).some((x) => x[2])) ? ' ¶ marks a sentence that starts a new paragraph (the speaker paused and moved on): a good start is usually one, and a good end is usually the sentence just before one.' : ''} Reply with only: {"edges":[{"id":1,"from":0,"to":0}]}`;
  return { system, prompt };
}
async function refineEdges(moments, S, { ask, minLen, maxLen, retryWaits }) {
  if (!moments.length) return 0;
  const items = moments.map((m, k) => {
    const sl = [], el = [];
    for (let n = Math.max(0, m.from - 5); n <= Math.min(S.length - 1, m.from + 3); n++) sl.push([n, S[n].text, !!S[n].para]);
    for (let n = Math.max(0, m.to - 7); n <= Math.min(S.length - 1, m.to + 4); n++) el.push([n, S[n].text, !!S[n].para]);
    return { id: k + 1, title: m.title, point: m.point, from: m.from, to: m.to, startLines: sl, endLines: el, sMin: sl[0][0], sMax: sl[sl.length - 1][0], eMin: el[0][0], eMax: el[el.length - 1][0] };
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
    const v = vet({ from, to, title: m.title, point: m.point, strength: m.strength }, S, [Math.min(it.sMin, m.from), Math.max(it.eMax, m.to)], { minLen, maxLen, noGrow: true });
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
async function planShorts({ sents, minLen = 60, maxLen = 150, idealLen = 90, maxClips = 20, ask, onProgress = null, cancelled = () => false, retryWaits = [15000, 30000], wide = false, onUnread = null } = {}) {
  const S = (sents || []).filter((s) => s && s.text && s.end > s.start);
  if (S.length < 8 || typeof ask !== 'function') return null;
  // wide: a reader that holds the whole sermon reads it at once (a two-hour service in two halves)
  const secs = wide ? sections(S, WIDE_WORDS, OVERLAP_SENTS) : sections(S);
  const all = [];
  let failed = 0, lastGot = true, returned = 0, more = 0;
  for (let k = 0; k < secs.length; k++) {
    if (cancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    const { system, prompt } = promptFor(S, secs[k], { minLen, maxLen, idealLen, wide });
    let got = null;
    for (let attempt = 0; ; attempt++) {
      let out = '';
      try { out = await ask({ system, prompt, maxTokens: wide ? 6000 : 3000 }); } catch (e) { if (e && e.cancelled) throw e; out = ''; }
      got = parseMoments(out);
      // an answer that came but could not be read: said (measured — two such answers, and the
      // whole-sermon reading silently gave way to ten-minute pieces)
      if (out && !got && typeof onUnread === 'function') { try { onUnread(String(out).slice(0, 160)); } catch (e) {} }
      if (got || attempt >= retryWaits.length) break;
      // the free allowance refills by the minute: wait, then ask again
      const until = Date.now() + retryWaits[attempt];
      while (Date.now() < until) {
        if (cancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    // every part of a sermon has something worth a short: an empty answer is asked once more, for the best few
    if (got && !got.length) {
      try {
        const again = await ask({ system, prompt: prompt + '\n\nYou returned no moments. Every part of a sermon has some. Return the 3 best moments in this part, following all the rules above.', maxTokens: 3000 });
        got = parseMoments(again) || got;
      } catch (e) { if (e && e.cancelled) throw e; }
    }
    if (!got) failed++;
    // Two sections in a row with no answer at all: the free allowance is spent
    // (measured: a day of heavy testing left every model refusing, and the scan
    // sat waiting fifteen minutes). Stop and let the loudness scan run now.
    if (!got && k > 0 && !lastGot) return null;
    lastGot = !!got;
    returned += (got || []).length;
    for (const m of got || []) {
      const v = vet(m, S, secs[k], { minLen, maxLen, idealLen });
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
  /*
   * TOO FEW FOR THE SHORTS ASKED FOR. Measured: reading the whole sermon,
   * Mistral Large named five moments — all good, but eight were asked for.
   * Shown what it already chose, it is asked once for more, different ones.
   */
  if (wide && uniq.length < maxClips && secs.length === 1) {
    if (cancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    const { system, prompt } = promptFor(S, secs[0], { minLen, maxLen, idealLen, wide });
    const had = uniq.map((m) => `[${m.from}]–[${m.to}] "${m.title || ''}"`).join('\n');
    const want = Math.max(4, maxClips - uniq.length + 3);
    let out = '';
    try {
      out = await ask({ system, maxTokens: 6000, prompt: prompt + `\n\nThese moments are already chosen:\n${had}\n\nFind ${want} MORE moments in this sermon — different ones, not overlapping any of these — following every rule above. Reply with only: {"moments":[{"from":0,"to":0,"title":"","point":"","strength":0}]}` });
    } catch (e) { if (e && e.cancelled) throw e; out = ''; }
    for (const m of parseMoments(out) || []) {
      more++;
      const v = vet(m, S, secs[0], { minLen, maxLen, idealLen });
      if (v && !uniq.some((u) => overlaps(u, v) && Math.min(u.end, v.end) - Math.max(u.start, v.start) > 0.5 * Math.min(u.end - u.start, v.end - v.start))) uniq.push(Object.assign(v, { sec: 0 }));
    }
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
  return { moments, sections: secs.length, failed, found: uniq.length, returned, more, edgesMoved };
}

module.exports = { planShorts, sections, parseMoments, vet, choose, promptFor, refineEdges, edgePrompt, _rx: { FILLER_OPEN_RX, ASIDE_RX, NEW_STORY_RX, PROFANE_RX } };
