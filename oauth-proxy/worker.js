/**
 * NeoGDSync OAuth Proxy — Cloudflare Worker
 *
 * Exchanges a Google OAuth refresh_token for an access_token.
 * client_id and client_secret are stored as Worker Secrets (never in code).
 *
 * Deploy:
 *   1. wrangler secret put GOOGLE_CLIENT_ID
 *   2. wrangler secret put GOOGLE_CLIENT_SECRET
 *   3. wrangler deploy
 *
 * Free tier: workers.dev subdomain, HTTPS included, 100k req/day.
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const { refresh_token } = body;
    if (!refresh_token || typeof refresh_token !== 'string') {
      return json({ error: 'missing_refresh_token' }, 400);
    }

    // Call Google token endpoint — this is the only external call
    const params = new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token,
      grant_type:    'refresh_token',
    });

    const upstream = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      // Surface Google's error code without leaking secrets
      return json({ error: data.error ?? 'upstream_error', error_description: data.error_description }, upstream.status);
    }

    // Return only what the plugin needs — do NOT forward the full Google response
    return json(
      { access_token: data.access_token, expires_in: data.expires_in },
      200,
    );
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
