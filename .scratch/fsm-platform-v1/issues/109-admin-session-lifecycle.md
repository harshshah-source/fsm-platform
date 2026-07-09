# 109 — Admin session lifecycle: token refresh, 401 handling, session restore on reload
Status: done (2026-07-09, TDD) — rotating refresh token persisted (`api/tokens.ts`); central 401 policy
(`api/http.ts` `makeAuthFetch` installed over `window.fetch` once — single-flight rotating refresh →
retry-once → on failure clear + expiry hook; covers all 26 api modules untouched); mount rehydration via
`/me` behind a loading gate in `AuthProvider` + `ProtectedRoute` (no login bounce; proactive refresh ~1 min
before JWT exp); honest login errors (`LoginError` 401=INVALID_CREDENTIALS / network·5xx=SERVICE_UNAVAILABLE)
+ "session expired" notice on `LoginPage`. 9 vitest (expiry→refresh→retry, rotation reuse→logout, error
mapping, rehydration, expiry notice); full admin suite 211 green, tsc + build clean. httpOnly-cookie upgrade
remains #91's.
Type: AFK

> Source: 2026-07-07 independent re-audit (new finding — frontend; no prior issue owns it).

## Evidence

- `apps/admin/src/auth/AuthProvider.tsx:37-41` — `login` stores only `accessToken` in
  sessionStorage; the `refreshToken` in `LoginResponse` is **discarded**. No code in `apps/admin`
  references `refreshToken` (grep: zero matches outside tests).
- Backend access tokens expire after **15 minutes** (`token.service.ts` `accessTtlSec = 15 * 60`);
  the 30-day rotating refresh flow exists (`POST /auth/refresh`) but has no frontend caller.
- `AuthProvider` state starts `session = null` on every mount and nothing re-hydrates from the
  stored token — a browser **reload lands on the login page even with a valid token** in
  sessionStorage (`ProtectedRoute` checks `session`).
- No API layer intercepts 401: each `api/*.ts` throws a generic `Error`, so an expired token
  surfaces as per-page "Failed to load" error states, never a redirect to login.
- `api/client.ts:11-13` — `apiLogin` maps **every** non-OK response (500, network refusal, CORS) to
  `INVALID_CREDENTIALS`, telling users their password is wrong when the backend is down.

## Root cause

FE-01 built login parity presentation-only; the session-lifecycle half (refresh loop, 401 policy,
rehydration) was never picked up by any FE issue — the backlog's auth follow-up (#91) is
backend-only.

## Production impact

Every admin user is silently logged out 15 minutes after login: dashboards polling on the expired
token show generic error states with no path back but a manual re-login; any form being filled at
minute 15 loses its work. A reload at any time also bounces to login. This makes the dashboard
effectively unusable for a real ops shift.

## What to build

1. **Persist + use the refresh token**: store the rotating refresh token alongside the access token
   (sessionStorage now; the httpOnly-cookie upgrade stays #91's fast-follow — `app.config.ts` CORS
   is already `credentials: true` for it), and refresh proactively before the 15-min expiry or
   reactively on the first 401, then retry the failed request once.
2. **Central 401 policy**: a shared fetch wrapper (the `authHeaders` seam already exists) that on
   401 attempts one refresh; on refresh failure clears the session and redirects to login with a
   "session expired" notice.
3. **Session restore**: on `AuthProvider` mount with a stored token, call `/me` to rehydrate
   `session` (loading gate, not a login bounce); a 401 falls into the refresh-then-login path.
4. **Honest login errors**: distinguish 401 (`INVALID_CREDENTIALS`) from network/5xx
   (`SERVICE_UNAVAILABLE`) in `apiLogin` and render them differently on `LoginPage`.

## Acceptance criteria

- [ ] An expired access token during an active session refreshes transparently; the in-flight request retries once and succeeds; the user never sees a login bounce while the refresh token is valid.
- [ ] Refresh-token rotation is honored (each refresh stores the newly-issued token; reuse of a consumed token → logout).
- [ ] Reload with a valid stored token restores the session via `/me` without re-login; reload with an invalid token lands on login cleanly.
- [ ] Refresh failure (revoked/expired) clears storage and redirects to login with a "session expired" message — no dead error states.
- [ ] `LoginPage` shows "invalid credentials" only for 401; backend-down shows a service error.
- [ ] Regression tests (vitest): token-expiry → refresh → retry flow; rotation reuse-rejection → logout; mount-rehydration; login error mapping. Existing admin suite green; selector contract preserved.

## UI surfaces
Admin: LoginPage (error states), global session handling (all pages). No layout change — behavior only.

## Reference
docs/ui/desktop/v2-reference/00-login.png (existing login parity is not altered)

## Blocked by
None — works against the current in-memory auth; #91 (Postgres auth + httpOnly cookie) builds on the
same seam and is not a prerequisite.
