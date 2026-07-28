# Backend Readiness for SE Mobile — Independent Assessment

> **SUPERSEDED 2026-07-28 → [`mobile-backend-freeze-plan-2026-07-28.md`](./mobile-backend-freeze-plan-2026-07-28.md).**
> Reconciled into a single plan. Its central contribution — that contract stability, request
> validation, the error contract and the app lifecycle were systematically missed by the two
> backend-interior assessments — is accepted and promoted. **One claim is refuted:** the mobile test
> suite is **not** red; it passes 6 suites / 20 tests (executed twice). The real finding is that CI
> never invokes it. Historical — do not update.

**Date:** 2026-07-28 · **Branch:** `feat/autoplant-integration` · **HEAD:** `0d3b85d`
**Type:** READ-ONLY. No code, no edits, no commits, no issues filed.

## Provenance — read this before trusting the framing

Independence was requested and only partly achieved. Stating it plainly:

- The **client/server contract and app-lifecycle axis (§A1–A4)** is genuinely independent. It came
  from an investigator with no knowledge of either prior assessment, working from the code and the
  running repo. I then re-verified its sharpest claims myself; one it marked `[INFERRED]` turned out
  to be a **confirmed** crash path (§A2.1).
- The **spec-target, endpoint-inventory, phone-reality and off-axis investigations were stopped
  before reporting.** Findings in §A5 are carried forward from work done earlier in this same
  session — which *is* the 07-28 prior assessment. They are evidence-backed at file:line and I
  stand behind them, but they are **not** independently re-derived and must not be read as
  corroboration of the priors. They are the priors.

The honest summary: this assessment adds a **new axis** the two priors both missed almost entirely,
and re-states the axes they covered. §E is written with that asymmetry in mind.

---

## A. Findings

Organised by what the evidence forced, not by a supplied checklist. Severity is argued, not asserted.

### A1. The mobile app cannot be run, and its tests are red without anyone knowing

Severity: **Blocking, day one.** Cheap to fix; the cost is entirely in discovering it on Monday
instead of Friday.

`apps/mobile` is 5 production files, ~150 lines. It is not a working auth shell:

- **The keychain is write-only.** `tokenStore.getAccessToken()` (`apps/mobile/src/auth/tokenStore.ts:21`)
  has **zero production call sites** — every reference is a test or the definition itself.
  `AuthProvider.tsx:15` is `useState<SessionView|null>(null)` with **no `useEffect` anywhere in the
  file**, so every cold start renders `LoginScreen` while a valid token pair sits unread in the
  keychain. Compare `apps/admin/src/auth/AuthProvider.tsx:84-117`, a 34-line rehydrate effect that
  already solves this. *Built-wrong, not never-built* — the storage layer and its 55 lines of tests
  exist and are decorative.
- **It cannot run on the target hardware.** `react-native-keychain@^10` (`apps/mobile/package.json:41`)
  is a native module; there is no `ios/`, no `android/`, no `eas.json`, and `expo-secure-store` (the
  managed-workflow equivalent needing no prebuild) is absent. `app.json` has no
  `ios.bundleIdentifier` and no `android.package`. `apps/mobile/src/api/client.ts:5` defaults to
  `http://10.0.2.2:3000/api` — the **Android-emulator-only** loopback alias, which resolves to
  nothing on an iOS simulator or any physical handset.
- **Error mapping is actively misleading.** `client.ts:22-24` throws `INVALID_CREDENTIALS` for
  **every** non-2xx, and a network throw lands in the same catch — so a backend that is *down* tells
  the engineer their password is wrong (`LoginScreen.tsx:20`). Admin solved this already:
  `apps/admin/src/api/client.ts:5-31` discriminates `INVALID_CREDENTIALS` (401 only) from
  `SERVICE_UNAVAILABLE`, with a comment explaining exactly this distinction. Mobile is a strictly
  worse copy of a file that got it right.
