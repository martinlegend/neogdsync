/**
 * NeoGDSync OAuth Proxy — Cloudflare Worker
 *
 * Three endpoints:
 *   GET  /authorize  → redirect to Google OAuth consent screen
 *   GET  /callback   → exchange auth code for tokens, show refresh_token to user
 *   POST /           → exchange refresh_token for access_token (used by plugin at sync time)
 *
 * Deploy:
 *   1. wrangler secret put GOOGLE_CLIENT_ID
 *   2. wrangler secret put GOOGLE_CLIENT_SECRET
 *   3. wrangler deploy
 *
 * Free tier: workers.dev subdomain, HTTPS included, 100k req/day.
 */

const SCOPES = 'https://www.googleapis.com/auth/drive';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── GET /authorize — start OAuth flow ──────────────────────
    if (request.method === 'GET' && url.pathname === '/authorize') {
      const params = new URLSearchParams({
        client_id:     env.GOOGLE_CLIENT_ID,
        redirect_uri:  `${url.origin}/callback`,
        response_type: 'code',
        scope:         SCOPES,
        access_type:   'offline',
        prompt:        'consent',   // always return refresh_token
      });
      return Response.redirect(
        `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
        302,
      );
    }

    // ── GET /callback — exchange code, show refresh_token ───────
    if (request.method === 'GET' && url.pathname === '/callback') {
      const error = url.searchParams.get('error');
      if (error) return html(errorPage(error));

      const code = url.searchParams.get('code');
      if (!code) return html(errorPage('No authorization code received.'));

      const upstream = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          code,
          client_id:     env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri:  `${url.origin}/callback`,
          grant_type:    'authorization_code',
        }).toString(),
      });

      const data = await upstream.json();
      if (!upstream.ok) return html(errorPage(data.error ?? 'Token exchange failed.'));

      return html(successPage(data.refresh_token));
    }

    // ── POST / — refresh access_token (plugin sync path) ────────
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

    const upstream = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token,
        grant_type:    'refresh_token',
      }).toString(),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      return json(
        { error: data.error ?? 'upstream_error', error_description: data.error_description },
        upstream.status,
      );
    }

    return json({ access_token: data.access_token, expires_in: data.expires_in });
  },
};

// ── HTML helpers ───────────────────────────────────────────────

function successPage(refreshToken) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NeoGDSync — Connected</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 520px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { color: #1a7f37; }
    .token-box { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 16px; font-family: monospace; font-size: 13px; word-break: break-all; margin: 16px 0; }
    .copy-btn { background: #1a7f37; color: #fff; border: none; border-radius: 6px; padding: 10px 20px; font-size: 15px; cursor: pointer; }
    .copy-btn:active { background: #116329; }
    p { line-height: 1.6; color: #555; }
    .step { font-weight: 600; color: #1a1a1a; }
  </style>
</head>
<body>
  <h1>✅ Google Drive connected</h1>
  <p>Copy your refresh token below, then paste it into NeoGDSync settings.</p>
  <div class="token-box" id="token">${refreshToken}</div>
  <button class="copy-btn" onclick="copyToken()">Copy token</button>
  <p style="margin-top:24px">
    <span class="step">Back in Obsidian → NeoGDSync settings:</span><br>
    Paste the token into the <strong>Refresh token</strong> field (or tap <em>Paste token</em> if the button appears).
  </p>
  <script>
    function copyToken() {
      navigator.clipboard.writeText(document.getElementById('token').innerText)
        .then(() => { document.querySelector('.copy-btn').textContent = 'Copied!'; })
        .catch(() => { document.querySelector('.copy-btn').textContent = 'Copy failed — select manually'; });
    }
  </script>
</body>
</html>`;
}

function errorPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>NeoGDSync — Error</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 520px; margin: 60px auto; padding: 0 20px; }
    h1 { color: #cf222e; }
  </style>
</head>
<body>
  <h1>❌ Authorization failed</h1>
  <p>${error}</p>
  <p><a href="/authorize">Try again</a></p>
</body>
</html>`;
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

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
