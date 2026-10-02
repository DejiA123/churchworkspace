'use strict';
/*
 * EXPORTS YOU CAN WALK AWAY FROM — the background-task layer.
 *
 * This used to live in renderer.js, which meant it lived on the DESKTOP only.
 * The Cloud Studio serves the real veditor.js, and veditor.js drives this: it
 * opens a task per export, hands each pass of the chain to it, and asks it for
 * the one number that says how far the whole export has got. Without it every
 * call fell through a guard to the old behaviour — a full-screen overlay for
 * forty minutes, and a percentage that reached 100 four times per short.
 *
 * So it lives here and BOTH pages load it. The dock markup (#bgDock) and its
 * styles were already shared, because both pages are built from index.html and
 * styles.css; only the behaviour was stranded.
 *
 * WHAT IT EXPECTS FROM THE PAGE AROUND IT. Nothing but the eight globals every
 * shell already defines — __toast, __showOverlay, __hideOverlay, __setProgress,
 * __showCancel, __jobWasCancelled, plus window.api. They are read at CALL time,
 * never at load time, so this file can be loaded before or after the shell that
 * provides them.
 *
 * It is wrapped in an IIFE because it shares global scope with renderer.js, and
 * a bare `const toast` here would collide with the one there.
 */
(function () {

  /* The page's shell, whichever page this is. Read late, never cached. */
  const $ = (sel) => document.querySelector(sel);
  const toast = (...a) => (window.__toast ? window.__toast(...a) : undefined);
  const showOverlay = (...a) => (window.__showOverlay ? window.__showOverlay(...a) : undefined);
  const hideOverlay = (...a) => (window.__hideOverlay ? window.__hideOverlay(...a) : undefined);
  const setProgress = (...a) => (window.__setProgress ? window.__setProgress(...a) : undefined);
  const showCancel = (...a) => (window.__showCancel ? window.__showCancel(...a) : undefined);
  const jobWasCancelled = (...a) => (window.__jobWasCancelled ? window.__jobWasCancelled(...a) : false);
  const esc = (s2) => String(s2 == null ? '' : s2).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  /* ===================== EXPORTS YOU CAN WALK AWAY FROM =====================
   *
   * WHAT WAS WRONG. An export is not one job; it is a chain of them — composite,
   * encode, burn the text, caption it, lay the music under, put the outro on the
   * end — and every link showed the same full-screen overlay. A service export
   * takes forty minutes, and for those forty minutes the whole studio was a
   * spinner. The work itself was never the problem: ffmpeg runs in the main
   * process and whisper runs beside it, so the renderer spends that time doing
   * nothing but awaiting IPC. The ONLY thing standing between the operator and
   * the rest of the app was this modal.
   *
   * WHAT A TASK IS. One thing the operator asked for ("save my edited video"),
   * however many jobs it takes. The chain hands each job the task it belongs to,
   * so sending it to the background once keeps every later link out of the way
   * too — otherwise the overlay would slam back up at the captioning step.
   *
   * WHAT MOVING IT DOES NOT CHANGE. The job ids still route progress and still
   * cancel; the chip in the dock carries both. And what a backgrounded export
   * renders is frozen at the moment it starts (see freezeForExport in veditor.js)
   * — the whole point is to keep editing, and an export that quietly picked up
   * the text you typed after starting it would be worse than no feature at all.
   */
  let _taskSeq = 0;
  const _tasks = new Map();        // taskId -> record
  const _taskOfJob = new Map();    // jobId  -> taskId
  let _fgJobId = null;             // the job the modal overlay is currently showing
  let _dockTimer = null;

  /** Open a task. `background: true` starts it in the dock with no modal at all. */
  function newTask(title, opts = {}) {
    const id = 'task_' + (++_taskSeq) + '_' + Date.now();
    _tasks.set(id, {
      id, title: title || 'Working…', step: '', percent: 0,
      bg: !!opts.background, state: 'run', file: null, jobId: null,
      at: Date.now(), batch: null,
    });
    if (opts.background) renderDock();
    return id;
  }
  /** "Short 2 of 5", on the chip as well as the overlay. */
  function setTaskBatch(taskId, i, n) {
    const t = _tasks.get(taskId); if (!t) return;
    t.batch = (i && n) ? `${i} of ${n}` : null;
    renderDock();
  }
  /** Move a running task out of the way. Everything left in its chain follows. */
  function sendTaskToBackground(taskId) {
    const t = _tasks.get(taskId);
    if (!t || t.bg || t.state !== 'run') return;
    t.bg = true;
    hideOverlay();
    renderDock();
    toast('⇥ Carrying on in the background. Keep working — the corner shows how it is going, '
      + 'and it saves whatever the timeline looked like when you started it.', 'good', 8000);
  }
  /** Close a task: 'done' keeps the chip around with the file, the rest fade it. */
  function endTask(taskId, res = {}) {
    const t = _tasks.get(taskId); if (!t) return false;
    t.state = res.state || (res.ok === false ? 'fail' : 'done');
    t.file = res.file || null;
    t.step = res.note || t.step;
    t.percent = t.state === 'done' ? 100 : t.percent;
    for (const [j, id] of _taskOfJob) if (id === taskId) _taskOfJob.delete(j);
    if (!t.bg) { _tasks.delete(taskId); renderDock(); return false; }
    // A finished background export has to still be there when the operator looks
    // up — they were told to go and do something else. It waits, with the file.
    renderDock();
    setTimeout(() => { _tasks.delete(taskId); renderDock(); }, t.state === 'done' ? 60000 : 25000);
    return true;   // the caller must not yank Explorer open over whatever they are doing
  }
  const taskRunning = (taskId) => { const t = _tasks.get(taskId); return !!(t && t.state === 'run'); };
  /** How many exports are on the go — used to warn before piling on a fourth. */
  const backgroundCount = () => Array.from(_tasks.values()).filter((t) => t.bg && t.state === 'run').length;

  /* =================== ONE NUMBER FOR ONE EXPORT ===================
   *
   * An export is a chain of passes — encode, captions, text, music, outro — each
   * of which is its own ffmpeg job reporting its own 0-100. Showing that raw made
   * the chip reach 100% and restart four times for a single short.
   *
   * A chain is the list of passes THIS export is going to run, each with a weight.
   * The number is then where the whole export has got to. Three things make it
   * honest rather than decorative:
   *
   *   • THE WEIGHTS ARE MEASURED, not equal. A 1080p encode of a 90-second short
   *     is around 70 s; mixing a music bed under it is a stream copy of about 10.
   *     Equal fifths would have the bar crawl for a minute and then jump a fifth
   *     in three seconds.
   *   • THE PLAN IS BUILT FROM THE SAME CONDITIONS THE STEPS USE, so a short with
   *     no music and no outro has neither in its chain and still ends at 100.
   *   • IT ONLY GOES FORWARD. Steps are found by index, searching from where we
   *     are, so a pass that was planned and skipped settles to complete rather
   *     than dragging the number backwards, and a fallback pass nobody planned
   *     for rides inside the slice that is already running.
   *
   * Being a little out only changes the PACE. It cannot change the ending: the
   * task closes at 100 either way.
   */
  const CHAIN_WEIGHTS = {
    track:    90,   // two neural nets over every sampled frame — the big one
    encode:  100,   // the short itself
    overlays: 35,   // compositing the overlay lane onto the finished frame
    caption:  30,   // whisper listening to the clip
    draw:     12,   // rasterising the caption track here in the studio
    burn:     50,   // burning it (and any text) into the picture
    text:     25,   // text on its own, when there are no captions to ride with
    music:    10,   // -c:v copy, so it is cheap
    outro:    10,   // a stream-copy join since v2.71.0
  };
  /*
   * Attaching the cover picture is deliberately NOT in here. It is not a render —
   * it has no job, no progress and takes a moment — so giving it a slice would
   * mean the number reached the end of the outro and then went BACKWARDS to make
   * room for it. Work with nothing to report is better left out of a plan about
   * how much work is left.
   */
  /*
   * ►► AND IT IS ALWAYS MOVING. ◄◄
   *
   * Weighting the passes made the number mean something, but it still SAT there.
   * An export has long stretches that report nothing at all: tracking (90 units
   * of weight and not one progress event), the decode-verify that proves Quick
   * Sync did not write garbage, the checked voice track rendered before the
   * picture. On a face-tracked short with gaps closed that is most of a minute
   * frozen on 33%, which reads as a hang.
   *
   * So the number is ANIMATED, out of two things:
   *   • what was last actually MEASURED (c.reported), and
   *   • a creep between measurements, because time passing IS evidence — at the
   *     pace this pass was last going, or, for a pass that has never reported
   *     anything, a slow curve that approaches and never arrives.
   *
   * The creep is bounded to 92% of the pass it is inside, so it can never claim a
   * pass has finished; only a real measurement, or the next pass starting, does
   * that. And it is a floor on nothing: `shown` still only ever goes up.
   */
  const CREEP_CEILING = 0.92;   // of the current slice — leave room for the truth
  const TICK_MS = 120;
  /*
   * How long a silent pass is EXPECTED to take, which is what decides how fast
   * the creep may move through it. A fixed time constant cannot work: the same
   * chain runs over a six-second clip and over a four-minute one, and a curve
   * tuned for the second sits on 62% for four seconds on the first.
   *
   * So it is learned from the export itself. Every pass that finishes gives a
   * milliseconds-per-weight-unit reading, and the next pass is expected to take
   * its own weight times that. Until anything has finished, 700 ms/unit — the
   * ratio measured on a 90-second 1080p short, where the encode is ~70 s for 100.
   */
  const MS_PER_WEIGHT_GUESS = 700;

  /** Start a task's chain. `keys` is the passes this export will run, in order. */
  function chainBegin(taskId, keys) {
    const t = _tasks.get(taskId); if (!t) return;
    const steps = (keys || [])
      .filter((k) => CHAIN_WEIGHTS[k] > 0)
      .map((k) => ({ key: k, weight: CHAIN_WEIGHTS[k] }));
    t.chain = steps.length
      ? { steps, total: steps.reduce((n, s) => n + s.weight, 0), i: -1, done: 0, curW: 0,
          base: 0, span: 0, shown: 0, reported: 0, at: Date.now(), lastAt: Date.now(),
          msPerW: 0, tau: 0 }
      : null;
    t.percent = 0;
    if (t.chain) startTicker();
    if (t.bg) scheduleDock();
  }

  /* ---- the animation: one timer, however many exports are running ---- */
  let _tickTimer = null;
  function startTicker() {
    if (!_tickTimer) _tickTimer = setInterval(tickChains, TICK_MS);
  }
  function tickChains() {
    const now = Date.now();
    let live = 0, dockDirty = false;
    for (const t of _tasks.values()) {
      const c = t.chain;
      if (!c || t.state !== 'run') continue;
      live++;
      if (c.span <= 0) continue;              // no pass has started yet
      const ceil = c.base + c.span * CREEP_CEILING;
      // The pace this pass has actually managed so far, averaged over the whole
      // slice rather than the last two reports — ffmpeg's are not evenly spaced,
      // and an instantaneous rate off two close readings is mostly noise.
      const ran = c.lastAt - c.at;
      const rate = (ran > 400 && c.reported > c.base) ? (c.reported - c.base) / ran : 0;
      const est = rate > 0
        ? c.reported + rate * (now - c.lastAt)            // carry on as it was going
        : c.base + c.span * (1 - Math.exp(-(now - c.at) / (c.tau || 22000)));
      const last = c.i >= c.steps.length - 1;
      const target = Math.min(last ? 100 : 99,
        Math.max(c.shown, Math.min(ceil, Math.max(est, c.reported))));
      if (target <= c.shown) continue;
      // Ease toward it, but always by SOMETHING, so it is visibly alive.
      c.shown = Math.min(target, c.shown + Math.max(0.08, (target - c.shown) * 0.22));
      t.percent = c.shown;
      if (t.bg) dockDirty = true;
      else if (_fgJobId && _taskOfJob.get(_fgJobId) === t.id) setProgress(c.shown);
    }
    // Repaint the NUMBER, not the dock. renderDock rebuilds innerHTML and rebinds
    // every button; doing that eight times a second to move a percentage would
    // trade one kind of stuck for another — and would drop a click on ✕ Stop
    // that landed between a rebuild and its listener.
    if (dockDirty && !paintDockProgress()) renderDock();
    // Nothing left to animate: stop, rather than tick for the rest of the session.
    if (!live) { clearInterval(_tickTimer); _tickTimer = null; }
  }
  /**
   * This export is finished — show it, and give the screen a moment to.
   *
   * Without this a batch goes straight from "97%, 7 of 9" to "0%, 8 of 9" in one
   * synchronous breath, so no short is ever SEEN to complete. Both renders happen
   * before the browser paints, and the operator only ever sees the second.
   */
  async function chainDone(taskId) {
    const t = _tasks.get(taskId); if (!t) return;
    if (t.chain) { t.chain.shown = 100; t.chain.reported = 100; }
    t.percent = 100;
    renderDock();
    // Long enough to be seen. 120 ms against a three-minute export is nothing —
    // even twenty shorts add under two and a half seconds — and rAF alone is not
    // enough: a backgrounded window may not run one at all.
    await new Promise((r) => setTimeout(r, 120));
  }
  /** This pass is starting. Anything planned before it is settled as finished. */
  function chainEnter(t, key) {
    const c = t && t.chain;
    if (!c || !key) return;
    // Search FORWARD only: that is what makes the number monotonic, and what
    // settles a planned pass that turned out not to be needed.
    let i = -1;
    for (let j = Math.max(0, c.i); j < c.steps.length; j++) if (c.steps[j].key === key) { i = j; break; }
    if (i < 0) return;       // unplanned fallback — it rides in the current slice
    const prevW = c.i >= 0 ? c.curW : 0;
    c.i = i;
    c.done = c.steps.slice(0, i).reduce((n, s) => n + s.weight, 0);
    c.curW = c.steps[i].weight;
    // What the pass that just ended tells us about how fast THIS export is going.
    const now = Date.now();
    if (prevW > 0) {
      const took = now - c.at;
      if (took > 200) {
        const per = took / prevW;
        c.msPerW = c.msPerW ? (c.msPerW * 0.5 + per * 0.5) : per;
      }
    }
    // Where this pass sits in the whole export, and a clean slate for its pace:
    // the pass before it says nothing about how fast this one will go.
    c.base = (c.done / c.total) * 100;
    c.span = (c.curW / c.total) * 100;
    c.reported = Math.max(c.reported, c.base);
    c.at = now; c.lastAt = now;
    /*
     * Half the expected duration, so a pass that takes as long as expected is
     * about 86% of the way through its slice by the time it ends.
     *
     * The floor is FOUR SECONDS, not one. Passes of this app are measured in
     * seconds, and a learned rate can be nonsense — an export whose early passes
     * happened to be quick teaches "16 ms per weight unit", which sends the creep
     * to its ceiling in a second and leaves it sitting there for the ten that
     * follow. A creep that saturates is a creep that has stopped.
     */
    c.tau = Math.max(4000, (c.msPerW || MS_PER_WEIGHT_GUESS) * c.curW * 0.5);
    startTicker();
  }
  /** Where the whole export has got to, given this pass is `p` percent done. */
  function chainPct(t, p) {
    const c = t && t.chain;
    if (!c || !c.total) return Math.max(0, Math.min(100, Math.round(p) || 0));
    const within = Math.max(0, Math.min(100, Number(p) || 0)) / 100;
    const v = ((c.done + c.curW * within) / c.total) * 100;
    /*
     * 100 only on the LAST pass. Anywhere earlier, a pass finishing would read as
     * the export finishing — the very thing this replaced. But the cap must not
     * apply to the last one either, or the number would stick at 99 and then jump
     * when the task closes.
     */
    const last = c.i >= c.steps.length - 1;
    const capped = Math.max(0, Math.min(last ? 100 : 99, v));
    /*
     * ►► AND IT NEVER GOES BACKWARDS. ◄◄
     *
     * A high-water mark, rather than a promise that every pass reports tidily.
     * One slice can be entered TWICE — drawing a caption track and then burning
     * it were both 'burn' at first, so the second restarted the slice and the
     * number fell from 85 to 65 in front of the operator. Splitting those two
     * fixed that case; this makes the property true of every case, including the
     * fallback paths that run a second job inside a pass nobody planned twice.
     */
    if (capped > c.reported) { c.reported = capped; c.lastAt = Date.now(); }
    c.shown = Math.max(c.shown, Math.min(c.reported, last ? 100 : 99));
    startTicker();
    return c.shown;
  }

  /**
   * Say what a task is doing right now, whichever side of the modal it is on.
   * `chainKey` is for renderer-side work that is part of an export but has no
   * ffmpeg job of its own (drawing the caption track), so its progress lands in
   * the right slice instead of being read as the previous pass.
   */
  function taskSay(taskId, msg, chainKey) {
    const t = taskId && _tasks.get(taskId);
    if (t) {
      if (chainKey) chainEnter(t, chainKey);
      t.step = msg;
      if (t.bg) return scheduleDock();
    }
    if (!t || !t.bg) showOverlay(msg);
  }
  /** Progress for renderer-side work (rasterising captions/text) with no jobId. */
  function taskProgress(taskId, pct) {
    const t = taskId && _tasks.get(taskId);
    const shown = t ? chainPct(t, pct) : pct;
    if (t) { t.percent = shown; if (t.bg) return scheduleDock(); }
    if (!t || !t.bg) setProgress(shown);
  }

  /**
   * Move the running chips' numbers and bars where they already are on screen.
   * Returns false if a chip is missing, which means the dock really does need
   * rebuilding (a task started or finished since the last render).
   */
  function paintDockProgress() {
    const box = $('#bgDock');
    if (!box || box.classList.contains('hidden')) return false;
    let complete = true;
    for (const t of _tasks.values()) {
      if (!t.bg || t.state !== 'run') continue;
      const el = box.querySelector('.bgj[data-task="' + t.id + '"]');
      if (!el) { complete = false; continue; }
      const pct = Math.round(Math.max(0, Math.min(100, t.percent || 0)));
      const n = el.querySelector('.bgj-pct');
      if (n) n.textContent = pct + '%'; else complete = false;
      const bar = el.querySelector('.progress-bar');
      if (bar) bar.style.width = Math.max(2, pct) + '%';
    }
    return complete;
  }

  function scheduleDock() {
    if (_dockTimer) return;
    _dockTimer = requestAnimationFrame(() => { _dockTimer = null; renderDock(); });
  }
  const ICONS = { run: '⏳', done: '✅', fail: '⚠️', stopped: '■' };
  function renderDock() {
    const box = $('#bgDock');
    if (!box) return;
    const list = Array.from(_tasks.values()).filter((t) => t.bg);
    box.classList.toggle('hidden', !list.length);
    if (!list.length) { box.innerHTML = ''; return; }
    const running = list.filter((t) => t.state === 'run').length;
    box.innerHTML =
      `<div class="bgd-head">${running
        ? `${running} ${running === 1 ? 'job' : 'jobs'} running in the background`
        : 'Finished'}</div>`
      + list.map((t) => `
        <div class="bgj ${t.state}" data-task="${esc(t.id)}">
          <div class="bgj-top">
            <span class="bgj-ic">${ICONS[t.state] || '⏳'}</span>
            <span class="bgj-title" title="${esc(t.title)}">${esc(t.title)}</span>
            ${t.batch ? `<span class="bgj-batch">${esc(t.batch)}</span>` : ''}
            ${t.state === 'run' ? `<span class="bgj-pct">${Math.round(Math.max(0, Math.min(100, t.percent || 0)))}%</span>` : ''}
            ${t.state === 'run'
              ? `<button class="bgj-x" data-stop="${esc(t.id)}" title="Stop this export">✕</button>`
              : `<button class="bgj-x" data-close="${esc(t.id)}" title="Clear">✕</button>`}
          </div>
          <div class="bgj-step">${esc(t.step || 'Starting…')}</div>
          ${t.state === 'run'
            ? `<div class="progress"><div class="progress-bar" style="width:${Math.max(2, Math.min(100, t.percent || 0))}%"></div></div>`
            : ''}
          ${t.file ? `<button class="bgj-open" data-open="${esc(t.file)}">📂 Show the file</button>` : ''}
        </div>`).join('');
    box.querySelectorAll('[data-stop]').forEach((b) => b.addEventListener('click', async () => {
      const t = _tasks.get(b.dataset.stop); if (!t) return;
      b.disabled = true;
      t.step = 'Stopping…'; renderDock();
      if (t.jobId) { _cancelledJobs.add(t.jobId); try { await api.job.cancel(t.jobId); } catch (e) {} }
    }));
    box.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
      _tasks.delete(b.dataset.close); renderDock();
    }));
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      api.shell.showItem(b.dataset.open);
    }));
  }

  /**
   * Run an async job with overlay + live progress wired to a jobId.
   * `opts.cancellable === false` hides the Cancel button (for jobs that are only a
   * step of something already running, or too quick to be worth stopping).
   * `opts.task` ties it to a task, which is what makes ⇥ Run in the background
   * work across a whole export chain rather than one link of it.
   */
  async function runJob(label, jobId, fn, opts = {}) {
    const t = opts.task ? _tasks.get(opts.task) : null;
    if (t) {
      t.step = label; t.jobId = jobId;
      // With a chain the number belongs to the EXPORT, not to this pass, so it
      // moves to where this pass begins instead of back to nothing.
      if (t.chain) { chainEnter(t, opts.chain); t.percent = chainPct(t, 0); }
      else t.percent = 0;
      if (jobId) _taskOfJob.set(jobId, t.id);
    }
    if (t && t.bg) {
      // No modal, no overlay state touched — the studio stays exactly as the
      // operator left it while this runs.
      renderDock();
      try {
        const result = await fn();
        t.percent = chainPct(t, 100); scheduleDock();
        return result;
      } catch (err) {
        if (jobWasCancelled(jobId, err)) {
          _cancelledJobs.delete(jobId);
          err.cancelled = true;
        }
        throw err;
      } finally { if (jobId) _taskOfJob.delete(jobId); }
    }
    _fgJobId = jobId || null;
    showOverlay(label);
    // showOverlay puts the bar back to nothing; with a chain it belongs where this
    // export has actually got to, or the modal restarts at 0% every pass.
    if (t && t.chain) setProgress(chainPct(t, 0));
    showCancel(opts.cancellable === false ? null : jobId);
    showBackground(t ? t.id : null);
    try {
      const result = await fn();
      // It may have been sent to the background WHILE this job ran — then the
      // overlay is already down and must not be brought back up to say "100%".
      if (!t || !t.bg) {
        // 100 only when there is nothing after this; inside a chain it is where
        // this pass ENDS, which is not the end of the export.
        setProgress(t && t.chain ? chainPct(t, 100) : 100);
        // The hide STAYS scheduled even mid-chain: it is what closes the overlay
        // after the last pass, and the next pass's showOverlay cancels it (which
        // is the whole reason that clearTimeout is the first thing showOverlay
        // does). Skipping it here would leave the modal up for ever.
        _hideTimer = setTimeout(hideOverlay, 250);
        showCancel(null);
      } else { t.percent = chainPct(t, 100); scheduleDock(); }
      return result;
    } catch (err) {
      if (!t || !t.bg) hideOverlay();
      if (jobWasCancelled(jobId, err)) {
        _cancelledJobs.delete(jobId);
        toast('Stopped.', '');
        err.cancelled = true; // callers can tell "user stopped it" from "it broke"
      } else {
        toast('⚠️ ' + (err.message || err), 'error');
      }
      throw err;
    } finally {
      if (_fgJobId === jobId) _fgJobId = null;
      if (jobId) _taskOfJob.delete(jobId);
    }
  }

  /** The overlay's ⇥ button, shown only for work that CAN be walked away from. */
  function showBackground(taskId) {
    const b = $('#overlayBackground');
    if (!b) return;
    b.classList.toggle('hidden', !taskId);
    b.onclick = taskId ? () => sendTaskToBackground(taskId) : null;
  }

  function fmtBytes(b) {
    if (!b) return '0 MB';
    const mb = b / (1024 * 1024);
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
  }

  function finishedFile(path) {
    toast('✅ Saved: ' + path.split(/[\\/]/).pop(), 'good');
    setTimeout(() => api.shell.showItem(path), 400);
  }

  // Shared with veditor.js / editor.js
  window.__runJob = runJob;

  // The background-task layer (veditor.js drives it; the Cloud Studio has its own
  // shim and simply does without, which is the behaviour it has always had).
  // "Where did it go" — the dock answers it, so this belongs with the dock.
  window.finishedFile = finishedFile;
  window.__newTask = newTask;
  window.__endTask = endTask;
  window.__taskSay = taskSay;
  window.__taskProgress = taskProgress;
  window.__setTaskBatch = setTaskBatch;
  window.__chainBegin = chainBegin;
  window.__chainDone = chainDone;
  // For the tests: is the progress animation still running? (It must stop.)
  window.__chainTicking = () => !!_tickTimer;
  // For the tests: the running export's chain, so a stall can be attributed to a
  // pass rather than guessed at from the number alone.
  window.__chainDebug = () => {
    for (const t of _tasks.values()) {
      const c = t.chain;
      if (!c || t.state !== 'run') continue;
      return { key: c.i >= 0 ? c.steps[c.i].key : null, base: +c.base.toFixed(2), span: +c.span.toFixed(2),
               reported: +c.reported.toFixed(2), shown: +c.shown.toFixed(2),
               tau: Math.round(c.tau || 0), msPerW: Math.round(c.msPerW || 0) };
    }
    return null;
  };
  window.__chainWeights = CHAIN_WEIGHTS;   // read by the tests, not by the studio
  window.__taskRunning = taskRunning;
  window.__taskBackground = sendTaskToBackground;
  window.__backgroundCount = backgroundCount;

  /*
   * Progress used to go to the single overlay bar whatever job it came from. With
   * exports running behind the studio that is no longer harmless: a background
   * encode would drive the bar of whatever the operator is doing in front of it.
   * So it is routed by job id, and only an unclaimed reading falls through to the
   * overlay (there are still a few callers that show it by hand).
   */
  api.onJobProgress(({ jobId, percent }) => {
    const t = jobId && _tasks.get(_taskOfJob.get(jobId));
    // A job reports ITS OWN 0-100; what the operator is shown is how far the whole
    // export has got (chainPct). Without a chain the two are the same thing.
    const shown = t ? chainPct(t, percent) : percent;
    if (t) { t.percent = shown; if (t.bg) return scheduleDock(); }
    if (!jobId || !_fgJobId || jobId === _fgJobId) setProgress(shown);
  });

})();
