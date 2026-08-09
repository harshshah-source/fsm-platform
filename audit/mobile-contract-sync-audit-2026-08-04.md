# Contract & cross-surface sync audit — mobile ↔ backend ↔ admin

Date: 2026-08-04 · Follow-up to `mobile-device-readiness-2026-08-04.md`.
Scope: what is **out of sync, wrong, or will break in the field** — not what is unbuilt.
Every claim labelled **OBSERVED** (`file:line`, or a live HTTP/DB probe run today against the dev
backend at localhost:3000) or **INFERRED**. Live probes ran as `se.north@fsm.test` with real tokens.

**Method note:** all mobile response types are `@fsm/shared` imports cast directly from `res.json()`
(client.ts throughout), so the drift surfaces are (a) shared-type ↔ backend-serializer, (b) the
client's error-body assumptions, and (c) the admin app, which — unlike mobile — hand-copies its
contract types. Mobile is the *clean* client; admin is where the duplication problem lives
(only 5 admin files import `@fsm/shared`; 13+ contract types are re-declared by hand).

---

## A. WILL BREAK IN THE FIELD

### A1. After 15 minutes, the app permanently misreports auth expiry as "Offline" — worst finding

- OBSERVED: access-token TTL is **15 minutes** (`token.service.ts:22`, `accessTtlSec = 15 * 60`;
  confirmed on a live token's iat→exp). Refresh TTL 30 days (`prisma-refresh-token-store.ts:20`).
- OBSERVED: mobile refreshes tokens in exactly one place — `resolveSession`
  (`AuthProvider.tsx:28`), called only at **mount** (:48) and **login** (:65). There is no fetch
  interceptor and no 401-retry anywhere; every screen pulls the raw stored token and maps *any*
  failure to `'offline'` (`HomeScreen.tsx:46-58`; same shape in TicketsScreen:79, StockScreen:38,
  AvailabilityScreen:41, VouchersScreen:29, LeaveRequestScreen:32, NotificationsScreen:36,
  TicketDetailScreen:73, and every form).
- Contrast: the **admin** client has both a proactive refresh 60s before expiry
  (`apps/admin/src/auth/AuthProvider.tsx:57-69`) and a single-flight 401 interceptor with one retry
  (`apps/admin/src/api/http.ts:63-82`). Mobile has neither.
- INFERRED consequence: an SE who keeps the app open longer than 15 minutes sees every screen flip
  to the "Offline" badge with full connectivity, every write fail, and no bounce to Login. Recovery
  requires a full app restart (so the mount refresh runs). Misdiagnosing auth expiry as a network
  problem is the worst possible failure copy for a field user.
- **Fix: code (mobile — a refresh-on-401 wrapper around the api client). Issue: none exists.**

### A2. Guard-level 401/403 bodies have no `code` — write-path error handling throws `Error(undefined)`

- OBSERVED (live probes): controller-thrown errors carry `{code}` (`{"code":"RECOVERY_NOT_FOUND"}`
  404, `{"code":"INVALID_NOTIFICATION_ID"}` 400, `{"code":"INVALID_AVAILABILITY_STATUS"}` 400), but
  **guard-level** rejections are Nest defaults with no `code`:
  `{"message":"Unauthorized","statusCode":401}` and `{"message":"Forbidden","statusCode":403}`.
- OBSERVED: `recoveryPost` (client.ts:354-357), `installPost` (:390-393), `intradayPost`
  (:425-428), and `apiSetAvailability` (:527-529) destructure `{code}` from **any** non-2xx body →
  on a guard 401/403 (i.e., exactly the post-15-minute case from A1), `code` is `undefined` and the
  screen surfaces `Error(undefined)`.
- The doc comments on those client functions claim the controllers map "every non-2xx" to `{code}`
  — true only for responses that *reach* the controller. Guards fire first.
- **Fix: code (either a shared error-code union + guard shape unification — #169's still-open
  items 1/2 own this backend-side — or defensive parsing client-side). Issue: #169 (open, stale
  status line; see F3).**

### A3. Admin voucher review renders every mobile-uploaded photo as a broken image