- **Fourteen unguarded `console.log` calls on the auth path** (`client.ts:6,9,10,19`;
  `AuthProvider.tsx:18,20,22,23,25,26,28,29,31,33`; `LoginScreen.tsx:14,19`), including the caught
  error object. No `__DEV__` guard, so a release build writes auth traces to logcat.
- **The one screen that exists renders a manager concept.** `SessionScreen.tsx:10-18` displays
  `acted_as_role`, which only CSM/Operations Head can ever populate
  (`apps/backend/src/auth/acting-context.ts:4`). The provider tests log in as
  `zm.north@fsm.test`/`ZONAL_MANAGER` (`AuthProvider.test.tsx:25,33,57`). This is the SE app.
- **The suite is red right now**: 1 failed / 20 tests, an `AuthProvider` timeout
  ([INFERRED] a React 19 / `reactCompiler` `act()` interaction — the redness is certain, the cause
  is not). Typecheck is clean.

**Why nobody knew:** `ci.yml:107-113` hardcodes two test steps, `working-directory: apps/backend`
and `apps/admin`. `@fsm/mobile#test` exists in the Turbo graph and is **never invoked** — while
`ci.yml:86` uses `pnpm turbo run typecheck`, which *does* cover mobile (the step label
"Typecheck (backend + admin)" undersells it). The workflow's own header says it was written because
"both suites were red and nobody knew: the backend for 43 commits, the admin for 3." Mobile is the
third instance of the exact bug the file exists to kill. **Fix: one more test step.** It must land
before mobile work starts or the trap re-arms permanently.

### A2. The error contract cannot support correct client behaviour

Severity: **Blocking for a well-built client.** Everything the engineer writes in week one — the
HTTP client, the retry policy, the error-to-message mapping — has to be rewritten once this settles.

The controller layer is genuinely disciplined: 219 throw sites carry a machine-readable
`{ code }`, and the filter reproduces `exception.getResponse()` verbatim precisely so route
contracts don't change (`all-exceptions.filter.ts:42-49`). `troubleshoot.controller.ts:99-110` is a
model for mobile — a 409 carrying `winnerSeId`/`winnerAt`/`shadowUseRecorded`, and an explicit
`duplicate: true` on idempotent replay. That is better than most codebases and should be the
template. But:

#### A2.1 Request bodies on every SE write route are unvalidated — and client bugs surface as 500

**This is the finding I am most confident is new, and it is worse than a missing idempotency key.**

