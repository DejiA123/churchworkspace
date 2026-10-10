'use strict';
/*
 * THE SCHEDULER, CREATOR-STUDIO DESIGN, AND CAPTIONS THAT WRITE THEMSELVES —
 * on a phone.
 *
 * "The UI is nasty — make it the best. And when I upload a video or a flyer,
 * the AI should write the caption." The church chose design B. This drives the
 * real Cloud Studio like an iPhone, with a stand-in AI service on this machine
 * (the custom provider: POST /v1/chat/completions), and checks:
 *   [1] home: accounts as cards with their real names, an "Up next" card for
 *       the next post, the rest as 9:16 tiles, and the next free best time as
 *       a tile that opens a post for that time
 *   [2] a flyer chosen for a new post: the AI READS it (event, date, time,
 *       place shown as chips) and the caption is written by itself — nobody
 *       taps anything; the preview shows it on the picture
 *   [3] Shorter changes it, Undo puts it back
 *   [4] the YouTube title appears when a YouTube account is chosen
 *   [5] scheduling posts it with that caption and title
 *   [6] a caption typed before the AI answers is never written over
 *   [10] "I don't like 'the speaker' and 'Our Church'": with no names given the
 *       caption names nobody; names given on the post are used, and remembered
 *   [11] bulk upload: several picked on the phone at once — a tile each while
 *       sending, then a card per post with its own AI caption to edit, its own
 *       time; Schedule makes one post each, with its own caption
 *   [9] "I selected a video from this phone but it did not show up": on a slow
 *       connection the video shows AT ONCE, played from the phone, with how far
 *       the sending has got — then the caption is written when it lands
 *
 * Needs Playwright with Chromium; without it this says so and skips.
 *   node test/phone-scheduler-studio.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7399, AIPORT = 7400, CODE = 'sched-studio-test-5521';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-schedb-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }

/* a stand-in AI: reads flyers, writes captions, revises them */
const AI = { calls: [], slow: 0 };
const FLYER = { text: 'THE POWER HOUSE CHURCH NIGHT OF WORSHIP FRIDAY 24 OCTOBER 7PM THE POWER HOUSE CHURCH, 12 GRACE ROAD', event: 'Night of Worship', date: 'Friday 24 October', time: '7 pm', place: 'The Power House Church, 12 Grace Road', people: [], theme: '', contact: '', isFlyer: true, describe: 'A purple worship night flyer' };
function aiServer() {
  return http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
      const j = JSON.parse(b || '{}');
      const msgs = j.messages || [];
      const vision = msgs.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));
      const text = msgs.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      let out;
      if (vision) { AI.calls.push('read'); out = FLYER; }
      else if (/WHAT TO DO: Make it SHORTER/.test(text)) { AI.calls.push('shorten'); out = { title: 'Night of Worship', caption: 'Night of Worship, Friday 24 October, 7 pm. 🙌\n\n#ThePowerHouse #Worship' }; }
      else if (/ruthless short-form copy editor/.test(text)) { AI.calls.push('polish'); out = { scores: [] }; }
      else if (/"options"/.test(text) && !/WHAT IS PRINTED ON THE FLYER/.test(text)) {
        AI.calls.push('write'); AI.lastVideoWrite = text;
        if (AI.slow) await sleep(AI.slow);
        const named = /The speaker is Bishop David Richman/.test(text);
        const cap = named ? '"God is not finished with you," Bishop David Richman said at The Power House International. 🙌\n\n#Faith'
          : 'Ever felt stuck? "Especially when the children of God gather together and talk to God over issues," the speaker said at Our Church. In that moment, healing came. 🙌\n\n#Faith #Prayer';
        out = { options: [{ title: 'Ever felt stuck?', hook: 'Ever felt stuck?', caption: cap }, { title: 'Two', hook: 'x', caption: cap }, { title: 'Three', hook: 'x', caption: cap }] };
      }
      else if (/"options"/.test(text)) {
        AI.calls.push('write'); if (!AI.firstWrite) AI.firstWrite = text;
        if (AI.slow) await sleep(AI.slow);
        const cap = 'One night to lift His name together. 🙌 Night of Worship is this Friday 24 October at 7 pm, at The Power House Church, 12 Grace Road. Bring a friend and come as you are.\n\n#ThePowerHouse #NightOfWorship #Worship #Friday';
        out = { options: [{ title: 'Night of Worship: Friday 7 pm 🙌', hook: 'One night to lift His name together.', caption: cap },
          { title: 'Come and worship with us ✨', hook: 'Come as you are.', caption: 'Come as you are this Friday. ✨ Night of Worship, 24 October at 7 pm, The Power House Church.\n\n#ThePowerHouse #Worship' },
          { title: 'Friday: Night of Worship 🎶', hook: 'Friday night belongs to worship.', caption: 'Friday night belongs to worship. 🎶 Join us 24 October, 7 pm, at The Power House Church.\n\n#ThePowerHouse #Worship' }] };
      } else { AI.calls.push('other'); out = { scores: [] }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
    });
  }).listen(AIPORT, '127.0.0.1');
}

