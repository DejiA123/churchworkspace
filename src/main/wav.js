'use strict';
/*
 * A 16-BIT MONO WAV HEADER, AND NOTHING ELSE.
 *
 * Two things now need to wrap raw PCM in a container — voicelisten.js writing a
 * phrase to disk for whisper-cli, and cloudspeech.js handing one to ffmpeg or
 * straight to an API — and they must produce byte-identical audio, because the
 * whole point of the cloud/local fallback is that the same seconds of sound go
 * to either engine and come back comparable. Two copies of a header this fiddly
 * is exactly how they would stop being identical.
 */

/** A 16-bit mono WAV around raw PCM, as a Buffer. No ffmpeg for something this small. */
function wavBuffer(pcm16, rate = 16000) {
  const bytes = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + bytes.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);            // PCM
  head.writeUInt16LE(1, 22);            // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);     // byte rate
  head.writeUInt16LE(2, 32);            // block align
  head.writeUInt16LE(16, 34);           // bits
  head.write('data', 36);
  head.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([head, bytes]);
}

module.exports = { wavBuffer };
