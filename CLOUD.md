# ☁️ Cloud Studio — the Video Studio from anywhere

The Video Studio, in a browser, on any phone, tablet or laptop in the world.
Not a cut-down mobile version: **the same editor** — the same buttons, the same
Long-to-shorts, the same captions, the same auto-reframe — because the page it
serves is built from the desktop app's own screen.

Add it to your phone's home screen and it opens like an app.

---

## The one thing to understand first

The editing was never done by the window. It is done by **ffmpeg, whisper and
MediaPipe on a machine**. The window is a remote control that happens to sit on
the same desk.

So the Cloud Studio is a second remote control, over the internet. You get the
whole studio on a phone, and a machine somewhere does the encoding at full
speed. Nothing is installed on the phone.

There are three places that machine can be:

| | **1 — your own PC** | **2 — a server you rent** | **3 — Oracle always-free** |
|---|---|---|---|
| Does the work | the church PC | a VPS | a free ARM machine |
| Setup | tick a box in Settings | `docker compose up` | make the machine, then one command |
| Speed | full — your GPU, your models | CPU only | 4 ARM cores, no GPU |
| Needs the PC on | **yes** | no | no |
| Cost | nothing | £4–40 a month | nothing |
| Your recordings | already there | must be uploaded | must be uploaded |
| Captions, AI clips | already installed | downloads once | downloads once |

Route 1 is what most churches want, and it is running in five minutes. Route 3
is the one to pick if the PC genuinely cannot stay on — it costs nothing, but
the services have to live on it, and that upload is the real price.

All three run the identical code — see *Why there is no second version* at the bottom.

---

## Route 1 — your own PC (five minutes, free)

1. Open **Settings → ☁️ Cloud Studio**.
2. Tick **Cloud Studio is on**.
3. You now have an address and an **access code** — words and four digits, like
   `garden-rain-4184`. On the church wifi, that address already works: type it
   into a phone's browser and sign in with the code.
4. To use it **away from the church**, tick **Give it a public address**. The
   first time, the app downloads a free helper from Cloudflare (~50 MB). A few
   seconds later the address changes to an `https://…` one that works from
   anywhere in the world.
5. On the phone, open the browser menu and choose **Add to Home Screen**. It
   now opens full screen, with no address bar, like an app.

Leave it ticked and it comes back on its own every time the app starts, tunnel
and all.

### About that public address

Your PC **dials out** to Cloudflare; Cloudflare hands back an address and passes
traffic down the connection your PC opened. Nothing is opened on your router,
and nothing on the church network is exposed. The only way in is the address
plus the access code.

The free address is random and **changes every time it starts**. If you want one
that stays the same — `studio.ourchurch.org` — make a free tunnel in a
Cloudflare account and paste its token into the box in Settings.

**The PC has to be on and awake.** Windows sleeping is the single most common
reason "it worked yesterday": set the power plan to never sleep, or use Route 2.

---

## Route 2 — a server (the PC can be off)

```bash
git clone <this repo> && cd MediaWorkstation
# put your domain in docker-compose.yml (two places), point DNS at the machine
docker compose up -d
```

Or without Compose:

```bash
docker build -t church-cloud-studio .
docker run -d --name studio -p 7390:7390 \
  -e MW_CLOUD_CODE="your-access-code-1234" \
  -v studio-data:/data \
  -v /srv/recordings:/media \
  church-cloud-studio
```

Or with no Docker at all, on any machine with Node 20:

```bash
npm ci
npm run cloud -- --port 7390 --data ./cloud-data --media /srv/recordings \
  --code "your-access-code-1234"
```

## Route 3 — free forever, PC off (Oracle Cloud)

Everything on a rented host costs money **except** one: Oracle Cloud gives
away an ARM machine permanently — 4 cores, 24 GB RAM, 200 GB of disk — which
is more than the church PC has, and far more than Render's paid Starter
(half a CPU, 512 MB). It is the only free tier with enough disk and uptime to
actually run this. Free tiers that need no card (Render, Fly trials) have **no
disk** and **sleep when idle**.

What it costs: nothing. Oracle asks for a card to prove you are a person;
Always Free resources are never charged.

### 1. Make the machine (Oracle's website, about 10 minutes)

1. **oracle.com/cloud/free** → sign up. Pick the **home region** nearest the
   church — you cannot change it later.