- OBSERVED: mobile submits `photoRef` = the raw `media_objects` PK (`media.controller.ts:82`
  returns `{photoRef: created.mediaId}`). The admin reviewer renders that id **directly as an image
  URL**: `VoucherReviewPage.tsx:128` (`setLightbox(it.photoRef)`) → `:291`
  (`<img src={lightbox} …>`). The admin app has **no media API client at all** (no
  `apps/admin/src/api/media.ts`; zero fetches of `/media/:id` repo-wide), even though
  `GET /api/media/:id` exists with the reviewer roles allowed (`media.controller.ts:85-94`,
  `REVIEW_ROLES` at :32). Even a constructed URL would fail: the auth guard requires an
  `Authorization: Bearer` header (`auth.guard.ts:42-49`), which an `<img>` tag cannot send.
- INFERRED consequence: the ZM voucher-review flow — whose whole point is checking the receipt
  photo — shows a broken image for every voucher mobile submits. Approval decisions get made
  without the evidence.
- **Fix: code (admin: authenticated blob fetch → object URL; or backend: short-lived signed URL).
  Issue: none exists.**

### A4. Any admin-web login for a user with a live mobile session silently kills the mobile session

- OBSERVED: `issue()` revokes **all** active refresh tokens for the `userId`, unconditionally —
  device id is recorded but never compared (`prisma-refresh-token-store.ts:47-50`,
  `REPLACED_BY_NEW_DEVICE`). The admin client never sends `X-Device-Id` (login:
  `apps/admin/src/api/client.ts:20-24`), taking the `randomUUID()` fallback
  (`auth.controller.ts:31`) — so every admin login is a "new device."
- The comment at `auth.controller.ts:27-30` claims enforcement "only meaningfully activates once a
  client sends a real stable id" — understates reality; the revoke-all write is fully live.
- Combined with A1: the killed mobile session shows "Offline," not "signed out elsewhere."
- Also unmitigated: no rotation grace window (`schema.prisma:189-192` notes it) — a dropped refresh
  *response* on a lossy field network burns the session permanently; and reuse of a rotated token
  is a plain 401 with no lineage revocation (`REUSE_DETECTED` reason documented at
  schema.prisma:206, no writer exists).
