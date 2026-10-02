'use strict';
/*
 * PHONE STUDIO — the front end.
 *
 * Everything visible here is a thin skin over the same handlers the desktop
 * Video Studio calls. When you tap "Long to short clips", this posts
 * `sermon:analyze` to the PC and the PC runs the identical analysis it would
 * run for the desktop window; when you tap Export, the PC's ffmpeg does the
 * encoding with hardware acceleration and hands back a file you can save to the
 * camera roll. The phone never decodes a sermon.
 *
 * The one thing that genuinely runs HERE is face tracking for auto-reframe:
 * facetrack.js is served by the PC and executes in this browser against frames
 * the PC sampled — which is exactly what happens on the desktop, so the crop
 * path a phone export follows is the same code, not a reimplementation.
 */
(function () {
  /* ═══════════════════════════ small helpers ═══════════════════════════ */

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
             : `${m}:${String(s).padStart(2, '0')}`;
  }
  const mb = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB');
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();

  /* ═══════════════════════════ state ═══════════════════════════ */

  const DEFAULTS = {
    aspect: 'reel-9x16', fill: 'crop', denoise: '', fadeIn: 0, fadeOut: 0,
    reframe: true, deep: true, pauses: true, len: 'auto',
    capAuto: false, capStyle: 'outline', capFont: 'Bebas Neue', capSize: 'm', capTrans: 'pop',
    capPos: 'bottom', capWords: '3', capCase: 'upper',
    musicId: '', musicVol: 0.25, outroId: '',
  };

  const S = {
    token: localStorage.getItem('mwPhoneToken') || '',
    hello: null,
    presets: {},
    library: { music: [], clips: [] },
    video: null,          // { path, info, playPath, stripUrl }
    range: null,          // { start, end } — the stretch of the video we work on
    texts: [],            // words laid over the picture — see the TEXT section
    clips: [],            // the shorts
    exports: [],          // finished files this session
    settings: Object.assign({}, DEFAULTS, readJson('mwPhoneSettings') || {}),
    jobs: new Map(),      // jobId -> onProgress
    activeJob: null,
    es: null,
    tab: 'Edit',
  };

  function readJson(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  const saveSettings = () => localStorage.setItem('mwPhoneSettings', JSON.stringify(S.settings));

  /* ═══════════════════════════ transport ═══════════════════════════ */

  const q = (p) => encodeURIComponent(p);
  /** A URL this phone can stream or download a PC-side file from. */
  const mediaUrl = (p) => `/api/media?p=${q(p)}&k=${q(S.token)}`;
  const fileUrl = (p) => `/api/file?p=${q(p)}&k=${q(S.token)}`;

  /** One RPC into the PC's Video Studio. Throws the studio's own error text. */
  async function rpc(channel, args) {
    const res = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
      body: JSON.stringify({ channel, args: args || {} }),
    });
    if (res.status === 401) { unpair('Pair this phone again.'); throw new Error('Not paired'); }
    let body;
    try { body = await res.json(); } catch (e) { throw new Error('The PC sent something unreadable.'); }
    if (body && body.ok) return body.data;
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    if (body && body.cancelled) err.cancelled = true;
    throw err;
  }

  const newJobId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /**
   * Run a long PC-side job behind the progress overlay. `fn(jobId)` must pass
   * that id through to the RPC so `job:cancel` can reach the ffmpeg underneath.
   */
  async function runJob(label, fn) {
    const jobId = newJobId();
    showOverlay(label, jobId);
    S.jobs.set(jobId, (pct) => setOverlay(pct));
    try {
      return await fn(jobId);
    } catch (e) {
      if (!e || !e.cancelled) toast('⚠️ ' + ((e && e.message) || 'That did not work.'), 'error', 6000);
      throw e;
    } finally {
      S.jobs.delete(jobId);
      hideOverlay();
    }
  }

  /* ── live progress from the PC ───────────────────────────────────────── */

  function connectEvents() {
    if (S.es) { try { S.es.close(); } catch (e) {} }
    const es = new EventSource(`/api/events?k=${q(S.token)}`);
    S.es = es;
    es.addEventListener('job:progress', (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      const cb = S.jobs.get(d.jobId);
      if (cb) cb(d.percent);
    });
    es.addEventListener('upload:progress', (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      showUpload(d.percent, d.name);
    });
    es.onerror = () => { /* EventSource retries by itself */ };
  }

  /* ═══════════════════════════ chrome ═══════════════════════════ */

  function toast(msg, kind, ms) {
    const n = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    $('toasts').appendChild(n);
    setTimeout(() => { n.style.opacity = '0'; setTimeout(() => n.remove(), 300); }, ms || 3800);
  }

  function showOverlay(label, jobId) {
    S.activeJob = jobId;
    $('ovLabel').textContent = label;
    setOverlay(0);
    $('overlay').classList.remove('hidden');
  }
  function setOverlay(pct) {
    const v = clamp(Math.round(pct || 0), 0, 100);
    $('ovFill').style.width = v + '%';
    $('ovPct').textContent = v + '%';
  }
  function hideOverlay() { S.activeJob = null; $('overlay').classList.add('hidden'); }

  function showTab(name) {
    S.tab = name;
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
    const scr = $('scr' + name);
    if (scr) scr.classList.add('active');
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === name);
    if (scr) scr.scrollTop = 0;
  }

  /** The bottom sheet — used for renaming, captions, and pick-one lists. */
  function sheet(title, buildBody, buttons) {
    $('sheetTitle').textContent = title;
    const body = $('sheetBody');
    body.innerHTML = '';
    buildBody(body);
    const foot = $('sheetFoot');
    foot.innerHTML = '';
    for (const b of buttons || []) {
      const n = el('button', b.primary ? 'primary' : 'ghost', b.label);
      n.onclick = () => { if (b.onClick() !== false) closeSheet(); };
      foot.appendChild(n);
    }
    $('sheet').classList.remove('hidden');
  }
  const closeSheet = () => $('sheet').classList.add('hidden');


  /* ═══════════════════════ text on the video ═══════════════════════
   *
   * The same thing the desktop studio calls "Add text": words placed on the
   * picture for a stretch of time. They are burned by the PC through the
   * overlays:burn channel, which renders them as subtitles rather than as
   * rasterised pictures — that matters here, because a phone has no way to
   * rasterise a font the PC will use, and asking it to would put the words in
   * a different place than the export.
   *
   * Placement is a 3x3 grid rather than free dragging: on a phone, dragging a
   * small box on a small preview is fiddly and imprecise, and nine positions
   * cover what a sermon clip actually needs (a title top-centre, a name lower
   * third, a verse in the middle).
   */
  const TEXT_SPOTS = [
    { id: 'tl', name: '↖', x: 0.20, y: 0.12 }, { id: 'tc', name: '↑', x: 0.50, y: 0.12 }, { id: 'tr', name: '↗', x: 0.80, y: 0.12 },
    { id: 'ml', name: '←', x: 0.20, y: 0.50 }, { id: 'mc', name: '•', x: 0.50, y: 0.50 }, { id: 'mr', name: '→', x: 0.80, y: 0.50 },
    { id: 'bl', name: '↙', x: 0.20, y: 0.86 }, { id: 'bc', name: '↓', x: 0.50, y: 0.86 }, { id: 'br', name: '↘', x: 0.80, y: 0.86 },
  ];
  const TEXT_SIZES = [['s', 'Small', 0.045], ['m', 'Medium', 0.065], ['l', 'Large', 0.09], ['xl', 'Huge', 0.12]];

  /** The overlays that fall inside [a, b], re-timed to a clip that starts at a. */
  function textsFor(a, b) {
    return (S.texts || [])
      .filter((t) => t.text && t.end > a + 0.02 && t.start < b - 0.02)
      .map((t) => ({
        text: t.text,
        start: Math.max(0, t.start - a),
        end: Math.min(b, t.end) - a,
        x: t.x, y: t.y, sizePct: t.sizePct, color: t.color, bg: !!t.bg,
        font: t.font || (S.settings.capFont || undefined),
      }));
  }

  /** Burn whatever text falls on this stretch onto a finished file. */
  async function burnTextOn(file, a, b, label) {
    const list = textsFor(a, b);
    if (!list.length) return file;
    return runJob(`🔤 Adding your text to “${label || 'the video'}”…`, (jobId) => rpc('overlays:burn', {
      input: file, overlays: list, jobId, deleteInput: true,
      outName: (label || 'text').replace(/[^\w.-]+/g, '_').slice(0, 40) + '-text',
    }));
  }

  function newText() {
    const at = ($("player").currentTime || 0);
    const d = durOf();
    return {
      id: 'x' + Math.random().toString(36).slice(2, 8),
      text: '', x: 0.5, y: 0.12, sizePct: 0.065, color: '#ffffff', bg: true,
      start: Math.max(0, at), end: Math.min(d, at + 4),
    };
  }

  function openTextSheet() {
    if (!S.video) return toast("Pick a video first.");
    sheet("🔤 Text on the video", (body) => {
      const list = el("div", "tx-list");
      const draw = () => {
        list.innerHTML = "";
        if (!S.texts.length) {
          const p = el("p", "muted", "No text yet. Add some and it is burned onto every clip you export.");
          list.appendChild(p);
        }
        S.texts.forEach((t, i) => {
          const card = el("div", "tx-card");
          const ta = el("textarea", "tx-text");
          ta.rows = 2; ta.placeholder = "Type the words…"; ta.value = t.text;
          ta.oninput = () => { t.text = ta.value; };
          card.appendChild(ta);

          const spots = el("div", "tx-grid");
          TEXT_SPOTS.forEach((sp) => {
            const b = el("button", "tx-spot" + (Math.abs(t.x - sp.x) < 0.01 && Math.abs(t.y - sp.y) < 0.01 ? " on" : ""), sp.name);
            b.onclick = () => { t.x = sp.x; t.y = sp.y; draw(); };
            spots.appendChild(b);
          });
          card.appendChild(spots);

          const row = el("div", "tx-row");
          const size = el("select", "tx-size");
          TEXT_SIZES.forEach(([id, name, pct]) => {
            const o = el("option", "", name); o.value = String(pct);
            if (Math.abs(pct - t.sizePct) < 0.001) o.selected = true;
            size.appendChild(o);
          });
          size.onchange = () => { t.sizePct = Number(size.value); };
          row.appendChild(size);

          const col = el("input", "tx-col"); col.type = "color"; col.value = t.color;
          col.oninput = () => { t.color = col.value; };
          row.appendChild(col);

          const bgWrap = el("label", "tx-bg");
          const bg = el("input", ""); bg.type = "checkbox"; bg.checked = !!t.bg;
          bg.onchange = () => { t.bg = bg.checked; };
          bgWrap.appendChild(bg); bgWrap.appendChild(document.createTextNode(" backing box"));
          row.appendChild(bgWrap);
          card.appendChild(row);

          const when = el("div", "tx-row");
          const setNow = el("button", "ghost small", "⤓ starts now");
          setNow.onclick = () => { const c = ($("player").currentTime || 0); t.end = Math.max(c + 1, t.end - t.start + c); t.start = c; draw(); };
          when.appendChild(setNow);
          const lenSel = el("select", "tx-size");
          [2, 3, 4, 6, 8, 12].forEach((n) => {
            const o = el("option", "", n + "s"); o.value = String(n);
            if (Math.abs((t.end - t.start) - n) < 0.6) o.selected = true;
            lenSel.appendChild(o);
          });
          lenSel.onchange = () => { t.end = t.start + Number(lenSel.value); draw(); };
          when.appendChild(lenSel);
          when.appendChild(el("span", "muted small", `from ${fmt(t.start)}`));
          const del = el("button", "ghost small", "🗑");
          del.onclick = () => { S.texts.splice(i, 1); draw(); };
          when.appendChild(del);
          card.appendChild(when);
          list.appendChild(card);
        });
      };
      draw();
      body.appendChild(list);
      const add = el("button", "ghost big", "➕ Add text");
      add.onclick = () => { S.texts.push(newText()); draw(); };
      body.appendChild(add);
    }, [
      { label: "Done", primary: true, onClick: () => { S.texts = S.texts.filter((t) => t.text && t.text.trim()); return true; } },
    ]);
  }
  /* ═══════════════════════════ pairing ═══════════════════════════ */

  async function hello() {
    const res = await fetch('/api/hello', { headers: S.token ? { Authorization: 'Bearer ' + S.token } : {} });
    return res.json();
  }

  async function pair() {
    const pin = ($('pinInput').value || '').trim();
    const msg = $('pairMsg');
    msg.className = 'pair-msg';
    msg.textContent = 'Pairing…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const body = await res.json();
      if (!res.ok || !body.token) { msg.className = 'pair-msg bad'; msg.textContent = body.error || 'Could not pair.'; return; }
      S.token = body.token;
      localStorage.setItem('mwPhoneToken', S.token);
      msg.className = 'pair-msg good';
      msg.textContent = 'Paired.';
      enterApp();
    } catch (e) {
      msg.className = 'pair-msg bad';
      msg.textContent = 'Could not reach the PC. Is it still on and on this wifi?';
    }
  }

  function unpair(note) {
    S.token = '';
    localStorage.removeItem('mwPhoneToken');
    if (S.es) { try { S.es.close(); } catch (e) {} S.es = null; }
    $('tabs').classList.add('hidden');
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
    $('scrPair').classList.add('active');
    $('pairMsg').textContent = note || '';
  }

  /* ═══════════════════════════ library ═══════════════════════════ */

  async function loadLibrary() {
    const list = $('libList');
    list.innerHTML = '';
    let groups = [];
    try {
      const res = await fetch('/api/videos', { headers: { Authorization: 'Bearer ' + S.token } });
      const body = await res.json();
      groups = (body && body.groups) || [];
    } catch (e) { toast('Could not read the PC’s video folders.', 'error'); return; }

    let any = false;
    for (const g of groups) {
      if (!g.files.length) continue;
      any = true;
      const wrap = el('div', 'grp');
      wrap.appendChild(el('div', 'grp-title', g.label));
      for (const f of g.files.slice(0, 60)) {
        const row = el('button', 'file');
        const th = el('div', 'file-thumb');
        row.appendChild(th);
        const name = el('div', 'file-name');
        name.appendChild(el('b', null, f.name));
        name.appendChild(el('span', 'muted small', `${mb(f.size)} · ${new Date(f.mtime).toLocaleDateString()}`));
        row.appendChild(name);
        row.onclick = () => openVideo(f.path);
        wrap.appendChild(row);
        // Thumbnails are cheap but not free; fetch them after the list is up.
        thumb(f.path, 3).then((u) => { if (u) th.style.backgroundImage = `url("${u}")`; }).catch(() => {});
      }
      list.appendChild(wrap);
    }
    if (!any) list.appendChild(el('p', 'muted', 'No videos found yet. Send one from this phone, or drop one in the PC’s Videos folder.'));
  }

  const thumbCache = new Map();
  async function thumb(path, t) {
    const key = path + '@' + t;
    if (thumbCache.has(key)) return thumbCache.get(key);
    const p = rpc('video:thumbnail', { input: path, timeSec: t }).then((out) => mediaUrl(out)).catch(() => '');
    thumbCache.set(key, p);
    return p;
  }

  function showUpload(pct, name) {
    const bar = $('uploadBar');
    bar.classList.remove('hidden');
    $('uploadFill').style.width = clamp(pct, 0, 100) + '%';
    $('uploadTxt').textContent = `${name || 'Sending'} — ${clamp(Math.round(pct), 0, 100)}%`;
    if (pct >= 100) setTimeout(() => bar.classList.add('hidden'), 1500);
  }

  /**
   * Send a video from the camera roll to the PC. XHR rather than fetch because
   * only XHR reports UPLOAD progress, and a 2 GB service over wifi with no
   * progress bar feels broken long before it finishes.
   */
  function uploadFile(file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload?name=${q(file.name)}`);
      xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) showUpload((e.loaded / e.total) * 100, file.name); };
      xhr.onload = () => {
        let body; try { body = JSON.parse(xhr.responseText); } catch (e) { body = null; }
        if (xhr.status === 200 && body && body.path) { showUpload(100, file.name); resolve(body); }
        else reject(new Error((body && body.error) || 'Upload failed.'));
      };
      xhr.onerror = () => reject(new Error('Upload failed — check the wifi.'));
      xhr.send(file);
    });
  }

  /* ═══════════════════════════ opening a video ═══════════════════════════ */

  async function openVideo(path) {
    let info;
    try { info = await rpc('video:info', { input: path }); }
    catch (e) { return toast('Could not read that video: ' + e.message, 'error', 6000); }
    if (!info.durationSec) return toast('That file has no playable video.', 'error');

    S.video = { path, info, playPath: path, stripUrl: '' };
    S.range = { start: 0, end: info.durationSec };
    S.texts = [];   // a different recording is a different set of words
    S.clips = [];
    renderClips();

    $('edName').textContent = baseName(path);
    $('edEmpty').classList.add('hidden');
    $('edBody').classList.remove('hidden');
    $('playerNote').classList.add('hidden');

    const p = $('player');
    p.src = mediaUrl(path);
    p.load();
    $('tDur').textContent = fmt(info.durationSec);
    drawRange();
    showTab('Edit');

    loadStrip(path);
    toast(`${baseName(path)} — ${fmt(info.durationSec)}, ${info.width}×${info.height}`, 'good');
  }

  async function loadStrip(path) {
    try {
      const out = await rpc('video:filmstrip', { input: path, count: 26 });
      if (!S.video || S.video.path !== path) return;
      S.video.stripUrl = mediaUrl(out);
      $('stripImg').style.backgroundImage = `url("${S.video.stripUrl}")`;
    } catch (e) { /* the strip is decoration; the scrubber works without it */ }
  }

  /**
   * Some recordings a PC plays happily (MKV, AVI, exotic codecs) a phone will
   * not touch. Rather than guess from the codec name, we let the phone TRY and
   * only build a preview proxy when it actually refuses — the same makeProxy
   * the desktop uses, so nothing new has to be maintained.
   */
  async function makePlayable() {
    if (!S.video || S.video.proxying) return;
    S.video.proxying = true;
    const note = $('playerNote');
    note.classList.remove('hidden');
    note.textContent = '📱 This phone can’t play that file directly — building a preview on the PC…';
    try {
      const proxy = await runJob('📱 Building a preview this phone can play…',
        (jobId) => rpc('video:makeProxy', { input: S.video.path, jobId }));
      S.video.playPath = proxy;
      const p = $('player');
      p.src = mediaUrl(proxy);
      p.load();
      note.textContent = '📱 Playing a preview. Exports still use the original at full quality.';
    } catch (e) {
      note.textContent = '⚠️ Could not build a preview. You can still cut and export — you just can’t watch it here.';
    } finally { S.video.proxying = false; }
  }

  /* ═══════════════════════════ scrub strip + trim ═══════════════════════════ */

  function stripW() { return $('strip').getBoundingClientRect().width || 1; }
  const durOf = () => (S.video ? S.video.info.durationSec : 0) || 1;
  const t2x = (t) => (clamp(t, 0, durOf()) / durOf()) * stripW();
  const x2t = (x) => clamp(x / stripW(), 0, 1) * durOf();

  function drawRange() {
    if (!S.video) return;
    const a = t2x(S.range.start), b = t2x(S.range.end), w = stripW();
    $('dimL').style.width = a + 'px';
    $('dimR').style.width = Math.max(0, w - b) + 'px';
    $('handL').style.left = a + 'px';
    $('handR').style.left = b + 'px';
    const whole = S.range.start <= 0.01 && S.range.end >= durOf() - 0.01;
    $('rangeLabel').textContent = whole
      ? 'Whole video'
      : `Working on ${fmt(S.range.start)} – ${fmt(S.range.end)}  (${fmt(S.range.end - S.range.start)})`;
  }

  function wireStrip() {
    const strip = $('strip');
    let drag = null;   // 'l' | 'r' | 'seek'

    const posOf = (ev) => {
      const r = strip.getBoundingClientRect();
      const cx = (ev.touches && ev.touches[0] ? ev.touches[0].clientX : ev.clientX);
      return clamp(cx - r.left, 0, r.width);
    };

    const down = (ev) => {
      if (!S.video) return;
      const x = posOf(ev);
      const dl = Math.abs(x - t2x(S.range.start)), dr = Math.abs(x - t2x(S.range.end));
      drag = (Math.min(dl, dr) <= 26) ? (dl <= dr ? 'l' : 'r') : 'seek';
      move(ev);
      ev.preventDefault();
    };
    const move = (ev) => {
      if (!drag || !S.video) return;
      const t = x2t(posOf(ev));
      if (drag === 'l') S.range.start = Math.min(t, S.range.end - 1);
      else if (drag === 'r') S.range.end = Math.max(t, S.range.start + 1);
      else { $('player').currentTime = t; }
      if (drag !== 'seek') { $('player').currentTime = t; drawRange(); }
      updatePlayhead();
      ev.preventDefault();
    };
    const up = () => { drag = null; };

    strip.addEventListener('touchstart', down, { passive: false });
    strip.addEventListener('touchmove', move, { passive: false });
    strip.addEventListener('touchend', up);
    strip.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('resize', () => { drawRange(); updatePlayhead(); });
  }

  function updatePlayhead() {
    if (!S.video) return;
    const p = $('player');
    $('playhead').style.left = t2x(p.currentTime || 0) + 'px';
    $('tCur').textContent = fmt(p.currentTime || 0);
  }

  /* ═══════════════════════════ finding the shorts ═══════════════════════════ */

  const lenParams = () => {
    const v = S.settings.len;
    if (v === 'auto') return { minLen: 45, idealLen: 90, maxLen: 150, autoLen: true };
    const n = parseInt(v, 10) || 60;
    return { minLen: Math.round(n * 0.6), idealLen: n, maxLen: Math.round(n * 1.6), autoLen: false };
  };

  async function findHighlights() {
    if (!S.video) return;
    const whole = S.range.start <= 0.01 && S.range.end >= durOf() - 0.01;
    let p = lenParams();
    const keptSec = S.range.end - S.range.start;
    // Same accommodation the desktop makes: a short recording can't hold
    // 90-second clips, so ✨Auto scales its band to the footage rather than
    // coming back empty-handed.
    if (p.autoLen && keptSec < p.minLen * 4) {
      const ideal = clamp(Math.round(keptSec / 4), 15, p.idealLen);
      p = { minLen: Math.max(8, Math.round(ideal * 0.55)), idealLen: ideal, maxLen: Math.max(24, Math.round(ideal * 1.7)), autoLen: true };
    }
    const fit = Math.floor(keptSec / ((p.idealLen || 50) + 8));
    const maxClips = clamp(Math.min(20, fit), 3, 20);
    const deep = !!S.settings.deep;
    const label = deep
      ? '🧠 Reading the sermon for its key points… (first run is the slow one — the transcript is cached)'
      : '🤖 Finding the best moments…';

    let res;
    try {
      res = await runJob(label, (jobId) => rpc('sermon:analyze', {
        input: S.video.path, minLen: p.minLen, maxLen: p.maxLen, idealLen: p.idealLen,
        autoLen: !!p.autoLen, deep, maxClips, jobId,
        startSec: whole ? 0 : S.range.start, endSec: whole ? 0 : S.range.end,
        ranges: whole ? null : [[S.range.start, S.range.end]],
      }));
    } catch (e) { return; }

    if (!res.clips || !res.clips.length) {
      return toast(whole ? 'No standout moments found.' : 'No standout moments inside that stretch — widen the trim.', 'error', 6000);
    }
    S.clips = res.clips.map((c, i) => ({
      id: 'c' + i + '_' + Date.now().toString(36),
      start: c.start, end: c.end, label: c.label || `Key moment ${i + 1}`,
      quote: c.quote, virality: c.virality, reasons: c.reasons, rank: c.rank || i + 1,
      cuts: null, caps: null, thumb: '',
    }));
    renderClips();
    showTab('Shorts');
    toast(`✨ Found ${S.clips.length} clip${S.clips.length > 1 ? 's' : ''}. Review, then export.`, 'good', 5000);

    if (S.settings.pauses) await removePauses(S.clips, { quiet: false });
  }

  /** The kept stretches of a clip once its pauses are cut out. */
  function keptPieces(c) {
    const out = []; let t = c.start;
    for (const cut of (c.cuts || [])) {
      const a = Math.max(c.start, cut.start), b = Math.min(c.end, cut.end);
      if (b <= a) continue;
      if (a > t) out.push({ start: t, end: a });
      t = Math.max(t, b);
    }
    if (t < c.end) out.push({ start: t, end: c.end });
    return out;
  }
  const cutSecs = (c) => (c.cuts || []).reduce((a, x) => a + (x.end - x.start), 0);

  async function removePauses(clips, { quiet } = {}) {
    let touched = 0, removed = 0;
    for (const c of clips) {
      let res;
      try {
        res = await runJob(`🤫 Listening for pauses in “${c.label}”…`, (jobId) => rpc('video:detectSilence', {
          input: S.video.path, startSec: c.start, endSec: c.end,
          noiseDb: -32, minSilenceSec: 0.7, padSec: 0.12, jobId,
        }));
      } catch (e) { if (e && e.cancelled) break; continue; }
      // Under a quarter-second is punctuation, not a pause — cutting those makes
      // the speech sound clipped.
      const cuts = ((res && res.silences) || []).filter((x) => x.end - x.start >= 0.25);
      if (!cuts.length) continue;
      c.cuts = cuts;
      touched++; removed += cuts.reduce((a, x) => a + (x.end - x.start), 0);
    }
    renderClips();
    if (!quiet) {
      toast(touched
        ? `🤫 Took ${removed.toFixed(1)}s of dead air out of ${touched} clip${touched > 1 ? 's' : ''}.`
        : 'No long pauses found — those clips were already tight.', 'good', 5500);
    }
    return { touched, removed };
  }

  /* ═══════════════════════════ the shorts list ═══════════════════════════ */

  function renderClips() {
    const list = $('shortsList');
    list.innerHTML = '';
    $('shortsEmpty').classList.toggle('hidden', S.clips.length > 0);
    $('btnExportAll').disabled = !S.clips.length;
    const badge = $('shortsBadge');
    badge.textContent = String(S.clips.length);
    badge.classList.toggle('hidden', !S.clips.length);
    if (!S.clips.length) return;

    const best = S.clips.reduce((a, b) => ((b.virality || 0) > (a.virality || 0) ? b : a), S.clips[0]);

    for (const c of S.clips) {
      const card = el('div', 'clip' + (c === best ? ' top' : ''));
      const main = el('div', 'clip-main');

      const th = el('div', 'clip-thumb');
      if (c.thumb) th.style.backgroundImage = `url("${c.thumb}")`;
      else thumb(S.video.path, Math.min(c.start + 1.5, c.end - 0.2)).then((u) => { if (u) { c.thumb = u; th.style.backgroundImage = `url("${u}")`; } }).catch(() => {});
      th.appendChild(el('span', 'clip-rank', '#' + c.rank));
      main.appendChild(th);

      const info = el('div', 'clip-info');
      info.appendChild(el('div', 'clip-title', c.label));
      info.appendChild(el('div', 'muted small', `${fmt(c.start)} – ${fmt(c.end)}  ·  ${fmt(c.end - c.start)}`));
      if (c.quote) info.appendChild(el('div', 'clip-quote', '“' + c.quote + '”'));
      const meta = el('div', 'clip-meta');
      if (c === best) meta.appendChild(el('span', 'tag hot', '🔥 Top pick'));
      if (c.virality) meta.appendChild(el('span', 'tag', `${c.virality}% viral score`));
      if (c.cuts && c.cuts.length) meta.appendChild(el('span', 'tag cut', `🤫 ${cutSecs(c).toFixed(1)}s cut`));
      if (c.caps && c.caps.length) meta.appendChild(el('span', 'tag cap', `💬 ${c.caps.length} lines`));
      info.appendChild(meta);
      main.appendChild(info);
      card.appendChild(main);

      const acts = el('div', 'clip-actions');
      acts.appendChild(btn('▶', 'Preview', () => previewClip(c)));
      acts.appendChild(btn('✏️', 'Rename', () => renameClip(c)));
      acts.appendChild(btn('💬', 'Captions', () => captionClip(c)));
      acts.appendChild(btn('⬇️', 'Export', () => exportClip(c)));
      acts.appendChild(btn('🗑', 'Delete', () => {
        S.clips = S.clips.filter((x) => x !== c);
        renderClips();
      }));
      card.appendChild(acts);
      list.appendChild(card);
    }
  }

  function btn(glyph, title, onClick) {
    const b = el('button', null, glyph);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = onClick;
    return b;
  }

  function previewClip(c) {
    if (!S.video) return;
    showTab('Edit');
    const p = $('player');
    p.currentTime = c.start;
    p.play().catch(() => {});
    // Stop at the clip's end so "preview" means the clip, not the rest of the sermon.
    const stop = () => { if (p.currentTime >= c.end) { p.pause(); p.removeEventListener('timeupdate', stop); } };
    p.addEventListener('timeupdate', stop);
  }

  function renameClip(c) {
    sheet('Rename clip', (body) => {
      const inp = el('input');
      inp.type = 'text';
      inp.value = c.label;
      inp.id = 'renameInput';
      body.appendChild(inp);
      setTimeout(() => inp.focus(), 60);
    }, [
      { label: 'Cancel', onClick: () => true },
      { label: 'Save', primary: true, onClick: () => {
        const v = ($('renameInput').value || '').trim();
        if (v) { c.label = v; renderClips(); }
        return true;
      } },
    ]);
  }

  /* ═══════════════════════════ captions ═══════════════════════════ */

  /* The same twelve looks the desktop caption picker offers, in the same order,
   * so a short captioned on a phone is indistinguishable from one captioned at
   * the PC. They translate into the three ASS primitives the burner supports. */
  const CAP_STYLES = [
    { id: 'clean', name: 'Clean', style: 'shadow', color: '#ffffff' },
    { id: 'outline', name: 'Outline', style: 'outline', color: '#ffffff', outline: '#000000' },
    { id: 'pop', name: 'Pop', style: 'outline', color: '#ffffff', outline: '#000000', outlineScale: 1.7 },
    { id: 'sunshine', name: 'Sunshine', style: 'outline', color: '#ffe14d', outline: '#000000', outlineScale: 1.4 },
    { id: 'neon', name: 'Neon', style: 'outline', color: '#2ff3ff', outline: '#062a33', outlineScale: 1.5 },
    { id: 'mint', name: 'Mint', style: 'outline', color: '#57ff9b', outline: '#04331b', outlineScale: 1.4 },
    { id: 'candy', name: 'Candy', style: 'outline', color: '#ff77d4', outline: '#2c0722', outlineScale: 1.4 },
    { id: 'fire', name: 'Fire', style: 'outline', color: '#ff8b34', outline: '#2b0e00', outlineScale: 1.4 },
    { id: 'band', name: 'Band', style: 'box', color: '#ffffff', outline: '#000000' },
    { id: 'highlight', name: 'Highlight', style: 'box', color: '#000000', outline: '#ffe14d' },
    { id: 'royal', name: 'Royal', style: 'box', color: '#ffffff', outline: '#7b3ff2' },
    { id: 'preach', name: 'Preach', style: 'box', color: '#ffffff', outline: '#c1121f' },
  ];
  const capStyleDef = () => CAP_STYLES.find((s) => s.id === S.settings.capStyle) || CAP_STYLES[1];

  function capOpts() {
    const d = capStyleDef();
    return {
      font: S.settings.capFont, sizeKey: S.settings.capSize, position: S.settings.capPos,
      transition: S.settings.capTrans || 'pop',
      color: d.color, outline: d.outline || '#000000', style: d.style,
      outlineScale: d.outlineScale || 1, styleId: d.id,
    };
  }

  /* Punctuation earns nothing on a burned caption — a line holds three words for
   * a second and a half and the line break IS the pause. Identical rule to the
   * desktop's cleanCapText, so the two produce the same words. */
  function cleanCapText(t) {
    return String(t)
      .replace(/[’ʼ]/g, "'")
      .replace(/["“”„‟«»‹›″＂‘]/g, '')
      .replace(/[?？¿]/g, '')
      .replace(/[…⋯]/g, ' ')
      .replace(/[.,。．，、]/g, (m, i, s) => (/\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '') ? m : ''))
      .replace(/\s+/g, ' ')
      .trim();
  }
  function transformCase(t, c) {
    if (c === 'upper') return t.toUpperCase();
    if (c === 'lower') return t.toLowerCase();
    if (c === 'title') return t.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    return t;
  }
  function groupWords(words, wordsPerLine, textCase) {
    const events = [];
    const push = (g) => {
      if (!g.length) return;
      const text = cleanCapText(transformCase(g.map((x) => x.text).join(' '), textCase));
      if (text) events.push({ start: g[0].start, end: g[g.length - 1].end, text });
    };
    if (wordsPerLine === 'auto') {
      let cur = [];
      for (const w of words) { cur.push(w); if (cur.length >= 6 || /[.?!,]$/.test(w.text)) { push(cur); cur = []; } }
      push(cur);
    } else {
      const n = Math.max(1, parseInt(wordsPerLine, 10) || 3);
      for (let i = 0; i < words.length; i += n) push(words.slice(i, i + n));
    }
    return events;
  }

  /**
   * Transcribe ONE clip's range and open its words for editing. Whisper's word
   * times come back clip-relative, which is exactly what the burn needs, so the
   * captions line up with the exported short without any offset arithmetic.
   */
  async function captionClip(c) {
    const engineOk = await rpc('captions:available').catch(() => false);
    if (!engineOk) {
      const info = await rpc('captions:engineInfo').catch(() => null);
      return toast('💬 ' + ((info && (info.reason || info.howTo)) || 'Speech-to-text isn’t available in this build.'), 'error', 9000);
    }
    if (!c.words) {
      let res;
      try {
        res = await runJob(`💬 Listening to “${c.label}”…`, (jobId) => rpc('captions:transcribe', {
          input: S.video.path, startSec: c.start, endSec: c.end, jobId,
        }));
      } catch (e) { return; }
      c.words = res.words || [];
      if (!c.words.length) return toast('No speech found in that clip.', 'error');
    }
    c.caps = groupWords(c.words, S.settings.capWords, S.settings.capCase);
    openCaptionSheet(c);
  }

  function openCaptionSheet(c) {
    sheet(`Captions — ${c.label}`, (body) => {
      const styles = el('div', 'style-grid');
      for (const st of CAP_STYLES) {
        const card = el('div', 'style-card' + (st.id === S.settings.capStyle ? ' sel' : ''), st.name);
        card.style.color = st.color;
        if (st.style === 'box') { card.style.background = st.outline; }
        else if (st.style === 'outline') { card.style.webkitTextStroke = '1px ' + st.outline; }
        else { card.style.textShadow = '0 2px 6px #000'; }
        card.onclick = () => {
          S.settings.capStyle = st.id; saveSettings();
          for (const n of styles.children) n.classList.remove('sel');
          card.classList.add('sel');
        };
        styles.appendChild(card);
      }
      body.appendChild(el('div', 'muted small', 'Pick a look, then fix any word the AI misheard.'));
      body.appendChild(styles);

      const lines = el('div');
      lines.style.display = 'flex';
      lines.style.flexDirection = 'column';
      lines.style.gap = '8px';
      c.caps.forEach((ev, i) => {
        const row = el('div', 'cap-line');
        row.appendChild(el('span', 'cap-time', fmt(ev.start)));
        const inp = el('input');
        inp.type = 'text';
        inp.value = ev.text;
        inp.oninput = () => { c.caps[i].text = inp.value; };
        row.appendChild(inp);
        lines.appendChild(row);
      });
      body.appendChild(lines);
    }, [
      { label: 'Remove captions', onClick: () => { c.caps = null; renderClips(); return true; } },
      { label: 'Keep', primary: true, onClick: () => { renderClips(); toast('💬 Captions saved — they burn on when you export this clip.', 'good', 5000); return true; } },
    ]);
  }

  /* ═══════════════════════════ exporting ═══════════════════════════ */

  const fillCfg = () => (S.settings.fill === 'crop' ? null : { mode: S.settings.fill });
  const denoiseCfg = () => (S.settings.denoise || null);
  const reframeOn = () => !!S.settings.reframe && S.settings.fill === 'crop';

  /**
   * Face-tracking keyframes for one clip — the identical pipeline the desktop
   * runs: the PC samples frames at 6fps (with scene-cut events so the crop
   * SNAPS at camera changes instead of gliding across them), this browser runs
   * MediaPipe over them, and the resulting pan path goes back to ffmpeg.
   */
  async function computeKeyframes(c, input, ss, ee, pieces) {
    if (!window.FaceTrack) return [];
    window.MW_AI_BASE = location.origin + '/ai/';
    let ok = false;
    try { ok = await window.FaceTrack.available(); } catch (e) { ok = false; }
    if (!ok) { toast('🎯 Speaker tracking couldn’t load on this phone — exporting a centred crop instead.', 'error', 7000); return []; }

    let res;
    // `pairs` gets a second still a frame after each sample, which is what the
    // tracker measures mouth movement across — the cue that tells the person
    // preaching from the person standing beside them. The phone runs the same
    // tracker as the desktop, so it asks for the same evidence.
    try { res = await rpc('video:extractFrames', { input, startSec: ss, endSec: ee, fps: 6, pieces, pairs: true }); }
    catch (e) { return []; }
    const frames = ((res && res.frames) || []).map((f) => ({
      t: f.t, url: mediaUrl(f.path), pairUrl: f.pairPath ? mediaUrl(f.pairPath) : null,
    }));
    if (!frames.length) return [];
    let dets = [];
    try { dets = await window.FaceTrack.detectFrames(frames, { cuts: (res && res.cuts) || [], onProg: (p) => setOverlay(p * 100) }); }
    catch (e) { dets = []; }
    if (res.dir) rpc('fs:rmdir', { dir: res.dir }).catch(() => {});
    if (!dets.length) return [];
    const preset = S.presets[S.settings.aspect] || { w: 9, h: 16 };
    return window.FaceTrack.buildKeyframes(dets, S.video.info.width, S.video.info.height,
      { targetAR: preset.w / preset.h, cuts: (res && res.cuts) || [] });
  }

  /** One short, framed and rendered — mirrors the desktop's exportOneClip. */
  async function renderClip(c) {
    const preset = S.settings.aspect;
    const input = S.video.path;
    let ss = c.start, ee = c.end, pieces = null;
    if (c.cuts && c.cuts.length) {
      pieces = keptPieces(c);
      ss = pieces[0].start; ee = pieces[pieces.length - 1].end;
    }
    const fill = fillCfg(), denoise = denoiseCfg();
    const fadeIn = Number(S.settings.fadeIn) || 0, fadeOut = Number(S.settings.fadeOut) || 0;
    const gaps = pieces ? ` — ${c.cuts.length} gap${c.cuts.length > 1 ? 's' : ''} closed` : '';

    if (reframeOn()) {
      const keyframes = await runJob(`🎯 Tracking the speaker in “${c.label}”…`, () => computeKeyframes(c, input, ss, ee, pieces));
      if (keyframes && keyframes.length) {
        return runJob(`Exporting “${c.label}” (following the speaker)${gaps}…`, (jobId) => rpc('sermon:exportReframed', {
          input, startSec: ss, endSec: ee, preset, keyframes, pieces, fill, denoise, fadeIn, fadeOut, label: c.label, jobId,
        }));
      }
      // No usable track (no faces, or MediaPipe unavailable) — a centred crop is
      // still a correct short, so the export continues rather than failing.
    }
    const how = fill ? (fill.mode === 'blur' ? ' (blurred background)' : ' (letterboxed)') : '';
    return runJob(`Exporting “${c.label}”${how}${gaps}…`, (jobId) => rpc('sermon:exportShort', {
      input, startSec: ss, endSec: ee, preset, pieces, fill, denoise, fadeIn, fadeOut, label: c.label, jobId,
    }));
  }

  /** Captions, then music, then the outro — each step replaces the file before it. */
  async function finishFile(c, file) {
    let out = file;
    // Words the operator put on the video, re-timed to THIS clip and burned in
    // before captions/music/outro — the same order the desktop studio uses, so
    // a clip made on the phone and one made on the PC look the same.
    try { out = await burnTextOn(out, c.start, c.end, c.label); } catch (e) { /* text is optional */ }
    const wantCaps = (c.caps && c.caps.length) || (S.settings.capAuto && !c.caps);
    if (wantCaps) {
      const engineOk = await rpc('captions:available').catch(() => false);
      if (engineOk) {
        let events = c.caps;
        if (!events) {
          try {
            const res = await runJob(`💬 Captioning “${c.label}”…`, (jobId) => rpc('captions:transcribe', { input: out, jobId }));
            events = groupWords(res.words || [], S.settings.capWords, S.settings.capCase);
          } catch (e) { events = null; }
        }
        if (events && events.length) {
          out = await runJob(`💬 Adding captions to “${c.label}”…`, (jobId) => rpc('captions:burn', {
            input: out, events, opts: capOpts(), jobId, outName: c.label, deleteInput: true,
          }));
        }
      }
    }
    // Library entries carry the copied-in file as `.file` (see library.js).
    const music = S.library.music.find((m) => m.id === S.settings.musicId);
    if (music) {
      out = await runJob(`🎵 Laying music under “${c.label}”…`, (jobId) => rpc('video:mixMusic', {
        input: out, musicPath: music.file, musicVolume: Number(S.settings.musicVol) || 0.25,
        jobId, outName: c.label, deleteInput: true,
      }));
    }
    const outro = S.library.clips.find((m) => m.id === S.settings.outroId);
    if (outro) {
      out = await runJob(`🎬 Adding your outro to “${c.label}”…`, (jobId) => rpc('video:appendClips', {
        input: out, clips: [{ path: outro.file }], position: 'end', jobId, outName: c.label, deleteInput: true,
      }));
    }
    return out;
  }

  function addExport(path) {
    S.exports.unshift({ path, name: baseName(path), at: Date.now() });
    renderExports();
  }

  async function exportClip(c) {
    try {
      let out = await renderClip(c);
      out = await finishFile(c, out);
      addExport(out);
      toast('✅ Exported. Open the Finished tab to save it to this phone.', 'good', 6000);
      showTab('Done');
    } catch (e) { /* runJob already said why */ }
  }

  async function exportAll() {
    let done = 0;
    for (const c of S.clips) {
      try {
        let out = await renderClip(c);
        out = await finishFile(c, out);
        addExport(out);
        done++;
      } catch (e) { break; }
    }
    if (done) { toast(`✅ Exported ${done} short${done > 1 ? 's' : ''}.`, 'good', 6000); showTab('Done'); }
  }

  /** "Export just this trim" — the recording's own shape, not a social crop. */
  async function exportTrim() {
    if (!S.video) return;
    try {
      const name = baseName(S.video.path).replace(/\.[^.]+$/, '') + '-edited';
      const out = await runJob(`💾 Saving ${fmt(S.range.end - S.range.start)} of video…`, (jobId) => rpc('sermon:exportShort', {
        input: S.video.path, startSec: S.range.start, endSec: S.range.end,
        preset: 'source', denoise: denoiseCfg(),
        fadeIn: Number(S.settings.fadeIn) || 0, fadeOut: Number(S.settings.fadeOut) || 0,
        label: name, jobId,
      }));
      const withText = await burnTextOn(out, S.range.start, S.range.end, name).catch(() => out);
      addExport(withText);
      toast('✅ Saved. Open the Finished tab to get it onto this phone.', 'good', 6000);
      showTab('Done');
    } catch (e) {}
  }

  function renderExports() {
    const list = $('doneList');
    list.innerHTML = '';
    if (!S.exports.length) {
      list.appendChild(el('p', 'muted', 'Nothing exported yet in this session. Anything you export lands here — and in the PC’s output folder.'));
      return;
    }
    for (const f of S.exports) {
      const row = el('div', 'done-row');
      const th = el('div', 'file-thumb');
      row.appendChild(th);
      thumb(f.path, 1).then((u) => { if (u) th.style.backgroundImage = `url("${u}")`; }).catch(() => {});
      const name = el('div', 'file-name');
      name.appendChild(el('b', null, f.name));
      name.appendChild(el('span', 'muted small', new Date(f.at).toLocaleTimeString()));
      row.appendChild(name);
      const a = document.createElement('a');
      a.className = 'dl';
      a.href = fileUrl(f.path);
      a.download = f.name;
      a.textContent = '⬇️ Save';
      row.appendChild(a);
      list.appendChild(row);
    }
  }

  /* ═══════════════════════════ more tools ═══════════════════════════ */

  async function runTool(tool) {
    if (!S.video) return;
    const input = S.video.path;
    try {
      if (tool === 'proxy') {
        S.video.proxying = false;
        return makePlayable();
      }
      if (tool === 'audio') {
        const out = await runJob('🎧 Extracting the audio…', (jobId) => rpc('video:extractAudio', { input, jobId }));
        addExport(out); toast('✅ Audio saved.', 'good'); return showTab('Done');
      }
      if (tool === 'autotrim') {
        const out = await runJob('🤫 Taking the silences out…', (jobId) => rpc('video:autoTrim', { input, jobId }));
        addExport(out); toast('✅ Done.', 'good'); return showTab('Done');
      }
      if (tool === 'stabilize') {
        const out = await runJob('🎚 Stabilising (two passes — this one takes a while)…', (jobId) => rpc('video:stabilize', { input, jobId }));
        addExport(out); toast('✅ Stabilised.', 'good'); return showTab('Done');
      }
      if (tool === 'reshape') {
        const out = await runJob('📐 Reshaping for social…', (jobId) => rpc('video:export', {
          input, preset: S.settings.aspect, fill: fillCfg(), denoise: denoiseCfg(), jobId,
        }));
        addExport(out); toast('✅ Reshaped.', 'good'); return showTab('Done');
      }
      if (tool === 'captions') {
        const engineOk = await rpc('captions:available').catch(() => false);
        if (!engineOk) return toast('💬 Speech-to-text isn’t available in this build.', 'error', 6000);
        const res = await runJob('💬 Listening to the whole video (this is the long one)…',
          (jobId) => rpc('captions:transcribe', { input, jobId }));
        const events = groupWords(res.words || [], S.settings.capWords, S.settings.capCase);
        if (!events.length) return toast('No speech found.', 'error');
        const out = await runJob('💬 Burning the captions on…', (jobId) => rpc('captions:burn', {
          input, events, opts: capOpts(), jobId, outName: baseName(input).replace(/\.[^.]+$/, ''),
        }));
        addExport(out); toast('✅ Captioned.', 'good'); return showTab('Done');
      }
    } catch (e) { /* reported */ }
  }

  /* ═══════════════════════════ settings screen ═══════════════════════════ */

  function bindSetting(id, key, { number, bool, onChange } = {}) {
    const n = $(id);
    if (!n) return;
    if (bool) n.checked = !!S.settings[key];
    else n.value = S.settings[key];
    n.addEventListener('change', () => {
      S.settings[key] = bool ? n.checked : (number ? Number(n.value) : n.value);
      saveSettings();
      if (onChange) onChange();
    });
  }

  async function loadPresets() {
    try {
      S.presets = await rpc('video:presets');
      const sel = $('optAspect');
      sel.innerHTML = '';
      for (const [id, p] of Object.entries(S.presets)) {
        const o = el('option', null, p.label);
        o.value = id;
        sel.appendChild(o);
      }
      sel.value = S.settings.aspect;
    } catch (e) {}
  }

  async function loadFonts() {
    const sel = $('setCapFont');
    let fonts = ['Bebas Neue', 'Anton', 'Poppins', 'Bangers', 'Arial'];
    try { const f = await rpc('captions:fonts'); if (f && f.length) fonts = f; } catch (e) {}
    sel.innerHTML = '';
    for (const f of fonts) { const o = el('option', null, f); o.value = f; sel.appendChild(o); }
    sel.value = S.settings.capFont;
    // Anything the PC knows about is offered here too, so a clip captioned on
    // the phone can use the same typefaces as one captioned at the desk.
    if (!sel.options.length || sel.options.length < 6) {
      rpc('captions:fonts').then((list) => {
        if (!Array.isArray(list) || !list.length) return;
        sel.innerHTML = list.map((f) => `<option value="${f}">${f}</option>`).join('');
        sel.value = list.includes(S.settings.capFont) ? S.settings.capFont : list[0];
      }).catch(() => {});
    }
  }

  function fillStyleSelect() {
    const sel = $('setCapStyle');
    sel.innerHTML = '';
    for (const s of CAP_STYLES) { const o = el('option', null, s.name); o.value = s.id; sel.appendChild(o); }
    sel.value = S.settings.capStyle;
  }

  async function loadMediaLibrary() {
    try {
      const lib = await rpc('library:list');
      S.library.music = (lib && lib.music) || [];
      S.library.clips = (lib && lib.clips) || [];
    } catch (e) { S.library = { music: [], clips: [] }; }
    const fill = (sel, items, none, current) => {
      sel.innerHTML = '';
      const o0 = el('option', null, none); o0.value = ''; sel.appendChild(o0);
      for (const it of items) { const o = el('option', null, it.name || baseName(it.file)); o.value = it.id; sel.appendChild(o); }
      sel.value = items.some((i) => i.id === current) ? current : '';
    };
    fill($('setMusic'), S.library.music, 'None', S.settings.musicId);
    fill($('setOutro'), S.library.clips, 'None', S.settings.outroId);
  }

  async function loadEngineNote() {
    try {
      const info = await rpc('captions:engineInfo');
      $('setEngine').textContent = info && info.available
        ? '💬 Speech-to-text: ready on the PC'
        : '💬 Speech-to-text: ' + ((info && info.reason) || 'not available in this build');
    } catch (e) {}
  }

  /* ═══════════════════════════ wiring ═══════════════════════════ */

  function wire() {
    $('pairBtn').onclick = pair;
    $('pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(); });

    for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showTab(b.dataset.tab);

    $('libRefresh').onclick = loadLibrary;
    $('edGoLib').onclick = () => showTab('Library');
    $('edChange').onclick = () => showTab('Library');
    $('doneRefresh').onclick = renderExports;

    $('uploadInput').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const res = await uploadFile(f);
        toast('⬆️ Sent to the PC.', 'good');
        await loadLibrary();
        openVideo(res.path);
      } catch (err) { toast('⚠️ ' + err.message, 'error', 6000); }
    });

    // player
    const p = $('player');
    const setPlayGlyph = () => {
      const glyph = p.paused ? '▶' : '⏸';
      $('btnPlay').textContent = glyph;
      $('bigPlay').classList.toggle('hidden', !p.paused);
    };
    $('btnPlay').onclick = () => (p.paused ? p.play().catch(() => {}) : p.pause());
    $('bigPlay').onclick = () => p.play().catch(() => {});
    $('btnBack10').onclick = () => { p.currentTime = Math.max(0, p.currentTime - 10); };
    $('btnFwd10').onclick = () => { p.currentTime = Math.min(durOf(), p.currentTime + 10); };
    $('btnLoopRange').onclick = () => { p.currentTime = S.range.start; p.play().catch(() => {}); };
    p.addEventListener('play', setPlayGlyph);
    p.addEventListener('pause', setPlayGlyph);
    p.addEventListener('timeupdate', updatePlayhead);
    p.addEventListener('loadedmetadata', () => { drawRange(); updatePlayhead(); });
    p.addEventListener('error', () => { if (S.video && S.video.playPath === S.video.path) makePlayable(); });

    $('btnResetRange').onclick = () => { if (S.video) { S.range = { start: 0, end: durOf() }; drawRange(); } };
    $('btnText').onclick = openTextSheet;
  $('btnFind').onclick = findHighlights;
    $('btnExportTrim').onclick = exportTrim;
    $('btnExportAll').onclick = exportAll;
    for (const b of document.querySelectorAll('.tool-grid button')) b.onclick = () => runTool(b.dataset.tool);

    $('ovCancel').onclick = () => { if (S.activeJob) rpc('job:cancel', { id: S.activeJob }).catch(() => {}); };
    $('sheetClose').onclick = closeSheet;
    $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

    // options that live on the editor screen mirror the settings store
    bindSetting('optLen', 'len');
    bindSetting('optAspect', 'aspect');
    bindSetting('optDeep', 'deep', { bool: true });
    bindSetting('optPauses', 'pauses', { bool: true });
    bindSetting('optReframe', 'reframe', { bool: true });
    bindSetting('setFill', 'fill');
    bindSetting('setDenoise', 'denoise');
    bindSetting('setFadeIn', 'fadeIn', { number: true });
    bindSetting('setFadeOut', 'fadeOut', { number: true });
    bindSetting('setCapAuto', 'capAuto', { bool: true });
    bindSetting('setCapStyle', 'capStyle');
    bindSetting('setCapFont', 'capFont');
    bindSetting('setCapTrans', 'capTrans');
    bindSetting('setCapSize', 'capSize');
    bindSetting('setCapPos', 'capPos');
    bindSetting('setCapWords', 'capWords');
    bindSetting('setCapCase', 'capCase');
    bindSetting('setMusic', 'musicId');
    bindSetting('setMusicVol', 'musicVol', { number: true });
    bindSetting('setOutro', 'outroId');

    $('btnUnpair').onclick = () => unpair('Unpaired. Enter the PIN to connect again.');

    wireStrip();
  }

  /* ═══════════════════════════ boot ═══════════════════════════ */

  async function enterApp() {
    $('scrPair').classList.remove('active');
    $('tabs').classList.remove('hidden');
    showTab('Edit');
    connectEvents();
    fillStyleSelect();
    await Promise.all([loadPresets(), loadFonts(), loadMediaLibrary(), loadLibrary(), loadEngineNote()]);
    renderExports();
    renderClips();
    $('setHost').textContent = location.host;
    $('setVer').textContent = 'Workstation ' + ((S.hello && S.hello.version) || '');
    if (!S.video) showTab('Library');
  }

  async function boot() {
    wire();
    let info = null;
    try { info = await hello(); } catch (e) {}
    S.hello = info;
    $('pairHost').textContent = info ? `${info.name} at ${location.host}` : `Could not reach a workstation at ${location.host}`;
    if (info && info.paired) enterApp();
    else { unpair(''); $('pinInput').focus(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Handy from a desktop browser while developing, and the hook the test uses.
  window.__phone = { S, rpc, openVideo, findHighlights, renderClips, groupWords, cleanCapText, keptPieces, showTab };
})();
