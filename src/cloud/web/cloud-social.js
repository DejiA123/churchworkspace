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
  /*
   * Each Instagram mark gets its OWN gradient id. They all used to point at one
   * "mwIgG", and a gradient is found by id across the whole page: when the
   * first copy sat in something hidden (a Home banner slide not showing), every
   * Instagram mark lost its colours and drew white lines on white — invisible
   * on the light pages.
   */
  let markN = 0;
  const platMark = (p, cls) => {
    let svg = (PLAT[p] || {}).svg || '';
    if (svg.includes('mwIgG')) { const id = 'mwIgG' + (++markN); svg = svg.replace(/mwIgG/g, id); }
    return `<span class="cs-mark${cls ? ' ' + cls : ''}" title="${escAttr((PLAT[p] || {}).name || p)}">${svg}</span>`;
  };

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
    // (what came from a phone is saved as "20261016161916-IMG_0042.MOV": the stamp is the server's, not a name)
    const raw = baseName(p).replace(/\.[a-z0-9]+$/i, '').replace(/^\d{14}-(?=.)/, '');
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
  /**
   * A picture of this video for a card. The thumbnail chosen at export (the
   * AI's pick, or the one picked by hand) is kept beside the video as
   * <name>.jpg, and that is the picture the card shows; a video without one
   * gets a frame made once, on the studio machine.
   */
  function thumbFor(p, onReady) {
    if (!p) return '';
    if (isImage(p)) return C.fileUrl(p);
    const got = S.thumbs.get(p);
    if (got) return C.fileUrl(got);
    if (got === undefined) {
      S.thumbs.set(p, '');
      const frame = () => window.api.video.thumbnail(p, 1).then((t) => {
        S.thumbs.set(p, t || '');
        if (t && onReady) onReady(C.fileUrl(t));
      }).catch(() => {});
      const cover = p.replace(/\.[a-z0-9]+$/i, '.jpg');
      if (cover === p) { frame(); return ''; }
      const im = new Image();
      im.onload = () => { S.thumbs.set(p, cover); if (onReady) onReady(C.fileUrl(cover)); };
      im.onerror = frame;
      im.src = C.fileUrl(cover);
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
      // every finished video, newest first, as My Uploads lists them (Home shows its own first 10)
      S.exports = ((out && out.files) || []).filter((f) => isVideo(f.path) || isImage(f.path))
        .sort((a, b) => b.mtime - a.mtime);
      // …and what was added from the phone (videos and photos), for My Uploads in Post
      const phone = (data.groups || []).find((g) => g.key === 'uploads');
      S.phoneFiles = ((phone && phone.files) || []).filter((f) => isVideo(f.path) || isImage(f.path))
        .sort((a, b) => b.mtime - a.mtime);
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

  /*
   * ►► HOME: CHURCH SPACE'S OWN. ◄◄ "It looks like CapCut." The calm and the
   * one-tap reach stay — a big New project card, the tools as app icons — but
   * in Church Space's own colours (violet to gold), and with what no video
   * app has: this week's services, each a tap from its flyer. Every door the
   * page had is still here (Studio and projects, Montage, Post, My Uploads,
   * Help, your space).
   */
  function buildHome() {
    const el = document.createElement('div');
    el.id = 'cloudHome';
    el.className = 'cloud-home';
    const TI = (cls, extra) => `<span class="ch-ti ${cls}">${extra}</span>`;
    el.innerHTML = `
      <main class="ch-scroll">
        <header class="ch-top">
          <div class="ch-brand"><span class="ch-logo"><svg class="mw-cross" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 2.5h4v5.5h5.5v4H14v9.5h-4V12H4.5V8H10z"/></svg></span><span class="ch-name">Church Space</span></div>
          <div class="ch-acts"><span class="ch-chip-slot"></span><span class="ch-ask" id="chAsk"></span>
            <button type="button" class="ch-round ch-help" data-tool="help" aria-label="Help"><i class="ch-q">?</i></button>
            <button type="button" class="ch-round ch-me" data-home="me" aria-label="Your space"><b id="chMeInitial">${esc(((C.me && C.me.name) || '').charAt(0).toUpperCase()) || mi('user')}</b></button>
          </div>
        </header>
        <p class="ch-hello" id="chHello"></p>
        <!-- the one big thing: start something (the Video Studio and its projects) -->
        <button type="button" class="ch-new ch-studio" data-go="projects">
          <span class="ch-new-tx"><b>New project</b><span>Drop in Sunday’s sermon — we’ll do the rest</span><small id="chStudioFoot"></small></span>
          <span class="ch-new-plus" aria-hidden="true">+</span>
        </button>
        <div id="chInvite"></div>
        <div id="chEnq"></div>
        <!-- the tools, as app icons -->
        <nav class="ch-tools" aria-label="Tools">
          <button type="button" class="ch-tool" data-tool="shorts">${TI('t-shorts', mi('scissors'))}<span class="ch-tool-tx">AI Shorts</span></button>
          <button type="button" class="ch-tool" data-tool="captions">${TI('t-caps', mi('captions'))}<span class="ch-tool-tx">Captions</span></button>
          <button type="button" class="ch-tool ch-flyer" data-home="flyers">${TI('t-flyer', mi('image'))}<span class="ch-tool-tx">Flyers</span></button>
          <button type="button" class="ch-tool ch-thumb" data-home="thumbs">${TI('t-thumb', mi('thumbnail'))}<span class="ch-tool-tx">Thumbnails</span></button>
          <button type="button" class="ch-tool ch-montage" data-home="montage">${TI('t-montage', mi('sparkles'))}<span class="ch-tool-tx">AI Montage</span></button>
          <button type="button" class="ch-tool ch-social" data-go="scheduler" id="chSocialCard">${TI('t-post', mi('send') + '<i class="ch-badge hidden" id="chSocialBadge"></i>')}<span class="ch-tool-tx">Post</span>
            <small id="chSocialFoot"></small><span class="ch-marks" id="chMarks"></span></button>
          <button type="button" class="ch-tool" data-tool="upload">${TI('t-up', mi('upload'))}<span class="ch-tool-tx">Upload</span></button>
        </nav>
        <!-- this week's services, each a tap from its flyer (the church's own service days) -->
        <section class="ch-week" id="chWeek">
          <h2>This week <button type="button" class="ch-link" data-home="kit">Edit</button></h2>
          <div class="ch-week-row" id="chWeekRow"></div>
        </section>
        <section class="ch-sec hidden" id="chJobs"><h2>Running now</h2><div class="ch-jobs"></div></section>
        <section class="ch-sec hidden" id="chReady">
          <h2>Ready to post <button type="button" class="ch-link" data-home="files">See all</button></h2>
          <div class="ch-reel" id="chReel"></div>
        </section>
        <p class="ch-foot-note" id="chWhere"></p>
      </main>
      <nav class="ch-bar" aria-label="Sections">
        <button type="button" class="on" data-bar="home">${mi('home')}<span>Home</span></button>
        <button type="button" data-go="projects">${mi('film')}<span>Projects</span></button>
        <button type="button" data-home="flyers">${mi('image')}<span>Flyers</span></button>
        <button type="button" data-home="files">${mi('folder')}<span>My Uploads</span></button>
      </nav>`;
    document.body.appendChild(el);
    el.querySelector('.ch-chip-slot').appendChild(C.jobChip());
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-go],[data-home],[data-post],[data-job],[data-view],[data-proj],[data-tool],[data-bar]');
      if (!b) return;
      if (b.dataset.bar === 'home') { const sc = el.querySelector('.ch-scroll'); if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      if (b.dataset.tool === 'shorts' || b.dataset.tool === 'captions') return homeTool(b.dataset.tool);
      if (b.dataset.tool === 'saved') { const d = document.getElementById('cloudDownloads'); return d && d.click(); }
      // "Add a video": straight to the phone's own picker — My Uploads opens behind it to show it arriving
      if (b.dataset.tool === 'upload') { const f = document.getElementById('cloudFiles'); if (f) f.click(); const u = document.getElementById('cloudUpload'); return u && u.click(); }
      if (b.dataset.tool === 'help') return window.MWGuide && window.MWGuide.openHelp && window.MWGuide.openHelp();
      if (b.dataset.proj) return openProject(b.dataset.proj);
      if (b.dataset.home === 'projects') return openProjects();
      if (b.dataset.view) return C.viewFile && C.viewFile(b.dataset.view);
      if (b.dataset.go) return go(b.dataset.go);
      if (b.dataset.home === 'files') return $('#cloudFiles') && $('#cloudFiles').click();
      if (b.dataset.home === 'me') return C.openProfile && C.openProfile();
      if (b.dataset.home === 'montage') return openMontage();
      if (b.dataset.home === 'thumbs') return openThumbs();
      if (b.dataset.home === 'flyers') return openFlyers(b.dataset.occ ? { occasion: b.dataset.occ } : undefined);
      if (b.dataset.home === 'kit') return window.MWFlyerStudio && window.MWFlyerStudio.openKit ? window.MWFlyerStudio.openKit(() => renderWeek()) : openFlyers();
      if (b.dataset.post) return compose({ files: [b.dataset.post] });
      if (b.dataset.job) return C.openJobs();
    });
    renderWeek();
    return el;
  }

  /*
   * THIS WEEK: the church's own services (Tuesday Bible Study, Friday prayer,
   * Sunday service — set once in the Flyer Studio), the next few, each a tap
   * from its flyer. Nothing a video app has: this is what makes it theirs.
   */
  async function renderWeek() {
    const row = document.getElementById('chWeekRow'); if (!row) return;
    let kit = null;
    try { kit = await window.api.flyer.kitGet(); } catch (e) { kit = null; }
    const D = window.MWFlyer && window.MWFlyer.Dates;
    const occ = kit && D ? D.upcoming(kit).slice(0, 6) : [];
    if (!occ.length) {
      row.innerHTML = '<button type="button" class="ch-day ch-day-set" data-home="kit"><small>SET UP ONCE</small><b>Your service days</b><span>Add them</span></button>';
      return;
    }
    row.innerHTML = occ.map((o) => {
      const d = D.dateParts(o.date);
      const when = d ? d.dayName.slice(0, 3).toUpperCase() : '';
      const t = o.time || (o.service && o.service.time) || '';
      return `<button type="button" class="ch-day${o.seasonal ? ' season' : ''}" data-home="flyers" data-occ="${esc(o.id)}"><small>${esc(when)}${t ? ' ' + esc(D.niceTime(t)) : ''}</small><b>${esc(o.name)}</b><span>Make flyer</span></button>`;
    }).join('');
  }

  /* the Flyer Studio (cloud-flyer.js) */
  function openFlyers(opts) {
    if (window.MWFlyerStudio) return window.MWFlyerStudio.open(opts);
    C.toast('The flyer studio is still loading — try again in a moment.');
  }

  /* the YouTube thumbnail studio (cloud-flyer.js, Thumbnail mode) */
  function openThumbs(opts) {
    if (window.MWFlyerStudio && window.MWFlyerStudio.openThumb) return window.MWFlyerStudio.openThumb(opts);
    C.toast('The thumbnail studio is still loading — try again in a moment.');
  }

  /* AI Shorts or Captions from the front page: straight to the tool — a video first when none is open */
  function homeTool(kind) {
    const ed = window.VideoEditor;
    const nth = kind === 'captions' ? 2 : 1;
    const tap = () => { const b = document.querySelector(`#cloudDock .cloud-dock-row[data-row="main"] .cloud-tool:nth-child(${nth})`); if (b) b.click(); };
    const had = !!(ed && ed.hasVideo && ed.hasVideo());
    go('studio');
    if (had) return setTimeout(tap, 250);
    // (the picker straight from the tap — a phone opens one only from a tap); the tool opens once the video is in
    const o = document.getElementById('veOpen'); if (o) o.click();
    const t0 = Date.now();
    const wait = setInterval(() => {
      if (ed && ed.hasVideo && ed.hasVideo()) { clearInterval(wait); setTimeout(tap, 700); }
      else if (Date.now() - t0 > 180000 || !document.body.classList.contains('mw-in-studio')) clearInterval(wait);
    }, 500);
  }

  /* "Show me around" — the screens say what things are in a word, the tours
     say the rest (src/renderer/guide.js). They never start by themselves. */
  function registerTours() {
    const G = window.MWGuide;
    if (!G || G.has('home')) return;
    G.register('home', {
      title: 'Find your way', emoji: '🧭', before: () => go('home'),
      steps: [
        { emoji: '👋', title: 'Welcome!', body: 'Here is a quick look around.' },
        { target: '#cloudHome .ch-studio', emoji: '🎬', title: 'Make a video', body: 'Edit a video, make shorts, add captions.' },
        { target: '#cloudHome .ch-montage', emoji: '✨', title: 'AI Montage', body: 'Pick photos and videos. The AI makes the edit.' },
        { target: '#cloudHome .ch-flyer', emoji: '🎨', title: 'Flyers', body: 'Pick the service, tap Make. The AI paints the picture; your words stay exactly as typed.' },
        { target: '#chSocialCard', emoji: '📅', title: 'Post online', body: 'Send your videos and flyers to social media.' },
        { target: '#cloudHome [data-home="files"]', emoji: '📁', title: 'My Uploads', body: 'Everything is kept here: the videos and photos you added from your phone, and the shorts you made.' },
        { target: '#chAsk .mwg-ask', emoji: '❓', title: 'Need help?', body: 'Tap ? any time to see these tips again.' },
      ],
    });
    G.register('studio', {
      title: 'Edit a video', emoji: '✂️', before: () => go('studio'),
      steps: [
        { target: '#vePlayer || #veMonitors', emoji: '▶️', title: 'Your video', body: 'Tap play to watch it.' },
        { target: '#veTlScroll', emoji: '👆', title: 'Timeline', body: 'Slide it left and right to move through.' },
        { target: '#cloudDock .cloud-dock-row[data-row="main"] .cloud-tool:nth-child(1) || #veFindHighlights', emoji: '✨', title: 'AI Shorts', body: 'The AI finds the best short clips.' },
        { target: '#cloudDock .cloud-dock-row[data-row="main"] .cloud-tool:nth-child(2) || #veAutoCaptions', emoji: '💬', title: 'Captions', body: 'Words on your video, by themselves.' },
        { target: '#cloudDock .cloud-dock-row.on', emoji: '🧰', title: 'All the tools', body: 'Swipe for more. Tap one to open it.' },
        { target: '#cloudExport || #veExportEdited', emoji: '💾', title: 'Export', body: 'Save your finished video to your phone.' },
        { target: '#cloudHomeBtn', emoji: '🏠', title: 'Home', body: 'Go back to the start.' },
      ],
    });
    G.register('scheduler', {
      title: 'Post online', emoji: '📅', before: () => go('scheduler'),
      available: () => S.social,
      steps: [
        { target: '#cloudSched .csb-plus', emoji: '➕', title: 'New post', body: 'Pick a video or flyer to post.' },
        { target: '#csAccts', emoji: '🔗', title: 'Your accounts', body: 'Link Instagram, TikTok and more, once.' },
        { target: '#csTabs', emoji: '🗓️', title: 'Your posts', body: 'Planned, posted, and any that need a look.' },
      ],
    });
  }

  /*
   * ►► ENQUIRIES FROM THE PUBLIC PAGE (/hello: "Request a demo"). ◄◄ The
   * owner's home shows how many came in; tap for each one, with a tap to call,
   * WhatsApp or email them back. Nobody else sees them (the server says 403).
   */
  let enqLook = 0;   // the newest look at the list: an older reply that lands late is ignored
  async function paintEnquiries() {
    const slot = $('#chEnq'); if (!slot || !C.api) return;
    if (C.me && !C.me.owner) { slot.innerHTML = ''; return; }
    const look = ++enqLook;
    let items = [];
    try { items = (await C.api('/api/hello/enquiries')).items || []; } catch (e) { if (look === enqLook) slot.innerHTML = ''; return; }
    if (look !== enqLook) return;
    const fresh = items.filter((x) => !x.seen).length;
    slot.innerHTML = items.length ? `<button type="button" class="ch-enq${fresh ? ' new' : ''}"><span class="ch-enq-ic">${mi('mail')}</span><span class="ch-enq-tx"><b>${fresh ? `${fresh} new ${fresh === 1 ? 'enquiry' : 'enquiries'}` : 'Enquiries'}</b><small>From your Church Space page · ${items.length} in all</small></span>${mi('chev-right')}</button>` : '';
    const b = slot.querySelector('.ch-enq'); if (b) b.onclick = () => openEnquiries();
  }
  /*
   * How to answer someone, from whatever they typed as their contact: an email
   * address in it (only the address: nothing after it can add a copy or text
   * to the owner's reply), and the first phone number in it. WhatsApp needs
   * the country: given (+ or 00), an Irish mobile (08…), or a long number
   * that already starts with one; any other local number is a call only.
   */
  function enquiryReach(c) {
    const v = String(c || '');
    const out = [];
    const mail = /[^\s@?&#%,;:\/<>"'()[\]]+@[^\s@?&#%,;:\/<>"'()[\]]+\.[a-z]{2,}/i.exec(v);
    if (mail) out.push(`<a class="enq-act" href="mailto:${C.escAttr(mail[0])}?subject=Church%20Space">Email</a>`);
    const run = /(\+|\b00)?\d[\d\s().-]{5,}\d/.exec(mail ? v.replace(mail[0], ' ') : v);
    const digits = run ? run[0].replace(/\D/g, '') : '';
    if (digits.length >= 7 && digits.length <= 17) {   // 15 digits at most, after a 00
      let intl = '';
      if (run[0].startsWith('+')) intl = digits;
      else if (digits.startsWith('00')) intl = digits.slice(2);
      else if (/^08\d{8}$/.test(digits)) intl = '353' + digits.slice(1);
      else if (!digits.startsWith('0') && digits.length >= 10) intl = digits;
      out.push(`<a class="enq-act" href="tel:${intl ? '+' + intl : digits}">Call</a>`);
      if (intl) out.push(`<a class="enq-act" href="https://wa.me/${intl}" target="_blank" rel="noopener">WhatsApp</a>`);
    }
    return out.join('');
  }
  async function openEnquiries() {
    const p = C.openPanel({ id: 'cloudEnquiries', title: 'Enquiries', cls: 'cp-enquiries' });
    p.body.innerHTML = '<p class="enq-empty">Loading…</p>';
    // the list as it is now, not as Home last saw it
    let items;
    try { items = (await C.api('/api/hello/enquiries')).items || []; } catch (e) { p.body.innerHTML = '<p class="enq-empty">The enquiries did not load. Check the connection and try again.</p>'; return; }
    const when = (iso) => { try { return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
    const draw = () => {
      p.body.innerHTML = items.length ? `<div class="enq-list">${items.map((x) => `<div class="enq${x.seen ? '' : ' new'}">
          <div class="enq-top"><b>${esc(x.name)}</b><small>${esc(when(x.at))}</small></div>
          ${x.church ? `<div class="enq-church">${esc(x.church)}</div>` : ''}
          <div class="enq-contact">${esc(x.contact)}</div>
          ${x.message ? `<p class="enq-msg">${esc(x.message)}</p>` : ''}
          <div class="enq-acts">${enquiryReach(x.contact)}<button type="button" class="enq-act ghost" data-rm="${C.escAttr(x.id)}">Remove</button></div>
        </div>`).join('')}</div>`
        : '<p class="enq-empty">No enquiries yet. They arrive here from the “Request a demo” form on your public page.</p>';
    };
    draw();
    p.body.onclick = async (e) => {
      const rm = e.target.closest('[data-rm]'); if (!rm) return;
      try { await C.api('/api/hello/enquiries/remove', { id: rm.dataset.rm }); items = items.filter((x) => x.id !== rm.dataset.rm); draw(); paintEnquiries(); } catch (er) { /* stays */ }
    };
    // opened: the ones shown are read now (one that arrives meanwhile stays new)
    const shown = items.filter((x) => !x.seen).map((x) => x.id);
    if (shown.length) { enqLook++; C.api('/api/hello/enquiries/seen', { ids: shown }).then(() => paintEnquiries()).catch(() => {}); }
  }

  async function renderHome(refresh) {
    registerTours();
    const el = $('#cloudHome') || buildHome();
    if (window.MWGuide) {
      const ask = $('#chAsk');
      if (ask && !ask.firstChild) ask.appendChild(window.MWGuide.helpButton('', { title: 'How do I…?' }));
      window.MWGuide.invite('home', $('#chInvite'));
    }
    $('#chHello').textContent = greeting() + (C.me && C.me.name ? ', ' + C.me.name.split(' ')[0] : '');
    const where = (C.hello && C.hello.standalone) ? 'Working on the church’s cloud server' : 'Working on the church’s studio machine';
    void where;
    $('#chWhere').textContent = '';
    // the studio's door says what is waiting behind it
    const ed = window.VideoEditor;
    let foot = 'Open a video to start';
    if (ed && ed.hasVideo && ed.hasVideo()) foot = 'Carry on editing';
    if (S.projects && S.projects.length) foot = `${S.projects.length} project${S.projects.length > 1 ? 's' : ''}`;
    else if (S.resumeName) foot = `Pick up “${S.resumeName}”`;
    $('#chStudioFoot').textContent = foot;
    renderHomeProjects();
    $('#chSocialCard').classList.toggle('hidden', !S.social);
    renderHomeSocial();
    renderHomeJobs(C.jobList());
    if (!refresh) return;
    paintEnquiries();
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
    // the Post online tile: a word or two under its name — what is next, or what needs a look (a red badge)
    const up = upcoming();
    const foot = $('#chSocialFoot');
    const due = handTodos().find(handDue);
    const bad = failed().length;
    if (due) foot.textContent = 'Add its song';
    else if (bad) foot.textContent = `${bad} need${bad > 1 ? '' : 's'} a look`;
    else if (up.length) foot.textContent = `Next: ${whenLabel(up[0].scheduledAt)}`;
    else foot.textContent = '';
    const badge = $('#chSocialBadge');
    if (badge) { badge.textContent = due || bad ? '!' : up.length ? String(up.length) : ''; badge.classList.toggle('hidden', !(due || bad || up.length)); badge.classList.toggle('warn', !!(due || bad)); }
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
  /*
   * 🙏 THE SONG ADDED IN THE APP ITSELF. No app may put a song on a Facebook
   * post — Meta lets none (Zernio has no audio for Facebook; Facebook's Reels
   * API takes the video alone). And the library Instagram opens to apps is
   * mostly Meta's royalty-free collection: the hit gospel songs (Travis
   * Greene…) are in the apps' OWN libraries, free and licensed, never muted.
   * So, the way TikTok's inbox works, a flyer's Facebook (and, if chosen, its
   * Instagram) is handed over: the flyer to Photos, the caption to the
   * clipboard, the app opened, the taps there said. Kept on this phone until
   * done — a scheduled one waits at the top of the Scheduler (and on the home
   * screen) for its time.
   */
  const HAND_KEY = 'mw.app.handoff';
  const HAND_APPS = {
    facebook: {
      name: 'Facebook', open: 'fb://',
      where: 'on your Page (tap your picture → your Page)',
      steps: (song) => `Tap <b>＋</b> → <b>Reel</b> → pick the flyer → <b>♫ Music</b> → ${song} → <b>Next</b>.`,
      share: (later) => `Paste the caption → <b>Share now</b>${later ? ' — or, on a Page, <b>Schedule</b> it for its time' : ''}.`,
    },
    instagram: {
      name: 'Instagram', open: 'instagram://app',
      where: 'on the church’s account',
      steps: (song) => `Tap <b>＋</b> → <b>Post</b> → pick the flyer → <b>Next</b> → <b>♫ Add music</b> → ${song} → <b>Done</b>.`,
      share: () => 'Paste the caption → <b>Share</b>. It shows like a photo post, the song’s name above it.',
    },
  };
  function handTodos() {
    try {
      const l = JSON.parse(localStorage.getItem(HAND_KEY) || '[]');
      return Array.isArray(l) ? l.filter((x) => x && x.id && Array.isArray(x.items) && x.items.length && Array.isArray(x.apps) && x.apps.some((a) => HAND_APPS[a])) : [];
    } catch (e) { return []; }
  }
  function saveHandTodos(l) { try { localStorage.setItem(HAND_KEY, JSON.stringify(l.slice(-12))); } catch (e) {} }
  function addHandTodo(t) {
    const rec = Object.assign({ id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString() }, t);
    // two days past its time (or its making), one never finished is let go
    const cut = Date.now() - 2 * 864e5;
    const alive = (x) => new Date(x.at).getTime() > cut || x.items.some((i) => i.when && new Date(i.when).getTime() > cut);
    saveHandTodos(handTodos().filter(alive).concat(rec));
    return rec;
  }
  const doneHandTodo = (id) => saveHandTodos(handTodos().filter((x) => x.id !== id));
  // its time has come (or is a quarter of an hour off)
  const handDue = (t) => t.items.some((i) => !i.when || new Date(i.when).getTime() <= Date.now() + 15 * 60e3);
  const appNames = (t) => t.apps.filter((a) => HAND_APPS[a]).map((a) => HAND_APPS[a].name).join(' and ');
  // the caption as the app gets it from here: its own trending tags in place of the app-neutral ones
  function appCaption(caption, app) {
    const t = String(caption || '').trim();
    if (!/#[\wÀ-￿]/.test(t)) return t;
    const body = t.replace(/(\s*#[\wÀ-￿]+)+\s*$/, '').trim();
    return (body ? body + '\n\n' : '') + tagsFor(t, app);
  }
  function renderHandTodo() {
    const box = $('#csHandTodo'); if (!box) return;
    box.innerHTML = handTodos().map((t) => {
      const it = t.items[0], due = handDue(t);
      return `<button type="button" class="csb-handtodo${due ? ' due' : ''}" data-handtodo="${escAttr(t.id)}">`
        + `<span class="csb-stack">${t.apps.filter((a) => HAND_APPS[a]).map((a) => platMark(a, 'sm')).join('')}</span>`
        + `<span><b>${esc(appNames(t))}: add your gospel song${due ? ' now' : ''}</b>`
        + `<small>${esc(it.title || 'Flyer')}${t.items.length > 1 ? ` + ${t.items.length - 1} more` : ''} · ${it.when ? esc(whenLabel(it.when)) : 'now'}</small></span>`
        + `<span class="ch-arrow">${mi('chev-right')}</span></button>`;
    }).join('');
  }
  function openHandOff(t) {
    const apps = t.apps.filter((a) => HAND_APPS[a]);
    const panel = C.openPanel({ id: 'csHandOff', title: `Finish on ${appNames(t)}`, cls: 'cp-handoff' });
    // the flyers, fetched ahead: an iPhone opens the share sheet only inside the tap, with the file already in hand
    const files = new Map();
    t.items.forEach((it, i) => {
      fetch(C.fileUrl(it.file)).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then((blob) => {
        const ext = String(blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
        files.set(i, new File([blob], `flyer-${i + 1}.${ext}`, { type: blob.type || 'image/jpeg' }));
      }).catch(() => files.set(i, null));
    });
    const later = t.items.some((i) => i.when && new Date(i.when).getTime() > Date.now() + 15 * 60e3);
    const song = t.song ? `search <b>${esc(t.song)}</b> (or any gospel song)` : 'search <b>Travis Greene</b> (or any gospel song)';
    const copyBtn = (i, a) => `<button type="button" class="cs-btn" data-f="copy" data-i="${i}" data-app="${a}">${mi('copy')}${apps.length > 1 ? 'Caption · ' + HAND_APPS[a].name : 'Copy caption'}</button>`;
    panel.body.innerHTML = '<div class="csb-hand">'
      + `<p class="cs-hint">The hit gospel songs are in ${esc(appNames(t))}’s own library — free there, licensed, never muted or flagged. No app may add them from outside, so here is everything for the app:</p>`
      + t.items.map((it, i) => `<div class="csb-handrow"><img src="${escAttr(C.fileUrl(it.file))}" alt=""><span><b>${esc(it.title || 'Flyer')}</b><small>${it.when ? 'For ' + esc(whenLabel(it.when)) : 'Now'}</small></span>`
        + `<div class="csb-handbtns"><button type="button" class="cs-btn" data-f="save" data-i="${i}">${mi('download')}Save flyer</button>`
        + apps.map((a) => copyBtn(i, a)).join('') + '</div></div>').join('')
      + apps.map((a) => {
        const A = HAND_APPS[a];
        return `<div class="csb-handapp"><div class="csb-fm-h">${platMark(a, 'sm')}<b>${A.name}</b></div><ol class="csb-handsteps">`
          + `<li><b>Save flyer</b> → <b>Save Image</b>, and copy its caption (above).</li>`
          + `<li><a class="cs-btn csb-handopen ${a}" href="${A.open}">${platMark(a, 'sm')}Open ${A.name}</a> ${A.where}.</li>`
          + `<li>${A.steps(song)}</li><li>${A.share(later)}</li></ol></div>`;
      }).join('')
      + '</div>';
    panel.foot.innerHTML = `<button type="button" class="cs-btn primary" data-f="done">✓ Done — it is on ${esc(appNames(t))}</button>`
      + '<button type="button" class="cs-btn ghost" data-f="later">Later</button>';
    const copyOld = (text) => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove(); return ok;
    };
    const copied = (b) => { b.classList.add('done'); C.island({ kind: 'good', title: 'Caption copied', sub: 'Paste it in the app', ms: 2500 }); };
    panel.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      const f = b.dataset.f, i = +b.dataset.i || 0, it = t.items[i];
      if (f === 'save') {
        const file = files.get(i);
        if (file === undefined) { C.island({ kind: 'info', title: 'One moment — the flyer is still coming', ms: 2500 }); return; }
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file] }).then(() => { b.innerHTML = mi('check') + 'Saved'; b.classList.add('done'); },
            (er) => { if (!(er && er.name === 'AbortError')) openFlyer(it); });
        } else openFlyer(it);
        return;
      }
      if (f === 'copy') {
        const text = appCaption(it.caption, b.dataset.app);
        // the clipboard, inside the tap; the old way if this phone says no
        let p = null;
        try { if (navigator.clipboard && navigator.clipboard.writeText) p = navigator.clipboard.writeText(text); } catch (er) { p = null; }
        if (p && p.then) p.then(() => copied(b), () => { if (copyOld(text)) copied(b); else C.island({ kind: 'warn', title: 'This phone would not copy it', sub: 'Type the caption in the app instead', ms: 4000 }); });
        else if (copyOld(text)) copied(b);
        return;
      }
      if (f === 'done') {
        doneHandTodo(t.id); panel.close(); renderSched(); renderHomeSocial();
        C.island({ kind: 'good', title: `${appNames(t)} done`, sub: 'With its gospel song', ms: 2500 });
        return;
      }
      if (f === 'later') { panel.close(); renderSched(); }
    });
    function openFlyer(it) {
      window.open(C.fileUrl(it.file), '_blank');
      C.island({ kind: 'info', title: 'Press and hold the flyer → Save to Photos', ms: 6000 });
    }
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
      + `<span class="pj-tx"><b>${esc(projName(r.name))}</b>`
      + `<small>${openNow ? '<i class="pj-now">Open now</i> · ' : ''}${r.videoMissing ? 'Its video was deleted' : esc(`Edited ${agoWords(r.savedAt)}`) + (bits ? ' · ' + esc(bits) : '')}</small></span>`
      + (o.manage ? '' : `<span class="pj-go">${mi('chev-right')}</span>`) + '</button>'
      + (o.manage && r.videoPath && !r.videoMissing ? keepBtnHtml(r.videoPath, 'pj-more') : '')
      + (o.manage ? `<button type="button" class="pj-more" data-pjren="${escAttr(r.id)}" aria-label="Rename">${mi('pen')}</button>`
        + `<button type="button" class="pj-more" data-pjdup="${escAttr(r.id)}" aria-label="Duplicate"${r.videoMissing ? ' disabled' : ''}>${mi('copy')}</button>`
        + `<button type="button" class="pj-more pj-del" data-pjdel="${escAttr(r.id)}" aria-label="Delete">${mi('trash')}</button>` : '')
      + '</div>';
  }
  /*
   * ⬇ KEEP ON THIS PHONE (cloud-boot.js MWOffline): the video is downloaded so
   * it plays and scrubs with no signal; ✓ when it is here (tap to free the room).
   */
  function keepBtnHtml(video, cls) {
    const K = window.MWOffline; if (!K) return '';
    const k = K.keptFor(video), pr = K.progress(video);
    const label = k ? 'On this phone — tap to remove' : pr ? 'Keeping it on this phone…' : 'Keep on this phone (works with no signal)';
    const pct = pr && pr.total ? Math.round((pr.got / pr.total) * 100) + '%' : '';
    return `<button type="button" class="${cls} pj-keep${k ? ' on' : ''}${pr ? ' busy' : ''}" data-pjkeep="${escAttr(video)}" aria-label="${escAttr(label)}" title="${escAttr(label)}">`
      + (pr ? `<span class="pj-keep-pct">${pct || '…'}</span>` : mi(k ? 'check' : 'download'))
      + (cls === 'pv-cur-keep' ? `<span>${k ? 'On this phone' : pr ? 'Keeping…' : 'Keep offline'}</span>` : '') + '</button>';
  }
  async function keepToggle(video) {
    const K = window.MWOffline, ed = window.VideoEditor;
    if (!K || !ed || !ed.keepCopyFor || K.progress(video)) return;
    if (K.keptFor(video)) {
      if (!window.confirm('Remove this video from your phone?\n\nThe project and the video on the studio stay — it just needs a signal to play again.')) return;
      await K.unkeep(video);
      C.island({ id: 'keep', title: 'Removed from this phone', sub: 'It plays from the studio again', ms: 3000 });
      return renderProjectsView();
    }
    C.island({ id: 'keep', title: 'Getting it ready to keep…', spin: true, sticky: true });
    const off = K.onChange(() => {
      const pr = K.progress(video);
      if (pr) C.island({ id: 'keep', title: `Keeping it on this phone… ${pr.total ? Math.round((pr.got / pr.total) * 100) + '%' : ''}`, sub: 'Stay on Wi-Fi until it is done', spin: true, sticky: true });
      if (S.view === 'projects') { const b = document.querySelector(`[data-pjkeep="${CSS.escape(video)}"]`); if (b) b.outerHTML = keepBtnHtml(video, b.classList.contains('pv-cur-keep') ? 'pv-cur-keep' : 'pj-more'); }
    });
    try {
      const { play, info } = await ed.keepCopyFor(video);
      const rec = await K.keep(video, play, info);
      C.island({ id: 'keep', kind: 'good', title: 'Kept on this phone', sub: `It plays and scrubs with no signal${rec && rec.size ? ' · ' + Math.round(rec.size / 1e6) + ' MB' : ''}`, ms: 4500 });
      if (ed.useKeptCopy) ed.useKeptCopy();
    } catch (e) {
      C.island({ id: 'keep', kind: 'warn', title: 'It could not be kept on this phone', sub: (e && e.message) || 'Try again on Wi-Fi', ms: 6000 });
    } finally { off(); }
    if (S.view === 'projects') renderProjectsView();
  }
  // the home screen lists no projects (the Video Studio card says how many and opens them) — kept for a home that has the list
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
  /* Delete the project open in the editor — the studio's Project row, or the
   * card at the top of Projects. Only the edit goes; then back to Projects. */
  async function deleteOpenProject() {
    const ed = window.VideoEditor;
    if (!ed || !ed.deleteProject || !(ed.hasVideo && ed.hasVideo())) {
      C.island({ kind: 'warn', title: 'No project is open', sub: 'Open one from Projects first', ms: 3500 });
      return false;
    }
    const id = ed.projectId ? ed.projectId() : null;
    const row = id ? (S.projects || []).find((r) => r.id === id) : null;
    const nm = row ? row.name : String((ed.sourcePath && ed.sourcePath()) || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    if (!window.confirm(`Delete this project${nm ? ` “${nm}”` : ''}?\n\nThe video and anything you exported stay — only this edit goes.`)) return false;
    let ok = false;
    try { ok = await ed.deleteProject(); } catch (e) { ok = false; }
    if (!ok) { C.island({ kind: 'warn', title: 'That project could not be deleted', ms: 4000 }); return false; }
    if (id && S.projects) S.projects = S.projects.filter((r) => r.id !== id);
    C.island({ title: 'Project deleted', ms: 2500 });
    if (S.view === 'projects') renderProjectsView(); else go('projects');
    return true;
  }
  /* A project named after its video's file ("short-Test_short-20261012-154054")
     reads as a person would say it; a name someone typed is left as it is. */
  const projName = (n) => {
    const t = String(n || '').trim();
    if (!t) return 'Untitled project';
    return /\d{8}[-_]\d{4,6}|^\d{12,14}[-_ ]|^(short|edited)[-_]|_/i.test(t) && C.friendlyName ? C.friendlyName(t) : t;
  };
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
          <span class="pv-new-tx"><b>New project</b></span>
        </button>
        <section class="pv-cur hidden" id="pvCur"></section>
        <h2 class="pv-h">Your projects <small id="pvCount"></small></h2>
        <div class="pj-list" id="pvList"></div>
      </main>`;
    document.body.appendChild(el);
    el.querySelector('.cs-chip-slot').appendChild(C.jobChip());
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-go],[data-pv],[data-proj],[data-pjren],[data-pjdup],[data-pjdel],[data-pjkeep]');
      if (!b || b.disabled) return;
      if (b.dataset.pjkeep) return keepToggle(b.dataset.pjkeep);
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
      if (b.dataset.pv === 'delete') return deleteOpenProject();
      if (b.dataset.pv === 'duplicate') {
        // the open edit as it is this moment: saved first, then copied
        const ed = window.VideoEditor;
        try { if (ed && ed.flushProject) await ed.flushProject(); } catch (er) {}
        const id = ed && ed.projectId ? ed.projectId() : null;
        if (!id) { C.island({ kind: 'warn', title: 'Nothing to copy yet', sub: 'Open a video in the editor first', ms: 3500 }); return; }
        return duplicateProject(id);
      }
      if (b.dataset.pjdup) return duplicateProject(b.dataset.pjdup);
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
  /* ⧉ Duplicate: the same video and every edit, as a project of its own
     ("Copy of …"), first in the list, to try something without losing this. */
  async function duplicateProject(id) {
    let row = null;
    try { row = await window.api.sessions.duplicate(id); } catch (e) { row = null; }
    if (!row || !row.id) { C.island({ kind: 'warn', title: 'That project could not be copied', sub: 'Try again in a moment', ms: 4000 }); return null; }
    C.island({ title: 'Project duplicated', sub: `“${projName(row.name)}”: the same video and edits, to change as you like`, ms: 3800 });
    await renderProjectsView();
    return row;
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
      cur.innerHTML = `<button type="button" class="pv-cont" data-pv="continue"><span class="pv-cont-k">Open in the editor</span><b>${esc(nm || 'Your video')}</b><span class="pv-cont-go">Continue ${mi('chev-right')}</span></button>`
        + `<div class="pv-cur-acts">${ed.sourcePath && ed.sourcePath() ? keepBtnHtml(ed.sourcePath(), 'pv-cur-keep') : ''}<button type="button" class="pv-cur-dup" data-pv="duplicate">${mi('copy')}Duplicate</button>`
        + `<button type="button" class="pv-cur-del" data-pv="delete">${mi('trash')}Delete this project</button></div>`;
    }
    const others = rows.filter((r) => r.id !== openId);
    $('#pvCount', el).textContent = rows.length ? String(rows.length) : '';
    list.innerHTML = others.length
      ? others.map((r) => projRow(r, { manage: true })).join('')
      : (rows.length ? '<p class="pv-none">This is your only project so far.</p>'
        : `<div class="pj-empty"><span class="pj-empty-art">${mi('layers')}</span><b>No projects yet</b></div>`);
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

  /*
   * ►► THE SCHEDULER, CREATOR-STUDIO STYLE (the design the church chose). ◄◄
   * Media first, like CapCut or TikTok Studio: the accounts as real cards
   * (name, platform, live), the next post as a big "Up next" card, then what
   * is coming as 9:16 tiles with their time on them — and the next free best
   * time as a tile of its own, one tap from a post for it.
   */
  function buildSched() {
    const el = document.createElement('div');
    el.id = 'cloudSched';
    el.className = 'cloud-sched csb';
    el.innerHTML = `
      <header class="csb-top">
        <button type="button" class="csb-round" data-go="home" aria-label="Home">${mi('chev-left')}</button>
        <span class="cs-chip-slot"></span>
      </header>
      <main class="cs-scroll csb-scroll">
        <div class="csb-head">
          <div><h1>Posts</h1></div>
          <span class="csb-ask" id="csAsk"></span>
          <button type="button" class="csb-plus" data-sched="new" aria-label="New post">${mi('plus')}<span>New post</span></button>
        </div>
        <div class="csb-handtodos" id="csHandTodo"></div>
        <div class="csb-h2"><h2>Accounts</h2><button type="button" class="csb-link" data-sched="connect">Manage</button></div>
        <section class="csb-accts" id="csAccts"></section>
        <nav class="csb-seg" id="csTabs" role="tablist">
          <button type="button" data-tab="upcoming" role="tab">Planned</button>
          <button type="button" data-tab="posted" role="tab">Posted</button>
          <button type="button" data-tab="failed" role="tab">Needs a look</button>
        </nav>
        <div class="csb-list" id="csList"></div>
      </main>`;
    document.body.appendChild(el);
    el.querySelector('.cs-chip-slot').appendChild(C.jobChip());
    if (window.MWGuide) el.querySelector('#csAsk').appendChild(window.MWGuide.helpButton('scheduler', { title: 'Show me around' }));
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button,[data-open-post]');
      if (!b) return;
      if (b.dataset.go) return go(b.dataset.go);
      if (b.dataset.handtodo) { const t = handTodos().find((x) => x.id === b.dataset.handtodo); return t ? openHandOff(t) : renderSched(); }
      if (b.dataset.sched === 'new') return compose({});
      // (several videos from here carry on the plan's own spacing)
      if (b.dataset.sched === 'slot') return compose({ when: new Date(+b.dataset.at), spacing: +b.dataset.gap || undefined });
      if (b.dataset.sched === 'connect') return openConnect();
      if (b.dataset.tab) { S.tab = b.dataset.tab; return renderSched(); }
      if (b.dataset.openPost) return openPost(b.dataset.openPost);
    });
    return el;
  }

  const platsOf = (p) => Array.from(new Set((p.platforms || []).concat(((p.accountIds || []).map((id) => (S.accounts.find((a) => a.id === id) || {}).platform)).filter(Boolean))));
  const stack = (plats) => `<span class="csb-stack">${plats.map((x) => platMark(x, 'sm')).join('')}</span>`;
  // "Tmrw 7 PM", "Sat 9:30 AM": fits on a 9:16 tile
  const compactTime = (t) => { const d = new Date(t); return d.getMinutes() ? timeOf(d) : d.toLocaleTimeString(undefined, { hour: 'numeric' }); };
  const shortWhen = (d) => {
    const t = new Date(d);
    const day = dayName(t);
    const near = Math.abs(t.getTime() - Date.now()) < 6 * 86400e3;
    return (day === 'Today' ? 'Today' : day === 'Tomorrow' ? 'Tmrw' : day === 'Yesterday' ? 'Yday'
      : near ? t.toLocaleDateString(undefined, { weekday: 'short' }) : t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })) + ' ' + compactTime(t);
  };
  // the next best time with nothing booked near it (two hours either side), within a fortnight
  /*
   * ►► THE + TILE: THE NEXT TIME IN THE PLAN. ◄◄ "The furthest post is 31 Oct
   * 00:00 — the best time is obviously after it." The plan goes on where it
   * stops, in its own rhythm (posts every 6 hours → 31 Oct 06:00), not in a
   * gap earlier on. Nothing booked: the next hour people look.
   */
  const gapHours = (ms) => { const h = ms / 3600e3; return h % 24 === 0 ? (h === 24 ? 'day' : h / 24 + ' days') : (Math.round(h * 4) / 4) + ' h'; };
  function rhythmOf(times) {
    // the usual gap between the last few booked posts (the median), when it is a steady one
    const gaps = [];
    for (let i = Math.max(1, times.length - 10); i < times.length; i++) { const g = times[i] - times[i - 1]; if (g >= 30 * 60000) gaps.push(g); }
    if (!gaps.length) return null;
    gaps.sort((a, b) => a - b);
    const mid = gaps[Math.floor(gaps.length / 2)];
    // (a plan booked "every 6 hours" is exactly that: gaps within a few minutes of each other, most of them)
    const steady = gaps.length >= 2 && gaps.filter((g) => Math.abs(g - mid) <= 5 * 60000).length >= Math.max(2, Math.ceil(gaps.length * 0.6));
    return steady && mid >= 3600e3 && mid <= 7 * 864e5 ? Math.round(mid / 900000) * 900000 : null;
  }
  function freeSlot() {
    const soon = Date.now() + 30 * 60000;
    const taken = upcoming().map((p) => new Date(p.scheduledAt).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
    if (!taken.length) return { at: nextWindow(new Date(soon)), gap: null };
    const last = taken[taken.length - 1], gap = rhythmOf(taken);
    if (gap) return { at: new Date(Math.max(last + gap, soon)), gap };
    // one post, or no steady rhythm: the next hour people look, at least two hours after the last one
    return { at: nextWindow(new Date(Math.max(last + 2 * 3600e3, soon))), gap: null };
  }

  function renderSched() {
    if (S.view !== 'scheduler') return;
    const el = $('#cloudSched') || buildSched();
    renderHandTodo();
    // the accounts, as cards: who they are and where
    const acc = linked();
    $('#csAccts').innerHTML = acc.map((a) => `<button type="button" class="csb-acc" data-sched="connect">`
      + `<span class="csb-acc-top">${a.picture ? `<span class="csb-acc-pic" style="background-image:url('${escAttr(a.picture)}')">${platMark(a.platform, 'badge')}</span>` : platMark(a.platform, 'lg')}<i class="csb-live" title="Connected"></i></span>`
      + `<b>${esc(a.name || (PLAT[a.platform] || {}).name || a.platform)}</b><small>${esc((PLAT[a.platform] || {}).name || a.platform)}</small></button>`).join('')
      + `<button type="button" class="csb-acc add" data-sched="connect"><span class="csb-acc-plus">${mi('plus')}</span><b>${acc.length ? 'Add account' : 'Connect accounts'}</b><small>${acc.length ? 'TikTok, YouTube…' : 'One tap sets them up'}</small></button>`;
    // the tabs, with counts
    const counts = { upcoming: upcoming().length, posted: posted().length, failed: failed().length };
    for (const t of $$('#csTabs [data-tab]')) {
      const k = t.dataset.tab;
      t.classList.toggle('on', S.tab === k);
      t.setAttribute('aria-selected', S.tab === k ? 'true' : 'false');
      t.innerHTML = `${{ upcoming: 'Planned', posted: 'Posted', failed: 'Needs a look' }[k]}${counts[k] ? `<i${k === 'failed' ? ' class="bad"' : ''}>${counts[k]}</i>` : ''}`;
    }
    const list = S.tab === 'posted' ? posted() : S.tab === 'failed' ? failed() : upcoming();
    const box = $('#csList');
    if (!list.length) {
      box.innerHTML = emptySched();
      return;
    }
    let html = '';
    if (S.tab === 'upcoming') {
      const [first, ...rest] = list;
      html += '<div class="csb-h2"><h2>Up next</h2></div>' + heroCard(first);
      const slot = freeSlot(), free = slot && slot.at;
      if (rest.length || free) {
        html += `<div class="csb-h2"><h2>Coming up</h2><span class="csb-dim">${rest.length ? `${rest.length} more` : ''}</span></div><div class="csb-grid">`
          + rest.map((p) => tile(p, p.scheduledAt)).join('')
          + (free ? `<button type="button" class="csb-tile free" data-sched="slot" data-at="${free.getTime()}"${slot.gap ? ` data-gap="${slot.gap / 3600e3}"` : ''}><span class="csb-free-plus">${mi('plus')}</span>`
            + `<b>${esc(dayName(free))} ${esc(timeOf(free))}</b><small>${slot.gap ? 'Next in your plan · every ' + esc(gapHours(slot.gap)) : 'Best time ' + esc(timeOf(free))}</small></button>` : '')
          + '</div>';
      }
    } else {
      html += '<div class="csb-grid">' + list.map((p) => tile(p, S.tab === 'posted' ? (p.postedAt || p.scheduledAt) : p.scheduledAt)).join('') + '</div>';
    }
    box.innerHTML = html;
    paintThumbs(box);
  }

  function heroCard(p) {
    const media = (p.mediaPaths || [])[0];
    const st = statusOf(p);
    const plats = platsOf(p);
    const n = (p.accountIds || []).length || plats.length;
    const cap = String(p.caption || '').split('\n').find((l) => l.trim()) || '';
    return `<button type="button" class="csb-hero" data-open-post="${escAttr(p.id)}">`
      + `<span class="csb-hero-pic" ${media ? `data-thumb="${escAttr(media)}"` : ''}>${media && isVideo(media) ? `<i class="csb-play">${mi('play')}</i>` : media ? '' : mi('type')}</span>`
      + '<span class="csb-hero-main">'
      + `<span class="csb-hero-when"><b>${esc(dayName(p.scheduledAt).toUpperCase())} · ${esc(timeOf(p.scheduledAt))}</b><i>${esc(fromNow(p.scheduledAt))}</i></span>`
      + `<span class="csb-hero-title">${esc(p.title || 'Untitled post')}</span>`
      + (cap ? `<span class="csb-hero-cap">${esc(cap)}</span>` : '')
      + `<span class="csb-hero-foot">${stack(plats)}<span class="csb-dim">${n} account${n === 1 ? '' : 's'}</span><span class="cs-state ${st.cls}">${esc(st.tx)}</span></span>`
      + '</span></button>';
  }
  function tile(p, when) {
    const media = (p.mediaPaths || [])[0];
    const st = statusOf(p);
    return `<button type="button" class="csb-tile" data-open-post="${escAttr(p.id)}" ${media ? `data-thumb="${escAttr(media)}"` : ''}>`
      + `<span class="csb-time">${esc(shortWhen(when))}</span>`
      + (st.cls !== 'planned' ? `<span class="cs-state ${st.cls}">${esc(st.tx)}</span>` : '')
      + (media && isVideo(media) ? `<i class="csb-play sm">${mi('play')}</i>` : '')
      + `<span class="csb-tile-foot"><b>${esc(p.title || 'Untitled post')}</b>${stack(platsOf(p))}</span>`
      + '</button>';
  }

  function emptySched() {
    if (!S.keys.zo && !linked().length && S.tab === 'upcoming') {
      return `<div class="csb-empty"><div class="csb-empty-art">${PLAT_ORDER.map((p) => platMark(p, 'lg')).join('')}</div>`
        + '<b>Post everywhere from here</b><p>Connect TikTok, YouTube, Instagram and Facebook once. Then pick a finished short — the AI writes the caption — choose a time, and it goes out on its own, even with this phone off.</p>'
        + `<button type="button" class="csb-cta" data-sched="connect">${mi('link')}Connect accounts</button></div>`;
    }
    const msg = {
      upcoming: ['Nothing planned yet', 'Pick a short or a flyer — the AI writes the caption, you choose the time.'],
      posted: ['Nothing posted yet', 'Posts that have gone out show up here, with a link to each one.'],
      failed: ['All good', 'Nothing needs a look.'],
    }[S.tab];
    return `<div class="csb-empty"><div class="csb-empty-art solo">${mi(S.tab === 'failed' ? 'check' : 'calendar')}</div><b>${msg[0]}</b><p>${msg[1]}</p>`
      + (S.tab === 'upcoming' ? `<button type="button" class="csb-cta" data-sched="new">${mi('plus')}New post</button>` : '') + '</div>';
  }

  function statusOf(p) {
    if (p.status === 'posting') return { cls: 'posting', tx: 'Posting now…' };
    if (p.status === 'posted') {
      // a flyer waiting in the TikTok inbox (for its song) is not out yet
      const ok = Object.values(p.results || {}).filter((r) => r && r.ok);
      if (ok.length && ok.every((r) => r.inbox)) return { cls: 'booked', tx: 'In TikTok inbox' };
      return { cls: 'posted', tx: 'Posted' };
    }
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
      const note = (r && r.ok && r.note) || (h && h.ok && h.note) || '';
      if ((r && r.ok && r.inbox) || (!r && h && h.ok && h.inbox)) { line = r ? 'In your TikTok inbox — open TikTok, tap the notification, add your song and post' : 'Goes to your TikTok inbox at its time — then open TikTok, add your song and post'; cls = 'warn'; }
      else if (r && r.ok) { line = r.url ? `<a href="${escAttr(r.url)}" target="_blank" rel="noopener">Posted — open it ${mi('external')}</a>` : 'Posted'; cls = 'ok'; }
      else if (r && !r.ok) { line = esc(r.error || 'Did not post'); cls = 'bad'; }
      else if (h && h.ok) { line = `Booked — ${esc((PLAT[a.platform] || {}).name || 'the platform')} will post it at its time`; cls = 'ok'; }
      else if (he) { line = esc(he.why || 'Could not book it yet — it will try again'); cls = he.cannotSchedule ? '' : 'warn'; }
      if (note && !(r && r.inbox) && !(h && h.inbox)) line += ` · ${esc(note)}`;
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
          if (warn) C.island({ kind: 'warn', title: 'Deleted here — still being taken back there', sub: warn + ' — the app keeps trying; if it is still there before its time, delete it there by hand.', ms: 12000 });
          else C.island({ kind: 'good', title: 'Post deleted', sub: (r && r.pending && r.note) || p.title || '', ms: r && r.pending ? 6000 : 3500 });
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
      const inboxOnly = now && now.status === 'posted' && statusOf(now).tx === 'In TikTok inbox';
      if (inboxOnly) C.island({ kind: 'info', title: 'In your TikTok inbox', sub: 'Open TikTok, tap the notification, add your song and post.', ms: 9000 });
      else if (now && now.status === 'posted') C.island({ kind: 'good', title: 'Posted', sub: now.title || '', action: { label: 'View', onClick: () => { go('scheduler'); S.tab = 'posted'; renderSched(); } } });
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
      cover: edit ? edit.coverPath || null : (o.cover || null),   // 🖼 the video's thumbnail (a picture on the studio)
      title: edit ? edit.title || '' : '',
      caption: edit ? edit.caption || '' : '',
      accountIds: edit ? (edit.accountIds || []).slice() : (S.loadedAt ? linked().map((a) => a.id) : null),
      when: edit ? new Date(edit.scheduledAt) : null,
      quick: edit ? 'pick' : 'best',
      spacing: 24,
      snap: false,          // a bulk: exactly every N hours, or nudged onto the best times
      options: null,
      writing: false,
      batchCaps: {},
      music: null,          // { free: id | 'auto' } or { lib: id } — laid under the video before it posts
      musicMood: 'uplift',
      shelf: null, songs: [],
      // 🎵 a flyer's music, per platform (see flyerBlock): each app's own trending songs by default
      // (TikTok: the church picks a GOSPEL song in TikTok by default — TikTok's own pick can be any genre)
      // NO free instrumentals, ever: real songs from the apps' own libraries, the church's own recording, or none
      fm: Object.assign({ mode: 'trending', tiktok: 'draft', fbyt: 'none', fb: 'app', igWay: 'lib', fromIg: [], ig: null, igQ: '', igList: null, igState: '', igFor: '', lib: null }, flyerPrefs()),
      // ✨ the AI caption: written by itself the moment something is chosen
      ai: null,             // { stage: 'listen'|'read'|'write'|'done'|'fail', pct, from: 'video'|'flyer'|'picture', by, note, flyer }
      autoFor: '',          // the file the caption on screen was written for (a re-pick drops a late answer)
      prev: null,           // the caption before Shorter / More hype / Rewrite, for Undo
      revising: '',
      // who is speaking and the church's name — optional, remembered on this phone; with
      // neither, the caption names nobody (no "the speaker", no "our church")
      names: (() => { try { return JSON.parse(localStorage.getItem('mw.social.names') || '{}') || {}; } catch (e) { return {}; } })(),
      namesOpen: false,
    };
    if (o.when && !edit) { st.quick = 'pick'; st.when = new Date(o.when); }
    if (o.spacing >= 1 && o.spacing <= 336 && !edit) st.spacing = o.spacing;
    // the free shelf and the operator's own songs, for the Music section
    (async () => {
      try { st.shelf = await window.api.freeMusic.list(false); } catch (e) { st.shelf = null; }
      try { const l = await window.api.library.list(); st.songs = ((l && l.music) || []).filter((m) => !/^free:/.test(m.source || '')); } catch (e) { st.songs = []; }
      if (panel.el.isConnected && st.files.length) draw();
    })();
    const panel = C.openPanel({ id: 'csCompose', title: edit ? 'Edit post' : 'New post', cls: 'cp-compose', onClose: () => { stopIgPreview(); clearTimeout(igTimer); clearInterval(igWatch); } });
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
    // a batch starts from the time chosen (a free-slot tile), or from the next best time
    /*
     * ►► A BULK, ONE BY ONE, OVER DAYS. ◄◄ "Every 6 hours" means every 6
     * hours: the first goes at the start chosen (Now, Tonight, Pick…), each
     * next one the gap later, for as many days as it takes. "Nudge to the best
     * times" moves each onto the nearest hour people look instead.
     */
    const batchStart = () => (st.quick === 'now' ? new Date(Date.now() + 2 * 60000) : chosenWhen());
    const batchTimes = () => {
      const n = st.files.length, start = batchStart();
      if (st.snap) return planTimes(n, st.spacing, start);
      return Array.from({ length: n }, (_, i) => new Date(start.getTime() + i * st.spacing * 3600e3));
    };
    const gapWords = (h) => (h % 24 === 0 ? (h === 24 ? 'every day' : `every ${h / 24} days`) : h === 1 ? 'every hour' : `every ${h} hours`);

    const sendLine = (it) => {
      const pct = Math.round(it.pct || 0);
      const i = it.info || {};
      let t = `Sending to the studio… ${pct}%`;
      if (i.rate && i.total && pct < 100) {
        const left = Math.max(0, (i.total - (i.sent || 0)) / i.rate);
        t += left < 60 ? ` · ${Math.max(5, Math.ceil(left / 5) * 5)} s left` : ` · ${Math.ceil(left / 60)} min left`;
      }
      return pct >= 100 ? 'Almost there…' : t;
    };
    const firstPlat = () => { const a = linked().find((x) => picked().includes(x.id) && /tiktok|instagram/.test(x.platform)) || linked().find((x) => picked().includes(x.id)); return a || null; };
    function mediaBlock() {
      if (st.sending && st.sending.items.length > 1) {
        // a bulk send: a tile each, with its own progress
        const its = st.sending.items;
        const done = its.filter((x) => (x.pct || 0) >= 100).length;
        return `<div class="csb-h3"><b>Sending ${Math.min(its.length, done + 1)} of ${its.length} to the studio…</b><button type="button" class="csb-link" data-c="stopsend">Stop all</button></div>`
          + '<div class="csb-strip">' + its.map((it, i) => `<div class="csb-strip-it sending" data-send="${i}"${!it.video && it.url ? ` style="background-image:url('${escAttr(it.url)}')"` : ''}>`
            + (it.video && it.url ? `<video src="${escAttr(it.url)}#t=0.5" muted playsinline preload="metadata"></video>` : '')
            + `<span class="csb-send mini"><span class="csb-send-bar"><i style="width:${Math.max(3, it.pct || 0)}%"></i></span><span class="csb-send-tx">${(it.pct || 0) >= 100 ? '✓' : Math.round(it.pct || 0) + '%'}</span></span></div>`).join('') + '</div>';
      }
      if (st.sending) {
        return '<div class="csb-sending">' + st.sending.items.map((it, i) => `<div class="csb-prev sending${it.video ? '' : ' pic'}" data-send="${i}"${!it.video && it.url ? ` style="background-image:url('${escAttr(it.url)}')"` : ''}>`
          + (it.video && it.url ? `<video src="${escAttr(it.url)}" muted playsinline autoplay loop preload="metadata"></video>` : '')
          + `<span class="csb-send"><span class="csb-send-name">${esc(it.name)}</span><span class="csb-send-bar"><i style="width:${Math.max(3, it.pct || 0)}%"></i></span>`
          + `<span class="csb-send-tx">${esc(sendLine(it))}</span></span>`
          + (i === 0 ? `<button type="button" class="csb-pill right" data-c="stopsend">${mi('x')}<span>Stop</span></button>` : '')
          + '</div>').join('') + '</div>';
      }
      if (!st.files.length) {
        const err = st.sendErr ? `<p class="csb-send-err">${mi('alert')}<span>${esc(st.sendErr)}</span></p>` : '';
        return '<div class="csb-choose">'
          + `<button type="button" class="csb-src" data-c="exports"><span class="csb-src-ic">${mi('film')}</span><b>My Uploads</b><small>What you made, and videos and photos you added</small></button>`
          + `<button type="button" class="csb-src" data-c="device"><span class="csb-src-ic">${mi('upload')}</span><b>From this ${phone() ? 'phone' : 'computer'}</b><small>Videos or flyers — pick one, or many at once</small></button>`
          + '</div>' + err;
      }
      if (many()) {
        // each post is a card below (picture, time, caption): here only a way to add more
        return '<div class="csb-addrow">'
          + `<button type="button" class="csb-act" data-c="device">${mi('upload')}Add from ${phone() ? 'phone' : 'computer'}</button>`
          + `<button type="button" class="csb-act" data-c="exports">${mi('film')}Add exports</button></div>`;
      }
      // one post: the picture as it will be seen, with its caption on it
      const f = st.files[0];
      const a = firstPlat();
      const lines = String(st.caption || '').split('\n').map((l) => l.trim()).filter(Boolean);
      // the preview shows the hashtags THIS app gets
      const tags = a && APP_TAGS[a.platform] && lines.some((l) => /^#/.test(l)) ? tagsFor(st.caption, a.platform) : lines.filter((l) => /^#/.test(l)).join(' ');
      const body = lines.filter((l) => !/^#/.test(l)).join(' ');
      return `<div class="csb-prev${isVideo(f) ? '' : ' pic'}" data-thumb="${escAttr(f)}">`
        + `<span class="csb-pill">${a ? platMark(a.platform, 'sm') : mi('eye')}<span>${a ? esc((PLAT[a.platform] || {}).name || '') + ' preview' : 'Preview'}</span></span>`
        + `<button type="button" class="csb-pill right" data-c="change">${mi('refresh')}<span>Change</span></button>`
        + (isVideo(f) ? `<i class="csb-play" data-c="play" data-f="${escAttr(f)}" role="button" aria-label="Play">${mi('play')}</i>` : '')
        + `<span class="csb-prev-txt"><b>${esc(a ? '@' + String(a.name || '').replace(/^@/, '').replace(/\s+/g, '').toLowerCase() : '@yourchurch')}</b>`
        + `<span class="csb-prev-cap" id="csbPrevCap">${body ? esc(body) : st.ai && st.ai.stage !== 'done' && st.ai.stage !== 'fail' ? '<i class="csb-shim w80"></i><i class="csb-shim w60"></i>' : '<em>Your caption shows here</em>'}</span>`
        + (tags ? `<span class="csb-prev-tags" id="csbPrevTags">${esc(tags)}</span>` : '')
        + '</span></div>';
    }
    function accountsBlock() {
      const acc = linked();
      if (!acc.length) {
        return `<button type="button" class="cs-connect-cta" data-c="connect">${PLAT_ORDER.map((p) => platMark(p, 'sm')).join('')}<span><b>Connect an account</b><small>TikTok, YouTube, Instagram or Facebook</small></span>${mi('chev-right')}</button>`;
      }
      return `<div class="csb-h3"><b>Posting to ${picked().length} of ${acc.length} account${acc.length === 1 ? '' : 's'}</b><button type="button" class="csb-link" data-c="connect">Manage</button></div>`
        + '<div class="csb-pills">' + acc.map((a) => {
          const on = picked().includes(a.id);
          return `<button type="button" class="csb-acc-pill ${a.platform}${on ? ' on' : ''}" data-c="acct" data-id="${escAttr(a.id)}" aria-pressed="${on}">`
            + `${platMark(a.platform, 'md')}<span>${esc(a.name || a.platform)}</span><i class="csb-check">${mi('check')}</i></button>`;
        }).join('') + '</div>';
    }
    /*
     * 🎵 MUSIC ON A FLYER — "no one engages a flyer with no music". The
     * trending gospel songs come from each app's OWN licensed library, the
     * only way they never get a post muted or flagged:
     *   TikTok — TikTok's trending music added by TikTok, or the post sent to
     *     the TikTok inbox to pick any song there (Travis Greene and all);
     *   Instagram — a song from the library Instagram opens to apps, chosen
     *     right here (🙏 Gospel: songs BY gospel artists — accounts.js
     *     _igGospelMix), or added in the Instagram app itself (openHandOff);
     *   Facebook — no app may put a song there, so the flyer and caption are
     *     handed over right after Post and the song is added in the Facebook
     *     app, from Facebook's own library (openHandOff);
     *   YouTube — no library an app may use.
     * Or the church's own recording, or no music — never a free
     * instrumental. publisher.js flyerPlan
     * does what this says.
     */
    const flyers = () => (edit ? [] : st.files.filter((f) => !isVideo(f)));
    // gospel first (songs BY gospel artists), then the artists one by one — never a word search like "praise",
    // which brings back any song with the word in it; "Trending" is everything Instagram has trending (any genre)
    const IG_QUICK = [['__gospel', '🙏 Gospel'], ['Travis Greene', 'Travis Greene'], ['Maverick City Music', 'Maverick City'], ['Elevation Worship', 'Elevation Worship'],
      ['CeCe Winans', 'CeCe Winans'], ['Dunsin Oyekan', 'Dunsin Oyekan'], ['Nathaniel Bassey', 'Nathaniel Bassey'], ['Sinach', 'Sinach'],
      ['Mercy Chinwo', 'Mercy Chinwo'], ['Moses Bliss', 'Moses Bliss'], ['Forrest Frank', 'Forrest Frank'], ['Brandon Lake', 'Brandon Lake'],
      ['', '🔥 Trending (any genre)']];
    // what the search box shows for a chip ("🙏 Gospel" is a mix of gospel artists, not the word)
    const igQShown = (q) => (String(q || '').startsWith('__') ? '' : String(q || ''));
    // the church's own recording, when one is chosen (for Facebook, YouTube — never a free instrumental)
    const ownSong = () => { const fm = st.fm; if (fm.fbyt !== 'own' || !fm.lib) return null; const x = st.songs.find((m) => m.id === fm.lib); return x ? '“' + String(x.name || 'your recording') + '”' : null; };
    // what each place gets — the same rules as publisher.js flyerPlan
    function flyerWhat(a) {
      const fm = st.fm, mode = fm.mode, zo = a.via === 'zernio', own = ownSong();
      const withOwn = (what) => (own ? `${what} with ${own} — your own recording` : null);
      if (a.platform === 'tiktok') {
        if (mode === 'none') return zo ? 'a photo post, no music' : 'a 10-second video of the flyer, no music';
        if (!zo) return withOwn('a 15-second video') || 'a 10-second video of the flyer, no music';
        return fm.tiktok === 'draft' ? 'sent to your TikTok inbox — you add the gospel song there and post' : 'a photo post with a trending song TikTok adds';
      }
      if (a.platform === 'instagram') {
        if (mode === 'none') return 'a picture post, no music';
        if (igApp(a)) return 'you add the gospel song in the Instagram app (any song — Travis Greene…) — the flyer and caption are handed to you right after Post';
        if (igSongFor(a)) return `your flyer as it is (like a photo post) with “${fm.ig.title}”${fm.ig.artist ? ' — ' + fm.ig.artist : ''}`;
        if (igAutoFor(a)) return 'your flyer as it is (like a photo post) with a real gospel song from Instagram’s library — a different one each time';
        if (igNoGospel()) return withOwn('your flyer as it is') || 'a picture post, no music — Instagram’s library for apps has no gospel artists for this account (see below)';
        return withOwn('your flyer as it is') || 'a picture post, no music (Instagram’s songs are not reachable for it yet)';
      }
      if (mode === 'none') return a.platform === 'youtube' ? 'a 10-second Short, no music' : 'a picture post, no music';
      if (fromIg(a)) return 'gets your Instagram Reel with its gospel song — Instagram shares it to this Page';
      if (fbApp(a)) return 'you add a real gospel song in the Facebook app — the flyer and caption are handed to you right after Post';
      if (a.platform === 'youtube') return withOwn('a 15-second Short') || 'a 10-second Short, no music';
      return withOwn('your flyer as it is') || 'a picture post, no music';
    }
    // the Instagram account whose library the chosen song is from — the only one that gets it
    const igSongFor = (a) => !!(st.fm.ig && st.fm.igWay !== 'app' && a.platform === 'instagram' && a.via === 'zernio' && (!st.fm.ig.acc || st.fm.ig.acc === a.id));
    // an Instagram whose song is added in the Instagram app (any song there): handed over right after Post
    const igApp = (a) => !!(a.platform === 'instagram' && st.fm.mode === 'trending' && st.fm.igWay === 'app');
    // the gospel artists were searched and Instagram's library for apps has none of them for this account
    const igNoGospel = () => st.fm.igQ === '__gospel' && Array.isArray(st.fm.igList) && !st.fm.igList.length && !st.fm.igState;
    // where the church's own recording would play (no app library there): Facebook, YouTube, a TikTok not on Zernio,
    // an Instagram whose library cannot be reached — and an Instagram with its own song keeps it, for if Instagram
    // will not take its song on the day
    function wantsOwn(accs) {
      if (st.fm.mode === 'none') return false;
      return accs.some((a) => (a.platform === 'tiktok' && a.via !== 'zernio') || (a.platform === 'instagram' && !igApp(a)) || ((a.platform === 'facebook' && !fromIg(a) && !fbApp(a)) || a.platform === 'youtube'));
    }
    function saveFlyerPrefs() { try { localStorage.setItem('mw.flyer.music', JSON.stringify({ mode: st.fm.mode, tiktok: st.fm.tiktok, fbyt: st.fm.fbyt, fb: st.fm.fb, igWay: st.fm.igWay, fromIg: st.fm.fromIg })); } catch (e) {} }
    // Instagram's own library answers for the chosen Instagram account (not "link through Facebook first" etc.)
    const igLibOk = () => !['needsFb', 'unavailable', 'error'].includes(st.fm.igState);
    const igZo = () => linked().find((x) => picked().includes(x.id) && x.platform === 'instagram' && x.via === 'zernio');
    // a REAL gospel song picked from Instagram's library for an Instagram with none chosen (main.js withFlyerMusic)
    const igAutoFor = (a) => !!(st.fm.mode === 'trending' && st.fm.igWay !== 'app' && a.platform === 'instagram' && a.via === 'zernio' && !igSongFor(a) && igLibOk() && !igNoGospel());
    // a Facebook Page that gets the Instagram Reel (with its gospel song) through Instagram's own sharing
    const fromIg = (a) => !!(a.platform === 'facebook' && st.fm.mode === 'trending' && st.fm.fb !== 'app' && igZo() && (st.fm.fromIg || []).includes(a.id));
    // a Facebook that gets its gospel song in the Facebook app: not posted from here — handed over right after Post
    const fbApp = (a) => !!(a.platform === 'facebook' && st.fm.mode === 'trending' && st.fm.fb === 'app');
    // the trending hashtags each chosen app gets (its own discovery tags, then the post's church tags)
    function appTagsRow() {
      const plats = Array.from(new Set(linked().filter((a) => picked().includes(a.id)).map((a) => a.platform))).filter((p) => APP_TAGS[p]);
      // (a caption with no hashtags is posted as written)
      if (!plats.length || !/#[\wÀ-￿]/.test(st.caption)) return '';
      return '<div class="csb-apptags" id="csbAppTags"><small>Trending hashtags each app gets</small>'
        + plats.map((p) => `<span class="csb-apptag" data-p="${p}">${platMark(p, 'sm')}<span>${esc(tagsFor(st.caption, p))}</span></span>`).join('') + '</div>';
    }
    function flyerBlock() {
      const pics = flyers();
      if (!pics.length) return '';
      const accs = linked().filter((a) => picked().includes(a.id));
      const fm = st.fm;
      const chip = (on, attrs, label) => `<button type="button" class="cs-chip${on ? ' on' : ''}" ${attrs}>${label}</button>`;
      const what = pics.length === st.files.length ? (pics.length > 1 ? 'These flyers go' : 'This flyer goes') : 'Flyers go';
      let html = `<div class="csb-h3"><b>${mi('music')} Music on your flyer</b></div>`
        + '<div class="cs-chips csb-fm-mode">'
        + chip(fm.mode === 'trending', 'data-c="fm-mode" data-v="trending"', '🙏 Real gospel songs')
        + chip(fm.mode === 'none', 'data-c="fm-mode" data-v="none"', 'No music')
        + '</div>';
      if (fm.mode === 'trending') html += '<p class="cs-hint">Real gospel songs from each app’s own library — licensed by the app, so never muted or flagged. No instrumentals, ever.</p>';
      const tk = accs.filter((a) => a.platform === 'tiktok');
      const ig = accs.filter((a) => a.platform === 'instagram');
      if (accs.length) {
        html += `<div class="csb-fnote" id="csbFlyerNote"><b>${what} out as</b>`
          + accs.map((a) => `<span class="csb-fnote-row" data-p="${a.platform}">${platMark(a.platform, 'sm')}<span><b>${esc((PLAT[a.platform] || {}).name || a.platform)}</b> · ${esc(flyerWhat(a))}</span></span>`).join('')
          + '</div>';
      }
      if (fm.mode === 'trending' && tk.some((a) => a.via === 'zernio')) {
        html += `<div class="csb-fm-sec"><div class="csb-fm-h">${platMark('tiktok', 'sm')}<b>TikTok song</b></div><div class="cs-chips">`
          + chip(fm.tiktok === 'draft', 'data-c="fm-tk" data-v="draft"', '🙏 I’ll pick a gospel song in TikTok')
          + chip(fm.tiktok === 'trending', 'data-c="fm-tk" data-v="trending"', '✨ TikTok picks a trending song (any genre)')
          + '</div>'
          + (fm.tiktok === 'draft'
            ? '<p class="cs-hint">At its time it lands in your TikTok inbox: open TikTok → tap the notification → <b>Add sound</b> → search <b>Travis Greene</b> (or any gospel song) → Post. Any song TikTok offers your account is licensed for it — free, never flagged.</p>'
            : '<p class="cs-hint">TikTok adds one of its trending songs by itself and it goes out on time — but TikTok chooses it, so it may not be gospel.</p>')
          + '</div>';
      }
      if (fm.mode === 'trending' && ig.length) html += igPicker(ig.some((a) => a.via === 'zernio'));
      // Facebook: no app may put a song there — the Facebook app can, from its own library: the flyer is handed over
      const fbs = accs.filter((a) => a.platform === 'facebook');
      if (fm.mode === 'trending' && fbs.length) {
        html += `<div class="csb-fm-sec"><div class="csb-fm-h">${platMark('facebook', 'sm')}<b>Facebook song</b></div><div class="cs-chips">`
          + chip(fm.fb === 'app', 'data-c="fm-fb" data-v="app"', '🙏 I’ll add the gospel song in Facebook')
          + chip(fm.fb !== 'app', 'data-c="fm-fb" data-v="here"', 'Post it from here')
          + '</div>'
          + (fm.fb === 'app'
            ? '<p class="cs-hint">Facebook lets no app put a song on a post — but its own app can, free, from Facebook’s licensed library (never muted or flagged). Right after you tap Post, the studio hands you the flyer and the caption: Facebook → <b>＋ → Reel</b> → pick the flyer → <b>♫ Music</b> → search <b>Travis Greene</b> (or any gospel song) → Share. Half a minute.</p>'
            : '<p class="cs-hint">Facebook gets the flyer as a picture post from here (or with your own recording, below).</p>')
          + '</div>';
      }
      // …or the Instagram Reel, with its gospel song, shared by Instagram to the Page linked to it
      if (fm.mode === 'trending' && fm.fb !== 'app' && fbs.length && igZo()) {
        html += `<div class="csb-fm-sec"><div class="csb-fm-h">${platMark('facebook', 'sm')}<b>Or: Instagram shares its Reel</b></div>`
          + '<p class="cs-hint">Instagram can share its Reel, with its gospel song, to the Facebook Page linked to it. Tap the Page that is linked:</p><div class="cs-chips">'
          + fbs.map((a) => `<button type="button" class="cs-chip${(fm.fromIg || []).includes(a.id) ? ' on' : ''}" data-c="fm-fromig" data-id="${escAttr(a.id)}">${(fm.fromIg || []).includes(a.id) ? '✓ ' : ''}${esc(a.name || 'Facebook')} gets the Instagram Reel</button>`).join('')
          + '</div>'
          + ((fm.fromIg || []).length ? '<p class="cs-hint">Once, in the Instagram app: <b>Settings → Accounts Center → Sharing across profiles</b> → choose this Page → turn on <b>Reels</b>. Check the Page after the first flyer: if the Reel is not there, untick it here and the Page gets the flyer as before.</p>' : '')
          + '</div>';
      }
      // Facebook and YouTube (no song library any app may use): the church's own gospel recording, or none
      if (wantsOwn(accs)) {
        const chip2 = (on, attrs, label) => `<button type="button" class="cs-chip${on ? ' on' : ''}" ${attrs}>${label}</button>`;
        const ownWhere = Array.from(new Set(accs.filter((a) => (a.platform === 'facebook' && !fromIg(a) && !fbApp(a)) || a.platform === 'youtube'
          || (a.platform === 'tiktok' && a.via !== 'zernio') || (a.platform === 'instagram' && !igApp(a))).map((a) => (PLAT[a.platform] || {}).name || a.platform)));
        html += `<div class="csb-fm-sec"><div class="csb-fm-h">${mi('music')}<b>Your own recording · ${esc(ownWhere.join(', '))}</b></div><div class="cs-chips">`
          + chip2(fm.fbyt === 'own', 'data-c="fm-fbyt" data-v="own"', '🎵 Our own gospel recording')
          + chip2(fm.fbyt !== 'own', 'data-c="fm-fbyt" data-v="none"', 'No music')
          + '</div>'
          + (ownSong() ? `<p class="cs-hint">${esc(ownSong())} — your church’s own recording.</p>` : '')
          + (fm.fbyt === 'own' ? (st.songs.length ? '<div class="cs-chips">' + st.songs.slice(0, 12).map((x) => `<button type="button" class="cs-chip${fm.lib === x.id ? ' on' : ''}" data-c="fm-lib" data-v="${escAttr(x.id)}">🎵 ${esc(String(x.name || 'song').slice(0, 24))}</button>`).join('') + '</div>'
            : '<p class="cs-hint">Add your choir’s or worship team’s recording in <b>My music</b> first — it shows here.</p>') : '')
          + '<p class="cs-hint">Real hit gospel songs (Travis Greene…) cannot be put on Facebook or YouTube by any app — they get the post muted or flagged. Your own recordings are free and safe.</p>'
          + '</div>';
      }
      // 🧪 the whole chain, on the real accounts, nothing public (main.js social:musicCheck)
      const ck = st.check;
      html += '<div class="csb-fm-sec csb-check-sec">'
        + `<button type="button" class="cs-btn ghost csb-mcheck" data-c="fm-check"${ck && ck.busy ? ' disabled' : ''}>${ck && ck.busy ? '<i class="csb-spin"></i> Testing your accounts… (a minute)' : '🧪 Test music on my accounts'}</button>`
        + (ck && ck.checks ? '<ul class="csb-mres">' + ck.checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}">${c.platform ? platMark(c.platform, 'sm') : mi('music')}<span><b>${c.ok ? '✅' : '⚠️'} ${esc(c.name)}</b><small>${esc(c.what)}</small></span></li>`).join('') + '</ul>'
          : ck && ck.error ? `<p class="cs-hint">${esc(ck.error)}</p>`
            : '<p class="cs-hint">Books a test flyer with its music on each account a month ahead — so Zernio, Instagram and TikTok check it for real — then takes it straight back. Nothing is posted.</p>')
        + '</div>';
      return html;
    }
    function igPicker(zo) {
      const fm = st.fm;
      const chip = (on, attrs, label) => `<button type="button" class="cs-chip${on ? ' on' : ''}" ${attrs}>${label}</button>`;
      const app = fm.igWay === 'app' || !zo;
      let h = `<div class="csb-fm-sec" id="csbIgPick"><div class="csb-fm-h">${platMark('instagram', 'sm')}<b>Instagram song</b>`
        + (fm.ig && !app ? `<button type="button" class="csb-link" data-c="fm-ig-clear">Remove</button>` : '') + '</div>'
        + '<div class="cs-chips">'
        + (zo ? chip(!app, 'data-c="fm-igway" data-v="lib"', '🎵 Pick it here — posts by itself') : '')
        + chip(app, 'data-c="fm-igway" data-v="app"', '🙏 I’ll add it in Instagram (any song)')
        + '</div>';
      if (app) {
        return h + '<p class="cs-hint">Every song is in the Instagram app’s own library — Travis Greene, Dunsin Oyekan, CeCe Winans… free and licensed, never muted. Right after you tap Post, the studio hands you the flyer and the caption: Instagram → <b>＋ → Post</b> → pick the flyer → <b>♫ Add music</b> → search the song → Share. It shows like a photo post with the song’s name above it.</p></div>';
      }
      if (fm.ig) {
        h += `<div class="csb-igsong on">${fm.ig.cover ? `<img src="${escAttr(fm.ig.cover)}" alt="">` : `<i class="csb-igart">${mi('music')}</i>`}<span><b>${esc(fm.ig.title)}</b><small>${esc(fm.ig.artist || '')}</small></span><i class="csb-check">${mi('check')}</i></div>`;
      }
      h += `<input class="cs-input csb-igsearch" type="search" enterkeyhint="search" placeholder="Search Instagram’s songs — e.g. Travis Greene" value="${escAttr(igQShown(fm.igQ))}" data-c="fm-igq-in">`
        + '<div class="cs-chips csb-igquick">' + IG_QUICK.map(([q, l]) => `<button type="button" class="cs-chip${fm.igQ === q ? ' on' : ''}" data-c="fm-igq" data-v="${escAttr(q)}">${esc(l)}</button>`).join('') + '</div>'
        + `<div id="csbIgList">${igListHtml()}</div></div>`;
      return h;
    }
    function igListHtml() {
      const fm = st.fm;
      if (fm.igState === 'loading') return '<p class="cs-hint"><i class="csb-spin"></i> Finding songs…</p>';
      if (fm.igState === 'needsUnlink') return `<p class="cs-hint">${esc(fm.igErr || '')}</p>`
        + '<p class="cs-hint">Nothing to pay: Zernio’s own way to switch an account to a Facebook sign-in is to unlink it first. It takes a minute — sign in with Facebook on the page that opens and choose this Instagram.</p>'
        + '<button type="button" class="cs-btn csb-igfb" data-c="fm-ig-fb2">Unlink and link through Facebook (free)</button>';
      if (fm.igState === 'linking') return '<p class="cs-hint"><i class="csb-spin"></i> Sign in with Facebook on the page that opened and choose this Instagram — this page carries on by itself when it is linked.</p>';
      if (fm.igState === 'needsFb') return '<p class="cs-hint">Instagram opens its song library only to an account linked through Facebook. One sign-in, once:</p>'
        + `<button type="button" class="cs-btn csb-igfb" data-c="fm-ig-fb">Link Instagram through Facebook</button>`
        + '<p class="cs-hint">Until then Instagram gets the flyer as a picture (or with your own recording, if you chose one).</p>';
      if (fm.igState === 'unavailable' || fm.igState === 'error') return `<p class="cs-hint">${esc(fm.igErr || 'Instagram’s songs could not be loaded just now.')} Instagram gets the flyer as a picture meanwhile (or with your own recording).</p>`;
      if (!fm.igList) return '';
      if (!fm.igList.length) {
        return fm.igQ === '__gospel'
          ? '<p class="cs-hint">The library Instagram opens to apps has none of the gospel artists for this account (on a Business account it is mostly Meta’s royalty-free music). Two ways to real gospel:</p>'
            + '<p class="cs-hint">• Add the song in the Instagram app yourself — every song is there: <button type="button" class="csb-link" data-c="fm-igway" data-v="app">I’ll add it in Instagram</button></p>'
            + '<p class="cs-hint">• Or, once, in Instagram: <b>Settings → Account type and tools → Switch to creator account</b> (free — Creator accounts get the licensed music), then tap 🙏 Gospel again.</p>'
          : `<p class="cs-hint">Instagram has no song matching “${esc(igQShown(fm.igQ))}” — try a gospel artist’s name (Travis Greene, CeCe Winans, Dunsin Oyekan…).</p>`;
      }
      return '<div class="csb-iglist">' + fm.igList.slice(0, 15).map((x, i) => `<div class="csb-igsong${fm.ig && fm.ig.id === x.id ? ' on' : ''}" data-c="fm-ig" data-i="${i}" role="button" tabindex="0">`
        + (x.cover ? `<img src="${escAttr(x.cover)}" alt="" loading="lazy">` : `<i class="csb-igart">${mi('music')}</i>`)
        + `<span><b>${esc(x.title)}</b><small>${esc(x.artist || '')}${x.seconds ? ' · ' + Math.floor(x.seconds / 60) + ':' + String(x.seconds % 60).padStart(2, '0') : ''}</small></span>`
        + `<button type="button" class="csb-igplay${igPlaying === x.id ? ' on' : ''}" data-c="fm-ig-play" data-i="${i}" aria-label="Listen">${igPlaying === x.id ? mi('pause') : mi('play')}</button>`
        + '</div>').join('') + '</div>';
    }
    // ▶ a song: one <audio> for the sheet, started inside the tap (an iPhone plays nothing started later) and fed
    // the studio's copy of the preview (main.js social:igPreview — Instagram's own link expires and is fussy)
    let igTimer = null, igSeq = 0, igAudioEl = null, igPlaying = null, igPlaySeq = 0;
    async function loadIg(q) {
      clearTimeout(igTimer);
      const acc = linked().find((a) => picked().includes(a.id) && a.platform === 'instagram' && a.via === 'zernio');
      if (!acc) return;
      const fm = st.fm, my = ++igSeq;
      fm.igQ = q; fm.igState = 'loading'; fm.igFor = acc.id;
      const paint = () => {
        const box = panel.body.querySelector('#csbIgList'); if (box) box.innerHTML = igListHtml();
        panel.body.querySelectorAll('.csb-igquick .cs-chip').forEach((c) => c.classList.toggle('on', c.dataset.v === fm.igQ));
        const inp = panel.body.querySelector('.csb-igsearch'); if (inp && document.activeElement !== inp) inp.value = igQShown(fm.igQ);
      };
      paint();
      try {
        const r = await window.api.social.igAudio(acc.id, q);
        if (my !== igSeq) return;
        if (r && r.needsFacebookLogin) fm.igState = 'needsFb';
        else if (r && r.unavailable) { fm.igState = 'unavailable'; fm.igErr = r.unavailable; }
        else { fm.igState = ''; fm.igList = (r && r.songs) || []; }   // (nothing matched: an empty list, said as such)
      } catch (er) { if (my !== igSeq) return; fm.igState = 'error'; fm.igErr = (er && er.message) || ''; }
      paint();
    }
    // waiting for the Instagram linked through Facebook: it takes the old link's place, then its songs load
    let igWatch = null;
    function watchIgLink(oldId) {
      clearInterval(igWatch);
      const until = Date.now() + 10 * 60000;
      igWatch = setInterval(async () => {
        if (!panel.el.isConnected || Date.now() > until) {
          clearInterval(igWatch);
          if (panel.el.isConnected && st.fm.igState === 'linking') { st.fm.igState = 'needsFb'; const bx = panel.body.querySelector('#csbIgList'); if (bx) bx.innerHTML = igListHtml(); }
          return;
        }
        let r = null;
        try { r = await window.api.social.linkClaim('instagram', false); } catch (e) { return; }
        if (!r || !r.account) return;
        clearInterval(igWatch);
        await loadSocial(true);
        const nu = r.account.id;
        if (nu && nu !== oldId) st.accountIds = picked().map((x) => (x === oldId ? nu : x)).filter((x, i, a) => a.indexOf(x) === i);
        Object.assign(st.fm, { igState: '', igList: null, igErr: '', igFor: '', ig: null });
        C.island({ kind: 'good', title: 'Instagram is linked through Facebook', sub: 'Its song library is open — your scheduled Instagram posts were moved over.', ms: 6000 });
        draw();
      }, 4000);
    }
    function stopIgPreview() {
      igPlaySeq++; igPlaying = null;
      if (igAudioEl) { try { igAudioEl.pause(); } catch (e) {} }
      if (panel.el.isConnected) panel.body.querySelectorAll('.csb-igplay.on, .csb-igplay.busy').forEach((n) => { n.classList.remove('on', 'busy'); n.innerHTML = mi('play'); });
    }
    function playIg(x, b) {
      const acc = linked().find((a) => a.id === st.fm.igFor) || igZo();
      if (!acc) return;
      if (!igAudioEl) { igAudioEl = new Audio(); igAudioEl.preload = 'auto'; }
      const el = igAudioEl, my = igPlaySeq;
      // unlocked by this very tap: a moment of silence now, the song when it is here
      try { el.src = SILENCE; const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
      igPlaying = x.id;
      b.classList.add('on', 'busy'); b.innerHTML = '<i class="csb-spin"></i>';
      window.api.social.igPreview(acc.id, x.id, x.preview || '').then((r) => {
        if (my !== igPlaySeq || !r || !r.path) return;
        el.src = C.fileUrl(r.path);
        el.onended = () => { if (my === igPlaySeq) stopIgPreview(); };
        const pr = el.play();
        if (pr && pr.catch) pr.catch(() => { if (my === igPlaySeq) { stopIgPreview(); C.island({ kind: 'warn', title: 'Tap ▶ once more to listen', ms: 3500 }); } });
        b.classList.remove('busy'); b.innerHTML = mi('pause');
      }, (er) => {
        if (my !== igPlaySeq) return;
        stopIgPreview();
        C.island({ kind: 'warn', title: 'That song cannot be played here', sub: (er && er.message) || 'Instagram gave no preview of it — it still posts with it.', ms: 5000 });
      });
    }
    function whenBlock() {
      if (many()) {
        const times = batchTimes();
        const gaps = [[1, '1 h'], [2, '2 h'], [3, '3 h'], [6, '6 h'], [12, '12 h'], [24, 'Daily'], [48, '2 days']];
        const custom = !gaps.some(([h]) => h === st.spacing);
        const last = times[times.length - 1];
        return '<small class="csb-lbl">Starts</small><div class="cs-chips">'
          + [['now', 'Now'], ['best', '✦ Best time'], ['hour', 'In an hour'], ['tonight', 'Tonight 7 pm'], ['tomorrow', 'Tomorrow 9 am'], ['pick', 'Pick…']].map(([k, l]) =>
            `<button type="button" class="cs-chip${st.quick === k ? ' on' : ''}" data-c="quick" data-k="${k}">${l}</button>`).join('')
          + '</div>'
          + (st.quick === 'pick' ? `<label class="cs-dt-wrap">${mi('calendar')}<input type="datetime-local" class="cs-dt" data-c="dt" value="${localInput(chosenWhen())}" min="${localInput(new Date())}" aria-label="Date and time"></label>` : '')
          + '<small class="csb-lbl">Then one every</small><div class="cs-chips">'
          + gaps.map(([h, l]) => `<button type="button" class="cs-chip${st.spacing === h ? ' on' : ''}" data-c="spacing" data-h="${h}">${l}</button>`).join('')
          + `<button type="button" class="cs-chip${custom ? ' on' : ''}" data-c="spacing-other">${custom ? `${st.spacing} h` : 'Other…'}</button></div>`
          + (st.spacingOther ? `<label class="csb-gap"><input class="cs-input" type="number" min="1" max="336" step="1" inputmode="numeric" data-c="gap" value="${st.spacing}"><span>hours between posts</span></label>` : '')
          + `<label class="csb-snap"><input type="checkbox" data-c="snap"${st.snap ? ' checked' : ''}><span>✦ Nudge each onto the best times people look</span></label>`
          + `<p class="csb-plan">${mi('calendar')}<span><b>${times.length} posts, ${esc(gapWords(st.spacing))}</b>${esc(shortWhen(times[0]))} → ${esc(shortWhen(last))} · one at a time, by themselves</span></p>`;
      }
      const w = chosenWhen();
      return '<div class="cs-chips">'
        + [['now', 'Now'], ['best', '✦ Best time'], ['hour', 'In an hour'], ['tonight', 'Tonight 7 pm'], ['tomorrow', 'Tomorrow 9 am'], ['pick', 'Pick…']].map(([k, l]) =>
          `<button type="button" class="cs-chip${st.quick === k ? ' on' : ''}" data-c="quick" data-k="${k}">${l}</button>`).join('')
        + '</div>'
        + (st.quick === 'pick' ? `<label class="cs-dt-wrap">${mi('calendar')}<input type="datetime-local" class="cs-dt" data-c="dt" value="${localInput(w)}" min="${localInput(new Date())}" aria-label="Date and time"></label>` : '');
    }
    // what the AI is doing, in words
    function aiStatus() {
      const ai = st.ai;
      if (!ai) return '';
      if (ai.stage === 'listen') return `<span class="csb-ai-st busy"><i class="csb-spin"></i>Listening${ai.pct ? ` · ${ai.pct}%` : '…'}</span>`;
      if (ai.stage === 'read') return '<span class="csb-ai-st busy"><i class="csb-spin"></i>Reading the flyer…</span>';
      if (ai.stage === 'write') return '<span class="csb-ai-st busy"><i class="csb-spin"></i>Writing…</span>';
      if (st.revising) return '<span class="csb-ai-st busy"><i class="csb-spin"></i>Changing it…</span>';
      if (ai.stage === 'done') return `<span class="csb-ai-st ok">${mi('check')}Ready</span>`;
      return '';
    }
    function namesRow() {
      const n = st.names || {};
      const has = n.speaker || n.church;
      if (!st.namesOpen) {
        return `<button type="button" class="csb-names-btn" data-c="names">${mi('user')}<span>${has ? esc([n.speaker, n.church].filter(Boolean).join(' · ')) : 'Name the speaker and church (optional)'}</span>${mi('chev-right')}</button>`;
      }
      return '<div class="csb-names">'
        + `<label><small>Who is speaking?</small><input class="cs-input" data-n="speaker" maxlength="80" value="${escAttr(n.speaker || '')}" placeholder="e.g. Bishop David Richman"></label>`
        + `<label><small>Church name</small><input class="cs-input" data-n="church" maxlength="80" value="${escAttr(n.church || '')}" placeholder="e.g. The Power House International"></label>`
        + `<div class="csb-names-acts"><button type="button" class="csb-act" data-c="names-save">${mi('sparkles')}Use them — write it again</button>`
        + `<button type="button" class="csb-act ghost" data-c="names-clear">Leave names out</button></div>`
        + '<small class="csb-names-hint">Left empty, captions name nobody — never "the speaker" or "our church". Remembered on this phone.</small></div>';
    }
    function textBlock() {
      if (many()) {
        // ►► BULK: every post its own card — its picture, its time, its own AI caption to edit
        const n = st.files.filter((f) => st.batchCaps[f]).length;
        const times = batchTimes();
        return `<div class="csb-ai"><div class="csb-ai-head"><span class="csb-ai-ic">${mi('sparkles')}</span><b>AI captions</b><small>one for each post</small>${st.writing ? `<span class="csb-ai-st busy"><i class="csb-spin"></i>${esc(st.writing)}</span>` : n ? `<span class="csb-ai-st ok">${mi('check')}${n} of ${st.files.length}</span>` : ''}</div>`
          + '<div class="csb-bposts">' + st.files.map((f, i) => {
            const own = st.batchCaps[f];
            const writing = st.writingFile === f;
            return `<div class="csb-bpost"><span class="csb-bpic"${isVideo(f) ? ` data-c="play" data-f="${escAttr(f)}" role="button" aria-label="Play"` : ''} data-thumb="${escAttr(f)}">${isVideo(f) ? `<i class="csb-play sm">${mi('play')}</i>` : ''}</span>`
              + `<div class="csb-bmain"><small>${mi('clock')}${esc(times[i] ? shortWhen(times[i]) : '')}</small>`
              + (own ? `<textarea class="cs-input csb-bcap" data-bcap="${i}" rows="4" maxlength="2200">${esc(own.caption || '')}</textarea>`
                : writing ? '<div class="csb-shims"><i class="csb-shim w90"></i><i class="csb-shim w75"></i><i class="csb-shim w50"></i></div>'
                  : `<p class="csb-bwait">${st.writing ? 'Waiting its turn…' : 'No caption yet'}</p>`)
              + `</div><button type="button" class="csb-x" data-c="drop" data-i="${i}" aria-label="Leave this one out">${mi('x')}</button></div>`;
          }).join('') + '</div>'
          + `<div class="csb-acts"><button type="button" class="csb-act" data-c="write-all"${st.writing ? ' disabled' : ''}>${mi('refresh')}${n ? 'Write them all again' : 'Write them now'}</button></div>`
          + (!st.writing ? namesRow() : '') + '</div>';
      }
      const f = st.files[0];
      const ai = st.ai || {};
      const busy = ai.stage && ai.stage !== 'done' && ai.stage !== 'fail';
      const from = ai.from === 'flyer' ? 'from the flyer' : isVideo(f) ? 'from what is said' : 'from the picture';
      const fl = ai.flyer;
      const facts = fl ? [fl.event && ['sparkles', fl.event], fl.date && ['calendar', fl.date], fl.time && ['clock', fl.time], fl.place && ['home', fl.place]].filter(Boolean) : [];
      return `<div class="csb-ai${busy ? ' busy' : ''}">`
        + `<div class="csb-ai-head"><span class="csb-ai-ic">${mi('sparkles')}</span><b>AI caption</b><small>${from}</small>${aiStatus()}</div>`
        + (busy && isVideo(f) ? '<div class="csb-wave">' + Array.from({ length: 28 }, (x, i) => `<i style="animation-delay:${(i % 7) * 0.09}s"></i>`).join('') + '</div>' : '')
        + (facts.length ? `<div class="csb-facts"><small>Read on the flyer</small>${facts.map(([ic, t]) => `<span>${mi(ic)}${esc(t)}</span>`).join('')}</div>` : '')
        + (busy ? '<div class="csb-shims"><i class="csb-shim w90"></i><i class="csb-shim w75"></i><i class="csb-shim w50"></i></div>'
          : `<textarea class="cs-input csb-cap" data-c="caption" rows="5" maxlength="2200" placeholder="Say what it is, who is speaking, and where. Hashtags at the end.">${esc(st.caption)}</textarea>`)
        + (ai.note && !busy ? `<p class="csb-note">${esc(ai.note)}</p>` : '')
        + (!busy ? '<div class="csb-acts">'
          + (st.caption.trim() ? `<button type="button" class="csb-act" data-c="rev" data-a="rewrite"${st.revising ? ' disabled' : ''}>${mi('refresh')}Rewrite</button>`
            + `<button type="button" class="csb-act" data-c="rev" data-a="shorten"${st.revising ? ' disabled' : ''}>${mi('scissors')}Shorter</button>`
            + `<button type="button" class="csb-act" data-c="rev" data-a="hype"${st.revising ? ' disabled' : ''}>${mi('flame')}More hype</button>`
            : `<button type="button" class="csb-act" data-c="write">${mi('sparkles')}Write it for me</button>`)
          + (st.prev ? `<button type="button" class="csb-act ghost" data-c="undo">${mi('undo')}Undo</button>` : '')
          + `<span class="cs-count">${st.caption.length}/2200</span></div>` : '')
        + (!busy && st.caption.trim() ? appTagsRow() : '')
        + (!busy ? namesRow() : '')
        + (st.options && !busy ? '<div class="csb-styles"><small>Other styles</small>' + st.options.map((op, i) => `<button type="button" class="csb-style" data-c="opt" data-i="${i}">${esc(op.label || 'Option ' + (i + 1))}</button>`).join('') + '</div>' : '')
        + '</div>'
        + (linked().some((x) => picked().includes(x.id) && x.platform === 'youtube')
          ? `<label class="csb-yt">${platMark('youtube', 'md')}<span><small>YouTube title</small><input class="csb-yt-in" data-c="title" maxlength="100" value="${escAttr(st.title)}" placeholder="What is this clip about?"></span>${mi('pen')}</label>` : '');
    }

    /*
     * 🎵 MUSIC UNDER THE POST. Instagram and TikTok do not let any app add
     * their own library songs to a post, and a popular song baked in gets a
     * post muted or flagged — so a song that is free to post (or the
     * operator's own) is laid under the video on the server before it goes.
     */
    function musicBlock() {
      // a video's music: the church's own songs only — never a free instrumental
      if (edit || !st.files.length || !st.files.every(isVideo)) return '';
      const chip = (on, attrs, label) => `<button type="button" class="cs-chip${on ? ' on' : ''}" ${attrs}>${label}</button>`;
      const m = st.music || {};
      let html = '<div class="cs-chips">' + chip(!st.music, 'data-c="mus" data-v=""', 'No music') + '</div>';
      if (st.songs.length) html += '<label class="cs-label">Your songs <small>— your church’s own recordings, or ones you have the rights to post</small></label><div class="cs-chips">'
        + st.songs.slice(0, 10).map((x) => chip(m.lib === x.id, `data-c="muslib" data-v="${escAttr(x.id)}"`, '🎵 ' + esc(String(x.name || 'song').slice(0, 24)))).join('') + '</div>';
      else html += '<p class="cs-hint">Add your choir’s or worship team’s recording in <b>My music</b> to put it under a video.</p>';
      html += `<p class="cs-hint">${st.music ? 'Laid softly under your video — it dips whenever someone speaks. ' : ''}A well-known song added by any app gets a post muted or flagged.</p>`;
      return html;
    }

    function whenSummary() {
      if (many()) { const t = batchTimes(); return { main: `${st.files.length} posts`, sub: `${gapWords(st.spacing)} from ${shortWhen(t[0])}` }; }
      if (st.quick === 'now') return { main: 'Right now', sub: 'As soon as you tap' };
      const w = chosenWhen();
      const day = dayName(w);
      return { main: `${day === 'Today' ? 'Today' : day === 'Tomorrow' ? 'Tmrw' : new Date(w).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })} ${compactTime(w)}`, sub: (st.quick === 'best' ? '✦ Best time · ' : '') + fromNow(w) };
    }
    function shortWhenLabel(d) { const day = dayName(d); return (/^(Today|Tomorrow)$/.test(day) ? day : new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })) + ' ' + timeOf(d); }

    /*
     * 🖼 THE VIDEO'S THUMBNAIL. Optional: made in the Thumbnails studio from this
     * very video, or a picture from the phone. publisher.js coverFor sends it
     * where each place takes one; this says where, for the accounts ticked.
     */
    const oneVideo = () => st.files.length === 1 && isVideo(st.files[0]);
    function coverBlock() {
      if (!oneVideo()) return '';
      const accs = linked().filter((a) => picked().includes(a.id));
      const where = accs.map((a) => {
        const name = (PLAT[a.platform] || {}).name || a.platform;
        if (a.platform === 'youtube') return `<li>${platMark('youtube', 'sm')}<span><b>${esc(name)}</b> — the video’s thumbnail (a full video; a Short keeps the frame YouTube picks; your channel must be verified)</span></li>`;
        if (a.via !== 'zernio') return `<li>${platMark(a.platform, 'sm')}<span><b>${esc(name)}</b> — this connection can’t send a thumbnail; ${esc(name)} picks one from the video</span></li>`;
        if (a.platform === 'facebook') return `<li>${platMark('facebook', 'sm')}<span><b>${esc(name)}</b> — the video’s thumbnail</span></li>`;
        if (a.platform === 'instagram') return `<li>${platMark('instagram', 'sm')}<span><b>${esc(name)}</b> — the Reel’s cover (when it is the video’s shape)</span></li>`;
        if (a.platform === 'tiktok') return `<li>${platMark('tiktok', 'sm')}<span><b>${esc(name)}</b> — the cover, shown as the first moment (when it is the video’s shape)</span></li>`;
        return '';
      }).filter(Boolean);
      const uniq = Array.from(new Set(where));
      return `<div class="csb-h3"><b>Thumbnail</b><small>${st.cover ? 'goes with the video' : 'optional'}</small></div>`
        + (st.cover
          ? `<div class="csb-cover"><img src="${escAttr(C.fileUrl(st.cover))}" alt="The thumbnail"><div class="csb-cover-acts">`
            + `<button type="button" class="csb-act" data-c="covermake">${mi('sparkles')}Make another</button><button type="button" class="csb-act" data-c="coverpick">${mi('image')}From ${phone() ? 'photos' : 'files'}</button>`
            + `<button type="button" class="csb-act csb-act-x" data-c="coverdel">${mi('x')}Remove</button></div></div>`
            + (uniq.length ? `<ul class="csb-cover-where">${uniq.join('')}</ul>` : '')
          : `<div class="csb-acts"><button type="button" class="csb-act" data-c="covermake">${mi('sparkles')}Make a thumbnail</button><button type="button" class="csb-act" data-c="coverpick">${mi('image')}From ${phone() ? 'photos' : 'files'}</button></div>`
            + '<p class="cs-hint">Without one, each app picks a frame from the video itself.</p>');
    }

    function draw() {
      const fa = document.activeElement;
      const keepIg = fa && fa.classList && fa.classList.contains('csb-igsearch') && panel.body.contains(fa) ? { value: fa.value, a: fa.selectionStart, b: fa.selectionEnd } : null;
      // another Instagram account chosen: its own songs (a song from the other one's list is let go)
      const igAcc = linked().find((a) => picked().includes(a.id) && a.platform === 'instagram' && a.via === 'zernio');
      if (st.fm.igFor && (!igAcc || igAcc.id !== st.fm.igFor)) {
        igSeq++; clearTimeout(igTimer); stopIgPreview();
        Object.assign(st.fm, { igFor: '', igList: null, igState: '', igErr: '' });
      }
      // a song is from one account's library: another account's post does not get it
      if (st.fm.ig && st.fm.ig.acc && igAcc && igAcc.id !== st.fm.ig.acc) st.fm.ig = null;
      panel.setTitle(edit ? 'Edit post' : many() ? `${st.files.length} posts` : 'New post');
      panel.el.classList.add('csb-sheet');
      const mus = musicBlock();
      const musName = !st.music ? 'None' : 'Your song';
      panel.body.innerHTML = '<div class="csb-form">'
        + mediaBlock()
        + (st.files.length ? textBlock() : '')
        + (oneVideo() ? `<section class="csb-sec" id="csbCover">${coverBlock()}</section>` : '')
        + `<section class="csb-sec">${accountsBlock()}</section>`
        + (flyers().length ? `<section class="csb-sec csb-fm" id="csbFlyerMusic">${flyerBlock()}</section>` : '')
        + (mus ? `<details class="csb-more"${st.music ? ' open' : ''}><summary>${mi('music')}<span>Music</span><small>${esc(musName)}</small>${mi('chev-right')}</summary><div class="csb-more-in">${mus}</div></details>` : '')
        + `<section class="csb-sec" id="csbWhen"><div class="csb-h3"><b>When</b></div>${whenBlock()}</section>`
        + '</div>';
      // flyers whose Facebook (or Instagram) gets its song in the app itself: not posted from here, handed over after
      const handAccs = !edit && flyers().length === st.files.length ? linked().filter((a) => picked().includes(a.id) && (fbApp(a) || igApp(a))) : [];
      const handTo = Array.from(new Set(handAccs.map((a) => (PLAT[a.platform] || {}).name || a.platform))).join(' and ');
      const n = (picked().length - handAccs.length) * Math.max(1, st.files.length);
      const ready = st.files.length && picked().length;
      const busy = !many() && st.ai && st.ai.stage && st.ai.stage !== 'done' && st.ai.stage !== 'fail';
      const label = edit ? 'Save changes' : n === 0 && handTo ? `Continue to ${handTo}` : many() ? `Schedule ${st.files.length} posts`
        // one video to several accounts is ONE post (it was "Schedule 5 posts" for one video on five accounts)
        : st.quick === 'now' ? `Post now${n > 1 ? ` · ${n} accounts` : ''}` : `Schedule post${n > 1 ? ` · ${n} accounts` : ''}`;
      const ws = whenSummary();
      panel.foot.innerHTML = '<div class="csb-bar">'
        + `<button type="button" class="csb-when" data-c="whenjump">${mi('clock')}<span><b>${esc(ws.main)}</b><small>${esc(ws.sub)}</small></span></button>`
        + `<button type="button" class="csb-go" data-c="go"${ready && !st.submitting ? '' : ' disabled'}>${st.submitting ? 'Scheduling…' : label}</button></div>`
        + (ready ? (busy ? '<p class="cs-hint">You can tap it now — it waits for the caption to be written.</p>'
          : handTo && n ? `<p class="cs-hint">Then ${esc(handTo)}: the flyer and caption are handed to you, to add the gospel song in the app.</p>` : '')
          : `<p class="cs-hint">${st.sending ? (st.sending.items.length > 1 ? 'Your videos are on their way — the captions start as each one lands.' : 'Your video is on its way — the caption starts as soon as it lands.') : !st.files.length ? 'Choose a video or a flyer first.' : 'Choose at least one account to post to.'}</p>`);
      paintThumbs(panel.body);
      // the search box keeps its place and what was typed when the sheet is drawn again
      if (keepIg) {
        const inp = panel.body.querySelector('.csb-igsearch');
        if (inp) { inp.value = keepIg.value; inp.focus({ preventScroll: true }); try { inp.setSelectionRange(keepIg.a, keepIg.b); } catch (e) {} }
      }
      if (!panel.body.querySelector('#csbIgPick')) { stopIgPreview(); clearTimeout(igTimer); }
      // Instagram's songs, the first time its picker shows: gospel first
      if (panel.body.querySelector('#csbIgPick') && st.fm.igList == null && !st.fm.igState) loadIg('__gospel');
    }

    /*
     * ►► THE CAPTION WRITES ITSELF. ◄◄ The moment a video or a flyer is
     * chosen, the AI listens to it (or reads it) and writes the caption, the
     * hashtags and a YouTube title — nobody has to ask. A caption already
     * typed is never written over, and choosing another file drops a late
     * answer for the old one.
     */
    function autoWrite(force) {
      if (many() || !st.files.length) return null;
      const f = st.files[0];
      if (!force && (edit || st.caption.trim() || st.autoFor === f)) return null;
      // asked for again: the new answer replaces the AI's last one (never what was typed)
      if (force && st.aiText && st.caption === st.aiText.caption) st.caption = '';
      st.aiRun = writeFor(f);
      return st.aiRun;
    }
    async function writeFor(f) {
      st.autoFor = f; st.prev = null; st.options = null;
      const video = isVideo(f);
      st.ai = { stage: video ? 'listen' : 'read', pct: 0, from: video ? 'video' : 'picture' };
      draw();
      // "listening" becomes "writing" once the words are in (the writer itself reports nothing)
      const jobId = 'copy_' + Date.now();
      const off = window.api.onJobProgress ? window.api.onJobProgress((d) => {
        if (!d || d.jobId !== jobId || !st.ai || st.autoFor !== f || st.ai.stage !== 'listen') return;
        st.ai.pct = Math.min(99, Math.round(d.percent || 0));
        if (st.ai.pct >= 99) st.ai.stage = 'write';
        const el = panel.body.querySelector('.csb-ai-st'); if (el) el.outerHTML = aiStatus();
      }) : null;
      const toWrite = setTimeout(() => { if (st.ai && st.autoFor === f && st.ai.stage === 'read') { st.ai.stage = 'write'; const el = panel.body.querySelector('.csb-ai-st'); if (el) el.outerHTML = aiStatus(); } }, video ? 600000 : 7000);
      let out = null, err = null;
      try { out = await window.api.social.suggestCopy({ mediaPath: f, kind: video ? 'video' : 'image', listen: true, jobId, speaker: st.names.speaker || '', churchName: st.names.church || '' }); }
      catch (e) { err = e; }
      clearTimeout(toWrite); if (off) off();
      if (!panel.el.isConnected || st.autoFor !== f) return;
      if (out) {
        // what was typed while it was writing wins
        if (!st.caption.trim()) st.caption = out.caption || '';
        if (out.title && (!st.title || st.title === titleFromFile(f) || (st.aiText && st.title === st.aiText.title))) st.title = out.title;
        st.aiText = { caption: st.caption, title: st.title };
        st.options = (out.options && out.options.length > 1) ? out.options : null;
        st.ai = { stage: 'done', from: out.flyer ? 'flyer' : video ? 'video' : 'picture', flyer: out.flyer || null,
          note: out.wroteBy === 'rules' ? 'Written without the AI writer' + (out.writerWhy ? ` (${out.writerWhy})` : '') + ' — edit it freely.' : '' };
      } else {
        st.ai = { stage: 'fail', from: video ? 'video' : 'picture', note: 'The AI could not write it this time' + (err && err.message ? ` (${err.message})` : '') + ' — type it, or tap Write it for me.' };
      }
      draw();
    }
    function writeAll() {
      // one run at a time; files added meanwhile are written when it gets to them
      if (st.batchRun) return st.batchRun;
      st.batchRun = writeMissing().finally(() => { st.batchRun = null; });
      return st.batchRun;
    }
    async function writeMissing() {
      for (let i = 0; i < st.files.length; i++) {
        if (!panel.el.isConnected || !many()) break;
        const f = st.files[i];
        if (st.batchCaps[f]) continue;
        st.writing = `Writing ${i + 1} of ${st.files.length}…`;
        st.writingFile = f;
        draw();
        try {
          const out = await window.api.social.suggestCopy({ mediaPath: f, kind: isVideo(f) ? 'video' : 'image', listen: true, quick: true, jobId: 'copy_' + Date.now(), speaker: st.names.speaker || '', churchName: st.names.church || '' });
          if (out) st.batchCaps[f] = { title: out.title, caption: out.caption };
        } catch (er) { /* that one keeps the shared caption */ }
      }
      st.writing = false; st.writingFile = '';
      if (panel.el.isConnected) draw();
    }
    const afterPick = () => {
      if (many()) {
        // the first post's caption (written or typed) stays that post's own
        const f0 = st.files[0];
        if (st.caption.trim() && !st.batchCaps[f0]) st.batchCaps[f0] = { title: st.title, caption: st.caption };
        if (st.files.some((f) => !st.batchCaps[f])) writeAll();
      } else autoWrite();
    };

    async function pickExports() {
      await loadExports();
      const sub = C.openPanel({ id: 'csPickExports', title: 'My Uploads', cls: 'cp-pick' });
      const files = S.exports.concat(S.phoneFiles || []).sort((a, b) => b.mtime - a.mtime);
      const chosen = new Set();
      const drawPick = () => {
        sub.body.innerHTML = files.length
          ? '<div class="cs-grid">' + files.map((f) => `<button type="button" class="cs-g${chosen.has(f.path) ? ' on' : ''}" data-f="${escAttr(f.path)}">`
            + `<span class="cs-g-pic" data-thumb="${escAttr(f.path)}"></span><span class="cs-g-name">${esc(titleFromFile(f.path))}</span><i class="cs-tick">${mi('check')}</i></button>`).join('') + '</div>'
          : `<div class="cs-empty"><div class="cs-empty-art solo">${mi('film')}</div><b>Nothing here yet</b><p>Shorts you export, and videos and photos you add from your phone, appear here.</p></div>`;
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
        afterPick();
      });
      drawPick();
    }
    /*
     * ►► FROM THIS PHONE, WITH SOMETHING TO SEE. ◄◄ "I selected a video and it
     * did not show up": a sermon takes minutes to send, and the only progress
     * bar was in Your files, which is not open. Now the video is shown at once
     * — played from the phone itself — with how far the sending has got, a
     * Stop, and any failure said right there. The caption starts when it lands.
     */
    async function pickDevice() {
      const got = await C.chooseFromDevice(!edit, ['.mp4', '.mov', '.m4v', '.webm', '.jpg', '.jpeg', '.png'], {
        onPicked: (files, stop) => {
          st.sending = { stop, items: files.map((f) => ({ name: f.name, video: /^video\//.test(f.type) || /\.(mov|mp4|m4v|webm)$/i.test(f.name), url: (() => { try { return URL.createObjectURL(f); } catch (e) { return ''; } })(), pct: 0 })) };
          st.sendErr = '';
          if (panel.el.isConnected) draw();
        },
        onProgress: (i, pct, info) => {
          const it = st.sending && st.sending.items[i]; if (!it) return;
          it.pct = pct; it.info = info;
          const el = panel.body.querySelector(`[data-send="${i}"]`);
          if (el) {
            const b = el.querySelector('.csb-send-bar i'); if (b) b.style.width = Math.max(3, pct) + '%';
            const t = el.querySelector('.csb-send-tx'); if (t) t.textContent = st.sending.items.length > 1 ? (pct >= 100 ? '✓' : Math.round(pct) + '%') : sendLine(it);
            if (st.sending.items.length > 1) { const h = panel.body.querySelector('.csb-h3 b'); const its = st.sending.items; if (h) h.textContent = `Sending ${Math.min(its.length, its.filter((x) => (x.pct || 0) >= 100).length + 1)} of ${its.length} to the studio…`; }
          }
        },
        onResults: (results) => {
          const bad = results.filter((x) => x.error && !x.error.stopped);
          st.sendErr = bad.length ? `${bad[0].name}: ${(bad[0].error && bad[0].error.message) || 'it could not be sent'}` : '';
        },
      });
      const was = st.sending;
      st.sending = null;
      if (was) setTimeout(() => was.items.forEach((x) => { try { URL.revokeObjectURL(x.url); } catch (e) {} }), 60000);
      if (!panel.el.isConnected) return;
      if (!got) { draw(); return; }
      const add = Array.isArray(got) ? got : [got];
      st.files = edit ? add.slice(0, 1) : (st.files.length ? Array.from(new Set(st.files.concat(add))) : add);
      if (!many() && !st.title) st.title = titleFromFile(st.files[0]);
      draw();
      afterPick();
    }

    async function writeOne(file) {
      const jobId = 'copy_' + Date.now();
      return window.api.social.suggestCopy({ mediaPath: file, kind: isVideo(file) ? 'video' : 'image', listen: true, jobId });
    }

    panel.body.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.c === 'fm-igq-in') {
        clearTimeout(igTimer);
        const q = t.value.trim();
        igTimer = setTimeout(() => loadIg(q), 450);
        return;
      }
      if (t.dataset.c === 'title') st.title = t.value;
      if (t.dataset.bcap != null) { const f = st.files[+t.dataset.bcap]; if (f) st.batchCaps[f] = Object.assign({}, st.batchCaps[f], { caption: t.value }); }
      if (t.dataset.c === 'caption') {
        st.caption = t.value;
        const n = panel.body.querySelector('.cs-count'); if (n) n.textContent = `${t.value.length}/2200`;
        // the preview follows the typing
        const lines = t.value.split('\n').map((l) => l.trim()).filter(Boolean);
        const cap = panel.body.querySelector('#csbPrevCap'); if (cap) cap.textContent = lines.filter((l) => !/^#/.test(l)).join(' ') || ' ';
        const a0 = firstPlat();
        const tg = panel.body.querySelector('#csbPrevTags'); if (tg) tg.textContent = a0 && APP_TAGS[a0.platform] && lines.some((l) => /^#/.test(l)) ? tagsFor(t.value, a0.platform) : lines.filter((l) => /^#/.test(l)).join(' ');
        panel.body.querySelectorAll('#csbAppTags .csb-apptag').forEach((n) => { const sp = n.querySelector('span:last-child'); if (sp) sp.textContent = tagsFor(t.value, n.dataset.p); });
      }
    });
    panel.body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.c === 'dt' && t.value) { st.when = new Date(t.value); draw(); }
      if (t.dataset.c === 'gap') { const h = Math.round(+t.value); if (h >= 1 && h <= 336) { st.spacing = h; draw(); } }
      if (t.dataset.c === 'snap') { st.snap = !!t.checked; draw(); }
    });
    panel.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-c]'); if (!b || b.disabled) return;
      const c = b.dataset.c;
      if (c === 'exports') return pickExports();
      // a video in the list of posts: played right here, over the list
      if (c === 'play' && b.dataset.f) {
        const pp = C.openPanel({ id: 'cloudPostPlay', title: 'Preview', cls: 'cp-postplay' });
        pp.body.innerHTML = `<video class="cs-video" src="${escAttr(C.fileUrl(b.dataset.f))}" controls autoplay playsinline style="width:100%;max-height:70vh;border-radius:14px;background:#000"></video>`;
        return;
      }
      if (c === 'change') {
        if (many()) return pickExports();
        // what the AI wrote for the old file goes with it; what the person typed stays
        if (st.aiText) {
          if (st.caption === st.aiText.caption) st.caption = '';
          if (st.title === st.aiText.title) st.title = '';
          st.aiText = null;
        }
        if (!edit && st.files.length === 1 && st.title === titleFromFile(st.files[0])) st.title = '';
        st.files = []; st.ai = null; st.autoFor = ''; st.options = null; st.prev = null; st.batchCaps = {}; st.booked = {}; st.cover = null;
        return draw();          // one file: offer both places again
      }
      if (c === 'device') return pickDevice();
      // 🖼 the thumbnail: made from this video in the Thumbnails studio ("Use" there brings it back here), or a picture
      if (c === 'covermake') {
        if (!(window.MWFlyerStudio && window.MWFlyerStudio.openThumb)) return C.toast('The thumbnail studio is still loading — try again in a moment.');
        return window.MWFlyerStudio.openThumb({ video: st.files[0], onUse: (p) => { st.cover = p; if (panel.el.isConnected) draw(); } });
      }
      if (c === 'coverpick') {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = async () => {
          const file = inp.files && inp.files[0]; if (!file) return;
          b.disabled = true;
          try {
            // a phone photo is 12 megapixels: the platforms want 1920 at most, under 2 MB
            const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
            const k = Math.min(1, 1920 / Math.max(im.naturalWidth, im.naturalHeight));
            const cv = document.createElement('canvas'); cv.width = Math.round(im.naturalWidth * k); cv.height = Math.round(im.naturalHeight * k);
            cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
            URL.revokeObjectURL(im.src);
            const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.88));
            const p = await C.uploadFile(new File([blob], (file.name || 'thumbnail').replace(/\.[^.]+$/, '') + ' thumbnail.jpg', { type: 'image/jpeg' }));
            if (!p || typeof p !== 'string') throw new Error('it did not reach the studio');
            st.cover = p; draw();
          } catch (er) { C.toast('That picture could not be used: ' + ((er && er.message) || er), 'error'); b.disabled = false; }
        };
        if (C.openPicker) C.openPicker(inp); else inp.click();
        return;
      }
      if (c === 'coverdel') { st.cover = null; return draw(); }
      if (c === 'stopsend') { if (st.sending && st.sending.stop) st.sending.stop(); return; }
      if (c === 'drop') {
        st.files.splice(+b.dataset.i, 1);
        // down to one: its own caption becomes the post's
        if (st.files.length === 1) {
          const own = st.batchCaps[st.files[0]];
          if (own && !st.caption.trim()) { st.caption = own.caption || ''; st.title = own.title || st.title; st.autoFor = st.files[0]; st.ai = { stage: 'done', from: isVideo(st.files[0]) ? 'video' : 'picture' }; }
          else if (!st.caption.trim()) autoWrite();
        }
        return draw();
      }
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
      if (c === 'spacing') { st.spacing = +b.dataset.h; st.spacingOther = false; return draw(); }
      if (c === 'spacing-other') { st.spacingOther = true; draw(); const i = panel.body.querySelector('input[data-c="gap"]'); if (i) { i.focus(); i.select(); } return; }
      if (c === 'mus') { st.music = null; return draw(); }   // (only "No music" — songs are the church's own: muslib)
      // 🎵 a flyer's music
      if (c === 'fm-mode') { st.fm.mode = b.dataset.v; saveFlyerPrefs(); clearTimeout(igTimer); stopIgPreview(); return draw(); }
      if (c === 'fm-tk') { st.fm.tiktok = b.dataset.v === 'draft' ? 'draft' : 'trending'; saveFlyerPrefs(); return draw(); }
      if (c === 'fm-check') {
        if (st.check && st.check.busy) return;
        st.check = { busy: true };
        draw();
        try { const r = await window.api.social.musicCheck(); st.check = { checks: (r && r.checks) || [] }; }
        catch (er) { st.check = { error: 'The test could not run: ' + ((er && er.message) || er) }; }
        if (panel.el.isConnected) draw();
        const sec = panel.body.querySelector('.csb-check-sec'); if (sec) sec.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (c === 'fm-fromig') {
        const id = b.dataset.id, cur = st.fm.fromIg || [];
        st.fm.fromIg = cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat(id);
        saveFlyerPrefs(); return draw();
      }
      if (c === 'fm-fbyt') {
        if (b.dataset.v === 'own') { st.fm.fbyt = 'own'; if (!st.fm.lib && st.songs[0]) st.fm.lib = st.songs[0].id; }
        else st.fm.fbyt = 'none';
        saveFlyerPrefs(); return draw();
      }
      if (c === 'fm-lib') { st.fm.lib = b.dataset.v; return draw(); }
      if (c === 'fm-igq') { const i = panel.body.querySelector('.csb-igsearch'); if (i) i.value = igQShown(b.dataset.v); return loadIg(b.dataset.v); }
      if (c === 'fm-ig-clear') { st.fm.ig = null; stopIgPreview(); return draw(); }
      if (c === 'fm-ig-play') {
        e.stopPropagation();
        const x = st.fm.igList && st.fm.igList[+b.dataset.i];
        if (!x) return;
        const same = igPlaying === x.id;
        stopIgPreview();
        if (!same) playIg(x, b);
        return;
      }
      if (c === 'fm-fb') { st.fm.fb = b.dataset.v === 'app' ? 'app' : 'here'; saveFlyerPrefs(); return draw(); }
      if (c === 'fm-igway') { st.fm.igWay = b.dataset.v === 'app' ? 'app' : 'lib'; stopIgPreview(); saveFlyerPrefs(); return draw(); }
      if (c === 'fm-ig') {
        const x = st.fm.igList && st.fm.igList[+b.dataset.i];
        if (x) { st.fm.ig = Object.assign({}, x, { acc: st.fm.igFor }); stopIgPreview(); draw(); }
        return;
      }
      if (c === 'fm-ig-fb' || c === 'fm-ig-fb2') {
        const acc = linked().find((a) => picked().includes(a.id) && a.platform === 'instagram' && a.via === 'zernio');
        if (!acc) return;
        const unlink = c === 'fm-ig-fb2';
        // opened on the tap, before anything is awaited — an iPhone blocks a window opened later
        let w = null;
        try { w = window.open('', '_blank'); if (w) w.opener = null; } catch (er) { w = null; }
        b.disabled = true; b.textContent = 'Opening…';
        const box = () => panel.body.querySelector('#csbIgList');
        try {
          const r = await window.api.social.igRelink(acc.id, unlink);
          if (r && r.needsUnlink) {
            // Zernio's free plan counts it as a third account: the free way needs a yes first
            if (w) try { w.close(); } catch (x) {}
            st.fm.igState = 'needsUnlink'; st.fm.igErr = r.message || '';
            const bx = box(); if (bx) bx.innerHTML = igListHtml();
            return;
          }
          if (w) w.location.href = r.url; else window.open(r.url, '_blank');
          st.fm.igState = 'linking';
          const bx = box(); if (bx) bx.innerHTML = igListHtml();
          watchIgLink(acc.id);
        } catch (er) {
          if (w) try { w.close(); } catch (x) {}
          b.disabled = false; b.textContent = unlink ? 'Unlink and link through Facebook (free)' : 'Link Instagram through Facebook';
          C.island({ kind: 'error', title: 'Could not start the sign-in', sub: (er && er.message) || '', ms: 8000 });
        }
        return;
      }
      if (c === 'muslib') { st.music = { lib: b.dataset.v }; return draw(); }
      if (c === 'musmood') { st.musicMood = b.dataset.v; return draw(); }
      if (c === 'opt') {
        const op = st.options && st.options[+b.dataset.i];
        if (op) { st.title = op.title || st.title; st.caption = op.caption || st.caption; draw(); }
        return;
      }
      if (c === 'write') return autoWrite(true);
      if (c === 'write-all') { if (st.batchRun) return; st.batchCaps = {}; return writeAll(); }
      if (c === 'names') { st.namesOpen = true; return draw(); }
      if (c === 'names-save' || c === 'names-clear') {
        const v = (k) => ((panel.body.querySelector(`input[data-n="${k}"]`) || {}).value || '').trim();
        st.names = c === 'names-clear' ? {} : { speaker: v('speaker'), church: v('church') };
        try { localStorage.setItem('mw.social.names', JSON.stringify(st.names)); } catch (e) {}
        st.namesOpen = false;
        if (st.files.length && !many()) return autoWrite(true);
        if (many() && !st.batchRun) { st.batchCaps = {}; return writeAll(); }
        return draw();
      }
      if (c === 'whenjump') { const w = panel.body.querySelector('#csbWhen'); if (w) w.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      if (c === 'undo') { if (st.prev) { st.caption = st.prev.caption; st.title = st.prev.title; st.prev = null; } return draw(); }
      if (c === 'rev') {
        if (st.revising || !st.caption.trim()) return;
        const action = b.dataset.a;
        st.revising = action;
        const before = { caption: st.caption, title: st.title };
        draw();
        try {
          const r = await window.api.social.reviseCopy({ caption: st.caption, title: st.title, action });
          if (r && r.source === 'ai' && r.caption) { st.prev = before; st.caption = r.caption; if (r.title) st.title = r.title; }
          else C.island({ kind: 'warn', title: 'The caption was not changed', sub: (r && r.why) || '', ms: 4500 });
        } catch (er) { C.island({ kind: 'error', title: 'Could not change it', sub: er.message }); }
        st.revising = '';
        return draw();
      }
      if (c === 'go') return submit(b);
    });
    panel.foot.addEventListener('click', (e) => {
      const j = e.target.closest('[data-c="whenjump"]');
      if (j) { const w = panel.body.querySelector('#csbWhen'); if (w) w.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      const b = e.target.closest('[data-c="go"]');
      if (b && !b.disabled) submit(b);
    });

    /* the chosen song laid under each video (on the server) — the files that will post, and the caption credit */
    async function withMusic(btn) {
      // (the video music: a flyer has its own, per platform — flyerMusicFor)
      if (!st.music || !st.music.lib || edit || !st.files.length || !st.files.every(isVideo)) return null;   // never a free instrumental
      let free = st.music.free || null;
      if (free === 'auto') {
        // the next worship song not used lately (see freeDeal) — the same one again if this is a retry,
        // so every post of a bulk has the same song and credit
        if (!st.musFree) {
          const next = freeDeal((st.shelf && st.shelf.tracks) || [], 'uplift')[0];
          if (!next) return null;
          st.musFree = next.id;
          freeUsed(next.id);
        }
        free = st.musFree;
      }
      const out = { files: [], credit: '' };
      for (let i = 0; i < st.files.length; i++) {
        // already booked (a retry after one failed): not mixed again
        if (st.booked && st.booked[st.files[i]]) { out.files.push(st.files[i]); out.credit = out.credit || st.musCredit || ''; continue; }
        btn.innerHTML = `${mi('music')}Adding the music${st.files.length > 1 ? ` (${i + 1} of ${st.files.length})` : ''}…`;
        const r = await window.api.social.withMusic({ mediaPath: st.files[i], free: free || undefined, libId: st.music.lib || undefined });
        out.files.push(r.path);
        out.credit = r.credit || out.credit;
      }
      if (out.credit) st.musCredit = out.credit;
      return out;
    }
    /* a flyer's music, as the post carries it (main.js withFlyerMusic → publisher.js flyerPlan) */
    function flyerMusicFor(f) {
      if (edit || isVideo(f)) return null;
      const fm = st.fm;
      if (fm.mode === 'none') return { tiktok: 'none', igAudio: null, song: null };
      const accs = linked().filter((a) => picked().includes(a.id));
      const ig = fm.mode === 'trending' && fm.ig ? { id: fm.ig.id, title: fm.ig.title, artist: fm.ig.artist || '', acc: fm.ig.acc || '' }
        : accs.some((a) => igAutoFor(a)) ? { auto: '__gospel' } : null;
      // never a free instrumental: the church's own recording where it was chosen, or none
      const own = fm.fbyt === 'own' && fm.lib && wantsOwn(accs);
      return { tiktok: fm.tiktok, igAudio: ig, fbyt: own ? 'song' : 'none', song: own ? { lib: fm.lib } : null };
    }
    // book it — a flyer with its music (no free songs to deal: real ones from the apps, or the church's own)
    async function addPost(base, f) {
      const m = flyerMusicFor(f);
      return window.api.scheduler.add(m ? Object.assign({}, base, { music: m }) : base);
    }
    const withCredit = (caption, credit) => (credit && !String(caption || '').includes(credit) ? [String(caption || '').trim(), credit].filter(Boolean).join('\n\n') : caption);

    async function submit(btn) {
      if (st.submitting) return;
      st.submitting = true;
      btn.disabled = true;
      try { await submitNow(btn); } finally { st.submitting = false; }
    }
    async function submitNow(btn) {
      // tapped while the AI was still writing: the post waits for its caption(s)
      const waitFor = many() ? st.batchRun : (st.aiRun && st.ai && st.ai.stage !== 'done' && st.ai.stage !== 'fail' ? st.aiRun : null);
      if (waitFor) {
        btn.textContent = many() ? 'Finishing the captions…' : 'Finishing the caption…';
        try { await waitFor; } catch (er) {}
        // closed meanwhile: that is a cancel, not a post
        if (!panel.el.isConnected) return;
        btn = panel.foot.querySelector('[data-c="go"]') || btn;
        btn.disabled = true;
        if (!many() && !st.caption.trim() && st.ai && st.ai.stage === 'fail') {
          draw();
          C.island({ kind: 'warn', title: 'There is no caption yet', sub: 'The AI could not write it — type one, or tap Write it for me.', ms: 6000 });
          return;
        }
      }
      const accs = linked().filter((a) => picked().includes(a.id));
      const platforms = Array.from(new Set(accs.map((a) => a.platform)));
      stopIgPreview();
      // a flyer: a Facebook Page that gets the Instagram Reel (shared by Instagram) is not posted to again, and a
      // Facebook that gets its song in the Facebook app is handed the flyer instead (openHandOff)
      const accsFor = (f) => (isVideo(f) || edit ? accs : accs.filter((a) => !fromIg(a) && !fbApp(a) && !igApp(a)));
      const platsFor = (list) => Array.from(new Set(list.map((a) => a.platform)));
      const fbHand = edit ? [] : accs.filter((a) => fbApp(a) || igApp(a));
      const hand = [];
      if (flyers().length && st.fm.mode !== 'none') btn.innerHTML = `${mi('music')}Putting the music on…`;
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
            scheduledAt: chosenWhen().toISOString(), coverPath: oneVideo() ? st.cover || null : null,
          });
          C.island({ kind: 'good', title: 'Post updated', sub: whenLabel(chosenWhen()) });
        } else if (many()) {
          const times = batchTimes();
          for (let i = 0; i < st.files.length; i++) {
            btn.innerHTML = `${mi('calendar')}Booking ${i + 1} of ${st.files.length}…`;
            const f = st.files[i];
            const own = st.batchCaps[f] || {};
            // tapped again after one failed: the ones already booked are not booked twice
            st.booked = st.booked || {};
            const one = {
              title: own.title || titleFromFile(f),
              caption: withCredit(own.caption || st.caption || titleFromFile(f), credit),
              mediaPaths: [fileAt(i)], accountIds: accsFor(f).map((a) => a.id), platforms: platsFor(accsFor(f)),
              scheduledAt: times[i].toISOString(),
            };
            if (fbHand.length && !isVideo(f) && !hand.some((h) => h.file === f)) hand.push({ file: f, when: times[i].toISOString(), title: one.title, caption: own.caption || st.caption || titleFromFile(f) });
            if (!one.accountIds.length) continue;   // only Facebook, through its own app: nothing to book here
            // booked already (tapped again after one failed): brought up to what is chosen now, never booked twice
            if (st.booked[f]) { await bookedAgain(st.booked[f], one); continue; }
            st.booked[f] = (await addPost(one, f)) || true;
          }
          if (st.files.some((f) => accsFor(f).length)) C.island({ kind: 'good', title: `${st.files.length} posts scheduled`, sub: `First one ${whenLabel(times[0])}` });
        } else {
          const when = chosenWhen();
          st.booked = st.booked || {};
          const booked = accsFor(st.files[0]);
          const one = {
            title: st.title.trim() || titleFromFile(st.files[0]), caption: withCredit(st.caption, credit),
            mediaPaths: [fileAt(0)], accountIds: booked.map((a) => a.id), platforms: platsFor(booked),
            scheduledAt: when.toISOString(),
          };
          if (oneVideo() && st.cover) one.coverPath = st.cover;
          if (fbHand.length && !isVideo(st.files[0])) hand.push({ file: st.files[0], when: st.quick === 'now' ? null : when.toISOString(), title: one.title, caption: st.caption });
          // dropped down to one after a bulk half-booked: that one is booked already — it gets what is chosen now
          const had = st.booked[st.files[0]];
          if (booked.length) {
            const rec = had ? await bookedAgain(had, one) : await addPost(one, st.files[0]);
            if (rec) st.booked[st.files[0]] = rec;
            if (st.quick === 'now' && rec && rec.id) postNow(rec.id);
            else C.island({ kind: 'good', title: 'Post scheduled', sub: `${whenLabel(when)} · ${booked.map((a) => (PLAT[a.platform] || {}).name || a.platform).join(', ')}` });
          }
        }
        panel.close();
        // Facebook's (and Instagram's) part, with its song: kept on this phone until it is done, and handed over now
        const todo = hand.length ? addHandTodo({ items: hand, apps: platsFor(fbHand).sort((x, y) => (x === 'instagram' ? -1 : y === 'instagram' ? 1 : 0)),
          song: st.fm.ig && st.fm.igWay !== 'app' ? st.fm.ig.title + (st.fm.ig.artist ? ' — ' + st.fm.ig.artist : '') : '' }) : null;
        if (S.view !== 'scheduler') go('scheduler');
        S.tab = 'upcoming';
        await loadSocial(true);
        renderSched(); renderHomeSocial();
        if (todo) openHandOff(todo);
      } catch (er) {
        btn.disabled = false;
        draw();
        C.island({ kind: 'error', title: 'It was not scheduled', sub: er.message || String(er), ms: 8000 });
      }
    }

    if (st.files.length === 1 && !st.title) st.title = titleFromFile(st.files[0]);
    draw();
    ensure();
    if (st.files.length) afterPick();
    return panel;
  }

  /* ------------------------------------------------------------- connect */

  /*
   * LINKING AN ACCOUNT, FROM A PHONE. Through Zernio: free, its developer apps
   * are already approved by all four platforms, and it publishes a booked post
   * itself — so a post goes out at its time whether or not anything of ours is
   * switched on.
   *
   * ►► AS FEW TAPS AS THE PLATFORMS ALLOW. ◄◄ "I need to do a lot to set it
   * up." What no app can skip: one Zernio key (made once, on zernio.com — or
   * given to the server, ZERNIO_API_KEY, and never asked for) and each
   * platform's own "Allow". Everything else is done for you:
   *   • Open Zernio goes straight to its API keys page; 📋 Paste key reads
   *     the copied key (no typing, no Save) and Zernio checks it there and then
   *   • whatever is already linked on Zernio is linked here at once
   *   • ✨ Set up everything opens each platform's sign-in in turn, in one
   *     window, each coming back to the studio which opens the next
   *     (main.js setupRuns, cloud-api.js /social/next) — no Connect per
   *     platform, no coming back to the app in between
   * Connect beside a platform still does just that one.
   */
  function openConnect(after) {
    const panel = C.openPanel({ id: 'csConnect', title: 'Accounts', cls: 'cp-connect', onClose: () => { stopClaim(); stopWatch(); if (after) after(); } });
    let claiming = null;   // { platform, timer, until }
    let watching = null;   // { timer, until } — while Set up everything runs in its own window
    let typing = false;    // the paste box, when the phone would not let the key be read
    let more = false;
    // a second Facebook page in Set up everything — remembered, like what was unticked
    const FB2_KEY = 'mw.social.fb2';
    let extraFb = (() => { try { return localStorage.getItem(FB2_KEY) === '1'; } catch (e) { return false; } })();
    const saveFb2 = () => { try { localStorage.setItem(FB2_KEY, extraFb ? '1' : '0'); } catch (e) {} };
    let needSecond = false;   // the free Zernio account is full: a second free one is the way on
    // platforms left out of Set up everything — remembered on this phone (a church with no YouTube says so once)
    const SKIP_KEY = 'mw.social.skip';
    const skip = new Set((() => { try { return JSON.parse(localStorage.getItem(SKIP_KEY) || '[]'); } catch (e) { return []; } })());
    const saveSkip = () => { try { localStorage.setItem(SKIP_KEY, JSON.stringify(Array.from(skip))); } catch (e) {} };
    function stopClaim() { if (claiming) { clearInterval(claiming.timer); claiming = null; } }
    function stopWatch() { if (watching) { clearInterval(watching.timer); watching = null; } }
    const label = (p) => (PLAT[p] || {}).name || p;
    const missing = () => PLAT_ORDER.filter((p) => !linked().some((x) => x.platform === p));
    const countOf = (p) => linked().filter((x) => x.platform === p).length;
    // counted only while its chip can be seen: never a Facebook sign-in after Facebook was unticked
    const wantSecondFb = () => extraFb && !(missing().includes('facebook') && skip.has('facebook')) && countOf('facebook') + (missing().includes('facebook') ? 1 : 0) < 2;
    // the free Zernio account is full: told by a run or a Connect, or seen — 2 accounts on one key and more wanted
    // up to three free Zernio accounts (2 places each): the next empty key slot, if any
    const KEY_FIELD = { zo: 'zoApiKey', zoFb: 'zoApiKeyFb', zo3: 'zoApiKey3' };
    const nextSlot = () => (!S.keys.zo ? null : !S.keys.zoFb ? 'zoFb' : !S.keys.zo3 ? 'zo3' : null);
    const keyCount = () => ['zo', 'zoFb', 'zo3'].filter((k) => S.keys[k]).length;
    const needSecondNow = () => !!nextSlot() && (needSecond || (linked().filter((a) => a.via === 'zernio').length >= 2 * keyCount()
      && (missing().some((p) => !skip.has(p)) || wantSecondFb())));

    function draw(msg) {
      const keyRow = (k, title, sub) => `<div class="cs-key${S.keys[k] ? ' set' : ''}">`
        + `<div class="cs-key-tx"><b>${title}</b><small>${S.keys[k] ? 'Saved on the studio machine — it never comes back to this phone' : sub}</small></div>`
        + (S.keys[k] ? `<button type="button" class="cs-mini" data-k="edit-${k}">Replace</button>` : '')
        + `<div class="cs-key-in${S.keys[k] ? ' hidden' : ''}" data-key-row="${k}"><input class="cs-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the API key" data-key="${k}">`
        + `<button type="button" class="cs-btn primary" data-k="save-${k}">Save</button></div></div>`;
      const needs = S.keys.zo || S.keys.zoFb;
      const busyRow = (p, another) => claiming && claiming.platform === p && !!claiming.another === !!another;
      const rows = PLAT_ORDER.map((p) => {
        const mine = linked().filter((x) => x.platform === p);
        // every linked account its own row (two Facebook pages are two rows)
        const done = mine.map((a) => `<div class="cs-plat linked" data-plat="${p}">${platMark(p, 'lg')}`
          + `<div class="cs-plat-tx"><b>${label(p)}</b><small>${esc(a.name)}</small></div>`
          + `<button type="button" class="cs-mini" data-k="unlink" data-id="${escAttr(a.id)}">Remove</button></div>`).join('');
        const connectRow = (another) => {
          const busy = busyRow(p, another);
          return `<div class="cs-plat${another ? ' cs-plat-more' : ''}" data-plat="${p}">${platMark(p, 'lg')}`
            + `<div class="cs-plat-tx"><b>${another ? 'Another Facebook page' : label(p)}</b><small>${busy ? 'Waiting for you to finish signing in…' : watching && !another ? 'Waiting for its sign-in…' : another ? 'Free on your second Zernio account' : 'Not connected'}</small></div>`
            + (busy ? (claiming.url ? `<a class="cs-mini accent" href="${escAttr(claiming.url)}" target="_blank" rel="noopener">${mi('external')}Open</a>` : '<span class="cs-spin"></span>')
              : `<button type="button" class="cs-mini accent" data-k="link" data-p="${p}"${another ? ' data-another="1"' : ''}${needs ? '' : ' disabled'}>${another ? '+ Add' : 'Connect'}</button>`)
            + '</div>';
        };
        return mine.length ? done + (p === 'facebook' && mine.length === 1 ? connectRow(true) : '') : connectRow(false);
      }).join('');
      const plats = `<h4 class="cs-h4">Your accounts</h4><div class="cs-plats">${rows}</div>`;
      const left = missing();

      // the one big thing to do next
      let hero;
      if (!S.keys.zo) {
        hero = '<div class="cs-setup">'
          + '<div class="cs-step"><span class="cs-step-n">1</span><div class="cs-step-tx"><b>Get your free Zernio key</b>'
          + '<small>Zernio posts for you, even with this phone off. Sign up (or log in), open <b>API keys</b> in Zernio’s menu, tap <b>Create key</b>, then <b>Copy</b>.</small></div></div>'
          + `<a class="cs-btn ghost cs-wide" href="https://zernio.com/signup" target="_blank" rel="noopener">${mi('external')}Open Zernio</a>`
          + '<div class="cs-step"><span class="cs-step-n">2</span><div class="cs-step-tx"><b>Come back and paste it</b>'
          + '<small>It is checked with Zernio straight away, and anything you already linked there is linked here too.</small></div></div>'
          + `<button type="button" class="cs-btn primary cs-wide cs-big" data-k="paste">📋 Paste key</button>`
          + (typing ? '<div class="cs-key-in" data-key-row="zo"><input class="cs-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the API key here" data-key="zo"><button type="button" class="cs-btn primary" data-k="save-zo">Save</button></div>' : '')
          + '</div>';
      } else if (needSecondNow() && !watching) {
        hero = '<div class="cs-setup cs-second">'
          + `<div class="cs-step"><span class="cs-step-n">+</span><div class="cs-step-tx"><b>Free account${keyCount() > 1 ? 's' : ''} full — add another free one</b>`
          + `<small>Each free Zernio account holds 2 accounts. Make ${keyCount() > 1 ? 'a third' : 'a second'} free Zernio account (use another email), open <b>API keys</b> in its menu, tap <b>Create key</b>, then <b>Copy</b>. It stays free.</small></div></div>`
          + `<a class="cs-btn ghost cs-wide" href="https://zernio.com/signup" target="_blank" rel="noopener">${mi('external')}Open Zernio</a>`
          + `<button type="button" class="cs-btn primary cs-wide cs-big" data-k="paste2">📋 Paste the new key</button>`
          + (typing ? `<div class="cs-key-in" data-key-row="${nextSlot()}"><input class="cs-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the new key here" data-key="${nextSlot()}"><button type="button" class="cs-btn primary" data-k="save-${nextSlot()}">Save</button></div>` : '')
          + '</div>';
      } else if (left.length && left.every((p) => skip.has(p)) && !wantSecondFb() && !watching) {
        // everything wanted is connected; what is left was unticked on purpose
        hero = (msg && msg.kind === 'good' ? '' : `<p class="cs-note good">${mi('check')} All set — posts go out on their own.</p>`)
          + `<button type="button" class="cs-more" data-k="unskip">Also connect ${left.map(label).join(' or ')}</button>`;
      } else if (left.length) {
        const chips = left.map((p) => `<button type="button" class="cs-pick${skip.has(p) ? '' : ' on'}" data-k="pick" data-p="${p}" aria-pressed="${skip.has(p) ? 'false' : 'true'}">${platMark(p, 'sm')}<span>${label(p)}</span></button>`).join('');
        // two Facebook pages: the second one is a tap away (off unless asked for)
        const chips2 = countOf('facebook') < 2 && !(left.includes('facebook') && skip.has('facebook'))
          ? `<button type="button" class="cs-pick${extraFb ? ' on' : ''}" data-k="pick" data-p="facebook2" aria-pressed="${extraFb}">${platMark('facebook', 'sm')}<span>${countOf('facebook') ? 'Another page' : '2nd page'}</span></button>` : '';
        const n = left.filter((p) => !skip.has(p)).length + (wantSecondFb() ? 1 : 0);
        hero = '<div class="cs-setup">'
          + (watching ? `<a class="cs-btn primary cs-wide cs-big" href="${escAttr(watching.url)}" target="_blank" rel="noopener">${mi('external')}Start the sign-ins</a>`
            : `<button type="button" class="cs-btn primary cs-wide cs-big" data-k="setup"${n ? '' : ' disabled'}>✨ Set up everything</button>`)
          + `<small class="cs-setup-sub">${watching ? 'Finish each sign-in in the window that opened — each one moves on to the next by itself, and this list fills in as they connect. (No window? Tap Start the sign-ins.)'
            : 'Signs you in to each one, one after another, in one window — just tap Allow on each. Untick any you don’t use.'}</small>`
          + `<div class="cs-picks">${chips}${chips2}</div></div>`;
      } else {
        // said once: not again under a note that already says so
        hero = msg && msg.kind === 'good' ? '' : `<p class="cs-note good">${mi('check')} Everything is connected — posts go out on their own.</p>`;
      }
      const keys = !S.keys.zo ? '' : `<button type="button" class="cs-more" data-k="more">${more ? 'Fewer options' : 'Zernio key and more'}</button>`
        + (more ? keyRow('zo', 'Zernio key', 'For every account')
          + keyRow('zoFb', 'Second Zernio account (free)', 'Each free Zernio account holds 2 accounts. A key from a second free Zernio account gives 2 more places — the studio puts each account wherever there is room.')
          + (S.keys.zoFb ? keyRow('zo3', 'Third Zernio account (free)', 'Two more free places, for a fifth or sixth account.') : '') : '');
      panel.body.innerHTML = (msg ? `<p class="cs-note ${msg.kind || ''}">${esc(msg.text)}</p>` : '') + hero + plats + keys;
    }

    async function claim() {
      if (!claiming) return;
      const p = claiming.platform;
      try {
        const r = await window.api.social.linkClaim(p, claiming.another);
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
    // Set up everything runs in its own window: this sheet watches the list fill in,
    // and asks how the run is going so it stops waiting — and says why — when it ends
    const typingHere = () => { const a = document.activeElement; return !!(a && panel.body.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName)); };
    async function watch() {
      if (!watching) return;
      const before = linked().map((a) => a.id).join();
      await loadSocial(true).catch(() => null);
      const changed = linked().map((a) => a.id).join() !== before;
      if (changed) { renderSched(); renderHomeSocial(); }
      let st = null;
      if (watching.code) { try { st = await window.api.social.setupStatus(watching.code); } catch (e) { st = null; } }
      if (!watching) return;
      const allIn = !missing().filter((p) => !skip.has(p)).length && !wantSecondFb();
      if (allIn || (st && (st.done || st.expired)) || Date.now() > watching.until) {
        stopWatch();
        const bad = (st && st.results ? st.results : []).filter((x) => !x.ok);
        if (bad.some((x) => x.needSecondKey)) needSecond = true;
        if (!bad.length && allIn) {
          draw({ kind: 'good', text: 'All set — your accounts are connected.' });
          C.island({ kind: 'good', title: 'Accounts connected', sub: linked().map((a) => label(a.platform)).join(' · ') });
        } else {
          const full = bad.some((x) => x.full);
          draw({ kind: 'warn', text: (needSecond && nextSlot() ? `Your free Zernio account${keyCount() > 1 ? 's are' : ' is'} full (2 accounts each), so ${Array.from(new Set(bad.map((x) => label(x.platform) + (x.another ? ' (2nd page)' : '')))).join(' and ')} could not go on it. `
            : bad.length ? bad.map((x) => `${label(x.platform)}${x.another ? ' (2nd page)' : ''}: ${x.error}`).join(' ') + ' ' : 'Not everything was connected. ')
            + (needSecond && nextSlot() ? 'Still free: add another free Zernio account below, then tap ✨ Set up everything again.'
              : full ? 'Remove one you don’t use, or turn on billing at zernio.com.' : 'Tap ✨ Set up everything again for what is left.') });
        }
        return;
      }
      // redrawn only when something changed, and never under someone's typing
      if (changed && !typingHere()) draw();
    }
    const onBack = () => { if (document.hidden) return; if (claiming) claim(); if (watching) watch(); };
    document.addEventListener('visibilitychange', onBack);
    const origClose = panel.onClose;
    panel.onClose = () => { document.removeEventListener('visibilitychange', onBack); if (origClose) origClose(); };

    async function saveKey(key, v) {
      const res = await window.api.social.setKeys({ [KEY_FIELD[key] || 'zoApiKey']: v });
      S.keys = res;
      typing = false;
      await loadSocial(true);
      renderSched(); renderHomeSocial();
      const got = (res.linked || []).map(label);
      const left = missing();
      draw({ kind: 'good', text: (got.length ? `Key saved — ${got.join(', ')} ${got.length === 1 ? 'was' : 'were'} already on Zernio and ${got.length === 1 ? 'is' : 'are'} connected. ` : 'Key saved. ')
        + (left.length ? 'Now tap ✨ Set up everything.' : 'Everything is connected.') });
    }

    panel.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-k]'); if (!b || b.disabled) return;
      const k = b.dataset.k;
      if (k === 'more') { more = !more; return draw(); }
      if (k === 'pick') { const p = b.dataset.p; if (p === 'facebook2') { extraFb = !extraFb; saveFb2(); } else { if (skip.has(p)) skip.delete(p); else skip.add(p); saveSkip(); } return draw(); }
      if (k === 'unskip') { skip.clear(); saveSkip(); return draw(); }
      if (k === 'paste' || k === 'paste2') {
        const slot = k === 'paste2' ? (nextSlot() || 'zoFb') : 'zo';
        // the copied key, read on this tap (the phone asks once: Paste); typed in when it cannot be read
        let v = '';
        try { v = navigator.clipboard && navigator.clipboard.readText ? String(await navigator.clipboard.readText() || '').trim() : ''; } catch (er) { v = ''; }
        if (!v || /\s/.test(v) || v.length < 12) {
          typing = true;
          draw(v ? { kind: 'warn', text: 'What was copied does not look like a Zernio key — copy the key on zernio.com again, or paste it below.' } : null);
          const i = panel.body.querySelector(`input[data-key="${slot}"]`); if (i) i.focus();
          return;
        }
        b.disabled = true; b.textContent = 'Checking the key with Zernio…';
        try { await saveKey(slot, v); if (slot !== 'zo') needSecond = false; }
        catch (er) { typing = true; draw({ kind: 'bad', text: er.message }); }
        return;
      }
      if (k === 'setup') {
        const platforms = missing().filter((p) => !skip.has(p)).concat(wantSecondFb() ? ['facebook2'] : []);
        if (!platforms.length) return;
        // the window is opened on the tap itself (a phone will not open one later); the address follows
        let w = null;
        try { w = window.open('', '_blank'); if (w) w.opener = null; } catch (er) { w = null; }
        b.disabled = true; b.textContent = 'Opening…';
        let r;
        try { r = await window.api.social.setupStart({ origin: location.origin, platforms }); }
        catch (er) { if (w) try { w.close(); } catch (x) {} draw({ kind: 'bad', text: er.message }); return; }
        if (r && r.done) {
          if (w) try { w.close(); } catch (x) {}
          await loadSocial(true); renderSched(); renderHomeSocial();
          return draw({ kind: 'good', text: 'Everything is connected — it was all on Zernio already.' });
        }
        stopClaim(); stopWatch();
        watching = { code: r.code, url: r.url, until: Date.now() + 30 * 60000, timer: setInterval(watch, 4000) };
        if (w) { try { w.location.href = r.url; } catch (er) { w = null; } }
        // the phone blocked the window: a real link opens it (never this page — an upload or export would stop)
        draw(w ? null : { kind: '', text: 'Tap Start the sign-ins below.' });
        return;
      }
      if (k.startsWith('edit-')) {
        const row = panel.body.querySelector(`[data-key-row="${k.slice(5)}"]`);
        if (row) { row.classList.remove('hidden'); const i = row.querySelector('input'); if (i) i.focus(); }
        return;
      }
      if (k.startsWith('save-')) {
        const key = k.slice(5);
        // the box in the tapped button's own row (the paste card and "more" can both show one)
        const row = b.closest('[data-key-row]');
        const input = (row && row.querySelector('input')) || panel.body.querySelector(`input[data-key="${key}"]`);
        const v = input ? input.value.trim() : '';
        if (!v) { if (input) input.focus(); return; }
        b.disabled = true; b.textContent = 'Checking…';
        try { await saveKey(key, v); if (key !== 'zo') needSecond = false; }
        catch (er) { b.disabled = false; b.textContent = 'Save'; draw({ kind: 'bad', text: er.message }); }
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
        const another = b.dataset.another === '1';
        stopClaim();
        // opened on the tap, before anything is awaited — an iPhone blocks a window opened later
        let w = null;
        try { w = window.open('', '_blank'); if (w) w.opener = null; } catch (er) { w = null; }
        b.disabled = true; b.textContent = 'Opening…';
        let r;
        try { r = await window.api.social.linkStart(p, another); }
        catch (er) {
          if (w) try { w.close(); } catch (x) {}
          if (/another free Zernio account/i.test(er.message)) needSecond = true;
          draw({ kind: needSecond ? 'warn' : 'bad', text: er.message }); return;
        }
        if (r && r.account) {
          if (w) try { w.close(); } catch (x) {}
          await loadSocial(true);
          draw({ kind: 'good', text: `${label(p)} is connected as ${r.account.name}.` });
          renderSched(); renderHomeSocial();
          return;
        }
        claiming = { platform: p, another, url: r && r.url, until: Date.now() + 10 * 60000, timer: setInterval(claim, 4000) };
        let opened = false;
        if (w) { try { w.location.href = r.url; opened = true; } catch (er) { opened = false; } }
        // if the phone blocked it, the row's own Open button (a real link) does it
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
    registerTours();
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
      if (window.MWGuide) bar.appendChild(window.MWGuide.helpButton('studio', { title: 'Show me around', className: 'cloud-ask' }));
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
  /* ♥ the free songs someone has hearted in the Video Studio's Free music (veditor.js
     freeFavs): offered first here too, as a "Favourites" mood of their own */
  const FREE_FAVS = 'mw-free-favs';
  const freeFavs = () => { try { return new Set(JSON.parse(localStorage.getItem(FREE_FAVS) || '[]') || []); } catch (e) { return new Set(); } };
  const inMood = (t, mood) => (mood === '__fav' ? freeFavs().has(t.id) : t.mood === mood);
  const moodsWithFavs = (F) => {
    const favs = freeFavs();
    const any = favs.size && ((F && F.tracks) || []).some((t) => favs.has(t.id));
    return (any ? [{ id: '__fav', name: '♥ Favourites' }] : []).concat((F && F.moods) || []);
  };
  // a twentieth of a second of silence: what an iPhone is given to play inside the tap, so the song may play after
  const SILENCE = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
  /* each app its own trending hashtags — what the server puts on as it posts (social-copy.js forPlatform) */
  const APP_TAGS = { tiktok: ['#fyp', '#foryou', '#foryoupage'], instagram: ['#instagood', '#explorepage', '#reels'], facebook: ['#reels', '#viral', '#fbreels'], youtube: ['#shorts', '#youtubeshorts'] };
  const APP_TAG_SET = new Set([].concat(...Object.values(APP_TAGS), ['#fy', '#viralvideo', '#trending', '#explore', '#reelsinstagram', '#instadaily', '#youtube', '#facebookreels', '#reelsfb', '#christianreels', '#christiantiktok']));
  const CORE_TAGS = ['#jesus', '#faith', '#god', '#christian', '#church'];
  function tagsFor(caption, platform) {
    const own = (String(caption || '').match(/#[\wÀ-￿]+/g) || []).filter((t) => !APP_TAG_SET.has(t.toLowerCase()));
    const out = [];
    for (const t of [].concat(APP_TAGS[platform] || [], own, CORE_TAGS)) if (out.length < 5 && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    return out.join(' ');
  }
  // how this phone likes its flyers' music (Trending / free / none; TikTok's way), remembered
  function flyerPrefs() {
    try { const p = JSON.parse(localStorage.getItem('mw.flyer.music') || '{}') || {}; const o = {};
      if (['trending', 'none'].includes(p.mode)) o.mode = p.mode;
      else if (p.mode === 'free') o.mode = 'trending';   // (the free-instrumental choice is gone)
      if (['draft', 'trending'].includes(p.tiktok)) o.tiktok = p.tiktok;
      if (p.fbyt === 'own') o.fbyt = 'own';   // anything else: no music (never an instrumental)
      if (['app', 'here'].includes(p.fb)) o.fb = p.fb;
      if (['lib', 'app'].includes(p.igWay)) o.igWay = p.igWay;
      if (Array.isArray(p.fromIg)) o.fromIg = p.fromIg.filter((x) => typeof x === 'string');
      return o; } catch (e) { return {}; }
  }
  function freeDeal(tracks, mood) {
    const all = tracks || [];
    const pool = all.filter((t) => inMood(t, mood));
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
    // (mi-off: every idea keeps its own emoji — none swapped for a line icon, so the row reads as one set)
    return `<textarea id="mtBrief" class="mt-brief" rows="2" maxlength="400" placeholder="e.g. Bishop David Richman at The Power House — faith over fear. Join us Sundays at 10am">${esc(MT.brief)}</textarea>
        <div class="mt-ideas mi-off">${ideas.map(([v, l]) => `<button type="button" class="mt-chip${mtHas(MT.brief, v) ? ' on' : ''}" data-mt-idea="${escAttr(v)}">${esc(l)}</button>`).join('')}</div>`;
  }
  const MT = { items: [], song: null, songFile: null, style: 'hype', len: 30, custom: 120, aspect: '9:16', keep: true, brief: '', busy: false, order: 'ai', caps: true, mode: 'talk', free: null, freeMood: null, voice: '',
    acc: new Set() };   // the rows of "Fine-tune" that are open (kept across redraws)
  /* which free mood suits which style, for "✨ Pick for me" */
  const MT_MOOD_OF = { hype: 'hype', fun: 'upbeat', cinematic: 'epic', worship: 'uplift', emotional: 'calm' };
  /*
   * ►► TWO KINDS OF EDIT. ◄◄ A music montage is cut from what the clips LOOK
   * like, to a song. A viral talk edit is cut from what is SAID: the AI hears
   * every video, picks the strongest lines from any of them, puts the hook
   * first and builds the story, then cuts it with jump zooms, a cinematic
   * grade, B-roll from the photos and captions lit up word by word
   * (montage.js makeTalk).
   */
  // "Viral" beside "Music" read as two kinds of music: Viral is content made to be shared, Standard the classic montage
  const MT_MODES = [['talk', 'Viral'], ['music', 'Standard']];   // Viral first (on the left)
  const MT_KIND = {
    talk: { sub: 'The best lines, hook first — made to go viral' },
    music: { sub: 'Your clips and photos one after another, with music and words' },
  };
  const MT_TALK_LENS = [[15, '15s'], [30, '30s'], [45, '45s'], [60, '60s'], ['custom', 'Custom']];
  const MT_ORDERS = [['ai', 'AI decides'], ['mine', 'My order']];
  const MT_STYLES = [['hype', 'Hype'], ['worship', 'Worship'], ['emotional', 'Emotional'], ['cinematic', 'Cinematic'], ['fun', 'Fun']];
  const MT_LENS = [['all', 'All'], [15, '15s'], [30, '30s'], [45, '45s'], [60, '60s'], ['custom', 'Custom']];
  const MT_ASPECTS = [['9:16', 'Reels / TikTok'], ['1:1', 'Square'], ['4:5', 'Feed'], ['16:9', 'YouTube']];

  async function openMontage() {
    if (MT.busy && MT.panel && document.body.contains(MT.panel.el)) return;
    const panel = C.openPanel({ id: 'cloudMontage', title: 'AI Montage', cls: 'cp-montage', full: true, onClose: () => { mtPreviewStop(); if (!MT.busy) mtRelease(); } });
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

  /*
   * ►► THE AI MONTAGE, CALM AND CLEAR. ◄◄ The feedback: "confusing,
   * overwhelming, too much going on" — and "Viral" beside "Music" read as two
   * kinds of music. So the page asks two things, big: what are you making (two
   * picture cards — Viral, made to be shared; Standard, clips and photos cut to
   * music) and which videos. Every other choice is one tidy list, as a phone's
   * own Settings is: each row says what it is set to now, and opens in place to
   * change it. Nothing was taken away — every choice is a row.
   */
  function mtArt(v) {
    return v === 'talk'
      ? `<span class="mt-art mt-art-v" aria-hidden="true"><span class="mt-ph mt-ph-l"></span><span class="mt-ph mt-ph-r"></span>
          <span class="mt-ph mt-ph-c">${mi('flame')}<span class="mt-cap"><i></i><i></i><i></i></span></span><span class="mt-likes"><i></i>24K</span></span>`
      : `<span class="mt-art mt-art-s" aria-hidden="true"><span class="mt-film"><i></i><i></i><i></i><i></i></span>
          <span class="mt-eq"><i></i><i></i><i></i><i></i><i></i></span><span class="mt-art-note">${mi('music')}</span></span>`;
  }
  // a shape's own outline, at most 40 × 34
  const mtBox = (v) => { const [a, b] = String(v).split(':').map(Number); const k = Math.min(40 / a, 34 / b); return [Math.round(a * k), Math.round(b * k)]; };
  // "🙏 Worship & uplifting" → "Worship"
  const mtWord = (n) => String(n || '').replace(/\s*&.*$/, '').replace(/^\S+\s/, '');
  /* what each row of the list is set to now, in a word or two (the music: what will really be used) */
  function mtValues(who) {
    const F = MT.freeList;
    let music = 'No music';
    if (MT.songFile) music = MT.songFile.name.replace(/\.[^.]+$/, '');
    else if (MT.free && F && F.tracks) {
      if (MT.free === 'auto') music = 'Pick for me · ' + mtWord((moodsWithFavs(F).find((m) => m.id === mtFreeMood()) || {}).name || mtFreeMood());
      else music = (F.tracks.find((t) => t.id === MT.free) || {}).title || 'A free song';
    } else if (MT.song) music = String(MT.song.name || 'Your song');
    const voices = (who.voiceover && who.voiceover.voices) || [];
    return {
      music,
      len: MT.len === 'all' ? 'All of it' : MT.len === 'custom' ? mtClock(MT.custom) : MT.len + ' sec',
      shape: (MT_ASPECTS.find(([v]) => v === MT.aspect) || ['', MT.aspect])[1],
      voice: !MT.voice ? 'None' : ((voices.find((x) => x.id === MT.voice) || {}).label || 'On'),
      about: MT.brief ? MT.brief : 'Optional',
      look: (MT_STYLES.find(([v]) => v === MT.style) || ['', 'Hype'])[1],
      order: MT.order === 'mine' ? 'My order' : 'AI decides',
    };
  }
  // the mood "✨ Pick for me" deals from: the one tapped, else the style's own
  const mtFreeMood = () => MT.freeMood || MT_MOOD_OF[MT.style] || 'uplift';

  function mtPaint() {
    const p = MT.panel; if (!p) return;
    const esc = C.esc, attr = C.escAttr;
    const who = MT.who || {};
    const openPath = window.VideoEditor && (window.VideoEditor.montagePath || window.VideoEditor.currentPath) ? (window.VideoEditor.montagePath || window.VideoEditor.currentPath)() : null;
    const openIsMontage = !!openPath && /(^|[\\/])montage-[^\\/]*\.mp4$/i.test(openPath);
    const talk = MT.mode === 'talk';
    if (talk && MT.len === 'all') MT.len = 30;
    const nVid = MT.items.filter((it) => it.kind === 'video').length;
    const ready = talk ? nVid >= 1 : MT.items.length >= 2;
    const n = MT.items.length;
    // a choice of a few: one segmented control, as the phone's own
    const seg = (list, cur, key) => `<div class="mt-sc">${list.map(([v, label]) => `<button type="button" class="${String(cur) === String(v) ? 'on' : ''}" data-mt-${key}="${attr(v)}">${esc(label)}</button>`).join('')}</div>`;
    const head = (k, title, meta) => `<h3 class="mt-h"><i>${k}</i><span>${title}</span>${meta ? `<small>${meta}</small>` : ''}</h3>`;
    const row = (key, icon, label, value, body, hidden) => `<details class="mt-acc" data-acc="${key}"${MT.acc.has(key) ? ' open' : ''}${hidden ? ' hidden' : ''}>
        <summary><span class="mt-ic mt-ic-${key}">${mi(icon)}</span><h3>${label}</h3><span class="mt-val">${esc(value)}</span><span class="mt-chev" aria-hidden="true"></span></summary>
        <div class="mt-acc-in">${body}</div></details>`;
    const V = mtValues(who);

    // 2 — the videos: one inviting card when there are none, then their pictures
    const tiles = MT.items.map((it, i) => `<div class="mt-tile" data-i="${i}">${it.kind === 'image'
        ? (it.thumb ? `<img src="${attr(it.thumb)}" alt="" draggable="false" />` : it.bad ? `<span class="mt-nopic">${mi('image')}</span>` : '<span class="mt-load"></span>') : (it.poster ? `<img src="${attr(it.poster)}" alt="" draggable="false" />` : '<span class="mt-load"></span>') + (talk
          ? `<button type="button" class="mt-part${mtHasPart(it) ? ' on' : ''}" data-mt-part="${i}" aria-label="Choose the part to use">${mi('scissors')}<span>${mtHasPart(it) ? mtClock(it.from || 0) + '–' + mtClock(it.to || it.secs) : 'Trim'}</span></button>`
          : `<span class="mt-dur">${mi('play')}${it.secs ? mtClock(it.secs) : ''}</span>`)}
        ${MT.order === 'mine' ? `<span class="mt-num">${i + 1}</span>` : ''}
        <button type="button" class="mt-x" data-mt-del="${i}" aria-label="Remove">${mi('x')}</button></div>`).join('');
    const videos = n
      ? `<div class="mt-grid${MT.order === 'mine' ? ' mt-ordered' : ''}">${tiles}
          <button type="button" class="mt-addt" data-mt="add"><span class="mt-addt-ic">${mi('plus')}</span><span>Phone</span></button>
          <button type="button" class="mt-addt" data-mt="addsrv"><span class="mt-addt-ic">${mi('folder')}</span><span>My Uploads</span></button></div>
        ${!talk && n > 1 ? '<small class="mt-hint">Hold a tile and drag it to change the order.</small>' : ''}`
      : `<div class="mt-empty">
          <span class="mt-empty-top"><span class="mt-empty-ic">${mi(talk ? 'film' : 'image')}</span>
            <span class="mt-empty-t"><b>${talk ? 'Add a video of someone speaking' : 'Add your clips and photos'}</b>
            <small>${talk ? 'A sermon, a talk, a testimony — the AI finds the best lines' : 'Two or more. They play one after another, with music.'}</small></span></span>
          <span class="mt-empty-btns"><button type="button" class="mt-btn mt-btn-hi" data-mt="add">${mi('phone')}<span>From phone</span></button>
            <button type="button" class="mt-btn" data-mt="addsrv">${mi('folder')}<span>My Uploads</span></button></span></div>`;

    // 3 — fine-tune: one list, each row its value, opened in place
    const keepRow = `<label class="mt-swline"${talk ? ' hidden' : ''}><span>Keep the clips’ own sound${MT.song || MT.songFile || MT.free ? ' under the music' : ''}</span>
        <input type="checkbox" class="mt-sw" id="mtKeep" ${MT.keep ? 'checked' : ''}/></label>`;
    const lenBody = `${seg(talk ? MT_TALK_LENS : MT_LENS, MT.len, 'len')}
        ${MT.len === 'custom' ? `<div class="mt-custom"><label><input type="number" id="mtMin" inputmode="numeric" min="0" max="10" value="${Math.floor(MT.custom / 60)}" /><span>min</span></label>
          <label><input type="number" id="mtSec" inputmode="numeric" min="0" max="59" step="5" value="${MT.custom % 60}" /><span>sec</span></label></div>` : ''}`;
    const shapeBody = `<div class="mt-shapes">${MT_ASPECTS.map(([v, l]) => { const [w, h] = mtBox(v); return `<button type="button" class="mt-shape${MT.aspect === v ? ' on' : ''}" data-mt-aspect="${attr(v)}">
        <span class="mt-shape-pic"><i style="width:${w}px;height:${h}px"></i></span><b>${esc(l)}</b><small>${esc(v)}</small></button>`; }).join('')}</div>`;
    const voiceBody = who.voiceover && who.voiceover.installed ? mtVoiceHtml(who.voiceover.voices || [])
      : '<small class="mt-hint">The narrator voice is not installed on this server yet — update the server to add it.</small>';
    const lookBody = `<div class="mt-row mt-looks">${MT_STYLES.map(([v, l]) => `<button type="button" class="mt-chip${MT.style === v ? ' on' : ''}" data-mt-style="${attr(v)}"><i class="mt-dot mt-dot-${v}"></i>${esc(l)}</button>`).join('')}</div>`;
    const orderBody = `${seg(MT_ORDERS, MT.order, 'order')}
        <small class="mt-hint">${MT.order === 'mine' ? 'Hold a tile and drag it to move it.' : 'Hold and drag a tile to set your own order.'}</small>`;
    const capsRow = talk ? '' : `<label class="mt-swrow"><span class="mt-ic mt-ic-caps">${mi('captions')}</span><span class="mt-lbl">Captions</span>
        <input type="checkbox" class="mt-sw" id="mtCaps" ${MT.caps ? 'checked' : ''}/></label>`;

    p.body.innerHTML = `
      ${openIsMontage ? `<button type="button" class="me-banner" data-mt-rearrange><span class="me-banner-ic">${mi('pen')}</span><span class="me-banner-t"><b>Rearrange the montage that’s open</b><small>Move clips and photos, then remake it</small></span><span class="mt-chev" aria-hidden="true"></span></button>` : ''}
      <section class="mt-sec">${head(1, 'What are you making?')}
        <div class="mt-kinds">${MT_MODES.map(([v, name]) => `<button type="button" class="mt-kind${MT.mode === v ? ' on' : ''}" data-mt-mode="${v}" aria-pressed="${MT.mode === v}">
          ${mtArt(v)}<span class="mt-kind-t"><b>${name}</b><small>${MT_KIND[v].sub}</small></span><span class="mt-tick">${mi('check')}</span></button>`).join('')}</div></section>
      <section class="mt-sec">${head(2, talk ? 'Your videos' : 'Your clips & photos', n ? `${n} added` : talk ? '1 or more' : '2 or more')}
        ${MT.picking ? '<div class="mt-picking"><i class="cf-spin"></i><span>Getting your photos and videos from your phone…</span></div>' : ''}
        ${videos}${MT.note ? `<small class="mt-note${MT.note.warn ? ' warn' : ''}">${esc(MT.note.text)}</small>` : ''}</section>
      <section class="mt-sec mt-tune">${head(3, 'Fine-tune', 'optional')}
        <div class="mt-group">
          ${row('music', 'music', 'Music', V.music, mtMusicHtml() + keepRow)}
          ${row('len', 'hourglass', 'Length', V.len, lenBody)}
          ${row('shape', 'crop', 'Shape', V.shape, shapeBody)}
          ${talk ? row('voice', 'mic', 'Narrator', V.voice, voiceBody) : ''}
          ${row('about', 'pen', 'What it’s about', V.about, mtAboutHtml())}
          ${row('look', 'wand', 'Vibe', V.look, lookBody)}
          ${row('order', 'shuffle', 'Order', V.order, orderBody, talk)}
          ${capsRow}
        </div></section>`;
    // a row opened or closed stays so through every redraw; one the operator opens eases in
    $$('details.mt-acc', p.body).forEach((d) => d.addEventListener('toggle', () => {
      const k = d.dataset.acc;
      if (d.open && !MT.acc.has(k)) { MT.acc.add(k); d.classList.add('mt-opening'); }
      else if (!d.open) MT.acc.delete(k);
    }));
    const go = !ready ? (talk ? (n ? 'Viral needs a video — or choose Standard' : 'Add a video to start') : 'Add 2 clips or photos to start') : talk ? 'Make my viral montage' : 'Make my montage';
    p.foot.innerHTML = `<button type="button" class="mt-go" data-mt="go"${ready ? '' : ' disabled'}>${ready ? mi('sparkles') : ''}<span>${go}</span></button>`;
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
        ${hasFree ? `<button type="button" class="${tab === 'free' ? 'on' : ''}" data-mt-tab="free">Tracks</button>` : ''}
        <button type="button" class="${tab === 'mine' ? 'on' : ''}" data-mt-tab="mine">My songs</button></div>`;
    const playing = MT.preview && MT.preview.key;
    const row = ({ key, sel, title, sub, pick, play }) => `<div class="mt-song${sel ? ' on' : ''}" ${pick}>
        ${play ? `<button type="button" class="mt-play${playing === key ? ' on' : ''}" data-mt-play="${attr(key)}" aria-label="Listen to ${attr(title)}"></button>` : `<span class="mt-play mt-play-x">${mi('sparkles')}</span>`}
        <span class="mt-song-t"><b>${esc(title)}</b><small data-mt-sub="${attr(key)}" data-orig="${attr(sub)}">${esc(sub)}</small></span><span class="mt-radio"></span></div>`;
    if (tab === 'free' && hasFree) {
      const mood = MT.freeMood || (F.tracks.find((t) => t.id === MT.free) || {}).mood || mtFreeMood();
      const moods = moodsWithFavs(F);
      const mName = (moods.find((m) => m.id === mood) || {}).name || '';
      const songs = F.tracks.filter((t) => inMood(t, mood));
      const selAt = songs.findIndex((t) => t.id === MT.free);
      const all = MT.showAll === mood || selAt >= MT_LIST_SHOW;
      const shown = all ? songs : songs.slice(0, MT_LIST_SHOW);
      return `${tabs}
        <div class="mt-row mt-moods">${moods.map((m) => `<button type="button" class="mt-chip${mood === m.id ? ' on' : ''}" data-mt-mood="${attr(m.id)}">${esc(mtWord(m.name))}</button>`).join('')}</div>
        <div class="mt-list">
          ${row({ key: 'auto', sel: MT.free === 'auto', title: 'Pick for me', sub: `a different ${mtWord(mName)} song each time`, pick: 'data-mt-free="auto"' })}
          ${shown.map((t) => row({ key: 'free:' + t.id, sel: MT.free === t.id, title: t.title, sub: (freeFavs().has(t.id) ? '♥ ' : '') + (t.artist ? 'by ' + t.artist : mName.replace(/^\S+\s/, '')), pick: `data-mt-free="${attr(t.id)}"`, play: true })).join('')}
          ${!all && songs.length > MT_LIST_SHOW ? `<button type="button" class="mt-more" data-mt-all="${attr(mood)}">Show all ${songs.length} ${esc(mtWord(mName))} songs</button>` : ''}
        </div>
        <small class="mt-hint">Free and safe to post — no copyright flags, no credit needed (Mixkit).</small>`;
    }
    if (tab === 'mine') {
      return `${tabs}
        <div class="mt-list">
          ${MT.songFile ? row({ key: 'file', sel: true, title: MT.songFile.name.replace(/\.[^.]+$/, ''), sub: 'from this phone', pick: 'data-mt-tab="mine"', play: true }) : ''}
          ${MT.lib.slice(0, 30).map((m) => row({ key: 'lib:' + m.id, sel: !!(MT.song && MT.song.id === m.id), title: String(m.name || 'Song'), sub: m.durationSec ? mtClock(m.durationSec) : 'your song', pick: `data-mt-song="${attr(m.id)}"`, play: true })).join('')}
          <button type="button" class="mt-more" data-mt="song">${mi('plus')} Add a song from this phone</button>
        </div>
        ${MT.lib.length || MT.songFile ? '' : '<small class="mt-hint">It stays here for next time.</small>'}`;
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
        ${play ? `<button type="button" class="mt-play${playing === 'voice:' + id ? ' on' : ''}" data-mt-play="voice:${attr(id)}" aria-label="Hear ${attr(title)}"></button>` : `<span class="mt-play mt-play-x mt-play-off">${mi('volume-x')}</span>`}
        <span class="mt-song-t"><b>${esc(title)}</b><small data-mt-sub="voice:${attr(id)}" data-orig="${attr(sub)}">${esc(sub)}</small></span><span class="mt-radio"></span></div>`;
    return `<div class="mt-list">${row('', 'No narrator', 'Straight in with the first line', false)}${voices.map((v) => row(v.id, v.label, MT_VOICE_FEEL[v.id] || 'An AI voice', true)).join('')}</div>
      <small class="mt-hint">A hook at the start and a closing line at the end, written by the AI for this edit.</small>`;
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
      const b = e.target.closest('[data-mt],[data-mt-part],[data-mt-del],[data-mt-song],[data-mt-style],[data-mt-len],[data-mt-aspect],[data-mt-order],[data-mt-mode],[data-mt-voice],[data-mt-free],[data-mt-mood],[data-mt-idea],[data-mt-tab],[data-mt-play],[data-mt-all]');
      if (!b || MT.busy || mtDrag.just) return;
      const d = b.dataset;
      if (d.mtOrder) { MT.order = d.mtOrder; return mtPaint(); }
      if (d.mtMode) {
        MT.mode = d.mtMode; MT.note = null;
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
      if (d.mtPart != null) return mtChoosePart(MT.items[+d.mtPart]);
      if (d.mtDel != null) { const it = MT.items.splice(+d.mtDel, 1)[0]; if (it) URL.revokeObjectURL(it.url); MT.note = null; return mtPaint(); }
      if (d.mtSong != null) { MT.song = d.mtSong ? MT.lib.find((m) => m.id === d.mtSong) || null : null; MT.songFile = null; MT.free = null; MT.musTab = d.mtSong ? 'mine' : 'none'; if (!d.mtSong) mtPreviewStop(); return mtPaint(); }
      if (d.mtFree) {
        MT.free = d.mtFree; MT.song = null; MT.songFile = null; MT.musTab = 'free';
        // a song picked: its mood is the one "Pick for me" deals from after it
        const t = d.mtFree !== 'auto' && MT.freeList && MT.freeList.tracks.find((x) => x.id === d.mtFree);
        if (t) MT.freeMood = t.mood;
        return mtPaint();
      }
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
      if (d.mt === 'add') {
        const pick = document.getElementById('mtPick');
        MT.picking = true; MT.note = null;
        clearTimeout(mtPickTimer);
        mtPickTimer = setTimeout(() => { if (MT.picking) { mtPickingOff(); mtPaint(); } }, 3 * 60e3);
        pick.click();   // (first, while the tap still counts as the operator's)
        return mtPaint();
      }
      if (d.mt === 'addsrv') return mtAddFromFiles();
      if (d.mt === 'song') return document.getElementById('mtSong').click();
      if (d.mt === 'go') return mtMake();
    };
    p.body.addEventListener('click', onClick);
    p.foot.addEventListener('click', onClick);
    mtPickers();
    // (a phone that does not say the picker was closed: the next tap elsewhere takes the line away —
    // the element itself, not a redraw, so the tap still lands where it was aimed)
    p.body.addEventListener('pointerdown', (e) => {
      if (!MT.picking || e.target.closest('[data-mt="add"]')) return;
      mtPickingOff();
      const w = p.body.querySelector('.mt-picking'); if (w) w.remove();
    }, true);
    p.body.addEventListener('change', (e) => {
      if (e.target.id === 'mtKeep') MT.keep = e.target.checked;
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
   * The phone's own pickers for clips, photos and a song. They live on the
   * page, NOT inside the sheet: the sheet is redrawn whenever anything changes
   * (music loading, a poster arriving), and a picker redrawn away while the
   * iPhone's Photos was open answered into nothing, so the tick did nothing.
   */
  function mtPickers() {
    const make = (id, accept, multiple, take) => {
      if (document.getElementById(id)) return;
      const inp = document.createElement('input');
      inp.type = 'file'; inp.id = id; inp.accept = accept; inp.multiple = multiple;
      inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
      inp.addEventListener('change', () => {
        mtPickingOff();
        const files = Array.from(inp.files || []); inp.value = '';
        if (files.length) take(files);
        else { MT.note = { warn: true, text: 'Nothing came through from your phone. If they are kept in iCloud, open them in Photos first so they download, then add them again.' }; mtPaint(); }
      });
      inp.addEventListener('cancel', () => { mtPickingOff(); mtPaint(); });
      document.body.appendChild(inp);
    };
    make('mtPick', 'video/*,image/*', true, (files) => {
      const room = Math.max(0, MT_MAX - MT.items.length);
      for (const f of files.slice(0, room)) {
        const kind = /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|avif|gif)$/i.test(f.name) ? 'image' : 'video';
        const it = { file: f, kind, url: URL.createObjectURL(f) };
        MT.items.push(it);
        mtPicture(it);
      }
      // what needs saying is said in the sheet, under the tiles — no pop-ups
      const switched = mtFitMode();
      MT.note = files.length > room
        ? { warn: true, text: room ? `A montage takes up to ${MT_MAX} clips and photos: ${room} of the ${files.length} were added.` : `A montage takes up to ${MT_MAX} clips and photos, and this one is full.` }
        : switched ? { text: 'Photos make a Standard montage: one after another, with music. Viral needs a video of someone speaking.' } : null;
      mtPaint();
    });
    make('mtSong', 'audio/*,.mp3,.m4a,.wav,.aac', false, (files) => {
      MT.songFile = files[0]; MT.song = null; MT.free = null; MT.musTab = 'mine';
      if (MT.songFileUrl) { URL.revokeObjectURL(MT.songFileUrl); MT.songFileUrl = null; }
      mtPaint();
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
      if (!tile || e.target.closest('.mt-x,.mt-part') || MT.busy) return;
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
    for (const p of paths.slice(0, Math.max(0, MT_MAX - MT.items.length))) {
      if (have.has(p)) continue;
      const name = String(p).split(/[\\/]/).pop();
      const kind = /\.(jpe?g|png|webp|heic|avif)$/i.test(name) ? 'image' : 'video';
      const it = { path: p, name, kind, file: null, url: kind === 'image' ? C.fileUrl(p) : '' };
      MT.items.push(it);
      if (kind === 'image') mtPicture(it);   // a small picture of it, like a photo from the phone
      if (kind === 'video') {
        // its picture and length, from the server (the phone does not have the file)
        (async () => {
          try { const t = await window.api.video.thumbnail(p, 1); if (t) it.poster = C.fileUrl(t); } catch (e) {}
          try { const info = await window.api.video.info(p); if (info && info.durationSec) it.secs = info.durationSec; it.size = (info && info.sizeBytes) || 0; } catch (e) {}
          mtPaint();
        })();
      }
    }
    MT.note = mtFitMode() ? { text: 'Photos make a Standard montage: one after another, with music. Viral needs a video of someone speaking.' } : null;
    mtPaint();
  }

  /*
   * ►► FROM WHICH PART TO WHICH PART. ◄◄ "Let me choose from which part to
   * which part of the video for the AI to do its montage." Tap ✂️ on a video:
   * it plays here, and two handles (or "Start here" / "End here" while it
   * plays) mark the part. Only that part is listened to and cut from.
   */
  const mtHasPart = (it) => !!it && it.kind === 'video' && ((it.from || 0) > 0.05 || (it.to > 0 && (!it.secs || it.to < it.secs - 0.05)));
  function mtChoosePart(it) {
    if (!it || it.kind !== 'video' || MT.busy) return;
    const esc = C.esc;
    const src = it.url || (it.path ? C.fileUrl(it.path) : '');
    const p = C.openPanel({ id: 'cloudMontagePart', title: 'Choose the part to use', cls: 'cp-montage cp-mtpart' });
    let D = it.secs || 0, A = it.from || 0, B = it.to || D, stopAt = null;
    const MIN = 3;   // a part shorter than this has nothing to cut from
    p.body.innerHTML = `<div class="mp-wrap" data-mp="play">
        <video class="mp-video" playsinline webkit-playsinline preload="metadata" src="${C.escAttr(src)}"></video>
        <button type="button" class="mp-play" aria-label="Play"></button></div>
      <div class="mp-times"><span><small>From</small><b data-mp-a></b></span><span class="mp-len"><small>Part</small><b data-mp-len></b></span><span><small>To</small><b data-mp-b></b></span></div>
      <div class="mp-track"><i class="mp-sel"></i>
        <input type="range" class="mp-r mp-ra" min="0" step="0.1" aria-label="From" />
        <input type="range" class="mp-r mp-rb" min="0" step="0.1" aria-label="To" /></div>
      <div class="mp-btns"><button type="button" class="mt-chip" data-mp="a">⇤ Start here</button>
        <button type="button" class="mt-chip" data-mp="part">▶ Play the part</button>
        <button type="button" class="mt-chip" data-mp="b">End here ⇥</button></div>
      <small class="mt-hint">Drag the handles, or play it and tap <b>Start here</b> and <b>End here</b>. The AI listens only to this part and makes the montage from it.</small>`;
    p.foot.innerHTML = `<div class="mt-foot2"><button type="button" class="mt-edit" data-mp="all">Use all of it</button><button type="button" class="mt-go" data-mp="ok">Use this part</button></div>`;
    const v = $('.mp-video', p.body), ra = $('.mp-ra', p.body), rb = $('.mp-rb', p.body);
    const paint = () => {
      ra.max = rb.max = String(D || 1);
      ra.value = String(A); rb.value = String(B);
      $('[data-mp-a]', p.body).textContent = mtClock(A);
      $('[data-mp-b]', p.body).textContent = mtClock(B);
      $('[data-mp-len]', p.body).textContent = mtClock(B - A);
      const sel = $('.mp-sel', p.body);
      sel.style.left = (D ? (A / D) * 100 : 0) + '%';
      sel.style.width = (D ? ((B - A) / D) * 100 : 100) + '%';
      $('.mp-play', p.body).classList.toggle('on', !v.paused);
    };
    const seek = (t) => { try { v.currentTime = Math.max(0, Math.min(D || t, t)); } catch (e) {} };
    v.addEventListener('loadedmetadata', () => {
      if (!(v.duration > 0) || !isFinite(v.duration)) return;
      const first = !D;
      D = v.duration; it.secs = it.secs || D;
      if (first || !(B > 0)) B = it.to || D;
      B = Math.min(B, D); A = Math.min(A, Math.max(0, B - MIN));
      paint(); seek(A + 0.01);
    });
    v.addEventListener('timeupdate', () => { if (stopAt != null && v.currentTime >= stopAt) { v.pause(); stopAt = null; } });
    v.addEventListener('play', paint); v.addEventListener('pause', paint);
    p.body.addEventListener('input', (e) => {
      if (e.target === ra) { A = Math.min(+ra.value, Math.max(0, B - MIN)); seek(A); }
      else if (e.target === rb) { B = Math.max(+rb.value, Math.min(D, A + MIN)); seek(B); }
      else return;
      stopAt = null; if (!v.paused) v.pause();
      paint();
    });
    const onClick = (e) => {
      const b = e.target.closest('[data-mp]'); if (!b) return;
      const k = b.dataset.mp;
      if (k === 'play') { if (v.paused) { stopAt = null; v.play().catch(() => {}); } else v.pause(); }
      else if (k === 'part') { stopAt = B; seek(A); v.play().catch(() => {}); }
      else if (k === 'a') { A = Math.min(v.currentTime || 0, Math.max(0, B - MIN)); paint(); }
      else if (k === 'b') { B = Math.max(v.currentTime || 0, Math.min(D, A + MIN)); paint(); }
      else if (k === 'all') { it.from = 0; it.to = 0; C.closePanel(p); mtPaint(); }
      else if (k === 'ok') {
        it.from = Math.round(A * 10) / 10;
        it.to = D && B >= D - 0.05 ? 0 : Math.round(B * 10) / 10;
        C.closePanel(p); mtPaint();
      }
    };
    p.body.addEventListener('click', onClick);
    p.foot.addEventListener('click', onClick);
    p.onClose = () => { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} };
    paint();
    $('[data-mp-len]', p.body).textContent = D ? mtClock(B - A) : '…';
  }

  /*
   * ►► FIFTY PHOTOS AT ONCE. ◄◄ Each tile shows a small picture made from the
   * photo, one photo at a time: forty full-size iPhone photos (12–48
   * megapixels each) drawn at once took more memory than the iPhone gives a
   * page, and the app was closed and reloaded under the operator. Videos'
   * first frames are taken one at a time too (a phone plays only so many
   * videos at once). The sheet is redrawn once a moment, not once a picture.
   */
  const MT_MAX = 60;
  /*
   * Photos only, in Viral: Viral is cut from what someone SAYS in a video, so
   * with nothing but photos its button stayed grey ("Add a video to start")
   * and forty photos seemed to do nothing. Photos alone make a Standard
   * montage (one after another, with music), and the sheet says so.
   */
  function mtFitMode() {
    if (MT.mode !== 'talk' || !MT.items.length || MT.items.some((it) => it.kind === 'video')) return false;
    MT.mode = 'music';
    return true;
  }
  /* the picker answered (or was closed): the "Getting your photos…" line goes */
  let mtPickTimer = null;
  function mtPickingOff() { clearTimeout(mtPickTimer); MT.picking = false; }
  let mtPicQueue = Promise.resolve(), mtPaintTimer = null;
  function mtPaintSoon() { if (!mtPaintTimer) mtPaintTimer = setTimeout(() => { mtPaintTimer = null; mtPaint(); }, 250); }
  function mtPicture(it) {
    mtPicQueue = mtPicQueue.then(() => (MT.items.includes(it) ? (it.kind === 'image' ? mtPhotoThumb(it) : mtPoster(it)) : null)).catch(() => {}).then(mtPaintSoon);
  }
  function mtPhotoThumb(it) {
    return new Promise((resolve) => {
      const im = new Image();
      const done = () => { im.onload = im.onerror = null; im.removeAttribute('src'); resolve(); };
      im.onload = () => {
        try {
          const k = 320 / Math.max(1, Math.min(im.naturalWidth, im.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(im.naturalWidth * Math.min(1, k))); c.height = Math.max(1, Math.round(im.naturalHeight * Math.min(1, k)));
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          it.thumb = c.toDataURL('image/jpeg', 0.75);
          c.width = c.height = 0;
        } catch (e) { it.thumb = ''; }
        done();
      };
      im.onerror = () => { it.thumb = ''; it.bad = true; done(); };
      im.src = it.url;
    });
  }
  /*
   * A photo is sent at the size the montage can use: its short side at most
   * 2400 pixels (a 1920-tall frame, with room to zoom), as a JPEG — a tenth
   * of a 48-megapixel original, so fifty go up in minutes, not an hour. The
   * phone turns it the right way up as it draws it.
   */
  function mtShrinkPhoto(file) {
    if (/gif$/i.test(file.type || '') || /\.gif$/i.test(file.name || '')) return Promise.resolve(file);
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      const keep = () => { URL.revokeObjectURL(url); resolve(file); };
      im.onerror = keep;
      im.onload = () => {
        const w = im.naturalWidth, h = im.naturalHeight;
        const k = Math.min(1, 2400 / Math.max(1, Math.min(w, h)), Math.sqrt(16e6 / Math.max(1, w * h)));   // (and the phone's canvas limit, for a panorama)
        if (k >= 1 && file.size < 3 * 1024 * 1024 && /jpe?g$/i.test(file.type || '')) return keep();
        try {
          const c = document.createElement('canvas');
          c.width = Math.round(w * k); c.height = Math.round(h * k);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          c.toBlob((b) => {
            c.width = c.height = 0; URL.revokeObjectURL(url);
            if (!b || b.size >= file.size) return resolve(file);
            resolve(new File([b], String(file.name || 'photo').replace(/\.[a-z0-9]+$/i, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified }));
          }, 'image/jpeg', 0.9);
        } catch (e) { keep(); }
      };
      im.src = url;
    });
  }

  function mtPoster(it) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    let done = false, settle = null;
    const over = new Promise((r) => { settle = r; });
    const finish = () => { if (done) return; done = true; try { v.removeAttribute('src'); v.load(); } catch (e) {} settle(); };
    const grab = () => {
      if (done) return;
      try {
        const w = 240, h = Math.round(240 * (v.videoHeight / Math.max(1, v.videoWidth))) || 400;
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        it.poster = c.toDataURL('image/jpeg', 0.7);
      } catch (e) { /* the play mark alone */ }
      finish();
    };
    v.addEventListener('loadedmetadata', () => {
      it.secs = v.duration || 0;
      try { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); } catch (e) {}
    });
    v.addEventListener('seeked', grab);
    v.addEventListener('error', finish);
    setTimeout(() => { if (!done && v.readyState >= 2) grab(); }, 2500);
    setTimeout(finish, 8000);   // never holds up the pictures after it
    v.src = it.url;
    v.load();
    return over;
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
      // three at a time, each photo at the size the montage can use (mtShrinkPhoto)
      const part = new Map();   // item -> share of it sent (0..1)
      let finished = 0, next = 0;
      const items = MT.items.slice();
      // one that fails (or is stopped) stops the others taking more; what is sent stays sent,
      // and their progress no longer draws "Sending…" over the message that says why it stopped
      let failed = null;
      const say = () => {
        if (failed) return;
        const got = items.reduce((n, it) => n + sizeOf(it) * (it.path ? 1 : part.get(it) || 0), 0);
        mtProgress(`Sending ${Math.min(items.length, finished + 1)} of ${items.length}…`, (got / total) * 30);
      };
      say();
      const worker = async () => {
        while (next < items.length && !failed) {
          const it = items[next++];
          if (it.path) { finished++; continue; }
          try {
            const file = it.kind === 'image' ? await mtShrinkPhoto(it.file) : it.file;
            it.path = await C.uploadFile(file, (pc) => { part.set(it, pc / 100); say(); });
          } catch (e) { failed = failed || e; throw e; }
          finished++; say();
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      for (const it of items) paths.push(it.path);
      // 2) the song joins the music library, so it is on the music lane afterwards
      let song = MT.song;
      // a free song: fetched onto the server's music library (once), credited in the post
      let credit = '';
      if (!MT.songFile && MT.free && MT.freeList) {
        mtProgress('Getting the music…', 30);
        try {
          song = await freeFetch(MT.free, MT.freeList.tracks, mtFreeMood(), (title) => { if (title) mtProgress(`Getting the music — “${title}”…`, 30); });
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
        // the part of each video to use (null: all of it)
        ranges: talk ? MT.items.map((it) => (it.kind === 'video' && mtHasPart(it) ? { from: it.from || 0, to: it.to || 0 } : null)) : undefined,
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
      const sentSome = MT.items.some((it) => it.path && it.file);
      const why = e && e.stopped ? 'Sending was stopped.' : (e && e.message) || 'Something went wrong.';
      p.body.innerHTML = `<div class="mt-run"><div class="mt-orb bad">!</div><b class="mt-stage">That montage didn’t finish</b>
        <small class="mt-note">${C.esc(why)}${sentSome ? ' Tap Make again to carry on: what was already sent is not sent again.' : ''}</small></div>`;
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

  window.MWSocial = { _mtResult: (r) => mtResult(r), _rhythmOf: (t) => rhythmOf(t), _freeSlot: () => freeSlot(), busy: () => !!MT.busy, start, go, compose, openConnect, openMontage, editMontage, openProjects, openProject, deleteOpenProject, openPost, view: () => S.view, _state: S, _planTimes: planTimes, _titleFromFile: titleFromFile };
})();
