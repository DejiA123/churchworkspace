# ✝ Church Work Space

An all-in-one Windows desktop app for a church media team:

- 🎬 **Video Studio** — trim clips, reshape for Reels/TikTok/feed (no black bars), **auto-trim dead air (AI)**, extract audio, merge clips, add captions. Runs 100% on your machine via bundled `ffmpeg` — nothing is uploaded.
- 🎨 **Flyer Maker** — pick a template, fill in your event, live preview, export print- + social-ready PNGs. Optional AI copy suggestions.
- 📅 **Social Scheduler** — link your accounts once, then schedule a post and it is **booked with the platform itself**: the video is uploaded straight away with its time attached, and Facebook / YouTube / any account connected the easy way publish it on their own servers. **This PC can be switched off.** Instagram and TikTok give no way to book a post in advance, so those fall back to a background poster that needs the PC on (but not the app) — and each post says on its face which of the two it is.
- ☁️ **Cloud Studio** — the **whole Video Studio in a browser, from anywhere in the world**. Not a cut-down mobile version: the page is built from the desktop app's own screen and loads the same editor, so every button, every AI clip and every caption look is there. Add it to a phone's home screen and it opens like an app (PWA). Your PC does the encoding, and a tunnel gives it an `https://` address without opening anything on your router — or run it on a server with the PC switched off, same code, no Electron (`docker compose up`). Switch it on in *Settings → ☁️ Cloud Studio*; see **[CLOUD.md](CLOUD.md)**.
- 📱 **Phone Studio** — the Video Studio, driven from your phone's browser on the church wifi. Pick a sermon, scrub it, run Long-to-shorts, fix the captions, export — while **this PC** does all the encoding and hands the finished vertical clips back to your camera roll. Switch it on in *Settings → 📱 Phone Studio*; see **[BUILD-IOS.md](BUILD-IOS.md)**.

---

## Run it (development)

```powershell
npm install      # downloads Electron + ffmpeg (one time, ~200 MB)
npm start        # launches the app
```

## Test the engine (no window needed)

```powershell
npm run test:engine
```

This generates a synthetic clip and verifies every video operation end-to-end.

```powershell
npm run test:phone       # Phone Studio, end to end: pairing, the allowlist,
                         # media streaming, upload, a real AI shorts run and export
npm run test:cloud       # Cloud Studio, end to end: the page still holds the whole
                         # studio, sign-in, the allowlist, a real export, the PWA
npm run test:cloud-desk  # the Settings panel an operator actually clicks
npm run test:swiftport   # the iPhone app's Swift analyser vs the JavaScript one
```

## Run it in the cloud (nothing to install on the phone)

```powershell
npm run cloud -- --code "your-access-code-1234"   # the studio as a web app, on this machine
docker compose up -d                              # …or on a server, with the PC switched off
```

Then open the address on any phone and add it to the home screen. The full
story — https, tunnels, what is deliberately NOT in the cloud, and why there
is no second version of the code — is in **[CLOUD.md](CLOUD.md)**.

## Build the installer (.exe)

```powershell
npm run dist
```

The Windows installer is written to `release\`. Double-click it to install
"Church Work Space" with Start-menu + desktop shortcuts.

---

## Where files go

Exports are saved to **`Videos\Church Work Space`** by default
(change it in **Settings → Output folder**). Your scheduled posts and settings
live in `%APPDATA%\church-work-space\workstation.json`.

---

## Roadmap (next versions)

These need accounts/keys only you can provide, so they're staged for later:

1. **Fully-automatic posting** via the official Meta (Instagram/Facebook Page)
   and TikTok Content Posting APIs. Requires you to create free developer apps,
   get them approved, and authorize the church's Business accounts. The
   scheduler is already built to plug these in.
2. **AI flyer artwork** from a text prompt — add an image-generation API key in
   Settings.
3. **AI auto-captions** — on-device Whisper transcription to generate the `.srt`
   automatically before the caption step.
4. **Smarter AI copy** — add a Claude API key in Settings to upgrade the flyer
   copy and caption suggestions.

## Honest notes

- Social platforms change their rules often; the "one-tap publish" flow is
  deliberately resilient because it never depends on their private APIs.
- A booked post is held by the platform, so the PC can be off. Instagram and
  TikTok have no booking in their own APIs at all — no setting or payment
  changes that — so connect those two the "easy" way (Zernio or Upload-Post,
  both free) and they get booked like the rest. Any post that still needs this
  PC says so on its own card, with a one-click fix.
- The background poster that covers what cannot be booked is a desktop app, not
  a cloud service: the PC has to be on and signed in. A sleeping PC is woken for
  the post; a PC that was shut down publishes what it missed when it comes back.
- Video processing speed depends on your CPU and the clip length.
