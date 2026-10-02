'use strict';
/*
 * GO LIVE — AUDIO MIXER (vMix-style docked panel).
 *
 * Boots the real app UI and drives the mixer through real DOM events:
 *  - toggle via the bars button, panel structure (rails, Master, input strips)
 *  - strips exist ONLY for inputs that have audio
 *  - faders (master + input) move the real WebAudio gains
 *  - mute buttons sync with the input bar's Audio buttons and master mute
 *  - Solo is headphones-only: monitor gate closes, solo tap opens, broadcast
 *    bus (masterGain -> recording/stream) is untouched
 *  - headphone knob (wheel) changes monitor volume only
 *  - meters actually light up while a tone plays
 *  - OUTPUTS/INPUTS rails collapse their sections
 *
 * Run: npx electron test/audio-mixer.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-mixer-'));
const ok = (data) => ({ ok: true, data });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: { dest: 'facebook', key: '', customUrl: '', quality: '720p' } };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:pickScreen', () => ok(true));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.LiveStudio.__test';

app.whenReady().then(async () => {
  console.log('== GO LIVE — AUDIO MIXER TEST ==');

  const win = new BrowserWindow({
    show: true, width: 1480, height: 920,
    // fresh in-memory session -> empty localStorage, so the mixer's persisted
    // open/collapsed state from a previous manual run can't leak into the test
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, partition: 'mixer-test-' + Date.now() },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1000);
  await js(win, `localStorage.removeItem('mw-vmx-mixer'); localStorage.removeItem('mw-vmx-mixer-out'); localStorage.removeItem('mw-vmx-mixer-in');
    document.querySelector('.nav-item[data-view="live"]').click(); await new Promise(r=>setTimeout(r,300)); return true;`);

  /* -------- always-visible docked panel + structure (vMix style) -------- */
  console.log('\n[Panel] always visible, docked BELOW the monitors + vMix structure');
  let r = await js(win, `
    await new Promise(r2=>setTimeout(r2,150));
    const m = document.getElementById('vmxMixer');
    const box = m.getBoundingClientRect();
    const mons = document.querySelector('.vmx-mons').getBoundingClientRect();
    const bottom = document.querySelector('.vmx-status').getBoundingClientRect();
    return {
      visible: !m.classList.contains('hidden') && box.width > 0 && box.height > 0,
      belowMonitors: box.top >= mons.bottom - 1,
      monitorsTall: mons.height > 200, // the screens must KEEP their space — a collapsed monitor row is a layout bug
      mixerBounded: box.height > 150 && box.height < 400,
      aboveBottomBar: box.bottom <= bottom.top + 1,
      barsBtnGone: !document.getElementById('vmxMixerBtn'),
      pinGone: !document.getElementById('vmxMixerPin'),
      overlayBtnGone: !document.getElementById('vmxOverlayCfg'),
      tab: (m.querySelector('.vmx-mixer-tab')||{}).textContent,
      rails: [...m.querySelectorAll('.vmx-mixer-rail span')].map(s=>s.textContent),
      masterStrips: m.querySelectorAll('#vmxMixerOut .vmx-strip').length,
      masterTitle: (m.querySelector('#vmxMixerOut .vmx-strip-title')||{}).textContent,
      emptyNote: !!m.querySelector('.vmx-mixer-empty'),
      knob: !!m.querySelector('.vmx-knob'),
      stateOpen: ${T}.state().mixerOpen,
    };
  `);
  log(r && r.visible && r.stateOpen, 'mixer is ALWAYS visible — no button click needed (vMix style)');
  log(r && r.belowMonitors && r.monitorsTall, 'mixer top stays BELOW the monitors — the screens keep their full space',
    r && ('belowMonitors=' + r.belowMonitors + ' monitorsTall=' + r.monitorsTall));
  log(r && r.aboveBottomBar && r.mixerBounded, 'mixer is a bounded dock above the footer (not full-screen-height)');
  log(r && r.barsBtnGone && r.pinGone, 'old bars/pin toggle buttons are gone');
  log(r && r.overlayBtnGone, 'Overlay button removed from the bottom bar');
  log(r && /Audio Mixer/.test(r.tab || ''), '"Audio Mixer" label in the dock header', r && r.tab);
  log(r && r.rails && r.rails.join(',') === 'OUTPUTS,INPUTS', 'OUTPUTS / INPUTS rails present', r && r.rails.join(','));
  log(r && r.masterStrips === 1 && r.masterTitle === 'Master', 'Master strip in the OUTPUTS section');
  log(r && r.emptyNote, 'INPUTS section shows a note when no audio inputs exist');
  log(r && r.knob, 'Master strip has the headphones knob');

  /* -------- strips follow inputs (only ones WITH audio) -------- */
  console.log('\n[Strips] appear only for inputs with audio');
  r = await js(win, `
    ${T}.addColor('Backdrop', '#204080');          // no audio -> no strip
    const syn = ${T}.addSynthetic('Band', 120);    // 440Hz tone -> strip
    await new Promise(r2=>setTimeout(r2,400));
    const strips = [...document.querySelectorAll('#vmxMixerIn .vmx-strip')];
    return {
      synId: syn.id,
      count: strips.length,
      title: strips[0] ? strips[0].querySelector('.vmx-strip-title').textContent : '',
      hasSolo: !!(strips[0] && strips[0].querySelector('[data-mact="solo"]')),
      hasGear: !!(strips[0] && strips[0].querySelector('[data-mact="gear"]')),
      hasFader: !!(strips[0] && strips[0].querySelector('.vmx-vfader')),
      hasMeter: !!(strips[0] && strips[0].querySelector('.vmx-strip-meter')),
    };
  `);
  const synId = r && r.synId;
  log(r && r.count === 1, 'exactly one strip (colour input gets none)', r && ('count=' + r.count));
  log(r && /Band/.test(r.title), 'strip titled with input number + name', r && r.title);
  log(r && r.hasSolo && r.hasGear && r.hasFader && r.hasMeter, 'strip has S / gear / fader / meter');

  /* -------- faders drive the real gains -------- */
  console.log('\n[Faders] move the real WebAudio gains');
  r = await js(win, `
    ${T}.setAutoMix(false); // full weight regardless of program
    const strip = document.querySelector('#vmxMixerIn .vmx-strip[data-strip="${synId}"]');
    const fader = strip.querySelector('.vmx-vfader');
    fader.value = '0.4';
    fader.dispatchEvent(new Event('input', { bubbles: true }));
    let gain = 0;
    for (let i=0;i<40;i++){ ${T}.drawNow(); gain = ${T}.inputGain(${synId}); if (Math.abs(gain-0.4) < 0.05) break; await new Promise(r2=>setTimeout(r2,100)); }
    const vol = ${T}.state().inputs.find(i=>i.id===${synId}).volume;
    const pct = strip.querySelector('.vmx-strip-pct').textContent;
    return { vol, gain, pct };
  `);
  log(r && Math.abs(r.vol - 0.4) < 0.001, 'input fader sets the input volume', r && ('vol=' + r.vol));
  log(r && Math.abs(r.gain - 0.4) < 0.05, 'real input gain follows the fader', r && ('gain=' + (r.gain || 0).toFixed(2)));
  log(r && r.pct === '40%', 'strip shows the volume percentage', r && r.pct);

  r = await js(win, `
    const fader = document.querySelector('#vmxMixerOut .vmx-strip.master .vmx-vfader');
    fader.value = '0.6';
    fader.dispatchEvent(new Event('input', { bubbles: true }));
    let mg = 0;
    for (let i=0;i<40;i++){ ${T}.drawNow(); mg = ${T}.audioGraph().masterGain; if (Math.abs(mg-0.6) < 0.05) break; await new Promise(r2=>setTimeout(r2,100)); }
    return { masterVol: ${T}.state().masterVol, bottomBar: document.getElementById('vmxMasterVol').value, mg };
  `);
  log(r && Math.abs(r.masterVol - 0.6) < 0.001, 'master fader sets master volume', r && ('masterVol=' + r.masterVol));
  log(r && r.bottomBar === '0.6', 'bottom-bar master slider stays in sync', r && r.bottomBar);
  log(r && Math.abs(r.mg - 0.6) < 0.05, 'real master gain follows', r && ('gain=' + (r.mg || 0).toFixed(2)));

  /* -------- mute sync (strip <-> input bar, master <-> bottom bar) -------- */
  console.log('\n[Mute] strip and input-bar buttons stay in sync');
  r = await js(win, `
    document.querySelector('#vmxMixerIn .vmx-strip[data-strip="${synId}"] [data-mact="mute"]').click();
    await new Promise(r2=>setTimeout(r2,150));
    const st1 = ${T}.state();
    const barBtnOff = !document.querySelector('.vmx-input[data-id="${synId}"] button[data-act="audio"]').classList.contains('on');
    ${T}.clickCell(${synId}, 'audio'); // turn back on from the INPUT BAR side
    await new Promise(r2=>setTimeout(r2,150));
    const st2 = ${T}.state();
    const stripOnAgain = document.querySelector('#vmxMixerIn .vmx-strip[data-strip="${synId}"] [data-mact="mute"]').classList.contains('on');
    return { offAfterStrip: !st1.inputs.find(i=>i.id===${synId}).audioOn, barBtnOff, onAfterBar: st2.inputs.find(i=>i.id===${synId}).audioOn, stripOnAgain };
  `);
  log(r && r.offAfterStrip && r.barBtnOff, 'strip mute turns input audio off (bar button follows)');
  log(r && r.onAfterBar && r.stripOnAgain, 'input-bar Audio button turns it back on (strip follows)');

  r = await js(win, `
    document.querySelector('#vmxMixerOut .vmx-strip.master [data-mact="mute"]').click();
    await new Promise(r2=>setTimeout(r2,100));
    const muted = ${T}.state().masterMuted;
    const bottomBtn = document.getElementById('vmxMasterMute').textContent;
    document.getElementById('vmxMasterMute').click(); // unmute from the bottom bar
    await new Promise(r2=>setTimeout(r2,100));
    const stripOn = document.querySelector('#vmxMixerOut .vmx-strip.master [data-mact="mute"]').classList.contains('on');
    return { muted, bottomBtn, unmuted: !${T}.state().masterMuted, stripOn };
  `);
  log(r && r.muted && r.bottomBtn === '🔇', 'master strip mute syncs the bottom-bar button');
  log(r && r.unmuted && r.stripOn, 'bottom-bar unmute syncs the strip back');

  /* -------- Solo: headphones only, broadcast untouched -------- */
  console.log('\n[Solo] headphones-only, never the broadcast');
  r = await js(win, `
    document.querySelector('#vmxMixerIn .vmx-strip[data-strip="${synId}"] [data-mact="solo"]').click();
    await new Promise(r2=>setTimeout(r2,100));
    let g = null, sg = null;
    for (let i=0;i<40;i++){ ${T}.drawNow(); g = ${T}.audioGraph(); sg = ${T}.soloGainOf(${synId}); if (g.monitorGate < 0.05 && sg > 0.3) break; await new Promise(r2=>setTimeout(r2,100)); }
    const soloOnUi = document.querySelector('#vmxMixerIn .vmx-strip[data-strip="${synId}"] [data-mact="solo"]').classList.contains('solo-on');
    return { soloState: ${T}.state().inputs.find(i=>i.id===${synId}).solo, soloOnUi, gate: g.monitorGate, soloGain: sg, masterGain: g.masterGain };
  `);
  log(r && r.soloState && r.soloOnUi, 'S button engages solo (orange)');
  log(r && r.gate < 0.05, 'monitor gate closes — normal mix leaves the headphones', r && ('gate=' + (r.gate || 0).toFixed(2)));
  log(r && r.soloGain > 0.3, 'solo tap opens — solo input reaches the headphones', r && ('solo=' + (r.soloGain || 0).toFixed(2)));
  log(r && Math.abs(r.masterGain - 0.6) < 0.05, 'broadcast bus unaffected by solo', r && ('master=' + (r.masterGain || 0).toFixed(2)));

  r = await js(win, `
    document.querySelector('#vmxMixerIn .vmx-strip[data-strip="${synId}"] [data-mact="solo"]').click();
    let gate = 0;
    for (let i=0;i<40;i++){ ${T}.drawNow(); gate = ${T}.audioGraph().monitorGate; if (gate > 0.9) break; await new Promise(r2=>setTimeout(r2,100)); }
    return { gate };
  `);
  log(r && r.gate > 0.9, 'un-solo restores the normal headphone mix', r && ('gate=' + (r.gate || 0).toFixed(2)));

  /* -------- headphones knob -------- */
  console.log('\n[Headphones] knob changes the monitor bus only');
  r = await js(win, `
    const knob = document.querySelector('#vmxMixerOut .vmx-knob');
    for (let i=0;i<5;i++) knob.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true })); // 5 clicks down = -0.30
    let mon = null;
    for (let i=0;i<40;i++){ ${T}.drawNow(); mon = ${T}.audioGraph().monitorGain; if (Math.abs(mon-0.7) < 0.06) break; await new Promise(r2=>setTimeout(r2,100)); }
    return { monitorVol: ${T}.state().monitorVol, mon, masterGain: ${T}.audioGraph().masterGain };
  `);
  log(r && Math.abs(r.monitorVol - 0.7) < 0.001, 'knob wheel lowers monitor volume', r && ('monitorVol=' + r.monitorVol));
  log(r && Math.abs(r.mon - 0.7) < 0.06, 'real monitor gain follows the knob', r && ('gain=' + (r.mon || 0).toFixed(2)));
  log(r && Math.abs(r.masterGain - 0.6) < 0.05, 'broadcast bus unaffected by the knob', r && ('master=' + (r.masterGain || 0).toFixed(2)));

  /* -------- meters light up -------- */
  console.log('\n[Meters] strips light up while the tone plays');
  r = await js(win, `
    let lit = false;
    for (let i=0;i<30 && !lit;i++){
      ${T}.drawNow();
      const cv = document.querySelector('#vmxMixerIn .vmx-strip[data-strip="${synId}"] .vmx-strip-meter');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let p=0;p<d.length;p+=4){ if (d[p+1] > 150 && d[p] < 120) { lit = true; break; } } // a lit green segment
      if (!lit) await new Promise(r2=>setTimeout(r2,100));
    }
    return { lit };
  `);
  log(r && r.lit, 'input strip meter shows lit green segments');

  /* -------- rails collapse -------- */
  console.log('\n[Rails] OUTPUTS / INPUTS sections collapse');
  r = await js(win, `
    document.getElementById('vmxMixerRailIn').click();
    await new Promise(r2=>setTimeout(r2,100));
    const collapsed = document.getElementById('vmxMixerIn').classList.contains('hidden');
    document.getElementById('vmxMixerRailIn').click();
    await new Promise(r2=>setTimeout(r2,100));
    const back = !document.getElementById('vmxMixerIn').classList.contains('hidden') &&
                 document.querySelectorAll('#vmxMixerIn .vmx-strip').length === 1;
    return { collapsed, back };
  `);
  log(r && r.collapsed, 'INPUTS rail hides the input strips');
  log(r && r.back, 'clicking again brings them back');

  /* -------- the mixer can NOT be closed — it is part of the board -------- */
  r = await js(win, `
    const m = document.getElementById('vmxMixer');
    const box = m.getBoundingClientRect();
    return { stillVisible: !m.classList.contains('hidden') && box.height > 0, stateOpen: ${T}.state().mixerOpen };
  `);
  log(r && r.stillVisible && r.stateOpen, 'mixer remains visible after every interaction (no close control exists)');

  await js(win, `${T}.closeAllInputs(); return true;`);
  console.log('\n== ' + (failed ? 'FAILED' : 'ALL PASSED') + ' ==');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  app.exit(failed ? 1 : 0);
});
