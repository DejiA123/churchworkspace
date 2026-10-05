#!/usr/bin/env node
'use strict';
/*
 * Fetch the voice cleaner (DeepFilterNet) for a desktop build.
 *
 * Studio sound and Remove background noise run on it (src/main/deepfilter.js).
 * It is a single program per platform, 27-39 MB, so it is not kept in git —
 * the same arrangement as the Whisper models. This puts each one where
 * electron-builder's extraResources picks it up (bin/deepfilter/<os>-<arch>/,
 * matching its ${os}-${arch}), and refuses anything whose SHA-256 is not the
 * one pinned in deepfilter.js. `npm run dist` / `dist:mac` run it first.
 *
 *   node scripts/fetch-deepfilter.js                   this machine
 *   node scripts/fetch-deepfilter.js --platform darwin both Mac processors
 *   node scripts/fetch-deepfilter.js --all             every platform
 *   … --soft   (the npm build hooks) a failure is a warning, not a stopped build
 *
 * Without it a build still works: the app falls back to its ffmpeg chain.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const df = require('../src/main/deepfilter');

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const ALL = Object.keys(df.ASSETS);
// Before a build, a missing cleaner is not worth stopping for: the app falls
// back to its ffmpeg chain. Said loudly, then the build carries on.
const SOFT = argv.includes('--soft');
const finish = (bad) => {
  if (bad && SOFT) console.warn('  ⚠ the voice cleaner was not fetched — this build will use the older ffmpeg clean-up');
  process.exit(bad && !SOFT ? 1 : 0);
};
const platform = opt('--platform'), arch = opt('--arch');
let wanted;
if (argv.includes('--all')) wanted = ALL;
else if (platform || arch) {
  const os = df.platformKey(platform || process.platform, 'any').split('-')[0];
  wanted = ALL.filter((k) => k.split('-')[0] === os && (!arch || k.split('-')[1] === arch));
} else wanted = [df.platformKey()].filter((k) => df.ASSETS[k]);
if (!wanted.length) { console.error('No voice cleaner is published for that platform.'); finish(true); }

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const root = path.join(__dirname, '..', 'bin', 'deepfilter');
let failed = 0;
for (const key of wanted) {
  const { file, sha256: want } = df.ASSETS[key];
  const dir = path.join(root, key);
  const dest = path.join(dir, df.exeName(key.startsWith('win') ? 'win32' : 'x'));
  if (fs.existsSync(dest) && sha256(dest) === want) { console.log(`  ${key}: already here`); continue; }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = dest + '.part';
  console.log(`  ${key}: downloading ${file}…`);
  const r = spawnSync('curl', ['-fsSL', '--retry', '4', '--retry-delay', '2', '-o', tmp, df.RELEASE_URL + file], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(tmp)) { console.error(`  ${key}: download failed`); failed++; continue; }
  const got = sha256(tmp);
  if (got !== want) { fs.rmSync(tmp, { force: true }); console.error(`  ${key}: checksum mismatch (${got}) — not kept`); failed++; continue; }
  fs.renameSync(tmp, dest);
  try { fs.chmodSync(dest, 0o755); } catch (e) {}
  console.log(`  ${key}: ok`);
}
finish(failed > 0);
