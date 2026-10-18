'use strict';
/*
 * "Show me around" for the desktop window — one short tour per room.
 *
 * The screens say what things are in a word or two and nothing more; these
 * tours are where the few plain sentences live (src/renderer/guide.js runs
 * them). Each room's header gets a ? that starts its own tour, the sidebar's
 * Help opens all of them as big tiles, and Home shows a one-time
 * "👋 New here? Show me around".
 */
(function () {
  const G = window.MWGuide;
  if (!G) return;
  const $ = (s) => document.querySelector(s);
  const open = (view) => () => { if (typeof goto === 'function') goto(view); };

  G.register('home', {
    title: 'Find your way', emoji: '🧭', before: open('dashboard'),
    steps: [
      { emoji: '👋', title: 'Welcome!', body: 'Here is a quick look around. It takes one minute.' },
      { target: '.nav', emoji: '🗂️', title: 'Every room', body: 'Pick a room here. Home brings you back.' },
      { target: '.dash-tile.t-present', emoji: '📖', title: 'Show slides', body: 'Bible verses and song words on the big screen.' },
      { target: '.dash-tile.t-video', emoji: '🎬', title: 'Make a video', body: 'Edit the sermon, make shorts, add captions.' },
      { target: '.dash-tile.t-flyer', emoji: '🎨', title: 'Make a flyer', body: 'Pick a design, type your event, save it.' },
      { target: '.dash-tile.t-live', emoji: '🔴', title: 'Go live', body: 'Stream or record the service.' },
      { target: '.dash-tile.t-posts', emoji: '📅', title: 'Post online', body: 'Send videos and flyers to social media.' },
      { target: '#openHelp', emoji: '❓', title: 'Need help?', body: 'Tap Help any time to see these tips again.' },
    ],
  });

  G.register('present', {
    title: 'Show slides', emoji: '📖', before: open('present'),
    steps: [
      { target: '#pvLibList || .pv-rail', emoji: '📚', title: 'Your songs', body: 'Pick a song or slides from the list.' },
      { target: '#pvSlides', emoji: '🖼️', title: 'Click a slide', body: 'Click a slide to show it.' },
      { target: '#pvGo', emoji: '▶️', title: 'Go Live', body: 'This puts it on the big screen.' },
      { target: '#pvPrev || #pvNext', emoji: '⏭️', title: 'Next slide', body: 'Move back and forward. Arrow keys work too.' },
      { target: '#pvBlack', emoji: '⬛', title: 'Clear screen', body: 'Make the screen dark in one click.' },
      { target: '#pvTabBible', emoji: '✝️', title: 'Bible verses', body: 'Type a verse like John 3:16 and press Find.' },
      { target: '#pvAudience', emoji: '📽️', title: 'Projector', body: 'Turn the projector picture on or off.' },
    ],
  });

  G.register('video', {
    title: 'Make a video', emoji: '🎬', before: open('video'),
    steps: [
      { target: '#veOpen', emoji: '📂', title: 'Open a video', body: 'Start here. Pick a sermon or any video.' },
      { target: '#veFindHighlights', emoji: '✨', title: 'Generate Shorts', body: 'The AI finds the best short clips for you.' },
      { target: '#veAutoCaptions || #veInspTabCaptions', emoji: '💬', title: 'Captions', body: 'Add words on the video automatically.' },
      { target: '#veTimeline', emoji: '✂️', title: 'Timeline', body: 'Your video, from start to end. Drag to trim.' },
      { target: '#veExportEdited || #veExportAll', emoji: '💾', title: 'Save it', body: 'Save your finished video to the computer.' },
    ],
  });

  G.register('flyer', {
    title: 'Make a flyer', emoji: '🎨', before: open('flyer'),
    steps: [
      { target: '#edRail', emoji: '🧩', title: 'Pick things', body: 'Designs, text, photos and shapes live here.' },
      { target: '#edStageWrap || #edStage', emoji: '🖌️', title: 'Your flyer', body: 'Click anything on it to change it.' },
      { target: '#edInspector', emoji: '🎛️', title: 'Change it', body: 'Colours and sizes for what you picked.' },
      { target: '#edExport', emoji: '💾', title: 'Save it', body: 'Save the flyer as a picture.' },
      { target: '#edSchedule', emoji: '📅', title: 'Post it', body: 'Send it to social media.' },
    ],
  });

  G.register('live', {
    title: 'Go live', emoji: '🔴', before: open('live'),
    steps: [
      { target: '#vmxAddInput', emoji: '➕', title: 'Add a camera', body: 'Add cameras, videos, pictures or titles.' },
      { target: '#vmxInputs', emoji: '🎥', title: 'Pick one', body: 'Click one to get it ready.' },
      { target: '#vmxCut', emoji: '🎬', title: 'Show it', body: 'Puts the ready one on air.' },
      { target: '#vmxRecord', emoji: '⏺️', title: 'Record', body: 'Save the service to the computer.' },
      { target: '#vmxStream', emoji: '📡', title: 'Go Live', body: 'Stream to YouTube or Facebook.' },
    ],
  });

  G.register('scheduler', {
    title: 'Post online', emoji: '📅', before: open('scheduler'),
    steps: [
      { target: '#connectAccount', emoji: '🔗', title: 'Link accounts', body: 'Do this once: link Instagram, TikTok and more.' },
      { target: '#pickPostMedia', emoji: '🖼️', title: 'Pick a video', body: 'Choose the video or flyer to post.' },
      { target: '#sWriteForMe', emoji: '✍️', title: 'Write for me', body: 'The AI writes the words for your post.' },
      { target: '#sDate', emoji: '🕒', title: 'Pick a time', body: 'Choose when it goes out.' },
      { target: '#addPost', emoji: '✅', title: 'Plan it', body: 'Done! It posts by itself at that time.' },
    ],
  });

  G.register('settings', {
    title: 'Settings', emoji: '⚙️', before: open('settings'),
    steps: [
      { target: '#setChurchName', emoji: '⛪', title: 'Church name', body: 'Type your church name here.' },
      { target: '#saveSettings', emoji: '💾', title: 'Save', body: 'Press Save when you change something.' },
    ],
  });

  // A ? in each room's header; Help in the sidebar; the one-time hello on Home.
  const ROOMS = { dashboard: 'home', present: 'present', video: 'video', flyer: 'flyer', live: 'live', scheduler: 'scheduler', settings: 'settings' };
  function mount() {
    const helpBtn = $('#openHelp');
    if (helpBtn) helpBtn.addEventListener('click', () => G.openHelp());
    const ask = $('#dashAsk');
    if (ask && !ask.firstChild) ask.appendChild(G.helpButton('home', { title: 'Show me around' }));
    // where each room's ? goes: its header, or the end of its own toolbar
    // (Go Live already has its own ? for the board's keys; F1 and Help run its tour)
    const SLOTS = { present: '#view-present .pv-tb-right', video: '#view-video .ve-top-actions', flyer: '#view-flyer .ed-toolbar',
      scheduler: '#view-scheduler .view-head', settings: '#view-settings .view-head' };
    for (const [view, sel] of Object.entries(SLOTS)) {
      const slot = $(sel);
      if (slot && !slot.querySelector('.mwg-ask')) slot.appendChild(G.helpButton(ROOMS[view], { title: 'Show me around', className: 'view-ask' }));
    }
    const inv = $('#dashInvite');
    if (inv) G.invite('home', inv);
    // F1 = help for the room on screen
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'F1') return;
      e.preventDefault();
      const v = document.querySelector('.view.active');
      const id = v && ROOMS[v.id.replace(/^view-/, '')];
      if (id) G.start(id); else G.openHelp();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
