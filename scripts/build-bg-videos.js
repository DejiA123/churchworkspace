'use strict';
/*
 * Build the motion-background collection for the Presentation Studio.
 *
 * The clips themselves are NOT shipped — thirty HD loops is the better part of
 * a gigabyte, and a church that wants four of them should not download the
 * other twenty-six. What ships is this manifest plus a small poster for each,
 * so the gallery is instant and works with the wifi off; the video itself comes
 * down once, on the click that chooses it, and is then on the machine for good.
 *
 * Everything below is measured from the source rather than assumed:
 *   • which quality rung is 1080p (Pixabay scales relative to the original, so
 *     a 4K clip's "small" is 1080p while an HD clip's "large" is),
 *   • the real byte size, so the tile can say what it will cost,
 *   • the real pixel size and duration, via ffprobe over https.
 *
 *   node scripts/build-bg-videos.js            # refresh everything
 *   node scripts/build-bg-videos.js --posters  # posters only
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'assets', 'bgvideos');
const MANIFEST = path.join(ROOT, 'src', 'renderer', 'bgvideos.js');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;

/*
 * The collection, curated for a church platform: calm enough to sit BEHIND
 * words, no faces to become the subject, nothing that dates the service.
 * `base` is the Pixabay CDN path (everything before _tiny.jpg / _small.mp4).
 */
/*
 * Every name below was checked against its own poster, not against the tags
 * Pixabay carries — "Golden Particles" turned out to be a purple starfield.
 * Seven candidates were thrown out at that stage and the reasons are worth
 * keeping: a framed scroll (a border inside a background), a collage of loose
 * pages, neon flowers and a fantasy canyon (both fight the words), a shrine
 * gate, a pair of hands reading, and a beautiful ocean clip that is 125 MB at
 * 1080p — five times its neighbours for one background.
 */
const CLIPS = [
  /* ---- Faith: the ones a Bible reading or communion actually wants ---- */
  { id: '70216', base: '2021/04/06/70216-533814725', name: 'Open Bible', cat: 'Faith' },
  { id: '150149', base: '2023/02/11/150149-797999298', name: 'Scripture & Light', cat: 'Faith' },
  { id: '117183', base: '2022/05/16/117183-710602933', name: 'Bible & Candles', cat: 'Faith' },
  { id: '139047', base: '2022/11/15/139047-771365739', name: 'Oil Lamp', cat: 'Faith' },
  { id: '139046', base: '2022/11/15/139046-771365734', name: 'Candlelit Book', cat: 'Faith' },
  { id: '134964', base: '2022/10/15/134964-760679909', name: 'Scripture & Bokeh', cat: 'Faith' },
  { id: '106885', base: '2022/02/06/106885-674268702', name: 'Quiet Study', cat: 'Faith' },

  /* ---- Light: the safest thing to put white lyrics on ---- */
  { id: '214405', base: '2024/05/29/214405', name: 'Rose Light', cat: 'Light' },
  { id: '219969', base: '2024/07/07/219969', name: 'Blue Rays', cat: 'Light' },
  { id: '217486', base: '2024/06/20/217486', name: 'Starlight', cat: 'Light' },
  { id: '214402', base: '2024/05/29/214402', name: 'Purple Haze', cat: 'Light' },
  { id: '183558', base: '2023/10/05/183558-871642742', name: 'Candle Flames', cat: 'Light' },
  { id: '165208', base: '2023/05/31/165208-832102298', name: 'Soft Bokeh', cat: 'Light' },

  /* ---- Nature ---- */
  { id: '175953', base: '2023/08/14/175953-854496176', name: 'Forest River', cat: 'Nature' },
  { id: '169880', base: '2023/07/03/169880-841954078', name: 'Misty Path', cat: 'Nature' },
  { id: '174588', base: '2023/08/04/174588-851804340', name: 'Hidden Falls', cat: 'Nature' },
  { id: '201447', base: '2024/02/21/201447-915698694', name: 'Meadow', cat: 'Nature' },
  { id: '236711', base: '2024/10/17/236711', name: 'Campfire', cat: 'Nature' },

  /* ---- Water & sky ---- */
  { id: '178807', base: '2023/09/02/178807-860734626', name: 'Sea Sunset', cat: 'Water' },
  { id: '178809', base: '2023/09/02/178809-860734631', name: 'Evening Shore', cat: 'Water' },
  { id: '174468', base: '2023/08/03/174468-851502076', name: 'Sunset Sphere', cat: 'Water' },
  { id: '173656', base: '2023/07/29/173656-849839042', name: 'Tree of Light', cat: 'Water' },

  /* ---- Abstract ---- */
  { id: '165229', base: '2023/05/31/165229-832460001', name: 'Golden Dust', cat: 'Abstract' },
  { id: '178799', base: '2023/09/02/178799-860734620', name: 'Blue Lines', cat: 'Abstract' },
  { id: '203021', base: '2024/03/04/203021-919745637', name: 'Ribbons', cat: 'Abstract' },
  { id: '202583', base: '2024/03/01/202583-918431492', name: 'Warm Spiral', cat: 'Abstract' },

  /* ---- Season ---- */
  { id: '93079', base: '2021/10/24/93079-639008190', name: 'Harvest Bible', cat: 'Season' },
  { id: '143328', base: '2022/12/17/143328-782178570', name: 'Winter Candle', cat: 'Season' },
];

const CDN = (base, suffix) => `https://cdn.pixabay.com/video/${base}${suffix}`;
const VARIANTS = ['tiny', 'small', 'medium', 'large'];

