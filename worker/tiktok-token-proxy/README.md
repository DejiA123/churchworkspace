# TikTok token proxy (Path A)

A tiny, stateless Cloudflare Worker that holds your TikTok **client secret** and
performs the OAuth token exchange, so the desktop app never has to ship the
secret to a church's computer. This is the "own it" backend from the
architecture decision: near‑zero cost, no database, free TikTok posting at any
volume once your app passes review.

Every church still just taps **Connect TikTok** and signs in — they never see
any of this.

## What it does

The app sends the Worker one of two JSON POST bodies; the Worker injects your
secret and forwards to TikTok, returning TikTok's JSON unchanged:

| App sends | Worker → TikTok | Returns |
|---|---|---|
| `{ "grant_type": "authorization_code", "code", "code_verifier", "redirect_uri" }` | code exchange | `access_token`, `refresh_token`, `open_id`, … |
| `{ "grant_type": "refresh_token", "refresh_token" }` | refresh | fresh `access_token` (and rotated `refresh_token`) |

The secret is **never** returned to the app and **never** logged. Refresh tokens
live only on each church's machine — the Worker keeps no state.

## Deploy (about 5 minutes, free)

You need a free Cloudflare account and your TikTok app's **Client key** +
**Client secret** (Developer Portal → your app → Credentials).

```bash
npm install -g wrangler          # one time
cd worker/tiktok-token-proxy
wrangler login                   # opens your browser to authorize

# Store your TikTok credentials as encrypted Worker secrets (never in git):
wrangler secret put TIKTOK_CLIENT_KEY       # paste the Client key
wrangler secret put TIKTOK_CLIENT_SECRET    # paste the Client secret

wrangler deploy
```

`wrangler deploy` prints your Worker URL, e.g.
`https://tiktok-token-proxy.YOURNAME.workers.dev`.

## Point the app at it

In the app, set the **TikTok token proxy URL** (Settings → Social accounts) to
that URL. Also set your **Client key** (it is public — it goes in the sign‑in
URL). You do **not** enter the client secret in the app anymore.

When you build the app to ship to churches, bake the Worker URL + Client key in
as defaults so churches get a zero‑config "Connect TikTok".

## Optional: lock the Worker to your app

To stop strangers from calling your Worker and burning your TikTok rate limit,
set a shared token:

```bash
wrangler secret put APP_TOKEN        # any long random string
```

Then put the same value in the app's **TikTok proxy token** setting. Leave both
unset for a zero‑config setup — your secret is safe either way.

## Cost

Cloudflare Workers free tier = 100,000 requests/day. A church connecting once
and posting ~50 videos/month uses a few dozen requests a month. You will not pay
for this.
