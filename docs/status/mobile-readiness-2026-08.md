# Mobile Readiness — Backend & `@fsm/shared` Preconditions (2026-08-03)

> **Scope:** what must change in the backend and `packages/shared` before SE mobile development can
> *safely* continue past the existing auth shell. Not the mobile app build itself.
> **Method:** four-phase read, in order — source-only current state, then PRD requirements mapped
> onto that state, then reconciliation against the written record, then a concrete day-one
> walkthrough. Every claim is labelled **OBSERVED** (read from source, cited `file:line`) or
> **INFERRED** (a conclusion drawn from OBSERVED facts, or a number carried from a document whose
> claims were independently re-verified in Phase 3). Nothing here is presented as observation unless
> it was read directly from source in this pass.
> **Why this order:** the written record for this repo has been independently found wrong three
> times in 48 hours before this report was written (a constructor-arity claim, a missing
> config-shape defect, and a suite-non-determinism cause). Phase 1–2 were built with zero doc access
> so the written record in Phase 3 could be *checked against* an independent reading, not assumed.

---

## Phase 1 — Current State, From Source Alone

### 1.1 API surface & guard chain

**Guard chain (OBSERVED).** Three guards run globally via `APP_GUARD`
(`apps/backend/src/app.module.ts:179-190`), in order:

1. **`AuthGuard`** (`common/guards/auth.guard.ts:24-56`) — requires a valid Bearer token unless
   `@Public()`; attaches `{user_id, role, zone_id}` from JWT claims.
2. **`RoleGuard`** (`common/guards/role.guard.ts:16-37`) — enforces `@Roles(...)`. A route with no
   `@Roles` decorator is reachable by **any authenticated role** (e.g. `GET /me`).
3. **`ZoneScopeGuard`** (`common/guards/zone-scope.guard.ts:22-42`) — **only fires for
   `role === 'ZONAL_MANAGER'`**; a no-op for every other role, SERVICE_ENGINEER included.

**There is no cross-cutting per-SE row-scoping guard or interceptor.** Ownership/coverage checks
are implemented ad hoc, per service method — a pattern that is correct in some places and absent in
others by construction, not by design:

**Correctly row-scoped (OBSERVED):** `ticketing/recovery.service.ts:107,314` (`isAssignedSe`),
`ticketing/install-lifecycle.service.ts:266,296`, `ticketing/vehicle-unavailability.service.ts:68`,
`intraday/intraday-insertion.service.ts` accept/decline (`NOT_OFFERED` on a mismatched offer),
`vouchers/vouchers.service.ts:288` (`resubmit`).

**Not row-scoped at all (OBSERVED — any authenticated SE can act on/read a ticket that is not
theirs):**
- `POST /tickets/:id/troubleshoot` — `troubleshoot-submission.service.ts:112-114` checks only that
  the ticket exists; never checks assignment/coverage. Controller: `ticketing/troubleshoot.controller.ts:71-96`.
- `POST /tickets/:id/soft-state` — `soft-state.service.ts` `runAdvance`/`setOnSite` never query
  `tickets` for an owner check at all (zero matches on grep).
- `POST /component-requests/:id/confirm-receipt` — `component-request.service.ts:171-200` checks
  status only, not `existing.seId` against the caller.
- `GET /tickets/:id/verification` — `verification.controller.ts:103-109` calls
  `this.query.forTicket(ticketId)` with **no scope argument at all** — unscoped for every role, not
  SE-specific (confirmed by direct read of `verification-query.service.ts`).

**Test coverage of the gap (OBSERVED):** `test/soft-state-controller.e2e-spec.ts:124-132` and
`test/troubleshoot-controller.e2e-spec.ts:128-137` each test "wrong role → 403" but neither has a
"right role, wrong SE" case. The gap is real and currently invisible to CI.

**SE has no general ticket list/detail read (OBSERVED).** `GET /tickets` and `GET /tickets/:id`
(`ticketing/tickets.controller.ts:39,71`) are `ZONAL_MANAGER, CENTRAL_SERVICE_MANAGER,
OPERATIONS_HEAD` only. The controller's own docstring says this is deliberate — SEs read work
through Day Plan / Shared Pool. Those two views:

