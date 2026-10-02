'use strict';
/**
 * POSTING WHEN THE APP IS CLOSED.
 *
 * The Social Scheduler used to be a scheduler in name only: the tick that
 * publishes a due post lives in this app's main process, so a post scheduled
 * for 9am on Sunday only went out if somebody happened to have the studio open
 * at 9am on Sunday. Everything else about it worked — the accounts, the Graph
 * uploads, the retries — but the one thing a scheduler is for did not.
 *
 * This module fixes that by handing the clock to the operating system.
 *
 *   • Windows registers a Task Scheduler task, macOS a launchd agent, that
 *     runs THIS SAME APP every few minutes with `--publish-due`.
 *   • In that mode the app opens no window and loads no studio (see the top of
 *     main.js): it reads the schedule, publishes whatever is due, shows a
 *     desktop notification for each one, and quits. A run costs a second or
 *     two and no visible window ever appears.
 *   • When the studio IS open, the agent stands down immediately — the studio's
 *     own scheduler is already ticking, and two processes writing the same
 *     posts file is how a post gets published twice.
 *
 * TWO PROCESSES, ONE SET OF POSTS
 *
 * The studio and the agent are separate processes sharing one JSON file, so
 * "don't post it twice" cannot be a variable in memory. Two files on disk do
 * that job:
 *
 *   studio-open.json  a heartbeat the studio rewrites every 30s. Fresh means
 *                     the studio is up and the agent has nothing to do. It goes
 *                     stale by itself, so a crashed studio hands the job back
 *                     rather than blocking posting forever.
 *   publish.lock      held for the length of a publishing run by whichever
 *                     process is doing it. Whoever cannot take it does not
 *                     publish. A lock whose owner died is broken on sight, so
 *                     a killed upload cannot wedge the schedule.
 *
 * WHAT THIS HONESTLY CANNOT DO
 *
 * It is a desktop app, not a cloud service. The PC has to be switched on and
 * signed in to Windows (locked is fine, and the task is allowed to wake a
 * sleeping machine). A shut-down PC posts nothing — but anything that came due
 * while it was off goes out on the next run, which the "start when available"
 * flag makes the first few minutes after it comes back.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const AGENT_FLAG = '--publish-due';
const TASK_NAME = 'Church Work Space Auto-Post';       // Windows Task Scheduler
const MAC_LABEL = 'org.church.workspace.autopost';     // launchd agent label
const DEFAULT_EVERY_MIN = 5;
const EVERY_MIN_CHOICES = [5, 10, 15, 30, 60];

// The studio rewrites its heartbeat every 30s; anything older than this and we
// treat the studio as gone. Generous, because a heartbeat can be late when the
// machine is busy encoding a service, and being wrong here means not posting.
const HEARTBEAT_MS = 30 * 1000;
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;
// A publish lock older than this belonged to a process that is no longer
// publishing (a big Reel upload can legitimately run for many minutes).
const LOCK_STALE_MS = 30 * 60 * 1000;
const RUN_LOG_KEEP = 30;

function isAgentArgv(argv) {
  return (argv || []).some((a) => a === AGENT_FLAG || a === '--background-post');
}

/* ------------------------------- files ---------------------------------- */

function paths(userData) {
  return {
    heartbeat: path.join(userData, 'studio-open.json'),
    lock: path.join(userData, 'publish.lock'),
    state: path.join(userData, 'autopost.json'),
    plist: path.join(os.homedir(), 'Library', 'LaunchAgents', MAC_LABEL + '.plist'),
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return fallback; }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8'); return true; } catch (e2) { return false; }
  }
}

/** Is that pid still a running process? EPERM means yes-but-not-ours. */
function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

/* ---------------------------- studio heartbeat --------------------------- */

/**
 * The studio says "I am here" every 30 seconds. Written by the studio only;
 * the agent never touches it beyond reading it and (when stale) ignoring it.
 */
