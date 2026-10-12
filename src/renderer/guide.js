'use strict';
/*
 * THE GUIDE — "show me around", one thing at a time.
 *
 * The screens carry no explanations any more: a button says what it is in a
 * word or two, and that is all. Anyone who wants to know where things are taps
 * the ? (or "Show me around") and the guide walks them through the screen:
 * the rest of the page dims, the one thing that matters glows, and a bubble
 * says what it is in a few plain words. Next, Back, Done.
 *
 * The same file runs in the desktop window and in the Cloud Studio (phone or
 * laptop browser), so a tour is written once:
 *
 *   MWGuide.register('home', {
 *     title: 'Home', emoji: '🏠',
 *     steps: [
 *       { target: '#chStudio', emoji: '🎬', title: 'Make a video', body: 'Tap here to edit a video.' },
 *       …
 *     ],
 *   });
 *   MWGuide.start('home');          // run it
 *   MWGuide.helpButton('home')      // a round ? button that runs it
 *   MWGuide.invite('home', parent)  // a small "👋 New here? Show me around" card, once
 *   MWGuide.openHelp()              // every tour, as big tiles
 *
 * It never starts by itself: a tour that pops up uninvited is one more thing
 * going on. The invite card sits in the page like any other card (nothing is
 * covered) and goes away for good once used or closed.
 *
 * Steps whose target is missing or hidden are skipped, so a tour written for
 * the phone still makes sense on a laptop and the other way round. A step with
 * no target (or `target: null`) is a bubble in the middle of the screen.
 */
