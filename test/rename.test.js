'use strict';
/*
 * "CHANGE THE NAME OF THE SOFTWARE TO CHURCH WORK SPACE — LET IT REFLECT
 *  EVERYWHERE PERFECTLY."
 *
 * Renaming an Electron app is not a find-and-replace, because the product name
 * is also where a church's entire library lives: Electron derives userData from
 * it, so %APPDATA%\Church Media Workstation becomes %APPDATA%\Church Work Space
 * and the app opens on an empty shelf. No songs, no service running orders, no
 * Bible downloads, no linked Facebook or YouTube account, no settings. Nothing
 * is deleted — it is all still in the old folder — but on a Sunday morning
 * "somewhere else" and "gone" are the same sentence.
 *
 * So this checks two different things:
 *
 *   [1] the name really did change everywhere a person can see it, and did NOT
 *       change in the two places it must not (the identifiers that make an
 *       upgrade an upgrade instead of a second app appearing);
 *   [2] the library survives, in every shape the folder can be in when the
 *       renamed app first opens — including the ones designed to lose data if
 *       written carelessly.
 *
 * [1] also guards the trap this very rename fell into: the find-and-replace
 * rewrote the OLD name inside the migration itself, so the code that was meant
 * to rescue the library was left looking for a folder that never existed. A
 * comment would not have caught that. This does.
 *
 *   npm run test:rename
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { migrateUserData, MARKER } = require(path.join(ROOT, 'src/main/migrate-name'));
const pkg = require(path.join(ROOT, 'package.json'));

const NEW_NAME = 'Church Work Space';
const OLD_NAME = 'Church Media Workstation';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  ok ? pass++ : fail++;
};
const head = (s) => console.log('\n' + s);
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } };

console.log('== THE RENAME: ' + OLD_NAME + '  ->  ' + NEW_NAME + ' ==');

/* ======================= [1] the name people see ======================== */
head('[1] Everywhere a person can see the name');
check('the product name is the new one', pkg.productName === NEW_NAME, pkg.productName);
check('and so is the one the installer builds with', pkg.build.productName === NEW_NAME, pkg.build.productName);
check('the Start Menu / desktop shortcut says it', pkg.build.nsis.shortcutName === NEW_NAME, pkg.build.nsis.shortcutName);
check('the package name matches', pkg.name === 'church-work-space', pkg.name);
check('the installer will be named after it', !/workstation/i.test(pkg.name + pkg.productName),
  `"${pkg.productName} Setup ${pkg.version}.exe"`);

const mainJs = read('src/main/main.js');
check('the window title bar says it', mainJs.includes("title: '" + NEW_NAME + "'"));
const indexHtml = read('src/renderer/index.html');
check('the browser/page title says it', indexHtml.includes('<title>' + NEW_NAME + '</title>'));
check('the sidebar falls back to it before a church sets its own name',
  read('src/renderer/renderer.js').includes("|| '" + NEW_NAME + "'"));

/* Nothing user-visible may still carry the old words. Identifiers are exempt
 * and checked separately below — they are deliberately unchanged. */
const VISIBLE = ['src/main/main.js', 'src/main/webserver.js', 'src/main/mobile-api.js', 'src/main/ndi-proc.js',
  'src/main/accounts.js', 'src/renderer/index.html', 'src/renderer/renderer.js', 'src/renderer/live.js',
  'src/renderer/present.js', 'src/renderer/phone.html', 'src/renderer/mobile.html',
  'legal/index.html', 'legal/privacy-policy.html', 'legal/terms-of-service.html', 'README.md', 'INSTALL.md'];
const stragglers = [];
for (const f of VISIBLE) {
  for (const line of read(f).split('\n')) {
    if (!/Media Workstation|MediaWorkstation/i.test(line)) continue;
    if (/OLD_APP_NAMES|HISTORICAL|find-and-replace|previous name/i.test(line)) continue; // the migration's own record
    stragglers.push(f + ': ' + line.trim().slice(0, 70));
  }
}
check('no screen, page or document still says the old name', stragglers.length === 0,
  stragglers.length ? stragglers[0] + (stragglers.length > 1 ? ` (+${stragglers.length - 1} more)` : '') : 'all clear');

/* The identifiers must NOT change. Same appId is what makes the new installer
 * replace the old app instead of a second copy turning up in the Start Menu
 * beside it, and the iOS keychain service must keep matching its bundle id or
 * saved logins are orphaned. Being asked to change the name "everywhere" does
 * not mean breaking upgrades. */
check('the app id is deliberately unchanged, so this upgrades in place',
  pkg.build.appId === 'org.church.mediaworkstation', pkg.build.appId);

