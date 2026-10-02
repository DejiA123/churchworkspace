'use strict';
/*
 * HOW MUCH UPLOAD HAVE YOU ACTUALLY GOT, AND WILL SUNDAY FIT DOWN IT?
 *
 * The failure this exists to prevent, from a real service: Facebook and YouTube
 * both on the same 1080p preset, both pure copies, no re-encoding — and forty
 * minutes in YouTube is arriving at 2.3 Mbps with warbling audio while Facebook
 * is flawless. Nothing was wrong with the encode. Two 1080p streams need about
 * 12.3 Mbps of upload, the line could not carry it, and TCP does not share what
 * it has fairly between two different platforms: one wins and one starves.
 * Which one starves is decided by routing, not by anything the operator did.
 *
 * The app already copes once that is happening — it drops picture on the
 * starving destination to protect the preaching, and says so. But coping is not
 * the same as knowing, and the operator finds out from the pew. This measures
 * the line BEFORE the service and does the arithmetic that nobody should have
 * to do in their head.
 *
 * MEASUREMENT, and why it is not measured against YouTube itself: the only way
 * to learn the true throughput to an RTMP ingest is to publish to it, and
 * publishing to YouTube starts the broadcast. A pre-flight check that puts a
 * church live by accident is worse than no pre-flight check. So the throughput
 * is measured against a neutral endpoint built for exactly this, and the answer
 * is treated as an estimate of the LINE rather than of the route.
 *
 * HEADROOM is the other half of being honest. A line measured at 10 Mbps cannot
 * carry 10 Mbps of video: RTMP framing, TCP recovery, the rest of the building
 * on the same wifi, and the simple fact that a broadcast bitrate is an average
 * with peaks above it. Planning to fill the pipe is planning to shed. So a plan
 * only "fits" if it needs no more than USABLE of what was measured.
 */
const https = require('https');
const { URL } = require('url');
const streamrate = require('./streamrate');

/* A church hall shares its line with everything else in the building, and a
 * broadcast bitrate is an average with peaks well above it. Two thirds is the
 * number that stops a plan from being a plan to shed. */
const USABLE = 0.66;

/* Endpoints that accept a POST body and discard it, in preference order. Both
 * are public speed-test endpoints; nothing is uploaded but zeroes. */
const ENDPOINTS = [
  'https://speed.cloudflare.com/__up',
  'https://httpbin.org/post',
];

const KB = 1024;

/**
 * Push zeroes at a neutral endpoint and time it.
 *
 * Returns Mbps as the BEST sustained sample rather than the mean: TCP spends
 * the first moment ramping up, and averaging that in makes every line look
 * worse than it is. The best sample is what the line can actually do; the
 * headroom rule above is what keeps the plan honest.
 */
function measureOnce(url, bytes, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve(null); }
    const body = Buffer.alloc(bytes, 0);
    const started = Date.now();
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', port: 443,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        const secs = (Date.now() - started) / 1000;
        if (secs <= 0.05) return resolve(null);
        resolve({ mbps: (body.length * 8) / secs / 1e6, secs, bytes: body.length });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

/**
 * Measure the line.
 *
 * Three passes of growing size: a small one to open the window, then two real
 * ones. Small transfers measure latency, not throughput, which is how a good
 * line gets reported as a bad one.
 */
async function measure({ onProgress } = {}) {
  const say = (m) => { try { if (onProgress) onProgress(m); } catch (e) {} };
  const sizes = [512 * KB, 3072 * KB, 6144 * KB];
  for (const url of ENDPOINTS) {
    const samples = [];
    let host = '';
    try { host = new URL(url).hostname; } catch (e) {}
    for (let i = 0; i < sizes.length; i++) {
      say({ step: i + 1, of: sizes.length, host });
      const r = await measureOnce(url, sizes[i], 25000);
      if (!r) { samples.length = 0; break; }          // this endpoint is no good; try the next
      if (i > 0) samples.push(r.mbps);                 // the first pass is warm-up only
    }
    if (samples.length) {
      const mbps = Math.max(...samples);
      return { ok: true, mbps, samples, host, at: Date.now() };
    }
  }
  return { ok: false, error: 'Could not reach a speed-test server. Check this computer is online.' };
}

/* ------------------------------ the arithmetic --------------------------- */

/**
 * What one destination costs on the wire, in Mbps.
 *
 * NOT the preset's bitrate. A destination costs what the app will actually
 * send, and since platformKbps (livestream.js) raises a preset to the
 * platform's own recommendation for the picture size being sent, that is the
 * number this has to plan against. Costing 1080p at a 720p preset's 2.5 mbps
 * is how a line gets told it has room for a stream that then arrives
 * under-rated — the pre-flight agreeing with the encoder is the entire point
 * of it existing.
 */
const costOf = (q, productionFps) => {
  if (!q) return 0;
  const fps = q.fps || productionFps || 30;
  const video = Math.max(q.videoKbps || 0,
    (q.width && q.height) ? streamrate.recommendedKbps(q.width, q.height, fps) : 0);
  return (video + (q.audioKbps || 0)) / 1000;
};

/**
 * Does this line carry these destinations, and if not, what would?
 *
 * `qualities` is the preset each destination is set to. `catalogue` is every
 * preset available, so a recommendation can be an actual named preset the
 * operator can pick rather than a number they then have to translate.
 */