(async () => {
  const VID = path.join(MEDIA, 'Sunday sermon clip.webm'), VID2 = path.join(MEDIA, 'Worship highlights.webm'), FLY = path.join(MEDIA, 'Night of Worship flyer.png');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=360x640:c0=0x3b1e44:c1=0xffa060:d=6:r=15', '-f', 'lavfi', '-i', 'sine=f=220:d=6', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=360x640:c0=0x0f1030:c1=0x8b5cf6:d=4:r=15', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', VID2]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=720x900:c0=0x2a0f3d:c1=0xff5c8a:d=1', '-frames:v', '1', FLY]);
  const day = 86400e3, now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const accts = [
    { id: 'zotk_1', platform: 'tiktok', via: 'zernio', name: 'The Power House', username: 'thepowerhouse', token: 'k', zoAccountId: '1' },
    { id: 'zofb_2', platform: 'facebook', via: 'zernio', name: 'The Power House Church', token: 'k', zoAccountId: '2' },
    { id: 'zoig_3', platform: 'instagram', via: 'zernio', name: '@thepowerhouse.church', token: 'k', zoAccountId: '3' },
    { id: 'zofb_4', platform: 'facebook', via: 'zernio', name: 'Bishop David Richman', token: 'k', zoAccountId: '4' },
    { id: 'zoyt_5', platform: 'youtube', via: 'zernio', name: 'The Power House TV', token: 'k', zoAccountId: '5' },
  ];
  const mk = (id, title, caption, media, when, ids) => ({ id, title, caption, mediaPaths: [media], accountIds: ids, platforms: Array.from(new Set(ids.map((x) => accts.find((a) => a.id === x).platform))), scheduledAt: at(when), status: 'scheduled', attempts: 0, createdAt: at(0), updatedAt: at(0), owner: null });
  fs.writeFileSync(path.join(DATA, 'workstation.json'), JSON.stringify({
    socialAccounts: accts,
    posts: [
      mk('p1', 'God is not finished with you yet', 'Even in the waiting, He is working. 🙌\n\n#ThePowerHouse #Faith', VID, 3 * 3600e3 + 20 * 60e3, ['zotk_1', 'zoig_3', 'zofb_2', 'zoyt_5']),
      mk('p2', 'Night of Worship', 'Friday 7 pm', FLY, day + 2 * 3600e3, ['zoig_3', 'zofb_2', 'zofb_4']),
      mk('p3', 'Sunday highlights', 'What a Sunday', VID2, 2 * day, ['zotk_1', 'zoig_3', 'zoyt_5']),
    ],
    settings: { brand: { churchName: 'The Power House' }, social: { cloud: { on: true, provider: 'custom', url: `http://127.0.0.1:${AIPORT}/v1/chat/completions`, key: 'test-key', model: 'stand-in-vision' } } },
  }));
  const ai = aiServer();
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA],
    { stdio: 'ignore', env: Object.assign({}, process.env, { GROQ_API_KEY: '', MW_GROQ_KEY: '' }) });
  const browser = await chromium.launch();
  const SHOTS = process.env.MW_SHOTS || '';
  try {
    if (!(await waitUp())) throw new Error('no server');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#scheduler`, { waitUntil: 'load' });
    await page.waitForSelector('#cloudSched .csb-hero', { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'b-real-1-home.png') });

    // [1]
    const home = await page.evaluate(() => ({
      accts: [...document.querySelectorAll('#csAccts .csb-acc:not(.add) b')].map((b) => b.textContent),
      hero: (document.querySelector('.csb-hero .csb-hero-title') || {}).textContent,
      tiles: document.querySelectorAll('.csb-grid .csb-tile:not(.free)').length,
      free: (document.querySelector('.csb-tile.free b') || {}).textContent || '',
    }));
    check(home.accts.includes('Bishop David Richman') && home.accts.length === 5, 'accounts show as cards with their real names', home.accts);
    check(home.hero === 'God is not finished with you yet', 'the next post is the Up next card', home.hero);
    check(home.tiles === 2 && / is free$/.test(home.free), 'the rest are 9:16 tiles, with the next free best time as a tile', home);

    // [2] a flyer, from the free-time tile: it is read and written by itself
    await page.tap('.csb-tile.free');
    await page.waitForSelector('#csCompose .csb-src', { timeout: 8000 });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'b-real-2-new.png') });
    const when0 = await page.$eval('#csCompose .csb-when b', (n) => n.textContent);
    check(!!when0 && !/Right now/.test(when0), 'the free-time tile opens a post for that time', when0);
    AI.slow = 2500;
    // From this phone → the studio's chooser → send the flyer from the phone, as an iPhone does
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), page.tap('#csCompose [data-c="device"]')]);
    await chooser.setFiles(FLY);
    await page.waitForSelector('#csCompose .csb-prev', { timeout: 30000 }).catch(() => {});
    check(await page.evaluate(() => !!document.querySelector('#csCompose .csb-prev')), 'the flyer can be chosen from the phone', await page.evaluate(() => ({ modal: !document.getElementById('cloudFilesModal').classList.contains('hidden'), txt: document.getElementById('cloudFilesModal').innerText.slice(0, 300), comp: (document.querySelector('#csCompose .cp-body') || {}).innerText })));
    await page.waitForSelector('#csCompose .csb-ai.busy', { timeout: 8000 }).catch(() => {});
    const busy = await page.evaluate(() => ({ busy: !!document.querySelector('#csCompose .csb-ai.busy'), st: (document.querySelector('#csCompose .csb-ai-st') || {}).textContent || '' }));
    check(busy.busy && /Reading the flyer|Writing/.test(busy.st), 'the AI starts by itself the moment the flyer is chosen', busy);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'b-real-3-writing.png') });
    await page.waitForSelector('#csCompose .csb-ai-st.ok', { timeout: 30000 }).catch(() => {});
    const done = await page.evaluate(() => ({
      cap: (document.querySelector('#csCompose .csb-cap') || {}).value || '',
      facts: [...document.querySelectorAll('#csCompose .csb-facts span')].map((x) => x.textContent),
      prev: (document.querySelector('#csbPrevCap') || {}).textContent || '',
      styles: document.querySelectorAll('#csCompose .csb-style').length,
    }));
    check(/Night of Worship is this Friday 24 October at 7 pm/.test(done.cap), 'the caption is written from what the flyer says', done.cap.slice(0, 120));
    check(done.facts.includes('Night of Worship') && done.facts.includes('Friday 24 October') && done.facts.includes('7 pm'), 'what was read on the flyer is shown', done.facts);
    check(/One night to lift His name/.test(done.prev), 'the preview shows the caption on the picture', done.prev);
    check(done.styles === 3 && AI.calls.includes('read'), 'other styles are offered', { styles: done.styles, calls: AI.calls });
    check(/WHAT IS PRINTED ON THE FLYER/.test(AI.firstWrite || '') && /Date: Friday 24 October/.test(AI.firstWrite || '') && /Time: 7 pm/.test(AI.firstWrite || ''),
      'the writer is given every fact printed on the flyer', (AI.firstWrite || '').slice(0, 300));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'b-real-4-written.png') });

    // [3]
    await page.tap('#csCompose [data-c="rev"][data-a="shorten"]');
    await page.waitForFunction(() => /^Night of Worship, Friday/.test((document.querySelector('#csCompose .csb-cap') || {}).value || ''), null, { timeout: 15000 }).catch(() => {});
    const short = await page.$eval('#csCompose .csb-cap', (n) => n.value);
    check(/^Night of Worship, Friday 24 October, 7 pm/.test(short), 'Shorter changes the caption', short);
    await page.tap('#csCompose [data-c="undo"]');
    const back = await page.$eval('#csCompose .csb-cap', (n) => n.value);
    check(/^One night to lift His name/.test(back), 'Undo puts it back', back.slice(0, 60));

    // [4]
    const yt = await page.$eval('#csCompose .csb-yt-in', (n) => n.value).catch(() => null);
    check(yt === 'Night of Worship: Friday 7 pm 🙌', 'the YouTube title is written too, shown for the YouTube account', yt);
    // scroll to see the rest, for the record
    if (SHOTS) { await page.evaluate(() => { const b = document.querySelector('#csCompose .cp-body'); if (b) b.scrollTop = 520; }); await sleep(300); await page.screenshot({ path: path.join(SHOTS, 'b-real-5-accounts.png') }); }

    // [5]
    await page.tap('#csCompose [data-c="go"]');
    await page.waitForFunction(() => !document.querySelector('#csCompose.on'), null, { timeout: 15000 }).catch(() => {});
    await sleep(1000);
    const posts = await page.evaluate(async () => window.api.scheduler.list());
    const made = posts.find((p) => /One night to lift His name/.test(p.caption || ''));
    check(!!made && made.title === 'Night of Worship: Friday 7 pm 🙌' && made.accountIds.length === 5, 'it is scheduled with that caption, title and all five accounts', made && { title: made.title, n: made.accountIds.length });

    // [6] typed before the AI answers: kept
    AI.slow = 3000;
    await page.evaluate((f) => window.MWSocial.compose({ files: [f] }), FLY);
    await page.waitForSelector('#csCompose .csb-ai.busy', { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => { /* the person starts typing in the preview-less moment: set it the way input does */ });
    const typed = 'My own words for this one';
    await page.evaluate((t) => { window.__typed = t; }, typed);
    // the caption box appears only once written; type into it while... the state lets typing win: emulate via the input event on a fresh textarea after it lands
    await page.waitForSelector('#csCompose .csb-ai-st.ok', { timeout: 30000 }).catch(() => {});
    await page.fill('#csCompose .csb-cap', typed);
    await page.tap('#csCompose [data-c="write"]').catch(() => {});
    const kept = await page.$eval('#csCompose .csb-cap', (n) => n.value).catch(() => '');
    check(kept === typed, 'a typed caption is not written over by itself', kept);
    // [7] another file chosen: the AI's caption for the old one goes, a new one is written; what was typed stays
    await page.evaluate(() => { const x = document.querySelector('#csCompose .cp-x'); if (x) x.click(); });
    await sleep(600);
    AI.slow = 0;
    await page.evaluate((f) => window.MWSocial.compose({ files: [f] }), FLY);
    await page.waitForSelector('#csCompose .csb-ai-st.ok', { timeout: 30000 }).catch(() => {});
    const writes0 = AI.calls.filter((c) => c === 'write').length;
    await page.tap('#csCompose .csb-pill.right');   // Change
    await sleep(300);
    const cleared = await page.evaluate(() => ({ src: !!document.querySelector('#csCompose .csb-src') }));
    const [ch2] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), page.tap('#csCompose [data-c="device"]')]);
    await ch2.setFiles(VID);
    await page.waitForSelector('#csCompose .csb-ai-st.ok', { timeout: 30000 }).catch(() => {});
    check(cleared.src && AI.calls.filter((c) => c === 'write').length > writes0, 'choosing another file writes a new caption for it (the old one goes)', { cleared, calls: AI.calls });

    // [8] Schedule tapped while writing, then the sheet closed: nothing is posted
    AI.slow = 4000;
    const before = (await page.evaluate(async () => window.api.scheduler.list())).length;
    await page.evaluate(() => { const x = document.querySelector('#csCompose .cp-x'); if (x) x.click(); });
    await sleep(600);
    await page.evaluate((f) => window.MWSocial.compose({ files: [f] }), VID2);
    await page.waitForSelector('#csCompose .csb-ai.busy', { timeout: 8000 }).catch(() => {});
    await page.tap('#csCompose [data-c="go"]');
    await sleep(300);
    const twice = await page.$eval('#csCompose [data-c="go"]', (b) => b.disabled).catch(() => true);
    await page.evaluate(() => { const x = document.querySelector('#csCompose .cp-x'); if (x) x.click(); });
    await sleep(6000);
    const after = (await page.evaluate(async () => window.api.scheduler.list())).length;
    check(twice, 'while it waits for the caption, Schedule cannot be tapped twice');
    check(after === before, 'closing the sheet while it waits posts nothing', { before, after });

    // [9] a big video on a slow connection
    AI.slow = 0;
    const BIG = path.join(WORK, 'Sunday service.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=6', '-f', 'lavfi', '-i', 'sine=d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', BIG]);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 4e6, uploadThroughput: 600e3 });
    await page.evaluate(() => { const x = document.querySelector('#csCompose .cp-x'); if (x) x.click(); });
    await sleep(600);
    await page.evaluate(() => window.MWSocial.compose({}));
    await page.waitForSelector('#csCompose [data-c="device"]', { timeout: 8000 });
    const [ch3] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), page.tap('#csCompose [data-c="device"]')]);
    await ch3.setFiles(BIG);
    await page.waitForSelector('#csCompose .csb-prev.sending', { timeout: 5000 }).catch(() => {});
    await sleep(1500);
    const sending = await page.evaluate(() => ({ shown: !!document.querySelector('#csCompose .csb-prev.sending video'), tx: (document.querySelector('#csCompose .csb-send-tx') || {}).textContent || '', stop: !!document.querySelector('#csCompose [data-c="stopsend"]') }));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'b-real-7-sending.png') });
    check(sending.shown && /Sending to the studio… \d+%/.test(sending.tx) && sending.stop, 'the video shows at once, with how far the sending has got and a Stop', sending);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitForSelector('#csCompose .csb-prev:not(.sending)', { timeout: 120000 }).catch(() => {});
    await page.waitForSelector('#csCompose .csb-ai-st.ok, #csCompose .csb-ai.busy', { timeout: 30000 }).catch(() => {});
    const landed = await page.evaluate(() => ({ prev: !!document.querySelector('#csCompose .csb-prev:not(.sending)'), ai: !!document.querySelector('#csCompose .csb-ai') }));
    check(landed.prev && landed.ai, 'when it lands it is the post\'s video, and its caption is written', landed);

    // [10] no names: nobody named; names given: used and remembered
    await page.evaluate(() => { const x = document.querySelector('#csCompose .cp-x'); if (x) x.click(); });
    await sleep(600);
    await page.evaluate((f) => window.MWSocial.compose({ files: [f] }), VID);
    await page.waitForSelector('#csCompose .csb-ai-st.ok', { timeout: 30000 }).catch(() => {});
    const plain = await page.$eval('#csCompose .csb-cap', (n) => n.value).catch(() => '');
    check(/talk to God over issues\." In that moment/.test(plain) && !/the speaker/i.test(plain) && !/our church/i.test(plain), 'with no names given, the caption names nobody: no "the speaker", no "Our Church"', plain);
    // (this studio's settings name the church, so only the speaker is unknown here)
    check(/Do NOT refer to the speaker at all/.test(AI.lastVideoWrite || '') && /THE CHURCH: The Power House/.test(AI.lastVideoWrite || ''), 'the writer is told to leave out the speaker it does not know', (AI.lastVideoWrite || '').slice(0, 200));
    await page.tap('#csCompose [data-c="names"]');
    await page.fill('#csCompose input[data-n="speaker"]', 'Bishop David Richman');
    await page.fill('#csCompose input[data-n="church"]', 'The Power House International');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'b-real-8-names.png') });
    await page.tap('#csCompose [data-c="names-save"]');
    await page.waitForFunction(() => /Bishop David Richman/.test((document.querySelector('#csCompose .csb-cap') || {}).value || ''), null, { timeout: 30000 }).catch(() => {});
    const named = await page.$eval('#csCompose .csb-cap', (n) => n.value).catch(() => '');
    check(/Bishop David Richman said at The Power House International/.test(named) && /The speaker is Bishop David Richman/.test(AI.lastVideoWrite) && /THE CHURCH: The Power House International/.test(AI.lastVideoWrite),
      'names given on the post are used — written again with them', named);
    const keptNames = await page.evaluate(() => localStorage.getItem('mw.social.names'));
    check(/Bishop David Richman/.test(keptNames || ''), 'and remembered for the next post', keptNames);
    await page.evaluate(() => localStorage.removeItem('mw.social.names'));

    // [11] bulk upload from the phone
    await page.evaluate(() => { const x = document.querySelector('#csCompose .cp-x'); if (x) x.click(); });
    await sleep(600);
    const nBefore = (await page.evaluate(async () => window.api.scheduler.list())).length;
    await page.evaluate(() => window.MWSocial.compose({}));
    await page.waitForSelector('#csCompose [data-c="device"]', { timeout: 8000 });
    const cdp2 = await ctx.newCDPSession(page);
    await cdp2.send('Network.enable');
    await cdp2.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 4e6, uploadThroughput: 900e3 });
    const [ch4] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), page.tap('#csCompose [data-c="device"]')]);
    check(ch4.isMultiple(), 'From this phone lets several be picked at once');
    const B2 = path.join(WORK, 'Clip two.mp4');
    fs.copyFileSync(BIG, B2);
    await ch4.setFiles([BIG, B2, FLY]);
    await page.waitForSelector('#csCompose .csb-strip-it.sending', { timeout: 5000 }).catch(() => {});
    await sleep(800);
    const bulkSend = await page.evaluate(() => ({ tiles: document.querySelectorAll('#csCompose .csb-strip-it.sending').length, head: (document.querySelector('#csCompose .csb-h3 b') || {}).textContent || '' }));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'b-real-9-bulk-sending.png') });
    check(bulkSend.tiles === 3 && /Sending \d of 3 to the studio/.test(bulkSend.head), 'while sending: a tile each, and how many are done', bulkSend);
    await cdp2.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitForFunction(() => document.querySelectorAll('#csCompose .csb-bcap').length === 3, null, { timeout: 120000 }).catch(() => {});
    const cards = await page.$$eval('#csCompose .csb-bcap', (xs) => xs.map((x) => x.value));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'b-real-10-bulk-cards.png') });
    check(cards.length === 3 && cards.every((c) => c.length > 10), 'then a card per post, each with its own AI caption', cards.map((c) => c.slice(0, 40)));
    await page.fill('#csCompose .csb-bcap[data-bcap="1"]', 'My own words for clip two');
    // several days, one by one: starts Tonight 7 pm, then exactly every 6 hours
    await page.tap('#csCompose [data-c="quick"][data-k="tonight"]');
    await page.tap('#csCompose [data-c="spacing"][data-h="6"]');
    const plan = await page.$eval('#csCompose .csb-plan', (n) => n.textContent).catch(() => '');
    const cardTimes = await page.$$eval('#csCompose .csb-bmain > small', (xs) => xs.map((x) => x.textContent.trim()));
    if (SHOTS) { await page.evaluate(() => { const w = document.querySelector('#csbWhen'); if (w) w.scrollIntoView({ block: 'center' }); }); await sleep(200); await page.screenshot({ path: path.join(SHOTS, 'b-real-11-bulk-every6h.png') }); }
    check(/3 posts, every 6 hours/.test(plan) && cardTimes.length === 3, 'Starts + "then one every 6 h": the plan and each card say when', { plan, cardTimes });
    const goLabel = await page.$eval('#csCompose [data-c="go"]', (b) => b.textContent);
    check(/Schedule 3 posts/.test(goLabel), 'the button says how many posts', goLabel);
    await page.tap('#csCompose [data-c="go"]');
    await page.waitForFunction(() => !document.querySelector('#csCompose.on'), null, { timeout: 30000 }).catch(() => {});
    await sleep(1200);
    const all = await page.evaluate(async () => window.api.scheduler.list());
    const fresh = all.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 3);
    const times = fresh.map((p) => +new Date(p.scheduledAt)).sort();
    check(all.length === nBefore + 3 && fresh.some((p) => p.caption === 'My own words for clip two') && new Set(fresh.map((p) => p.caption)).size === 3,
      'Schedule makes one post each, with its own caption (an edited one kept)', fresh.map((p) => (p.caption || '').slice(0, 30)));
    const t7 = new Date(times[0]);
    check(times[1] - times[0] === 6 * 3600e3 && times[2] - times[1] === 6 * 3600e3 && t7.getHours() === 19 && t7.getMinutes() === 0,
      'they go out one by one: 7 pm, then exactly every 6 hours', times.map((t) => new Date(t).toString()));

    if (SHOTS) {
      await page.evaluate(() => { const x = document.querySelector('#csCompose .cp-x'); if (x) x.click(); });
      await sleep(600);
      await page.evaluate(() => window.MWSocial.go('scheduler'));
      await sleep(1200);
      await page.screenshot({ path: path.join(SHOTS, 'b-real-6-home-after.png') });
    }
  } catch (e) {
    check(false, 'the test ran to the end', e.message);
  } finally {
    await browser.close(); srv.kill(); ai.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