2. ☰ → **Compute → Instances → Create instance**.
   * **Image:** Canonical **Ubuntu 22.04** (or 24.04).
   * **Shape:** *Change shape* → **Ampere** → **VM.Standard.A1.Flex** →
     **4 OCPUs, 24 GB memory** (all of it is free).
   * **Networking:** keep "Assign a public IPv4 address" ticked.
   * **SSH keys:** *Generate a key pair* → **Save private key**.
   * **Boot volume:** *Specify a custom size* → **200 GB**.
   * **Create.** Note the **Public IP address** when it is running.
   * *"Out of capacity"?* Ampere machines are popular. Try another
     Availability Domain, try again later, or upgrade the account to **Pay As
     You Go** (Billing → Upgrade) — you are still not charged for Always Free
     resources, it gets capacity far more easily, and Oracle stops reclaiming
     idle free machines on PAYG accounts.
3. **Open the web ports** (this is the step everyone misses):
   ☰ → **Networking → Virtual cloud networks** → your VCN → **Security Lists**
   → **Default Security List** → **Add Ingress Rules**:
   source `0.0.0.0/0`, protocol **TCP**, destination port **80** — then again
   for **443**.
4. *(Recommended)* Make the IP permanent: ☰ → **Networking → Reserved public
   IPs** → reserve one, and assign it to the instance's VNIC. The studio's
   address is built from the IP, so a reserved IP means an address that never
   changes.

### 2. Put the studio on it (one command)

Connect: **Cloud Shell** (the `>_` icon at the top of Oracle's console — works
from any browser, even a phone) or your own terminal:

```bash
ssh -i the-key-you-saved.key ubuntu@YOUR-PUBLIC-IP
```

Then fetch the studio from GitHub and set it up. The repository is private,
so make a read-only token first: **github.com → Settings → Developer settings
→ Fine-grained tokens → Generate** — only this repository, *Contents:
Read-only*.

```bash
git clone https://YOUR-TOKEN@github.com/DejiA123/churchworkspace.git
cd churchworkspace && bash scripts/cloud-setup.sh
```

The script asks for two optional keys (press Enter to skip either):

* a **free Groq key** (console.groq.com → API Keys) — captions, the sermon
  scan and the ✨ AI check run on Groq's free Whisper Large and AI models.
  Strongly recommended: it is free and much better than any model a server
  runs on its own;
* a **Claude key** (console.anthropic.com) — optional and paid: Claude directs
  AI montages and proof-reads captions with the most context.

Then it installs Docker, builds the studio (10–20 minutes the first time — it
compiles the speech engine for ARM), opens the machine's own firewall, starts
it behind **Caddy** with a real certificate, and prints:

```
  address:      https://141-147-10-20.sslip.io
  access code:  cedar-harbour-4821-psalm
```

That address is the machine's own free name (`sslip.io` turns the IP written
in it into the IP — no account, no domain to buy) and **it does not change**,
so the app on everyone's home screen keeps working. Have your own domain or a
free DuckDNS name? `STUDIO_HOST=studio.yourchurch.org bash scripts/cloud-setup.sh`
(point its DNS at the IP first).

On each iPhone: open the address in **Safari**, make a space with the access
code, then **Share → Add to Home Screen**.

### 3. It keeps itself up to date

Like Render's auto-deploy: every 30 minutes the server checks GitHub, and
when there is a new version it rebuilds and restarts — but **never in the
middle of an export** (it waits for the next round). The log is
`~/studio-update.log`. To update straight away: `bash scripts/cloud-update.sh`
(add `FORCE=1` to update even while something exports). `AUTO_UPDATE=off` when
running the setup turns it off.

### Moving from Render

Accounts, projects and uploads live on each server's own disk, so the Oracle
studio starts empty: make the spaces again, and send up the recordings you
still need (**📁 Files → ⬆ Send a video** — chunked, and it resumes if the
signal drops). Re-add the app to each home screen from the new address. Once
everyone has moved, delete the Render service so it stops billing.

### Getting your services onto it

The machine starts empty; a service is 2–4 GB. Send it from the phone as
above, or from a computer:

