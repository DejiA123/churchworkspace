'use strict';
/*
 * A FAIR QUEUE — when many people caption at once, they take turns.
 *
 * "When 50+ people use it": the free cloud ears answer a few requests a minute,
 * and the server's own speech model is four cores. Started all at once, every
 * job slows every other and they fail together. So only `slots` run at a time
 * and the rest wait — and they wait FAIRLY: turns go round the people, not
 * round the jobs. Someone captioning 14 shorts gets one turn, then the next
 * person waiting gets theirs, so one big batch never locks everyone else out.
 *
 * Waiting is not failing: the caller is told its place in the line (to show it),
 * and a job cancelled while it waits simply leaves the line.
 */

const { AsyncResource } = require('async_hooks');

function create({ slots = 2, isCancelled = () => false } = {}) {
  let running = 0;
  const lines = new Map();   // owner -> [entry] waiting, oldest first
  const turns = [];          // owners with someone waiting, whose turn is next first

  const waitingCount = () => { let n = 0; for (const l of lines.values()) n += l.length; return n; };
  const runningBy = new Map();   // owner -> how many of theirs are running
  /*
   * WHOSE TURN: the person with the fewest jobs running right now, and among
   * those, whoever's last turn was longest ago (or who has not had one). So
   * someone with nothing running always goes before someone whose shorts are
   * already being heard, and a newcomer before someone on their third short.
   */
  const lastTurn = new Map();    // owner -> when their last job started (a counter)
  let clock = 0;
  function pick(turnsNow, runs, last) {
    let best = -1;
    const key = (o) => [runs.get(o) || 0, last.has(o) ? last.get(o) : -1];
    for (let i = 0; i < turnsNow.length; i++) {
      if (best < 0) { best = i; continue; }
      const [r, l] = key(turnsNow[i]), [br, bl] = key(turnsNow[best]);
      if (r < br || (r === br && l < bl)) best = i;
    }
    return best;
  }
  // its place in the line: the turns played out from here (running jobs assumed still running)
  function ahead(entry) {
    const t = turns.slice(), runs = new Map(runningBy), last = new Map(lastTurn), left = new Map();
    let c = clock;
    for (const [o, l] of lines) left.set(o, l.length);
    const mine = (lines.get(entry.owner) || []).indexOf(entry);
    if (mine < 0) return 0;
    let n = 0, mineServed = 0;
    while (t.length) {
      const i = pick(t, runs, last);
      const o = t.splice(i, 1)[0];
      if (o === entry.owner) { if (mineServed === mine) return n; mineServed++; }
      n++;
      runs.set(o, (runs.get(o) || 0) + 1);
      last.set(o, ++c);
      left.set(o, left.get(o) - 1);
      if (left.get(o) > 0) t.push(o);
    }
    return n;
  }
  function drop(entry) {
    const l = lines.get(entry.owner);
    if (!l) return;
    const i = l.indexOf(entry);
    if (i >= 0) l.splice(i, 1);
    if (!l.length) { lines.delete(entry.owner); const t = turns.indexOf(entry.owner); if (t >= 0) turns.splice(t, 1); }
  }
  function next() {
    while (running < slots && turns.length) {
      const owner = turns.splice(pick(turns, runningBy, lastTurn), 1)[0];
      const l = lines.get(owner);
      const entry = l.shift();
      if (l.length) turns.push(owner); else lines.delete(owner);   // their next job waits for the round to come back
      running++;
      runningBy.set(owner, (runningBy.get(owner) || 0) + 1);
      lastTurn.set(owner, ++clock);
      entry.go();
    }
    for (const l of lines.values()) for (const e of l) e.tell();
  }
  function done(owner) {
    running--;
    const r = (runningBy.get(owner) || 1) - 1;
    if (r > 0) runningBy.set(owner, r); else runningBy.delete(owner);
    if (!r && !lines.has(owner)) lastTurn.delete(owner);   // gone quiet: forgotten
    next();
  }

  /** Run fn when it is this owner's turn. While it waits, onWait(n) says its place in the line (1 = next); onWait(0) when it starts. */
  function run(owner, fn, { onWait, jobId } = {}) {
    owner = owner || '';
    return new Promise((resolve, reject) => {
      let poll = null, told = -1;
      // started later, from whichever job freed the slot: it must still run as ITS
      // job (cancel, the owner of what it spawns) — so it keeps the context it queued in
      const start = AsyncResource.bind(() => fn());
      // (told from other jobs' turns too: the news goes to this job's person, not theirs)
      if (onWait) onWait = AsyncResource.bind(onWait);
      const entry = {
        owner,
        tell() { const n = ahead(entry) + 1; if (n !== told && onWait) { told = n; try { onWait(n); } catch (e) {} } },
        go() {
          clearInterval(poll);
          if (told > 0 && onWait) { try { onWait(0); } catch (e) {} }
          new Promise((r) => r(start())).then(resolve, reject).finally(() => done(owner));
        },
      };
      if (!lines.has(owner)) { lines.set(owner, []); turns.push(owner); }
      lines.get(owner).push(entry);
      next();
      if (lines.get(owner) && lines.get(owner).includes(entry)) {
        // still waiting: leave the line if the job is cancelled meanwhile
        poll = setInterval(() => {
          if (!isCancelled(jobId)) return;
          clearInterval(poll); drop(entry); next();
          const err = new Error('Cancelled'); err.name = 'CancelledError'; err.cancelled = true;
          reject(err);
        }, 250);
      }
    });
  }

  return { run, state: () => ({ running, waiting: waitingCount(), slots }) };
}

module.exports = { create };
