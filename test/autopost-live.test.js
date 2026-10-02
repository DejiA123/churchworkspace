'use strict';
/**
 * THE ONE THAT ACTUALLY ANSWERS THE QUESTION.
 *
 * test/autopost.test.js proves the publishing LOGIC works with no studio, but
 * it proves it inside a plain Node process that imported the modules by hand.
 * The thing a church needs to be true is different and bigger: that the
 * application itself, started by Windows with no window, no renderer and
 * nobody logged into the studio, publishes the post.
 *
 * So this test does not import anything from the app. It:
 *   1. stands up a mock Facebook Graph on localhost,
 *   2. writes a userData folder containing one linked Page and one post that
 *      came due an hour ago,
 *   3. runs the REAL application as a separate process, exactly as the Task
 *      Scheduler will: `<electron> . --publish-due --user-data-dir=<that folder>`,
 *   4. waits for it to exit and then asks the mock server what arrived.
 *
 * If this passes, "the software has to be open to post" is no longer true.
 *
 *   npm run test:autopost-live
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

function electronBin() {
  try { return require(path.join(ROOT, 'node_modules', 'electron')); } catch (e) {}
  const local = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  return fs.existsSync(local) ? local : 'electron';
}

const received = [];
function startMockGraph() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        received.push({
          url: u.pathname,
          fields: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()).entries()),
        });
        res.end(JSON.stringify({ id: 'feed_' + received.length }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/v19.0` }));
  });
}

(async () => {
  console.log('== THE APP IS CLOSED. THE POST GOES OUT ANYWAY ==');
  const { server, base } = await startMockGraph();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-live-'));

  fs.writeFileSync(path.join(userData, 'workstation.json'), JSON.stringify({
    settings: { accounts: { fbApiBase: base } },
    socialAccounts: [{ id: 'fb_1', platform: 'facebook', name: 'Grace Chapel', pageId: 'mypage', token: 'goodtoken' }],
    posts: [{
      id: 'live1', title: 'Sunday 9am', caption: 'Doors open at 8:45.',
      platforms: ['facebook'], accountIds: ['fb_1'], mediaPaths: [],
      scheduledAt: new Date(Date.now() - 3600e3).toISOString(),
      status: 'scheduled', notified: false, attempts: 0, error: null, results: {},
    }],
  }, null, 2));

  const started = Date.now();
  const child = spawn(electronBin(), [ROOT, '--publish-due', '--user-data-dir=' + userData], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const code = await new Promise((resolve) => {
    const kill = setTimeout(() => { try { child.kill(); } catch (e) {} resolve('timeout'); }, 120000);
    child.on('exit', (c) => { clearTimeout(kill); resolve(c); });
    child.on('error', (e) => { clearTimeout(kill); out += e.message; resolve('error'); });
  });
  const took = ((Date.now() - started) / 1000).toFixed(1);

  console.log('  (the app ran for ' + took + 's and exited with ' + code + ')');
  if (out.trim()) console.log(out.trim().split('\n').map((l) => '   | ' + l).join('\n'));

  check('the app ran and exited by itself', code === 0, String(code));
  const posted = received.find((r) => r.url === '/v19.0/mypage/feed');
  check('IT POSTED — with no window, no studio, nobody there', !!posted, JSON.stringify(received));
  check('and it sent the caption that was scheduled', posted && posted.fields.message === 'Doors open at 8:45.');
  check('using the linked Page token', posted && posted.fields.access_token === 'goodtoken');

  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'workstation.json'), 'utf8'));
  check('the schedule was written back as posted', saved.posts[0].status === 'posted', saved.posts[0].status);
  check('so opening the studio later shows it as done', !!saved.posts[0].postedAt);

  const log = JSON.parse(fs.readFileSync(path.join(userData, 'autopost.json'), 'utf8'));
  const last = (log.runs || []).slice(-1)[0];
  check('and the run is in the log the Scheduler page shows', last && last.published === 1, JSON.stringify(last));

  // Run it a second time: there is nothing left to do, and nothing must be
  // sent again. This is the check that would catch a duplicate every 5 minutes.
  const before = received.length;
  await new Promise((resolve) => {
    const c2 = spawn(electronBin(), [ROOT, '--publish-due', '--user-data-dir=' + userData],
      { stdio: 'ignore', windowsHide: true });
    c2.on('exit', resolve); c2.on('error', resolve);
  });
  check('the next background run does NOT post it again', received.length === before,
    (received.length - before) + ' extra requests');

  server.close();
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