function startHeartbeat(userData) {
  const file = paths(userData).heartbeat;
  const beat = () => writeJson(file, { pid: process.pid, at: Date.now() });
  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  if (timer.unref) timer.unref();
  return {
    stop() {
      clearInterval(timer);
      try { fs.unlinkSync(file); } catch (e) {}
    },
  };
}

/** True when a live studio is running right now (so the agent should stand down). */
function studioIsOpen(userData, now = Date.now()) {
  const hb = readJson(paths(userData).heartbeat, null);
  if (!hb || !hb.at) return false;
  if (hb.pid === process.pid) return false;           // our own beat, in the studio process
  if (now - hb.at > HEARTBEAT_STALE_MS) return false; // studio died without cleaning up
  return pidAlive(hb.pid);
}

/* ----------------------------- publish lock ------------------------------ */

/**
 * Take the cross-process publishing lock, or return null if somebody else has
 * it. Release with the returned function. A lock left behind by a dead process
 * (or one held implausibly long) is taken over rather than respected — the
 * alternative is a schedule that silently stops forever.
 */
function acquireLock(userData, who = 'studio', now = Date.now(), owner = String(process.pid)) {
  const file = paths(userData).lock;
  const held = readJson(file, null);
  if (held && held.owner !== owner && pidAlive(held.pid) && (now - (held.at || 0)) < LOCK_STALE_MS) {
    return null;
  }
  if (!writeJson(file, { pid: process.pid, owner, who, at: now })) return null;
  // Two processes can write theirs in the same instant; last writer wins and
  // the other backs off, so re-read before believing it is ours.
  const check = readJson(file, null);
  if (!check || check.owner !== owner) return null;
  return function release() {
    const cur = readJson(file, null);
    if (cur && cur.owner === owner) { try { fs.unlinkSync(file); } catch (e) {} }
  };
}

/**
 * Who holds the lock right now, if anyone still alive does — for deciding
 * whether to stand down WITHOUT taking it. (Peeking rather than acquiring is
 * what lets the run that stands down leave the real publisher undisturbed.)
 */
function lockHeldBy(userData, now = Date.now(), owner = String(process.pid)) {
  const held = readJson(paths(userData).lock, null);
  if (!held || held.owner === owner) return null;
  if (held.pid === process.pid) return null;              // another part of us
  if ((now - (held.at || 0)) >= LOCK_STALE_MS) return null;
  return pidAlive(held.pid) ? held : null;
}

/* ------------------------------ run history ------------------------------ */

function readState(userData) {
  const st = readJson(paths(userData).state, null) || {};
  return {
    enabled: !!st.enabled,
    everyMinutes: EVERY_MIN_CHOICES.includes(st.everyMinutes) ? st.everyMinutes : DEFAULT_EVERY_MIN,
    runs: Array.isArray(st.runs) ? st.runs : [],
  };
}

function writeState(userData, patch) {
  const st = readState(userData);
  const next = { ...st, ...patch };
  next.runs = (next.runs || []).slice(-RUN_LOG_KEEP);
  writeJson(paths(userData).state, next);
  return next;
}

function recordRun(userData, entry) {
  const st = readState(userData);
  st.runs.push({ at: new Date().toISOString(), ...entry });
  return writeState(userData, { runs: st.runs });
}

/* --------------------------- how to launch us ---------------------------- */

/**
 * The command the OS should run. Packaged, that is the app's own exe; from a
 * checkout it is electron plus the project folder, so the feature can be
 * switched on and genuinely tested before it is ever installed.
 */
function launchCommand(opts = {}) {
  const exe = opts.execPath || process.execPath;
  const packaged = opts.packaged !== undefined
    ? opts.packaged
    : !/^electron(\.exe)?$/i.test(path.basename(exe));
  const appDir = opts.appDir || path.resolve(__dirname, '..', '..');
  return packaged ? { exe, args: [AGENT_FLAG] } : { exe, args: [appDir, AGENT_FLAG] };
}

/* Quote only what needs it. The project folder handed to electron in a dev run
 * routinely has spaces in it; a bare flag does not, and wrapping one in quotes
 * makes the argument list harder to read in Windows' own Task Scheduler for no
 * benefit. Embedded quotes are dropped rather than escaped — nothing we pass
 * has any, and a half-escaped command line is worse than a missing character. */