- Pure SEs (who never touch admin) are unaffected; anyone testing both surfaces with one account
  will hit it constantly. D-2 one-active-device is by design (#91); the cross-*surface* interaction
  and the failure copy are not.
- **Fix: partly design-intent (D-2), partly code (mobile "signed out elsewhere" state; grace
  window). Issue: none exists for the cross-surface interaction.**

### A5. Environment: migration lag + stale backend process (carried from the readiness audit — still live)

- OBSERVED today: `device_tokens` migration **still unapplied** (live `_prisma_migrations` query:
  zero rows; `to_regclass('public.device_tokens')` → null) and the running backend is stale code
  (`POST /api/v1/notifications/device-token` → 404 live; `GET /me` returns no `profile` key even
  though current source sets it, `me.controller.ts:32`).
- INFERRED: restarting the backend on current code **without** `pnpm prisma migrate deploy` makes
  logout 500 (`AuthService.logout` → `DeviceTokenService.clear` → missing table). Until the
  restart, the mobile Home header renders a blank name/zone (no `profile`).
- **Verdict on issue-vs-runbook (asked in the brief): runbook line, not an issue** — it is one
  command, it exists only until the next restart, and it is recorded as step 1 of the "shortest
  real path" in `mobile-device-readiness-2026-08-04.md`. Filing an issue for it would outlive the
  problem. **Setup task.**

### A6. Dispatch cron timezone is unpinned — the "before the field day" run can fire at 10:30 IST

- OBSERVED: cron default `'0 5 * * *'` with **no `timeZone` option** (`dispatch-scheduler.service.ts:50`;
  intent comment "early morning, before the field day starts" at :6-8). No `TZ=` is set in any
  compose/Docker/env file in the repo. The DB session is pinned UTC (`prisma.service.ts:46-52`,
  ADR-0025) but the process TZ is whatever the host has.
- INFERRED: on a UTC host the run fires at 10:30 IST — hours into the field day; the effective hour
  is environment-dependent.
- Related, systemic (see C7): every "today" boundary is UTC midnight = **05:30 IST**
  (`utc-day.ts:9-11` and its ~15 call sites).
- **Fix: config/code (pass `timeZone` to `@Cron`, or pin container TZ — a deliberate decision
  either way). Issue: none exists.**

---

## B. WRONG BUT CURRENTLY HARMLESS (works by accident; breaks on a change)

| # | Finding | Cite | Fix / issue |
|---|---|---|---|
| B1 | `POST /intraday-insertions/:id/accept` (and decline/fire/assign/available-ses) does unvalidated `BigInt(id)` → **500** on any non-numeric id (reproduced live: 500 with correlationId). Real ids are backend-minted numerics, so latent — but any retry/URL corruption becomes a 500 + `Error(undefined)` on mobile (A2). | `intraday-insertion.controller.ts:53,68,84,96,109` | Code; none |
| B2 | Mobile `VerificationScreen.BADGE_COPY` is missing `FAILED_ACTIVATION` (a real `VerifyOutcome`); typed `Record<string,…>` so invisible to the compiler; falls back to **"Verification pending"** with an info-blue pill — a terminal failure rendered as in-progress. Latent because the screen is only reachable while `detail.status === 'VERIFICATION_PENDING'` (`TicketDetailScreen.tsx:75`) and FAILED_ACTIVATION is install-lifecycle; reachable only via a stale-fetch race. | `VerificationScreen.tsx:25-30,58,78` vs `shared:274` | Code; none |
| B3 | 15 notification `type` strings produced, **1** consumed (`INTRADAY_GHOST_ASSIGNMENT`, SeTabShell.tsx:50); `type` is bare `string` on producer, shared, and consumer. Renaming the producer string compiles clean and silently kills the ghost toast. Highest silent-breakage seam in the repo. | producer list: `intraday-insertion.service.ts:212,326,418,505,521`; `cross-zone-escalation.service.ts:214,303,324`; `day-plan-notifier.ts:63,73`; `bulk-unassign.service.ts:360`; `install-notifier.ts:54,66`; `recovery-notifier.ts:78,95` | Code (shared union); none |
| B4 | `@Roles(...roles: string[])` — authorization's only enforcement is unchecked strings; a typo silently 403s everyone. Six backend files re-hand-copy the same manager-role array untyped. | `roles.decorator.ts:6`, `role.guard.ts:21` | Code; none |
| B5 | Stale contract comments that misdirect the next builder: shared says photo capture "blocked on #81 (unbuilt)" (`shared/index.ts:389-390,404`) — #81 is done; #169's issue body still claims "no enableVersioning" (`169-…md:41`) vs `app.config.ts:27`; #58's stale blocker corrected in place this session. | — | Docs; #58 corrected, rest none |
| B6 | Convention-only enum sync that happens to match today: `UNABLE_REASONS` re-listed rather than derived (`recovery.service.ts:19-24` vs `shared` — 4/4 match); `media.controller.ts:27` hand-copies `VALID_KINDS` nine lines after importing `MEDIA_SLOTS_BY_KIND` whose keys are that exact list; backend re-declares `NotificationListItem`'s shape locally (`notification.service.ts:47-56`) instead of importing shared (fields match today — verified). No parity test exists anywhere (zero tests reference `ROLES`/`SLA_BANDS`/`MEDIA_SLOTS_BY_KIND`). | — | Code hygiene; none |
| B7 | Admin date-render traps one change away from the previous-day bug: `TierOverridesPage.tsx:19-22` round-trips a date through `new Date().toISOString()` (safe only because it re-serializes UTC); `PlantDeactivationsPage.tsx:48` uses `toLocaleDateString` (safe only because the field is a real instant). Both clients otherwise render date-only fields by string-slicing — the discipline holds today. | — | Code hygiene; none |
| B8 | Leave-window semantics: `YYYY-MM-DD` inputs parse server-side as **UTC midnight** (`leave-request.controller.ts:52-53`), so "on leave 2026-08-10" actually spans 05:30 IST Aug 10 → 05:30 IST Aug 11. Display is self-consistent (both clients slice the string back), but the underlying window is shifted 5h30m. | — | Design decision needed; none |
| B9 | `TicketStatus`/`WorkType` are not in `@fsm/shared` at all — `MeTicketRow.status`/`workType` are bare `string`; 6 hand-copies of WorkType, 17-value status list re-typed in 4 places (no drift today). Leave-request *status* likewise stringly on both clients — a future `CANCELLED` renders as "Pending"-ish semantics on mobile with no compile error. | `shared:85-86,258,894`; `ticket-query.service.ts:118-124` | Code (shared unions); #169 family, none specific |

Also confirmed **not** broken (worth stating): the troubleshoot 409 body matches
`TroubleshootConflictBody` field-for-field (`troubleshoot.controller.ts:75-82` ↔ `shared:436-443`;
source-verified, live-untested) and routes to the full-screen `ConflictScreen`
(`TroubleshootFormScreen.tsx:44`); the mobile refresh flow **does** persist the rotated pair
(`AuthProvider.tsx:28-30` — the classic keep-the-old-token bug is absent); server rotation is
correctly single-use (`prisma-refresh-token-store.ts:74-77`); `/api` and `/api/v1` are two URL
registrations of identical handlers — byte-identical shapes, pinned by
`api-versioning.e2e-spec.ts:34-52`; `RootCauseCategory`, `Role`, `SlaBucket`, `MediaKind/Slot`,
`VoucherStatus`, `ExpenseCategory`, `SoftStateType`, `VehicleUnavailReason`, `UnableToCollectReason`
value sets agree everywhere they are copied.

---

## C. INCONSISTENT BETWEEN SURFACES (same data, different meaning)

| # | Finding | Cite |
|---|---|---|
| C1 | **SLA bucket**: admin labels are the *time ranges* ("24–48Hr", from `BUCKET_RANGE_LABEL`, slaBucket.ts:70-105); mobile labels are the *severity words* ("Critical", ticketDisplay.ts:29-38). The `null` bucket renders **"Active"** on mobile (:30-32) and **nothing** on admin (badges.tsx:22 returns null). Admin uses an 8-color ordinal ramp; mobile deliberately collapses to warning/critical (documented, ticketDisplay.ts:4-9). An SE and their ZM discussing "the red one" are not looking at the same encoding. |
| C2 | **UNZONED — two disjoint populations** (#192, filed 2026-08-04, confirmed from source): `/devices?zoneId=UNZONED` = `p.zone_id IS NULL` (`device.service.ts:314`); every dashboard inner-joins `zones` and reports the *seeded* UNZONED zone (`org-seed.ts:17`, `mapping-table-zone-resolver.ts:85-87`, `dashboard.service.ts:343-350` + 10 more sites). The device filter dropdown offers **both** — a numeric seeded-zone option and the string "UNZONED" NULL-set option, identically labelled (`device.service.ts:340-346,363-375`; `DeviceDetailPage.tsx:396`). Mobile has no UNZONED handling at all. |
| C3 | **Availability**: admin renders `SOFT_UNAVAILABLE` as the raw token with the **critical/red** fallback tone (`SeManagementPage.tsx:36,133,286`) and drops those SEs from the metric strip entirely (`:25` — 5 of 9 statuses counted, cards don't sum to rows); mobile renders "Soft Unavailable" (`availabilityDisplay.ts:4-9`). An SE legitimately using the #87 feature looks like a red alert to their manager. |
| C4 | **Root cause**: three renderings of the same enum — mobile "GPS Antenna Issue" (acronym-aware, troubleshootDisplay.ts:3-11), admin analytics "Gps Antenna Issue" (RootCauseAnalyticsPage.tsx:7, DeviceDetailPage.tsx:35), admin ticket drawer raw `GPS_ANTENNA_ISSUE` (TicketDetailDrawer.tsx:340). No values missing anywhere. |
| C5 | **Voucher status**: `APPROVED` = info-blue on admin (badges.tsx:88) vs success-green on mobile (voucherDisplay.ts:26); `DRAFT`/`ZONAL_MANAGER_REVIEW`/`NEEDS_CLARIFICATION`/`PAID` untoned on admin (fall through to neutral, badges.tsx:131) vs distinct semantics on mobile; label "Zonal Manager Review" vs "Manager Review" (voucherDisplay.ts:15). |
| C6 | **Component requests**: mobile shows raw enum tokens with a binary tone (`StockScreen.tsx:116` — RECEIVED and APPROVED visually identical); admin humanizes ("Shipped"). Admin's own pages also disagree with each other on schedule status: `OVERRIDDEN` = "ZM Adjusted" on SchedulesPage:118, raw token on ScheduleDetailPage:121. |
| C7 | **"Today" has three definitions**: backend = UTC midnight (05:30 IST boundary, `utc-day.ts:9-11`, ~15 call sites); admin planner = device-local midnight (`PlannerPage.tsx:33-47`, deliberately); mobile's one local-time computation is VU's "tomorrow 9 AM" on the handset clock (`vehicleUnavailabilityDisplay.ts:26-31`). Backend and admin-planner disagree for the first 5h30m of every IST day. |
| C8 | **Admin ticket filter offers 8 of 17 statuses** (`TicketsPage.tsx:21-24`) — every Recovery and Install lifecycle status is missing, while the same page filters by those work types (:20). The backend accepts all 17 (`ticket-query.service.ts:118`). Operators can find RECOVERY tickets but not filter them by any status a recovery ticket actually has. |

---

## D. MISSING SYNC (one surface produces a state the other can't handle)

| # | Finding | Cite | Issue |
|---|---|---|---|
| D1 | **Mobile ignores the server's removal contract.** `/me/tickets` populates `removedFromPlanAt`/`deferredToDate` on every row (`me-tickets-query.service.ts:61-68,127-128`; contract `shared:103-114`) — mobile's production code never reads either field (grep: test fixtures only). It re-derives removals from an in-memory session diff (`dayPlanCues.ts:20-41`) whose own comment ("the server has no signal") is now false. Consequences: a removal while the app was closed is **invisible** (cold-start diff is empty, :23-26); ZM DEFER vs REMOVE (distinct actions, `override.service.ts:23-24`) collapse into one "Removed" badge with no return date. | `TicketsScreen.tsx:149,172` | none (#66 done; gap unfiled) |
| D2 | **Bulk unassign is a dead-end on mobile**: `DAY_PLAN_REBALANCED` notification carries `entityType:'zone'` (`bulk-unassign.service.ts:358-366`); mobile routes taps only on `entityType==='ticket'` (`NotificationsScreen.tsx:57`) — the tap does nothing but mark read. Schedule status deliberately untouched (D3, `:289-295`), unlike override actions. | — | none |
| D3 | **Schedule closure has no mobile state**: the sweep writes `COMPLETED`/`PARTIAL` (`schedule-closure-scheduler.service.ts:162,167`), both excluded from `LIVE_SCHEDULE_STATUSES` (`schedule-status.ts:15,22`) — the SE's plan silently empties with no "day closed out" rendering. | — | none |
| D4 | **Intraday: 5 states, mobile screens 1, admin displays 0.** Mobile handles `PENDING_ACCEPTANCE` + an error-code-keyed "gone" fallback (`IntradayOfferScreen.tsx:54-56,71-73`); `TIMED_OUT`/`ESCALATION_REQUIRED` render nowhere. Admin's Intraday Queue reads a *different* endpoint (ZM manual-update audit, `intradayUpdates.ts:26`) and hardcodes "No acceptance required" (`IntradayQueuePage.tsx:103`) while its subtitle claims insertions appear there (:122). The manager-scoped `GET /api/intraday-insertions` (all 5 states) is unconsumed. | — | none |
| D5 | **Admin consumes no notifications at all.** Zero notification reads in apps/admin. Every manager-recipient notification — `INTRADAY_ESCALATION_REQUIRED`, `CROSS_ZONE_*`, and the ZM `RECOVERY_UNABLE_TO_COLLECT` added by today's #76 slice — is written and displayed **nowhere**. The states that exist specifically to demand manager action are invisible on the manager surface. | producer cites in B3 | none |
| D6 | **Voucher decisions notify no one**: `voucher-notifier.ts` is a pre-spine seam that only logs (:31-43); approve/reject/needs-clarification/PAID produce no notification row, so mobile's notification list can never carry them. (Deliberately out of #76's adoption scope — no `Logging*Notifier`-to-spine seam precedent; recorded in #76.) | — | #76 remainder |
| D7 | **Admin cannot set `AVAILABLE`** (`api/engineers.ts:19`, `SeManagementPage.tsx:26,305-309`) though the backend's manager legs permit it (`se-availability.service.ts:103-107` — no status narrowing for ZM/CSM; `SETTABLE_STATUSES` includes it, `engineers.controller.ts:70`). A manager cannot clear an SE's stuck window from the console; only the SE can, from mobile. | — | none |
| D8 | **`NonOpState` admin type lies**: 3 of 7 enum values typed (`api/nonOp.ts:10` vs `schema.prisma:1758-1766`) — any `ACTIVE`/`EXPIRED`/`UNMARKED` row the API returns is a type-level lie with no runtime guard. | — | none |
| D9 | **WM component-request queue can never show `RECEIVED`/`REJECTED`** (server `ACTIVE` filter, `component-request.service.ts:80,88`) — the WM who shipped a part cannot see mobile's receipt confirmation land. In oversight mode the same page *does* receive them but the metric strip still counts only 3 statuses (`ComponentRequestsPage.tsx:29,191-193`) — strip under-counts the table. | — | none |
| D10 | **`X-App-Version` is inert**: sent on every mobile request (client.ts:104), read by zero backend sites; no version floor exists (#170 owns it; #54:126 documents the absence accurately). Non-retrofittable header correctly pre-staged, currently decorative. `X-Device-Id` is consumed by exactly three endpoints (login, refresh, device-token — the last has no mobile caller yet, #89). | — | #170 / #89 |
| D11 | **`actionTakenCategory` has no server-side vocabulary**: mobile's ten Title-Case tile labels (`troubleshootDisplay.ts:18-29`) are written unvalidated into the DB (`troubleshoot.controller.ts:61`); no list exists backend-side. Drift is guaranteed the moment a second writer exists. (#172 Decision 8 says "becomes an enum" — #169/#174's open work.) | — | #169/#174 |
| D12 | **ticketNo residue**: ticket surfaces correctly render `ticketNoDisplay` (TicketsScreen:36, TicketDetailScreen:297, VerificationScreen:65) — but two raw-UUID leaks remain: the intraday offer screen's fallback line "Ticket {offer.ticketId}" (`IntradayOfferScreen.tsx:124`, shown when the detail fetch fails) and the SE_ACCEPTANCE confirmation body `` `Ticket ${ins.ticketId} added to your Day Plan.` `` (`intraday-insertion.service.ts:214`) — the exact defect #76's own comment log flagged (PRD:228/workflow:1461); #77 fixed only the ghost-notification leak. | — | #76 (flagged, unfixed) |
| D13 | **Troubleshoot `photoRefs` accepted, never sent**: backend passes it through today (`troubleshoot.controller.ts:66`); the mobile form doesn't capture photos. Owner: **#58**, whose stale "#81 unbuilt" blocker was corrected in place today — the AC is now buildable (Voucher/Install established the pattern; the four named slots already exist in `MEDIA_SLOTS_BY_KIND.TROUBLESHOOT`). Voucher itself implements 1 of its 3 named slots (RECEIPT only, `VoucherFormScreen.tsx:124`); the per-item `photoRef` model makes PHOTO/BILL unbuilt-but-expressible. | — | **#58 (corrected today)** |

---

## E. #169 — what it actually covers now (asked explicitly)

OBSERVED: `/api/v1` is implemented as a global `defaultVersion: ['1', VERSION_NEUTRAL]`
(`app.config.ts:27-30`) — every route serves identically under both paths, byte-identical shapes,
pinned by `api-versioning.e2e-spec.ts`. Mobile pins `/api/v1` (client.ts:92). Admin is unversioned
across **35 files** that each re-declare `BASE_URL` — repointing admin is a 35-file edit, and the
401 interceptor is gated on `url.startsWith(BASE_URL)` (`http.ts:67`), so a partial repoint would
silently disable it for the moved modules. The issue file is stale: `Status: ready-for-agent`
despite item 3 marked "LANDED ✅" in its own comments; body text still claims no `enableVersioning`
exists; its AC ("unversioned path redirects or is retired") contradicts the deliberate co-equal
alias decision recorded in `app.config.ts:23-26`. **Items 1, 2, 4-8 (error-shape unification,
shared error-code union, actionTaken enum, etc.) remain open — those are the ones findings A2, B9,
D11 need.**

## F. Actions taken this session (Part 4 of the brief)

1. **Migration lag re-confirmed live and NOT deployed** (see A5). Verdict: **runbook line, not an
   issue** — already step 1 of the readiness audit's "shortest real path"; an issue would outlive
   the problem.
2. **Troubleshoot photo gap**: duplicate-check found the owner — **#58 is still open
   (`ready-for-agent`) with the photo AC unchecked and a stale "blocked on #81 (unbuilt)" reason
   while #81 is `done`**. Per the tracker's no-forks rule, corrected **#58 in place** (dated
   2026-08-04 contract-audit comment: blocker gone, established capture-upload pattern cited, exact
   remaining scope; struck-through Blocked-by entry; also corrected its stale "409 shows inline"
   claim — `ConflictScreen` is wired, `TroubleshootFormScreen.tsx:44`). No new issue number minted.
3. Noted: a concurrent session filed **#194 (no-dev-login-seed-path)**, which owns the readiness
   audit's seed-credential gap.
