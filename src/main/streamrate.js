'use strict';
/*
 * WHAT THE PLATFORM EXPECTS FOR THE PICTURE YOU ARE ACTUALLY SENDING.
 *
 * The complaint this exists to end, seen on YouTube every single service:
 *
 *     ⚠ The stream's current bitrate (2278.74 Kbps) is lower than the
 *       recommended bitrate. We recommend that you use a stream bitrate
 *       of 6800 Kbps.
 *
 * That warning is not about the internet and it is not about the encoder. It is
 * a COMPARISON, and until now this app was not a party to it. YouTube looks at
 * the picture size and frame rate arriving at its ingest, looks up its own
 * recommended bitrate for that shape, compares it with the bitrate actually
 * arriving, and complains if the second number is smaller. Nothing anywhere in
 * this app knew the first number existed.
 *
 * So the app could — and routinely did — send a 1920x1080 picture with a
 * bitrate chosen from a preset list that has no idea what 1920x1080 costs on
 * YouTube. Three separate roads led to the same warning:
 *
 *   1. THE SIZE AND THE BITRATE CAME FROM DIFFERENT PLACES. The program canvas
 *      was sized from the largest destination preset and the encode bitrate
 *      from the highest one — different presets, so "1080p" could be sent at a
 *      720p preset's 2500 kbps. YouTube wants 4500 for 1080p30. Warning, every
 *      time, on a flawless line.
 *   2. THE PRESETS TOP OUT BELOW THE RECOMMENDATION. Presets follow vMix's
 *      list, whose biggest 1080p entry is 6 mbps. A 60fps camera makes the
 *      program 1080p60, and YouTube's recommendation for 1080p60 is 6800 — so
 *      even the largest preset in the app, running perfectly, warned.
 *   3. AUTO-FIT AND THE LINE. When the line cannot carry it, the rate comes
 *      down and stays down; the picture size does not, so the comparison gets
 *      worse, not better. See uplink.js — the answer there is to send a SMALLER
 *      PICTURE, not a starved big one.
 *
 * This module is the missing first number. Every tier below is YouTube's own
 * published live range for H.264 at that shape (they are also inside what
 * Facebook, Twitch and X accept, so one table serves every destination).
 *
 * `rec` is deliberately DERIVED from the range rather than typed in, because
 * the midpoint is what the platform quotes back at the operator: 1080p60 is
 * (4500 + 9000) / 2 = 6750, rounded to the nearest hundred = 6800 — the exact
 * figure in the warning above, from a real service. That agreement is the only
 * evidence anybody has that this table is the same table YouTube is using, so
 * the derivation stays visible instead of being flattened into constants.
 */

/*
 * H.264 live ranges, in kbps, largest first. `h` is the SHORT side of the
 * picture: a vertical 1080x1920 Reel costs the same as a horizontal 1920x1080
 * service, and both are the 1080 tier.
 */
const TIERS = [
  { h: 2160, fps: 60, min: 20000, max: 51000 },
  { h: 2160, fps: 30, min: 13000, max: 34000 },
  { h: 1440, fps: 60, min:  9000, max: 18000 },
  { h: 1440, fps: 30, min:  6000, max: 13000 },
  { h: 1080, fps: 60, min:  4500, max:  9000 },
  { h: 1080, fps: 30, min:  3000, max:  6000 },
  { h:  720, fps: 60, min:  2250, max:  6000 },
  { h:  720, fps: 30, min:  1500, max:  4000 },
  { h:  480, fps: 30, min:   500, max:  2000 },
  { h:  360, fps: 30, min:   400, max:  1000 },
  { h:  240, fps: 30, min:   300, max:   700 },
].map((t) => ({ ...t, rec: Math.round((t.min + t.max) / 2 / 100) * 100 }));

/*
 * Which rate column a production frame rate lands in.
 *
 * There are only two columns, so everything above 30 is charged at the 60 rate:
 * a 50fps PAL camcorder is nearer 60 than 30 in what it costs to encode, and
 * charging it at the 30 rate is how a stream ends up below the recommendation
 * without anybody choosing anything. 30 is the floor — a platform never asks
 * for LESS because the camera is slow.
 */
const rateColumn = (fps) => (Number(fps) > 32 ? 60 : 30);

/** The short side of the picture, which is the tier it belongs to. */
const shortSide = (width, height) => Math.min(Number(width) || 0, Number(height) || 0);

const tiersAt = (fps) => TIERS.filter((t) => t.fps === rateColumn(fps));

/**
 * What this platform expects for a picture of this shape, in kbps.
 *
 * Sizes between two tiers are interpolated rather than snapped, so a 900-line
 * picture is not charged at 720 (which under-sends and warns) nor at 1080
 * (which wastes a third of a church's upload for pixels nobody asked for).
 */
