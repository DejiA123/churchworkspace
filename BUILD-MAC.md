# Building the macOS installer (Church Work Space)

This produces a **`.dmg`** (drag-to-Applications installer) and a **`.zip`** for Mac
users. The build **must be run on a Mac** — Apple's disk-image and code-signing tools
(`hdiutil`, `codesign`) only exist on macOS. You cannot build the `.dmg` on Windows.

The Windows build is unchanged: `npm run dist` still produces the `.exe` installer.

---

## 1. On the Mac — one-time setup

1. Install **Node.js 18 or newer** (LTS): https://nodejs.org
2. Copy this whole project folder to the Mac (USB, cloud drive, or `git clone`).
3. Open **Terminal**, `cd` into the project folder, and install dependencies:

   ```bash
   npm install
   ```

   > This is important: `npm install` downloads the **macOS** versions of `ffmpeg`,
   > `ffprobe`, and the `koffi` native module. Do **not** copy `node_modules` over
   > from Windows — those are Windows binaries and won't run on a Mac.

## 2. Build the installer

```bash
npm run dist:mac
```

The finished files land in the **`release/`** folder:

- `Church Work Space-2.3.0.dmg` ← give this to Mac users
- `Church Work Space-2.3.0-mac.zip` ← auto-update / alternative

By default this builds for the **same chip as the Mac you build on**:

- **Apple Silicon** Mac (M1/M2/M3/M4) → an Apple-Silicon app (what most MacBooks since 2020 need).
- **Intel** Mac → an Intel app.

To force a specific chip, add a flag:

```bash
npm run dist:mac -- --arm64   # Apple Silicon
npm run dist:mac -- --x64     # Intel
```

> Build for the chip your users actually have. Building an Intel app **on** an Apple-Silicon
> Mac will bundle the wrong `ffmpeg`, so match the target to the build machine (or install
> the matching `ffmpeg-static` for the other arch first).

---

## 3. Installing it (what to tell Mac users)

**You only need to give the Mac user ONE file: the `.dmg`** (from the `release/` folder —
e.g. `Church Work Space-2.3.0.dmg`). Do **not** send them the whole project folder;
that's only for building. Send the `.dmg` by USB stick, AirDrop, Google Drive, WeTransfer, etc.

Because this build is **not signed with an Apple Developer ID** (that costs $99/yr and can be
added later — see §6), macOS Gatekeeper shows a warning the first time. This is normal for
in-house apps. Here's the exact click-by-click for the Mac user:

1. **Double-click the `.dmg` file.** A window opens showing the app icon and a shortcut to the
   **Applications** folder.
2. **Drag the "Church Work Space" icon onto the "Applications" folder** in that same window.
   (This copies/installs it.) Then close the window and eject the `.dmg` (drag it to the Trash /
   click the ⏏ next to it in Finder's sidebar).
3. **Open Applications** (Finder → sidebar → Applications), find **Church Work Space**,
   then **right-click (or Control-click) it → choose "Open" → click "Open" again** on the prompt.
   - ⚠️ The **first** launch MUST be done with right-click → Open. If they just double-click it the
     first time, macOS says *"can't be opened because Apple cannot check it for malicious software"* —
     that's expected for an unsigned app. Right-click → Open is the one-time way past it.
4. From then on they can open it normally (double-click, Dock, Launchpad).
5. The first time they use the camera, microphone, or screen capture, macOS will pop a permission
   prompt — click **Allow / Open System Settings** and enable it. (Screen capture: System Settings →
   Privacy & Security → Screen Recording → turn on Church Work Space.)

If macOS still refuses with *"app is damaged and can't be opened"* (can happen when the file was
downloaded through a browser), run this once in **Terminal** (Applications → Utilities → Terminal):

```bash
xattr -cr "/Applications/Church Work Space.app"
```

That clears the download-quarantine flag; then repeat step 3. (This whole dance disappears once the
app is signed + notarized — see §6.)

---

## 4. What works on Mac vs. Windows

| Feature | Mac | Notes |
|---|---|---|
| 🔴 **Go Live switcher** (multi-input mixing, transitions, overlays, recording, streaming) | ✅ | This is your **own** built-in switcher (vMix-*style*, not vMix) — it runs on Mac exactly like OBS does. Program is composited in-app and streamed via bundled ffmpeg (RTMP/RTMPS to YouTube/Facebook/etc.). See the input notes below. |
| ↳ Camera / mic / video / image / audio / title / color / list / web browser / PowerPoint / video call / replay / delay inputs | ✅ | All cross-platform. |
| ↳ Screen Capture input | ✅ | Works; macOS asks for **Screen Recording** permission the first time (System Settings → Privacy & Security → Screen Recording — same as OBS). Capturing the Mac's **system audio** needs a virtual audio device like **BlackHole** — again, same requirement OBS has on Mac. |
| ↳ NDI input | ⚠️ | Best-effort: works only if the user installs the free **NDI Tools for macOS**. |
| 🎬 Video Studio (trim, shorts, effects, stabilize, reframe) | ✅ | Bundled ffmpeg; **hardware-accelerated** export via Apple **VideoToolbox**, auto-falls-back to software. |
| 🎯 Face-tracking auto-reframe | ✅ | MediaPipe WASM — cross-platform. |
| 🔤 Text overlays / burn-in captions | ✅ | Uses bundled fonts + ffmpeg. |
| 🎨 Flyer Editor | ✅ | Pure renderer. |
| 📅 Social Scheduler | ✅ | |
| 💬 **Auto-captions (Whisper transcription)** | ⚠️ | Everything around captions works on Mac — the CapCut-style captions lane, click-to-edit, styling and burn-in. Only the on-device *speech-to-text* step needs a macOS `whisper-cli` binary, which is **drop-in**: see §5. Until then the 💬 button explains exactly what's missing instead of failing silently. |

Nothing in the list **crashes** on Mac — the two ⚠️ items degrade gracefully with an on-screen message.

---

## 5. Enable Whisper auto-captions on Mac (drop-in — no config edit)

The packaging is already wired for this. `bin/whisper` is in the **mac**
`extraResources` (with the Windows `.exe`/`.dll` filtered out), and an `afterPack`
hook decides what actually ships:

* **A macOS binary is present** → whisper + the speech models are bundled, the
  binary is `chmod +x`'d, and auto-captions work in the `.dmg`.
* **No macOS binary** → the hook removes the whisper folder from the packed app,
  so you don't ship ~215 MB of models nothing can run. The build log says which
  branch it took.

So the whole job is: put a binary in place, rebuild.

### Steps

1. Get a macOS `whisper-cli` for **your Mac's CPU** (`uname -m` → `arm64` on Apple
   Silicon, `x86_64` on Intel) — either a release build from
   <https://github.com/ggml-org/whisper.cpp/releases>, or build it yourself:

   ```bash
   git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
   cmake -B build -DBUILD_SHARED_LIBS=OFF && cmake --build build -j --config Release
   # -> build/bin/whisper-cli   (static: nothing else to copy)
   ```

   A **static** build (`-DBUILD_SHARED_LIBS=OFF`) is strongly preferred — one file,
   nothing to go missing. A dynamic build also works: copy its `*.dylib` files in
   next to the binary; the app puts that folder on `DYLD_LIBRARY_PATH` for you.