function plan(qualities, mbps, catalogue, productionFps) {
  const qs = (qualities || []).filter(Boolean);
  const needMbps = qs.reduce((n, q) => n + costOf(q, productionFps), 0);
  const usable = (Number(mbps) || 0) * USABLE;
  const fits = qs.length > 0 && needMbps <= usable;
  const out = { count: qs.length, needMbps, mbps: Number(mbps) || 0, usable, usableFraction: USABLE, fits };
  if (fits || !qs.length) return out;

  /*
   * The recommendation deliberately keeps every destination on the SAME preset.
   * Giving one destination a smaller one is the obvious move and it is a trap:
   * mismatched presets cannot be copied from the single program encode, so the
   * odd one out gets re-encoded live — a second 1080p encode on a church PC,
   * which fails in a way that looks exactly like bad internet.
   */
  const biggest = qs.reduce((m, q) => (q.width * q.height > m.width * m.height ? q : m), qs[0]);
  const perDestKbps = (usable / qs.length) * 1000 - (biggest.audioKbps || 128);
  const fps = biggest.fps || productionFps || 30;
  const portrait = biggest.height > biggest.width;

  /*
   * A SMALLER PICTURE, not a starved big one.
   *
   * The old answer here was "the cheapest preset that fits", which could keep
   * the operator on 1080p at a preset bitrate the line happened to have room
   * for — and that is precisely the stream YouTube reports as under-rated for
   * the whole service, because 1080p has a price and it is not negotiable.
   * fitTier picks the biggest picture this line can actually FEED at the rate
   * the platform expects for it, which is the only shape that arrives clean.
   */
  const tier = streamrate.fitTier(perDestKbps, {
    fps, portrait, maxSide: Math.min(biggest.width, biggest.height),
  });
  const key = streamrate.presetKeyFor(tier, catalogue, { portrait });
  const rec = catalogue && key ? catalogue[key] : null;
  out.recommend = rec ? {
    key, quality: rec, totalMbps: costOf(rec, tier.fps) * qs.length,
    keepsSize: Math.min(rec.width, rec.height) === Math.min(biggest.width, biggest.height),
    tier: tier.tier,
    // A 60fps production this line cannot feed: the frame rate is the cheaper
    // thing to give up, and nobody chose 60 in the first place — 'Auto' just
    // followed the camera. See fitTier.
    setFps: tier.droppedTo30 ? 30 : 0,
  } : null;
  // Even the smallest picture in the list costs more than this line has — the
  // honest answer then is one platform, not a smaller one.
  out.tooSmallForAny = !!tier.over;
  out.shortfallMbps = needMbps - usable;
  return out;
}

/** One sentence an operator can act on, with no jargon in it. */
function verdict(p) {
  if (!p || !p.count) return '';
  const n = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const many = p.count > 1;
  const dests = `${p.count} destination${many ? 's' : ''}`;
  if (p.fits) {
    return `Your upload measured ${n(p.mbps)} Mbps. ${dests} ${many ? 'need' : 'needs'} `
      + `${n(p.needMbps)} Mbps — that fits with room to spare.`;
  }
  /* The consequence is spelled out because the number on its own means nothing
   * to most operators, and because the way it FAILS is the confusing part: with
   * two destinations one of them stays perfect, which is exactly why the other
   * one looks like the platform's fault rather than the line's. */
  const head = `Your upload measured ${n(p.mbps)} Mbps, and ${dests} at this quality `
    + `${many ? 'need' : 'needs'} ${n(p.needMbps)} Mbps. It will not fit`
    + (many
      ? ', and one destination will lose its picture partway through the service while the other looks perfect.'
      : ', so the picture will start dropping partway through the service.');
  if (!p.recommend) {
    return head + (p.tooSmallForAny
      ? ' Even the smallest picture costs more than this line has spare, so stream to one platform instead.'
      : ' Lower the streaming quality, or stream to one platform instead of two.');
  }
  /*
   * The answer is a SMALLER PICTURE and it is worth saying why, because it is
   * the opposite of what an operator expects. Leaving the picture at 1080p and
   * letting it run at whatever the line has spare does not give a slightly
   * softer 1080p; it gives a 1080p stream the platform reports as under-fed —
   * that yellow "your bitrate is lower than the recommended bitrate" banner —
   * for the whole service. A 720p picture at the 720p rate is a full-quality
   * stream of a smaller picture, and it is the one that arrives clean.
   */
  const fpsBit = p.recommend.setFps
    ? `, and set the production frame rate to ${p.recommend.setFps} (your camera is running faster than `
      + `this line can pay for, and nobody chose that — 'Auto' simply followed it)`
    : '';
  return head + ` Use “${p.recommend.key}”${many ? ' on every destination' : ''}${fpsBit} — that is `
    + `${n(p.recommend.totalMbps)} Mbps${many ? ' in total' : ''}, which this line can carry`
    + (p.recommend.keepsSize && !p.recommend.setFps ? '.'
      : `. It is a smaller picture on purpose: a big picture sent at less than the `
        + `platform asks for is reported as a poor stream all service, while the smaller `
        + `one arrives at full quality.`);
}

module.exports = { measure, plan, verdict, costOf, USABLE };
