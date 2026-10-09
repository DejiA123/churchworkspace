'use strict';
/*
 * ONE WORD BOOK FOR THE WHOLE CHURCH (wordbook.js):
 *   [1] the books people had of their own are folded into the church's, once
 *   [2] a name anyone teaches is in everyone's captions
 *
 *   node test/wordbook-shared.test.js
 */
const fs = require('fs'), os = require('os'), path = require('path');
const space = require(path.join(__dirname, '..', 'src/main/space'));
const wordbook = require(path.join(__dirname, '..', 'src/main/wordbook'));
let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${m}${d != null && !c ? '  -> ' + JSON.stringify(d) : ''}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-wb-shared-'));
const own = path.join(dir, 'spaces', 'demo1234', 'wordbook');
fs.mkdirSync(own, { recursive: true });
fs.writeFileSync(path.join(own, 'word-book.json'), JSON.stringify({ version: 99, terms: [{ text: 'Olayinka' }], fixes: [{ from: 'mireya', to: 'Mirella', src: 'user' }] }));
fs.writeFileSync(path.join(dir, 'word-book.json'), JSON.stringify({ version: 99, terms: [{ text: 'Adeboye' }], fixes: [{ from: 'mireya', to: 'Maria', src: 'user' }] }));

console.log('\n[1] folded in, once');
space.init(dir);
wordbook.init(dir);
let v = wordbook.view();
const terms = () => wordbook.view().terms.map((t) => t.text).sort().join();
ok(terms() === 'Adeboye,Olayinka', 'the church book has its own names and the team\'s', terms());
ok(v.fixes.filter((f) => f.from === 'mireya').length === 1 && v.fixes.find((f) => f.from === 'mireya').to === 'Maria', 'a correction the church book already had keeps the church\'s');
wordbook.flushSync();
wordbook.init(dir);
ok(terms() === 'Adeboye,Olayinka', 'not folded in a second time', terms());

console.log('\n[2] everyone reads and teaches the same book');
space.run('demo1234', () => { wordbook.addTerm('Zebedee'); });
ok(terms().includes('Zebedee'), 'a name a team member teaches is in the owner\'s captions');
let seen = '';
space.run('other999', () => { seen = wordbook.view().terms.map((t) => t.text).join(); });
ok(seen.includes('Zebedee') && seen.includes('Olayinka'), 'and in everyone else\'s', seen);
const r = space.run('other999', () => wordbook.apply([{ text: 'Mireya', start: 0, end: 0.5 }]));
ok(r.entries[0].text === 'Maria', 'corrections apply for everyone too', r.entries);

console.log('\n[3] a book that learned rewrites is cleaned the next time it opens');
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-wb-clean-'));
  const L = (from, to) => ({ from, to, src: 'learned', on: true });
  fs.writeFileSync(path.join(d2, 'word-book.json'), JSON.stringify({ version: 2, folded: true, terms: [], fixes: [
    L('in the', 'on the'), L('we are', 'we have been'), L('it is', 'meetings'), L('to god', 'to Galway'), L('satan', 'shout'),
    L('galilee', 'Galway'), L('yahweh', 'god'), L('the waliwke', 'Daddy Wale oke'), L('cardiffa', 'Cardava'),
    { from: 'peel the music', to: 'play the music', src: 'user' }] }));
  space.init(d2);
  wordbook.init(d2);
  const left = wordbook.view().fixes.map((f) => f.from).sort().join(', ');
  ok(left === 'cardiffa, peel the music, the waliwke', 'only the mishearings and what a person typed are left', left);
  const r = wordbook.apply('we are in the house of god'.split(' ').map((t, i) => ({ text: t, start: i, end: i + 0.5 })));
  ok(r.entries.map((w) => w.text).join(' ') === 'we are in the house of god', 'ordinary sentences come out as heard', r.entries.map((w) => w.text).join(' '));
  wordbook.flushSync();
  fs.rmSync(d2, { recursive: true, force: true });
}

wordbook.flushSync();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
