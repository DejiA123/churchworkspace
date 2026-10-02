/**
 * TikTok token proxy — the server side of "Path A" (own your TikTok app).
 *
 * Why this exists: TikTok's OAuth token exchange requires the app's
 * client_secret. A desktop app shipped to many churches must NEVER carry that
 * secret on each church's computer. So the secret lives ONLY here, in a
 * stateless Cloudflare Worker, and the app calls this Worker for the two
 * operations that need it:
 *
 *   POST { grant_type: "authorization_code", code, code_verifier, redirect_uri }
 *   POST { grant_type: "refresh_token", refresh_token }
 *
 * We inject client_key + client_secret from the Worker's environment, forward
 * to TikTok, and hand TikTok's JSON straight back. No database, no state — the
 * refresh token lives on each church's own machine, exactly as before.
 *
 * Deploy: see README.md. Secrets are set with `wrangler secret put …`, never
 * committed. The client_secret is never returned to the caller and never logged.
 */

const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const ALLOWED_GRANTS = new Set(['authorization_code', 'refresh_token']);

function cors(extra) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-app-token',
    ...extra,
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: cors({ 'content-type': 'application/json' }),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
      return json({ error: 'server_not_configured', error_description: 'Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET.' }, 500);
    }

    // Optional light guard: if APP_TOKEN is set, callers must present it so
    // strangers can't burn your TikTok rate limit. Leave it unset for a
    // zero-config setup — the secret is still safe either way.
    if (env.APP_TOKEN && request.headers.get('x-app-token') !== env.APP_TOKEN) {
      return json({ error: 'unauthorized' }, 401);
    }

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'invalid_json' }, 400); }

    const grant = body && body.grant_type;
    if (!ALLOWED_GRANTS.has(grant)) return json({ error: 'unsupported_grant_type' }, 400);

    // Build the form TikTok expects. We ignore any client_key/client_secret the
    // caller might send — those come only from the Worker environment.
    const form = new URLSearchParams();
    form.set('client_key', env.TIKTOK_CLIENT_KEY);
    form.set('client_secret', env.TIKTOK_CLIENT_SECRET);
    form.set('grant_type', grant);

    if (grant === 'authorization_code') {
      if (!body.code) return json({ error: 'invalid_request', error_description: 'missing code' }, 400);
      form.set('code', String(body.code));
      if (body.code_verifier) form.set('code_verifier', String(body.code_verifier));
      if (body.redirect_uri) form.set('redirect_uri', String(body.redirect_uri));
    } else {
      if (!body.refresh_token) return json({ error: 'invalid_request', error_description: 'missing refresh_token' }, 400);
      form.set('refresh_token', String(body.refresh_token));
    }

    let tkRes;
    try {
      tkRes = await fetch(TIKTOK_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
        body: form.toString(),
      });
    } catch (e) {
      return json({ error: 'upstream_unreachable', error_description: 'Could not reach TikTok.' }, 502);
    }

    // Pass TikTok's token JSON straight through (access_token, refresh_token,
    // open_id, expires_in, …). The secret is never part of this response.
    const text = await tkRes.text();
    return new Response(text, {
      status: tkRes.status,
      headers: cors({ 'content-type': 'application/json' }),
    });
  },
};
