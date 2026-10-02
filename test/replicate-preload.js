'use strict';
/* The slice of the studio's `window.api` that the tracker and the caption
 * rasteriser actually reach for. Same call names, same shapes. */
const { ipcRenderer } = require('electron');
const unwrap = (r) => { if (r && r.ok === false) throw new Error(r.error || 'failed'); return r && Object.prototype.hasOwnProperty.call(r, 'data') ? r.data : r; };
const call = (ch, a) => ipcRenderer.invoke(ch, a).then(unwrap);
window.api = {
  captions: { fontList: () => call('captions:fontList') },
  fonts: { data: () => call('fonts:data') },
  frames: { write: (a) => call('frames:write', a) },
  sermon: {
    extractFrames: (a) => call('sermon:extractFrames', a),
    rmdir: () => Promise.resolve(),
  },
};
