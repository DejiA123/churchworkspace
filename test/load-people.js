'use strict';
/*
 * MANY PEOPLE AT ONCE — a load run against a live Cloud Studio.
 *
 * N people (default 20) start together: each makes their own space, uploads a
 * video, reads it, asks for a thumbnail, saves a project, lists files and
 * exports a clip. It reports how long each step took, whether every export
 * came out, whether anyone could see another person's files or projects, how
 * fast the server kept answering, and the peak memory of the server and
 * everything it ran.
 *
 *   # a studio sized like Render Starter (512 MB, one core):
 *   MW_CLOUD_CODE=test-code-1234 MW_MEMORY_MB=512 MW_CPUS=1 MW_CLOUD_PORT=7399 \
 *     taskset -c 0 node src/cloud/server.js &
 *   node test/load-people.js 20 some-video.mp4 <server pid>
 *
 * Measured (20 people, 15 s 1080x1920 clip, 512 MB / 1 core): 20/20 done,
 * 0 seeing anyone else's work, server answering in 2 ms (median), peak 323 MB,
 * thumbnails 5 s (median) while 20 exports took their turns.
 */
// 20 people at once against the Cloud Studio (512 MB / 1 CPU settings)
const fs = require('fs');
const { execSync } = require('child_process');
const BASE = 'http://127.0.0.1:7399';
const N = Number(process.argv[2] || 20);
const SRC = fs.readFileSync(process.argv[3]);
const pid = Number(process.argv[4]);
const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(1);
let peak = 0, peakFf = 0;
const tree = () => { try { return execSync(`ps -eo pid,ppid,rss,comm`).toString().trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/)); } catch (e) { return []; } };
const sampler = setInterval(() => {
  const rows = tree(); const kids = new Set([String(pid)]); let grew = true;
  while (grew) { grew = false; for (const r of rows) if (kids.has(r[1]) && !kids.has(r[0])) { kids.add(r[0]); grew = true; } }
  let tot = 0, ff = 0; for (const r of rows) if (kids.has(r[0])) { tot += Number(r[2]); if (/ffmpeg|whisper/.test(r[3])) ff++; }
  peak = Math.max(peak, tot); peakFf = Math.max(peakFf, ff);
}, 250);
const lat = [];
const pinger = setInterval(async () => { const a = Date.now(); try { await fetch(BASE + '/api/hello'); lat.push(Date.now() - a); } catch (e) { lat.push(99999); } }, 500);
async function rpc(tok, channel, args) {
  const r = await fetch(BASE + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ channel, args }) });
  const j = await r.json(); if (!j.ok) throw new Error(channel + ': ' + j.error); return j.data;
}
async function person(i) {
  const out = { i, steps: {} };
  const step = async (name, fn) => { const a = Date.now(); const v = await fn(); out.steps[name] = Date.now() - a; return v; };
  const login = await step('signup', async () => (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ create: true, code: 'test-code-1234', name: `Load Person ${i} ${Date.now() % 100000}`, password: 'secret-' + i, remember: true }) })).json());
  if (!login.token) throw new Error('signup: ' + JSON.stringify(login));
  const tok = login.token, H = { Authorization: 'Bearer ' + tok };
  const name = `sermon-person${i}.mp4`;
  const up = await step('upload', async () => (await fetch(`${BASE}/api/upload?name=${name}&id=u${i}x${Date.now()}&size=${SRC.length}&offset=0`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, H), body: SRC })).json());
  if (!up.path) throw new Error('upload: ' + JSON.stringify(up));
  const info = await step('info', () => rpc(tok, 'video:info', { input: up.path }));
  await step('thumb', () => rpc(tok, 'video:thumbnail', { input: up.path, timeSec: 2 }));
  await step('project', () => rpc(tok, 'session:save', { id: null, name: 'Project of person ' + i, data: { video: { path: up.path, durationSec: info.durationSec }, timeline: { segments: [{ id: 'a', start: 1, end: 6, ai: true }] } } }));
  const mine = await step('files', async () => (await fetch(BASE + '/api/videos', { headers: H })).json());
  const seen = mine.groups.flatMap((g) => g.files.map((f) => f.name));
  out.othersSeen = seen.filter((n) => /sermon-person\d+\.mp4/.test(n) && !n.endsWith('-' + name)).length;
  const projects = await rpc(tok, 'session:list', {});
  out.othersProjects = projects.filter((p) => p.name !== 'Project of person ' + i).length;
  const outFile = await step('export', () => rpc(tok, 'video:trim', { input: up.path, startSec: 1, endSec: 9 }));
  out.exportOk = !!outFile && fs.existsSync(outFile) && fs.statSync(outFile).size > 10000;
  out.exportInOwnSpace = outFile && !/person/.test(outFile) ? outFile.split('/').slice(-3, -1).join('/') : outFile;
  return out;
}
(async () => {
  console.log(`${N} people start at once…`);
  const res = await Promise.allSettled(Array.from({ length: N }, (_, i) => person(i + 1)));
  clearInterval(sampler); clearInterval(pinger);
  const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const bad = res.filter((r) => r.status === 'rejected').map((r) => String(r.reason && r.reason.message || r.reason));
  console.log(`finished in ${sec()} s · ${ok.length}/${N} people completed everything` + (bad.length ? ' · FAILURES: ' + bad.join(' | ') : ''));
  const q = (k) => { const v = ok.map((o) => o.steps[k]).sort((a, b) => a - b); return v.length ? `median ${(v[v.length >> 1] / 1000).toFixed(1)}s, slowest ${(v[v.length - 1] / 1000).toFixed(1)}s` : '-'; };
  for (const k of ['signup', 'upload', 'info', 'thumb', 'project', 'files', 'export']) console.log(`  ${k.padEnd(8)} ${q(k)}`);
  console.log(`  exports good: ${ok.filter((o) => o.exportOk).length}/${ok.length}`);
  console.log(`  anyone seeing someone else's files: ${ok.filter((o) => o.othersSeen).length} · projects: ${ok.filter((o) => o.othersProjects).length}`);
  const l = lat.slice().sort((a, b) => a - b);
  console.log(`  server answering while busy: median ${l[l.length >> 1]} ms, worst ${l[l.length - 1]} ms (${l.length} pings)`);
  console.log(`  peak memory, server + everything it ran: ${Math.round(peak / 1024)} MB · most ffmpegs at once: ${peakFf}`);
  process.exit(0);
})();
