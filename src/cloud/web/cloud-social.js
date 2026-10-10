'use strict';
/*
 * THE HOME SCREEN AND THE SOCIAL SCHEDULER — the Cloud Studio as an app with
 * two rooms.
 *
 * The phone used to open straight into the editor. That was right while the
 * editor was the only thing here; now there are two jobs a church does from a
 * phone — make the video, then get it in front of people — and the app opens
 * on a home screen that offers both, the way any app with more than one room
 * does.
 *
 *   HOME        two big doors (Video Studio, Social Scheduler), what is running
 *               in the background, and the latest exports with a Post button.
 *   SCHEDULER   the posts, by day; the linked accounts; a composer that takes a
 *               finished short, writes the caption with the same AI the desk
 *               uses, and books it.
 *
 * The scheduler here is the app's OWN scheduler (src/main/scheduler.js), run on
 * whichever machine serves this page: the same posts, the same booking with
 * Zernio, the same retries. Nothing in this file publishes anything; it asks.
 *
 * It leans on cloud-boot.js for everything shell-shaped (window.MWCloud): the
 * RPC, the island, the sheets, downloads, uploads, the jobs chip.
 */
(function () {
  const C = window.MWCloud;
  if (!C) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => C.esc(s);
  const escAttr = (s) => C.escAttr(s);
  const mi = (n, x) => C.mi(n, x);
  const phone = () => window.matchMedia('(max-width: 900px)').matches;

  const S = {
    view: '',
    started: false,
    social: true,            // the server may switch the scheduler off
    posts: [],
    plans: {},
    accounts: [],
    keys: { zo: false, zoFb: false },
    loadedAt: 0,
    tab: 'upcoming',
    exports: [],
    thumbs: new Map(),       // media path -> thumbnail path (or '' while coming)
    poll: null,
  };

  /* ---------------------------------------------------------- brand marks */

  // The four places a post can go, drawn small and in their own colours.
  const PLAT = {
    tiktok: {
      name: 'TikTok',
      svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="7" fill="#000"/><path fill="#25F4EE" d="M15.9 4.4h-2.6v10.4a2.2 2.2 0 1 1-2.2-2.2c.2 0 .4 0 .6.1V10a4.9 4.9 0 1 0 4.3 4.8V9.6a6.3 6.3 0 0 0 3.6 1.1V8.1a3.7 3.7 0 0 1-3.7-3.7z" transform="translate(-.6 -.4)"/><path fill="#FE2C55" d="M15.9 4.4h-2.6v10.4a2.2 2.2 0 1 1-2.2-2.2c.2 0 .4 0 .6.1V10a4.9 4.9 0 1 0 4.3 4.8V9.6a6.3 6.3 0 0 0 3.6 1.1V8.1a3.7 3.7 0 0 1-3.7-3.7z" transform="translate(.6 .4)"/><path fill="#fff" d="M15.9 4.4h-2.6v10.4a2.2 2.2 0 1 1-2.2-2.2c.2 0 .4 0 .6.1V10a4.9 4.9 0 1 0 4.3 4.8V9.6a6.3 6.3 0 0 0 3.6 1.1V8.1a3.7 3.7 0 0 1-3.7-3.7z"/></svg>',
    },
    youtube: {
      name: 'YouTube',
      svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="7" fill="#fff"/><rect x="3.5" y="6.5" width="17" height="11" rx="3.4" fill="#FF0033"/><path d="M10.4 9.4v5.2l4.4-2.6z" fill="#fff"/></svg>',
    },
    instagram: {
      name: 'Instagram',
      svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="mwIgG" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FEDA75"/><stop offset=".3" stop-color="#FA7E1E"/><stop offset=".55" stop-color="#D62976"/><stop offset=".8" stop-color="#962FBF"/><stop offset="1" stop-color="#4F5BD5"/></linearGradient></defs><rect width="24" height="24" rx="7" fill="url(#mwIgG)"/><rect x="6" y="6" width="12" height="12" rx="3.8" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="12" cy="12" r="2.9" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="16.1" cy="7.9" r="1" fill="#fff"/></svg>',
    },
    facebook: {
      name: 'Facebook',
      svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="7" fill="#1877F2"/><path d="M13.3 20v-6.3h2.1l.4-2.6h-2.5V9.5c0-.7.3-1.3 1.4-1.3h1.2V6c-.2 0-1-.1-1.9-.1-1.9 0-3.2 1.2-3.2 3.3v1.9H8.7v2.6h2.1V20z" fill="#fff"/></svg>',
    },
  };
  const PLAT_ORDER = ['tiktok', 'youtube', 'instagram', 'facebook'];
  const platMark = (p, cls) => `<span class="cs-mark${cls ? ' ' + cls : ''}" title="${escAttr((PLAT[p] || {}).name || p)}">${(PLAT[p] || {}).svg || ''}</span>`;

  /* --------------------------------------------------------------- times */

  const DAY = 86400000;
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const timeOf = (d) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  function dayName(d) {
    const t = startOfDay(Date.now()).getTime(), x = startOfDay(d).getTime();
    if (x === t) return 'Today';
    if (x === t + DAY) return 'Tomorrow';
    if (x === t - DAY) return 'Yesterday';
    return new Date(d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  }
  const whenLabel = (d) => `${dayName(d)} · ${timeOf(d)}`;
  function fromNow(d) {
    const ms = new Date(d).getTime() - Date.now();
    const a = Math.abs(ms), m = Math.round(a / 60000), h = Math.round(a / 3600000), dd = Math.round(a / DAY);
    const span = m < 1 ? 'now' : m < 60 ? `${m} min` : h < 36 ? `${h} h` : `${dd} days`;
    if (span === 'now') return 'now';
    return ms > 0 ? `in ${span}` : `${span} ago`;
  }
  /*
   * When people actually look — the same windows the desk's auto-schedule uses
   * (src/main/schedule-plan.js), worked out HERE, in this phone's own time. The
   * server is in a data centre on UTC; "18:00" there is not the church's 6pm.
   */
  const WINDOWS = [9, 12, 15, 18, 20];
  function nextWindow(from) {
    const start = new Date(from);
    for (let d = 0; d < 14; d++) {
      const day = startOfDay(start); day.setDate(day.getDate() + d);
      const hours = (day.getDay() === 0 ? [7] : []).concat(WINDOWS);
      for (const h of hours) {
        const t = new Date(day); t.setHours(h, 0, 0, 0);
        if (t.getTime() >= start.getTime()) return t;
      }
    }
    const t = new Date(start); t.setHours(t.getHours() + 1, 0, 0, 0);
    return t;
  }
  function planTimes(n, spacingHours, from) {
    const out = [];
    let cursor = new Date(Math.max(Date.now() + 30 * 60000, from ? new Date(from).getTime() : 0));
    for (let i = 0; i < n; i++) {
      const slot = nextWindow(cursor);
      out.push(slot);
      cursor = new Date(slot.getTime() + spacingHours * 3600000);
    }
    return out;
  }
  const localInput = (d) => {
    const x = new Date(d);
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
  };

  /* --------------------------------------------------------------- media */

  const baseName = (p) => String(p || '').split(/[\\/]/).pop();
  const isVideo = (p) => /\.(mp4|mov|m4v|webm|mkv)$/i.test(String(p || ''));
  const isImage = (p) => /\.(png|jpe?g|gif|webp)$/i.test(String(p || ''));
  /**
   * A title out of an export's file name: "short-Faith_over_fear-20261002-173243.mp4"
   * → "Faith over fear". The studio's own words for HOW it was made (edited,
   * overlay, captioned) are not a title; a name with nothing else in it becomes
   * "Short · 2 Oct", from the time stamp the studio put on it.
   */
  function titleFromFile(p) {
    const raw = baseName(p).replace(/\.[a-z0-9]+$/i, '');
    const m = /(\d{4})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})?$/.exec(raw);
    const n = raw.replace(/[-_]?\d{8}[-_]\d{4,6}$/, '')
      .replace(/^(short|edited|export|clip)[-_]+/i, '')
      .replace(/(^|[-_])(edited|overlay|captioned|text|reframed|framed)(?=$|[-_])/gi, '$1')
      .replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!n || /^(short|sermon|video|clip|new video)$/i.test(n)) {
      const kind = /^short/i.test(raw) ? 'Short' : 'Video';
      if (!m) return kind;
      const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      return `${kind} · ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    }
    return n.charAt(0).toUpperCase() + n.slice(1);
  }
  /** A picture of this video for a card. Made once per file, on the studio machine. */
  function thumbFor(p, onReady) {
    if (!p) return '';
    if (isImage(p)) return C.fileUrl(p);
    const got = S.thumbs.get(p);
    if (got) return C.fileUrl(got);
    if (got === undefined) {
      S.thumbs.set(p, '');
      window.api.video.thumbnail(p, 1).then((t) => {
        S.thumbs.set(p, t || '');
        if (t && onReady) onReady(C.fileUrl(t));
      }).catch(() => {});
    }
    return '';
  }
  /** Paint the thumbnail into every element waiting for this file. */
  function paintThumbs(root) {
    for (const el of $$('[data-thumb]', root || document)) {
      const p = el.dataset.thumb;
      const url = thumbFor(p, (u) => { for (const e2 of $$(`[data-thumb="${CSS.escape(p)}"]`)) e2.style.backgroundImage = `url("${u}")`; });
      if (url) el.style.backgroundImage = `url("${url}")`;
    }
  }

  async function loadExports() {
    try {
      const res = await fetch('/api/videos', { headers: C.authHeaders() });
      if (!res.ok) return S.exports;
      const data = await res.json();
      const out = (data.groups || []).find((g) => g.key === 'output');
      S.exports = ((out && out.files) || []).filter((f) => isVideo(f.path) || isImage(f.path))
        .sort((a, b) => b.mtime - a.mtime).slice(0, 40);
    } catch (e) { /* the list is a convenience */ }
    return S.exports;
  }

  /* ---------------------------------------------------------- the data */

  async function loadSocial(force) {
    if (!S.social) return;
    if (!force && Date.now() - S.loadedAt < 4000) return;
    S.loadedAt = Date.now();
    try {
      const [posts, acc, plans] = await Promise.all([
        window.api.scheduler.list(),
        window.api.social.accounts(),
        window.api.scheduler.plans().catch(() => ({})),
      ]);
      S.posts = Array.isArray(posts) ? posts : [];
      S.accounts = (acc && acc.accounts) || [];
      S.keys = (acc && acc.keys) || S.keys;
      S.plans = plans || {};
    } catch (e) {
      if (/not available from the cloud/i.test(e.message || '')) S.social = false;
    }
  }
  const upcoming = () => S.posts.filter((p) => p.status === 'scheduled' || p.status === 'posting')
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  const posted = () => S.posts.filter((p) => p.status === 'posted')
    .sort((a, b) => new Date(b.postedAt || b.scheduledAt) - new Date(a.postedAt || a.scheduledAt));
  const failed = () => S.posts.filter((p) => p.status === 'failed');
  const linked = () => S.accounts.filter((a) => a.connected !== false);

  /* ================================================================ VIEWS */

  /*
   * Three rooms, one page: the home screen and the scheduler are layers over the
   * studio, which is never torn down — an export running behind it carries on,
   * and coming back to it finds the timeline exactly where it was.
   */
  function go(view) {
    if (view === 'scheduler' && !S.social) view = 'home';
    S.view = view;
    document.body.classList.toggle('mw-home', view === 'home');
    document.body.classList.toggle('mw-sched', view === 'scheduler');
    document.body.classList.toggle('mw-in-studio', view === 'studio');
    document.body.classList.toggle('mw-projects', view === 'projects');
    clearInterval(S.poll); S.poll = null;
    if (view === 'home') renderHome(true);
    if (view === 'projects') renderProjectsView();
    if (view === 'scheduler') {
      renderSched();
      loadSocial(true).then(renderSched);
      S.poll = setInterval(() => { if (!document.hidden) loadSocial(true).then(renderSched); }, 20000);
    }
    if (view === 'studio') {
      const fit = () => { try { window.VideoEditor && window.VideoEditor.fit && window.VideoEditor.fit(); } catch (e) {} };
      requestAnimationFrame(fit); setTimeout(fit, 250);
    }
    try { history.replaceState(null, '', view === 'home' ? location.pathname + location.search : '#' + view); } catch (e) {}
  }

  /* ----------------------------------------------------------------- home */

  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }

  function buildHome() {
    const el = document.createElement('div');
    el.id = 'cloudHome';
    el.className = 'cloud-home';
    el.innerHTML = `
      <header class="ch-top">
        <div class="ch-brand"><span class="ch-logo">✝</span><span class="ch-name">Church Work Space</span></div>
        <div class="ch-acts"><span class="ch-chip-slot"></span>
          <button type="button" class="ch-round" data-home="files" aria-label="Your files">${mi('folder')}</button>
          <button type="button" class="ch-round ch-me" data-home="me" aria-label="Your space"><b id="chMeInitial">${esc(((C.me && C.me.name) || '').charAt(0).toUpperCase()) || mi('user')}</b></button>
        </div>
      </header>
      <main class="ch-scroll">
        <section class="ch-hello"><h1 id="chHello"></h1><p>What are we making today?</p></section>
        <button type="button" class="ch-card ch-studio" data-go="projects">
          <span class="ch-glow"></span>
          <span class="ch-art">${mi('film')}</span>
          <span class="ch-copy"><b>Video Studio</b><small>Edit the sermon, cut AI shorts, captions and exports</small></span>
          <span class="ch-foot"><span class="ch-foot-tx" id="chStudioFoot">Open a video to start</span><span class="ch-arrow">${mi('chev-right')}</span></span>
        </button>
        <section class="ch-sec ch-projsec hidden" id="chProjects">
          <h2>Your projects <button type="button" class="ch-link" data-home="projects">See all</button></h2>
          <div class="pj-list" id="chProjList"></div>
        </section>
        <button type="button" class="ch-card ch-montage" data-home="montage">
          <span class="ch-glow"></span>
          <span class="ch-art">${mi('sparkles')}</span>
          <span class="ch-copy"><b>AI Montage</b><small>Drop in videos and photos — AI cuts a scroll-stopping edit to your music</small></span>
          <span class="ch-foot"><span class="ch-foot-tx">Make one in a few taps</span><span class="ch-arrow">${mi('chev-right')}</span></span>
        </button>
        <button type="button" class="ch-card ch-social" data-go="scheduler" id="chSocialCard">
          <span class="ch-glow"></span>
          <span class="ch-art">${mi('calendar')}</span>
          <span class="ch-copy"><b>Social Scheduler</b><small>Plan posts to TikTok, YouTube, Instagram and Facebook</small></span>
          <span class="ch-foot"><span class="ch-foot-tx" id="chSocialFoot">Plan your first post</span><span class="ch-marks" id="chMarks"></span><span class="ch-arrow">${mi('chev-right')}</span></span>
        </button>
        <section class="ch-sec hidden" id="chJobs"><h2>Running now</h2><div class="ch-jobs"></div></section>
        <section class="ch-sec hidden" id="chReady">
          <h2>Ready to post <button type="button" class="ch-link" data-home="files">All files</button></h2>
          <div class="ch-reel" id="chReel"></div>
        </section>
        <p class="ch-foot-note" id="chWhere"></p>
      </main>`;
    document.body.appendChild(el);
    el.querySelector('.ch-chip-slot').appendChild(C.jobChip());
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-go],[data-home],[data-post],[data-job],[data-view],[data-proj]');
      if (!b) return;
      if (b.dataset.proj) return openProject(b.dataset.proj);
      if (b.dataset.home === 'projects') return openProjects();
      if (b.dataset.view) return C.viewFile && C.viewFile(b.dataset.view);
      if (b.dataset.go) return go(b.dataset.go);
      if (b.dataset.home === 'files') return $('#cloudFiles') && $('#cloudFiles').click();
      if (b.dataset.home === 'me') return C.openProfile && C.openProfile();
      if (b.dataset.home === 'montage') return openMontage();
      if (b.dataset.post) return compose({ files: [b.dataset.post] });
      if (b.dataset.job) return C.openJobs();
    });
    return el;
  }

  async function renderHome(refresh) {
    const el = $('#cloudHome') || buildHome();
    $('#chHello').textContent = greeting() + (C.me && C.me.name ? ', ' + C.me.name.split(' ')[0] : '');
    const where = (C.hello && C.hello.standalone) ? 'Working on the church’s cloud server' : 'Working on the church’s studio machine';
    $('#chWhere').textContent = where + (C.hello && C.hello.version ? ` · v${C.hello.version}` : '');
    // the studio's door says what is waiting behind it
    const ed = window.VideoEditor;
    let foot = 'Open a video to start';
    if (ed && ed.hasVideo && ed.hasVideo()) foot = 'Carry on editing';
    if (S.projects && S.projects.length) foot = `${S.projects.length} project${S.projects.length > 1 ? 's' : ''} · open one or start new`;
    else if (S.resumeName) foot = `Pick up “${S.resumeName}”`;
    $('#chStudioFoot').textContent = foot;
    renderHomeProjects();
    $('#chSocialCard').classList.toggle('hidden', !S.social);
    renderHomeSocial();
    renderHomeJobs(C.jobList());
    if (!refresh) return;
    loadProjects().then(() => renderHome());
    loadExports().then(renderHomeReady);
    loadSocial(true).then(renderHomeSocial);
    if (!S.resumeChecked) {
      S.resumeChecked = true;
      try {
        const saved = await window.api.sessions.autosaveGet();
        const name = saved && (saved.name || (saved.data && saved.data.name) || (saved.video && baseName(saved.video.path || '')));
        if (name) { S.resumeName = String(name).replace(/\.[a-z0-9]+$/i, '').slice(0, 40); renderHome(); }
      } catch (e) {}
    }
  }
  function renderHomeSocial() {
    if (!$('#cloudHome')) return;
    const up = upcoming();
    const foot = $('#chSocialFoot');
    if (up.length) foot.textContent = `Next: ${whenLabel(up[0].scheduledAt)} · ${up.length} planned`;
    else if (failed().length) foot.textContent = `${failed().length} post${failed().length > 1 ? 's' : ''} need a look`;
    else foot.textContent = linked().length ? 'Nothing planned yet' : 'Connect your accounts to start';
    const plats = Array.from(new Set(linked().map((a) => a.platform)));
    $('#chMarks').innerHTML = plats.map((p) => platMark(p, 'sm')).join('');
  }
  function renderHomeJobs(list) {
    const sec = $('#chJobs'); if (!sec) return;
    const run = list.filter((t) => t.state === 'run');
    sec.classList.toggle('hidden', !run.length);
    sec.querySelector('.ch-jobs').innerHTML = run.map((t) => {
      const pc = Math.round(C.jobPct ? C.jobPct(t) : (t.percent || 0));   // the same number as the chip
      return `<button type="button" class="ch-job" data-job="${escAttr(t.id)}">`
        + `<span class="ch-job-ring" style="--p:${pc}"><i>${pc}%</i></span>`
        + `<span class="ch-job-tx"><b>${esc(C.toastText(t.title))}</b><small>${t.batch ? 'Short ' + esc(t.batch) + ' · ' : ''}${esc(C.toastText(t.step) || 'Starting…')}</small></span>`
        + `<span class="ch-arrow">${mi('chev-right')}</span></button>`;
    }).join('');
  }
  /* ------------------------------------------------------------- projects */

  /*
   * ►► PROJECTS — EVERY VIDEO BEING EDITED KEEPS ITS OWN. ◄◄
   * The studio saves each video's edit as a project of its own as you work
   * (veditor saveProject): the clips, cuts, captions, text, music and where
   * you were. Here they are listed to pick up: the three latest on the home
   * screen under the Video Studio, every one in Projects (also in the
   * studio's Project row), with rename and delete. Deleting a project never
   * touches the video or its exports.
   */
  async function loadProjects() {
    try { S.projects = (await window.api.sessions.list()) || []; } catch (e) { S.projects = S.projects || []; }
    return S.projects;
  }
  function agoWords(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function projRow(r, opts) {
    const o = opts || {};
    const openNow = window.VideoEditor && window.VideoEditor.projectId && window.VideoEditor.projectId() === r.id;
    const bits = [
      r.clips ? `${r.clips} clip${r.clips === 1 ? '' : 's'}` : null,
      r.shorts ? `${r.shorts} short${r.shorts === 1 ? '' : 's'}` : null,
      r.captions ? 'captions' : null,
    ].filter(Boolean).join(' · ');
    const pic = r.thumb ? `<span class="pj-pic" style="background-image:url('${escAttr(r.thumb)}')"></span>`
      : `<span class="pj-pic" ${r.videoPath && !r.videoMissing ? `data-thumb="${escAttr(r.videoPath)}"` : ''}>${mi('film')}</span>`;
    return `<div class="pj-row${r.videoMissing ? ' missing' : ''}${openNow ? ' now' : ''}">`
      + `<button type="button" class="pj-main" data-proj="${escAttr(r.id)}"${r.videoMissing ? ' disabled' : ''}>${pic}`
      + `<span class="pj-tx"><b>${esc(r.name || 'Untitled project')}</b>`
      + `<small>${openNow ? '<i class="pj-now">Open now</i> · ' : ''}${r.videoMissing ? 'Its video was deleted' : esc(`Edited ${agoWords(r.savedAt)}`) + (bits ? ' · ' + esc(bits) : '')}</small></span>`
      + (o.manage ? '' : `<span class="pj-go">${mi('chev-right')}</span>`) + '</button>'
      + (o.manage ? `<button type="button" class="pj-more" data-pjren="${escAttr(r.id)}" aria-label="Rename">${mi('pen')}</button>`
        + `<button type="button" class="pj-more pj-del" data-pjdel="${escAttr(r.id)}" aria-label="Delete">${mi('trash')}</button>` : '')
      + '</div>';
  }
  function renderHomeProjects() {
    const sec = $('#chProjects'); if (!sec) return;
    const list = (S.projects || []).filter((r) => !r.videoMissing).slice(0, 3);
    sec.classList.toggle('hidden', !list.length);
    $('#chProjList').innerHTML = list.map((r) => projRow(r)).join('');
    paintThumbs(sec);
  }
  async function openProject(id) {
    const ed = window.VideoEditor;
    if (!ed || !ed.openProject) return;
    const p = C.panelOf && C.panelOf('cloudProjects'); if (p) p.close();
    go('studio');
    C.island({ id: 'proj', title: 'Opening your project…', spin: true, sticky: true });
    let ok = false;
    try { ok = await ed.openProject(id); } catch (e) { ok = false; }
    C.islandHide('proj');
    if (!ok) C.island({ kind: 'warn', title: 'That project could not be opened', sub: 'Its video may have been deleted', ms: 5000 });
  }
  /*
   * ►► THE PROJECTS SCREEN — what tapping the Video Studio opens. ◄◄
   * Like CapCut's: a big New project, then every project to pick from (the
   * one open in the editor marked), each with rename and delete. The editor's
   * top bar has a Projects button to come back here; leaving the editor saves
   * the open project first.
   */
  function openProjects() { go('projects'); }
  function buildProjectsView() {
    const el = document.createElement('div');
    el.id = 'cloudProjView';
    el.className = 'cloud-proj';
    el.innerHTML = `
      <header class="cs-top">
        <button type="button" class="cs-back" data-go="home" aria-label="Home">${mi('chev-left')}</button>
        <h1>Video Studio</h1>
        <span class="cs-chip-slot"></span>
      </header>
      <main class="cs-scroll pv-scroll">
        <button type="button" class="pv-new" data-pv="new">
          <span class="pv-new-art">${mi('plus')}</span>
          <span class="pv-new-tx"><b>New project</b><small>Open a video to edit — a sermon, a clip, anything</small></span>
        </button>
        <section class="pv-cur hidden" id="pvCur"></section>
        <h2 class="pv-h">Your projects <small id="pvCount"></small></h2>
        <div class="pj-list" id="pvList"></div>
      </main>`;
    document.body.appendChild(el);
    el.querySelector('.cs-chip-slot').appendChild(C.jobChip());
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-go],[data-pv],[data-proj],[data-pjren],[data-pjdel]');
      if (!b) return;
      if (b.dataset.go) return go(b.dataset.go);
      if (b.dataset.pv === 'new') {
        // the picker first, straight from the tap (a phone only opens one from a tap); the open project is saved meanwhile
        const ed = window.VideoEditor;
        const saving = ed && ed.flushProject ? ed.flushProject().catch(() => null) : null;
        go('studio');
        const o = document.getElementById('veOpen'); if (o) o.click();
        await saving;
        return;
      }
      if (b.dataset.pv === 'continue') return go('studio');
      if (b.dataset.proj) return openProject(b.dataset.proj);
      if (b.dataset.pjren) {
        const row = (S.projects || []).find((r) => r.id === b.dataset.pjren);
        const nm = window.prompt('Name this project', row ? row.name : '');
        if (nm == null || !String(nm).trim()) return;
        const name = String(nm).trim().slice(0, 80);
        try { await window.api.sessions.rename(b.dataset.pjren, name); } catch (er) {}
        const ed = window.VideoEditor; if (ed && ed.projectRenamed) ed.projectRenamed(b.dataset.pjren, name);
        return renderProjectsView();
      }
      if (b.dataset.pjdel) {
        const row = (S.projects || []).find((r) => r.id === b.dataset.pjdel);
        if (!window.confirm(`Delete the project “${row ? row.name : ''}”?\n\nThe video and anything you exported stay — only this edit goes.`)) return;
        try { await window.api.sessions.remove(b.dataset.pjdel); } catch (er) {}
        const ed = window.VideoEditor; if (ed && ed.projectRemoved) ed.projectRemoved(b.dataset.pjdel);
        return renderProjectsView();
      }
    });
    return el;
  }
  async function renderProjectsView() {
    const el = $('#cloudProjView') || buildProjectsView();
    const list = $('#pvList', el);
    if (!S.projects) list.innerHTML = '<p class="pj-empty">Looking…</p>';
    try { const ed = window.VideoEditor; if (ed && ed.flushProject) await ed.flushProject(); } catch (e) {}
    const rows = await loadProjects();
    if (S.view !== 'projects') return;
    const ed = window.VideoEditor;
    const openId = ed && ed.projectId ? ed.projectId() : null;
    // the edit open in the editor, first — even before it has been saved as a project
    const cur = $('#pvCur', el);
    const curRow = openId ? rows.find((r) => r.id === openId) : null;
    const hasVid = ed && ed.hasVideo && ed.hasVideo();
    cur.classList.toggle('hidden', !hasVid);
    if (hasVid) {
      const nm = curRow ? curRow.name : String((ed.sourcePath && ed.sourcePath()) || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      cur.innerHTML = `<button type="button" class="pv-cont" data-pv="continue"><span class="pv-cont-k">Open in the editor</span><b>${esc(nm || 'Your video')}</b><span class="pv-cont-go">Continue ${mi('chev-right')}</span></button>`;
    }
    const others = rows.filter((r) => r.id !== openId);
    $('#pvCount', el).textContent = rows.length ? String(rows.length) : '';
    list.innerHTML = others.length
      ? others.map((r) => projRow(r, { manage: true })).join('')
      : (rows.length ? '<p class="pv-none">This is your only project so far.</p>'
        : `<div class="pj-empty"><span class="pj-empty-art">${mi('layers')}</span><b>No projects yet</b><p>Tap <b>New project</b> and open a video — every video you edit is kept here, to carry on any time.</p></div>`);
    paintThumbs(el);
  }

  function renderHomeReady() {
    const sec = $('#chReady'); if (!sec) return;
    const list = S.exports.filter((f) => isVideo(f.path)).slice(0, 10);
    sec.classList.toggle('hidden', !list.length);
    $('#chReel').innerHTML = list.map((f) => `<div class="ch-tile">`
      + `<span class="ch-tile-pic" data-thumb="${escAttr(f.path)}" data-view="${escAttr(f.path)}" role="button" aria-label="Watch"></span>`
      + `<span class="ch-tile-name">${esc(titleFromFile(f.path))}</span>`
      + (S.social ? `<button type="button" class="ch-tile-go" data-post="${escAttr(f.path)}">${mi('send')}Post</button>` : '')
      + '</div>').join('');
    paintThumbs(sec);
  }

  /* ------------------------------------------------------------ scheduler */

  function buildSched() {
    const el = document.createElement('div');
    el.id = 'cloudSched';
    el.className = 'cloud-sched';
    el.innerHTML = `
      <header class="cs-top">
        <button type="button" class="cs-back" data-go="home" aria-label="Home">${mi('chev-left')}</button>
        <h1>Scheduler</h1>
        <span class="cs-chip-slot"></span>
        <button type="button" class="cs-new" data-sched="new">${mi('plus')}<span>New post</span></button>
      </header>
      <main class="cs-scroll">
        <section class="cs-accts" id="csAccts"></section>
        <nav class="cs-tabs" id="csTabs" role="tablist">
          <button type="button" data-tab="upcoming" role="tab">Planned</button>
          <button type="button" data-tab="posted" role="tab">Posted</button>
          <button type="button" data-tab="failed" role="tab">Needs a look</button>
        </nav>
        <div class="cs-list" id="csList"></div>
      </main>`;
    document.body.appendChild(el);
    el.querySelector('.cs-chip-slot').appendChild(C.jobChip());
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button,[data-open-post]');
      if (!b) return;
      if (b.dataset.go) return go(b.dataset.go);
      if (b.dataset.sched === 'new') return compose({});
      if (b.dataset.sched === 'connect') return openConnect();
      if (b.dataset.tab) { S.tab = b.dataset.tab; return renderSched(); }
      if (b.dataset.openPost) return openPost(b.dataset.openPost);
    });
    return el;
  }

  function renderSched() {
    if (S.view !== 'scheduler') return;
    const el = $('#cloudSched') || buildSched();
    // the accounts strip
    const acc = linked();
    $('#csAccts').innerHTML = acc.map((a) => `<button type="button" class="cs-acct" data-sched="connect">`
      + `<span class="cs-ava">${a.picture ? `<img src="${escAttr(a.picture)}" alt="">` : `<b>${esc((a.name || '?').replace(/^@/, '').charAt(0).toUpperCase())}</b>`}${platMark(a.platform, 'badge')}</span>`
      + `<span class="cs-acct-name">${esc(a.name || (PLAT[a.platform] || {}).name || a.platform)}</span></button>`).join('')
      + `<button type="button" class="cs-acct cs-acct-add" data-sched="connect"><span class="cs-ava">${mi('plus')}</span>`
      + `<span class="cs-acct-name">${acc.length ? 'Accounts' : 'Connect'}</span></button>`;
    // the tabs, with counts
    const counts = { upcoming: upcoming().length, posted: posted().length, failed: failed().length };
    for (const t of $$('#csTabs [data-tab]')) {
      const k = t.dataset.tab;
      t.classList.toggle('on', S.tab === k);
      t.setAttribute('aria-selected', S.tab === k ? 'true' : 'false');
      t.innerHTML = `${{ upcoming: 'Planned', posted: 'Posted', failed: 'Needs a look' }[k]}${counts[k] ? `<i>${counts[k]}</i>` : ''}`;
      t.classList.toggle('alert', k === 'failed' && counts.failed > 0);
    }
    const list = S.tab === 'posted' ? posted() : S.tab === 'failed' ? failed() : upcoming();
    const box = $('#csList');
    if (!list.length) {
      box.innerHTML = emptySched();
      return;
    }
    // grouped by day
    let html = '', day = '';
    for (const p of list) {
      const when = S.tab === 'posted' ? (p.postedAt || p.scheduledAt) : p.scheduledAt;
      const d = dayName(when);
      if (d !== day) { day = d; html += `<h3 class="cs-day">${esc(d)}</h3>`; }
      html += postCard(p, when);
    }
    box.innerHTML = html;
    paintThumbs(box);
  }

  function emptySched() {
    if (!S.keys.zo && !linked().length && S.tab === 'upcoming') {
      return `<div class="cs-empty"><div class="cs-empty-art">${PLAT_ORDER.map((p) => platMark(p)).join('')}</div>`
        + '<b>Post everywhere from here</b><p>Connect TikTok, YouTube, Instagram and Facebook once. Then pick a finished short, let the AI write the caption, choose a time — and it goes out on its own, even with this phone switched off.</p>'
        + `<button type="button" class="cs-cta" data-sched="connect">${mi('link')}Connect accounts</button></div>`;
    }
    const msg = {
      upcoming: ['Nothing planned yet', 'Pick a finished short and choose when it should go out.'],
      posted: ['Nothing posted yet', 'Posts that have gone out show up here, with a link to each one.'],
      failed: ['All good', 'Nothing needs a look.'],
    }[S.tab];
    return `<div class="cs-empty"><div class="cs-empty-art solo">${mi(S.tab === 'failed' ? 'check' : 'calendar')}</div><b>${msg[0]}</b><p>${msg[1]}</p>`
      + (S.tab === 'upcoming' ? `<button type="button" class="cs-cta" data-sched="new">${mi('plus')}New post</button>` : '') + '</div>';
  }

  function statusOf(p) {
    if (p.status === 'posting') return { cls: 'posting', tx: 'Posting now…' };
    if (p.status === 'posted') return { cls: 'posted', tx: 'Posted' };
    if (p.status === 'failed') return { cls: 'failed', tx: 'Did not post' };
    const plan = S.plans[p.id];
    if (plan && plan.bookable && plan.bookable.length && plan.bookable.every((b) => b.booked) && !(plan.local || []).length) {
      return { cls: 'booked', tx: 'Booked' };
    }
    if (p.error) return { cls: 'retry', tx: 'Retrying' };
    return { cls: 'planned', tx: 'Planned' };
  }
  function postCard(p, when) {
    const media = (p.mediaPaths || [])[0];
    const st = statusOf(p);
    const plats = Array.from(new Set((p.platforms || []).concat(((p.accountIds || []).map((id) => (S.accounts.find((a) => a.id === id) || {}).platform)).filter(Boolean))));
    const cap = String(p.caption || '').split('\n').find((l) => l.trim()) || '';
    return `<button type="button" class="cs-post" data-open-post="${escAttr(p.id)}">`
      + `<span class="cs-pic" ${media ? `data-thumb="${escAttr(media)}"` : ''}>${media ? '' : mi('type')}</span>`
      + '<span class="cs-post-main">'
      + `<span class="cs-post-when">${esc(timeOf(when))}<i>${esc(fromNow(when))}</i></span>`
      + `<span class="cs-post-title">${esc(p.title || 'Untitled post')}</span>`
      + (cap ? `<span class="cs-post-cap">${esc(cap)}</span>` : '')
      + `<span class="cs-post-foot"><span class="cs-marks">${plats.map((x) => platMark(x, 'sm')).join('')}</span><span class="cs-state ${st.cls}">${esc(st.tx)}</span></span>`
      + '</span></button>';
  }

  /* --------------------------------------------------------- one post */

  function openPost(id) {
    const p = S.posts.find((x) => x.id === id);
    if (!p) return;
    const panel = C.openPanel({ id: 'csPost', title: p.status === 'posted' ? 'Posted' : 'Planned post', cls: 'cp-post' });
    const media = (p.mediaPaths || [])[0];
    const st = statusOf(p);
    const rows = (p.accountIds || []).map((aid) => {
      const a = S.accounts.find((x) => x.id === aid) || { name: aid, platform: '' };
      const r = (p.results || {})[aid];
      const h = (p.handoffs || {})[aid];
      const he = (p.handoffErrors || {})[aid];
      let line = 'Waiting for its time', cls = '';
      if (r && r.ok) { line = r.url ? `<a href="${escAttr(r.url)}" target="_blank" rel="noopener">Posted — open it ${mi('external')}</a>` : 'Posted'; cls = 'ok'; }
      else if (r && !r.ok) { line = esc(r.error || 'Did not post'); cls = 'bad'; }
      else if (h && h.ok) { line = `Booked — ${esc((PLAT[a.platform] || {}).name || 'the platform')} will post it at its time`; cls = 'ok'; }
      else if (he) { line = esc(he.why || 'Could not book it yet — it will try again'); cls = he.cannotSchedule ? '' : 'warn'; }
      return `<li class="${cls}">${platMark(a.platform)}<span><b>${esc(a.name)}</b><small>${line}</small></span></li>`;
    }).join('');
    panel.body.innerHTML = '<div class="cs-detail">'
      + (media && isVideo(media)
        ? `<video class="cs-video" src="${escAttr(C.fileUrl(media))}" controls playsinline preload="metadata"></video>`
        : media ? `<img class="cs-video" src="${escAttr(C.fileUrl(media))}" alt="">` : '')
      + `<div class="cs-d-when">${mi('clock')}<span>${esc(whenLabel(p.status === 'posted' ? (p.postedAt || p.scheduledAt) : p.scheduledAt))}</span><span class="cs-state ${st.cls}">${esc(st.tx)}</span></div>`
      + `<h3 class="cs-d-title">${esc(p.title || 'Untitled post')}</h3>`
      + (p.caption ? `<p class="cs-d-cap">${esc(p.caption)}</p>` : '')
      + (rows ? `<ul class="cs-d-accts">${rows}</ul>` : '')
      + (p.error && p.status !== 'posted' ? `<p class="cs-d-err">${esc(p.error)}</p>` : '')
      + '</div>';
    const btns = [];
    if (p.status === 'scheduled' || p.status === 'failed') btns.push(`<button type="button" class="cs-btn ghost" data-act="edit">${mi('pen')}Edit</button>`);
    if (p.status === 'failed') btns.push(`<button type="button" class="cs-btn primary" data-act="retry">${mi('refresh')}Try again</button>`);
    else if (p.status === 'scheduled') btns.push(`<button type="button" class="cs-btn primary" data-act="now">${mi('send')}Post now</button>`);
    panel.foot.innerHTML = `<div class="cs-actions">${btns.join('')}</div>`
      + `<button type="button" class="cs-btn danger wide" data-act="delete">${mi('trash')}${p.status === 'posted' ? 'Remove from this list' : 'Delete this post'}</button>`;
    panel.foot.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act === 'edit') { panel.close(); return compose({ post: p }); }
      if (act === 'delete') {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.innerHTML = `${mi('trash')}Tap again to delete`; return; }
        b.disabled = true;
        try {
          const r = await window.api.scheduler.remove(p.id);
          const warn = r && r.warning;
          C.island({ kind: warn ? 'warn' : 'good', title: warn ? 'Deleted here — check the platform' : 'Post deleted', sub: warn || p.title || '', ms: warn ? 10000 : 3500 });
        } catch (er) { C.island({ kind: 'error', title: 'Could not delete it', sub: er.message }); }
        panel.close();
        await loadSocial(true); renderSched(); renderHomeSocial();
        return;
      }
      if (act === 'now' || act === 'retry') {
        b.disabled = true;
        b.innerHTML = `${mi('send')}${act === 'now' ? 'Posting…' : 'Trying…'}`;
        postNow(p.id, act === 'retry');
        setTimeout(() => { panel.close(); loadSocial(true).then(renderSched); }, 700);
      }
    });
  }

  /**
   * Publish now, without holding the page: a video upload can take minutes.
   *
   * A planned post is MOVED to now first. Zernio may already be holding it for
   * its old time, and publishing over a booking would be the same video twice;
   * moving it gives the booking back (Scheduler.reschedule), and then it goes.
   */
  function postNow(id, retry) {
    const p = S.posts.find((x) => x.id === id);
    const run = retry ? window.api.scheduler.retry(id)
      : window.api.scheduler.update(id, { scheduledAt: new Date().toISOString() }).then(() => window.api.scheduler.publishAuto(id));
    C.island({ kind: 'info', spin: true, title: 'Posting…', sub: (p && p.title) || '', ms: 3500 });
    Promise.resolve(run).then(async () => {
      await loadSocial(true); renderSched(); renderHomeSocial();
      const now = S.posts.find((x) => x.id === id);
      if (now && now.status === 'posted') C.island({ kind: 'good', title: 'Posted', sub: now.title || '', action: { label: 'View', onClick: () => { go('scheduler'); S.tab = 'posted'; renderSched(); } } });
    }).catch(async (e) => {
      await loadSocial(true); renderSched();
      C.island({ kind: 'error', title: 'It did not post', sub: e.message || String(e), ms: 9000 });
    });
  }

  /* ------------------------------------------------------------ composer */

  /*
   * ONE POST, OR A BATCH. Opened from the scheduler's New post, from a finished
   * export on the home screen, and from a finished background job ("Post", or
   * "Schedule all"). One file is one post with its own caption; several are a
   * batch, spread out over the coming days at the hours people look.
   */
  function compose(o = {}) {
    if (!S.social) return;
    const edit = o.post || null;
    const st = {
      files: edit ? (edit.mediaPaths || []).slice() : (o.files || []).slice(),
      title: edit ? edit.title || '' : '',
      caption: edit ? edit.caption || '' : '',
      accountIds: edit ? (edit.accountIds || []).slice() : (S.loadedAt ? linked().map((a) => a.id) : null),
      when: edit ? new Date(edit.scheduledAt) : null,
      quick: edit ? 'pick' : 'best',
      spacing: 24,
      options: null,
      writing: false,
      batchCaps: {},
      music: null,          // { free: id | 'auto' } or { lib: id } — laid under the video before it posts
      musicMood: 'uplift',
      shelf: null, songs: [],
    };
    // the free shelf and the operator's own songs, for the Music section
    (async () => {
      try { st.shelf = await window.api.freeMusic.list(false); } catch (e) { st.shelf = null; }
      try { const l = await window.api.library.list(); st.songs = ((l && l.music) || []).filter((m) => !/^free:/.test(m.source || '')); } catch (e) { st.songs = []; }
      if (panel.el.isConnected && st.files.length) draw();
    })();
    const panel = C.openPanel({ id: 'csCompose', title: edit ? 'Edit post' : 'New post', cls: 'cp-compose' });
    const ensure = async () => {
      if (st.accountIds != null) return;
      await loadSocial(true);
      st.accountIds = linked().map((a) => a.id);   // all of them, to start with
      if (panel.el.isConnected) draw();
    };
    const picked = () => st.accountIds || [];
    const many = () => st.files.length > 1;

    function whenFor(kind) {
      const now = new Date();
      if (kind === 'now') return now;
      if (kind === 'hour') { const t = new Date(now.getTime() + 3600000); t.setMinutes(Math.ceil(t.getMinutes() / 5) * 5, 0, 0); return t; }
      if (kind === 'tonight') { const t = new Date(now); t.setHours(19, 0, 0, 0); if (t <= now) t.setDate(t.getDate() + 1); return t; }
      if (kind === 'tomorrow') { const t = new Date(now); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0); return t; }
      if (kind === 'best') return nextWindow(new Date(now.getTime() + 30 * 60000));
      return st.when || nextWindow(new Date(now.getTime() + 30 * 60000));
    }
    function chosenWhen() { return st.quick === 'pick' ? (st.when || whenFor('best')) : whenFor(st.quick); }

    function mediaBlock() {
      if (!st.files.length) {
        return '<div class="cs-pick">'
          + `<button type="button" class="cs-pick-btn" data-c="exports">${mi('film')}<b>Your exports</b><small>Shorts and videos the studio made</small></button>`
          + (phone()
            ? `<button type="button" class="cs-pick-btn" data-c="device">${mi('upload')}<b>From this phone</b><small>A video or picture from your camera roll</small></button>`
            : `<button type="button" class="cs-pick-btn" data-c="device">${mi('upload')}<b>From this computer</b><small>A video or picture from your files</small></button>`)
          + '</div>';
      }
      return `<div class="cs-media${many() ? ' many' : ''}">`
        + st.files.map((f, i) => `<div class="cs-m">`
          + `<span class="cs-m-pic" data-thumb="${escAttr(f)}">${isVideo(f) ? '<i class="cs-m-play"></i>' : ''}</span>`
          + (many() ? `<button type="button" class="cs-m-x" data-c="drop" data-i="${i}" aria-label="Leave this one out">×</button>` : '')
          + '</div>').join('')
        + `<button type="button" class="cs-m-add" data-c="change">${mi(many() ? 'plus' : 'refresh')}<span>${many() ? 'Add' : 'Change'}</span></button>`
        + '</div>';
    }
    function accountsBlock() {
      const acc = linked();
      if (!acc.length) {
        return `<button type="button" class="cs-connect-cta" data-c="connect">${PLAT_ORDER.map((p) => platMark(p, 'sm')).join('')}<span><b>Connect an account</b><small>TikTok, YouTube, Instagram or Facebook</small></span>${mi('chev-right')}</button>`;
      }
      return '<div class="cs-who">' + acc.map((a) => {
        const on = picked().includes(a.id);
        return `<button type="button" class="cs-who-a${on ? ' on' : ''}" data-c="acct" data-id="${escAttr(a.id)}" aria-pressed="${on}">`
          + `<span class="cs-ava">${a.picture ? `<img src="${escAttr(a.picture)}" alt="">` : `<b>${esc((a.name || '?').replace(/^@/, '').charAt(0).toUpperCase())}</b>`}${platMark(a.platform, 'badge')}<i class="cs-tick">${mi('check')}</i></span>`
          + `<span>${esc(a.name || a.platform)}</span></button>`;
      }).join('') + `<button type="button" class="cs-who-a add" data-c="connect"><span class="cs-ava">${mi('plus')}</span><span>Add</span></button></div>`;
    }
    function whenBlock() {
      if (many()) {
        const times = planTimes(st.files.length, st.spacing);
        return '<div class="cs-chips">'
          + [[24, 'One a day'], [12, 'Twice a day'], [6, 'Every 6 h'], [48, 'Every 2 days']].map(([h, l]) =>
            `<button type="button" class="cs-chip${st.spacing === h ? ' on' : ''}" data-c="spacing" data-h="${h}">${l}</button>`).join('')
          + '</div><ol class="cs-plan">' + times.map((t, i) => `<li><span class="cs-plan-pic" data-thumb="${escAttr(st.files[i])}"></span>`
            + `<span><b>${esc(titleFromFile(st.files[i]))}</b><small>${esc(whenLabel(t))}</small></span></li>`).join('') + '</ol>';
      }
      const w = chosenWhen();
      return '<div class="cs-chips">'
        + [['now', 'Now'], ['best', 'Best time'], ['hour', 'In an hour'], ['tonight', 'Tonight 7 pm'], ['tomorrow', 'Tomorrow 9 am'], ['pick', 'Pick…']].map(([k, l]) =>
          `<button type="button" class="cs-chip${st.quick === k ? ' on' : ''}" data-c="quick" data-k="${k}">${l}</button>`).join('')
        + '</div>'
        + (st.quick === 'pick' ? `<input type="datetime-local" class="cs-input cs-dt" data-c="dt" value="${localInput(w)}" min="${localInput(new Date())}">` : '')
        + `<div class="cs-when-is">${mi('clock')}<span>${st.quick === 'now' ? 'Posts as soon as you tap Post' : esc(whenLabel(w)) + ' · ' + esc(fromNow(w))}</span></div>`;
    }
    function textBlock() {
      if (many()) {
        const n = Object.keys(st.batchCaps).length;
        return '<label class="cs-label">Caption for every post</label>'
          + `<textarea class="cs-input cs-cap" data-c="caption" rows="4" placeholder="Leave it empty and each post gets its own — tap ✨ to write them">${esc(st.caption)}</textarea>`
          + `<button type="button" class="cs-ai" data-c="write-all"${st.writing ? ' disabled' : ''}>${mi('sparkles')}${st.writing ? esc(st.writing) : n ? `Captions written for ${n} of ${st.files.length} — write again` : `Write a caption for each (${st.files.length})`}</button>`;
      }
      return '<label class="cs-label">Title <small>— YouTube shows it; the others use the caption</small></label>'
        + `<input class="cs-input" data-c="title" maxlength="100" value="${escAttr(st.title)}" placeholder="What is this clip about?">`
        + '<label class="cs-label">Caption</label>'
        + `<textarea class="cs-input cs-cap" data-c="caption" rows="6" maxlength="2200" placeholder="Say what it is, who is speaking, and where. Hashtags at the end.">${esc(st.caption)}</textarea>`
        + `<div class="cs-cap-bar"><button type="button" class="cs-ai" data-c="write"${st.writing || !st.files.length ? ' disabled' : ''}>${mi('sparkles')}${st.writing ? esc(st.writing) : 'Write it for me'}</button><span class="cs-count">${st.caption.length}/2200</span></div>`
        + (st.options ? '<div class="cs-opts">' + st.options.map((op, i) => `<button type="button" class="cs-opt" data-c="opt" data-i="${i}"><b>${esc(op.label || 'Option ' + (i + 1))}</b><span>${esc(op.title || '')}</span></button>`).join('') + '</div>' : '');
    }

    /*
     * 🎵 MUSIC UNDER THE POST. Instagram and TikTok do not let any app add
     * their own library songs to a post, and a popular song baked in gets a
     * post muted or flagged — so a song that is free to post (or the
     * operator's own) is laid under the video on the server before it goes.
     */
    function musicBlock() {
      if (edit || !st.files.length || !st.files.every(isVideo)) return '';
      const F = st.shelf;
      const chip = (on, attrs, label) => `<button type="button" class="cs-chip${on ? ' on' : ''}" ${attrs}>${label}</button>`;
      const m = st.music || {};
      let html = '<div class="cs-chips">'
        + chip(!st.music, 'data-c="mus" data-v=""', 'No music')
        + (F && F.tracks && F.tracks.length ? chip(m.free === 'auto', 'data-c="mus" data-v="auto"', '✨ Pick a worship song for me') : '')
        + '</div>';
      if (F && F.tracks && F.tracks.length) {
        html += '<div class="cs-chips">' + F.moods.map((x) => chip(st.musicMood === x.id, `data-c="musmood" data-v="${escAttr(x.id)}"`, esc(x.name))).join('') + '</div>'
          + '<div class="cs-chips">' + F.tracks.filter((t) => t.mood === st.musicMood).map((t) => chip(m.free === t.id, `data-c="mus" data-v="${escAttr(t.id)}"`, '♪ ' + esc(t.title))).join('') + '</div>';
      }
      if (st.songs.length) html += '<label class="cs-label">Your songs <small>— only ones you have the rights to post</small></label><div class="cs-chips">'
        + st.songs.slice(0, 10).map((x) => chip(m.lib === x.id, `data-c="muslib" data-v="${escAttr(x.id)}"`, '🎵 ' + esc(String(x.name || 'song').slice(0, 24)))).join('') + '</div>';
      html += `<p class="cs-hint">${st.music ? 'Laid softly under your video — it dips whenever someone speaks. ' : ''}Free songs are safe to post (no muting or copyright flags); the artist credit is added to your caption by itself. Instagram’s and TikTok’s own song library can’t be added by any app.</p>`;
      return html;
    }

    function draw() {
      panel.setTitle(edit ? 'Edit post' : many() ? `Schedule ${st.files.length} posts` : 'New post');
      panel.body.innerHTML = '<div class="cs-form">'
        + `<section class="cs-sec"><h4>${many() ? 'Videos' : 'Video or picture'}</h4>${mediaBlock()}</section>`
        + (st.files.length ? `<section class="cs-sec">${textBlock()}</section>` : '')
        + (musicBlock() ? `<section class="cs-sec"><h4>Music</h4>${musicBlock()}</section>` : '')
        + `<section class="cs-sec"><h4>Post to</h4>${accountsBlock()}</section>`
        + `<section class="cs-sec"><h4>When</h4>${whenBlock()}</section>`
        + '</div>';
      const ready = st.files.length && picked().length;
      const label = edit ? 'Save changes' : many() ? `Schedule ${st.files.length} posts` : st.quick === 'now' ? 'Post now' : 'Schedule post';
      panel.foot.innerHTML = `<button type="button" class="cs-btn primary wide" data-c="go"${ready ? '' : ' disabled'}>${mi(st.quick === 'now' && !many() ? 'send' : 'calendar')}${label}</button>`
        + (ready ? '' : `<p class="cs-hint">${!st.files.length ? 'Choose a video first.' : 'Choose at least one account to post to.'}</p>`);
      paintThumbs(panel.body);
    }

    async function pickExports() {
      await loadExports();
      const sub = C.openPanel({ id: 'csPickExports', title: 'Your exports', cls: 'cp-pick' });
      const files = S.exports;
      const chosen = new Set();
      const drawPick = () => {
        sub.body.innerHTML = files.length
          ? '<div class="cs-grid">' + files.map((f) => `<button type="button" class="cs-g${chosen.has(f.path) ? ' on' : ''}" data-f="${escAttr(f.path)}">`
            + `<span class="cs-g-pic" data-thumb="${escAttr(f.path)}"></span><span class="cs-g-name">${esc(titleFromFile(f.path))}</span><i class="cs-tick">${mi('check')}</i></button>`).join('') + '</div>'
          : `<div class="cs-empty"><div class="cs-empty-art solo">${mi('film')}</div><b>No exports yet</b><p>Shorts and videos you export from the Video Studio appear here.</p></div>`;
        sub.foot.innerHTML = `<button type="button" class="cs-btn primary wide" data-done${chosen.size ? '' : ' disabled'}>${chosen.size > 1 ? `Use these ${chosen.size}` : 'Use this one'}</button>`;
        paintThumbs(sub.body);
      };
      sub.body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-f]'); if (!b) return;
        const f = b.dataset.f;
        if (chosen.has(f)) chosen.delete(f); else chosen.add(f);
        drawPick();
      });
      sub.foot.addEventListener('click', (e) => {
        if (!e.target.closest('[data-done]') || !chosen.size) return;
        const add = Array.from(chosen);
        st.files = edit ? add.slice(0, 1) : (st.files.length ? Array.from(new Set(st.files.concat(add))) : add);
        if (!many() && !st.title) st.title = titleFromFile(st.files[0]);
        sub.close();
        draw();
      });
      drawPick();
    }
    async function pickDevice() {
      const got = await C.chooseFromDevice(!edit, ['.mp4', '.mov', '.m4v', '.webm', '.jpg', '.jpeg', '.png']);
      if (!got) return;
      const add = Array.isArray(got) ? got : [got];
      st.files = edit ? add.slice(0, 1) : (st.files.length ? Array.from(new Set(st.files.concat(add))) : add);
      if (!many() && !st.title) st.title = titleFromFile(st.files[0]);
      draw();
    }

    async function writeOne(file) {
      const jobId = 'copy_' + Date.now();
      return window.api.social.suggestCopy({ mediaPath: file, kind: isVideo(file) ? 'video' : 'image', listen: true, jobId });
    }

    panel.body.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.c === 'title') st.title = t.value;
      if (t.dataset.c === 'caption') {
        st.caption = t.value;
        const n = panel.body.querySelector('.cs-count'); if (n) n.textContent = `${t.value.length}/2200`;
      }
    });
    panel.body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.c === 'dt' && t.value) { st.when = new Date(t.value); draw(); }
    });
    panel.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-c]'); if (!b || b.disabled) return;
      const c = b.dataset.c;
      if (c === 'exports') return pickExports();
      if (c === 'change') {
        if (many()) return pickExports();
        st.files = []; return draw();          // one file: offer both places again
      }
      if (c === 'device') return pickDevice();
      if (c === 'drop') { st.files.splice(+b.dataset.i, 1); return draw(); }
      if (c === 'connect') {
        return openConnect(() => {
          if (!panel.el.isConnected) return;
          st.accountIds = Array.from(new Set(picked().concat(linked().map((a) => a.id))));
          draw();
        });
      }
      if (c === 'acct') {
        const id = b.dataset.id;
        st.accountIds = picked().includes(id) ? picked().filter((x) => x !== id) : picked().concat(id);
        return draw();
      }
      if (c === 'quick') {
        st.quick = b.dataset.k;
        if (st.quick === 'pick' && !st.when) st.when = whenFor('best');
        return draw();
      }
      if (c === 'spacing') { st.spacing = +b.dataset.h; return draw(); }
      if (c === 'mus') { st.music = b.dataset.v ? { free: b.dataset.v } : null; return draw(); }
      if (c === 'muslib') { st.music = { lib: b.dataset.v }; return draw(); }
      if (c === 'musmood') { st.musicMood = b.dataset.v; return draw(); }
      if (c === 'opt') {
        const op = st.options && st.options[+b.dataset.i];
        if (op) { st.title = op.title || st.title; st.caption = op.caption || st.caption; draw(); }
        return;
      }
      if (c === 'write') {
        st.writing = 'Listening to the clip…';
        draw();
        try {
          const out = await writeOne(st.files[0]);
          st.options = (out && out.options) || null;
          st.title = (out && out.title) || st.title;
          st.caption = (out && out.caption) || st.caption;
          C.island({ kind: 'good', title: 'Caption written', sub: out && out.wroteBy === 'rules' ? 'From the clip’s words — tap another style to swap' : 'Tap a style below to try another', ms: 3500 });
        } catch (er) { C.island({ kind: 'error', title: 'Could not write it', sub: er.message }); }
        st.writing = false;
        return draw();
      }
      if (c === 'write-all') {
        for (let i = 0; i < st.files.length; i++) {
          if (!panel.el.isConnected) return;
          st.writing = `Writing ${i + 1} of ${st.files.length}…`;
          draw();
          try {
            const out = await writeOne(st.files[i]);
            if (out) st.batchCaps[st.files[i]] = { title: out.title, caption: out.caption };
          } catch (er) { /* that one keeps the shared caption */ }
        }
        st.writing = false;
        return draw();
      }
      if (c === 'go') return submit(b);
    });
    panel.foot.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c="go"]');
      if (b && !b.disabled) submit(b);
    });

    /* the chosen song laid under each video (on the server) — the files that will post, and the caption credit */
    async function withMusic(btn) {
      if (!st.music || edit) return null;
      let free = st.music.free || null;
      if (free === 'auto') {
        // the next worship song not used lately (see freeDeal)
        const next = freeDeal((st.shelf && st.shelf.tracks) || [], 'uplift')[0];
        free = next ? next.id : null;
        if (!free) return null;
        freeUsed(free);
      }
      const out = { files: [], credit: '' };
      for (let i = 0; i < st.files.length; i++) {
        btn.innerHTML = `${mi('music')}Adding the music${st.files.length > 1 ? ` (${i + 1} of ${st.files.length})` : ''}…`;
        const r = await window.api.social.withMusic({ mediaPath: st.files[i], free: free || undefined, libId: st.music.lib || undefined });
        out.files.push(r.path);
        out.credit = r.credit || out.credit;
      }
      return out;
    }
    const withCredit = (caption, credit) => (credit && !String(caption || '').includes(credit) ? [String(caption || '').trim(), credit].filter(Boolean).join('\n\n') : caption);

    async function submit(btn) {
      btn.disabled = true;
      const accs = linked().filter((a) => picked().includes(a.id));
      const platforms = Array.from(new Set(accs.map((a) => a.platform)));
      try {
        let mus = null;
        try { mus = await withMusic(btn); } catch (er) {
          C.island({ kind: 'error', title: 'The music could not be added', sub: (er && er.message) || '', ms: 6000 });
          btn.disabled = false; btn.innerHTML = `${mi('calendar')}Try again`;
          return;
        }
        const fileAt = (i) => (mus ? mus.files[i] : st.files[i]);
        const credit = mus ? mus.credit : '';
        if (edit) {
          await window.api.scheduler.update(edit.id, {
            title: st.title.trim() || titleFromFile(st.files[0]), caption: st.caption,
            mediaPaths: st.files.slice(0, 1), accountIds: accs.map((a) => a.id), platforms,
            scheduledAt: chosenWhen().toISOString(),
          });
          C.island({ kind: 'good', title: 'Post updated', sub: whenLabel(chosenWhen()) });
        } else if (many()) {
          const times = planTimes(st.files.length, st.spacing);
          for (let i = 0; i < st.files.length; i++) {
            btn.innerHTML = `${mi('calendar')}Booking ${i + 1} of ${st.files.length}…`;
            const f = st.files[i];
            const own = st.batchCaps[f] || {};
            await window.api.scheduler.add({
              title: own.title || titleFromFile(f),
              caption: withCredit(st.caption.trim() ? st.caption : (own.caption || titleFromFile(f)), credit),
              mediaPaths: [fileAt(i)], accountIds: accs.map((a) => a.id), platforms,
              scheduledAt: times[i].toISOString(),
            });
          }
          C.island({ kind: 'good', title: `${st.files.length} posts scheduled`, sub: `First one ${whenLabel(times[0])}` });
        } else {
          const when = chosenWhen();
          const rec = await window.api.scheduler.add({
            title: st.title.trim() || titleFromFile(st.files[0]), caption: withCredit(st.caption, credit),
            mediaPaths: [fileAt(0)], accountIds: accs.map((a) => a.id), platforms,
            scheduledAt: when.toISOString(),
          });
          if (st.quick === 'now' && rec && rec.id) postNow(rec.id);
          else C.island({ kind: 'good', title: 'Post scheduled', sub: `${whenLabel(when)} · ${accs.map((a) => (PLAT[a.platform] || {}).name || a.platform).join(', ')}` });
        }
        panel.close();
        if (S.view !== 'scheduler') go('scheduler');
        S.tab = 'upcoming';
        await loadSocial(true);
        renderSched(); renderHomeSocial();
      } catch (er) {
        btn.disabled = false;
        draw();
        C.island({ kind: 'error', title: 'It was not scheduled', sub: er.message || String(er), ms: 8000 });
      }
    }

    if (st.files.length === 1 && !st.title) st.title = titleFromFile(st.files[0]);
    draw();
    ensure();
    return panel;
  }

  /* ------------------------------------------------------------- connect */

  /*
   * LINKING AN ACCOUNT, FROM A PHONE. Through Zernio: free, its developer apps
   * are already approved by all four platforms, and it publishes a booked post
   * itself — so a post goes out at its time whether or not anything of ours is
   * switched on. The church pastes a free key once; each account is then one
   * sign-in on that platform's own page.
   */
  function openConnect(after) {
    const panel = C.openPanel({ id: 'csConnect', title: 'Accounts', cls: 'cp-connect', onClose: () => { stopClaim(); if (after) after(); } });
    let claiming = null;   // { platform, timer, until }
    function stopClaim() { if (claiming) { clearInterval(claiming.timer); claiming = null; } }
    const label = (p) => (PLAT[p] || {}).name || p;

    function draw(msg) {
      const keyRow = (k, title, sub) => `<div class="cs-key${S.keys[k] ? ' set' : ''}">`
        + `<div class="cs-key-tx"><b>${title}</b><small>${S.keys[k] ? 'Saved on the studio machine — it never comes back to this phone' : sub}</small></div>`
        + (S.keys[k] ? `<button type="button" class="cs-mini" data-k="edit-${k}">Replace</button>` : '')
        + `<div class="cs-key-in${S.keys[k] ? ' hidden' : ''}" data-key-row="${k}"><input class="cs-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the API key" data-key="${k}">`
        + `<button type="button" class="cs-btn primary" data-k="save-${k}">Save</button></div></div>`;
      const rows = PLAT_ORDER.map((p) => {
        const a = linked().find((x) => x.platform === p);
        const needs = (p === 'facebook' || p === 'instagram') ? (S.keys.zoFb || S.keys.zo) : S.keys.zo;
        const busy = claiming && claiming.platform === p;
        return `<div class="cs-plat${a ? ' linked' : ''}" data-plat="${p}">${platMark(p, 'lg')}`
          + `<div class="cs-plat-tx"><b>${label(p)}</b><small>${a ? esc(a.name) : busy ? 'Waiting for you to finish signing in…' : 'Not connected'}</small></div>`
          + (a ? `<button type="button" class="cs-mini" data-k="unlink" data-id="${escAttr(a.id)}">Remove</button>`
            : busy ? (claiming.url ? `<a class="cs-mini accent" href="${escAttr(claiming.url)}" target="_blank" rel="noopener">${mi('external')}Open</a>` : '<span class="cs-spin"></span>')
              : `<button type="button" class="cs-mini accent" data-k="link" data-p="${p}"${needs ? '' : ' disabled'}>Connect</button>`)
          + '</div>';
      }).join('');
      const keys = '<h4 class="cs-h4">Zernio key</h4>'
        + (!S.keys.zo ? '<ol class="cs-steps"><li>Make a free account at <a href="https://zernio.com" target="_blank" rel="noopener">zernio.com</a> — it is what posts for you, even with this app closed.</li>'
          + '<li>In Zernio, open <b>Settings → API keys</b> and copy a key.</li><li>Paste it here, then tap Connect beside each account.</li></ol>' : '')
        + keyRow('zo', 'Main key', 'For TikTok and YouTube (and Facebook and Instagram if you only have one)')
        + keyRow('zoFb', 'Second key (optional)', 'Zernio’s free plan links two accounts per key — a second free key covers Facebook and Instagram');
      const plats = `<h4 class="cs-h4 first">Your accounts</h4><div class="cs-plats">${rows}</div>`;
      panel.body.innerHTML = (msg ? `<p class="cs-note ${msg.kind || ''}">${esc(msg.text)}</p>` : '')
        // no key yet: that is the first thing to do, so it comes first
        + (S.keys.zo ? plats + keys : keys.replace('cs-h4', 'cs-h4 first') + plats);
    }

    async function claim() {
      if (!claiming) return;
      const p = claiming.platform;
      try {
        const r = await window.api.social.linkClaim(p);
        if (r && r.account) {
          stopClaim();
          await loadSocial(true);
          draw({ kind: 'good', text: `${label(p)} is connected as ${r.account.name}.` });
          C.island({ kind: 'good', title: `${label(p)} connected`, sub: r.account.name });
          renderSched(); renderHomeSocial();
          return;
        }
      } catch (e) { /* keep waiting */ }
      if (claiming && Date.now() > claiming.until) { stopClaim(); draw({ kind: 'warn', text: `${label(p)} was not linked — tap Connect to try again.` }); }
    }
    const onBack = () => { if (!document.hidden && claiming) claim(); };
    document.addEventListener('visibilitychange', onBack);
    const origClose = panel.onClose;
    panel.onClose = () => { document.removeEventListener('visibilitychange', onBack); if (origClose) origClose(); };

    panel.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-k]'); if (!b || b.disabled) return;
      const k = b.dataset.k;
      if (k.startsWith('edit-')) {
        const row = panel.body.querySelector(`[data-key-row="${k.slice(5)}"]`);
        if (row) { row.classList.remove('hidden'); const i = row.querySelector('input'); if (i) i.focus(); }
        return;
      }
      if (k.startsWith('save-')) {
        const key = k.slice(5);
        const input = panel.body.querySelector(`input[data-key="${key}"]`);
        const v = input ? input.value.trim() : '';
        if (!v) { if (input) input.focus(); return; }
        b.disabled = true;
        try {
          S.keys = await window.api.social.setKeys(key === 'zo' ? { zoApiKey: v } : { zoApiKeyFb: v });
          draw({ kind: 'good', text: 'Key saved. Now tap Connect beside an account.' });
        } catch (er) { b.disabled = false; draw({ kind: 'bad', text: er.message }); }
        return;
      }
      if (k === 'unlink') {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Sure?'; return; }
        try { await window.api.social.unlink(b.dataset.id); } catch (er) {}
        await loadSocial(true); draw(); renderSched(); renderHomeSocial();
        return;
      }
      if (k === 'link') {
        const p = b.dataset.p;
        stopClaim();
        b.disabled = true; b.textContent = 'Opening…';
        let r;
        try { r = await window.api.social.linkStart(p); }
        catch (er) { draw({ kind: 'bad', text: er.message }); return; }
        if (r && r.account) {
          await loadSocial(true);
          draw({ kind: 'good', text: `${label(p)} is connected as ${r.account.name}.` });
          renderSched(); renderHomeSocial();
          return;
        }
        claiming = { platform: p, url: r && r.url, until: Date.now() + 10 * 60000, timer: setInterval(claim, 4000) };
        // A tap may open it straight away; if the phone blocks that, the row's
        // own Open button (a real link) does it.
        let opened = null;
        try { opened = window.open(r.url, '_blank', 'noopener'); } catch (er) { opened = null; }
        draw({ kind: '', text: opened ? `Sign in to ${label(p)} on the page that opened, then come back here.` : `Tap Open to sign in to ${label(p)}, then come back here.` });
      }
    });

    draw();
    loadSocial(true).then(() => draw());
    return panel;
  }

  /* ------------------------------------------------------- server links */

  // "Open this page" from the studio machine (a connect flow it started itself).
  C.onEvent('open:url', (d) => {
    if (!d || !/^https:\/\//i.test(d.url || '')) return;
    C.island({ kind: 'info', sticky: true, title: 'Open the sign-in page', sub: d.url.replace(/^https:\/\//, '').slice(0, 48), action: { label: 'Open', onClick: () => window.open(d.url, '_blank', 'noopener') } });
  });
  C.onEvent('scheduler:changed', () => { loadSocial(true).then(() => { renderSched(); renderHomeSocial(); }); });
  C.onEvent('scheduler:notice', (d) => {
    if (!d || !d.title) return;
    const bad = /fail|⚠/i.test(d.title);
    C.island({ kind: bad ? 'error' : 'good', title: C.toastText(d.title), sub: C.toastText(d.body || ''), ms: 8000,
      action: S.social ? { label: 'View', onClick: () => { S.tab = bad ? 'failed' : 'posted'; go('scheduler'); } } : null });
  });

  /* ----------------------------------------------------------- the start */

  /** Called by cloud-boot.js once the studio is signed in. */
  function start(hello) {
    if (S.started) return;
    S.started = true;
    S.social = !hello || hello.social !== false;
    C.hello = hello || null;
    // Home lives in the studio's top bar on a phone, where Files used to be
    // (the home screen has Files now).
    const bar = $('#cloudBar .cloud-bar-actions') || $('#cloudBar');
    if (bar && !$('#cloudHomeBtn')) {
      const h = document.createElement('button');
      h.id = 'cloudHomeBtn';
      h.className = 'cloud-chip cloud-home-btn';
      h.setAttribute('aria-label', 'Home');
      h.title = 'Home — Video Studio and Social Scheduler';
      h.innerHTML = `${mi('home', 'mi-l')}<span class="cloud-chip-tx">Home</span>`;
      h.addEventListener('click', () => go('home'));
      bar.insertBefore(h, bar.firstChild);
      // …and back to the Projects screen, to pick another (the open one is saved on the way)
      const pj = document.createElement('button');
      pj.id = 'cloudProjBtn';
      pj.className = 'cloud-chip cloud-home-btn cloud-proj-btn';
      pj.setAttribute('aria-label', 'Projects');
      pj.title = 'Projects — pick another video to edit';
      pj.innerHTML = `${mi('layers', 'mi-l')}<span class="cloud-chip-tx">Projects</span>`;
      pj.addEventListener('click', () => go('projects'));
      h.after(pj);
    }
    C.jobListeners.push((list) => { if (S.view === 'home') renderHomeJobs(list); });
    // a video deleted in Files leaves the home screen too — and an edit whose
    // video went with it is no longer something to "pick up"
    if (C.fileListeners) C.fileListeners.push((d) => {
      const gone = new Set(d.deleted || []);
      S.exports = S.exports.filter((f) => !gone.has(f.path));
      if (d.autosaveCleared) S.resumeName = '';
      if (S.view === 'home') { renderHome(); renderHomeReady(); }
    });
    const want = String(location.hash || '').replace('#', '');
    go(want === 'studio' || want === 'scheduler' || want === 'projects' ? want : 'home');
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (S.view === 'scheduler') loadSocial(true).then(renderSched);
      if (S.view === 'home') renderHome(true);
      if (S.view === 'projects') renderProjectsView();
    });
  }


  /* ================================ AI MONTAGE ================================
   *
   * A pile of videos and photos from the phone → one edit cut to the operator's
   * own song, directed by the strongest AI the server has (see montage.js).
   * The result opens in the Video Studio with the song on the music lane and
   * the words as text boxes, so captions, restyling and export are the studio's
   * own — nothing here re-invents them.
   */
  /*
   * ✨ PICK FOR ME, NOT THE SAME SONG EVERY TIME. Songs of the mood are dealt
   * like cards: one not used lately comes first, and the whole mood is gone
   * through before any comes round again (remembered on this phone). Returns
   * the order to try them in, so a song that cannot be fetched gives way to
   * the next instead of to no music.
   */
  const FREE_RECENT = 'mw-free-recent';
  function freeDeal(tracks, mood) {
    const all = tracks || [];
    const pool = all.filter((t) => t.mood === mood);
    const list = pool.length ? pool : all.slice();
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem(FREE_RECENT) || '[]') || []; } catch (e) { recent = []; }
    const shuffled = list.map((t) => [Math.random(), t]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    // least lately used first: never used, then used longest ago
    const age = (t) => { const i = recent.indexOf(t.id); return i < 0 ? -1 : i; };
    return shuffled.sort((a, b) => (age(a) < 0 ? -1 : 0) - (age(b) < 0 ? -1 : 0) || (age(b) - age(a)));
  }
  function freeUsed(id) {
    try {
      const recent = (JSON.parse(localStorage.getItem(FREE_RECENT) || '[]') || []).filter((x) => x !== id);
      recent.unshift(id);
      localStorage.setItem(FREE_RECENT, JSON.stringify(recent.slice(0, 60)));
    } catch (e) { /* private window: still a random pick */ }
  }
  /** A free song onto the server: the one asked for, or (auto) the next in the deal that can be fetched. */
  async function freeFetch(id, tracks, mood, onTry) {
    const tries = id === 'auto' ? freeDeal(tracks, mood).slice(0, 4).map((t) => t.id) : [id];
    let last = null;
    for (const t of tries) {
      if (onTry) onTry((tracks.find((x) => x.id === t) || {}).title || '');
      try { const song = await window.api.freeMusic.get(t); freeUsed(t); return song; } catch (e) { last = e; }
    }
    throw last || new Error('No song could be fetched right now.');
  }
  C._freeDeal = { deal: freeDeal, used: freeUsed }; // for test/phone-montage-talk
  /*
   * ►► "WHAT'S IT ABOUT?" ◄◄ One clean box, and under it one row of ideas to
   * tap (swiped sideways): the occasion, and the speaker read off a video's
   * own file name. A tap adds the words to the box, a second tap takes them
   * out. A speaker or occasion that is in the box also goes to the server as
   * such (montage.js cleanAbout), so the name is spelt as written — in the
   * captions too.
   */
  const MT_OCCASIONS = [['Sunday service', '⛪ Sunday service'], ['Youth service', '🔥 Youth'], ['Conference', '🎤 Conference'], ['Worship night', '🙌 Worship night'],
    ['Outreach', '📣 Outreach'], ['Testimony', '💬 Testimony'], ['Camp', '🏕 Camp'], ['Baptism', '💧 Baptism'], ['Special event', '🎉 Special event']];
  const mtHas = (text, x) => String(text || '').toLowerCase().includes(String(x).toLowerCase());
  /** the box with an idea added (or, when it is already there, taken out) */
  function mtToggleIdea(text, idea) {
    const t = String(text || '');
    if (mtHas(t, idea)) {
      const i = t.toLowerCase().indexOf(idea.toLowerCase());
      return (t.slice(0, i) + t.slice(i + idea.length)).replace(/^[\s—,·-]+|[\s—,·-]+$/g, '').replace(/\s*—\s*—\s*/g, ' — ').trim();
    }
    const base = t.replace(/[\s—,·-]+$/, '');
    return base ? `${base} — ${idea}` : idea;
  }
  /** what the box says, in parts the server can use: a guessed speaker or an occasion written in it */
  function mtAboutOf(text) {
    const about = {};
    const who = mtSpeakerGuesses().find((g) => mtHas(text, g));
    if (who) about.speaker = who;
    const occ = MT_OCCASIONS.find(([v]) => mtHas(text, v));
    if (occ) about.occasion = occ[0];
    return about;
  }
  /* "Teaching with Bishop David Richman.mp4" → "Bishop David Richman": a titled name in a file's name */
  const MT_TITLES = 'Pastor|Pst|Bishop|Archbishop|Rev(?:erend)?|Dr|Apostle|Prophet(?:ess)?|Evangelist|Minister|Elder|Deacon(?:ess)?|Baba|Mummy|Daddy';
  // words a file's name goes on with after the name — never part of it
  const MT_NOT_NAME = /^(live|stream|service|sermon|message|teaching|preaching|part|pt|sunday|monday|tuesday|wednesday|thursday|friday|saturday|night|day|morning|evening|full|hd|clip|video|worship|conference|special|session|at|on|in|the|and|with|of|vol|episode|ep|final|edit|copy)$/i;
  function mtSpeakerGuesses() {
    const out = [];
    const re = new RegExp(`(?:^|[^\\p{L}])(${MT_TITLES})\\.?\\s+((?:\\p{Lu}[\\p{L}'’]*\\s*){1,3})`, 'giu');
    for (const it of MT.items) {
      const n = String((it.file && it.file.name) || it.name || '').replace(/\.[^.]+$/, '').replace(/[_+]+/g, ' ').replace(/\s+-\s+|-/g, ' ');
      for (const m of n.matchAll(re)) {
        const title = m[1].charAt(0).toUpperCase() + m[1].slice(1);
        const parts = [];
        for (const w of m[2].trim().split(/\s+/)) { if (MT_NOT_NAME.test(w) || !/^\p{Lu}/u.test(w)) break; parts.push(w); }
        if (!parts.length) continue;
        const name = title + ' ' + parts.join(' ');
        if (!out.includes(name)) out.push(name);
      }
    }
    return out.slice(0, 3);
  }
  function mtAboutHtml() {
    const ideas = mtSpeakerGuesses().map((g) => [g, '🎤 ' + g]).concat(MT_OCCASIONS);
    return `<section class="mt-sec"><h3>What’s it about? <small>optional</small></h3>
        <textarea id="mtBrief" class="mt-brief" rows="2" maxlength="400" placeholder="e.g. Bishop David Richman at The Power House — faith over fear. Join us Sundays at 10am">${esc(MT.brief)}</textarea>
        <div class="mt-ideas">${ideas.map(([v, l]) => `<button type="button" class="mt-chip${mtHas(MT.brief, v) ? ' on' : ''}" data-mt-idea="${escAttr(v)}">${esc(l)}</button>`).join('')}</div></section>`;
  }
  const MT = { items: [], song: null, songFile: null, style: 'hype', len: 30, custom: 120, aspect: '9:16', keep: true, brief: '', busy: false, order: 'ai', caps: true, mode: 'talk', free: null, freeMood: null, voice: '' };
  /* which free mood suits which style, for "✨ Pick for me" */
  const MT_MOOD_OF = { hype: 'hype', fun: 'hype', cinematic: 'epic', worship: 'uplift', emotional: 'calm' };
  /*
   * ►► TWO KINDS OF EDIT. ◄◄ A music montage is cut from what the clips LOOK
   * like, to a song. A viral talk edit is cut from what is SAID: the AI hears
   * every video, picks the strongest lines from any of them, puts the hook
   * first and builds the story, then cuts it with jump zooms, a cinematic
   * grade, B-roll from the photos and captions lit up word by word
   * (montage.js makeTalk).
   */
  const MT_MODES = [['talk', '🔥 Viral Montage'], ['music', '🎵 AI Standard Montage']];   // the Viral Montage first (on the left)
  const MT_TALK_LENS = [[15, '15s'], [30, '30s'], [45, '45s'], [60, '60s'], ['custom', 'Custom']];
  const MT_ORDERS = [['ai', '✨ AI decides'], ['mine', '📌 My order']];
  const MT_STYLES = [['hype', 'Hype'], ['worship', 'Worship'], ['emotional', 'Emotional'], ['cinematic', 'Cinematic'], ['fun', 'Fun']];
  const MT_LENS = [['all', 'Use everything'], [15, '15s'], [30, '30s'], [45, '45s'], [60, '60s'], ['custom', 'Custom']];
  const MT_ASPECTS = [['9:16', 'Reels / TikTok'], ['1:1', 'Square'], ['4:5', 'Feed'], ['16:9', 'YouTube']];

  async function openMontage() {
    if (MT.busy && MT.panel && document.body.contains(MT.panel.el)) return;
    const panel = C.openPanel({ id: 'cloudMontage', title: 'AI Montage', cls: 'cp-montage', onClose: () => { mtPreviewStop(); if (!MT.busy) mtRelease(); } });
    MT.panel = panel;
    let who = null, lib = null;
    try { who = await window.api.montage.status(); } catch (e) { who = null; }
    try { lib = await window.api.library.list(); } catch (e) { lib = null; }
    MT.lib = ((lib && lib.music) || []).filter((m) => !/^free:/.test(m.source || ''));
    try { MT.freeList = await window.api.freeMusic.list(false); } catch (e) { MT.freeList = null; }
    // it opens on the Viral Montage: music under it unless the operator says otherwise (as picking the tab does)
    if (MT.mode === 'talk' && !MT.song && !MT.songFile && !MT.free && MT.freeList && MT.freeList.tracks && MT.freeList.tracks.length) MT.free = 'auto';
    MT.who = who;
    mtPaint();
  }

  function mtRelease() {
    for (const it of MT.items) { try { URL.revokeObjectURL(it.url); } catch (e) {} }
  }

  function mtPaint() {
    const p = MT.panel; if (!p) return;
    const esc = C.esc, attr = C.escAttr;
    const who = MT.who || {};
    const brain = who.director === 'claude' ? `Directed by <b>Claude</b> (${esc(who.model || 'Opus')}), looking at every shot`
      : who.director === 'groq' ? 'Directed by Groq AI (free), looking at every shot. <small>A Claude key on the server gives the very best edits.</small>'
        : 'Directed by the studio’s own editor. <small>Add a Claude key on the server for AI-directed edits.</small>';
    const chips = (list, cur, key) => list.map(([v, label]) => `<button type="button" class="mt-chip${String(cur) === String(v) ? ' on' : ''}" data-mt-${key}="${attr(v)}">${esc(label)}</button>`).join('');
    const openPath = window.VideoEditor && (window.VideoEditor.montagePath || window.VideoEditor.currentPath) ? (window.VideoEditor.montagePath || window.VideoEditor.currentPath)() : null;
    const openIsMontage = !!openPath && /(^|[\\/])montage-[^\\/]*\.mp4$/i.test(openPath);
    const talk = MT.mode === 'talk';
    if (talk && MT.len === 'all') MT.len = 30;
    const nVid = MT.items.filter((it) => it.kind === 'video').length;
    const ready = talk ? nVid >= 1 : MT.items.length >= 2;
    p.body.innerHTML = `
      <section class="mt-sec"><h3>What kind of edit?</h3><div class="mt-row">${chips(MT_MODES, MT.mode, 'mode')}</div>
        <small class="mt-hint">${talk
    ? 'Add one or more videos of someone speaking. The AI listens to every word, picks the lines that stop the scroll — from any of the videos — puts the strongest first and builds the story, then cuts it with jump zooms, a cinematic look, flashes, B-roll from your photos and captions lit up word by word.'
    : 'Clips and photos cut to music — the AI picks the best-looking moments and cuts them on the beat.'}</small></section>
      ${openIsMontage ? `<button type="button" class="me-banner" data-mt-rearrange>✏️ <span><b>Rearrange the montage that’s open</b><small>Move clips and photos, then remake it</small></span></button>` : ''}
      <p class="mt-lead">${mi('sparkles')} ${brain}</p>
      <section class="mt-sec"><h3>${talk ? 'Your videos' : 'Your clips &amp; photos'} <small>${MT.items.length ? MT.items.length + ' added' : talk ? 'add 1 or more videos (photos become B-roll)' : 'add 2 or more'}</small></h3>
        <div class="mt-grid${MT.order === 'mine' ? ' mt-ordered' : ''}">${MT.items.map((it, i) => `<div class="mt-tile" data-i="${i}">${it.kind === 'image'
          ? `<img src="${attr(it.url)}" alt="" draggable="false" />` : (it.poster ? `<img src="${attr(it.poster)}" alt="" draggable="false" />` : '<span class="mt-load"></span>') + `<span class="mt-dur">▶${it.secs ? ' ' + Math.floor(it.secs / 60) + ':' + String(Math.round(it.secs % 60)).padStart(2, '0') : ''}</span>`}
          ${MT.order === 'mine' ? `<span class="mt-num">${i + 1}</span>` : ''}
          <button type="button" class="mt-x" data-mt-del="${i}" aria-label="Remove">✕</button></div>`).join('')}
          <button type="button" class="mt-add" data-mt="add">${mi('plus')}<span>Add</span></button>
          <button type="button" class="mt-add mt-add-files" data-mt="addsrv">${mi('folder')}<span>From your files</span></button></div>
      </section>
      <section class="mt-sec"${talk ? ' hidden' : ''}><h3>Order</h3><div class="mt-row">${chips(MT_ORDERS, MT.order, 'order')}</div>
        <small class="mt-hint">${MT.order === 'mine' ? 'The clips play in this order. Hold a tile and drag it to move it — a photo goes over the video before it.' : 'The AI puts the strongest moment first and orders the rest for the story. Hold and drag a tile to set your own order.'}</small></section>
      ${talk ? `<section class="mt-sec"><h3>Narrator <small>optional · tap ▶ to hear</small></h3>
        ${who.voiceover && who.voiceover.installed ? mtVoiceHtml(who.voiceover.voices || [])
    : '<small class="mt-hint">The narrator voice is not installed on this server yet — update the server to add it.</small>'}</section>` : ''}
      <section class="mt-sec"><h3>${talk ? 'Background music' : 'Music'} <small>tap ▶ to listen</small></h3>
        ${mtMusicHtml()}
        <label class="mt-toggle"${talk ? ' hidden' : ''}><input type="checkbox" id="mtKeep" ${MT.keep ? 'checked' : ''}/> <span>Keep the clips’ own sound${MT.song || MT.songFile ? ' under the music' : ''}</span></label>
      </section>
      <section class="mt-sec"><h3>Style</h3><div class="mt-row">${chips(MT_STYLES, MT.style, 'style')}</div></section>
      <section class="mt-sec"><h3>Length</h3><div class="mt-row">${chips(talk ? MT_TALK_LENS : MT_LENS, MT.len, 'len')}</div>
        ${MT.len === 'custom' ? `<div class="mt-custom"><label><input type="number" id="mtMin" inputmode="numeric" min="0" max="10" value="${Math.floor(MT.custom / 60)}" /><span>min</span></label>
          <label><input type="number" id="mtSec" inputmode="numeric" min="0" max="59" step="5" value="${MT.custom % 60}" /><span>sec</span></label></div>` : ''}
        <small class="mt-hint">${talk ? 'About this much speech — the AI keeps every line whole, so it can land a little over or under.' : MT.len === 'custom' ? 'Any length from 8 seconds to 10 minutes — the AI builds a longer piece in sections, each rising and landing.' : MT.len === 'all' ? 'Nothing is cut out: every clip plays in full and every photo gets its moment — the AI orders them and blends them together with fades, flashes and cuts on the beat.' : 'The AI picks the best moments to fit this length.'}</small></section>
      <section class="mt-sec"><h3>Shape</h3><div class="mt-row">${chips(MT_ASPECTS.map(([v, l]) => [v, v + ' · ' + l]), MT.aspect, 'aspect')}</div></section>
      <section class="mt-sec"><h3>Words on screen</h3>
        ${talk ? '<p class="mt-hint">💬 Captions of every word, lit up as it’s said, are always on — plus a headline hook at the top. You can restyle both in the studio.</p>'
    : `<label class="mt-toggle"><input type="checkbox" id="mtCaps" ${MT.caps ? 'checked' : ''}/> <span>💬 Captions of what’s said, added automatically</span></label>
        <small class="mt-hint">The AI also writes a hook, story lines and a closing line, styled to match — tell it the story below.</small>`}</section>
      ${mtAboutHtml()}
      <input type="file" id="mtPick" accept="video/*,image/*" multiple hidden />
      <input type="file" id="mtSong" accept="audio/*,.mp3,.m4a,.wav,.aac" hidden />`;
    p.foot.innerHTML = `<button type="button" class="mt-go" data-mt="go"${ready ? '' : ' disabled'}>${mi('sparkles')} ${talk ? 'Make my Viral Montage' : 'Make my montage'}</button>`;
    if (!p._wired) { p._wired = true; mtWire(p); }
    if (MT.preview) mtPreviewPaint();   // a sample still loading or playing keeps its line after a redraw
  }

  /* 🎁 the free shelf: songs that are safe to post (freemusic.js), by mood */
  /*
   * ►► BACKGROUND MUSIC: TABS, A SHORT LIST, ▶ TO LISTEN. ◄◄ No music / Free
   * songs / My songs. Free songs: the moods, then "✨ Pick for me" and four
   * songs of the mood (the rest a tap away), each with ▶ to hear it before it
   * is used and a round tick for the one that will be. My songs: the
   * library's, and adding one from the phone.
   */
  const mtMusTab = () => MT.musTab || (MT.song || MT.songFile ? 'mine' : MT.free ? 'free' : 'none');
  const MT_LIST_SHOW = 4;
  function mtMusicHtml() {
    const esc = C.esc, attr = C.escAttr;
    const F = MT.freeList, hasFree = !!(F && F.tracks && F.tracks.length);
    const tab = mtMusTab();
    const tabs = `<div class="mt-seg" role="tablist">
        <button type="button" class="${tab === 'none' ? 'on' : ''}" data-mt-song="">No music</button>
        ${hasFree ? `<button type="button" class="${tab === 'free' ? 'on' : ''}" data-mt-tab="free">✨ Free songs</button>` : ''}
        <button type="button" class="${tab === 'mine' ? 'on' : ''}" data-mt-tab="mine">🎵 My songs</button></div>`;
    const playing = MT.preview && MT.preview.key;
    const row = ({ key, sel, title, sub, pick, play }) => `<div class="mt-song${sel ? ' on' : ''}" ${pick}>
        ${play ? `<button type="button" class="mt-play${playing === key ? ' on' : ''}" data-mt-play="${attr(key)}" aria-label="Listen to ${attr(title)}"></button>` : '<span class="mt-play mt-play-x">✨</span>'}
        <span class="mt-song-t"><b>${esc(title)}</b><small data-mt-sub="${attr(key)}" data-orig="${attr(sub)}">${esc(sub)}</small></span><span class="mt-radio"></span></div>`;
    if (tab === 'free' && hasFree) {
      const mood = MT.freeMood || (F.tracks.find((t) => t.id === MT.free) || {}).mood || MT_MOOD_OF[MT.style] || 'uplift';
      const mName = (F.moods.find((m) => m.id === mood) || {}).name || '';
      const songs = F.tracks.filter((t) => t.mood === mood);
      const selAt = songs.findIndex((t) => t.id === MT.free);
      const all = MT.showAll === mood || selAt >= MT_LIST_SHOW;
      const shown = all ? songs : songs.slice(0, MT_LIST_SHOW);
      const short = (n) => String(n).replace(/\s*&.*$/, '');
      return `${tabs}
        <div class="mt-row mt-moods">${F.moods.map((m) => `<button type="button" class="mt-chip${mood === m.id ? ' on' : ''}" data-mt-mood="${attr(m.id)}">${esc(short(m.name))}</button>`).join('')}</div>
        <div class="mt-list">
          ${row({ key: 'auto', sel: MT.free === 'auto', title: 'Pick for me', sub: `a different ${short(mName).replace(/^\S+\s/, '')} song each time`, pick: 'data-mt-free="auto"' })}
          ${shown.map((t) => row({ key: 'free:' + t.id, sel: MT.free === t.id, title: t.title, sub: mName.replace(/^\S+\s/, ''), pick: `data-mt-free="${attr(t.id)}"`, play: true })).join('')}
          ${!all && songs.length > MT_LIST_SHOW ? `<button type="button" class="mt-more" data-mt-all="${attr(mood)}">Show all ${songs.length} ${esc(short(mName).replace(/^\S+\s/, ''))} songs ▾</button>` : ''}
        </div>
        <small class="mt-hint">🎁 Free and safe to post — no muting or copyright flags; the post credits the artist for you.</small>`;
    }
    if (tab === 'mine') {
      return `${tabs}
        <div class="mt-list">
          ${MT.songFile ? row({ key: 'file', sel: true, title: MT.songFile.name.replace(/\.[^.]+$/, ''), sub: 'from this phone', pick: 'data-mt-tab="mine"', play: true }) : ''}
          ${MT.lib.slice(0, 30).map((m) => row({ key: 'lib:' + m.id, sel: !!(MT.song && MT.song.id === m.id), title: String(m.name || 'Song'), sub: m.durationSec ? mtClock(m.durationSec) : 'your song', pick: `data-mt-song="${attr(m.id)}"`, play: true })).join('')}
          <button type="button" class="mt-more" data-mt="song">＋ Add a song from this phone</button>
        </div>
        ${MT.lib.length || MT.songFile ? '' : '<small class="mt-hint">Your own songs: a worship track, an instrumental — add one from this phone and it stays here for next time.</small>'}`;
    }
    return `${tabs}<small class="mt-hint">${MT.mode === 'talk' ? 'No music — just the voices.' : 'No music — the clips’ own sound.'}</small>`;
  }
  /*
   * ►► THE NARRATOR, AS A LIST YOU CAN LISTEN TO. ◄◄ "No narrator", then each
   * voice with what it sounds like, ▶ to hear it say a line, and a tick for
   * the one that will open and close the edit (the same rows as the music).
   */
  const MT_VOICE_FEEL = {
    am_michael: 'Warm and confident — a friendly host', af_heart: 'Bright and warm — welcoming',
    bm_george: 'Calm British storyteller', bf_emma: 'Gentle and clear — British', am_onyx: 'Deep and cinematic — a trailer voice',
  };
  function mtVoiceHtml(voices) {
    const esc = C.esc, attr = C.escAttr;
    const playing = MT.preview && MT.preview.key;
    const row = (id, title, sub, play) => `<div class="mt-song${(MT.voice || '') === id ? ' on' : ''}" data-mt-voice="${attr(id)}">
        ${play ? `<button type="button" class="mt-play${playing === 'voice:' + id ? ' on' : ''}" data-mt-play="voice:${attr(id)}" aria-label="Hear ${attr(title)}"></button>` : '<span class="mt-play mt-play-x mt-play-off">🔇</span>'}
        <span class="mt-song-t"><b>${esc(title)}</b><small data-mt-sub="voice:${attr(id)}" data-orig="${attr(sub)}">${esc(sub)}</small></span><span class="mt-radio"></span></div>`;
    return `<div class="mt-list">${row('', 'No narrator', 'Straight in with the first line', false)}${voices.map((v) => row(v.id, v.label, MT_VOICE_FEEL[v.id] || 'An AI voice', true)).join('')}</div>
      <small class="mt-hint">🎙 The narrator says a hook before the first line and a closing line to follow or share, over B-roll — words the AI writes for this edit.</small>`;
  }
  const mtClock = (sec) => { const s = Math.max(0, Math.round(sec || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  /* ▶ one song at a time: tap to hear it, tap again to stop. A free song plays
     straight from incompetech; if the phone cannot get it there, the server
     fetches it once (it is then in the library) and it plays from there. */
  function mtPreviewSrc(key) {
    if (key.startsWith('voice:')) return window.MW_VOICE_SAMPLE_URL ? window.MW_VOICE_SAMPLE_URL(key.slice(6)) : '';
    if (key === 'file') return MT.songFile ? (MT.songFileUrl || (MT.songFileUrl = URL.createObjectURL(MT.songFile))) : '';
    if (key.startsWith('lib:')) { const m = MT.lib.find((x) => 'lib:' + x.id === key); return m && m.file ? C.fileUrl(m.file) : ''; }
    if (key.startsWith('free:')) {
      // through the server (it fetches the song once and streams it), else straight from incompetech
      const t = MT.freeList && MT.freeList.tracks.find((x) => 'free:' + x.id === key);
      if (!t) return '';
      return window.MW_FREE_SONG_URL ? window.MW_FREE_SONG_URL(t.id) : (t.url || '');
    }
    return '';
  }
  function mtPreviewPaint() {
    const p = MT.panel; if (!p) return;
    const pv = MT.preview, key = pv && pv.key;
    $$('[data-mt-play]', p.body).forEach((b) => b.classList.toggle('on', b.dataset.mtPlay === key));
    $$('[data-mt-sub]', p.body).forEach((el) => {
      if (pv && el.dataset.mtSub === key) {
        const a = pv.a;
        el.textContent = a.currentTime < 0.05 ? (key.startsWith('voice:') ? 'Getting the voice ready… (the first time takes about a minute)' : 'Loading…') : `Playing · ${mtClock(a.currentTime)}${a.duration && isFinite(a.duration) ? ' / ' + mtClock(a.duration) : ''}`;
      } else el.textContent = el.dataset.orig || '';
    });
  }
  function mtPreviewStop() {
    const pv = MT.preview; MT.preview = null;
    if (pv && pv.a) { try { pv.a.pause(); pv.a.removeAttribute('src'); pv.a.load(); } catch (e) {} }
    mtPreviewPaint();
  }
  async function mtPreviewToggle(key) {
    if (MT.preview && MT.preview.key === key) return mtPreviewStop();
    mtPreviewStop();
    let src = mtPreviewSrc(key);
    if (!src) return;
    const a = new Audio();
    a.preload = 'auto';
    MT.preview = { key, a };
    // remember each row's own line, to put back when it stops
    const onErr = () => {
      const pv = MT.preview;
      if (!pv || pv.a !== a) return;
      const voice = key.startsWith('voice:');
      C.island({ kind: 'warn', title: voice ? 'That voice would not play' : 'That song would not play',
        sub: voice ? 'The server could not make the voice just now — try again in a moment.' : 'The music site did not answer — try again in a moment, or pick another.', ms: 4000 });
      mtPreviewStop();
    };
    a.addEventListener('error', onErr);
    a.addEventListener('timeupdate', mtPreviewPaint);
    a.addEventListener('loadedmetadata', mtPreviewPaint);
    a.addEventListener('ended', () => { if (MT.preview && MT.preview.a === a) mtPreviewStop(); });
    a.src = src;
    mtPreviewPaint();
    try { await a.play(); } catch (e) { if (e && e.name !== 'AbortError') onErr(); }
  }

  function mtWire(p) {
    const onClick = async (e) => {
      if (e.target.closest('[data-mt-rearrange]') && !MT.busy) {
        const op = window.VideoEditor && (window.VideoEditor.montagePath || window.VideoEditor.currentPath) ? (window.VideoEditor.montagePath || window.VideoEditor.currentPath)() : null;
        C.closePanel(p, true);
        return editMontage(op);
      }
      const b = e.target.closest('[data-mt],[data-mt-del],[data-mt-song],[data-mt-style],[data-mt-len],[data-mt-aspect],[data-mt-order],[data-mt-mode],[data-mt-voice],[data-mt-free],[data-mt-mood],[data-mt-idea],[data-mt-tab],[data-mt-play],[data-mt-all]');
      if (!b || MT.busy || mtDrag.just) return;
      const d = b.dataset;
      if (d.mtOrder) { MT.order = d.mtOrder; return mtPaint(); }
      if (d.mtMode) {
        MT.mode = d.mtMode;
        if (MT.mode === 'talk' && MT.len === 'all') MT.len = 30;
        // a viral edit has music under it unless the operator says otherwise
        if (MT.mode === 'talk' && !MT.song && !MT.songFile && !MT.free && MT.freeList && MT.freeList.tracks && MT.freeList.tracks.length) MT.free = 'auto';
        return mtPaint();
      }
      if (d.mtPlay != null) return mtPreviewToggle(d.mtPlay);
      if (d.mtAll != null) { MT.showAll = d.mtAll; return mtPaint(); }
      if (d.mtTab) {
        MT.musTab = d.mtTab;
        if (d.mtTab === 'free' && !MT.free) { MT.free = 'auto'; MT.song = null; MT.songFile = null; }
        return mtPaint();
      }
      if (d.mtDel != null) { const it = MT.items.splice(+d.mtDel, 1)[0]; if (it) URL.revokeObjectURL(it.url); return mtPaint(); }
      if (d.mtSong != null) { MT.song = d.mtSong ? MT.lib.find((m) => m.id === d.mtSong) || null : null; MT.songFile = null; MT.free = null; MT.musTab = d.mtSong ? 'mine' : 'none'; if (!d.mtSong) mtPreviewStop(); return mtPaint(); }
      if (d.mtFree) { MT.free = d.mtFree; MT.song = null; MT.songFile = null; MT.musTab = 'free'; return mtPaint(); }
      if (d.mtMood) { MT.freeMood = d.mtMood; MT.showAll = null; return mtPaint(); }
      if (d.mtVoice != null) { MT.voice = d.mtVoice; return mtPaint(); }
      if (d.mtIdea != null) {
        MT.brief = mtToggleIdea(MT.brief, d.mtIdea);
        const box = $('#mtBrief', p.body);
        if (box) box.value = MT.brief;
        b.classList.toggle('on', mtHas(MT.brief, d.mtIdea));
        return;
      }
      if (d.mtStyle) { MT.style = d.mtStyle; return mtPaint(); }
      if (d.mtLen) { MT.len = d.mtLen === 'all' || d.mtLen === 'custom' ? d.mtLen : +d.mtLen; return mtPaint(); }
      if (d.mtAspect) { MT.aspect = d.mtAspect; return mtPaint(); }
      if (d.mt === 'add') return $('#mtPick', p.body).click();
      if (d.mt === 'addsrv') return mtAddFromFiles();
      if (d.mt === 'song') return $('#mtSong', p.body).click();
      if (d.mt === 'go') return mtMake();
    };
    p.body.addEventListener('click', onClick);
    p.foot.addEventListener('click', onClick);
    p.body.addEventListener('change', (e) => {
      if (e.target.id === 'mtPick') {
        for (const f of Array.from(e.target.files || []).slice(0, 60 - MT.items.length)) {
          const kind = /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|avif)$/i.test(f.name) ? 'image' : 'video';
          const it = { file: f, kind, url: URL.createObjectURL(f) };
          MT.items.push(it);
          if (kind === 'video') mtPoster(it);
        }
        e.target.value = '';
        mtPaint();
      } else if (e.target.id === 'mtSong') {
        const f = e.target.files && e.target.files[0];
        if (f) { MT.songFile = f; MT.song = null; MT.free = null; MT.musTab = 'mine'; if (MT.songFileUrl) { URL.revokeObjectURL(MT.songFileUrl); MT.songFileUrl = null; } }
        e.target.value = '';
        mtPaint();
      } else if (e.target.id === 'mtKeep') MT.keep = e.target.checked;
      else if (e.target.id === 'mtCaps') MT.caps = e.target.checked;
    });
    mtWireDrag(p);
    p.body.addEventListener('input', (e) => {
      if (e.target.id === 'mtBrief') {
        MT.brief = e.target.value;
        $$('[data-mt-idea]', p.body).forEach((x) => x.classList.toggle('on', mtHas(MT.brief, x.dataset.mtIdea)));
      }
      if (e.target.id === 'mtMin' || e.target.id === 'mtSec') {
        const mm = Math.max(0, Math.min(10, parseInt($('#mtMin', p.body).value, 10) || 0));
        const ss = Math.max(0, Math.min(59, parseInt($('#mtSec', p.body).value, 10) || 0));
        MT.custom = Math.max(8, Math.min(600, mm * 60 + ss));
      }
    });
  }

  /*
   * ►► HOLD AND DRAG TO SET THE ORDER. ◄◄
   * A short hold on a tile picks it up (a quick swipe still scrolls the
   * sheet); it follows the finger, the tile under the finger is where it will
   * land, and letting go puts it there. Moving a tile means the operator wants
   * their own order, so "My order" switches on.
   */
  const mtDrag = { just: false };
  function mtWireDrag(p) {
    let hold = null, drag = null;
    const tileAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      const t = el && el.closest && el.closest('.mt-tile');
      return t && !t.classList.contains('mt-lift') ? t : null;
    };
    const end = () => { clearTimeout(hold && hold.timer); hold = null; };
    p.body.addEventListener('pointerdown', (e) => {
      const tile = e.target.closest('.mt-tile');
      if (!tile || e.target.closest('.mt-x') || MT.busy) return;
      const x0 = e.clientX, y0 = e.clientY, id = e.pointerId;
      hold = { x0, y0, timer: setTimeout(() => {
        const r = tile.getBoundingClientRect();
        drag = { tile, from: +tile.dataset.i, to: +tile.dataset.i, dx: x0 - r.left, dy: y0 - r.top, id };
        tile.classList.add('mt-lift');   // (it lets the finger see the tile under it: pointer-events none)
        if (navigator.vibrate) try { navigator.vibrate(10); } catch (er) {}
      }, 260) };
    });
    p.body.addEventListener('pointermove', (e) => {
      if (hold && !drag && Math.hypot(e.clientX - hold.x0, e.clientY - hold.y0) > 10) end();
      if (!drag || e.pointerId !== drag.id) return;
      e.preventDefault();
      drag.tile.style.transform = `translate(${e.clientX - hold.x0}px, ${e.clientY - hold.y0}px) scale(1.06)`;
      const over = tileAt(e.clientX, e.clientY);
      $$('.mt-tile.mt-target', p.body).forEach((t) => t.classList.remove('mt-target'));
      if (over) { over.classList.add('mt-target'); drag.to = +over.dataset.i; }
    }, { passive: false });
    // while a tile is held, the finger moves the tile, not the sheet
    p.body.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
    const drop = (e) => {
      if (drag && (!e || e.pointerId === drag.id)) {
        const { from, to } = drag;
        drag = null; end();
        mtDrag.just = true; setTimeout(() => { mtDrag.just = false; }, 350);
        if (to !== from) {
          const [it] = MT.items.splice(from, 1);
          MT.items.splice(to, 0, it);
          MT.order = 'mine';
        }
        mtPaint();
        return;
      }
      end();
    };
    p.body.addEventListener('pointerup', drop);
    p.body.addEventListener('pointercancel', drop);
    p.body.addEventListener('contextmenu', (e) => { if (e.target.closest('.mt-tile')) e.preventDefault(); });
  }

  /*
   * A frame of each video for its tile. iOS paints a <video> black until it is
   * played, so the tile showed nothing; a frame is grabbed onto a canvas once
   * instead (half a second in, past any fade from black).
   */
  /*
   * ►► FROM YOUR FILES. ◄◄ "The montage should be able to add videos that are
   * on Your files." Clips already on the server — a sermon sent earlier, the
   * shorts just exported — are picked from the same list, shown with their
   * picture, and used where they are: nothing is sent up again.
   */
  async function mtAddFromFiles() {
    let got = null;
    try { got = await C.pickFiles([{ name: 'Videos and photos', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'jpg', 'jpeg', 'png', 'webp'] }], true); }
    catch (e) { got = null; }
    const paths = (Array.isArray(got) ? got : got ? [got] : []).filter((x) => typeof x === 'string');
    if (!paths.length) return;
    const have = new Set(MT.items.map((it) => it.path).filter(Boolean));
    for (const p of paths.slice(0, Math.max(0, 60 - MT.items.length))) {
      if (have.has(p)) continue;
      const name = String(p).split(/[\\/]/).pop();
      const kind = /\.(jpe?g|png|webp|heic|avif)$/i.test(name) ? 'image' : 'video';
      const it = { path: p, name, kind, file: null, url: kind === 'image' ? C.fileUrl(p) : '' };
      MT.items.push(it);
      if (kind === 'video') {
        // its picture and length, from the server (the phone does not have the file)
        (async () => {
          try { const t = await window.api.video.thumbnail(p, 1); if (t) it.poster = C.fileUrl(t); } catch (e) {}
          try { const info = await window.api.video.info(p); if (info && info.durationSec) it.secs = info.durationSec; it.size = (info && info.sizeBytes) || 0; } catch (e) {}
          mtPaint();
        })();
      }
    }
    mtPaint();
  }

  function mtPoster(it) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    let done = false;
    const finish = () => { done = true; try { v.removeAttribute('src'); v.load(); } catch (e) {} };
    const grab = () => {
      if (done) return;
      try {
        const w = 240, h = Math.round(240 * (v.videoHeight / Math.max(1, v.videoWidth))) || 400;
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        it.poster = c.toDataURL('image/jpeg', 0.7);
      } catch (e) { /* the play mark alone */ }
      finish();
      mtPaint();
    };
    v.addEventListener('loadedmetadata', () => {
      it.secs = v.duration || 0;
      try { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); } catch (e) {}
    });
    v.addEventListener('seeked', grab);
    v.addEventListener('error', finish);
    setTimeout(() => { if (!done && v.readyState >= 2) grab(); }, 2500);
    v.src = it.url;
    v.load();
  }

  /*
   * ►► THE PROGRESS SCREEN: A NUMBER THAT IS ALWAYS MOVING. ◄◄ One screen,
   * kept (only its words change), so the bar glides instead of jumping. The
   * percentage shown eases up to where the work really is, and between the
   * server's reports it keeps creeping a little — never more than a few
   * points ahead, never backwards, and 100% only when it is done.
   */
  function mtProgress(title, pct, note) {
    const p = MT.panel; if (!p) return;
    const want = Math.max(0, Math.min(100, Number(pct) || 0));
    let run = $('.mt-run[data-live]', p.body);
    if (!run) {
      p.body.innerHTML = `<div class="mt-run" data-live="1"><div class="mt-orb">${mi('sparkles')}</div><b class="mt-stage"></b>
        <div class="mt-barrow"><div class="mt-bar"><i></i></div><b class="mt-pct">0%</b></div>
        <small class="mt-note"></small></div>`;
      p.foot.innerHTML = '';
      run = $('.mt-run', p.body);
      if (!MT.prog) MT.prog = { shown: 0, target: 0, at: 0, raf: 0 };
    }
    const pr = MT.prog || (MT.prog = { shown: 0, target: 0, at: 0, raf: 0 });
    if (want > pr.target) { pr.target = want; pr.at = performance.now(); }
    const st = $('.mt-stage', run);
    if (st.textContent !== title) st.textContent = title;
    $('.mt-note', run).textContent = note && note.trim() ? note : (note === ' ' ? '' : 'You can lock your phone — it carries on, and the montage opens when you come back.');
    if (!pr.raf) {
      let last = performance.now();
      const tick = (now) => {
        const bar = MT.panel && $('.mt-run[data-live] .mt-bar i', MT.panel.body);
        if (!bar) { pr.raf = 0; return; }
        const dt = Math.min(0.1, (now - last) / 1000); last = now;
        if (pr.shown < pr.target) {
          // catch up quickly, then settle
          pr.shown = Math.min(pr.target, pr.shown + Math.max(0.6, (pr.target - pr.shown) * 4) * dt);
        } else if (pr.target < 100) {
          // nothing new for a while: creep on, slowing down, up to a few points past the last report
          const roof = Math.min(99, pr.target + 10);
          pr.shown += Math.max(0, roof - pr.shown) * 0.08 * dt;
        }
        bar.style.transform = `scaleX(${Math.max(0.02, pr.shown / 100).toFixed(4)})`;
        const n = $('.mt-run[data-live] .mt-pct', MT.panel.body);
        const label = Math.floor(pr.target >= 100 && pr.shown > 99.5 ? 100 : Math.min(pr.shown, 99)) + '%';
        if (n && n.textContent !== label) n.textContent = label;
        pr.raf = requestAnimationFrame(tick);
      };
      pr.raf = requestAnimationFrame(tick);
    }
  }

  async function mtMake() {
    const talk = MT.mode === 'talk';
    if (talk ? !MT.items.some((it) => it.kind === 'video') : MT.items.length < 2) return;
    mtPreviewStop();
    if (MT.prog && MT.prog.raf) cancelAnimationFrame(MT.prog.raf);
    MT.prog = null;   // a new montage counts from 0%
    MT.busy = true;
    const jobId = 'mt' + Date.now().toString(36);
    let off = null;
    try {
      // 1) the files go up one by one (resumable, like every upload here)
      const paths = [];
      const sizeOf = (it) => (it.file && it.file.size) || it.size || 1;
      const total = MT.items.reduce((n, it) => n + sizeOf(it), 0) + ((MT.songFile && MT.songFile.size) || 0);
      let done = 0;
      for (let i = 0; i < MT.items.length; i++) {
        const it = MT.items[i];
        if (it.path) { paths.push(it.path); done += sizeOf(it); continue; }
        mtProgress(`Sending ${i + 1} of ${MT.items.length}…`, (done / total) * 30);
        it.path = await C.uploadFile(it.file, (pc) => mtProgress(`Sending ${i + 1} of ${MT.items.length}…`, ((done + sizeOf(it) * pc / 100) / total) * 30));
        done += sizeOf(it);
        paths.push(it.path);
      }
      // 2) the song joins the music library, so it is on the music lane afterwards
      let song = MT.song;
      // a free song: fetched onto the server's music library (once), credited in the post
      let credit = '';
      if (!MT.songFile && MT.free && MT.freeList) {
        mtProgress('Getting the music…', 30);
        try {
          song = await freeFetch(MT.free, MT.freeList.tracks, MT_MOOD_OF[MT.style] || 'uplift', (title) => { if (title) mtProgress(`Getting the music — “${title}”…`, 30); });
          credit = song.credit || '';
        } catch (er) {
          C.island({ kind: 'warn', title: 'That song could not be fetched', sub: (er && er.message) || '', ms: 5000 });
          song = null;
        }
      }
      if (MT.songFile) {
        mtProgress('Sending your song…', 30);
        const up = await C.uploadFile(MT.songFile, () => {});
        song = await window.api.library.add('music', up, MT.songFile.name.replace(/\.[^.]+$/, ''), 'montage');
        MT.song = song; MT.songFile = null;
      }
      // 3) the edit itself — long, so its stages are shown as they happen
      mtProgress('Starting…', 32);
      off = window.api.onJobProgress((d) => {
        if (!d || d.jobId !== jobId) return;
        mtProgress(d.stage || 'Working…', 32 + (d.percent || 0) * 0.68);
      });
      const res = await window.api.montage.create({
        mediaPaths: paths, musicPath: song ? song.file : null, style: MT.style,
        lengthSec: MT.len === 'all' ? 0 : MT.len === 'custom' ? MT.custom : MT.len, full: MT.len === 'all',
        aspect: MT.aspect, brief: MT.brief, about: mtAboutOf(MT.brief), keepAudio: talk ? true : MT.keep, keepOrder: !talk && MT.order === 'mine', jobId,
        mode: talk ? 'talk' : undefined, voice: talk && MT.voice ? MT.voice : undefined,
      });
      if (credit) res.postCaption = [res.postCaption, credit].filter(Boolean).join('\n\n');
      if (off) off();
      MT.busy = false;
      mtProgress('Opening it in the studio…', 100, ' ');
      go('studio');
      // (the Viral Montage's song plays under the WHOLE piece at 30% — about 10 dB under the
      // preacher. At 16% it was lost under his voice and only heard in the narrator's lines.)
      await window.VideoEditor.applyMontage(talk
        ? { output: res.output, base: res.base, overlays: res.overlays, music: song, musicVolume: 0.3, texts: res.texts, style: res.style || MT.style, words: res.words, talk: true, cuts: res.cuts }
        : { output: res.output, base: res.base, overlays: res.overlays, music: song, musicVolume: MT.keep ? 0.7 : 1, texts: res.texts, style: res.style || MT.style, captions: MT.caps && MT.keep, cuts: res.cuts });
      res.song = song || null;
      C.closePanel(MT.panel, true);
      mtRelease();
      MT.items = []; MT.brief = '';
      res.autoCaps = talk ? 'talk' : MT.caps && MT.keep;
      mtResult(res);
    } catch (e) {
      if (off) off();
      MT.busy = false;
      const p = MT.panel; if (!p) return;
      p.body.innerHTML = `<div class="mt-run"><div class="mt-orb bad">!</div><b class="mt-stage">That montage didn’t finish</b>
        <small class="mt-note">${C.esc((e && e.message) || 'Something went wrong.')}</small></div>`;
      p.foot.innerHTML = '<button type="button" class="mt-go" data-mt="back">Back to my clips</button>';
      p.foot.onclick = (ev) => { if (ev.target.closest('[data-mt="back"]')) { p.foot.onclick = null; mtPaint(); } };
    }
  }

  function mtResult(res) {
    const tags = (res.hashtags || []).map((h) => '#' + h).join(' ');
    const caption = [res.postCaption, tags].filter(Boolean).join('\n\n');
    const p = C.openPanel({ id: 'cloudMontageDone', title: res.title || 'Your montage', cls: 'cp-montage' });
    p.body.innerHTML = `<p class="mt-lead">${mi('check')} ${C.esc(Math.round(res.duration))}s · ${res.mode === 'talk' ? C.esc(String(res.lines || 0)) + ' lines, ' : ''}${C.esc(String((res.shots || []).length))} ${res.mode === 'talk' ? 'cuts' : 'shots'}${res.bpm ? ' · cut to ' + C.esc(String(Math.round(res.bpm))) + ' BPM' : ''}</p>
      ${res.concept ? `<p class="mt-concept">${C.esc(res.concept)}</p>` : ''}
      ${res.narrator ? `<p class="mt-concept">🎙 Narrator: “${C.esc(res.narrator.join('” … “'))}”</p>` : ''}
      ${res.narratorWhy ? `<p class="mt-tip">🎙 The narrator was left out this time (${C.esc(res.narratorWhy)}) — the edit is complete without it.</p>` : ''}
      <p class="mt-tip">It’s open in the studio now${res.texts && res.texts.length ? ' — the words on screen are text boxes, tap one to change it' : ''}. ${res.autoCaps === 'talk' ? 'The captions are on, every word lit up as it’s said, and go into the export — tap 💬 Captions to change their look.' : res.autoCaps ? 'Captions of what’s said are being added by themselves — they go into the export.' : 'Add captions from the 💬 Captions tool.'} Change the music volume in Audio, then export as usual.</p>
      ${caption ? `<section class="mt-sec"><h3>Post caption</h3><textarea class="mt-brief" rows="4" readonly>${C.esc(caption)}</textarea>
        <button type="button" class="mt-chip on" data-mt-copy>Copy caption</button></section>` : ''}`;
    p.foot.innerHTML = `<div class="mt-foot2">${res.project ? '<button type="button" class="mt-edit" data-mt-shots>✏️ Rearrange shots &amp; photos</button>' : ''}<button type="button" class="mt-go" data-mt-ok>Start editing</button></div>`;
    p.el.addEventListener('click', (e) => {
      if (e.target.closest('[data-mt-ok]')) C.closePanel(p);
      if (e.target.closest('[data-mt-shots]')) { C.closePanel(p, true); editMontage(res.output, res.song || null); }
      if (e.target.closest('[data-mt-copy]')) {
        try { navigator.clipboard.writeText(caption); C.island({ kind: 'good', title: 'Caption copied' }); } catch (er) {}
      }
    });
  }

  /* ============================ EDIT A MADE MONTAGE ============================
   *
   * The montage's own edit, shot by shot, to change by hand: move a clip
   * earlier or later, take one out, move a photo to the clip before or after,
   * switch it between full screen and a framed box, take it off, or put an
   * unused one on. "Remake" builds the video again from this — no AI, and the
   * shots that did not change are not made again (montage.js remake()).
   */
  const ME = { path: '', project: null, shots: [], sel: null, selShot: -1, busy: false, dirty: false, music: null, panel: null };

  async function editMontage(path, music) {
    if (!path) return;
    let project = null;
    try { project = await window.api.montage.project(path); } catch (e) { project = null; }
    if (!project || !Array.isArray(project.shots)) {
      return C.island({ kind: 'warn', title: 'Nothing to rearrange', sub: 'This montage was made before montages could be edited shot by shot — make it again to edit it.', ms: 6000 });
    }
    ME.path = path; ME.project = project; ME.sel = null; ME.selShot = -1; ME.dirty = false; ME.busy = false;
    if (music !== undefined) ME.music = music;
    ME.shots = project.shots.map((sh, key) => ({ key, transition: sh.transition, overlays: sh.overlays.map((o) => ({ cid: o.cid, style: o.style })) }));
    ME.panel = C.openPanel({ id: 'cloudMontageEdit', title: 'Edit the montage', cls: 'cp-montage', onClose: () => meStopPreview() });
    if (!ME.panel._wired) { ME.panel._wired = true; meWire(ME.panel); }
    mePaint();
  }

  const meCand = (cid) => (ME.project && ME.project.cands[cid]) || null;
  const meBase = (sh) => ME.project.shots[sh.key];
  function meUnused() {
    const on = new Set();
    ME.shots.forEach((sh) => { on.add(meBase(sh).cid); sh.overlays.forEach((o) => on.add(o.cid)); });
    return Object.values(ME.project.cands).filter((c) => c.kind === 'image' && !on.has(c.id));
  }
  const fmtS = (x) => { const v = Math.round(Number(x) || 0); return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0'); };

  function mePaint() {
    const p = ME.panel; if (!p) return;
    meStopPreview();
    const esc = C.esc, attr = C.escAttr;
    const thumb = (c) => (c && c.thumb ? `<img src="${attr(c.thumb)}" alt="" draggable="false" />` : '<span class="me-nothumb"></span>');
    let t = 0;
    const rows = ME.shots.map((sh, i) => {
      const b = meBase(sh), c = meCand(b.cid) || {};
      const at = t; t += b.seconds;
      const vid = c.kind === 'video';
      const sel = ME.sel && ME.sel.i === i ? ME.sel.j : -1;
      const ovs = vid ? sh.overlays.map((o, j) => {
        const oc = meCand(o.cid);
        return `<button type="button" class="me-ov${sel === j ? ' on' : ''}" data-me-ov="${i}:${j}">${thumb(oc)}<span>${o.style === 'pip' ? 'Box' : 'Full'}</span></button>`;
      }).join('') : '';
      const tools = sel >= 0 ? `<div class="me-ovtools">
          <button type="button" data-me-ovact="prev"${meNeighbour(i, -1) < 0 ? ' disabled' : ''}>◀ Earlier clip</button>
          <button type="button" data-me-ovact="next"${meNeighbour(i, 1) < 0 ? ' disabled' : ''}>Later clip ▶</button>
          <button type="button" data-me-ovact="style">${sh.overlays[sel] && sh.overlays[sel].style === 'pip' ? 'Make it full screen' : 'Make it a box'}</button>
          <button type="button" data-me-ovact="del">Take it off</button></div>` : '';
      return `<div class="me-shot${ME.selShot === i ? ' sel' : ''}" data-me-shot="${i}">
          <div class="me-row">
            <span class="me-n">${i + 1}</span>
            <span class="me-th" data-me-play="${i}" role="button" aria-label="Play this shot">${thumb(c)}<i class="me-playbadge" aria-hidden="true"></i></span>
            <span class="me-info"><b>${vid ? 'Clip' : 'Photo'} · ${esc(fmtS(b.seconds))}</b><small>${esc((c.name || '').slice(0, 28))}</small><small>starts ${esc(fmtS(at))}${i ? ' · ' + esc(sh.transition) + ' in' : ''}</small></span>
            <span class="me-btns">
              <button type="button" data-me-move="-1" aria-label="Earlier"${i === 0 ? ' disabled' : ''}>▲</button>
              <button type="button" data-me-move="1" aria-label="Later"${i === ME.shots.length - 1 ? ' disabled' : ''}>▼</button>
              <button type="button" data-me-del aria-label="Take out">✕</button>
            </span>
          </div>
          ${vid ? `<div class="me-ovs">${ovs || '<small class="me-none">No photos on this clip — tap it, then a photo below to add one.</small>'}</div>${tools}` : ''}
        </div>`;
    }).join('');
    const unused = meUnused();
    p.body.innerHTML = `
      <p class="mt-lead">${mi('sparkles')} Your montage, shot by shot — tap a picture to play that shot.</p>
      <p class="mt-hint me-lead">Move clips with ▲ ▼, take one out with ✕. Tap a photo on a clip to move it to another clip, make it full screen or a box, or take it off. Then <b>Remake</b> — only the shots you changed are made again.</p>
      <div class="me-list">${rows}</div>
      ${unused.length ? `<section class="mt-sec"><h3>Photos not in it <small>${ME.selShot >= 0 ? 'tap one to put it on clip ' + (ME.selShot + 1) : 'tap a clip first, then a photo'}</small></h3>
        <div class="me-tray">${unused.map((c) => `<button type="button" class="me-ov" data-me-add="${attr(c.id)}">${thumb(c)}<span>Add</span></button>`).join('')}</div></section>` : ''}`;
    p.foot.innerHTML = `<button type="button" class="mt-go" data-me-go${ME.dirty ? '' : ' disabled'}>${mi('sparkles')} ${ME.dirty ? 'Remake montage' : 'Change something to remake'}</button>`;
  }

  /** The nearest CLIP before/after shot i (photos cannot carry a picture). */
  function meNeighbour(i, dir) {
    for (let k = i + dir; k >= 0 && k < ME.shots.length; k += dir) {
      const c = meCand(meBase(ME.shots[k]).cid);
      if (c && c.kind === 'video') return k;
    }
    return -1;
  }

  /*
   * ▶ THE SHOT ITSELF, NOT A STILL OF IT. A tap on a shot's picture plays that
   * shot right there — from the finished montage, so it is seen exactly as it
   * is (cut round the speaker, its zooms, its photos and words) — and stops at
   * its end; a second tap stops it. One at a time.
   */
  function meStopPreview() {
    const pv = ME.preview; ME.preview = null;
    if (!pv) return;
    try { pv.v.pause(); pv.v.removeAttribute('src'); pv.v.load(); } catch (e) {}
    if (pv.v.parentNode) pv.v.parentNode.removeChild(pv.v);
    if (pv.slot) pv.slot.classList.remove('playing');
  }
  function mePlayShot(i, slot) {
    const same = ME.preview && ME.preview.i === i;
    meStopPreview();
    if (same || !ME.path) return;
    const sh = ME.shots[i]; if (!sh) return;
    // where this shot is in the montage as it was made (the order may have been changed since)
    let start = 0;
    const own = ME.project.shots[sh.key], next = ME.project.shots[sh.key + 1];
    if (typeof own.at === 'number') start = own.at;   // where it really is in the file (montage.js render)
    else for (let k = 0; k < sh.key; k++) start += Number(ME.project.shots[k].seconds) || 0;
    const end = next && typeof next.at === 'number' ? next.at : start + (Number(own.seconds) || 0);
    const v = document.createElement('video');
    v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    v.src = C.fileUrl(ME.path) + `#t=${start.toFixed(2)},${end.toFixed(2)}`;
    slot.appendChild(v);
    slot.classList.add('playing');
    ME.preview = { i, v, slot };
    const seekIn = () => { try { if (Math.abs(v.currentTime - start) > 0.3) v.currentTime = start; } catch (e) {} };
    v.addEventListener('loadedmetadata', seekIn);
    v.addEventListener('timeupdate', () => { if (v.currentTime >= end - 0.04) meStopPreview(); });
    v.addEventListener('ended', meStopPreview);
    v.addEventListener('error', () => { meStopPreview(); C.island({ kind: 'warn', title: 'That shot would not play', sub: 'Try again in a moment.', ms: 3000 }); });
    v.play().catch(() => {});
  }

  function meWire(p) {
    p.body.addEventListener('click', (e) => {
      if (ME.busy) return;
      const play = e.target.closest('[data-me-play]');
      if (play) {
        e.stopPropagation();
        // the picture is the clip too: tapping it also chooses it (for a photo to go on), as tapping the row does
        const k = +play.dataset.mePlay;
        if (ME.selShot !== k || ME.sel) {
          ME.selShot = k; ME.sel = null;
          $$('#cloudMontageEdit [data-me-shot]').forEach((el) => el.classList.toggle('sel', +el.dataset.meShot === k));
        }
        return mePlayShot(k, play);
      }
      const shotEl = e.target.closest('[data-me-shot]');
      const i = shotEl ? +shotEl.dataset.meShot : -1;
      const mv = e.target.closest('[data-me-move]');
      if (mv) {
        const j = i + (+mv.dataset.meMove);
        if (j < 0 || j >= ME.shots.length) return;
        const [x] = ME.shots.splice(i, 1); ME.shots.splice(j, 0, x);
        ME.sel = null; ME.selShot = j; ME.dirty = true; return mePaint();
      }
      if (e.target.closest('[data-me-del]')) {
        if (ME.shots.length <= 1) return C.island({ kind: 'warn', title: 'A montage needs at least one shot', ms: 3000 });
        ME.shots.splice(i, 1); ME.sel = null; ME.selShot = -1; ME.dirty = true; return mePaint();
      }
      const ov = e.target.closest('[data-me-ov]');
      if (ov) {
        const [a, b] = ov.dataset.meOv.split(':').map(Number);
        ME.sel = ME.sel && ME.sel.i === a && ME.sel.j === b ? null : { i: a, j: b };
        ME.selShot = a; return mePaint();
      }
      const act = e.target.closest('[data-me-ovact]');
      if (act && ME.sel) {
        const sh = ME.shots[ME.sel.i], o = sh.overlays[ME.sel.j];
        if (!o) return;
        const what = act.dataset.meOvact;
        if (what === 'style') o.style = o.style === 'pip' ? 'cutaway' : 'pip';
        else if (what === 'del') { sh.overlays.splice(ME.sel.j, 1); ME.sel = null; }
        else {
          const k = meNeighbour(ME.sel.i, what === 'prev' ? -1 : 1);
          if (k < 0) return;
          sh.overlays.splice(ME.sel.j, 1);
          const to = ME.shots[k];
          if (what === 'prev') to.overlays.push(o); else to.overlays.unshift(o);
          ME.sel = { i: k, j: what === 'prev' ? to.overlays.length - 1 : 0 }; ME.selShot = k;
        }
        ME.dirty = true; return mePaint();
      }
      const add = e.target.closest('[data-me-add]');
      if (add) {
        let k = ME.selShot >= 0 && meCand(meBase(ME.shots[ME.selShot]).cid).kind === 'video' ? ME.selShot : meNeighbour(-1, 1);
        if (k < 0) return C.island({ kind: 'warn', title: 'There is no clip to put it on', ms: 3000 });
        ME.shots[k].overlays.push({ cid: add.dataset.meAdd, style: 'cutaway' });
        ME.selShot = k; ME.dirty = true; return mePaint();
      }
      if (shotEl && !e.target.closest('button')) { ME.selShot = ME.selShot === i ? -1 : i; ME.sel = null; return mePaint(); }
    });
    p.foot.addEventListener('click', (e) => { if (e.target.closest('[data-me-go]') && ME.dirty && !ME.busy) meRemake(); });
  }

  async function meRemake() {
    const p = ME.panel;
    ME.busy = true;
    const jobId = 'me' + Date.now().toString(36);
    const show = (title, pct) => {
      p.body.innerHTML = `<div class="mt-run"><div class="mt-orb">${mi('sparkles')}</div><b class="mt-stage">${C.esc(title)}</b>
        <div class="mt-bar"><i style="width:${Math.max(2, Math.min(100, pct || 0))}%"></i></div>
        <small class="mt-note">Only the shots you changed are made again. You can lock your phone.</small></div>`;
      p.foot.innerHTML = '';
    };
    show('Remaking your montage…', 2);
    const off = window.api.onJobProgress((d) => { if (d && d.jobId === jobId) show(d.stage || 'Remaking your montage…', d.percent || 0); });
    try {
      const res = await window.api.montage.remake({ path: ME.path, edits: { shots: ME.shots }, jobId });
      off && off();
      ME.busy = false;
      show('Opening it in the studio…', 100);
      go('studio');
      await window.VideoEditor.applyMontage({ output: res.output, base: res.base, overlays: res.overlays, texts: res.texts, style: res.style, cuts: res.cuts, music: ME.music || undefined, keepMusic: true });
      C.closePanel(p, true);
      C.island({ kind: 'good', title: 'Montage remade', sub: `${Math.round(res.duration)}s · ${res.shots.length} shots — it’s in the studio`, ms: 4500 });
    } catch (e) {
      off && off();
      ME.busy = false;
      p.body.innerHTML = `<div class="mt-run"><div class="mt-orb bad">!</div><b class="mt-stage">That didn’t remake</b><small class="mt-note">${C.esc((e && e.message) || 'Something went wrong.')}</small></div>`;
      p.foot.innerHTML = '<button type="button" class="mt-go" data-me-back>Back to the shots</button>';
      p.foot.onclick = (ev) => { if (ev.target.closest('[data-me-back]')) { p.foot.onclick = null; mePaint(); } };
    }
  }

  window.MWSocial = { busy: () => !!MT.busy, start, go, compose, openConnect, openMontage, editMontage, openProjects, openProject, view: () => S.view, _state: S, _planTimes: planTimes, _titleFromFile: titleFromFile };
})();
