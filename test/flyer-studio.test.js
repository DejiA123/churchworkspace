'use strict';
/*
 * THE FLYER STUDIO (Home → Flyers) — what can be checked without a browser:
 *
 *   [A] the dates   — the next Tuesday / Friday / Sunday from any day, today
 *                     only while the service has not started, Easter and the
 *                     church year on the right days, dates printed flyer-style
 *   [B] the kit     — the church's details, speakers with picture BANKS (new
 *                     pictures in, old ones kept, removed ones deleted), the
 *                     service days (10am Sunday, 7pm Tuesday and Friday by
 *                     default, every one editable), which picture went last
 *   [C] the board   — inspiration in and out, its colours used without an AI
 *   [D] direction   — the rules pick a look, colours and real photographs for
 *                     an event with no AI at all; pictures are sized for HD
 *   [E] the wiring  — the page loads the studio, the browser may call its
 *                     channels, the photographs are served and nothing else is
 *
 *   node test/flyer-studio.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failed = 0, passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); }
}

(async () => {
  const D = require('../src/cloud/web/cloud-flyer.js');
  const fa = require('../src/main/flyerart.js');

  console.log('[A] dates');
  await t('next weekday: Tuesday from a Monday is the next day', () => {
    const d = D.nextWeekday(2, new Date(2026, 9, 12, 9, 0));   // Mon 12 Oct 2026
    assert.strictEqual(d.getDate(), 13); assert.strictEqual(d.getDay(), 2);
  });
  await t('today, while the service has not finished; next week once it has', () => {
    assert.strictEqual(D.nextWeekday(2, new Date(2026, 9, 13, 15, 0), '7:00PM').getDate(), 13);
    assert.strictEqual(D.nextWeekday(2, new Date(2026, 9, 13, 21, 0), '7:00PM').getDate(), 20);
  });
  await t('Easter is right for several years', () => {
    const iso = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    assert.strictEqual(iso(D.easter(2024)), '2024-3-31');
    assert.strictEqual(iso(D.easter(2025)), '2025-4-20');
    assert.strictEqual(iso(D.easter(2026)), '2026-4-5');
    assert.strictEqual(iso(D.easter(2027)), '2027-3-28');
  });
  await t('the church year: Good Friday, Pentecost, Mothering Sunday, Christmas, Crossover', () => {
    const s = Object.fromEntries(D.seasons(2026).map((x) => [x.id, x.date]));
    assert.strictEqual(s.goodfriday.getDate(), 3); assert.strictEqual(s.goodfriday.getMonth(), 3);
    assert.strictEqual(s.pentecost.getDate(), 24); assert.strictEqual(s.pentecost.getMonth(), 4);
    assert.strictEqual(s.mothering.getDate(), 15); assert.strictEqual(s.mothering.getMonth(), 2);
    assert.strictEqual(s.christmas.getDate(), 25); assert.strictEqual(s.crossover.getDate(), 31);
    assert.strictEqual(s.carol.getDay(), 0); assert.ok(s.carol < s.christmas);
  });
  await t('upcoming: the weekly services at their next dates, big days only when near, soonest first', () => {
    const kit = { services: [{ id: 'sun', day: 0, name: 'Sunday Service', time: '10:00AM' }, { id: 'tue', day: 2, name: 'Bible Study', time: '7:00PM' }, { id: 'fri', day: 5, name: 'Prayer Meeting', time: '7:00PM' }] };
    const up = D.upcoming(kit, new Date(2026, 9, 13, 9));
    assert.deepStrictEqual(up.slice(0, 3).map((o) => o.name), ['Bible Study', 'Prayer Meeting', 'Sunday Service']);
    assert.ok(up.some((o) => o.id.startsWith('season:carol')), 'the carol service is within ten weeks');
    assert.ok(!up.some((o) => /easter/.test(o.id)), 'Easter is months away');
    const lent = D.upcoming(kit, new Date(2026, 2, 20, 9));
    assert.ok(lent.some((o) => /season:easter/.test(o.id)) && lent.some((o) => /season:goodfriday/.test(o.id)));
  });
  await t('dates and times the way flyers print them', () => {
    const p = D.dateParts(new Date(2026, 9, 18, 12));
    assert.strictEqual(p.dd, '18TH'); assert.strictEqual(p.month, 'OCTOBER'); assert.strictEqual(p.day, 'SUNDAY'); assert.strictEqual(p.iso, '2026-10-18');
    assert.deepStrictEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(D.ordinal), ['1ST', '2ND', '3RD', '4TH', '11TH', '12TH', '13TH', '21ST', '22ND', '23RD']);
    assert.strictEqual(D.niceTime('7pm'), '7PM'); assert.strictEqual(D.niceTime('18:30'), '6:30PM');
    assert.strictEqual(D.niceTime('10am'), '10AM'); assert.strictEqual(D.niceTime('6pm - 9pm'), '6PM – 9PM');
  });

  console.log('[B] the kit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-flyerkit-'));
  fa.init(dir);
  const png = (n) => 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from([n])]).toString('base64');
  await t('a new kit has the three services at 10am Sunday, 7pm Tuesday and Friday', () => {
    const k = fa.kitGet();
    assert.deepStrictEqual(k.services.map((s) => [s.day, s.name, s.time]), [[0, 'Sunday Service', '10:00AM'], [2, 'Bible Study', '7:00PM'], [5, 'Prayer Meeting', '7:00PM']]);
  });
  let k;
  await t('speakers keep a bank of pictures; new ones in, kept ones kept, removed ones deleted', () => {
    k = fa.kitSave({ church: 'Grace Covenant', address: '144 Airport Road', services: fa.kitGet().services, speakers: [{ id: 'dr', name: 'Bishop David Richman', photos: [png(1), png(2), png(3)] }] });
    assert.strictEqual(k.speakers[0].photos.length, 3);
    assert.ok(k.speakers[0].photos.every((n) => /^speaker-[\w-]+\.png$/.test(n)));
    const keep = k.speakers[0].photos.slice(1);
    k = fa.kitSave(Object.assign({}, k, { speakers: [{ id: 'dr', name: 'Bishop David Richman', photos: keep.concat(png(4)) }] }));
    assert.strictEqual(k.speakers[0].photos.length, 3);
    assert.deepStrictEqual(k.speakers[0].photos.slice(0, 2), keep);
    const files = fs.readdirSync(path.join(dir, 'flyer-kit')).filter((n) => n !== 'kit.json');
    assert.strictEqual(files.length, 3, 'the removed picture is gone from the disk');
  });
  await t('a bulk add stores each photo as it comes, even for a speaker not saved yet', () => {
    const a = fa.kitAddPhoto({ speaker: 'new1', name: 'Pst. Grace', dataUrl: png(7) });
    const b = fa.kitAddPhoto({ speaker: 'new1', dataUrl: png(8) });
    const sp = fa.kitGet().speakers.find((x) => x.id === 'new1');
    assert.deepStrictEqual(sp.photos, [a, b]); assert.strictEqual(sp.name, 'Pst. Grace');
    assert.throws(() => fa.kitAddPhoto({ speaker: 'nobody', dataUrl: png(1) }));
    k = fa.kitGet();
  });
  await t('a picture comes back by its name, and nothing outside the kit does', () => {
    assert.ok(fa.kitPic(k.speakers[0].photos[0]).startsWith('data:image/png;base64,'));
    assert.throws(() => fa.kitPic('../kit.json'));
    assert.throws(() => fa.kitPic('kit.json'));
  });
  await t('which picture a flyer used last is remembered', () => {
    fa.kitUsed({ speaker: 'dr', photo: k.speakers[0].photos[1] });
    assert.strictEqual(fa.kitGet().speakers[0].last, k.speakers[0].photos[1]);
  });
  await t('service days are the church’s own: added, renamed, removed', () => {
    const svc = [{ id: 'wed', day: 3, name: 'Midweek Service', time: '6:30PM' }, { id: 'sun', day: 0, name: 'Celebration Service', time: '9:00AM', speaker: 'dr' }];
    const out = fa.kitSave(Object.assign({}, fa.kitGet(), { services: svc }));
    assert.deepStrictEqual(out.services.map((s) => s.name), ['Midweek Service', 'Celebration Service']);
    assert.strictEqual(out.services[1].speaker, 'dr');
    assert.strictEqual(fa.kitSave(Object.assign({}, out, { services: [{ day: 9, name: 'x' }] })).services.length, 0, 'a day that is not a day is dropped');
  });

  console.log('[C] the inspiration board');
  await t('a flyer goes on the board with its colours, and comes off again', async () => {
    const it = await fa.inspoAdd({ thumb: png(9), palette: ['#1a0602', '#c2410c', '#ffb300', '#fff3c4'] });
    assert.deepStrictEqual(fa.kitGet().inspo[0].palette, ['#1a0602', '#c2410c', '#ffb300', '#fff3c4']);
    fa.kitSave(fa.kitGet());   // saving the kit keeps the board
    assert.strictEqual(fa.kitGet().inspo.length, 1);
    fa.inspoRemove({ id: it.id });
    assert.strictEqual(fa.kitGet().inspo.length, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'flyer-kit', it.thumb)));
  });

  console.log('[D] direction without any AI');
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  await t('each kind of event gets its look, its colours and matching photographs', async () => {
    const bible = await fa.direct({ title: 'Bible Study', kind: 'Bible study' });
    assert.strictEqual(bible.looks[0], 'bible'); assert.strictEqual(bible.palette.length, 4);
    assert.ok(bible.photos.includes('bible-open.jpg'), bible.photos.join());
    const prayer = await fa.direct({ title: 'Prayer Meeting' });
    // a prayer meeting leads with the UPPER ROOM reference look; the gold prophetic one is still on offer
    assert.strictEqual(prayer.looks[0], 'upper'); assert.ok(prayer.looks.includes('prophetic'));
    assert.ok(prayer.photos.includes('praying-hands.jpg'), prayer.photos.join());
    const easter = await fa.direct({ title: 'Easter Sunday', season: 'Easter Sunday' });
    assert.strictEqual(easter.scriptWord, 'Easter');
    assert.ok(easter.looks.length >= 10, 'every look is on offer');
  });
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
  await t('pictures are asked for at HD sizes the models take', () => {
    const a = fa.sizeFor(1080, 1350), b = fa.sizeFor(1080, 1920);
    assert.ok(a.w * a.h >= 1.4e6 && a.w % 64 === 0 && a.h % 64 === 0, JSON.stringify(a));
    assert.ok(b.h <= 1472 && b.w % 64 === 0, JSON.stringify(b));
  });
  await t('the prompt asks for no words in the picture', () => {
    assert.ok(/no text/.test(fa.paintPrompt('light rays')));
  });

  console.log('[E] the wiring');
  await t('the cloud page loads the flyer studio, and its shell cache knows it', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'src/cloud/page.js'), 'utf8');
    const sw = fs.readFileSync(path.join(__dirname, '..', 'src/cloud/web/sw.js'), 'utf8');
    assert.ok(/cloud-flyer\.js\?v=/.test(page)); assert.ok(/cloud-flyer\.js/.test(sw));
  });
  await t('the browser may call the flyer channels; main registers every one', () => {
    const api = fs.readFileSync(path.join(__dirname, '..', 'src/cloud/cloud-api.js'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
    const boot = fs.readFileSync(path.join(__dirname, '..', 'src/cloud/web/cloud-boot.js'), 'utf8');
    for (const ch of ['status', 'direct', 'paint', 'kitGet', 'kitSave', 'kitPic', 'kitUsed', 'kitAddPhoto', 'inspoAdd', 'inspoRemove']) {
      assert.ok(api.includes(`'flyer:${ch}': true`), ch + ' allowed');
      assert.ok(main.includes(`ipcMain.handle('flyer:${ch}'`), ch + ' handled');
      assert.ok(boot.includes(`'flyer:${ch}'`), ch + ' in window.api');
    }
  });
  await t('only the named photographs are served', () => {
    assert.ok(fa.stockPath('fire-flames.jpg'));
    assert.strictEqual(fa.stockPath('../../main/main.js'), '');
    assert.strictEqual(fa.stockPath('CREDITS.md'), '');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