function quoteWin(s) {
  const t = String(s).replace(/"/g, '');
  return /[\s&|<>^]/.test(t) || !t ? '"' + t + '"' : t;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* ------------------------- Windows: Task Scheduler ----------------------- */

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        out: String(stdout || ''),
        err: String(stderr || (err && err.message) || ''),
      }));
  });
}

/**
 * The task definition. Written as XML rather than assembled from schtasks
 * switches because the switches cannot express the three settings that decide
 * whether this actually works for a church:
 *   StartWhenAvailable  a run missed because the PC was off happens as soon as
 *                       it comes back on, instead of waiting for the next slot.
 *   WakeToRun           a sleeping PC wakes up for the post.
 *   DisallowStartIfOnBatteries=false  a laptop on battery still posts.
 */
function taskXml({ exe, args, everyMinutes, description }) {
  const user = (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') +
    (process.env.USERNAME || os.userInfo().username);
  const every = 'PT' + Math.max(1, Math.round(everyMinutes)) + 'M';
  const cmdArgs = args.map((a) => quoteWin(a)).join(' ');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Author>' + esc(user) + '</Author>',
    '    <Description>' + esc(description) + '</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    '      <UserId>' + esc(user) + '</UserId>',
    '      <Delay>PT1M</Delay>',
    '    </LogonTrigger>',
    '    <CalendarTrigger>',
    '      <StartBoundary>2024-01-01T00:00:00</StartBoundary>',
    '      <Enabled>true</Enabled>',
    '      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
    '      <Repetition>',
    '        <Interval>' + every + '</Interval>',
    '        <Duration>P1D</Duration>',
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    '    </CalendarTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <UserId>' + esc(user) + '</UserId>',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>true</WakeToRun>',
    '    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>' + esc(exe) + '</Command>',
    '      <Arguments>' + esc(cmdArgs) + '</Arguments>',
    '      <WorkingDirectory>' + esc(path.dirname(exe)) + '</WorkingDirectory>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
  ].join('\n');
}

async function winEnable(userData, everyMinutes, cmd) {
  // schtasks reads the definition as UTF-16 — hand it exactly that, BOM and all.
  const xml = taskXml({
    exe: cmd.exe, args: cmd.args, everyMinutes,
    description: 'Publishes Church Work Space social posts at their scheduled time, even when the app is closed.',
  });
  const file = path.join(os.tmpdir(), 'cws-autopost-' + Date.now() + '.xml');
  fs.writeFileSync(file, '\ufeff' + xml, 'utf16le');
  try {
    const r = await run('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F']);
    if (!r.ok) throw new Error(cleanErr(r) || 'Windows Task Scheduler refused the task.');
  } finally { try { fs.unlinkSync(file); } catch (e) {} }
}

async function winDisable() {
  const r = await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
  // "cannot find the file" simply means it was already gone.
  if (!r.ok && !/cannot find|does not exist|specified file/i.test(r.out + r.err)) {
    throw new Error(cleanErr(r) || 'Could not remove the task.');
  }
}

async function winRegistered() {
  const r = await run('schtasks', ['/Query', '/TN', TASK_NAME]);
  return r.ok;
}

/**
 * Which app the registered task actually starts.
 *
 * A task is a path written down once. Reinstall the app somewhere else, or
 * switch this on from a checkout and later install it properly, and Windows
 * goes on dutifully starting something that is no longer there — a schedule
 * that looks switched on and posts nothing, which is the exact failure this
 * whole feature exists to end. So read the path back and compare it.
 *
 * Read from the task's own XML rather than /FO LIST, because the list output
 * is translated into the machine's language and the XML is not.
 */
async function winRegisteredCommand() {
  const r = await run('schtasks', ['/Query', '/TN', TASK_NAME, '/XML']);
  if (!r.ok) return null;
  const xml = r.out.replace(/\0/g, '');
  const cmd = (xml.match(/<Command>([\s\S]*?)<\/Command>/) || [])[1];
  return cmd ? cmd.trim().replace(/^"|"$/g, '') : null;
}

