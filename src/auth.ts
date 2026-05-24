/** Auth module — token refresh via configurable proxy */

import { requestUrl } from 'obsidian';

// Self-hosted Cloudflare Worker proxy (oauth-proxy/worker.js).
// Replace with your own workers.dev URL after deploying.
export const DEFAULT_PROXY_URL = 'https://neogdsync-oauth.neogdsync.workers.dev';

export interface AccessToken {
  token: string;
  expiresAt: number;
}

let cached: AccessToken | null = null;

export async function getAccessToken(
  refreshToken: string,
  proxyUrl: string = DEFAULT_PROXY_URL,
): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
  }
  const resp = await requestUrl({
    url: proxyUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    throw: false,
  });
  if (resp.status >= 400) throw new Error(`Auth failed: ${resp.status}`);
  const { access_token, expires_in } = resp.json as { access_token: string; expires_in: number };
  cached = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  return cached.token;
}

export function clearTokenCache() {
  cached = null;
}
