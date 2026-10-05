'use strict';
/*
 * ONE FILE TO PUT ON A SERVER.
 *
 *   npm run bundle:cloud
 *
 * The setup script used to begin `git clone <your repo>`, which quietly assumed
 * something that is not true: this project has no remote. Anyone following those
 * instructions would get to step one and stop. So this makes the thing that step
 * one actually needs — a single archive holding exactly what a server runs, and
 * nothing else.
 *
 * WHAT GOES IN
 *   src/            the app: main process, renderer, and src/cloud
 *   bin/ai          MediaPipe wasm + models (auto-reframe runs in the phone, but
 *                   the server has to hand them to it)
 *   bin/fonts       the caption typefaces ffmpeg burns
 *   package.json    + the lockfile, so `npm ci` in the image is reproducible
 *   Dockerfile      and the two compose files, and the setup script
 *   CLOUD.md        the instructions, travelling with the thing they describe
 *
 * WHAT STAYS BEHIND, and why it matters that it does
 *   node_modules    350 MB, and rebuilt inside the image from the lockfile
 *   release/        a Windows installer has no business on a Linux box
 *   test/, ios/     not what a server runs
 *   bin/whisper     the Windows binary; the image compiles its own for ARM
 *   .env            the access code. It is a password, and it is never packed.
 *
 * The result is a few MB — small enough to send over hotel wifi, which is the
 * point: the machine at the other end is usually being set up from a phone
 * tether, not a fibre line.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const NAME = `cloud-studio-${pkg.version}`;
const OUT_DIR = path.join(ROOT, 'release');
const OUT = path.join(OUT_DIR, `${NAME}.tar.gz`);

/* Whole trees that travel as they are. */
const TREES = [
  ['src', 'src'],
  ['bin/ai', 'bin/ai'],
  ['bin/fonts', 'bin/fonts'],
  ['legal', 'legal'],
];

/* Single files. */
const FILES = [
  'package.json',
  'package-lock.json',
  'Dockerfile',
  '.dockerignore',
  'docker-compose.free.yml',
  'docker-compose.yml',
  'docker-compose.oracle.yml',
  'scripts/cloud-setup.sh',
  'scripts/cloud-update.sh',
  'CLOUD.md',
];

/*
 * Never, under any circumstances.
 *
 * `src/renderer/assets` is 36 MB of Flyer Maker stock photos and background
 * loops — more than half the archive, for a server that does not run the Flyer
 * Maker. Nothing the cloud page serves references it (checked: not styles.css,
 * not any of the eight scripts, not the generated page), so it stays home. That
 * is the difference between a 63 MB upload and a 27 MB one, on a connection
 * that is usually a phone tether.
 */
const NEVER = [/(^|[\\/])\.env$/i, /(^|[\\/])\.cloud-studio\.env$/i, /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/, /\.map$/,
  /^src[\\/]renderer[\\/]assets([\\/]|$)/];

const blocked = (p) => NEVER.some((re) => re.test(p));

/*
 * Node hands `fs.cpSync`'s filter EXTENDED-LENGTH paths: not
 * `C:\…\src\renderer\assets` but `\\?\C:\…\src\renderer\assets`. A plain
 * `path.relative(ROOT, that)` cannot resolve it against an ordinary root, so it
 * hands back the whole `\\?\…` string — which matches none of the rules above.
 *
 * Every exclusion here was therefore dead, silently: the archive carried 36 MB
 * of stock photos, and would have carried node_modules and a .env too if they
 * had been inside a copied tree. Strip the prefix first.
 */
const rel = (p) => path.relative(ROOT, String(p).replace(/^\\\\\?\\/, ''));

function copyInto(stage, from, to) {
  const src = path.join(ROOT, from);
  if (!fs.existsSync(src)) return 0;
  const dest = path.join(stage, to);
  let n = 0;
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      if (blocked(rel(s))) return false;
      if (fs.statSync(s).isFile()) n++;
      return true;
    },
  });
  return n;
}

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function main() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cloud-bundle-'));
  const root = path.join(stage, NAME);
  fs.mkdirSync(root, { recursive: true });

  let files = 0;
  for (const [from, to] of TREES) files += copyInto(root, from, to);
  for (const f of FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) { console.warn('  (missing, skipped) ' + f); continue; }
    const dest = path.join(root, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    files++;
  }

  // A note for whoever opens the archive on the server, which is usually the
  // same person hours later with none of this in their head.
  fs.writeFileSync(path.join(root, 'START-HERE.txt'), [
    `Church Work Space - Cloud Studio ${pkg.version}`,
    '',
    'The Video Studio as a server. On a fresh Ubuntu or Debian machine:',
    '',
    '    bash scripts/cloud-setup.sh',
    '',
    'That installs Docker, builds the studio, starts it behind a Cloudflare',
    'tunnel, and prints an https:// address and an access code. Open the address',
    'on a phone, type the code, and add it to the home screen.',
    '',
    'No domain, no certificate and no open ports are needed.',
    'The first build compiles whisper.cpp for captions - 10 to 20 minutes, once.',
    '',
    'Everything else is in CLOUD.md.',
  ].join('\n'), 'utf-8');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  try { fs.rmSync(OUT, { force: true }); } catch (e) {}
  /*
   * `tar` ships with Windows 10+, macOS and every Linux - no dependency needed.
   *
   * It is run FROM the staging folder with relative names only. Handing GNU tar
   * a Windows path is how this first failed: it reads `C:\…` as a remote host
   * and tries to connect to a machine called C.
   */
  const tmpArchive = NAME + '.tar.gz';
  execFileSync('tar', ['-czf', tmpArchive, NAME], { cwd: stage, stdio: 'inherit' });
  fs.copyFileSync(path.join(stage, tmpArchive), OUT);

  const unpacked = dirSize(root);
  const packed = fs.statSync(OUT).size;
  fs.rmSync(stage, { recursive: true, force: true });

  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
  console.log('');
  console.log('  ' + OUT);
  console.log(`  ${files} files - ${mb(unpacked)} unpacked - ${mb(packed)} packed`);
  console.log('');
  console.log('  Put it on the server and run it:');
  console.log(`    scp "${path.basename(OUT)}" ubuntu@YOUR-SERVER:~/`);
  console.log(`    ssh ubuntu@YOUR-SERVER "tar -xzf ${path.basename(OUT)} && cd ${NAME} && bash scripts/cloud-setup.sh"`);
  console.log('');
}

if (require.main === module) main();
module.exports = { main, NAME, OUT };
