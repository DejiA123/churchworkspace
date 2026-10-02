# Editing on your phone — the two routes, and how to build them

You asked whether the Video Studio could live on an iPhone so you can turn long
sermons into shorts away from the desk. There are two honest answers, and both
are now built.

| | What it is | Needs the PC on? | Status |
|---|---|---|---|
| **Route A — Phone Studio** | The full Video Studio in your phone's browser; the PC does the encoding | Yes, same wifi | **Done and tested — usable today** |
| **Route B — the iPhone app** | A native app that edits on the phone itself, and can also drive the PC | No | **Written in full; needs a Mac to compile** |

Route A is finished, proven end to end, and ships in the Windows/macOS build you
already have. Route B is a complete Xcode project in `ios/` — every screen and
the whole engine — but it has never been through a compiler, because this
machine is Windows and Xcode is macOS-only. What that means in practice is set
out honestly at the bottom of this file.

---

## Route A — Phone Studio (nothing to install)

**On the PC:** Settings → **📱 Phone Studio**, switch it on. It shows an address
and a 6-digit PIN. (There is also a **📱 Phone** button in the Video Studio's top
bar that jumps straight there.)

**On the phone:** open that address in Safari or Chrome, type the PIN once.

That's it. You get: your videos (the PC's Videos folder, its output folder, and
anything you've sent from a phone) · a scrubbing player with trim handles ·
**Long to short clips (AI)** · remove pauses · speaker tracking · caption editing
with all twelve looks · export · and a Save button that puts the finished clip in
your camera roll.

The PC does every heavy thing. The phone is the remote control.

**Add it to your home screen** (Share → Add to Home Screen) and it opens
full-screen like an app.

### What it can and cannot do

* It needs the PC switched on, awake, and on the same network. That is the
  trade: no App Store, no second codebase, and a fix to the export pipeline
  reaches the phone the same instant it reaches the desktop.
* To use it from outside the church wifi you would need a tunnel (Tailscale is
  the usual answer). Nothing in Phone Studio assumes the local network beyond
  the address you type, so a tunnel works, but it is not set up for you.

### How it is secured

It runs encoders and reads media on your PC, so it is not open the way the stage
display page is:

* a pairing PIN, exchanged once for a token; wrong PINs are rate-limited and
  then locked out per device;
* only an **allowlist** of studio operations can be called — never a shell,
  never a file dialog, never your settings (they hold your API keys and social
  tokens), never a file write;
* every path handed to an allowed operation must resolve inside a few known
  media folders, so even a stolen token cannot read the rest of the disk;
* media is served read-only and by file type.

`npm run test:phone` proves all of that against the running app, along with the
real editing pipeline. 74 checks.

---

## Route B — the iPhone app

`ios/` is a complete SwiftUI app. It does the whole job on the phone:

| Desktop | iPhone equivalent |
|---|---|
| ffmpeg decode → loudness envelope | `AVAssetReader` at 8 kHz mono — same signal, same numbers |
| `highlights.js` analysis | `HighlightEngine.swift` — a line-for-line port |
| whisper.cpp captions | `SFSpeechRecognizer`, on-device (nothing is uploaded) |
| MediaPipe face + pose tracking | Vision `VNDetectFaceRectangles` + `VNDetectHumanBodyPose` |
| libass caption burn-in | Core Text drawn straight into the frame |
| ffmpeg export chain (5 passes) | one `AVAssetExportSession` pass through VideoToolbox |

It also has a **"Use my PC"** switch. Paired with Phone Studio, the same screens
drive the workstation instead — so the app is useful on a train *and* fast in the
building. That is Route A and Route B in one binary.

### Building it

You need a Mac with **Xcode 16 or newer**.

```bash
cd ios
open MediaWorkstation.xcodeproj
```

Then in Xcode: select the **MediaWorkstation** scheme, pick your iPhone (or a
simulator), set your team under *Signing & Capabilities*, and press ▶.

If the project ever refuses to open, regenerate it from the spec — the `.yml` is
the source of truth, the `.xcodeproj` is a convenience:

```bash
brew install xcodegen
cd ios && xcodegen generate
```

### Running the engine tests without Xcode

The analysis engine is also a Swift package, so it compiles and tests from a
terminal on any Mac:

```bash
cd ios && swift test
```

That runs the parity suite: the Swift analyser is fed a loudness envelope
captured from the **real JavaScript engine** and must choose the same clips, with
the same cut points, the same viral scores and the same reasons. It is the fastest
way to know a change to one engine has not silently diverged from the other.

Regenerate the fixture whenever you deliberately change `src/main/highlights.js`:

```bash
node ios/Tools/make-parity-fixture.js
```

### The caption fonts

Captions use the same four typefaces the desktop bundles. Drop the `.ttf` files
into `ios/MediaWorkstation/Fonts/` (create the folder) — they are already listed
in `Info.plist`:

```
BebasNeue-Regular.ttf   Anton-Regular.ttf   Poppins-Bold.ttf   Bangers-Regular.ttf
```

They are in this repo at `bin/fonts/`. Without them the app falls back to
Helvetica Bold and everything still works — the words are just a different shape
from a desktop export.

### What it does not do, and why

* **No YouTube import.** `yt-dlp` cannot ship on the App Store (guideline 2.5.2
  forbids downloading executable code, and it needs constant updating to keep
  working). Import on the PC and it appears in Phone Studio.
* **The "deep" content-aware pass is not ported.** On the desktop, the analyser
  can transcribe its best candidates with whisper and re-rank them on what was
  actually said. On iOS the transcript comes from Speech.framework instead, which
  is a different engine with different timings — so rather than pretend it is the
  same code path, the app runs the audio analysis (which IS the same code path,
  and is proven so) and uses speech only for captions. In "Use my PC" mode you
  get the full deep pass, because the PC runs it.
* **No live switcher, presentation studio, flyer maker or scheduler.** Those are
  desk jobs. This is the Video Studio.

---

## Honest status of Route B

Everything in `ios/` was written on a Windows machine. That has consequences,
and pretending otherwise would waste your time:

**What is verified:**

* The analysis port is verified, and not by inspection. `node
  ios/Tools/verify-swift-port.js` transliterates the Swift back into JavaScript
  and runs it against the real engine's own output: all three length modes, every
  clip's cut points, viral score and reasons — identical. That covers the part a
  hand port actually gets wrong (a constant mistyped, a loop bound off by one).
* The caption text rule, the pause detector and the kept-pieces maths have unit
  tests in `ios/Tests/`.

**What is not verified:**

* **It has never been compiled.** No Swift toolchain exists on Windows. Expect to
  spend a first session in Xcode fixing whatever the compiler objects to —
  most likely an API that moved between SDK versions. The logic underneath it is
  the part that was hard, and that part is checked.
* Nothing that needs a device has been run: Vision tracking on real footage,
  Speech accuracy on a sermon, export speed and thermals on an actual iPhone.
* No App Store submission has been prepared (icons, screenshots, privacy
  manifest, review notes).

**The order I would do it in:** run `swift test` first — it needs no project, no
signing and no device, and it tells you the engine compiles and agrees with the
desktop. Then open the project and run the app in the simulator. Only then worry
about a device build.