function head(url) {
  return new Promise((res) => {
    const r = https.request(url, { method: 'HEAD', headers: { 'User-Agent': 'ChurchWorkSpace' } }, (x) => {
      x.resume();
      res(x.statusCode === 200 ? Number(x.headers['content-length'] || 0) : 0);
    });
    r.on('error', () => res(0));
    r.setTimeout(25000, () => { r.destroy(); res(0); });
    r.end();
  });
}
function download(url, dest) {
  return new Promise((res, rej) => {
    const f = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'ChurchWorkSpace' } }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      r.pipe(f);
      f.on('finish', () => f.close(() => res(true)));
    }).on('error', rej);
  });
}
function probe(url) {
  try {
    const o = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration', '-of', 'json', url], { timeout: 90000 }).toString());
    const s = (o.streams || [])[0] || {};
    return { w: s.width || 0, h: s.height || 0, secs: Math.round(Number((o.format || {}).duration || 0)) };
  } catch (e) { return { w: 0, h: 0, secs: 0 }; }
}

/* What the last run measured, so a re-run only probes what actually changed
 * (each probe is an https round trip and there are four rungs per clip). */
function previous() {
  const out = new Map();
  try {
    const src = fs.readFileSync(MANIFEST, 'utf-8');
    for (const m of src.matchAll(/\{ id: '(\d+)',[^}]*url: '([^']+)', bytes: (\d+), w: (\d+), h: (\d+), secs: (\d+) \}/g)) {
      out.set(m[1], { url: m[2], bytes: Number(m[3]), w: Number(m[4]), h: Number(m[5]), secs: Number(m[6]) });
    }
  } catch (e) {}
  return out;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const postersOnly = process.argv.includes('--posters');
  const refresh = process.argv.includes('--refresh');
  const known = refresh ? new Map() : previous();
  const done = [];

  for (const c of CLIPS) {
    process.stdout.write(`${c.name} (${c.id}) … `);

    /* poster: 480px wide, quality 6 — a few kilobytes, sharp in a 156px tile */
    const posterOut = path.join(OUT_DIR, c.id + '.jpg');
    if (!fs.existsSync(posterOut)) {
      const tmp = posterOut + '.src.jpg';
      try {
        await download(CDN(c.base, '_tiny.jpg'), tmp);
        execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', tmp, '-vf', 'scale=480:-2', '-q:v', '6', posterOut], { timeout: 60000 });
      } catch (e) { process.stdout.write('poster FAILED ' + e.message + '\n'); continue; }
      finally { try { fs.rmSync(tmp, { force: true }); } catch (e) {} }
    }
    if (postersOnly) { process.stdout.write('poster ok\n'); done.push(Object.assign({}, c)); continue; }
    if (known.has(c.id)) {
      const k = known.get(c.id);
      done.push(Object.assign({}, c, k));
      process.stdout.write(`${k.w}x${k.h}, ${(k.bytes / 1048576).toFixed(1)} MB (cached)\n`);
      continue;
    }

    /*
     * WHICH RUNG IS 1080p.
     *
     * Pixabay scales each rung off the ORIGINAL, so there is no fixed mapping:
     * a 4K clip's "small" is 1920x1080 while an HD clip's "large" is. Taking
     * the smallest rung that still reaches 1080 gives a projector the real
     * thing without dragging a 95 MB 4K master over church wifi.
     */
    const sizes = {};
    for (const v of VARIANTS) sizes[v] = await head(CDN(c.base, `_${v}.mp4`));
    let pick = null;
    for (const v of VARIANTS) {
      if (!sizes[v]) continue;
      const dim = probe(CDN(c.base, `_${v}.mp4`));
      if (dim.h >= 1080) { pick = Object.assign({ variant: v, bytes: sizes[v] }, dim); break; }
      pick = Object.assign({ variant: v, bytes: sizes[v] }, dim);   // fallback: the best we saw
    }
    if (!pick || !pick.w) { process.stdout.write('NO USABLE VIDEO\n'); continue; }
    done.push(Object.assign({}, c, {
      url: CDN(c.base, `_${pick.variant}.mp4`), bytes: pick.bytes, w: pick.w, h: pick.h, secs: pick.secs,
    }));
    process.stdout.write(`${pick.w}x${pick.h}, ${(pick.bytes / 1048576).toFixed(1)} MB (${pick.variant})\n`);
  }

  if (postersOnly) { console.log(`\n${done.length} posters.`); return; }

  const cats = [];
  for (const c of done) if (!cats.includes(c.cat)) cats.push(c.cat);
  const body = done.map((c) => `  { id: '${c.id}', name: ${JSON.stringify(c.name)}, cat: '${c.cat}', `
    + `url: '${c.url}', bytes: ${c.bytes}, w: ${c.w}, h: ${c.h}, secs: ${c.secs} },`).join('\n');

  fs.writeFileSync(MANIFEST, `'use strict';
/*
 * The motion backgrounds offered in the Presentation Studio.
 *
 * GENERATED by scripts/build-bg-videos.js — edit the curated list there, not here.
 *
 * Only the poster ships with the app (assets/bgvideos/<id>.jpg, a few kB each).
 * The clip itself is fetched once, on the click that chooses it, and lands in
 * <userData>/backgrounds — after which it plays with the network unplugged,
 * which is the only state that matters on a Sunday morning.
 *
 * Footage: Pixabay (pixabay.com), Pixabay Content License.
 */
(() => {
  const CLIPS = [
${body}
  ];
  const CATEGORIES = ${JSON.stringify(cats)};
  const byId = (id) => CLIPS.find((c) => c.id === String(id)) || null;
  window.BgVideos = { CLIPS, CATEGORIES, byId };
})();
`, 'utf-8');

  const mb = done.reduce((s, c) => s + c.bytes, 0) / 1048576;
  console.log(`\n${done.length} clips written to ${path.relative(ROOT, MANIFEST)} (${mb.toFixed(0)} MB if every one were downloaded).`);
})();
