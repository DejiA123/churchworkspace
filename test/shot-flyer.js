'use strict';
// Screenshot the Flyer Maker (Canva-style UI): Magic results + a loaded design,
// plus an exported flyer PNG for eyeballing. Retries capturePage until non-empty.
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const video = require('../src/main/video');

const OUT = process.env.MW_SAMPLE_DIR || os.tmpdir();
const ok = (data) => ({ ok: true, data });
const fontsDir = () => path.join(__dirname, '..', 'bin', 'fonts');
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: OUT, userData: OUT, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('fonts:data', () => {
  const dir = fontsDir();
  return ok(fs.readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f))
    .map((f) => ({ file: f, base64: fs.readFileSync(path.join(dir, f)).toString('base64') })));
});
ipcMain.handle('photos:list', () => {
  const dir = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'photos');
  return ok(fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).map((f) => ({ name: f, path: path.join(dir, f) })));
});
ipcMain.handle('fs:readImageDataUrl', (e, { path: p }) => {
  const ext = path.extname(p).slice(1).toLowerCase() || 'png';
  return ok(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(p).toString('base64')}`);
});

protocol.registerSchemesAsPrivileged([
  { scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAGIC_TEXT = `Holy Ghost Party
with P. Daniel Olawande & Min. Tobi Akuraku
Theme: Wisdom & Power Service
Sun. 7th June, 2026 at 3PM
Venue: The Envoys Centre, 6A Cocoa Industries Road, Ikeja, Lagos`;

let lastShot = null;
async function capture(win, file, mustDiffer = true) {
  let candidate = null;
  for (let i = 0; i < 10; i++) {
    await sleep(800);
    win.webContents.invalidate();
    const img = await win.webContents.capturePage();
    const buf = img.toPNG();
    if (!buf || buf.length < 8000) continue;
    candidate = buf;
    if (!mustDiffer || !lastShot || !buf.equals(lastShot)) break; // wait for a repaint that differs from the previous shot
  }
  if (candidate) {
    fs.writeFileSync(file, candidate);
    lastShot = candidate;
    console.log('wrote ' + file + ' (' + candidate.length + ' bytes)');
    return true;
  }
  console.log('FAILED to capture ' + file);
  return false;
}

app.whenReady().then(async () => {
  protocol.handle('mwasset', async (request) => {
    try {
      const u = new URL(request.url);
      const rel = decodeURIComponent((u.hostname + u.pathname)).replace(/^\/+/, '');
      const dir = path.join(__dirname, '..', 'bin', 'ai');
      const full = path.normalize(path.join(dir, rel));
      if (!full.startsWith(dir)) return new Response('forbidden', { status: 403 });
      const ext = path.extname(full).toLowerCase();
      const mime = ext === '.wasm' ? 'application/wasm' : (ext === '.mjs' || ext === '.js') ? 'text/javascript' : 'application/octet-stream';
      return new Response(await fs.promises.readFile(full), { headers: { 'content-type': mime } });
    } catch (e) { return new Response('nf', { status: 404 }); }
  });

  const win = new BrowserWindow({
    show: true, width: 1500, height: 940,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1800);

  // Open the Flyer view, run Magic with the example text, load the first design.
  await win.webContents.executeJavaScript(`(async () => {
    localStorage.removeItem('mw_design');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-flyer').classList.add('active');
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === 'flyer'));
    await window.Editor.__test.fontsReady();
    await window.Editor.__test.photosReady();
    window.Editor.onShow();
    const ta = document.getElementById('magicText');
    ta.value = ${JSON.stringify(MAGIC_TEXT)};
    document.getElementById('magicGo').click();
    window.Editor.__test.applyGenerated(0);
    return true;
  })()`);
  await capture(win, path.join(OUT, 'flyer-magic.png'));

  // Templates tab view
  await win.webContents.executeJavaScript(`window.Editor.__test.setTab('templates'); true`);
  await capture(win, path.join(OUT, 'flyer-templates.png'));

  // Layers tab + a selected element (inspector visible)
  await win.webContents.executeJavaScript(`(() => {
    window.Editor.__test.setTab('layers');
    const d = window.Editor.__test.getDesign();
    const t = d.elements.find(e => e.type === 'text');
    if (t) window.Editor.__test.select(t.id);
    return true;
  })()`);
  await capture(win, path.join(OUT, 'flyer-layers.png'));

  // Export a few generated flyers at full size for eyeballing.
  const shots = [
    ['Holy Ghost Party', MAGIC_TEXT, 0],
    ['Fire Conference', 'Ekiti Fire Conference\nTheme: Floodgates of the Supernatural\nMin. Pelumi Deborah, P. Daniel Olawande, Min. BBO\nFriday 14th March 2025\nVenue: Ekiti Parapo Pavilion, New Iyin Road, Ado Ekiti', 0],
    ['Rain of Abundance', 'Rain of Abundance\nwith P. Daniel Olawande\nApril 24th - April 30th, 2023\n10:30PM (Daily)\nGethsemane Platforms', 0],
    ['Halleluyah Night', 'Halleluyah Night\nTheme: Flood Gates Breaking Aggressive Praise & Worship\nMin. Ernest Uzezi, P. Daniel Olawande\nThurs. 26th Dec, 2024 at 9PM\nOld Auditorium, Redemption City of God', 0],
    ['Worship Royal', 'Night of Worship\nTheme: In His Presence\nwith Min. Temitayo Adubi\nFriday 12th September 2026 at 9PM\nVenue: Main Auditorium, Grace Chapel', 1],
    ['Army Volunteers', 'Volunteers\nTheme: Meeting\nYoung Ministers Retreat\nP. Daniel Olawande\n9th November 2025 at 2PM\nVenue: Main Camp Ground, Redemption City', 0],
    ['Weapons of War', 'Weapons of War\nYoung Ministers Retreat\nwith P. Daniel Olawande\n27th December 2021 at 6PM\nVenue: RCCG Redemption Camp, KM 46, Lagos-Ibadan Exp., Ogun State', 0],
    ['Gold Celebration', 'Celebration Service\nTheme: The Hand of God\nThe Envoys\nP. Daniel Olawande\n4th June 2023 at 4PM\nVenue: Excellence Hotel, Ogba, Ikeja Lagos', 0],
    ['Stamp Conference', 'Gods Army\nJCCF Nigeria National Conference\n10th Edition\nPst. Daniel Olawande\n5th November 2025 at 9AM\nVenue: Global Impact Church, Ogudu-Oworonshoki Expressway, Ogudu, Lagos', 0],
    ['Fire Plaque', 'Understanding Fire\nTheme: Part 5\nThe Envoys\nMinistering: P. Daniel Olawande\n20th October 2024 at 3PM\nVenue: Excellence Hotel, Ogba Ikeja, Lagos', 0],
    ['Hero Overlap', 'Power Encounter\nTheme: Shifting Atmospheres\nThe Envoys\nwith P. Daniel Olawande\n12th December 2026 at 6PM\nVenue: Faith Arena, Ikeja, Lagos', 'hero-overlap'],
    ['Echo Outline', 'Youth Jam Night\nTheme: Overflow of Joy\nHouse of Praise Youth\nMin. Tobi Akuraku\n31st December 2026 at 8PM\nVenue: Dome Arena, Lagos', 'echo-outline'],
    ['Bible Study', 'Word Study\nTheme: Rightly Dividing The Word\nGrace Chapel\nTeacher: Pastor David Richman\nEvery Wednesday at 6PM\nVenue: Main Auditorium, Grace Chapel', 'bible-study'],
    ['Revival Poster', 'South Africa Revival\nTheme: A New Season\nwith P. Daniel Olawande\n13th - 14th June at 6PM\nVenue: The Masters Place, Randburg, Johannesburg', 'revival-poster'],
    ['Holy Ghost Fire', '12 Hours In The Holyghost\nTheme: The Holy Spirit\n10th Edition\nP. Daniel Olawande\nJan 31st 2025\n6PM - 6AM\nVenue: RCCG Gate of Heavens, Redemption City', 'holyghost-fire'],
    ['Wisdom Service', 'Preserving The Authentic Supernatural\nInstagram Live Wisdom Service\nwith P. Daniel Olawande & Dr. Kay Ijisesan\nMonday August 24th\n2:30pm CST\nVenue: @pdanielolawande', 'wisdom-service'],
  ];
  for (const [name, text, idx] of shots) {
    const b64 = await win.webContents.executeJavaScript(`(async () => {
      const arr = window.Editor.__test.generate(${JSON.stringify(text)});
      const want = ${JSON.stringify(idx)};
      const i = typeof want === 'string' ? Math.max(0, arr.findIndex((x) => x.templateId === want)) : want;
      window.Editor.__test.applyGenerated(i);
      return await window.Editor.__test.exportBase64();
    })()`);
    const file = path.join(OUT, 'flyer-' + name.toLowerCase().replace(/[^a-z]+/g, '-') + '.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log('wrote ' + file);
  }

  win.destroy();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
