'use strict';
/*
 * Verifies the macOS auto-captions drop-in path WITHOUT needing a Mac:
 *   - the binary resolver finds the layouts a real drop lands in (arch-suffixed,
 *     whisper.cpp's own build/bin, plain), for mac/linux/win, using temp dirs
 *   - engineInfo() explains a missing engine in actionable words
 *   - the packaging config ships whisper to mac minus the Windows artifacts
 *   - the afterPack hook keeps whisper when a mac binary is present and drops it
 *     when it isn't — and never touches a Windows build
 * On a Mac WITH a binary in place it goes further and actually transcribes a
 * generated clip, so `npm run test:whisper-mac` is also the pre-flight check
 * before `npm run dist:mac`.
 *
 *   node test/whisper-mac.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cap = require(path.join(ROOT, 'src/main/captioner'));
const afterPack = require(path.join(ROOT, 'build/after-pack.js'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  -> ' + detail : ''));
  ok ? pass++ : fail++;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-whisper-mac-'));
const touch = (rel) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'binary');
  return p;
};
const fresh = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };

/* ---------------- 1. candidate list per platform ---------------- */
console.log('\n[1] Which filenames each platform looks for');
const win = cap.cliCandidates('win32', 'x64');
const mac = cap.cliCandidates('darwin', 'arm64');
const macIntel = cap.cliCandidates('darwin', 'x64');
check('windows looks for whisper-cli.exe under Release/', win[0] === path.join('Release', 'whisper-cli.exe'), win.join(', '));
check('windows never looks for an extension-less binary', !win.some((c) => /whisper-cli$/.test(c)));
check('mac prefers its own arch first', mac[0] === path.join('Release', 'whisper-cli-arm64'), mac.slice(0, 4).join(', '));
check('mac falls back to plain whisper-cli', mac.includes(path.join('Release', 'whisper-cli')));
check('an Intel Mac asks for the x64 build', macIntel[0] === path.join('Release', 'whisper-cli-x64'));
check('mac also accepts whisper.cpp\'s own build/bin layout', mac.includes(path.join('build', 'bin', 'whisper-cli')));
check('mac accepts the binary dropped straight in the folder', mac.includes('whisper-cli'));

/* ---------------- 2. resolver against real directory layouts ---------------- */
console.log('\n[2] Resolver against the layouts a real drop produces');
const layoutRelease = fresh('l-release'); fs.mkdirSync(path.join(layoutRelease, 'Release'));
fs.writeFileSync(path.join(layoutRelease, 'Release', 'whisper-cli'), 'x');
check('finds Release/whisper-cli', cap.findCli(layoutRelease, 'darwin', 'arm64') === path.join(layoutRelease, 'Release', 'whisper-cli'));

const layoutArch = fresh('l-arch'); fs.mkdirSync(path.join(layoutArch, 'Release'));
fs.writeFileSync(path.join(layoutArch, 'Release', 'whisper-cli'), 'x');
fs.writeFileSync(path.join(layoutArch, 'Release', 'whisper-cli-arm64'), 'x');
check('an arch-specific binary WINS over the generic one',
  cap.findCli(layoutArch, 'darwin', 'arm64') === path.join(layoutArch, 'Release', 'whisper-cli-arm64'));
check('…and the Intel Mac still gets the generic one when there is no -x64',
  cap.findCli(layoutArch, 'darwin', 'x64') === path.join(layoutArch, 'Release', 'whisper-cli'));

const layoutBuild = fresh('l-build'); fs.mkdirSync(path.join(layoutBuild, 'build', 'bin'), { recursive: true });
fs.writeFileSync(path.join(layoutBuild, 'build', 'bin', 'whisper-cli'), 'x');
check('finds whisper.cpp\'s build/bin/whisper-cli', cap.findCli(layoutBuild, 'darwin', 'arm64') === path.join(layoutBuild, 'build', 'bin', 'whisper-cli'));

const layoutFlat = fresh('l-flat');
fs.writeFileSync(path.join(layoutFlat, 'whisper-cli'), 'x');
check('finds a binary dropped straight into bin/whisper', cap.findCli(layoutFlat, 'darwin', 'arm64') === path.join(layoutFlat, 'whisper-cli'));

