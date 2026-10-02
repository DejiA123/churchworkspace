'use strict';
const { spawn } = require('child_process');

/**
 * Stream / SRT input engine — pulls a network video source (RTMP, RTSP,
 * SRT, HTTP(S), UDP — anything ffmpeg's demuxers understand) and continuously
 * overwrites a single local JPEG file with the latest decoded frame. The
 * renderer polls that file into an <img>, the same trick IP cameras use for
 * MJPEG-over-HTTP, without needing to stand up an HTTP server or a container
 * muxer. Video only for now — see the UI note about audio.
 */
class NetStream {
  constructor() {
    this.proc = null;
    this.lastLog = '';
    this.onEvent = null; // (type, payload) => void  ('ended')
    this._stopping = false;
  }

  get running() { return !!this.proc; }

  start(ctx, { url, framePath, fps = 10 }) {
    if (this.proc) throw new Error('That network stream is already running — stop it first.');
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (/^rtsp:\/\//i.test(url)) args.push('-rtsp_transport', 'tcp');
    args.push(
      '-i', url, '-an',
      '-vf', `fps=${fps},scale=1280:-2`,
      '-q:v', '5', '-update', '1', '-y', framePath,
    );
    const proc = spawn(ctx.ffmpeg, args, { windowsHide: true });
    this.proc = proc;
    this._stopping = false;
    this.lastLog = '';

    proc.stderr.on('data', (d) => {
      this.lastLog += d.toString();
      if (this.lastLog.length > 20000) this.lastLog = this.lastLog.slice(-10000);
    });
    proc.on('error', (err) => {
      this.proc = null;
      if (this.onEvent) { try { this.onEvent('ended', { error: 'Could not start ffmpeg: ' + err.message }); } catch (e) {} }
    });
    proc.on('close', (code) => {
      const wasStopping = this._stopping;
      this.proc = null;
      if (this.onEvent) {
        const error = wasStopping || code === 0 ? null :
          'Could not read that stream. ' + (this.lastLog.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 220) || 'Check the URL and that it is reachable.');
        try { this.onEvent('ended', { code, error }); } catch (e) {}
      }
    });
  }

  stop() {
    return new Promise((resolve) => {
      const proc = this.proc;
      if (!proc) return resolve(true);
      this._stopping = true;
      const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 4000);
      proc.once('close', () => { clearTimeout(killTimer); resolve(true); });
      try { proc.kill(); } catch (e) { resolve(true); }
    });
  }
}

module.exports = { NetStream };
