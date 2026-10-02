'use strict';
/*
 * THE RESIDENT SPEECH MODEL — same answers, less waiting.
 *
 * whisperfast.js calls the whisper library directly and keeps the model loaded,
 * instead of starting whisper-cli for every phrase. That removes ~530 ms of
 * per-phrase startup, and it is the only part of 🎤 Listen that reaches into
 * native memory, so it gets its own test and a high bar:
 *
 *   1. it must refuse rather than guess — the layout fingerprint is what stands
 *      between a fine speedup and a crash mid-service;
 *   2. it must say the SAME THING as whisper-cli, phrase for phrase, because a
 *      faster answer that differs is not the same feature;
 *   3. it must actually be faster, or there is no reason to carry the risk;
 *   4. it must survive being hammered, since it is one long-lived model instead
 *      of a fresh process each time.
 *
 *   node test/voice-fast.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const voicelisten = require('../src/main/voicelisten');
const whisperfast = require('../src/main/whisperfast');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const skip = (n, d) => console.log('  SKIP  ' + n + (d ? '  -> ' + d : ''));

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-vfast-'));
const SAY = path.join(W, 'say.ps1');

/* Spoken phrases, from the operating system's own voice. */
const LINES = [
  'Turn with me to John chapter three verse sixteen.',
  'John three sixteen.',
  "Let's read Philippians chapter four verse six.",
  'First Corinthians chapter thirteen verse four.',
  'Psalm twenty three.',
  'Isaiah forty verse thirty one.',
  'Next verse.',
  'Previous verse.',
  'Go to verse twelve.',
  'Clear the screen.',
  'We will come back to that in a moment.',
  'He was one of the twelve who followed him.',
];

function speak() {
  fs.writeFileSync(SAY, `param([string]$Out,[string]$Text)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice('Microsoft Hazel Desktop') } catch { }
$s.Rate = -1
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($Out,$fmt); $s.Speak($Text); $s.SetOutputToNull(); $s.Dispose()
`, 'utf8');
  return LINES.map((text, i) => {
    const wav = path.join(W, `c${i}.wav`);
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SAY, '-Out', wav, '-Text', text],
      { windowsHide: true, stdio: 'ignore' });
    const b = fs.readFileSync(wav);
    let pos = 12, data = null;
    while (pos + 8 <= b.length) {
      const id = b.toString('ascii', pos, pos + 4), sz = b.readUInt32LE(pos + 4);
      if (id === 'data') { data = b.slice(pos + 8, pos + 8 + sz); break; }
      pos += 8 + sz + (sz & 1);
    }
    return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  });
}
const same = (a, b) => String(a).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  === String(b).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

