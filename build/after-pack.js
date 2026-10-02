'use strict';
/*
 * electron-builder afterPack hook.
 *
 * The mac target lists bin/whisper in extraResources (with the Windows .exe/.dll
 * filtered out) so that the moment a macOS whisper.cpp binary is dropped into
 * bin/whisper/Release/, `npm run dist:mac` ships auto-captions — no config edit.
 *
 * The cost of that convenience: without such a binary the build would still carry
 * ~215 MB of speech models that nothing can run. So after packing a mac app we
 * check whether a mac binary actually made it in, and if not we drop the whole
 * whisper folder back out. Windows builds are never touched.
 */
const fs = require('fs');
const path = require('path');

/** Names a macOS/Linux whisper CLI can have (mirrors captioner.cliCandidates). */
const MAC_CLI_NAMES = ['whisper-cli', 'whisper-cli-arm64', 'whisper-cli-x64'];

/** Is there a runnable (non-Windows) whisper binary anywhere under `dir`? */
function hasMacWhisperCli(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const walk = (d, depth) => {
    if (depth > 3) return false;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return false; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (walk(full, depth + 1)) return true; }
      else if (MAC_CLI_NAMES.includes(e.name)) return true;
    }
    return false;
  };
  return walk(dir, 0);
}

/** Resources dir inside a packed app, per platform. */
function resourcesDir(appOutDir, platform, productName) {
  return platform === 'darwin'
    ? path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
}

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (platform !== 'darwin') return; // Windows/Linux builds are left exactly as they were

  const productName = context.packager.appInfo.productFilename;
  const whisperDir = path.join(resourcesDir(context.appOutDir, platform, productName), 'whisper');
  if (!fs.existsSync(whisperDir)) return;

  if (hasMacWhisperCli(whisperDir)) {
    // make sure the drop-in binary is still executable after being copied
    const chmodAll = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) chmodAll(full);
        else if (MAC_CLI_NAMES.includes(e.name)) { try { fs.chmodSync(full, 0o755); } catch (er) {} }
      }
    };
    chmodAll(whisperDir);
    console.log('  • whisper: macOS speech engine bundled — auto-captions will work in this build');
    return;
  }

  fs.rmSync(whisperDir, { recursive: true, force: true });
  console.log('  • whisper: no macOS binary in bin/whisper — leaving the speech models out '
    + '(saves ~215 MB). Auto-captions stay disabled; see BUILD-MAC.md §5.');
};

// exported for tests
module.exports.hasMacWhisperCli = hasMacWhisperCli;
module.exports.resourcesDir = resourcesDir;
module.exports.MAC_CLI_NAMES = MAC_CLI_NAMES;
