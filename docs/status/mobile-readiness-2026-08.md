# Mobile Readiness — Backend & `@fsm/shared` Preconditions (2026-08-03, revised)

> **Scope:** what must change in the backend and `packages/shared` before SE mobile development can
> *safely* continue past the existing auth shell. Not the mobile app build itself.
> **Method:** four-phase read, in order — source-only current state (via 6 independent, doc-blind
> subagent passes covering every controller/guard/DTO/e2e-spec, the full Prisma schema, `@fsm/shared`,
> and an absence-search for upload/push/rate-limit/search/refresh-token infra), then PRD requirements
> mapped onto that state, then reconciliation against the written record, then a concrete day-one
> walkthrough. Every claim is labelled **OBSERVED** (read from source, cited `file:line`) or
> **INFERRED**.
> **Why this order, and why this revision exists:** the written record for this repo has been
> independently found wrong three times in 48 hours (a constructor-arity claim, a missing
> config-shape defect, a misdiagnosed suite-non-determinism cause). A prior pass of *this exact
> report*, also dated 2026-08-03, was written earlier today — and reality moved again before this
> revision started: commit `54b23de` closed **#162** (SE row-level authorization floor) and commit
> `980a212` landed most of **#186** (mobile session persistence) *after* that draft's Phase 1 was
> written. This revision re-derived Phase 1 from source independently (blind to that draft and to
> `.scratch/`), then checked it against both the older doc set and the prior draft. Where they
> disagree, the newer commit wins — see Phase 3.

---

## Phase 1 — Current State, From Source Alone

### 1.1 API surface & guard chain

**Guard chain (OBSERVED).** Three guards run globally via `APP_GUARD`
(`apps/backend/src/app.module.ts:186-188`), in order:

1. **`AuthGuard`** (`common/guards/auth.guard.ts:31-55`) — requires a valid Bearer token unless
   `@Public()`; verifies via `TokenService`, attaches `{user_id, role, zone_id}` to `request.user`.
2. **`RoleGuard`** (`common/guards/role.guard.ts:20-36`) — enforces `@Roles(...)` from
   `reflector.getAllAndOverride`. **A route with no `@Roles()` decorator at all is reachable by any
   authenticated role** (`role.guard.ts:25-27`, exact: `if (!required || required.length === 0) {
   return true; }`) — default-allow, not deny-by-default. Confirmed live instances:
   `org/geography.controller.ts` (`GET /org/geo/states|regions|districts`) and `GET /zones/:zoneId`
   carry no `@Roles()` anywhere in either file — any authenticated SE token can call them today.
   Tracked (not new): `.scratch/fsm-platform-v1/issues/169-se-api-contract-freeze.md` scopes
   "decide the 8 by-omission routes" as part of the contract-freeze work.
3. **`ZoneScopeGuard`** (`common/guards/zone-scope.guard.ts:23-41`) — first line is
   `if (!user || user.role !== 'ZONAL_MANAGER') { return true; }` — **a complete no-op for every
   role except ZONAL_MANAGER, SERVICE_ENGINEER included.** It never filters query results; it only
   403s a ZM targeting a `:zoneId`/`zone_id` outside their own zone.

**There is no cross-cutting per-SE row-scoping guard or interceptor.** All SE ownership/coverage
enforcement is service-layer, per call site.

**Closed as of commit `54b23de` (2026-08-03) — OBSERVED, re-verified independently in this pass:**
issue **#162** ("SE row-level authorization floor") landed all 5 sites via a shared
`SeCoverageService.coveredPlantIds`/`isPlantCovered` predicate:

- `isAssignedSe(ticket, actor)` pattern (`actor.role === 'SERVICE_ENGINEER' && ticket.assignedSeId
  === actor.userId`) gates install on-site/fitted (`install-lifecycle.service.ts:295-297`) and
  recovery on-site/collected/unable-to-collect (`recovery.service.ts:313-315`).
- **Troubleshoot submission** (`troubleshoot-submission.service.ts:123`) now requires
  `SeCoverageService.isPlantCovered(seId, ticket.plantId)` before accepting a write — **by design,
  this is plant-coverage, not per-ticket assignment**: any SE covering the plant may submit, and a
  genuine two-SE race on the same ticket resolves via the documented Business-409/Shadow-Use path
  (`shadow-use-conflict.e2e-spec.ts`), not a scoping bug.
- **Soft-state** (`soft-state.service.ts`) gained an `assertInScope` check ahead of the transaction —
  previously had *no* ticket query at all.
- **Component-request confirm-receipt** (`component-request.service.ts:183`) now requires
  `existing.seId === actor.userId`.
