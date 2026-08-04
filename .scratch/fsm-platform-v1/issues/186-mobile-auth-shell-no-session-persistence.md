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
### 2026-08-04 — SCOPE COMPLETION: AC#2 shipped for `apiMe` only; ~40 endpoints were never wrapped

Found by the cross-surface contract audit (`audit/mobile-contract-sync-audit-2026-08-04.md`, finding
A1 — the highest-severity item in either 2026-08-04 audit) and confirmed here by duplicate-check:
**this issue already owns it.** Its own AC#2 reads *"Wrap `apiMe` (and, once other endpoints exist,
**every authenticated call**) so a 401 triggers one `POST /auth/refresh` attempt … and retries the
original call on success."* When this landed, `apiMe` was the only authenticated call. It no longer is.

**Verified state 2026-08-04.** `resolveSession` (`AuthProvider.tsx:19-34`) is invoked from exactly two
places — the rehydrate-on-mount effect (`:48`) and `login` (`:65`). There is no fetch interceptor and
no 401-retry anywhere else in `apps/mobile`. Every screen added since (#55-#61, #63, #64, #66, #68,
#71, #77, #85, #86, #87 — roughly 40 client functions in `src/api/client.ts`) instead pulls the raw
token itself and maps **any** failure to `'offline'`:

```
const token = await getAccessToken();
if (!token) throw new Error('UNAUTHORIZED');
... catch { setState(s => ({ ...s, status: 'offline' })); }
```

Same shape at `HomeScreen.tsx:46-58`, `TicketsScreen.tsx:79`, `StockScreen.tsx:38,60`,
`AvailabilityScreen.tsx:41,64,87`, `VouchersScreen.tsx:29`, `LeaveRequestScreen.tsx:32`,
`NotificationsScreen.tsx:36`, `IntradayOfferScreen.tsx:50,67`, `TicketDetailScreen.tsx:73,125,143,155`,
plus every form screen.

**Field consequence.** Access-token TTL is **15 minutes** (`token.service.ts:22`; confirmed on a live
token, `exp − iat` = 900s). Fifteen minutes after login, an SE with the app in the foreground sees
every screen flip to the **"Offline"** badge with full connectivity — no refresh attempt, no logout,
no bounce to `LoginScreen`. The session recovers only on a full app restart, because that is the one
path that re-runs the mount effect. Misreporting an auth expiry as a connectivity failure is the worst
available copy for a field user, and it is the single most likely source of false bug reports from a
pilot ("the app keeps going offline" sends investigation to the network, not to auth).

**Compounding, found in the same pass and folded in here (finding N1):** two screens tell the user
*"Pull to retry"* (`StockScreen.tsx:80`, `TicketDetailScreen.tsx:273`) and **`RefreshControl` appears
zero times in the entire mobile app** — the instructed gesture does nothing, and switching tabs
re-runs the same effect with the same dead token. There is genuinely no in-app recovery.

**Port from, do not reinvent:** `apps/admin/src/api/http.ts:27-82` already implements this correctly —
single-flight refresh (`refreshOnce`, `:27-50`), one retry with the new bearer (`:75`), and
`clearTokens(); onExpired()` on failure (`:71-73`, `:77-79`). Admin additionally refreshes proactively
60s before expiry (`apps/admin/src/auth/AuthProvider.tsx:57-69`); mobile should at minimum match the
reactive half. Note the `url.startsWith(BASE_URL)` gate at `http.ts:67` — the equivalent mobile guard
must not exclude any client function.

**Added ACs (this issue's scope, not a new issue):**
- [ ] Every authenticated call in `src/api/client.ts` routes through one wrapper that refreshes once
      on 401 and retries — adding a new endpoint must not require remembering to opt in
- [ ] A 401 after refresh fails logs out to `LoginScreen`; a genuine network failure still reads
      "Offline". The two are distinguishable on screen
- [ ] `Error(undefined)` is impossible: guard-level 401/403 bodies carry no `code` (verified live —
      `{"message":"Unauthorized","statusCode":401}`), yet `recoveryPost`/`installPost`/`intradayPost`/
      `apiSetAvailability` destructure `{code}` from every non-2xx. Parse defensively here; the server
      half is [#169](./169-se-api-contract-freeze.md) item 1
- [ ] Either implement pull-to-refresh where the copy promises it, or remove the copy
- [ ] Regression test: a 401 mid-session triggers refresh-and-retry, not an offline state. **Cheap** —
      `AuthProvider.test.tsx` already exists

Tracked under [#197](./197-mobile-pilot-readiness-remediation-epic.md) as the top P1 slice.
