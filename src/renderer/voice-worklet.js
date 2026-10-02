/*
 * THE MICROPHONE END OF 🎤 LISTEN.
 *
 * All this does is hand the page fixed 32 ms blocks of mono samples along with
 * how loud each one was. It runs on the audio thread on purpose: the deciding
 * of where a phrase ends is done from these blocks, and if they arrived in
 * bursts because the main thread was busy laying out slides, the pauses in the
 * speech would appear in the wrong places and phrases would be cut in half.
 * (The same lesson as capture-audio-worklet.js, which was written after six
 * seconds in every ten of a sermon went missing off a main-thread reader.)
 *
 * The level travels with the samples so the page never has to touch the audio
 * to know whether anyone is talking.
 */
class VoiceEarProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const ms = Math.max(10, Math.min(200, Number(o.blockMs) || 32));
    this.size = Math.max(128, Math.round((ms * sampleRate) / 1000));
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.running = true;
    this.port.onmessage = (e) => { if (e.data && e.data.cmd === 'stop') this.running = false; };
  }

  process(inputs) {
    if (!this.running) return false;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) {
        let sum = 0;
        for (let k = 0; k < this.size; k++) sum += this.buf[k] * this.buf[k];
        const out = this.buf.slice(0);
        this.port.postMessage({ pcm: out, rms: Math.sqrt(sum / this.size) }, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-ear', VoiceEarProcessor);
