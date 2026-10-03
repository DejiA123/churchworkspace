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
    clearInterval(S.poll); S.poll = null;
    if (view === 'home') renderHome(true);
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
        </div>
      </header>
      <main class="ch-scroll">
        <section class="ch-hello"><h1 id="chHello"></h1><p>What are we making today?</p></section>
        <button type="button" class="ch-card ch-studio" data-go="studio">
          <span class="ch-glow"></span>
          <span class="ch-art">${mi('film')}</span>
          <span class="ch-copy"><b>Video Studio</b><small>Edit the sermon, cut AI shorts, captions and exports</small></span>
          <span class="ch-foot"><span class="ch-foot-tx" id="chStudioFoot">Open a video to start</span><span class="ch-arrow">${mi('chev-right')}</span></span>
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
      const b = e.target.closest('[data-go],[data-home],[data-post],[data-job]');
      if (!b) return;
      if (b.dataset.go) return go(b.dataset.go);
      if (b.dataset.home === 'files') return $('#cloudFiles') && $('#cloudFiles').click();
      if (b.dataset.post) return compose({ files: [b.dataset.post] });
      if (b.dataset.job) return C.openJobs();
    });
    return el;
  }

  async function renderHome(refresh) {
    const el = $('#cloudHome') || buildHome();
    $('#chHello').textContent = greeting();
    const where = (C.hello && C.hello.standalone) ? 'Working on the church’s cloud server' : 'Working on the church’s studio machine';
    $('#chWhere').textContent = where + (C.hello && C.hello.version ? ` · v${C.hello.version}` : '');
    // the studio's door says what is waiting behind it
    const ed = window.VideoEditor;
    let foot = 'Open a video to start';
    if (ed && ed.hasVideo && ed.hasVideo()) foot = 'Carry on editing';
    else if (S.resumeName) foot = `Pick up “${S.resumeName}”`;
    $('#chStudioFoot').textContent = foot;
    $('#chSocialCard').classList.toggle('hidden', !S.social);
    renderHomeSocial();
    renderHomeJobs(C.jobList());
    if (!refresh) return;
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
  function renderHomeReady() {
    const sec = $('#chReady'); if (!sec) return;
    const list = S.exports.filter((f) => isVideo(f.path)).slice(0, 10);
    sec.classList.toggle('hidden', !list.length);
    $('#chReel').innerHTML = list.map((f) => `<div class="ch-tile">`
      + `<span class="ch-tile-pic" data-thumb="${escAttr(f.path)}"></span>`
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
    };
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

    function draw() {
      panel.setTitle(edit ? 'Edit post' : many() ? `Schedule ${st.files.length} posts` : 'New post');
      panel.body.innerHTML = '<div class="cs-form">'
        + `<section class="cs-sec"><h4>${many() ? 'Videos' : 'Video or picture'}</h4>${mediaBlock()}</section>`
        + (st.files.length ? `<section class="cs-sec">${textBlock()}</section>` : '')
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

    async function submit(btn) {
      btn.disabled = true;
      const accs = linked().filter((a) => picked().includes(a.id));
      const platforms = Array.from(new Set(accs.map((a) => a.platform)));
      try {
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
              caption: st.caption.trim() ? st.caption : (own.caption || titleFromFile(f)),
              mediaPaths: [f], accountIds: accs.map((a) => a.id), platforms,
              scheduledAt: times[i].toISOString(),
            });
          }
          C.island({ kind: 'good', title: `${st.files.length} posts scheduled`, sub: `First one ${whenLabel(times[0])}` });
        } else {
          const when = chosenWhen();
          const rec = await window.api.scheduler.add({
            title: st.title.trim() || titleFromFile(st.files[0]), caption: st.caption,
            mediaPaths: st.files.slice(0, 1), accountIds: accs.map((a) => a.id), platforms,
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
    go(want === 'studio' || want === 'scheduler' ? want : 'home');
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (S.view === 'scheduler') loadSocial(true).then(renderSched);
      if (S.view === 'home') renderHome(true);
    });
  }

  window.MWSocial = { start, go, compose, openConnect, view: () => S.view, _state: S, _planTimes: planTimes, _titleFromFile: titleFromFile };
})();
