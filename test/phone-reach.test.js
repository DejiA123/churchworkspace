'use strict';
/*
 * "THE PHONE STUDIO EDIT ON THE PHONE DOES NOT WORK EVEN IF I AM ON THE SAME
 *  NETWORK ON MY PHONE."
 *
 * The server was never the problem. It listens on 0.0.0.0, Windows Firewall had
 * an Allow rule for it, and the phone was on the same wifi. What was wrong was
 * the ADDRESS the operator was handed. Both servers listed every non-internal
 * IPv4 interface in whatever order Node happened to return them, and on the
 * church laptop that is six addresses:
 *
 *   192.168.56.1     VirtualBox host-only    unreachable from anywhere else
 *   172.31.80.1      Hyper-V Default Switch  unreachable
 *   169.254.x.x  x3  link-local (APIPA)      unroutable by definition
 *   192.168.8.100    WiFi                    the only one that works
 *
 * Five dead URLs and one live one, in no particular order. Anyone who has
 * installed Docker, WSL, VirtualBox, VMware or Hyper-V — which is most people
 * whose laptop also does video — gets a dead one first.
 *
 * This proves the picker on THIS machine's real interfaces, and then does what
 * the phone does: starts the real server and fetches the real page over the
 * real LAN address, from outside the loopback.
 *
 *   npm run test:phone-reach
 */
const os = require('os');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lan = require(path.join(ROOT, 'src/main/lan-address'));

let pass = 0, fail = 0;
const check = (n, v, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };
const skip = (n, d) => console.log('  SKIP  ' + n + (d ? '  -> ' + d : ''));
const head = (s) => console.log('\n' + s);

console.log('== CAN THE PHONE ACTUALLY REACH THIS COMPUTER? ==');

/* ==================== [1] the picker, on real interfaces ================== */
head('[1] Which address gets handed to the phone');

const raw = [];
const ifs = os.networkInterfaces();
for (const name of Object.keys(ifs)) {
  for (const i of ifs[name] || []) if (i.family === 'IPv4' && !i.internal) raw.push({ name, address: i.address });
}
console.log('    this machine really has ' + raw.length + ' non-internal IPv4 address(es):');
for (const r of raw) console.log('      ' + r.address.padEnd(16) + r.name);

const ranked = lan.candidates();
console.log('    after filtering and ranking:');
for (const c of ranked) console.log('      ' + c.address.padEnd(16) + 'score ' + String(c.score).padStart(4) + '  ' + c.name + (c.virtual ? '  [virtual]' : ''));

const linkLocal = raw.filter((r) => lan.isLinkLocal(r.address));
if (linkLocal.length) {
  check('link-local addresses are dropped — they can never be reached',
    !ranked.some((c) => lan.isLinkLocal(c.address)), linkLocal.length + ' dropped');
} else {
  skip('dropping link-local addresses', 'this machine has none right now');
}

if (ranked.length > 1) {
  check('a real network is ranked above every virtual adapter',
    !ranked[0].virtual, ranked[0].address + ' (' + ranked[0].name + ') beats ' + ranked[1].address);
  const virt = ranked.filter((c) => c.virtual);
  if (virt.length) {
    check('VirtualBox / Hyper-V style adapters are identified as virtual',
      virt.every((v) => v.score < 0), virt.map((v) => v.address).join(', '));
  } else skip('identifying virtual adapters', 'none on this machine');
} else if (ranked.length === 1) {
  skip('ranking', 'this machine has only one usable address — nothing to rank');
}
check('there is an address to give the phone at all', !!lan.best(), lan.best() && lan.best().address);
check('and no advice is needed when one is reachable', !lan.advice() || !ranked.length, lan.advice() || '(none)');

/* ================ [2] the phone's own request, over the LAN =============== */
head('[2] Fetching the page the way the phone does');

function get(url, timeout = 6000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 8000) body += d; });   // cap the total, never drop a chunk
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] || '' }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ error: 'timed out' }); });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

(async () => {
  const phone = require(path.join(ROOT, 'src/main/mobile-api'));
  const PORT = 7391;                       // not the default, so a running app is not disturbed
  let started = null;
  try {
    started = await phone.start({ port: PORT, allowUpload: true });
  } catch (e) {
    console.log('    could not start Phone Studio here: ' + e.message);
  }

  if (!started) {
    skip('the real fetch', 'Phone Studio would not start in this harness');
  } else {
    const urls = (started.urls || []).slice();
    console.log('    the app now offers: ' + (urls.join('  ') || '(none)'));
    check('the FIRST url offered is the reachable one, not a virtual adapter',
      !!urls.length && !!lan.best() && urls[0].includes(lan.best().address), urls[0] || '(none)');
    check('no unreachable link-local url is offered at all',
      !urls.some((u) => /169\.254\./.test(u)), urls.length + ' url(s)');

    // The real thing: fetch over the LAN IP, not over localhost. This is the
    // request the phone makes, and the one that was failing.
    const target = urls[0];
    if (target) {
      const r = await get(target);
      if (r.error) {
        check('THE PAGE LOADS OVER THE LAN ADDRESS — what the phone does', false, r.error
          + ' (if this is a timeout, Windows Firewall is blocking inbound on this port)');
      } else {
        check('THE PAGE LOADS OVER THE LAN ADDRESS — what the phone does',
          r.status === 200 && /html/i.test(r.type), 'HTTP ' + r.status + ' ' + r.type);
        check('and it is really the Phone Studio page', /phone|studio|<!doctype html/i.test(r.body || ''),
          (r.body || '').slice(0, 60).replace(/\s+/g, ' '));
      }
      // Localhost must keep working too — that is how the operator tests it.
      const local = await get('http://127.0.0.1:' + PORT);
      check('it still answers on this computer itself', !local.error && local.status === 200,
        local.error || ('HTTP ' + local.status));
    }
    try { await phone.stop(); } catch (e) {}
  }

  console.log(`\n  ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
