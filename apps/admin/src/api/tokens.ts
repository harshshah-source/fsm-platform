// Session token store (Issue 109). The rotating refresh token is persisted alongside the access token
// so a session survives the 15-min access-token expiry. sessionStorage for now; the httpOnly-cookie
// upgrade is #91's fast-follow (the CORS `credentials:true` seam is already in place). `authHeaders.ts`
// reads the same ACCESS_KEY literal — keep them in sync.

const ACCESS_KEY = 'fsm.accessToken';
const REFRESH_KEY = 'fsm.refreshToken';

export const getAccessToken = (): string | null => sessionStorage.getItem(ACCESS_KEY);
export const getRefreshToken = (): string | null => sessionStorage.getItem(REFRESH_KEY);

export function setTokens(accessToken: string, refreshToken?: string): void {
  sessionStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) sessionStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens(): void {
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
}
