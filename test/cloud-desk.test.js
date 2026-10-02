'use strict';
/*
 * THE CLOUD STUDIO, FROM THE OPERATOR'S SIDE OF THE DESK.
 *
 * cloud-studio.test.js proves the server. This proves the two minutes before
 * anybody ever sees that server: someone opens Settings, ticks a box, and reads
 * an address and a code off the screen to type into a phone.
 *
 * It runs the REAL app under Electron — the real index.html, the real
 * renderer.js — and drives the panel the way a person does:
 *
 *   [A] the panel is there, off, and explains itself
 *   [B] ticking the box really starts a server, and the address and code on the
 *       screen are the ones that server will actually accept
 *   [C] the code is legible from arm's length, and is WORDS (this one faces the
 *       internet; a six-digit PIN would not do)
 *   [D] the Video Studio has a ☁️ Cloud button that brings you here
 *   [E] unticking it stops the server and frees the port
 *
 *   npx electron test/cloud-desk.test.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 7396;

const WORK = path.join(os.tmpdir(), 'mw-cloud-desk-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'userData'));

let failed = false;
const results = [];
function log(ok, name, detail) {
  results.push(!!ok);
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: 'GET', headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf-8')); } catch (e) {}
        resolve({ status: res.statusCode, json, text: buf.toString('utf-8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
function post(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch (e) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// The real main process, loaded the way Electron loads it.
require(path.join(ROOT, 'src/main/main.js'));

async function run() {
  await sleep(2000);   // the window, the store, the handlers

  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) { log(false, 'the studio window is open'); return; }
  log(true, 'the studio opened with the Cloud Studio compiled in');

  /* ───────────── [A] the panel, before anything is switched on ───────────── */
  console.log('\n=== [A] the panel ===');
  const before = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav-item[data-view="settings"]').click();
    await new Promise(r => setTimeout(r, 200));
    const p = document.getElementById('cloudPanel');
    return {
      hasPanel: !!p,
      heading: p ? p.querySelector('h2').textContent : '',
      blurb: p ? p.querySelector('p').textContent : '',
      checked: document.getElementById('cloudOn').checked,
      detailsHidden: document.getElementById('cloudDetails').classList.contains('hidden'),
      hasTunnel: !!document.getElementById('cloudTunnelOn'),
    };
  })()`);
  log(before.hasPanel, 'Settings has a Cloud Studio panel', before.heading);
  log(!before.checked && before.detailsHidden, 'it starts switched off, with the details folded away');
  log(/anywhere/i.test(before.heading + before.blurb), 'and says what it is for in plain words');
  log(before.hasTunnel, 'with the public-address decision kept separate from switching it on');

  /* ───────────── [B] ticking the box ───────────── */
  console.log('\n=== [B] switching it on ===');
  const on = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('cloudPort').value = ${PORT};
    document.getElementById('cloudOn').checked = true;
    document.getElementById('cloudOn').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1500));
    const st = await window.api.cloud.state();
    const el = (id) => document.getElementById(id);
    return {
      running: st.running, port: st.port, codeFromMain: st.code,
      url: el('cloudUrl').textContent,
      code: el('cloudCode').textContent,
      codePx: parseFloat(getComputedStyle(el('cloudCode')).fontSize),
      status: el('cloudStatus').textContent,
      detailsVisible: !el('cloudDetails').classList.contains('hidden'),
      alt: el('cloudUrlAlt').textContent,
      signedIn: el('cloudSignedIn').textContent,
    };
  })()`);
  log(on.running && on.detailsVisible, 'ticking it starts the server and unfolds the steps', on.status);
  log(/^http:\/\/[\d.]+:\d+$/.test(on.url), 'the address shown is one a phone can type', on.url);
  log(String(on.port) === String(PORT), 'on the port the box asked for', String(on.port));

  // The screen and the server have to agree, or the code is useless.
  const hello = await get('/api/hello');
  log(hello.status === 200 && hello.json.ok, 'and there really is a server answering there', hello.json && hello.json.name);

  const wrong = await post('/api/login', { code: 'not-the-code-9999' });
  log(wrong.status === 401, 'a code that is not the one on screen is refused');

  const right = await post('/api/login', { code: on.code });
  log(right.status === 200 && !!right.json.token, 'and the code ON THE SCREEN signs you in', on.code);
  log(on.code === on.codeFromMain, 'the panel shows exactly what the server holds');

  /* ───────────── [C] can it be read out loud? ───────────── */
  console.log('\n=== [C] legible ===');
  log(on.codePx >= 16, 'the code is big enough to read across a desk', on.codePx + 'px');
  log(/^[a-z]+-[a-z]+-\d{4}$/.test(on.code),
    'and it is WORDS and digits, not a six-digit PIN — this one faces the internet', on.code);
  log(/wifi|anywhere/i.test(on.alt), 'the panel is honest about what that address reaches', on.alt.slice(0, 60));

  /* ───────────── [D] the way in from the studio ───────────── */
  console.log('\n=== [D] from the Video Studio ===');
  const btn = await win.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('veCloud');
    if (!b) return { there: false };
    b.click();
    return {
      there: true, label: b.textContent,
      landed: document.getElementById('view-settings').classList.contains('active'),
      title: b.title.slice(0, 60),
    };
  })()`);
  log(btn.there, 'the Video Studio has a ☁️ Cloud button', btn.label);
  log(btn.landed, 'and it brings you to the panel');

  /* ───────────── [E] switching it off ───────────── */
  console.log('\n=== [E] switching it off ===');
  const off = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('cloudOn').checked = false;
    document.getElementById('cloudOn').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    const st = await window.api.cloud.state();
    return { running: st.running, status: document.getElementById('cloudStatus').textContent };
  })()`);
  log(!off.running, 'unticking it stops the server', off.status);
  let after = null;
  try { after = await get('/api/hello'); } catch (e) { after = { status: 0 }; }
  log(after.status === 0, 'and the port really is closed');

  // What was chosen is remembered for next time, which is what makes it come
  // back up on its own on Sunday.
  const remembered = await win.webContents.executeJavaScript(
    `(async () => { const s = await window.api.settings.get(); return s.cloud || null; })()`,
  );
  log(remembered && remembered.enabled === false && String(remembered.port) === String(PORT),
    'the choice is remembered in settings', remembered && JSON.stringify({ enabled: remembered.enabled, port: remembered.port }));
  log(remembered && typeof remembered.code === 'string' && remembered.code.length > 6,
    'including the code, so the phone that signed in stays signed in next launch');
}

app.whenReady().then(() => {
  run()
    .catch((e) => { console.error('\nTEST CRASHED:', e); failed = true; })
    .then(() => {
      const pass = results.filter(Boolean).length;
      console.log(`\n${failed ? '❌' : '✅'} ${pass}/${results.length} checks passed`);
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
      app.exit(failed ? 1 : 0);
    });
});