/** Windows tools answer in the machine's own language; keep the text, drop the noise. */
function cleanErr(r) {
  const t = ((r.err || '') + ' ' + (r.out || '')).replace(/\s+/g, ' ').trim();
  return t.slice(0, 300);
}

/* ---------------------------- macOS: launchd ----------------------------- */

function macPlist({ exe, args, everyMinutes }) {
  const items = [exe, ...args].map((a) => '    <string>' + esc(a) + '</string>').join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key><string>' + MAC_LABEL + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    items,
    '  </array>',
    '  <key>StartInterval</key><integer>' + Math.max(60, Math.round(everyMinutes * 60)) + '</integer>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>ProcessType</key><string>Background</string>',
    '</dict>',
    '</plist>',
  ].join('\n');
}

async function macEnable(userData, everyMinutes, cmd) {
  const file = paths(userData).plist;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, macPlist({ exe: cmd.exe, args: cmd.args, everyMinutes }), 'utf-8');
  await run('launchctl', ['unload', file]);           // ignore "not loaded"
  const r = await run('launchctl', ['load', '-w', file]);
  if (!r.ok) throw new Error(cleanErr(r) || 'macOS refused to load the background agent.');
}

async function macDisable(userData) {
  const file = paths(userData).plist;
  await run('launchctl', ['unload', '-w', file]);
  try { fs.unlinkSync(file); } catch (e) {}
}

async function macRegistered(userData) {
  if (!fs.existsSync(paths(userData).plist)) return false;
  const r = await run('launchctl', ['list', MAC_LABEL]);
  return r.ok;
}

/* ------------------------------ public API ------------------------------- */

const supported = () => process.platform === 'win32' || process.platform === 'darwin';

/** Is the OS task actually registered right now? (Not just what we last saved.) */
async function registered(userData) {
  try {
    if (process.platform === 'win32') return await winRegistered();
    if (process.platform === 'darwin') return await macRegistered(userData);
  } catch (e) {}
  return false;
}

async function status(userData, opts = {}) {
  const st = readState(userData);
  const cmd = launchCommand(opts);
  const on = supported() ? await registered(userData) : false;
  // Is the registered task still pointing at THIS app? (See winRegisteredCommand.)
  let stale = null;
  if (on && process.platform === 'win32') {
    try {
      const have = await winRegisteredCommand();
      if (have && path.resolve(have).toLowerCase() !== path.resolve(cmd.exe).toLowerCase()) stale = have;
      else if (have && !fs.existsSync(have)) stale = have;
    } catch (e) {}
  }
  const runs = st.runs.slice().reverse();
  const lastPublish = runs.find((r) => (r.published || 0) > 0 || (r.failed || 0) > 0) || null;
  return {
    supported: supported(),
    platform: process.platform,
    enabled: on,
    // What we last SAVED vs what the OS actually has. They differ when someone
    // deletes the task in Windows' own Task Scheduler, and the studio should
    // say so rather than keep claiming the tick is on.
    wanted: st.enabled,
    // Set when the task starts a copy of the app that is no longer the one
    // running: the schedule would look on and quietly do nothing.
    stale,
    everyMinutes: st.everyMinutes,
    choices: EVERY_MIN_CHOICES,
    command: cmd.exe + ' ' + cmd.args.join(' '),
    taskName: process.platform === 'darwin' ? MAC_LABEL : TASK_NAME,
    lastRun: runs[0] || null,
    lastPublish,
    runs: runs.slice(0, 10),
  };
}

async function enable(userData, everyMinutes = DEFAULT_EVERY_MIN, opts = {}) {
  if (!supported()) throw new Error('Background posting needs Windows or macOS.');
  const mins = EVERY_MIN_CHOICES.includes(Number(everyMinutes)) ? Number(everyMinutes) : DEFAULT_EVERY_MIN;
  const cmd = launchCommand(opts);
  if (process.platform === 'win32') await winEnable(userData, mins, cmd);
  else await macEnable(userData, mins, cmd);
  writeState(userData, { enabled: true, everyMinutes: mins });
  return status(userData, opts);
}

