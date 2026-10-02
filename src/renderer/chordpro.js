'use strict';
/*
 * ChordPro — chords over lyrics, for the worship team.
 *
 * ChordPro is the format every worship musician's chord chart is already in:
 *
 *     {title: Way Maker}
 *     {c: Verse 1}
 *     You are [G]here, moving in our [D]midst
 *
 * The bracketed chord belongs at that exact point in the WORD, so it has to be
 * rendered as a floating strip above the line rather than as a separate text
 * row — a separate row drifts out of alignment the moment the line wraps, which
 * is precisely when a musician needs it to be right.
 *
 * The output keeps lyrics and chords apart:
 *   lines:  ['You are here, moving in our midst']       ← what the room sees
 *   chords: [[{at: 8, chord: 'G'}, {at: 26, chord: 'D'}]] ← what the band sees
 * so the audience screen can simply ignore `chords` while the stage display
 * draws them. One document, two audiences.
 */
(function () {
  /** Does this text look like ChordPro (or a plain chords-above-lyrics chart)? */
  function looksLikeChordPro(text) {
    const t = String(text || '');
    return /\[[A-G][#b]?[^\]]{0,10}\]/.test(t) || /^\s*\{\s*(title|t|c|comment|soc|sov)\s*:/im.test(t);
  }

  /**
   * Parse one line: strip the [chords] out, remembering the character offset
   * each was sitting at in the REMAINING lyric text.
   */
  function parseLine(raw) {
    const chords = [];
    let lyric = '';
    const s = String(raw == null ? '' : raw);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '[') {
        const end = s.indexOf(']', i);
        if (end > i) {
          const chord = s.slice(i + 1, end).trim();
          if (chord) chords.push({ at: lyric.length, chord });
          i = end;
          continue;
        }
      }
      lyric += s[i];
    }
    return { lyric, chords };
  }

  const DIRECTIVE = /^\s*\{\s*([a-z_]+)\s*:?\s*([^}]*)\}\s*$/i;
  /** Directives that name a new section, mapped to our group vocabulary. */
  const SECTION = {
    c: null, comment: null,            // value carries the section name
    soc: 'Chorus', eoc: null, sov: 'Verse 1', eov: null, sob: 'Bridge', eob: null,
    start_of_chorus: 'Chorus', start_of_verse: 'Verse 1', start_of_bridge: 'Bridge',
  };
  const GROUP_WORDS = /^(verse|chorus|bridge|tag|intro|outro|pre[- ]?chorus|refrain|ending|interlude|vamp)\b/i;

  /**
   * Parse a whole ChordPro document into presentation slides.
   * Returns { title, author, key, sections: [{ group, lines, chords }] }.
   */
  function parse(text, { linesPerSlide = 4 } = {}) {
    const out = { title: '', author: '', key: '', ccli: '', sections: [] };
    const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let group = 'Verse 1';
    let cur = null;
    const flush = () => {
      if (cur && cur.lines.some((l) => l.trim())) out.sections.push(cur);
      cur = null;
    };
    const start = (g) => { flush(); cur = { group: g, lines: [], chords: [] }; };

    for (const line of raw) {
      const d = line.match(DIRECTIVE);
      if (d) {
        const key = d[1].toLowerCase(), val = (d[2] || '').trim();
        if (key === 'title' || key === 't') out.title = val;
        else if (key === 'subtitle' || key === 'st' || key === 'artist' || key === 'composer') out.author = val;
        else if (key === 'key') out.key = val;
        else if (key === 'ccli') out.ccli = val;
        else if (key === 'c' || key === 'comment') { if (val) { group = normalizeGroup(val); start(group); } }
        else if (SECTION[key] !== undefined && SECTION[key]) { group = SECTION[key]; start(group); }
        else if (/^eo/.test(key)) flush();
        continue;
      }
      if (!line.trim()) {
        // a blank line ends the block — the writer's own stanza break
        flush();
        continue;
      }
      if (!cur) start(group);
      const p = parseLine(line);
      cur.lines.push(p.lyric.replace(/\s+$/, ''));
      cur.chords.push(p.chords);
    }
    flush();

    // Split anything longer than a screenful, keeping chords aligned with lyrics.
    const sections = [];
    for (const s of out.sections) {
      for (let i = 0; i < s.lines.length; i += linesPerSlide) {
        sections.push({
          group: s.group,
          lines: s.lines.slice(i, i + linesPerSlide),
          chords: s.chords.slice(i, i + linesPerSlide),
        });
      }
    }
    out.sections = sections;
    return out;
  }

  /** "Verse 1" / "chorus 2" / "BRIDGE" → our group names. */
  function normalizeGroup(v) {
    const s = String(v || '').trim();
    const m = s.match(GROUP_WORDS);
    if (!m) return s.slice(0, 24) || 'Verse 1';
    const word = m[1].toLowerCase().replace(/\s+/g, '-');
    const num = (s.match(/(\d+)/) || [])[1];
    const pretty = {
      verse: 'Verse', chorus: 'Chorus', bridge: 'Bridge', tag: 'Tag', intro: 'Intro', outro: 'Outro',
      refrain: 'Chorus', ending: 'Outro', interlude: 'Intro', vamp: 'Tag',
      'pre-chorus': 'Pre-Chorus', prechorus: 'Pre-Chorus',
    }[word] || 'Verse';
    if (pretty === 'Verse') return 'Verse ' + (num || '1');
    return pretty;
  }

  /** Turn parsed sections back into ChordPro, for the editor. */
  function toChordPro(slides, meta = {}) {
    const out = [];
    if (meta.title) out.push(`{title: ${meta.title}}`);
    if (meta.author) out.push(`{artist: ${meta.author}}`);
    if (meta.key) out.push(`{key: ${meta.key}}`);
    let lastGroup = null;
    for (const s of slides || []) {
      if (s.group !== lastGroup) { out.push(''); out.push(`{c: ${s.group}}`); lastGroup = s.group; }
      (s.lines || []).forEach((l, i) => {
        const row = (s.chords && s.chords[i]) || [];
        if (!row.length) { out.push(l); return; }
        // re-insert from the end so earlier offsets stay valid
        let line = l;
        for (const c of row.slice().sort((a, b) => b.at - a.at)) {
          line = line.slice(0, c.at) + '[' + c.chord + ']' + line.slice(c.at);
        }
        out.push(line);
      });
    }
    return out.join('\n').trim();
  }

  /* ---------------- transposition ---------------- */
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  /** Shift every chord by `steps` semitones (Nashville-proof enough for church). */
  function transpose(chord, steps, preferFlats) {
    return String(chord).replace(/([A-G][#b]?)/g, (root) => {
      let i = SHARP.indexOf(root);
      if (i < 0) i = FLAT.indexOf(root);
      if (i < 0) return root;
      const n = ((i + steps) % 12 + 12) % 12;
      return (preferFlats ? FLAT : SHARP)[n];
    });
  }
  function transposeSlides(slides, steps, preferFlats) {
    return (slides || []).map((s) => Object.assign({}, s, {
      chords: (s.chords || []).map((row) => (row || []).map((c) => Object.assign({}, c, { chord: transpose(c.chord, steps, preferFlats) }))),
    }));
  }

  window.ChordPro = { parse, parseLine, toChordPro, looksLikeChordPro, normalizeGroup, transpose, transposeSlides };
})();