- **Verification read** (`GET /tickets/:id/verification`, `verification-query.service.ts:130-146`)
  now takes a scope argument — SE limited to own troubleshoot submission / own RECOVERY
  `assignedSeId` / own batch assignment; previously unscoped for **every** role, ZM included, not
  SE-specific (per the issue's own 2026-07-28 correction, re-confirmed here).
- **Availability self-grant** (`se-availability.service.ts:62`) narrowed: an SE may now self-set only
  `SOFT_UNAVAILABLE`, not `ON_LEAVE`/`OFF_SHIFT`/`WEEKLY_OFF` (previously any SE could silently
  bypass ZM leave approval by calling `POST /engineers/:seId/availability` on themselves).

Vehicle-unavailability file report (`vehicle-unavailability.service.ts:67-68`,
`actor.userId === input.seId`) and voucher resubmit (`vouchers.service.ts:288`,
`voucher.seId !== actor.userId`) were **already** correctly scoped before #162 and are unchanged.

**SE has no general ticket list/detail read beyond a card view (OBSERVED — this is the single
largest remaining blocker).** `GET /tickets` and `GET /tickets/:id`
(`ticketing/tickets.controller.ts`, `@Roles('ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER',
'OPERATIONS_HEAD')`) exclude SERVICE_ENGINEER entirely. The SE-facing merged read,
`GET /api/me/tickets` (`me-tickets-query.service.ts:61-96`, shipped 2026-08-03 as #161 "item 2"),
returns only a card-shaped row (`MeTicketRow`, lines 13-29: ticketId, assigned, workState, workType,
status, plantId/Name, companyName/Tier, slaBucket, deviceId, vehicleId, activeSoftState, two
timestamps). **The code's own comment says explicitly** (lines 49-52): *"a fuller per-ticket detail
read is #161's own item 1 and is not built here."* No Technical Hints, no raw telemetry, no
Transporter contact, no Failure Cycle history, no expected components, no lifecycle — anywhere in
the SE-reachable API surface, for TROUBLESHOOT-type tickets. `GET /install/:ticketId` is the sole
exception — a real per-ticket detail read, but INSTALL-work-type only
(`install-lifecycle.service.ts:266`, correctly scoped). RECOVERY has no SE-readable detail route at
all (`recovery.controller.ts` is POST-only).

**Other SE-reachable read gaps (OBSERVED, tracked by #163 "SE self-artifact reads"):** `GET
/vouchers` is manager-only — an SE can `POST /vouchers` and `POST /vouchers/:id/resubmit` but never
list their own past vouchers or see review status. `GET /leave-requests` is manager-only — an SE can
submit but never see status. `GET /devices` is manager-only (`devices.controller.ts:31`,
`READ_ROLES` excludes SE) — device master data an SE's tickets reference is unreachable directly.

**Ticket search exists, not for SE (OBSERVED, tracked by #83).** `GET /tickets` accepts `@Query('q')`
— a real ILIKE match across `device_id`/`vehicle_no`/plant name/company name plus exact id
(`ticket-query.service.ts:278-287`) — wired only to the manager-only controller. `GET
/api/me/tickets` takes zero query parameters. The QR Scanner PRD flow has no SE-reachable backend
counterpart today.

**DTO validation is inert for nearly the whole SE write surface (OBSERVED, tracked by #174).** Every
DTO across the ticketing/scheduling/org surfaces sampled (troubleshoot, install, recovery, voucher,
component-request, vehicle-unavailability, leave-request, availability, intraday-insertion,
schedules, planner — 21+ routes) is a plain TS `interface`/inline object type, not a `class`. Nest's
global `ValidationPipe({whitelist, forbidNonWhitelisted, transform})` (`app.module.ts`) silently
no-ops on non-class metatypes. The only real `class-validator` DTOs in the entire backend are in
`cross-zone/cross-zone.dtos.ts` — a manager-only surface. Malformed SE input (e.g. a non-numeric
`componentUnavailableItem`) surfaces as a generic 500, not a 400.

**HTTP e2e coverage gaps (OBSERVED, not previously catalogued at this granularity).** Every SE-facing
write route found in this pass (install/recovery/troubleshoot/voucher/component-request/vehicle-
unavailability/soft-state/leave-request lifecycle) has a passing HTTP-level e2e spec. The gaps are
on the **admin** side: `ZoneMappingAdminController`'s 5 routes and `POST/PATCH/DELETE` on
`engineers.controller.ts` (6 routes) have zero HTTP-level e2e coverage (service-level tests only, or
none) — tangential to mobile readiness, noted for completeness, not filed as a new issue since it
doesn't gate mobile.

**Test-signal caveat found incidentally (OBSERVED, already filed as #187 2026-08-02, independently
reproduced by #162's closure work):** `voucher-controller.e2e-spec.ts` fails 3/5 deterministically —
a missing `EngineerMaster` seed fixture, not a route defect — reproduced on the base commit via
`git stash` isolation. The voucher write **routes** are real and correctly scoped; the **test file**
asserting them is currently red. Don't read "voucher writes are e2e-tested" as "currently green."

### 1.2 Data model (Prisma schema, `apps/backend/prisma/schema.prisma`, 2432 lines)

**Row-scoping capability — real, with two read-side gaps and five missing indexes (OBSERVED).**
Every field-work model except two carries a direct `seId`/`assignedSeId`/`offeredSeId` column:
`Ticket.assignedSeId` (RECOVERY only, `:2120`, indexed), `TroubleshootingSubmission.seId` (`:913`),
`ExpenseVoucher.seId` (`:980`), `ComponentRequest.seId` (`:1173`), `ComponentBlockedQueue.seId`
(`:1150`), `InventoryTransaction.seId` (`:1205`), `SeAvailability.seId` (`:1234`),
`LeaveRequest.seId` (`:1255`), `VehicleUnavailabilityReport.seId` (`:2050`), `WorkSchedule.seId`
(`:605`), `PlantBatchAssignment.seId` (`:637`), `IntradayInsertion.offeredSeId` (`:495`).

- **`VerificationRun` (`:1048-1072`) has no SE/engineer column at all** — scoping (done in #162) must
  join through `submissionId → TroubleshootingSubmission.seId` or the ticket's `assignedSeId`/batch
  assignment.
- **`NonOperationalMarking` (`:2393-2432`) has only a generic, role-polymorphic `requestedBy`/
  `requestedByRole` pair**, not an SE-specific ownership column — not currently exercised as an SE
  read/write path, so latent, not live.
- **Five columns have no supporting index** (a per-SE query on any of these would force a sequential
  scan as the table grows): `ComponentRequest.seId` (only `[status,createdAt]` and
  `[ticketId,createdAt DESC]` exist); **`ComponentBlockedQueue` has zero `@@index`/`@@unique`
  declarations at all** — not even on `ticketId`; `VehicleUnavailabilityReport.seId`;
  `IntradayInsertion.offeredSeId`; and (lower relevance, manager-facing)
  `CrossZoneEscalation.assignedSeId` / `DispatchDecisionTrace.seId`. None of these are load-bearing
  yet because no SE-scoped read against them exists in the API today — they become load-bearing the
  moment #173 (SE inventory & component-request surface) ships a `WHERE se_id = :caller` query
  against `ComponentRequest` or `ComponentBlockedQueue`. **New issue #188 filed for this** (see
  below) — not covered by #161/#162/#173 as filed.

**`User`/`EngineerMaster` → zone (OBSERVED):** `User.zoneId` (`:137`, indexed) and
`EngineerMaster.zoneId` (`:225`, non-nullable, indexed) give every SE exactly one home zone;
plant-level assignment is `SeCoverage` (`seId`+`plantId`, `:265-278`) and floating territory is
`EngineerTerritoryCoverage` (`:384-398`). `Role` enum (`:18-26`) confirms the exact string
`SERVICE_ENGINEER`.

**Auth persistence (OBSERVED — confirmed still true, matches #91 exactly).** `RefreshToken`
(`schema.prisma:191-209` — tokenHash, deviceId, expiresAt, revokedAt, rotatedFrom, lastSeenAt) exists
and is schema-ready for real session persistence, but `auth.module.ts`/`auth.service.ts` still inject
`InMemoryRefreshTokenStore` (`refresh-token-store.ts` — a process-local `Map`, explicitly commented
"TEMPORARY... does not survive restart and is not shared across instances"). A backend restart or a
second instance logs out every active session, mobile included.

**Re-confirmed directly, follow-up (OBSERVED):** `auth.module.ts:11-18` provides `InMemoryUserStore`,
`InMemoryRefreshTokenStore`, and `DevZoneResolver` as the live production providers today.
`auth.service.ts:9-16` injects all three by constructor; `login()` (`:18-24`) calls
`InMemoryUserStore.validateCredentials`; `refresh()` (`:26-36`) calls
`InMemoryRefreshTokenStore.consume` (single-use rotation, `refresh-token-store.ts:30-37`); `issueTokens`
(`:38-49`) calls `DevZoneResolver.resolveZoneId` and `InMemoryRefreshTokenStore.issue`. None of this
reads Postgres. **Schema Slice 1 has already landed** (commit `dd9846b`, 2026-07-29, per #91's own
2026-07-29 comment): `UserCredential` (`schema.prisma:162-175` — `userId` PK/FK, `passwordHash`,
`passwordSalt`, `passwordAlgo`, `passwordParams`) and `RefreshToken` (`:191-209`, as above, plus
`deviceId` NOT NULL per the ratified D-2 one-active-device policy) both exist, migrated, and indexed.
**#91's own issue file already scopes the remaining work as three slices** (comment
`91-....md:454-458`), which this pass confirms are still accurate and not yet started:
- **S2 — DB-backed login.** A `PrismaUserStore` implementing the same `validateCredentials` contract
  `InMemoryUserStore` exposes today, reading `users` + `UserCredential`; async `crypto.scrypt` (not
  `scryptSync`, per #91's own 2026-07-28 amendment — `user-store.ts:78`'s sync call stalls the event
  loop under login burst); credential seeding for the existing `*@fsm.test` and Book users so current
  tests/demos survive the cutover.
- **S3 — persistent refresh with device binding.** A `PrismaRefreshTokenStore` implementing the same
  `issue`/`consume` contract, writing/reading `RefreshToken` (hash-only — SHA-256 the opaque token
  before storing), enforcing one-active-device (new login revokes the previous `RefreshToken` row for
  that `userId`), plus the `revokeAllForUser`/logout path #91's 2026-07-28 comment adds as a new AC
  (there is currently no logout endpoint at all — `auth.controller.ts:16-26` exposes only `login` and
  `refresh`).
- **S4 — retire the in-memory graph.** Remove `InMemoryUserStore`, `InMemoryRefreshTokenStore`, and
  `DevZoneResolver` (`dev-zone-resolver.ts`, plus its provider line in `auth.module.ts:17` and its
  injection/call in `auth.service.ts:15,41` — redundant once `zone_id` loads from `users.zone_id`
  directly) from the production provider graph; add `POST /api/auth/logout`.

**What changes in `auth.module.ts`/`auth.service.ts` specifically, S2→S4:** the `providers` array
swaps `InMemoryUserStore`→`PrismaUserStore` and `InMemoryRefreshTokenStore`→`PrismaRefreshTokenStore`
(S2/S3, DI swap only — same constructor shape); `AuthService`'s constructor swaps its two store types
accordingly (S2/S3); `DevZoneResolver` and its one call site in `issueTokens` are deleted, and
`issueTokens`/`login`/`refresh` may revert from `Promise<...>` back to sync return types where the
dev-zone `await` was the only async point (S4) — though `PrismaUserStore`/`PrismaRefreshTokenStore`
calls are themselves async, so the methods stay `async` regardless. `auth.controller.ts`,
`token.service.ts`, and all three guards are untouched in every slice — the JWT shape and API contract
are explicitly frozen (#91's own byte-compatibility AC). **This confirms the user's framing is
accurate:** because Slice 1's schema is already done, S2-S4 is a DI-swap-plus-seeding exercise on two
files, not a design or schema task — smaller than the issue file's overall "L" sizing implies once
Slice 1 is priced out separately.

**No file/photo upload mechanism anywhere (OBSERVED, tracked by #81).** Zero grep hits for
`FileInterceptor|multer|multipart|@UploadedFile` in `apps/backend/src`. Every `photoRef`/`photoRefs`
column (`Ticket.fittedPhotoRef`, `TroubleshootingSubmission.photoRefs`,
`ExpenseVoucherItem.photoRef`) is a bare `String`/`String[]` accepted as opaque client-supplied text
(`install.controller.ts:55`, `troubleshoot.controller.ts:42`, `vouchers.service.ts:153`) — there is
nowhere to actually upload binary image content today.

**No offline bulk-sync endpoint (OBSERVED, tracked by #82).** The only "bulk" surfaces are
manager/admin actions over existing rows (`vouchers markPaid`, `schedules/bulk-unassign`) or a
manager CSV-text bulk-**create** for installs — nothing accepts a client-generated batch of
SE-originated offline events.

**No rate limiting anywhere (OBSERVED, tracked by #110).** Zero hits for
`ThrottlerModule|@Throttle|rate-limit|express-rate-limit`; no such dependency in `package.json`.
`/auth/login` scrypt is an unthrottled CPU-DoS vector.

**Push/WhatsApp delivery is a real, deliberately-honest stub, not a bug (OBSERVED — corrects an
initial mischaracterization during this pass).** `NotificationChannelGateway`
(`notification-channel.gateway.ts:24-26`) is implemented only by `LoggingChannelGateway`
(`:35-41`) — logs and returns `'UNAVAILABLE'` for every channel; no FCM/APNs/WhatsApp/SMS/SMTP
adapter exists (`package.json` has no `firebase-admin`/`node-apn`/etc.). Only `IN_APP` delivery is
real (a DB row). **For the `SE_ACCEPTANCE` chain specifically**, `notification.service.ts:158-161`
unconditionally records the WhatsApp delivery row as `status: 'SENT'` regardless of the gateway's
actual `'UNAVAILABLE'` return. This *looks* like a correctness bug in isolation, but
**PRD:305 explicitly specifies this exact behavior** — *"WhatsApp Confirmation displayed as 'sent'
(not 'attempted') — it is a first-class delivery channel for SE Acceptance events"* — and
`SYSTEM-STATE-2026-07.md:769` confirms it is "honored in data (`first_class=true`)" as a known,
intentional placeholder ahead of a real adapter. **The open question is a product one** (see
UNRESOLVED below), not an engineering defect: is it acceptable for the UI to claim "sent" before any
adapter exists at all, or should the fallback display differ until #76 lands a real channel?

### 1.3 `packages/shared` (`@fsm/shared`)

**OBSERVED.** One 77-line file: `ROLES`/`Role`, `isRole()`, `SessionView`, `LoginRequest`/
`LoginResponse`, `SlaBucket`, `SLA_BANDS`. All three apps depend on it via `workspace:*` and actually
import real symbols from it (backend: 5 files; admin: 5 files; mobile: all 3 API/auth files) — it is
wired, not dead. **Partial duplication exists alongside it, tracked by #169:** `Role` and `SlaBucket`
are also defined in Prisma-generated `apps/backend/src/generated/prisma/enums.ts`, and several
backend files (`roles/role-backup.controller.ts:17`, `notification.service.ts:2`,
`devices.controller.ts:17`) import the generated version instead of `@fsm/shared` — values match
today (no drift), but two parallel definitions exist. Admin independently re-declares its own
`SlaBucket` type (`apps/admin/src/lib/slaBucket.ts:6-17`) rather than importing shared's, though it
does derive its display bands from shared's `SLA_BANDS`. No ticket/job/install/recovery/troubleshoot
domain type exists in `@fsm/shared` at all — every such DTO is defined locally inside
`apps/backend/src/ticketing/*.service.ts` with zero compile-time contract for a mobile consumer.

### 1.4 `apps/mobile` — current state

**OBSERVED — materially more built than "auth shell, nothing else" implied a few hours ago.** Six
non-test files: `AppEntry.tsx`, `LoginScreen.tsx`, `SessionScreen.tsx`, `AuthProvider.tsx`,
`tokenStore.ts`, `api/client.ts`. Still zero field-service screens — this part is unchanged.

**Session persistence — mostly landed as of commit `980a212` (2026-08-03), corrects the prior
draft's "no rehydration, no refresh" finding:**
- `tokenStore.ts` stores the full token pair in `react-native-keychain` (`SERVICE='fsm.tokens'`).
- `AuthProvider.tsx:40-60` **does** rehydrate on mount: reads the keychain, calls `resolveSession()`
  (lines 19-34), which tries `apiMe(accessToken)` first and on `UNAUTHORIZED` falls back to
  `apiRefresh(refreshToken)` → persists the new pair → retries `apiMe` with the new access token.
  `AppEntry.tsx` gates on a `loading` state so a returning user with a valid token never flashes
  `LoginScreen`.
- Matches issue **#186**'s own status line exactly: AC#1 (rehydration), AC#2 (refresh-and-retry),
  and AC#4 (unit tests) are done; **AC#3 is not** — `console.log` debug scaffolding remains in
  `LoginScreen.tsx:14,19` and `client.ts:6,9-10,19` (independently re-confirmed by direct read in
  this pass: `client.ts:6` `console.log('[API] BASE_URL =', BASE_URL)`, `:9-10,19` request/error
  logs; `LoginScreen.tsx:14,19` button-press/error logs). Small, mechanical remainder — no new
  finding here, #186 already tracks it precisely.

**Dependency signals (OBSERVED, `package.json`):** no `expo-location`/maps, no `expo-notifications`,
no `expo-image-picker`/`expo-camera` (capture — `expo-image` is display-only), no
`expo-sqlite`/WatermelonDB/AsyncStorage, no `@react-native-community/netinfo`, no React
Query/axios/zustand/redux. Location, push, photo capture, and offline storage all have zero
scaffolding.

---

## Phase 2 — What Mobile Needs (PRD requirements → Phase 1 reality)

Source: `docs/PRD-fsm-admin-dashboard.md` — SE Mobile App user stories (§217-285), Screen Inventory
(§479-499), App Flows (§501-663), Architecture (§307-317). Read for requirements only.

| PRD Screen | Backend endpoint | Phase 1 reality |
|---|---|---|
| Home / Day Plan | `GET /api/me/tickets` | Exists, self-scoped, card-shaped — buildable for a list view |
| Shared Pool | `GET /api/me/tickets` (merged) / `GET /me/shared-pool` | Exists, correctly coverage-scoped |
| **Ticket Detail** (device, vehicle, transporter, SLA, Failure Cycle, Technical Hints, telemetry) | none for SE | **Does not exist.** Hard blocker — #161 item 1 |
| Tickets List — human-readable ID | n/a (schema gap) | **`ticketNo` does not exist yet** (OBSERVED — `grep 'ticketNo\|ticket_no' schema.prisma` → zero hits). Already fully scoped, not missing an issue: #161's own 2026-07-28 comment (`161-....md:140-193`) specifies a global `ticketNo BigInt @default(autoincrement()) @unique` alongside the UUID PK, `TCK-`+5-digit-zero-padded display format (matches the 7 reference-image numbers cited, `TCK-10252`…`TCK-10306`), backfill in `created_at` order for the existing 21,438 rows, and lists every downstream consumer (#161/#165 payloads, admin ticket search `q`, WhatsApp notification payload, audit-trail route param, ticket drawer deep links). This is an unimplemented AC *inside* #161, not a separate gap — filing a new issue would duplicate it. Relevant because the Tickets List (via `GET /api/me/tickets`) is the one SE screen buildable today, and every reference image shows `TCK-#####`; shipping against raw UUIDs first is guaranteed rework. |
| Troubleshooting Form | `POST /tickets/:id/troubleshoot` | Exists, now coverage-scoped (#162); photo has no upload target |
| Vehicle Unavailability | `POST /vehicle-unavailability` | Exists, row-scoped correctly |
| Install Form | `POST /install/:ticketId/fitted` | Exists, row-scoped correctly; photo optional, no upload target |
| Recovery Collection Form | `POST /recovery/:id/collected` | Exists, row-scoped correctly; no SE detail GET for recovery |
| Intra-day Insertion Accept/Decline | `POST /intraday-insertions/:id/accept\|decline` | Exists, row-scoped; 10-min timeout depends on push (absent); routes have no HTTP success-path e2e test (404-only coverage) |
| Verification Result | `GET /tickets/:id/verification` | Exists, now scoped to own submission/assignment (#162) |
| 409 Conflict Screen | Shadow-Use contract on submit | Exists, sanctioned race path confirmed |
| Van Stock | `GET /me/van-stock` | Exists, self-scoped |
| Expense Voucher Create | `POST /vouchers` | Exists; mandatory photo proof has no upload target |
| My Vouchers | `GET /vouchers` (SE-scoped) | **Does not exist for SE** — #163 |
| Leave Request | `POST /leave-requests` | Exists, row-scoped correctly |
| Leave status | `GET /leave-requests` (SE-scoped) | **Does not exist for SE** — #163 |
| Availability | `POST /engineers/:seId/availability` | Exists, now correctly narrowed to SOFT_UNAVAILABLE-only self-grant (#162) |
| QR Scanner | search-by-vehicle/device (SE-scoped) | Search logic exists (`ticket-query.service.ts:278`), no SE-reachable route — #83 |
| Notifications | `GET /notifications` | Exists, no `@Roles` restriction, reachable |
| Technical Hints | derived telemetry | Depends entirely on the missing Ticket Detail endpoint — #84 |

**Architecture requirements (PRD §307-317):** WatermelonDB/SQLite offline queue, FCM/APNs push for 5+
triggers, GPS auto-capture, `client_submission_id` dedup, `react-native-keychain` (already correctly
in use). None of offline/push/GPS have client-side scaffolding.

---

## Phase 3 — Reconciliation With the Written Record

Read after Phases 1-2: `docs/SYSTEM-STATE-2026-07.md`, `audit/2026-07-31-implementation-audit.md`,
`audit/02-open-questions.md` (item 32 of §6, "Everything marked UNKNOWN" — there is no literal
"§6.32" heading; it is list item 32 under section 6), `docs/status/mobile-backend-freeze-plan-
2026-07-28.md`, `docs/status/mobile-backend-independent-assessment-2026-07-28.md`,
`docs/status/backend-mobile-readiness-2026-07-22.md`, `docs/status/backend-mobile-readiness-plan-
2026-07-28.md`, `docs/status/se-screen-data-needs-2026-07-28.md`, the prior same-day draft of this
file, `.scratch/fsm-platform-v1/INDEX.md`, and issues #161, #162, #163, #169, #174, #186, #187, #188.

### Contradiction list

| # | Claim | Source | Verdict | Why |
|---|---|---|---|---|
| 1 | No global `APP_GUARD` / `ValidationPipe` (#99 open) | `SYSTEM-STATE-2026-07.md:154-156` | **STALE** | `app.module.ts:186-193` has both; #99 shows done 2026-07-13 in INDEX.md. Doc body was never edited in place after the fix — the exact drift pattern the doc's own convention exists to prevent. |
| 2 | "Any authenticated SE can currently write against every open troubleshoot ticket in every zone" (#162 open) | `audit/2026-07-31-implementation-audit.md:272`, §13 R3 | **STALE as of `54b23de` (2026-08-03)** | Independently re-verified in this pass: all 5 sites now coverage/ownership-scoped. The audit was accurate *when written* (2026-07-31); #162 landed 3 days later. |
| 3 | Mobile auth shell has no session rehydration or refresh | Prior same-day draft of this file, Phase 1.4 | **STALE as of `980a212` (2026-08-03)** | Independently re-verified: `AuthProvider.tsx:40-60` now rehydrates + refreshes. The prior draft was accurate when its Phase 1 was written; the commit landed afterward. Only the `console.log` remainder (#186 AC#3) still holds. |
| 4 | SE ticket-read surface entirely unbuilt, Day Plan returns bare `{ticketId, sortOrder}` | `2026-07-31-implementation-audit.md:29,270`; prior draft | **PARTIALLY STALE** | `GET /api/me/tickets` (card-shaped, not bare ids) shipped 2026-08-03 per #161 "item 2". The *conclusion* — no per-ticket detail read exists — is still fully accurate; only the day-plan-list half improved. |
| 5 | WhatsApp "shown as sent" for SE Acceptance is a correctness bug | (this pass's own first-draft internal read, corrected before publishing) | **NOT A BUG** | PRD:305 + `SYSTEM-STATE-2026-07.md:769` both confirm this is deliberate, documented behavior pending a real adapter (#76). Recorded here as a caution against over-flagging PRD-sanctioned stub behavior as a defect. |
| 6 | Mobile is "auth shell only, nothing else" | `SYSTEM-STATE-2026-07.md:77-79`, `2026-07-31-implementation-audit.md` | **AGREES on scope, STALE on functional depth** | Still true that zero field-service screens exist; false that the auth shell itself is non-functional — it now persists and refreshes sessions correctly. |
| 7 | Issue #176 (KPI transparency) filed done | `2026-07-31-implementation-audit.md:32,156` | Not re-verified this pass (out of mobile scope) — flagged again per the prior draft, unresolved. |
| 8 | Open Questions item 32 — mobile absence explains several dashboard metrics with no live producer | `audit/02-open-questions.md:449-454` | **AGREES**, correctly scoped as a human question, not an engineering defect. |

### Per-existing-issue verdict

| Issue | Verdict |
|---|---|
| **#161** SE ticket-read surface | Partial — item 2 (merged list) DONE 2026-08-03; items 1 (detail), 3 (own forms), `/api/me` enrichment, `ticketNo` still open exactly as filed. This remains the top blocker. |
| **#162** SE row-level authorization floor | **DONE 2026-08-03** — closes the audit's R3 finding. No further action; reference only. |
| **#163** SE self-artifact reads | Still open as filed — matches Phase 1 (vouchers, leave-requests) exactly. |
| **#169** SE API contract freeze | Still open; already scopes the by-omission-route decision (geography/zones) this pass independently re-found. |
| **#174** SE request validation DTOs | Still open as filed; independently reproduced across a wider route sample this pass. |
| **#186** Mobile auth shell session persistence | Partial — AC#1/#2/#4 done 2026-08-03 (`980a212`); AC#3 (console.log cleanup) open, independently reconfirmed at the same file:lines. |
| **#187** voucher-controller e2e fixture bug | Still open, test-only; independently reproduced as a side effect of verifying #162's closure (3/5 tests fail on a missing `EngineerMaster` seed, not a route defect). |
| **#188** (new, this pass) — missing indexes on SE-ownership columns | Not previously filed; see below. |

**Bottom line:** the written record — including a same-day draft of this exact file — was accurate
*at the moment each artifact was written*, and this codebase is moving fast enough (two security-
relevant landings within the same calendar day) that a status document's shelf life is measured in
hours, not days. Nearly everything this pass would otherwise recommend filing is already filed,
open, and correctly scoped; the one gap that had no owner (index coverage on SE-ownership columns
ahead of #173) is filed below as #188.

---

## Phase 4 — The Day-One Walkthrough

*A mobile client, built straightforwardly on today's exposed endpoints, ships tomorrow. What breaks
first, concretely, citing routes and guards from Phase 1 — updated to reflect #162/#186 now landed.*

1. **The first real screen is unbuildable.** SE opens the app, Day Plan loads
   (`GET /api/me/tickets`) and returns a real card list — plant, SLA bucket, device, work state. SE
   taps a card. There is no `GET /api/me/tickets/:id` and `GET /tickets/:id` 403s for
   SERVICE_ENGINEER (`tickets.controller.ts`). **This is still the literal first tap after Day Plan
   rendering successfully, failing.** Install tickets are the one exception (`GET /install/:ticketId`
   works); Troubleshoot and Recovery tickets — the majority of PRD-described field work — have
   nowhere to go.

2. **The two most severe day-one risks from a few hours ago are now closed.** As of `54b23de`: a
   stale-cached ticket no longer lets an out-of-coverage SE silently overwrite another SE's
   troubleshoot submission (coverage-checked); `GET /tickets/:id/verification` no longer leaks every
   historically-seen ticket's fraud/verification detail indefinitely (scoped to own submission/
   assignment); an SE can no longer self-grant `ON_LEAVE`/`OFF_SHIFT`/`WEEKLY_OFF` and silently
   bypass ZM approval (narrowed to `SOFT_UNAVAILABLE`). All three were live, unauthenticated-scope
   holes as of the 2026-07-31 audit and are gone as of today's commit.

3. **Intra-day CRITICAL insertions will still mis-route confusingly, but not silently-and-wrongly.**
   The 10-minute Acceptance Timeout (PRD §393) depends on push, which has zero infrastructure
   (§1.2/1.4) — an SE only learns of an offer by polling or opening the app, so timeouts/reroutes
   will read as "routed to another SE while you were offline" for offers never actually delivered.
   The accept/decline routes themselves are coverage-correct (`NOT_OFFERED` on mismatch) but have
   **no HTTP-level success-path e2e test** (only 404 cases are covered) — an unverified, not
   necessarily broken, write path.

4. **Expense Voucher and Troubleshooting Form photo requirements cannot be met at all.** No upload
   endpoint exists anywhere (§1.2). PRD requires at least one photo before an Expense Voucher can
   submit (§601) — a submit button that can never succeed without further backend work, independent
   of anything else in this report.

5. **My Vouchers and Leave-status screens have nothing to render.** `GET /vouchers` and
   `GET /leave-requests` remain manager-only (§1.1, #163). An SE who submits either has no way to see
   what happened short of asking their ZM.

6. **QR Scanner and offline queueing remain entirely unbuildable/unscaffolded respectively.** Neither
   corrupts data on day one; both are advertised PRD features with zero path to existing without
   further work (#83, #82 + client-side WatermelonDB build).

7. **Session loss is now a much smaller risk than it was this morning.** With `980a212` landed, an
   app restart mid-shift rehydrates from the keychain and silently refreshes an expired access token
   — the field-availability risk flagged a few hours ago (forced re-login on every restart, unusable
   without signal) is closed. The only remaining defect is cosmetic (`console.log` scaffolding still
   present, #186 AC#3) — no functional impact.

8. **A test-signal trap, not a runtime one:** anyone checking "are voucher writes safe to build
   against" by running `voucher-controller.e2e-spec.ts` will see 3/5 red today (#187, a fixture bug)
   and could wrongly conclude the voucher write path itself is broken. It isn't — `POST /vouchers`
   and `/resubmit` are real, scoped, and independently confirmed correct by direct code read in this
   pass; only the test fixture is missing a seed row.

**What does not break:** login/session/`/me` is contract-correct; the now-scoped write paths
(troubleshoot, soft-state, confirm-receipt, verification-read, availability, plus the
previously-correct recovery/install/VU/voucher-resubmit paths) are safe to build against today;
Shared Pool and the merged `/me/tickets` list are correctly coverage-scoped and reasonably rich for a
list view.

---

## Ordered Sequence

**Backend runway estimate — INFERRED, carried from `docs/status/mobile-backend-freeze-plan-2026-07-28.md`,
not derived in this pass.** That plan's own table (`freeze-plan:408`) gives **59-87 engineer-days
(3-4 calendar months at its assumed staffing, or 6-8 weeks at the team size the plan itself sizes for)**
for the "Compatibility" bar it recommends over a full contract freeze (`freeze-plan:422`, decision D-1).
This pass did not re-derive that figure from source — it is restated here, labeled, because the prior
version of this report cited it inline next to OBSERVED findings without distinguishing the two. The
one adjustment this pass can make with OBSERVED confidence: #162 (a whole wave of that estimate) is now
done, so the true remaining figure is smaller than 59-87 days, but by how much has not been re-costed
here — treat 59-87 as a stale upper bound, not a current re-estimate.

Cross-checked against `docs/status/mobile-backend-freeze-plan-2026-07-28.md`'s W0-W4 waves and
`.scratch/fsm-platform-v1/INDEX.md`'s own mobile-readiness block — largely still accurate; the one
material change this pass makes to that ordering is moving #162 from "blocks mobile, land first" to
**done**, which unblocks starting #161's remaining items immediately rather than sequencing behind it.

**Blocks mobile (must land before any further field screen is built on the auth shell):**

1. **#161 (items 1 & 3) — SE ticket detail read + own submitted forms.** The single concrete blocker
   left in this category (Phase 4, item 1). Troubleshoot and Recovery ticket detail, specifically —
   Install's read already exists as the pattern to mirror.
2. **#91 — Postgres-backed credential store**, ahead of any real SE credential rollout — in-memory
   `InMemoryUserStore`/`InMemoryRefreshTokenStore` does not survive a restart despite the
   `RefreshToken` table already existing in schema (§1.2). One synthetic SE credential exists today;
   #91 mints ~75 real ones. **Re-confirmed directly against source this pass** (§1.2) — the claim is
   accurate: `auth.module.ts`/`auth.service.ts` still inject the in-memory stores today. Schema
   Slice 1 already landed (`dd9846b`); remaining work is S2 (DB-backed login) → S3 (persistent refresh
   + device binding + logout) → S4 (retire in-memory providers), a DI swap on two files plus credential
   seeding, not a design task — see §1.2 for the full slice breakdown and exactly what changes in
   `auth.module.ts`/`auth.service.ts`.
3. ~~#162 — SE row-level authorization floor~~ — **done, no longer a blocker.**
4. ~~#186 (console.log remainder)~~ — **cosmetic only, does not block further mobile work**; land
   opportunistically, not as a gate.

**Should precede mobile (not a hard block, but building without these means rework or a worse field
experience):**

5. **#163 — SE self-artifact reads** (my vouchers, my leave, my pending intraday offer).
6. **#169 + #174 — SE API contract freeze + request-validation DTOs**, including the by-omission
   route decision (geography/zones) this pass independently reconfirmed.
7. **#81 — Media Upload API** — hard submit-blocker for Expense Voucher and Troubleshooting Form.
8. **#76 + #89 — Notification adapters + mobile push wiring** — needed for the 10-minute intra-day
   flow and every other push trigger PRD §312 specifies; also resolves the WhatsApp-"sent" product
   question (Phase 1.2) once a real adapter exists to make the claim true.
9. **#83 — Ticket Search API** for QR Scanner — server-side search logic already exists, this is
   exposing it to SE.
10. **#84 — Technical Hints API** — depends on #161 item 1 existing first as its render target.
11. **#188 (new, this pass) — index the five unindexed SE-ownership columns** before #173 ships any
    SE-scoped query against `ComponentRequest`/`ComponentBlockedQueue`/
    `VehicleUnavailabilityReport`/`IntradayInsertion` — cheap now (small tables), a real migration
    later.

**Parallel (independent, can proceed alongside):**

- **#164/#165 — mutation retry contract + poll-endpoint bounding/delta.**
- **#171 — transporter contact data** (schema has no phone column).
- **#110 — auth rate limiting**, ahead of real device volume.
- **#82 — Offline Batch Sync API** (backend half); client-side WatermelonDB/SQLite queue is mobile-
  app work, out of this report's scope.

**Can follow (genuinely deferrable):**

- **#166 — capture-time authority** (HITL D5).
- **#170 — mobile release/upgrade mechanism** (OTA).
- **#167 — request-scoped observability.**
- **#175 — SE work-history series** (explicitly deferred by #172's own ratification).
- **#111 — deployment packaging/runbook.**

---

## UNRESOLVED — Human Must Decide

- **Push provider choice and offline-confirm UX for the 10-minute Acceptance Timeout when push is
  unavailable** — Gate-0 decision D1/D2 in the freeze plan, still open. Owner: **product + backend
  lead**.
- **Whether the WhatsApp-"sent" display (PRD:305) is acceptable to ship before #76's real adapter
  exists**, i.e. is a UI claim of "sent" with zero actual delivery tolerable pre-launch, or should the
  fallback state differ until a real channel lands. Not previously posed as an explicit question in
  the written record found this pass. Owner: **product**.
- **Contract-freeze bar: full immutability vs. compatibility (versioning + additive-only + OTA)** —
  freeze plan's own verdict (~85% of a hard freeze achievable) still stands. Owner: **engineering
  lead**.
- **Media storage decision** (S3 vs. alternative — CLAUDE.md states no S3 in the current stack),
  blocking #81. Owner: **backend lead + infra**.
- **Whether a first mobile pilot ships connected-only** or waits for the full offline queue build.
  Owner: **product**.
- **Open Questions item 32** — whether the current absence of several dashboard producer metrics
  (caused by zero mobile writers) is the expected pre-launch state. Owner: **product/operations**.
- **#176's actual commit status** — flagged again, not re-verified this pass (out of mobile scope).
  Owner: whoever next picks up #176.

---

## New Issue Filed This Pass

- **[#188 — Missing indexes on SE-ownership columns ahead of SE-scoped reads](../../.scratch/fsm-platform-v1/issues/188-se-ownership-column-indexes.md).**
  `ComponentRequest.seId`, `ComponentBlockedQueue.seId` (which has *no* indexes at all),
  `VehicleUnavailabilityReport.seId`, and `IntradayInsertion.offeredSeId` have no supporting index.
  Latent today (no SE-scoped query hits them yet); becomes load-bearing the moment #173 ships an
  SE-scoped component-request/component-blocked read. Not covered by #161, #162, or #173 as filed —
  checked against the full issue list before filing.

Everything else this pass found was already filed, current, and (with the two staleness corrections
in Phase 3) accurately scoped. #186's session-persistence work is far enough along that its status
line should be read as "small remainder," not "not started," by the next session that touches it.
