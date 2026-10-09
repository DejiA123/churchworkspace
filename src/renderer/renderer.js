'use strict';

/* ===================== tiny helpers ===================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  video: null,        // { path, info }
  mergeClips: [],     // extra clip paths
  srt: null,
  postMedia: null,
  settings: null,
  paths: null,
  presets: {},
  template: 'modern',
};

// `ms` lets a long, instructional message (e.g. how to enable auto-captions on a
// Mac build) stay up long enough to actually be read.
/*
 * THE MESSAGE PILL. One look on the phone and the desk: frosted glass, a small
 * status mark in the kind's colour (done / problem / note), and the words —
 * without the decorative emoji the studio's messages open with, which read as
 * clutter beside a proper icon. Symbols that MEAN something in a sentence
 * (▶ ◆ ✓ ✕ arrows) are kept. It slides in, and fades out rather than blinking.
 */
const TOAST_ICONS = {
  good: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6.5"/><path d="M12 17.2v.1"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6.5"/><path d="M12 17.2v.1"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 11v6"/><path d="M12 7.2v.1"/></svg>',
};
const toastText = (msg) => String(msg == null ? '' : msg)
  .replace(/(?![▶⏸◆◇✓✕↔↕→←↑↓★])[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}][\u{FE0F}\u{20E3}\u{200D}\p{Extended_Pictographic}]*/gu, '')
  .replace(/️/g, '')
  .replace(/\s+([,.;:!?)])/g, '$1')
  .replace(/\(\s+/g, '(')
  .replace(/\s{2,}/g, ' ')
  .trim();
function toast(msg, kind = '', ms) {
  const t = document.getElementById('toast');
  if (!t) return;
  // a message that opens with a warning sign is a warning, whatever kind it was sent as
  const warn = !kind && /^\s*(?:⚠|🚫|⛔)/u.test(String(msg || ''));
  const k = kind === 'good' || kind === 'error' ? kind : (warn ? 'warn' : 'info');
  const text = toastText(msg) || String(msg || '');
  t.setAttribute('role', k === 'error' ? 'alert' : 'status');
  // "Headline — the detail" (or "Headline. The detail.") reads as a bold
  // title over a softer line; anything else is a single line.
  let title = text, sub = '';
  const cut = text.match(/^(.{4,52}?)(?:\s+—\s+|\.\s+)(.+)$/);
  if (cut) { title = cut[1].replace(/[.:]$/, ''); sub = cut[2].charAt(0).toUpperCase() + cut[2].slice(1); }
  else title = title.replace(/\.$/, '');   // a one-line note reads cleaner without its full stop
  t.innerHTML = `<span class="toast-ic">${TOAST_ICONS[k]}</span><span class="toast-msg"><b class="toast-title"></b><span class="toast-sub"></span></span>`;
  t.querySelector('.toast-title').textContent = title;
  const subEl = t.querySelector('.toast-sub');
  if (sub) subEl.textContent = sub; else subEl.remove();
  t.className = 'toast toast-' + k + (kind && k !== kind ? ' ' + kind : '');
  // restart the entrance even when a message replaces one still showing
  void t.offsetWidth;
  t.classList.add('toast-in');
  clearTimeout(toast._t); clearTimeout(toast._t2);
  const stay = ms || Math.min(7000, Math.max(3200, 1600 + text.length * 38));
  toast._t = setTimeout(() => {
    t.classList.remove('toast-in');
    t.classList.add('toast-out');
    toast._t2 = setTimeout(() => t.classList.add('hidden'), 260);
  }, stay);
}
window.__toast = toast; // used by editor.js

let _jobCounter = 0;
function newJobId() { return 'job_' + (++_jobCounter) + '_' + Date.now(); }

let _hideTimer = null;
function showOverlay(msg) {
  // Cancel any pending hide from the PREVIOUS job — in chained jobs (e.g. Export
  // all: export → text → captions, per clip) the stale timer used to hide the
  // overlay while the next job was still running, so exports looked "invisible".
  clearTimeout(_hideTimer); _hideTimer = null;
  $('#overlayMsg').textContent = msg || 'Working…';
  $('#progressBar').style.width = '0%';
  { const el = $('#overlayPct'); if (el) el.textContent = '0%'; }
  /*
   * The progress goes ON TOP of the captions editor. It sits under the studio's
   * sheets so a question asked mid-job can come up over it — but a job started
   * FROM the editor (🎧 Generate captions, Save video with captions) then ran
   * hidden behind it: the button seemed to do nothing until the editor was
   * closed by hand. When it finishes the editor is right there, with the words.
   */
  const capUp = !!document.querySelector('#capModal:not(.hidden)');
  $('#overlay').classList.toggle('on-top', capUp);
  $('#overlay').classList.remove('hidden');
}
/*
 * THE NUMBER, NOT JUST THE BAR.
 *
 * A bar answers "is it moving"; an operator with a service starting in ten
 * minutes is asking "how long", and only a number answers that.
 *
 * It used to be the CURRENT STEP's percentage, on the grounds that pretending
 * five passes are one smooth 0-100 would be a made-up number. That was the
 * wrong call in practice: the operator watched it reach 100% and start again
 * four times per short, which tells them nothing about how long the SHORT will
 * take — the thing they are actually waiting for. It is now one number for one
 * export, and it is not made up: the passes are weighted by what they really
 * cost (see CHAIN_WEIGHTS), so it moves at something like a steady pace instead
 * of crawling through the encode and leaping through the outro.
 */
function setProgress(p) {
  const pct = Math.max(0, Math.min(100, Math.round(p) || 0));
  $('#progressBar').style.width = Math.max(2, pct) + '%';
  const el = $('#overlayPct');
  if (el) el.textContent = pct + '%';
}
function hideOverlay() {
  clearTimeout(_hideTimer); _hideTimer = null;
  $('#overlay').classList.add('hidden');
  $('#overlay').classList.remove('on-top');
  setJobBatch(null);
  showCancel(null);
  const bg = $('#overlayBackground');
  if (bg) { bg.classList.add('hidden'); bg.onclick = null; }
}

/* ---------------- cancelling a running job ----------------
 * Deep analysis and transcription can run for minutes. The jobId that already
 * routes progress is also a kill handle in the main process, so the overlay just
 * needs a button that hands that id back. Once cancelled we remember the id so
 * the rejected promise reads as "cancelled", not as an ffmpeg crash. */
let _cancelJobId = null;
const _cancelledJobs = new Set();

function showCancel(jobId) {
  const b = $('#overlayCancel');
  _cancelJobId = jobId || null;
  if (!b) return;
  b.classList.toggle('hidden', !jobId);
  b.disabled = false;
  b.textContent = '✕ Cancel';
}
async function cancelCurrentJob() {
  const id = _cancelJobId;
  if (!id) return;
  const b = $('#overlayCancel');
  if (b) { b.disabled = true; b.textContent = 'Stopping…'; }
  _cancelledJobs.add(id);
  try { await api.job.cancel(id); } catch (e) { /* it may have just finished */ }
}
/** Was this job stopped by the user (rather than failing on its own)? */
function jobWasCancelled(jobId, err) {
  return !!(err && err.cancelled) || (jobId && _cancelledJobs.has(jobId));
}
window.__jobWasCancelled = jobWasCancelled;
window.__showCancel = showCancel;   // tasks.js drives the overlay's Cancel
window.__cancelJob = cancelCurrentJob;
(() => {
  const b = $('#overlayCancel');
  if (b) b.addEventListener('click', cancelCurrentJob);
})();

/** Batch indicator for multi-clip runs: "Short 2 of 5" above the job message. */
function setJobBatch(i, n, what, tail) {
  const el = $('#overlayBatch');
  if (!el) return;
  if (!i || !n) { el.classList.add('hidden'); el.textContent = ''; }
  else { el.classList.remove('hidden'); el.textContent = `${what || 'Short'} ${Math.min(i, n)} of ${n}${tail ? ' ' + tail : ''}`; }
}

/* The background-task layer — tasks, the chain that turns five ffmpeg passes
 * into one honest percentage, and the dock in the corner — moved to tasks.js
 * so the Cloud Studio's page loads the very same one. window.__newTask and
 * friends come from there. */

window.__newJobId = newJobId;
window.__showOverlay = showOverlay;
window.__hideOverlay = hideOverlay;
window.__setJobBatch = setJobBatch;
window.__setProgress = setProgress;
// finishedFile moved to tasks.js with the rest of the task layer (the dock shows
// it), and a file cannot export a function it no longer has.
/* ===================== navigation ===================== */
/*
 * SWITCHING PAGES, AND WHY IT IS THE ONE THING THAT CAN STALL THIS APP.
 *
 * All five studios live in ONE renderer on ONE main thread; switching pages
 * only toggles a CSS class, so nothing is unloaded and nothing is paused. Two
 * costs land on that thread the moment a class flips:
 *
 *   1. THE BROWSER LAYS OUT A STUDIO THAT WAS display:none. Thousands of nodes
 *      that have had no geometry since the app started suddenly need some.
 *   2. THE STUDIO'S OWN onShow() re-renders whatever it thinks is stale.
 *
 * Both used to happen inside the click, so the click WAS the stall. Now only
 * the part that must be synchronous is: the class toggle, so the page visibly
 * changes on the same frame the operator clicked. Everything else is handed to
 * the frame AFTER the browser has painted the new page, which turns one long
 * stall into a switch that is already on screen while the studio catches up.
 *
 * `__switchTimes` keeps the last few, split the same way, because "it feels
 * slow sometimes" is not something anybody can act on.
 */
const _switchTimes = [];
window.__switchTimes = _switchTimes;
let _gotoSeq = 0;
/*
 * …AND WHAT THE STUDIO YOU JUST LEFT SHOULD STOP DOING.
 *
 * Switching pages only toggles a CSS class, so a hidden studio carries on
 * exactly as it was — and a hidden element does not stop requestAnimationFrame,
 * or a <video>, or an audio context. The Video Studio left mid-preview went on
 * decoding a 90-minute recording and running a caption animation for the whole
 * of the sermon that followed, on the one thread the Presentation studio was
 * trying to put slides on the wall with.
 *
 * Go Live is the deliberate exception and is not asked: its compositor IS the
 * program feed and has to keep running whatever page is in front (it already
 * drops to 2 fps by itself when nobody is looking at it).
 */
const HIDEABLE = { video: () => window.VideoEditor, present: () => window.Presenter, flyer: () => window.Editor };
let _curView = 'dashboard';
function goto(view) {
  const t0 = performance.now();
  if (_curView !== view) {
    const leaving = HIDEABLE[_curView] && HIDEABLE[_curView]();
    if (leaving && leaving.onHide) { try { leaving.onHide(); } catch (e) {} }
    _curView = view;
  }
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (view !== 'dashboard') clearInterval(_dashLiveTimer);
  const tSwap = performance.now() - t0;
  /*
   * AFTER THE PAINT, NOT BEFORE IT, AND NOT INSIDE IT.
   *
   * requestAnimationFrame fires BEFORE the coming paint, so doing the studio's
   * catch-up there would hold that paint up — the operator would still wait,
   * and the frame monitor would still see one long frame. Handing it to a
   * timeout from inside the callback runs it immediately AFTER the new page has
   * been painted, so the page change is on screen first and the work lands
   * between frames instead of inside one.
   */
  const seq = ++_gotoSeq;
  const after = () => {
    /*
     * THE STUDIO YOU HAVE ALREADY LEFT DOES NOT NEED CATCHING UP.
     *
     * The catch-up is queued behind a paint, so flipping pages faster than the
     * work takes used to leave a queue of them — go live → present → video and
     * the app would still be re-rendering Go Live while the Video Studio was on
     * screen. Each one was work on a page nobody could see, and they ran back to
     * back, which is what turned rapid switching into a stall. Only the newest
     * one is worth doing.
     */
    if (seq !== _gotoSeq) return;
    const t1 = performance.now();
    if (view === 'scheduler') { refreshAccounts().then(refreshPosts); refreshAutopost(); }
    if (view === 'dashboard') refreshDashboard();
    if (view === 'flyer' && window.Editor) window.Editor.onShow();
    if (view === 'present' && window.Presenter) window.Presenter.onShow();
    if (view === 'video' && window.VideoEditor) window.VideoEditor.onShow();
    if (view === 'live' && window.LiveStudio) window.LiveStudio.onShow();
    _switchTimes.push({ view, swap: +tSwap.toFixed(1), show: +(performance.now() - t1).toFixed(1) });
    while (_switchTimes.length > 40) _switchTimes.shift();
  };
  requestAnimationFrame(() => setTimeout(after, 0));
}
$$('.nav-item').forEach((b) => b.addEventListener('click', () => goto(b.dataset.view)));
$$('[data-goto]').forEach((c) => c.addEventListener('click', () => goto(c.dataset.goto)));

/* ===================== sidebar collapse ===================== */
(() => {
  const sidebar = $('#sidebar');
  const toggle = $('#sidebarToggle');
  const setCollapsed = (on) => {
    sidebar.classList.toggle('collapsed', on);
    toggle.title = on ? 'Expand sidebar' : 'Collapse sidebar';
    try { localStorage.setItem('mw-sidebar-collapsed', on ? '1' : '0'); } catch (e) {}
  };
  setCollapsed(localStorage.getItem('mw-sidebar-collapsed') === '1');
  toggle.addEventListener('click', () => setCollapsed(!sidebar.classList.contains('collapsed')));
})();

// The CapCut-style Video Studio lives in veditor.js (window.VideoEditor).

/* ===================== FLYER MAKER (legacy templates unused) ===================== */
const TEMPLATES = {
  modern: { name: 'Modern Gradient', fn: tplModern },
  bold:   { name: 'Bold Banner', fn: tplBold },
  elegant:{ name: 'Elegant Serif', fn: tplElegant },
  minimal:{ name: 'Minimal Clean', fn: tplMinimal },
};

function flyerData() {
  return {
    title: $('#fTitle').value || 'Sunday Service',
    subtitle: $('#fSubtitle').value || '',
    date: $('#fDate').value || '',
    time: $('#fTime').value || '',
    location: $('#fLocation').value || '',
    footer: $('#fFooter').value || '',
    church: (state.settings && state.settings.brand && state.settings.brand.churchName) || 'Our Church',
    primary: $('#fPrimary').value,
    accent: $('#fAccent').value,
  };
}

function tplModern(d, u) {
  const css = `
    .fl-root{--u:${u};width:100%;height:100%;font-family:'Segoe UI',sans-serif;position:relative;overflow:hidden;
      background:linear-gradient(135deg,${d.primary},${shade(d.primary,-40)});color:#fff;display:flex;flex-direction:column;justify-content:center;padding:calc(var(--u)*70px);}
    .fl-root .blob{position:absolute;border-radius:50%;filter:blur(calc(var(--u)*10px));opacity:.5;}
    .fl-b1{width:calc(var(--u)*420px);height:calc(var(--u)*420px);background:${d.accent};top:calc(var(--u)*-120px);right:calc(var(--u)*-120px);}
    .fl-b2{width:calc(var(--u)*300px);height:calc(var(--u)*300px);background:${shade(d.primary,60)};bottom:calc(var(--u)*-100px);left:calc(var(--u)*-90px);}
    .fl-church{position:relative;font-size:calc(var(--u)*30px);letter-spacing:calc(var(--u)*4px);text-transform:uppercase;opacity:.9;margin-bottom:calc(var(--u)*18px);}
    .fl-title{position:relative;font-size:calc(var(--u)*84px);font-weight:800;line-height:1.04;margin:0 0 calc(var(--u)*16px);overflow-wrap:break-word;}
    .fl-sub{position:relative;font-size:calc(var(--u)*38px);color:${d.accent};font-weight:600;margin-bottom:calc(var(--u)*40px);}
    .fl-meta{position:relative;font-size:calc(var(--u)*32px);line-height:1.9;}
    .fl-meta b{display:inline-block;width:calc(var(--u)*44px);}
    .fl-foot{position:relative;margin-top:calc(var(--u)*44px);background:${d.accent};color:#1a1a1a;display:inline-block;
      padding:calc(var(--u)*14px) calc(var(--u)*28px);border-radius:calc(var(--u)*40px);font-weight:700;font-size:calc(var(--u)*28px);align-self:flex-start;}`;
  const body = `<div class="fl-root"><div class="blob fl-b1"></div><div class="blob fl-b2"></div>
    <div class="fl-church">${esc(d.church)}</div>
    <h1 class="fl-title">${esc(d.title)}</h1>
    ${d.subtitle ? `<div class="fl-sub">${esc(d.subtitle)}</div>` : ''}
    <div class="fl-meta">
      ${d.date ? `<div><b>📅</b>${esc(d.date)}</div>` : ''}
      ${d.time ? `<div><b>🕙</b>${esc(d.time)}</div>` : ''}
      ${d.location ? `<div><b>📍</b>${esc(d.location)}</div>` : ''}
    </div>
    ${d.footer ? `<div class="fl-foot">${esc(d.footer)}</div>` : ''}</div>`;
  return { css, body };
}

function tplBold(d, u) {
  const css = `
    .fl-root{--u:${u};width:100%;height:100%;font-family:'Arial Black',Impact,sans-serif;background:${shade(d.primary,-65)};color:#fff;display:flex;flex-direction:column;}
    .fl-top{background:${d.accent};color:#1a1a1a;padding:calc(var(--u)*40px) calc(var(--u)*60px);font-size:calc(var(--u)*34px);font-weight:800;letter-spacing:calc(var(--u)*3px);text-transform:uppercase;}
    .fl-mid{flex:1;display:flex;flex-direction:column;justify-content:center;padding:calc(var(--u)*60px);}
    .fl-title{font-size:calc(var(--u)*120px);line-height:.98;margin:0;text-transform:uppercase;}
    .fl-title span{color:${d.accent};}
    .fl-sub{font-size:calc(var(--u)*40px);margin-top:calc(var(--u)*20px);font-family:'Segoe UI',sans-serif;font-weight:400;color:#dfe4ee;}
    .fl-bottom{background:${d.primary};padding:calc(var(--u)*36px) calc(var(--u)*60px);display:flex;flex-wrap:wrap;gap:calc(var(--u)*40px);font-family:'Segoe UI',sans-serif;font-size:calc(var(--u)*30px);font-weight:600;}
    .fl-bottom div b{color:${d.accent};}`;
  const t = esc(d.title).split(' ');
  const titleHtml = t.length > 1 ? t.slice(0, -1).join(' ') + ' <span>' + t.slice(-1) + '</span>' : esc(d.title);
  const body = `<div class="fl-root">
    <div class="fl-top">${esc(d.church)}</div>
    <div class="fl-mid"><h1 class="fl-title">${titleHtml}</h1>${d.subtitle ? `<div class="fl-sub">${esc(d.subtitle)}</div>` : ''}</div>
    <div class="fl-bottom">
      ${d.date ? `<div><b>WHEN</b><br/>${esc(d.date)} ${esc(d.time)}</div>` : ''}
      ${d.location ? `<div><b>WHERE</b><br/>${esc(d.location)}</div>` : ''}
      ${d.footer ? `<div><b>&#160;</b><br/>${esc(d.footer)}</div>` : ''}
    </div></div>`;
  return { css, body };
}

function tplElegant(d, u) {
  const css = `
    .fl-root{--u:${u};width:100%;height:100%;font-family:Georgia,'Times New Roman',serif;background:#faf7f0;color:#2a2a2a;
      display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:calc(var(--u)*80px);box-sizing:border-box;}
    .fl-frame{border:calc(var(--u)*3px) solid ${d.primary};padding:calc(var(--u)*60px);width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;box-sizing:border-box;}
    .fl-church{font-size:calc(var(--u)*28px);letter-spacing:calc(var(--u)*6px);text-transform:uppercase;color:${d.accent};margin-bottom:calc(var(--u)*30px);}
    .fl-rule{width:calc(var(--u)*120px);height:calc(var(--u)*3px);background:${d.accent};margin:calc(var(--u)*24px) 0;}
    .fl-title{font-size:calc(var(--u)*88px);font-weight:400;font-style:italic;color:${d.primary};margin:0;line-height:1.1;}
    .fl-sub{font-size:calc(var(--u)*34px);margin-top:calc(var(--u)*16px);}
    .fl-meta{font-size:calc(var(--u)*30px);line-height:2;margin-top:calc(var(--u)*30px);}
    .fl-foot{margin-top:calc(var(--u)*34px);font-size:calc(var(--u)*26px);font-style:italic;color:${d.accent};}`;
  const body = `<div class="fl-root"><div class="fl-frame">
    <div class="fl-church">${esc(d.church)}</div>
    <h1 class="fl-title">${esc(d.title)}</h1>
    ${d.subtitle ? `<div class="fl-sub">${esc(d.subtitle)}</div>` : ''}
    <div class="fl-rule"></div>
    <div class="fl-meta">${[d.date, d.time, d.location].filter(Boolean).map(esc).join('<br/>')}</div>
    ${d.footer ? `<div class="fl-foot">${esc(d.footer)}</div>` : ''}
  </div></div>`;
  return { css, body };
}

function tplMinimal(d, u) {
  const css = `
    .fl-root{--u:${u};width:100%;height:100%;font-family:'Segoe UI',sans-serif;background:#fff;color:#111;display:flex;flex-direction:column;padding:calc(var(--u)*80px);box-sizing:border-box;}
    .fl-bar{width:calc(var(--u)*90px);height:calc(var(--u)*10px);background:${d.primary};margin-bottom:calc(var(--u)*40px);}
    .fl-church{font-size:calc(var(--u)*26px);text-transform:uppercase;letter-spacing:calc(var(--u)*3px);color:#888;}
    .fl-title{font-size:calc(var(--u)*100px);font-weight:800;margin:calc(var(--u)*10px) 0;line-height:1;color:#111;}
    .fl-sub{font-size:calc(var(--u)*40px);color:${d.primary};font-weight:600;}
    .fl-spacer{flex:1;}
    .fl-meta{font-size:calc(var(--u)*34px);line-height:1.8;border-top:calc(var(--u)*2px) solid #eee;padding-top:calc(var(--u)*30px);}
    .fl-meta span{color:${d.accent};font-weight:700;}
    .fl-foot{margin-top:calc(var(--u)*24px);font-size:calc(var(--u)*30px);font-weight:700;color:${d.accent};}`;
  const body = `<div class="fl-root">
    <div class="fl-bar"></div>
    <div class="fl-church">${esc(d.church)}</div>
    <h1 class="fl-title">${esc(d.title)}</h1>
    ${d.subtitle ? `<div class="fl-sub">${esc(d.subtitle)}</div>` : ''}
    <div class="fl-spacer"></div>
    <div class="fl-meta">
      ${d.date ? `<div><span>When </span>${esc(d.date)} ${esc(d.time)}</div>` : ''}
      ${d.location ? `<div><span>Where </span>${esc(d.location)}</div>` : ''}
    </div>
    ${d.footer ? `<div class="fl-foot">${esc(d.footer)}</div>` : ''}</div>`;
  return { css, body };
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = pct / 100;
  r = Math.round(Math.min(255, Math.max(0, r + 255 * f)));
  g = Math.round(Math.min(255, Math.max(0, g + 255 * f)));
  b = Math.round(Math.min(255, Math.max(0, b + 255 * f)));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function currentFlyerSize() {
  const [w, h] = $('#flyerSize').value.split('x').map(Number);
  return { w, h };
}

function renderFlyerPreview() {
  const { w, h } = currentFlyerSize();
  const d = flyerData();
  const u = w / 1080;
  const tpl = (TEMPLATES[state.template] || TEMPLATES.modern).fn(d, u);
  const prev = $('#flyerPreview');
  prev.style.width = w + 'px';
  prev.style.height = h + 'px';
  prev.innerHTML = `<style>${tpl.css}</style>${tpl.body}`;
  // Scale to fit the preview area
  const wrap = $('.flyer-preview-wrap');
  const availW = wrap.clientWidth - 40;
  const availH = wrap.clientHeight - 40;
  const scale = Math.min(availW / w, availH / h, 1);
  $('.flyer-preview-scaler').style.transform = `scale(${scale})`;
  $('.flyer-preview-scaler').style.width = w * scale + 'px';
  $('.flyer-preview-scaler').style.height = h * scale + 'px';
  prev.style.transformOrigin = 'top left';
  prev.style.transform = `scale(${scale})`;
  $('.flyer-preview-scaler').style.transform = 'none';
}

function buildFlyer() {
  const { w, h } = currentFlyerSize();
  const d = flyerData();
  const tpl = (TEMPLATES[state.template] || TEMPLATES.modern).fn(d, w / 1080);
  return { css: tpl.css, body: tpl.body, w, h };
}

/* The rasteriser — flyers, text overlays and the WYSIWYG caption track — moved
 * to rasterize.js so the Cloud Studio's page can load the very same one.
 * window.rasterizeFlyer / rasterizeToCanvas / canvasToPngBytes come from there. */

// The full flyer editor (drag/resize/layers/images/export) lives in editor.js and
// reuses window.rasterizeFlyer above. It wires its own DOM events on init.

// Helper the editor uses to attach an exported flyer to a new scheduled post.
window.attachFlyerToPost = (path, title, caption) => {
  state.postMedia = path;
  $('#sTitle').value = title || 'Flyer';
  if (caption) $('#sCaption').value = caption;
  $('#postMediaName').textContent = path.split(/[\\/]/).pop();
  goto('scheduler');
  toast('✅ Flyer ready and attached to a new post.', 'good');
};

/* ===================== SCHEDULER: linked accounts ===================== */
state.accounts = [];

const PLAT_ICON = { facebook: '📘', instagram: '📸', tiktok: '🎵', youtube: '▶️' };
const VIDEO_MEDIA_RX = /\.(mp4|mov|m4v|avi|mkv|webm|mpg|mpeg|wmv)$/i;

// Local file path → file:// URL the <img>/<video> tags can load (CSP allows file:).
const fileUrl = (p) => 'file:///' + String(p).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^\/+/, '');

// Show a thumbnail of the media just attached to a new post (image or video).
function renderPostMediaPreview() {
  const box = $('#postMediaPreview');
  if (!box) return;
  const p = state.postMedia;
  if (!p) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const url = fileUrl(p);
  box.innerHTML = VIDEO_MEDIA_RX.test(p)
    ? `<video src="${esc(url)}" controls autoplay loop muted playsinline preload="auto"></video>`
    : `<img src="${esc(url)}" alt="Attached media preview" />`;
  box.classList.remove('hidden');
}

function acctAvatar(a) {
  return a.picture
    ? `<img class="acct-ava" src="${a.picture}" alt="" />`
    : `<span class="acct-ava acct-ava-fallback">${esc((a.name || '?').replace('@', '').slice(0, 1).toUpperCase())}</span>`;
}

async function refreshAccounts() {
  try { state.accounts = await api.accounts.list(); } catch (e) { state.accounts = []; }
  renderAcctStrip();
  renderPostTargets();
  updateSchedBanner();
}

/* ---------------- 🕒 posting while the app is closed ----------------
 *
 * The switch here does not start a timer inside this app — that is the thing
 * that never worked. It asks Windows (or macOS) to run the app itself every
 * few minutes with no window, publish what is due, and quit. So the state
 * shown is whatever the OS ACTUALLY has registered, re-read each time this
 * page opens: a task somebody deleted in Windows' own Task Scheduler shows up
 * here as off, rather than the app claiming a schedule it no longer has.
 */
function autopostRunLine(r) {
  const when = new Date(r.at).toLocaleString();
  if (r.skipped === 'studio-open') return `<div class="ap-run"><span class="ap-when">${when}</span> checked — the app was open, so it posted from here</div>`;
  if (r.skipped === 'already-publishing') return `<div class="ap-run"><span class="ap-when">${when}</span> checked — a post was already uploading</div>`;
  if (r.skipped === 'error') return `<div class="ap-run bad"><span class="ap-when">${when}</span> ⚠️ ${esc(r.error || 'could not run')}</div>`;
  if (!r.published && !r.failed) return `<div class="ap-run"><span class="ap-when">${when}</span> checked — nothing was due</div>`;
  const bits = [];
  if (r.published) bits.push(`✅ posted ${r.published}${(r.titles || []).length ? ' (' + esc(r.titles.join(', ')) + ')' : ''}`);
  if (r.failed) bits.push(`✖ ${r.failed} failed${(r.errors || []).length ? ' — ' + esc(r.errors[0]) : ''}`);
  return `<div class="ap-run${r.failed ? ' bad' : ' good'}"><span class="ap-when">${when}</span> ${bits.join(' · ')}</div>`;
}

async function refreshAutopost() {
  const panel = $('#autopostPanel');
  if (!panel) return;
  let st;
  try { st = await api.autopost.status(); } catch (e) { st = null; }
  const badge = $('#autopostState'), note = $('#autopostNote'), runs = $('#autopostRuns');
  if (!st || !st.supported) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  state.autopost = st;
  $('#autopostOn').checked = !!st.enabled;
  $('#autopostEvery').value = String(st.everyMinutes);
  badge.textContent = st.enabled ? 'ON' : 'OFF';
  badge.className = 'badge ' + (st.enabled ? 'posted' : 'auto');

  const notes = [];
  // Switched on in the app but gone from the OS: say so plainly instead of
  // leaving a tick box promising something that will not happen.
  if (st.wanted && !st.enabled) notes.push('⚠️ This was switched on, but the task is no longer registered with ' + (st.platform === 'darwin' ? 'macOS' : 'Windows') + ' — switch it on again.');
  // Registered against a copy of the app that has since moved or been
  // replaced: it would look on and post nothing, so say so and say the fix.
  else if (st.stale) notes.push('⚠️ Windows is set to start an old copy of the app (' + esc(st.stale) + '). Untick this and tick it again to point it at the one you are using.');
  else if (st.enabled) notes.push(`${st.platform === 'darwin' ? 'macOS' : 'Windows'} checks your schedule every ${st.everyMinutes} minutes, so a post goes out within ${st.everyMinutes} minutes of the time you set.`);
  else notes.push('Right now posts only go out while this app is open.');
  note.innerHTML = notes.join(' ');

  runs.innerHTML = (st.runs || []).length
    ? '<div class="ap-runs-head muted small">Background checks</div>' + st.runs.map(autopostRunLine).join('')
    : '';
  updateSchedBanner(); // the banner's promise depends on whether this is on
}

async function setAutopost(on) {
  const every = Number($('#autopostEvery').value) || 5;
  const box = $('#autopostOn');
  box.disabled = true;
  try {
    if (on) {
      await api.autopost.enable(every);
      toast('🕒 Done — your posts now go out with the app closed.', 'good', 6000);
    } else {
      await api.autopost.disable();
      toast('Background posting is off — posts now need the app open.', 'good');
    }
  } catch (e) {
    box.checked = !on;
    toast('⚠️ ' + e.message, 'bad', 9000);
  } finally {
    box.disabled = false;
    refreshAutopost();
  }
}

$('#autopostOn').addEventListener('change', (e) => setAutopost(e.target.checked));
$('#autopostEvery').addEventListener('change', () => { if ($('#autopostOn').checked) setAutopost(true); });
$('#autopostTest').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = '⏳ Running the background poster…';
  try {
    const res = await api.autopost.testBackground();
    const r = res && res.run;
    if (!r) toast('⚠️ The background poster did not report back. Check that “' + (state.autopost || {}).command + '” can run on this PC.', 'bad', 12000);
    else if (r.published) toast(`✅ It works — the background poster published ${r.published} post${r.published === 1 ? '' : 's'} with no studio involved.`, 'good', 9000);
    else if (r.failed) toast(`The background poster ran, but ${r.failed} post failed: ${(r.errors || [])[0] || ''}`, 'bad', 12000);
    else toast('✅ It works — the background poster ran; nothing was due to post just now.', 'good', 8000);
  } catch (err) {
    toast('⚠️ ' + err.message, 'bad', 9000);
  } finally {
    btn.disabled = false; btn.textContent = was;
    refreshAutopost(); refreshPosts();
  }
});

function renderAcctStrip() {
  const el = $('#acctStrip');
  if (!el) return;
  if (!state.accounts.length) {
    el.innerHTML = '<p class="muted small">Nothing linked yet. Hit <b>＋ Connect account</b> — sign in once and the app posts for you: Facebook photos, videos &amp; text, and Instagram photos &amp; Reels.</p>';
    return;
  }
  el.innerHTML = state.accounts.map((a) => `
    <div class="acct-chip" data-acct="${a.id}" title="Click to test this connection">
      ${acctAvatar(a)}<span class="acct-plat">${PLAT_ICON[a.platform] || '🌐'}</span>
      <span class="acct-name">${esc(a.name)}</span>
      <button class="acct-x" data-unlink="${a.id}" title="Disconnect">✕</button>
    </div>`).join('');
  $$('#acctStrip .acct-chip').forEach((c) => c.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-unlink]')) return;
    c.classList.add('checking');
    try { const r = await api.accounts.check(c.dataset.acct); toast('✅ ' + r.name + ' is connected and ready.', 'good'); }
    catch (e) { toast('⚠️ ' + e.message, 'error'); }
    c.classList.remove('checking');
  }));
  $$('#acctStrip [data-unlink]').forEach((b) => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await api.accounts.remove(b.dataset.unlink);
    toast('Account disconnected.', 'good');
    refreshAccounts().then(refreshPosts);
  }));
}

function renderPostTargets() {
  const el = $('#postToAccounts');
  if (!el) return;
  if (!state.accounts.length) {
    el.innerHTML = '<span class="muted small">No linked accounts yet — hit “＋ Connect account” above.</span>';
    return;
  }
  el.innerHTML = state.accounts.map((a) => `
    <label class="pill acct-pick"><input type="checkbox" value="${a.id}" checked />
      ${acctAvatar(a)} ${PLAT_ICON[a.platform] || ''} ${esc(a.name)}</label>`).join('');
}

/* ---- Connect-account wizard ---- */
function acctModal(html) {
  $('#acctModalBox').innerHTML = html;
  $('#acctModal').classList.remove('hidden');
}
function closeAcctModal() { $('#acctModal').classList.add('hidden'); }
$('#acctModal').addEventListener('click', (e) => { if (e.target.id === 'acctModal') closeAcctModal(); });

$('#connectAccount').addEventListener('click', showPlatformChooser);

function showPlatformChooser() {
  acctModal(`
    <div class="acct-modal-head"><h2>＋ Connect an account</h2><button class="icon-btn" id="acctClose">✕</button></div>
    <p class="muted small">Link once — then scheduled posts publish by themselves.</p>
    <div class="acct-pagelist">
      <button class="acct-pagerow acct-choose" id="chooseFb">
        <span class="acct-ava acct-ava-fallback">📘</span>
        <span><b>Facebook Page + Instagram</b><br /><span class="muted small">Photos, videos &amp; text to your Page · Photos &amp; Reels to Instagram Business</span></span></button>
      <button class="acct-pagerow acct-choose" id="chooseYt">
        <span class="acct-ava acct-ava-fallback">▶️</span>
        <span><b>YouTube channel</b><br /><span class="muted small">Videos upload straight to your channel</span></span></button>
      <button class="acct-pagerow acct-choose" id="chooseTk">
        <span class="acct-ava acct-ava-fallback">🎵</span>
        <span><b>TikTok account</b><br /><span class="muted small">Videos post straight to your TikTok</span></span></button>
      <button class="acct-pagerow acct-choose" id="chooseIgZo">
        <span class="acct-ava acct-ava-fallback">📸</span>
        <span><b>Instagram — second route</b><br /><span class="muted small">A backup way in for Reels, for when Meta&rsquo;s own video service is refusing them</span></span></button>
    </div>`);
  $('#acctClose').onclick = closeAcctModal;
  // Facebook + Instagram connect directly through your Meta app (no third-party).
  $('#chooseFb').onclick = () => {
    const acc = (state.settings && state.settings.accounts) || {};
    if (!(acc.fbAppId || '').trim()) showAppSetup();
    else startFbConnect();
  };
  /*
   * YouTube prefers its OWN Google app whenever one is set up.
   *
   * Both routes work, but they are not equal: the Google one is free and
   * unlimited and costs nothing, while every platform on Zernio spends one of
   * the two slots its free plan allows — and a church that has already spent
   * both on Instagram and TikTok cannot put YouTube there at all (Zernio
   * answers "add a payment method"). So when the Google credentials are
   * present, that is simply the right answer and the app stops asking.
   * The Zernio route stays one click away inside the chooser for anyone who
   * has not set Google up.
   */
  $('#chooseYt').onclick = () => {
    const acc = (state.settings && state.settings.accounts) || {};
    const hasGoogle = !!((acc.ytClientId || '').trim() && (acc.ytClientSecret || '').trim());
    if (hasGoogle) startYtConnect();
    else showYtChoice();
  };
  // Instagram, the second way in. Meta direct (via the Facebook row above) stays
  // the primary route — this is what you reach for when it will not take video.
  $('#chooseIgZo').onclick = () => {
    const acc = (state.settings && state.settings.accounts) || {};
    if ((acc.zoApiKey || '').trim()) startZoConnect('instagram');
    else showZoSetup('instagram');
  };
  // TikTok uses the free & unlimited Zernio easy-connect only.
  $('#chooseTk').onclick = () => {
    const acc = (state.settings && state.settings.accounts) || {};
    if ((acc.zoApiKey || '').trim()) startTkZoConnect();
    else showTkZoSetup();
  };
}

/* ---- Zernio: the free & unlimited easy connect (TikTok + YouTube) ---- */
// One free Zernio key connects TikTok + YouTube (2 accounts free), so the same
// wizard drives either platform — `platform` picks the labels + connect call.
const ZO_LABEL = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };
const ZO_SIGNIN = { tiktok: 'TikTok', youtube: 'YouTube (Google)', instagram: 'Instagram', facebook: 'Facebook' };
const ZO_CONNECT = { tiktok: 'connectZo', youtube: 'connectZoYt', instagram: 'connectZoIg', facebook: 'connectZoFb' };
function zoAdvanced(platform) {
  if (platform === 'youtube') return showYtSetup();
  return; // TikTok has no own-app route anymore — Zernio easy-connect only.
}

function showZoSetup(platform, err) {
  const acc = (state.settings && state.settings.accounts) || {};
  const label = ZO_LABEL[platform] || 'TikTok';
  const signIn = ZO_SIGNIN[platform] || label;
  const noPortal = platform === 'youtube' ? ', and <b>no Google Cloud Console</b> to set up' : '';
  // Only YouTube keeps a "fully direct" fallback (your own Google app); TikTok is
  // Zernio easy-connect only.
  const advancedLink = platform === 'youtube'
    ? ` Prefer fully direct? Use <a href="#" id="zoGoAdvanced">the advanced setup</a> instead.` : '';
  acctModal(`
    <div class="acct-modal-head"><h2>⚡ ${label} easy connect (free &amp; unlimited)</h2><button class="icon-btn" id="acctClose">✕</button></div>
    ${err ? `<div class="post-error">⚠️ ${esc(err)}</div>` : ''}
    <p class="muted small">One-time setup (~1 minute). Zernio's ${label} app is already approved, so posts are <b>public immediately</b> — the free plan has <b>no monthly post limit</b>${noPortal}.</p>
    <ol class="acct-steps muted small">
      <li>Tap <b>Sign up free</b> below → create a Zernio account (no card — its <b>2 free slots</b> cover TikTok + YouTube).</li>
      <li>Tap <b>API keys</b> → <b>Create API Key</b> → copy it.</li>
      <li>Paste the key below and hit Continue — a browser tab opens where you sign in to ${signIn} once.</li>
    </ol>
    <div class="acct-openrow">
      <button class="ghost-btn small" id="wizZoOpenSignup">🌐 Sign up free at Zernio</button>
      <button class="ghost-btn small" id="wizZoOpenKeys">🔑 API keys</button>
    </div>
    <p class="muted small">Heads-up: with this route your posts upload via Zernio's servers.${advancedLink}</p>
    <label>Zernio API key<input type="password" id="wizZoKey" value="${esc(acc.zoApiKey || '')}" placeholder="paste it here" /></label>
    <div class="acct-modal-foot">
      <button class="ghost-btn" id="acctCancel">Cancel</button>
      <button class="primary-btn" id="wizZoContinue">Continue →</button>
    </div>`);
  $('#acctClose').onclick = $('#acctCancel').onclick = closeAcctModal;
  if ($('#zoGoAdvanced')) $('#zoGoAdvanced').onclick = (e) => { e.preventDefault(); zoAdvanced(platform); };
  const openExt = (url) => { try { api.shell.openExternal(url); } catch (e) { toast('Open ' + url + ' in your browser.', 'error'); } };
  $('#wizZoOpenSignup').onclick = () => openExt('https://zernio.com/signup');
  $('#wizZoOpenKeys').onclick = () => openExt('https://zernio.com/settings/api-keys');
  $('#wizZoContinue').onclick = async () => {
    const key = $('#wizZoKey').value.trim();
    if (!key) return toast('Paste the Zernio API key first.', 'error');
    const cur = (state.settings || {}).accounts || {};
    state.settings = await api.settings.update({ accounts: { ...cur, zoApiKey: key } });
    if ($('#setZoApiKey')) $('#setZoApiKey').value = key;
    startZoConnect(platform);
  };
}

async function startZoConnect(platform) {
  const label = ZO_LABEL[platform] || 'TikTok';
  const signIn = ZO_SIGNIN[platform] || label;
  acctModal(`
    <div class="acct-modal-head"><h2>⚡ Connecting ${label}…</h2><button class="icon-btn" id="acctClose">✕</button></div>
    <div class="acct-wait"><div class="spinner"></div>
      <p>Checking your Zernio account…</p>
      <p class="muted small">If ${label} isn't linked yet, a browser tab opens — sign in to ${signIn} there and allow access. This window finishes by itself.</p></div>
    <div class="acct-modal-foot">
      <button class="ghost-btn small" id="wizEditZo">API key</button>
      <button class="ghost-btn" id="acctCancel">Cancel</button>
    </div>`);
  $('#acctClose').onclick = $('#acctCancel').onclick = closeAcctModal;
  $('#wizEditZo').onclick = () => showZoSetup(platform);
  try {
    const acc = await api.accounts[ZO_CONNECT[platform] || 'connectZo']();
    closeAcctModal();
    toast('✅ Connected ' + acc.name + ' — ' + label + ' auto-posting is ON (free, unlimited public posts).', 'good');
    // Book whatever was waiting on this account: the whole point of connecting
    // it this way is that those posts stop needing the PC.
    afterEasyFix();
  } catch (e) {
    showZoSetup(platform, e.message);
  }
}

// Thin platform wrappers so existing TikTok call sites stay unchanged.
function showTkZoSetup(err) { return showZoSetup('tiktok', err); }
function startTkZoConnect() { return startZoConnect('tiktok'); }

/* ============ MAKING INSTAGRAM (or TikTok) SURVIVE A SHUTDOWN ============
 *
 * Meta offers NO way to book an Instagram post in advance — no price, no
 * permission and no API version changes that; the content container it would
 * need expires after 24 hours. TikTok's own API is the same. So an account
 * connected directly to them can only be posted by something awake at the
 * time, which means this PC on.
 *
 * The way out is not a setting, it is a different route: link the account
 * through a service that IS awake, and hand IT the post with its time. The app
 * speaks two, both with free tiers, and the second exists because the first
 * one's free plan runs out of slots.
 */
const EASY_LABEL = { instagram: 'Instagram', tiktok: 'TikTok' };

function showEasyFix(platform) {
  const label = EASY_LABEL[platform] || platform;
  acctModal(`
    <div class="acct-modal-head"><h2>🔒 Make ${label} post with the PC off</h2><button class="icon-btn" id="acctClose">✕</button></div>
    <p class="muted small">${label} has <b>no way to book a post in advance</b> — that is Meta's API, not this app, and no setting or payment changes it. Right now this post waits on this PC.</p>
    <p class="muted small">Re-link the same ${label} account through a service that stays awake, and the post gets handed over the moment you schedule it. It posts exactly as it does now; the difference is that <b>this PC can be off</b>. Both are free — pick either, and if one says its free slots are full, use the other.</p>
    <div class="acct-pagelist">
      <button class="acct-pagerow acct-choose" id="fixZo">
        <span class="acct-ava acct-ava-fallback">⚡</span>
        <span><b>Zernio</b><br /><span class="muted small">Free, no post limit. Facebook &amp; Instagram get their own 2 free slots here, separate from TikTok/YouTube.</span></span></button>
      <button class="acct-pagerow acct-choose" id="fixUp">
        <span class="acct-ava acct-ava-fallback">📤</span>
        <span><b>Upload-Post</b><br /><span class="muted small">Free tier, already approved by ${label}. A separate account from Zernio — use this if Zernio's free slots are gone.</span></span></button>
    </div>
    <div class="acct-modal-foot"><button class="ghost-btn" id="acctCancel">Not now</button></div>`);
  $('#acctClose').onclick = $('#acctCancel').onclick = closeAcctModal;
  $('#fixZo').onclick = () => {
    const acc = (state.settings && state.settings.accounts) || {};
    // Facebook/Instagram use their own Zernio key when one is set (see zoCfg).
    if ((acc.zoApiKeyFb || acc.zoApiKey || '').trim()) startZoConnect(platform);
    else showZoSetup(platform);
  };
  $('#fixUp').onclick = () => {
    const acc = (state.settings && state.settings.accounts) || {};
    if ((acc.upApiKey || '').trim()) startUpConnect(platform);
    else showUpSetup(platform);
  };
}

function showUpSetup(platform, err) {
  const label = EASY_LABEL[platform] || platform;
  const acc = (state.settings && state.settings.accounts) || {};
  acctModal(`
    <div class="acct-modal-head"><h2>📤 ${label} via Upload-Post</h2><button class="icon-btn" id="acctClose">✕</button></div>
    ${err ? `<div class="post-error">⚠️ ${esc(err)}</div>` : ''}
    <p class="muted small">One-time setup (~1 minute). Their ${label} app is already approved, so posts go out public, and booked posts are held on their servers — not on this PC.</p>
    <ol class="acct-steps muted small">
      <li>Tap <b>Sign up free</b> below → create an Upload-Post account.</li>
      <li>Tap <b>API keys</b> → copy your key.</li>
      <li>Paste it below and hit Continue — a browser tab opens where you sign in to ${label} once.</li>
    </ol>
    <div class="acct-openrow">
      <button class="ghost-btn small" id="wizUpOpenSignup">🌐 Sign up free at Upload-Post</button>
      <button class="ghost-btn small" id="wizUpOpenKeys">🔑 API keys</button>
    </div>
    <p class="muted small">Heads-up: with this route your posts upload via Upload-Post's servers.</p>
    <label>Upload-Post API key<input type="password" id="wizUpKey" value="${esc(acc.upApiKey || '')}" placeholder="paste it here" /></label>
    <div class="acct-modal-foot">
      <button class="ghost-btn" id="acctCancel">Cancel</button>
      <button class="primary-btn" id="wizUpContinue">Continue →</button>
    </div>`);
  $('#acctClose').onclick = $('#acctCancel').onclick = closeAcctModal;
  const openExt = (url) => { try { api.shell.openExternal(url); } catch (e) { toast('Open ' + url + ' in your browser.', 'error'); } };
  $('#wizUpOpenSignup').onclick = () => openExt('https://www.upload-post.com/');
  $('#wizUpOpenKeys').onclick = () => openExt('https://app.upload-post.com/api-keys');
  $('#wizUpContinue').onclick = async () => {
    const key = $('#wizUpKey').value.trim();
    if (!key) return toast('Paste the Upload-Post API key first.', 'error');
    const cur = (state.settings || {}).accounts || {};
    state.settings = await api.settings.update({ accounts: { ...cur, upApiKey: key } });
    startUpConnect(platform);
  };
}

async function startUpConnect(platform) {
  const label = EASY_LABEL[platform] || platform;
  acctModal(`
    <div class="acct-modal-head"><h2>📤 Connecting ${label}…</h2><button class="icon-btn" id="acctClose">✕</button></div>
    <div class="acct-wait"><div class="spinner"></div>
      <p>Checking your Upload-Post account…</p>
      <p class="muted small">If ${label} isn't linked yet, a browser tab opens — sign in there and allow access. This window finishes by itself.</p></div>
    <div class="acct-modal-foot">
      <button class="ghost-btn small" id="wizEditUp">API key</button>
      <button class="ghost-btn" id="acctCancel">Cancel</button>
    </div>`);
  $('#acctClose').onclick = $('#acctCancel').onclick = closeAcctModal;
  $('#wizEditUp').onclick = () => showUpSetup(platform);
  try {
    const acc = await api.accounts.connectUpIg();
    closeAcctModal();
    toast(`✅ ${acc.name} reconnected — its posts are booked in advance now and go out with this PC off.`, 'good', 9000);
    await afterEasyFix();
  } catch (e) {
    showUpSetup(platform, e.message);
  }
}

/**
 * The account is re-linked; now book everything that was waiting on it, so the
 * operator does not have to touch each post to make the fix take effect.
 */
async function afterEasyFix() {
  await refreshAccounts();
  let booked = 0;
  for (const p of await api.scheduler.list()) {
    if (p.status !== 'scheduled') continue;
    try { const r = await api.scheduler.handOff(p.id); booked += (r && r.booked) || 0; } catch (e) {}
  }
  if (booked) toast(`🔒 ${booked} scheduled post${booked === 1 ? '' : 's'} booked with the platform — safe with this PC off.`, 'good', 9000);
  refreshPosts();
}

/* ---- YouTube: easy (Zernio) vs advanced (your own Google app) ---- */
function showYtChoice() {
  acctModal(`
    <div class="acct-modal-head"><h2>▶️ Connect YouTube</h2><button class="icon-btn" id="acctClose">✕</button></div>
    <p class="muted small">Two ways to auto-post to your channel — pick one:</p>
    <div class="acct-pagelist">
      <button class="acct-pagerow acct-choose" id="ytEasy">
        <span class="acct-ava acct-ava-fallback">⚡</span>
        <span><b>Easy connect — no Google setup</b> <span class="muted small">(uses 1 of your 2 free Zernio slots)</span><br />
          <span class="muted small">One free key from <b>zernio.com</b> (the same key that connects TikTok) — just sign into YouTube once. <b>No Google Cloud Console, no OAuth client.</b></span></span></button>
      <button class="acct-pagerow acct-choose" id="ytAdvanced">
        <span class="acct-ava acct-ava-fallback">🛠️</span>
        <span><b>Your own Google app — free, unlimited, no Zernio slot</b><br />
          <span class="muted small">Upload straight to YouTube via your own Google Cloud OAuth client — more setup, but nothing goes through anyone else's servers.</span></span></button>
    </div>`);
  $('#acctClose').onclick = closeAcctModal;
  $('#ytEasy').onclick = () => {
    const acc = (state.settings && state.settings.accounts) || {};
    if ((acc.zoApiKey || '').trim()) startZoConnect('youtube');
    else showZoSetup('youtube');
  };
  $('#ytAdvanced').onclick = () => {
    const acc = (state.settings && state.settings.accounts) || {};
    if ((acc.ytClientId || '').trim() && (acc.ytClientSecret || '').trim()) startYtConnect();
    else showYtSetup();
  };
}

function showYtSetup(err) {
  const acc = (state.settings && state.settings.accounts) || {};
  acctModal(`
    <div class="acct-modal-head"><h2>▶️ Connect YouTube</h2><button class="icon-btn" id="acctClose">✕</button></div>
    ${err ? `<div class="post-error">⚠️ ${esc(err)}</div>` : ''}
    <p class="muted small">One-time setup (~3 minutes). The app talks straight to Google — nothing goes through anyone else's servers.</p>
    <p class="muted small">😮‍💨 Too much? <a href="#" id="ytGoEasy">Easy connect</a> needs just one pasted Zernio key and no Google setup at all.</p>
    <ol class="acct-steps muted small">
      <li>Open <b>console.cloud.google.com</b> → create a project (any name).</li>
      <li><b>APIs &amp; Services → Library</b> → enable <b>YouTube Data API v3</b>.</li>
      <li><b>OAuth consent screen</b> → External → add yourself as a test user.</li>
      <li><b>Credentials → Create credentials → OAuth client ID</b> → type <b>Desktop app</b> — copy the Client ID + Secret below.</li>
    </ol>
    <label>Google Client ID<input type="text" id="wizYtId" value="${esc(acc.ytClientId || '')}" placeholder="e.g. 1234…apps.googleusercontent.com" /></label>
    <label>Google Client Secret<input type="password" id="wizYtSecret" value="${esc(acc.ytClientSecret || '')}" placeholder="GOCSPX-…" /></label>
    <div class="acct-modal-foot">
      <button class="ghost-btn" id="acctCancel">Cancel</button>
      <button class="primary-btn" id="wizYtContinue">Continue with Google →</button>
    </div>`);
  $('#acctClose').onclick = $('#acctCancel').onclick = closeAcctModal;
  $('#ytGoEasy').onclick = (e) => { e.preventDefault(); showZoSetup('youtube'); };
  $('#wizYtContinue').onclick = async () => {
    const cid = $('#wizYtId').value.trim();
    const csec = $('#wizYtSecret').value.trim();
    if (!cid || !csec) return toast('Paste both the Client ID and the Client Secret.', 'error');
    const cur = (state.settings || {}).accounts || {};
    state.settings = await api.settings.update({ accounts: { ...cur, ytClientId: cid, ytClientSecret: csec } });
    $('#setYtClientId').value = cid;
    $('#setYtClientSecret').value = csec;
    startYtConnect();
  };
}

async function startYtConnect() {
  acctModal(`
    <div class="acct-modal-head"><h2>▶️ Connecting to YouTube…</h2><button class="icon-btn" id="acctClose">✕</button></div>
    <div class="acct-wait"><div class="spinner"></div>
      <p>Your browser opened — sign in with the Google account that owns the channel.</p>
      <p class="muted small">Come back here when Google says “Connected”.</p></div>
    <div class="acct-modal-foot">
      <button class="ghost-btn small" id="wizEditYt">App setup</button>
      <button class="ghost-btn" id="acctCancel">Cancel</button>
    </div>`);
  $('#acctClose').onclick = $('#acctCancel').onclick = closeAcctModal;
  $('#wizEditYt').onclick = () => showYtSetup();
  try {
    const acc = await api.accounts.connectYt();
    closeAcctModal();
    toast('✅ Connected ' + acc.name + ' — YouTube auto-posting is ON.', 'good');
    refreshAccounts().then(refreshPosts);
  } catch (e) {
    showYtSetup(e.message);
  }
}

function showAppSetup(err) {
  const acc = (state.settings && state.settings.accounts) || {};
  acctModal(`
    <div class="acct-modal-head"><h2>🔗 Connect Facebook &amp; Instagram</h2><button class="icon-btn" id="acctClose">✕</button></div>
    ${err ? `<div class="post-error">⚠️ ${esc(err)}</div>` : ''}
    <p class="muted small">One-time setup (~4 minutes). The app talks straight to Facebook — your login never goes through anyone else's servers. You must be an <b>admin of the Facebook Page</b> you want to post to.</p>
    <ol class="acct-steps muted small">
      <li>Open <b>developers.facebook.com/apps</b> and sign in with the Facebook account that manages your Page. <i>(Ignore any “Meta Model API” / AI banners — that's a different product, and it's geo-blocked in some countries. Your posting API works everywhere.)</i></li>
      <li>Hit <b>Create App</b> → choose <b>Other</b> → type <b>Business</b> → any name → Create. <i>(Create ONE app and stick with it — its App ID goes below.)</i></li>
      <li>In the app's left sidebar find <b>Add Product</b> → <b>Facebook Login</b> (may be called <i>Facebook Login for Business</i>) → <b>Set up</b>.</li>
      <li>Open <b>Facebook Login → Settings</b> and switch <b>ON</b>: ✅ <b>Client OAuth login</b> and ✅ <b>Embedded browser OAuth login</b> → hit <b>Save changes</b> and make sure it really saved (reload the page — both must still say Yes). Leave <b>Valid OAuth Redirect URIs empty</b> — pasting a facebook.com link there silently blocks the save.</li>
      <li><b>App settings → Basic</b>: copy the <b>App ID</b> and the <b>App Secret</b> (click <i>Show</i>) into the boxes below, then Continue — you'll sign in to Facebook and pick your Page.</li>
    </ol>
    <p class="muted small">💡 The app can stay in <b>Development mode</b> — that's enough to auto-post to Pages you admin, no review needed. If the Facebook popup says <b>“Can't load URL”</b>, step 4 didn't save — go back and check both toggles.</p>
    <label>Meta App ID<input type="text" id="wizAppId" value="${esc(acc.fbAppId || '')}" placeholder="e.g. 1089…" /></label>
    <label>Meta App Secret <span class="muted small">(recommended)</span><input type="password" id="wizAppSecret" value="${esc(acc.fbAppSecret || '')}" placeholder="keeps the link from expiring" /></label>
    <div class="acct-modal-foot">
      <button class="ghost-btn" id="acctCancel">Cancel</button>
      <button class="primary-btn" id="wizContinue">Continue with Facebook →</button>
    </div>`);
  $('#acctClose').onclick = $('#acctCancel').onclick = closeAcctModal;
  $('#wizContinue').onclick = async () => {
    const appId = $('#wizAppId').value.trim();
    if (!appId) return toast('Paste your Meta App ID first.', 'error');
    const cur = (state.settings || {}).accounts || {};
    state.settings = await api.settings.update({
      accounts: { ...cur, fbAppId: appId, fbAppSecret: $('#wizAppSecret').value.trim() },
    });
    $('#setFbAppId').value = appId;
    $('#setFbAppSecret').value = $('#wizAppSecret').value.trim();
    startFbConnect();
  };
}

async function startFbConnect() {
  acctModal(`
    <div class="acct-modal-head"><h2>🔗 Connecting to Facebook…</h2><button class="icon-btn" id="acctClose">✕</button></div>
    <div class="acct-wait"><div class="spinner"></div>
      <p>A Facebook window is open — sign in and allow access.</p>
      <p class="muted small">Then the app finds your Pages and Instagram accounts.</p></div>
    <div class="acct-modal-foot">
      <button class="ghost-btn small" id="wizEditApp">App setup</button>
      <button class="ghost-btn" id="acctCancel">Cancel</button>
    </div>`);
  $('#acctClose').onclick = $('#acctCancel').onclick = closeAcctModal;
  $('#wizEditApp').onclick = () => showAppSetup();
  try {
    const res = await api.accounts.connectFb();
    showPagePicker(res);
  } catch (e) {
    showAppSetup(e.message);
  }
}

function showPagePicker({ connectId, pages }) {
  acctModal(`
    <div class="acct-modal-head"><h2>Pick what to connect</h2><button class="icon-btn" id="acctClose">✕</button></div>
    <p class="muted small">Found ${pages.length} Page${pages.length === 1 ? '' : 's'}. Check everything the app should post to:</p>
    <div class="acct-pagelist">
      ${pages.map((p) => `
        <label class="acct-pagerow"><input type="checkbox" data-sel="facebook" data-page="${esc(p.pageId)}" checked />
          ${p.picture ? `<img class="acct-ava" src="${p.picture}" alt="" />` : '<span class="acct-ava acct-ava-fallback">📘</span>'}
          <span><b>${esc(p.name)}</b><br /><span class="muted small">📘 Facebook Page — photos, videos &amp; text auto-post</span></span></label>
        ${p.ig ? `
        <label class="acct-pagerow acct-pagerow-ig"><input type="checkbox" data-sel="instagram" data-page="${esc(p.pageId)}" checked />
          ${p.ig.picture ? `<img class="acct-ava" src="${p.ig.picture}" alt="" />` : '<span class="acct-ava acct-ava-fallback">📸</span>'}
          <span><b>@${esc(p.ig.username || p.name)}</b><br /><span class="muted small">📸 Instagram Business — photos &amp; Reels auto-post</span></span></label>` : ''}
      `).join('')}
    </div>
    <div class="acct-modal-foot">
      <button class="ghost-btn" id="acctCancel">Cancel</button>
      <button class="primary-btn" id="wizFinish">🔗 Connect selected</button>
    </div>`);
  $('#acctClose').onclick = $('#acctCancel').onclick = closeAcctModal;
  $('#wizFinish').onclick = async () => {
    const selections = $$('#acctModalBox [data-sel]:checked').map((c) => ({ type: c.dataset.sel, pageId: c.dataset.page }));
    if (!selections.length) return toast('Check at least one account.', 'error');
    try {
      const added = await api.accounts.add(connectId, selections);
      closeAcctModal();
      toast('✅ Connected ' + added.map((a) => a.name).join(', ') + ' — auto-posting is ON.', 'good');
      refreshAccounts().then(refreshPosts);
    } catch (e) { toast('⚠️ ' + e.message, 'error'); }
  };
}

/* ===================== SCHEDULER ===================== */
$('#pickPostMedia').addEventListener('click', async () => {
  try {
    const p = await api.dialog.openFile([{ name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'mp4', 'mov', 'gif', 'webp'] }]);
    if (p) { state.postMedia = p; $('#postMediaName').textContent = p.split(/[\\/]/).pop(); renderPostMediaPreview(); }
  } catch (err) { window.__toast && window.__toast('⚠️ Could not open media: ' + (err.message || 'Unknown error'), 'error'); }
});

$('#addPost').addEventListener('click', async () => {
  const title = $('#sTitle').value.trim();
  if (!title) return toast('Give the post a title.', 'error');
  const accountIds = $$('#postToAccounts input:checked').map((c) => c.value);
  const platforms = $$('#view-scheduler .platform-pick input:checked').map((c) => c.value);
  if (!accountIds.length && !platforms.length) {
    return toast('Pick at least one account to post to (or a reminder platform).', 'error');
  }
  // YouTube + TikTok only accept video uploads; Instagram takes a photo OR a
  // video but never text-only — catch it now, not at post time.
  const VIDEO_ONLY_NAMES = { youtube: 'YouTube', tiktok: 'TikTok' };
  const picked = accountIds.map((id) => state.accounts.find((x) => x.id === id)).filter(Boolean);
  const videoOnly = picked.filter((a) => VIDEO_ONLY_NAMES[a.platform]);
  if (videoOnly.length && !VIDEO_MEDIA_RX.test(state.postMedia || '')) {
    const names = Array.from(new Set(videoOnly.map((a) => VIDEO_ONLY_NAMES[a.platform])));
    const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1] : names[0];
    return toast(list + ' auto-posts need a video — attach a video file, or untick ' + (videoOnly.length === 1 ? 'that account.' : 'those accounts.'), 'error');
  }
  if (picked.some((a) => a.platform === 'instagram') && !state.postMedia) {
    return toast('Instagram auto-posts need a photo or video — attach media, or untick that account.', 'error');
  }
  const date = $('#sDate').value, time = $('#sTime').value;
  if (!date || !time) return toast('Pick a date and time.', 'error');
  const scheduledAt = new Date(`${date}T${time}`).toISOString();
  await api.scheduler.add({
    title, caption: $('#sCaption').value, platforms, accountIds,
    mediaPaths: state.postMedia ? [state.postMedia] : [], scheduledAt,
  });
  $('#sTitle').value = ''; $('#sCaption').value = ''; $('#postMediaName').textContent = '';
  state.postMedia = null;
  renderPostMediaPreview();
  renderPostTargets(); // reset the target checkboxes to all-on
  toast('✅ Post scheduled' + (accountIds.length ? ' — it will publish by itself.' : '.'), 'good');
  refreshPosts();
});


/* ---------------- ✨ write the post for me ----------------
 *
 * The subject comes from the media itself — for anything this app made, the
 * file name IS the spoken hook, because Long-to-shorts names each clip after
 * the line it found. The local thinking model turns that into copy when one is
 * installed; when it is not, the built-in rules do, so the button never sits
 * there doing nothing. See src/main/social-copy.js.
 */
const VIDEO_KIND_RX = /\.(mp4|mov|m4v|avi|mkv|webm)$/i;

/**
 * The three options, as cards.
 *
 * A single take is a guess at which platform this post is for. Three, each
 * written in the voice that platform actually reads in, is what an editor hands
 * over — and seeing them side by side is how you notice which one is right.
 * Clicking a card puts it in the fields above; the fields stay editable.
 */
function renderCopyOptions(out) {
  const box = $('#copyOptions');
  if (!box) return;
  const opts = (out && out.options) || [];
  box.classList.toggle('hidden', opts.length < 2);
  if (opts.length < 2) { box.innerHTML = ''; return; }
  box.innerHTML = opts.map((o, i) => `
    <div class="copy-opt${i === 0 ? ' on' : ''}" data-i="${i}" role="button" tabindex="0">
      <div class="copy-opt-head">
        <span class="copy-opt-label">Option ${i + 1}: ${esc(o.label)}</span>
        <span class="muted small">${esc(o.platforms)}</span>
      </div>
      <div class="copy-opt-title">${esc(o.title)}</div>
      <div class="copy-opt-body">${esc(o.caption)}</div>
    </div>`).join('');
  const use = (i) => {
    const o = opts[i]; if (!o) return;
    $('#sTitle').value = o.title;
    $('#sCaption').value = o.caption;
    $$('.copy-opt', box).forEach((el, j) => el.classList.toggle('on', j === i));
    toast(`✨ Using option ${i + 1}: ${o.label}. Edit it however you like.`, 'good', 4000);
  };
  $$('.copy-opt', box).forEach((el) => {
    el.addEventListener('click', () => use(+el.dataset.i));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); use(+el.dataset.i); } });
  });
}

/* ================= WHO WRITES THE CAPTIONS, FROM SETTINGS =================
 *
 * Three writers, in order of how good the answer is: a hosted model, the small
 * model on this PC, and the built-in rules. The rules always work and always
 * sound like rules; the hosted model reads the whole clip and writes copy that
 * can be posted as it is.
 *
 * The key box is the important part of this panel and the reason it is worth
 * its own section rather than a line in the AI keys block: on Groq's free tier
 * it is the SAME key 🎤 Listen uses, so a church that set the cloud ear up has
 * already done this and only has to be told so. That is what cwShared says.
 */
const WRITER_KEY = '__cloudwrite';
async function refreshWriter() {
  if (!$('#cwEngine')) return;
  try { state.writer = await api.social.cloudState(); } catch (e) { state.writer = null; }
  renderWriter();
}
function writerProvider() {
  const st = state.writer;
  return st ? (st.providers || []).find((p) => p.id === st.provider) || null : null;
}
function renderWriter() {
  const st = state.writer;
  const sel = $('#cwEngine');
  if (!st || !sel) return;
  const p = writerProvider();
  sel.innerHTML = (st.providers || []).map((x) =>
    `<option value="cloud:${esc(x.id)}">${esc(x.label)}</option>`).join('')
    + '<option value="local">This PC — the small local model, if installed</option>'
    + '<option value="rules">Built-in rules only — never touches the internet</option>';
  sel.value = st.on ? 'cloud:' + st.provider : 'rules';
  const on = !!st.on;
  $('#cwSetup').classList.toggle('hidden', !on);
  if (p) {
    $('#cwBlurb').textContent = p.blurb;
    $('#cwKey').placeholder = p.keyHint || 'your key';
    $('#cwGetKey').textContent = p.free ? 'Get a free key' : 'Get a key';
    $('#cwGetKey').style.display = p.keyUrl ? '' : 'none';
    $('#cwGetKey').onclick = (ev) => { ev.preventDefault(); if (p.keyUrl) api.shell.openExternal(p.keyUrl); };
    $('#cwUrlRow').classList.toggle('hidden', !p.needsUrl);
    $('#cwModel').innerHTML = (p.models || []).map((m) =>
      `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    $('#cwModel').value = st.model || (p.models[0] || {}).id || '';
  }
  // Never show back a key that is not this feature's own — a borrowed one is
  // reported in words instead, so clearing the box cannot delete the ear's key.
  if ($('#cwKey').value === '' && st.hasKey) $('#cwKey').value = WRITER_KEY;
  $('#cwUrl').value = st.url || '';
  $('#cwShared').textContent = st.borrowingKey
    ? '✔ Using the same free key you set up for 🎤 Listen. Paste a different one here only if you want a separate account.'
    : (st.hasKey ? '' : 'No key yet, so the built-in rules are writing them.');
  const status = $('#cwStatus');
  if (!on) status.textContent = 'Built-in rules';
  else if (!st.ready && st.cooling) status.textContent = `${st.providerName} — resting for ${Math.ceil(st.cooling / 1000)}s`;
  else if (!st.ready) status.textContent = st.hasKey || st.borrowingKey ? `${st.providerName} — ${st.why || 'not ready'}` : `${st.providerName} — needs a key`;
  else if (st.why) {
    // Ready, but the LAST thing it was asked did not work. That is the state an
    // operator is in when the captions have quietly gone back to templates, and
    // it used to read simply "ready".
    status.textContent = `${st.providerName} — last try failed: ${st.why}`;
  } else {
    status.textContent = `${st.providerName} — ready${st.free ? ', free' : ''}`
      + (st.usingModel ? ` · ${st.usingModel}` : '');
  }
}
/** What the boxes say right now, ready to save or test. */
function writerPatch() {
  const sel = $('#cwEngine');
  const v = sel.value;
  const cloud = v.indexOf('cloud:') === 0;
  const typed = $('#cwKey').value;
  return {
    on: cloud,
    provider: cloud ? v.slice(6) : ((state.writer || {}).provider || 'groq'),
    // The sentinel means "leave the stored key alone"; anything else is a real edit.
    key: typed === WRITER_KEY ? ((state.writer || {}).hasKey ? undefined : '') : typed.trim(),
    model: $('#cwModel').value || '',
    url: $('#cwUrl').value.trim(),
  };
}
async function saveWriter(patch) {
  const p = Object.assign({}, patch);
  if (p.key === undefined) delete p.key;   // a patch with no key keeps the stored one
  try { state.writer = await api.social.cloudSet(p); } catch (e) {}
  renderWriter();
}
(() => {
  const sel = $('#cwEngine');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const v = sel.value;
    const cloud = v.indexOf('cloud:') === 0;
    // 'local' and 'rules' both mean "not the cloud"; the difference is whether a
    // model is installed on this PC, which the main process works out for itself.
    saveWriter({ on: cloud, provider: cloud ? v.slice(6) : ((state.writer || {}).provider || 'groq') });
  });
  $('#cwModel').addEventListener('change', () => saveWriter(writerPatch()));
  $('#cwKey').addEventListener('focus', () => { if ($('#cwKey').value === WRITER_KEY) $('#cwKey').value = ''; });
  $('#cwKey').addEventListener('change', () => saveWriter(writerPatch()));
  $('#cwUrl').addEventListener('change', () => saveWriter(writerPatch()));
  $('#cwTest').addEventListener('click', async () => {
    const out = $('#cwTestResult');
    const btn = $('#cwTest');
    out.textContent = 'Asking it to write something…';
    btn.disabled = true;
    try {
      const r = await api.social.cloudTest(writerPatch());
      state.writer = (r && r.state) || state.writer;
      out.textContent = r && r.ok
        ? `✅ ${r.provider} answered in ${r.ms} ms with ${r.model}.`
        : `⚠️ ${(r && r.error) || 'It did not answer.'}`;
      renderWriter();
    } catch (e) {
      out.textContent = '⚠️ ' + (e.message || e);
    } finally { btn.disabled = false; }
  });
})();

async function writeCopyForMe() {
  const media = state.postMedia || (state.bulk && state.bulk.length ? state.bulk[0] : null);
  if (!media) return toast('Attach a video or picture first — the words are written from what is in it.', 'error');
  const btn = $('#sWriteForMe');
  const was = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '✨ Writing…'; }
  try {
    const kind = VIDEO_KIND_RX.test(media) ? 'video' : 'image';
    if (btn) btn.textContent = kind === 'video' ? '🎧 Listening to the clip…' : '✨ Writing…';
    const out = await api.social.suggestCopy({ mediaPath: media, kind });
    if (!out || !out.title) throw new Error('nothing came back');
    // Option 1 goes straight into the fields so the button still "just works";
    // all three are offered below, and clicking one swaps it in.
    $('#sTitle').value = out.title;
    $('#sCaption').value = out.caption || '';
    renderCopyOptions(out);
    // A caption the RULES wrote is not a failure — it is postable — but it is
    // not what the operator asked for either, and it must not arrive dressed as
    // a success. See writeNote().
    toast(writeNote(out), out.source === 'ai' ? 'good' : 'error', out.source === 'ai' ? 10000 : 13000);
  } catch (e) {
    toast('⚠️ Could not write it: ' + (e.message || e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = was; }
  }
}

/*
 * WHAT IT DID, IN ONE LINE.
 *
 * Copy is only as good as the words it was written from and the writer that
 * wrote them, and both of those can quietly be the weakest option available —
 * no key, no model, no speech in the clip. Saying which ear heard it and which
 * writer wrote it turns "this is terrible again" into something with an answer,
 * and points at the one setting that would fix it.
 */
function writeNote(out) {
  const who = out.speaker ? ` Credited to ${out.speaker}.` : '';
  const ear = out.heardBy === 'cloud' ? 'the full-size cloud speech model'
    : out.heardBy === 'local' ? 'this PC’s speech model' : '';
  if (!out.heard) {
    return ear
      ? `✨ Written from the file name: ${ear} found no speech in this one. Read it over before posting.`
      : '✨ Written from the file name — nothing listened to the clip. Set a writer up in Settings for captions written from what is actually said.';
  }
  if (out.wroteBy === 'cloud') {
    return `✨ Three options, written by ${out.writerName || 'the cloud writer'} from what is actually said in the clip`
      + `${ear ? `, heard by ${ear}` : ''}.${who} Pick one and edit anything that is not right.`;
  }
  if (out.wroteBy === 'local') {
    return `✨ Three options, written by the small model on this PC${ear ? `, from ${ear}` : ''}.${who} `
      + 'Settings → ✨ Social captions has a free cloud writer that does this far better.';
  }
  /*
   * ►► THE RULES WROTE IT, AND THE OPERATOR HAS TO BE TOLD WHY. ◄◄
   *
   * This used to read as a cheerful "✨ Three options from the built-in rules",
   * which is how somebody ends up looking at template copy and concluding the
   * feature is rubbish. The writer knows exactly why it did not answer — no key,
   * a refused key, an allowance used up, every model retired — and that reason
   * is the one thing that turns "this is terrible" into something fixable.
   */
  const why = out.writerWhy
    ? ` The AI writer did not answer: ${out.writerWhy}.`
    : ' No AI writer is set up yet.';
  return `📝 These came from the built-in rules, not from the AI${ear ? `, using ${ear}` : ''}.${who}${why}`
    + ' Settings → ✨ Social captions → Test it will say what is wrong.';
}

/* ---------------- 📦 bulk upload + 🗓 auto-schedule ----------------
 *
 * Many files in, one post each, spread over the days and hours people are
 * actually watching. The spacing the operator picks sets the pace; the posting
 * windows set the exact hour, so "3 hours apart" never means 03:00.
 * See src/main/schedule-plan.js.
 */
/*
 * The batch, one editable card per file.
 *
 * A batch of ten shorts is ten different sermons, so one shared caption would be
 * wrong nine times out of ten. Each file carries its own title and caption in
 * state.bulkCopy, written from what that clip actually SAYS, and every field is
 * editable in place before anything is scheduled.
 */
function renderBulk() {
  const box = $('#bulkBox'), list = $('#bulkList'), count = $('#bulkCount');
  if (!box) return;
  const files = state.bulk || [];
  box.classList.toggle('hidden', !files.length);
  if (count) count.textContent = files.length + (files.length === 1 ? ' file' : ' files');
  if (!list) return;
  state.bulkCopy = state.bulkCopy || {};
  list.innerHTML = files.map((f, i) => {
    const name = f.split(/[\\/]/).pop();
    const kind = VIDEO_KIND_RX.test(f) ? '🎞' : '🖼';
    const when = (state.bulkPlan && state.bulkPlan[i]) ? `${state.bulkPlan[i].dayLabel} ${state.bulkPlan[i].timeLabel}` : '';
    const cp = state.bulkCopy[f] || {};
    /*
     * A caption the rules wrote is marked 📝 whatever it was written FROM, and
     * says why the AI did not write it. Before, "🎧 taken from what is said in
     * the clip" read like a success on copy that was a filled-in template.
     */
    const state1 = cp.busy ? '🎧 listening to this clip…'
      : cp.source === 'ai' ? (cp.wroteBy === 'cloud'
          ? `✨ written by ${cp.writerName || 'the cloud writer'} from what is said in the clip`
          : '✨ written by the model on this PC, from what is said in the clip')
      : cp.source === 'heard' ? `📝 the rules wrote this${cp.writerWhy ? ' — the AI did not answer: ' + cp.writerWhy : ''}`
      : cp.source === 'rules' ? `📝 the rules wrote this, from the file name (no speech found)${cp.writerWhy ? ' — ' + cp.writerWhy : ''}`
      : 'not written yet';
    return `<div class="bulk-item" data-i="${i}">
      <div class="bi-top">
        <span class="bi-kind">${kind}</span>
        <span class="bi-name" title="${esc(f)}">${esc(name)}</span>
        <span class="bi-when">${esc(when)}</span>
        <button type="button" class="ghost-btn bi-write" data-write="${i}" title="Listen to this clip and write its title and caption">${cp.busy ? '…' : '✨'}</button>
        <button type="button" class="icon-btn bi-drop" data-drop="${i}" title="Take this file out of the batch">✕</button>
      </div>
      <input class="bi-title" data-title="${i}" placeholder="Title for this one…" value="${esc(cp.title || '')}" />
      <textarea class="bi-cap" data-cap="${i}" rows="3" placeholder="Caption for this one…">${esc(cp.caption || '')}</textarea>
      <div class="bi-state ${cp.source === 'ai' ? 'heard' : 'warn'}">${esc(state1)}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-title]').forEach((el) => el.addEventListener('input', () => {
    const f = (state.bulk || [])[Number(el.dataset.title)];
    if (f) { state.bulkCopy[f] = state.bulkCopy[f] || {}; state.bulkCopy[f].title = el.value; }
  }));
  list.querySelectorAll('[data-cap]').forEach((el) => el.addEventListener('input', () => {
    const f = (state.bulk || [])[Number(el.dataset.cap)];
    if (f) { state.bulkCopy[f] = state.bulkCopy[f] || {}; state.bulkCopy[f].caption = el.value; }
  }));
  list.querySelectorAll('[data-write]').forEach((el) => el.addEventListener('click', () => {
    const f = (state.bulk || [])[Number(el.dataset.write)];
    if (f) writeCopyFor(f);
  }));
  list.querySelectorAll('[data-drop]').forEach((el) => el.addEventListener('click', () => {
    const i = Number(el.dataset.drop);
    const f = (state.bulk || [])[i];
    state.bulk = (state.bulk || []).filter((_, k) => k !== i);
    if (f && state.bulkCopy) delete state.bulkCopy[f];
    previewBulkPlan();
  }));
}

/** Listen to ONE clip and write its own title + caption. */
/** `quick` skips the second editing pass — see writeCopyForAll. */
async function writeCopyFor(file, quick) {
  state.bulkCopy = state.bulkCopy || {};
  state.bulkCopy[file] = Object.assign({}, state.bulkCopy[file], { busy: true });
  renderBulk();
  try {
    const kind = VIDEO_KIND_RX.test(file) ? 'video' : 'image';
    const out = await api.social.suggestCopy({ mediaPath: file, kind, quick: !!quick });
    state.bulkCopy[file] = {
      title: (out && out.title) || '', caption: (out && out.caption) || '',
      source: out && out.source, heard: !!(out && out.heard), busy: false,
      wroteBy: out && out.wroteBy, heardBy: out && out.heardBy, writerName: out && out.writerName,
      writerWhy: out && out.writerWhy,
    };
  } catch (e) {
    state.bulkCopy[file] = Object.assign({}, state.bulkCopy[file], { busy: false });
    toast('⚠️ Could not write that one: ' + (e.message || e), 'error');
  }
  renderBulk();
}

/* ==================== WRITING A WHOLE BATCH ==============================
 *
 * ►► WHY THIS WAS SLOW, AND IT WAS NOT THE MODEL. ◄◄
 *
 * Eight clips were written ONE AT A TIME, and each one is a round trip to a
 * machine somewhere else: listen to the clip, write three options, edit them.
 * Nearly all of that time is spent WAITING — this PC has nothing to do during
 * it — so doing them one after another made the batch take as long as the sum
 * of eight waits when it could take as long as the longest two.
 *
 * FOUR AT A TIME, not all of them: the free tier has a requests-per-minute
 * ceiling, and firing twenty at once is how a batch turns into a rate limit and
 * then into template copy for everything after it. Four keeps every clip inside
 * the allowance and still cuts a batch of eight to about a quarter of the time.
 */
const BULK_LANES = 4;
async function writeCopyForAll() {
  const files = (state.bulk || []).slice();
  if (!files.length) return toast('Pick some files first with 📦 Bulk upload.', 'error');
  const btn = $('#bulkWriteAll');
  const was = btn ? btn.textContent : '';
  if (btn) btn.disabled = true;
  const t0 = Date.now();
  let done = 0;
  const next = async () => {
    for (;;) {
      const f = files.shift();
      if (!f) return;
      await writeCopyFor(f, true);
      done++;
      if (btn) btn.textContent = `✨ Writing… ${done} done`;
    }
  };
  const total = files.length;
  await Promise.all(Array.from({ length: Math.min(BULK_LANES, total) }, next));
  if (btn) { btn.textContent = was; btn.disabled = false; }

  const wrote = (state.bulk || []).map((f) => state.bulkCopy[f] || {});
  const heard = wrote.filter((c) => c.heard).length;
  const byAi = wrote.filter((c) => c.source === 'ai').length;
  const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
  /*
   * ►► AND IF THE WRITER DID NOT WRITE THEM, SAY SO. ◄◄
   *
   * The rules always produce something postable, which is what makes them a
   * good floor and a terrible thing to fall back to in silence: the operator
   * gets eight captions that look finished and read like a template, with
   * nothing on screen to say the model was never asked. That is exactly what
   * happened when the writer's whole model list had been retired underneath it.
   */
  if (byAi === 0) {
    const why = (wrote.find((c) => c.writerWhy) || {}).writerWhy || '';
    toast(`⚠️ Written by the built-in rules, not by the AI writer${why ? ' — ' + why : ''}. `
      + 'Settings → ✨ Social captions → Test it will say what is wrong.', 'error', 12000);
  } else if (byAi < total) {
    toast(`✨ Written ${total} captions in ${secs}s — ${byAi} of them by the AI writer and `
      + `${total - byAi} by the built-in rules. Check the ones marked 📝 before posting.`, '', 10000);
  } else {
    toast(`✨ Written ${total} captions in ${secs}s, all by ${wrote[0].writerName || 'the AI writer'}`
      + `${heard === total ? ', every one from what is actually said in the clip' : ''}. Edit any of them above.`,
      'good', 9000);
  }
}

/** Show what auto-schedule WOULD do, before it does it. */
async function previewBulkPlan() {
  const files = state.bulk || [];
  const note = $('#bulkPlanNote');
  if (!files.length) { state.bulkPlan = null; renderBulk(); return; }
  try {
    const spacing = Number(($('#bulkSpacing') || {}).value || 6);
    state.bulkPlan = await api.social.planSchedule({ count: files.length, spacingHours: spacing });
    if (note && state.bulkPlan.length) {
      const a = state.bulkPlan[0], b = state.bulkPlan[state.bulkPlan.length - 1];
      note.textContent = `${files.length} post${files.length > 1 ? 's' : ''}, about ${spacing}h apart — `
        + `${a.dayLabel} ${a.timeLabel} through ${b.dayLabel} ${b.timeLabel}. Daytime and evening only, plus Sunday morning.`;
    }
  } catch (e) { state.bulkPlan = null; }
  renderBulk();
}

async function autoScheduleBulk() {
  const files = (state.bulk || []).slice();
  if (!files.length) return toast('Pick some files first with 📦 Bulk upload.', 'error');
  const accountIds = $$('#postToAccounts input:checked').map((c) => c.value);
  const platforms = $$('#view-scheduler .platform-pick input:checked').map((c) => c.value);
  if (!accountIds.length && !platforms.length) {
    return toast('Tick the accounts to post to first — every file in the batch goes to the same ones.', 'error');
  }
  await previewBulkPlan();
  const plan = state.bulkPlan || [];
  if (plan.length !== files.length) return toast('Could not work out the times — try again.', 'error');
  const spacing = Number(($('#bulkSpacing') || {}).value || 6);
  const first = plan[0], last = plan[plan.length - 1];
  // Scheduling a batch is a real commitment — say exactly what will happen.
  const okGo = window.confirm(
    `Schedule ${files.length} post${files.length > 1 ? 's' : ''}, about ${spacing} hours apart?\n\n`
    + `First:  ${first.dayLabel} at ${first.timeLabel}\n`
    + `Last:   ${last.dayLabel} at ${last.timeLabel}\n\n`
    + `They publish by themselves at those times.`);
  if (!okGo) return;
  let made = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // Whatever is in that file's card — written, then edited by hand if the
    // operator wanted to. Anything still blank gets written now.
    let cp = (state.bulkCopy || {})[f];
    if (!cp || !cp.title) { await writeCopyFor(f); cp = (state.bulkCopy || {})[f]; }
    let title = (cp && cp.title) || f.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    let caption = (cp && cp.caption) || '';
    try {
      await api.scheduler.add({
        title, caption, platforms, accountIds,
        mediaPaths: [f], scheduledAt: plan[i].iso,
      });
      made++;
    } catch (e) { /* keep going — one bad file must not lose the batch */ }
  }
  state.bulk = []; state.bulkPlan = null; renderBulk();
  toast(`🗓 Scheduled ${made} post${made > 1 ? 's' : ''} — each with its own title and caption. They publish by themselves.`, 'good', 8000);
  refreshPosts();
}

const wfm = $('#sWriteForMe'); if (wfm) wfm.addEventListener('click', writeCopyForMe);
const pb = $('#pickPostBatch');
if (pb) pb.addEventListener('click', async () => {
  try {
    const files = await api.dialog.openFile(
      [{ name: 'Videos & pictures', extensions: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'png', 'jpg', 'jpeg', 'webp'] }], true);
    const list = Array.isArray(files) ? files : (files ? [files] : []);
    if (!list.length) return;
    state.bulk = list;
    await previewBulkPlan();
    toast(`📦 ${list.length} file${list.length > 1 ? 's' : ''} ready — tick the accounts, then 🗓 Auto-schedule them all.`, 'good', 7000);
  } catch (e) { toast('⚠️ ' + (e.message || e), 'error'); }
});
const bs = $('#bulkSpacing'); if (bs) bs.addEventListener('change', previewBulkPlan);
const bc = $('#bulkClear'); if (bc) bc.addEventListener('click', () => { state.bulk = []; state.bulkPlan = null; state.bulkCopy = {}; renderBulk(); });
const bwa = $('#bulkWriteAll'); if (bwa) bwa.addEventListener('click', writeCopyForAll);
const bsch = $('#bulkSchedule'); if (bsch) bsch.addEventListener('click', autoScheduleBulk);
$('#refreshPosts').addEventListener('click', refreshPosts);

function fbConnected() {
  const acc = (state.settings && state.settings.accounts) || {};
  return !!((acc.fbPageId || '').trim() && (acc.fbToken || '').trim());
}

/** Can this post publish by itself? (targeted accounts, platform-matched accounts, or the legacy token) */
function postCanAuto(p) {
  if ((p.accountIds || []).some((id) => state.accounts.find((a) => a.id === id))) return true;
  if ((p.accountIds || []).length) return false; // targets all since unlinked
  const plats = p.platforms || [];
  if (state.accounts.some((a) => plats.includes(a.platform))) return true;
  return fbConnected() && plats.includes('facebook');
}

function updateSchedBanner() {
  const el = $('#schedAutoBanner');
  if (!el) return;
  const n = state.accounts.length;
  /*
   * The sentence people need is not "it posts by itself" but how far it
   * survives: app shut, or PC off. Count what is actually true right now
   * across the posts on the page rather than claiming the best case.
   */
  const plans = Object.values(state.plans || {});
  const anyBooked = plans.some((pl) => pl.bookable.some((b) => b.booked));
  const allSafe = plans.length > 0 && plans.every((pl) => pl.safeWithPcOff);
  const closed = allSafe
    ? ' Every one of them is <b>booked with the platform itself</b> — they go out even with this <b>PC switched off</b>.'
    : anyBooked
      ? ' The ones marked 🔒 are <b>booked with the platform</b> and go out with this <b>PC off</b>; the rest need this PC on.'
      : (state.autopost && state.autopost.enabled
        ? ' They go out <b>even with this app closed</b>, as long as this PC is on.'
        : ' <b>Leave this app open</b> for them to go out — or switch on “Post when the app is closed” below.');
  if (n || fbConnected()) {
    el.classList.remove('off'); el.classList.add('on');
    el.innerHTML = (n
      ? `⚡ <b>Auto-posting is ON</b> — ${n} linked account${n === 1 ? '' : 's'}. Scheduled posts publish by themselves at their time.`
      : '⚡ <b>Auto-posting is ON</b> — scheduled Facebook posts publish by themselves at their time.') + closed;
  } else {
    el.classList.add('off'); el.classList.remove('on');
    el.innerHTML = '⚡ <b>Connect an account</b> below and scheduled posts publish <b>by themselves</b> — photos, videos, Reels, and text.';
  }
}

/** Per-account chips on a post card: ⚡ pending / ✓ posted (click = open) / ✖ failed. */
function acctResultBadges(p) {
  const results = p.results || {};
  const ids = Array.from(new Set([...(p.accountIds || []), ...Object.keys(results)]));
  return ids.map((id) => {
    const acc = state.accounts.find((a) => a.id === id);
    const r = results[id];
    const name = (acc && acc.name) || (r && r.name) || (id === 'legacy_fb' ? 'Facebook Page' : 'removed account');
    const icon = PLAT_ICON[(acc && acc.platform) || (r && r.platform)] || '';
    if (r && r.ok) return `<span class="badge posted acct-result" data-open="${esc(r.url || '')}" title="Posted — click to view">✓ ${icon} ${esc(name)}</span>`;
    if (r && !r.ok) return `<span class="badge failed" title="${esc(r.error || '')}">✖ ${icon} ${esc(name)}</span>`;
    if (!acc && (p.accountIds || []).includes(id)) return `<span class="badge failed" title="This account was disconnected">? ${esc(name)}</span>`;
    return `<span class="badge auto">⚡ ${icon} ${esc(name)}</span>`;
  }).join('');
}

/*
 * WHO IS ACTUALLY GOING TO POST THIS.
 *
 * Three different things can publish a scheduled post, and they survive very
 * different amounts of neglect:
 *   the platform itself   — booked in advance; the PC can be OFF.
 *   the background poster — needs the PC on, but not the app (autopost.js).
 *   this window           — needs both.
 * The operator has to be able to see which, per post, or the schedule is a
 * promise nobody can check until the morning it fails.
 */
function handoffLine(plan) {
  if (!plan) return '';
  const held = plan.bookable.filter((b) => b.booked);
  const waiting = plan.bookable.filter((b) => !b.booked);
  const bits = [];
  if (held.length) {
    bits.push('<span class="ho-safe">🔒 ' + esc(held.map((h) => h.name).join(', ')) +
      (held.length > 1 ? ' have this booked' : ' has this booked') +
      ' — it goes out with this PC switched off.</span>');
  }
  if (waiting.length) {
    bits.push('<span class="ho-wait">⏳ Booking with ' + esc(waiting.map((h) => h.name).join(', ')) + '…</span>');
  }
  for (const l of plan.local) {
    // Instagram and TikTok are only stuck because of HOW they were connected.
    // The app already has the route that fixes it, so offer it right here
    // rather than describing it and leaving the operator to find it.
    const fixable = (l.platform === 'instagram' || l.platform === 'tiktok')
      ? ` <button class="link-btn" data-easyfix="${l.platform}">Fix this →</button>` : '';
    bits.push('<span class="ho-local">⚠️ ' + esc(l.name) + ' needs this PC switched on. ' + esc(l.why) + fixable + '</span>');
  }
  return bits.length ? '<div class="post-handoff">' + bits.join('') + '</div>' : '';
}

async function refreshPosts() {
  updateSchedBanner();
  const posts = await api.scheduler.list();
  let plans = {};
  try { plans = await api.scheduler.plans(); } catch (e) { plans = {}; }
  state.plans = plans;
  const list = $('#postList');
  if (!posts.length) { list.innerHTML = '<p class="muted">No posts yet — schedule your first one!</p>'; return; }
  const now = Date.now();
  list.innerHTML = posts.map((p) => {
    const when = new Date(p.scheduledAt);
    const due = p.status === 'scheduled' && when.getTime() <= now;
    const canAuto = postCanAuto(p);
    const badge =
      p.status === 'posted' ? (p.autoPosted ? '<span class="badge posted">⚡ Auto-posted</span>' : '<span class="badge posted">Posted</span>')
      : p.status === 'posting' ? '<span class="badge due">⏳ Posting…</span>'
      : p.status === 'failed' ? '<span class="badge failed">✖ Failed</span>'
      : due ? '<span class="badge due">DUE NOW</span>'
      : (canAuto ? '<span class="badge auto">⚡ Auto</span>' : '<span class="badge">Scheduled</span>');
    const err = p.error && p.status !== 'posted' ? `<div class="post-error">⚠️ ${esc(p.error)}</div>` : '';
    const actions =
      p.status === 'posting' ? ''
      : p.status === 'failed' ? `<button class="primary-btn small" data-retry="${p.id}">↻ Retry</button>`
      : p.status === 'posted' ? ''
      : canAuto ? `<button class="primary-btn small" data-auto="${p.id}">⚡ Post now</button>`
      : `<button class="primary-btn small" data-pub="${p.id}">▶ Publish</button>`;
    return `<div class="post" data-id="${p.id}">
      <div class="post-main">
        <div class="post-title">${esc(p.title)}</div>
        <div class="post-when">${when.toLocaleString()}</div>
        <div class="post-caption">${esc(p.caption || '')}</div>
        <div class="post-badges">${badge}${acctResultBadges(p)}${(p.platforms || []).map((pl) => `<span class="badge">${pl}</span>`).join('')}</div>
        ${handoffLine(plans[p.id])}
        ${err}
      </div>
      <div class="post-actions">
        ${actions}
        <button class="ghost-btn small" data-del="${p.id}">🗑</button>
      </div></div>`;
  }).join('');
  $$('#postList .acct-result[data-open]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.open) api.shell.openExternal(b.dataset.open);
  }));
  $$('#postList [data-pub]').forEach((b) => b.addEventListener('click', () => publishPost(b.dataset.pub)));
  $$('#postList [data-auto]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '⏳ Posting…';
    try {
      await api.scheduler.publishAuto(b.dataset.auto);
      toast('⚡ Posted! Click the green account badges to view.', 'good');
    } catch (e) { toast('⚠️ ' + e.message, 'error'); }
    refreshPosts();
  }));
  $$('#postList [data-retry]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api.scheduler.retry(b.dataset.retry); toast('↻ Retrying…', 'good'); }
    catch (e) { toast('⚠️ ' + e.message, 'error'); }
    setTimeout(refreshPosts, 800);
  }));
  // Meta/TikTok cannot book a post at all, so the fix is a different route in.
  // Offer both free ones rather than picking for them — a full free tier on one
  // is exactly the case the other exists for.
  $$('#postList [data-easyfix]').forEach((b) => b.addEventListener('click',
    () => showEasyFix(b.dataset.easyfix)));
  $$('#postList [data-del]').forEach((b) => b.addEventListener('click', async () => {
    // A booked post that could not be called off WILL still go out. That is
    // the one thing here the operator must not find out about on Sunday.
    const res = await api.scheduler.remove(b.dataset.del);
    if (res && res.warning) {
      toast('⚠️ Deleted here, but ' + res.warning + '. Open that account and delete the scheduled post there too.', 'error', 15000);
    }
    refreshPosts();
  }));
}

async function publishPost(id) {
  try {
    const res = await api.scheduler.publish(id);
    toast(`▶ Opened ${res.opened.join(', ')}. Caption copied to clipboard — paste & attach the media (revealed in Explorer).`, 'good');
    refreshPosts();
  } catch (e) { toast('⚠️ ' + e.message, 'error'); }
}

// Fired whenever the main-process scheduler changes a post (due, posting, posted, failed).
api.onSchedulerDue(async (id) => {
  refreshPosts();
  refreshDashboard();
  try {
    const p = (await api.scheduler.list()).find((x) => x.id === id);
    if (p && p.status === 'posted' && p.autoPosted) toast('⚡ Auto-posted: ' + p.title, 'good');
    else if (p && p.status === 'failed') toast('⚠️ Post failed: ' + p.title + ' — open the Scheduler to retry.', 'error');
    else if (p && p.status === 'scheduled' && p.notified) toast('⏰ Time to post: ' + p.title, 'good');
  } catch (e) {}
});

/* ===================== DASHBOARD ===================== */
let _dashLiveTimer = null;
function refreshDashLive() {
  if (!window.LiveStudio || !window.LiveStudio.getStatus) return;
  const s = window.LiveStudio.getStatus();
  const badge = $('#dashLiveBadge');
  const desc = $('#dashLiveDesc');
  badge.classList.toggle('hidden', !s.live);
  if (s.streaming && s.recording) { badge.textContent = 'LIVE + REC'; }
  else if (s.streaming) { badge.textContent = s.streamCount > 1 ? `LIVE ×${s.streamCount}` : 'LIVE'; }
  else if (s.recording) { badge.textContent = 'REC'; }
  desc.textContent = s.live
    ? `Currently ${s.streaming ? 'streaming' : 'recording'}${s.programName ? ' — ' + s.programName + ' on program' : ''}.`
    : 'Switch cameras, run titles, and stream or record your service.';
}
async function refreshDashboard() {
  refreshDashLive();
  clearInterval(_dashLiveTimer);
  _dashLiveTimer = setInterval(refreshDashLive, 2000);
  const posts = (await api.scheduler.list()).filter((p) => p.status === 'scheduled').slice(0, 5);
  const el = $('#dashUpcoming');
  if (!posts.length) { el.innerHTML = '<p class="muted">No upcoming posts. Head to the Scheduler to plan one!</p>'; return; }
  el.innerHTML = posts.map((p) => `<div class="post"><div class="post-main">
    <div class="post-title">${esc(p.title)}</div>
    <div class="post-when">${new Date(p.scheduledAt).toLocaleString()}</div>
    <div class="post-badges">${acctResultBadges(p)}${(p.platforms || []).map((pl) => `<span class="badge">${pl}</span>`).join('')}</div>
  </div></div>`).join('');
}

/* ===================== SETTINGS ===================== */
$('#saveSettings').addEventListener('click', async () => {
  const patch = {
    brand: {
      churchName: $('#setChurchName').value || 'Our Church',
      primaryColor: $('#setPrimary').value,
      accentColor: $('#setAccent').value,
    },
    // What the caption writer needs to know about this church's services.
    social: {
      eventName: $('#setEventName').value.trim(),
      speakers: $('#setSpeakers').value.trim(),
      allowBait: !!$('#setAllowBait').checked,
    },
    accounts: {
      instagram: $('#setIg').value, tiktok: $('#setTt').value, facebook: $('#setFb').value,
      fbPageId: $('#setFbPageId').value.trim(), fbToken: $('#setFbToken').value.trim(),
      fbAppId: $('#setFbAppId').value.trim(), fbAppSecret: $('#setFbAppSecret').value.trim(),
      ytClientId: $('#setYtClientId').value.trim(), ytClientSecret: $('#setYtClientSecret').value.trim(),
      zoApiKey: $('#setZoApiKey').value.trim(),
      // TikTok own-app + Upload-Post backup + FB/IG Zernio settings panels were
      // removed from the UI (TikTok/YouTube = Zernio easy-connect; FB/IG = Meta).
      // Preserve any previously-stored values rather than reading absent fields.
      tkClientKey: ((state.settings || {}).accounts || {}).tkClientKey,
      tkClientSecret: ((state.settings || {}).accounts || {}).tkClientSecret,
      tkRedirectUri: ((state.settings || {}).accounts || {}).tkRedirectUri,
      tkTokenProxy: ((state.settings || {}).accounts || {}).tkTokenProxy,
      tkProxyToken: ((state.settings || {}).accounts || {}).tkProxyToken,
      upApiKey: ((state.settings || {}).accounts || {}).upApiKey,
      zoApiKeyFb: ((state.settings || {}).accounts || {}).zoApiKeyFb,
      // keep test overrides if set
      fbApiBase: ((state.settings || {}).accounts || {}).fbApiBase,
      fbOauthBase: ((state.settings || {}).accounts || {}).fbOauthBase,
      ytApiBase: ((state.settings || {}).accounts || {}).ytApiBase,
      ytAuthBase: ((state.settings || {}).accounts || {}).ytAuthBase,
      ytTokenBase: ((state.settings || {}).accounts || {}).ytTokenBase,
      tkApiBase: ((state.settings || {}).accounts || {}).tkApiBase,
      tkAuthBase: ((state.settings || {}).accounts || {}).tkAuthBase,
      upApiBase: ((state.settings || {}).accounts || {}).upApiBase,
      zoApiBase: ((state.settings || {}).accounts || {}).zoApiBase,
      zoRedirectUrl: ((state.settings || {}).accounts || {}).zoRedirectUrl,
    },
    // The Bible-key field is no longer on the Settings page. Keep whatever is
    // already stored instead of writing '' — saving settings must not silently
    // wipe a key the user entered in an older build.
    apiKeys: {
      anthropic: $('#setAnthropic').value,
      image: $('#setImage').value,
      bible: $('#setBibleKey') ? $('#setBibleKey').value : (((state.settings || {}).apiKeys || {}).bible || ''),
    },
  };
  state.settings = await api.settings.update(patch);
  $('#brandName').textContent = patch.brand.churchName;
  $('#brandName').title = patch.brand.churchName;
  toast('💾 Settings saved.', 'good');
});

$('#testFb').addEventListener('click', async () => {
  const out = $('#testFbResult');
  out.textContent = 'Testing…';
  try {
    const r = await api.scheduler.testFb($('#setFbPageId').value.trim(), $('#setFbToken').value.trim());
    out.textContent = `✅ Connected to "${r.name}" — auto-posting is ready.`;
  } catch (e) {
    out.textContent = '✖ ' + e.message;
  }
});

$('#changeOutput').addEventListener('click', async () => {
  const dir = await api.dialog.openDir();
  if (dir) {
    state.settings = await api.settings.update({ outputDir: dir });
    $('#setOutputDir').textContent = dir;
    toast('Output folder updated.', 'good');
  }
});

$('#openOutput').addEventListener('click', async () => {
  if (state.paths) api.shell.openPath(state.paths.outputDir);
});

/* ================= PHONE STUDIO (edit from a phone) =================
 *
 * The whole feature is two facts on screen: the address to type and the PIN.
 * Everything else — which of the machine's several network cards the phone can
 * actually see, whether the port is free — is the app's problem, not the
 * operator's, so the panel just shows the answer and gets out of the way.
 */
function renderPhone(st) {
  state.phone = st || state.phone || { running: false };
  const s = state.phone;
  const on = $('#phoneOn');
  if (on) on.checked = !!s.running;
  $('#phoneDetails').classList.toggle('hidden', !s.running);
  $('#phoneStatus').textContent = s.running
    ? (s.paired ? `On — ${s.paired} phone${s.paired > 1 ? 's' : ''} paired` : 'On — waiting for a phone')
    : 'Off';
  if (!s.running) return;
  const list = s.urls || [];
  $('#phoneUrl').textContent = list[0] || `http://localhost:${s.port}`;
  // A PC with wifi AND ethernet AND a VPN adapter answers on several addresses,
  // and only one of them is the one the phone can reach — so show them all
  // rather than picking wrong and looking broken.
  $('#phoneUrlsAlt').textContent = list.length > 1 ? 'Or: ' + list.slice(1).join('   ') : '';
  $('#phonePin').textContent = (s.pin || '').replace(/(\d{3})(\d{3})/, '$1 $2');
  $('#phonePort').value = s.port;
  $('#phoneUpload').checked = s.allowUpload !== false;
  $('#phonePaired').textContent = s.paired
    ? `${s.paired} phone${s.paired > 1 ? 's' : ''} paired. A new PIN unpairs them all.`
    : 'No phone paired yet.';
}

async function togglePhone(want) {
  try {
    const st = want
      ? await api.phone.start({ port: Number($('#phonePort').value) || 7380, allowUpload: $('#phoneUpload').checked })
      : await api.phone.stop();
    renderPhone(st);
    if (want) toast('📱 Phone Studio is on — open that address on your phone.', 'good', 7000);
  } catch (e) {
    $('#phoneOn').checked = false;
    toast('⚠️ ' + e.message, 'error', 7000);
  }
}

if ($('#phoneOn')) {
  $('#phoneOn').addEventListener('change', (e) => togglePhone(e.target.checked));
  $('#phoneNewPin').addEventListener('click', async () => {
    try { renderPhone(await api.phone.newPin()); toast('New PIN — every paired phone has to pair again.', 'good'); }
    catch (er) { toast('⚠️ ' + er.message, 'error'); }
  });
  // Changing the port or the upload switch only means anything once it's applied,
  // so restart the server rather than silently storing a setting that isn't live.
  const restart = () => { if (state.phone && state.phone.running) togglePhone(true); };
  $('#phonePort').addEventListener('change', restart);
  $('#phoneUpload').addEventListener('change', restart);
}
if ($('#vePhone')) {
  $('#vePhone').addEventListener('click', () => {
    document.querySelector('.nav-item[data-view="settings"]').click();
    const panel = $('#phonePanel');
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      panel.classList.add('flash');
      setTimeout(() => panel.classList.remove('flash'), 1400);
    }
  });
}

/* ===================== CLOUD STUDIO =====================
 *
 * Phone Studio's panel answers "what do I type on the phone". This one answers
 * the same question with one more line in it, because there are two addresses
 * that can be true at once: the one on this wifi, and the one from anywhere.
 *
 * The public address takes a few seconds to come back from Cloudflare and can
 * change while the panel is open, so it ARRIVES (api.cloud.onUrl) rather than
 * being asked for — a panel that polled would show a dash for the first five
 * seconds of every switch-on, which reads as broken.
 */
function renderCloud(st) {
  state.cloud = st || state.cloud || { running: false };
  const s = state.cloud;
  const on = $('#cloudOn');
  if (on) on.checked = !!s.running;
  $('#cloudDetails').classList.toggle('hidden', !s.running);
  const t = s.tunnel || {};
  $('#cloudStatus').textContent = !s.running ? 'Off'
    : (s.publicUrl ? 'On — reachable from anywhere' : 'On — on this network');
  if (!s.running) return;

  const local = (s.localUrls || [])[0] || `http://localhost:${s.port}`;
  // The public address is the one that makes this feature what it is, so it is
  // the one shown big. The local one stays underneath: it is faster on the
  // church wifi, and it is what still works when the internet does not.
  $('#cloudUrl').textContent = s.publicUrl || local;
  $('#cloudUrlAlt').textContent = s.publicUrl
    ? 'On this wifi you can also use ' + local
    : 'This works on the church wifi. For anywhere else, switch on a public address below.';
  $('#cloudCode').textContent = s.code || '————';
  $('#cloudPort').value = s.port;
  $('#cloudUpload').checked = s.allowUpload !== false;
  $('#cloudSignedIn').textContent = s.signedInDevices
    ? `${s.signedInDevices} device${s.signedInDevices > 1 ? 's' : ''} signed in. A new code signs them all out.`
    : 'No device signed in yet.';

  $('#cloudTunnelOn').checked = !!(t.running || t.wanted);
  $('#cloudTunnelStatus').textContent = t.running
    ? (s.publicUrl ? 'Public address is live' : 'Connected')
    : (t.wanted ? (t.error ? 'Could not connect: ' + t.error.slice(0, 80) : 'Starting…')
      : (t.available ? '' : 'Helper not downloaded yet'));
  if ($('#cloudTunnelToken') && document.activeElement !== $('#cloudTunnelToken')) {
    $('#cloudTunnelToken').value = t.hasToken ? '••••••••••••' : '';
  }
}

async function toggleCloud(want) {
  try {
    const st = want
      ? await api.cloud.start(Number($('#cloudPort').value) || 7390, $('#cloudUpload').checked)
      : await api.cloud.stop();
    renderCloud(want ? await api.cloud.state() : st);
    if (want) toast('☁️ Cloud Studio is on — open that address on your phone.', 'good', 7000);
  } catch (e) {
    $('#cloudOn').checked = false;
    toast('⚠️ ' + e.message, 'error', 7000);
  }
}

async function toggleTunnel(want) {
  if (!want) {
    try { renderCloud(await api.cloud.tunnelStop()); } catch (e) { toast('⚠️ ' + e.message, 'error'); }
    return;
  }
  try {
    const status = await api.cloud.state();
    // The helper is 50 MB. Downloading it without asking, on a church's
    // connection, on a Sunday, is not a decision this panel gets to make.
    if (!status.tunnel.available) {
      const ok = window.confirm('A public address needs a free helper from Cloudflare (about 50 MB, downloaded once).\n\nDownload it now?');
      if (!ok) { $('#cloudTunnelOn').checked = false; return; }
      const jobId = newJobId();
      await window.__runJob('Getting the helper that makes a public address…', jobId, () => api.cloud.tunnelInstall(jobId), { cancellable: false });
    }
    $('#cloudTunnelStatus').textContent = 'Connecting…';
    await api.cloud.tunnelStart();
    renderCloud(await api.cloud.state());
    toast('☁️ Public address is live — that link now works from anywhere.', 'good', 8000);
  } catch (e) {
    $('#cloudTunnelOn').checked = false;
    renderCloud(await api.cloud.state().catch(() => null));
    toast('⚠️ ' + e.message, 'error', 8000);
  }
}

if ($('#cloudOn')) {
  $('#cloudOn').addEventListener('change', (e) => toggleCloud(e.target.checked));
  $('#cloudNewCode').addEventListener('click', async () => {
    try { renderCloud(await api.cloud.newCode()); toast('New code — every signed-in device has to sign in again.', 'good'); }
    catch (er) { toast('⚠️ ' + er.message, 'error'); }
  });
  $('#cloudTunnelOn').addEventListener('change', (e) => toggleTunnel(e.target.checked));
  $('#cloudTunnelToken').addEventListener('change', async (e) => {
    const v = e.target.value.trim();
    if (v.startsWith('••')) return;                       // untouched
    try {
      await api.cloud.tunnelToken(v);
      toast(v ? 'Saved. Switch the public address off and on to use it.' : 'Token cleared — back to a free random address.', 'good');
    } catch (er) { toast('⚠️ ' + er.message, 'error'); }
  });
  // A port or upload change only means something once it is applied, so restart
  // rather than store a setting that is not live.
  const restart = () => { if (state.cloud && state.cloud.running) toggleCloud(true); };
  $('#cloudPort').addEventListener('change', restart);
  $('#cloudUpload').addEventListener('change', restart);
  // The address can arrive, change, or go away without anybody clicking.
  if (api.cloud.onUrl) api.cloud.onUrl(async () => { try { renderCloud(await api.cloud.state()); } catch (e) {} });
}
if ($('#veCloud')) {
  $('#veCloud').addEventListener('click', () => {
    document.querySelector('.nav-item[data-view="settings"]').click();
    const panel = $('#cloudPanel');
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      panel.classList.add('flash');
      setTimeout(() => panel.classList.remove('flash'), 1400);
    }
  });
}

/* ===================== INIT ===================== */
async function init() {
  state.settings = await api.settings.get();
  state.paths = await api.paths.get();
  state.presets = await api.video.presets();

  // Show the version the app ACTUALLY is. It used to be typed into the HTML by
  // hand, which meant it stopped being true the first time anyone forgot —
  // and a build that reports the old version is indistinguishable from a build
  // that never installed.
  const verEl = document.querySelector('.sidebar-foot .version');
  if (verEl && state.paths && state.paths.appVersion) verEl.textContent = 'v' + state.paths.appVersion;

  // Brand
  const b = state.settings.brand || {};
  $('#brandName').textContent = b.churchName || 'Church Work Space';
  $('#brandName').title = b.churchName || 'Church Work Space';
  $('#setChurchName').value = b.churchName || '';
  $('#setPrimary').value = b.primaryColor || '#1f6feb';
  $('#setAccent').value = b.accentColor || '#f5a623';
  $('#setOutputDir').textContent = state.paths.outputDir;
  const soc = state.settings.social || {};
  $('#setEventName').value = soc.eventName || '';
  $('#setSpeakers').value = soc.speakers || '';
  $('#setAllowBait').checked = !!soc.allowBait;
  refreshWriter();
  const acc = state.settings.accounts || {};
  $('#setIg').value = acc.instagram || '';
  $('#setTt').value = acc.tiktok || '';
  $('#setFb').value = acc.facebook || '';
  $('#setFbPageId').value = acc.fbPageId || '';
  $('#setFbToken').value = acc.fbToken || '';
  $('#setFbAppId').value = acc.fbAppId || '';
  $('#setFbAppSecret').value = acc.fbAppSecret || '';
  $('#setYtClientId').value = acc.ytClientId || '';
  $('#setYtClientSecret').value = acc.ytClientSecret || '';
  if ($('#setZoApiKey')) $('#setZoApiKey').value = acc.zoApiKey || '';
  const keys = state.settings.apiKeys || {};
  $('#setAnthropic').value = keys.anthropic || '';
  $('#setImage').value = keys.image || '';
  if ($('#setBibleKey')) $('#setBibleKey').value = keys.bible || '';

  // Phone Studio may already be running (it starts with the app when it was
  // left switched on), so the panel reflects reality rather than a default.
  try { renderPhone(await api.phone.state()); } catch (e) {}
  // …and the Cloud Studio, which also starts with the app when left on.
  try { renderCloud(await api.cloud.state()); } catch (e) {}

  // Default scheduler date/time = tomorrow 10:00
  const t = new Date(Date.now() + 86400000);
  $('#sDate').value = t.toISOString().slice(0, 10);
  $('#sTime').value = '10:00';

  if (window.Editor) window.Editor.init(state.settings);
  if (window.VideoEditor) window.VideoEditor.init(state.settings, state.presets);
  if (window.LiveStudio) window.LiveStudio.init(state.settings);
  if (window.Presenter) window.Presenter.init(state.settings);
  refreshAccounts().then(refreshDashboard);
  window.addEventListener('resize', () => { if ($('#view-flyer').classList.contains('active') && window.Editor) window.Editor.fit(); });
}

init().catch((e) => toast('Init error: ' + e.message, 'error'));
