'use strict';
/*
 * THE HOUSE STYLE for "✨ Write the title & caption for me".
 *
 * The operator did not ask for "better copy"; they gave a specification, in the
 * form of a dozen worked examples and a short list of things never to do again.
 * That list is what this file checks, and it checks it on BOTH paths — the
 * rules that run when no model is installed, and a stand-in model that answers
 * with every one of those mistakes in it. The standard has to be enforced on
 * the way OUT, not merely requested on the way in.
 *
 *   node test/social-copy-house.test.js
 */
const c = require('../src/main/social-copy');

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); ok ? pass++ : fail++; };

const EVENT = 'All Ireland Outpouring';
const SPEAKERS = ['Bishop Francis Wale Oke', 'Pastor John Ahern', 'Bishop David Richman'];
const TRANSCRIPT = 'The youth of Europe will come to Christ and serve the Lord. '
  + 'Bishop Oke declares that God is pouring out his spirit upon all flesh, young and old, male and female. '
  + 'Empty altars will be restored across this continent and revival will break out in this generation.';
const AHERN = 'We must contend earnestly for the faith once delivered to the saints. '
  + 'Pastor Ahern calls the church to stand in the gap and preach the pure gospel without compromise. '
  + 'Many are in the valley of decision searching for hope and truth today.';

const EM_DASH = /[—–]/;