```bash
scp -i the-key.key "Thanksgiving Sunday.mp4" ubuntu@YOUR-IP:/tmp/
ssh -i the-key.key ubuntu@YOUR-IP 'cd churchworkspace && docker compose cp /tmp/"Thanksgiving Sunday.mp4" studio:/media/'
```

### What to expect

* **Speed:** 4 ARM cores, no GPU — exports are libx264 on the CPU. Several
  times faster than Render Starter's half a CPU, and with 24 GB several
  exports run side by side instead of queueing. Still slower than a church PC
  with Quick Sync.
* **Captions and AI:** with the Groq key, listening and the AI check happen on
  Groq's free service — quick, and nothing for the server to carry.
* **Useful commands** (in `~/churchworkspace`): `docker compose logs -f studio`
  (what it is doing), `docker compose restart`, `docker compose down` (stop —
  your files stay), `bash scripts/cloud-setup.sh` again to add a key.
* **No public ports wanted?** `ADDRESS=tunnel bash scripts/cloud-setup.sh` uses
  a Cloudflare quick tunnel instead — but its address is random and changes
  whenever it restarts, which means re-adding the app on every phone.

## Other hosts (paid)

Blueprints are in the repo for when free is not the priority:

```bash
# Fly.io — https://<app>.fly.dev
fly auth login && fly launch --no-deploy --copy-config
fly volume create studio_data --size 100
fly secrets set MW_CLOUD_CODE="your-access-code-here"
fly deploy

# Render — push to GitHub, then New → Blueprint → pick the repo (render.yaml)
```

Any VPS with Docker works too: `docker compose -f docker-compose.free.yml up -d`
for the tunnel (no domain), or `docker compose up -d` for Caddy and your own
domain.

### Put https in front of it

Not optional, and not about being cautious: **a PWA will not install over plain
http**, and browsers treat an http page as insecure. `docker-compose.yml`
includes Caddy, which gets and renews a certificate by itself once you give it
your domain. Cloudflare Tunnel or nginx do the job equally well.

### What the server needs

* **2+ CPU cores.** A cheap VPS has no GPU, so exports use libx264 on the CPU —
  the same file, the same settings, just more minutes than the church PC with
  Quick Sync takes.
* **Disk.** Recordings are large. `/media` is where they live, `/data` holds
  settings, saved sessions, the music library and any speech model downloaded.
* **RAM.** 2 GB is enough for editing; 4 GB if you use the larger speech models.

### Environment

| Variable | Default | What it does |
|---|---|---|
| `MW_CLOUD_PORT` | `7390` | port to listen on |
| `MW_CLOUD_HOST` | `0.0.0.0` | interface to bind |
| `MW_CLOUD_DATA` | `~/.church-work-space-cloud` | settings, sessions, library, models |
| `MW_CLOUD_MEDIA` | `<data>/media` | where recordings live |
| `MW_CLOUD_CODE` | generated | the access code — **set this**, or it changes on restart |
| `MW_CLOUD_UPLOADS` | `on` | `off` stops phones sending files up |
| `GROQ_API_KEY` | — | a free Groq key: the sermon scan, captions and "remove pauses" are heard by Whisper Large in the cloud. Set it in the host's dashboard, never in the repo |
| `GEMINI_API_KEY` | — | a free Google Gemini key (aistudio.google.com → *Get API key*, no card): every caption is heard a third time by a model that is not Whisper. Where it and the second Whisper ear agree against the first, theirs is used; where both Whisper ears share a mishearing ("on the same" for "on the scene"), a free Groq reader picks between the hearings, and a place it cannot decide is listed for a look. Google's free tier may use what is sent to it to improve its products. Without the key the captions are exactly as before. Set it in `.env` / the host's dashboard, never in the repo |
| `ANTHROPIC_API_KEY` | — | a Claude API key (console.anthropic.com): ✨ AI Montage is directed by Claude Opus 5.5, which looks at every clip and photo before cutting the edit. Without it the montage is directed by the Groq model, or the studio's own rules. Set it in the host's dashboard, never in the repo |
| `MW_MONTAGE_MODEL` | `claude-opus-5-5` | which Claude model directs the montage |
| `MW_CLOUD_SOCIAL` | `on` | `off` takes the Social Scheduler off the phone and stops this server publishing anything |
| `MW_MEMORY_MB`, `MW_CPUS` | read from the container | only for a host that hides its limits — see *A small server* below |

### A small server (512 MB)