const layoutWinOnly = fresh('l-winonly'); fs.mkdirSync(path.join(layoutWinOnly, 'Release'));
fs.writeFileSync(path.join(layoutWinOnly, 'Release', 'whisper-cli.exe'), 'x');
check('a Windows-only folder resolves to NOTHING for mac (no false positive)', cap.findCli(layoutWinOnly, 'darwin', 'arm64') === null);
check('…and still resolves for windows', cap.findCli(layoutWinOnly, 'win32', 'x64') === path.join(layoutWinOnly, 'Release', 'whisper-cli.exe'));

const layoutDir = fresh('l-dir'); fs.mkdirSync(path.join(layoutDir, 'Release', 'whisper-cli'), { recursive: true });
check('a DIRECTORY named whisper-cli is not mistaken for the binary', cap.findCli(layoutDir, 'darwin', 'arm64') === null);

/* ---------------- 3. engineInfo speaks in actionable words ---------------- */
console.log('\n[3] engineInfo() explains itself');
const info = cap.engineInfo();
check('reports this platform + arch', info.platform === process.platform && info.arch === process.arch, `${info.platform}/${info.arch}`);
check('names an exact path for the binary', typeof info.cli === 'string' && info.cli.length > 0, info.cli);
if (info.available) {
  check('this machine HAS a working engine (windows dev box)', true, info.cli);
  check('no error text when everything is fine', !info.reason);
} else {
  check('says WHY it is unavailable', !!info.reason, info.reason);
  check('says WHAT TO DO about it', !!info.howTo, (info.howTo || '').slice(0, 90) + '…');
  if (process.platform === 'darwin') {
    check('the mac message points at BUILD-MAC.md §5', /BUILD-MAC\.md/.test(info.howTo || ''));
    check('the mac message names the arch-specific filename', new RegExp('whisper-cli-' + process.arch).test(info.howTo || ''));
    check('the mac message makes clear the REST of captions still works', /burn|edit/i.test(info.howTo || ''));
  }
}

/* ---------------- 4. packaging config ---------------- */
console.log('\n[4] Packaging config is pre-wired');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const macRes = pkg.build.mac.extraResources || [];
const winRes = pkg.build.win.extraResources || [];
const macWhisper = macRes.find((r) => r.from === 'bin/whisper');
const winWhisper = winRes.find((r) => r.from === 'bin/whisper');
check('mac ships bin/whisper', !!macWhisper);
check('mac filters out the Windows .exe', !!macWhisper && macWhisper.filter.includes('!**/*.exe'));
check('mac filters out the Windows .dll', !!macWhisper && macWhisper.filter.includes('!**/*.dll'));
check('mac still ships fonts + ai', ['bin/fonts', 'bin/ai'].every((f) => macRes.some((r) => r.from === f)));
check('WINDOWS resources are unchanged (whisper, unfiltered)', !!winWhisper && !winWhisper.filter);
check('the afterPack hook is registered', pkg.build.afterPack === 'build/after-pack.js');
check('the hook file exists', fs.existsSync(path.join(ROOT, 'build/after-pack.js')));
check('there is a pre-flight script', pkg.scripts['test:whisper-mac'] === 'node test/whisper-mac.test.js');

/* ---------------- 5. the afterPack decision ---------------- */
console.log('\n[5] afterPack keeps or drops whisper correctly');
const withMac = fresh('pack-with'); fs.mkdirSync(path.join(withMac, 'Release'), { recursive: true });
fs.writeFileSync(path.join(withMac, 'Release', 'whisper-cli-arm64'), 'x');
fs.writeFileSync(path.join(withMac, 'ggml-base.en.bin'), 'model');
check('a mac binary is detected -> whisper is KEPT', afterPack.hasMacWhisperCli(withMac) === true);

