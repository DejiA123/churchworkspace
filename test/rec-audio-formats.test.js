'use strict';
/*
 * "MP4A SEEMS NOT TO WORK WELL IN A LOT OF SYSTEMS" — so which recording audio
 * format actually plays?
 *
 * This builds a real MPEG-TS the way the live hub does (H.264 + AAC), remuxes it
 * into every offered recording format for real, and then DECODES each result
 * two ways:
 *   1. ffprobe — is the file structurally valid, and what codec/tag did it get?
 *   2. a real Chromium <video> element — does it actually load and report an
 *      audio track? That is the closest thing to "will this open on someone
 *      else's machine" that can be checked automatically.
 * It also measures each format's size cost, since uncompressed audio is a real
 * trade for a 2-hour service.
 *
 *   npx electron test/rec-audio-formats.test.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { REC_FORMATS, recFormat } = require(path.join(ROOT, 'src/main/livestream'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const { mfDecodesAudio, audioSpecificConfig } = require('./helpers/mf-play');

const WORK = path.join(os.tmpdir(), 'mw-recfmt-test');
fs.mkdirSync(WORK, { recursive: true });
const SRC_TS = path.join(WORK, 'hub-feed.ts');
const SECS = 5;

let failed = false;
const log = (okv, name, d) => { console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : '')); if (!okv) failed = true; };

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  /* ---- a feed shaped exactly like the program hub's output ---- */
  console.log(`\n[0] Building a ${SECS}s H.264 + AAC MPEG-TS (what the hub actually emits)`);
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-t', String(SECS), '-i', 'color=c=blue:s=640x360:r=30',
    '-f', 'lavfi', '-t', String(SECS), '-i', 'sine=frequency=440:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-f', 'mpegts', SRC_TS], { stdio: 'ignore' });
  log(fs.existsSync(SRC_TS) && fs.statSync(SRC_TS).size > 1000, 'built the source feed', `${Math.round(fs.statSync(SRC_TS).size / 1024)} KB`);

  // The harness page MUST be loaded with loadFile, not a data: URL. A data: page
  // has an OPAQUE origin, and Chromium then refuses every file:// media load with
  // "Media load rejected by URL safety check" — which looks exactly like a codec
  // failure and is not one. Production loads index.html via loadFile, so this
  // mirrors it.
  const harness = path.join(WORK, 'player.html');
  fs.writeFileSync(harness, '<!doctype html><html><body></body></html>', 'utf-8');
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { webSecurity: false } });
  await win.loadFile(harness);

  /**
   * Load a file in a real Chromium <video> and report what it can actually do.
   *
   * POLLS for decoded bytes rather than sampling once after a fixed delay: the
   * first media element on a fresh page takes noticeably longer to spin up its
   * decoders, and a single early snapshot reported 0 bytes for a file that
   * ffmpeg decodes perfectly — a measurement artifact that reads exactly like a
   * codec failure. Waits for BOTH audio and video to move, or gives up.
   */
  async function chromiumCanPlay(file) {
    const url = 'file:///' + file.replace(/\\/g, '/').replace(/#/g, '%23');
    return win.webContents.executeJavaScript(`new Promise((res) => {
      const v = document.createElement('video');
      v.muted = true;
      let done = false;
      const finish = (o) => { if (!done) { done = true; try { v.pause(); v.remove(); } catch (e) {} res(o); } };
      v.onerror = () => finish({ ok: false, err: (v.error && v.error.message) || 'decode error' });
      v.onloadeddata = () => {
        v.play().then(() => {
          const deadline = Date.now() + 6000;
          const tick = () => {
            // webkitAudioDecodedByteCount proves audio actually DECODED, not just
            // that a track was declared in the container header.
            const a = v.webkitAudioDecodedByteCount || 0;
            const vid = v.webkitVideoDecodedByteCount || 0;
            if ((a > 0 && vid > 0) || Date.now() > deadline) {
              return finish({ ok: true, dur: v.duration, audioBytes: a, videoBytes: vid, waited: 6000 - (deadline - Date.now()) });
            }
            setTimeout(tick, 120);
          };
          tick();
        }).catch((e) => finish({ ok: false, err: 'play(): ' + e.message }));
      };
      setTimeout(() => finish({ ok: false, err: 'timed out loading' }), 12000);
      v.src = ${JSON.stringify('URLPLACEHOLDER')};
      document.body.appendChild(v);
    })`.replace('URLPLACEHOLDER', url));
  }
  // Warm the media stack once so the first real measurement isn't the slow one.
  await chromiumCanPlay(SRC_TS).catch(() => {});

  console.log(`\n[1] Remuxing the feed into every offered recording format, for real`);
  const results = [];
  for (const f of REC_FORMATS) {
    const out = path.join(WORK, `rec-${f.id}${f.ext}`);
    try { fs.rmSync(out, { force: true }); } catch (e) {}
    const spec = recFormat(f.id);
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'mpegts', '-i', SRC_TS,
      '-c:v', 'copy', ...spec.audioArgs(192), ...spec.muxArgs(out)];
    let built = true, errText = '';
    try { execFileSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { built = false; errText = String(e.stderr || e.message).split('\n')[0]; }
    const size = built && fs.existsSync(out) ? fs.statSync(out).size : 0;
    let probe = '';
    if (size) {
      try {
        probe = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0',
          '-show_entries', 'stream=codec_name,codec_tag_string,sample_rate,channels', '-of', 'csv=p=0', out]).toString().trim();
      } catch (e) { probe = 'unreadable'; }
    }
    const play = size ? await chromiumCanPlay(out) : { ok: false, err: 'not built' };
    results.push({ f, out, built, errText, size, probe, play });
  }

  console.log('');
  for (const r of results) {
    log(r.built && r.size > 1000, `[${r.f.id}] ffmpeg writes a real ${r.f.ext} file`, r.built ? `${Math.round(r.size / 1024)} KB` : r.errText);
    log(!!r.probe && r.probe !== 'unreadable', `[${r.f.id}] ffprobe reads its audio stream`, r.probe);
    const codecOk = r.probe.startsWith(r.f.probeCodec);
    log(codecOk, `[${r.f.id}] the audio really is ${r.f.probeCodec}`, r.probe.split(',')[0]);
  }

  console.log('\n[2] Does a real Chromium engine PLAY it, with audio decoding?');
  for (const r of results) {
    const p = r.play;
    console.log(`  ${r.f.id.padEnd(10)} ${r.f.ext.padEnd(5)} ${p.ok ? 'plays' : 'NO'}` +
      (p.ok ? `  dur=${(p.dur || 0).toFixed(1)}s  audio decoded=${p.audioBytes}B  video=${p.videoBytes}B` : `  (${p.err})`));
  }
  // The default MUST play everywhere — that is the one every user gets.
  const def = results.find((r) => r.f.id === 'aac');
  log(def && def.play.ok && def.play.audioBytes > 0, 'the DEFAULT (AAC/MP4) plays with audio in Chromium',
    def && `${def.play.audioBytes}B decoded`);

  /* =====================================================================
   * [2b] …AND DOES WINDOWS DECODE IT?
   *
   * Chromium alone was not enough, and that is not a hypothetical: this test
   * passed every check above while a whole service was recorded with sound
   * Windows refused to play ("It's encoded in mp4a format which isn't
   * supported"). Chromium carries its own AAC decoder and guesses at anything
   * missing from the file; Media Foundation — what Media Player and Films & TV
   * use — does not guess. The church opens these files on Windows, so Windows
   * gets a vote.
   * ===================================================================== */
  console.log('\n[2b] Does WINDOWS decode it? (Media Foundation, via a real SourceReader)');
  for (const r of results) {
    if (!r.size) continue;
    r.mf = mfDecodesAudio(r.out);
    r.asc = /\.(mp4|mov)$/i.test(r.f.ext) ? audioSpecificConfig(r.out) : null;
    console.log(`  ${r.f.id.padEnd(10)} ${r.f.ext.padEnd(5)} ${r.mf.raw}` +
      (r.asc ? `  ·  ${r.asc.present ? 'ASC ' + r.asc.hex : 'NO AudioSpecificConfig'}` : ''));
  }
  if (def && def.asc) {
    log(def.asc.present && def.asc.objectType === 2,
      'the DEFAULT carries its AudioSpecificConfig — the thing a fragmented stream-copy leaves out',
      def.asc.present ? `ASC=${def.asc.hex} AAC-LC ${def.asc.sampleRate}Hz ${def.asc.channels}ch` : def.asc.note);
  }
  log(def && def.mf && def.mf.ok, 'the DEFAULT (AAC/MP4) DECODES ON WINDOWS — the failure a whole service was lost to',
    def && def.mf && def.mf.raw);
  // Every format the app OFFERS has to open on the machine the church uses.
  // A recording format that Windows cannot decode is not a fallback, it is a
  // second dead end handed to someone already stuck — which is exactly why
  // MP3-in-MP4 was withdrawn after this check first ran.
  for (const r of results) {
    if (!r.size || r.f.id === 'aac') continue;
    log(r.mf && r.mf.ok, `[${r.f.id}] is offered, so it must decode on Windows too`, r.mf && r.mf.raw);
  }
  // Every offered format must at least be a structurally valid file.
  log(results.every((r) => r.built && r.size > 1000), 'every offered format produces a valid file');
  // Compatibility claims on the labels must be earned, not asserted: anything we
  // call "plays in almost anything" has to at least decode here.
  for (const r of results.filter((x) => x.f.chromiumMustPlay)) {
    log(r.play.ok && r.play.audioBytes > 0, `[${r.f.id}] labelled widely-compatible AND decodes audio here`,
      r.play.ok ? `${r.play.audioBytes}B` : r.play.err);
  }

  console.log('\n[3] Size cost (a 2-hour service is the real test)');
  const base = results.find((r) => r.f.id === 'aac');
  for (const r of results) {
    const ratio = base && base.size ? r.size / base.size : 1;
    const perHour = (r.size / SECS) * 3600 / (1024 * 1024 * 1024);
    console.log(`  ${r.f.id.padEnd(10)} ${(ratio).toFixed(2)}x vs AAC   ≈ ${perHour.toFixed(2)} GB/hour at this resolution`);
  }

  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); app.exit(1); });
