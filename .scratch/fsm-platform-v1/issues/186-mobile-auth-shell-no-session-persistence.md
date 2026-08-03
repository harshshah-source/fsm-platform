# 186 — Mobile auth shell has no session rehydration or token refresh

Status: ready-for-agent — **partial: found uncommitted in the working tree 2026-08-03 (implementation
predates this status note; author/session untracked), committed as-is this session.** AC#1
(rehydration on mount), AC#2 (refresh-and-retry via a shared `resolveSession` helper), and AC#4 (unit
tests: rehydrate-success, rehydrate-no-token, refresh-success-retries, refresh-failure-logs-out) are
done and green (29/29 mobile tests, `tsc --noEmit` clean). **AC#3 is not done** — `console.log` debug
scaffolding remains in `LoginScreen.tsx:14,19` and `client.ts:6,9-10,19` (only `AuthProvider.tsx`'s was
removed). Small, mechanical remainder; do not re-do AC#1/#2/#4.
Type: AFK · Mobile

Filed 2026-08-03, found during the mobile-readiness precondition analysis
(`docs/status/mobile-readiness-2026-08.md`). Not covered by #91, #109, #169, or any other filed
issue (checked) — those own the *backend* credential store, the *admin* web session lifecycle, and
the *contract* respectively; this is a defect in the mobile client code that already shipped.

## What's wrong

The existing SE mobile auth shell (`apps/mobile/src/auth/`) stores a full access+refresh token pair
in the keychain on login but never uses either capability that would make a session durable:

1. **No rehydration on launch.** `AuthProvider.tsx:15` holds `session` in a plain `useState`,
   initialized to `null`, with no effect that reads the keychain on mount. `AppEntry.tsx:7-9`
   renders `LoginScreen` whenever `session` is `null` — which is always true on a fresh app
   instance. `tokenStore.ts:21-24` implements `getAccessToken()` for exactly this purpose and it is
   unit-tested (`tokenStore.test.ts:33-48`), but a repo-wide grep shows it is never imported outside
   test files. Every app restart — kill-and-reopen, OS background eviction, a crash — forces a full
   re-login, even though a valid token pair sits in the keychore.
2. **No token refresh.** The backend already exposes `POST /auth/refresh` (`auth.controller.ts:22`,
   `@Public`), and `LoginResponse.refreshToken` (`packages/shared/src/index.ts:39-42`) is stored by
   `setTokens()` (`tokenStore.ts:9-11`). No client code calls it — grep for `refresh`/`apiRefresh`
   across `apps/mobile/src` hits only the stored field name, never a call site. `apiMe()`
   (`client.ts:28-36`) throws a bare `UNAUTHORIZED` on any non-OK response; nothing catches it to
   attempt a refresh-and-retry. A short-lived access token simply logs the SE out mid-session with
   no recovery path.

## Why this matters now, not later

Every SE mobile screen still to be built (#161's ticket read surface, #163's self-artifact reads,
the Day Plan itself) will be built on top of this `AuthProvider`. If it lands after those screens
exist, every screen that assumes a live session needs to be touched again. Landing it now, while the
auth shell is still the only thing built, is a single small fix instead of an N-screen retrofit.
Field conditions make this materially worse than the same gap would be in an office app: an SE with
patchy connectivity who gets logged out mid-shift may not have signal to log back in until they
reach the next plant.

## What to build

1. On mount, `AuthProvider` calls `getAccessToken()`; if a token exists, call `apiMe()` to
   re-establish `session` before rendering `AppEntry`'s gate (with a brief loading state — there is
   no loading/splash state today either, `AppEntry.tsx:7-9` is a synchronous ternary).
2. Wrap `apiMe` (and, once other endpoints exist, every authenticated call) so a 401 triggers one
   `POST /auth/refresh` attempt using the stored refresh token, retries the original call on success,
   and falls back to `logout()` + `LoginScreen` only if refresh itself fails.
3. Remove the `console.log` debug scaffolding left in `AuthProvider.tsx` (lines 18-33),
   `LoginScreen.tsx` (14, 19), and `client.ts` (6, 9-10, 19) as part of the same slice — it's in the
   files being touched anyway and is not production-shaped logging.

## Acceptance criteria

- [ ] Killing and reopening the app with a valid stored token pair lands on `SessionScreen` (or
      whatever the current screen is at landing time), not `LoginScreen`
- [ ] An expired access token triggers a silent refresh-and-retry, not an immediate logout
- [ ] A failed refresh (expired/revoked refresh token) logs out and returns to `LoginScreen`
- [ ] No debug `console.log` remains in the touched files
- [ ] Unit tests cover: rehydrate-success, rehydrate-no-token, refresh-success-retries-original-call,
      refresh-failure-logs-out

## UI surfaces

`apps/mobile/src/auth/AppEntry.tsx`, `AuthProvider.tsx` — add a loading/splash state for the
rehydration window. No new screen.

## Reference

n/a.

## Blocked by

- None. Independent of the backend mobile-readiness blocks (#161-#175) — this is entirely
  client-side against endpoints (`/auth/login`, `/auth/refresh`, `/me`) that already work today.

## Comments

n/a.