`app.module.ts` registers a global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true,
transform: true })`. Nest skips non-class metatypes, so it validates **only** class DTOs. Grep for
`class-validator` across `apps/backend/src` returns **exactly one file**:
`cross-zone/cross-zone.dtos.ts`. Every other `@Body()` is a TypeScript **interface**, erased at
runtime — `TroubleshootBody`, `FileBody`, `SubmitBody`, `SetAvailabilityBody`, `CreateBody`,
`FittedBody`, `LoginRequest`, and ~30 more (verified across the `@Body() body:` grep).

Controllers hand-roll a few checks. `troubleshoot.controller.ts:74-79` validates **2 of its 11
fields**. The rest reach the service unchecked, and one is a confirmed crash:

```ts
// troubleshoot.controller.ts:92
componentUnavailableItem: body.componentUnavailableItem ? BigInt(body.componentUnavailableItem) : null,
```

`BigInt("abc")` throws `SyntaxError`. That is not an `HttpException` and carries no numeric
`status`, so it falls through both filter branches to the generic handler
(`all-exceptions.filter.ts:71-77`) and returns **500 `Internal server error`**. A client bug — a
malformed id, a GPS reading that arrives as a string — is reported to the phone as *the server is
broken*. (`seGps?: {lat,lon}` at `:43` flows unvalidated to `seGpsLat: input.seGps?.lat` the same
way.)

The consequence is specifically a mobile consequence: **5xx is the one status a retry policy must
treat as transient.** So a client-side bug produces an infinite retry loop against a server with no
rate limiting (§A2.3), and the resulting load looks like an outage rather than a bad build.
*Built-wrong.* The fix is DTOs on the SE write routes — mechanical, and much cheaper before a
thousand handsets encode the current behaviour.

#### A2.2 The same error code arrives in different JSON fields

Six distinct body shapes exist. The sharpest instance is provable from the repo's own e2e
assertions: `ZONE_SCOPE_VIOLATION` is thrown as a **string** by the guard
(`common/guards/zone-scope.guard.ts:37` → `{statusCode:403, message:'ZONE_SCOPE_VIOLATION',
error:'Forbidden'}`) and as `{ code: 'ZONE_SCOPE_VIOLATION' }` by controllers
(`se-planner.controller.ts:64`, `tier-overrides.service.ts:78,140`). Same code, same status,
different field. Guard 401/403s carry **no code at all** (`auth.guard.ts:45,51`, `role.guard.ts:32`).
A client cannot write one `parseError()`; it must check both fields forever, and guess for the
guards.

#### A2.3 "Try again later" does not exist in the contract

Grep across `apps/backend/src` for `Throttler|rateLimit|429|TooManyRequests|Retry-After`:
**zero hits.** The only `ServiceUnavailableException`s are the health probe and an ingestion route,
neither SE-facing. So the backend never tells a client that retrying is safe and useful — every
transient failure is indistinguishable from a permanent one, and every retry policy mobile writes
is guesswork. Combined with §A2.1 this is the thundering-herd mechanism: unretryable requests that
look retryable, retried by 1,000 handsets, against a server with no throttle.

**Scored against the five questions a mobile client must answer:** "someone else got there first"
— yes, and well (409 + winner payload). "You already did this" — on **2 routes only**
(troubleshoot, vouchers; unique `(se_id, client_submission_id)` at `schema.prisma:870`).
"You did something wrong" — only where hand-rolled; otherwise it becomes a 500. "Try again later"
— no. "The server is broken" — yes, and over-subscribed by §A2.1.

### A3. Once v1 ships, nothing can be changed or recalled

Severity: **High, and systematically underweighted.** This is not a day-one blocker; it is the
finding with the worst cost-to-fix-later ratio in the whole assessment.

All of the following returned zero hits: `@nestjs/swagger`/OpenAPI (absent from source *and*
`package.json`), `enableVersioning`/`VersioningType`/`@Version` (the prefix is a flat
`setGlobalPrefix('api')`, there is no `/v1`), any client-version header or minimum-version check,
contract tests, `expo-updates`/`eas.json`/`runtimeVersion` (**no OTA channel and no forced-upgrade
mechanism — an installed APK cannot be updated or blocked**).

And the coupling that would otherwise catch drift does not exist. `packages/shared/src/index.ts` is
**76 lines total**: `ROLES`/`isRole`, `SessionView`, `LoginRequest`, `LoginResponse`, `SlaBucket`,
`SLA_BANDS`. No domain types. **None of the 149 error codes.** They exist only as inline string
literals across 219 throw sites.

The concrete failure: someone renames `{ code: 'TICKET_ALREADY_CLOSED' }`. Backend suite green (it
asserts the new string). Admin unaffected. Mobile typecheck green (string literal, no shared type).
Deploy. A thousand handsets fall through their conflict branch into a generic error on the single
most important SE workflow — with no OTA to push a fix, no version gate to serve the old shape, and
no signal except engineers phoning in.

**The mitigation is unusually cheap for the risk it retires:** move SE-facing error codes and
response types into `@fsm/shared` and import them at the throw sites. That converts the entire
class into a compile error using machinery that already exists and is already in CI.

### A4. Sessions cannot survive a fleet's normal life

Severity: **Blocking.** Overlaps the priors' auth findings but adds two they did not state.

- **No logout endpoint exists.** `auth.controller.ts:16-26` has exactly two routes, `login` and
  `refresh`. Grep for `logout` across all controllers: nothing. `InMemoryRefreshTokenStore` exposes
  only `issue` and `consume` — **no `revoke`, no `revokeAllForUser`**. Mobile's `logout()`
  (`AuthProvider.tsx:38-41`) clears the local keychain only; the refresh token stays valid
  server-side for up to 30 days. **A lost or stolen handset cannot be revoked at all.** For a field
  workforce with device turnover that is a security finding, not a papercut. *Never-built.*
- **Every deploy logs out the entire fleet.** The store is a `Map` whose own docstring says
  "does not survive restart and is not shared across instances"
  (`auth/refresh-token-store.ts:16,19-21`); there is no refresh/session table in `schema.prisma`.
  Access tokens are 15 minutes (`token.service.ts:22`), so within 15 minutes of any restart, 1,000
  SEs are hard-logged-out and must retype a password — in the field, possibly with no signal. It
  also caps the backend at one instance.
- **Single-use rotation with no grace window.** `consume()` revokes before returning
  (`refresh-token-store.ts:30-37`). Correct for reuse detection; on a handset it means a refresh
  whose *response* is lost to a dropped connection permanently burns the session. Routine on 2G,
  rare in an office browser. Admin defends with single-flight (`apps/admin/src/api/http.ts:20-50`);
  mobile has no refresh logic at all, so when written, single-flight is mandatory.
- **One SE account exists**, `se.north@fsm.test` (`auth/user-store.ts:45-49`), one of 8 hardcoded
  seeds sharing the password `'correct-password'`. Beyond the known production gap, this is a
  **day-one dev-loop blocker**: two engineers testing simultaneously share one identity and one
  soft-state machine, so their test runs corrupt each other.

### A5. Carried forward from earlier this session — not independently re-derived

Stated compactly because §E depends on them; provenance flagged above.

- **M3 Ticket Detail has no SE data source.** `GET /api/tickets/:id` is manager-only
  (`ticketing/tickets.controller.ts:70-71`); recovery tickets have no GET at all; the day plan
  returns `{ticketId, sortOrder}` only (`scheduling/day-plan-query.service.ts:62-77`). Install
  detail *is* SE-readable (`install.controller.ts:216-217`) — the asymmetry is real.
- **Row-level authorization gaps.** `ZoneScopeGuard` returns `true` for every non-ZM
  (`zone-scope.guard.ts:27-29`, re-read this session). `POST /tickets/:id/troubleshoot` validates
  existence + workType + `status==='OPEN'` only (`troubleshoot-submission.service.ts:107-116`) — no
  assignment or coverage check, against **13,941** OPEN troubleshoot tickets. Soft-state writes never
  query `tickets` at all; `confirm-receipt` has no ownership check; the SE verification read is
  unscoped.
- **Offline breaks verification, and the failure mode is a fraud flag.** Writes are server-stamped
  (`troubleshoot-submission.service.ts:104,140`); Phase 1 searches pings *after* that stamp
  (`verification.service.ts:203,283`). A repair done at 10:00 and uploaded at 16:00 from a vehicle
  that has since moved trips `fraud: true` (`verification-criteria.ts:80`) → immediate
  `FAILED_VERIFICATION` (`verification.service.ts:221-224`). **Irreversible, and it accuses the
  engineer.**
- **Unbounded reads:** shared pool has no `take` (worst measured 1,015 tickets ≈152 KB/poll);
  one live schedule holds 1,453 tickets; notifications are fixed newest-50 with no cursor.
- **Day plan has no date filter** (`day-plan-query.service.ts:41-46`) and schedules are never
  closed — 21 of 64 SEs' latest live plan is entirely past-dated.
- **Connection posture:** pg defaults `max:10`, no acquisition timeout, `statement_timeout=0`,
  13 in-process crons on the same pool.
- **Observability:** correlation IDs exist only in the exception filter; successful requests
  produce no log line at all.

---

## B. The blunt verdict — what they build, and where they stop

**There are two walls, and the earlier one is not the one the priors named.**

**Monday–Tuesday: they don't write a screen.** They fight the environment. The app cannot build
(native keychain module, no prebuild, no `eas.json`, no bundle IDs), cannot reach the backend from
anything but an Android emulator (`10.0.2.2`), and its test suite is red on a clean checkout. They
discover the keychain is write-only and rehydration was never built. They discover one SE account
exists and they cannot both use it. Every one of these is mechanical — and every one is invisible
until someone tries, because CI never ran mobile.

**Wall 1 — the foundational wall, hit around day 3.** They sit down to write the API client, and
find they cannot write a correct one. They cannot distinguish "you already did this" from "someone
else won" on 10 of 12 write routes. They cannot distinguish a client bug from a server outage,
because unvalidated bodies 500 (§A2.1). They cannot express "retry later" because the server never
says it. They must hardcode 149 error-code strings with no shared type and no compile-time
protection. **They can proceed** — by guessing — and everything they guess gets rewritten later,
in a client that by then is deployed and unrecallable.

**Wall 2 — the functional wall, hit around day 4–5.** M3 Ticket Detail, the centre of the app,
**has no data source at all.** The day plan returns bare ticket IDs and nothing SE-callable expands
them. This one is a hard stop: no amount of client engineering works around a missing endpoint.

**What they can actually finish before that:** the shell, login (as one synthetic SE), van stock,
notifications (newest 50), availability, voucher *create* and leave *create* — both write-only, since
the SE cannot read either back. Roughly **2–3 of ~14 screens**, and the day-plan screen among them
will show a stale plan to a third of engineers.

The distinction that matters: **Wall 2 is what stops them building. Wall 1 is what makes what they
build wrong.** Wall 1 is cheaper to remove and the priors ranked it near-last.

---

## C. Before mobile starts vs in parallel

**Must be true before the first screen** — because each is either a hard stop or is client-breaking
to retrofit onto a shipped fleet:

1. **CI runs `apps/mobile` tests, and the red test is fixed.** One CI step. Do it first — it is the
   precondition for trusting anything else. (~1 hour)
2. **The app can run**: `expo-secure-store` or a committed prebuild/`eas.json`, bundle identifiers,
   a base URL that resolves off an Android emulator. (~1 day)
3. **Real SE credentials** (#91) — with, at minimum, a path to seed several engineers so the mobile
   team can test concurrently. Reasoning: every screen and every scoping test is meaningless against
   one shared identity.
4. **The error contract**: normalize the code field (always `body.code`, guards included), and move
   SE-facing error codes + response types into `@fsm/shared`. Reasoning: this is the only item whose
   cost *rises* after v1 ships and cannot be undone without an OTA channel that doesn't exist.
5. **DTO validation on SE write routes**, so client errors are 4xx. Reasoning: retry policy is built
   on this distinction; getting it wrong bakes an infinite-retry bug into the client.
6. **The SE ticket-read surface** (M3's data source). Reasoning: it is Wall 2, and its payload shape
   determines the client's data model and offline cache schema.
7. **Day-plan date correctness.** Reasoning: without it the Home screen lies to a third of engineers
   on day one.

**Land in parallel** — real, but not shape-setting for the client, or already gated on a decision:

- Row-level authorization floor — *with one hard constraint: it must land no later than #91's
  credential rollout*, because 75 real logins against an unscoped write surface is the moment the
  exposure becomes real.
- Connection pool sizing, acquisition timeout, statement timeouts (hours of config; do it before
  any load test, or the test measures the wrong thing).
- Idempotency keys on the remaining mutations, and pagination/cursors — **before the client's write
  and list layers**, which is later than "before the first screen" but earlier than most people think.
- Observability (correlation IDs on success, access logs) — before field pilot, not before dev.
- Capture-time authority — **decision** before the offline cache is designed; **build** can trail.
- Push/device registry, media upload, ticket search, technical hints — each blocks specific screens,
  none blocks starting.

**Dependency reasoning in one line:** items 1–2 gate the team's ability to observe anything; 3 gates
their ability to test anything; 4–5 gate their ability to build anything *correctly*; 6–7 gate their
ability to build the core screens *at all*.

---

## D. Decisions only you can make

New from this axis:

| # | Decision | Blocks | Options | Recommendation |
|---|---|---|---|---|
| D-a | **How is a shipped app updated?** There is no OTA channel and no forced-upgrade gate. | Everything about how tolerable a v1 mistake is | `expo-updates` + EAS channels · store-only releases + a server-side minimum-version gate · both | **Both, and cheaply**: EAS OTA for JS fixes, plus an `X-App-Version` header the server can refuse. Without one of these, every §A3 risk is permanent. This is a real cost — it needs your call, not mine. |
| D-b | **Is there an API contract artifact?** No OpenAPI, no contract tests, 149 error codes as loose strings. | Whether server changes can silently break the field | Adopt `@nestjs/swagger` · shared-types-only via `@fsm/shared` · neither | **Shared types + error codes in `@fsm/shared` now** (cheap, uses existing CI); OpenAPI only if you want generated clients. Do not do neither. |
| D-c | **Native module or managed workflow?** `react-native-keychain` forces a prebuild that has never been configured. | The entire build/release pipeline | `expo-secure-store` (managed, no prebuild) · commit a prebuild + `eas.json` | **`expo-secure-store`** unless something else already needs native code. Same security posture, no pipeline. |
| D-d | **API versioning now or never?** Adding `/v1` after v1 ships is itself a breaking change. | Ability to evolve SE endpoints | Flat `/api` forever · `/api/v1` from the start | **`/api/v1` now.** It costs a prefix today and is unobtainable later. |

Carried forward, still open and still yours: capture-time authority and the backdating window (the
sharpest one — it decides whether an offline repair can be recorded honestly); one-device-vs-many
(time-critical, it shapes the `refresh_tokens` table before it freezes); push provider; mobile token
lifetime; media storage mechanism; SE write scope (covered-any vs covered-claimed); and whether the
single-instance ceiling is accepted for the pilot.

---

## E. Comparison with the two prior assessments

*(Read only after the above was written.)*

### What this assessment found that both priors missed

Both priors are backend-interior documents. Neither treats the mobile client as a **shipped artifact
with a lifecycle**, and that blind spot is shared and systematic:

1. **Request bodies are unvalidated on every SE write route** (§A2.1). Neither prior mentions
   validation at all. Both frame write safety as *idempotency*; neither noticed that the more basic
   problem is that a client bug returns 500 rather than 400, which breaks retry logic in the
   direction that generates load. The 07-28 doc discusses `#99`'s "global guard + ValidationPipe"
   as landed and green without ever checking that the pipe validates nothing on these routes.
