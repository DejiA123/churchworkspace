'use strict';
/*
 * Flyer Maker test — boots the REAL renderer + preload (like the smoke test),
 * registers the real mwasset:// scheme so the on-device AI segmentation model
 * can load, and exercises the whole Canva-style flyer pipeline:
 *   fonts, templates, Magic text→flyer parsing/generation, editor operations,
 *   exact-size export (PNG / 2x / JPEG with embedded fonts), and background
 *   removal (AI + flood-fill fallback).
 * Run: npx electron test/flyer-maker.test.js
 */
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let failed = false;
function log(ok, name, d) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!ok) failed = true;
}

function aiDir() { return path.join(__dirname, '..', 'bin', 'ai'); }
function fontsDir() { return path.join(__dirname, '..', 'bin', 'fonts'); }

protocol.registerSchemesAsPrivileged([
  { scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Minimal IPC so the renderer's init() completes (mirrors main.js behaviour).
const video = require('../src/main/video');
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: os.tmpdir(), userData: os.tmpdir(), fontsDir: fontsDir(), ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton', 'Bebas Neue', 'Poppins', 'Bangers']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'no thumbs in test' }));
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

// The app now ships with GPU compositing ON (see main.js). Run with MW_GPU=1 to
// exercise that configuration; the default stays software so this suite still
// covers the "graphics acceleration turned off" escape hatch users can pick.
if (process.env.MW_GPU !== '1') app.disableHardwareAcceleration();

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: ' + label)), ms))]);
}

/* The real flyer texts from the user's example designs. */
const EXAMPLES = [
  {
    name: 'Holy Ghost Party',
    text: `Holy Ghost Party\nwith P. Daniel Olawande & Min. Tobi Akuraku\nWisdom & Power Service\nSun. 7th June, 2026 at 3PM\nVenue: The Envoys Centre, 6A Cocoa Industries Road, Ogba Industrial Estate, Ikeja, Lagos`,
    expect: { title: /holy ghost party/i, speaker: /daniel olawande/i, date: /7th june/i, time: /3PM/, venue: /envoys centre/i },
  },
  {
    name: 'Rain of Abundance',
    text: `April Destiny Encounter\nRain of Abundance\nwith P. Daniel Olawande\nApril 24th - April 30th, 2023\n10:30PM (Daily)`,
    expect: { title: /(rain of abundance|april destiny encounter)/i, speaker: /olawande/i, date: /april 24th/i, time: /10:30PM/i },
  },
  {
    name: 'Ekiti Fire Conference',
    text: `Ekiti Fire Conference EFC 2025\nTheme: Floodgates of the Supernatural\nMin. Pelumi Deborah, P. Daniel Olawande, Min. BBO\nFriday 14th March 2025\nVenue: Ekiti Parapo Pavilion, New Iyin Road, Ado Ekiti`,
    expect: { title: /ekiti fire conference/i, theme: /floodgates of the supernatural/i, speaker: /pelumi deborah/i, date: /14th march 2025/i, venue: /parapo pavilion/i },
  },
  {
    name: 'Halleluyah Night',
    text: `Halleluyah Night & Volunteers Congress\nTheme: Flood Gates Breaking Aggressive Praise & Worship\nMin. Ernest Uzezi, Min. Tobi Akuraku, P. Daniel Olawande, Min. Temitayo Adubi\nThurs. 26th Dec, 2024 at 9PM\nOld Auditorium, Redemption City of God, Ogun State`,
    expect: { title: /halleluyah night/i, theme: /aggressive praise/i, speaker: /ernest uzezi/i, date: /26th dec/i, time: /9PM/, venue: /(old auditorium|redemption city)/i },
  },
  {
    name: 'Manifestation of His Power',
    text: `Osun Students Pray 10th Edition\nManifestation of His Power\nPst. Daniel Olawande, Evang. Moses Ade Bamijoko\nJune 30th at 9PM\nVenue: Oba Adenile Park, Onisekere Area, Ayetoro Junction, Osogbo`,
    expect: { title: /manifestation of his power/i, speaker: /moses ade bamijoko/i, date: /june 30th/i, time: /9PM/, venue: /oba adenile park/i, edition: /10th edition/i },
  },
];

app.whenReady().then(async () => {
  // Serve bundled AI assets exactly like the real app does.
  protocol.handle('mwasset', async (request) => {
    try {
      const u = new URL(request.url);
      const rel = decodeURIComponent((u.hostname + u.pathname)).replace(/^\/+/, '');
      const full = path.normalize(path.join(aiDir(), rel));
      if (!full.startsWith(aiDir())) return new Response('forbidden', { status: 403 });
      const ext = path.extname(full).toLowerCase();
      const mime = ext === '.wasm' ? 'application/wasm' : (ext === '.mjs' || ext === '.js') ? 'text/javascript' : 'application/octet-stream';
      const buf = await fs.promises.readFile(full);
      return new Response(buf, { headers: { 'content-type': mime } });
    } catch (e) { return new Response('not found: ' + e.message, { status: 404 }); }
  });

  console.log('\n[A] Boot + modules');
  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + d.reason));

  const J = (code, ms, label) => withTimeout(win.webContents.executeJavaScript(code), ms || 20000, label || code.slice(0, 40));

  try {
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    log(true, 'renderer loaded');
  } catch (e) { log(false, 'renderer loaded', e.message); }
  await new Promise((r) => setTimeout(r, 1500));

  // A fresh, known design (localStorage may hold an old autosave from a previous run).
  await J(`(() => { localStorage.removeItem('mw_design'); window.Editor.__test.loadPreset('event', 1080, 1350); return true; })()`);

  const mods = await J(`({
    tpl: !!window.FlyerTemplates, ai: !!window.FlyerAI, editor: !!window.Editor,
    tplCount: window.FlyerTemplates ? window.FlyerTemplates.TEMPLATES.length : 0,
    palCount: window.FlyerTemplates ? Object.keys(window.FlyerTemplates.PALETTES).length : 0,
    rail: document.querySelectorAll('.ed-rail-tab').length,
    drawer: !!document.getElementById('edDrawer'),
  })`);
  log(mods.tpl && mods.ai && mods.editor, 'FlyerTemplates + FlyerAI + Editor modules loaded');
  log(mods.tplCount >= 19, '19+ templates registered (incl. army/stamp/gold/war/fire-plaque)', mods.tplCount + ' templates');
  log(mods.palCount >= 14, '14+ colour palettes (incl. army green + black & gold)', mods.palCount + ' palettes');
  log(mods.rail === 6, 'left rail has 6 tabs (Magic/Templates/Text/Elements/BG/Layers)', mods.rail + ' tabs');

  console.log('\n[B] Fonts (bundled, embedded as data-URI @font-face)');
  const fonts = await J(`(async () => {
    await window.Editor.__test.fontsReady();
    const fams = window.Editor.__test.fontFamilies();
    const loads = await Promise.all(['Anton','Bebas Neue','Alfa Slab One','Great Vibes','Pacifico','Playfair Display','Montserrat'].map(async (f) => {
      try { await document.fonts.load("32px '" + f + "'"); return document.fonts.check("32px '" + f + "'"); } catch (e) { return false; }
    }));
    return { fams, loads };
  })()`, 30000, 'fonts');
  log(fonts.fams.length >= 9, 'all 9 bundled font families registered', fonts.fams.join(', '));
  log(fonts.loads.every(Boolean), 'display fonts actually load & render', fonts.loads.filter(Boolean).length + '/7 loaded');

  console.log('\n[C] Magic parser on the 5 real example flyers');
  for (const ex of EXAMPLES) {
    const f = await J(`window.Editor.__test.parse(${JSON.stringify(ex.text)})`);
    const checks = [];
    if (ex.expect.title) checks.push(['title', ex.expect.title.test(f.title), f.title]);
    if (ex.expect.theme) checks.push(['theme', ex.expect.theme.test(f.theme), f.theme]);
    if (ex.expect.speaker) checks.push(['speaker', f.speakers.some((s) => ex.expect.speaker.test(s.name)), f.speakers.map((s) => s.name).join('; ')]);
    if (ex.expect.date) checks.push(['date', ex.expect.date.test(f.date), f.date]);
    if (ex.expect.time) checks.push(['time', ex.expect.time.test(f.time), f.time]);
    if (ex.expect.venue) checks.push(['venue', ex.expect.venue.test(f.venue), f.venue]);
    if (ex.expect.edition) checks.push(['edition', ex.expect.edition.test(f.edition), f.edition]);
    const bad = checks.filter((c) => !c[1]);
    log(bad.length === 0, `parse "${ex.name}"`, bad.length ? bad.map((b) => b[0] + '=' + JSON.stringify(b[2])).join(', ') : checks.map((c) => c[0]).join('+'));
  }

  console.log('\n[D] Template engine — every template × palette builds a valid design');
  const tplCheck = await J(`(() => {
    const FT = window.FlyerTemplates;
    const out = { built: 0, bad: [] };
    for (const t of FT.TEMPLATES) {
      for (const pal of t.palettes) {
        for (const [w, h] of [[1080, 1350], [1080, 1080], [1080, 1920]]) {
          try {
            const d = FT.buildTemplate(t.id, pal, FT.SAMPLE, w, h);
            const valid = d.w === w && d.h === h && d.elements.length >= 4 &&
              d.elements.every((e) => Number.isFinite(e.x) && Number.isFinite(e.y) && e.w > 0 && e.h > 0);
            if (!valid) out.bad.push(t.id + '/' + pal + '@' + w + 'x' + h + ' invalid (' + d.elements.length + ' els)');
            else out.built++;
          } catch (err) { out.bad.push(t.id + '/' + pal + ': ' + err.message); }
        }
      }
    }
    return out;
  })()`, 30000, 'templates');
  log(tplCheck.bad.length === 0, `all template×palette×size combos build (${tplCheck.built})`, tplCheck.bad.slice(0, 4).join(' | '));

  console.log('\n[E] Magic generation → apply → edit');
  const gen = await J(`(() => {
    const list = window.Editor.__test.generate(${JSON.stringify(EXAMPLES[0].text)});
    const applied = window.Editor.__test.applyGenerated(0);
    return { n: list.length, names: list.map(x => x.name).slice(0,3), applied, allHaveEls: list.every(x => x.elements >= 4) };
  })()`);
  log(gen.n === 8, 'Magic generates 8 flyer options', gen.n + ': ' + gen.names.join(' / '));
  log(gen.allHaveEls, 'every generated flyer has a full layout');
  log(gen.applied >= 4, 'clicking a result loads it into the editor', gen.applied + ' editable layers');

  const vibe = await J(`(() => {
    const fire = window.Editor.__test.generate('Ekiti Fire Conference, theme: Floodgates of the Supernatural');
    const party = window.Editor.__test.generate('Holy Ghost Party celebration night');
    return { fire: fire[0].templateId, fireHasFirePal: fire.slice(0,3).some(x => ['fire','crimson'].includes(x.paletteId)),
             party: party[0].templateId };
  })()`);
  log(vibe.fireHasFirePal, 'fire-themed events pick fiery designs first', vibe.fire);
  log(vibe.party.includes('party') || vibe.party.includes('neon') || vibe.party.includes('youth') || vibe.party.includes('sticker'), 'party events pick party designs first', vibe.party);

  console.log('\n[F] Export — exact size, embedded fonts, 2x, JPEG');
  const exp1 = await J(`(async () => {
    window.Editor.__test.generate(${JSON.stringify(EXAMPLES[4].text)});
    window.Editor.__test.applyGenerated(0);
    const used = window.Editor.__test.usedFonts();
    const info = await window.Editor.__test.exportInfo();
    return { used, info };
  })()`, 40000, 'export1x');
  log(exp1.info.w === 1080 && exp1.info.h === 1350 && exp1.info.len > 5000, 'generated flyer exports EXACT 1080x1350', `${exp1.info.w}x${exp1.info.h}, ${exp1.info.len}b`);
  log(exp1.used.length > 0, 'design uses bundled display fonts (embedded in export)', exp1.used.join(', '));

  const exp2 = await J(`window.Editor.__test.exportInfo(2)`, 60000, 'export2x');
  log(exp2.w === 2160 && exp2.h === 2700, 'PNG 2× export doubles resolution', `${exp2.w}x${exp2.h}`);

  const jpg = await J(`window.Editor.__test.exportJpegInfo()`, 40000, 'jpeg');
  log(jpg.b0 === 255 && jpg.b1 === 216 && jpg.len > 5000, 'JPEG export produces a real JPEG', `bytes ${jpg.b0},${jpg.b1}, ${jpg.len}b`);

  // Print size export (A4 @300dpi) with a generated design
  const a4 = await J(`(async () => {
    const d = window.Editor.__test.getDesign();
    const list = window.FlyerTemplates.generateDesigns({ text: ${JSON.stringify(EXAMPLES[2].text)}, w: 2480, h: 3508, count: 2 });
    window.Editor.__test.setDesign(list[0].design);
    const info = await window.Editor.__test.exportInfo();
    window.Editor.__test.setDesign(d);
    return info;
  })()`, 60000, 'a4');
  log(a4.w === 2480 && a4.h === 3508, 'A4 print export is EXACT 2480x3508', `${a4.w}x${a4.h}`);

  console.log('\n[G] Background removal');
  const aiOk = await J(`window.FlyerAI.aiAvailable()`, 90000, 'ai init');
  log(aiOk === true, 'AI segmentation model loads (on-device, free)', String(aiOk));

  const flood = await J(`(async () => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 200;
    const x = c.getContext('2d');
    x.fillStyle = '#12d012'; x.fillRect(0,0,200,200);
    x.fillStyle = '#d01515'; x.fillRect(70,70,60,60);
    return await window.Editor.__test.removeBg(c.toDataURL('image/png'), 40);
  })()`, 60000, 'floodfill');
  log(flood.corner === 0, 'plain-background removal: background is transparent', 'corner alpha ' + flood.corner);
  log(flood.center > 200, 'plain-background removal: subject stays opaque', 'centre alpha ' + flood.center);

  // A person-ish portrait (skin-tone head + shoulders on a busy background):
  // the smart path must return a valid cut-out either via AI or the fallback.
  const person = await J(`(async () => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 400;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0,0,300,400); g.addColorStop(0,'#3355aa'); g.addColorStop(1,'#66aadd');
    x.fillStyle = g; x.fillRect(0,0,300,400);
    x.fillStyle = '#c68863'; x.beginPath(); x.ellipse(150,140,52,66,0,0,7); x.fill();   // head
    x.fillStyle = '#222833'; x.beginPath(); x.ellipse(150,330,110,90,0,0,7); x.fill();  // shoulders
    x.fillStyle = '#c68863'; x.fillRect(135,195,30,40);                                  // neck
    const out = await window.FlyerAI.removeBackground(c.toDataURL('image/png'));
    return { method: out.method, isPng: out.src.startsWith('data:image/png') };
  })()`, 90000, 'person');
  log(person.isPng, 'smart remove returns a valid transparent PNG', 'method: ' + person.method);

  console.log('\n[H] Editor operations (Canva parity)');
  const ops = await J(`(() => {
    const T = window.Editor.__test;
    T.loadPreset('blank', 1080, 1350);
    const r = {};
    T.addText({ heading: true });
    T.addShape('roundrect'); T.addShape('ellipse'); T.addShape('star'); T.addShape('line'); T.addEmoji('🔥');
    r.count = T.elementCount();
    const d = T.getDesign();
    r.roundedRadius = d.elements[1].radius;
    const id = d.elements[0].id;
    // hidden layers are excluded from export html
    T.toggleHidden(id);
    r.hiddenExcluded = !T.designHtml().includes('Your Heading');
    T.toggleHidden(id);
    r.shownIncluded = T.designHtml().includes('Your Heading');
    // lock
    r.locked = T.toggleLocked(id) === true;
    T.toggleLocked(id);
    // align to canvas
    T.select(id);
    const c1 = T.alignEl('hcenter'); const c2 = T.alignEl('bottom');
    const e = T.getDesign().elements[0];
    r.centered = Math.abs((e.x + e.w / 2) - 540) <= 1;
    r.bottomed = Math.abs((e.y + e.h) - 1350) <= 1;
    // zoom
    r.zoom2 = T.setZoom(2);
    r.zoomFit = T.setZoom(null) < 2;
    // layers panel
    T.setTab('layers');
    const html = T.layersHtml();
    r.layersListed = (html.match(/data-layer=/g) || []).length === r.count;
    T.setTab('magic');
    return r;
  })()`);
  log(ops.count === 6, 'heading + 4 shapes + emoji all add', ops.count + ' elements');
  log(ops.roundedRadius > 0, 'rounded rectangle has corner radius', 'r=' + ops.roundedRadius);
  log(ops.hiddenExcluded && ops.shownIncluded, 'hide layer excludes it from export; show restores');
  log(ops.locked, 'lock/unlock toggles');
  log(ops.centered && ops.bottomed, 'align-to-canvas (center / bottom) positions exactly');
  log(ops.zoom2 === 2 && ops.zoomFit, 'zoom controls (200% / fit) work');
  log(ops.layersListed, 'layers panel lists every element');

  console.log('\n[I] Text effects render CSS');
  const fx = await J(`(() => {
    const T = window.Editor.__test;
    T.loadPreset('blank', 1080, 1350);
    T.addText({ heading: true, effect: 'neon' });
    const neon = T.designHtml().includes('text-shadow');
    const d = T.getDesign(); d.elements[0].effect = 'outline'; T.setDesign(d);
    const outline = T.designHtml().includes('-webkit-text-stroke');
    const d2 = T.getDesign(); d2.elements[0].effect = 'chip'; T.setDesign(d2);
    const chip = T.designHtml().includes('border-radius:0.18em');
    return { neon, outline, chip };
  })()`);
  log(fx.neon, 'neon glow effect renders');
  log(fx.outline, 'outline effect renders');
  log(fx.chip, 'backing-chip effect renders');

  console.log('\n[K] Creative round 2: stickers, metal text, vibe routing');
  const round2 = await J(`(() => {
    const T = window.Editor.__test;
    T.loadPreset('blank', 1080, 1350);
    const r = {};
    r.stickerCount = T.stickerCount();
    const st = T.addSticker('flame');
    r.flame = st && st.type === 'image' && st.isSvg;
    T.addSticker('jet'); T.addSticker('qr'); T.addSticker('crown');
    r.count = T.elementCount();
    // gold / chrome metallic text
    T.addText({ heading: true, effect: 'gold' });
    r.gold = T.designHtml().includes('background-clip:text');
    const d = T.getDesign(); d.elements[d.elements.length - 1].effect = 'chrome'; T.setDesign(d);
    r.chrome = T.designHtml().includes('background-clip:text');
    // vibe routing for the new example styles
    r.army = T.generate('New Army Volunteers Meeting with P. Daniel Olawande, 09/11/2025 2PM')[0].templateId;
    r.war = T.generate('Weapons of War, 27-30 December 2021, RCCG Redemption Camp')[0].templateId;
    r.celeb = T.generate('Celebration Service — theme: The Hand of God, 4th Sun June 2023 4PM, Excellence Hotel Ogba, Ikeja Lagos')[0].templateId;
    r.firePart = T.generate('Understanding Fire Part 5 with P. Daniel Olawande, 20th Oct 2024 3PM, Excellence Hotel Ogba')[0].templateId;
    // "God's Army NATIONAL Conference" (the CONFIRMED stamp reference) must beat plain army routing
    r.national = T.generate('Gods Army — JCCF Nigeria National Conference 2025, scan to register')[0].templateId;
    // "AbunDANCE" must not trip the party rule's "dance" keyword
    r.rain = T.generate('Rain of Abundance with P. Daniel Olawande, April 24th 2023, 10:30PM Daily')[0].templateId;
    // "... Service" titles must stay TITLES; leftover brand line becomes the host
    const f = window.FlyerTemplates.parseEventText(${JSON.stringify('Celebration Service\nTheme: The Hand of God\nThe Envoys\nP. Daniel Olawande\n4th June 2023 at 4PM\nVenue: Excellence Hotel, Ogba, Ikeja Lagos')});
    r.svcTitle = f.title; r.svcChurch = f.church;
    return r;
  })()`);
  log(round2.stickerCount >= 13, '13+ graphics/stickers available', round2.stickerCount + ' stickers');
  log(round2.flame && round2.count === 4, 'stickers add as movable SVG layers (flame/jet/QR/crown)', round2.count + ' added');
  log(round2.gold, 'Gold 3D metallic text renders (gradient-filled glyphs)');
  log(round2.chrome, 'Chrome metallic text renders');
  log(round2.army === 'army-volunteers', 'army/volunteers events pick the Army Duotone design', round2.army);
  log(round2.war === 'war-metal', '"Weapons of War" picks the War Chrome design', round2.war);
  log(round2.celeb === 'gold-celebration', 'celebration services pick the Gold 3D design', round2.celeb);
  log(round2.firePart === 'fire-plaque', '"Understanding Fire Part 5" picks the Fire Plaque design', round2.firePart);
  log(round2.national === 'stamp-conference', 'national conference beats plain army routing (stamp look)', round2.national);
  log(round2.rain === 'rain-stack', '"Rain of AbunDANCE" is not hijacked by the party rule', round2.rain);
  log(/celebration service/i.test(round2.svcTitle), '"Celebration Service" parses as the TITLE', round2.svcTitle);
  log(/envoys/i.test(round2.svcChurch), 'leftover brand line ("The Envoys") becomes the host', round2.svcChurch);

  console.log('\n[M] HD photo backgrounds (real bundled photos, not vector art)');
  const photos = await J(`(async () => {
    const T = window.Editor.__test;
    await T.photosReady();
    const r = {};
    r.count = T.photoCount();
    r.manifest = window.FlyerTemplates.PHOTOS.length;
    T.loadPreset('blank', 1080, 1350);
    r.applied = T.applyPhotoBg('fire-flames');
    const bg = T.getBackground();
    r.type = bg.type; r.isData = /^data:image\\/jpeg/.test(bg.src || ''); r.overlay = /linear-gradient/.test(bg.overlay || ''); r.photoId = bg.photoId;
    T.generate('New Army Volunteers Meeting with P. Daniel Olawande, 09/11/2025 2PM');
    T.applyGenerated(0);
    const bg2 = T.getBackground();
    r.armyPhoto = bg2.type === 'image' && /^data:image\\/jpeg/.test(bg2.src || '') && /linear-gradient/.test(bg2.overlay || '');
    r.armyId = bg2.photoId || '(procedural fallback)';
    T.setTab('background');
    r.gallery = document.querySelectorAll('#edDrawer .ed-photo').length;
    T.setTab('magic');
    return r;
  })()`, 60000, 'photo library');
  log(photos.manifest >= 30 && photos.count >= 30, '30+ HD photos bundled & loaded as data URIs', photos.count + '/' + photos.manifest);
  log(photos.applied && photos.type === 'image' && photos.isData && photos.overlay, 'gallery click applies a real photo + readability tint', photos.photoId);
  log(photos.armyPhoto, 'army template uses a real soldiers photo (green duotone wash)', photos.armyId);
  log(photos.gallery >= 30, 'Background tab lists the HD photo gallery', photos.gallery + ' cards');
  let pe;
  try {
    pe = await J(`(async () => { const T = window.Editor.__test; T.loadPreset('blank', 1080, 1350); T.applyPhotoBg('city-night'); return await T.exportInfo(); })()`, 60000, 'photo export');
    log(pe.w === 1080 && pe.h === 1350, 'design with a photo background exports EXACT 1080x1350', pe.w + 'x' + pe.h);
  } catch (e) { log(false, 'design with a photo background exports EXACT 1080x1350', e.message); }

  console.log('\n[O] Creative round 3: layer order, pop-out subject, gradient text, overlap templates');
  const r3 = await J(`(async () => {
    const T = window.Editor.__test;
    T.loadPreset('blank', 1080, 1350);
    const r = {};
    r.tplCount = window.FlyerTemplates.TEMPLATES.length;
    T.addText({ heading: true });
    T.addShape('rect');
    T.addSticker('flame');
    const types = () => T.getDesign().elements.map((e) => e.type).join(',');
    r.order0 = types();
    const d0 = T.getDesign();
    T.select(d0.elements[0].id);
    T.bringFront(); r.order1 = types();
    T.sendBack(); r.order2 = types();
    T.bringForward(); r.order3 = types();
    T.sendBackward(); r.order4 = types();
    // pop-out: plain-background test image -> cut-out subject added ON TOP
    const cv = document.createElement('canvas'); cv.width = 200; cv.height = 200;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#00a651'; cx.fillRect(0, 0, 200, 200);
    cx.fillStyle = '#c1272d'; cx.beginPath(); cx.arc(100, 100, 60, 0, Math.PI * 2); cx.fill();
    T.addImageSrc(cv.toDataURL('image/png'), 100, 100, 300, 300);
    const before = T.elementCount();
    const dd = T.getDesign(); T.select(dd.elements[dd.elements.length - 1].id);
    await T.popOut();
    const after = T.getDesign();
    r.popCount = after.elements.length - before;
    const top = after.elements[after.elements.length - 1];
    r.popName = top.name || '';
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = top.src; });
    const c2 = document.createElement('canvas'); c2.width = im.naturalWidth; c2.height = im.naturalHeight;
    const x2 = c2.getContext('2d'); x2.drawImage(im, 0, 0);
    r.popCorner = x2.getImageData(1, 1, 1, 1).data[3];
    r.popCenter = x2.getImageData(Math.floor(c2.width / 2), Math.floor(c2.height / 2), 1, 1).data[3];
    // gradient text effects
    T.loadPreset('blank', 1080, 1350);
    T.addText({ heading: true, effect: 'fire' });
    r.fire = T.designHtml().includes('background-clip:text');
    const d2 = T.getDesign(); d2.elements[0].effect = 'royal'; T.setDesign(d2);
    r.royal = T.designHtml().includes('background-clip:text');
    // overlap templates: the photo layer must sit ABOVE the title text
    const hero = window.FlyerTemplates.buildTemplate('hero-overlap', 'gold', window.FlyerTemplates.SAMPLE, 1080, 1350);
    const photoI = hero.elements.findIndex((e) => e.type === 'image' && /over the title/i.test(e.name || ''));
    const lastTitleI = hero.elements.reduce((m, e, i) => (e.type === 'text' && e.font === 'Anton' ? i : m), -1);
    r.heroOrder = photoI >= 0 && lastTitleI >= 0 && photoI > lastTitleI;
    const echo = window.FlyerTemplates.buildTemplate('echo-outline', 'neon', window.FlyerTemplates.SAMPLE, 1080, 1350);
    r.echoPair = echo.elements.some((e) => e.name === 'Echo outline') && echo.elements.some((e) => e.type === 'text' && e.effect === 'shadow' && e.font === 'Anton');
    return r;
  })()`, 120000, 'creative round 3');
  log(r3.tplCount >= 21, '21+ templates (incl. Hero Overlap + Echo Outline)', r3.tplCount + ' templates');
  log(r3.order1 === 'rect,image,text' && r3.order2 === 'text,rect,image' && r3.order3 === 'rect,text,image' && r3.order4 === 'text,rect,image', 'layer order controls restack correctly (front/back/forward/backward)', r3.order1 + ' | ' + r3.order3);
  log(r3.popCount === 1 && /cut-out/i.test(r3.popName), '"Pop out subject" adds an AI cut-out as the TOP layer', r3.popName);
  log(r3.popCorner === 0 && r3.popCenter === 255, 'the cut-out is transparent around the subject, opaque inside', 'corner ' + r3.popCorner + ' / centre ' + r3.popCenter);
  log(r3.fire && r3.royal, 'Fire + Royal gradient text effects render (gradient-filled glyphs)');
  log(r3.heroOrder, 'Hero Overlap: the photo layer sits ABOVE the giant title (image-over-text)');
  log(r3.echoPair, 'Echo Outline: outline echo + filled title pair renders');

  console.log('\n[P] Photoshop-style layer tools (blend, shadow, skew, crop, gradients, adjustments)');
  const rp = await J(`(async () => {
    const T = window.Editor.__test;
    T.loadPreset('blank', 1080, 1350);
    T.addText({ heading: true });
    T.addShape('rect');
    T.addShape('star');
    const d = T.getDesign();
    const txt = d.elements[0], rect = d.elements[1], star = d.elements[2];
    txt.blend = 'overlay'; txt.ds = { on: true, x: 4, y: 8, blur: 20, color: '#000000', alpha: 0.5 };
    txt.caps = true; txt.underline = true; txt.skewX = 10;
    rect.fill2 = '#ff0000'; rect.gradAngle = 90;
    star.fill2 = '#00ff00';
    T.setDesign(d);
    const cv = document.createElement('canvas'); cv.width = 80; cv.height = 80;
    const cx = cv.getContext('2d'); cx.fillStyle = '#3355ff'; cx.fillRect(0, 0, 80, 80);
    T.addImageSrc(cv.toDataURL('image/png'), 50, 50, 300, 300);
    const d2 = T.getDesign();
    const img = d2.elements[d2.elements.length - 1];
    img.zoom = 2; img.panX = 20; img.panY = 80; img.filter = { hue: 90, invert: 1 };
    T.setDesign(d2);
    const html = T.designHtml();
    const r = {
      blend: html.includes('mix-blend-mode:overlay'),
      ds: html.includes('drop-shadow(4px 8px 20px rgba(0,0,0,0.5))'),
      caps: html.includes('text-transform:uppercase'),
      underline: html.includes('text-decoration:underline'),
      skew: html.includes('skew(10deg,0deg)'),
      rectGrad: html.includes('linear-gradient(90deg,'),
      starGrad: html.includes('<linearGradient'),
      crop: html.includes('object-position:20% 80%') && html.includes('scale(2,2)'),
      adjust: html.includes('hue-rotate(90deg)') && html.includes('invert(1)'),
      isolate: html.includes('isolation:isolate'),
    };
    const info = await T.exportInfo();
    r.export = info.w === 1080 && info.h === 1350 && info.len > 1500;
    return r;
  })()`, 60000, 'photoshop layer tools');
  log(rp.blend, 'blend modes render (mix-blend-mode on the layer)');
  log(rp.ds, 'drop-shadow layer style renders with colour + opacity');
  log(rp.caps && rp.underline, 'ALL CAPS + underline text options render');
  log(rp.skew, 'skew transform renders');
  log(rp.rectGrad, 'gradient fill on CSS shapes (rect) renders');
  log(rp.starGrad, 'gradient fill on SVG shapes (star) uses <linearGradient>');
  log(rp.crop, 'crop-inside-frame renders (zoom scale + object-position pan)');
  log(rp.adjust, 'hue + invert adjustments render');
  log(rp.isolate, 'export root isolates blend modes to the flyer');
  log(rp.export, 'design with new layer tools still exports EXACT size');

  console.log('\n[Q] Cinematic 3D text, real theme photos & wiser Magic parsing');
  const rq = await J(`(async () => {
    const T = window.Editor.__test; const FT = window.FlyerTemplates;
    await T.photosReady();
    // 3D metallic title effect: gradient-filled glyphs + a stacked extrusion filter
    const d = FT.buildTemplate('fire-conference', 'fire', { title: 'Fire Night', speakers: [], date: 'Fri', time: '6PM', venue: 'Main Hall' }, 1080, 1350);
    T.setDesign(d);
    const html = T.designHtml();
    const has3d = /background-clip:text/.test(html) && /drop-shadow\\([0-9.]+px [0-9.]+px 0 #/.test(html);
    // Real theme photos are bundled + loaded
    const photoCount = FT.photosLoaded();
    const biblePhoto = FT.pickPhoto('bible word study scripture the word');
    const prayPhoto = FT.pickPhoto('prayer praying hands vigil intercession');
    // Wiser parsing: valid title kept, recurring schedule captured
    const p1 = FT.parseEventText('Prayer & Fasting\\nTheme: The Secret Place\\nEvery Friday at 6PM');
    // Weighted routing still lands the dominant theme
    const bible = FT.generateDesigns({ text: 'Midweek Bible Study\\nThe Word', count: 1 })[0];
    // Birthday / tribute → the multi-portrait montage; it has many photo slots
    const bday = FT.generateDesigns({ text: 'Happy Birthday\\nCelebrating A Father\\nApostle Joshua Selman\\n25th June\\nWordWave TV', count: 1 })[0];
    const montageSlots = bday.design.elements.filter((e) => e.type === 'image' && e.ph).length;
    return { has3d, photoCount, biblePhoto, prayPhoto,
      title: p1.title, date: p1.date, time: p1.time, bibleTpl: bible.templateId,
      bdayTpl: bday.templateId, montageSlots };
  })()`, 60000, '3d + photos + parsing');
  log(rq.has3d, '3D metallic title renders (gradient fill + stacked extrusion)');
  log(rq.photoCount >= 37, '37+ HD photos bundled & loaded (incl. bible/prayer)', String(rq.photoCount));
  log(rq.biblePhoto === 'bible-open', 'Bible study finds the real open-Bible photo', rq.biblePhoto);
  log(rq.prayPhoto === 'praying-hands', 'Prayer finds the real praying-hands photo', rq.prayPhoto);
  log(rq.title === 'Prayer & Fasting', '"Prayer & Fasting" is kept as the TITLE (not a host word)', rq.title);
  log(/every friday/i.test(rq.date || '') && /6PM/i.test(rq.time || ''), 'recurring "Every Friday" + time parsed', rq.date + ' / ' + rq.time);
  log(rq.bibleTpl === 'bible-study', 'Bible study text routes to the bible-study design', rq.bibleTpl);
  log(rq.bdayTpl === 'portrait-montage', 'Birthday/tribute routes to the Portrait Montage', rq.bdayTpl);
  log(rq.montageSlots >= 5, 'Portrait Montage has a hero + several montage photo slots', rq.montageSlots + ' slots');

  console.log('\n[J] Legacy presets still export exact sizes (smoke parity)');
  for (const presetName of ['event', 'bold', 'blank']) {
    for (const [w, h] of [[1080, 1350], [2480, 3508]]) {
      let r;
      try {
        r = await J(`(async () => { window.Editor.__test.loadPreset('${presetName}', ${w}, ${h}); return await window.Editor.__test.exportInfo(); })()`, 60000, 'preset ' + presetName);
      } catch (e) { log(false, `preset "${presetName}" @ ${w}x${h}`, e.message); continue; }
      log(r && r.w === w && r.h === h && r.len > 1500, `preset "${presetName}" exports EXACT ${w}x${h}`, r ? `${r.w}x${r.h}, ${r.len}b` : 'no result');
    }
  }

  // XNNPACK line = MediaPipe's harmless model-load INFO logged at error level.
  const realErrors = errors.filter((e) => !/Security Warning|Autofill|enableDeviceEmulation|font|XNNPACK|TensorFlow/i.test(e));
  log(realErrors.length === 0, 'no renderer console errors', realErrors.slice(0, 3).join(' | '));

  console.log('\n' + (failed ? 'RESULT: FAIL' : 'RESULT: ALL PASS'));
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('Test harness error:', e); app.exit(1); });