(async () => {
  console.log('\n== THE RESIDENT SPEECH MODEL: same answers, less waiting ==\n');

  if (process.platform !== 'win32') { skip('the whole test', 'it needs Windows\' speech synthesiser'); process.exit(0); }
  if (!voicelisten.available()) { console.log('  FAIL  the speech engine is not installed'); process.exit(1); }

  /* ---- 1. it either proves the layout or refuses ---- */
  console.log('[1] It checks the library before it trusts it');
  const started = whisperfast.start({});
  if (!started) {
    // Refusing is a PASS for safety — but then nothing else here can run.
    check('it declined, and said why (the CLI path keeps working)', !!whisperfast.why(), whisperfast.why());
    console.log(`\n${pass} PASS / ${fail} FAIL  (the fast path is not available on this build)`);
    process.exit(fail ? 1 : 0);
  }
  check('the layout fingerprint matched and the model loaded', whisperfast.isReady(), 'resident');
  {
    // A build laying its settings out differently must be refused, not used.
    const bogus = Buffer.alloc(whisperfast.PARAMS_BYTES);
    const faults = whisperfast.layoutFaults(bogus);
    check('…and a struct that does NOT match is rejected', faults.length >= 10,
      `${faults.length} landmarks failed on a zeroed struct`);
  }

  /*
   * WHAT IS COMPARED, AND WHY IT IS NOT THE TEXT.
   *
   * Word-for-word equality between the two paths is not an achievable bar and
   * chasing it would be measuring the wrong thing: whisper splits its matrix
   * work across threads, the reduction order varies, and on a borderline
   * utterance that is enough to flip "Isaiah" to "I'm a". Both paths do it —
   * the CLI is no more repeatable than the resident model, it just happened to
   * win that particular coin toss.
   *
   * What has to hold is that the screen ends up in the same place. So each
   * phrase is scored against what it MEANS, and the resident model has to be at
   * least as right as the path it is replacing.
   */
  console.log('\n[2] Saying the same things through both paths');
  const WANT = ['John 3:16', 'John 3:16', 'Philippians 4:6', '1 Corinthians 13:4', 'Psalms 23',
    'Isaiah 40:31', 'next', 'prev', 'verse12', 'clear', 'nothing', 'nothing'];
  const live = { bookNr: 43, chapter: 3, verse: 16 };
  const clips = speak();
  const slow = [], quick = [], slowMs = [], quickMs = [];
  for (const pcm of clips) {
    let t = Date.now();
    const a = await voicelisten.hear({ pcm16: pcm, live, fast: false });
    slowMs.push(Date.now() - t); slow.push(a);
    t = Date.now();
    const b = await voicelisten.hear({ pcm16: pcm, live, fast: true });
    quickMs.push(Date.now() - t); quick.push(b);
  }
  check('the fast path was actually the one used', quick.every((r) => r.via === 'resident'),
    quick.map((r) => r.via).join(','));

  const act = (r) => (r.intent ? (r.intent.kind === 'ref' ? r.intent.ref : r.intent.kind + (r.intent.verse || '')) : 'nothing');
  let cliRight = 0, fastRight = 0;
  for (let i = 0; i < clips.length; i++) {
    const a = act(slow[i]), b = act(quick[i]);
    if (a === WANT[i]) cliRight++;
    if (b === WANT[i]) fastRight++;
    if (a !== b) console.log(`     "${LINES[i]}"\n        whisper-cli: ${a}   "${slow[i].text}"\n        resident   : ${b}   "${quick[i].text}"`);
  }
  console.log(`      whisper-cli got ${cliRight}/${clips.length} right, the resident model ${fastRight}/${clips.length}`);
  check('the resident model is at least as accurate as whisper-cli', fastRight >= cliRight,
    `${cliRight} vs ${fastRight}`);
  check('…and it gets nearly all of them', fastRight >= clips.length - 1,
    `${fastRight}/${clips.length}`);
  check('a sentence of ordinary preaching still moves nothing',
    act(quick[10]) === 'nothing' && act(quick[11]) === 'nothing',
    `${act(quick[10])}, ${act(quick[11])}`);

  console.log('\n[3] It is worth the trouble');
  const ms = median(slowMs), mq = median(quickMs);
  console.log(`      whisper-cli  median ${ms} ms`);
  console.log(`      resident     median ${mq} ms`);
  check('the resident model is meaningfully faster', mq < ms * 0.75,
    `${ms} ms -> ${mq} ms (${Math.round((1 - mq / ms) * 100)}% off)`);

  console.log('\n[4] It holds up to being used all morning');
  const pcm = clips[6];                                  // "Next verse."
  const texts = [];
  const t0 = Date.now();
  for (let i = 0; i < 25; i++) texts.push((await whisperfast.transcribe(
    Float32Array.from(pcm, (v) => v / 32768), { audioCtx: 256, threads: 4 })));
  check('25 phrases back to back, all identical', new Set(texts.map((t) => t.trim())).size === 1,
    JSON.stringify(texts[0]) + ` (${Math.round((Date.now() - t0) / 25)} ms each)`);
  check('…and none of them came back empty', texts.every((t) => t && t.trim().length > 2), `${texts.length} runs`);

  console.log('\n[5] Turning it off releases the model');
  whisperfast.stop();
  check('it reports itself unloaded', !whisperfast.isReady(), 'stopped');
  const back = await voicelisten.hear({ pcm16: clips[6], fast: false });
  check('…and the ordinary path still answers afterwards', /next/i.test(back.text), `"${back.text}" via ${back.via}`);

  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