2. **The error contract is not machine-parseable by a client** (§A2.2) — same code in `body.code`
   vs `body.message`, guards emitting no code. The 07-28 doc's only error-shape finding (N17) is
   that 4xx bodies lack `correlationId` — true, but a footnote next to this.
3. **No logout endpoint exists** (§A4). Both priors discuss revocation as a `#91` capability gap;
   neither states that there is no logout route at all, so a lost handset's token stays live for
   30 days.
4. **No `Retry-After`, no 429, no way to say "retry later"** (§A2.3). The priors treat rate limiting
   (`#110`) purely as a *server protection*. It is also a **client contract** gap, and that framing
   changes the fix.
5. **`@fsm/shared` shares nothing** (§A3) — 149 error codes as inline literals, no domain types, so
   a rename typechecks green across the monorepo and breaks the field silently.
6. **No OTA, no forced upgrade, no version negotiation, no `/v1`** (§A3, D-a/D-d).
7. **CI never runs mobile tests, and the mobile suite is red** (§A1) — the third instance of the
   exact failure the CI workflow was written to prevent.
8. **`apps/mobile` is substantially broken, not merely thin** (§A1): write-only keychain, no
   rehydrate, Android-emulator-only URL, no bundle IDs, 14 unguarded auth-path `console.log`s, a
   screen rendering a manager-only field. The 07-28 doc has one footnote (N18) covering two of these
   and files nothing.