(function () {
  if (window.MWGuide) return;
  const KEY = 'mw.guide.v1';
  const tours = new Map();          // id -> { title, emoji, steps, before, order }
  let order = 0;
  let run = null;                   // the tour on screen: { id, steps, i, els, onEnd }

  /* ------------------------------------------------------------ memory */

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function save(m) { try { localStorage.setItem(KEY, JSON.stringify(m)); } catch (e) {} }
  const seen = (id) => !!(load().seen || {})[id];
  function markSeen(id) { const m = load(); m.seen = Object.assign({}, m.seen, { [id]: Date.now() }); save(m); }
  const invited = (id) => !!(load().noInvite || {})[id];
  function markInvited(id) { const m = load(); m.noInvite = Object.assign({}, m.noInvite, { [id]: 1 }); save(m); }

  /* ------------------------------------------------------------- style */

  const STYLE = `
.mwg-dim{position:fixed;inset:0;z-index:2147483000;background:transparent;touch-action:none}
.mwg-hole{position:fixed;z-index:2147483001;border-radius:16px;pointer-events:none;
  box-shadow:0 0 0 9999px rgba(8,6,20,.72),0 0 0 3px #a78bfa,0 0 26px 6px rgba(167,139,250,.55);
  transition:left .28s ease,top .28s ease,width .28s ease,height .28s ease,border-radius .28s ease}
.mwg-hole.mwg-none{box-shadow:0 0 0 9999px rgba(8,6,20,.72);width:0!important;height:0!important}
.mwg-hole::after{content:"";position:absolute;inset:-3px;border-radius:inherit;border:3px solid #c4b5fd;animation:mwgPulse 1.6s ease-out infinite}
.mwg-hole.mwg-none::after{display:none}
@keyframes mwgPulse{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(1.18)}}
.mwg-bub{position:fixed;z-index:2147483002;width:min(360px,calc(100vw - 32px));box-sizing:border-box;
  background:linear-gradient(160deg,#ffffff 0%,#f5f3ff 100%);color:#1e1b4b;border-radius:22px;padding:18px 18px 14px;
  box-shadow:0 18px 50px rgba(0,0,0,.45),0 0 0 1px rgba(124,58,237,.18);
  font:500 16px/1.35 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  animation:mwgIn .26s cubic-bezier(.2,.9,.3,1.2)}
@keyframes mwgIn{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}
.mwg-bub .mwg-emo{font-size:34px;line-height:1;display:block;margin:0 0 8px}
.mwg-bub h3{margin:0 0 4px;font-size:21px;font-weight:800;letter-spacing:-.01em;color:#1e1b4b}
.mwg-bub p{margin:0;color:#4c4a6b;font-size:16px}
.mwg-row{display:flex;align-items:center;gap:8px;margin-top:16px}
.mwg-dots{display:flex;gap:6px;flex:1;flex-wrap:wrap}
.mwg-dots i{width:8px;height:8px;border-radius:50%;background:#ddd6fe}
.mwg-dots i.on{background:#7c3aed;width:20px;border-radius:6px}
.mwg-btn{appearance:none;border:0;border-radius:14px;padding:12px 18px;min-height:46px;font-weight:700;font-size:16px;line-height:1;font-family:inherit;cursor:pointer}
.mwg-next{background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;box-shadow:0 6px 16px rgba(109,40,217,.35)}
.mwg-back{background:#ede9fe;color:#5b21b6}
.mwg-skip{position:absolute;top:10px;right:10px;width:36px;height:36px;border-radius:50%;border:0;background:transparent;color:#6b6890;font-size:22px;line-height:1;cursor:pointer}
.mwg-skip:hover,.mwg-back:hover{filter:brightness(.96)}
.mwg-btn:focus-visible,.mwg-skip:focus-visible,.mwg-tile:focus-visible,.mwg-ask:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}
.mwg-ask{appearance:none;border:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  width:40px;height:40px;border-radius:50%;background:rgba(167,139,250,.18);color:#ddd6fe;font:800 19px/1 Inter,-apple-system,"Segoe UI",sans-serif;
  box-shadow:inset 0 0 0 1.5px rgba(167,139,250,.45);flex:none}
.mwg-ask:hover{background:rgba(167,139,250,.3)}
.mwg-invite{display:flex;align-items:center;gap:12px;box-sizing:border-box;width:100%;margin:0 0 14px;padding:14px 14px 14px 16px;border-radius:20px;
  background:linear-gradient(135deg,rgba(250,204,21,.16),rgba(167,139,250,.18));box-shadow:inset 0 0 0 1.5px rgba(250,204,21,.35);color:inherit;
  font:600 16px/1.3 Inter,-apple-system,"Segoe UI",sans-serif}
.mwg-invite .mwg-wave{font-size:28px;line-height:1;animation:mwgWave 2.4s ease-in-out infinite;transform-origin:70% 70%}
@keyframes mwgWave{0%,60%,100%{transform:rotate(0)}10%,30%{transform:rotate(14deg)}20%,40%{transform:rotate(-8deg)}}
.mwg-invite b{flex:1;font-weight:700}
.mwg-invite .mwg-go{appearance:none;border:0;border-radius:14px;padding:11px 16px;min-height:44px;cursor:pointer;
  background:#facc15;color:#1e1b4b;font-weight:800;font-size:15px;line-height:1;font-family:inherit;white-space:nowrap}
.mwg-invite .mwg-x{appearance:none;border:0;background:transparent;color:inherit;opacity:.6;font-size:22px;width:36px;height:36px;cursor:pointer;flex:none}
.mwg-help{position:fixed;inset:0;z-index:2147482990;display:flex;align-items:flex-end;justify-content:center;background:rgba(8,6,20,.6);
  animation:mwgFade .2s ease}
@media (min-width:700px){.mwg-help{align-items:center}}
@keyframes mwgFade{from{opacity:0}to{opacity:1}}
.mwg-sheet{width:min(560px,100vw);max-height:88vh;overflow:auto;box-sizing:border-box;padding:22px 18px calc(22px + env(safe-area-inset-bottom));
  background:#14111f;color:#f4f2ff;border-radius:26px 26px 0 0;box-shadow:0 -10px 40px rgba(0,0,0,.4);
  font:500 16px/1.35 Inter,-apple-system,"Segoe UI",sans-serif;animation:mwgUp .28s cubic-bezier(.2,.9,.3,1.1)}
@media (min-width:700px){.mwg-sheet{border-radius:26px}}
@keyframes mwgUp{from{transform:translateY(30px);opacity:0}to{transform:none;opacity:1}}
.mwg-sheet h2{margin:0 0 4px;font-size:26px;font-weight:800;display:flex;align-items:center;gap:10px}
.mwg-sheet h2 .mwg-close{margin-left:auto;appearance:none;border:0;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.08);color:#fff;font-size:22px;cursor:pointer}
.mwg-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:16px}
.mwg-tile{appearance:none;border:0;cursor:pointer;text-align:left;border-radius:20px;padding:16px 14px;min-height:104px;
  display:flex;flex-direction:column;justify-content:space-between;gap:10px;color:#fff;font-weight:700;font-size:17px;line-height:1.2;font-family:inherit;
  background:linear-gradient(150deg,rgba(139,92,246,.35),rgba(91,33,182,.25));box-shadow:inset 0 0 0 1px rgba(196,181,253,.25)}
.mwg-tile:nth-child(4n+2){background:linear-gradient(150deg,rgba(236,72,153,.35),rgba(147,51,234,.22))}
.mwg-tile:nth-child(4n+3){background:linear-gradient(150deg,rgba(14,165,233,.32),rgba(79,70,229,.22))}
.mwg-tile:nth-child(4n+4){background:linear-gradient(150deg,rgba(34,197,94,.3),rgba(13,148,136,.22))}
.mwg-tile .mwg-temo{font-size:32px;line-height:1}
.mwg-tile:active{transform:scale(.98)}
.mwg-reset{display:block;margin:18px auto 0;appearance:none;border:0;background:transparent;color:#a5a1c9;font-weight:600;font-size:14px;line-height:1;font-family:inherit;cursor:pointer;text-decoration:underline}
@media (prefers-reduced-motion:reduce){.mwg-hole,.mwg-bub,.mwg-sheet,.mwg-help{transition:none!important;animation:none!important}
  .mwg-hole::after,.mwg-invite .mwg-wave{animation:none!important}}
`;
  function style() {
    if (document.getElementById('mwgStyle')) return;
    const st = document.createElement('style');
    st.id = 'mwgStyle';
    st.textContent = STYLE;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ------------------------------------------------------------- tours */

  function register(id, tour) {
    if (!id || !tour || !Array.isArray(tour.steps)) return;
    const prev = tours.get(id);
    tours.set(id, Object.assign({ order: prev ? prev.order : order++ }, tour));
  }

  function find(target) {
    if (!target) return null;
    const list = typeof target === 'function' ? [target()] : String(target).split('||').map((s) => {
      try { return document.querySelector(s.trim()); } catch (e) { return null; }
    });
    for (const el of list) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none') continue;
      return el;
    }
    return null;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function start(id, opts = {}) {
    const tour = tours.get(id);
    if (!tour) return false;
    stop(true);
    closeHelp();
    if (typeof tour.before === 'function') {
      try { await tour.before(); } catch (e) {}
      await new Promise((r) => setTimeout(r, 350));
    }
    style();
    const dim = document.createElement('div');
    dim.className = 'mwg-dim';
    dim.setAttribute('aria-hidden', 'true');
    const hole = document.createElement('div');
    hole.className = 'mwg-hole';
    const bub = document.createElement('div');
    bub.className = 'mwg-bub';
    bub.setAttribute('role', 'dialog');
    bub.setAttribute('aria-modal', 'true');
    bub.setAttribute('aria-live', 'polite');
    document.body.append(dim, hole, bub);
    run = { id, tour, i: 0, els: { dim, hole, bub }, onEnd: opts.onEnd, prevFocus: document.activeElement };
    dim.addEventListener('click', () => go(1));
    bub.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mwg]');
      if (!b) return;
      const a = b.dataset.mwg;
      if (a === 'next') go(1);
      else if (a === 'back') go(-1);
      else if (a === 'skip') stop();
    });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    show(0, 1);
    return true;
  }

  function onKey(e) {
    if (!run) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); }
  }

  function go(d) { if (run) show(run.i + d, d); }

  // the next step (in direction d) whose target is on screen, or a centred one
  function show(i, d) {
    if (!run) return;
    const steps = run.tour.steps;
    while (i >= 0 && i < steps.length) {
      const s = steps[i];
      if (!s.target || find(s.target)) break;
      i += d >= 0 ? 1 : -1;
    }
    if (i >= steps.length) { stop(); return; }
    if (i < 0) i = 0;
    run.i = i;
    const s = steps[i];
    if (typeof s.before === 'function') { try { s.before(); } catch (e) {} }
    const el = find(s.target);
    run.el = el;
    if (el) {
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch (e) { try { el.scrollIntoView(); } catch (x) {} }
    }
    const visible = steps.filter((x) => !x.target || find(x.target));
    const at = Math.max(0, visible.indexOf(s));
    const last = at >= visible.length - 1;
    const { bub } = run.els;
    bub.innerHTML = `<button type="button" class="mwg-skip" data-mwg="skip" aria-label="Close the guide">✕</button>`
      + (s.emoji ? `<span class="mwg-emo" aria-hidden="true">${esc(s.emoji)}</span>` : '')
      + `<h3>${esc(s.title || '')}</h3>`
      + (s.body ? `<p>${esc(s.body)}</p>` : '')
      + `<div class="mwg-row"><span class="mwg-dots" aria-label="Step ${at + 1} of ${visible.length}">`
      + visible.map((_, k) => `<i class="${k === at ? 'on' : ''}"></i>`).join('') + '</span>'
      + (at > 0 ? '<button type="button" class="mwg-btn mwg-back" data-mwg="back">Back</button>' : '')
      + `<button type="button" class="mwg-btn mwg-next" data-mwg="next">${last ? 'Done 🎉' : 'Next'}</button></div>`;
    place();
    setTimeout(place, 320);           // after the smooth scroll settles
    const nb = bub.querySelector('.mwg-next');
    if (nb) try { nb.focus({ preventScroll: true }); } catch (e) {}
  }

  function place() {
    if (!run) return;
    const { hole, bub } = run.els;
    const el = run.el && run.el.isConnected ? run.el : null;
    const vw = window.innerWidth, vh = window.innerHeight, pad = 8, gap = 14;
    const bw = bub.offsetWidth, bh = bub.offsetHeight;
    if (!el) {
      hole.classList.add('mwg-none');
      hole.style.left = vw / 2 + 'px'; hole.style.top = vh / 2 + 'px';
      bub.style.left = Math.round((vw - bw) / 2) + 'px';
      bub.style.top = Math.round((vh - bh) / 2) + 'px';
      return;
    }
    hole.classList.remove('mwg-none');
    const r = el.getBoundingClientRect();
    const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad);
    const w = Math.min(vw - 8, r.right + pad) - x, h = Math.min(vh - 8, r.bottom + pad) - y;
    Object.assign(hole.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    const cs = getComputedStyle(el);
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    hole.style.borderRadius = Math.min(28, rad + pad) + 'px';
    // below if it fits, else above, else whichever side has more room
    let top;
    if (y + h + gap + bh <= vh - 8) top = y + h + gap;
    else if (y - gap - bh >= 8) top = y - gap - bh;
    else top = (vh - (y + h)) > y ? Math.min(vh - bh - 8, y + h + gap) : Math.max(8, y - gap - bh);
    top = Math.max(8, Math.min(vh - bh - 8, top));
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(16, Math.min(vw - bw - 16, left));
    bub.style.left = Math.round(left) + 'px';
    bub.style.top = Math.round(top) + 'px';
  }

  function stop(silent) {
    if (!run) return;
    const r = run;
    run = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    for (const el of Object.values(r.els)) el.remove();
    if (!silent) {
      markSeen(r.id);
      markInvited(r.id);
      for (const c of document.querySelectorAll(`.mwg-invite[data-tour="${window.CSS && CSS.escape ? CSS.escape(r.id) : r.id}"]`)) c.remove();
      if (typeof r.onEnd === 'function') { try { r.onEnd(); } catch (e) {} }
    }
    try { if (r.prevFocus && r.prevFocus.focus) r.prevFocus.focus({ preventScroll: true }); } catch (e) {}
  }

  /* ----------------------------------------------------------- buttons */

  function helpButton(id, opts = {}) {
    style();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mwg-ask' + (opts.className ? ' ' + opts.className : '');
    b.textContent = '?';
    b.title = opts.title || 'Show me around';
    b.setAttribute('aria-label', opts.title || 'Show me around');
    b.dataset.tour = id;
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (id) start(id); else openHelp(); });
    return b;
  }

  // "👋 New here? Show me around" — in the page, once, never on top of anything
  function invite(id, parent, opts = {}) {
    if (!parent || invited(id) || seen(id) || !tours.has(id)) return null;
    if (parent.querySelector(`.mwg-invite[data-tour="${id}"]`)) return parent.querySelector(`.mwg-invite[data-tour="${id}"]`);
    style();
    const card = document.createElement('div');
    card.className = 'mwg-invite';
    card.dataset.tour = id;
    card.innerHTML = `<span class="mwg-wave" aria-hidden="true">👋</span><b>${esc(opts.text || 'New here?')}</b>`
      + `<button type="button" class="mwg-go">${esc(opts.button || 'Show me around')}</button>`
      + '<button type="button" class="mwg-x" aria-label="No thanks">✕</button>';
    card.querySelector('.mwg-go').addEventListener('click', () => { markInvited(id); card.remove(); start(id); });
    card.querySelector('.mwg-x').addEventListener('click', () => { markInvited(id); card.remove(); });
    if (opts.before && opts.before.parentNode === parent) parent.insertBefore(card, opts.before);
    else if (opts.first) parent.insertBefore(card, parent.firstChild);
    else parent.appendChild(card);
    return card;
  }

  /* -------------------------------------------------------- help sheet */

  let helpEl = null;
  function closeHelp() { if (helpEl) { helpEl.remove(); helpEl = null; window.removeEventListener('keydown', helpKey, true); } }
  function helpKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHelp(); } }
  function openHelp(opts = {}) {
    style();
    closeHelp();
    const list = Array.from(tours.entries())
      .filter(([, t]) => t.help !== false && (typeof t.available !== 'function' || t.available()))
      .sort((a, b) => a[1].order - b[1].order);
    helpEl = document.createElement('div');
    helpEl.className = 'mwg-help';
    helpEl.innerHTML = `<div class="mwg-sheet" role="dialog" aria-modal="true" aria-label="Help">`
      + `<h2><span aria-hidden="true">🧭</span>${esc(opts.title || 'How do I…?')}<button type="button" class="mwg-close" aria-label="Close">✕</button></h2>`
      + `<div class="mwg-grid">${list.map(([id, t]) => `<button type="button" class="mwg-tile" data-tour="${esc(id)}"><span class="mwg-temo" aria-hidden="true">${esc(t.emoji || '✨')}</span><span>${esc(t.title || id)}</span></button>`).join('')}</div>`
      + '<button type="button" class="mwg-reset">Show the welcome tips again</button></div>';
    helpEl.addEventListener('click', (e) => {
      if (e.target === helpEl || e.target.closest('.mwg-close')) return closeHelp();
      const t = e.target.closest('.mwg-tile');
      if (t) return start(t.dataset.tour);
      if (e.target.closest('.mwg-reset')) { save({}); closeHelp(); if (typeof opts.onReset === 'function') opts.onReset(); }
    });
    document.body.appendChild(helpEl);
    window.addEventListener('keydown', helpKey, true);
    const first = helpEl.querySelector('.mwg-tile');
    if (first) try { first.focus({ preventScroll: true }); } catch (e) {}
    return helpEl;
  }

  window.MWGuide = {
    register, start, stop: () => stop(), go,
    helpButton, invite, openHelp, closeHelp,
    seen, markSeen, reset: () => save({}),
    has: (id) => tours.has(id),
    list: () => Array.from(tours.keys()),
    get running() { return run ? run.id : null; },
    get step() { return run ? run.i : -1; },
  };
})();