/* THE TRAP THIS RENAME ACTUALLY FELL INTO. */
head('[1b] The migration still knows what the OLD name was');
const namesLine = (mainJs.match(/const OLD_APP_NAMES = .*/) || [''])[0];
console.log('    ' + namesLine.trim());
let declared = [];
try { declared = eval(namesLine.replace('const OLD_APP_NAMES = ', '').replace(/;$/, '')); } catch (e) { declared = []; }
check('it names a real previous name', declared.includes(OLD_NAME), JSON.stringify(declared));
check('and that name is NOT just the current one', !declared.includes(NEW_NAME),
  'a find-and-replace here silently loses every church its whole library');

/* ==================== [2] nobody loses their library ==================== */
head('[2] The library survives the rename');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-rename-'));
const mk = (dir, files) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    if (typeof body === 'object') { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'x.bin'), 'x'); }
    else fs.writeFileSync(p, body);
  }
};
const LIBRARY = {
  [MARKER]: JSON.stringify({ presentations: [{ name: 'Way Maker' }], playlists: [{ name: 'This Sunday' }],
    settings: { accounts: { fbToken: 'the-church-facebook-login' } } }),
  'song-bank.json': JSON.stringify({ songs: [{ title: 'Goodness Of God', words: 'our arrangement' }] }),
  bibles: {}, library: {}, models: {},
};
const libraryIsIntact = (dir) => {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    const b = JSON.parse(fs.readFileSync(path.join(dir, 'song-bank.json'), 'utf8'));
    return w.presentations[0].name === 'Way Maker'
      && w.settings.accounts.fbToken === 'the-church-facebook-login'
      && b.songs[0].words === 'our arrangement'
      && fs.existsSync(path.join(dir, 'bibles')) && fs.existsSync(path.join(dir, 'models'));
  } catch (e) { return false; }
};

// (a) the ordinary case: a year of use under the old name, nothing under the new
let base = fs.mkdtempSync(path.join(WORK, 'a-'));
mk(path.join(base, OLD_NAME), LIBRARY);
let r = migrateUserData(path.join(base, NEW_NAME), [OLD_NAME]);
check('a church that has been using it for a year keeps everything',
  r.moved && libraryIsIntact(path.join(base, NEW_NAME)), r.how);
check('the songs, the running order, the Bibles AND the Facebook login all came across',
  libraryIsIntact(path.join(base, NEW_NAME)));
check('and the old folder is not left lying around duplicating 800 MB',
  !fs.existsSync(path.join(base, OLD_NAME)));

// (b) it must not run twice
r = migrateUserData(path.join(base, NEW_NAME), [OLD_NAME]);
check('opening the app again does nothing further', !r.moved && libraryIsIntact(path.join(base, NEW_NAME)), r.how);

// (c) Electron often creates the folder before we get there
base = fs.mkdtempSync(path.join(WORK, 'c-'));
mk(path.join(base, OLD_NAME), LIBRARY);
fs.mkdirSync(path.join(base, NEW_NAME), { recursive: true });
r = migrateUserData(path.join(base, NEW_NAME), [OLD_NAME]);
check('an empty folder already sitting at the new name is not in the way',
  r.moved && libraryIsIntact(path.join(base, NEW_NAME)), r.how);

// (d) the dangerous one: they opened the renamed app first, so a NEW profile
// exists with a few Chromium caches in it — the old library must merge in,
// and nothing already there may be overwritten.
base = fs.mkdtempSync(path.join(WORK, 'd-'));
mk(path.join(base, OLD_NAME), LIBRARY);
mk(path.join(base, NEW_NAME), { 'Local State': 'chromium', Preferences: 'chromium' });
r = migrateUserData(path.join(base, NEW_NAME), [OLD_NAME]);
check('a half-started new profile does not block the library',
  r.moved && r.how === 'merged' && libraryIsIntact(path.join(base, NEW_NAME)), r.how);
check('and what was already there is left alone',
  fs.readFileSync(path.join(base, NEW_NAME, 'Local State'), 'utf8') === 'chromium');

// (e) the most dangerous: they have ALREADY been using the renamed app and
// built a new library in it. An old folder must never overwrite that.
base = fs.mkdtempSync(path.join(WORK, 'e-'));
mk(path.join(base, OLD_NAME), LIBRARY);
mk(path.join(base, NEW_NAME), { [MARKER]: JSON.stringify({ presentations: [{ name: 'LAST SUNDAY' }] }) });
r = migrateUserData(path.join(base, NEW_NAME), [OLD_NAME]);
const kept = JSON.parse(fs.readFileSync(path.join(base, NEW_NAME, MARKER), 'utf8'));
check('a library already in use is NEVER overwritten by an older one',
  !r.moved && kept.presentations[0].name === 'LAST SUNDAY', kept.presentations[0].name);

// (f) nothing to bring across — a brand new church on a brand new machine
base = fs.mkdtempSync(path.join(WORK, 'f-'));
r = migrateUserData(path.join(base, NEW_NAME), [OLD_NAME]);
check('a first-ever install has nothing to do and does not fall over', !r.moved, r.how);

fs.rmSync(WORK, { recursive: true, force: true });

console.log(`\n  ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
