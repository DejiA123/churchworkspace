# The voice-isolation model

`beguiling-drafter.rnnn` is an [RNNoise](https://jmvalin.ca/demo/rnnoise/) model,
used by ffmpeg's `arnndn` filter. It is what 🎙️ **Studio sound** in the Video
Studio uses to take the room off a recording (see `studioVoiceAf` in
`src/main/video.js`).

## Why a model at all

The obvious tool, ffmpeg's `afftdn`, assumes the noise is flat and steady. A
church hall's noise is not: most of its energy is air handling and traffic
rumble down at the bottom, with hiss on top and mains hum in between. Measured
on a real recording (`node test/studio-voice.test.js`), `afftdn` took **3.9 dB**
off the room — and its strength control was inert while doing it: across the
whole range of the dial, `nr=3` to `nr=97`, the room level moved by less than
0.1 dB. Feeding it a *measured* fifteen-band profile of the actual room
(`nt=custom`) did not rescue it either — 2.9 dB. RNNoise takes off **17–21 dB**
per pass and leaves the voice alone.

## Which model, and why this one

From [GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models), which
publishes five, each trained for a different pairing of expected signal and
expected noise. Two were close, and they behave very differently on a service:

| model                   | trained for            | the room | a worship band | pure tones |
| ----------------------- | ---------------------- | -------- | -------------- | ---------- |
| beguiling-drafter (this) | recording noise × VOICE | −17.6 dB | −14.4 dB       | −5.8 dB    |
| conjoined-burgers        | recording noise × general | −17.2 dB | untouched   | untouched  |

"Voice" here means human sound — speech, singing, laughter, a shouted amen — as
opposed to "general", which is any signal at all. `beguiling-drafter` keeps what
a person makes and pushes down what a person doesn't, which is what the button
promises: the speaker, without the hall. The cost is that it also pushes down an
instrumental band playing under the preacher, so a worship segment is better
served by the gentler strength levels in the dropdown, which never touch music.

## Why the app checks the audio instead of trusting the filter

`arnndn` in the bundled ffmpeg (6.1.1) does not give the same answer twice. Same
binary, same input, same command line — and it lands on one of exactly **two**
byte-identical outputs. Over 30 runs of the real chain on one recording, **19
left the room exactly where it was** and 11 removed about 17 dB of it.

Ruled out, one at a time: the model (all five published models do it), the
strength, the input format, threading (`-threads 1`, `-filter_threads 1`), SIMD
dispatch (`-cpuflags 0` and every level up to `avx2+fma3`), and frame sizing
(`asetnsamples`). ffmpeg's own verbose log is line-for-line identical between a
good run and a bad one apart from heap addresses — it believes it did the same
work both times, which is what state being read before it is written looks like
from outside a prebuilt binary.

The outcome is not random per run either: it is **fixed by the shape of the
command**. Rendering the same MP4 six times over gave the same dirty result all
six times, while the very same audio with the filter listed twice came back clean
all six. So retrying the identical command is pointless, and no fixed number of
passes is safe:

| passes in the graph | runs that left the room untouched |
| ------------------- | --------------------------------- |
| one                 | 19 of 30                          |
| two                 | 1 of 30, then 0 of 40             |
| three               | 0 of 30, then 1 of 40             |
| four                | 21 of 40 — this many flattens the voice |

"Almost always" is not what the button promises. So `renderVerifiedVoice` in
`src/main/video.js` renders the export's audio on its own, **measures** whether
the words really did pull away from the room, and tries again with another pass
in the graph until they do. The encode then plays that checked track rather than
running the filter itself. On this laptop the checking runs at about 7x realtime
— seconds for a short, roughly eight minutes for a whole one-hour service.

`test/studio-voice.test.js` proves both halves: that the raw filter really is a
coin toss, and that the checked path comes back clean on every one of five runs.
If a later ffmpeg fixes `arnndn`, the first of those starts passing consistently,
and that is the signal the retry machinery can be simplified away.

## Licence

The repository states: "With the exception of the tools/ directory and this
file, none of this work is creative and thus none of it is subject to
copyright." The model is a table of numbers, not code, and ships as-is.