2. Drop it into the repo, no extension:

   ```bash
   mkdir -p bin/whisper/Release
   cp whisper.cpp/build/bin/whisper-cli bin/whisper/Release/whisper-cli-arm64   # or -x64
   chmod +x bin/whisper/Release/whisper-cli-arm64
   ```

   The app accepts, in order: `whisper-cli-<arch>`, then plain `whisper-cli`,
   looked for in `Release/`, `build/bin/`, `bin/`, then the whisper folder itself.
   The arch suffix lets an Intel and an Apple-Silicon binary live side by side —
   each Mac picks its own. The models (`ggml-base.en.bin`, `ggml-tiny.en.bin`) are
   already in `bin/whisper` and are platform-independent — nothing to do there.

3. Check it before building:

   ```bash
   npm run test:whisper-mac
   ```

   It reports whether a usable binary was found, for which arch, and — if one is
   present — actually runs it end to end on a generated clip.

4. `npm run dist:mac`. Look for this line in the output:

   ```
   • whisper: macOS speech engine bundled — auto-captions will work in this build
   ```

### If captions still don't run on the Mac

The app now tells you which of these it is, in the toast when you press 💬:

| Symptom | Cause | Fix |
|---|---|---|
| "does not include the on-device speech engine yet" | no binary found | §5 step 2 — check the filename and folder |
| App says macOS blocked it | Gatekeeper quarantine on a downloaded binary | `xattr -cr "/Applications/Church Work Space.app"` |
| "built for a different CPU" | arm64 binary on an Intel Mac (or vice-versa) | download the matching build |
| "image not found" in the error | dynamic build missing its `.dylib`s | copy the `.dylib`s next to the binary, or use a static build |

The app already handles the two boring ones for you: it `chmod +x`'s the binary and
strips the quarantine flag on first use.

---

## 6. (Optional) Sign + notarize later (removes the Gatekeeper warning)

When you get an **Apple Developer account** ($99/yr):

1. Install your **Developer ID Application** certificate into the Mac's Keychain.
2. In `package.json`, under `"mac"`, remove `"identity": null` and add:

   ```json
   "hardenedRuntime": true,
   "gatekeeperAssess": false,
   "entitlements": "build/entitlements.mac.plist",
   "entitlementsInherit": "build/entitlements.mac.plist",
   "notarize": true
   ```

3. Provide notarization credentials as environment variables and rebuild:

   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="YOURTEAMID"
   npm run dist:mac
   ```

An `entitlements.mac.plist` starter (camera/mic + JIT for Electron) is already in `build/`.
After this, users just double-click to open — no warning.