const winOnlyPack = fresh('pack-winonly'); fs.mkdirSync(path.join(winOnlyPack, 'Release'), { recursive: true });
fs.writeFileSync(path.join(winOnlyPack, 'Release', 'whisper-cli.exe'), 'x');
fs.writeFileSync(path.join(winOnlyPack, 'ggml-base.en.bin'), 'model');
check('only a Windows .exe -> whisper is DROPPED (no 215MB of dead models)', afterPack.hasMacWhisperCli(winOnlyPack) === false);
check('an empty/absent folder -> DROPPED', afterPack.hasMacWhisperCli(fresh('pack-empty')) === false && afterPack.hasMacWhisperCli(path.join(tmp, 'nope')) === false);
check('mac Resources path is inside the .app bundle',
  afterPack.resourcesDir('/out', 'darwin', 'Church Work Space').replace(/\\/g, '/').endsWith('Church Work Space.app/Contents/Resources'));

// the hook must be a no-op for Windows even if the folder looks mac-less
(async () => {
  const winPack = fresh('pack-win-app');
  const winResDir = path.join(winPack, 'resources', 'whisper', 'Release');
  fs.mkdirSync(winResDir, { recursive: true });
  fs.writeFileSync(path.join(winResDir, 'whisper-cli.exe'), 'x');
  await afterPack({ electronPlatformName: 'win32', appOutDir: winPack, packager: { appInfo: { productFilename: 'Church Work Space' } } });
  check('running the hook on a WINDOWS build leaves whisper completely alone',
    fs.existsSync(path.join(winResDir, 'whisper-cli.exe')));

  // …and really deletes it for a mac build with no mac binary
  const macPack = fresh('pack-mac-app');
  const macResDir = path.join(macPack, 'Church Work Space.app', 'Contents', 'Resources', 'whisper');
  fs.mkdirSync(path.join(macResDir, 'Release'), { recursive: true });
  fs.writeFileSync(path.join(macResDir, 'ggml-base.en.bin'), 'model');
  await afterPack({ electronPlatformName: 'darwin', appOutDir: macPack, packager: { appInfo: { productFilename: 'Church Work Space' } } });
  check('a mac build with no mac binary has whisper removed from the .app', !fs.existsSync(macResDir));

  const macPack2 = fresh('pack-mac-app2');
  const macResDir2 = path.join(macPack2, 'Church Work Space.app', 'Contents', 'Resources', 'whisper');
  fs.mkdirSync(path.join(macResDir2, 'Release'), { recursive: true });
  fs.writeFileSync(path.join(macResDir2, 'Release', 'whisper-cli'), 'x');
  fs.writeFileSync(path.join(macResDir2, 'ggml-base.en.bin'), 'model');
  await afterPack({ electronPlatformName: 'darwin', appOutDir: macPack2, packager: { appInfo: { productFilename: 'Church Work Space' } } });
  check('a mac build WITH a mac binary keeps whisper + its models',
    fs.existsSync(path.join(macResDir2, 'Release', 'whisper-cli')) && fs.existsSync(path.join(macResDir2, 'ggml-base.en.bin')));
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(macResDir2, 'Release', 'whisper-cli')).mode & 0o111;
    check('…and marks the binary executable', mode !== 0, '0' + (fs.statSync(path.join(macResDir2, 'Release', 'whisper-cli')).mode & 0o777).toString(8));
  }

  /* ---------------- 6. real run, when a binary is actually present -------- */
  console.log('\n[6] Real transcription (only when this machine has an engine)');
  if (!cap.isAvailable()) {
    console.log('  – skipped: no whisper binary on this machine (' + process.platform + '/' + process.arch + ')');
    if (process.platform === 'darwin') {
      console.log('    ==> Auto-captions will be DISABLED in the .dmg. See BUILD-MAC.md §5.');
    }
  } else {
    const { execFileSync } = require('child_process');
    const ffmpeg = require('ffmpeg-static');
    const ffprobe = require('ffprobe-static').path;
    const clip = path.join(tmp, 'speech.mp4');
    // a spoken-ish tone track is enough to prove the engine starts, decodes and
    // returns structured output; word content is covered by captions-timeline.test.js
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip], { stdio: 'ignore' });
    const t0 = Date.now();
    const res = await cap.transcribe({ ffmpeg, ffprobe }, { input: clip, granularity: 'segment', fast: true });
    check('the engine ran and returned a result object', !!res && Array.isArray(res.words),
      `${(res.words || []).length} entries in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    check('it reported the clip duration', res.durationSec > 3 && res.durationSec < 6, res.durationSec + 's');
    console.log('  engine: ' + cap.whisperPaths().cli);
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