- `GET /schedules/me` → `DayPlanQueryService.getDayPlan` (`scheduling/day-plan-query.service.ts:40`)
  returns `DayPlanView { dispatched, scheduleId, dateFrom, dateTo, stops: [{batchId, stopSequence,
  plantId, plantName, deviceCount, tickets: [{ticketId, sortOrder}]}] }` — **each ticket is bare
  `{ticketId, sortOrder}`, nothing else** (`day-plan-query.service.ts:5-25`).
- `GET /me/shared-pool` → `SharedPoolService.getSharedPool` (`shared-pool/shared-pool.service.ts:34-63`)
  returns `{ticketId, workType, plantId, plantName, companyTier, slaBucket, deviceId}` per ticket —
  richer, and correctly coverage-scoped server-side (`coveredPlantIds`, union of `se_coverage` +
  the `plant_eligible_floating_se` materialized view) — but still nothing like transporter contact,
  technical hints, telemetry, failure-cycle history, or expected components.

Since `GET /tickets/:id` is manager-only, **there is no way for an SE-facing client to hydrate a
bare Day Plan ticket ID into anything renderable.** This is the single largest concrete blocker
found in this pass.

**Other SE-reachable read gaps (OBSERVED):** `GET /vouchers` is `REVIEW_ROLES`-only
(`vouchers.controller.ts:100-101`) — an SE can `POST /vouchers` (create) and `POST
/vouchers/:id/resubmit` but never list their own past vouchers or see review status. `GET
/leave-requests` is `MANAGER_ROLES`-only (`leave-request.controller.ts:66-67`) — an SE can submit a
leave request but never see its status. Both are one-way streets: write access without read-back.

**QR/vehicle search (OBSERVED).** A "universal search" by device ID / vehicle number / plant /
company exists (`ticketing/ticket-query.service.ts:110,278`) but is wired only into the
manager-only `GET /tickets` controller. No SE-reachable endpoint exposes it. The QR Scanner PRD
feature (Flow 13) has zero backend counterpart today.

### 1.2 Data model (Prisma schema, `apps/backend/prisma/schema.prisma`, 2432 lines)

**Row-scoping capability — partial, join-dependent (OBSERVED).** Every SE-facing operational model
carries a direct `seId`/`engineerId` FK (`WorkSchedule:603`, `PlantBatchAssignment:633`,
`SePlanner:686`, `TroubleshootingSubmission:907`, `ExpenseVoucher/Item:978/1006`,
`ComponentRequest`, `InventoryTransaction`, `SeAvailability`, `LeaveRequest`) — trivial to scope
`WHERE se_id = :callerId`. **`Ticket` itself has no general assignee column** — `assignedSeId`
(`schema.prisma:2120`) exists only for the RECOVERY work-type. For TROUBLESHOOT/INSTALL, resolving
"which tickets is this SE assigned today" requires a join:
`Ticket ← BatchAssignmentTicket(:666) ← PlantBatchAssignment.seId(:637)`.

**No org/tenant column anywhere (OBSERVED, grep confirmed zero hits).** Isolation is zone-based
only (`User.zoneId`, `Plant.zoneId`) — this is one fleet-management org with internal zones, not a
multi-tenant system.

**Mobile-specific model gaps (OBSERVED):**
- **No attendance/check-in model** — zero matches for `attendance|check.?in|check.?out`.
- **No push/device-token storage table.** `NotificationChannel.PUSH` exists as an enum value
  (`:1442`) but nothing stores an FCM/APNs token per device; schema comment at `:1487-1488` calls
  the external send "a deferred seam."
- **No continuous location/ping table for an engineer's own phone.** The only GPS capture is
  single-shot: `TroubleshootingSubmission.seGpsLat/Lon` + `onsiteCaptureGps`
  (`Unsupported("geometry(Point,4326)")`, `:914-917`) — one row per form submission, not a track.
  `Device`/`DeviceState` models are the fleet GPS hardware being serviced, not the SE's handset.
- **No photo/attachment upload endpoint anywhere.** `photoRef`/`photo_refs` fields
  (`Ticket.fittedPhotoRef:2144`, `TroubleshootingSubmission.photoRefs:927`,
  `ExpenseVoucherItem.photoRef:1013`) are bare `String`/`String[]` columns. Confirmed at the
  controller layer (`install.controller.ts:52-56`) that `photoRef` is accepted as a plain string in
  JSON. Zero `Multer`/`FileInterceptor`/`@UploadedFile` hits anywhere in `apps/backend/src`. Combined
  with no S3 in the stack (per `CLAUDE.md`), **there is currently no server-side place to put an
  actual image file.**

