'use strict';
/**
 * "I HAVE VIDEOS SCHEDULED TO POST, THEY SHOULD STILL POST EVEN WHEN THE
 *  SOFTWARE IS CLOSED."
 *
 * That is the whole of what this file checks, and it checks it the only way
 * worth checking it: by running the code path the operating system runs when
 * no studio exists — autopost.publishDue() against a real Store, a real
 * Scheduler and a real (mock) Facebook Graph — and looking at what arrived on
 * the wire.
 *
 * Making the post go out is the easy half. The half that can quietly ruin a
 * church's Facebook Page is posting it TWICE, because from now on two separate
 * processes can both reach the same schedule. So most of this file is about
 * that: a live studio makes the poster stand down, a dead one does not, two
 * publishers racing over one file produce exactly one post, and a lock left
 * behind by a killed process never wedges the schedule for good.
 *
 * The Windows task definition is checked too — not that Windows accepts it
 * (only Windows can say), but that it still asks for the three settings
 * without which the feature is a lie on a laptop: run the missed one when the
 * PC comes back, wake a sleeping PC, and do not stop on battery.
 *
 *   npm run test:autopost
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const autopost = require('../src/main/autopost');
const { Scheduler } = require('../src/main/scheduler');
const { Store } = require('../src/main/store');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const head = (s) => console.log('\n' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- mock Facebook Graph -------------------------- */

