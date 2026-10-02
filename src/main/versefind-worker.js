'use strict';
/*
 * THE QUOTATION MATCHER, ON A THREAD OF ITS OWN.
 *
 * Listening for quoted scripture means holding an index of several whole
 * translations — about thirteen megabytes and a second of work each, and up to
 * five of them. Neither belongs in the main process:
 *
 *  - the SECOND is the problem. That process answers every IPC call the five
 *    studios make, so a solid second of index building is a second in which
 *    Presentation cannot put a slide on the wall. Yielding inside the build cut
 *    the worst uninterrupted block from 1100 ms to 201 ms, which is better and
 *    still far too long to happen while a service is starting.
 *  - the MEGABYTES are the smaller problem but the same argument: 135 MB of
 *    typed arrays sitting in the process that also runs ffmpeg's pipes, the
 *    store, the scheduler and the web server.
 *
 * Over here both are free. The main thread sends a line of speech and gets back
 * a reference or nothing, and the ten milliseconds it costs happen somewhere
 * else entirely.
 */
const { parentPort, workerData } = require('worker_threads');
const bible = require('./bible');
const vf = require('./versefind');

bible.init(workerData && workerData.userData);

let ready = [];
let building = null;

async function prepare(abbrs) {
  const want = (abbrs || []).filter(Boolean);
  /*
   * READY ONE AT A TIME. Every installed translation is indexed now (see
   * chooseTranslations), which is about fifteen seconds of building on a
   * modest PC. The first ones — the church's own, then the King James — are
   * worth using the moment they exist, so each joins `ready` as it is built
   * rather than all of them together at the end.
   */
  const out = [];
  ready = ready.filter((ix) => want.includes(ix.translation));
  for (const a of want) {
    try {
      const ix = await vf.indexFor(a, bible.load);
      if (ix) { out.push(ix); ready = out.concat(ready.filter((r) => !out.includes(r))); }
    } catch (e) { /* one translation failing is not the feature failing */ }
  }
  ready = out;
  return ready.map((ix) => ({ translation: ix.translation, verses: ix.N, pairs: ix.pairCount, buildMs: ix.buildMs }));
}

parentPort.on('message', async (m) => {
  const msg = m || {};
  try {
    switch (msg.cmd) {
      case 'prepare': {
        // Asking twice while the first is still going waits for it rather than
        // building everything a second time.
        if (!building) building = prepare(msg.abbrs).finally(() => { building = null; });
        const info = await building;
        parentPort.postMessage({ id: msg.id, ok: true, data: { indexes: info } });
        break;
      }
      case 'find': {
        // Past its deadline the asker has already given up (versefind-host.js).
        const stale = msg.deadline && Date.now() > msg.deadline;
        const r = ready.length && !stale ? vf.findAcross(ready, msg.text, msg.opts || {}) : null;
        parentPort.postMessage({ id: msg.id, ok: true, data: r });
        break;
      }
      case 'state':
        parentPort.postMessage({ id: msg.id, ok: true, data: {
          ready: ready.map((ix) => ix.translation), building: !!building,
        } });
        break;
      default:
        parentPort.postMessage({ id: msg.id, ok: false, error: 'unknown command' });
    }
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: (e && e.message) || String(e) });
  }
});