The studio reads the memory and CPUs the container really has (not the host's),
and on anything under 2 GB it works within them: exports decode on one thread
and keep x264's look-ahead short (a 1080p short peaks near 290 MB instead of
680), the scan streams the sermon's loudness instead of holding the recording,
and a speech model that would not fit is never started — it steps down to one
that does (the image carries Tiny, so captions work from the first start), or,
with `GROQ_API_KEY` set, the listening happens in the cloud and costs the server
nothing — Tiny then only hears what the cloud cannot. That key is the single
best thing to give a small server: Tiny gets the gist, Whisper Large gets the
names right.

---

## Using it on a phone

* **Sign in once.** Tick *Keep me signed in* and the phone stays signed in for a
  month — through restarts of the server too.
* **Home.** The app opens on a home screen with two doors — **Video Studio**
  and **Social Scheduler** — what is running in the background, and your latest
  exports with a **Post** button on each. The house in the studio's top bar
  comes back here; the studio carries on exactly where it was.
* **Exports you can walk away from.** Switch on *Keep editing while it exports*
  in the Export sheet (or press *Run in the background* on any export). A live
  chip in the top bar shows how far it has got, with a thin purple line under
  the bar. Tap it for every job: its step, how long it has run and roughly how
  long is left, and **Stop** — then, when it is done, each file with **Save**
  (to the phone) and **Post** (straight into the scheduler).
* **Messages** come out of one black capsule at the top of the screen, the way
  an iPhone shows them, and never sit over the timeline.
* **New versions.** An app on an iPhone's home screen is *resumed*, not
  reopened, so it can go days without loading a new version. It asks the server
  whenever it comes back to the front and offers **Refresh** when there is a
  new one — never in the middle of an export. (A copy installed before this
  existed needs closing fully once: swipe it away in the app switcher.)
* **A strip at the bottom of an iPhone.** iOS 26 gives a home-screen app with
  a see-through status bar a window one status bar short of the screen, and
  nothing can be drawn in the strip left over (WebKit bug 301108). The studio
  now uses an opaque black status bar, which reaches the bottom edge, but iOS
  reads that only when the app is added. An older install says so once: remove
  it from the Home Screen and add it again from Safari.
* **📁 Files** opens what is on the studio machine: finished exports, anything
  sent from a phone, and the Videos folder. **⬆ Send a video from this phone**
  uploads from the handset, in slices, and **picks up where it left off** if the
  signal drops. The bin on a finished export or an upload **deletes** it (a
  second tap to be sure; **Select** deletes several at once), and the sheet says
  how much room is left. The Videos folder is never deleted from a phone, nor a
  video a planned post still needs, nor the one open in the studio. An upload
  abandoned half-way is swept away after two days.
* **⬇ Saved** is everything finished in this session. Tap one to pull it onto
  the phone's camera roll or files.
* **Dragging.** Clips, trim handles, caption blocks, text boxes and the crop
  frame all drag with one finger. Dragging *empty* timeline scrolls it — **hold
  still for a moment first** and the same drag draws a new clip instead (or use
  *＋ Clip*, which adds one at the playhead). The small bar along the bottom
  carries undo, redo, zoom, split, delete and play — the keyboard shortcuts a
  phone has no keyboard for.
* **Auto-reframe runs on the phone.** The face and pose tracking is done in the
  phone's own browser (MediaPipe), exactly as it is in the desktop window, so
  the crop path an export follows is identical.

---

## What is NOT in the cloud, and why

**Go Live** and **Presentation** are not here. They drive cameras, capture
cards, NDI, projectors and stage screens on the church network. A browser in
another country cannot reach any of that, and a button that pretends otherwise
is worse than no button. They stay on the machine in the building.

The desk's **direct** Facebook, YouTube and TikTok sign-ins are not here
either: they open a sign-in window on the machine itself. On a phone, accounts
are linked through Zernio instead (below).

---

## The Social Scheduler on a phone

Plan posts to **TikTok, YouTube, Instagram and Facebook** from the phone — the
app's own scheduler, run by whichever machine is serving the page.

1. **A free Zernio key, once.** Make a free account at zernio.com, copy an API
   key (Settings → API keys) and paste it in *Scheduler → Accounts*. It is
   stored on the server and **never sent back to any phone** — the page is only
   ever told *whether* a key is set. Zernio's free plan links two accounts per
   key; a second free key covers Facebook and Instagram.