async function disable(userData, opts = {}) {
  if (process.platform === 'win32') await winDisable();
  else if (process.platform === 'darwin') await macDisable(userData);
  writeState(userData, { enabled: false });
  return status(userData, opts);
}

/**
 * Start a real background run by hand — the button that answers "will this
 * actually work when I close the app?" without waiting until Sunday.
 *
 * `force` is what makes the test worth anything: the studio is by definition
 * open while somebody is pressing the button, and a run that stands down
 * because of that proves only that the process started. Forcing it makes the
 * poster do the whole job — the publish lock, not the heartbeat, is what keeps
 * the two of them from posting the same thing twice.
 */
async function runNow(userData, opts = {}) {
  if (!opts.force && process.platform === 'win32' && await winRegistered()) {
    const r = await run('schtasks', ['/Run', '/TN', TASK_NAME]);
    if (r.ok) return { started: 'task' };
  }
  const cmd = launchCommand(opts);
  const args = opts.force ? cmd.args.concat(['--force']) : cmd.args;
  const child = spawn(cmd.exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { started: 'process', command: cmd.exe + ' ' + args.join(' ') };
}

/** Wait for the background process to write its next line in the run log. */
function waitForRun(userData, timeoutMs = 45000) {
  const before = readState(userData).runs.length;
  const started = Date.now();
  return new Promise((resolve) => {
    const poll = () => {
      const runs = readState(userData).runs;
      if (runs.length > before) return resolve(runs[runs.length - 1]);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(poll, 500);
    };
    setTimeout(poll, 500);
  });
}

/**
 * The headless run itself. Called from main.js when the app was started with
 * --publish-due; also exercised directly by test/autopost.test.js with a fake
 * scheduler, which is why nothing Electron-shaped appears in here.
 *
 * Returns what happened, and writes the same into the run log the Scheduler
 * page shows, so "did it run at 3am?" has an answer that is not a guess.
 */
async function publishDue(userData, scheduler, opts = {}) {
  const now = opts.now ? opts.now() : Date.now();
  if (!opts.force && studioIsOpen(userData, now)) {
    const entry = { skipped: 'studio-open', published: 0, failed: 0 };
    recordRun(userData, entry);
    return entry;
  }
  // Peek, do not take: the Scheduler takes the lock per post, and taking it
  // out here as well would only mean releasing somebody else's.
  if (!opts.force && lockHeldBy(userData, now)) {
    const entry = { skipped: 'already-publishing', published: 0, failed: 0 };
    recordRun(userData, entry);
    return entry;
  }
  const before = new Map((scheduler.list() || []).map((p) => [p.id, p.status]));
  try {
    await scheduler.tickNow();
  } catch (e) {
    recordRun(userData, { skipped: 'error', error: (e && e.message) || String(e), published: 0, failed: 0 });
    throw e;
  }

  const posted = [], failed = [];
  for (const p of (scheduler.list() || [])) {
    if (before.get(p.id) === p.status) continue;
    if (p.status === 'posted') posted.push({ id: p.id, title: p.title });
    else if (p.status === 'failed') failed.push({ id: p.id, title: p.title, error: p.error || '' });
  }
  const entry = {
    published: posted.length, failed: failed.length,
    titles: posted.map((p) => p.title).slice(0, 5),
    errors: failed.map((p) => p.title + ': ' + (p.error || '')).slice(0, 5),
  };
  recordRun(userData, entry);
  return entry;
}

module.exports = {
  AGENT_FLAG, TASK_NAME, MAC_LABEL, DEFAULT_EVERY_MIN, EVERY_MIN_CHOICES,
  HEARTBEAT_STALE_MS, LOCK_STALE_MS,
  isAgentArgv, paths, startHeartbeat, studioIsOpen, acquireLock, lockHeldBy,
  readState, writeState, recordRun, launchCommand, taskXml, macPlist,
  supported, registered, status, enable, disable, runNow, waitForRun, publishDue,
};
