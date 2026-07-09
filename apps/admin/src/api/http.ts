// Central session/401 policy (Issue 109). A shared fetch interceptor: any API request that comes back
// 401 triggers a single-flight rotating refresh; on success the original request is retried once with the
// refreshed bearer; on refresh failure the session is cleared and the app is told to bounce to login with
// a "session expired" notice. Installed once over `window.fetch` at app start (`installAuthFetch`), so all
// 26 api modules get the policy without change. The core (`makeAuthFetch`) is exported for direct testing.

import { clearTokens, getRefreshToken, setTokens } from './tokens';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** App-provided hook fired when the session can no longer be refreshed (revoked/expired/rotation reuse). */
let onExpired: () => void = () => {};
export function setOnSessionExpired(fn: () => void): void {
  onExpired = fn;
}

/** Login/refresh 401s are real (bad credentials / dead refresh token) — never recurse a refresh on them. */
const isAuthEndpoint = (url: string): boolean => url.includes('/auth/login') || url.includes('/auth/refresh');

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Single-flight rotating refresh. Concurrent 401s share ONE refresh call; the newly-issued refresh token
 * is stored (rotation), and a rejected refresh (revoked / expired / a reused consumed token → the backend
 * 401s) resolves to null so the caller logs the session out.
 */
function refreshOnce(rawFetch: typeof fetch): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async (): Promise<string | null> => {
      const refreshToken = getRefreshToken();
      if (!refreshToken) return null;
      try {
        const res = await rawFetch(`${BASE_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { accessToken: string; refreshToken: string };
        setTokens(data.accessToken, data.refreshToken); // rotation: persist the new token pair
        return data.accessToken;
      } catch {
        return null; // network failure during refresh → treat as unrefreshable
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Standalone refresh (used by session rehydrate). Returns the new access token, or null if unrefreshable. */
export const apiRefresh = (rawFetch: typeof fetch = fetch): Promise<string | null> => refreshOnce(rawFetch);

/** Rebuild `init.headers` with the refreshed bearer, replacing any stale Authorization. */
function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/** The interceptor core, parameterised on the underlying fetch so tests can inject a mock. */
export function makeAuthFetch(rawFetch: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const res = await rawFetch(input, init);
    if (res.status !== 401 || !url.startsWith(BASE_URL) || isAuthEndpoint(url)) return res;

    const token = await refreshOnce(rawFetch);
    if (!token) {
      clearTokens();
      onExpired();
      return res;
    }
    const retry = await rawFetch(input, withBearer(init, token));
    if (retry.status === 401) {
      clearTokens();
      onExpired();
    }
    return retry;
  };
}

/** Install the 401 policy over `window.fetch` once (app entry only; tests drive `makeAuthFetch`). */
export function installAuthFetch(): void {
  const raw = window.fetch.bind(window);
  window.fetch = makeAuthFetch(raw);
}