### What the priors found that this pass missed, and why

The four investigators covering spec-target, endpoint inventory, phone-reality and off-axis were
stopped before reporting, so **this pass did not independently re-derive**: the full PRD screen walk,
the complete SE-reachable route inventory, the soft-state/confirm-receipt/verification-read
authorization gaps, the live payload and staleness measurements, the connection-pool and cron
analysis, or the offline capture-time architecture. §A5 carries them forward from the same session
rather than pretending to have re-found them. **That is a gap in this assessment, not a correction
of theirs** — those findings are well-evidenced and I did not re-litigate them.

Two things I'd have expected an independent pass to test and cannot claim to have: whether the
07-28 doc's *correction* of the 07-22 doc (that the Shadow-Use double-decrement is unreachable via
HTTP because `consumedComponents` is never wired from the controller) is right — I believe it is,
having re-read `troubleshoot.controller.ts:32-44` above and confirmed no such field exists — and
whether the 13,941-ticket blast radius is still current.

### Where I disagree with them

**1. Contract stability was badly underweighted — including by me.** The 07-28 doc lists it as
**N22**, "low (nice-to-have), unfiled", phrased as "CI produces no API-contract artifact a mobile
client could pin against". That is the wrong severity by a wide margin, and it is wrong *by that
document's own logic*: it argues correctly that pagination and idempotency must land before the
client because they are "cheap now and client-breaking later" — and then fails to apply that
identical argument to response shapes and error codes, which are **more** exposed (a thousand
handsets, no recall mechanism at all) and **cheaper** to protect (move strings into an existing
shared package). I was wrong about this; it belongs in the pre-start set, not a footnote.

