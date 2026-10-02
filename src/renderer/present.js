'use strict';
/*
 * Church Work Space — Presentation Studio (ProPresenter-style).
 *
 * The shape of the thing, and why:
 *
 *   LIBRARY / PLAYLIST rail  — a church has a library of songs and readings that
 *     outlives any one service, and a playlist that IS this Sunday. Same split
 *     ProPresenter and EasyWorship use, because it matches how a service is run.
 *
 *   SLIDE GRID  — every slide as a real miniature of what goes on the wall,
 *     grouped and colour-tagged (Verse 1 / Chorus / Bridge / Tag). The colours
 *     are the whole point: mid-song the operator finds "Chorus" by colour in a
 *     glance, not by reading.
 *
 *   LIVE / NEXT monitors  — what is on the projector right now, and what one
 *     more click will put there. Nothing goes to the congregation without the
 *     operator having seen it first.
 *
 * Two rules run through all of it:
 *   1. Clicking a slide sends it LIVE immediately (that's what an operator
 *      expects mid-service); editing happens in Edit mode where clicks select.
 *   2. Anything that touches the projector goes through one `live()` call, so
 *      the on-screen preview and the actual output physically cannot diverge.
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => 'p' + Math.random().toString(36).slice(2, 9);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const attr = (s) => esc(s).replace(/"/g, '&quot;');

  /* Group colours — the same vocabulary worship teams already use. */
  const GROUPS = [
    { name: 'Verse 1', color: '#1f6feb' }, { name: 'Verse 2', color: '#1f6feb' }, { name: 'Verse 3', color: '#1f6feb' },
    { name: 'Chorus', color: '#e5534b' }, { name: 'Pre-Chorus', color: '#db61a2' },
    { name: 'Bridge', color: '#a371f7' }, { name: 'Tag', color: '#e5534b' },
    { name: 'Intro', color: '#0aa2c0' }, { name: 'Outro', color: '#0aa2c0' },
    { name: 'Scripture', color: '#c9a227' }, { name: 'Blank', color: '#5a6478' },
  ];
  /*
   * Sections can be named anything now, so this answers for names that were
   * never in the list above.
   *
   * Three steps, in order of confidence. An exact match keeps the colours a
   * worship team already reads. Failing that, a name that CONTAINS a known
   * word takes that word's colour — rename "Verse 1" to "Verse 4" and it stays
   * blue, which is the whole point of the colour. Only a genuinely new word
   * ("Communion", "Response") gets a colour of its own, picked by hashing the
   * name so that it is stable: the same section is the same colour every time
   * the page renders, and on every machine that opens the file.
   */
  const CUSTOM_HUES = ['#3f8f4f', '#c9622a', '#7a5cd6', '#0f8b8d', '#b5417a', '#8a7320'];
  const groupColor = (name) => {
    const n = String(name == null ? '' : name).trim();
    if (!n) return '#5a6478';
    const exact = GROUPS.find((g) => g.name.toLowerCase() === n.toLowerCase());
    if (exact) return exact.color;
    /* Whole words only. A plain `includes` matched "Stage" against "Tag" and
     * painted a stage-notes section red. Longest first, so "Pre-Chorus" is not
     * swallowed by "Chorus". */
    const kw = GROUPS.slice().sort((a, b) => b.name.length - a.name.length)
      .find((g) => g.name !== 'Blank'
        && new RegExp('\\b' + g.name.toLowerCase().split(' ')[0] + '\\b', 'i').test(n));
    if (kw) return kw.color;
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return CUSTOM_HUES[h % CUSTOM_HUES.length];
  };

  const DEFAULT_LOOKS = [
    {
      id: 'look-dark', name: 'Dark',
      font: 'Poppins', sizePx: 96, color: '#ffffff', bold: true, align: 'center', valign: 'center',
      shadow: 0.55, outline: 0, lineHeight: 1.2,
      bg: { type: 'color', value: '#07090f', dim: 0 }, showFooter: true, footerColor: '#ffd479',
    },
    {
      id: 'look-royal', name: 'Royal',
      font: 'Poppins', sizePx: 92, color: '#ffffff', bold: true, align: 'center', valign: 'center',
      shadow: 0.6, outline: 0, lineHeight: 1.22,
      bg: { type: 'gradient', value: 'linear-gradient(160deg,#1b1042 0%,#2d1b69 45%,#0b0720 100%)', dim: 0 },
      showFooter: true, footerColor: '#ffd479',
    },
    {
      id: 'look-dawn', name: 'Dawn',
      font: 'Bebas Neue', sizePx: 108, color: '#fff8ec', bold: false, align: 'center', valign: 'center',
      shadow: 0.65, outline: 0, lineHeight: 1.12,
      bg: { type: 'gradient', value: 'linear-gradient(180deg,#2a1206 0%,#7a3410 55%,#c9701f 100%)', dim: 0.1 },
      showFooter: true, footerColor: '#ffe6b0',
    },
    {
      id: 'look-clean', name: 'Clean white',
      font: 'Poppins', sizePx: 88, color: '#10131a', bold: true, align: 'center', valign: 'center',
      shadow: 0, outline: 0, lineHeight: 1.24,
      bg: { type: 'color', value: '#f6f7fb', dim: 0 }, showFooter: true, footerColor: '#7a5a12',
    },
  ];

  /* ---------------------------- stage layouts ----------------------------
   * A confidence monitor is not one thing. The worship leader wants big words
   * and the chords; the preacher wants the notes and a countdown he can see
   * from the back; the director wants a multiviewer of every screen. So the
   * stage display is a GRID OF BLOCKS described as data, and the operator picks
   * which arrangement each monitor is showing — the output window just draws
   * whatever list of blocks it is handed. */
  const STAGE_BLOCKS = [
    { type: 'header', label: 'Header + clock' },
    { type: 'current', label: 'Current slide' },
    { type: 'next', label: 'Next slide' },
    { type: 'notes', label: 'Notes + stage message' },
    { type: 'clock', label: 'Big clock' },
    { type: 'timer', label: 'Big timer' },
    { type: 'multiview', label: 'Multiviewer' },
  ];
  const DEFAULT_STAGE_LAYOUTS = [
    {
      id: 'stage-lyrics', name: 'Lyrics + Next', cols: '1.7fr 1fr', rows: 'auto 1fr auto',
      blocks: [
        { type: 'header', area: '1 / 1 / 2 / 3' },
        { type: 'current', area: '2 / 1 / 3 / 2' },
        { type: 'next', area: '2 / 2 / 3 / 3' },
        { type: 'notes', area: '3 / 1 / 4 / 3' },
      ],
    },
    {
      // A musician reads chords over words and nothing else — no notes column
      // stealing width from the thing they are actually playing from.
      id: 'stage-band', name: 'Musician (chords)', cols: '1fr', rows: 'auto 1fr auto',
      blocks: [
        { type: 'header', area: '1 / 1 / 2 / 2' },
        { type: 'current', area: '2 / 1 / 3 / 2', chords: true },
        { type: 'next', area: '3 / 1 / 4 / 2' },
      ],
    },
    {
      id: 'stage-preacher', name: 'Preacher (notes + timer)', cols: '1.4fr 1fr', rows: 'auto 1fr 1fr',
      blocks: [
        { type: 'header', area: '1 / 1 / 2 / 3' },
        { type: 'current', area: '2 / 1 / 3 / 2', chords: false },
        { type: 'timer', area: '2 / 2 / 4 / 3' },
        { type: 'notes', area: '3 / 1 / 4 / 2' },
      ],
    },
    {
      id: 'stage-director', name: 'Director (multiviewer)', cols: '1fr 1.2fr', rows: 'auto 1fr auto',
      blocks: [
        { type: 'header', area: '1 / 1 / 2 / 3' },
        { type: 'current', area: '2 / 1 / 3 / 2' },
        { type: 'multiview', area: '2 / 2 / 3 / 3' },
        { type: 'notes', area: '3 / 1 / 4 / 3' },
      ],
    },
    { id: 'stage-clock', name: 'Countdown only', cols: '1fr', rows: 'auto 1fr', blocks: [{ type: 'header', area: '1 / 1 / 2 / 2' }, { type: 'timer', area: '2 / 1 / 3 / 2' }] },
  ];

  const pv = {
    inited: false,
    mode: 'show',              // 'show' = clicking a slide goes live; 'edit' = clicking selects
    tab: 'bible',
    presentations: [],
    playlists: [],
    looks: [],
    lookId: 'look-royal',
    docId: null,               // open presentation
    slideIx: -1,               // selected slide
    liveIx: -1,                // what is actually on the projector
    liveDocId: null,
    outputs: { audience: false, stage: false, displays: [], suggested: '' },
    displayId: '',
    translation: 'kjv',
    catalogue: [],
    bibleResult: null,
    // 🎤 Listen: the microphone, and what it has already acted on
    // 'mics' are what Windows has; 'ndi' are the feeds on the network (see
    // ndi-listen.js). 'ndiRx' is the live receiver while Listen is running.
    /* `follow` is "turn the page when the speaker finishes reading the verse"
     * (see followReading). `tape` is the stitched transcript it judges against
     * — overlapping look-backs welded into one continuous reading — and
     * `tape.used` marks the words that have already turned a page, so the same
     * reading cannot advance two or three verses at once. `close` is the fast
     * local look-back that runs only while somebody is demonstrably mid-verse. */
    listen: { ear: null, busy: false, closeBusy: false, queue: [], lastSig: '', lastAt: 0, acted: 0, dropped: 0, micId: '', micLabel: '', mics: [], unlocking: null, fast: true, quote: false, quoteReady: false, follow: false, readKey: '',
      tape: { words: [], stems: [], used: 0, at: 0 }, close: false, closeWant: false, closeAt: 0, closeLooks: 0, lastRead: null,
      /* '' = automatic (the ladder in voicelisten: climbs to Small, never
       * picks Medium or Turbo on its own because neither keeps up live). */
      model: '', modelNote: '',
      /* The cloud ear's state, as main last reported it. The key itself never
       * comes back to the page — only whether there IS one. */
      cloud: null, cadence: null, viaCloud: 0, viaLocal: 0, lastVia: '', lastWarn: '', fuelTimer: null,
      ndi: [], ndiOk: false, ndiWhy: '', ndiRx: null },
    // The songs the church sings, as opposed to what is in this service.
    bank: { songs: [], themes: [], chip: 'all', loaded: false },
    media: [],                 // background images/videos (from the shared library + ad-hoc)
    outMode: 'black',
    thumbSize: 200,
    settings: {},

    /* ---- the seven-layer live state (see layers.js) ----
     * Held here, in the studio, because the studio is the only thing that
     * decides; the outputs just draw whatever this becomes. */
    layers: { background: null, media: null, mask: null },
    props: [],            // persistent logos / lower thirds
    announcement: null,   // stays up across slide changes
    message: null,        // timed pop-up
    stageMessage: '',     // private note to the stage display only
    timers: [],
    cleared: { background: false, media: false, slide: false, announcement: false, props: false, messages: false, mask: false },
    transitions: { background: 'dissolve', media: 'dissolve', slide: 'dissolve', announcement: 'dissolve', props: 'dissolve', messages: 'dissolve', mask: 'cut' },
    blackout: false,
    easyView: false,
    outputLooks: {},      // outputId -> Look id, so each screen can style the same cue differently
    outputMaps: {},       // outputId -> display map (rotate / scale / offset / edge blend)
    outputList: [],       // open outputs reported by main
    stageLayoutId: 'stage-lyrics',
    stageLayouts: [],     // what each confidence monitor is arranged to show
    ndi: null,            // NDI output state from main
    audio: { tracks: [], master: 1, playlistOn: true, shuffle: false, loopList: true },
    bgCat: 'All',         // which ready-made background category is showing
    bgApply: 'slide',     // …and whether a click lands on this slide, all slides, or the Look
    arrangement: null,    // active arrangement name for the open song
    macros: [],           // one-click multi-step actions
    midi: null, midiBinds: {},
    drawing: false, maskBeforeDraw: null,
    web: null,            // web-output server state
  };

  /* ============================ ask() ============================
   * Chromium — and therefore Electron — does not implement window.prompt():
   * calling it throws "prompt() is and will not be supported." and takes the
   * rest of the click handler with it. Seventeen buttons in this studio were
   * built on it, and every one of them did nothing at all: new playlist, new
   * arrangement, name a Look, name a macro, lower-third text, timers, custom
   * outputs, MIDI binds, playback markers. The button was not broken in each
   * case — the same missing function was.
   *
   * So: one small in-app dialog, returning a Promise of the string or null,
   * the shape prompt() had. Keyboard-first, because the alternative is an
   * operator hunting for a mouse while the service waits — Enter accepts,
   * Escape cancels.
   */
  function ask(message, initial, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'pv-ask-back';
      back.innerHTML =
        `<div class="pv-ask" role="dialog" aria-modal="true">
           <p class="pv-ask-msg">${esc(message).replace(/\n/g, '<br>')}</p>
           <input type="text" class="pv-ask-input" value="${attr(initial == null ? '' : initial)}" />
           <div class="pv-ask-btns">
             <button class="pv-ask-cancel">Cancel</button>
             <button class="pv-ask-ok">${attr(o.okLabel || 'OK')}</button>
           </div>
         </div>`;
      document.body.appendChild(back);
      const input = back.querySelector('.pv-ask-input');
      let done = false;
      const close = (v) => {
        if (done) return;              // Enter fires click AND keydown; only the first wins
        done = true;
        back.remove();
        resolve(v);
      };
      back.querySelector('.pv-ask-ok').addEventListener('click', () => close(input.value));
      back.querySelector('.pv-ask-cancel').addEventListener('click', () => close(null));
      back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
      /* Captured, because the studio binds space/arrows/1-7 on document to cue
       * the projector. Typing "Bridge" into this box must not black the screen. */
      back.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
      });
      input.focus(); input.select();
    });
  }

  const doc = () => pv.presentations.find((p) => p.id === pv.docId) || null;
  const slides = () => (doc() || {}).slides || [];
  const look = () => pv.looks.find((l) => l.id === pv.lookId) || pv.looks[0] || DEFAULT_LOOKS[1];
  const lookFor = (s) => Object.assign({}, look(), (s && s.look) || null);

  /* ============================ persistence ============================ */
  async function loadLibrary() {
    let lib = { presentations: [], playlists: [], themes: [] };
    try { lib = await window.api.present.library(); } catch (e) {}
    pv.presentations = lib.presentations || [];
    pv.playlists = lib.playlists || [];
    pv.looks = (lib.themes && lib.themes.length) ? lib.themes : DEFAULT_LOOKS.slice();
    if (!pv.looks.some((l) => l.id === pv.lookId)) pv.lookId = pv.looks[0].id;
    if (!pv.playlists.length) pv.playlists = [{ id: uid(), name: 'This Sunday', items: [] }];
    if (!pv.presentations.length) seedExample();
    if (!pv.docId) pv.docId = pv.presentations[0] && pv.presentations[0].id;
    pv.playlistId = pv.playlists[0].id;
  }
  /* ------------------------- writing to disk -------------------------
   *
   * Every one of these ends, in the main process, in the whole library being
   * serialised and written to a file. That is the right thing to do when an
   * edit is finished and the wrong thing to do while it is being made: a
   * keystroke in the slide editor and a drag of a size slider each fired one,
   * so typing a chorus line wrote the library thirty-three times and dragging a
   * slider wrote it twenty-six times in a second — with the main process, which
   * every window shares, blocked inside each write.
   *
   * So writes are held for a moment and coalesced. The delay is short enough to
   * be invisible and long enough to turn a burst into one write. Nothing is
   * risked by it: `flushSaves()` runs whenever an edit is finished (the editor
   * closes, another song is opened, something is cued) and unconditionally when
   * the window is closing, so what reaches the disk is the same as before.
   */
  const SAVE_DEBOUNCE_MS = 400;
  const _dirtyDocs = new Map();
  const _dirtyPlaylists = new Map();
  let _looksDirty = false;
  let _saveTimer = null;

  function flushSaves() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    if (_dirtyDocs.size) {
      const docs = Array.from(_dirtyDocs.values());
      _dirtyDocs.clear();
      for (const d of docs) window.api.present.savePresentation(d).catch(() => {});
    }
    if (_dirtyPlaylists.size) {
      const pls = Array.from(_dirtyPlaylists.values());
      _dirtyPlaylists.clear();
      for (const pl of pls) window.api.present.savePlaylist(pl).catch(() => {});
    }
    if (_looksDirty) { _looksDirty = false; window.api.present.saveThemes(pv.looks).catch(() => {}); }
  }
  const queueSave = () => {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => { _saveTimer = null; flushSaves(); }, SAVE_DEBOUNCE_MS);
  };
  const saveDoc = (d) => { if (!d || !d.id) return; _dirtyDocs.set(d.id, d); queueSave(); };
  const saveLooks = () => { _looksDirty = true; queueSave(); };
  const savePlaylist = (pl) => { if (!pl || !pl.id) return; _dirtyPlaylists.set(pl.id, pl); queueSave(); };
  // A service that is being closed down, or a machine being shut off, must not
  // lose the last thing that was typed.
  window.addEventListener('beforeunload', () => { try { stopListening(); } catch (e) {} });
  window.addEventListener('beforeunload', flushSaves);
  window.addEventListener('pagehide', flushSaves);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaves(); });

  /** A first-run presentation so the studio is never an empty grey box. */
  function seedExample() {
    const d = {
      id: uid(), name: 'Welcome', kind: 'custom', lookId: 'look-royal', updated: Date.now(),
      slides: [
        mkSlide('Blank', ['Welcome home']),
        mkSlide('Blank', ['We’re glad', 'you’re here']),
        mkSlide('Scripture', ['This is the day the LORD has made;', 'let us rejoice and be glad in it.'], 'Psalm 118:24'),
      ],
    };
    pv.presentations = [d];
    saveDoc(d);
  }
  function mkSlide(group, lines, footer) {
    return { id: uid(), group: group || 'Blank', lines: lines || [''], footer: footer || '', notes: '', bg: null, look: null };
  }

  /* ============================ left rail ============================ */
  function renderLibrary() {
    const filter = (($('#pvLibFilter') || {}).value || '').toLowerCase();
    const list = pv.presentations.filter((p) => !filter || String(p.name).toLowerCase().includes(filter));
    const el = $('#pvLibList');
    el.innerHTML = list.length ? list.map((p) => `
      <button class="pv-item${p.id === pv.docId ? ' sel' : ''}" data-doc="${attr(p.id)}" title="${attr(p.name)}">
        <span class="pv-item-icon">${p.kind === 'scripture' ? '📖' : p.kind === 'song' ? '🎵' : '📄'}</span>
        <span class="pv-item-name">${esc(p.name)}</span>
        <span class="pv-item-n">${(p.slides || []).length}</span>
      </button>`).join('')
      : '<p class="muted small pv-empty">Nothing yet — press ＋ to start a song or reading.</p>';
    $$('[data-doc]', el).forEach((b) => b.addEventListener('click', () => openDoc(b.dataset.doc)));
    $$('[data-doc]', el).forEach((b) => b.addEventListener('contextmenu', (e) => { e.preventDefault(); deleteDoc(b.dataset.doc); }));
  }
  /* Rename in place: swap an <input> over the label, commit on Enter or blur.
   * Used by the group bars, the playlists and the playlist entries — three
   * places where a modal for a two-word change would be heavier than the edit
   * itself. Returns nothing; `onCommit` gets the trimmed text. */
  function inlineRename(labelEl, current, onCommit) {
    if (!labelEl || labelEl.querySelector('input')) return;
    const prev = labelEl.textContent;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'pv-rename'; input.value = current == null ? prev : current;
    labelEl.textContent = '';
    labelEl.appendChild(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      // The label is put back either way. It used to be restored only on
      // cancel, on the assumption that a re-render would replace the whole bar
      // on commit — which is true only while every render rebuilds everything.
      // Leave it to that and a committed rename leaves its input box open.
      labelEl.textContent = (save && v) ? v : prev;
      if (save && v) onCommit(v);
    };
    input.addEventListener('blur', () => finish(true));
    // The studio cues the projector from document-level keys. An operator
    // typing "Chorus" must not black the screen on the "b".
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  /*
   * RENAMING AND DELETING HAVE TO BE VISIBLE.
   *
   * Both have always worked — double-click renames, right-click deletes — and
   * both were advertised only in a `title` tooltip, which is to say not at all.
   * An operator with a playlist called "Sunday 10/08/202" (an import's
   * auto-name, truncated) had no way to see that it could be changed.
   *
   * So each row carries a pencil and a bin that appear on hover. They are
   * <span>s, not <button>s, because the row itself is a <button> and nesting
   * one inside another is invalid HTML that Chromium silently restructures.
   * The keyboard/tooltip paths are unchanged, so nothing that worked stops.
   */
  const rowActs = (kind, id, what) =>
    `<span class="pv-acts">` +
      `<span class="pv-act" role="button" tabindex="-1" data-${kind}rename="${attr(id)}"` +
        ` title="Rename this ${what}">✏️</span>` +
      `<span class="pv-act pv-act-del" role="button" tabindex="-1" data-${kind}del="${attr(id)}"` +
        ` title="${kind === 'pl' ? 'Delete this playlist' : 'Remove this from the service'}">🗑</span>` +
    `</span>`;

  function renderPlaylists() {
    const el = $('#pvPlaylists');
    el.innerHTML = pv.playlists.map((p) => `
      <button class="pv-item pv-item-sm${p.id === pv.playlistId ? ' sel' : ''}" data-pl="${attr(p.id)}"
              title="${attr(p.name)} — double-click to rename, right-click to delete">
        <span class="pv-item-icon">📋</span><span class="pv-item-name">${esc(p.name)}</span>
        <span class="pv-item-n">${(p.items || []).length}</span>
        ${rowActs('pl', p.id, 'playlist')}
      </button>`).join('');
    $$('[data-pl]', el).forEach((b) => {
      const pl = pv.playlists.find((p) => p.id === b.dataset.pl);
      const startRename = () => {
        if (!pl) return;
        inlineRename(b.querySelector('.pv-item-name'), pl.name, (v) => {
          pl.name = v; savePlaylist(pl); renderPlaylists(); renderPlaylistItems();
        });
      };
      b.addEventListener('click', () => { pv.playlistId = b.dataset.pl; renderPlaylists(); renderPlaylistItems(); });
      b.addEventListener('dblclick', (e) => { e.preventDefault(); startRename(); });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); deletePlaylist(b.dataset.pl); });
      // The icons must not also select or open the row underneath them.
      const act = (sel, fn) => {
        const n = b.querySelector(sel); if (!n) return;
        n.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
        n.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); });
      };
      act('[data-plrename]', () => { pv.playlistId = b.dataset.pl; renderPlaylists(); renderPlaylistItems(); startRenameOn(b.dataset.pl); });
      act('[data-pldel]', () => deletePlaylist(b.dataset.pl));
    });
    const cur = pv.playlists.find((p) => p.id === pv.playlistId);
    $('#pvPlName').textContent = cur ? cur.name : 'Service';
  }
  /** Re-find the row after a re-render and put the caret in it. */
  function startRenameOn(id) {
    const b = $(`#pvPlaylists [data-pl="${cssEsc(id)}"]`);
    const pl = pv.playlists.find((p) => p.id === id);
    if (!b || !pl) return;
    inlineRename(b.querySelector('.pv-item-name'), pl.name, (v) => {
      pl.name = v; savePlaylist(pl); renderPlaylists(); renderPlaylistItems();
    });
  }
  /** Ids are generated here (uid()), but an attribute selector still has to be
   *  safe against whatever a future id scheme allows. */
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));
  /** Deleting the last playlist would leave the rail with no way to make one,
   *  so the last one is emptied rather than removed. */
  function deletePlaylist(id) {
    const pl = pv.playlists.find((p) => p.id === id); if (!pl) return;
    if (!window.confirm(`Delete the playlist "${pl.name}"? The songs themselves stay in the Library.`)) return;
    if (pv.playlists.length === 1) {
      pl.items = []; savePlaylist(pl);
    } else {
      pv.playlists = pv.playlists.filter((p) => p.id !== id);
      _dirtyPlaylists.delete(id);      // don't let a queued save resurrect it
      flushSaves();
      window.api.present.deletePlaylist(id).catch(() => {});
      if (pv.playlistId === id) pv.playlistId = pv.playlists[0].id;
    }
    renderPlaylists(); renderPlaylistItems();
  }
  function renderPlaylistItems() {
    const pl = pv.playlists.find((p) => p.id === pv.playlistId);
    const el = $('#pvPlItems');
    const items = (pl && pl.items) || [];
    /* Sets are read as HEADINGS, not as a flat list.
     *
     * A service is "praise and worship, then thanksgiving, then offering" —
     * three blocks the operator's eye jumps between — and a run of twenty
     * numbered rows hides exactly that. The heading is drawn once when the set
     * changes, so an unset playlist looks precisely as it always did. */
    let lastGroup = null;
    el.innerHTML = items.length ? items.map((it, i) => {
      const d = pv.presentations.find((p) => p.id === it.presentationId);
      const g = it.group || '';
      const bar = g !== lastGroup && g
        ? `<div class="pv-plset" title="Set">${esc(g)}</div>` : '';
      lastGroup = g;
      // A song with nothing typed in it yet has to be findable at a glance —
      // that is the whole point of importing the names first.
      const empty = d && !(d.slides || []).some((s) => (s.lines || []).some((l) => String(l).trim()));
      /* An entry's own name wins over the presentation's.
       *
       * The same song can sit in a service twice — "Worship 1" before the
       * notices and "Response" after the sermon — and both entries point at
       * ONE presentation. Renaming used to go straight to that presentation,
       * so both rows changed at once and the operator saw the rename appear
       * in a place they had not touched. The label lives on the entry now. */
      const label = it.name || (d ? d.name : '(missing)');
      /* The "no words yet" badge used to be a pencil, sitting exactly where a
       * rename button belongs — a pencil that could not be clicked. Now that
       * the row has a REAL pencil on hover, this one says what it means. */
      return bar + `<button class="pv-item${d && d.id === pv.docId ? ' sel' : ''}${empty ? ' nolyrics' : ''}" data-plitem="${i}"
                title="${attr(label)}${empty ? ' — no words yet: open it and paste them' : ''} — double-click to rename this entry, right-click to remove">
        <span class="pv-item-icon">${i + 1}.</span>
        <span class="pv-item-name">${esc(label)}</span>
        ${empty ? '<span class="pv-item-todo" title="No words yet — open it and paste them in">no words</span>' : ''}
        ${rowActs('it', i, 'entry')}
      </button>`;
    }).join('') : '<p class="muted small pv-empty">Add the songs and readings for this service, in order — or press <b>📥 Import</b> and paste your set list.</p>';
    $$('[data-plitem]', el).forEach((b) => {
      const i = +b.dataset.plitem;
      b.addEventListener('click', () => { const it = items[i]; if (it) openDoc(it.presentationId); });
      b.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const it = items[i]; if (!it) return;
        const d = pv.presentations.find((p) => p.id === it.presentationId);
        inlineRename(b.querySelector('.pv-item-name'), it.name || (d ? d.name : ''), (v) => {
          it.name = v; savePlaylist(pl); renderPlaylistItems();
        });
      });
      const removeEntry = () => {
        const it = items[i]; if (!it) return;
        pl.items.splice(i, 1); savePlaylist(pl); renderPlaylists(); renderPlaylistItems();
      };
      const startRename = () => {
        const it = items[i]; if (!it) return;
        const d = pv.presentations.find((p) => p.id === it.presentationId);
        inlineRename(b.querySelector('.pv-item-name'), it.name || (d ? d.name : ''), (v) => {
          it.name = v; savePlaylist(pl); renderPlaylistItems();
        });
      };
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); removeEntry(); });
      const act = (sel, fn) => {
        const n = b.querySelector(sel); if (!n) return;
        n.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
        n.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); });
      };
      act('[data-itrename]', startRename);
      act('[data-itdel]', removeEntry);
    });
    // The bank ticks the songs that are already in this service, so it has to
    // hear about the service changing. Only while the tab is actually showing:
    // this runs on every playlist edit.
    if (pv.tab === 'songs' && pv.bank.loaded) renderBankSoon();
  }

  /* ============================ slide grid ============================ */
  /* ------------------- controls that fire while you hold them -------------------
   *
   * A Look slider sends an event per mouse-move — about sixty a second — and a
   * Look change is the one edit that really does invalidate every thumbnail at
   * once, so each of those events asked for all eighty to be repainted. The
   * grid could not keep up and the window stopped answering while the operator
   * dragged.
   *
   * What the operator is watching during a drag is the Live and Next monitors,
   * and those stay immediate. The grid is asked for "soon" instead: repeated
   * requests collapse into one, and it catches up a moment after the slider
   * settles. Anything that needs the grid to be correct right now — a test
   * reading it, an edit finishing — calls flushGrid().
   */
  let _gridTimer = null;
  let _suppressGrid = 0;
  function renderSlidesSoon(delay = 110) {
    if (_gridTimer) clearTimeout(_gridTimer);
    _gridTimer = setTimeout(() => { _gridTimer = null; renderSlides(); }, delay);
  }
  function flushGrid() {
    if (!_gridTimer) return;
    clearTimeout(_gridTimer); _gridTimer = null;
    renderSlides();
  }

  function renderSlides() {
    // A cue made in the middle of a drag re-renders too; hold it with the rest.
    if (_suppressGrid) { renderSlidesSoon(); return; }
    const el = $('#pvSlides');
    const d = doc();
    if (!d) { el.__pvShape = null; el.innerHTML = '<p class="muted pv-empty">Pick something from the library, or press ＋ New.</p>'; return; }
    /*
     * A song imported by name and not yet written.
     *
     * The half of the workflow that would otherwise be missing: the operator
     * imported forty titles on Tuesday and comes back on Saturday with the
     * words. Sending them to 📋 Paste songs would make a SECOND song with the
     * same name, so the box lives here, on the song itself, and fills THIS one.
     */
    const blank = (d.slides || []).length <= 1 && !(d.slides || []).some((s) => (s.lines || []).some((l) => String(l).trim()));
    if (blank) {
      $('#pvDocName').value = d.name || '';
      $('#pvDocMeta').textContent = 'no words yet';
      // The lyric box is a different grid shape; the next real render must not
      // mistake the leftover cards for its own.
      if (el.__pvShape === '__blank__' + d.id) return;   // already showing, don't steal the caret
      el.__pvShape = '__blank__' + d.id;
      el.innerHTML =
        `<div class="pv-nolyrics">
           <b>“${esc(d.name || 'This song')}” has no words yet.</b>
           <span class="muted small">Paste them in and the slides build themselves. A blank line starts a new slide;
             write <b>Chorus</b> or <b>Verse 2</b> on its own line to tag a section.</span>
           <textarea id="pvFillLyrics" spellcheck="false" placeholder="Verse 1
Amazing grace, how sweet the sound
That saved a wretch like me

Chorus
How sweet the sound"></textarea>
           <div class="pv-nolyrics-row">
             <label>Lines per slide <input type="number" id="pvFillMax" value="4" min="1" max="12" /></label>
             <button id="pvFillGo" class="primary-btn small" disabled>Add the words</button>
           </div>
         </div>`;
      const ta = $('#pvFillLyrics'), go = $('#pvFillGo'), mx = $('#pvFillMax');
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      ta.addEventListener('input', () => { go.disabled = !ta.value.trim(); });
      go.addEventListener('click', () => {
        // Parsed with the song's OWN name forced, so a first lyric line is never
        // mistaken for a title and the song does not quietly rename itself.
        const parsed = parseSongs('\n' + ta.value, { maxLines: +mx.value || 4, titleFromFirstLine: false });
        const s = parsed[0];
        if (!s || !s.slides.length) { window.__toast && window.__toast('No words found in that.', 'error'); return; }
        d.slides = s.slides.map((x) => mkSlide(x.group, x.lines));
        touch(); renderSlides(); renderMonitors(); renderPlaylistItems(); renderLibrary();
        window.__toast && window.__toast(`🎵 ${d.slides.length} slides added to “${d.name}”.`, 'good');
      });
      setTimeout(() => ta.focus(), 0);
      return;
    }
    if ($('#pvDocName').value !== (d.name || '')) $('#pvDocName').value = d.name || '';
    $('#pvDocMeta').textContent = `${(d.slides || []).length} slide${(d.slides || []).length === 1 ? '' : 's'}`;
    const w = pv.thumbSize, h = Math.round(w * 9 / 16);

    /* Slides are laid out UNDER GROUP BARS, not as one undifferentiated grid.
     * A service document is read in sections — verse, chorus, the notices —
     * and a coloured bar spanning the row is how an operator finds the chorus
     * at a glance while the previous song is still playing. Consecutive slides
     * sharing a group sit under one bar; `data-slide` keeps the slide's real
     * index, because everything else in this file addresses slides by it. */
    const slides = d.slides || [];
    const sections = [];
    slides.forEach((s, i) => {
      const g = s.group || '';
      const last = sections[sections.length - 1];
      if (last && last.group === g) last.items.push(i);
      else sections.push({ group: g, items: [i] });
    });

    /* ---------------------- the freeze, and why it is here ----------------------
     *
     * Everything that touches a slide ends in renderSlides(), and renderSlides()
     * used to throw the entire grid away and build it again: new HTML for every
     * card, a fresh 1920x1080 stage painted into every thumbnail, three event
     * listeners re-attached per slide. On an eighty-slide deck that is about
     * 85 ms of frozen window — and the slide editor ran it TWICE per keystroke,
     * so typing a line of a chorus locked the studio up for seconds at a time.
     *
     * Almost none of that work is ever needed. Moving the selection, cueing a
     * slide, typing into one slide — none of them change the SHAPE of the grid.
     * So the shape gets a signature; when it has not changed the cards are left
     * standing and only what actually differs is touched: the two or three
     * classes that mark selection and live, and the one thumbnail whose words
     * changed (SlideRender.paint skips the rest by its own signature).
     *
     * The full rebuild is still here, unchanged, for when the shape really does
     * change — a slide added, deleted, reordered, retagged, or the deck swapped.
     */
    const liveIx = (!pv.verseCue && pv.liveDocId === d.id) ? pv.liveIx : -1;
    const shapeSig = JSON.stringify([d.id, w, sections.map((s) => [s.group, s.items.length]),
      slides.map((s) => s.label || '')]);
    // The Look is shared by every thumbnail and is the bulk of a paint key, so
    // it is described once here rather than eighty times inside paint().
    const baseLook = look();
    const baseSig = JSON.stringify(baseLook);
    const paintAll = (cards, boxes) => {
      // Every thumbnail is the same size, so measure one — see fit()'s note on
      // why measuring each in turn is what makes a grid repaint expensive.
      const first = boxes.find(Boolean);
      const size = first ? { w: first.clientWidth, h: first.clientHeight } : null;
      slides.forEach((s, i) => {
        const box = boxes[i]; if (!box) return;
        const lk = s.look ? Object.assign({}, baseLook, s.look) : baseLook;
        window.SlideRender.paint(box, s, lk, {
          shrink: true, still: true, box: size,
          lookSig: s.look ? baseSig + JSON.stringify(s.look) : baseSig,
        });
      });
      cards.forEach((n, i) => {
        n.classList.toggle('sel', pv.slideIx === i);
        n.classList.toggle('live', liveIx === i);
      });
    };
    if (el.__pvShape === shapeSig && el.__pvCards && el.__pvCards.length === slides.length) {
      paintAll(el.__pvCards, el.__pvBoxes);
      return;
    }
    el.__pvShape = shapeSig;

    el.innerHTML = sections.map((sec, si) => {
      const col = groupColor(sec.group);
      const first = slides[sec.items[0]];
      return `<div class="pv-group-sec">` +
        `<div class="pv-group-bar" style="--gc:${col}" data-gsec="${si}"` +
          ` title="Double-click to rename this section">` +
          `<span class="pv-group-bar-name">${esc(sec.group || first && first.label || 'Slides')}</span>` +
          `<span class="pv-group-bar-n">${sec.items.length}</span>` +
        `</div>` +
        `<div class="pv-group-slides">` +
        sec.items.map((i) => {
          const s = slides[i];
          // While a passage from the Bible panel owns the screen, no slide in
          // the Library is live — saying otherwise would be a lie the operator
          // acts on.
          const isLive = !pv.verseCue && pv.liveDocId === d.id && pv.liveIx === i;
          return `<div class="pv-slide${pv.slideIx === i ? ' sel' : ''}${isLive ? ' live' : ''}" data-slide="${i}" style="width:${w}px">
            <div class="pv-slide-thumb" style="height:${h}px" data-thumb="${i}">
              <!-- A slide has to SAY it can be edited. Double-click is a secret:
                   the people running a service on a Sunday morning had no way to
                   discover it, and the ones who knew still had no way to change
                   the words' size, colour or position. -->
              <button type="button" class="pv-slide-edit-btn" data-editslide="${i}"
                      title="Edit these words and how they look">✏️</button>
            </div>
            <div class="pv-slide-tag" style="background:${groupColor(s.group)}">
              <span class="pv-slide-no">${i + 1}</span>
              <span class="pv-slide-group">${esc(s.label || s.group || '')}</span>
            </div>
          </div>`;
        }).join('') +
        `</div></div>`;
    }).join('') || '<p class="muted pv-empty">No slides yet — press ＋ Slide, or find a verse in the Bible panel.</p>';

    // The cards and their thumbnails are looked up once and kept: every later
    // render reuses them instead of querying the document eighty times over.
    el.__pvCards = []; el.__pvBoxes = [];
    $$('.pv-slide', el).forEach((n) => {
      const i = +n.dataset.slide;
      el.__pvCards[i] = n;
      el.__pvBoxes[i] = n.querySelector('[data-thumb]');
      n.addEventListener('click', () => onSlideClick(i));
      n.addEventListener('dblclick', () => editSlide(i));
      n.addEventListener('contextmenu', (e) => { e.preventDefault(); pv.slideIx = i; cycleGroup(i); });
    });
    // Paint each thumbnail through the SAME renderer the projector uses, so a
    // thumbnail is a true miniature — line breaks and all.
    paintAll(el.__pvCards, el.__pvBoxes);
    // The ✏️ on a slide opens the editor. It must not also CUE the slide, so it
    // stops the click before the card's own handler sees it.
    $$('[data-editslide]', el).forEach((b) => {
      b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); openSlideEditor(+b.dataset.editslide); });
      b.addEventListener('dblclick', (e) => { e.stopPropagation(); e.preventDefault(); });
    });
    wireGroupBars(el, sections);
  }
  /* Renaming a section IS how a slide gets its tag now.
   *
   * There used to be a strip of eleven coloured chips along the bottom of the
   * screen — the only way to tag a slide, and a fixed vocabulary: if your
   * running order says "Communion" or "Response", no chip said so. The bar
   * above each section is where the operator already reads the name, so that
   * is where they type it. Every slide in the section moves together, which is
   * what a section means. */
  function wireGroupBars(el, sections) {
    $$('[data-gsec]', el).forEach((bar) => {
      const sec = sections[+bar.dataset.gsec]; if (!sec) return;
      bar.addEventListener('dblclick', (e) => {
        e.preventDefault();
        inlineRename(bar.querySelector('.pv-group-bar-name'), sec.group, (v) => {
          const ss = slides();
          sec.items.forEach((i) => { if (ss[i]) ss[i].group = v; });
          touch(); renderSlides(); renderMonitors();
        });
      });
    });
  }
  /** In Show mode a click IS the cue; in Edit mode it selects for editing. */
  function onSlideClick(i) {
    pv.slideIx = i;
    if (pv.mode === 'show') cue(i);
    else { renderSlides(); renderMonitors(); }
  }
  function cycleGroup(i) {
    const s = slides()[i]; if (!s) return;
    const at = GROUPS.findIndex((g) => g.name === s.group);
    s.group = GROUPS[(at + 1) % GROUPS.length].name;
    touch(); renderSlides();
  }
  const touch = () => { const d = doc(); if (d) { d.updated = Date.now(); saveDoc(d); } };

  /* ============================ editing ============================ */
  /**
   * Inline slide editor — a textarea straight over the thumbnail.
   *
   * Edit mode is switched on FOR THE DURATION OF THE EDIT and switched off
   * again the moment the textarea closes. It used to latch: a double-click put
   * the whole studio into Edit and left it there, so afterwards the operator
   * clicked a slide mid-service and the screen did not change — the click was
   * being read as "select this one for editing". Nothing on the toolbar said
   * so loudly enough to notice while a song was playing. The mode now lasts
   * exactly as long as the box you are typing in.
   */
  function editSlide(i) {
    const d = doc(); const s = slides()[i]; if (!s) return;
    setMode('edit');
    // This textarea used to be swept away by the next full rebuild of the grid
    // rather than by anything that knew about it. That worked only for as long
    // as every render rebuilt everything; the moment the grid started leaving
    // unchanged cards alone, a finished edit left its box sitting on the slide
    // and the NEXT double-click found the dead one instead of the live one —
    // typing went into a textarea whose commit had already fired, and the
    // studio stayed in Edit. A node is removed by the code that created it.
    $$('#pvSlides .pv-slide-edit').forEach((n) => { try { n.remove(); } catch (e) {} });
    pv.slideIx = i; renderSlides();
    const box = $(`#pvSlides .pv-slide[data-slide="${i}"] .pv-slide-thumb`);
    if (!box) { setMode('show'); return; }
    const ta = document.createElement('textarea');
    ta.className = 'pv-slide-edit';
    ta.value = (s.lines || []).join('\n');
    box.appendChild(ta);
    ta.focus(); ta.select();
    const commit = () => {
      s.lines = ta.value.split('\n');
      setMode('show');                            // back to cueing, always
      try { ta.remove(); } catch (e) {}
      touch(); renderSlides(); renderMonitors();
      if (pv.liveDocId === d.id && pv.liveIx === i) live(i); // keep the projector honest
    };
    ta.addEventListener('blur', commit, { once: true });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); ta.value = (s.lines || []).join('\n'); ta.blur(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }
    });
  }
  /* ======================= THE SLIDE EDITOR =======================
   *
   * Editing a slide used to be a double-click that produced a bare textarea:
   * undiscoverable, and even once found it could only change the WORDS. How
   * those words looked — their size, colour, font, where they sat on the screen
   * — could only be changed for the whole Look, so one verse that needed to be
   * a little smaller meant restyling every slide in the service.
   *
   * The renderer has always supported a per-slide `theme` that wins over the
   * Look (see slide-render.js stageHtml). This is the panel that writes it: the
   * words on the left, the type controls on the right, and a live 16:9 preview
   * painted by the SAME renderer the projector uses — so what is being adjusted
   * IS what the congregation will see, at every step.
   */
  const SLIDE_FONTS = ['Poppins', 'Anton', 'Bebas Neue', 'Bangers', 'Arial'];
  /** The per-slide overrides this panel can set, and what they mean. */
  const slideTheme = (s) => Object.assign({}, (s && s.theme) || {});

  function openSlideEditor(i) {
    const d = doc(); const s = slides()[i]; if (!d || !s) return;
    closeSlideEditor();
    pv.slideIx = i;
    pv.editingSlide = i;
    const look = lookFor(s);
    const before = { lines: (s.lines || []).slice(), theme: slideTheme(s) };
    const t = () => Object.assign({}, look, slideTheme(s));

    const back = document.createElement('div');
    back.className = 'pv-sled-back';
    back.innerHTML =
      `<div class="pv-sled" role="dialog" aria-modal="true">
         <div class="pv-sled-head">
           <span class="pv-sled-title">✏️ Slide ${i + 1}<span class="muted small"> — ${esc(s.label || s.group || '')}</span></span>
           <div class="pv-sled-head-btns">
             <button type="button" class="pv-sled-reset" title="Give this slide the Look's styling back">↺ Match the Look</button>
             <button type="button" class="pv-sled-x" title="Close">✕</button>
           </div>
         </div>
         <div class="pv-sled-body">
           <div class="pv-sled-left">
             <label class="pv-sled-lab">The words on this slide</label>
             <textarea class="pv-sled-text" spellcheck="false" placeholder="Type the words for this slide…"></textarea>
             <p class="muted small pv-sled-hint">Each line here is a line on the screen. Enter starts a new line — nothing is cut off.</p>
             <div class="pv-sled-preview-wrap">
               <label class="pv-sled-lab">What the congregation will see</label>
               <div class="pv-sled-preview"></div>
             </div>
           </div>
           <div class="pv-sled-right">
             <div class="pv-sled-group">
               <span class="pv-sled-gname">Type</span>
               <label>Font <select class="sled-font">${SLIDE_FONTS.map((f) => `<option value="${attr(f)}">${esc(f)}</option>`).join('')}</select></label>
               <label>Size <input type="range" class="sled-size" min="36" max="180" step="2" /><output class="sled-size-v"></output></label>
               <label>Colour <input type="color" class="sled-color" /></label>
               <div class="pv-sled-toggles">
                 <button type="button" class="sled-b" title="Bold"><b>B</b></button>
                 <button type="button" class="sled-i" title="Italic"><i>I</i></button>
                 <button type="button" class="sled-caps" title="ALL CAPS">AA</button>
               </div>
             </div>
             <div class="pv-sled-group">
               <span class="pv-sled-gname">Where it sits</span>
               <label>Across <select class="sled-align">
                 <option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></label>
               <label>Down <select class="sled-valign">
                 <option value="top">Top</option><option value="center">Middle</option><option value="bottom">Bottom</option></select></label>
               <label>Line spacing <input type="range" class="sled-lh" min="0.9" max="2" step="0.05" /><output class="sled-lh-v"></output></label>
               <label>Side margin <input type="range" class="sled-padx" min="0" max="400" step="10" /><output class="sled-padx-v"></output></label>
             </div>
             <div class="pv-sled-group">
               <span class="pv-sled-gname">Readability over a picture</span>
               <label>Shadow <input type="range" class="sled-shadow" min="0" max="1" step="0.05" /><output class="sled-shadow-v"></output></label>
               <label>Outline <input type="range" class="sled-outline" min="0" max="3" step="0.1" /><output class="sled-outline-v"></output></label>
               <label>Outline colour <input type="color" class="sled-outcolor" /></label>
             </div>
           </div>
         </div>
         <div class="pv-sled-foot">
           <button type="button" class="pv-sled-apply-all" title="Give every slide in this song the styling you just set">Use this styling for the whole song</button>
           <span class="pv-sled-live muted small"></span>
           <div class="pv-sled-foot-btns">
             <button type="button" class="pv-sled-cancel">Cancel</button>
             <button type="button" class="pv-sled-done">Done</button>
           </div>
         </div>
       </div>`;
    document.body.appendChild(back);
    pv._sledEl = back;

    const q = (sel) => back.querySelector(sel);
    const ta = q('.pv-sled-text');
    ta.value = (s.lines || []).join('\n');

    /** Write one override onto the slide (or clear it when it matches the Look). */
    const setT = (key, val) => {
      s.theme = s.theme || {};
      if (val == null || val === look[key]) delete s.theme[key];
      else s.theme[key] = val;
      if (!Object.keys(s.theme).length) delete s.theme;
      apply();
    };

    const paint = () => {
      window.SlideRender.paint(q('.pv-sled-preview'), s, look, { shrink: true, still: true });
    };
    /** Push every change straight to the document, the grid and the projector. */
    const apply = () => {
      touch();
      paint();
      syncControls();
      // If this exact slide is on the screen right now, the screen follows the
      // edit as it is made — no "apply" step, no surprise at the next cue.
      //
      // live() re-renders the grid and the monitors itself, so calling them
      // here as well ran every one of them TWICE for each letter typed. On a
      // long deck that was the difference between a studio that keeps up with
      // a typist and one that stops answering.
      const isLive = pv.liveDocId === d.id && pv.liveIx === i && !pv.verseCue;
      if (isLive) live(i);
      else { renderSlides(); renderMonitors(); }
      q('.pv-sled-live').textContent = isLive
        ? '🔴 This slide is LIVE — the screen is following your changes.' : '';
    };
    const syncControls = () => {
      const c = t();
      q('.sled-font').value = SLIDE_FONTS.includes(c.font) ? c.font : SLIDE_FONTS[0];
      q('.sled-size').value = c.sizePx; q('.sled-size-v').textContent = Math.round(c.sizePx) + 'px';
      q('.sled-color').value = /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#ffffff';
      q('.sled-b').classList.toggle('on', !!c.bold);
      q('.sled-i').classList.toggle('on', !!c.italic);
      q('.sled-caps').classList.toggle('on', !!c.allCaps);
      q('.sled-align').value = c.align; q('.sled-valign').value = c.valign;
      q('.sled-lh').value = c.lineHeight; q('.sled-lh-v').textContent = Number(c.lineHeight).toFixed(2);
      q('.sled-padx').value = c.padX; q('.sled-padx-v').textContent = Math.round(c.padX) + 'px';
      q('.sled-shadow').value = c.shadow; q('.sled-shadow-v').textContent = Math.round(c.shadow * 100) + '%';
      q('.sled-outline').value = c.outline; q('.sled-outline-v').textContent = Number(c.outline).toFixed(1);
      q('.sled-outcolor').value = /^#[0-9a-f]{6}$/i.test(c.outlineColor) ? c.outlineColor : '#000000';
    };

    ta.addEventListener('input', () => { s.lines = ta.value.split('\n'); apply(); });
    // The studio cues the projector on space and the arrow keys; typing a lyric
    // in here must never black the screen mid-service.
    back.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    }, true);

    q('.sled-font').addEventListener('change', (e) => setT('font', e.target.value));
    q('.sled-size').addEventListener('input', (e) => setT('sizePx', +e.target.value));
    q('.sled-color').addEventListener('input', (e) => setT('color', e.target.value));
    q('.sled-b').addEventListener('click', () => setT('bold', !t().bold));
    q('.sled-i').addEventListener('click', () => setT('italic', !t().italic));
    q('.sled-caps').addEventListener('click', () => setT('allCaps', !t().allCaps));
    q('.sled-align').addEventListener('change', (e) => setT('align', e.target.value));
    q('.sled-valign').addEventListener('change', (e) => setT('valign', e.target.value));
    q('.sled-lh').addEventListener('input', (e) => setT('lineHeight', +e.target.value));
    q('.sled-padx').addEventListener('input', (e) => setT('padX', +e.target.value));
    q('.sled-shadow').addEventListener('input', (e) => setT('shadow', +e.target.value));
    q('.sled-outline').addEventListener('input', (e) => setT('outline', +e.target.value));
    q('.sled-outcolor').addEventListener('input', (e) => setT('outlineColor', e.target.value));

    q('.pv-sled-reset').addEventListener('click', () => { delete s.theme; apply(); });
    q('.pv-sled-apply-all').addEventListener('click', () => {
      const th = slideTheme(s);
      for (const other of slides()) { if (Object.keys(th).length) other.theme = Object.assign({}, th); else delete other.theme; }
      apply();
      window.__toast && window.__toast('🎨 Every slide in this song now uses this styling.', 'good');
    });

    const cancel = () => {
      s.lines = before.lines;
      if (Object.keys(before.theme).length) s.theme = before.theme; else delete s.theme;
      apply();
      closeSlideEditor();
    };
    q('.pv-sled-cancel').addEventListener('click', cancel);
    q('.pv-sled-x').addEventListener('click', closeSlideEditor);
    q('.pv-sled-done').addEventListener('click', closeSlideEditor);
    back.addEventListener('mousedown', (e) => { if (e.target === back) closeSlideEditor(); });

    apply();
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    return back;
  }

  function closeSlideEditor() {
    if (pv._sledEl) { try { pv._sledEl.remove(); } catch (e) {} pv._sledEl = null; }
    pv.editingSlide = null;
    saveShow();
    flushSaves();          // the edit is finished — put it on the disk now
    flushGrid();
  }

  function addSlide(after) {
    const d = doc(); if (!d) return;
    const at = after == null ? (pv.slideIx >= 0 ? pv.slideIx + 1 : d.slides.length) : after;
    const s = mkSlide('Blank', ['']);
    d.slides.splice(at, 0, s);
    pv.slideIx = at; touch(); renderSlides();
    setTimeout(() => editSlide(at), 0);
  }
  function deleteSlide() {
    const d = doc(); if (!d || pv.slideIx < 0) return;
    d.slides.splice(pv.slideIx, 1);
    if (pv.liveDocId === d.id && pv.liveIx >= d.slides.length) pv.liveIx = d.slides.length - 1;
    pv.slideIx = clamp(pv.slideIx, -1, d.slides.length - 1);
    touch(); renderSlides(); renderMonitors();
  }
  /**
   * Reflow: re-split every slide's words into readable chunks.
   *
   * Pasting a whole song or a long passage gives you one unreadable wall of
   * text; this is the "make it fit the screen" button. Splits on blank lines
   * first (the writer's own stanzas), then caps each slide at 4 lines.
   */
  function reflow() {
    const d = doc(); if (!d || !d.slides.length) return;
    const MAX = 4;
    const out = [];
    for (const s of d.slides) {
      const blocks = (s.lines || []).join('\n').split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
      if (!blocks.length) { out.push(s); continue; }
      let first = true;
      for (const b of blocks) {
        for (let i = 0; i < b.length; i += MAX) {
          const chunk = b.slice(i, i + MAX);
          out.push(first
            ? Object.assign({}, s, { lines: chunk })
            : Object.assign({}, s, { id: uid(), lines: chunk }));
          first = false;
        }
      }
    }
    d.slides = out; pv.slideIx = 0; touch(); renderSlides();
    window.__toast && window.__toast(`⇄ Re-split into ${out.length} slides — nothing longer than ${MAX} lines.`, 'good');
  }

  /* ================= arrangements =================
   * A song's slides are written once, in order; an ARRANGEMENT is a named play
   * order over them ("V1 C V2 C B C C"). Sunday morning runs the short version,
   * the evening runs the long one — same document, no duplicated slides. */
  function arrangements() { const d = doc(); return (d && d.arrangements) || []; }
  function activeOrder() {
    const d = doc(); if (!d) return [];
    const a = arrangements().find((x) => x.name === pv.arrangement);
    if (!a) return d.slides.map((_, i) => i);
    // an arrangement lists GROUP names; expand each to the slides in that group
    const out = [];
    for (const g of a.order) d.slides.forEach((s, i) => { if (s.group === g) out.push(i); });
    return out.length ? out : d.slides.map((_, i) => i);
  }
  function renderArrangements() {
    const sel = $('#pvArrange'); if (!sel) return;
    const list = arrangements();
    sel.innerHTML = '<option value="">Full order</option>'
      + list.map((a) => `<option value="${attr(a.name)}"${pv.arrangement === a.name ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
    sel.value = pv.arrangement || '';
  }
  async function newArrangement() {
    const d = doc(); if (!d) return;
    const groups = Array.from(new Set(d.slides.map((s) => s.group)));
    const name = await ask('Name this arrangement:', 'Sunday short'); if (!name) return;
    const order = await ask(
      `Play order — group names separated by commas.\nAvailable: ${groups.join(', ')}`,
      groups.join(', '));
    if (!order) return;
    d.arrangements = (d.arrangements || []).filter((a) => a.name !== name);
    d.arrangements.push({ name, order: order.split(',').map((s) => s.trim()).filter(Boolean) });
    pv.arrangement = name; touch(); renderArrangements(); renderSlides();
    window.__toast && window.__toast(`🎼 Arrangement "${name}" saved — ▶/← now follow it.`, 'good');
  }

  /* ================= ChordPro ================= */
  /** Paste or import a chord chart; chords land above the words for the band. */
  async function importChordPro(text) {
    let raw = text;
    if (raw == null) {
      let p; try { p = await window.api.dialog.openFile([{ name: 'Chord chart', extensions: ['cho', 'crd', 'chopro', 'chordpro', 'pro', 'txt'] }]); } catch (e) { p = null; }
      if (!p) return null;
      try { raw = await window.api.fs.readText(p); } catch (e) { return null; }
    }
    if (!raw || !raw.trim()) return null;
    const parsed = window.ChordPro.parse(raw, { linesPerSlide: 4 });
    if (!parsed.sections.length) { window.__toast && window.__toast('No lyrics found in that chart.', 'error'); return null; }
    const d = {
      id: uid(), name: parsed.title || 'Untitled song', kind: 'song', lookId: pv.lookId,
      author: parsed.author || '', songKey: parsed.key || '', ccli: parsed.ccli || '',
      updated: Date.now(),
      slides: parsed.sections.map((s) => Object.assign(mkSlide(s.group, s.lines), { chords: s.chords })),
    };
    pv.presentations.unshift(d); saveDoc(d);
    pv.docId = d.id; pv.slideIx = 0; pv.arrangement = null;
    renderLibrary(); renderArrangements(); renderSlides(); renderMonitors();
    window.__toast && window.__toast(
      `🎸 "${d.name}" imported — ${d.slides.length} slides with chords${parsed.key ? ' in ' + parsed.key : ''}.`, 'good');
    return d;
  }
  function transposeSong(steps) {
    const d = doc(); if (!d) return;
    d.slides = window.ChordPro.transposeSlides(d.slides, steps, steps < 0);
    touch(); renderSlides();
    if (pv.liveDocId === d.id && pv.liveIx >= 0) live(pv.liveIx);
    window.__toast && window.__toast(`🎸 Transposed ${steps > 0 ? '+' : ''}${steps} semitone${Math.abs(steps) === 1 ? '' : 's'}.`, 'good');
  }

  /* ==================== PASTING SONGS IN ====================
   *
   * A choir event is twenty songs, and building each one by hand — New, Slide,
   * double-click, type, Reflow — is twenty times the work on the night before.
   * Everything a worship team already has is TEXT: a lyrics site, a Word file,
   * last year's running order. So the whole job is one paste.
   *
   * The rules are deliberately the ones people already write lyrics with, so
   * nobody has to learn a format:
   *   • a line of --- (or ===) starts the next SONG,
   *   • the first line of a song is its NAME (unless it is a section tag),
   *   • a BLANK LINE starts the next slide,
   *   • a line like "Chorus", "[Verse 2]", "Bridge:" names the section it
   *     heads, is coloured like ProPresenter, and is not sung,
   *   • nothing longer than `maxLines` lines ever lands on one slide.
   *
   * Pure, and separately tested: what an operator sees in the preview is this
   * function's own output, so the preview cannot lie about what they will get.
   */
  const SECTION_RE = /^\s*[\[(]?\s*(verse|chorus|pre[- ]?chorus|bridge|tag|intro|outro|ending|refrain|vamp|interlude|instrumental|coda|hook|scripture)\s*([0-9]+)?\s*[\])]?\s*:?\s*$/i;
  function sectionOf(line) {
    const m = SECTION_RE.exec(line || '');
    if (!m) return null;
    const word = m[1].toLowerCase().replace(/\s+/g, '').replace('pre-chorus', 'pre-chorus');
    const n = m[2] ? ' ' + m[2] : '';
    const canon = {
      verse: 'Verse', chorus: 'Chorus', prechorus: 'Pre-Chorus', 'pre-chorus': 'Pre-Chorus',
      bridge: 'Bridge', tag: 'Tag', intro: 'Intro', outro: 'Outro', ending: 'Outro',
      refrain: 'Chorus', vamp: 'Tag', interlude: 'Intro', instrumental: 'Intro',
      coda: 'Outro', hook: 'Chorus', scripture: 'Scripture',
    }[word] || null;
    if (!canon) return null;
    // "Verse" on its own is Verse 1; "Chorus 2" stays "Chorus 2" only if the
    // group list knows it, otherwise the number is dropped so the colour holds.
    if (canon === 'Verse') return 'Verse' + (n || ' 1');
    return canon + (n && canon === 'Chorus' ? '' : '');
  }

  function parseSongs(text, opts) {
    const o = opts || {};
    const maxLines = Math.max(1, Math.min(12, o.maxLines || 4));
    const titleFromFirstLine = o.titleFromFirstLine !== false;
    const songs = [];
    const chunks = String(text || '').replace(/\r\n?/g, '\n').split(/^\s*[-=_]{3,}\s*$/m);
    for (const chunk of chunks) {
      const raw = chunk.replace(/^\n+|\n+$/g, '');
      if (!raw.trim()) continue;
      const blocks = raw.split(/\n\s*\n+/).map((b) => b.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()))
        .filter((b) => b.length);
      if (!blocks.length) continue;
      let name = '';
      // A title is a lone first line that is NOT a section tag and not part of
      // a verse — "Amazing Grace" over a blank line, the way lyrics are written.
      if (titleFromFirstLine && blocks[0].length === 1 && !sectionOf(blocks[0][0])) {
        name = blocks.shift()[0].trim();
      }
      const slides = [];
      let group = 'Verse 1';
      for (const block of blocks) {
        let lines = block;
        const tag = sectionOf(lines[0]);
        if (tag) { group = tag; lines = lines.slice(1); }
        if (!lines.length) continue;
        for (let i = 0; i < lines.length; i += maxLines) {
          slides.push({ group, lines: lines.slice(i, i + maxLines).map((l) => l.trim()) });
        }
      }
      /*
       * `keepEmpty` is what makes an export a backup rather than a one-way
       * door. Paste songs drops a chunk with no words — quite right, since a
       * stray line between two `---` is a mistake, not a song. But a file
       * written by 📤 Export legitimately contains songs whose words have not
       * been typed yet, and dropping those on the way back in would lose
       * exactly the set list the operator was keeping.
       */
      if (!slides.length) {
        if (!o.keepEmpty || !name) continue;
        songs.push({ name, slides: [{ group: 'Verse 1', lines: [''] }], empty: true });
        continue;
      }
      if (!name) name = (slides[0].lines[0] || 'Untitled song').slice(0, 60);
      songs.push({ name, slides });
    }
    return songs;
  }

  /* ===================== a SET LIST — titles now, words later =================
   *
   * The order a service actually gets built in: someone knows the songs on
   * Tuesday and nobody has typed a word of them yet. So this reads a plain list
   * of names — the thing that already exists, in an email or a notebook — and
   * makes a real song for each one, empty and waiting.
   *
   * Sets are headings. A line marked `# Praise and Worship`, `[Offering]`,
   * `--- Thanksgiving ---` or `Thanksgiving:` starts a new set, and everything
   * under it belongs to that set until the next heading. Numbering people
   * naturally type ("1.", "2)", "- ") is stripped, because they will type it.
   */
  const SET_HEADING = [
    /^#{1,3}\s*(.+?)\s*#*$/,          // # Praise and Worship
    /^\[\s*(.+?)\s*\]$/,              // [Offering]
    /^[-=_*]{2,}\s*(.+?)\s*[-=_*]{2,}$/, // --- Thanksgiving ---
    /^(.{2,40}?)\s*:$/,               // Thanksgiving:
  ];
  function headingOf(line) {
    const t = line.trim();
    if (!t) return null;
    for (const re of SET_HEADING) {
      const m = re.exec(t);
      // A bare "---" is a song separator in the lyrics format, not a heading.
      if (m && m[1] && m[1].trim() && !/^[-=_*\s]+$/.test(m[1])) return m[1].trim();
    }
    return null;
  }
  /** Strip the numbering a human will inevitably have typed. */
  const stripBullet = (s) => s.replace(/^\s*(?:\d{1,3}\s*[.)\]:-]|[-•*–—▪·‣])\s+/, '').trim();
  /** Does this line carry a bullet or a number? */
  const BULLETED = /^\s*(?:\d{1,3}\s*[.)\]]|[-•*–—▪·‣])\s+/;
  /*
   * A song somebody has CROSSED OUT is a song they decided against, and it must
   * not quietly reappear on the screen on Sunday. Rich text pasted into a plain
   * box loses the strikethrough entirely, so the only two forms that survive
   * are markdown `~~like this~~` and the combining-strikethrough character some
   * exporters emit. Both are honoured; anything else has to be unticked in the
   * preview, which is exactly what that list is for.
   */
  const STRUCK = /^~~.+~~$/;
  const hasCombiningStrike = (s) => (s.match(/[̶̵]/g) || []).length >= Math.max(2, Math.floor(s.length / 3));
  const isStruck = (s) => STRUCK.test(s.trim()) || hasCombiningStrike(s);
  const unStrike = (s) => s.replace(/^~~|~~$/g, '').replace(/[̶̵]/g, '').trim();

  /**
   * A plain set list → `[{ set, songs: [name…] }]`.
   * Never throws and never drops a line silently: anything that is not a
   * heading is a song, so what the operator sees in the preview is what they get.
   */
  function parseSongList(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    /*
     * THE STRONGEST SIGNAL IN A REAL LIST IS THE BULLET.
     *
     * Nobody marks their headings with `#`. What they actually send is a note
     * where the songs are bulleted and the set names are not:
     *
     *     Song list for outpouring '26      ← the note's title
     *     Worship - C                       ← a set, with its key
     *     • Hallelujah my God reigns        ← songs
     *     • Most High, God of Heaven…
     *
     * So in a list that uses bullets at all, an UNBULLETED line is a heading.
     * That reads "Worship - C" and "Praise - C" correctly without asking anyone
     * to reformat anything, and the note's own title falls out for free: it
     * becomes a set with no songs under it, and empty sets are dropped below.
     *
     * The length guard is for the one way this can misfire — a bulleted item
     * that wrapped onto a second, unbulleted line. A heading is short; a
     * runaway lyric is not, so a long unbulleted line stays a song.
     */
    const usesBullets = lines.some((l) => BULLETED.test(l));
    // index of every non-empty line, so "the next line" means the next line
    // that says something rather than the next blank one
    const live = [];
    lines.forEach((l, i) => { if (l.trim()) live.push(i); });
    const sets = [];
    let cur = null;
    for (let k = 0; k < live.length; k++) {
      const raw = lines[live[k]];
      const line = raw.trim();
      const bulleted = BULLETED.test(raw);
      // Strip the bullet FIRST: a crossed-out song arrives as "• ~~Name~~", and
      // testing the whole line for strikethrough never matches.
      const body = stripBullet(line);
      const struck = isStruck(body);
      const bare = struck ? unStrike(body) : body;
      if (!bare) continue;
      let h = headingOf(bare);
      if (!h && usesBullets && !bulleted && bare.length <= 60) {
        const nextBulleted = k + 1 < live.length && BULLETED.test(lines[live[k + 1]]);
        /*
         * An unbulleted line in a bulleted list is a heading only if it
         * INTRODUCES bullets. That distinction is what keeps a mixed list
         * working: in "# Offering" followed by an unbulleted "All I Have Is
         * Yours", the song has no bullets under it and stays a song.
         *
         * And the very first line, when the line after it is also unbulleted,
         * is the note's own title ("Song list for outpouring '26") — a heading
         * for the whole page, not for a set. It is dropped rather than turned
         * into a song nobody asked for.
         */
        if (k === 0 && !nextBulleted) continue;
        if (nextBulleted) h = bare;
      }
      if (h && !struck) { cur = { set: h, songs: [] }; sets.push(cur); continue; }
      if (!bare) continue;
      if (!cur) { cur = { set: '', songs: [] }; sets.push(cur); }
      cur.songs.push({ name: bare.slice(0, 90), struck });
    }
    return sets.filter((s) => s.songs.length);
  }

  /**
   * ONE importer for both shapes of file, so the operator never has to know
   * which they have.
   *
   * A plain list of names is the Tuesday case — the set list exists, the words
   * do not. A file with `---` separators is what 📤 Export writes and what 📋
   * Paste songs eats: songs with their words, and (because an export is a
   * backup) songs without them too. Set headings work in both.
   */
  function parseImport(text, opts) {
    const t = String(text || '').replace(/\r\n?/g, '\n');
    const hasLyrics = /^\s*[-=_]{3,}\s*$/m.test(t);
    if (!hasLyrics) {
      return parseSongList(t).map((s) => ({
        set: s.set,
        songs: s.songs.map((n) => ({
          name: typeof n === 'string' ? n : n.name,
          slides: [{ group: 'Verse 1', lines: [''] }],
          empty: true,
          // crossed out in the note → offered, but unticked
          struck: typeof n === 'string' ? false : !!n.struck,
        })),
      }));
    }
    const sets = [];
    let cur = null;
    for (const chunk of t.split(/^\s*[-=_]{3,}\s*$/m)) {
      let body = chunk.replace(/^\n+/, '');
      const first = (body.split('\n')[0] || '').trim();
      const h = headingOf(first);
      if (h) {
        cur = { set: h, songs: [] };
        sets.push(cur);
        body = body.slice(body.indexOf('\n') + 1 || body.length).replace(/^\n+/, '');
      }
      const parsed = parseSongs(body, Object.assign({}, opts, { keepEmpty: true }));
      if (!parsed.length) continue;
      if (!cur) { cur = { set: '', songs: [] }; sets.push(cur); }
      cur.songs.push(...parsed);
    }
    return sets.filter((s) => s.songs.length);
  }

  /**
   * Create the songs and the running order from a parsed set list.
   *
   * Every song becomes a real presentation with at least ONE slide, so it can
   * be opened and typed into straight away — a document with no slides at all
   * has nothing to click. The sets become section headings ON the playlist
   * entries, which is how a service is actually read: one running order,
   * divided.
   */
  function addSongList(sets, { playlistName } = {}) {
    const made = [];
    const entries = [];
    for (const s of sets) {
      for (const song of s.songs) {
        // accept both a bare name and a parsed song with slides
        const name = typeof song === 'string' ? song : song.name;
        const sl = typeof song === 'string' ? null : song.slides;
        const d = { id: uid(), name, kind: 'song', lookId: pv.lookId, updated: Date.now(),
          slides: (sl && sl.length ? sl : [{ group: 'Verse 1', lines: [''] }]).map((x) => mkSlide(x.group, x.lines)) };
        pv.presentations.unshift(d);
        saveDoc(d);
        made.push(d);
        entries.push({ id: uid(), presentationId: d.id, name, group: s.set || '' });
      }
    }
    if (entries.length) {
      const wanted = (playlistName || '').trim();
      let pl = wanted
        ? pv.playlists.find((p) => (p.name || '').toLowerCase() === wanted.toLowerCase())
        : pv.playlists.find((p) => p.id === pv.playlistId);
      if (!pl) {
        pl = { id: uid(), name: wanted || 'This Sunday', items: [] };
        pv.playlists.unshift(pl);
      }
      pl.items = (pl.items || []).concat(entries);
      savePlaylist(pl);
      pv.playlistId = pl.id;
    }
    if (made.length) { pv.docId = made[0].id; pv.slideIx = 0; }
    renderLibrary(); renderPlaylists(); renderPlaylistItems(); renderSlides(); renderMonitors();
    return { songs: made.length, sets: sets.length };
  }

  /**
   * Everything back out as text, in the SAME shape 📋 Paste songs reads.
   *
   * Songs that have no words yet come out as just their name under their set,
   * so an exported list is still a valid list to re-import — which is what
   * makes this a backup rather than a one-way door.
   */
  function exportSongsText({ playlistOnly } = {}) {
    const out = [];
    const pl = pv.playlists.find((p) => p.id === pv.playlistId);
    const rows = playlistOnly && pl
      ? (pl.items || []).map((it) => ({ group: it.group || '', doc: pv.presentations.find((p) => p.id === it.presentationId), label: it.name }))
      : pv.presentations.map((d) => ({ group: '', doc: d, label: d.name }));
    let lastGroup = null;
    let first = true;
    for (const r of rows) {
      if (!r.doc) continue;
      /*
       * ORDER MATTERS: separator first, THEN the set heading.
       *
       * Written the other way round the heading lands before the `---`, which
       * puts it inside the PREVIOUS song's chunk — so on the way back in that
       * song appears to have a line of lyrics ("# Thanksgiving") and the set is
       * never seen at all. Caught by the round-trip check, which is the only
       * thing that could have caught it.
       */
      if (!first) out.push('---\n');
      if (r.group !== lastGroup) {
        lastGroup = r.group;
        if (r.group) out.push('# ' + r.group + '\n');
      }
      first = false;
      out.push((r.label || r.doc.name || 'Untitled song') + '\n');
      let group = null;
      for (const s of r.doc.slides || []) {
        const lines = (s.lines || []).filter((l) => String(l).trim());
        if (!lines.length) continue;
        if (s.group && s.group !== group) { out.push('\n' + s.group + '\n'); group = s.group; }
        else out.push('\n');
        out.push(lines.join('\n') + '\n');
      }
    }
    return out.join('');
  }

  /** Turn parsed songs into real documents in the library. */
  function addParsedSongs(songs, { toPlaylist } = {}) {
    const made = [];
    for (const s of songs) {
      const d = { id: uid(), name: s.name, kind: 'song', lookId: pv.lookId, updated: Date.now(),
        slides: s.slides.map((x) => mkSlide(x.group, x.lines)) };
      pv.presentations.unshift(d);
      saveDoc(d);
      made.push(d);
    }
    if (toPlaylist && made.length) {
      const pl = pv.playlists.find((p) => p.id === pv.playlistId);
      if (pl) {
        pl.items = pl.items || [];
        for (const d of made) pl.items.push({ id: uid(), presentationId: d.id, name: d.name });
        savePlaylist(pl);
        renderPlaylistItems();
      }
    }
    if (made.length) { pv.docId = made[0].id; pv.slideIx = 0; }
    renderLibrary(); renderPlaylists(); renderSlides(); renderMonitors();
    return made;
  }

  /* ============================ THE SONGS BANK ============================
   *
   * The Library is what is in THIS service. The bank is what the church SINGS —
   * the list a service is drawn out of, week after week, without retyping a
   * word. Every Sunday the same fifteen songs come round; before this, each one
   * was pasted again, or hunted for in a Library of four hundred old services.
   *
   * The catalogue ships with the app: titles, writers, years, what each song is
   * FOR, and the shape it is sung in. It ships no lyrics, and that is not a
   * shortfall — worship words are exactly what a church's CCLI licence covers,
   * and an app has no business handing out its own copy of them under somebody
   * else's name. So the words are the church's: typed once, pasted from the
   * files they already have, or poured in from the Library in one press
   * (📚 Add my library). From then on the bank keeps them, and a song is one
   * click from Sunday for good.
   *
   * A Library song made from the bank remembers where it came from (`bankId`),
   * so putting "Goodness Of God" into a fourth service reuses the one song
   * rather than making a fourth copy of it.
   */

  /** A song's words in the same format 📋 Paste songs reads — one round trip. */
  function songWords(d) {
    const parts = [];
    let group = null;
    for (const s of ((d && d.slides) || [])) {
      const lines = (s.lines || []).filter((l) => String(l).trim());
      if (!lines.length) continue;
      let head = '';
      if (s.group && s.group !== group) { head = s.group + '\n'; group = s.group; }
      parts.push(head + lines.join('\n'));
    }
    return parts.join('\n\n');
  }
  /* Two titles are the same song when they look the same to a person: case,
   * punctuation, accents and a leading "The" mean nothing. Mirrors songbank.js
   * so the studio and the bank never disagree about what is already there. */
  const normTitle = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[’'`]/g, '').replace(/^\s*the\s+/, '').replace(/[^a-z0-9]+/g, '');
  const sameSong = (a, b) => { const x = normTitle(a); return !!x && x === normTitle(b); };

  async function refreshBank() {
    try {
      const r = await window.api.songBank.list();
      pv.bank.songs = (r && r.songs) || [];
      pv.bank.themes = (r && r.themes) || [];
      pv.bank.loaded = true;
    } catch (e) { pv.bank.loaded = true; }
    renderBank();
  }

  function renderBankChips() {
    const el = $('#pvBankChips'); if (!el) return;
    const ready = pv.bank.songs.filter((s) => s.ready).length;
    const mine = pv.bank.songs.filter((s) => s.mine).length;
    const chips = [
      { id: 'all', label: 'All', n: pv.bank.songs.length },
      { id: 'ready', label: 'Ready to use', n: ready },
      { id: 'todo', label: 'Needs words', n: pv.bank.songs.length - ready },
      { id: 'mine', label: 'Ours', n: mine },
    ].concat((pv.bank.themes || []).map((t) => ({ id: t, label: t, n: pv.bank.songs.filter((s) => (s.themes || []).includes(t)).length })));
    el.innerHTML = chips.filter((c) => c.n || c.id === 'all').map((c) =>
      `<button class="pv-chip${pv.bank.chip === c.id ? ' on' : ''}" data-bankchip="${attr(c.id)}">${esc(c.label)}<span>${c.n}</span></button>`).join('');
    $$('[data-bankchip]', el).forEach((b) => b.addEventListener('click', () => {
      pv.bank.chip = b.dataset.bankchip; renderBank();
    }));
  }

  function renderBank() {
    const el = $('#pvBankList'); if (!el) return;
    renderBankChips();
    const q = (($('#pvBankFilter') || {}).value || '').trim().toLowerCase();
    const chip = pv.bank.chip;
    const list = pv.bank.songs.filter((s) => {
      if (q && !(String(s.title).toLowerCase().includes(q) || String(s.author).toLowerCase().includes(q))) return false;
      if (chip === 'ready') return s.ready;
      if (chip === 'todo') return !s.ready;
      if (chip === 'mine') return s.mine;
      if (chip && chip !== 'all') return (s.themes || []).includes(chip);
      return true;
    });
    const inService = new Set();
    const pl = pv.playlists.find((p) => p.id === pv.playlistId);
    for (const it of ((pl && pl.items) || [])) {
      const d = pv.presentations.find((p) => p.id === it.presentationId);
      if (d) { if (d.bankId) inService.add(d.bankId); inService.add('~' + normTitle(d.name)); }
    }
    const hint = $('#pvBankHint');
    if (hint) {
      const ready = pv.bank.songs.filter((s) => s.ready).length;
      hint.innerHTML = ready
        ? `<b>${ready}</b> of ${pv.bank.songs.length} have your words in them — those go straight onto the screen.`
        : `The words are yours to add: open a song, paste them in once, and the bank keeps them for every service after this one. `
          + `Already have them in your Library? Press <b>📚 Add my library</b>.`;
    }
    el.innerHTML = list.length ? list.map((s) => {
      const on = inService.has(s.id) || inService.has('~' + normTitle(s.title));
      const meta = [s.author, s.year || '', (s.themes || [])[0]].filter(Boolean).join(' · ');
      return `<div class="pv-bank-row${on ? ' on' : ''}" data-bank="${attr(s.id)}" title="${attr(s.title)}${on ? ' — already in this service' : ''}">
        <span class="pv-bank-main">
          <b>${esc(s.title)}</b>
          <span class="muted small">${esc(meta)}</span>
        </span>
        <span class="pv-bank-tag ${s.ready ? 'ok' : 'todo'}">${s.ready ? 'words ✓' : 'needs words'}</span>
        <span class="pv-bank-acts">
          <span class="pv-act" role="button" tabindex="-1" data-bankedit="${attr(s.id)}" title="Edit this song in the bank — words, writer, key">✏️</span>
          <span class="pv-act pv-act-del" role="button" tabindex="-1" data-bankdel="${attr(s.id)}" title="Take this out of the bank">🗑</span>
        </span>
        <button class="pv-bank-add" data-bankadd="${attr(s.id)}" title="${on ? 'Already in this service' : 'Add it to this service'}">${on ? '✓' : '＋'}</button>
      </div>`;
    }).join('')
      : `<p class="muted small pv-empty">${q || chip !== 'all' ? 'No song here matches that.' : 'The bank is empty — press ＋ New to put a song in it.'}</p>`;
    /*
     * ONE listener on the list, not four on every row.
     *
     * A bank is a hundred and fifty songs and grows for years, and this
     * re-renders whenever the service changes. Wiring each row cost six hundred
     * addEventListener calls per redraw and three redraws per song added — the
     * same "one action rebuilds everything, several times" shape that made
     * typing freeze the studio for 3.7 seconds. Delegation makes a redraw cost
     * the innerHTML and nothing else.
     *
     * The row opens the song (so the words can be read and edited); the ＋ puts
     * it in the service. Two different jobs, and mixing them would make one
     * impossible to do without doing the other.
     */
    if (!el._bankWired) {
      el._bankWired = true;
      el.addEventListener('click', (ev) => {
        const add = ev.target.closest('[data-bankadd]');
        if (add) { ev.stopPropagation(); addBankSong(add.dataset.bankadd, true); return; }
        const edit = ev.target.closest('[data-bankedit]');
        if (edit) { ev.stopPropagation(); openBankEditor(pv.bank.songs.find((s) => s.id === edit.dataset.bankedit)); return; }
        const del = ev.target.closest('[data-bankdel]');
        if (del) { ev.stopPropagation(); removeBankSong(del.dataset.bankdel); return; }
        const row = ev.target.closest('[data-bank]');
        if (row) addBankSong(row.dataset.bank, false);
      });
    }
  }
  /* The bank re-renders because the SERVICE changed, and a single press changes
   * it several times over. Coalesce those into one redraw, the way the slide
   * grid does — nothing is watching the bank mid-press. */
  let _bankTimer = null;
  function renderBankSoon() {
    if (_bankTimer) return;
    _bankTimer = setTimeout(() => { _bankTimer = null; renderBank(); }, 0);
  }

  /** The slides a bank song becomes: its words if it has them, its shape if not. */
  function bankSlides(s) {
    if (String(s.words || '').trim()) {
      const parsed = parseSongs(s.words, { maxLines: 4, titleFromFirstLine: false })[0];
      if (parsed && parsed.slides.length) return parsed.slides.map((x) => mkSlide(x.group, x.lines));
    }
    const secs = (s.sections || []).length ? s.sections : ['Verse 1'];
    return secs.map((g) => mkSlide(g, ['']));
  }

  /**
   * Put a bank song into the Library, and optionally into this service.
   *
   * An existing Library copy is REUSED rather than duplicated — by its bankId
   * first, then by its title, so a song typed by hand last month is adopted
   * instead of appearing twice under the same name.
   */
  async function addBankSong(id, toService) {
    const s = pv.bank.songs.find((x) => x.id === id);
    if (!s) return null;
    let d = pv.presentations.find((p) => p.bankId === id)
      || pv.presentations.find((p) => sameSong(p.name, s.title));
    let made = false;
    if (!d) {
      d = { id: uid(), name: s.title, kind: 'song', bankId: s.id, lookId: pv.lookId,
        author: s.author || '', songKey: s.key || '', ccli: s.ccli || '',
        updated: Date.now(), slides: bankSlides(s) };
      pv.presentations.unshift(d); saveDoc(d);
      made = true;
    } else if (!d.bankId) { d.bankId = s.id; saveDoc(d); }
    if (toService) {
      const pl = pv.playlists.find((p) => p.id === pv.playlistId);
      if (pl) {
        pl.items = pl.items || [];
        if (!pl.items.some((it) => it.presentationId === d.id)) {
          pl.items.push({ id: uid(), presentationId: d.id, name: d.name });
          savePlaylist(pl);
        }
      }
    }
    // openDoc already redraws the library, the running order and the grid —
    // repeating them here made one press redraw everything three times over.
    openDoc(d.id);
    renderPlaylists(); renderBankSoon();
    const words = (d.slides || []).some((x) => (x.lines || []).some((l) => String(l).trim()));
    window.__toast && window.__toast(words
      ? `🎵 "${d.name}" ${toService ? 'added to this service' : 'opened'} — ${d.slides.length} slides ready.`
      : `🎵 "${d.name}" ${toService ? 'added to this service' : 'opened'} — now type or paste its words, then press ＋ Bank the open song to keep them.`,
    'good', words ? 4200 : 9000);
    return d;
  }

  /**
   * Put the song that is open into the bank, words and all.
   *
   * This is the other half of the loop, and the half that makes the bank the
   * church's rather than the app's: whatever arrangement is on the screen —
   * their verses, their order, their key — is what gets kept.
   */
  async function bankTheOpenSong() {
    const d = doc();
    if (!d) return null;
    const words = songWords(d);
    if (!words.trim()) {
      window.__toast && window.__toast('This song has no words in it yet — type or paste them first, then bank it.', 'error', 7000);
      return null;
    }
    const existing = pv.bank.songs.find((s) => s.id === d.bankId)
      || pv.bank.songs.find((s) => sameSong(s.title, d.name));
    const song = Object.assign({}, existing || {}, {
      title: d.name, words,
      author: d.author || (existing && existing.author) || '',
      key: d.songKey || (existing && existing.key) || '',
      ccli: d.ccli || (existing && existing.ccli) || '',
      sections: Array.from(new Set((d.slides || []).map((s) => s.group).filter(Boolean))),
    });
    if (existing && existing.ready && existing.words !== words
      && !window.confirm(`"${d.name}" is already in the bank with words. Replace them with the ones in this song?`)) return null;
    try {
      await window.api.songBank.save(song);
      if (!d.bankId) { d.bankId = existing ? existing.id : song.id; saveDoc(d); }
      await refreshBank();
      // The bank generates the id, so the link is made from the saved list.
      if (!d.bankId) {
        const back = pv.bank.songs.find((s) => sameSong(s.title, d.name));
        if (back) { d.bankId = back.id; saveDoc(d); }
      }
      window.__toast && window.__toast(`🎵 "${d.name}" is in the bank — one click into any service from now on.`, 'good', 6000);
    } catch (e) {
      window.__toast && window.__toast('⚠️ ' + (e.message || 'Could not save that to the bank.'), 'error');
    }
    return song;
  }

  /**
   * Pour the Library into the bank.
   *
   * A church that has been using the studio all term already has its own
   * arrangements typed. Retyping them into the bank would be absurd, so this
   * matches them by title: their words land IN the catalogue entry, credited
   * and themed, rather than beside it as a near-duplicate. Nothing already in
   * the bank is overwritten.
   */
  async function bankMergeLibrary() {
    const songs = pv.presentations
      // A SONGS bank. The notices deck and the welcome slides have words in
      // them too, and belong in it about as much as a shopping list does —
      // ＋ Bank the open song is there for the one a church really does want.
      .filter((d) => (d.kind || 'song') === 'song')
      .map((d) => ({ title: d.name, words: songWords(d), author: d.author || '', key: d.songKey || '',
        sections: Array.from(new Set((d.slides || []).map((s) => s.group).filter(Boolean))) }))
      .filter((s) => s.words.trim());
    if (!songs.length) {
      window.__toast && window.__toast('Nothing to add yet — your Library has no songs with words in them.', 'error', 7000);
      return null;
    }
    try {
      const r = await window.api.songBank.merge(songs);
      await refreshBank();
      const res = (r && r.result) || {};
      const bits = [];
      if (res.filled) bits.push(`${res.filled} matched a song already listed`);
      if (res.added) bits.push(`${res.added} added`);
      window.__toast && window.__toast(bits.length
        ? `🎵 Bank updated — ${bits.join(', ')}.${res.skipped ? ` ${res.skipped} were already in it.` : ''}`
        : '🎵 Everything in your Library was already in the bank.', 'good', 8000);
      return res;
    } catch (e) {
      window.__toast && window.__toast('⚠️ ' + (e.message || 'Could not add those.'), 'error');
      return null;
    }
  }

  async function removeBankSong(id) {
    const s = pv.bank.songs.find((x) => x.id === id); if (!s) return;
    if (!window.confirm(`Take "${s.title}" out of the bank? Any copy of it in your Library stays where it is.`)) return;
    try { await window.api.songBank.remove(id); } catch (e) {}
    await refreshBank();
  }

  /** One dialog for both ＋ New and ✏️ — a song in the bank is a song in the bank. */
  function openBankEditor(song) {
    const s = song || { title: '', author: '', year: 0, themes: [], words: '', key: '', ccli: '' };
    const isNew = !song;
    const back = document.createElement('div');
    back.className = 'pv-ask-back';
    back.innerHTML =
      `<div class="pv-ask pv-paste pv-bank-edit" role="dialog" aria-modal="true">
         <p class="pv-ask-msg"><b>${isNew ? 'Add a song to the bank' : esc(s.title)}</b><br>
           <span class="muted small">The words you put here are yours and stay on this computer — the app never ships
           anybody's lyrics. Paste them the usual way: <b>a blank line starts a new slide</b>, and
           <b>Chorus</b> or <b>Verse 2</b> on its own line tags a section.</span></p>
         <div class="pv-bank-fields">
           <label>Title <input type="text" class="pv-bk-title" value="${attr(s.title)}" placeholder="Song title" /></label>
           <label>Writer <input type="text" class="pv-bk-author" value="${attr(s.author || '')}" placeholder="Who wrote it" /></label>
           <label>Key <input type="text" class="pv-bk-key" value="${attr(s.key || '')}" placeholder="e.g. G" /></label>
           <label>CCLI <input type="text" class="pv-bk-ccli" value="${attr(s.ccli || '')}" placeholder="Song number" /></label>
         </div>
         <textarea class="pv-paste-text pv-bk-words" spellcheck="false" placeholder="Verse 1
type or paste the words here

Chorus
…">${esc(s.words || '')}</textarea>
         <div class="pv-paste-preview pv-imp-list">Nothing yet.</div>
         <div class="pv-ask-btns">
           <button class="pv-ask-cancel">Cancel</button>
           <button class="pv-ask-ok">${isNew ? 'Add to bank' : 'Save'}</button>
         </div>
       </div>`;
    document.body.appendChild(back);
    const titleEl = back.querySelector('.pv-bk-title');
    const wordsEl = back.querySelector('.pv-bk-words');
    const okBtn = back.querySelector('.pv-ask-ok');
    const prev = back.querySelector('.pv-paste-preview');
    const refresh = () => {
      const parsed = parseSongs(wordsEl.value, { maxLines: 4, titleFromFirstLine: false })[0];
      okBtn.disabled = !titleEl.value.trim();
      prev.innerHTML = parsed && parsed.slides.length
        ? `<b>${parsed.slides.length} slides</b> <span class="muted">(${[...new Set(parsed.slides.map((x) => x.group))].map(esc).join(', ')})</span>`
        : 'No words yet — you can add the title now and the words later.';
    };
    const close = () => back.remove();
    wordsEl.addEventListener('input', refresh);
    titleEl.addEventListener('input', refresh);
    back.querySelector('.pv-ask-cancel').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    // Typing a lyric in here must never reach the projector's keyboard cues.
    back.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }, true);
    okBtn.addEventListener('click', async () => {
      const out = Object.assign({}, s, {
        title: titleEl.value.trim(),
        author: back.querySelector('.pv-bk-author').value.trim(),
        key: back.querySelector('.pv-bk-key').value.trim(),
        ccli: back.querySelector('.pv-bk-ccli').value.trim(),
        words: wordsEl.value,
      });
      if (!out.title) return;
      close();
      try {
        await window.api.songBank.save(out);
        await refreshBank();
        window.__toast && window.__toast(`🎵 "${out.title}" saved in the bank.`, 'good');
      } catch (e) { window.__toast && window.__toast('⚠️ ' + (e.message || 'Could not save that.'), 'error'); }
    });
    refresh();
    setTimeout(() => (isNew ? titleEl : wordsEl).focus(), 0);
    return back;
  }

  /** The paste box itself — with a live preview, so nothing is a surprise. */
  function openPasteSongs() {
    const back = document.createElement('div');
    back.className = 'pv-ask-back';
    const hasPlaylist = !!pv.playlists.find((p) => p.id === pv.playlistId);
    back.innerHTML =
      `<div class="pv-ask pv-paste" role="dialog" aria-modal="true">
         <p class="pv-ask-msg"><b>Paste your songs</b><br>
           <span class="muted small">One song or twenty. Put <b>---</b> on its own line between songs.
           A blank line starts a new slide. Write <b>Chorus</b>, <b>Verse 2</b> or <b>Bridge</b> on its own line to tag a section.</span></p>
         <textarea class="pv-paste-text" spellcheck="false" placeholder="Amazing Grace

Verse 1
Amazing grace, how sweet the sound
That saved a wretch like me

Chorus
How sweet the sound

---

How Great Thou Art
…"></textarea>
         <div class="pv-paste-opts">
           <label>Lines per slide <input type="number" class="pv-paste-max" value="4" min="1" max="12" /></label>
           <label class="pv-inline"><input type="checkbox" class="pv-paste-title" checked /> First line is the song title</label>
           ${hasPlaylist ? '<label class="pv-inline"><input type="checkbox" class="pv-paste-pl" checked /> Add them to the open playlist</label>' : ''}
         </div>
         <div class="pv-paste-preview pv-imp-list">Nothing pasted yet.</div>
         <div class="pv-ask-btns">
           <button class="pv-ask-cancel">Cancel</button>
           <button class="pv-ask-ok" disabled>Add songs</button>
         </div>
       </div>`;
    document.body.appendChild(back);
    const ta = back.querySelector('.pv-paste-text');
    const maxEl = back.querySelector('.pv-paste-max');
    const titleEl = back.querySelector('.pv-paste-title');
    const okBtn = back.querySelector('.pv-ask-ok');
    const prev = back.querySelector('.pv-paste-preview');
    let songs = [];
    const refresh = () => {
      songs = parseSongs(ta.value, { maxLines: +maxEl.value || 4, titleFromFirstLine: titleEl.checked });
      const slides = songs.reduce((n, s) => n + s.slides.length, 0);
      okBtn.disabled = !songs.length;
      okBtn.textContent = songs.length ? `Add ${songs.length} song${songs.length > 1 ? 's' : ''}` : 'Add songs';
      prev.innerHTML = songs.length
        ? `<b>${songs.length} song${songs.length > 1 ? 's' : ''} · ${slides} slides</b><br>` +
          songs.slice(0, 12).map((s) => `${esc(s.name)} <span class="muted">(${s.slides.length} slides: ${
            [...new Set(s.slides.map((x) => x.group))].map(esc).join(', ')})</span>`).join('<br>') +
          (songs.length > 12 ? `<br>…and ${songs.length - 12} more` : '')
        : 'Nothing pasted yet.';
    };
    const close = () => back.remove();
    ta.addEventListener('input', refresh);
    maxEl.addEventListener('input', refresh);
    titleEl.addEventListener('change', refresh);
    back.querySelector('.pv-ask-cancel').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    // Captured: the studio cues the projector on space and the arrow keys, and
    // typing a lyric into this box must not black the screen mid-service.
    back.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }, true);
    okBtn.addEventListener('click', () => {
      const plEl = back.querySelector('.pv-paste-pl');
      const made = addParsedSongs(songs, { toPlaylist: plEl && plEl.checked });
      close();
      window.__toast && window.__toast(
        `🎵 ${made.length} song${made.length > 1 ? 's' : ''} added — ${made.reduce((n, d) => n + d.slides.length, 0)} slides ready.`, 'good');
    });
    setTimeout(() => ta.focus(), 0);
    return back;
  }

  /* ===================== Import a set list · Export everything ============= */

  /** The set-list box: paste the names, or open the file they are already in. */
  function openImportSongs() {
    const back = document.createElement('div');
    back.className = 'pv-ask-back';
    back.innerHTML =
      `<div class="pv-ask pv-paste" role="dialog" aria-modal="true">
         <p class="pv-ask-msg"><b>Import a set list</b><br>
           <span class="muted small">Just the song names — the words can come later.
           <b>Paste it straight from your Notes app</b>: bulleted lines are songs, and a line without a bullet above them
           (like <b>Worship - C</b>) becomes a set. Numbering and bullets are stripped for you.
           Then untick anything you crossed out.</span></p>
         <textarea class="pv-paste-text" spellcheck="false" placeholder="# Praise and Worship
Way Maker
Goodness of God
Great Are You Lord

# Thanksgiving
10,000 Reasons
Thank You Lord

# Offering
All I Have Is Yours"></textarea>
         <div class="pv-paste-opts">
           <label>Add to playlist <input type="text" class="pv-imp-pl" placeholder="This Sunday" /></label>
           <button type="button" class="pv-imp-file">📂 Open a file…</button>
         </div>
         <div class="pv-paste-preview muted small">Nothing pasted yet.</div>
         <div class="pv-ask-btns">
           <button class="pv-ask-cancel">Cancel</button>
           <button class="pv-ask-ok" disabled>Add songs</button>
         </div>
       </div>`;
    document.body.appendChild(back);
    const ta = back.querySelector('.pv-paste-text');
    const plEl = back.querySelector('.pv-imp-pl');
    const okBtn = back.querySelector('.pv-ask-ok');
    const prev = back.querySelector('.pv-paste-preview');
    let sets = [];
    const refresh = () => {
      sets = parseImport(ta.value, { maxLines: 4 });
      const n = sets.reduce((t, s) => t + s.songs.length, 0);
      const withWords = sets.reduce((t, s) => t + s.songs.filter((x) => x && !x.empty).length, 0);
      okBtn.disabled = !n;
      okBtn.textContent = n ? `Add ${n} song${n > 1 ? 's' : ''}` : 'Add songs';
      // Show exactly what was understood — a set list is ambiguous by nature and
      // the operator must be able to SEE that "Offering" became a set and not a
      // song before they commit forty of them to the library.
      /*
       * The preview is a TICK LIST, not a summary.
       *
       * Real lists have songs crossed out on them, and a plain-text paste
       * cannot carry a strikethrough — so the ones that were struck arrive
       * looking exactly like the ones that were kept. Rather than guess, every
       * song is shown with a box: anything recognised as struck starts
       * unticked, and everything else can be dropped with one click before a
       * single song is created. It doubles as the proof that "Worship - C" was
       * read as a set and not as a song.
       */
      if (!n) { prev.innerHTML = '<p class="pv-imp-none">Nothing pasted yet.</p>'; return; }
      prev.innerHTML =
        `<div class="pv-imp-head"><b>${n} song${n > 1 ? 's' : ''} in ${sets.length} set${sets.length > 1 ? 's' : ''}</b>` +
        `<span class="muted small">${withWords
          ? `${withWords} already ${withWords === 1 ? 'has its words' : 'have their words'} — the rest are empty, ready for theirs.`
          : 'Untick anything you do not want.'}</span></div>` +
        sets.map((s, si) => `<div class="pv-imp-set">${esc(s.set || 'No set')}</div>` +
          s.songs.map((song, xi) => {
            const nm = typeof song === 'string' ? song : song.name;
            const off = !!(song && song.struck);
            return `<label class="pv-imp-row${off ? ' off' : ''}">` +
              `<input type="checkbox" data-si="${si}" data-xi="${xi}"${off ? '' : ' checked'} />` +
              `<span>${esc(nm)}</span>` +
              `${off ? '<em class="pv-imp-note">crossed out</em>' : ''}` +
              `</label>`;
          }).join('')).join('');
      const sync = () => {
        const picked = $$('[data-si]', prev).filter((c) => c.checked).length;
        okBtn.disabled = !picked;
        okBtn.textContent = picked ? `Add ${picked} song${picked > 1 ? 's' : ''}` : 'Add songs';
      };
      $$('[data-si]', prev).forEach((c) => c.addEventListener('change', () => {
        c.closest('.pv-imp-row').classList.toggle('off', !c.checked);
        sync();
      }));
      sync();
    };
    /** Only what is still ticked, in the sets it belongs to. */
    const picked = () => sets
      .map((s, si) => ({ set: s.set, songs: s.songs.filter((_, xi) =>
        (prev.querySelector(`[data-si="${si}"][data-xi="${xi}"]`) || {}).checked) }))
      .filter((s) => s.songs.length);
    const close = () => back.remove();
    ta.addEventListener('input', refresh);
    back.querySelector('.pv-imp-file').addEventListener('click', async () => {
      try {
        const p = await window.api.dialog.openFile([{ name: 'Song lists', extensions: ['txt', 'text', 'md', 'csv'] }]);
        if (!p) return;
        const text = await window.api.fs.readText(Array.isArray(p) ? p[0] : p);
        ta.value = String(text || ''); refresh();
      } catch (e) { window.__toast && window.__toast('⚠️ Could not read that file: ' + (e.message || e), 'error'); }
    });
    back.querySelector('.pv-ask-cancel').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    back.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }, true);
    okBtn.addEventListener('click', () => {
      const r = addSongList(picked(), { playlistName: plEl.value });
      close();
      window.__toast && window.__toast(
        `🎵 ${r.songs} song${r.songs > 1 ? 's' : ''} added in ${r.sets} set${r.sets > 1 ? 's' : ''} — open one and paste its words when you have them.`, 'good', 8000);
    });
    setTimeout(() => ta.focus(), 0);
    return back;
  }

  /** Write the library (or just this service) out as a text file. */
  async function exportSongs({ playlistOnly } = {}) {
    const text = exportSongsText({ playlistOnly });
    if (!text.trim()) { window.__toast && window.__toast('Nothing to export yet.', 'error'); return null; }
    const pl = pv.playlists.find((p) => p.id === pv.playlistId);
    const base = playlistOnly && pl ? (pl.name || 'service') : 'song-library';
    try {
      const p = await window.api.dialog.saveFile(base.replace(/[^\w -]+/g, '') + '.txt',
        [{ name: 'Text', extensions: ['txt'] }]);
      if (!p) return null;
      await window.api.fs.writeText(p, text);
      window.__toast && window.__toast('💾 Saved to ' + String(p).split(/[\\/]/).pop() + ' — it reads straight back in with 📥 Import.', 'good', 7000);
      return p;
    } catch (e) {
      window.__toast && window.__toast('⚠️ Could not save: ' + (e.message || e), 'error');
      return null;
    }
  }

  /**
   * Which export — and it has to be ASKED, not hidden behind a modifier key.
   *
   * The two are genuinely different files. THIS SERVICE carries the sets,
   * because a set is a property of the running order and not of a song. THE
   * WHOLE LIBRARY carries every song you own and no sets, because a library has
   * no running order to divide. Someone asking to "export my songs" wants one
   * or the other and there is no way to guess which.
   */
  function openExportSongs() {
    const pl = pv.playlists.find((p) => p.id === pv.playlistId);
    const nItems = pl ? (pl.items || []).length : 0;
    const nDocs = (pv.presentations || []).length;
    const back = document.createElement('div');
    back.className = 'pv-ask-back';
    back.innerHTML =
      `<div class="pv-ask" role="dialog" aria-modal="true">
         <p class="pv-ask-msg"><b>Export your songs</b><br>
           <span class="muted small">Saved as a plain text file you can keep, email, or read straight back in with <b>📥 Import</b>.</span></p>
         <div class="pv-exp-picks">
           <button class="pv-exp-pick" data-only="1"${nItems ? '' : ' disabled'}>
             <b>This service — ${esc(pl ? pl.name : 'no playlist open')}</b>
             <span class="muted small">${nItems} item${nItems === 1 ? '' : 's'}, in order, with their sets</span>
           </button>
           <button class="pv-exp-pick" data-only="0"${nDocs ? '' : ' disabled'}>
             <b>My whole song library</b>
             <span class="muted small">All ${nDocs} song${nDocs === 1 ? '' : 's'} — a backup. Sets belong to a service, so they are not included.</span>
           </button>
         </div>
         <div class="pv-ask-btns"><button class="pv-ask-cancel">Cancel</button></div>
       </div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector('.pv-ask-cancel').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    back.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }, true);
    $$('.pv-exp-pick', back).forEach((b) => b.addEventListener('click', async () => {
      close();
      await exportSongs({ playlistOnly: b.dataset.only === '1' });
    }));
    return back;
  }

  function newDoc(name, kind) {
    const d = { id: uid(), name: name || 'Untitled', kind: kind || 'song', lookId: pv.lookId, updated: Date.now(), slides: [mkSlide('Verse 1', [''])] };
    pv.presentations.unshift(d); saveDoc(d);
    pv.docId = d.id; pv.slideIx = 0;
    renderLibrary(); renderSlides(); renderMonitors();
    setTimeout(() => { const n = $('#pvDocName'); if (n) { n.focus(); n.select(); } }, 0);
    return d;
  }
  function openDoc(id) {
    flushSaves();          // whatever was being edited is finished with
    pv.docId = id; pv.slideIx = 0;
    const d = doc();
    if (d && d.lookId && pv.looks.some((l) => l.id === d.lookId)) { pv.lookId = d.lookId; syncLookUi(); }
    renderLibrary(); renderPlaylistItems(); renderSlides(); renderMonitors();
  }
  function deleteDoc(id) {
    const d = pv.presentations.find((p) => p.id === id); if (!d) return;
    if (!window.confirm(`Delete "${d.name}"? This can't be undone.`)) return;
    pv.presentations = pv.presentations.filter((p) => p.id !== id);
    pv.playlists.forEach((pl) => { pl.items = (pl.items || []).filter((it) => it.presentationId !== id); });
    // A save still waiting its turn would put this song straight back after the
    // delete had already gone through. Drop it, then let the rest out.
    _dirtyDocs.delete(id);
    flushSaves();
    window.api.present.deletePresentation(id).catch(() => {});
    if (pv.docId === id) pv.docId = pv.presentations[0] && pv.presentations[0].id;
    renderLibrary(); renderPlaylists(); renderPlaylistItems(); renderSlides();
  }

  /* ============================ going live ============================ */
  /**
   * The one and only path to the projector. Everything — clicking a slide,
   * arrow keys, Bible "send live", black, clear — ends up here, which is why
   * the operator's Live monitor can never show something different from the
   * wall.
   */
  function live(i, mode) {
    const d = doc();
    const wasBg = pv._liveBgSig;
    if (mode) pv.outMode = mode;
    else if (i != null) {
      // A slide from the Library takes the screen back off a verse that was
      // being read straight out of the Bible panel.
      pv.verseCue = null;
      pv.outMode = 'slide'; pv.liveDocId = d && d.id; pv.liveIx = i; pv.slideIx = i;
    }
    const st = liveState();
    window.api.present.set(st).catch(() => {});
    // Markers belong to the clip, so they are (re-)armed only when the clip
    // itself changes — advancing a lyric slide over a running loop must not
    // restart its markers from zero.
    const bg = st.layers.background;
    const sig = bg ? [bg.type, bg.value].join('|') : '';
    if (sig !== wasBg) { pv._liveBgSig = sig; armMarkers(bg); }
    if (i != null) fireSlideAudio(d && d.slides[i]);
    renderSlides(); renderMonitors(); renderClearPalette(); renderAudioLinks();
  }

  /* ---------------------- making "live" mean LIVE ----------------------
   * live() decides WHAT is on; it has never opened the screen it goes to. That
   * was the bug behind "Go Live does nothing": press it with no output window
   * open and the state is pushed perfectly to nobody — the projector stays
   * black and the app says nothing about why.
   *
   * So every deliberate cue from the operator (the Go Live button, Enter,
   * clicking a slide in Show mode, ◀ ▶, Bible "Send live") now goes through
   * cue(), which makes sure there is a screen for it to land on. Automatic
   * re-pushes — a re-render keeping the projector honest, a look change, a
   * clear — still use live()/pushLive() and never pop a window open on their own.
   */
  /** Is there anywhere for the picture to actually go? (stage is not a projector) */
  function hasAudienceOutput() {
    return !!(pv.outputs.audience || (pv.outputList || []).some((o) => o.role !== 'stage'));
  }
  /**
   * Open the main projector output for a cue. Returns true if something is now
   * showing the picture.
   *
   * The one-screen case matters: fullscreen + alwaysOnTop + focusable:false on
   * the only monitor buries the studio under a window the operator cannot click
   * away or Esc out of. On a single screen we open a MOVABLE window instead and
   * say so; plug the projector in and it goes fullscreen there by itself.
   *
   * Only ever ONE open in flight. Arrowing through four slides before the window
   * has finished loading must not fire four opens — presenter.open() destroys and
   * re-creates the window each time, so that would flash the projector black
   * three times in front of the room.
   */
  function ensureAudienceOutput() {
    if (hasAudienceOutput()) return Promise.resolve(true);
    if (pv._openingOutput) return pv._openingOutput;
    pv._openingOutput = (async () => {
      // A projector plugged in after the app started is only in the CURRENT state.
      await refreshOutputs();
      if (hasAudienceOutput()) return true;
      const ds = (pv.outputs && pv.outputs.displays) || [];
      if (!ds.length) {
        window.__toast && window.__toast('⚠️ No screen found to project onto. Connect the projector or TV, then press Go Live again.', 'error', 7000);
        return false;
      }
      /*
       * "Only one screen" is often a LIE the OS told us.
       *
       * A projector on a Windows laptop arrives in Duplicate — one desktop on
       * two panels — so the display list honestly holds one entry while the
       * projector sits there showing a copy of the studio. Saying "only one
       * screen was found, drag the window onto the projector" to someone whose
       * projector is plainly plugged in is worse than useless. Name the real
       * problem and put the one-click fix in front of them; the output still
       * opens, so nothing is left dark while they read.
       */
      const adv = screenAdvice();
      if (ds.length < 2 && adv.state !== 'ok') {
        toggleScreenMenu(true);
        window.__toast && window.__toast('⚠️ ' + adv.headline + '. ' + (adv.canExtend
          ? 'Press “' + adv.action + '” in the Screens panel and the slides go straight onto it.'
          : (adv.macDetail || '')), 'error', 12000);
      }
      // Which screen. Unless the operator picked one from the dropdown, the
      // projector is never the screen they are working on when there is another
      // one to use. This is not hypothetical: plug the HDMI in AFTER opening the
      // app and pv.displayId is still the laptop — going fullscreen there would
      // bury the studio under a window that can't be focused or closed.
      const mine = ds.find((d) => d.primary);
      const valid = pv.displayId && ds.some((d) => d.id === pv.displayId);
      const onOperatorsScreen = valid && mine && pv.displayId === mine.id;
      if (!valid || (onOperatorsScreen && !pv.displayPicked && ds.length > 1)) {
        pv.displayId = (pv.outputs && pv.outputs.suggested)
          || ((ds.find((d) => !d.primary) || ds[0]).id);
      }
      const windowed = ds.length < 2;
      try {
        await window.api.present.open('audience', pv.displayId, windowed, 'main');
        await refreshOutputs();
        window.__toast && window.__toast(windowed
          ? '🖥 Live — only one screen was found, so the output opened in a window you can drag onto the projector. Connect a second screen and it fills it automatically.'
          : '🖥 Live on ' + ((ds.find((d) => d.id === pv.displayId) || {}).label || 'the projector') + '.', 'good', 7000);
        return hasAudienceOutput();
      } catch (e) {
        window.__toast && window.__toast('⚠️ Could not open the projector output: ' + (e.message || e), 'error', 8000);
        return false;
      }
    })().finally(() => { pv._openingOutput = null; });
    return pv._openingOutput;
  }
  /**
   * A deliberate cue.
   *
   * The order here is deliberate and load-bearing: the slide goes live FIRST,
   * synchronously, and only then do we go and open a screen if there wasn't one.
   * Cueing during a service has to be instant — putting an IPC round-trip in
   * front of every slide change would make the arrow keys lag the worship leader.
   * Nothing is lost by opening second: main re-pushes the live state to an output
   * as it finishes loading, so a window opened a moment later comes up already
   * showing this cue.
   */
  function cue(i, mode) {
    live(i, mode);
    if (!hasAudienceOutput()) ensureAudienceOutput();
  }
  /**
   * The Go Live button (and Enter). It has one job and it now does it: whatever
   * is selected ends up on the projector, opening the projector if need be, and
   * saying plainly what happened when it can't.
   */
  async function goLive() {
    const d = doc();
    if (!d || !(d.slides || []).length) {
      window.__toast && window.__toast('Nothing to send yet — open a presentation from the Library, press ＋ Slide, or find a verse in the Bible panel.', 'error', 7000);
      return false;
    }
    // Nothing picked yet is not a reason to do nothing — start at the top.
    if (pv.slideIx < 0 || pv.slideIx >= d.slides.length) pv.slideIx = 0;
    live(pv.slideIx);                       // on the screen now, not after a round trip
    const el = $(`#pvSlides .pv-slide[data-slide="${pv.slideIx}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
    const ok = await ensureAudienceOutput(); // …and give it a screen if it hasn't got one
    // The two ways a perfectly correct cue still shows a black wall. Both are
    // deliberate controls with their own lit buttons, so Go Live does not undo
    // them behind the operator's back — but it does say which one is holding the
    // picture back, instead of leaving them to hunt for it mid-service.
    if (ok && pv.blackout) {
      window.__toast && window.__toast('⬛ The slide is live, but the screen is BLACKED OUT — press ⬛ (or B) to show it.', 'error', 8000);
    } else if (ok && pv.cleared && pv.cleared.slide) {
      window.__toast && window.__toast('The slide is live, but the WORDS layer is cleared — press its button in the clear bar to bring it back.', 'error', 8000);
    }
    return ok;
  }
  /**
   * Build the seven-layer state that every output draws.
   *
   * The important move here: a slide's background goes on the BACKGROUND layer,
   * not inside the slide. That is what lets the lyrics be cleared, changed or
   * transitioned while the motion loop underneath keeps playing untouched —
   * the single most-used control on a Sunday.
   */
  function liveState() {
    const d = doc();
    /*
     * A verse read straight from the Bible panel outranks the Library.
     *
     * Scripture does not want to live in the running order: a chapter dropped
     * into the middle of a service is thirty-six slides nobody will ever use
     * again, and the operator has to delete them afterwards. `pv.verseCue` is
     * the passage on the screen right now, built on the fly and belonging to
     * nothing — the Library is untouched, and one click on another verse moves
     * the screen.
     */
    const vc = pv.verseCue;
    const s = vc ? verseSlide(vc.ix)
      : ((pv.outMode === 'slide' && d) ? d.slides[pv.liveIx] : null);
    const nx = vc ? verseSlide(vc.ix + 1)
      : ((d && pv.liveIx >= 0) ? d.slides[pv.liveIx + 1] : null);
    const lk = lookFor(s);
    return {
      layers: {
        background: bgFor(s, lk),
        media: pv.layers.media,
        slide: s ? payload(s) : (pv.outMode === 'clear' ? null : null),
        announcement: pv.announcement,
        props: pv.props.filter((p) => !p.hidden),
        mask: pv.layers.mask,
      },
      cleared: Object.assign({}, pv.cleared),
      transitions: Object.assign({}, pv.transitions),
      blackout: !!pv.blackout,
      easyView: !!pv.easyView,
      look: lk,
      outputLooks: outputLookMap(),
      outputMaps: Object.assign({}, pv.outputMaps),
      next: nx ? payload(nx) : null,
      timers: pv.timers,
      message: pv.message,
      stageMessage: pv.stageMessage || '',
      stageLayout: stageLayout(),
      outputs: pv.outputList,
    };
  }
  /** The arrangement each confidence monitor is currently showing. */
  function stageLayout() {
    const list = pv.stageLayouts && pv.stageLayouts.length ? pv.stageLayouts : DEFAULT_STAGE_LAYOUTS;
    return list.find((l) => l.id === pv.stageLayoutId) || list[0];
  }
  /** Whatever should be behind the words: the slide's own bg, else the Look's. */
  function bgFor(s, lk) {
    if (s && s.bg && s.bg.type) return withPlayback(Object.assign({ fit: 'cover' }, lk && lk.bg, s.bg));
    if (pv.layers.background) return withPlayback(pv.layers.background);
    return (lk && lk.bg) ? withPlayback(Object.assign({ fit: 'cover' }, lk.bg)) : { type: 'color', value: '#000000' };
  }
  /**
   * Pause and Loop, carried on the background itself.
   *
   * They deliberately do NOT form part of the layer's signature (see output.js):
   * a video that repainted every time the operator pressed pause would jump back
   * to its first frame, which is the opposite of pausing. The output reconciles
   * the element it already has instead.
   */
  function withPlayback(bg) {
    if (!bg || bg.type !== 'video') return bg;
    return Object.assign({}, bg, { paused: !!pv.bgPaused, loop: pv.bgLoop !== false });
  }
  /**
   * The video bar appears only while a video is on the screen.
   *
   * It used to sit at the bottom of the Media panel, under seventy-four
   * background tiles — which is the same as not existing. Beside the monitors
   * it is where the operator is already looking when they want to hold a loop.
   */
  function syncVidPlayback() {
    const bar = $('#pvVidBar'); if (!bar) return;
    const bg = liveState().layers.background;
    const isVideo = !!(bg && bg.type === 'video');
    bar.classList.toggle('hidden', !isVideo);
    if (!isVideo) return;
    const btn = $('#pvVidPlay');
    btn.textContent = pv.bgPaused ? '▶ Play' : '⏸ Pause';
    btn.classList.toggle('on', !!pv.bgPaused);
    $('#pvVidLoop').classList.toggle('on', pv.bgLoop !== false);
    const clip = (window.BgVideos && window.BgVideos.CLIPS || [])
      .find((c) => String(bg.value || '').replace(/\\/g, '/').endsWith('/' + c.id + '.mp4'));
    $('#pvVidName').textContent = clip ? clip.name : String(bg.value || '').split(/[\\/]/).pop();
  }
  /** Per-output Look overrides, resolved from ids to real Look objects. */
  function outputLookMap() {
    const out = {};
    for (const [id, lookId] of Object.entries(pv.outputLooks || {})) {
      const l = pv.looks.find((x) => x.id === lookId);
      if (l) out[id] = l;
    }
    return out;
  }
  /*
   * What one slide looks like to everything downstream — the projector, the
   * stage screen, the NDI feed, the phone view.
   *
   * `theme` is the per-slide override the RENDERER reads (slide-render.js:
   * `theme(Object.assign({}, look, s.theme))`). Two things write one:
   *   • the slide editor's type controls, on `s.theme`,
   *   • the Bible panel's verse styling, on `s.look` at cue time.
   * This used to forward only the second, so a slide styled in the editor was
   * correct in the library grid — which paints the slide object directly — and
   * plain on the actual screen. Both are merged, with the verse override last
   * because it is applied deliberately at the moment of cueing.
   */
  const payload = (s) => {
    const th = Object.assign({}, s.theme || null, s.look || null);
    return {
      lines: s.lines || [], footer: s.footer || '', group: s.group || '',
      notes: s.notes || '', chords: s.chords || null,
      theme: Object.keys(th).length ? th : null,
    };
  };
  /** Re-send the current cue without changing it (after a clear, prop, timer…). */
  const pushLive = () => { window.api.present.set(liveState()).catch(() => {}); renderMonitors(); renderClearPalette(); };

  /**
   * Escape, in the order an operator means it.
   *
   * "Close the slide with Esc" is about the picture on the wall, not about a
   * mode inside the editor — so an open dialog goes first, then the projector
   * itself, and only when nothing is being shown does Esc fall back to leaving
   * edit mode. (Esc pressed ON the projector window closes it directly; see
   * presenter.js.)
   */
  async function escape() {
    const modal = $$('.cap-modal').find((m) => !m.classList.contains('hidden'));
    if (modal) { modal.classList.add('hidden'); return 'modal'; }
    if (hasAudienceOutput() || pv.outputs.stage) {
      await window.api.present.close().catch(() => {});
      await refreshOutputs();
      renderMonitors();
      window.__toast && window.__toast('⎋ Screens closed. Press Go Live to put them back.', 'good');
      return 'outputs';
    }
    if (pv.mode === 'edit') { setMode('show'); return 'edit'; }
    return 'none';
  }
  /* ================= scripture straight to the screen =================
   *
   * Clicking a verse in the panel puts it on the projector. Nothing is added to
   * the Library, nothing has to be tidied up afterwards, and the arrow keys then
   * walk the passage verse by verse — which is what a reading actually is.
   *
   * The slides are built by the SAME scriptureSlides() the ＋ Add button uses,
   * so "Verses" and "Reference" mean exactly what they mean everywhere else,
   * and a verse that is put on the screen looks identical to one that was added
   * to a presentation.
   */
  /**
   * One chunk of the passage, carrying whatever background the verses are on.
   *
   * `pv.verseBg` belongs to the READING, not to any slide — it survives looking
   * up the next passage, which is what a church wants: set the picture once at
   * the start of the service and every verse after it lands on the same thing.
   */
  function verseSlide(ix) {
    const c = pv.verseCue;
    const s = c && c.slides[ix];
    if (!s) return null;
    const out = Object.assign({}, s);
    if (pv.verseBg) out.bg = pv.verseBg;
    if (pv.verseTheme && Object.keys(pv.verseTheme).length) out.look = Object.assign({}, s.look, pv.verseTheme);
    return (out.bg || out.look) ? out : s;
  }
  /**
   * Where scripture sits on the screen, and how big it is.
   *
   * A reading and a song want different things — a verse is prose and often
   * wants to start at the top so long ones do not creep off the bottom, while
   * lyrics want the middle. This overrides the Look for VERSES only, so setting
   * one does not move the other. `↺` drops the override and the Look decides
   * again.
   */
  function setVerseFormat(patch) {
    pv.verseTheme = patch === null ? null : Object.assign({}, pv.verseTheme, patch);
    savePref();
    syncVerseFormat();
    if (pv.verseCue) live(null, 'slide'); else renderMonitors();
  }
  function verseSizePx() {
    const t = pv.verseTheme || {};
    return t.sizePx || (look() || {}).sizePx || window.SlideRender.DEFAULT_THEME.sizePx;
  }
  function syncVerseFormat() {
    const t = pv.verseTheme || {};
    const base = look() || {};
    $$('[data-vfvalign]').forEach((b) => b.classList.toggle('on', b.dataset.vfvalign === (t.valign || base.valign || 'center')));
    $$('[data-vfalign]').forEach((b) => b.classList.toggle('on', b.dataset.vfalign === (t.align || base.align || 'center')));
    const reset = $('#pvVfReset');
    if (reset) reset.classList.toggle('on', !!(pv.verseTheme && Object.keys(pv.verseTheme).length));
  }
  function chunkOf(res, verseNo) {
    const per = parseInt($('#pvVps').value, 10);
    const at = (res.verses || []).findIndex((v) => v.verse === verseNo);
    if (at < 0) return 0;
    return per === 0 ? 0 : Math.floor(at / Math.max(1, per));
  }
  /** Put the passage on the screen, starting at the chunk holding `verseNo`. */
  function sendVerseLive(verseNo) {
    const res = pv.bibleResult;
    if (!res || !res.verses.length) return null;
    const slides = scriptureSlides(res);
    if (!slides.length) return null;
    /*
     * A DIFFERENT PASSAGE IS NOT A CONTINUING READING.
     *
     * Putting something new on the screen clears what has been heard. Without
     * this the tape still holds a minute of the last reading, and the first
     * look-back after the change would judge the new verse against words said
     * before it was up — which at best turns the page instantly and at worst
     * turns it twice.
     */
    if (!pv.verseCue || pv.verseCue.reference !== res.reference) tapeReset();
    pv.verseCue = {
      slides, ix: clamp(chunkOf(res, verseNo), 0, slides.length - 1),
      reference: res.reference,
      verses: res.verses.map((v) => v.verse),
      per: parseInt($('#pvVps').value, 10),
    };
    cueVerseChunk(pv.verseCue.ix);
    return pv.verseCue;
  }
  /** Move within the passage that is already live. */
  function cueVerseChunk(ix) {
    const c = pv.verseCue; if (!c || !c.slides[ix]) return;
    c.ix = ix;
    live(null, 'slide');                     // re-push; liveState reads verseCue
    if (!hasAudienceOutput()) ensureAudienceOutput();
    markLiveVerses();
  }
  /** Light up the verses that are on the screen, and keep them in view. */
  function markLiveVerses() {
    const box = $('#pvBibleResults'); if (!box) return;
    const c = pv.verseCue;
    const res = pv.bibleResult;
    const on = c && res && c.reference === res.reference;
    let first = null;
    $$('.pv-verse', box).forEach((el) => {
      const n = parseInt(el.dataset.verse, 10);
      const live = !!(on && chunkOf(res, n) === c.ix);
      el.classList.toggle('live', live);
      if (live && !first) first = el;
    });
    if (first) first.scrollIntoView({ block: 'nearest' });
  }

  /** Step through the ACTIVE ARRANGEMENT, not the raw slide order. */
  function step(delta) {
    // A passage on the screen steps through ITS verses, not the Library's slides.
    if (pv.verseCue) {
      const n = pv.verseCue.slides.length;
      const at = clamp(pv.verseCue.ix + delta, 0, n - 1);
      if (at !== pv.verseCue.ix) cueVerseChunk(at);
      return;
    }
    const d = doc(); if (!d || !d.slides.length) return;
    const order = activeOrder();
    const from = (pv.liveDocId === d.id && pv.liveIx >= 0) ? pv.liveIx : pv.slideIx;
    const at = order.indexOf(from < 0 ? order[0] : from);
    const nextPos = clamp((at < 0 ? 0 : at) + delta, 0, order.length - 1);
    const next = order[nextPos];
    if (next == null) return;
    cue(next);
    const el = $(`#pvSlides .pv-slide[data-slide="${next}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /**
   * The Live monitor draws the REAL composite — every layer, honouring clears
   * and blackout — not just the slide. If it only showed the slide, an operator
   * could stare at correct lyrics while the room saw a stale prop or a message
   * still up.
   */
  function renderMonitors() {
    const d = doc();
    const st = liveState();
    window.SlideRender.paintComposite($('#pvLiveScreen'), st, st.look);
    // Next follows whatever is actually live — during a reading that is the
    // next VERSE, not the next slide in a presentation nobody is looking at.
    const nextSlide = pv.verseCue
      ? verseSlide(pv.verseCue.ix + 1)
      : (d ? d.slides[(pv.liveIx >= 0 ? pv.liveIx : pv.slideIx) + 1] : null);
    window.SlideRender.paintComposite($('#pvNextScreen'), {
      layers: { background: bgFor(nextSlide, lookFor(nextSlide)), slide: nextSlide ? payload(nextSlide) : null },
    }, lookFor(nextSlide));

    syncVidPlayback();
    const dot = $('#pvLiveDot');
    const on = pv.outputs.audience || (pv.outputList || []).some((o) => o.role !== 'stage');
    const clean = pv.outMode === 'slide' && !pv.blackout && !anyCleared();
    dot.classList.toggle('on', on && clean);
    dot.classList.toggle('warn', on && !clean);
    $('#pvOutState').textContent = !on ? 'No output'
      : pv.blackout ? 'Blacked out'
      : anyCleared() ? 'Partly cleared'
      : pv.outMode === 'slide' ? 'On screen' : 'Cleared';
    $('#pvBlack').classList.toggle('on', !!pv.blackout);
  }
  /** Header line of the Music popover: which song these buttons will act on,
   *  and what key it is in — transposing blind is how a band ends up in E♭. */
  function syncMusicPanel() {
    const key = $('#pvSongKey'); if (!key) return;
    const d = doc();
    if (!d) { key.textContent = 'No song open'; return; }
    key.textContent = d.songKey ? `${d.name} · key of ${d.songKey}` : d.name || 'Untitled';
  }
  const anyCleared = () => Object.values(pv.cleared).some(Boolean);

  /* ================= clear palette =================
   * ProPresenter's most-used strip. Each layer clears on its own and lights up
   * red while it is cleared, so the operator can always see at a glance WHY the
   * screen doesn't look like the slide they're on. */
  /*
   * The seven layers, in the order they matter on a Sunday.
   *
   * `more` marks the three that a normal service never touches — props,
   * messages and the mask are all things you have to have DELIBERATELY put up
   * before there is anything to clear. They sit behind ⋯ More so the bar in
   * front of the operator holds the four buttons they actually press, while the
   * number keys 1-7 still reach all seven.
   */
  const CLEAR_LAYERS = [
    { id: 'background', label: 'Background', icon: '🎞' },
    { id: 'media', label: 'Media', icon: '🖼' },
    { id: 'slide', label: 'Slide', icon: '📄' },
    { id: 'announcement', label: 'Announce', icon: '📢', more: true },
    { id: 'props', label: 'Props', icon: '🏷', more: true },
    { id: 'messages', label: 'Messages', icon: '💬', more: true },
    { id: 'mask', label: 'Mask', icon: '⬛', more: true },
  ];
  function renderClearPalette() {
    const el = $('#pvClearPalette'); if (!el) return;
    // A cleared layer must never hide behind More — that is the one state the
    // operator has to be able to see and undo at a glance.
    const open = !!pv.clearMore || CLEAR_LAYERS.some((l) => l.more && pv.cleared[l.id]);
    /*
     * Park Easy View out of the palette BEFORE the rebuild below.
     *
     * It is a real element that gets moved into the More group, and the next
     * line replaces the palette's innerHTML — which would delete it outright,
     * along with its listener and its on/off state. It is put back at the end.
     */
    const easyHome = $('.pv-clearbar-right');
    const easyBtn = $('#pvEasy');
    if (easyBtn && easyHome && easyBtn.parentElement === el) easyHome.insertBefore(easyBtn, easyHome.firstChild);
    const btn = (l) =>
      `<button class="pv-clear${pv.cleared[l.id] ? ' on' : ''}" data-clear="${l.id}"
         title="Clear the ${l.label.toLowerCase()} layer — everything else keeps running">
        <span class="pv-clear-ico">${l.icon}</span><span class="pv-clear-lbl">${l.label}</span></button>`;
    el.innerHTML = CLEAR_LAYERS.filter((l) => !l.more).map(btn).join('')
      + (open ? CLEAR_LAYERS.filter((l) => l.more).map(btn).join('') : '')
      + `<button class="pv-clear pv-clear-more${open ? ' on' : ''}" data-clearmore="1"
          title="${open ? 'Hide' : 'Show'} props, messages and the mask">
          <span class="pv-clear-ico">⋯</span><span class="pv-clear-lbl">${open ? 'Less' : 'More'}</span></button>`
      + `<button class="pv-clear pv-clear-all${anyCleared() || pv.blackout ? ' on' : ''}" data-clear="__all"
          title="Clear everything">✕ All</button>`;
    $$('[data-clear]', el).forEach((b) => b.addEventListener('click', () => toggleClear(b.dataset.clear)));
    const more = $('[data-clearmore]', el);
    if (more) more.addEventListener('click', () => { pv.clearMore = !open; savePref(); renderClearPalette(); });
    /*
     * Easy View lives in the More group too.
     *
     * It is a reading aid for the operator, not a control over what the room
     * sees, so it does not belong in the four buttons that are pressed during a
     * service. The element itself is MOVED rather than re-created — it has its
     * own listener and its own on/off state, and duplicating it would give two
     * buttons claiming to be the same switch.
     */
    if (easyBtn) {
      if (open) el.insertBefore(easyBtn, more);
      easyBtn.classList.toggle('hidden', !open);
    }
    /* 🎵 Music rides with the More group for the same reason: arrangements,
     * transposing and chord charts are things you set up before the doors
     * open, never mid-song. It stays in the right-hand strip rather than being
     * moved inline — it is a popover, and popovers need a stable anchor. */
    const music = $('#pvMusicDetails');
    if (music) {
      music.classList.toggle('hidden', !open);
      if (!open) music.open = false;
    }
    syncMusicPanel();
    const tr = $('#pvTransRow');
    if (tr) {
      tr.innerHTML = CLEAR_LAYERS.map((l) =>
        `<label title="Transition for the ${l.label.toLowerCase()} layer">${l.icon}
          <select data-trans="${l.id}">${window.Layers.TRANSITION_LIST.map((t) =>
            `<option value="${t.id}"${pv.transitions[l.id] === t.id ? ' selected' : ''}>${t.name}</option>`).join('')}</select>
        </label>`).join('');
      $$('[data-trans]', tr).forEach((s) => s.addEventListener('change', () => {
        pv.transitions[s.dataset.trans] = s.value; savePref(); pushLive();
      }));
    }
  }
  function toggleClear(id) {
    if (id === '__all') {
      const on = !(anyCleared() || pv.blackout);
      for (const l of CLEAR_LAYERS) pv.cleared[l.id] = on;
      if (!on) pv.blackout = false;
    } else pv.cleared[id] = !pv.cleared[id];
    pushLive(); renderClearPalette();
  }

  /* ================= props ================= */
  function renderProps() {
    const el = $('#pvPropList'); if (!el) return;
    el.innerHTML = pv.props.length ? pv.props.map((p, i) => `
      <div class="lib-row${p.hidden ? '' : ' sel'}">
        <span class="lib-row-icon">${p.type === 'image' ? '🖼' : '🏷'}</span>
        <span class="lib-row-main"><b>${esc(p.name || p.value || 'Prop')}</b>
          <span class="muted small">${p.hidden ? 'hidden' : 'ON SCREEN'}</span></span>
        <button class="lib-mini" data-proptoggle="${i}" title="Show / hide">${p.hidden ? '👁' : '🚫'}</button>
        <button class="lib-mini danger" data-propdel="${i}" title="Delete">🗑</button>
      </div>`).join('')
      : '<p class="muted small pv-empty">No props. A prop is a logo or lower third that stays on screen <b>across slide changes</b>.</p>';
    $$('[data-proptoggle]', el).forEach((b) => b.addEventListener('click', () => {
      pv.props[+b.dataset.proptoggle].hidden = !pv.props[+b.dataset.proptoggle].hidden;
      saveShow(); renderProps(); pushLive();
    }));
    $$('[data-propdel]', el).forEach((b) => b.addEventListener('click', () => {
      pv.props.splice(+b.dataset.propdel, 1); saveShow(); renderProps(); pushLive();
    }));
  }
  async function addProp(kind) {
    if (kind === 'image') {
      let p; try { p = await window.api.dialog.openFile([{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]); } catch (e) { p = null; }
      if (!p) return;
      pv.props.push({ id: uid(), type: 'image', name: p.split(/[\\/]/).pop(), value: p, x: 0.04, y: 0.04, w: 0.16, opacity: 1 });
    } else {
      const text = await ask('Lower-third text:', 'Pastor David Richman'); if (!text) return;
      pv.props.push({ id: uid(), type: 'text', name: text.slice(0, 28), value: text, x: 0.05, y: 0.78, w: 0.5, size: 52, color: '#ffffff' });
    }
    saveShow(); renderProps(); pushLive();
  }

  /* ================= messages ================= */
  const MSG_TEMPLATES = [
    { id: 'nursery', name: 'Nursery call', body: 'Parent of child {number}, please come to the nursery.', tokens: ['number'] },
    { id: 'parking', name: 'Parking', body: 'Would the owner of the {colour} {car} please move it — you are blocking the exit.', tokens: ['colour', 'car'] },
    { id: 'welcome', name: 'Welcome', body: 'Welcome, {name}! We are so glad you are here.', tokens: ['name'] },
    { id: 'custom', name: 'Custom', body: '{text}', tokens: ['text'] },
  ];
  function renderMessages() {
    const el = $('#pvMsgList'); if (!el) return;
    el.innerHTML = MSG_TEMPLATES.map((t) => `
      <button class="pv-hit" data-msgtpl="${t.id}">
        <span class="pv-hit-ref">${esc(t.name)}</span>
        <span class="pv-hit-text">${esc(t.body)}</span>
      </button>`).join('');
    $$('[data-msgtpl]', el).forEach((b) => b.addEventListener('click', () => showMessage(b.dataset.msgtpl)));
    $('#pvMsgClear').classList.toggle('on', !!pv.message);
  }
  /** Fill a template's tokens and put it on screen for a set time. */
  async function showMessage(tplId) {
    const t = MSG_TEMPLATES.find((x) => x.id === tplId); if (!t) return;
    let body = t.body;
    for (const token of t.tokens) {
      const v = await ask(`${t.name} — ${token}:`, '');
      if (v == null) return;
      body = body.split('{' + token + '}').join(v);
    }
    const secs = parseInt(($('#pvMsgSecs') || {}).value, 10) || 0;
    pv.message = { text: body, position: ($('#pvMsgPos') || {}).value || 'bottom', size: 52 };
    pushLive(); renderMessages();
    clearTimeout(pv._msgTimer);
    if (secs > 0) pv._msgTimer = setTimeout(() => { pv.message = null; pushLive(); renderMessages(); }, secs * 1000);
  }
  function clearMessage() { clearTimeout(pv._msgTimer); pv.message = null; pushLive(); renderMessages(); }

  /* ================= timers & clocks ================= */
  function renderTimers() {
    const el = $('#pvTimerList'); if (!el) return;
    el.innerHTML = pv.timers.length ? pv.timers.map((t, i) => `
      <div class="lib-row${t.running ? ' sel' : ''}">
        <span class="lib-row-icon">${t.mode === 'clock' ? '🕐' : t.mode === 'countup' ? '⏱' : '⏳'}</span>
        <span class="lib-row-main"><b>${esc(t.name)}</b>
          <span class="muted small" data-timerval="${t.id}">${window.SlideRender.timerText(t, Date.now())}</span></span>
        ${t.mode === 'clock' ? '' : `<button class="lib-mini" data-timerrun="${i}">${t.running ? '⏸' : '▶'}</button>
        <button class="lib-mini" data-timerreset="${i}" title="Reset">↺</button>`}
        <button class="lib-mini" data-timershow="${i}" title="Show on the projector">${t.onOutput === false ? '👁' : '🚫'}</button>
        <button class="lib-mini danger" data-timerdel="${i}">🗑</button>
      </div>`).join('')
      : '<p class="muted small pv-empty">No timers. Add a countdown for “service starts in…”, a count-up for the sermon, or a wall clock for the stage.</p>';
    $$('[data-timerrun]', el).forEach((b) => b.addEventListener('click', () => toggleTimer(+b.dataset.timerrun)));
    $$('[data-timerreset]', el).forEach((b) => b.addEventListener('click', () => resetTimer(+b.dataset.timerreset)));
    $$('[data-timershow]', el).forEach((b) => b.addEventListener('click', () => {
      const t = pv.timers[+b.dataset.timershow]; t.onOutput = t.onOutput === false;
      saveShow(); renderTimers(); pushLive();
    }));
    $$('[data-timerdel]', el).forEach((b) => b.addEventListener('click', () => {
      pv.timers.splice(+b.dataset.timerdel, 1); saveShow(); renderTimers(); pushLive();
    }));
  }
  async function addTimer(mode) {
    let t;
    if (mode === 'clock') t = { id: uid(), name: 'Wall clock', mode: 'clock', onOutput: false, onStage: true, x: 0.5, y: 0.1, size: 96 };
    else if (mode === 'countup') t = { id: uid(), name: 'Count up', mode: 'countup', running: true, startedAt: Date.now(), onOutput: false, x: 0.5, y: 0.1, size: 110 };
    else {
      const mins = parseFloat(await ask('Count down from how many minutes?', '5'));
      if (!(mins > 0)) return;
      t = { id: uid(), name: `${mins} min countdown`, mode: 'countdown', running: true, endsAt: Date.now() + mins * 60000, durationMs: mins * 60000, onOutput: true, x: 0.5, y: 0.5, size: 200 };
    }
    pv.timers.push(t); saveShow(); renderTimers(); pushLive();
  }
  function toggleTimer(i) {
    const t = pv.timers[i]; if (!t) return;
    const now = Date.now();
    if (t.running) { t.running = false; t.stoppedAt = now; }
    else {
      // resume where it was paused, not from the top
      if (t.mode === 'countdown' && t.stoppedAt) t.endsAt += (now - t.stoppedAt);
      if (t.mode === 'countup' && t.stoppedAt) t.startedAt += (now - t.stoppedAt);
      t.running = true; t.stoppedAt = null;
    }
    saveShow(); renderTimers(); pushLive();
  }
  function resetTimer(i) {
    const t = pv.timers[i]; if (!t) return;
    const now = Date.now();
    if (t.mode === 'countdown') t.endsAt = now + (t.durationMs || 300000);
    if (t.mode === 'countup') t.startedAt = now;
    t.running = true; t.stoppedAt = null;
    saveShow(); renderTimers(); pushLive();
  }
  /** Tick the little readouts in the studio list (the outputs tick themselves). */
  function tickStudioTimers() {
    const now = Date.now();
    $$('[data-timerval]').forEach((el) => {
      const t = pv.timers.find((x) => x.id === el.dataset.timerval);
      if (t) el.textContent = window.SlideRender.timerText(t, now);
    });
  }

  /* ================= announcements ================= */
  function setAnnouncement(text) {
    pv.announcement = text && text.trim() ? { lines: text.split('\n'), valign: 'center' } : null;
    saveShow(); pushLive();
    const b = $('#pvAnnounceOn'); if (b) b.classList.toggle('on', !!pv.announcement);
  }

  /* ================= macros =================
   * One click that does several things at once — the way a service actually
   * runs. "Sermon" = switch to the sermon Look, clear the lyrics, start the
   * 35-minute count-up and fire a MIDI note at the lighting desk. Doing that as
   * four separate clicks mid-service is how mistakes happen. */
  const MACRO_ACTIONS = [
    { id: 'look', label: 'Change Look', arg: 'lookId' },
    { id: 'clear', label: 'Clear a layer', arg: 'layer' },
    { id: 'uncover', label: 'Un-clear a layer', arg: 'layer' },
    { id: 'black', label: 'Blackout on/off', arg: null },
    { id: 'timerStart', label: 'Start / reset a timer', arg: 'timerId' },
    { id: 'timerStop', label: 'Stop a timer', arg: 'timerId' },
    { id: 'message', label: 'Show a message', arg: 'text' },
    { id: 'clearMessage', label: 'Clear the message', arg: null },
    { id: 'prop', label: 'Toggle a prop', arg: 'propIndex' },
    { id: 'goto', label: 'Go to a slide', arg: 'slideIndex' },
    { id: 'midi', label: 'Send MIDI', arg: 'note' },
    { id: 'stageLayout', label: 'Switch stage layout', arg: 'layoutId' },
    { id: 'announce', label: 'Set the announcement', arg: 'text' },
    { id: 'stageMessage', label: 'Message the stage', arg: 'text' },
    { id: 'audioPlay', label: 'Fade in a track', arg: 'trackId' },
    { id: 'audioStop', label: 'Fade out a track', arg: 'trackId' },
    { id: 'audioStopAll', label: 'Fade out all audio', arg: null },
    { id: 'dmx', label: 'Send DMX (Art-Net)', arg: 'universe.channel=value' },
    { id: 'macro', label: 'Run another macro', arg: 'macroId' },
  ];
  function runMacro(id) {
    const m = pv.macros.find((x) => x.id === id); if (!m) return false;
    pv._macroDepth = (pv._macroDepth || 0) + 1;
    pv._macroChain = (pv._macroChain || []).concat([id]);
    for (const step of m.steps || []) {
      try { runStep(step); } catch (e) { /* one bad step must not kill the macro */ }
    }
    pv._macroDepth--;
    if (!pv._macroDepth) pv._macroChain = [];
    saveShow(); renderProps(); renderTimers(); renderClearPalette(); pushLive();
    window.__toast && window.__toast(`⚡ ${m.name}`, 'good', 1800);
    return true;
  }
  function runStep(step) {
    const a = step.action, v = step.value;
    if (a === 'look') { pv.lookId = v; syncLookUi(); renderSlides(); }
    else if (a === 'clear') pv.cleared[v] = true;
    else if (a === 'uncover') pv.cleared[v] = false;
    else if (a === 'black') pv.blackout = !pv.blackout;
    else if (a === 'timerStart') { const i = pv.timers.findIndex((t) => t.id === v); if (i >= 0) resetTimer(i); }
    else if (a === 'timerStop') { const i = pv.timers.findIndex((t) => t.id === v); if (i >= 0 && pv.timers[i].running) toggleTimer(i); }
    else if (a === 'message') pv.message = { text: v, position: 'bottom', size: 52 };
    else if (a === 'clearMessage') pv.message = null;
    else if (a === 'prop') { const p = pv.props[+v]; if (p) p.hidden = !p.hidden; }
    else if (a === 'goto') live(+v);
    else if (a === 'midi') sendMidi(v);
    else if (a === 'stageLayout') setStageLayout(v);
    else if (a === 'announce') setAnnouncement(v);
    else if (a === 'stageMessage') { pv.stageMessage = v || ''; const el = $('#pvStageMsg'); if (el) el.value = pv.stageMessage; }
    else if (a === 'audioPlay') playTrack(v);
    else if (a === 'audioStop') stopTrack(v);
    else if (a === 'audioStopAll') stopAllAudio();
    else if (a === 'dmx') sendDmx(v);
    // A macro can call another one — but not itself, and not in a ring, which
    // would take the whole desk down mid-service.
    else if (a === 'macro') {
      if (pv._macroDepth > 4 || (pv._macroChain || []).includes(v)) return;
      runMacro(v);
    }
  }
  function renderMacros() {
    const el = $('#pvMacroList'); if (!el) return;
    el.innerHTML = pv.macros.length ? pv.macros.map((m) => `
      <div class="lib-row">
        <span class="lib-row-icon">⚡</span>
        <span class="lib-row-main"><b>${esc(m.name)}</b>
          <span class="muted small">${(m.steps || []).length} step${(m.steps || []).length === 1 ? '' : 's'}</span></span>
        <button class="primary-btn small" data-macrorun="${attr(m.id)}">Run</button>
        <button class="lib-mini danger" data-macrodel="${attr(m.id)}">🗑</button>
      </div>`).join('')
      : '<p class="muted small pv-empty">No macros. A macro does several things with one click — change the Look, clear a layer, start a timer, fire MIDI.</p>';
    $$('[data-macrorun]', el).forEach((b) => b.addEventListener('click', () => runMacro(b.dataset.macrorun)));
    $$('[data-macrodel]', el).forEach((b) => b.addEventListener('click', () => {
      pv.macros = pv.macros.filter((m) => m.id !== b.dataset.macrodel); saveShow(); renderMacros();
    }));
  }
  /** Build a macro from the desk's CURRENT state — far easier than a step editor. */
  async function captureMacro() {
    const name = await ask('Name this macro:', 'Sermon'); if (!name) return;
    const steps = [{ action: 'look', value: pv.lookId }];
    for (const l of CLEAR_LAYERS) steps.push({ action: pv.cleared[l.id] ? 'clear' : 'uncover', value: l.id });
    if (pv.message) steps.push({ action: 'message', value: pv.message.text });
    else steps.push({ action: 'clearMessage' });
    pv.macros.push({ id: uid(), name, steps });
    saveShow(); renderMacros();
    window.__toast && window.__toast(`⚡ "${name}" captured from how the desk looks right now.`, 'good', 5000);
  }

  /* ================= MIDI =================
   * Chromium's Web MIDI, so no native module and no driver install. Incoming
   * notes fire macros or step slides (a foot pedal or a lighting desk driving
   * the words); outgoing notes let a macro tell the lighting desk what happened. */
  async function initMidi() {
    if (!navigator.requestMIDIAccess) return false;
    try {
      pv.midi = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) { return false; }
    for (const input of pv.midi.inputs.values()) {
      input.onmidimessage = (msg) => onMidi(msg.data);
    }
    pv.midi.onstatechange = () => {
      for (const input of pv.midi.inputs.values()) input.onmidimessage = (m) => onMidi(m.data);
      renderMidi();
    };
    renderMidi();
    return true;
  }
  function onMidi(data) {
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0, note = data[1], vel = data[2] || 0;
    if (status !== 0x90 || !vel) return;         // note-on only
    if (pv._midiLearn) {
      pv.midiBinds[note] = pv._midiLearn; pv._midiLearn = null;
      saveShow(); renderMidiBinds();
      window.__toast && window.__toast(`🎹 Note ${note} bound.`, 'good');
      return;
    }
    const bind = (pv.midiBinds || {})[note];
    if (!bind) return;
    if (bind === '__next') step(1);
    else if (bind === '__prev') step(-1);
    else if (bind === '__black') { pv.blackout = !pv.blackout; pushLive(); renderClearPalette(); }
    else runMacro(bind);
  }
  function sendMidi(note) {
    if (!pv.midi) return;
    const n = parseInt(note, 10); if (isNaN(n)) return;
    for (const out of pv.midi.outputs.values()) {
      try { out.send([0x90, n & 0x7f, 100]); out.send([0x80, n & 0x7f, 0], performance.now() + 120); } catch (e) {}
    }
  }
  function renderMidiBinds() {
    const el = $('#pvMidiBinds'); if (!el) return;
    const binds = Object.entries(pv.midiBinds || {});
    el.innerHTML = binds.length ? binds.map(([note, to]) => {
      const m = pv.macros.find((x) => x.id === to);
      const label = m ? '⚡ ' + m.name : to.replace(/^__/, '');
      return `<div class="lib-row"><span class="lib-row-icon">🎹</span>
        <span class="lib-row-main"><b>Note ${esc(note)}</b><span class="muted small">${esc(label)}</span></span>
        <button class="lib-mini danger" data-mididel="${esc(note)}">🗑</button></div>`;
    }).join('') : '';
    $$('[data-mididel]', el).forEach((b) => b.addEventListener('click', () => {
      delete pv.midiBinds[b.dataset.mididel]; saveShow(); renderMidiBinds();
    }));
  }
  function renderMidi() {
    const el = $('#pvMidiState'); if (!el) return;
    renderMidiBinds();
    if (!pv.midi) { el.textContent = 'MIDI not available in this build.'; return; }
    const ins = Array.from(pv.midi.inputs.values()).map((i) => i.name);
    const outs = Array.from(pv.midi.outputs.values()).map((o) => o.name);
    el.textContent = (ins.length || outs.length)
      ? `In: ${ins.join(', ') || 'none'} · Out: ${outs.join(', ') || 'none'}`
      : 'No MIDI devices connected.';
  }

  /* ================= live inputs (camera / screen) =================
   * A camera or a captured window becomes the BACKGROUND layer, so lyrics and
   * lower thirds sit over a live picture exactly as they sit over a video loop. */
  async function pickLiveInput(kind) {
    if (kind === 'screen') {
      pv.layers.background = { type: 'screen', value: 'screen' };
      pushLive(); renderLiveInputs();
      window.__toast && window.__toast('🖥 Screen capture is now the background layer.', 'good');
      return;
    }
    let devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); }
    catch (e) { devices = []; }
    if (!devices.length) { window.__toast && window.__toast('No camera found.', 'error'); return; }
    const pickIx = devices.length === 1 ? 1 : parseInt(await ask(
      'Which input?\n' + devices.map((d, i) => `${i + 1}. ${d.label || 'Camera ' + (i + 1)}`).join('\n'), '1'), 10);
    const d = devices[(pickIx || 1) - 1] || devices[0];
    pv.layers.background = { type: 'camera', value: d.deviceId, label: d.label };
    pushLive(); renderLiveInputs();
    window.__toast && window.__toast(`📷 "${d.label || 'Camera'}" is now the background layer.`, 'good');
  }
  function renderLiveInputs() {
    const el = $('#pvLiveInput'); if (!el) return;
    const b = pv.layers.background;
    el.textContent = !b ? 'Using the slide / Look background.'
      : b.type === 'camera' ? `📷 ${b.label || 'Camera'}`
      : b.type === 'screen' ? '🖥 Screen capture'
      : `${b.type} background`;
  }

  /* ================= live drawing =================
   * Annotate straight over what the room is seeing — circle a word, underline a
   * point. The strokes live on the mask layer as an overlay image so they ride
   * above everything and clear independently. */
  function toggleDraw() {
    pv.drawing = !pv.drawing;
    $('#pvDraw').classList.toggle('on', pv.drawing);
    $('#pvDrawSurface').classList.toggle('hidden', !pv.drawing);
    if (pv.drawing) setupDrawSurface();
    else { pv.layers.mask = pv.maskBeforeDraw || null; pushLive(); }
  }
  function setupDrawSurface() {
    const cv = $('#pvDrawSurface');
    if (!cv) return;
    pv.maskBeforeDraw = pv.layers.mask;
    cv.width = 1920; cv.height = 1080;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, 1920, 1080);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let drawing = false;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width * 1920, y: (e.clientY - r.top) / r.height * 1080 };
    };
    const start = (e) => {
      drawing = true; const p = pos(e);
      ctx.strokeStyle = ($('#pvDrawColor') || {}).value || '#ff2d55';
      ctx.lineWidth = parseInt(($('#pvDrawWidth') || {}).value, 10) || 10;
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      e.preventDefault();
    };
    const move = (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
    const end = () => { if (!drawing) return; drawing = false; commitDrawing(); };
    cv.onmousedown = start; cv.onmousemove = move;
    window.addEventListener('mouseup', end);
    cv._end = end;
  }
  /** Push the strokes to the outputs as a mask-layer image. */
  function commitDrawing() {
    const cv = $('#pvDrawSurface'); if (!cv) return;
    pv.layers.mask = { type: 'image', value: cv.toDataURL('image/png'), fit: 'contain', opacity: 1 };
    pushLive();
  }
  function clearDrawing() {
    const cv = $('#pvDrawSurface');
    if (cv) { const c = cv.getContext('2d'); c.clearRect(0, 0, cv.width, cv.height); }
    pv.layers.mask = pv.maskBeforeDraw || null;
    pushLive();
  }

  /* ================= web output ================= */
  async function toggleWebOut() {
    try {
      if (pv.web && pv.web.running) { pv.web = await window.api.webout.stop(); }
      else {
        const port = parseInt(($('#pvWebPort') || {}).value, 10) || 7373;
        const pass = (($('#pvWebPass') || {}).value || '').trim();
        pv.web = await window.api.webout.start({ port, passcode: pass, allowControl: ($('#pvWebControl') || {}).checked !== false });
      }
    } catch (e) { window.__toast && window.__toast('⚠️ ' + (e.message || 'Could not start the web output.'), 'error', 8000); }
    renderWebOut();
  }
  function renderWebOut() {
    const el = $('#pvWebState'); if (!el) return;
    const w = pv.web || {};
    $('#pvWebToggle').classList.toggle('on', !!w.running);
    $('#pvWebToggle').textContent = w.running ? '■ Stop' : '▶ Start';
    if (!w.running) { el.innerHTML = '<span class="muted small">Off. Start it and any phone on the church wifi can open the stage view — no app to install.</span>'; return; }
    el.innerHTML = '<span class="muted small">Open this on any phone or tablet:</span>'
      + (w.urls || []).map((u) => `<div class="pv-weburl">${esc(u)}</div>`).join('')
      + `<span class="muted small">${w.clients || 0} connected${w.passcode ? ' · passcode on' : ''}</span>`;
  }

  /** Persist the live-show extras (props, timers, announcement) with the settings. */
  function saveShow() {
    try {
      localStorage.setItem('mw-pv-show', JSON.stringify({
        props: pv.props, timers: pv.timers, announcement: pv.announcement,
        cleared: pv.cleared, transitions: pv.transitions, outputLooks: pv.outputLooks,
        macros: pv.macros, midiBinds: pv.midiBinds,
        outputMaps: pv.outputMaps, stageLayoutId: pv.stageLayoutId,
        // The <audio> elements themselves can't be serialised — only what they
        // were built from, so they are rebuilt lazily on first play.
        audio: {
          master: pv.audio.master, playlistOn: pv.audio.playlistOn, shuffle: pv.audio.shuffle, loopList: pv.audio.loopList,
          tracks: pv.audio.tracks.map((t) => ({ id: t.id, name: t.name, path: t.path, volume: t.volume, loop: t.loop, inPlaylist: t.inPlaylist, deviceId: t.deviceId })),
        },
      }));
    } catch (e) {}
  }

  /* ============================ outputs ============================ */
  function renderOutputs() {
    const sel = $('#pvDisplay');
    const ds = pv.outputs.displays || [];
    sel.innerHTML = ds.map((d) => `<option value="${attr(d.id)}">${esc(d.label)}</option>`).join('')
      || '<option value="">No screen found</option>';
    if (!pv.displayId || !ds.some((d) => d.id === pv.displayId)) pv.displayId = pv.outputs.suggested || (ds[0] && ds[0].id) || '';
    sel.value = pv.displayId;
    $('#pvAudience').classList.toggle('on', !!pv.outputs.audience);
    $('#pvStage').classList.toggle('on', !!pv.outputs.stage);
    $('#pvAudience').textContent = pv.outputs.audience ? '🖥 Audience ON' : '🖥 Audience';
    $('#pvStage').textContent = pv.outputs.stage ? '👤 Stage ON' : '👤 Stage';
    renderScreenMenu();
    renderMonitors();
  }

  /* ==================== more than one congregation screen ====================
   * A church is rarely one screen. The room projector, a lobby TV, an overflow
   * room and a cry-room monitor are all showing the SAME cue, and the operator
   * should be able to say so by ticking them — not by naming outputs one at a
   * time in a dialog. Every ticked screen gets a full audience output; the first
   * one keeps the id 'main', so everything that already knows how to talk to
   * "the projector" carries on working unchanged. */

  /** Which audience output (if any) is on this display. */
  function outputOnDisplay(displayId) {
    return (pv.outputList || []).find((o) => o.role !== 'stage' && String(o.displayId) === String(displayId)) || null;
  }
  const audienceScreenCount = () => (pv.outputList || []).filter((o) => o.role !== 'stage').length;

  /** The OS's verdict on the cables: mirroring, an unused screen, or nothing. */
  const screenAdvice = () => (pv.outputs && pv.outputs.screens) || { state: 'ok' };

  /**
   * A cable just changed — say so.
   *
   * The operator is watching the slides, not the Screens panel, so plugging a
   * projector in has to announce itself. Both endings of that moment are worth
   * a word, and they are opposites: an EXTENDED screen appears in the list and
   * is one tick from live, while a DUPLICATED one adds nothing to the list at
   * all and is exactly the fault that was reported. Saying nothing in the second
   * case is what made the app look broken.
   */
  function announceScreenChange(st) {
    const ids = (st.displays || []).map((d) => String(d.id));
    const state = (st.screens || {}).state || 'ok';
    const prevIds = pv._screenIds, prevState = pv._screenState;
    pv._screenIds = ids; pv._screenState = state;
    if (!prevIds) return;                       // the first reading is not a change
    if (!$('#view-present').classList.contains('active')) return;
    // The operator pressed the fix and is owed ONE answer about what happened,
    // written by the code that knows how it ended — not this running commentary.
    if (pv._extending) return;
    const added = (st.displays || []).filter((d) => !prevIds.includes(String(d.id)) && !d.primary);
    if (added.length && !outputOnDisplay(added[0].id)) {
      window.__toast && window.__toast('🖥 ' + (added[0].monitor || added[0].label)
        + ' connected. Open 🖵 Screens to put the slides on it.', 'good', 9000);
    } else if (state !== 'ok' && state !== prevState) {
      window.__toast && window.__toast('⚠️ ' + (st.screens.headline || 'A screen is connected but cannot be presented on')
        + '. Open 🖵 Screens — one button fixes it.', 'error', 14000);
    }
  }

  function renderScreenMenu() {
    const btn = $('#pvScreens'), menu = $('#pvScreenMenu'), count = $('#pvScreensCount');
    if (!btn || !menu) return;
    const n = audienceScreenCount();
    const adv = screenAdvice();
    btn.classList.toggle('on', n > 0);
    // A projector that is plugged in but mirrored is invisible to the screen
    // list, so the button itself has to say so — nobody opens a menu to look
    // for a problem they have not been told about.
    btn.classList.toggle('warn', adv.state !== 'ok');
    btn.title = adv.state !== 'ok'
      ? adv.headline + ' — click to fix'
      : 'Choose which screens show the congregation view — you can pick more than one';
    if (count) { count.textContent = String(n); count.classList.toggle('hidden', n === 0); }
    if (menu.classList.contains('hidden')) return;
    const ds = pv.outputs.displays || [];
    const stageOn = pv.outputs.stageDisplay;
    menu.innerHTML =
      screenWarningHtml(adv) +
      `<div class="pv-screen-head">Show the congregation view on…</div>` +
      (ds.length ? ds.map((d) => {
        const out = outputOnDisplay(d.id);
        const isStage = String(stageOn) === String(d.id);
        // A duplicated desktop is ONE row that is really two panels: say so on
        // the row, or ticking it looks like it did nothing to the projector.
        const copied = (d.copiedExtra || []).length ? ' · also copied onto ' + d.copiedExtra.join(', ') : '';
        return `<label class="pv-screen-row${out ? ' on' : ''}">` +
          `<input type="checkbox" data-screen="${attr(d.id)}"${out ? ' checked' : ''} />` +
          `<span class="pv-screen-main"><b>${esc(d.label)}</b>` +
            `<span class="muted small">${d.primary ? 'the screen you are working on' : 'external screen'}` +
            `${esc(copied)}${isStage ? ' · showing the stage display' : ''}${out && out.windowed ? ' · in a window' : ''}</span></span>` +
          `</label>`;
      }).join('')
        : `<p class="muted small pv-empty">No screen found. Connect a projector or TV and it appears here.</p>`) +
      `<p class="pv-screen-note">Tick as many as you need — every ticked screen shows the same cue. ` +
      `Give one its own styling in <b>Desk → Extra outputs</b>.</p>`;
    $$('[data-screen]', menu).forEach((c) => c.addEventListener('change', () => toggleScreen(c.dataset.screen, c.checked)));
    const fix = $('#pvExtend', menu);
    if (fix) fix.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); extendScreens(fix); });
  }

  /* ============ the projector that is plugged in but not a screen ============
   * The reported fault: "I plugged the HDMI into the projector and it only
   * showed my main screen — the software never noticed a second screen."
   *
   * It could not. Windows had put the two panels in Duplicate, which is ONE
   * desktop shown twice; there was no second screen to notice, and no amount of
   * looking harder would have found one. The studio now reads the cables rather
   * than the desktops, says which projector it can see, and offers the switch —
   * the operator should not have to know that Win+P exists. */
  function screenWarningHtml(adv) {
    if (!adv || adv.state === 'ok') return '';
    const body = adv.canExtend ? adv.detail : ((adv.macDetail || '') + ' ' + (adv.detail || ''));
    return `<div class="pv-screen-warn">` +
      `<b>⚠ ${esc(adv.headline)}</b>` +
      `<span>${esc(body.trim())}</span>` +
      (adv.canExtend ? `<button id="pvExtend" class="pv-screen-fix" type="button">${esc(adv.action)}</button>` : '') +
      `</div>`;
  }

  /**
   * One click: stop mirroring, then put the slides on the screen that appears.
   *
   * Stopping halfway would be its own bug — the operator pressed a button about
   * the projector, so the projector has to end up showing the presentation, not
   * a desktop with a new tick-box waiting somewhere else.
   */
  async function extendScreens(btn) {
    const before = (pv.outputs.displays || []).map((d) => String(d.id));
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Switching…'; }
    pv._extending = true;
    try {
      await window.api.present.extendScreens();
      await refreshOutputs();
      const fresh = (pv.outputs.displays || []).filter((d) => !before.includes(String(d.id)));
      if (fresh.length) {
        pv.displayPicked = true;
        await toggleScreen(fresh[0].id, true);
        window.__toast && window.__toast('🖥 ' + (fresh[0].monitor || 'The second screen') + ' is its own screen now, and it is showing the presentation.', 'good', 7000);
      } else {
        await refreshOutputs();
        const still = screenAdvice();
        window.__toast && window.__toast(still.state === 'ok'
          ? '🖥 Screens sorted out. Tick the projector below to present on it.'
          : '⚠️ Windows would not switch by itself. Press the Windows key + P and choose “Extend”.', still.state === 'ok' ? 'good' : 'error', 9000);
      }
    } catch (e) {
      window.__toast && window.__toast('⚠️ ' + (e.message || 'Could not change the screen setup') + ' — press the Windows key + P and choose “Extend”.', 'error', 9000);
    } finally {
      pv._extending = false;
      pv._screenIds = (pv.outputs.displays || []).map((d) => String(d.id));
      pv._screenState = screenAdvice().state;
      if (btn) { btn.disabled = false; btn.textContent = label; }
      renderScreenMenu();
    }
  }

  /**
   * Turn one physical screen into a congregation output, or take it away.
   *
   * The FIRST screen ticked becomes 'main' so the single-projector paths
   * (Go Live, the Audience button, ensureAudienceOutput) keep owning it; the
   * rest get an id derived from the display. A screen that already has an
   * output on it (the stage display, say) opens windowed rather than silently
   * covering what is there.
   */
  async function toggleScreen(displayId, on) {
    const ds = pv.outputs.displays || [];
    const d = ds.find((x) => String(x.id) === String(displayId));
    if (!d) return;
    try {
      if (!on) {
        const out = outputOnDisplay(displayId);
        if (out) await window.api.present.close(out.id);
      } else {
        const hasMain = (pv.outputList || []).some((o) => o.id === 'main');
        const key = hasMain ? 'scr-' + String(displayId).replace(/[^\w-]+/g, '') : 'main';
        const clash = String(pv.outputs.stageDisplay) === String(displayId);
        await window.api.present.open('audience', displayId, clash, key, d.label);
        if (key === 'main') pv.displayId = String(displayId);
        pv.displayPicked = true;
        if (clash) window.__toast && window.__toast('🖥 Opened in a window — the stage display is already on that screen.', 'good', 6000);
      }
      await refreshOutputs();
      pushLive();
    } catch (e) {
      window.__toast && window.__toast('⚠️ ' + (e.message || 'Could not change that screen.'), 'error');
      await refreshOutputs();
    }
  }

  function toggleScreenMenu(force) {
    const menu = $('#pvScreenMenu'); if (!menu) return;
    const open = force != null ? force : menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !open);
    if (open) { refreshOutputs(); renderScreenMenu(); }
  }
  async function toggleOutput(role) {
    const key = role === 'stage' ? 'stage' : 'main';
    try {
      if (pv.outputs[role === 'stage' ? 'stage' : 'audience']) await window.api.present.close(key);
      else {
        // Two outputs on ONE screen would just cover each other; if the stage is
        // going where the audience already is, put it in a window instead.
        const clash = role === 'stage' && pv.outputs.audience && pv.outputs.audienceDisplay === pv.displayId;
        await window.api.present.open(role, pv.displayId, clash, key);
        if (clash) window.__toast && window.__toast('👤 Stage opened in a window — both outputs were pointed at the same screen.', 'good', 6000);
      }
      await refreshOutputs();
      pushLive(); // push the current state to whatever just opened
    } catch (e) {
      window.__toast && window.__toast('⚠️ ' + (e.message || 'Could not open the output.'), 'error');
    }
  }
  async function refreshOutputs() {
    try { pv.outputs = await window.api.present.state(); } catch (e) {}
    pv.outputList = (pv.outputs && pv.outputs.outputs) || [];
    renderOutputs(); renderOutputList();
  }

  /* ================= multiple outputs, each with its own Look =================
   * One cue, several screens, different styling on each: full-screen decorative
   * text in the room, a plain readable version on a lobby TV, a keyable lower
   * third for the stream. The slide never changes — only the Look does. */
  async function addOutput() {
    const ds = (pv.outputs.displays || []);
    if (!ds.length) return;
    const name = await ask('Name this output (e.g. "Lobby", "Stream key"):', 'Lobby');
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20) || uid();
    const which = await ask(
      'Which screen?\n' + ds.map((d, i) => `${i + 1}. ${d.label}`).join('\n'), '1');
    const d = ds[(parseInt(which, 10) || 1) - 1] || ds[0];
    try {
      // A second output on a screen that already has one opens windowed, so it
      // can't silently hide the first.
      const clash = (pv.outputList || []).some((o) => o.displayId === d.id);
      await window.api.present.open('audience', d.id, clash, id, name);
      await refreshOutputs();
      pushLive();
    } catch (e) { window.__toast && window.__toast('⚠️ ' + (e.message || 'Could not open that output.'), 'error'); }
  }
  function renderOutputList() {
    const el = $('#pvOutList'); if (!el) return;
    const outs = (pv.outputList || []).filter((o) => o.role !== 'stage');
    const mapped = (id) => { const m = pv.outputMaps[id]; return m && (m.rotate || m.scale !== 1 || m.x || m.y || m.w || m.h || (m.blend && Object.values(m.blend).some((v) => v > 0))); };
    el.innerHTML = outs.length ? outs.map((o) => `
      <div class="lib-row sel">
        <span class="lib-row-icon">🖥</span>
        <span class="lib-row-main"><b>${esc(o.name)}</b>
          <span class="muted small">${esc((pv.outputs.displays.find((d) => d.id === o.displayId) || {}).label || '')}</span></span>
        <select class="pv-outlook" data-outlook="${attr(o.id)}" title="This screen's Look">
          <option value="">Same Look</option>
          ${pv.looks.map((l) => `<option value="${attr(l.id)}"${pv.outputLooks[o.id] === l.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>
        <select class="pv-outlook" data-outrender="${attr(o.id)}" title="Downstream keying — fill and key are the two cables an SDI keyer wants">
          <option value="normal"${(o.render || 'normal') === 'normal' ? ' selected' : ''}>Picture</option>
          <option value="fill"${o.render === 'fill' ? ' selected' : ''}>Fill (alpha)</option>
          <option value="key"${o.render === 'key' ? ' selected' : ''}>Key</option>
        </select>
        <button class="lib-mini${mapped(o.id) ? ' on' : ''}" data-outmap="${attr(o.id)}" title="Screen mapping: rotate, position, edge blend">📐</button>
        <button class="lib-mini danger" data-outclose="${attr(o.id)}" title="Close this output">✕</button>
      </div>`).join('')
      : '<p class="muted small pv-empty">Only the main output. Add another for a lobby screen or a differently-styled stream feed.</p>';
    $$('[data-outlook]', el).forEach((s) => s.addEventListener('change', () => {
      if (s.value) pv.outputLooks[s.dataset.outlook] = s.value; else delete pv.outputLooks[s.dataset.outlook];
      saveShow(); pushLive();
    }));
    // A transparent window can't be made opaque after the fact, so switching the
    // keying mode re-opens the output — on the same screen, with the same name.
    $$('[data-outrender]', el).forEach((s) => s.addEventListener('change', async () => {
      const o = outs.find((x) => x.id === s.dataset.outrender); if (!o) return;
      try {
        await window.api.present.open(o.role, o.displayId, o.windowed, o.id, o.name, s.value);
        await refreshOutputs(); pushLive();
      } catch (e) { window.__toast && window.__toast('⚠️ ' + (e.message || 'Could not switch that output.'), 'error'); }
    }));
    $$('[data-outmap]', el).forEach((b) => b.addEventListener('click', () => openMapEditor(b.dataset.outmap)));
    $$('[data-outclose]', el).forEach((b) => b.addEventListener('click', async () => {
      await window.api.present.close(b.dataset.outclose).catch(() => {});
      await refreshOutputs();
    }));
  }

  /* ================= screen mapping & edge blending =================
   * Real rooms are not one flat 16:9 rectangle. A projector gets hung sideways
   * for a tall banner screen, an LED wall is only the middle third of the
   * output, and two projectors overlap to make one wide picture. Each of those
   * is a per-screen transform — never a change to the slide, which has to stay
   * identical everywhere else it is shown. */
  const DEFAULT_MAP = () => ({ rotate: 0, scale: 1, x: 0, y: 0, w: 0, h: 0, blend: { left: 0, right: 0, top: 0, bottom: 0, gamma: 1 } });
  function mapFor(id) {
    if (!pv.outputMaps[id]) pv.outputMaps[id] = DEFAULT_MAP();
    if (!pv.outputMaps[id].blend) pv.outputMaps[id].blend = { left: 0, right: 0, top: 0, bottom: 0, gamma: 1 };
    return pv.outputMaps[id];
  }
  function openMapEditor(id) {
    pv.mapEditing = id;
    const m = mapFor(id);
    const o = (pv.outputList || []).find((x) => x.id === id);
    $('#pvMapName').textContent = (o && o.name) || id;
    $('#pvMapEditor').classList.remove('hidden');
    $('#pvMapRotate').value = String(m.rotate || 0);
    $('#pvMapScale').value = String(m.scale == null ? 1 : m.scale);
    $('#pvMapX').value = String(m.x || 0); $('#pvMapY').value = String(m.y || 0);
    $('#pvMapW').value = String(m.w || 0); $('#pvMapH').value = String(m.h || 0);
    $('#pvBlendL').value = String(m.blend.left || 0); $('#pvBlendR').value = String(m.blend.right || 0);
    $('#pvBlendT').value = String(m.blend.top || 0); $('#pvBlendB').value = String(m.blend.bottom || 0);
    $('#pvBlendG').value = String(m.blend.gamma == null ? 1 : m.blend.gamma);
  }
  function readMapEditor() {
    const id = pv.mapEditing; if (!id) return;
    const m = mapFor(id);
    const n = (sel, dflt) => { const v = parseFloat($(sel).value); return isNaN(v) ? dflt : v; };
    m.rotate = parseInt($('#pvMapRotate').value, 10) || 0;
    m.scale = clamp(n('#pvMapScale', 1), 0.2, 4);
    m.x = n('#pvMapX', 0); m.y = n('#pvMapY', 0);
    m.w = Math.max(0, n('#pvMapW', 0)); m.h = Math.max(0, n('#pvMapH', 0));
    m.blend = {
      left: Math.max(0, n('#pvBlendL', 0)), right: Math.max(0, n('#pvBlendR', 0)),
      top: Math.max(0, n('#pvBlendT', 0)), bottom: Math.max(0, n('#pvBlendB', 0)),
      gamma: clamp(n('#pvBlendG', 1), 0.2, 4),
    };
    saveShow(); pushLive(); renderOutputList();
  }

  /* ================= stage layouts ================= */
  function renderStageLayouts() {
    const sel = $('#pvStageLayout'); if (!sel) return;
    const list = pv.stageLayouts && pv.stageLayouts.length ? pv.stageLayouts : DEFAULT_STAGE_LAYOUTS;
    sel.innerHTML = list.map((l) => `<option value="${attr(l.id)}"${l.id === pv.stageLayoutId ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
    const cur = stageLayout();
    const has = (t) => (cur.blocks || []).some((b) => b.type === t);
    $('#pvStageBlocks').innerHTML = STAGE_BLOCKS
      .map((b) => `<span class="pv-chip${has(b.type) ? ' on' : ''}" title="${attr(b.label)}">${esc(b.label)}</span>`).join('');
  }
  function setStageLayout(id) {
    const list = pv.stageLayouts && pv.stageLayouts.length ? pv.stageLayouts : DEFAULT_STAGE_LAYOUTS;
    if (!list.some((l) => l.id === id)) return pv.stageLayoutId;
    pv.stageLayoutId = id;
    saveShow(); renderStageLayouts(); pushLive();
    return pv.stageLayoutId;
  }

  /* ================= DMX lighting (Art-Net) =================
   * The lights are part of the cue. "Sermon" should dim the house and kill the
   * wash in the same click that changes the Look and starts the countdown —
   * that is the whole reason macros exist, and Art-Net makes it one UDP packet
   * to gear the church already owns. */
  function sendDmx(cmd) {
    if (!cmd) return null;
    window.api.dmx.send({ command: String(cmd) }).catch(() => {});
    return String(cmd);
  }
  async function refreshDmx() {
    try { pv.dmx = await window.api.dmx.state(); } catch (e) { pv.dmx = null; }
    renderDmx();
  }
  function renderDmx() {
    const el = $('#pvDmxState'); if (!el) return;
    const d = pv.dmx || {};
    $('#pvDmxOn').checked = !!d.enabled;
    el.textContent = d.enabled
      ? `Sending to ${d.host}:${d.port}${(d.universes || []).length ? ' · universe ' + d.universes.join(', ') : ''}`
      : 'Off. Turn on to control the lighting rig from a macro.';
  }
  async function configureDmx() {
    const enabled = !!$('#pvDmxOn').checked;
    const host = ($('#pvDmxHost').value || '255.255.255.255').trim();
    try { pv.dmx = await window.api.dmx.configure({ enabled, host }); } catch (e) {}
    saveShow(); renderDmx();
    return pv.dmx;
  }

  /* ================= NDI output =================
   * Publishing the screens onto the network instead of running HDMI to the
   * stream box, the overflow room and the foyer. Each feed is rendered
   * offscreen at its own resolution, so an NDI feed is a real output — not a
   * scrape of whatever monitor happened to be plugged in. */
  async function refreshNdi() {
    try { pv.ndi = await window.api.ndiOut.state(); } catch (e) { pv.ndi = null; }
    renderNdi();
  }
  function renderNdi() {
    const st = $('#pvNdiState'), list = $('#pvNdiList');
    if (!st || !list) return;
    const n = pv.ndi;
    if (!n) { st.textContent = ''; list.innerHTML = ''; return; }
    st.textContent = n.available
      ? `Ready — this machine appears as “${n.machine}” on the network.`
      // The one thing that makes NDI simply not exist on a Windows PC is the
      // free runtime not being installed, and "NDI is not available" does not
      // tell an operator what to do about it on a Saturday night.
      : (n.error || 'NDI is not installed on this computer.') +
        ' Install the free NDI Tools (or the NDI Runtime) from ndi.video, then restart the app.';
    st.classList.toggle('warn', !n.available);
    const feeds = n.feeds || [];
    list.innerHTML = feeds.length ? feeds.map((f) => {
      // What the operator was promised versus what is actually on the wire. A
      // feed that quietly went out at a different size is the difference
      // between lyrics that fit the switcher and lyrics that are cropped.
      const wrongSize = f.sentW && f.sentH && (f.sentW !== f.width || f.sentH !== f.height);
      const bits = [
        `${f.width}×${f.height} @ ${f.fps}fps`,
        f.alpha ? 'keyable (alpha)' : null,
        f.group ? 'group ' + esc(f.group) : null,
        `${f.connections} receiver${f.connections === 1 ? '' : 's'}`,
        wrongSize ? `⚠️ sending ${f.sentW}×${f.sentH}` : null,
        f.ok === false ? '⚠️ ' + esc(f.error || 'could not start') : null,
      ].filter(Boolean);
      return `
      <div class="lib-row sel">
        <span class="lib-row-icon">${f.connections ? '🟢' : (f.ok === false ? '🔴' : '⚪')}</span>
        <span class="lib-row-main"><b>${esc(f.name)}</b>
          <span class="muted small">${bits.join(' · ')}</span></span>
        <button class="lib-mini danger" data-ndistop="${attr(f.id)}" title="Stop this feed">✕</button>
      </div>`;
    }).join('')
      : '<p class="muted small pv-empty">No NDI feeds. Add one to send the words to vMix, OBS or a stream box over the network.</p>';
    $$('[data-ndistop]', list).forEach((b) => b.addEventListener('click', async () => {
      await window.api.ndiOut.stop(b.dataset.ndistop).catch(() => {});
      pv.ndiSaved = (pv.ndiSaved || []).filter((x) => x.id !== b.dataset.ndistop);
      saveNdiFeeds();
      await refreshNdi();
    }));
  }

  /* Feeds are remembered. A church sets its stream-box feed up once; having it
   * vanish every time the app is closed is how "the NDI output doesn't work"
   * starts, ten minutes before a service. */
  function saveNdiFeeds() {
    try { localStorage.setItem('mw-pv-ndi', JSON.stringify(pv.ndiSaved || [])); } catch (e) {}
  }
  async function restoreNdiFeeds() {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('mw-pv-ndi') || '[]'); } catch (e) {}
    if (!Array.isArray(saved) || !saved.length) return;
    pv.ndiSaved = saved;
    if (!pv.ndi || !pv.ndi.available) return;   // no runtime: keep them for next time
    for (const f of saved) { try { await window.api.ndiOut.start(f); } catch (e) {} }
    await refreshNdi();
    pushLive();
  }

  async function addNdiOutput() {
    const name = ($('#pvNdiName').value || 'Lyrics').trim() || 'Lyrics';
    const [w, h] = ($('#pvNdiSize').value || '1920x1080').split('x').map((x) => parseInt(x, 10));
    const fps = parseInt($('#pvNdiFps').value, 10) || 30;
    const alpha = !!$('#pvNdiAlpha').checked;
    const group = (($('#pvNdiGroup') || {}).value || '').trim();
    const id = 'ndi-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20);
    const feed = { id, name, width: w, height: h, fps, alpha, group, sourceId: id };
    try {
      await window.api.ndiOut.start(feed);
      pv.ndiSaved = (pv.ndiSaved || []).filter((x) => x.id !== id).concat([feed]);
      saveNdiFeeds();
      await refreshNdi();
      pushLive();
      window.__toast && window.__toast(`📡 “${name}” is on the network.`, 'good');
    } catch (e) {
      window.__toast && window.__toast('⚠️ ' + (e.message || 'Could not start the NDI feed.'), 'error');
    }
  }

  /* ============================ Bible ============================ */
  /* ===================== which Bible, and what it is called =====================
   *
   * The catalogue's names are scholarly, not usable: one of them is "King James
   * Version (1769) with Strongs Numbers and Morphology and CatchWords, including
   * Apocrypha (without glosses)", which in a dropdown is a wall of text with the
   * useful part — KJV — buried at the front. So a SHORT name is derived for the
   * picker and the full one is kept as the tooltip, where it costs nothing.
   */
  function shortBibleName(t) {
    let n = String((t && (t.name || t.abbr)) || '').trim();
    n = n.split(/\s+\(/)[0];                       // drop "(1769) with …"
    n = n.replace(/\s+with\s+.*$/i, '');           // …and "with Strongs Numbers…"
    n = n.replace(/,\s*including\b.*$/i, '');
    // Tidy a trailing "version"/"translation" to title case — but keep the WORD:
    // the New Living Translation is not the New Living Version.
    n = n.replace(/\s*\b(version|translation)\b\s*$/i, (m, w) => ' ' + w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).trim();
    if (n.length > 46) n = n.slice(0, 44).replace(/[\s,;-]+$/, '') + '…';
    return n || bibleCode(t && t.abbr);
  }
  /** `bolls:NIV` is an id, not something to put in front of anyone — show "NIV". */
  const bibleCode = (abbr) => String(abbr || '').replace(/^bolls:/i, '').toUpperCase();

  /*
   * The English translations a church actually asks for, in the order they ask.
   *
   * The seven modern ones lead, because they are what gets read from the stage;
   * `bolls:` ids come from bolls.life (see src/main/bible.js), the rest are the
   * public-domain catalogue. Both kinds download once and then work offline, so
   * from the manager they behave identically — a volunteer never has to know
   * which list a translation came from.
   */
  const POPULAR_ENGLISH = [
    'bolls:niv', 'bolls:nlt', 'bolls:esv', 'bolls:nkjv', 'bolls:nasb', 'bolls:amp', 'bolls:msg',
    'bolls:csb17', 'bolls:net', 'bolls:bsb',
    'kjv', 'akjv', 'asv', 'web', 'webster', 'ylt', 'basicenglish', 'darby', 'douayrheims', 'geneva', 'kjva',
  ];

  async function refreshTranslations() {
    let inst = [];
    try { inst = await window.api.bible.installed(); } catch (e) {}
    pv.installed = inst;
    /*
     * The picker holds two kinds of translation. The downloaded ones work with
     * the wifi unplugged. The other kind is read off bolls.life as you look a
     * verse up — "Use now" in the manager, and also whatever was chosen on a
     * previous run but never downloaded. Those are marked · online, because on
     * a Sunday morning the difference between the two is the whole story.
     */
    const wanted = (pv.liveTranslations || []).slice();
    if (pv.translation && /^bolls:/i.test(pv.translation)) wanted.push(pv.translation);
    const live = wanted
      .filter((a, i) => wanted.indexOf(a) === i && !inst.some((t) => t.abbr === a))
      .map((a) => ({ abbr: a, name: ((pv.catalogue || []).find((c) => c.abbr === a) || {}).name || bibleCode(a), live: true }));
    pv.liveTranslations = live.map((t) => t.abbr);

    const all = inst.concat(live);
    const sel = $('#pvTranslation');
    if (!all.length) {
      sel.innerHTML = '<option value="">No translation yet — click ⚙</option>';
      return;
    }
    sel.innerHTML = all.map((t) =>
      `<option value="${attr(t.abbr)}" title="${attr(t.name || '')}">${esc(bibleCode(t.abbr))} — ${esc(shortBibleName(t))}${t.live ? ' · online' : ''}</option>`).join('')
      + `<option value="__manage">＋ Add another translation…</option>`;
    if (!all.some((t) => t.abbr === pv.translation)) pv.translation = all[0].abbr;
    sel.value = pv.translation;
    // Chapter and verse counts belong to the translation, so the pickers are
    // rebuilt whenever it changes — a chapter that exists in one is not
    // guaranteed to exist in another.
    await refreshBiblePicker();
  }

  /* ===================== BOOK ▸ CHAPTER ▸ VERSE =====================
   *
   * Typing "John 3:16" is quick if you already know where you are going. Three
   * dropdowns are for everyone else — a volunteer handed the desk five minutes
   * before the service, or a preacher calling out a book while the operator
   * hunts for the spelling of Ecclesiastes.
   *
   * They are the same search box underneath: every change writes a reference
   * into #pvRef and runs the ordinary lookup, so Add / Go Live / verses-per-
   * slide all behave exactly as they do for typed references, and a typed one
   * pulls the dropdowns back into step with it.
   */
  /**
   * Rebuild the pickers — but only while the Bible pane is the one on screen.
   * The book list costs a round trip (a live translation has to ask the site
   * for it), and a church that never opens this pane should never pay for it.
   */
  function refreshBiblePicker() {
    if (pv.tab !== 'bible') { pv.pickerStale = true; return Promise.resolve(); }
    pv.pickerStale = false;
    /*
     * Keep the operator's place. Tabbing away to pick a background and coming
     * back must not quietly wind the pickers to Genesis 1 while the panel is
     * still listing John 3 — the dropdowns would be describing a passage
     * nobody is reading.
     */
    const num = (sel) => { const v = parseInt(($(sel) || {}).value, 10); return Number.isFinite(v) ? v : null; };
    return fillBooks(num('#pvBook') || 0, num('#pvChapter'), num('#pvVerse'), num('#pvVerseTo'))
      // …and show the chapter they are pointing at. Opening on an empty panel
      // with Genesis 1 selected made the operator press Find to be told what
      // they could already see was chosen.
      .then(() => { if (!pv.bibleResult && pv.translation) return findFromPicker(); })
      .catch(() => {});
  }
  async function fillBooks(keepNr, keepCh, keepFrom, keepTo) {
    let list = [];
    try { const r = await window.api.bible.books(pv.translation); list = (r && r.books) || []; } catch (e) {}
    // A translation that only holds some books (an imported module) must not
    // offer the ones it hasn't got.
    const usable = list.filter((b) => b.chapters > 0);
    pv.bookList = usable.length ? usable : list;
    const sel = $('#pvBook');
    sel.innerHTML = pv.bookList.map((b) => `<option value="${b.nr}">${esc(b.name)}</option>`).join('');
    if (!pv.bookList.length) { $('#pvChapter').innerHTML = ''; $('#pvVerse').innerHTML = ''; $('#pvVerseTo').innerHTML = ''; return; }
    const want = pv.bookList.some((b) => b.nr === keepNr) ? keepNr : pv.bookList[0].nr;
    const same = want === keepNr;
    sel.value = String(want);
    await fillChapters(same ? keepCh : null, same ? keepFrom : null, same ? keepTo : null);
  }
  async function fillChapters(keepCh, keepFrom, keepTo) {
    const nr = parseInt($('#pvBook').value, 10);
    const b = (pv.bookList || []).find((x) => x.nr === nr);
    const n = (b && b.chapters) || 0;
    const sel = $('#pvChapter');
    sel.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    const same = !!(keepCh && keepCh <= n);
    sel.value = String(same ? keepCh : 1);
    await fillVerses(same ? keepFrom : null, same ? keepTo : null);
  }
  /**
   * The verse list comes from the chapter itself, never from a count table:
   * chapters genuinely differ between translations, and offering a verse that
   * is not there produces an error message instead of scripture.
   */
  async function fillVerses(keepFrom, keepTo) {
    const nr = parseInt($('#pvBook').value, 10);
    const ch = parseInt($('#pvChapter').value, 10);
    let verses = [];
    if (nr && ch && pv.translation) {
      try { verses = (await window.api.bible.chapter(pv.translation, nr, ch)) || []; } catch (e) { verses = []; }
    }
    const nums = verses.map((v) => v.verse).filter((n) => n > 0);
    const opts = nums.map((n) => `<option value="${n}">${n}</option>`).join('');
    const from = $('#pvVerse'), to = $('#pvVerseTo');
    from.innerHTML = '<option value="0">Whole chapter</option>' + opts;
    to.innerHTML = opts;
    /*
     * WHOLE CHAPTER is the default, not verse 1.
     *
     * The panel is now a cue list — the chapter is looked up once and each
     * verse is clicked onto the screen as the preacher reaches it. Landing on
     * "1" meant the operator had to change the dropdown before they could see
     * anything but the first verse.
     */
    from.value = String(keepFrom != null && (keepFrom === 0 || nums.includes(keepFrom)) ? keepFrom : 0);
    const f = parseInt(from.value, 10);
    to.value = String(keepTo != null && nums.includes(keepTo) && keepTo >= f ? keepTo : f);
    syncVerseRange();
  }
  /** "Whole chapter" has no second verse to pick, so the range half goes away. */
  function syncVerseRange() {
    const whole = parseInt($('#pvVerse').value, 10) === 0;
    $('.pv-bible-pick').classList.toggle('whole', whole);
    if (!whole) {
      // Never leave the range inside out — a "to" below the "from" reads as a
      // mistake the operator has to fix before anything appears.
      const f = parseInt($('#pvVerse').value, 10), t = parseInt($('#pvVerseTo').value, 10);
      if (!(t >= f)) $('#pvVerseTo').value = String(f);
    }
  }
  /** The reference the three dropdowns currently spell out. */
  function pickerRef() {
    const b = (pv.bookList || []).find((x) => x.nr === parseInt($('#pvBook').value, 10));
    if (!b) return '';
    const ch = parseInt($('#pvChapter').value, 10) || 1;
    const f = parseInt($('#pvVerse').value, 10) || 0;
    if (!f) return `${b.name} ${ch}`;
    const t = parseInt($('#pvVerseTo').value, 10) || f;
    return t > f ? `${b.name} ${ch}:${f}-${t}` : `${b.name} ${ch}:${f}`;
  }
  /** One picker change at a time, in the order they were made. */
  function pickerQueue(fn) {
    pv.pickerOp = Promise.resolve(pv.pickerOp).catch(() => {}).then(fn);
    return pv.pickerOp;
  }
  /** Everything the pickers are showing, in one object (read by the tests). */
  function pickerSnapshot() {
    const vals = (id) => Array.from($(id).options).map((o) => o.value);
    return {
      books: vals('#pvBook').length, book: $('#pvBook').value,
      firstBooks: Array.from($('#pvBook').options).slice(0, 3).map((o) => o.textContent),
      chapters: vals('#pvChapter').length, chapter: $('#pvChapter').value,
      verses: Math.max(0, vals('#pvVerse').length - 1),        // less "Whole chapter"
      verse: $('#pvVerse').value, verseTo: $('#pvVerseTo').value,
      wholeChapter: $('.pv-bible-pick').classList.contains('whole'),
      ref: pickerRef(),
    };
  }
  async function findFromPicker() {
    const ref = pickerRef();
    if (!ref) return;
    $('#pvRef').value = ref;
    // The dropdowns already say what they say — syncing them back from the
    // result would just rebuild the lists under the operator's cursor.
    pv.pickerBusy = true;
    try { await findScripture(); } finally { pv.pickerBusy = false; }
  }
  /** Pull the dropdowns back onto whatever was just found by typing. */
  function syncPickerTo(res) {
    if (!res || !res.bookNr || pv.pickerBusy) return;
    const sel = $('#pvBook');
    if (!(pv.bookList || []).some((b) => b.nr === res.bookNr)) return;
    pv.pickerBusy = true;
    sel.value = String(res.bookNr);
    const nums = (res.verses || []).map((v) => v.verse);
    const whole = res.chapterVerses && nums.length === res.chapterVerses;
    fillChapters(res.chapter)
      .then(() => fillVerses(whole ? 0 : nums[0], whole ? null : nums[nums.length - 1]))
      .finally(() => { pv.pickerBusy = false; });
  }

  /** Reference ("John 3:16") if it parses, otherwise a word search. */
  async function findScripture() {
    const q = ($('#pvRef').value || '').trim();
    const box = $('#pvBibleResults');
    if (!q) return;
    if (!pv.translation) { openBibleManager(); return; }
    box.innerHTML = '<p class="muted small pv-empty">Looking…</p>';
    pv.bibleResult = null; updateBibleButtons();
    let parsed = null;
    try { parsed = await window.api.bible.parseRef(q); } catch (e) {}
    try {
      if (parsed) {
        const res = await window.api.bible.lookup(pv.translation, q);
        pv.bibleResult = res;
        // Each verse is a button: one click and it is on the projector. The
        // Library never hears about it.
        box.innerHTML = res.verses.map((v) => `
          <button class="pv-verse" data-verse="${v.verse}" title="Put this on the screen">
            <span class="pv-verse-no">${v.verse}</span>
            <span class="pv-verse-text">${esc(v.text)}</span>
          </button>`).join('');
        $$('.pv-verse', box).forEach((el) => el.addEventListener('click', () => {
          sendVerseLive(parseInt(el.dataset.verse, 10));
        }));
        $('#pvVerseHint').classList.remove('hidden');
        $('#pvRef').dataset.ref = res.reference;
        markLiveVerses();
        syncPickerTo(res);
      } else {
        const hits = await window.api.bible.search({ translation: pv.translation, query: q, limit: 60 });
        if (!hits.length) { box.innerHTML = `<p class="muted small pv-empty">Nothing found for “${esc(q)}”.</p>`; return; }
        box.innerHTML = hits.map((h) => `
          <button class="pv-hit" data-hit="${attr(h.reference)}">
            <span class="pv-hit-ref">${esc(h.reference)}</span>
            <span class="pv-hit-text">${esc(h.text)}</span>
          </button>`).join('');
        $$('[data-hit]', box).forEach((b) => b.addEventListener('click', () => {
          $('#pvRef').value = b.dataset.hit; findScripture();
        }));
      }
    } catch (e) {
      box.innerHTML = `<p class="muted small pv-empty">⚠️ ${esc(e.message || 'Lookup failed.')}</p>`;
    }
    updateBibleButtons();
  }
  /* ======================= 🎤 Listen =======================
   *
   * The preacher announces the passage and it goes up; they say "next verse"
   * and it moves. What makes this safe to leave running for forty minutes is
   * not the recogniser, it is voiceref.js refusing to act on anything that
   * isn't unmistakably an instruction — so most of what is heard here lands in
   * the log and changes nothing, which is exactly right.
   *
   * The log is on show for one reason: when nothing happens, the operator can
   * read what it heard. "It isn't working" and "it heard me but that wasn't a
   * command" are completely different problems, and without the transcript they
   * look identical from the desk.
   */
  const LISTEN_COOLDOWN_MS = 900;      // one instruction cannot fire twice on an echo
  /*
   * Naming a passage needs a much longer guard than stepping does. The same
   * words sit inside every rolling look-back that overlaps them — six seconds
   * of audio, offered again every 1.2 s — and then again in the finished
   * phrase, so one announcement of "John chapter three verse sixteen" is heard
   * five or six times. Going there twice is harmless on the wall but reloads
   * the chapter each time, and the log would read as though the preacher were
   * stammering. Eight seconds outlasts the whole overlap.
   */
  const REF_COOLDOWN_MS = 8000;

  function listenLog(text, cls) {
    const box = $('#pvListenLog'); if (!box) return;
    const el = document.createElement('div');
    el.className = 'pv-listen-line' + (cls ? ' ' + cls : '');
    el.innerHTML = text;
    box.insertBefore(el, box.firstChild);
    while (box.children.length > 40) box.removeChild(box.lastChild);
  }
  function listenState(word, on) {
    const s = $('#pvListenState'); if (s) s.textContent = word;
    const b = $('#pvListen'); if (b) { b.classList.toggle('on', !!on); b.textContent = on ? '🎤 Listening' : '🎤 Listen'; }
  }
  /** What is on the wall right now, in the terms the parser thinks in. */
  function liveVerseContext() {
    const c = pv.verseCue, res = pv.bibleResult;
    if (!c || !res) return null;
    const first = (c.slides[c.ix] && c.verses) ? c.verses[0] : null;
    return { bookNr: res.bookNr || null, chapter: res.chapter || null, verse: first };
  }

  /**
   * Do what was asked. Returns a short line for the log, or null if it could
   * not be done (which is itself worth showing).
   */
  async function applyVoiceIntent(intent) {
    if (!intent) return null;
    if (intent.kind === 'next') { step(1); return 'next'; }
    if (intent.kind === 'prev') { step(-1); return 'previous'; }
    if (intent.kind === 'clear') { pv.blackout = true; pushLive(); renderClearPalette(); return 'screen cleared'; }
    /*
     * A WHOLE CHAPTER AT A TIME. "Next chapter", "the chapter before".
     *
     * It walks off the end of a book on purpose: chapter 1 of Mark, going back,
     * lands on the last chapter of Matthew, because that is where the text
     * actually is. Stopping dead at a book boundary is the sort of thing that
     * reads as the feature being broken rather than as it being careful.
     */
    if (intent.kind === 'chapter') {
      const res = pv.bibleResult;
      if (!res || !res.bookNr || !res.chapter) return null;
      const books = pv.bookList || [];
      const at = books.findIndex((b) => b.nr === res.bookNr);
      if (at < 0) return null;
      let bi = at, ch = res.chapter + (intent.delta > 0 ? 1 : -1);
      if (ch < 1) {
        if (bi === 0) return null;                       // the very start of the Bible
        bi--; ch = books[bi].chapters;
      } else if (ch > books[bi].chapters) {
        if (bi === books.length - 1) return null;        // …and the very end
        bi++; ch = 1;
      }
      $('#pvRef').value = `${books[bi].name} ${ch}`;
      await findScripture();
      const got = pv.bibleResult;
      if (!got || !got.verses || !got.verses.length) return null;
      if (pv.blackout) { pv.blackout = false; pushLive(); renderClearPalette(); }
      if (!sendVerseLive(got.verses[0].verse)) return null;
      return `${books[bi].name} ${ch}`;
    }
    if (intent.kind === 'verse') {
      if (!pv.bibleResult) return null;
      const has = (pv.bibleResult.verses || []).some((v) => v.verse === intent.verse);
      if (!has) return null;
      return sendVerseLive(intent.verse) ? `verse ${intent.verse}` : null;
    }
    if (intent.kind === 'ref') {
      /*
       * The WHOLE CHAPTER is loaded, and the screen simply starts on the verse
       * that was named. Fetching only the named verse looks tidier and breaks
       * the next thing the preacher always does: announce "John three sixteen",
       * read it, then say "next verse" — which has nowhere to go if verse 16 is
       * the only one that was ever fetched.
       */
      $('#pvRef').value = `${intent.book} ${intent.chapter}`;
      await findScripture();
      const res = pv.bibleResult;
      if (!res || !res.verses || !res.verses.length) return null;
      const first = (intent.verses && intent.verses[0]) || res.verses[0].verse;
      if (pv.blackout) { pv.blackout = false; pushLive(); renderClearPalette(); }
      if (!sendVerseLive(first)) return null;
      return intent.verses ? `${intent.book} ${intent.chapter}:${first}` : `${intent.book} ${intent.chapter}`;
    }
    return null;
  }

  /**
   * One finished phrase: ask main what it was, then act on it.
   *
   * Recognising a phrase takes about as long as saying a short one, so a
   * preacher who announces a reference and immediately says "next verse" will
   * produce the second phrase while the first is still being worked out. Those
   * queue rather than being thrown away — losing an instruction because the
   * engine was busy is exactly the kind of unreliability this feature cannot
   * afford. The queue is short on purpose: if it ever gets that far behind,
   * what is in it is stale and the oldest goes rather than the newest.
   */
  async function onVoicePhrase(pcm16, meta) {
    const partial = !!(meta && meta.partial);
    /*
     * A PHRASE CUT AT THE LENGTH CAP IS NOT WORTH A CLOUD REQUEST.
     *
     * With the cloud ear listening, the rolling look-backs already cover every
     * second of continuous speech, twelve seconds at a time and overlapping by
     * five. A capped phrase is the same seconds again, and it arrives every
     * thirty of them for the whole sermon — so sending it would spend a third
     * of a finite free allowance on audio that has already been recognised,
     * and spend it out of the reserve kept for instructions somebody actually
     * paused to give.
     *
     * It is dropped rather than downgraded because a downgraded one still costs
     * a request. On this PC, where a window costs nothing but processor time,
     * it is sent exactly as it always was.
     */
    if (meta && meta.capped && pv.listen.cadence) { pv.listen.dropped++; return; }
    if (pv.listen.busy) {
      /*
       * A LOOK-BACK IS NEVER QUEUED. It is an offer to look at the last few
       * seconds again, and by the time the engine is free those seconds have
       * been superseded by newer ones — recognising them then would act on
       * stale words and put the machine permanently behind. Dropping it is
       * also what makes the cadence self-tuning: a fast PC gets a look every
       * 1.2 s, a slow one gets one whenever it can, and neither falls behind.
       * A finished phrase still queues, because that one is an instruction
       * somebody actually paused to give and losing it is unforgivable.
       */
      if (partial) { pv.listen.dropped++; return; }
      pv.listen.queue.push({ pcm: pcm16, meta });
      while (pv.listen.queue.length > 2) { pv.listen.queue.shift(); pv.listen.dropped++; }
      return;
    }
    pv.listen.busy = true;
    try {
      const r = await window.api.voice.hear(pcm16, liveVerseContext(), pv.listen.fast, pv.listen.quote, pv.listen.model,
        // `capped` travels with it so the cloud allowance can tell an
        // instruction somebody paused to give from a sentence the ear simply
        // had to cut at eight seconds. See voiceear.js and voice:hear.
        { partial, capped: !!(meta && meta.capped) });
      if (!r || !r.ok) {
        /*
         * Said ONCE, not once a phrase. A hall whose internet has gone produces
         * one of these every few seconds, and forty identical warnings bury the
         * transcript that is the operator's only way of seeing what is going on.
         */
        const why = r && r.reason === 'cloud-down'
          ? '☁︎ ' + esc(r.why || 'the cloud ear is not answering') + ' — and there is no model on this PC to fall back to'
          : '⚠️ nothing is set up to listen with';
        if (pv.listen.lastWarn !== why) { pv.listen.lastWarn = why; listenLog(why, 'warn'); }
        return;
      }
      pv.listen.lastWarn = '';
      noteWhoHeard(r);
      await actOnHeard(r, { partial });
    } catch (e) {
      if (!partial) listenLog('⚠️ ' + esc(e.message || 'could not listen'), 'warn');
    } finally {
      pv.listen.busy = false;
      const next = pv.listen.queue.shift();
      if (next) onVoicePhrase(next.pcm, next.meta || { partial: false });
    }
  }

  /**
   * Keep count of which engine actually answered, and say so when it changes.
   *
   * The cloud ear falling back to this PC is not an error and must not read as
   * one — the whole point of the fallback is that the service carries on. But
   * it is the single most useful thing an operator can know when the transcript
   * suddenly gets worse halfway through a sermon, and without a line in the log
   * it is invisible. So it is mentioned ONCE per change of engine, not once per
   * phrase: forty "went back to this PC" lines would bury the words.
   */
  function noteWhoHeard(r) {
    const via = r && r.via === 'cloud' ? 'cloud' : 'local';
    if (via === 'cloud') pv.listen.viaCloud++; else pv.listen.viaLocal++;
    /*
     * A PACED SKIP IS NOT AN OUTAGE, AND SAYING SO WAS THE NOISE IN THE LOG.
     *
     * The cloud ear deliberately declines look-backs to stay inside a free
     * allowance that has to last a whole service — that is what the cadence is
     * for, and it happens several times a minute by design. Each one fell back
     * to this PC, which read as a change of engine, so the transcript filled
     * with "listening on this PC for now" / "back on the cloud ear" pairs and
     * the words the operator was actually watching for scrolled away. A skip
     * taken on purpose now says nothing at all; a real failure still says it
     * once. (`paced` comes from cloudspeech.lastDecline via voicelisten.)
     */
    if (r && r.paced) { pv.listen.pacedSkips = (pv.listen.pacedSkips || 0) + 1; return; }
    if (pv.listen.lastVia === via) return;
    const first = !pv.listen.lastVia;
    pv.listen.lastVia = via;
    if (first) return;                       // the first phrase is not a "change"
    if (via === 'local') {
      refreshCloudState().then(() => {
        const why = (pv.listen.cloud && pv.listen.cloud.why) || 'the cloud ear did not answer';
        listenLog('↩︎ listening on this PC for now — ' + esc(why), 'warn');
        noteCloudFuel();
      }).catch(() => {});
    } else {
      listenLog('☁︎ back on the cloud ear');
      refreshCloudState().then(noteCloudFuel).catch(() => {});
    }
  }

  /**
   * What to do about one line that has been heard.
   *
   * Split out from the microphone so the studio's own tests can drive the
   * whole of it — the log, the cool-down, the intent, the screen — with a
   * transcript instead of sound. Everything below this line is the shipping
   * path either way.
   */
  /* ==================== FOLLOWING THE READING ====================
   *
   * A verse is on the screen, the speaker reads it aloud, and when they reach
   * its last words the next one comes up on its own.
   *
   * WHY THIS LISTENS TO LOOK-BACKS AS WELL AS FINISHED PHRASES: somebody
   * reading scripture out loud does not pause at the end of a verse — they
   * read on into the next sentence. Waiting for the endpointer to call time
   * would turn the page somewhere in the middle of the verse after it. The
   * rolling look-backs are what make this land on the right word.
   *
   * …WHICH IS ALSO WHY IT HAS TO REMEMBER. The same six seconds of audio are
   * offered again every 1.2 s, so the completed reading arrives three or four
   * times over. `readKey` pins the chunk that has already been turned, so the
   * reading advances one verse rather than four. It is the chunk's identity,
   * not a timer: the guard cannot expire in the middle of a slow reading.
   */
  function chunkLastVerse() {
    const c = pv.verseCue, res = pv.bibleResult;
    if (!c || !res || c.reference !== res.reference) return null;
    let last = null;
    for (const v of (res.verses || [])) if (chunkOf(res, v.verse) === c.ix) last = v;
    return last;
  }

  /* ===================== THE TAPE ==========================================
   *
   * ►► WHY ONE LOOK-BACK WAS NEVER ENOUGH.
   *
   * A look-back is the last six seconds — about fourteen words at reading
   * pace. `minVerseShare` asks for a third of the verse to be present, so a
   * verse longer than roughly forty words could not clear that bar in ANY
   * single window, however perfectly it was read. Measured on real verses at
   * 135 wpm: Ephesians 1:3 and Matthew 5:44-45 never turned the page, ever.
   * The unit test did not catch it because it handed the matcher the whole
   * verse in one string, which is a thing the microphone never does.
   *
   * So the windows are welded back into one continuous transcript
   * (ReadAlong.stitch) and the matcher is given that instead. 7 of 9 real
   * verses turned before; 9 of 9 after.
   *
   * `used` is the other half of it. Once a run of words has turned the page
   * they are spent: without that mark the same reading sits in the tape for
   * another forty seconds and turns the NEXT verse as well, and the one after,
   * with the reader having said nothing. Marking rather than deleting them is
   * deliberate — the stitcher needs the old words to recognise the overlap in
   * the window that arrives next.
   */
  function tapeAdd(heard) {
    if (!window.ReadAlong) return 0;
    const t = pv.listen.tape;
    // Fuzzy: two recognitions of the same seconds never agree exactly at their
    // edges, and an exact join pasted whole windows in twice. See stitchFuzzy.
    const n = (window.ReadAlong.stitchFuzzy || window.ReadAlong.stitch)(t, heard);
    if (n) t.at = Date.now();
    return n;
  }
  function tapeWords() {
    const t = pv.listen.tape;
    return (t.words || []).slice(t.used || 0);
  }
  /** Forget everything heard so far — a new passage is not a continuing reading. */
  function tapeReset() {
    pv.listen.tape = { words: [], stems: [], used: 0, at: 0 };
    pv.listen.readKey = '';
    pv.listen.autoTurn = null;
    pv.listen.readingAt = 0;
    setCloseFollow(false);
  }

  /*
   * A reading that stopped is not a reading. Somebody who reads half a verse
   * and then preaches for two minutes must not have the page turn under them
   * when they happen to say the closing words later, so the tape is dropped
   * after a gap with nothing new in it.
   */
  const TAPE_IDLE_MS = 25000;
  function tapeExpire() {
    const t = pv.listen.tape;
    if (t.at && Date.now() - t.at > TAPE_IDLE_MS && (t.words || []).length) {
      t.words = []; t.stems = []; t.used = 0; t.at = 0;
      setCloseFollow(false);
    }
  }

  /*
   * WHERE IN THE CHAPTER THE READER IS — see ReadAlong.track().
   *
   * The follower used to ask one question of one verse: "has the verse on the
   * screen been read to its end?". Replayed against real readings from this
   * church's services, the page then went backwards and forwards, sat on a
   * verse whose ending whisper had garbled while the reader went on, and put
   * up Psalm 24:9 for 24:7 because the two are the same words. The tracker
   * looks at the verse on the screen AND the few after it, and only ever moves
   * forward. Returns null, or a line for the log.
   */
  const FOLLOW_LOOKAHEAD = 3;
  function followReading(heard) {
    if (!pv.listen.follow || !window.ReadAlong) return null;
    const c = pv.verseCue, res = pv.bibleResult;
    const v = chunkLastVerse();
    if (!v || !v.text || !c || !res) { setCloseFollow(false); return null; }
    const words = tapeWords();
    if (!words.length) return null;
    if (window.ReadAlong.track) return trackReading(v, words);
    const r = window.ReadAlong.finishedReading(v.text, words);
    pv.listen.lastRead = r;
    /*
     * CLOSE-FOLLOW. The moment the reader is plainly inside this verse, the ear
     * is asked to look back far more often — because the event being waited for
     * is a single word a few seconds away, and on the cloud ear the ordinary
     * pace is one look every 6.7 seconds. Measured on real verses, that put the
     * page turn up to 5.9 SECONDS after the last word: long enough that the
     * congregation has already looked down at their own Bible, which is exactly
     * the "shocking" part of it.
     */
    if (!r.done) { setCloseFollow(!!r.reading); return null; }

    const before = pv.verseCue.ix;
    // Spend the words that earned this turn, whatever happens next.
    if (r.endHeard >= 0) pv.listen.tape.used += r.endHeard + 1;
    setCloseFollow(false);
    step(1);
    // At the end of the passage there is nowhere to go; say nothing rather
    // than claim to have moved.
    if (pv.verseCue && pv.verseCue.ix === before) return null;
    pv.listen.acted++;
    pv.listen.readKey = (pv.verseCue.reference || '') + '#' + before;
    const said = words.slice(Math.max(0, r.endHeard - 9), r.endHeard + 1).join(' ');
    listenLog(`<b>verse ${v.verse} read to the end</b> <i class="pv-quote-tag">followed</i> — “…${esc(said)}”`, 'did');
    return `verse ${v.verse} read — moved on`;
  }

  function trackReading(target, words) {
    const c = pv.verseCue, res = pv.bibleResult;
    const all = res.verses || [];
    const firstIx = all.findIndex((x) => chunkOf(res, x.verse) === c.ix);
    const tIx = all.findIndex((x) => x.verse === target.verse);
    if (firstIx < 0 || tIx < 0) return null;
    const view = all.slice(firstIx, tIx + 1 + FOLLOW_LOOKAHEAD);
    const r = window.ReadAlong.track(view, target.verse, words);
    pv.listen.lastRead = r;
    if (r.located != null) pv.listen.readingAt = Date.now();
    if (r.action === 'none' || r.toVerse == null) { setCloseFollow(!!r.reading); return null; }
    const before = c.ix;
    const to = Math.min(chunkOf(res, r.toVerse), c.slides.length - 1);
    // Spend the words that earned this move, whatever happens next.
    if (r.endHeard >= 0) pv.listen.tape.used += r.endHeard + 1;
    setCloseFollow(false);
    if (to <= before) return null;                       // never backwards on its own
    cueVerseChunk(to);
    if (pv.verseCue.ix === before) return null;
    pv.listen.acted++;
    pv.listen.readKey = (pv.verseCue.reference || '') + '#' + before;
    // "Go on" said straight after this is the pastor agreeing, not asking for a
    // second verse — see absorbGoOn().
    pv.listen.autoTurn = { at: Date.now(), ix: pv.verseCue.ix };
    const said = words.slice(Math.max(0, r.endHeard - 9), r.endHeard + 1).join(' ');
    const what = r.action === 'catchup'
      ? `<b>caught up to verse ${r.toVerse}</b> <i class="pv-quote-tag">followed · the reader was ahead</i>`
      : `<b>verse ${target.verse} read to the end</b> <i class="pv-quote-tag">followed</i>`;
    listenLog(`${what} — “…${esc(said)}”`, 'did');
    return r.action === 'catchup' ? `caught up to verse ${r.toVerse}` : `verse ${target.verse} read — moved on`;
  }

  /*
   * "GO ON" RIGHT AFTER THE PAGE HAS TURNED ITSELF.
   *
   * In this church a verse is read, the pastor comments, and then says "Go on"
   * (or "next verse") for the reader to continue. With Follow the reading on,
   * the page has ALREADY turned at the end of the verse — so obeying "Go on" as
   * well moved it a second time, and the screen sat a verse ahead of the reader
   * for the rest of the passage. A "next" that arrives soon after an automatic
   * turn, before any of the new verse has been read, is the pastor saying the
   * same thing the follower already did. The second "next" still works.
   */
  const GO_ON_MS = 20000;
  function absorbGoOn(intent) {
    if (!intent || intent.kind !== 'next' || !pv.listen.follow) return false;
    const a = pv.listen.autoTurn;
    if (!a || !pv.verseCue || pv.verseCue.ix !== a.ix || Date.now() - a.at > GO_ON_MS) return false;
    pv.listen.autoTurn = null;                            // absorb ONE, not every
    return true;
  }

  /*
   * A QUOTATION FOUND WHILE A PASSAGE IS BEING FOLLOWED.
   *
   * Inside the chapter on the screen the tracker decides, not the search: it
   * knows the order, and the search does not — which is how the screen went
   * back a verse every time a look-back still held the one just read, and how
   * Psalm 24:9 went up for 24:7. So a quotation of the SAME chapter is left to
   * the tracker.
   *
   * A quotation of somewhere else, mid-reading, needs to be unmistakable. A
   * reading goes on for minutes and a five-word phrase can land on scripture by
   * accident — measured on a real service, "…which are in Christ Jesus" (a run
   * of FIVE) pulled a reading of 1 Timothy 1 over to 1 Thessalonians 2:14 for
   * four seconds. Eight in a row, and most of what was said, is what a single
   * sentence of a look-back has to carry anyway (TAIL_MIN_RUN in versefind.js):
   * "give and it shall be given unto you" is eight, all of it, and must still
   * open Luke 6:38 however recently a reading turned its page. Nine was tried
   * and refused exactly that.
   */
  const READING_ACTIVE_MS = 30000;
  const MID_READING_RUN = 8, MID_READING_SHARE = 0.8;
  function quoteYieldsToReading(intent, quote) {
    if (!intent || !intent.viaQuote || !pv.listen.follow) return false;
    const res = pv.bibleResult, c = pv.verseCue;
    if (!res || !c || c.reference !== res.reference) return false;
    if (res.bookNr === intent.bookNr && res.chapter === intent.chapter) return true;
    const active = pv.listen.readingAt && Date.now() - pv.listen.readingAt < READING_ACTIVE_MS;
    if (!active) return false;
    const q = quote || {};
    return !((q.run || 0) >= MID_READING_RUN && (q.share || 0) >= MID_READING_SHARE);
  }

  /*
   * IS THE QUOTE MATCHER POINTING AT THE VERSE ALREADY ON THE SCREEN?
   *
   * ►► THIS IS WHY THE TWO TICK BOXES FOUGHT EACH OTHER. ◄◄
   *
   * Somebody reading the verse on the wall is, to the quotation matcher, a
   * person quoting that verse — and it is right, and its answer is useless.
   * It produced a `ref` intent, `actOnHeard` acted on the intent instead of
   * calling followReading at all, and applyVoiceIntent reloaded the chapter and
   * sent the SAME verse live again. So with both boxes ticked the page could
   * never turn: every reading was claimed by the search, and the screen jumped
   * back to the verse the reader had just finished.
   *
   * The rule that settles it: a quotation of what is ALREADY on the screen is
   * not navigation, it is a reading. The search stays quiet and the reading
   * follower takes it. A quotation of any OTHER verse still wins, which is the
   * feature the operator asked for and it is untouched.
   */
  /* ==================== CLOSE-FOLLOW =====================================
   *
   * THE PROBLEM IT SOLVES, MEASURED.
   *
   * The ear's ordinary pace is set by whoever is listening. On this PC it is a
   * six-second window every 1.2 s, and the page turns within a second of the
   * last word — which is what the feature is supposed to feel like. On the
   * cloud ear the pace is a twelve-second window every 6.7 s, because that is
   * what the free allowance sustains for a whole service (see cloudspeech.js),
   * and the page then turns anywhere from 0.1 to 5.9 SECONDS after the last
   * word. Five seconds is long enough that the reader has moved on and the
   * congregation has looked away, and the turn reads as the studio lagging.
   *
   * WHY IT CAN BE FIXED CHEAPLY. Asking the cloud more often is not the answer
   * — that is the allowance the pacing exists to protect. But the question this
   * is asking is not the ear's usual one. The ear has to recognise anything
   * anybody might say; this has to notice whether ONE KNOWN SENTENCE has
   * reached its last words, against text already on the screen, with a matcher
   * built to absorb a recogniser that gets a word in ten wrong. That is a job
   * the small local model does perfectly well, and it costs nothing but a
   * little processor.
   *
   * SO IT IS ARMED, NOT ALWAYS ON. Nothing extra runs until the tape shows the
   * reader is inside the verse on the screen and has not yet finished it. Then
   * a short local look-back runs every second or so until the page turns, the
   * reading stops, or CLOSE_MAX_MS goes by. Idle cost: zero. Cost while
   * reading a verse: a few hundred milliseconds of one core for ten seconds.
   *
   * It never touches the cloud (`local: true`), so it cannot spend the
   * allowance, cannot trip the rate limit, and cannot make the transcript churn
   * between engines.
   */
  const CLOSE_MAX_MS = 30000;      // a "reading" that lasts longer than this is preaching
  function setCloseFollow(on) {
    // What it WOULD arm, recorded whether or not there is a microphone open —
    // the studio's own tests drive this path with text and no ear at all.
    pv.listen.closeWant = !!on && !!pv.listen.follow;
    const want = pv.listen.closeWant && !!pv.listen.ear;
    if (want === pv.listen.close) {
      if (want && Date.now() - pv.listen.closeAt > CLOSE_MAX_MS) setCloseFollow(false);
      return;
    }
    pv.listen.close = want;
    pv.listen.closeAt = want ? Date.now() : 0;
    try { if (pv.listen.ear && pv.listen.ear.setCloseLook) pv.listen.ear.setCloseLook(want); } catch (e) {}
  }

  /**
   * One close look-back: the last few seconds, recognised on THIS PC, used for
   * nothing except deciding whether the verse on the screen has been finished.
   *
   * It has its own busy flag rather than sharing `pv.listen.busy`: the ordinary
   * path may be waiting on the cloud for half a second at a time, and a close
   * look that queued behind it would arrive exactly as late as the thing it
   * exists to beat.
   */
  async function onCloseLook(pcm16) {
    if (!pv.listen.close || pv.listen.closeBusy) return;
    pv.listen.closeBusy = true;
    try {
      const r = await window.api.voice.hear(pcm16, null, true, false, pv.listen.model,
        // local: never the cloud. quote: off — this is not a search.
        { partial: true, local: true });
      if (!r || !r.ok || !r.text) return;
      pv.listen.closeLooks++;
      tapeAdd(r.text.trim());
      const did = followReading(r.text.trim());
      if (did) pv.listen.lastCloseDid = did;
    } catch (e) { /* the ordinary look-backs still drive it */ }
    finally { pv.listen.closeBusy = false; }
  }

  /*
   * …AND SAYING THE WORDS ON THE SLIDE IS SINGING THEM.
   *
   * Worship is full of scripture — "blessed be the name of the Lord", "let
   * everything that has breath praise the Lord" — and the quote finder is right
   * that those are verses. But when the same words are on the live slide, the
   * room is SINGING them, and swapping the lyric for a verse leaves a
   * congregation with nothing to sing. It is the rule above for a reading,
   * applied to a slide: words already on the wall are not an instruction.
   *
   * It is the WORDS, not the kind of presentation, that decide. Everything that
   * is not a Bible reading is a "song" here — notices, pictures, the sermon's
   * own points — and a sermon slide on the wall must not silence the finder
   * for the whole sermon.
   */
  const wordsOf = (t) => String(t || '').toLowerCase().replace(/[‘’ʼ']/g, '').match(/[a-z0-9]+/g) || [];
  function singsWhatIsShown(heard) {
    if (pv.verseCue || pv.blackout || pv.outMode !== 'slide' || !(pv.liveIx >= 0)) return false;
    const d = (pv.presentations || []).find((x) => x.id === pv.liveDocId);
    const s = d && d.slides && d.slides[pv.liveIx];
    const shown = wordsOf(((s && s.lines) || []).join(' '));
    if (shown.length < 3) return false;
    const said = wordsOf(heard);
    // the longest run of words said in the same order as they stand on the slide
    let best = 0, prev = new Array(shown.length + 1).fill(0);
    for (let i = 0; i < said.length; i++) {
      const cur = new Array(shown.length + 1).fill(0);
      for (let j = 0; j < shown.length; j++) {
        if (said[i] === shown[j]) { cur[j + 1] = prev[j] + 1; if (cur[j + 1] > best) best = cur[j + 1]; }
      }
      prev = cur;
    }
    return best >= Math.min(5, shown.length);
  }

  function quotesWhatIsShown(intent) {
    if (!intent || !intent.viaQuote) return false;
    const c = pv.verseCue, res = pv.bibleResult;
    if (!c || !res) return false;
    const want = (intent.verses && intent.verses[0]) || null;
    if (!want) return false;
    /*
     * The same chapter — compared by NUMBER, not by the reference string. A
     * prefix test reads "John 11:1-57" as starting with "John 1", so a genuine
     * quotation of John 1:1 said while John 11 was on the wall would have been
     * thrown away as "they are just reading what is up there".
     */
    if (res.bookNr == null || res.chapter == null) return false;
    if (res.bookNr !== intent.bookNr || res.chapter !== intent.chapter) return false;
    // …and the verse is one of the ones the screen is showing right now.
    return (res.verses || []).some((v) => v.verse === want && chunkOf(res, v.verse) === c.ix);
  }

  async function actOnHeard(r, opts) {
    const partial = !!(opts && opts.partial);
    let lastDid = null, lastQuoted = false;
    {
      const heard = (r.text || '').trim();
      if (!heard) return { did: null, quoted: false, heard: '', quote: r.quote || null };
      let intent = r.intent;
      /*
       * Reading the verse out is checked BEFORE the intent branches, and
       * deliberately before the `partial` early-return below: a reading is
       * continuous speech and reaches this function as look-backs, never as a
       * finished phrase. It is checked AFTER `intent` is read but acted on
       * first only when there is no SPOKEN instruction — "next verse" is an
       * order and must never be second-guessed by this.
       *
       * A quotation of the verse ALREADY ON THE SCREEN is not an instruction,
       * it is the reading itself, and it is dropped here so the follower can
       * have it. See quotesWhatIsShown().
       */
      tapeExpire();
      tapeAdd(heard);
      if (intent && quotesWhatIsShown(intent)) intent = null;
      if (intent && quoteYieldsToReading(intent, r.quote)) intent = null;
      if (intent && intent.viaQuote && singsWhatIsShown(heard)) intent = null;
      // "Go on" straight after the page turned itself: already done.
      if (intent && !partial && absorbGoOn(intent)) {
        listenLog(`${esc(heard)} <i>(already on it — the reading turned the page)</i>`);
        return { did: null, quoted: false, heard, absorbed: true, quote: r.quote || null };
      }
      if (!intent) {
        const followed = followReading(heard);
        if (followed) return { did: followed, quoted: false, heard, followed: true, quote: r.quote || null };
      }
      if (!intent) {
        /*
         * WHAT IT ALMOST DID IS NOT NEWS.
         *
         * A near-miss used to be annotated in the log — "…nearly Matthew 7:7"
         * — on the reasoning that an operator needs to see the feature is
         * alive. In a service it reads as the opposite: the studio announcing
         * that it knows the verse and is not going to put it up. The operator's
         * answer, correctly, is "then put it up". Either it is confident enough
         * to act or it should say nothing about it; the transcript alone is
         * proof enough that it is listening.
         *
         * Look-backs do not even get that: there are dozens a minute and
         * logging every one buries the lines that matter under a transcript.
         */
        if (partial) return { did: null, quoted: false, heard, quote: r.quote || null, partial: true };
        listenLog(esc(heard));
        return { did: null, quoted: false, heard, quote: r.quote || null };
      }
      /*
       * A LOOK-BACK MAY SAY WHERE TO GO; IT MAY NOT SAY "AGAIN".
       *
       * The same words sit in three or four overlapping look-backs, so acting
       * on "next verse" from one of them would move the screen three or four
       * verses. What separates the two is not naming versus stepping, it is
       * ABSOLUTE versus RELATIVE: "John 3:16" and "verse five" mean the same
       * thing however many times they arrive, and "next verse" does not. So the
       * absolute ones are allowed through — and they must be, because "verse
       * five" said mid-sentence was being silently dropped here, which from the
       * desk looked exactly like the studio ignoring the operator.
       */
      const ABSOLUTE = { ref: 1, verse: 1 };
      if (partial && !ABSOLUTE[intent.kind]) return { did: null, quoted: false, heard, partial: true, quote: r.quote || null };
      const now = Date.now();
      const sig = intent.kind + (intent.ref || intent.verse || '');
      /*
       * How long "already done" lasts. Naming a passage has to outlast the
       * look-back window it can be repeated in (six seconds of audio, offered
       * again every 1.2 s, then the finished phrase carrying the same words) or
       * one announcement reloads the chapter half a dozen times. Stepping stays
       * on the short guard it always had: that one only ever comes from a
       * finished phrase, and a preacher really can say "next verse" twice.
       */
      const coolMs = (intent.kind === 'ref' || intent.kind === 'verse') ? REF_COOLDOWN_MS : LISTEN_COOLDOWN_MS;
      if (sig === pv.listen.lastSig && now - pv.listen.lastAt < coolMs) {
        if (!partial) listenLog(esc(heard) + ' <i>(already done)</i>');
        return { did: null, quoted: false, heard, repeat: true, quote: r.quote || null };
      }
      const did = await applyVoiceIntent(intent);
      pv.listen.lastSig = sig; pv.listen.lastAt = now;
      lastDid = did; lastQuoted = !!intent.viaQuote;
      if (did) {
        pv.listen.acted++;
        /*
         * A quoted verse is marked as such in the log, because the operator
         * needs to be able to tell "I was told to do this" from "I worked out
         * that this is what they were quoting" at a glance — the second is a
         * judgement and they may want to overrule it.
         */
        const q = r.quote;
        const how = intent.viaQuote
          ? ` <i class="pv-quote-tag">quoted${q && q.agree ? ' · ' + (+q.agree) + ' Bibles agree'
            : q && q.matchedIn ? ' · matched in ' + esc(shortTrans(q.matchedIn)) : ''}${q && q.alsoAt ? ' · also ' + esc(q.alsoAt) : ''}</i>`
          : '';
        listenLog(`<b>${esc(did)}</b>${how} — “${esc(heard)}”`, 'did');
      } else listenLog(esc(heard) + ' <i>(nothing to move)</i>', 'warn');
    }
    return { did: lastDid, quoted: lastQuoted, heard: (r.text || '').trim(), quote: r.quote || null };
  }

  /* ---------------------- which microphone ----------------------
   *
   * A church PC usually has several inputs — its own microphone, the desk feed
   * on a USB interface, a webcam, whatever a streaming box presents — and 🎤
   * Listen is useless pointed at the wrong one. The PC's own microphone in
   * particular will not hear a preacher across a hall, which looks exactly like
   * the feature being broken.
   *
   * Names are the awkward part: the browser will not tell anyone what the
   * devices are CALLED until microphone permission has been granted, so before
   * that the list can only offer "Microphone 2". Rather than open a microphone
   * nobody asked for at startup just to learn the names, the list is filled
   * blind and the names are filled in at the first moment we legitimately hold
   * a stream — when Listen is switched on, or when the operator opens the list
   * itself, which is intent enough to ask.
   */
  /** "bolls:NKJV" -> "NKJV", for a log line that has to stay short. */
  function shortTrans(a) { return String(a || '').replace(/^bolls:/, '').toUpperCase(); }

  function micLabelOf(id) {
    const d = (pv.listen.mics || []).find((m) => m.deviceId === id);
    return d ? d.label : null;
  }
  /**
   * Open a stream briefly, only to make the OS hand over the device names.
   *
   * Guarded by the in-flight promise because clicking the list fires mousedown
   * AND focus, and without it that is two microphone requests racing — which on
   * a machine that has not granted permission yet means two prompts.
   */
  function unlockMicNames() {
    if ((pv.listen.mics || []).some((d) => d.label)) return Promise.resolve(false);
    if (pv.listen.unlocking) return pv.listen.unlocking;
    pv.listen.unlocking = (async () => {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
        return true;
      } catch (e) { return false; }   // refused: the ids still work, the names stay blank
      finally { pv.listen.unlocking = null; }
    })();
    return pv.listen.unlocking;
  }
  /* ---------------------- and which NDI feed -------------------------
   *
   * The list above can only ever show what WINDOWS has: a USB interface, a
   * webcam, the PC's own microphone. Plenty of churches have none of those
   * carrying the service. A room running Ableton with the official "NDI
   * Output" VST on the master, or a vMix desk publishing "vMix Audio -
   * Master", has the preacher on the NETWORK and on no sound card at all — so
   * Listen, pointed at the only device offered, heard an empty room and looked
   * broken. Go Live has spoken NDI for a long time; this puts the same feeds in
   * front of Listen. See ndi-listen.js.
   */
  const NDI_PREFIX = 'ndi:';
  async function refreshNdiFeeds() {
    if (!window.NdiListen) { pv.listen.ndi = []; return; }
    const a = await window.NdiListen.available();
    pv.listen.ndiOk = !!a.ok;
    pv.listen.ndiWhy = a.error || '';
    pv.listen.ndi = a.ok ? await window.NdiListen.sources() : [];
  }
  /* ==================== WHICH MODEL DOES THE LISTENING ====================
   *
   * Same shape as the caption and long-to-shorts pickers (veditor.js
   * renderAsrPicker): a model that is NOT downloaded is still offered, marked
   * with its size, and choosing it downloads it and then selects it — so "I
   * want the better one" is one action rather than a hunt for a button.
   *
   * WHAT IS DIFFERENT HERE IS THE SPEED WARNING, and it is not decoration.
   * Captions transcribe one clip and can take as long as they like. 🎤 Listen
   * asks for a six-second look-back every 1.2 seconds, all service, so a model
   * that cannot run several times faster than real time does not "run slowly"
   * — it falls behind and stays behind. Measured on this machine over 39.8 s
   * of real service audio:
   *
   *      base.en      6.6 s     6x faster than real time
   *      small.en    20.2 s     2x faster than real time
   *      medium.en  128.9 s     3.2x SLOWER than real time
   *
   * So Medium is offered, because an operator with a fast PC may want it and
   * an explicit choice is an instruction — but it is never chosen
   * automatically, and the dialog says plainly what it costs.
   *
   * Tiny is deliberately absent: it is in the catalogue for the shorts scanner,
   * and it mishears too much to put a verse on a wall.
   */
  const LISTEN_MODELS = ['base.en', 'small.en', 'medium.en', 'large-v3-turbo'];
  const modelSizeText = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB');
  const shortModelName = (m) => String((m && m.name) || '').split(' —')[0].split(' (')[0];

  /* ================== WHO DOES THE LISTENING ==============================
   *
   * Everything above this line is about the models that run on THIS PC, and the
   * table just above says exactly why they are the wrong tool: the only two
   * that keep up with a live service are the two smallest Whisper was ever
   * shipped in, and the one that would be good enough runs 3.2x slower than
   * real time.
   *
   * The cloud ear is the way out of that, because it is not a trade-off — the
   * full-size model, on hardware built for it, comes back FASTER than base.en
   * manages locally as well as far more accurately. So it leads the picker, and
   * this PC is what it falls back to when a church has no internet, has not set
   * a key up, or runs out of a free allowance mid-service.
   *
   * See src/main/cloudspeech.js for the allowance and the pacing it forces.
   */
  async function refreshCloudState() {
    try { pv.listen.cloud = await window.api.voice.cloudState(); } catch (e) { pv.listen.cloud = null; }
    return pv.listen.cloud;
  }
  const cloudOn = () => !!(pv.listen.cloud && pv.listen.cloud.on);
  const cloudProvider = () => (pv.listen.cloud && (pv.listen.cloud.providers || [])
    .find((x) => x.id === pv.listen.cloud.provider)) || null;

  /** The Hearing picker: every cloud service, then this PC. */
  async function renderListenEngine() {
    const sel = $('#pvListenEngine');
    if (!sel) return;
    const st = pv.listen.cloud || await refreshCloudState();
    if (!st) return;
    sel.innerHTML = (st.providers || []).map((p) =>
      `<option value="cloud:${attr(p.id)}">${esc(p.label)}</option>`).join('')
      + `<option value="local">This PC — offline, less accurate</option>`;
    sel.value = st.on ? 'cloud:' + st.provider : 'local';
    if (!sel._wired) {
      sel._wired = true;
      sel.addEventListener('change', async () => {
        const v = sel.value;
        const on = v.indexOf('cloud:') === 0;
        await setCloud({ on, provider: on ? v.slice(6) : (st.provider || 'groq') });
      });
    }
    showEngineRows();
  }

  /** Save one change to the cloud ear and redraw everything that depends on it. */
  async function setCloud(patch) {
    try { pv.listen.cloud = await window.api.voice.cloudSet(patch); } catch (e) {}
    renderCloudSetup();
    showEngineRows();
    noteListenModel();
    /*
     * Changing who is listening changes HOW OFTEN the ear should offer a
     * look-back — the cloud has a free allowance to live inside, this PC has a
     * processor. If it is listening right now, it is restarted so the new pace
     * takes effect rather than waiting for the next service.
     */
    if (pv.listen.ear) { stopListening(); await startListening(); }
  }

  /** Show the setup that belongs to whichever engine is chosen, and hide the other. */
  function showEngineRows() {
    const on = cloudOn();
    const box = $('#pvListenCloudBox'); if (box) box.classList.toggle('hidden', !on);
    const row = $('#pvListenModelRow'); if (row) row.classList.toggle('hidden', on);
    // "Faster replies" keeps a model loaded on this PC. With the cloud ear
    // there is no such model, so the tick box is not a choice — it is a puzzle.
    const fast = $('#pvListenFastRow'); if (fast) fast.classList.toggle('hidden', on);
    const sel = $('#pvListenEngine');
    if (sel) sel.value = on ? 'cloud:' + pv.listen.cloud.provider : 'local';
  }

  /** The key box, the model list, and how much of the free allowance is left. */
  function renderCloudSetup() {
    const st = pv.listen.cloud;
    const box = $('#pvListenCloudBox');
    if (!st || !box) return;
    const p = cloudProvider();
    const blurb = $('#pvListenCloudBlurb');
    if (blurb && p) blurb.textContent = p.blurb;
    const key = $('#pvListenCloudKey');
    if (key) {
      if (p) key.placeholder = 'paste your key — ' + p.keyHint;
      // The saved key is never sent back to the page. Showing that one IS saved
      // without showing what it is answers the only question an operator has.
      if (document.activeElement !== key) key.value = st.hasKey ? '••••••••••••••••' : '';
    }
    const urlRow = $('#pvListenCloudUrlRow');
    if (urlRow) urlRow.classList.toggle('hidden', !(p && p.needsUrl));
    const url = $('#pvListenCloudUrl');
    if (url && document.activeElement !== url) url.value = st.url || '';
    const get = $('#pvListenCloudGet');
    if (get) {
      get.classList.toggle('hidden', !(p && p.keyUrl));
      get.textContent = p && p.free ? '🔑 Get a free key' : '🔑 Get a key';
    }
    const msel = $('#pvListenCloudModel');
    if (msel && p) {
      msel.innerHTML = (p.models || []).map((m) =>
        `<option value="${attr(m.id)}">${esc(m.name)}</option>`).join('');
      msel.value = st.model || (p.models[0] || {}).id || '';
    }
    noteCloudFuel();
  }

  /**
   * What is left of the free allowance, and how fast it answered.
   *
   * This is on show for one reason: the free tier is generous but finite, and
   * the failure it produces — look-backs quietly stopping about an hour in — is
   * invisible from the transcript alone. A bar that has been draining all
   * service is the difference between "it went funny" and "we have used this
   * morning's allowance".
   */
  function noteCloudFuel() {
    const note = $('#pvListenCloudNote');
    const st = pv.listen.cloud;
    if (!note || !st) return;
    if (!st.hasKey) { note.className = 'muted small'; note.textContent = '— no key yet'; return; }
    const u = st.used || {};
    const left = u.hourCap ? Math.max(0, 1 - (u.hourSec || 0) / u.hourCap) : 1;
    const bits = [];
    if (st.lastMs) bits.push(Math.round(st.lastMs) + ' ms');
    if (st.free && u.hourCap) bits.push(Math.round(left * 100) + '% of this hour left');
    if (st.cooling > 0) bits.push('paused — ' + (st.why || 'trying again shortly'));
    note.className = 'muted small pv-listen-cloud-note' + (st.cooling > 0 ? ' bad' : '');
    note.textContent = bits.length ? '— ' + bits.join(' · ') : '';
  }

  function wireCloudSetup() {
    const key = $('#pvListenCloudKey');
    if (key && !key._wired) {
      key._wired = true;
      // Saved when they leave the box, not on every keystroke: a key is pasted
      // in one go, and writing a half-typed one to the store would leave the
      // engine configured with rubbish if they then walked away.
      const save = async () => {
        const v = key.value.trim();
        if (!v || /^•+$/.test(v)) return;
        await setCloud({ key: v, on: true });
        key.value = '••••••••••••••••';
      };
      key.addEventListener('blur', save);
      key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); key.blur(); } });
      key.addEventListener('focus', () => { if (/^•+$/.test(key.value)) key.value = ''; });
    }
    const url = $('#pvListenCloudUrl');
    if (url && !url._wired) {
      url._wired = true;
      url.addEventListener('blur', () => setCloud({ url: url.value.trim() }));
    }
    const msel = $('#pvListenCloudModel');
    if (msel && !msel._wired) {
      msel._wired = true;
      msel.addEventListener('change', () => setCloud({ model: msel.value }));
    }
    const get = $('#pvListenCloudGet');
    if (get && !get._wired) {
      get._wired = true;
      get.addEventListener('click', () => {
        const p = cloudProvider();
        if (p && p.keyUrl) window.api.shell.openExternal(p.keyUrl);
      });
    }
    const test = $('#pvListenCloudTest');
    if (test && !test._wired) {
      test._wired = true;
      test.addEventListener('click', async () => {
        const note = $('#pvListenCloudNote');
        const typed = key && key.value.trim();
        const patch = { on: true };
        if (typed && !/^•+$/.test(typed)) patch.key = typed;
        const urlBox = $('#pvListenCloudUrl');
        if (urlBox && urlBox.value.trim()) patch.url = urlBox.value.trim();
        if (msel && msel.value) patch.model = msel.value;
        test.disabled = true;
        if (note) { note.className = 'muted small'; note.textContent = '— testing…'; }
        try {
          const r = await window.api.voice.cloudTest(patch);
          pv.listen.cloud = (r && r.state) || pv.listen.cloud;
          if (key) key.value = pv.listen.cloud && pv.listen.cloud.hasKey ? '••••••••••••••••' : '';
          /*
           * Redraw FIRST, then write the answer. The other way round, the
           * redraw's own status line ("100% of this hour left") lands on top of
           * the one thing the operator pressed the button to read — so a
           * refused key reported itself as a healthy allowance with a note
           * about being paused, which is the opposite of an answer.
           */
          showEngineRows();
          renderCloudSetup();
          if (note) {
            note.className = 'muted small pv-listen-cloud-note ' + (r && r.ok ? 'good' : 'bad');
            note.textContent = r && r.ok
              // The round trip IS the answer: it is measured from this building,
              // on this church's internet, which is the only number that means
              // anything to the person about to run a service on it.
              ? `— ✅ ${esc(r.provider)} answered in ${r.ms} ms${r.free ? ', free' : ''}`
              : `— ⚠️ ${esc((r && r.error) || 'it did not answer')}`;
          }
        } catch (e) {
          if (note) { note.className = 'muted small pv-listen-cloud-note bad'; note.textContent = '— ⚠️ ' + esc(e.message || e); }
        } finally { test.disabled = false; }
      });
    }
  }

  async function renderListenModels() {
    const sel = $('#pvListenModel');
    if (!sel) return;
    let list = [];
    try { list = await window.api.captions.models(); } catch (e) { return; }
    pv.listen._models = list;
    // What automatic would land on, so the default option can name it rather
    // than leaving "Automatic" meaning something invisible.
    const auto = ['small.en', 'base.en'].map((id) => list.find((m) => m.id === id && m.installed)).find(Boolean);
    const opts = [`<option value="">Automatic${auto ? ' (' + esc(shortModelName(auto)) + ')' : ''}</option>`];
    for (const id of LISTEN_MODELS) {
      const m = list.find((x) => x.id === id);
      if (!m) continue;
      opts.push(m.installed
        ? `<option value="${attr(m.id)}">${esc(shortModelName(m))}</option>`
        : `<option value="get:${attr(m.id)}">${esc(shortModelName(m))} ⬇ ${esc(modelSizeText(m.sizeMB))}</option>`);
    }
    sel.innerHTML = opts.join('');
    // A model the operator picked and has since deleted falls back to
    // automatic rather than sitting in the box naming something that is gone.
    if (pv.listen.model && !list.some((m) => m.id === pv.listen.model && m.installed)) {
      pv.listen.model = ''; savePref();
    }
    sel.value = pv.listen.model || '';
    if (!sel._wired) {
      sel._wired = true;
      sel.addEventListener('change', async () => {
        const v = sel.value;
        if (!v.startsWith('get:')) {
          pv.listen.model = v;
          savePref();
          noteListenModel();
          return;
        }
        const id = v.slice(4);
        sel.value = pv.listen.model || '';          // don't select it until it exists
        const m = (pv.listen._models || []).find((x) => x.id === id);
        const size = m ? modelSizeText(m.sizeMB) : '';
        const warn = id === 'medium.en'
          ? '\n\nMedium hears the most words right, but on this PC it runs about 3x SLOWER than real time — 🎤 Listen would fall behind the preacher. Only pick it if this machine is much faster than the one this was measured on.'
          : id === 'large-v3-turbo'
            ? '\n\nTurbo is the most accurate model here and much quicker than Medium for its size. It is still far heavier than Small, so try it and watch whether the replies keep up.'
            : '';
        const ok = window.confirm(`Download ${m ? shortModelName(m) : id} (${size})?\n\n`
          + `It is free, runs on this PC and works offline afterwards.${warn}`);
        if (!ok) return;
        const jobId = window.__newJobId();
        try {
          await window.__runJob(`⬇️ Downloading the ${m ? shortModelName(m) : id} listening model (${size}) — one time only…`,
            jobId, () => window.api.captions.downloadModel({ id, jobId }));
        } catch (e) {
          window.__toast && window.__toast('The download did not finish: ' + ((e && e.message) || e), 'error');
          await renderListenModels();
          return;
        }
        pv.listen.model = id;
        savePref();
        await renderListenModels();
        noteListenModel();
        window.__toast && window.__toast(`🎤 Listen will hear with ${m ? shortModelName(m) : id} from now on.`, 'good');
      });
    }
    noteListenModel();
  }

  /**
   * Say which model is REALLY doing the listening.
   *
   * main resolves this, not the page: 'Automatic' is a ladder, and a model the
   * operator named but never downloaded falls back. Asking rather than
   * guessing is what keeps the label honest — see resolveModel in
   * voicelisten.js for the case where it used to lie.
   */
  async function noteListenModel() {
    const note = $('#pvListenModelNote');
    if (!note) return;
    try {
      const r = await window.api.voice.warmUp(pv.listen.fast, pv.listen.model);
      /*
       * The CLOUD ear gets to say so, and gets to say it FIRST.
       *
       * The old version of this asked main which local model was resolved and
       * printed that — which, once a cloud engine exists, is a label naming a
       * model that is not being asked anything. The bug it is guarding against
       * is the same one the local picker already had twice (see resolveModel in
       * voicelisten.js): a panel that reports one engine while another runs.
       */
      const how = r && r.how;
      if (how && how.cloud && how.cloud.on && how.cloud.hasKey) {
        pv.listen.cloud = how.cloud;
        pv.listen.modelNote = 'hearing with ' + how.cloud.model;
        note.textContent = '— ' + pv.listen.modelNote;
        noteCloudFuel();
        return;
      }
      const id = r && r.modelId;
      const m = (pv.listen._models || []).find((x) => x.id === id);
      pv.listen.modelNote = id ? ('hearing with ' + (m ? shortModelName(m) : id)) : '';
      note.textContent = pv.listen.modelNote ? '— ' + pv.listen.modelNote : '';
    } catch (e) { note.textContent = ''; }
  }

  async function refreshMicList({ unlock = false } = {}) {
    renderListenModels().catch(() => {});
    refreshCloudState().then(() => {
      renderListenEngine().catch(() => {});
      renderCloudSetup();
      wireCloudSetup();
    }).catch(() => {});
    const sel = $('#pvListenMic'); if (!sel || !navigator.mediaDevices) return;
    if (unlock) await unlockMicNames();
    // Opening the list is intent enough to go and look at the network, and
    // discovery is a fast, non-blocking call. Doing it on a timer instead
    // would keep an NDI finder alive through every service for a list nobody
    // is reading.
    if (unlock) await refreshNdiFeeds().catch(() => {});
    let devs = [];
    try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); }
    catch (e) { devs = []; }
    // Chromium lists a "default" and a "communications" pseudo-device that are
    // aliases of a real one; showing all three is three ways to pick the same
    // microphone and no way to tell them apart.
    const real = devs.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    pv.listen.mics = real;
    const want = pv.listen.micId || '';
    /*
     * A chosen microphone that is not plugged in right now stays chosen and
     * stays visible, marked. Quietly dropping back to the default would hide
     * the one fact the operator needs — that the desk feed is unplugged — and
     * would look identical to the feature simply not hearing anything. It also
     * kept the saved choice, which silently reverting would eventually erase.
     */
    const feeds = pv.listen.ndi || [];
    const wantNdi = want.indexOf(NDI_PREFIX) === 0 ? want.slice(NDI_PREFIX.length) : '';
    const missing = want && !wantNdi && !real.some((d) => d.deviceId === want) ? want : null;
    // A chosen NDI feed that is not on the network right now is kept and marked
    // for exactly the reason an unplugged device is: silently dropping back to
    // a microphone would hide the one fact the operator needs.
    const ndiGone = wantNdi && !feeds.some((f) => window.NdiListen.nameOf(f) === wantNdi) ? wantNdi : '';
    sel.innerHTML = `<option value="">Windows' default microphone</option>` +
      real.map((d, i) => `<option value="${attr(d.deviceId)}">${esc(d.label || `Microphone ${i + 1}`)}</option>`).join('') +
      (missing ? `<option value="${attr(missing)}">${esc(pv.listen.micLabel || 'The chosen microphone')} — not connected</option>` : '') +
      (feeds.length
        ? `<optgroup label="NDI over the network">` +
          feeds.map((f) => {
            const n = window.NdiListen.nameOf(f);
            return `<option value="${attr(NDI_PREFIX + n)}">${esc(n)}</option>`;
          }).join('') + `</optgroup>`
        : '') +
      (ndiGone ? `<option value="${attr(NDI_PREFIX + ndiGone)}">${esc(ndiGone)} — not on the network</option>` : '');
    sel.value = want;
    if (!real.length && !feeds.length && !ndiGone) {
      sel.innerHTML = '<option value="">No microphone found</option>';
      sel.disabled = true;
    } else sel.disabled = false;
  }
  /** Change microphone. If it is already listening, move it across live. */
  async function setListenMic(id) {
    pv.listen.micId = id || '';
    // Kept so an unplugged device can still be shown BY NAME rather than as a
    // meaningless id — enumerateDevices stops reporting it the moment it goes.
    if (id) pv.listen.micLabel = micLabelOf(id) || pv.listen.micLabel || '';
    else pv.listen.micLabel = '';
    // Keep the control showing what is actually selected. Coming from the
    // dropdown it already does; coming from anywhere else (a restored setting,
    // a macro, a test) it would otherwise sit on the old name while listening
    // to the new microphone, which is worse than no picker at all.
    const sel = $('#pvListenMic');
    if (sel && sel.value !== pv.listen.micId) sel.value = pv.listen.micId;
    savePref();
    if (!pv.listen.ear) return;
    stopListening();
    await startListening();
  }

  async function startListening() {
    if (pv.listen.ear) return true;
    let ready = false, avail = null;
    try { avail = await window.api.voice.available(); ready = !!(avail && avail.ready); } catch (e) {}
    if (!ready) {
      window.__toast && window.__toast('Nothing to listen with yet. Either paste a free key under “Hearing” — it takes a minute and needs no card — or install the speech engine, which the Video Studio’s captions use too.', 'error', 11000);
      return false;
    }
    /*
     * HOW OFTEN TO OFFER A LOOK-BACK IS THE ENGINE'S DECISION, NOT THIS PAGE'S.
     *
     * The ear's built-in pace — a 6-second window every 1.2 s — is sized to a
     * small model running on this PC, where a window costs nothing but CPU. The
     * cloud engine has a free allowance measured in requests and audio-seconds
     * per hour, and that same pace spends five times what it is given: it would
     * work beautifully for ten minutes and then stop, halfway through the
     * sermon, with nothing on screen to explain it.
     *
     * So main works out the pace that its allowance sustains indefinitely and
     * hands it over here. Nothing else about the ear changes — the same
     * endpointer, the same samples, the same everything downstream.
     */
    pv.listen.cadence = (avail && avail.cadence) || null;
    listenState('starting…', true);
    try { await window.api.voice.translation(pv.translation || null); } catch (e) {}
    // Load the model before the first phrase, so the first thing the operator
    // tries is not also the slowest thing that will ever happen.
    window.api.voice.warmUp(pv.listen.fast, pv.listen.model).then((r) => {
      // If the resident model declines — a whisper build laid out differently,
      // say — the operator is told, rather than left wondering why the tick box
      // did nothing. It still listens; it just listens the ordinary way.
      const note = $('#pvListenFastNote');
      if (!note) return;
      if (!pv.listen.fast) { note.textContent = ''; return; }
      if (r && r.resident) note.textContent = '— model loaded';
      else { note.textContent = '— not available here'; listenLog('Faster replies is not available on this build: ' + esc((r && r.residentWhy) || 'unknown'), 'warn'); }
    }).catch(() => {});
    /*
     * An NDI feed is received first and handed to the ear as a ready-made
     * stream; a microphone the ear opens itself. Either way everything after
     * this line — the endpointer, whisper, the reference matcher — is the same
     * code on the same 16 kHz samples.
     */
    let ndi = null;
    const ndiName = (pv.listen.micId || '').indexOf(NDI_PREFIX) === 0
      ? pv.listen.micId.slice(NDI_PREFIX.length) : '';
    if (ndiName) {
      try {
        await refreshNdiFeeds();
        const src = window.NdiListen.findByName(pv.listen.ndi, ndiName);
        if (!src) throw new Error(`“${ndiName}” is not on the network right now.`);
        ndi = await window.NdiListen.openStream(src);
        pv.listen.ndiRx = ndi;
      } catch (e) {
        listenState('off', false);
        window.__toast && window.__toast(`⚠️ Could not listen to the NDI feed: ${e.message || e}`, 'error', 9000);
        return false;
      }
    }
    try {
      pv.listen.ear = await window.VoiceEar.createEar({
        deviceId: ndi ? null : (pv.listen.micId || null),
        stream: ndi ? ndi.stream : null,
        opts: pv.listen.cadence || {},
        onPhrase: (pcm, meta) => onVoicePhrase(pcm, meta),
        // The fast channel, armed only while somebody is mid-verse. It goes to
        // its own handler because it goes to a different engine — this PC, not
        // the cloud. See close-follow above.
        onClose: (pcm) => onCloseLook(pcm),
        onLevel: (rms, speaking) => {
          // The loudest thing heard since Listen was switched on. It is the
          // only honest answer to "is this source actually reaching the ear?",
          // which is a different question from "did the receiver start".
          pv.listen.peak = Math.max(pv.listen.peak || 0, rms);
          pv.listen.blocks = (pv.listen.blocks || 0) + 1;
          const m = $('#pvListenMeter'); if (!m) return;
          const pct = Math.max(0, Math.min(100, Math.round((20 * Math.log10(rms + 1e-9) + 60) * 1.9)));
          m.firstElementChild.style.width = pct + '%';
          m.classList.toggle('speaking', !!speaking);
        },
      });
    } catch (e) {
      listenState('off', false);
      if (ndi) { try { ndi.stop(); } catch (e2) {} pv.listen.ndiRx = null; }
      // A named device can vanish between being listed and being opened — it
      // was unplugged, or another app took it. Say which one, because "could
      // not open the microphone" is useless when there are five of them.
      const which = ndiName || micLabelOf(pv.listen.micId) || 'the microphone';
      window.__toast && window.__toast(`⚠️ Could not open ${which}: ` + (e.message || e), 'error', 8000);
      return false;
    }
    pv.listen.peak = 0; pv.listen.blocks = 0;
    /*
     * KEEP THE ALLOWANCE READOUT ALIVE WHILE THE SERVICE RUNS.
     *
     * The free tier is generous but finite, and the way it runs out is not
     * dramatic: look-backs simply thin out towards the end of an hour. Without
     * a number that has visibly been draining, that reads as "it went funny",
     * which is the complaint this whole feature exists to stop. Half a minute
     * is often enough to watch a bar move and rare enough to cost nothing.
     */
    if (pv.listen.cadence) {
      clearInterval(pv.listen.fuelTimer);
      pv.listen.fuelTimer = setInterval(() => {
        refreshCloudState().then(noteCloudFuel).catch(() => {});
      }, 30000);
    }
    listenState('listening', true);
    // Holding a stream is what makes the operating system tell us the devices'
    // real names, so this is the moment the list stops saying "Microphone 2".
    $('#pvListenFast').checked = !!pv.listen.fast;
    $('#pvListenQuote').checked = !!pv.listen.quote;
    $('#pvListenFollow').checked = !!pv.listen.follow;
    // A fresh session starts with nothing heard and nothing turned, whatever
    // the last one did.
    tapeReset();
    {
      const note = $('#pvListenFollowNote');
      if (note) note.textContent = pv.listen.follow ? '— the page turns itself' : '';
    }
    // Switching Listen on is also the moment to have the indexes ready, if the
    // operator left the box ticked from last Sunday.
    if (pv.listen.quote && !pv.listen.quoteReady) {
      $('#pvListenQuote').dispatchEvent(new Event('change', { bubbles: true }));
    }
    refreshMicList().catch(() => {});
    if (ndi) listenLog(`Listening to the NDI feed <b>${esc(ndiName)}</b>.`);
    listenLog('Listening. Say a reference — “John chapter three verse sixteen” — or “next verse”.');
    return true;
  }
  function stopListening() {
    if (pv.listen.ear) { try { pv.listen.ear.stop(); } catch (e) {} pv.listen.ear = null; }
    // The receiver is ours, not the ear's — the ear was only handed its stream.
    if (pv.listen.ndiRx) { try { pv.listen.ndiRx.stop(); } catch (e) {} pv.listen.ndiRx = null; }
    // Which engine was listening, and at what pace, is settled when it STARTS.
    // Leaving the pace behind would have the next session drop capped phrases
    // on the reasoning that a cloud ear is listening, after somebody switched
    // back to this PC in between.
    pv.listen.cadence = null; pv.listen.lastVia = '';
    // Nothing is being read any more, so nothing is being followed closely.
    pv.listen.close = false; pv.listen.closeAt = 0; pv.listen.closeBusy = false;
    clearInterval(pv.listen.fuelTimer); pv.listen.fuelTimer = null;
    listenState('off', false);
    const m = $('#pvListenMeter'); if (m) { m.firstElementChild.style.width = '0%'; m.classList.remove('speaking'); }
  }
  const toggleListening = () => (pv.listen.ear ? (stopListening(), false) : startListening());

  /*
   * The seam the tests drive. A real phrase goes microphone -> endpointer ->
   * whisper -> voiceref -> here; a test hands over what whisper said and the
   * rest of the path is identical, so what it proves is the real behaviour and
   * not a mock of it.
   */
  async function presentTestApplyHeard(r) {
    const heard = (r.text || '').trim();
    const intent = r.intent;
    if (!intent) { listenLog(esc(heard)); return { heard, did: null }; }
    const did = await applyVoiceIntent(intent);
    if (did) { pv.listen.acted++; listenLog(`<b>${esc(did)}</b> — “${esc(heard)}”`, 'did'); }
    else listenLog(esc(heard) + ' <i>(nothing to move)</i>', 'warn');
    return { heard, did };
  }


  const updateBibleButtons = () => {
    const on = !!(pv.bibleResult && pv.bibleResult.verses.length);
    $('#pvBibleAdd').disabled = !on;
    $('#pvBibleLive').disabled = !on;
  };

  /** Turn the found passage into slides, N verses at a time. */
  function scriptureSlides(res) {
    const per = parseInt($('#pvVps').value, 10);
    const withRef = $('#pvShowRef').checked;
    const abbr = bibleCode(res.code || res.translation);
    const out = [];
    const chunk = per === 0 ? res.verses.length : Math.max(1, per);
    for (let i = 0; i < res.verses.length; i += chunk) {
      const part = res.verses.slice(i, i + chunk);
      const ref = part.length === 1
        ? `${part[0].book} ${part[0].chapter}:${part[0].verse}`
        : `${part[0].book} ${part[0].chapter}:${part[0].verse}-${part[part.length - 1].verse}`;
      out.push(Object.assign(mkSlide('Scripture', part.map((v) => v.text)), {
        footer: withRef ? `${ref}${abbr ? '  (' + abbr + ')' : ''}` : '',
        // Slides added to the Library keep the position the verses were being
        // read at, so ＋ Add and click-to-live look the same on the wall.
        look: (pv.verseTheme && Object.keys(pv.verseTheme).length) ? Object.assign({}, pv.verseTheme) : null,
      }));
    }
    return out;
  }
  function addScripture(sendLive) {
    const res = pv.bibleResult; if (!res) return;
    const made = scriptureSlides(res);
    let d = doc();
    // A reading gets its own presentation unless the operator is clearly adding
    // to something they already have open.
    if (!d || d.kind === 'song') {
      d = { id: uid(), name: res.reference, kind: 'scripture', lookId: pv.lookId, updated: Date.now(), slides: [] };
      pv.presentations.unshift(d); pv.docId = d.id;
    }
    const at = d.slides.length;
    d.slides.push(...made);
    saveDoc(d);
    pv.slideIx = at;
    renderLibrary(); renderSlides();
    if (sendLive) cue(at); else renderMonitors();
    window.__toast && window.__toast(`📖 ${res.reference} added — ${made.length} slide${made.length === 1 ? '' : 's'}.`, 'good');
  }

  /* -------- translation manager -------- */
  async function openBibleManager() {
    $('#bibModal').classList.remove('hidden');
    const list = $('#bibList');
    list.innerHTML = '<p class="muted small lib-empty">Loading the catalogue…</p>';
    try { pv.catalogue = await window.api.bible.catalogue(); } catch (e) { pv.catalogue = []; }
    renderBibleList();
  }
  function renderBibleList() {
    const q = (($('#bibFilter') || {}).value || '').toLowerCase();
    const tab = pv.bibTab || 'popular';
    const matches = (t) => !q
      || String(t.name).toLowerCase().includes(q)
      || String(t.abbr).toLowerCase().includes(q)
      || String(t.language || '').toLowerCase().includes(q);
    const isEnglish = (t) => /^(english|eng)/i.test(String(t.language || t.lang || ''));
    let list = pv.catalogue.filter(matches);
    if (!q) {
      if (tab === 'popular') {
        list = POPULAR_ENGLISH.map((a) => pv.catalogue.find((t) => String(t.abbr).toLowerCase() === a)).filter(Boolean);
      } else if (tab === 'english') list = list.filter(isEnglish);
      else if (tab === 'installed') list = list.filter((t) => t.installed);
    }
    const el = $('#bibList');
    $('#bibCount').textContent = `${pv.catalogue.filter((t) => t.installed).length} downloaded · ${pv.catalogue.length} available`;
    const chips = [['popular', 'Popular'], ['english', 'English'], ['installed', 'Downloaded'], ['all', 'Every language']]
      .map(([id, lbl]) => `<button class="pv-chip${tab === id ? ' on' : ''}" data-bibtab="${id}">${lbl}</button>`).join('');
    const rows = list.slice(0, 400).map((t) => `
      <div class="lib-row${t.installed ? ' sel' : ''}">
        <span class="lib-row-icon">${t.installed ? '📗' : '📘'}</span>
        <span class="lib-row-main" title="${attr(t.name || '')}">
          <b>${esc(bibleCode(t.abbr))} — ${esc(shortBibleName(t))}</b>
          <span class="muted small">${esc(t.language || t.lang || '')}${t.installed && t.sizeBytes ? ' · ' + (t.sizeBytes / 1048576).toFixed(1) + ' MB offline' : ''}</span>
        </span>
        ${t.installed
          ? `<button class="primary-btn small" data-bibuse="${attr(t.abbr)}">Use</button>
             <button class="lib-mini danger" data-bibdel="${attr(t.abbr)}" title="Remove the offline copy">🗑</button>`
          // A bolls translation reads live, so it can be tried before anyone
          // commits five megabytes and a wait to it.
          : `${t.source === 'bolls' ? `<button class="ghost-btn small" data-bibtry="${attr(t.abbr)}" title="Read it now over the internet, without downloading">Use now</button>` : ''}
             <button class="primary-btn small" data-bibget="${attr(t.abbr)}">⬇️ Download</button>`}
      </div>`).join('');
    /*
     * WHERE THE MODERN TRANSLATIONS COME FROM.
     *
     * NIV, NLT, ESV, NKJV, NASB, AMP and The Message are now in the list above
     * like everything else — they are read from bolls.life, a public Bible site
     * that serves plain JSON with no key and no account. This note stays because
     * someone who has looked for those names in a Bible app before expects them
     * to be missing, and needs telling once that they are not.
     */
    const modern = (tab === 'popular' || tab === 'english' || q) ? `
      <div class="bib-licensed">
        <b>📖 NIV · NLT · ESV · NKJV · NASB · AMP · The Message</b>
        <p class="muted small">All seven are in the list above — they come straight from <b>bolls.life</b>, so there is nothing to sign up for
        and no key to paste. <b>Use now</b> reads one straight over the internet; <b>⬇️ Download</b> (about 5 MB, once) puts it on this
        machine for good, which is the one you want before a Sunday.</p>
        <p class="muted small">Have your own module — an export from another Bible program? <b>📂 Import a file</b> takes it.</p>
      </div>` : '';
    if (!list.length && !modern) { el.innerHTML = '<p class="muted small lib-empty">No translation matches that.</p>'; return; }
    el.innerHTML = `<div class="bib-tabs">${chips}</div>`
      + (rows || '<p class="muted small lib-empty">No translation matches that.</p>') + modern;
    $$('[data-bibtab]', el).forEach((b) => b.addEventListener('click', () => { pv.bibTab = b.dataset.bibtab; renderBibleList(); }));
    $$('[data-bibget]', el).forEach((b) => b.addEventListener('click', () => downloadTranslation(b.dataset.bibget)));
    $$('[data-bibtry]', el).forEach((b) => b.addEventListener('click', async () => {
      pv.liveTranslations = (pv.liveTranslations || []).concat([b.dataset.bibtry]);
      pv.translation = b.dataset.bibtry;
      savePref();
      await refreshTranslations();
      $('#bibModal').classList.add('hidden');
      if (pv.bibleResult) findScripture();
      window.__toast && window.__toast(`📖 Reading ${bibleCode(pv.translation)} over the internet — download it to have it on a Sunday with no wifi.`, 'good', 7000);
    }));
    $$('[data-bibuse]', el).forEach((b) => b.addEventListener('click', async () => {
      pv.translation = b.dataset.bibuse;
      await refreshTranslations();
      $('#bibModal').classList.add('hidden');
      window.__toast && window.__toast(`📖 Now using ${bibleCode(pv.translation)}.`, 'good');
    }));
    $$('[data-bibdel]', el).forEach((b) => b.addEventListener('click', async () => {
      await window.api.bible.remove(b.dataset.bibdel).catch(() => {});
      pv.catalogue = await window.api.bible.catalogue().catch(() => pv.catalogue);
      await refreshTranslations(); renderBibleList();
    }));
  }
  async function downloadTranslation(abbr) {
    const jid = window.__newJobId();
    try {
      const r = await window.__runJob(`📖 Downloading ${bibleCode(abbr)} — it works offline after this…`, jid,
        () => window.api.bible.download(abbr, jid));
      pv.translation = r.abbr;
      pv.catalogue = await window.api.bible.catalogue().catch(() => pv.catalogue);
      await refreshTranslations(); renderBibleList();
      window.__toast && window.__toast(`📖 ${r.name} is ready — ${r.books} books, offline for good.`, 'good');
    } catch (e) { /* runJob already said so */ }
  }
  async function importTranslation() {
    let p;
    try { p = await window.api.dialog.openFile([{ name: 'Bible module (JSON)', extensions: ['json'] }]); } catch (e) { p = null; }
    if (!p) return;
    const abbr = await ask('Short code for this translation (e.g. "niv", "esv"):', '');
    if (!abbr) return;
    const name = (await ask('Full name:', abbr.toUpperCase())) || abbr.toUpperCase();
    try {
      const r = await window.api.bible.import(p, abbr, name);
      pv.translation = r.abbr;
      pv.catalogue = await window.api.bible.catalogue().catch(() => pv.catalogue);
      await refreshTranslations(); renderBibleList();
      window.__toast && window.__toast(`📖 Imported ${r.name} — ${r.books} books, ${r.verses} verses.`, 'good');
    } catch (e) {
      window.__toast && window.__toast('⚠️ ' + (e.message || 'Import failed.'), 'error', 9000);
    }
  }

  /* ============================ media ============================ */
  async function refreshMedia() {
    let lib = { clips: [] };
    try { lib = await window.api.library.list(); } catch (e) {}
    // Reuse the SAME saved clip library the Video Studio fills — a church's
    // motion backgrounds shouldn't have to be added to the app twice.
    const clips = (lib.clips || []).map((c) => ({ id: c.id, name: c.name, path: c.file, type: 'video', thumb: c.thumb }));
    // `own` marks the files this operator added here, which are the only ones
    // this panel may remove — the rest belong to the shared clip library.
    pv.media = (pv.mediaExtra || []).map((m) => Object.assign({ own: true }, m)).concat(clips);
    renderMedia();
  }
  function renderMedia() {
    const el = $('#pvMediaGrid');
    if (!pv.media.length) {
      el.innerHTML = '<p class="muted small pv-empty">Nothing here yet — press <b>＋ Add</b> to bring in a picture or a video from this computer.</p>';
      return;
    }
    el.innerHTML = pv.media.map((m, i) => `
      <div class="pv-media-cell">
        <button class="pv-media" data-media="${i}" title="${attr(m.name)} — click to put it behind this slide, shift-click for every slide">
          <span class="pv-media-thumb" style="${m.type === 'image'
            ? `background-image:url('${window.SlideRender.fileUrl(m.path)}')`
            : m.thumb ? `background-image:url('${window.SlideRender.fileUrl(m.thumb)}')` : ''}">${m.type === 'video' ? '<span class="pv-media-badge">▶</span>' : ''}</span>
          <span class="pv-media-name">${esc(m.name)}</span>
        </button>
        <button class="pv-media-slide" data-mediaslide="${i}" title="Add it as its OWN full-screen slide (no words over it)">▤＋</button>` +
        (m.own ? `<button class="pv-media-rm" data-mediarm="${i}" title="Remove it from this list (the file itself is not deleted)">✕</button>` : '') + `
      </div>`).join('');
    $$('[data-media]', el).forEach((b) => b.addEventListener('click', (e) => applyBackground(pv.media[+b.dataset.media], e.shiftKey)));
    $$('[data-mediaslide]', el).forEach((b) => b.addEventListener('click', () => addImageSlide(pv.media[+b.dataset.mediaslide])));
    $$('[data-mediarm]', el).forEach((b) => b.addEventListener('click', () => removeMedia(+b.dataset.mediarm)));
  }
  /** Take one of the operator's own files off the list (never off the disk). */
  function removeMedia(i) {
    const m = pv.media[i]; if (!m) return;
    pv.mediaExtra = (pv.mediaExtra || []).filter((x) => x.path !== m.path);
    try { localStorage.setItem('mw-pv-media', JSON.stringify(pv.mediaExtra)); } catch (e) {}
    refreshMedia();
  }
  /* ================= ready-made backgrounds =================
   * The set that ships with the app (see backgrounds.js). Every thumbnail
   * paints the REAL background rather than a picture of one, so what the
   * operator clicks is exactly what the congregation gets — the same rule the
   * slide grid follows. */
  function renderBgCats() {
    const el = $('#pvBgCats'); if (!el || !window.Backgrounds) return;
    // Moving footage leads; the flat scenes are still here under "Plain",
    // because a light room, a slow machine and a keyable lower third all still
    // want a background that costs nothing to draw.
    const cats = ['All'].concat((window.BgVideos && window.BgVideos.CATEGORIES) || [], ['Plain']);
    el.innerHTML = cats.map((c) => `<button class="pv-chip${(pv.bgCat || 'All') === c ? ' on' : ''}" data-bgcat="${attr(c)}">${esc(c)}</button>`).join('');
    $$('[data-bgcat]', el).forEach((b) => b.addEventListener('click', () => { pv.bgCat = b.dataset.bgcat; renderBgCats(); renderBuiltinBgs(); }));
  }
  const mb = (b) => (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB';
  /** Which clips are already on this machine (id -> local file). */
  async function refreshBgVideos() {
    let list = [];
    try { list = await window.api.bgVideos.installed(); } catch (e) {}
    const before = JSON.stringify(pv.bgFiles || {});
    pv.bgFiles = {};
    for (const c of list) pv.bgFiles[c.id] = c.file;
    // The ⬇/✓ badge is the only thing telling the operator whether a click
    // costs a download, so it must never be left describing the last answer.
    if (JSON.stringify(pv.bgFiles) !== before && $('#pvBgGrid')) renderBuiltinBgs();
    return pv.bgFiles;
  }
  function renderBuiltinBgs() {
    const el = $('#pvBgGrid'); if (!el || !window.Backgrounds) return;
    const cat = pv.bgCat || 'All';
    const clips = ((window.BgVideos && window.BgVideos.CLIPS) || []).filter((c) => cat === 'All' || c.cat === cat);
    const flat = window.Backgrounds.PRESETS.filter(() => cat === 'All' || cat === 'Plain');
    const have = pv.bgFiles || {};

    /*
     * A video tile shows its POSTER, not the video. Thirty autoplaying loops in
     * a 330px panel would cost more than the whole rest of the studio put
     * together, and the operator is choosing a picture, not watching one.
     */
    const vids = clips.map((c) => {
      const here = !!have[c.id];
      return `
      <button class="pv-bg pv-bg-vid${here ? ' have' : ''}" data-bgvid="${attr(c.id)}"
        title="${attr(c.name + ' — ' + c.cat + (here ? ' (on this machine)' : ` (${mb(c.bytes)} to download, once)`))}">
        <span class="pv-bg-thumb" style="${attr('background-image:url("assets/bgvideos/' + c.id + '.jpg");background-size:cover;background-position:center;')}">
          <span class="pv-bg-sample" style="color:#ffffff;text-shadow:0 2px 8px rgba(0,0,0,.75)">Amazing grace</span>
          <span class="pv-bg-badge">${here ? '✓' : '⬇ ' + mb(c.bytes)}</span>
          <span class="pv-bg-play">▶</span>
        </span>
        <span class="pv-bg-name">${esc(c.name)}</span>
      </button>`;
    }).join('');

    const plain = flat.map((p) => `
      <button class="pv-bg" data-bgpreset="${attr(p.id)}" title="${attr(p.name + ' — ' + p.cat + (p.light ? ' (light: use dark text)' : ''))}">
        <!-- attr(): bgStyle emits url("…") and the data URI has to survive
             being carried inside a double-quoted style attribute -->
        <span class="pv-bg-thumb" style="${attr(window.SlideRender.bgStyle(p))}">
          <span class="pv-bg-sample" style="color:${p.light ? '#10131a' : '#ffffff'};text-shadow:${p.light ? 'none' : '0 2px 8px rgba(0,0,0,.75)'}">Amazing grace</span>
        </span>
        <span class="pv-bg-name">${esc(p.name)}${p.light ? ' <span class="pv-bg-sun" title="Light background — pair it with dark text">☀</span>' : ''}</span>
      </button>`).join('');

    el.innerHTML = vids + plain;
    $$('[data-bgpreset]', el).forEach((b) => b.addEventListener('click', () => usePreset(b.dataset.bgpreset)));
    $$('[data-bgvid]', el).forEach((b) => b.addEventListener('click', () => useBgVideo(b.dataset.bgvid)));
    const note = $('#pvBgNote');
    if (note) {
      const n = Object.keys(have).length;
      note.innerHTML = `Moving backgrounds download <b>once</b> (the size is on each tile) and then play with the wifi off — ${n} on this machine. <b>Plain</b> holds the flat scenes.`;
    }
  }
  /**
   * Use a motion background: fetch it if this machine hasn't got it, then hand
   * it to the same applier the ready-made scenes use, so "This slide / All
   * slides / Bible & everything" means exactly what it means everywhere else.
   */
  async function useBgVideo(id) {
    const c = window.BgVideos && window.BgVideos.byId(id); if (!c) return null;
    let file = (pv.bgFiles || {})[id];
    if (!file) {
      const jid = window.__newJobId();
      try {
        const r = await window.__runJob(`🎞 Getting “${c.name}” — ${mb(c.bytes)}, once. After this it plays offline…`, jid,
          () => window.api.bgVideos.download(id, c.url, jid));
        file = r.file;
        await refreshBgVideos();
        renderBuiltinBgs();
      } catch (e) { return null; }   // runJob has already said what went wrong
    }
    // The poster travels with the background so the slide grid can paint a
    // still instead of running a decoder per thumbnail (see slide-render).
    return applyBgFile({ type: 'video', value: file, fit: 'cover', poster: `assets/bgvideos/${c.id}.jpg` }, c.name);
  }
  /** Put a ready-made background wherever the operator pointed the segmented control. */
  function usePreset(id) {
    const p = window.Backgrounds.byId(id); if (!p) return null;
    return applyBgFile(window.Backgrounds.toBg(p), p.name, p);
  }
  /** The one place a ready-made background — flat scene or video loop — lands. */
  function applyBgFile(bg, name, p) {
    const where = pv.bgApply || 'slide';
    /*
     * A PASSAGE ON THE SCREEN IS WHAT "this slide" MEANS.
     *
     * Verses cued from the Bible panel are not in the Library, so without this
     * the operator picks a background while a verse is up, sees nothing change,
     * and it has quietly landed on a slide in a presentation they are not
     * looking at. "Bible & everything" still goes to the Look, which is the
     * setting-once-for-the-whole-service route.
     */
    if (pv.verseCue && where !== 'look') {
      pv.verseBg = Object.assign({ fit: 'cover' }, bg);
      savePref();
      live(null, 'slide');
      window.__toast && window.__toast(`✨ “${name}” is behind the verses — it stays there for the rest of the reading.`, 'good', 6000);
      return bg;
    }
    if (where === 'look') {
      // Choosing the Look means the Look decides — a background pinned to the
      // verses earlier would otherwise silently outrank it.
      pv.verseBg = null; savePref();
      editLook((l) => { l.bg = Object.assign({}, bg); });
      window.__toast && window.__toast(`✨ “${name}” is now the ${look().name} Look's background — every slide using it changed at once.`, 'good', 5000);
    } else {
      const d = doc(); if (!d) return null;
      if (where === 'all') d.slides.forEach((s) => { s.bg = Object.assign({}, bg); });
      else {
        const s = d.slides[pv.slideIx >= 0 ? pv.slideIx : 0];
        if (!s) { window.__toast && window.__toast('⚠️ Pick a slide first.', 'error'); return null; }
        s.bg = Object.assign({}, bg);
      }
      touch(); renderSlides();
      if (pv.liveDocId === d.id && pv.liveIx >= 0) live(pv.liveIx);
      window.__toast && window.__toast(`✨ “${name}” applied to ${where === 'all' ? 'every slide' : 'this slide'}.`, 'good');
    }
    renderMonitors(); pushLive();
    if (!p) return bg;
    // White words on a white background is the one mistake this is likely to
    // cause, so say it before it reaches the wall rather than after.
    if (p.light && isLightText(look())) {
      window.__toast && window.__toast('☀ That background is light — switch the Look to “Clean white” (or darken the text) so the words stay readable.', 'warn', 7000);
    }
    return bg;
  }
  /** Rough perceived brightness of the Look's text colour. */
  function isLightText(l) {
    const hex = String((l && l.color) || '#ffffff').replace('#', '');
    const n = parseInt(hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex, 16);
    if (isNaN(n)) return true;
    return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) > 150;
  }
  /**
   * Give the background behind the words a slow move — or take it away.
   *
   * Applied wherever the "where" control is pointing, so it follows the same
   * rule as the picture itself: this slide, all of them, or the Look (which is
   * what puts it behind the Bible verses too).
   */
  function setBgMotion(kind) {
    pv.bgMotion = kind || '';
    const where = pv.bgApply || 'slide';
    const put = (bg) => Object.assign({}, bg || { type: 'color', value: '#000000' }, { motion: pv.bgMotion || undefined });
    if (where === 'look') editLook((l) => { l.bg = put(l.bg); });
    else {
      const d = doc();
      if (d) {
        if (where === 'all') d.slides.forEach((s) => { s.bg = put(s.bg); });
        else { const s = d.slides[pv.slideIx]; if (s) s.bg = put(s.bg); }
        touch(); renderSlides();
      }
    }
    renderMonitors(); pushLive();
    const d2 = doc();
    if (d2 && pv.liveDocId === d2.id && pv.liveIx >= 0) live(pv.liveIx);
    return pv.bgMotion;
  }

  function setBgApply(where) {
    pv.bgApply = where;
    $$('[data-bgapply]').forEach((b) => b.classList.toggle('on', b.dataset.bgapply === where));
    return pv.bgApply;
  }

  /**
   * Put a picture or a clip behind the slides.
   *
   * This used to give up in silence in the two states it is most likely to be
   * used from — no presentation open, or no slide selected — which is exactly
   * why "I cannot add images, it doesn't work" was a fair description of a
   * feature that was, technically, wired up. Nothing about clicking a
   * background says "you must first create a presentation and click a slide",
   * so it does that itself and says what it did.
   */
  function applyBackground(m, toAll) {
    if (!m) return null;
    /*
     * YOUR OWN PICTURES OBEY THE SAME "where does this go" CONTROL as the
     * ready-made ones.
     *
     * This slide / All slides / The Look sat above the ready-made grid and only
     * ever applied to those; a church's own photo could go behind one slide and
     * nowhere else. "The Look" is the answer to "I want my picture behind the
     * Bible verses": scripture slides are created later, from the Bible panel,
     * and they take the Look's background — so a background set on the LOOK is
     * automatically behind every verse you put up for the rest of the service.
     */
    const where = toAll ? 'all' : (pv.bgApply || 'slide');
    // A church's own picture goes behind the verses on the screen for exactly
    // the same reason a ready-made one does (see applyBgFile).
    if (pv.verseCue && where !== 'look') {
      pv.verseBg = { type: m.type, value: m.path, fit: 'cover' };
      savePref();
      live(null, 'slide');
      window.__toast && window.__toast(`🖼 “${m.name || 'Picture'}” is behind the verses — it stays there for the rest of the reading.`, 'good', 6000);
      return pv.verseBg;
    }
    if (where === 'look') {
      pv.verseBg = null; savePref();
      const bg = { type: m.type, value: m.path, fit: 'cover' };
      editLook((l) => { l.bg = Object.assign({}, l.bg, bg); });
      renderMonitors(); pushLive();
      window.__toast && window.__toast(
        `🖼 “${m.name || 'Picture'}” is now the ${look().name} Look's background — every slide using that Look, including Bible verses you add later, sits on it.`,
        'good', 7000);
      return bg;
    }
    let d = doc();
    if (!d) d = newDoc('Backgrounds', 'song');
    const bg = { type: m.type, value: m.path, fit: 'cover' };
    if (where === 'all') {
      if (!d.slides.length) d.slides.push(mkSlide('Blank', ['']));
      d.slides.forEach((s) => { s.bg = Object.assign({}, bg); });
      if (pv.slideIx < 0) pv.slideIx = 0;
    } else {
      let s = d.slides[pv.slideIx];
      if (!s) {
        // Nothing to put it on — make somewhere to put it rather than doing
        // nothing. A background with no slide cannot go on a projector.
        s = mkSlide('Blank', ['']);
        d.slides.push(s);
        pv.slideIx = d.slides.length - 1;
        window.__toast && window.__toast('🖼 Added a slide for this background — type your words on it, or leave it as a full-screen picture.', 'good', 6000);
      }
      s.bg = bg;
    }
    touch(); renderSlides(); renderMonitors();
    if (pv.liveDocId === d.id && pv.liveIx >= 0) live(pv.liveIx);
    window.__toast && window.__toast(where === 'all'
      ? '🖼 Background applied to every slide.'
      : '🖼 Background applied. (Use “The Look” above to put it behind Bible verses too.)', 'good');
    return bg;
  }

  /**
   * A picture (or clip) as a SLIDE of its own — a notice board, a sermon
   * graphic, a QR code for giving.
   *
   * This is the thing a church usually means by "add an image", and until now
   * the studio could only put a picture BEHIND words. A slide with no words is
   * a picture on the wall, so that is all this is: a full-frame background on a
   * blank slide, which every existing part of the show — the playlist, Go Live,
   * the stage screen, the NDI feed — already knows how to handle.
   */
  function addImageSlide(m, opts) {
    if (!m) return null;
    let d = doc();
    if (!d) d = newDoc('Notices', 'song');
    const s = mkSlide('Blank', ['']);
    s.bg = { type: m.type, value: m.path, fit: (opts && opts.fit) || 'contain' };
    s.mediaName = m.name || '';
    const at = pv.slideIx >= 0 ? pv.slideIx + 1 : d.slides.length;
    d.slides.splice(at, 0, s);
    pv.slideIx = at;
    touch(); renderSlides(); renderMonitors();
    window.__toast && window.__toast(`🖼 “${m.name || 'Picture'}” added as its own slide. Press Go Live to put it on the screen.`, 'good', 6000);
    return s;
  }
  /* ============================== audio ==============================
   * Sound comes out of the operator's machine, never out of the projector
   * windows — three outputs would otherwise mean three copies of the same
   * music, a few milliseconds apart, which sounds exactly as bad as it reads.
   *
   * Several tracks run at once (a bed under the welcome, a click and a stem for
   * the band), each with its own level and its own physical output, so a stem
   * can go to the desk on a second interface while the bed goes to the room.
   * Everything fades rather than cutting: an audio bed that stops dead is the
   * most noticeable mistake a media desk can make.
   */
  const FADE_MS = 800;
  function audioEl(t) {
    if (t.el) return t.el;
    const el = new Audio();
    el.src = window.SlideRender.fileUrl(t.path);
    el.loop = !!t.loop;
    el.volume = 0;
    el.preload = 'auto';
    if (t.deviceId && el.setSinkId) el.setSinkId(t.deviceId).catch(() => {});
    el.addEventListener('ended', () => { t.playing = false; onTrackEnded(t); });
    t.el = el;
    return el;
  }
  const trackVol = (t) => clamp((t.volume == null ? 1 : t.volume) * (pv.audio.master == null ? 1 : pv.audio.master), 0, 1);
  /** Ramp a track's level over `ms`, then optionally stop it. */
  function fadeTo(t, target, ms, thenStop) {
    const el = audioEl(t);
    clearInterval(t._fade);
    const from = el.volume, steps = Math.max(1, Math.round(ms / 40));
    let i = 0;
    t._fade = setInterval(() => {
      i++;
      el.volume = clamp(from + (target - from) * (i / steps), 0, 1);
      if (i >= steps) {
        clearInterval(t._fade); t._fade = null;
        if (thenStop) { try { el.pause(); el.currentTime = 0; } catch (e) {} t.playing = false; renderAudio(); }
      }
    }, 40);
    return t;
  }
  function playTrack(id, { fade = FADE_MS, restart = true } = {}) {
    const t = pv.audio.tracks.find((x) => x.id === id); if (!t) return null;
    const el = audioEl(t);
    if (restart) { try { el.currentTime = 0; } catch (e) {} }
    el.volume = fade ? 0 : trackVol(t);
    const p = el.play(); if (p && p.catch) p.catch(() => {});
    t.playing = true;
    if (fade) fadeTo(t, trackVol(t), fade, false);
    renderAudio();
    return t;
  }
  function stopTrack(id, { fade = FADE_MS } = {}) {
    const t = pv.audio.tracks.find((x) => x.id === id); if (!t) return null;
    if (!t.el) { t.playing = false; return t; }
    if (fade) fadeTo(t, 0, fade, true);
    else { try { t.el.pause(); t.el.currentTime = 0; } catch (e) {} t.playing = false; renderAudio(); }
    return t;
  }
  function stopAllAudio(fade = FADE_MS) { pv.audio.tracks.forEach((t) => { if (t.playing) stopTrack(t.id, { fade }); }); }
  function setMaster(v) {
    pv.audio.master = clamp(v, 0, 1);
    pv.audio.tracks.forEach((t) => { if (t.el && t.playing && !t._fade) t.el.volume = trackVol(t); });
    saveShow(); renderAudio();
    return pv.audio.master;
  }
  /** Auto-advance the background-music bin. */
  function onTrackEnded(t) {
    if (!pv.audio.playlistOn || !t.inPlaylist) { renderAudio(); return; }
    const bin = pv.audio.tracks.filter((x) => x.inPlaylist);
    if (!bin.length) return;
    const at = bin.indexOf(t);
    const next = pv.audio.shuffle
      ? bin[Math.floor(Math.random() * bin.length)]
      : bin[(at + 1) % bin.length];
    if (next && (pv.audio.loopList !== false || at + 1 < bin.length)) playTrack(next.id, { fade: FADE_MS });
    renderAudio();
  }
  async function addAudioTrack(opts = {}) {
    let p = opts.path;
    if (!p) {
      try { p = await window.api.dialog.openFile([{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }]); }
      catch (e) { p = null; }
    }
    if (!p) return null;
    const t = {
      id: uid(), name: opts.name || p.split(/[\\/]/).pop(), path: p,
      volume: opts.volume == null ? 0.8 : opts.volume, loop: !!opts.loop,
      inPlaylist: opts.inPlaylist !== false, deviceId: opts.deviceId || '', playing: false,
    };
    pv.audio.tracks.push(t);
    saveShow(); renderAudio();
    return t;
  }
  function removeAudioTrack(id) {
    const i = pv.audio.tracks.findIndex((t) => t.id === id); if (i < 0) return false;
    const t = pv.audio.tracks[i];
    clearInterval(t._fade);
    if (t.el) { try { t.el.pause(); } catch (e) {} }
    pv.audio.tracks.splice(i, 1);
    saveShow(); renderAudio();
    return true;
  }
  function renderAudio() {
    const el = $('#pvAudioList'); if (!el) return;
    const mv = $('#pvAudioMaster'); if (mv) mv.value = String(pv.audio.master == null ? 1 : pv.audio.master);
    const mvl = $('#pvAudioMasterV'); if (mvl) mvl.textContent = Math.round((pv.audio.master == null ? 1 : pv.audio.master) * 100) + '%';
    el.innerHTML = pv.audio.tracks.length ? pv.audio.tracks.map((t) => `
      <div class="lib-row${t.playing ? ' sel' : ''}">
        <button class="lib-mini${t.playing ? ' on' : ''}" data-audplay="${attr(t.id)}" title="${t.playing ? 'Fade out' : 'Fade in'}">${t.playing ? '■' : '▶'}</button>
        <span class="lib-row-main"><b>${esc(t.name)}</b>
          <span class="muted small">${t.loop ? 'loop · ' : ''}${t.inPlaylist ? 'in bin · ' : ''}${Math.round((t.volume == null ? 1 : t.volume) * 100)}%</span></span>
        <input class="pv-audvol" type="range" min="0" max="1" step="0.01" value="${t.volume == null ? 1 : t.volume}" data-audvol="${attr(t.id)}" title="Level" />
        <button class="lib-mini${t.loop ? ' on' : ''}" data-audloop="${attr(t.id)}" title="Loop">↻</button>
        <button class="lib-mini danger" data-auddel="${attr(t.id)}" title="Remove">✕</button>
      </div>`).join('')
      : '<p class="muted small pv-empty">No audio yet. Add a music bed, a stem or a sound effect.</p>';
    $$('[data-audplay]', el).forEach((b) => b.addEventListener('click', () => {
      const t = pv.audio.tracks.find((x) => x.id === b.dataset.audplay);
      if (t && t.playing) stopTrack(t.id); else playTrack(b.dataset.audplay);
    }));
    $$('[data-audvol]', el).forEach((r) => r.addEventListener('input', () => {
      const t = pv.audio.tracks.find((x) => x.id === r.dataset.audvol); if (!t) return;
      t.volume = parseFloat(r.value);
      if (t.el && !t._fade) t.el.volume = trackVol(t);
      saveShow();
    }));
    $$('[data-audloop]', el).forEach((b) => b.addEventListener('click', () => {
      const t = pv.audio.tracks.find((x) => x.id === b.dataset.audloop); if (!t) return;
      t.loop = !t.loop; if (t.el) t.el.loop = t.loop;
      saveShow(); renderAudio();
    }));
    $$('[data-auddel]', el).forEach((b) => b.addEventListener('click', () => removeAudioTrack(b.dataset.auddel)));
  }
  /** Slide-linked audio: a cue can start the bed, or stop it, on arrival. */
  function renderAudioLinks() {
    const s = slides()[pv.slideIx];
    const sel = $('#pvSlideAudio'); if (!sel) return;
    sel.innerHTML = '<option value="">No audio on this slide</option>'
      + pv.audio.tracks.map((t) => `<option value="play:${attr(t.id)}">▶ Play ${esc(t.name)}</option>`).join('')
      + pv.audio.tracks.map((t) => `<option value="stop:${attr(t.id)}">■ Stop ${esc(t.name)}</option>`).join('')
      + '<option value="stopall:">■ Stop all audio</option>';
    sel.value = (s && s.audio) || '';
  }
  function fireSlideAudio(s) {
    if (!s || !s.audio) return null;
    const [action, id] = String(s.audio).split(':');
    if (action === 'play') return playTrack(id);
    if (action === 'stop') return stopTrack(id);
    if (action === 'stopall') { stopAllAudio(); return true; }
    return null;
  }

  /* ================= web video, video controls, chroma key, markers =========
   * The background is a live thing, not a still: a YouTube link that plays
   * without downloading anything first, a camera with the green screen keyed
   * out, a loop trimmed to the eight seconds that actually work, and markers
   * that fire a cue at an exact moment inside the clip. All of it is stored on
   * the background object and applied at paint time, so the file on disk is
   * never touched and the same clip can be treated differently on two slides. */
  function addWebVideo(sendLive) {
    const url = ($('#pvLinkUrl').value || '').trim();
    if (!url) return null;
    const kind = /vimeo\.com/i.test(url) ? 'vimeo' : 'youtube';
    if (!window.SlideRender.videoId(url, kind)) {
      window.__toast && window.__toast('⚠️ That does not look like a YouTube or Vimeo link.', 'error');
      return null;
    }
    // Sound ON by default: a pasted link is almost always a bumper or an
    // announcement video, and a silent one is a bug report waiting to happen.
    // (main.js relaxes Chromium's autoplay policy so this actually plays.)
    const bg = Object.assign({ type: kind, value: url, fit: 'cover', loop: true, muted: !!($('#pvLinkMute') || {}).checked }, videoOpts());
    const d = doc(); const s = d && d.slides[pv.slideIx];
    if (s) { s.bg = bg; touch(); renderSlides(); }
    else { pv.layers.background = bg; }
    $('#pvLinkUrl').value = '';
    if (sendLive !== false && d && pv.slideIx >= 0) live(pv.slideIx); else pushLive();
    renderMonitors();
    window.__toast && window.__toast(`▶ ${kind === 'vimeo' ? 'Vimeo' : 'YouTube'} video is the background — it streams, nothing is downloaded.`, 'good', 5000);
    return bg;
  }
  /** Whatever the video-control sliders currently say. */
  function videoOpts() {
    const n = (sel, d) => { const el = $(sel); const v = el ? parseFloat(el.value) : NaN; return isNaN(v) ? d : v; };
    const o = {
      brightness: n('#pvVidBright', 1), contrast: n('#pvVidContrast', 1),
      saturation: n('#pvVidSat', 1), hue: n('#pvVidHue', 0), speed: n('#pvVidSpeed', 1),
      inSec: Math.max(0, n('#pvVidIn', 0)), outSec: Math.max(0, n('#pvVidOut', 0)),
      pingpong: !!($('#pvVidPingPong') || {}).checked,
    };
    if (($('#pvKeyOn') || {}).checked) {
      o.chroma = {
        on: true, color: $('#pvKeyColor').value || '#00b140',
        similarity: n('#pvKeySim', 0.16), smoothness: n('#pvKeySmooth', 0.08), spill: n('#pvKeySpill', 0.5),
      };
    }
    return o;
  }
  /** Re-apply the sliders to whatever background is live right now. */
  function applyVideoOpts() {
    const opts = videoOpts();
    if (!opts.chroma) opts.chroma = { on: false };
    const d = doc(); const s = d && d.slides[pv.slideIx];
    const target = (s && s.bg && s.bg.type) ? s.bg : pv.layers.background;
    if (!target) return null;
    Object.assign(target, opts);
    if (s) touch();
    renderSlides(); renderMonitors(); pushLive();
    return target;
  }
  function resetVideoOpts() {
    [['#pvVidBright', 1], ['#pvVidContrast', 1], ['#pvVidSat', 1], ['#pvVidHue', 0], ['#pvVidSpeed', 1],
      ['#pvVidIn', 0], ['#pvVidOut', 0]].forEach(([sel, v]) => { const el = $(sel); if (el) el.value = String(v); });
    $('#pvVidPingPong').checked = false; $('#pvKeyOn').checked = false;
    return applyVideoOpts();
  }

  /* ---- playback markers ----
   * A marker is a time inside the clip and something to do when it arrives, so
   * the intro video can drop the lower third at 0:08 and take it away at 0:14
   * without anyone touching the desk. They are scheduled off the studio's own
   * clock when the media goes live — no output window has to report back, and a
   * clip that is cleared cancels every pending marker with it. */
  function markers() {
    const d = doc(); const s = d && d.slides[pv.slideIx];
    const bg = (s && s.bg && s.bg.type) ? s.bg : pv.layers.background;
    return (bg && bg.markers) || [];
  }
  function renderMarkers() {
    const el = $('#pvMarkList'); if (!el) return;
    const list = markers();
    el.innerHTML = list.length ? list.map((m, i) => `
      <div class="lib-row">
        <span class="lib-row-icon">📍</span>
        <span class="lib-row-main"><b>${fmtSec(m.at)}</b>
          <span class="muted small">${esc(m.label || m.action)}</span></span>
        <button class="lib-mini danger" data-markdel="${i}" title="Remove">✕</button>
      </div>`).join('')
      : '<p class="muted small pv-empty">No markers on this clip.</p>';
    $$('[data-markdel]', el).forEach((b) => b.addEventListener('click', () => {
      const bgm = markers(); bgm.splice(+b.dataset.markdel, 1); touch(); renderMarkers(); pushLive();
    }));
  }
  const fmtSec = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
  function addMarker(at, action, value, label) {
    const d = doc(); const s = d && d.slides[pv.slideIx];
    const bg = (s && s.bg && s.bg.type) ? s.bg : pv.layers.background;
    if (!bg) { window.__toast && window.__toast('⚠️ Put a video background on this slide first.', 'error'); return null; }
    if (!bg.markers) bg.markers = [];
    bg.markers.push({ at: Math.max(0, +at || 0), action, value, label });
    bg.markers.sort((a, b) => a.at - b.at);
    if (s) touch();
    renderMarkers();
    return bg.markers;
  }
  /** Arm the markers on whatever just went live; disarm anything left over. */
  function armMarkers(bg) {
    (pv._markerTimers || []).forEach(clearTimeout);
    pv._markerTimers = [];
    const list = (bg && bg.markers) || [];
    if (!list.length) return 0;
    const rate = Math.max(0.1, Math.min(4, bg.speed || 1));
    const from = bg.inSec || 0;
    for (const mk of list) {
      const delay = ((mk.at - from) / rate) * 1000;
      if (delay < 0) continue;
      pv._markerTimers.push(setTimeout(() => {
        try { runStep({ action: mk.action, value: mk.value }); } catch (e) {}
        renderClearPalette(); renderProps(); renderTimers(); pushLive();
      }, delay));
    }
    return pv._markerTimers.length;
  }

  const MEDIA_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'mp4', 'mov', 'mkv', 'webm', 'm4v'];

  /** Ask for a file and remember it, without deciding what it is for. */
  async function pickMedia() {
    let p;
    try {
      p = await window.api.dialog.openFile([{ name: 'Picture or video', extensions: MEDIA_EXTS }]);
    } catch (e) {
      window.__toast && window.__toast('⚠️ Could not open the file picker: ' + (e.message || e), 'error');
      return null;
    }
    if (!p) return null;                       // the operator pressed Cancel
    const isVideo = /\.(mp4|mov|mkv|webm|m4v)$/i.test(p);
    const item = { id: uid(), name: p.split(/[\\/]/).pop(), path: p, type: isVideo ? 'video' : 'image' };
    // Same file twice is a mis-click, not a second background.
    pv.mediaExtra = (pv.mediaExtra || []).filter((m) => m.path !== p).concat([item]);
    try { localStorage.setItem('mw-pv-media', JSON.stringify(pv.mediaExtra)); } catch (e) {}
    refreshMedia();
    return Object.assign({ own: true }, item);
  }

  async function addMedia() {
    const m = await pickMedia();
    if (!m) return null;
    // Show the operator the thing they just added. Adding a file and being left
    // looking at the same screen is indistinguishable from nothing happening.
    setTab('media');
    const grid = $('#pvMediaGrid');
    const tile = grid && grid.querySelector(`[data-media="${pv.media.findIndex((x) => x.path === m.path)}"]`);
    if (tile && tile.scrollIntoView) tile.scrollIntoView({ block: 'nearest' });
    window.__toast && window.__toast(`🖼 “${m.name}” added. Click it to put it behind this slide, or press ▤＋ on it to make it a slide of its own.`, 'good', 7000);
    return m;
  }

  /** The toolbar's 🖼 Picture button: choose a file and put it straight on a slide. */
  async function addImageSlideFromPicker() {
    const m = await pickMedia();
    if (!m) return null;
    setTab('media');
    return addImageSlide(m);
  }

  /* ============================ looks ============================ */
  function renderLookSelect() {
    const sel = $('#pvLookSel');
    sel.innerHTML = pv.looks.map((l) => `<option value="${attr(l.id)}">${esc(l.name)}</option>`).join('');
    sel.value = pv.lookId;
  }
  function syncLookUi() {
    const l = look(); if (!l) return;
    renderLookSelect();
    $('#lkSize').value = l.sizePx; $('#lkSizeV').textContent = l.sizePx + 'px';
    $('#lkColor').value = l.color || '#ffffff';
    $('#lkLine').value = l.lineHeight || 1.2;
    $('#lkShadow').value = l.shadow || 0;
    $('#lkOutline').value = l.outline || 0;
    $('#lkBold').classList.toggle('on', !!l.bold);
    $('#lkItalic').classList.toggle('on', !!l.italic);
    $('#lkCaps').classList.toggle('on', !!l.allCaps);
    $$('[data-lkalign]').forEach((b) => b.classList.toggle('on', b.dataset.lkalign === (l.align || 'center')));
    $$('[data-lkvalign]').forEach((b) => b.classList.toggle('on', b.dataset.lkvalign === (l.valign || 'center')));
    const bg = l.bg || {};
    $('#lkBgType').value = bg.type || 'color';
    $('#lkBgColor').value = /^#/.test(bg.value || '') ? bg.value : '#07090f';
    $('#lkDim').value = bg.dim || 0;
    $('#lkShowFooter').checked = l.showFooter !== false;
    const isFile = bg.type === 'image' || bg.type === 'video';
    $('#lkBgColorRow').classList.toggle('hidden', bg.type !== 'color');
    $('#lkBgPickRow').classList.toggle('hidden', !isFile);
    $('#lkBgName').textContent = isFile && bg.value ? String(bg.value).split(/[\\/]/).pop() : '';
    const pad = l.padY == null ? 100 : l.padY;
    $('#lkPad').value = pad; $('#lkPadV').textContent = pad + 'px';
    const fontSel = $('#lkFont');
    if (fontSel && fontSel.options.length) fontSel.value = l.font || 'Poppins';
    syncVerseFormat();
    renderLookPreview();
  }
  function renderLookPreview() {
    window.SlideRender.paint($('#lkPreview'),
      { lines: ['The LORD is my shepherd;', 'I shall not want.'], footer: 'Psalm 23:1  (KJV)' }, look());
  }
  function editLook(mut) {
    const l = look(); if (!l) return;
    mut(l);
    saveLooks(); syncLookUi();
    renderMonitors();
    // The projector still follows every step of the drag — it is the thing the
    // change is being made for. Only the grid of thumbnails is held back.
    const d = doc();
    _suppressGrid++;
    try { if (d && pv.liveDocId === d.id && pv.liveIx >= 0) live(pv.liveIx); }
    finally { _suppressGrid--; }
    renderSlidesSoon();
  }

  /* ======================= the show desk, made readable =======================
   *
   * The Show panel grew to fourteen sections, every one of them open at once,
   * and a media volunteer opening it for the first time met a wall of about
   * forty controls with no way to tell the five that matter on a Sunday from
   * the nine that are set up once when the projector is installed and never
   * touched again.
   *
   * Nothing is removed — a church that has bought into screen mapping, NDI and
   * DMX still needs all of it. It is SORTED:
   *   • "Simple" shows only what a service uses. "Everything" adds the rest.
   *   • Every section folds, and three start open — the ones you reach for.
   *   • What you leave open is remembered, so an operator's own desk stays put.
   */
  const SHOW_OPEN_BY_DEFAULT = ['props', 'messages', 'timers'];

  function buildShowSections() {
    const pane = document.querySelector('[data-pvpane="show"]');
    if (!pane) return;
    let open = null;
    try { open = JSON.parse(localStorage.getItem('mw-pv-showopen') || 'null'); } catch (e) {}
    if (!Array.isArray(open)) open = SHOW_OPEN_BY_DEFAULT.slice();
    $$('.pv-show-sec', pane).forEach((sec) => {
      const head = sec.querySelector('.pv-show-head');
      if (!head || sec.dataset.built) return;
      sec.dataset.built = '1';
      // Everything after the heading becomes the foldable body. Doing it here
      // rather than in the markup keeps fourteen sections of hand-written HTML
      // readable instead of nested two levels deeper.
      const body = document.createElement('div');
      body.className = 'pv-sec-body';
      while (head.nextSibling) body.appendChild(head.nextSibling);
      sec.appendChild(body);
      const title = head.firstElementChild;
      if (title) {
        title.classList.add('pv-sec-title-btn');
        title.setAttribute('role', 'button');
        title.setAttribute('tabindex', '0');
        title.title = 'Click to fold this section away';
        const chev = document.createElement('span');
        chev.className = 'pv-sec-chev';
        chev.textContent = '▾';
        title.insertBefore(chev, title.firstChild);
        const toggle = () => setShowSectionOpen(sec.dataset.sec, sec.classList.contains('collapsed'));
        title.addEventListener('click', toggle);
        title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      }
      sec.classList.toggle('collapsed', !open.includes(sec.dataset.sec));
    });
    $$('[data-showmode]', pane).forEach((b) => b.addEventListener('click', () => setShowMode(b.dataset.showmode)));
    setShowMode(pv.showMode || 'simple');
  }

  function setShowSectionOpen(key, wantOpen) {
    const sec = document.querySelector(`[data-pvpane="show"] .pv-show-sec[data-sec="${key}"]`);
    if (!sec) return null;
    sec.classList.toggle('collapsed', !wantOpen);
    const open = $$('[data-pvpane="show"] .pv-show-sec:not(.collapsed)').map((s) => s.dataset.sec);
    try { localStorage.setItem('mw-pv-showopen', JSON.stringify(open)); } catch (e) {}
    return open;
  }

  function setShowMode(mode) {
    pv.showMode = mode === 'all' ? 'all' : 'simple';
    const pane = document.querySelector('[data-pvpane="show"]');
    if (!pane) return pv.showMode;
    $$('[data-showmode]', pane).forEach((b) => b.classList.toggle('on', b.dataset.showmode === pv.showMode));
    $$('.pv-show-sec', pane).forEach((s) => {
      s.classList.toggle('pv-sec-hidden', pv.showMode === 'simple' && s.dataset.adv === '1');
    });
    try { localStorage.setItem('mw-pv-showmode', pv.showMode); } catch (e) {}
    return pv.showMode;
  }

  /* ============================ modes / tabs ============================ */
  /* Still here, and still the thing that decides whether a click cues the
   * projector — it is just no longer a button the operator can leave switched
   * on. editSlide() turns it on and off around the textarea. */
  function setMode(m) {
    pv.mode = m;
    $('#view-present').classList.toggle('pv-editing', m === 'edit');
  }
  function setTab(t) {
    pv.tab = t;
    $$('[data-pvtab]').forEach((b) => b.classList.toggle('active', b.dataset.pvtab === t));
    $$('[data-pvpane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pvpane !== t));
    if (t === 'media') refreshMedia();
    if (t === 'bible') refreshBiblePicker();
    // Loaded on first sight rather than at startup: a church that never opens
    // the tab should not pay for reading the bank off disk.
    if (t === 'songs') { if (pv.bank.loaded) renderBank(); else refreshBank(); }
    if (t === 'look') syncLookUi();
    if (t === 'show') {
      renderProps(); renderMessages(); renderTimers(); renderOutputList();
      renderMacros(); renderLiveInputs(); renderWebOut(); renderMidi();
    }
  }

  /* ============================ wiring ============================ */
  function wire() {
    $$('[data-pvtab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.pvtab)));

    $('#pvLibNew').addEventListener('click', () => newDoc('Untitled song', 'song'));
    $('#pvNewSong').addEventListener('click', () => newDoc('Untitled song', 'song'));
    $('#pvPasteSongs').addEventListener('click', () => openPasteSongs());
    $('#pvImportSongs').addEventListener('click', () => openImportSongs());
    $('#pvExportSongs').addEventListener('click', () => openExportSongs());
    $('#pvLibFilter').addEventListener('input', renderLibrary);

    /* --- the Songs Bank --- */
    $('#pvBankFilter').addEventListener('input', renderBank);
    $('#pvBankNew').addEventListener('click', () => openBankEditor(null));
    $('#pvBankMerge').addEventListener('click', () => bankMergeLibrary());
    $('#pvBankAddOpen').addEventListener('click', () => bankTheOpenSong());

    $('#pvAddSlide').addEventListener('click', () => addSlide());
    $('#pvDelSlide').addEventListener('click', deleteSlide);
    $('#pvReflow').addEventListener('click', reflow);
    $('#pvDocName').addEventListener('change', () => { const d = doc(); if (d) { d.name = $('#pvDocName').value || 'Untitled'; touch(); renderLibrary(); } });

    $('#pvPlNew').addEventListener('click', async () => {
      const name = await ask('Name this playlist:', 'Sunday ' + new Date().toLocaleDateString());
      if (!name) return;
      const pl = { id: uid(), name, items: [] };
      pv.playlists.push(pl); pv.playlistId = pl.id; savePlaylist(pl);
      renderPlaylists(); renderPlaylistItems();
    });
    // The sub-header carries the open playlist's name; renaming from there is
    // the obvious move when that is the name you are looking at.
    $('#pvPlName').addEventListener('dblclick', () => {
      const pl = pv.playlists.find((p) => p.id === pv.playlistId); if (!pl) return;
      inlineRename($('#pvPlName'), pl.name, (v) => {
        pl.name = v; savePlaylist(pl); renderPlaylists(); renderPlaylistItems();
      });
    });
    $('#pvPlAdd').addEventListener('click', () => {
      const pl = pv.playlists.find((p) => p.id === pv.playlistId); const d = doc();
      if (!pl || !d) return;
      pl.items = (pl.items || []).concat([{ id: uid(), presentationId: d.id }]);
      savePlaylist(pl); renderPlaylists(); renderPlaylistItems();
    });

    $('#pvSize').addEventListener('input', () => { pv.thumbSize = +$('#pvSize').value; renderSlides(); });
    $('#pvBlack').addEventListener('click', () => { pv.blackout = !pv.blackout; pushLive(); renderClearPalette(); });
    $('#pvPrev').addEventListener('click', () => step(-1));
    $('#pvNext').addEventListener('click', () => step(1));
    // the promise is kept so a test can click the real button and await the real work
    $('#pvGo').addEventListener('click', () => { pv._goLive = goLive(); });

    $('#pvAudience').addEventListener('click', () => toggleOutput('audience'));
    $('#pvStage').addEventListener('click', () => toggleOutput('stage'));
    $('#pvScreens').addEventListener('click', (ev) => { ev.stopPropagation(); toggleScreenMenu(); });
    document.addEventListener('click', (ev) => {
      const menu = $('#pvScreenMenu');
      if (!menu || menu.classList.contains('hidden')) return;
      if (!menu.contains(ev.target) && !ev.target.closest('#pvScreens')) toggleScreenMenu(false);
    });
    $('#pvDisplay').addEventListener('change', async () => {
      pv.displayId = $('#pvDisplay').value;
      // An explicit choice is final — nothing may second-guess it later, not
      // even the "don't project onto the operator's own screen" rule.
      pv.displayPicked = true;
      savePref();
      if (pv.outputs.audience) { await window.api.present.open('audience', pv.displayId, false, 'main'); await refreshOutputs(); pushLive(); }
    });

    // Bible
    $('#pvTranslation').addEventListener('change', () => {
      // .catch, not try/catch: this is not awaited, so a rejected call escapes
      // the try entirely and lands as an unhandled rejection in the console —
      // which on a studio that logs console errors reads as the Presentation
      // Studio having failed, when all that happened is that nobody is listening.
      Promise.resolve(window.api.voice.translation($('#pvTranslation').value || null)).catch(() => {});
      const v = $('#pvTranslation').value;
      // "＋ Add another translation…" is the same list the ⚙ opens — putting it
      // in the dropdown means the answer to "where is the NIV" is where someone
      // is already looking, rather than behind a gear icon.
      if (v === '__manage') { $('#pvTranslation').value = pv.translation || ''; openBibleManager(); return; }
      pv.translation = v; savePref();
      refreshBiblePicker();
      if (pv.bibleResult) findScripture();
    });
    $('#pvBibleManage').addEventListener('click', openBibleManager);
    // Where the verse sits, and how big it is.
    $$('[data-vfvalign]').forEach((b) => b.addEventListener('click', () => setVerseFormat({ valign: b.dataset.vfvalign })));
    $$('[data-vfalign]').forEach((b) => b.addEventListener('click', () => setVerseFormat({ align: b.dataset.vfalign })));
    $('#pvVfBigger').addEventListener('click', () => setVerseFormat({ sizePx: Math.min(200, verseSizePx() + 8) }));
    $('#pvVfSmaller').addEventListener('click', () => setVerseFormat({ sizePx: Math.max(28, verseSizePx() - 8) }));
    $('#pvVfReset').addEventListener('click', () => setVerseFormat(null));
    /*
     * Book ▸ chapter ▸ verse: each one narrows the next, and the passage
     * appears without anyone pressing Find.
     *
     * Every change goes through pickerQueue. Filling a list means asking for a
     * chapter, which takes time, and an operator changing book then chapter
     * then verse before the first answer comes back would otherwise have two
     * fills racing: one repopulates the verse list under the other, and the
     * panel ends up showing a different passage from the one the dropdowns
     * spell out.
     */
    $('#pvBook').addEventListener('change', () => pickerQueue(async () => { await fillChapters(); await findFromPicker(); }));
    $('#pvChapter').addEventListener('change', () => pickerQueue(async () => { await fillVerses(); await findFromPicker(); }));
    $('#pvVerse').addEventListener('change', () => pickerQueue(async () => { syncVerseRange(); await findFromPicker(); }));
    $('#pvVerseTo').addEventListener('change', () => pickerQueue(async () => { syncVerseRange(); await findFromPicker(); }));
    $('#pvRefGo').addEventListener('click', findScripture);
    $('#pvListen').addEventListener('click', () => { pv._listenOp = toggleListening(); });
    $('#pvListenMic').addEventListener('change', (e) => { pv._micOp = setListenMic(e.target.value); });
    $('#pvListenFast').addEventListener('change', async (e) => {
      pv.listen.fast = !!e.target.checked;
      savePref();
      const note = $('#pvListenFastNote'); if (note) note.textContent = '';
      // Load (or drop) the model right away, so the tick box is honest about
      // what it did instead of waiting for the next thing anyone says.
      if (pv.listen.fast) {
        const r = await window.api.voice.warmUp(true, pv.listen.model).catch(() => null);
        if (note) note.textContent = r && r.resident ? '— model loaded' : '— not available here';
        if (r && !r.resident) listenLog('Faster replies is not available on this build: ' + esc(r.residentWhy || 'unknown'), 'warn');
      }
    });
    // Opening the list is intent: that is when it is fair to ask for the
    // microphone in order to learn the devices' real names.
    /*
     * Building the indexes takes a few seconds and happens on its own thread,
     * so the box can be ticked mid-service without the studio pausing. Until
     * they are ready the note says so — a feature that silently does nothing
     * for four seconds looks broken, and this is the moment somebody is
     * watching it hardest to decide whether it works.
     */
    /*
     * "Follow the reading" needs nothing loading and nothing downloaded — the
     * verse is already on the screen and the words are already arriving — so
     * unlike the two boxes above this one simply takes effect. The only state
     * it carries is which chunk has been turned, which is cleared when it is
     * switched on so a box ticked mid-reading starts from where the screen is.
     */
    $('#pvListenFollow').addEventListener('change', (e) => {
      pv.listen.follow = !!e.target.checked;
      // Ticking it mid-service starts from where the screen is now, not from
      // whatever was said before anybody asked for this.
      tapeReset();
      savePref();
      const note = $('#pvListenFollowNote');
      if (note) note.textContent = pv.listen.follow ? '— the page turns itself' : '';
    });
    $('#pvListenQuote').addEventListener('change', (e) => {
      pv.listen.quote = !!e.target.checked;
      savePref();
      const note = $('#pvListenQuoteNote');
      if (!pv.listen.quote) { pv.listen.quoteReady = false; if (note) note.textContent = ''; return; }
      if (note) note.textContent = '— reading the Bible…';
      pv.listen.quoteOp = (async () => {
        let r = null;
        try { r = await window.api.voice.quotePrepare(pv.translation || null); } catch (err) { r = null; }
        pv.listen.quoteReady = !!(r && r.ready);
        if (!note) return;
        if (!r || !r.ready) {
          note.textContent = '— needs a downloaded Bible';
          return;
        }
        const n = (r.indexes || []).length;
        note.textContent = n > 1
          ? `— the whole Bible, in all ${n} installed translations`
          : '— the whole Bible, in the one installed translation';
      })();
    });
    $('#pvListenMic').addEventListener('mousedown', () => { pv._micOp = refreshMicList({ unlock: true }); });
    $('#pvListenMic').addEventListener('focus', () => { pv._micOp = refreshMicList({ unlock: true }); });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => { refreshMicList().catch(() => {}); });
    }
    refreshMicList().catch(() => {});
    /*
     * Leaving the Presentation Studio closes the microphone. A church PC with
     * an open mic nobody remembers turning on is not something to ship, and the
     * button is the only thing that should be able to open it.
     */
    $$('.nav-item[data-view]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.view !== 'present' && pv.listen.ear) stopListening();
    }));
    $('#pvRef').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findScripture(); } });
    $('#pvVps').addEventListener('change', () => { if (pv.bibleResult) updateBibleButtons(); });
    // Two different jobs, and they must stay different: ＋ Add puts the passage
    // in the Library (for a reading planned into the running order), Send live
    // puts it on the screen and leaves the Library alone.
    $('#pvBibleAdd').addEventListener('click', () => addScripture(false));
    $('#pvBibleLive').addEventListener('click', () => {
      const res = pv.bibleResult;
      sendVerseLive(res && res.verses.length ? res.verses[0].verse : 0);
    });
    $('#bibClose').addEventListener('click', () => $('#bibModal').classList.add('hidden'));
    $('#bibDone').addEventListener('click', () => $('#bibModal').classList.add('hidden'));
    $('#bibFilter').addEventListener('input', renderBibleList);
    $('#bibImport').addEventListener('click', importTranslation);
    $('#bibRefresh').addEventListener('click', async () => {
      $('#bibList').innerHTML = '<p class="muted small lib-empty">Refreshing…</p>';
      try { pv.catalogue = await window.api.bible.catalogue(true); } catch (e) {}
      renderBibleList();
    });

    // Media
    $('#pvMediaAdd').addEventListener('click', addMedia);
    $('#pvAddImage').addEventListener('click', addImageSlideFromPicker);

    /* ---- clear palette / easy view / transitions ---- */
    $('#pvEasy').addEventListener('click', () => { pv.easyView = !pv.easyView; $('#pvEasy').classList.toggle('on', pv.easyView); pushLive(); });

    /* ---- show tab: props, messages, timers, announcements, outputs ---- */
    $('#pvPropImg').addEventListener('click', () => addProp('image'));
    $('#pvPropText').addEventListener('click', () => addProp('text'));
    $('#pvMsgClear').addEventListener('click', clearMessage);
    $('#pvTimerDown').addEventListener('click', () => addTimer('countdown'));
    $('#pvTimerUp').addEventListener('click', () => addTimer('countup'));
    $('#pvTimerClock').addEventListener('click', () => addTimer('clock'));
    $('#pvAnnounceText').addEventListener('change', () => setAnnouncement($('#pvAnnounceText').value));
    $('#pvAnnounceOn').addEventListener('click', () => {
      if (pv.announcement) setAnnouncement('');
      else setAnnouncement($('#pvAnnounceText').value);
    });
    $('#pvStageMsg').addEventListener('change', () => { pv.stageMessage = $('#pvStageMsg').value; pushLive(); });
    $('#pvOutAdd').addEventListener('click', addOutput);

    /* ---- stage layout, screen mapping, NDI ---- */
    $('#pvStageLayout').addEventListener('change', (e) => setStageLayout(e.target.value));
    ['#pvMapRotate', '#pvMapScale', '#pvMapX', '#pvMapY', '#pvMapW', '#pvMapH',
      '#pvBlendL', '#pvBlendR', '#pvBlendT', '#pvBlendB', '#pvBlendG']
      .forEach((sel) => $(sel).addEventListener('input', readMapEditor));
    $('#pvMapClose').addEventListener('click', () => { pv.mapEditing = null; $('#pvMapEditor').classList.add('hidden'); });
    $('#pvMapReset').addEventListener('click', () => {
      if (!pv.mapEditing) return;
      pv.outputMaps[pv.mapEditing] = DEFAULT_MAP();
      openMapEditor(pv.mapEditing); saveShow(); pushLive(); renderOutputList();
    });
    $('#pvNdiAdd').addEventListener('click', addNdiOutput);

    /* ---- audio ---- */
    $('#pvAudioAdd').addEventListener('click', () => addAudioTrack());
    $('#pvAudioStop').addEventListener('click', () => stopAllAudio());
    $('#pvAudioMaster').addEventListener('input', (e) => setMaster(parseFloat(e.target.value)));
    $('#pvAudioBin').addEventListener('change', (e) => { pv.audio.playlistOn = e.target.checked; saveShow(); });
    $('#pvAudioShuffle').addEventListener('change', (e) => { pv.audio.shuffle = e.target.checked; saveShow(); });
    $('#pvSlideAudio').addEventListener('change', (e) => {
      const s = slides()[pv.slideIx]; if (!s) return;
      if (e.target.value) s.audio = e.target.value; else delete s.audio;
      touch();
    });

    /* ---- lighting ---- */
    $('#pvDmxOn').addEventListener('change', configureDmx);
    $('#pvDmxHost').addEventListener('change', configureDmx);
    $('#pvDmxSend').addEventListener('click', () => sendDmx($('#pvDmxCmd').value));
    $('#pvDmxCmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendDmx(e.target.value); } });
    $('#pvDmxBlack').addEventListener('click', () => window.api.dmx.blackout(0).catch(() => {}));

    /* ---- ready-made backgrounds ---- */
    $$('[data-bgapply]').forEach((b) => b.addEventListener('click', () => setBgApply(b.dataset.bgapply)));
    const mo = $('#pvBgMotion'); if (mo) mo.addEventListener('change', () => setBgMotion(mo.value));

    /* ---- web video, video controls, chroma key, markers ---- */
    $('#pvLinkAdd').addEventListener('click', () => addWebVideo(true));
    $('#pvLinkUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addWebVideo(true); } });
    ['#pvVidBright', '#pvVidContrast', '#pvVidSat', '#pvVidHue', '#pvVidSpeed', '#pvVidIn', '#pvVidOut',
      '#pvKeySim', '#pvKeySmooth', '#pvKeySpill', '#pvKeyColor']
      .forEach((sel) => $(sel).addEventListener('input', applyVideoOpts));
    $('#pvVidPingPong').addEventListener('change', applyVideoOpts);
    // Pause / play and Loop act on whatever video is on the screen, whether it
    // came from the collection, from the church's own files or from a Look.
    $('#pvVidPlay').addEventListener('click', () => {
      pv.bgPaused = !pv.bgPaused;
      live(null, 'slide');
      window.__toast && window.__toast(pv.bgPaused ? '⏸ Background paused.' : '▶ Background playing.', 'good', 2500);
    });
    $('#pvVidLoop').addEventListener('click', () => {
      pv.bgLoop = pv.bgLoop === false;          // was off -> on
      live(null, 'slide');
      window.__toast && window.__toast(pv.bgLoop ? '🔁 The clip will loop.' : '⏭ The clip will stop at the end.', 'good', 2500);
    });
    $('#pvKeyOn').addEventListener('change', applyVideoOpts);
    $('#pvVidReset').addEventListener('click', resetVideoOpts);
    $('#pvMarkAdd').addEventListener('click', async () => {
      const at = await ask('Fire at how many seconds into the clip?', '8');
      if (at == null) return;
      const what = await ask('Do what?\nType a macro name, or: black, clearMessage, or "goto 3"', 'black');
      if (!what) return;
      const macro = pv.macros.find((m) => m.name.toLowerCase() === what.toLowerCase());
      const goto = /^goto\s+(\d+)/i.exec(what);
      if (macro) addMarker(at, 'macro', macro.id, macro.name);
      else if (goto) addMarker(at, 'goto', goto[1], 'Go to slide ' + goto[1]);
      else addMarker(at, what, '', what);
      pushLive();
    });

    /* ---- macros, live input, drawing, web output, MIDI ---- */
    $('#pvMacroNew').addEventListener('click', captureMacro);
    $('#pvInCam').addEventListener('click', () => pickLiveInput('camera'));
    $('#pvInScreen').addEventListener('click', () => pickLiveInput('screen'));
    $('#pvInOff').addEventListener('click', () => { pv.layers.background = null; pushLive(); renderLiveInputs(); });
    $('#pvDraw').addEventListener('click', toggleDraw);
    $('#pvDrawClear').addEventListener('click', clearDrawing);
    $('#pvWebToggle').addEventListener('click', toggleWebOut);
    $('#pvMidiLearn').addEventListener('click', async () => {
      const what = await ask('Bind the next MIDI note to what?\nType: next, prev, black, or a macro name', 'next');
      if (!what) return;
      const macro = pv.macros.find((m) => m.name.toLowerCase() === what.toLowerCase());
      pv._midiLearn = macro ? macro.id : ('__' + what.toLowerCase());
      window.__toast && window.__toast('🎹 Play the note or press the pad you want to use…', 'good', 6000);
    });

    // remote control arriving from a phone or a Stream Deck
    if (window.api.present.onRemote) window.api.present.onRemote(({ cmd, arg }) => {
      if (cmd === 'next') step(1);
      else if (cmd === 'prev') step(-1);
      else if (cmd === 'black') { pv.blackout = !pv.blackout; pushLive(); renderClearPalette(); }
      else if (cmd === 'clear') toggleClear(arg || 'slide');
      else if (cmd === 'slide') live(parseInt(arg, 10) || 0);
      else if (cmd === 'macro') runMacro(arg);
      else if (cmd === 'easy') { pv.easyView = !pv.easyView; pushLive(); }
      else if (cmd === 'message') { pv.message = arg ? { text: arg, position: 'bottom', size: 52 } : null; pushLive(); renderMessages(); }
      // A phone that changed something must see the change too — but only if
      // there IS a phone: these same commands now arrive from the arrow keys on
      // the projector window, and those must not cost a round trip per press.
      if (pv.web && pv.web.running) window.api.webout.state().then((s) => { pv.web = s; renderWebOut(); }).catch(() => {});
    });

    /* ---- arrangements + chords ---- */
    $('#pvArrange').addEventListener('change', () => { pv.arrangement = $('#pvArrange').value || null; renderSlides(); });
    $('#pvArrangeNew').addEventListener('click', newArrangement);
    // Opening the popover is the moment the song name and key must be right.
    $('#pvMusicDetails').addEventListener('toggle', syncMusicPanel);
    $('#pvChordUp').addEventListener('click', () => transposeSong(1));
    $('#pvChordDown').addEventListener('click', () => transposeSong(-1));
    $('#pvImportChords').addEventListener('click', () => importChordPro());

    // Look
    $('#pvLookSel').addEventListener('change', () => {
      pv.lookId = $('#pvLookSel').value;
      const d = doc(); if (d) { d.lookId = pv.lookId; touch(); }
      syncLookUi(); renderSlides(); renderMonitors();
      if (d && pv.liveDocId === d.id && pv.liveIx >= 0) live(pv.liveIx);
    });
    $('#pvLookNew').addEventListener('click', async () => {
      const name = await ask('Name this Look:', look().name + ' copy'); if (!name) return;
      const l = Object.assign({}, JSON.parse(JSON.stringify(look())), { id: uid(), name });
      pv.looks.push(l); pv.lookId = l.id; saveLooks(); syncLookUi();
    });
    $('#pvLookDel').addEventListener('click', () => {
      if (pv.looks.length <= 1) return;
      pv.looks = pv.looks.filter((l) => l.id !== pv.lookId);
      pv.lookId = pv.looks[0].id; saveLooks(); syncLookUi(); renderSlides();
    });
    $('#lkSize').addEventListener('input', () => editLook((l) => { l.sizePx = +$('#lkSize').value; }));
    $('#lkColor').addEventListener('input', () => editLook((l) => { l.color = $('#lkColor').value; }));
    $('#lkLine').addEventListener('input', () => editLook((l) => { l.lineHeight = +$('#lkLine').value; }));
    $('#lkShadow').addEventListener('input', () => editLook((l) => { l.shadow = +$('#lkShadow').value; }));
    $('#lkOutline').addEventListener('input', () => editLook((l) => { l.outline = +$('#lkOutline').value; }));
    $('#lkBold').addEventListener('click', () => editLook((l) => { l.bold = !l.bold; }));
    $('#lkItalic').addEventListener('click', () => editLook((l) => { l.italic = !l.italic; }));
    $('#lkCaps').addEventListener('click', () => editLook((l) => { l.allCaps = !l.allCaps; }));
    $$('[data-lkalign]').forEach((b) => b.addEventListener('click', () => editLook((l) => { l.align = b.dataset.lkalign; })));
    $$('[data-lkvalign]').forEach((b) => b.addEventListener('click', () => editLook((l) => { l.valign = b.dataset.lkvalign; })));
    // The margin keeps the words off the edges — the one part of "where the
    // text sits" that had no control at all.
    $('#lkPad').addEventListener('input', () => {
      const px = parseInt($('#lkPad').value, 10) || 100;
      editLook((l) => { l.padX = Math.round(px * 1.4); l.padY = px; });
      $('#lkPadV').textContent = px + 'px';
    });
    $('#lkFont').addEventListener('change', () => editLook((l) => { l.font = $('#lkFont').value; }));
    $('#lkShowFooter').addEventListener('change', () => editLook((l) => { l.showFooter = $('#lkShowFooter').checked; }));
    $('#lkDim').addEventListener('input', () => editLook((l) => { l.bg = Object.assign({}, l.bg, { dim: +$('#lkDim').value }); }));
    $('#lkBgType').addEventListener('change', () => editLook((l) => {
      const t = $('#lkBgType').value;
      const presets = { color: '#07090f', gradient: 'linear-gradient(160deg,#1b1042 0%,#2d1b69 45%,#0b0720 100%)' };
      l.bg = Object.assign({}, l.bg, { type: t, value: presets[t] != null ? presets[t] : (l.bg && l.bg.value) || '' });
    }));
    $('#lkBgColor').addEventListener('input', () => editLook((l) => { l.bg = Object.assign({}, l.bg, { type: 'color', value: $('#lkBgColor').value }); }));
    $('#lkBgPick').addEventListener('click', async () => {
      const isVideo = $('#lkBgType').value === 'video';
      const filters = isVideo
        ? [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v'] }]
        : [{ name: 'Image', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }];
      let p; try { p = await window.api.dialog.openFile(filters); } catch (e) { p = null; }
      if (p) editLook((l) => { l.bg = Object.assign({}, l.bg, { type: isVideo ? 'video' : 'image', value: p, fit: 'cover' }); });
    });

    // Keyboard — the operator runs the service from here, hands off the mouse.
    /*
     * Clicking the slide grid takes the keyboard BACK.
     *
     * The shortcuts below deliberately stand aside while a field or a dropdown
     * has focus — arrows have to work inside the book/chapter pickers. But that
     * left the operator one click away from a dead keyboard: choose a verse,
     * press →, nothing happens, because the focus is still in a <select>. A
     * click on the slides is an unambiguous "I am done with that control".
     */
    $('#view-present').addEventListener('mousedown', (e) => {
      const el = e.target;
      if (el.closest('input, textarea, select, [contenteditable="true"]')) return;
      const a = document.activeElement;
      if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) a.blur();
    });

    document.addEventListener('keydown', (e) => {
      if (!$('#view-present').classList.contains('active')) return;
      const t = e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.code === 'Space') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); goLive(); }
      else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); pv.blackout = !pv.blackout; pushLive(); renderClearPalette(); }
      else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); toggleClear('__all'); }
      else if (e.key === '~' || e.key === '`') { e.preventDefault(); pv.easyView = !pv.easyView; pushLive(); }
      else if (e.key >= '1' && e.key <= '7' && !e.ctrlKey && !e.metaKey) {
        // 1-7 clear individual layers, the way a lighting desk has bump buttons
        e.preventDefault(); toggleClear(CLEAR_LAYERS[+e.key - 1].id);
      }
      else if (e.key === 'Escape') { e.preventDefault(); escape(); }
      /* No 'e' toggle any more. With the Show/Edit buttons gone there is
       * nothing on screen to show the mode, and a shortcut that silently stops
       * clicks from reaching the projector is the worst kind of key to press
       * by accident. Double-click the slide you want to change instead. */
      else if (e.key === 'Home') { e.preventDefault(); if (pv.verseCue) cueVerseChunk(0); else live(0); }
      else if (e.key === 'End') {
        e.preventDefault();
        if (pv.verseCue) cueVerseChunk(pv.verseCue.slides.length - 1); else live(slides().length - 1);
      }
    });

    // Outputs opening/closing, monitors being plugged in. pv.outputList MUST be
    // updated alongside pv.outputs: it is what "is anything showing the picture?"
    // is answered from, so leaving it stale meant an output closed with Esc kept
    // a ghost entry — the studio thought it was still live and Go Live would
    // refuse to re-open the projector.
    if (window.api.present.onOutputs) window.api.present.onOutputs((st) => {
      pv.outputs = st;
      pv.outputList = (st && st.outputs) || [];
      renderOutputs(); renderOutputList();
      announceScreenChange(st || {});
    });
    window.addEventListener('resize', () => { if ($('#view-present').classList.contains('active')) { renderMonitors(); renderSlides(); } });
  }

  async function pickLogo() {
    if (pv.logoPath) {
      live(null, pv.outMode === 'logo' ? 'slide' : 'logo');
      return;
    }
    let p; try { p = await window.api.dialog.openFile([{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]); } catch (e) { p = null; }
    if (!p) return;
    pv.logoPath = p;
    try { localStorage.setItem('mw-pv-logo', p); } catch (e) {}
    live(null, 'logo');
  }

  function savePref() {
    try {
      localStorage.setItem('mw-pv', JSON.stringify({
        translation: pv.translation, displayId: pv.displayId, lookId: pv.lookId,
        clearMore: !!pv.clearMore, liveTranslations: pv.liveTranslations || [],
        verseBg: pv.verseBg || null, verseTheme: pv.verseTheme || null,
        listenMic: pv.listen.micId || '', listenMicName: pv.listen.micLabel || '',
        listenFast: !!pv.listen.fast, listenQuote: !!pv.listen.quote,
        listenFollow: !!pv.listen.follow, listenModel: pv.listen.model || '',
      }));
    } catch (e) {}
  }
  function loadPref() {
    try {
      const p = JSON.parse(localStorage.getItem('mw-pv') || '{}');
      if (p.translation) pv.translation = p.translation;
      if (p.displayId) pv.displayId = p.displayId;
      if (p.lookId) pv.lookId = p.lookId;
      pv.clearMore = !!p.clearMore;
      pv.listen.quote = !!p.listenQuote;
      /* Off unless the operator asked for it: it is the other thing here that
       * can move the screen without anybody touching the desk. */
      pv.listen.follow = !!p.listenFollow;
      /* '' is automatic. A model that has since been deleted simply falls back
       * to the ladder — resolveModel only honours one that is installed. */
      if (typeof p.listenModel === 'string') pv.listen.model = p.listenModel;
      if (Array.isArray(p.liveTranslations)) pv.liveTranslations = p.liveTranslations;
      if (p.verseBg && p.verseBg.type) pv.verseBg = p.verseBg;
      if (p.verseTheme && typeof p.verseTheme === 'object') pv.verseTheme = p.verseTheme;
      if (typeof p.listenMic === 'string') pv.listen.micId = p.listenMic;
      if (typeof p.listenMicName === 'string') pv.listen.micLabel = p.listenMicName;
      /*
       * Keeping the model loaded is ON unless the operator has turned it off.
       * It used to be an optimisation worth about half a second on the handful
       * of instructions somebody spoke into a pause. Now that the studio also
       * looks back over the last few seconds while the preaching goes on, it
       * runs about forty times a minute, and that half-second is most of the
       * work — leaving it off makes the whole thing late for no reason.
       */
      pv.listen.fast = p.listenFast === undefined ? true : !!p.listenFast;
      pv.logoPath = localStorage.getItem('mw-pv-logo') || null;
      pv.mediaExtra = JSON.parse(localStorage.getItem('mw-pv-media') || '[]');
      pv.showMode = localStorage.getItem('mw-pv-showmode') === 'all' ? 'all' : 'simple';
      const show = JSON.parse(localStorage.getItem('mw-pv-show') || '{}');
      if (Array.isArray(show.props)) pv.props = show.props;
      if (Array.isArray(show.timers)) pv.timers = show.timers;
      if (show.announcement) pv.announcement = show.announcement;
      if (show.transitions) Object.assign(pv.transitions, show.transitions);
      if (show.outputLooks) pv.outputLooks = show.outputLooks;
      if (Array.isArray(show.macros)) pv.macros = show.macros;
      if (show.midiBinds) pv.midiBinds = show.midiBinds;
      // Screen mapping IS the room — a rotated projector or an LED wall's edge
      // blend has to survive a restart, or the picture comes back wrong.
      if (show.outputMaps) pv.outputMaps = show.outputMaps;
      if (show.stageLayoutId) pv.stageLayoutId = show.stageLayoutId;
      if (show.audio) {
        // Levels and the music bin survive a restart; nothing is left PLAYING,
        // because an app that starts making noise on launch is a nightmare in a
        // quiet auditorium.
        Object.assign(pv.audio, show.audio, { tracks: (show.audio.tracks || []).map((t) => Object.assign({}, t, { playing: false, el: null })) });
      }
      // Clears are deliberately NOT restored: starting a service with the lyrics
      // silently cleared because of last week is exactly the kind of surprise
      // this whole panel exists to prevent.
    } catch (e) {}
  }

  window.Presenter = {
    async init(settings) {
      if (pv.inited) return; pv.inited = true;
      pv.settings = settings || {};
      const cfg = (settings && settings.present) || {};
      pv.translation = cfg.translation || pv.translation;
      loadPref();
      window.SlideRender.injectCss(document);
      /*
       * BOTH stylesheets, or the Live monitor goes black.
       *
       * The monitors here draw the same COMPOSITE the projector draws
       * (paintComposite), and that builds `.lyr-img` / `.lyr-video` / `.lyr-prop`
       * elements whose sizing lives in layers.js — `position:absolute; inset:0;
       * width:100%; height:100%`. Without it a background image is a div with
       * the right `background-image` and NO HEIGHT: the operator sees the words
       * on black while every thumbnail beside it shows the picture, because
       * thumbnails use `.sr-bg` from the other sheet. output.html injected both
       * from the start; the studio window only ever injected one.
       */
      window.Layers.injectCss(document);
      // caption fonts are already bundled and @font-face'd by the video studio
      const fonts = ['Poppins', 'Anton', 'Bebas Neue', 'Bangers', 'Arial'];
      $('#lkFont').innerHTML = fonts.map((f) => `<option value="${f}">${f}</option>`).join('');
      await loadLibrary();
      wire();
      renderLibrary(); renderPlaylists(); renderPlaylistItems(); renderSlides();
      renderClearPalette(); renderArrangements();
      renderProps(); renderMessages(); renderTimers();
      if (pv.announcement) $('#pvAnnounceText').value = (pv.announcement.lines || []).join('\n');
      $('#pvAnnounceOn').classList.toggle('on', !!pv.announcement);
      setInterval(tickStudioTimers, 500);
      renderMacros(); renderLiveInputs(); renderMidi(); renderStageLayouts();
      renderAudio(); renderAudioLinks(); renderMarkers(); refreshDmx();
      await refreshBgVideos();     // which motion backgrounds are already here
      renderBgCats(); renderBuiltinBgs();
      try { pv.web = await window.api.webout.state(); } catch (e) {}
      renderWebOut();
      // Bring last Sunday's feeds back up before anything else needs them.
      refreshNdi().then(restoreNdiFeeds);
      // Receiver counts and feed health change on their own, so the NDI panel
      // keeps itself honest rather than waiting for the operator to poke it.
      setInterval(() => { if (pv.ndi && (pv.ndi.feeds || []).length) refreshNdi(); }, 2000);
      initMidi();
      buildShowSections();
      syncLookUi(); setTab('bible'); setMode('show');
      await refreshTranslations();
      await refreshOutputs();
      // No translation on this machine yet — say so where they'll see it.
      if (!pv.installed || !pv.installed.length) {
        $('#pvBibleResults').innerHTML =
          '<p class="muted small pv-empty">No Bible downloaded yet.<br><b>Click ⚙ above</b> to pick a translation — it downloads once and then works offline.</p>';
      }
    },
    onShow() { flushGrid(); renderSlides(); renderMonitors(); refreshOutputs(); },

    /* test hooks — no projector or network required */
    __test: {
      state() {
        return {
          docId: pv.docId, slideIx: pv.slideIx, liveIx: pv.liveIx, mode: pv.mode, tab: pv.tab,
          outMode: pv.outMode, translation: pv.translation, lookId: pv.lookId,
          docs: pv.presentations.length, slides: slides().length,
        };
      },
      docs() { return pv.presentations.map((p) => ({ id: p.id, name: p.name, kind: p.kind, slides: (p.slides || []).length })); },
      /* ---- 🎤 Listen: the Hearing panel, driven the way an operator drives it.
       * `refreshMics` is what draws it (opening the list is what an operator
       * does), and `noteListenModel` is the label that has twice in this
       * feature's history named one engine while another was running. */
      refreshMics() { return refreshMicList({ unlock: false }); },
      noteListenModel() { return noteListenModel(); },
      listenCadence() { return pv.listen.cadence; },
      slides() { return slides().map((s) => ({ id: s.id, group: s.group, lines: s.lines, footer: s.footer, bg: s.bg })); },
      newDoc(n, k) { return newDoc(n, k).id; },
      /* ---- pasting songs in ---- */
      parseSongs(text, opts) { return parseSongs(text, opts); },
      /** Drive the REAL paste box the way an operator does: click, paste, add. */
      async pasteSongsViaButton(text, { maxLines, toPlaylist } = {}) {
        document.getElementById('pvPasteSongs').click();
        await new Promise((r) => setTimeout(r, 60));
        const box = document.querySelector('.pv-paste');
        if (!box) return { opened: false };
        const ta = box.querySelector('.pv-paste-text');
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        if (maxLines) {
          const m = box.querySelector('.pv-paste-max');
          m.value = String(maxLines);
          m.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const pl = box.querySelector('.pv-paste-pl');
        if (pl) pl.checked = !!toPlaylist;
        const ok = box.querySelector('.pv-ask-ok');
        const preview = box.querySelector('.pv-paste-preview').textContent.replace(/\s+/g, ' ').trim();
        const okLabel = ok.textContent;
        const disabled = ok.disabled;
        ok.click();
        await new Promise((r) => setTimeout(r, 120));
        return {
          opened: true, preview, okLabel, disabled,
          stillOpen: !!document.querySelector('.pv-paste'),
          docs: pv.presentations.map((p) => ({ name: p.name, slides: (p.slides || []).length })),
        };
      },
      openDoc(id) { openDoc(id); return pv.docId; },
      // the real deleteDoc, minus its confirm() — a modal prompt is UI, and it
      // blocks the renderer thread forever in a headless run
      delDoc(id) {
        const c = window.confirm; window.confirm = () => true;
        try { deleteDoc(id); } finally { window.confirm = c; }
        return pv.presentations.length;
      },
      addSlide() { const d = doc(); const at = d.slides.length; d.slides.push(mkSlide('Blank', ['test'])); touch(); renderSlides(); return at; },
      clearSlides() { const d = doc(); if (d) { d.slides = []; touch(); renderSlides(); renderMonitors(); } return slides().length; },
      setSlideText(i, text) { const s = slides()[i]; if (!s) return null; s.lines = String(text).split('\n'); touch(); renderSlides(); return s.lines; },
      selectSlide(i) { pv.slideIx = i; renderSlides(); renderMonitors(); return pv.slideIx; },
      clickSlide(i) { const el = document.querySelector(`#pvSlides .pv-slide[data-slide="${i}"]`); if (el) el.click(); return { slideIx: pv.slideIx, liveIx: pv.liveIx }; },
      go(i) { live(i); return pv.liveIx; },
      /* --- the REAL Go Live button, clicked the way an operator clicks it --- */
      async clickGoLive() {
        const b = document.getElementById('pvGo');
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await pv._goLive;                  // the click's own promise
        return { liveIx: pv.liveIx, slideIx: pv.slideIx, outMode: pv.outMode, hasOutput: hasAudienceOutput() };
      },
      /* --- set lists: names now, words later --- */
      parseSongList(text) { return parseSongList(text); },
      parseImport(text, opts) { return parseImport(text, opts || {}); },
      /** The REAL 📥 Import button, driven the way an operator drives it. */
      async importSongsViaButton(text, playlistName) {
        document.getElementById('pvImportSongs').click();
        const box = document.querySelector('.pv-ask-back .pv-paste-text');
        if (!box) return { __error: 'the Import dialog did not open' };
        if (playlistName != null) document.querySelector('.pv-ask-back .pv-imp-pl').value = playlistName;
        box.value = text;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        const ok = document.querySelector('.pv-ask-back .pv-ask-ok');
        const preview = document.querySelector('.pv-ask-back .pv-paste-preview').textContent;
        if (ok.disabled) { document.querySelector('.pv-ask-back .pv-ask-cancel').click(); return { __error: 'nothing parsed: ' + preview }; }
        ok.click();
        await new Promise((r) => setTimeout(r, 60));
        const pl = pv.playlists.find((p) => p.id === pv.playlistId);
        return {
          preview,
          playlist: pl ? pl.name : null,
          items: pl ? (pl.items || []).map((it) => ({ name: it.name, group: it.group || '' })) : [],
          docs: pv.presentations.map((d) => ({ name: d.name, slides: (d.slides || []).length,
            words: (d.slides || []).some((s) => (s.lines || []).some((l) => String(l).trim())) })),
        };
      },
      /** Set headings drawn in the running order. */
      playlistSetBars() { return $$('#pvPlItems .pv-plset').map((b) => b.textContent); },
      playlistTodoCount() { return $$('#pvPlItems .pv-item.nolyrics').length; },
      /** The "no words yet" box, and filling it the way an operator would. */
      noLyricsBox() { const b = document.getElementById('pvFillLyrics'); return b ? { placeholder: !!b.placeholder } : null; },
      fillLyricsViaBox(text, maxLines) {
        const ta = document.getElementById('pvFillLyrics');
        if (!ta) return { __error: 'no "words yet" box is showing' };
        if (maxLines) document.getElementById('pvFillMax').value = String(maxLines);
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('pvFillGo').click();
        const d = doc();
        return { slides: (d.slides || []).length, name: d.name,
          groups: (d.slides || []).map((s) => s.group),
          lines: (d.slides || []).map((s) => (s.lines || []).join(' / ')) };
      },
      exportSongsText(opts) { return exportSongsText(opts || {}); },
      hasAudienceOutput() { return hasAudienceOutput(); },
      goLiveButton() { const b = document.getElementById('pvGo'); return b ? { text: b.textContent.trim(), title: b.title } : null; },
      /* --- more than one congregation screen --- */
      openScreenMenu() { toggleScreenMenu(true); return $$('#pvScreenMenu [data-screen]').length; },
      screenMenuOpen() { const m = document.getElementById('pvScreenMenu'); return !!m && !m.classList.contains('hidden'); },
      screenRows() {
        return $$('#pvScreenMenu [data-screen]').map((c) => ({ displayId: c.dataset.screen, checked: c.checked }));
      },
      /** Tick/untick a screen exactly as a click on its row does. */
      async tickScreen(displayId, on) {
        const c = document.querySelector(`#pvScreenMenu [data-screen="${displayId}"]`);
        if (!c) return null;
        c.checked = on !== false;
        c.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 40 && audienceScreenCount() === 0 && on !== false; i++) await new Promise((r) => setTimeout(r, 100));
        await refreshOutputs();
        return { screens: audienceScreenCount(), outputs: (pv.outputList || []).map((o) => ({ id: o.id, displayId: o.displayId, role: o.role })) };
      },
      audienceScreenCount() { return audienceScreenCount(); },
      screensBadge() { const b = document.getElementById('pvScreensCount'); return b ? b.textContent : null; },
      /* --- the Songs Bank --- */
      async openBank() { setTab('songs'); await refreshBank(); return pv.bank.songs.length; },
      bankRows() {
        return $$('#pvBankList [data-bank]').map((r) => ({
          id: r.dataset.bank,
          title: r.querySelector('b').textContent,
          meta: r.querySelector('.muted').textContent,
          ready: !!r.querySelector('.pv-bank-tag.ok'),
          inService: r.classList.contains('on'),
        }));
      },
      bankChips() { return $$('#pvBankChips [data-bankchip]').map((b) => ({ id: b.dataset.bankchip, on: b.classList.contains('on'), label: b.textContent })); },
      bankPickChip(id) { const b = document.querySelector(`#pvBankChips [data-bankchip="${cssEsc(id)}"]`); if (b) b.click(); return $$('#pvBankList [data-bank]').length; },
      bankSearch(q) { const el = $('#pvBankFilter'); el.value = q; el.dispatchEvent(new Event('input')); return $$('#pvBankList [data-bank]').length; },
      bankHint() { const h = $('#pvBankHint'); return h ? h.textContent.trim() : ''; },
      /** Press the ＋ on a bank row exactly as an operator does. */
      async bankAddToService(id) {
        const b = document.querySelector(`#pvBankList [data-bankadd="${cssEsc(id)}"]`);
        if (!b) return null;
        b.click();
        await new Promise((r) => setTimeout(r, 250));
        const pl = pv.playlists.find((p) => p.id === pv.playlistId);
        return { service: ((pl && pl.items) || []).map((it) => it.name),
          library: pv.presentations.map((d) => d.name),
          openDoc: (doc() || {}).name, slides: ((doc() || {}).slides || []).length,
          groups: ((doc() || {}).slides || []).map((s) => s.group) };
      },
      /** Type words into the open song and put them in the bank. */
      async bankOpenSong(words) {
        const d = doc(); if (!d) return null;
        if (words) {
          const parsed = parseSongs(words, { maxLines: 4, titleFromFirstLine: false })[0];
          if (parsed) { d.slides = parsed.slides.map((x) => mkSlide(x.group, x.lines)); touch(); renderSlides(); }
        }
        await bankTheOpenSong();
        return { bankId: d.bankId || null, songs: pv.bank.songs.length,
          ready: pv.bank.songs.filter((s) => s.ready).map((s) => s.title) };
      },
      async bankMerge() { const r = await bankMergeLibrary(); await refreshBank(); return r; },
      bankWordsOf(id) { const s = pv.bank.songs.find((x) => x.id === id); return s ? s.words : null; },
      songWordsOfOpen() { return songWords(doc()); },
      docIdByName(name) { const d = pv.presentations.find((p) => sameSong(p.name, name)); return d ? d.id : null; },
      /* --- a projector the OS is mirroring instead of extending --- */
      screenAdvice() { return screenAdvice(); },
      screensButtonWarns() { const b = document.getElementById('pvScreens'); return !!b && b.classList.contains('warn'); },
      /** The amber banner exactly as the operator reads it, or null. */
      screenWarning() {
        const w = document.querySelector('#pvScreenMenu .pv-screen-warn');
        if (!w) return null;
        const fix = w.querySelector('.pv-screen-fix');
        return { headline: w.querySelector('b').textContent, detail: w.querySelector('span').textContent, fix: fix ? fix.textContent : null };
      },
      /** Press the fix and wait for it to finish, exactly as a click does. */
      async pressExtend() {
        const b = document.querySelector('#pvScreenMenu .pv-screen-fix');
        if (!b) return null;
        await extendScreens(b);
        return { screens: audienceScreenCount(), displays: (pv.outputs.displays || []).length,
          outputs: (pv.outputList || []).map((o) => ({ id: o.id, displayId: o.displayId })) };
      },
      screenRowNotes() {
        return $$('#pvScreenMenu .pv-screen-row').map((r) => r.querySelector('.muted').textContent);
      },
      screenLabels() { return (pv.outputs.displays || []).map((d) => d.label); },
      step(d) { step(d); return pv.liveIx; },
      setOutMode(m) { live(null, m); return pv.outMode; },
      setMode(m) { setMode(m); return pv.mode; },
      setTab(t) { setTab(t); return pv.tab; },
      reflow() { reflow(); return slides().length; },
      groups() { return GROUPS.map((g) => g.name); },
      setGroup(i, name) { const s = slides()[i]; if (s) { s.group = name; touch(); renderSlides(); } return s && s.group; },
      slideDom() { return $$('#pvSlides .pv-slide').length; },
      slideTagColor(i) {
        const el = document.querySelector(`#pvSlides .pv-slide[data-slide="${i}"] .pv-slide-tag`);
        return el ? el.style.background : null;
      },
      thumbHtml(i) {
        const el = document.querySelector(`#pvSlides .pv-slide[data-slide="${i}"] .sr-stage`);
        return el ? el.innerHTML : null;
      },
      liveScreenText() {
        const el = document.querySelector('#pvLiveScreen .sr-text');
        return el ? el.textContent : '';
      },
      nextScreenText() {
        const el = document.querySelector('#pvNextScreen .sr-text');
        return el ? el.textContent : '';
      },
      /*
       * ONE setTranslation, not two.
       *
       * There were two of these in this object literal — this one, and a later
       * one that drove the <select> directly. A duplicate key in an object
       * literal is not an error: the LAST one silently wins, so every caller
       * got the other one and this never ran. The other never called
       * refreshTranslations(), and that one omission produced three separate
       * faults, all of which looked like something else:
       *
       *   - the picker never learned about a translation installed after the
       *     studio opened, so a freshly downloaded NIV was missing from the
       *     dropdown while lookups through it worked perfectly;
       *   - setting an abbr that is not yet an <option> put the select to ""
       *     (a select silently refuses a value it has no option for), and the
       *     change handler then wrote that "" into pv.translation;
       *   - which made the next findScripture() take its `if (!pv.translation)`
       *     branch and OPEN THE BIBLE MANAGER — a modal left sitting over the
       *     studio, swallowing the next Escape.
       *
       * Merged: refresh the list first so the option exists, then let the
       * select and the listener agree with it, and tell the voice side what to
       * count verses in.
       */
      async setTranslation(a) {
        pv.translation = a;
        await refreshTranslations();          // rebuilds the options AND sets sel.value
        try { await window.api.voice.translation(pv.translation); } catch (e) {}
        return pv.translation;
      },
      /** What the book/chapter/verse dropdowns are offering right now. */
      biblePicker() { return pickerSnapshot(); },
      /** Drive the dropdowns the way a mouse does — real change events. */
      async pickBible(bookNr, ch, from, to) {
        const step = async (sel, v) => {
          if (v == null) return;
          const el = $(sel);
          el.value = String(v);
          el.dispatchEvent(new Event('change', { bubbles: true }));
          await Promise.resolve(pv.pickerOp).catch(() => {});
        };
        await step('#pvBook', bookNr);
        await step('#pvChapter', ch);
        await step('#pvVerse', from);
        await step('#pvVerseTo', to);
        return Object.assign(pickerSnapshot(), {
          found: pv.bibleResult ? pv.bibleResult.reference : null,
          verseCount: pv.bibleResult ? pv.bibleResult.verses.length : 0,
          box: $('#pvRef').value,
        });
      },
      /** What the picker actually reads — an id like `bolls:NIV` must never show. */
      translationOptions() { return Array.from($('#pvTranslation').options).map((o) => ({ value: o.value, label: o.textContent })); },
      async find(q) { $('#pvRef').value = q; await findScripture(); return pv.bibleResult; },
      /** Click a verse in the panel, the way an operator does. */
      clickVerse(n) {
        const el = $(`#pvBibleResults .pv-verse[data-verse="${n}"]`);
        if (!el) return null;
        el.click();
        return this.verseCue();
      },
      verseCue() {
        const c = pv.verseCue;
        return c ? {
          reference: c.reference, ix: c.ix, chunks: c.slides.length,
          lines: c.slides[c.ix].lines, footer: c.slides[c.ix].footer,
          liveRows: $$('#pvBibleResults .pv-verse.live').map((e) => parseInt(e.dataset.verse, 10)),
        } : null;
      },
      sendVerseLive(n) { return sendVerseLive(n) ? this.verseCue() : null; },
      /* --- 🎤 Listen ---------------------------------------------------
       * Everything the microphone would do, minus the microphone: a test can
       * push the exact text whisper produced and watch the screen move. */
      listen: {
        /** Act on one line as if it had just been heard and understood. */
        async heard(text, intent) {
          // No intent handed in? Then run the REAL parser over the text, so a
          // test proves what the studio would actually do with those words.
          let use = intent;
          if (use === undefined) {
            const r = await window.api.voice.parse(text, liveVerseContext());
            use = r ? r.intent : null;
          }
          return presentTestApplyHeard({ text, intent: use, ok: true });
        },
        /**
         * The WHOLE chain bar the microphone: real samples in, through the real
         * speech engine and the real parser, out onto the real screen. base64
         * because that is what survives a trip through executeJavaScript.
         */
        async hearPcm(b64) {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const pcm = new Int16Array(bytes.buffer);
          const before = pv.listen.acted;
          await onVoicePhrase(pcm);
          const lines = $$('#pvListenLog .pv-listen-line');
          return { acted: pv.listen.acted > before, log: lines.length ? lines[0].textContent : null };
        },
        /**
         * A transcript in, through the real main-process parser and quotation
         * matcher and then through the real studio — everything the microphone
         * path does except the microphone.
         */
        async hearText(text, opts) {
          const r = await window.api.voice.hearText(text, liveVerseContext(), pv.listen.quote);
          if (!r || !r.ok) return { did: null, error: 'no answer' };
          return actOnHeard(r, opts);
        },
        /** The same line, arriving as a rolling look-back rather than a finished
         *  phrase — which is how most of a sermon reaches the studio now. */
        async heardLookBack(text) { return this.hearText(text, { partial: true }); },
        /** One close-follow look-back, as onCloseLook handles it: onto the tape
         *  and into the reading follower, nothing else (it is not a search). */
        closeLookText(text) {
          const t = String(text || '').trim();
          if (!t) return null;
          pv.listen.closeLooks++;
          tapeAdd(t);
          return followReading(t);
        },
        /** Let the next look-back through: tests that mean to fire twice on
         *  purpose should not have to sleep out the repeat guard. */
        forgetLast() { pv.listen.lastSig = ''; pv.listen.lastAt = 0; },
        context() { return liveVerseContext(); },
        log() { return $$('#pvListenLog .pv-listen-line').map((e) => e.textContent); },
        state() { return $('#pvListenState').textContent; },
        on() { return !!pv.listen.ear; },
        /** The microphone list exactly as the operator sees it. */
        async mics(unlock) {
          await refreshMicList({ unlock: !!unlock });
          const sel = $('#pvListenMic');
          return {
            options: Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent })),
            chosen: sel.value, disabled: sel.disabled, saved: pv.listen.micId,
          };
        },
        async pickMic(id) { await setListenMic(id); return { chosen: $('#pvListenMic').value, saved: pv.listen.micId }; },
        fast() { return { on: !!pv.listen.fast, checked: $('#pvListenFast').checked, note: $('#pvListenFastNote').textContent }; },
        /* ---- following the reading (test/read-along.test.js proves the
         * decision; these drive it through the real studio) ---- */
        follow() {
          const t = pv.listen.tape || { words: [], used: 0 };
          return { on: !!pv.listen.follow, checked: $('#pvListenFollow').checked,
            readKey: pv.listen.readKey || '', note: ($('#pvListenFollowNote') || {}).textContent || '',
            // The stitched transcript the decision is actually made on, and how
            // much of it has already turned a page.
            tape: (t.words || []).join(' '), used: t.used || 0,
            unspent: (t.words || []).slice(t.used || 0).join(' '),
            close: !!pv.listen.close, closeWant: !!pv.listen.closeWant,
            closeLooks: pv.listen.closeLooks || 0,
            pacedSkips: pv.listen.pacedSkips || 0,
            last: pv.listen.lastRead ? {
              done: !!pv.listen.lastRead.done, reading: !!pv.listen.lastRead.reading,
              run: pv.listen.lastRead.run, share: pv.listen.lastRead.share,
              tailGap: pv.listen.lastRead.tailGap, why: pv.listen.lastRead.why,
            } : null };
        },
        /** Forget every word heard so far, as a new passage does. */
        resetReading() { tapeReset(); return this.follow(); },
        setFollow(on) {
          const el = $('#pvListenFollow'); el.checked = !!on;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return this.follow();
        },
        /** The verse the page-turn is currently listening for the end of. */
        followTarget() {
          const v = chunkLastVerse();
          return v ? { verse: v.verse, text: v.text } : null;
        },
        quote() { return { on: !!pv.listen.quote, ready: !!pv.listen.quoteReady, note: ($('#pvListenQuoteNote') || {}).textContent || '' }; },
        async setQuote(on) {
          const el = $('#pvListenQuote'); el.checked = !!on;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          await (pv.listen.quoteOp || Promise.resolve());
          return this.quote();
        },
        /** Ask what a line of speech was quoting, with no microphone in the way. */
        async find(text) { return window.api.voice.quoteFind(text); },
        async setFast(on) {
          const el = $('#pvListenFast'); el.checked = !!on;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 50));
          return this.fast();
        },
        acted() { return pv.listen.acted; },
        /** Is sound actually arriving, and from where? */
        audioIn() {
          const rx = pv.listen.ndiRx;
          return {
            ndi: !!rx, ndiPackets: rx ? rx.state.packets : 0, ndiRate: rx ? rx.state.rate : 0,
            peak: pv.listen.peak || 0, blocks: pv.listen.blocks || 0,
          };
        },
        async ndiFeeds() { await refreshNdiFeeds(); return { ok: pv.listen.ndiOk, why: pv.listen.ndiWhy, names: (pv.listen.ndi || []).map((f) => window.NdiListen.nameOf(f)) }; },
      },
      /** Where the verse sits, driven through the real buttons. */
      verseFormat(what) {
        if (what) {
          const sel = what === 'reset' ? '#pvVfReset'
            : what === 'bigger' ? '#pvVfBigger' : what === 'smaller' ? '#pvVfSmaller'
              : /^(top|center|bottom)$/.test(what) ? `[data-vfvalign="${what}"]` : `[data-vfalign="${what}"]`;
          const b = $(sel); if (b) b.click();
        }
        const live = liveState().layers.slide;
        const s = pv.verseCue ? verseSlide(pv.verseCue.ix) : null;
        return {
          theme: pv.verseTheme ? Object.assign({}, pv.verseTheme) : null,
          onSlide: s ? s.look : null,
          sentTheme: live ? live.theme : null,
          lit: {
            valign: ($$('[data-vfvalign].on')[0] || {}).dataset && $$('[data-vfvalign].on')[0].dataset.vfvalign,
            align: ($$('[data-vfalign].on')[0] || {}).dataset && $$('[data-vfalign].on')[0].dataset.vfalign,
            reset: $('#pvVfReset').classList.contains('on'),
          },
        };
      },
      /** The Look's margin slider (the padding that had no control). */
      lookPad(px) {
        if (px != null) {
          $('#lkPad').value = String(px);
          $('#lkPad').dispatchEvent(new Event('input', { bubbles: true }));
        }
        const l = look();
        return { padX: l.padX, padY: l.padY, shown: $('#lkPadV').textContent };
      },
      /** What the clear bar is showing, including Easy View's home. */
      clearBar() {
        return {
          buttons: $$('#pvClearPalette [data-clear]').map((b) => b.dataset.clear),
          easyInPalette: !!$('#pvClearPalette #pvEasy'),
          easyVisible: !!$('#pvEasy') && !$('#pvEasy').classList.contains('hidden'),
          moreOpen: !!$('#pvClearPalette .pv-clear-more.on'),
        };
      },
      /** The right-hand tab strip, as a person reads it. */
      tabLabels() { return $$('[data-pvtab]').map((b) => b.textContent.replace(/\s+/g, ' ').trim()); },
      modeLabels() { return $$('[data-pvmode]').map((b) => b.textContent.replace(/\s+/g, ' ').trim()); },

      /* ---- the six things this round changed ---- */
      /** The chip strip that used to sit under the slides. */
      groupChipBar() {
        const el = document.getElementById('pvGroups');
        return { present: !!el, chips: $$('.pv-group-chip').length };
      },
      /** Rename a section by driving the real double-click + input. */
      renameSection(secIx, name) {
        const bar = document.querySelector(`#pvSlides [data-gsec="${secIx}"]`);
        if (!bar) return null;
        bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = bar.querySelector('input.pv-rename');
        if (!input) return null;
        input.value = name;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return slides().map((s) => s.group);
      },
      sectionBars() {
        return $$('#pvSlides [data-gsec]').map((b) => ({
          name: b.querySelector('.pv-group-bar-name').textContent,
          color: b.style.getPropertyValue('--gc'),
          n: +b.querySelector('.pv-group-bar-n').textContent,
        }));
      },
      groupColor(name) { return groupColor(name); },
      /** Is ask() reachable, and does it hand back what was typed? */
      async askProbe(type) {
        const p = ask('Test:', 'seed');
        await new Promise((r) => setTimeout(r, 20));
        const box = document.querySelector('.pv-ask-back');
        if (!box) return { opened: false };
        const input = box.querySelector('.pv-ask-input');
        const seeded = input.value;
        if (type != null) input.value = type;
        box.querySelector('.pv-ask-ok').click();
        const v = await p;
        return { opened: true, seeded, value: v, closed: !document.querySelector('.pv-ask-back') };
      },
      async askCancelProbe() {
        const p = ask('Test:', 'seed');
        await new Promise((r) => setTimeout(r, 20));
        const box = document.querySelector('.pv-ask-back');
        if (!box) return { opened: false };
        box.querySelector('.pv-ask-cancel').click();
        return { opened: true, value: await p, closed: !document.querySelector('.pv-ask-back') };
      },
      playlists() { return pv.playlists.map((p) => ({ id: p.id, name: p.name, items: (p.items || []).map((i) => i.name || null) })); },
      selectPlaylist(i) { const b = $$('#pvPlaylists [data-pl]')[i]; if (b) b.click(); return pv.playlistId; },
      isBlack() { return !!pv.blackout; },
      /** Type real keys into a rename box; 'b' and '1' are projector commands. */
      typeIntoRename(secIx, keys) {
        const bar = document.querySelector(`#pvSlides [data-gsec="${secIx}"]`);
        if (!bar) return null;
        bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = bar.querySelector('input.pv-rename');
        if (!input) return null;
        input.value = '';                       // the box opens seeded with the old name
        for (const k of keys) {
          input.value += k;
          input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        }
        const typed = input.value;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return {
          typed, blackout: !!pv.blackout,
          cleared: Object.values(pv.cleared).filter(Boolean).length,
          stillOpen: !!document.querySelector('input.pv-rename'),
          focus: document.activeElement ? document.activeElement.className : null,
        };
      },
      docName() { const d = doc(); return d ? d.name : null; },
      playlistDom() {
        return {
          rows: $$('#pvPlaylists [data-pl]').map((b) => b.querySelector('.pv-item-name').textContent),
          items: $$('#pvPlItems [data-plitem]').map((b) => b.querySelector('.pv-item-name').textContent),
          header: $('#pvPlName').textContent,
        };
      },
      async newPlaylist(name) {
        const p = new Promise((r) => setTimeout(r, 30));
        $('#pvPlNew').click();
        await p;
        const box = document.querySelector('.pv-ask-back');
        if (!box) return { opened: false };
        box.querySelector('.pv-ask-input').value = name;
        box.querySelector('.pv-ask-ok').click();
        await new Promise((r) => setTimeout(r, 30));
        return { opened: true, playlists: pv.playlists.map((x) => x.name), current: pv.playlistId };
      },
      addOpenDocToPlaylist() { $('#pvPlAdd').click(); return (pv.playlists.find((p) => p.id === pv.playlistId) || {}).items.length; },
      /**
       * A whole event's lyrics through the REAL ＋ Paste songs button: the
       * dialog is opened, the words are typed into its box, the preview is read
       * back, and "Add songs" is clicked — exactly what a media desk does on the
       * Saturday before.
       */
      async pasteSongsViaDialog(text, opts = {}) {
        document.getElementById('pvPasteSongs').click();
        await new Promise((r) => setTimeout(r, 40));
        const box = document.querySelector('.pv-paste');
        if (!box) return { __error: 'the Paste songs dialog did not open' };
        if (opts.maxLines) {
          const m = box.querySelector('.pv-paste-max');
          m.value = String(opts.maxLines);
          m.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const ta = box.querySelector('.pv-paste-text');
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const preview = (box.querySelector('.pv-paste-preview').textContent || '').replace(/\s+/g, ' ').trim();
        const okBtn = box.querySelector('.pv-ask-ok');
        const disabled = okBtn.disabled;
        const before = pv.presentations.length;
        okBtn.click();
        await new Promise((r) => setTimeout(r, 120));
        const made = pv.presentations.slice(0, pv.presentations.length - before);
        return {
          preview, disabled, closed: !document.querySelector('.pv-paste'),
          docs: made.map((d) => ({ id: d.id, name: d.name, slides: (d.slides || []).length })),
        };
      },
      /** Throw away what is in memory and read the library back off the store. */
      async reloadLibrary() { await loadLibrary(); renderLibrary(); renderPlaylists(); renderPlaylistItems(); return pv.presentations.length; },
      renamePlaylistItem(i, name) {
        const b = document.querySelector(`#pvPlItems [data-plitem="${i}"]`);
        if (!b) return null;
        b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = b.querySelector('input.pv-rename');
        if (!input) return null;
        input.value = name;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      },
      renamePlaylist(i, name) {
        const b = $$('#pvPlaylists [data-pl]')[i];
        if (!b) return null;
        b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = b.querySelector('input.pv-rename');
        if (!input) return null;
        input.value = name;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      },
      /** Where the chord/arrangement buttons live now. */
      musicPanel() {
        const d = $('#pvMusicDetails');
        return {
          exists: !!d,
          hidden: !!d && d.classList.contains('hidden'),
          inDocHead: !!document.querySelector('.pv-doc-head #pvChordUp'),
          buttons: $$('#pvMusicDetails .pv-music-menu button').map((b) => b.textContent.trim()),
          key: ($('#pvSongKey') || {}).textContent,
        };
      },
      /** Open a rename box and walk away from it, leaving it on screen. */
      openRenameAndLeave(secIx) {
        const bar = document.querySelector(`#pvSlides [data-gsec="${secIx}"]`);
        if (!bar) return null;
        bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return !!bar.querySelector('input.pv-rename');
      },
      /** Drive a real double-click edit and report the mode at each step. */
      editRoundTrip(i) {
        const before = pv.mode;
        editSlide(i);
        const during = pv.mode;
        const ta = document.querySelector('#pvSlides .pv-slide-edit');
        if (!ta) {
          return {
            before, during, after: pv.mode, edited: false,
            why: 'no textarea', slides: slides().length,
            hasSlide0: !!document.querySelector('#pvSlides .pv-slide[data-slide="0"]'),
            strayRename: !!document.querySelector('input.pv-rename'),
          };
        }
        ta.value = 'typed by the test';
        ta.blur();
        return { before, during, after: pv.mode, edited: (slides()[i].lines || []).join('') === 'typed by the test' };
      },
      bibleResult() { return pv.bibleResult; },
      clearBibleResult() { pv.bibleResult = null; $('#pvBibleResults').innerHTML = ''; return true; },
      scriptureSlides() { return pv.bibleResult ? scriptureSlides(pv.bibleResult) : null; },
      addScripture(sendLive) { addScripture(!!sendLive); return slides().length; },
      setVersesPerSlide(n) { $('#pvVps').value = String(n); return $('#pvVps').value; },
      look() { return JSON.parse(JSON.stringify(look())); },
      setLook(id) { pv.lookId = id; syncLookUi(); renderSlides(); return pv.lookId; },
      editLook(patch) { editLook((l) => Object.assign(l, patch)); return JSON.parse(JSON.stringify(look())); },
      looks() { return pv.looks.map((l) => ({ id: l.id, name: l.name })); },
      setBackground(i, bg) { const s = slides()[i]; if (s) { s.bg = bg; touch(); renderSlides(); } return s && s.bg; },

      /* ---- pictures: the REAL buttons, not the functions behind them ---- */
      async addMediaViaButton() {
        document.getElementById('pvMediaAdd').click();
        await new Promise((r) => setTimeout(r, 250));
        return { count: pv.media.length, names: pv.media.map((m) => m.name) };
      },
      async addImageSlideViaButton() {
        document.getElementById('pvAddImage').click();
        await new Promise((r) => setTimeout(r, 250));
        const s = slides()[pv.slideIx];
        return { slides: slides().length, slideIx: pv.slideIx, bg: s && s.bg, lines: s && s.lines };
      },
      mediaTile(i) {
        const b = document.querySelector(`#pvMediaGrid [data-media="${i}"] .pv-media-thumb`);
        if (!b) return null;
        const m = (b.style.backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);
        return { thumb: m ? m[1] : '', hasSlideBtn: !!document.querySelector(`#pvMediaGrid [data-mediaslide="${i}"]`) };
      },
      /** Click the tile the way an operator does, and report what happened. */
      clickMediaTile(i, shift) {
        let toast = null;
        const orig = window.__toast;
        window.__toast = (msg) => { toast = msg; };
        const before = slides().length;
        try {
          const b = document.querySelector(`#pvMediaGrid [data-media="${i}"]`);
          if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: !!shift }));
        } finally { window.__toast = orig; }
        const s = slides()[pv.slideIx];
        return { bg: s && s.bg, toast, made: slides().length > before, slideIx: pv.slideIx,
          lookBg: JSON.parse(JSON.stringify((look() || {}).bg || null)) };
      },
      clickMediaAsSlide(i) {
        const b = document.querySelector(`#pvMediaGrid [data-mediaslide="${i}"]`);
        if (b) b.click();
        const s = slides()[pv.slideIx];
        return { slides: slides().length, bg: s && s.bg };
      },
      /**
       * Does each slide's background picture actually LOAD?
       *
       * A CSS background that fails paints nothing and says nothing — the slide
       * is simply black, which is precisely the "it's blank, what is the story
       * of that" report. Reading the style back only proves we asked for the
       * right file; this waits to see whether the browser could open it.
       */
      async slideBgProbe() {
        const out = [];
        const list = slides();
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          const box = document.querySelector(`[data-thumb="${i}"] .sr-bg`);
          const css = box ? (box.style.backgroundImage || '') : '';
          const m = css.match(/url\(["']?(.*?)["']?\)/);
          const url = m ? m[1] : '';
          let loads = null;
          if (url) {
            loads = await new Promise((res) => {
              const im = new Image();
              im.onload = () => res(true);
              im.onerror = () => res(false);
              im.src = url;
              setTimeout(() => res(null), 4000);
            });
          }
          out.push({
            i, bg: s.bg ? s.bg.type : null, path: s.bg ? s.bg.value : null,
            url, loads, painted: !!box,
          });
        }
        return out;
      },
      /**
       * What the LIVE monitor really paints — measured, not asked for.
       *
       * Reading the inline style back only proves the right file was requested.
       * A layer with the correct `background-image` and NO HEIGHT paints
       * nothing, which is exactly how the monitor went black while every
       * thumbnail beside it showed the picture.
       */
      async liveScreenBgProbe() {
        const stage = document.querySelector('#pvLiveScreen .sr-stage');
        if (!stage) return { stage: false };
        const sr = stage.getBoundingClientRect();
        let node = null, url = '';
        for (const n of stage.querySelectorAll('*')) {
          const bi = (n.style && n.style.backgroundImage) || getComputedStyle(n).backgroundImage || '';
          // GREEDY to the last bracket: an SVG data URI contains `url(#id)` of
          // its own, and a lazy match hands back half a picture.
          const m = String(bi).match(/url\(\s*(['"]?)([\s\S]*)\1\s*\)/);
          if (m) { node = n; url = m[2]; break; }
        }
        if (!node) return { stage: true, url: '' };
        const r = node.getBoundingClientRect();
        let loads = null;
        if (url) {
          loads = await new Promise((res) => {
            const im = new Image();
            im.onload = () => res(true); im.onerror = () => res(false);
            im.src = url;
            setTimeout(() => res(null), 4000);
          });
        }
        return {
          stage: true, url, loads,
          w: Math.round(r.width), h: Math.round(r.height),
          stageW: Math.round(sr.width), stageH: Math.round(sr.height),
          // The background must fill the stage, not perch at zero height in a corner.
          covers: r.width >= sr.width - 1 && r.height >= sr.height - 1,
        };
      },
      /** What the projector is actually painting behind the words. */
      liveScreenBg() {
        const el = document.querySelector('#pvLiveScreen .sr-stage') || document.querySelector('#pvLiveScreen .sr-bg');
        if (!el) return null;
        const vid = document.querySelector('#pvLiveScreen .sr-bgvideo');
        if (vid) return vid.getAttribute('src');
        const layers = [el, ...el.querySelectorAll('*')];
        for (const n of layers) {
          const bi = (n.style && n.style.backgroundImage) || '';
          const m = bi.match(/url\(["']?(.*?)["']?\)/);
          if (m) return m[1];
        }
        return null;
      },

      /* ---- the show desk's shape ---- */
      showPaneShape() {
        const secs = $$('[data-pvpane="show"] .pv-show-sec');
        const visible = secs.filter((s) => !s.classList.contains('pv-sec-hidden'));
        const open = visible.filter((s) => !s.classList.contains('collapsed'));
        const name = (s) => (s.querySelector('.pv-sec-title-btn') || {}).textContent || s.dataset.sec;
        return {
          sections: secs.length, visible: visible.length, open: open.length,
          openNames: open.map(name), mode: pv.showMode,
          folds: secs.every((s) => !!s.querySelector('.pv-sec-body')),
        };
      },
      setAdvanced(on) {
        const before = $$('[data-pvpane="show"] .pv-show-sec').filter((s) => !s.classList.contains('pv-sec-hidden')).length;
        setShowMode(on ? 'all' : 'simple');
        const after = $$('[data-pvpane="show"] .pv-show-sec').filter((s) => !s.classList.contains('pv-sec-hidden')).length;
        return { simpleVisible: before, visible: after, mode: pv.showMode };
      },
      toggleSection(key, open) { return setShowSectionOpen(key, open); },
      outputs() { return pv.outputs; },
      async refreshOutputs() { await refreshOutputs(); return pv.outputs; },
      async openBibleManager() { await openBibleManager(); return $$('#bibList .lib-row').length; },
      catalogue() { return pv.catalogue.length; },
      closeBibleManager() { $('#bibModal').classList.add('hidden'); },
      key(k) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : k, bubbles: true }));
        return { liveIx: pv.liveIx, outMode: pv.outMode, mode: pv.mode, blackout: pv.blackout, cleared: Object.assign({}, pv.cleared), easyView: pv.easyView };
      },

      /* --- layers, clears, transitions --- */
      /** Put the live-show desk back to zero (props/timers/messages/clears). */
      resetShow() {
        pv.props = []; pv.timers = []; pv.announcement = null; pv.message = null; pv.stageMessage = '';
        pv.layers = { background: null, media: null, mask: null };
        for (const k of Object.keys(pv.cleared)) pv.cleared[k] = false;
        pv.blackout = false; pv.easyView = false; pv.outputLooks = {}; pv.outputMaps = {};
        pv.macros = []; pv.midiBinds = {}; pv.drawing = false;
        pv.stageLayoutId = 'stage-lyrics';
        stopAllAudio(0);
        pv.audio = { tracks: [], master: 1, playlistOn: true, shuffle: false, loopList: true };
        (pv._markerTimers || []).forEach(clearTimeout); pv._markerTimers = [];
        // Forget which clip was last live, or the next cue would be treated as
        // "the same clip still running" and its markers would never arm.
        pv._liveBgSig = null;
        try { localStorage.removeItem('mw-pv-show'); } catch (e) {}
        renderProps(); renderMessages(); renderTimers(); renderClearPalette(); renderStageLayouts();
        renderAudio(); renderMarkers(); pushLive();
        return true;
      },
      liveState() { return liveState(); },
      /** The words on the live layer right now — what the congregation sees. */
      liveText() {
        const sl = liveState().layers.slide;
        if (!sl) return null;
        return { lines: sl.lines || [], footer: sl.footer || '', type: sl.type || '' };
      },
      /* setTranslation lives once, further up — see the note there for what
       * having it twice cost. */
      layerNames() { return window.Layers.ORDER.slice(); },
      transitionNames() { return window.Layers.TRANSITION_LIST.map((t) => t.id); },
      clearLayer(id) { toggleClear(id); return Object.assign({}, pv.cleared); },
      cleared() { return Object.assign({}, pv.cleared); },
      clearPaletteDom() { return $$('#pvClearPalette [data-clear]').map((b) => ({ id: b.dataset.clear, on: b.classList.contains('on') })); },
      /** Open/close the ⋯ More group in the clear bar. */
      clearMore(open) {
        pv.clearMore = open == null ? !pv.clearMore : !!open;
        renderClearPalette();
        return { open: !!$('#pvClearPalette .pv-clear-more.on'), buttons: $$('#pvClearPalette [data-clear]').map((b) => b.dataset.clear) };
      },
      /* ---- motion backgrounds ---- */
      bgClips() { return ((window.BgVideos || {}).CLIPS || []).length; },
      bgVideoTiles() { return $$('#pvBgGrid [data-bgvid]').length; },
      bgFlatTiles() { return $$('#pvBgGrid [data-bgpreset]').length; },
      /** Every poster really has to be IN the build — a missing one is a black tile. */
      async bgPosterProbe() {
        const clips = ((window.BgVideos || {}).CLIPS || []);
        const out = [];
        for (const c of clips) {
          const ok = await new Promise((res) => {
            const im = new Image();
            im.onload = () => res(im.naturalWidth > 0); im.onerror = () => res(false);
            im.src = `assets/bgvideos/${c.id}.jpg`;
            setTimeout(() => res(null), 4000);
          });
          out.push({ id: c.id, name: c.name, cat: c.cat, bytes: c.bytes, w: c.w, h: c.h, url: c.url, poster: ok });
        }
        return out;
      },
      async escape() { return escape(); },
      async refreshBgVideos() { return refreshBgVideos(); },
      async useBgVideo(id) { return useBgVideo(id); },
      /* ---- background playback ---- */
      vidPlayback() {
        const bar = $('#pvVidBar');
        return {
          enabled: !bar.classList.contains('hidden'),
          label: $('#pvVidPlay').textContent.trim(),
          name: $('#pvVidName').textContent.trim(),
          paused: !!pv.bgPaused, loop: pv.bgLoop !== false,
          // it has to be ON SCREEN, not merely in the DOM
          visible: bar.getBoundingClientRect().height > 0 && bar.getBoundingClientRect().top < window.innerHeight,
        };
      },
      pauseBackground() {
        $('#pvVidPlay').click();
        const bg = liveState().layers.background;
        return { state: !!(bg && bg.paused), label: $('#pvVidPlay').textContent.trim() };
      },
      setBackgroundLoop(on) {
        if ((pv.bgLoop !== false) !== !!on) $('#pvVidLoop').click();
        const bg = liveState().layers.background;
        return { loop: !!(bg && bg.loop), lit: $('#pvVidLoop').classList.contains('on') };
      },
      /** A passage on the screen, without needing a Bible downloaded. */
      fakeVerseCue() {
        pv.verseCue = {
          slides: [mkSlide('Scripture', ['For God so loved the world']), mkSlide('Scripture', ['that he gave his only Son'])],
          ix: 0, reference: 'John 3:16-17', verses: [16, 17], per: 1,
        };
        live(null, 'slide');
        return { ix: pv.verseCue.ix, chunks: pv.verseCue.slides.length };
      },
      setTransition(layer, id) { pv.transitions[layer] = id; pushLive(); return pv.transitions[layer]; },
      transitions() { return Object.assign({}, pv.transitions); },
      blackout(on) { pv.blackout = on == null ? !pv.blackout : !!on; pushLive(); renderClearPalette(); return pv.blackout; },
      easyView(on) { pv.easyView = on == null ? !pv.easyView : !!on; pushLive(); return pv.easyView; },
      setBackgroundLayer(bg) { pv.layers.background = bg; pushLive(); return pv.layers.background; },
      setMediaLayer(m) { pv.layers.media = m; pushLive(); return pv.layers.media; },
      setMaskLayer(m) { pv.layers.mask = m; pushLive(); return pv.layers.mask; },

      /* --- props / messages / announcements --- */
      addProp(p) { pv.props.push(Object.assign({ id: uid(), type: 'text', value: 'Prop', x: 0.05, y: 0.8, w: 0.4 }, p)); saveShow(); renderProps(); pushLive(); return pv.props.length; },
      props() { return pv.props.map((p) => ({ id: p.id, type: p.type, value: p.value, hidden: !!p.hidden })); },
      toggleProp(i) { pv.props[i].hidden = !pv.props[i].hidden; renderProps(); pushLive(); return !pv.props[i].hidden; },
      setMessage(text, pos) { pv.message = text ? { text, position: pos || 'bottom', size: 52 } : null; pushLive(); renderMessages(); return pv.message; },
      messageTemplates() { return MSG_TEMPLATES.map((t) => ({ id: t.id, tokens: t.tokens })); },
      setAnnouncement(t) { setAnnouncement(t); return pv.announcement; },
      setStageMessage(t) { pv.stageMessage = t; pushLive(); return pv.stageMessage; },

      /* --- timers --- */
      addTimer(t) { pv.timers.push(Object.assign({ id: uid(), name: 'T', mode: 'countdown', running: true, endsAt: Date.now() + 60000, durationMs: 60000 }, t)); saveShow(); renderTimers(); pushLive(); return pv.timers.length; },
      timers() { return pv.timers.map((t) => ({ id: t.id, mode: t.mode, running: !!t.running })); },
      timerText(i, now) { return window.SlideRender.timerText(pv.timers[i], now); },
      toggleTimer(i) { toggleTimer(i); return !!pv.timers[i].running; },
      resetTimer(i) { resetTimer(i); return pv.timers[i].endsAt || pv.timers[i].startedAt; },

      /* --- outputs --- */
      outputList() { return (pv.outputList || []).map((o) => ({ id: o.id, role: o.role, name: o.name, render: o.render || 'normal' })); },
      setOutputLook(id, lookId) { if (lookId) pv.outputLooks[id] = lookId; else delete pv.outputLooks[id]; pushLive(); return pv.outputLooks; },
      outputLooks() { return Object.assign({}, pv.outputLooks); },
      async openOutput(role, displayId, windowed, id, name, render) {
        await window.api.present.open(role, displayId || pv.displayId, windowed, id, name, render);
        await refreshOutputs(); pushLive();
        return (pv.outputList || []).map((o) => ({ id: o.id, render: o.render }));
      },

      /* --- screen mapping & edge blending --- */
      setMap(id, patch) { Object.assign(mapFor(id), patch || {}); saveShow(); pushLive(); renderOutputList(); return pv.outputMaps[id]; },
      map(id) { return pv.outputMaps[id] || null; },
      openMapEditor(id) { openMapEditor(id); return !$('#pvMapEditor').classList.contains('hidden'); },
      mapEditorValues() {
        return { rotate: $('#pvMapRotate').value, scale: $('#pvMapScale').value, w: $('#pvMapW').value, blendL: $('#pvBlendL').value };
      },
      resetMap(id) { pv.outputMaps[id] = DEFAULT_MAP(); saveShow(); pushLive(); return pv.outputMaps[id]; },

      /* --- stage layouts --- */
      stageLayouts() { return (pv.stageLayouts && pv.stageLayouts.length ? pv.stageLayouts : DEFAULT_STAGE_LAYOUTS).map((l) => ({ id: l.id, name: l.name, blocks: (l.blocks || []).map((b) => b.type) })); },
      setStageLayout(id) { return setStageLayout(id); },
      stageLayout() { return stageLayout(); },
      stageBlockTypes() { return STAGE_BLOCKS.map((b) => b.type); },

      /* --- ready-made backgrounds --- */
      presets() { return window.Backgrounds.PRESETS.map((p) => ({ id: p.id, name: p.name, cat: p.cat, type: p.type, light: !!p.light })); },
      presetCats() { return window.Backgrounds.CATEGORIES.slice(); },
      bgTiles() { return $$('#pvBgGrid .pv-bg').length; },
      bgTilePainted(i) {
        const el = $$('#pvBgGrid .pv-bg-thumb')[i];
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { image: cs.backgroundImage, size: cs.backgroundSize, sample: (el.textContent || '').trim() };
      },
      setBgCat(c) { pv.bgCat = c; renderBgCats(); renderBuiltinBgs(); return $$('#pvBgGrid .pv-bg').length; },
      setBgApply(w) { return setBgApply(w); },
      usePreset(id) { return usePreset(id); },
      lookBg() { return JSON.parse(JSON.stringify(look().bg || null)); },

      /* --- web video, video controls, chroma key, markers --- */
      webVideo(url) { $('#pvLinkUrl').value = url; return addWebVideo(false); },
      embedUrl(m) { return window.SlideRender.embedUrl(m); },
      videoId(u, k) { return window.SlideRender.videoId(u, k); },
      setVideoOpts(o) {
        const set = (sel, v) => { const el = $(sel); if (el && v != null) el.value = String(v); };
        set('#pvVidBright', o.brightness); set('#pvVidContrast', o.contrast); set('#pvVidSat', o.saturation);
        set('#pvVidHue', o.hue); set('#pvVidSpeed', o.speed); set('#pvVidIn', o.inSec); set('#pvVidOut', o.outSec);
        if (o.pingpong != null) $('#pvVidPingPong').checked = !!o.pingpong;
        if (o.chroma != null) {
          $('#pvKeyOn').checked = !!o.chroma;
          if (o.chromaColor) $('#pvKeyColor').value = o.chromaColor;
        }
        return applyVideoOpts();
      },
      resetVideoOpts() { return resetVideoOpts(); },
      filterFor(m) { return window.SlideRender.adjustFilter(m); },
      addMarker(at, action, value, label) { return addMarker(at, action, value, label); },
      markers() { return markers().slice(); },
      markerRows() { return $$('#pvMarkList .lib-row').length; },
      armedMarkers() { return (pv._markerTimers || []).length; },

      /* --- audio --- */
      async addAudio(o) { return addAudioTrack(o); },
      audioTracks() { return pv.audio.tracks.map((t) => ({ id: t.id, name: t.name, playing: !!t.playing, volume: t.volume, loop: !!t.loop, inPlaylist: !!t.inPlaylist })); },
      playAudio(id, fade) { const t = playTrack(id, { fade: fade == null ? 0 : fade }); return t && { id: t.id, playing: t.playing, vol: t.el && t.el.volume }; },
      stopAudio(id, fade) { const t = stopTrack(id, { fade: fade == null ? 0 : fade }); return t && { id: t.id, playing: t.playing }; },
      stopAllAudio(fade) { stopAllAudio(fade == null ? 0 : fade); return pv.audio.tracks.filter((t) => t.playing).length; },
      setMaster(v) { return setMaster(v); },
      trackVolume(id) { const t = pv.audio.tracks.find((x) => x.id === id); return t ? { set: trackVol(t), el: t.el ? t.el.volume : null } : null; },
      audioTime(id) { const t = pv.audio.tracks.find((x) => x.id === id); return t && t.el ? t.el.currentTime : 0; },
      audioDebug(id) {
        const t = pv.audio.tracks.find((x) => x.id === id);
        if (!t || !t.el) return { el: false };
        return { el: true, src: t.el.src, paused: t.el.paused, readyState: t.el.readyState,
          error: t.el.error ? t.el.error.code : null, dur: t.el.duration, at: t.el.currentTime };
      },
      linkSlideAudio(i, value) { const s = slides()[i]; if (!s) return null; s.audio = value; touch(); renderAudioLinks(); return s.audio; },
      audioRows() { return $$('#pvAudioList .lib-row').length; },
      removeAudio(id) { return removeAudioTrack(id); },

      /* --- lighting --- */
      async dmxConfigure(a) { pv.dmx = await window.api.dmx.configure(a); renderDmx(); return pv.dmx; },
      async dmxSend(cmd) { return window.api.dmx.send({ command: cmd }); },
      sendDmx(cmd) { return sendDmx(cmd); },

      /* --- NDI output --- */
      async ndiState() { await refreshNdi(); return pv.ndi; },
      async ndiStart(a) { await window.api.ndiOut.start(a); await refreshNdi(); pushLive(); return pv.ndi; },
      async ndiStop(id) { await window.api.ndiOut.stop(id); await refreshNdi(); return pv.ndi; },
      ndiRows() { return $$('#pvNdiList .lib-row').length; },
      ndiRowText(i) { const r = $$('#pvNdiList .lib-row')[i]; return r ? r.textContent.replace(/\s+/g, ' ').trim() : null; },
      /** Drive the ＋ button exactly as an operator does, fields and all. */
      async addNdiViaButton({ name, size, fps, group, alpha } = {}) {
        if (name) $('#pvNdiName').value = name;
        if (size) $('#pvNdiSize').value = size;
        if (fps) $('#pvNdiFps').value = String(fps);
        if (group != null) $('#pvNdiGroup').value = group;
        $('#pvNdiAlpha').checked = !!alpha;
        $('#pvNdiAdd').click();
        await new Promise((r) => setTimeout(r, 1200));
        await refreshNdi();
        return { feeds: (pv.ndi.feeds || []).map((f) => ({ id: f.id, name: f.name, w: f.width, h: f.height, fps: f.fps, group: f.group, alpha: f.alpha })),
                 saved: JSON.parse(localStorage.getItem('mw-pv-ndi') || '[]') };
      },
      /* ---- the slide editor (the ✏️ on a slide) ---- */
      /** Click the ✏️ exactly where an operator clicks it. */
      openSlideEditorViaButton(i) {
        const b = document.querySelector(`#pvSlides [data-editslide="${i}"]`);
        if (!b) return { opened: false, why: 'no ✏️ button on that slide' };
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const box = document.querySelector('.pv-sled');
        return {
          opened: !!box,
          liveIxAfter: pv.liveIx,          // the ✏️ must not also cue the slide
          controls: ['.sled-font', '.sled-size', '.sled-color', '.sled-b', '.sled-i', '.sled-caps',
            '.sled-align', '.sled-valign', '.sled-lh', '.sled-padx', '.sled-shadow', '.sled-outline', '.sled-outcolor']
            .filter((s) => !!document.querySelector(s)),
          hasPreview: !!document.querySelector('.pv-sled-preview .sr-stage'),
          text: (document.querySelector('.pv-sled-text') || {}).value,
        };
      },
      /** Type words into the editor the way a person does. */
      typeSlideText(text) {
        const ta = document.querySelector('.pv-sled-text'); if (!ta) return null;
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return slides()[pv.editingSlide].lines;
      },
      /** Drive one styling control and report what the slide and its preview became. */
      setSlideStyle(sel, value) {
        const el = document.querySelector(sel); if (!el) return null;
        if (el.tagName === 'BUTTON') el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        else {
          el.value = String(value);
          el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        }
        const s = slides()[pv.editingSlide];
        const txt = document.querySelector('.pv-sled-preview .sr-text');
        return { theme: Object.assign({}, s.theme || {}), css: txt ? txt.getAttribute('style') : null };
      },
      slideTheme(i) { const s = slides()[i]; return s && s.theme ? Object.assign({}, s.theme) : null; },
      slideEditorOpen() { return !!document.querySelector('.pv-sled'); },
      clickSlideEditor(sel) { const b = document.querySelector(sel); if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!b; },
      /** What the GRID thumbnail is painted with — it must follow the edit too. */
      slideThumbCss(i) {
        const t = document.querySelector(`#pvSlides [data-thumb="${i}"] .sr-text`);
        return t ? t.getAttribute('style') : null;
      },

      /** Stop a feed the way the operator does — the ✕ on its row. */
      async ndiStopViaButton(id) {
        const b = document.querySelector(`#pvNdiList [data-ndistop="${id}"]`);
        if (!b) return null;
        b.click();
        await new Promise((r) => setTimeout(r, 600));
        return (pv.ndi.feeds || []).map((f) => f.id);
      },
      /** What would come back after a restart. */
      ndiSavedFeeds() { try { return JSON.parse(localStorage.getItem('mw-pv-ndi') || '[]'); } catch (e) { return null; } },
      async ndiRestore() { await restoreNdiFeeds(); return (pv.ndi.feeds || []).map((f) => f.id); },
      ndiStatusText() { const s = $('#pvNdiState'); return s ? s.textContent : null; },

      /* --- macros / MIDI / drawing / live input / web output --- */
      addMacro(name, steps) { pv.macros.push({ id: uid(), name, steps }); saveShow(); renderMacros(); return pv.macros.length; },
      macros() { return pv.macros.map((m) => ({ id: m.id, name: m.name, steps: (m.steps || []).length })); },
      runMacro(id) { return runMacro(id); },
      captureMacroState() { return { lookId: pv.lookId, cleared: Object.assign({}, pv.cleared) }; },
      macroActions() { return MACRO_ACTIONS.map((a) => a.id); },
      bindMidi(note, to) { pv.midiBinds[note] = to; saveShow(); renderMidiBinds(); return pv.midiBinds; },
      fireMidi(note) { onMidi([0x90, note, 100]); return { liveIx: pv.liveIx, blackout: pv.blackout }; },
      midiBinds() { return Object.assign({}, pv.midiBinds); },
      setLiveInput(b) { pv.layers.background = b; pushLive(); renderLiveInputs(); return pv.layers.background; },
      draw(on) { if (!!on !== pv.drawing) toggleDraw(); return pv.drawing; },
      drawStroke() {
        const cv = $('#pvDrawSurface'); if (!cv || !pv.drawing) return null;
        const c = cv.getContext('2d');
        c.strokeStyle = '#ff2d55'; c.lineWidth = 14; c.beginPath(); c.moveTo(200, 200); c.lineTo(900, 600); c.stroke();
        commitDrawing();
        return pv.layers.mask && pv.layers.mask.type;
      },
      clearDrawing() { clearDrawing(); return pv.layers.mask; },
      async webStart(port) {
        const el = $('#pvWebPort'); if (el) el.value = String(port || 7373);
        await toggleWebOut(); return pv.web;
      },
      async webStop() { if (pv.web && pv.web.running) await toggleWebOut(); return pv.web; },
      webState() { return pv.web; },
      remote(cmd, arg) {
        // exactly what a phone / Stream Deck hitting the REST API triggers
        if (cmd === 'next') step(1);
        else if (cmd === 'prev') step(-1);
        else if (cmd === 'black') { pv.blackout = !pv.blackout; pushLive(); renderClearPalette(); }
        else if (cmd === 'clear') toggleClear(arg || 'slide');
        else if (cmd === 'slide') live(parseInt(arg, 10) || 0);
        else if (cmd === 'macro') runMacro(arg);
        return { liveIx: pv.liveIx, blackout: pv.blackout, cleared: Object.assign({}, pv.cleared) };
      },

      /* --- arrangements + chords --- */
      importChordPro(text) { return importChordPro(text); },
      chordsOf(i) { const s = slides()[i]; return s ? s.chords : null; },
      transpose(n) { transposeSong(n); return slides().map((s) => s.chords); },
      addArrangement(name, order) {
        const d = doc(); d.arrangements = (d.arrangements || []).concat([{ name, order }]);
        pv.arrangement = name; touch(); renderArrangements(); return d.arrangements.length;
      },
      setArrangement(name) { pv.arrangement = name || null; renderArrangements(); return pv.arrangement; },
      activeOrder() { return activeOrder(); },
    },
  };

  /*
   * A held-back grid render must never be something a test can catch halfway.
   * Every hook flushes first, so what a test reads is what the studio would be
   * showing a moment later anyway — the coalescing is a timing optimisation,
   * not a change to what ends up on the screen.
   */
  for (const k of Object.keys(window.Presenter.__test)) {
    const fn = window.Presenter.__test[k];
    if (typeof fn !== 'function') continue;
    window.Presenter.__test[k] = function (...a) { flushGrid(); return fn.apply(this, a); };
  }
  window.Presenter.__test.flushGrid = flushGrid;
})();