(async () => {
  console.log('\n[1] Three options, one per platform voice');
  const out = await c.suggest({ mediaPath: 'short-The_youth_of_Europe.mp4', eventName: EVENT, speakers: SPEAKERS, transcript: TRANSCRIPT });
  check('there are three of them', out.options.length === 3, out.options.length + '');
  check('they are labelled the way an editor labels them',
    out.options.map((o) => o.label).join(' | ') === 'Bold & Visionary | High-Energy & Prophetic | Deep & Inspiring',
    out.options.map((o) => o.label).join(' | '));
  check('each names the platforms it is for',
    out.options.every((o) => o.platforms && o.platforms.length > 5),
    out.options.map((o) => o.platforms).join(' / '));
  check('the first one is also in title/caption, so the button still just works',
    out.title === out.options[0].title && out.caption === out.options[0].caption);

  console.log('\n[2] The two facts every caption needs');
  check('every caption names the event', out.options.every((o) => o.caption.includes(EVENT)),
    out.options.map((o) => (o.caption.includes(EVENT) ? 'yes' : 'NO')).join(' '));
  check('every caption names the speaker', out.options.every((o) => o.caption.includes('Bishop Francis Wale Oke')));
  check('the speaker was worked out from the words, not guessed',
    out.speaker === 'Bishop Francis Wale Oke', out.speaker);
  const other = await c.suggest({ mediaPath: 'x.mp4', eventName: EVENT, speakers: SPEAKERS, transcript: AHERN });
  check('a different preacher in the clip is credited instead',
    other.speaker === 'Pastor John Ahern', other.speaker);
  check('and with several speakers configured and none of them named, nobody is invented',
    (await c.suggest({ mediaPath: 'x.mp4', speakers: SPEAKERS, transcript: 'God is good all the time and his mercy endures for ever and ever.' })).speaker === '');

  console.log('\n[3] Hashtags');
  const tags = out.options.map((o) => (o.caption.match(/#[A-Za-z0-9]+/g) || []));
  check('every option ends in a line of them — five at most (what Instagram and Threads take)', tags.every((t) => t.length >= 3 && t.length <= 5), tags.map((t) => t.length).join(', '));
  check('the speaker is the first one', tags.every((t) => t[0] === '#BishopFrancisWaleOke'), tags[0][0]);
  check('(the speaker\'s tag stands for the post; the event\'s is used when no speaker is named)', tags.every((t) => !t.includes('#AllIrelandOutpouring')));
  check('they are about what was actually said',
    tags[0].some((t) => /Revival|Awakening|Youth|Outpouring/i.test(t)), tags[0].join(' '));
  check('never more than nine', tags.every((t) => t.length <= 9), tags.map((t) => t.length).join(', '));

  console.log('\n[4] The things never to do again');
  const all = out.options.map((o) => o.title + '\n' + o.caption).join('\n');
  check('no em dash or en dash anywhere', !EM_DASH.test(all),
    EM_DASH.test(all) ? JSON.stringify(all.slice(all.search(EM_DASH) - 30, all.search(EM_DASH) + 30)) : '');
  check('no #SermonClip', !/#sermonclip/i.test(all));
  check('no #fyp, #viral or #trending', !/#(fyp|viral|trending)/i.test(all));
  check('no asking for engagement', !/drop an? \w+ in the comments|type \w+ in the comments|comment \w+ below/i.test(all), '');

  console.log('\n[5] The same standard is imposed on a model that ignores it');
  // A stand-in model that makes every mistake at once.
  const sloppy = {
    isAvailable: async () => true,
    parseJson: (t) => JSON.parse(t),
    chat: async () => JSON.stringify({
      options: [
        { title: 'A Word For You — Watch This', caption: 'God is moving today — powerfully.\n\nDrop an AMEN in the comments if you receive it!\n\n#faith #SermonClip #fyp #viral' },
        { title: 'Big Things Coming — Really', caption: 'Something is shifting.\n\nType AMEN in the comments below!\n\n#jesus #SermonClip #trending' },
        { title: 'He Is Faithful — Always', caption: 'A reflection on grace.\n\n#church #SermonClip' },
      ],
    }),
  };
  const fixed = await c.suggest({ mediaPath: 'x.mp4', eventName: EVENT, speakers: SPEAKERS, transcript: TRANSCRIPT, llm: sloppy });
  const fixedAll = fixed.options.map((o) => o.title + '\n' + o.caption).join('\n');
  check('it came back through the model', fixed.source === 'ai', fixed.source);
  check('its em dashes are gone', !EM_DASH.test(fixedAll),
    EM_DASH.test(fixedAll) ? JSON.stringify(fixedAll.slice(fixedAll.search(EM_DASH) - 25, fixedAll.search(EM_DASH) + 25)) : '');
  check('its #SermonClip is gone', !/#sermonclip/i.test(fixedAll));
  check('its #fyp / #viral / #trending are gone', !/#(fyp|viral|trending)/i.test(fixedAll));
  check('its engagement bait is gone', !/AMEN in the comments/i.test(fixedAll),
    /AMEN in the comments/i.test(fixedAll) ? fixedAll.slice(fixedAll.search(/AMEN in the comments/i) - 30, fixedAll.search(/AMEN in the comments/i) + 20) : '');
  check('the event it forgot to mention was put back',
    fixed.options.every((o) => o.caption.includes(EVENT)),
    fixed.options.map((o) => (o.caption.includes(EVENT) ? 'yes' : 'NO')).join(' '));
  check('and the wording it DID get right survived',
    /God is moving today/.test(fixed.options[0].caption), fixed.options[0].caption.split('\n')[0]);

  console.log('\n[6] Asking for engagement, when it is actually wanted');
  const bait = await c.suggest({ mediaPath: 'x.mp4', eventName: EVENT, speakers: SPEAKERS, transcript: TRANSCRIPT, allowBait: true, llm: sloppy });
  check('the setting lets it through', /AMEN in the comments/i.test(bait.options.map((o) => o.caption).join('\n')));
  check('but the other rules still hold', !/#sermonclip/i.test(bait.options.map((o) => o.caption).join('\n')));

  console.log('\n[7] The prompt says all of it out loud');
  const prompt = c.buildPrompt({ hook: 'A word', kind: 'video', eventName: EVENT, speaker: 'Bishop Francis Wale Oke', transcript: TRANSCRIPT });
  for (const must of ['All Ireland Outpouring', 'em dash', '#SermonClip', 'Drop an AMEN', 'British spelling', 'Bold & Visionary', 'High-Energy & Prophetic', 'Deep & Inspiring']) {
    check('the prompt states: ' + must, prompt.includes(must));
  }

  console.log('\n[8] It never falls over');
  const bare = await c.suggest({ mediaPath: 'clip.mp4' });
  check('no event, no speakers, no transcript: still three usable options',
    bare.options.length === 3 && bare.options.every((o) => o.title.length > 3 && o.caption.length > 30));
  check('and it invents neither an event nor a speaker',
    !/undefined|null|\[object/.test(bare.options.map((o) => o.title + o.caption).join(' ')));

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