**2. "Auth shell only" was taken at face value by both.** Both describe `apps/mobile` as an auth
shell and reason about the backend as though the client side were a clean slate. It is not a clean
slate; it is a small amount of wrong code with red tests that CI does not run. That changes the
Monday plan materially — the first two days are environment and cleanup, not screens.

**3. On the ranking of the M3 blocker, I agree with them — with a refinement.** Both priors call the
missing SE ticket read the #1 hard blocker. That is right, and my Wall 2 is their finding. But they
rank the *foundational* items (error contract, validation, versioning) at or near the bottom, and
that inverts the economics: Wall 2 stops work and is therefore self-announcing; Wall 1 does not stop
work, which is exactly why it ships.

### Where they were right and I'll say so plainly

- **The M3 ticket-detail gap is the correct #1 functional blocker.** Both found it; the 07-22 doc
  found it first and stated the reason well — the payload shape determines the client's whole data
  model, so retrofitting it is a migration on every installed device.
- **The offline/verification incompatibility is the deepest architectural finding in all three
  documents**, and the 07-28 doc's sharpening of it — that a genuine repair on a moved vehicle
  produces a *fraud flag*, not merely a failed verification — is the single most important thing any
  of these assessments contains. It is irreversible and it accuses the engineer whose livelihood
  depends on the record. I did not improve on it.
- **Sequencing the authorization floor to land no later than `#91`'s credential rollout** is exactly
  right, and is the kind of ordering constraint that is easy to miss.
- **The 07-28 correction of the 07-22 severity claim** (Shadow-Use armed-but-unreachable) is
  intellectually honest and, as far as I can verify, correct.
- **The 07-22 assessment's core three-part framing** — an SE cannot read a ticket, cannot log in,
  and the process cannot hold the connections — has held up across six days and two re-examinations.

---

*Read-only. No code changed, no issues filed. Claims are cited at file:line; measurements carried
forward from earlier this session are marked as such in §A5. `[INFERRED]` marks inference.*