2. **Connect each account.** Tap *Connect*, sign in on that platform's own
   page, come back to the app — the account appears.
3. **Post.** *New post* (or *Post* on a finished export): pick the video, let
   **✨ Write it for me** write the title and caption (the same writer as the
   desk; it listens to the clip first), tick the accounts and choose a time —
   *Best time* picks the next hour people actually look, in the phone's own
   time zone. Several shorts at once are spread over the coming days.

**It goes out with everything switched off.** A post is handed to Zernio the
moment it is saved, and Zernio publishes it at its time. *Post now* on a
planned post gives that booking back first, so nothing goes out twice; moving
or deleting a post calls the booking off too.

**Whose schedule is it?** The server's. A cloud server (Routes 2 and 3) keeps
its own posts and accounts in its data folder, separate from the church PC —
so there is never a second copy of a post to publish twice. When the church PC
serves the page (Route 1), the phone is looking at the PC's own schedule and
accounts. The server runs the scheduler for its posts (a booking that failed is
retried; a post whose time has come is published); `MW_CLOUD_SOCIAL=off` takes
the Scheduler off the phone and stands that down.

---

## Security, plainly

* **An access code, not a PIN.** Two words and four digits from a 200-word list
  is ~650 million combinations, against 8 tries per quarter hour per address.
  Phone Studio's six digits are fine facing a church hall; they are not fine
  facing the internet.
* **An allowlist of what may run**, by exact name — 100 of the app's 234
  handlers (the server prints both numbers when it starts). Not by prefix, so a
  handler added next month is refused until somebody has thought about it.
  Settings, the desk's account channels, shells, dialogs, Go Live and
  Presentation are all absent. The Social Scheduler's channels hand the phone
  its accounts **without** their tokens, and take a Zernio key in without ever
  giving one back out.
* **The access code now guards posting as well as editing.** Anyone with it
  can publish to the church's linked accounts — use a code nobody could guess,
  and press *New code* if it may have got out.
* **An allowlist of where it may run.** Every file path an instruction carries
  must resolve inside a few known media folders, checked recursively by
  argument name. A stolen token still cannot read `C:\Users`.
* **Media is read-only**, by extension, with proper Range support.
* **The service worker never caches or replays anything under `/api/`.** A
  cached instruction to a machine is a lie; a replayed one runs a job twice.

Roll the code any time with **New code** — every signed-in device is signed out.

---

## Troubleshooting

**"Cannot reach the studio machine."** The PC is asleep, off, or the tunnel
stopped. If the address was the free random one, it changed — reopen Settings
and read the new one.

**The address works on the church wifi but nowhere else.** That is the local
address. Tick *Give it a public address*.

**It will not add to the home screen.** The page has to be `https://` (or
`localhost`). The tunnel gives you that; a bare `http://192.168…` never will.

**An export said the connection was lost.** The job is still running on the
studio machine — losing signal on a phone does not stop ffmpeg. Open the app
again and it reappears.

**Exports are slow on the server.** No GPU. Give the container more cores, or
use Route 1 for anything long.

**Captions say the model is missing.** Pick one in the Video Studio and it
downloads once onto `/data`, then works offline forever.

---

## Why there is no second version

Everything above runs **one codebase**.

* The page is generated from `src/renderer/index.html` at serve time, with the
  other studios' views removed — so a button added to the Video Studio tomorrow
  is in the cloud the moment the page is next opened. It loads the real
  `veditor.js`, the real `caplayout.js`, the real `facetrack.js`.
* The server calls the same `ipcMain.handle` functions the desktop window calls,
  through `src/main/rpc.js`.
* The standalone server boots the real `src/main/main.js`, with a stand-in for
  Electron under it (`src/cloud/electron-shim.js`) — 199 handlers, not a
  reimplementation.

The test that keeps this honest is in `test/cloud-studio.test.js`: it asserts
that every DOM id `veditor.js` reaches for is still present in the generated
page. Move a modal in the desktop app and **the cloud build fails loudly**,
instead of quietly losing the caption editor.

```bash
npm run test:cloud        # the server, the page, the gate, a real export
npm run test:cloud-desk   # the Settings panel an operator actually clicks
```