const received = [];
function startMockGraph() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const fields = req.method === 'GET'
          ? Object.fromEntries(u.searchParams.entries())
          : Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()).entries());
        received.push({ url: u.pathname, method: req.method, fields });
        // A little latency, so "two publishers at once" is a real race and not
        // two calls that happen to be far apart.
        setTimeout(() => res.end(JSON.stringify({ id: 'feed_' + received.length })), 120);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/v19.0` }));
  });
}

/* ------------------------------ fixtures -------------------------------- */

/** A church's library on disk: one linked Page, one post that came due an hour ago. */
function makeLibrary(dir, base, posts) {
  const file = path.join(dir, 'workstation.json');
  fs.writeFileSync(file, JSON.stringify({
    settings: { accounts: { fbApiBase: base } },
    socialAccounts: [{ id: 'fb_1', platform: 'facebook', name: 'Grace Chapel', pageId: 'mypage', token: 'goodtoken' }],
    posts,
  }, null, 2));
  return file;
}

function duePost(id, title, minutesAgo = 60) {
  return {
    id, title, caption: title + ' — see you there!', platforms: ['facebook'], accountIds: ['fb_1'],
    mediaPaths: [], scheduledAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    status: 'scheduled', notified: false, attempts: 0, error: null, results: {},
  };
}

function schedulerOn(file, owner) {
  const store = new Store(file, {});
  return { store, sched: new Scheduler(store, () => null, { owner }) };
}

/** A real, live, foreign process to stand in for "the studio" / "the other copy". */
function spawnBystander() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  child.unref();
  return child;
}

/* --------------------------------- run ---------------------------------- */

(async () => {
  console.log('== POSTING WITH THE APP CLOSED ==');
  const { server, base } = await startMockGraph();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-autopost-'));

  /* ============ 1. it posts with no studio anywhere in sight ============ */
  head('[1] A post comes due while the app is shut');
  {
    const dir = path.join(root, 'closed'); fs.mkdirSync(dir);
    const file = makeLibrary(dir, base, [duePost('p1', 'Sunday service')]);
    const { store, sched } = schedulerOn(file);

    const result = await autopost.publishDue(dir, sched);

    const post = received.find((r) => r.url === '/v19.0/mypage/feed');
    check('the post reached Facebook with nothing open', !!post, JSON.stringify(received.slice(-1)));
    check('with the caption that was scheduled', post && post.fields.message === 'Sunday service — see you there!');
    check('publishDue reports the one it published', result.published === 1 && result.failed === 0, JSON.stringify(result));
    check('and names it, so the run log can say what went out', (result.titles || [])[0] === 'Sunday service');

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('the schedule ON DISK says posted', saved.posts[0].status === 'posted', saved.posts[0].status);
    check('with the Facebook post id kept', !!saved.posts[0].fbPostId);

    const runs = autopost.readState(dir).runs;
    check('the run is written down where the studio can show it', runs.length === 1 && runs[0].published === 1);

    // Second run, same schedule: nothing left to do, nothing sent again.
    const n = received.length;
    const again = await autopost.publishDue(dir, sched);
    check('running again does NOT post it a second time', received.length === n && again.published === 0);
    store.flushSync();
  }

  /* ================ 2. it stands down for a live studio ================= */
  head('[2] The studio is open — the background poster must not touch it');
  {
    const dir = path.join(root, 'studio-up'); fs.mkdirSync(dir);
    const file = makeLibrary(dir, base, [duePost('p2', 'Youth night')]);
    const { sched } = schedulerOn(file);
    const bystander = spawnBystander();

    // The heartbeat a running studio leaves behind.
    fs.writeFileSync(path.join(dir, 'studio-open.json'), JSON.stringify({ pid: bystander.pid, at: Date.now() }));
    check('a fresh heartbeat from a live process reads as "studio open"', autopost.studioIsOpen(dir) === true);

    const n = received.length;
    const res = await autopost.publishDue(dir, sched);
    check('the poster stands down instead of publishing', res.skipped === 'studio-open' && received.length === n);
    check('and says why in the run log', autopost.readState(dir).runs.slice(-1)[0].skipped === 'studio-open');

    // The studio crashed: the beat stops, and posting has to carry on.
    fs.writeFileSync(path.join(dir, 'studio-open.json'),
      JSON.stringify({ pid: bystander.pid, at: Date.now() - (autopost.HEARTBEAT_STALE_MS + 60000) }));
    check('a heartbeat that stopped hours ago does NOT block posting', autopost.studioIsOpen(dir) === false);

    const res2 = await autopost.publishDue(dir, sched);
    check('so the post the crashed studio never sent goes out', res2.published === 1, JSON.stringify(res2));

    // A heartbeat whose process is gone is worth nothing either.
    bystander.kill();
    await sleep(300);
    fs.writeFileSync(path.join(dir, 'studio-open.json'), JSON.stringify({ pid: bystander.pid, at: Date.now() }));
    check('a fresh beat from a DEAD process is not a studio', autopost.studioIsOpen(dir) === false);
  }

  /* =========== 3. two publishers, one schedule, ONE post ============== */
  head('[3] Studio and background poster racing — the post must go out ONCE');
  {
    const dir = path.join(root, 'race'); fs.mkdirSync(dir);
    const file = makeLibrary(dir, base, [duePost('p3', 'Carol service')]);
    // Two Schedulers over the SAME file with their own stores and their own
    // lock identities: the shape of a studio that was opened while a
    // background run was already in flight.
    const a = schedulerOn(file, 'studio-a');
    const b = schedulerOn(file, 'agent-b');

    const n = received.length;
    await Promise.all([a.sched.tickNow(), b.sched.tickNow()]);
    const sent = received.length - n;
    check('exactly one post was sent, not two', sent === 1, sent + ' requests');

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('and the schedule records it as posted once', saved.posts[0].status === 'posted', saved.posts[0].status);

    // Whichever lost the race must have adopted the winner's result, not kept
    // its own stale copy — otherwise the next tick posts it again.
    await a.sched.tickNow();
    await b.sched.tickNow();
    check('neither of them posts it again afterwards', received.length - n === 1, (received.length - n) + ' requests');
  }

  /*
   * The round above is won before the lock is even consulted: the first
   * publisher writes "posting" to disk before its first await, so the second
   * one re-reads the file and finds nothing due. That is the ordinary case and
   * worth proving — but it means the round above says nothing about the lock,
   * and the lock is the only thing standing between a church and a duplicate
   * post when the two really do arrive together. So ask for that collision
   * directly: two publishers told to publish the SAME post at the same moment,
   * neither having seen the other's write.
   */
  head('[3b] The same post, published by both at the same instant');
  {
    const dir = path.join(root, 'collide'); fs.mkdirSync(dir);
    const file = makeLibrary(dir, base, [duePost('p4', 'Christmas Eve')]);
    const a = schedulerOn(file, 'studio-a');
    const b = schedulerOn(file, 'agent-b');

    const n = received.length;
    const settle = (p) => p.then((v) => v, (e) => ({ error: e.message }));
    const [ra, rb] = await Promise.all([
      settle(a.sched.autoPublish('p4')),
      settle(b.sched.autoPublish('p4')),
    ]);
    check('Facebook still only heard about it once', received.length - n === 1, (received.length - n) + ' requests');
    const outcomes = [ra, rb];
    check('one of them published it', outcomes.filter((r) => r && r.posted).length === 1, JSON.stringify(outcomes));
    check('and the other was told to leave it alone', outcomes.filter((r) => r && r.pending).length === 1, JSON.stringify(outcomes));
  }

  /* ============== 4. a lock must never outlive its owner ============== */
  head('[4] A killed upload must not wedge the schedule forever');
  {
    const dir = path.join(root, 'lock'); fs.mkdirSync(dir);
    const bystander = spawnBystander();

    fs.writeFileSync(path.join(dir, 'publish.lock'),
      JSON.stringify({ pid: bystander.pid, owner: 'someone-else', at: Date.now() }));
    check('a lock held by a live process is respected', autopost.acquireLock(dir, 'test') === null);
    check('and lockHeldBy names the holder', !!autopost.lockHeldBy(dir));

    bystander.kill();
    await sleep(300);
    const release = autopost.acquireLock(dir, 'test');
    check('once that process is gone the lock is taken over', typeof release === 'function');
    check('releasing it removes the file', (release(), !fs.existsSync(path.join(dir, 'publish.lock'))));

    // A lock file from a process that died AND whose pid got reused by
    // something else is caught by age instead.
    fs.writeFileSync(path.join(dir, 'publish.lock'),
      JSON.stringify({ pid: process.pid, owner: 'ancient', at: Date.now() - (autopost.LOCK_STALE_MS + 60000) }));
    check('an implausibly old lock is broken on age alone', typeof autopost.acquireLock(dir, 'test') === 'function');
  }

  /* ====== 5. one process must see what the other wrote to the file ===== */
  head('[5] Two processes, one file');
  {
    const dir = path.join(root, 'sync'); fs.mkdirSync(dir);
    const file = makeLibrary(dir, base, [duePost('p5', 'Prayer meeting')]);
    const s1 = new Store(file, {});
    const s2 = new Store(file, {});

    const posts = s2.get('posts');
    posts[0].status = 'posted';
    s2.set('posts', posts);
    s2.flushSync();

    check('the other store still holds the old copy in memory', s1.get('posts')[0].status === 'scheduled');
    check('reloadKey adopts what is actually on disk', s1.reloadKey('posts')[0].status === 'posted');

    // Our own unwritten change must never be thrown away by a reload.
    const mine = s1.get('posts');
    mine[0].title = 'Renamed here';
    s1.set('posts', mine);
    check('a pending write of our own wins over the disk', s1.reloadKey('posts')[0].title === 'Renamed here');
  }

  /* ============ 6. what we actually ask the OS to run for us =========== */
  head('[6] The task handed to Windows');
  {
    const xml = autopost.taskXml({
      exe: 'C:\\Program Files\\Church Work Space\\Church Work Space.exe',
      args: [autopost.AGENT_FLAG], everyMinutes: 5, description: 'test',
    });
    check('it runs the app itself', xml.includes('Church Work Space.exe'));
    check('in background-poster mode', xml.includes('--publish-due'));
    check('every 5 minutes, all day', xml.includes('<Interval>PT5M</Interval>') && xml.includes('<Duration>P1D</Duration>'));
    check('and again at every sign-in', xml.includes('<LogonTrigger>'));
    // The three settings that decide whether this works on a real machine.
    check('a run missed while the PC was off happens when it comes back', xml.includes('<StartWhenAvailable>true</StartWhenAvailable>'));
    check('a sleeping PC is woken for the post', xml.includes('<WakeToRun>true</WakeToRun>'));
    check('a laptop on battery still posts', xml.includes('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'));
    check('two runs never overlap', xml.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'));
    check('it does not ask for administrator rights', xml.includes('<RunLevel>LeastPrivilege</RunLevel>'));

    const plist = autopost.macPlist({ exe: '/Applications/Church Work Space.app/Contents/MacOS/x', args: ['--publish-due'], everyMinutes: 15 });
    check('macOS gets the same job as a launchd agent', plist.includes('--publish-due') && plist.includes('<integer>900</integer>'));

    check('the app recognises the flag it will be started with',
      autopost.isAgentArgv(['electron.exe', '.', '--publish-due']) === true);
    check('and does not mistake an ordinary launch for one',
      autopost.isAgentArgv(['Church Work Space.exe']) === false);

    // Packaged, the OS runs the exe; from a checkout it needs electron + the folder.
    const packaged = autopost.launchCommand({ execPath: 'C:\\x\\Church Work Space.exe', packaged: true });
    check('packaged: just the exe and the flag', packaged.args.length === 1 && packaged.args[0] === '--publish-due');
    const dev = autopost.launchCommand({ execPath: 'C:\\x\\node_modules\\electron\\dist\\electron.exe', appDir: 'C:\\proj' });
    check('from a checkout: electron, the project folder, then the flag',
      dev.args[0] === 'C:\\proj' && dev.args[1] === '--publish-due', JSON.stringify(dev));
  }

  /* ============ 7. a run that has nothing to publish is silent ========= */
  head('[7] Nothing due');
  {
    const dir = path.join(root, 'quiet'); fs.mkdirSync(dir);
    const file = makeLibrary(dir, base, [{ ...duePost('p7', 'Next week'), scheduledAt: new Date(Date.now() + 864e5).toISOString() }]);
    const { sched } = schedulerOn(file);
    const n = received.length; // this section only — earlier ones posted for real
    const res = await autopost.publishDue(dir, sched);
    check('a post scheduled for tomorrow is NOT published', res.published === 0, JSON.stringify(res));
    check('it is still sitting in the schedule', sched.list()[0].status === 'scheduled');
    check('and the run log says so plainly', autopost.readState(dir).runs.slice(-1)[0].published === 0);
    /*
     * The run is not silent, though, and should not be: a future post gets
     * BOOKED with Facebook here (publisher.scheduleTo), which is what lets it
     * go out with this PC switched off. Anything sent must be that booking and
     * never a publish — a `published=false` with a time on it.
     */
    const mine = received.slice(n);
    const booking = mine.filter((r) => r.fields && r.fields.published === 'false');
    const publishes = mine.filter((r) => r.fields && r.fields.published !== 'false' && r.url.includes('/mypage/'));
    check('the background run booked it with Facebook instead', booking.length === 1, JSON.stringify(mine));
    check('booked for the time the church chose, not now',
      booking.length === 1 && Number(booking[0].fields.scheduled_publish_time) > Math.floor(Date.now() / 1000) + 3600);
    check('and nothing was published outright', publishes.length === 0, JSON.stringify(publishes));
    check('so the post is now safe with the PC off', sched.handoffPlan(sched.list()[0]).safeWithPcOff === true);
  }

  server.close();
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