### 1.3 `packages/shared` (`@fsm/shared`)

**OBSERVED.** The entire package is one 77-line file (`packages/shared/src/index.ts`): `ROLES` +
`Role`, `isRole()`, `SessionView`, `LoginRequest`/`LoginResponse`, `SlaBucket`, `SLA_BANDS`. All
three apps (`backend`, `admin`, `mobile`) already depend on it via `workspace:*` and all three
actually import it — mobile is already correctly wired, that part is not a gap. But **the package's
domain contract stops at auth/session/SLA-bucket.** Every ticket/job/install/recovery/troubleshoot
DTO (`TicketView`, `TicketDetailView`, etc.) is defined locally inside
`apps/backend/src/ticketing/*.service.ts` and re-exported nowhere. A mobile screen touching any of
those domains has zero compile-time contract with the backend today — it would need either new
`@fsm/shared` types or hand-duplicated local types with no drift protection (the same risk already
visible in the `Role`/`SlaBucket` enums, which are hand-copied between `@fsm/shared` and the Prisma
schema's Postgres enums, kept in sync only by convention/comment, not by tooling).

### 1.4 `apps/mobile` — current state

**OBSERVED.** Two screens exist, full stop: `LoginScreen` (`src/auth/LoginScreen.tsx`) and
`SessionScreen` (`src/auth/SessionScreen.tsx`, a role/zone display + logout button — **no
field-service functionality of any kind**). `app/_layout.tsx` + `app/index.tsx` +
`src/auth/AppEntry.tsx` route declaratively between them on `session ? SessionScreen : LoginScreen`.
`@react-navigation/*` packages are installed but unused — template scaffolding, not evidence of
built navigation.

**Auth flow works for what it does, and nothing else:** `apiLogin` → `POST /auth/login`, `apiMe` →
`GET /me` (`src/api/client.ts:8-36`) — contract verified field-for-field against the backend's
`LoginRequest/LoginResponse`/`SessionView` types, both sourced from `@fsm/shared`. This match is
**unverified by any automated test** — no integration/e2e test in `apps/mobile` hits a real backend;
it was confirmed here by manual cross-reading of source on both sides.

**Two concrete defects in already-shipped code (OBSERVED, not previously filed — see New Issues
below):**
- **No session rehydration on relaunch.** `AuthProvider.tsx:15` holds `session` in `useState`,
  initialized `null`. `tokenStore.ts:21-24`'s `getAccessToken()` exists and is unit-tested but is
  never called outside test files. Every app restart forces re-login even with a valid keychain
  token.
- **No token refresh wired.** Backend `POST /auth/refresh` exists (`auth.controller.ts:22`,
  `@Public`) and `LoginResponse.refreshToken` is stored, but no client code calls it (grep:
  zero non-test hits). `apiMe` on 401 just throws `UNAUTHORIZED`; nothing catches it to retry.

**Dependency signals confirm "auth shell only" is accurate, not conservative (OBSERVED,
`package.json`):** no `expo-location`/maps, no `expo-notifications`, no `expo-image-picker`/`expo-camera`
(capture — `expo-image` is display-only), no `expo-sqlite`/WatermelonDB/AsyncStorage, no
`@react-native-community/netinfo`, no React Query/axios/zustand/redux. Location, push, photo
capture, and offline storage all have **zero scaffolding**, not partial scaffolding.

---

## Phase 2 — What Mobile Needs (PRD requirements → Phase 1 reality)

Source: `docs/PRD-fsm-admin-dashboard.md` (SE Mobile App sections — user stories §217-285, Screen
Inventory §479-499, App Flows §501-663, Architecture §307-317). Read for requirements only.

| PRD Screen / Flow | Backend endpoint needed | Phase 1 reality |
|---|---|---|
| Home / Day Plan | `GET /schedules/me` | Exists, self-scoped — but returns `{ticketId, sortOrder}` only; **unbuildable as a card list without #161** |
| Ticket Detail (device, vehicle, transporter, SLA, Failure Cycle history, Technical Hints, telemetry) | `GET /tickets/:id` (SE-scoped) | **Does not exist for SE** — manager-only. **Hard blocker.** |
| Troubleshooting Form (root cause, photos, GPS) | `POST /tickets/:id/troubleshoot` | Exists, reachable — **not row-scoped** (any SE, any ticket) — and photo_refs has no upload target (§1.2) |
| Vehicle Unavailability | `POST /vehicle-unavailability` | Exists, row-scoped correctly. No SE-reachable GET to render "expected back on [date]" state after submit. |
| Install Form (device/SIM serial, photo) | `POST /install/:ticketId/fitted` | Exists, row-scoped correctly. Photo optional but has no upload target. |
| Recovery Collection Form | `POST /recovery/:id/collected` | Exists, row-scoped correctly. |
| Intra-day Insertion Accept/Decline | `POST /intraday-insertions/:id/accept\|decline` | Exists, row-scoped correctly (`NOT_OFFERED`) — but the **10-minute Acceptance Timeout is push-notification-dependent**, and no push infra exists at all (§1.2, §1.4) |
| Verification Result | `GET /tickets/:id/verification` | Exists, SE-reachable — **but unscoped for every role**, a read-side leak, not just an SE gap |
| 409 Conflict Screen | dedup/Shadow-Use contract on submit | Not independently re-verified this pass; existing issue coverage (#164) — flagged, not re-derived |
| Van Stock | `GET /me/van-stock` | Exists, self-scoped |
| Expense Voucher Create | `POST /vouchers` | Exists — **mandatory photo proof has no upload target** |
| My Vouchers (status list) | `GET /vouchers` (SE-scoped) | **Does not exist for SE** — `REVIEW_ROLES` only |
| Leave Request | `POST /leave-requests` | Exists, row-scoped correctly |
| Leave status ("PENDING badge") | `GET /leave-requests` (SE-scoped) | **Does not exist for SE** — `MANAGER_ROLES` only |
| Availability (SOFT_UNAVAILABLE) | `POST /engineers/:seId/availability` | Exists — but **an SE can currently self-grant `ON_LEAVE`/`OFF_SHIFT`/`WEEKLY_OFF`**, not just `SOFT_UNAVAILABLE` as the PRD specifies (§Phase 3 below) |
| Shared Pool | `GET /me/shared-pool` | Exists, correctly coverage-scoped, reasonably rich card data |
| QR Scanner | search-by-vehicle/device (SE-scoped) | **Search logic exists in the service layer but has no SE-reachable route at all** |
| Notifications (in-app list) | `GET /notifications` | Exists (`notifications.controller.ts:16`), no `@Roles` restriction — reachable |
| Technical Hints | derived from raw telemetry, shown on Ticket Card + Detail | Depends entirely on the missing Ticket Detail endpoint (§ above) — no independent source found |

**Architecture requirements (PRD §307-317, requirements-level, read alongside the screens):**
offline-first (WatermelonDB/SQLite) for form submission, expense drafts, and soft-state updates;
FCM/APNs push required for five distinct triggers including the 10-minute intra-day timeout; GPS
auto-capture at submission plus geofence-triggered ON_SITE; `client_submission_id` dedup;
`react-native-keychain` for token storage (already in use). **None of the offline, push, or GPS
requirements have any client-side scaffolding today** (§1.4).

---

## Phase 3 — Reconciliation With the Written Record

Read only after Phases 1-2 were complete: `docs/SYSTEM-STATE-2026-07.md`,
`audit/2026-07-31-implementation-audit.md`, `audit/02-open-questions.md` §6.32,
`docs/status/mobile-backend-freeze-plan-2026-07-28.md`, `.scratch/fsm-platform-v1/INDEX.md`, and the
issue files it references.

### Contradiction list

| # | Written-record claim | Verdict | Why |
|---|---|---|---|
| 1 | `SYSTEM-STATE-2026-07.md:154-156,856-857` — no global `APP_GUARD`/`ValidationPipe` (#99 open) | **CONTRADICTS** (stale) | `app.module.ts:179-190` has both; `#99` shows **done 2026-07-13** in INDEX.md:27. Doc body text was never edited in place after the fix landed — the exact drift class the doc's own convention exists to prevent. |
| 2 | Mobile is auth-shell-only, nothing else built (`SYSTEM-STATE:77-79`, `2026-07-31-implementation-audit.md` multiple) | **AGREES** | Independently reproduced: 2 screens, zero field-service functionality, zero relevant dependencies. |
| 3 | No general SE ticket-read endpoint; Day Plan returns bare ticket IDs (`2026-07-31-implementation-audit.md:29,270`; issue #161) | **AGREES** | Reproduced at the same file:line citations independently. |
| 4 | SE row-level authorization floor missing on 4 sites (issue #162) | **AGREES**, with #162's own correction adopted: the verification-read gap is role-generic (unscoped for every role, including ZM), not SE-specific — confirmed by direct read of `verification-query.service.ts`. |
| 5 | SE self-artifact reads are one-way (issue #163) | **AGREES** on the 2 sites independently checked (vouchers, leave-requests); the other 5 in #163 were not independently re-verified but follow the identical pattern. |
| 6 | No media/photo upload endpoint anywhere (`SYSTEM-STATE:773-774`; issue #81) | **AGREES** | Independently reproduced — bare string columns, zero upload-handler grep hits. |
| 7 | Push notifications are a spine with no external adapter (issue #76/#89) | **AGREES** | `NotificationChannel.PUSH` enum exists; no device-token table; "deferred seam" comment confirmed independently. |
| 8 | `@fsm/shared` is auth/session-only (issue #169) | **AGREES** | Independently counted the same export set. |
| 9 | No QR/vehicle-search endpoint for SE (issue #83) | **AGREES** | Search logic exists (`ticket-query.service.ts:110,278`) but wired only to the manager-only controller — independently reached the same conclusion. |
| 10 | Issue #176 (KPI transparency) filed `Status: DONE` | **SCOPE NO LONGER MATCHES REALITY** (as of 07-31; not re-checked as of today) | The 07-31 audit found the feature exists only in an uncommitted working tree — a "done" status line that a fresh clone would not reproduce. Not mobile-relevant directly, but a live example of why status lines need `git log`/`git status` verification, not just a read of the issue file. |
| 11 | Open Questions §6.32 — mobile absence explains several dashboard metrics with no live producer | **AGREES**, and correctly scoped as a human question ("confirm this is the expected pre-launch state"), not an engineering defect — left open here, not answered. |

### Per-existing-issue verdict (the ones this analysis would otherwise duplicate)

| Issue | Verdict |
|---|---|
| **#161** SE ticket-read surface | STILL OPEN AS FILED — matches Phase 1/2 exactly. Reference, don't re-file. |
| **#162** SE row-level authorization floor | STILL OPEN AS FILED — matches all 4 original sites exactly, **and already contains a 5th site** (SE self-grant leave via `POST /engineers/:seId/availability`, added 2026-07-28) that this analysis also found independently in Phase 2. Already captured; no new issue needed. |
| **#163** SE self-artifact reads | STILL OPEN AS FILED — matches the 2 independently-checked sites; widened to 7 by the issue's own 2026-07-28 addendum. |
| **#164** SE mutation retry contract | STILL OPEN AS FILED (not independently re-verified this pass). |
| **#165** SE poll-endpoint bounding | STILL OPEN AS FILED — the bare-array, unbounded-list shape is independently visible in `SharedPoolTicket[]`/`DayPlanView`, corroborating its claim. |
| **#166** Capture-time authority | STILL OPEN, `ready-for-human` — correctly scoped as a product decision. |
| **#169** SE API contract freeze | STILL OPEN, partially landed (`/api/v1` dual-serve done per its own comment). |
| **#170** Mobile release/upgrade mechanism | STILL OPEN, `ready-for-human`. |
| **#171** Transporter contact data | STILL OPEN, `ready-for-human` (migration). |
| **#172** Mobile screen-contract ratification | **ALREADY RESOLVED** — `Status: DONE`, ratified 2026-07-28, all 12 items closed. Its resolutions (e.g. merged `GET /api/me/tickets` replacing the day-plan/pool split as the SE ticket-read contract boundary) are binding for any future #161 build — noted here so a future session doesn't re-litigate it. |
| **#173** SE inventory & component-request surface | STILL OPEN AS FILED — contingent scope resolved in its favor by #172. |
| **#174** SE request validation DTOs | STILL OPEN AS FILED. |
| **#175** SE work-history series | STILL OPEN, explicitly non-blocking. |
| **#176** KPI transparency | Filed DONE but not committed as of 07-31 (see contradiction #10) — not mobile-relevant, flagged for confidence calibration only. |
| **#178** Closure never clears assignment | STILL OPEN — not a mobile blocker directly, but relevant background for Phase 4: if mobile starts writing ticket closures on top of this bug, SE capacity accounting will visibly degrade shortly after launch. |

**Bottom line:** the written record's most recent layer (`2026-07-31-implementation-audit.md` +
issues #161-#178, filed 2026-07-28) is **highly accurate** and independently corroborates nearly
every Phase 1/2 finding, in several cases with more precision than this pass achieved on its own
(#162's 5th site, #163's 7-site widening). The only concrete staleness found is
`SYSTEM-STATE-2026-07.md`'s never-updated guard-chain paragraph and the #176 status-line/git-status
mismatch — neither changes the mobile-readiness picture. Nearly everything this analysis would
otherwise recommend filing is already filed, open, and current.

---

## Phase 4 — The Day-One Walkthrough

*A mobile client, built straightforwardly on today's exposed endpoints (per the PRD), ships
tomorrow. What breaks first, concretely, citing routes and guards from Phase 1.*

1. **The first screen is unbuildable.** SE opens the app, Day Plan loads (`GET /schedules/me`) and
   returns a list of bare ticket IDs (`day-plan-query.service.ts:5-25`). To render anything — plant
   name, SLA bucket, device — the client must call `GET /tickets/:id`, which 403s for
   SERVICE_ENGINEER (`tickets.controller.ts:39,71`). Shared Pool is somewhat better (has plant/SLA/
   device fields) but Ticket Detail — the screen an SE actually taps into to do work — has the same
   wall. **This is not a rough edge; it is the literal first tap after login failing.**

2. **A stale cached ticket ID silently corrupts another SE's work.** PRD Flow 1/3b: a ZM can
   manually add/remove/reorder tickets on an SE's Day Plan mid-shift, "no SE Acceptance required,"
   with a push notification firing to inform the SE. But push has zero infrastructure (§1.2, §1.4) —
   no device-token table, no adapter, and the mobile client has no push handler. So: SE B has ticket
   X cached from an earlier sync; the ZM reassigns X to SE C; SE B, never informed, is still en
   route and taps **Submit Form**. `troubleshoot-submission.service.ts:112-114` checks only that the
   ticket exists — never that it still belongs to SE B — so the write succeeds. SE C's real work is
   now clobbered or duplicated, with no error surfaced to anyone. This is a direct consequence of
   the row-scoping gap (Phase 1.1) compounding the push gap (Phase 1.2/1.4) — neither alone would
   cause silent corruption; together they do.

3. **Verification data leaks permanently, not just today.** `GET /tickets/:id/verification` never
   re-checks current assignment (Phase 1.1, item 4). Any ticket ID an SE has ever seen — through
   their own historical Day Plan, Shared Pool, or a ticket they were reassigned away from — remains
   permanently queryable for fraud-flag and verification detail, with no time-based revocation. No
   ID-guessing is required; the SE only needs to have once been near the ticket.

4. **An SE can quietly skip the Leave Request approval flow entirely.** `POST
   /engineers/:seId/availability` currently authorizes an SE to self-set `ON_LEAVE`/`OFF_SHIFT`/
   `WEEKLY_OFF` (issue #162's 5th site) when the PRD (§496) and the workflow doc both specify SE gets
   only `SOFT_UNAVAILABLE`. A mobile client built to the PRD's Leave Request screen would coexist
   with this bug rather than trigger it directly — but a client built slightly off-PRD, or a bug in
   the availability screen, silently bypasses ZM approval with no audit trail of an approval that
   never happened.

5. **Expense Voucher and Troubleshooting Form photo requirements cannot be met at all.** No upload
   endpoint exists anywhere in the backend (Phase 1.2). The PRD requires **at least one photo before
   an Expense Voucher can submit** (§601) — this is not a degraded experience, it is a submit button
   that can never succeed without further backend work.

6. **Intra-day CRITICAL insertions will silently mis-route.** The Acceptance Timeout is a hard
   10 minutes with reroute-after-3-retries (PRD §393, Decision §16) — these are the highest-severity
   tickets in the system. Without push (Phase 1.2/1.4), an SE only learns of an offer by polling or
   opening the app. The system will behave exactly as designed — timing out and rerouting — but the
   SE will experience it as confusing, unexplained churn ("routed to another SE while you were
   offline") for offers they were never actually notified of.

7. **My Vouchers and Leave status screens have nothing to render.** `GET /vouchers` and `GET
   /leave-requests` are manager-only (Phase 1.1). An SE who submits either has no way to see what
   happened to it short of asking their ZM.

8. **QR Scanner and offline queueing are not "slower to build" — they are entirely unbuildable
   server-side (QR) or entirely unscaffolded client-side (offline).** Neither is a day-one
   functional break in the sense above (nothing gets corrupted), but both are advertised PRD
   features with zero path to existing today without further work first.

9. **Session loss is a field-availability risk, not a data risk.** No rehydration, no refresh
   (Phase 1.4) — an SE who loses the app mid-shift (OS eviction, crash, dead battery/restart) is
   logged out and, if offline at that moment, cannot work until they regain connectivity to
   re-authenticate. This does not corrupt data but does make the app unusable exactly when field
   conditions are worst.

**What does *not* break:** login/session (`/auth/login`, `/me`) is contract-correct and needs no
changes; the correctly-scoped write paths (recovery, install, vehicle-unavailability, intraday
accept/decline, voucher resubmit) are safe to build against today; Shared Pool's coverage-scoping is
correctly enforced server-side.

---

## Ordered Sequence

This section is the deliverable. Grouped by dependency, not by issue number. Cross-checked against
`docs/status/mobile-backend-freeze-plan-2026-07-28.md`'s own W0-W4 waves (Phase 3 found that plan
still accurate as of 07-31) — where this ordering agrees with that plan, it's noted; the reasoning
below is derived from this pass's own Phase 1/2/4 findings, not copied from the plan.

**Blocks mobile (must land before any further mobile screen is built on top of the auth shell):**

1. **#162 — SE row-level authorization floor.** Every other backend gap is a missing feature; this
   one is an active security hole against 14,000+ live tickets (per the issue's own 07-28 measurement)
   that gets *wider*, not narrower, the more mobile client code gets written against today's
   endpoints. Land first because every subsequent slice (#161, #163) reuses its coverage predicate —
   building #161 first would mean redoing its scoping logic twice.
2. **#161 — SE ticket-read surface.** Nothing past Day Plan can render without it (Phase 4, item 1).
   Build alongside #162 (they share the coverage-predicate helper per #162's own note); this is also
   where the #172-ratified `GET /api/me/tickets` contract decision (merged day-plan/pool boundary)
   gets implemented, so revisit that ratification when scoping the slice.
3. **#186 (new, this pass) — mobile auth shell session persistence.** Small and independent of the
   backend blocks, but every future mobile screen builds on `AuthProvider`; landing it now is a
   single fix instead of an N-screen retrofit later (Phase 1.4).
4. **#91 — Postgres-backed credential store**, ahead of any real SE credential rollout — the
   in-memory `InMemoryUserStore` (`auth.module.ts`/`auth.service.ts`) does not survive a restart, and
   #162's fix must land no later than #91's rollout per #162's own filed constraint (currently one
   synthetic SE credential exists; #91 mints ~75 real ones).

**Should precede mobile (not a hard block, but building without these means later rework or a
worse field experience):**

5. **#163 — SE self-artifact reads** (my vouchers, my leave, my pending intraday offer) — the "My
   Vouchers" and Leave-status screens are unbuildable without it (Phase 2 table).
6. **#169 + #174 — SE API contract freeze + request-validation DTOs.** Not urgent for a first
   screen, but every endpoint mobile starts consuming before this lands is a contract that can still
   change underneath a shipped client. This is the "freeze before build" bet the existing plan
   already made; Phase 3 found no reason to disagree with it.
7. **#81 — Media Upload API.** Blocks Expense Voucher and Troubleshooting Form photo requirements
   completely (Phase 4, item 5) — not a nice-to-have, a hard submit-blocker for two PRD flows.
8. **#76 + #89 — Notification spine adapters + mobile push client wiring.** Blocks the 10-minute
   intra-day Acceptance flow from behaving sanely (Phase 4, item 6) and every other push trigger the
   PRD specifies (§312).
9. **#83 — Ticket Search API**, for QR Scanner — server-side search logic already exists
   (`ticket-query.service.ts:110`), this is exposing it to SE, not building it from scratch.
10. **#84 — Technical Hints API** — depends on #161 existing first (Ticket Detail is the render
    target).

**Parallel (independent of the above, can proceed alongside):**

- **#164/#165 — mutation retry contract + poll-endpoint bounding/delta.** Client-data-layer
  concerns; useful before mobile writes real traffic at volume, not before the first screen exists.
- **#171 — transporter contact data** (schema has no phone column) — needed for the tap-to-call
  requirement on 3 screens, independent of the read-surface work.
- **#110 — auth rate limiting** on `/auth/login`/`/auth/refresh`, ahead of real device volume.
- **#82 — Offline Batch Sync API** — backend counterpart can be built in parallel with the read-surface
  work; the *client-side* WatermelonDB/SQLite queue (Phase 1.4, zero scaffolding) is mobile-app work,
  out of this report's scope, but its absence should inform sequencing of when mobile screens go live
  in the field vs. in a connected-only pilot.

**Can follow (genuinely deferrable without blocking safe mobile start):**

- **#166 — capture-time authority** (HITL D5, a product decision, not urgent for a first pilot).
- **#170 — mobile release/upgrade mechanism** (OTA) — matters at scale, not for a first build.
- **#167 — request-scoped observability** — matters before a field pilot generates real incident
  volume, not before code exists to observe.
- **#175 — SE work-history series** — explicitly deferred by #172's own ratification.
- **#111 — deployment packaging/runbook** — an operations concern, decoupled from client build order.

---

## UNRESOLVED — Human Must Decide

- **Push provider choice (FCM vs. a unified provider) and the offline-confirm UX for the 10-minute
  Acceptance Timeout when push is unavailable** — product/infra decision, not resolvable from
  source. Owner: **product + backend lead** (this is Gate-0 decision D1/D2 in the freeze plan;
  Phase 3 found no reason it has since been settled).
- **Contract-freeze bar: full immutability vs. compatibility (versioning + additive-only + OTA)** —
  the freeze plan's own honest verdict (as re-verified in Phase 3, still current) is ~85% of a hard
  freeze is achievable; the remaining categories (field-level completeness, client-discovered error
  cases, offline sync semantics, real-device performance) cannot be frozen ahead of a real client.
  Owner: **engineering lead**, informed by how much schedule risk the org will accept from
  mid-build contract changes.
- **Media storage decision** (S3 vs. an alternative — CLAUDE.md states no S3 in the current stack) —
  a genuine infrastructure/cost decision blocking #81. Owner: **backend lead + infra**.
- **Whether a first mobile pilot ships connected-only** (accepting the offline-queue gap, Phase 1.4)
  **or waits for the full WatermelonDB/SQLite build** — this changes how urgently #82's backend half
  needs to land and whether field SEs can be trusted to always have signal. Owner: **product**, this
  is an operational-risk call about the actual field conditions in the pilot zone(s).
- **Open Questions §6.32** — whether the current absence of dashboard producer metrics (Activity
  Status, root-cause distribution, etc., caused by zero mobile writers) is the expected pre-launch
  state or a gap someone assumed was already covered. Owner: **product/operations**, this is a
  question about expectations, not a defect.
- **#176's actual commit status** — was the KPI-transparency work ever committed after 07-31? Not
  re-verified in this pass (out of mobile-readiness scope); flagged so the next session checks
  `git log` before trusting the issue file's `DONE` line. Owner: **whoever picks up #176 next**.

---

## New Issues Filed This Pass

- **[#186 — Mobile auth shell has no session rehydration or token refresh](../../.scratch/fsm-platform-v1/issues/186-mobile-auth-shell-no-session-persistence.md).**
  Not covered by #91 (backend credential store), #109 (admin session lifecycle — a different app),
  or any SE-mobile-backend issue #161-#178 — those own the server side; this is a client-side defect
  in already-shipped `apps/mobile/src/auth/` code (Phase 1.4). Checked against the full issue list
  before filing; no duplicate found.

Everything else this analysis found was already filed, current, and accurately scoped — see the
Phase 3 per-issue verdict table. No other new issues were filed.
