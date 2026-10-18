'use strict';
/*
 * A SHORT MADE ON THE SERVER IS CALLED BY ITS TITLE.
 *
 * "Can the name of the finished videos be the actual title of the video
 *  instead of 'Media Church Work Space media…'?" The server batch (Export all,
 * run on the server) gave the steps that name their file after the one before
 * it (music, sounds) that file's whole path, squashed into a name and cut at 60
 * characters: "/…/Media/Church Work Space/short-Ignore_The…" came out as
 * "Media_Church_Work_Space_…" with the title cut off. Now a name gets the
 * file's own name: no folder, no extension, no time stamp.
 *
 *   node test/batch-names.test.js
 */
const batch = require('../src/main/batch');
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (!ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };

const outs = [
  '/root/Media/Church Work Space/short-Ignore_The_Multitude_To_Find_Your_Destiny-20261018-053000.mp4',
  '/root/Media/Church Work Space/short-Ignore_The_Multitude_To_Find_Your_Destiny-captioned-20261018-053100-2.mp4',
];
const got = batch._fill({ input: '@@step-1@@.mp4', outName: '@@step-1@@', more: { outName: '@@step-0@@-logo' }, list: ['@@step-0@@.mp4'] }, outs);
check(got.input === outs[1] && got.list[0] === outs[0], 'a file the step works on is still the whole path', got);
check(got.outName === 'short-Ignore_The_Multitude_To_Find_Your_Destiny-captioned', 'a name is the file’s own name — the short’s title, no folder, no time stamp', got.outName);
check(got.more.outName === 'short-Ignore_The_Multitude_To_Find_Your_Destiny-logo', 'a name made from it ("…-logo") gets it too', got.more.outName);
check(!/Church|Media|\//.test(got.outName), 'no trace of the folders in the name', got.outName);
let threw = false; try { batch._fill({ outName: '@@step-5@@' }, outs); } catch (e) { threw = true; }
check(threw, 'a name from a file never made is refused, as a path is', threw);
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