function bandFor(width, height, fps) {
  const col = rateColumn(fps);
  const rows = tiersAt(col);
  const side = shortSide(width, height);
  const band = (min, max) => ({ min: Math.round(min), max: Math.round(max),
    rec: Math.round((min + max) / 2 / 100) * 100, fps: col, side });
  if (!side) return { ...band(rows[rows.length - 1].min, rows[rows.length - 1].max), side: 0 };
  const exact = rows.find((t) => t.h === side);
  if (exact) return { min: exact.min, max: exact.max, rec: exact.rec, fps: col, side, tier: exact.h };
  if (side >= rows[0].h) return { ...band(rows[0].min, rows[0].max), tier: rows[0].h };
  const last = rows[rows.length - 1];
  if (side <= last.h) return { ...band(last.min, last.max), tier: last.h };
  // between two tiers: straight line on the short side
  for (let i = 0; i < rows.length - 1; i++) {
    const hi = rows[i], lo = rows[i + 1];
    if (side < hi.h && side > lo.h) {
      const f = (side - lo.h) / (hi.h - lo.h);
      return { ...band(lo.min + (hi.min - lo.min) * f, lo.max + (hi.max - lo.max) * f), tier: side };
    }
  }
  return { ...band(last.min, last.max), tier: last.h };
}

/** The one number the platform compares against. */
const recommendedKbps = (width, height, fps) => bandFor(width, height, fps).rec;

/**
 * Would a stream of this shape at this bitrate draw the warning?
 *
 * The comparison is against `rec`, not `min`, because `rec` is the number the
 * platform quotes — a stream sitting between min and rec is inside the
 * published range and still gets told off, which is exactly how an operator
 * ends up believing their internet is broken.
 */
function meets(width, height, fps, videoKbps) {
  return (Number(videoKbps) || 0) >= recommendedKbps(width, height, fps);
}

/** How far below the recommendation this stream is, in kbps (0 if it is fine). */
function shortfallKbps(width, height, fps, videoKbps) {
  return Math.max(0, recommendedKbps(width, height, fps) - (Number(videoKbps) || 0));
}

/**
 * The biggest picture this much upload can actually FEED, rather than the
 * biggest picture it can technically carry.
 *
 * This is the whole shift. Sending 1080p down a line that can only feed 720p
 * does not produce a slightly soft 1080p — it produces a 1080p stream that the
 * platform, correctly, reports as under-fed for the whole service. A 720p
 * stream at the 720p rate is not a compromise; it is the honest picture for
 * that line, and it is the one that arrives clean.
 *
 * `usableKbps` is what the line can give THIS stream once headroom is taken
 * (see uplink.js) and once it is shared between destinations.
 */
function fitTier(usableKbps, { fps = 30, portrait = false, maxSide = 2160 } = {}) {
  const budget = Number(usableKbps) || 0;
  const wanted = rateColumn(fps);
  const at = (col) => tiersAt(col).filter((t) => t.h <= maxSide);
  let col = wanted;
  let pick = at(col).find((t) => t.rec <= budget);
  /*
   * NOTHING IN THE 60fps COLUMN FITS → RECOMMEND 30fps, not a tiny picture.
   *
   * The 60 column stops at 720 because no platform publishes a 480p60 rate,
   * so a line that cannot feed 720p60 would otherwise be told to drop to 720p
   * anyway and stay there, still under-rated, with nothing having changed. A
   * 60fps camera is not a decision anybody made — 'Auto' follows whatever the
   * camera hands over — and halving the rate buys back a whole tier of
   * picture. 1080p30 looks considerably better than 480p60 in a church.
   */
  let droppedTo30 = false;
  if (!pick && wanted === 60) {
    const alt = at(30).find((t) => t.rec <= budget);
    if (alt) { pick = alt; col = 30; droppedTo30 = true; }
  }
  if (!pick) { const rows = at(col); pick = rows[rows.length - 1]; }
  const long = Math.round((pick.h * 16) / 9 / 2) * 2;
  return {
    width: portrait ? pick.h : long,
    height: portrait ? long : pick.h,
    fps: col,
    droppedTo30,
    videoKbps: pick.rec,
    tier: pick.h,
    band: { min: pick.min, max: pick.max, rec: pick.rec },
    // true when even the smallest tier costs more than the line has: the
    // caller must say so rather than quietly pretending this fits
    over: pick.rec > budget,
  };
}

/**
 * The preset in `catalogue` that IS this tier — same short side, same rate
 * column, bitrate at or above the recommendation.
 *
 * Naming a real preset matters more than it looks: the operator has to find it
 * in a dropdown, so an answer of "use 4100 kbps" is not an answer at all.
 * Returns null when the catalogue simply has no preset big enough, which is a
 * fact the caller needs (it is cause 2 at the top of this file).
 */
function presetKeyFor(tier, catalogue, { portrait = false } = {}) {
  const want = tier && tier.tier ? tier : null;
  if (!want) return null;
  const entries = Object.entries(catalogue || {}).filter(([, q]) =>
    q && !q.profile && shortSide(q.width, q.height) === want.tier &&
    (portrait ? q.height > q.width : q.width >= q.height) &&
    rateColumn(q.fps || want.fps) === want.fps &&
    (q.videoKbps || 0) >= want.videoKbps);
  if (!entries.length) return null;
  // the cheapest preset that still meets the recommendation — anything above it
  // spends the church's upload on nothing the platform asked for
  entries.sort((a, b) => (a[1].videoKbps || 0) - (b[1].videoKbps || 0));
  return entries[0][0];
}

module.exports = {
  TIERS, rateColumn, shortSide, bandFor, recommendedKbps, meets, shortfallKbps,
  fitTier, presetKeyFor,
};
