'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/*
 * Disk cache of sermon transcript spans. Whisper on a laptop CPU is what makes
 * deep analysis slow, and users re-run "Find highlights" repeatedly (trying
 * different lengths, re-opening the app). Every transcribed span is remembered
 * per video file (path + size + mtime), so any stretch of audio is only ever
 * paid for ONCE — later runs that need the same (or a contained) range are
 * served from disk instantly.
 */

function fileKey(input, extra) {
  let sig = input;
  try { const st = fs.statSync(input); sig = `${input}|${st.size}|${Math.round(st.mtimeMs)}`; } catch (e) {}
  return crypto.createHash('md5').update(sig + '|' + (extra || '')).digest('hex');
}

class TransCache {
  /** dir = cache folder; input = the video file; extra = model/options signature. */
  constructor(dir, input, extra) {
    this.file = path.join(dir, fileKey(input, extra) + '.json');
    this.spans = []; // [{from,to,segs:[{start,end,text}]}] — all times ABSOLUTE (video seconds)
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    try { this.spans = JSON.parse(fs.readFileSync(this.file, 'utf-8')).spans || []; } catch (e) {}
  }
  /** Segs (absolute times) overlapping [from,to], if a cached span fully covers it. */
  get(from, to) {
    const EPS = 0.25;
    const s = this.spans.find((x) => x.from <= from + EPS && x.to >= to - EPS);
    if (!s) return null;
    return s.segs.filter((g) => g.end > from && g.start < to);
  }
  /** Remember segs (absolute times) for [from,to]. */
  add(from, to, segs) {
    // spans fully inside the new one are superseded by it
    this.spans = this.spans.filter((x) => !(x.from >= from - 0.01 && x.to <= to + 0.01));
    this.spans.push({ from, to, segs });
    if (this.spans.length > 80) this.spans = this.spans.slice(-80);
    try { fs.writeFileSync(this.file, JSON.stringify({ spans: this.spans }), 'utf-8'); } catch (e) {}
  }
}

module.exports = { TransCache, fileKey };
