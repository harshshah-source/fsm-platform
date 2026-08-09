# Structural audit — apps/backend, apps/admin, apps/mobile — 2026-08-05

Report-only. No file under `apps/` was modified. Derived from source code, the Prisma schema and
migrations, and test-suite assertions only — no PRD, no CONTEXT.md, no INDEX.md, no prior audit,
no issue files were consulted, and no finding cites a document. Code comments were treated as
claims to verify, not as authority.

**Method.** Shape inventory first (route inventory, cron inventory, `$transaction` call sites,
catch blocks, `findMany` census), then six parallel read-only investigations over: transaction
boundaries / error propagation, concurrency / schedulers / resources, query shape / indexes /
dead code, test honesty, admin↔backend agreement, mobile↔backend agreement. Every top-ranked
finding below was additionally spot-verified by re-reading the cited source directly; those are
marked ✔.

**Labels.** OBSERVED = read at the cited file:line or produced by the quoted command.
INFERRED = reasoning from observed code, stated as such.

---

## 0. Shape of the system (all OBSERVED via commands)

| Surface | Size |
|---|---|
| Backend | ~32,000 LOC TS (excl. generated); 62 controllers, 222 route handlers (`grep -c '@(Get\|Post\|Put\|Patch\|Delete)('`); 71 Prisma models, 52 enums (schema.prisma, 2,519 lines); 74 migrations; 17 `@Cron` jobs; 41 `$transaction` call sites in `src/` (28 files); 158 `findMany` call sites (68 files) |
| Admin | ~25,000 LOC TS/TSX; 38 hand-rolled API modules over raw `fetch` (no react-query/SWR anywhere) |
| Mobile | ~12,000 LOC TS/TSX; Expo/React Native; bottom-tab shell for SEs |
| Tests | 299 e2e specs + 44 unit specs under `apps/backend/test`, run serially against a live Postgres (`vitest.config.ts` `fileParallelism: false`) |

Cron inventory: 11 business sweeps + schedule-closure + dispatch + partition-maintenance +
plant-eligibility-refresh + ingestion-telemetry + ingestion-masters
(`business-sweep-scheduler.service.ts:152-204`, `schedule-closure-scheduler.service.ts:91`,
`dispatch-scheduler.service.ts:63`, `partition-maintenance.service.ts:51`,
`plant-eligibility-refresh-scheduler.service.ts:59`, `integration-scheduler.service.ts:70,87`).
All default-off behind env switches, re-checked per tick.

---

## 1. Findings that can corrupt or lose data

### 1.1 ✔ Van-stock decrement is a lost-update write (absolute value from a stale read)

**OBSERVED** — `apps/backend/src/ticketing/troubleshoot-submission.service.ts:328-335`:
`decrementStock` reads the row, then writes `qty: Math.max(0, row.qty - qty)` — an **absolute**
value computed in JS under READ COMMITTED. The compensating rollback path is atomic
(`verification.service.ts:325-330` uses `qty: { increment: txn.qty }`), so the two writers of the
same row use asymmetric idioms.

Failure scenarios (INFERRED from the observed idiom; textbook lost update):
- Verification rollback (5-minute cron) restores +3 between a submit's read and write → the
  submit's absolute write erases the restoration. qty 5 → rollback makes 8 → submit writes
  `max(0, 5−2)=3`. Physical stock 6, recorded 3.
- Two concurrent submits by the same SE on different tickets, same component: both read 5,
  consume 3 each → final 2 instead of 0; `Math.max(0, …)` also silently floors genuine
  oversubscription instead of surfacing it.

Two investigators found this independently. The repo's own guarded-transition primitive
(`src/common/transition-or-conflict.ts:1-16`) documents exactly this bug class; van stock does
not use it or an atomic `{ decrement }`.

### 1.2 ✔ Troubleshoot submit: ticket status checked outside the transaction, transition unguarded — the Business-409 "winner" can be two winners

**OBSERVED** — `troubleshoot-submission.service.ts:126`: `if (ticket.status !== 'OPEN') return
this.handleConflict(...)` runs on a read taken **before** the `$transaction` at line 130. Inside
the tx, the ticket is flipped to `VERIFICATION_PENDING` by an update keyed on `ticketId` alone —
no `status: 'OPEN'` predicate in the WHERE.

INFERRED interleaving: SE A and SE B both submit on an OPEN ticket (the covered-plant race this
flow's conflict-handling exists for). Both pass the JS check; both transactions commit (their
idempotency uniques differ — `(seId, clientSubmissionId)`, schema ~L1023). Both submissions are
recorded as the normal path; the loser's component consumption is ledgered `PRE_VERIFICATION`
instead of routing through the shadow-use/conflict path, and the warehouse-reconciliation record
the conflict machinery exists to produce is silently skipped. `transitionOrConflict` is used by
the intraday flow but not here. Window is one HTTP round-trip wide; two SEs racing to one
critical ticket is the designed-for scenario, not an exotic one.

### 1.3 Intraday CRITICAL accept is four separate commits — a throw after the claim strands the ticket permanently

**OBSERVED** — `src/intraday/intraday-insertion.service.ts:161-241` (`accept`):
1. guarded flip `PENDING_ACCEPTANCE → ACCEPTED` commits immediately (line 161, on
   `this.prisma`, not a shared tx);
2. `override.assignTicket(...)` (line 190) commits in its own transaction — and then fires a
   notifier that itself performs DB writes *after* that commit (`override.service.ts:320`,
   production binding `scheduling.module.ts:58`);
3. `intradayInsertion.update` records `assignedScheduleId/assignedBatchId` (line 202);
4. notification + audited ticket event (lines 210-241).

The in-band failure path (`assigned.result !== 'OK'`) releases the claim (lines 191-199); a
**thrown** error or a crash between steps 1 and 3 does not. Consequences, all OBSERVED in code:
`fireForZone` excludes tickets with an insertion in `['PENDING_ACCEPTANCE','ACCEPTED']` (line
110) so the ticket is never re-offered; `sweepTimeouts` selects only `PENDING_ACCEPTANCE` (line
277) so no timeout rescue fires; the idempotent-retry path returns the literal string `"null"`
as `scheduleId` to the SE app (lines 145-152). A CRITICAL ticket ends accepted-but-unassigned
and invisible to every recovery sweep. `manualAssign` (lines 308-323) has the same
commit-then-commit shape. The file `transition-or-conflict.ts:15-16` explicitly instructs
passing the same tx client so guard and dependent writes commit atomically; `accept` does not.

### 1.4 Cross-zone approve: ticket assigned, escalation left PENDING, and the retry path can never repair it

**OBSERVED** — `src/cross-zone/cross-zone-escalation.service.ts:151-183`: `assignTicket` commits
in its own tx, then `crossZoneEscalation.update` to `APPROVED` is a separate write (line 167).
A failure between them leaves the ticket FORMALLY_ASSIGNED while the escalation stays PENDING in
the CSM/OH queue. The retry is self-sealing in the wrong direction: a second approve hits
`assignTicket` → `ALREADY_ASSIGNED` → returns early (line 164) **without updating the
escalation row** — the queue entry is permanently unresolvable through the API.

### 1.5 Leave approval: availability window commits, request stays PENDING; retry duplicates the window

**OBSERVED** — `src/engineers/leave-request.service.ts:80-106`: `approve` calls
`setAvailability` (its own committed tx: availability row + audit,
`se-availability.service.ts:110-134`), then updates the leave request separately (line 95).
Failure between: SE is ON_LEAVE in the availability ledger while the request reads PENDING; a
retried approve passes the PENDING check again and creates a **second** open-ended availability
window — in the table the recommender and intraday candidate filter read.

### 1.6 ✔ Mobile retries are not idempotent — duplicate vouchers; and most writes carry no idempotency key at all

**OBSERVED** — `apps/mobile/src/tickets/troubleshoot/TroubleshootFormScreen.tsx:56` and
`apps/mobile/src/vouchers/VoucherFormScreen.tsx:81`: `Crypto.randomUUID()` is called **inside**
`handleSubmit`, so every tap generates a fresh `clientSubmissionId`. Backend dedupe is keyed on
exactly that id (`troubleshoot-submission.service.ts:111-114`, `vouchers.service.ts:157-160`).
A committed-but-response-lost voucher submit followed by a retap creates a **second voucher
row**; the comment at `VoucherFormScreen.tsx:30-32` claims per-attempt generation makes retries
idempotent — it is what defeats the dedupe. On troubleshoot the same retry produces a 409
rendered as "already closed by *the SE's own name*."

**OBSERVED** — install-fitted, recovery-collected, leave, vehicle-unavailability, and
availability writes carry no idempotency key in their request types (`packages/shared`); leave
and vehicle-unavailability retries can create duplicate rows.

### 1.7 Eleven business sweeps assume a single process; a second instance corrupts inventory and duplicates escalations

**OBSERVED** — the only cross-process guards in the codebase are the snapshot/master-sync
advisory locks + durable partial-unique in-flight indexes (`snapshot-run.service.ts:46-61`,
`master-sync-run.service.ts:59-78`, migrations `20260619153000` L69 and `20260703120000`
L28-29), the dispatch/closure/bulk-unassign per-zone advisory locks
(`batch-assignment.service.ts:69-74`, `schedule-closure-scheduler.service.ts:131-136`,
`bulk-unassign.service.ts:261-266`), and the boot lock (`build-info/runtime-lock.ts:151-155`).
The 11 business sweeps have only an in-process `Set`
(`business-sweep-scheduler.service.ts:111`).

INFERRED consequence under two instances (or one instance plus a hand-run script): both execute
`runVerification` concurrently, both read the same `PRE_VERIFICATION` inventory rows
(`verification.service.ts:321-323`), both apply `{ increment }` restores before either flips
rows to `ROLLED_BACK` — **stock restored twice**. The same double-execution duplicates
cross-zone escalations (no unique backstop — 2.3 below) and doubles report rows (2.5).
Whether deployment ever runs two instances is not visible from source; the code's protection
level is a fact either way.

### 1.8 Verification sweep vs. manual ZM actions: unguarded terminal transitions in both directions

**OBSERVED** — `src/verification/verification.service.ts`: `finalize` (lines 292-347) updates
`verificationRun` and `ticket` **by id only**, no `outcome: null` / `status:
'VERIFICATION_PENDING'` predicate; `markAutoRecovery` (118-147) and `escalateFraud` (63-111)
are the same read-then-unconditionally-write shape.

INFERRED interleaving at the expiry boundary: the 5-minute sweep begins
`finalize(FAILED_VERIFICATION)` — which rolls PRE_VERIFICATION inventory back to the van —
while a ZM concurrently marks auto-recovery. Commit order decides the terminal status
arbitrarily; the run's `outcome` is overwritten by the second writer; if the sweep's branch
commits, stock is restored for a ticket the ZM recorded as recovered. Both actors are told
success; the audit trail records two contradictory terminal events. The same unguarded pattern
recurs in `repeat-escalation.service.ts:57-72` and structurally in
`install-lifecycle.service.ts:167-204`.

---

## 2. Findings that silently produce wrong output

### 2.1 ✔ The automated auto-recovery sweep is never invoked by anything

**OBSERVED** — `grep -rn runAutoRecovery apps/backend` returns exactly: the definition
(`src/ticketing/auto-recovery.service.ts:27`) and two calls in its own e2e spec
(`test/auto-recovery.e2e-spec.ts:99,119`). The controller injects `AutoRecoveryService` but
calls only `manualClose` (`tickets.controller.ts:102`). None of the 11 business-sweep crons
reference it. The manual endpoint that does exist, `POST /tickets/:id/auto-recovery-close`, has
**no caller** in either client (grep of `apps/admin/src` and `apps/mobile/src`); admin instead
calls `POST /verification/:ticketId/mark-auto-recovery`, which only works on tickets that
already have a verification run (`verification.service.ts:136`, `where: { ticketId, outcome:
null }`).

INFERRED blast radius: a never-worked ticket whose device recovers on its own — the case the
service exists for — is unreachable by any running code path. Dispatch keeps recommending SEs
to healthy devices (`recommender.service.ts:113` selects OPEN/UNASSIGNED), and downtime keeps
accruing in fleet-uptime (`fleet-uptime-aggregation.service.ts:85`). Wrong at any scale. The
service is fully implemented and green in its spec — the spec drives the method directly, so
the missing wiring is invisible to the suite.

### 2.2 ✔ Mobile troubleshoot submit swallows every non-conflict failure — a repair report can vanish with zero feedback

**OBSERVED** — `TroubleshootFormScreen.tsx:65-71`: the catch handles only
`TroubleshootConflictError`; any other failure (network drop, 400, expired token) is discarded —
no banner, no toast; the button reverts to "Submit Repair". An SE in a low-signal plant yard
taps Submit, the radio drops, nothing visibly happens, and the SE can walk away believing the
repair was filed. Every other mobile form (voucher, install, collection, leave, vehicle
unavailability) renders an error banner on the same pattern; the single most important field
submission is the one that shows nothing. Related silent-failure siblings, all OBSERVED:
`StockScreen.tsx:63-66` (confirm-receipt catch is an intentional no-op that also eats
network/auth failures and discards the server's structured conflict body);
`TicketDetailScreen.tsx:139-161` (recovery/install on-site handlers have no catch at all —
failures become invisible unhandled rejections in release builds);
`IntradayOfferScreen.tsx:46-60` (Accept on a CRITICAL offer shows nothing on network failure
while the acceptance deadline runs down and the server reroutes the ticket).

### 2.3 Cross-zone escalation: "one per ticket" enforced only by a read filter; manual endpoint bypasses the only guard; no DB unique

**OBSERVED** — `cross-zone-escalation.service.ts:75-118`: the sweep selects tickets with
`crossZoneEscalations: { none: {} }` then creates per-ticket with no transaction and no guard
between read and create; `schema.prisma:562-591` has `@@index([ticketId])` but **no unique** on
`ticketId`; the manual endpoint calls `svc.sweepAutoEscalations(...)` directly
(`cross-zone.controller.ts:51`), bypassing the scheduler's in-process guard; `flag()` (lines
128-147) is the same findFirst-then-create shape.

INFERRED: a cron tick and a manager's manual sweep interleave across the awaited per-ticket
creates → the same ticket gets two PENDING escalations, each with its own notification blast;
two managers can approve both, the second saved only by the assignment partial-unique backstop
surfacing as a 500 (3.2).

### 2.4 Voucher review and mark-paid: check in JS, write unconditionally — last writer silently wins ✔

**OBSERVED** — `vouchers.service.ts:247-282` (`review`): status checked in JS (line 260), then
`update({ where: { voucherId }, data: { status: next, ... } })` with no status predicate
(verified by direct read). Two concurrent reviews (ZM approves, CSM rejects) both pass, both
write audit rows, both actors are told OK; the last write wins. An SE can be paid on a voucher a
manager believes they rejected — the losing decision survives only in the audit log.
`markPaid()` (lines 321-347) is the same idiom, and a concurrent reject can be overwritten to
PAID. Human-speed collision likelihood is moderate; the consequence is financial.

### 2.5 Monthly/daily report rebuilds are DELETE+INSERT with no unique dimensional key — concurrent recompute doubles every number

**OBSERVED** — `root-cause-aggregation.service.ts:29-33`,
`system-efficiency-aggregation.service.ts:35-39`, `zm-performance-aggregation.service.ts:117-118`:
each wraps `DELETE WHERE month/day = X; INSERT …` in one tx — but the summary tables
(`RootCauseSummaryMonthly` schema ~L2365, `ZmPerformanceSummaryMonthly` ~L2392,
`SystemEfficiencySummaryDaily` ~L2427) have autoincrement PKs and **no unique on the
dimensional key**. Contrast: `DeviceDowntimeSummaryMonthly` has `@@id([deviceId, month])`
(~L2353) and upserts safely. The manual recompute endpoints call the aggregation services
directly (`reports.controller.ts:52,68,103,121,187`), bypassing the scheduler guard.

INFERRED (standard READ COMMITTED mechanics): two concurrent recomputes of the same period —
manual+manual, manual racing the month-start cron, or two instances — leave the period holding
**two full copies of its rows**; every scorecard doubles. Same class, smaller:
`soft-inactive-count.service.ts:108-131` snapshots history with no uniqueness on
`(zoneId, day, period)` — a manual run racing the 06:00/18:00 cron double-points trend charts.

### 2.6 Mobile sessions silently degrade into fake "Offline" after ~15 minutes

**OBSERVED both sides** — access token TTL is 15 minutes
(`apps/backend/src/auth/token.service.ts:22`); the mobile client calls `apiRefresh` **only**
from `resolveSession` at boot/login (single call site, grep-verified) and throws
`'UNAUTHORIZED'` on 401 everywhere else. Every read screen maps any failure to an
offline/empty state: `TicketsScreen.tsx:85-87` ("No cached tickets yet — connect to load"),
`HomeScreen.tsx:56-57` ("Offline" badge), vouchers/leave/availability likewise. ~15 minutes
after open, a perfectly connected phone reads as offline until app restart. Compounding
OBSERVED facts: all data is fetch-once-per-mount (`useEffect(..., [])`;
`HomeScreen.tsx:37`, `TicketsScreen.tsx:69`, `StockScreen.tsx:33`) with no polling, no focus
refetch, and no pull-to-refresh anywhere (zero `RefreshControl`/`onRefresh` in `src/` — while
two screens' error copy says "Pull to retry"); the offline write queue (`writeQueue.ts`,
`connectivity.ts`) is instantiated nowhere outside its own tests — dead code; and the app never
registers a push token (`POST /notifications/device-token` has zero mobile callers; no
`expo-notifications` in `src/`), so the one-shot intraday offer check on tab-shell mount
(`SeTabShell.tsx:38-61`) is the only way an SE ever learns of a CRITICAL offer.

**OBSERVED** — `AuthProvider.tsx:19-60` + `AppEntry.tsx:17-23`: a network failure during boot
`resolveSession` (non-`UNAUTHORIZED`) propagates into a mount effect with no try/catch —
`setLoading(false)` never runs and the app hangs on the boot spinner forever. An SE with a
valid stored session opening the app in a no-signal area gets a permanent spinner.

### 2.7 ✔ Admin dashboards render zeros and empty queues on API failure

**OBSERVED** (verified by direct read) — `WarehouseDashboard.tsx:56-67`: each queue fetch
carries `.catch(() => [])` **inside** the `Promise.all`, so the outer
`setError('Failed to load…')` is unreachable for fetch failures; the KPI tiles then compute
"Open Requests: 0", "Tickets Blocked: 0" from the substituted empty arrays
(lines 76-84). A backend outage renders as a clean day to the person deciding whether to ship
parts. Same class: `ReportsPage.tsx:80-85` (zone overview failure → "Total Inactive: 0" /
"Critical+: 0" beside a healthy uptime figure; and any soft-inactive-trend failure renders the
"Operations-Head-only" gate — a 500 shown to an actual OH as a role restriction);
`TicketDetailDrawer.tsx:94,106,118` (Forms/Components/Verification tabs render "no data" on
500 and memoize the failure for the drawer's lifetime). The admin **API layer** itself is
clean — every sampled module throws on non-2xx; the swallowing happens in pages.

### 2.8 Admin tickets list silently truncated at 100 rows

**OBSERVED** — backend `ticket-query.service.ts:298` applies `LIMIT min(limit>0 ? limit :
100, 500)` and the controller accepts `limit/offset` (`tickets.controller.ts:50-51`); admin's
`TicketFilters` has no limit/offset (`api/tickets.ts:63-74`) and `TicketsPage`/`DataTable`
render no pager, no total, no "more" indicator, under the subtitle "Every open and
recently-closed ticket in your zone". An all-zones CSM/OH with >100 matching tickets sees
exactly 100, and nothing says so. (Device Detail does this correctly — `devices.ts:96-99`
rows+total with a pager.)

### 2.9 Time and timezone disagreements across surfaces

- **✔ The 11 business sweeps fire in host-local time; dispatch is pinned.** OBSERVED (verified
  by direct read): every `@Cron` in `business-sweep-scheduler.service.ts:152-204` passes only
  `{ name }`; `dispatch-scheduler.service.ts:63` passes `timeZone: BUSINESS_TIMEZONE`
  ('Asia/Kolkata', `dispatch-cron.ts`). On any host not running in IST, the daily/monthly
  aggregation sweeps run at a different wall-clock hour than the one deliberately pinned job.
  No test asserts a business sweep's firing instant or expression (tests drive tick methods
  directly and assert only registered job names — 5.3).
- **Fleet Activity Trend buckets by UTC day against an IST operating day.** OBSERVED —
  `dashboard.service.ts:869,881` (`date_trunc(unit, created_at AT TIME ZONE 'UTC')`) vs. the
  IST day used by dispatch and leave (`common/ist-day.ts`). Tickets created 00:00-05:29 IST
  chart in the previous day's bar; day totals cannot reconcile with the dispatch ledger. Admin
  faithfully renders the UTC bucket (`api/dashboard.ts:178-183`).
- **Tier-override expiry parses a date input as UTC midnight.** OBSERVED —
  `TierOverridesPage.tsx:197,309`: `YYYY-MM-DD` → `new Date(...)` → UTC midnight stored raw
  (`tier-overrides.service.ts:82-85`). INFERRED: an override set to "Expires 2026-09-01"
  lapses at 05:30 IST that morning — tier reverts for 18.5 hours of its displayed final day,
  altering dispatch ordering. The repo's own IST helpers (`admin lib/datetime.ts:36-50`) are
  used for leave but not here.
- **Mobile availability window entry is a UTC trap.** OBSERVED —
  `AvailabilityScreen.tsx:153-168`: free-text ISO inputs with `Z`-suffixed placeholders; an SE
  typing local wall-clock with the suggested `Z` creates a window 5.5 h off. (Leave dates, by
  contrast, are handled correctly and deliberately handset-timezone-proof on both sides.)
- **Voucher Finance export month is UTC-bounded on both sides** (`vouchers.service.ts:489-495`;
  `VoucherReviewPage.tsx:33-36`) — internally consistent, but a voucher submitted 1st-of-month
  02:00 IST lands in the prior month's CSV.

### 2.10 Mobile renders backend states it doesn't understand as active work

**OBSERVED both sides** — `me-tickets-query.service.ts:73-88` returns assigned tickets with
**no status filter**, and `workStateFor` (lines 13-17) maps anything not in-work to `PLAN`.
Prisma `TicketStatus` has 17 values; `CLOSED`, `FAILED_VERIFICATION`, `ESCALATED`,
`CLOSED_NON_OPERATIONAL`, `RECEIVED_AT_WAREHOUSE`… therefore arrive as `workState: 'PLAN'` and
the ticket card pill reads "Plan" (`TicketsScreen.tsx:43`). A closed or escalated ticket looks
like still-planned work. Similarly `TicketDetailScreen.tsx:382-424` offers "Start Work" on
closed/failed troubleshoot tickets; tapping it posts a transition the backend refuses.

### 2.11 Ledgers that record the opposite of what happened

- **OBSERVED** — `batch-assignment.service.ts:234-238` + `dispatch-run.service.ts:200-204`: a
  throw in the post-commit per-SE notification loop is caught by the per-zone handler, which
  records the zone as errored with **0 schedules / 0 tickets** in `dispatch_run_zones` —
  although the schedules and tickets committed. The dispatch transparency ledger, whose purpose
  is recording what dispatch did, records the opposite; every SE after the failing one silently
  gets no day-plan push.
- **OBSERVED** — `master-sync.service.ts:416-421`: a failed departure-reconcile pass (the leg
  that cancels tickets on departed devices) is swallowed and the run finalizes `SUCCESS` with
  only a buried `skippedByReason.RECONCILE_FAILED` stat. Also lines 355-358: the catch path's
  `finishRun` can mask the original error when the root cause is DB trouble.
- **OBSERVED** — `notification.service.ts:132-189`: notification row and delivery rows are two
  separate commits with the (future FCM/SMS/WhatsApp) gateway calls between them; a throwing
  adapter leaves a notification with zero delivery records. And lines 146-176: only `SENT`/
  `ATTEMPTED` are ever written — `NotificationDeliveryStatus.SKIPPED`/`FAILED` (schema ~L1525)
  are unreachable, so the delivery audit trail cannot record what its own enum promises.
- **OBSERVED** — `SnapshotBanner.tsx:59-60` (admin): a `PARTIAL` snapshot run (some chunks
  failed; `SnapshotStatus`, schema ~L1399) renders the normal healthy banner — only FAILED and
  stuck-RUNNING alert. Mitigated: the shown "data as of" timestamp comes from the last SUCCESS.

### 2.12 Report buckets that can never be non-zero

**OBSERVED** — the only writes to `VerificationRun.outcome` are `CLOSED_AUTO_RECOVERY`,
`CLOSED`, `FAILED_VERIFICATION` (`verification.service.ts:137,296`). Readers that can never
fire: `zm-schedule-query.service.ts:222` (`partialRecovery` flag — always false) and
`reports.service.ts:270,565` (`PARTIAL_RECOVERY` and `FAILED_ACTIVATION` buckets in
`GET /reports/verification-outcomes` — permanently zero). The verification review page derives
its partial-recovery badge from ping counts instead (`verification-query.service.ts:57,83`), so
it is unaffected.

---

## 3. Findings that fail loudly (bounded damage, wrong error surface)

- **3.1 Idempotency as check-then-create.** OBSERVED — `vouchers.service.ts:157-160`,
  `troubleshoot-submission.service.ts:111-114`: `findUnique` then `create`; a truly concurrent
  duplicate passes the pre-check and hits P2002 inside the tx, surfacing as a 500 instead of
  the designed DUPLICATE response. The unique constraint prevents corruption; only the contract
  breaks.
- **3.2 Manual assign double-fire lands on the P2002 backstop as a 500.** OBSERVED —
  `override.service.ts:276-318`: `assignmentState` checked in JS, then create + unguarded
  ticket update; the loser of a race (two ZMs, or ZM vs. cross-zone approve vs. intraday
  accept) violates the one-active-per-ticket partial unique (migration `20260708120000`) and
  gets an unhandled 500, not `ALREADY_ASSIGNED`. Dispatch handles the same P2002 gracefully
  (`batch-assignment.service.ts:210-219`); the manual side throws.
- **3.3 Bulk unassign aborts mid-fleet without a summary.** OBSERVED —
  `bulk-unassign.service.ts:357-367` + `execute` (231-236, no per-zone catch): a post-commit
  notification throw aborts the Pan-India zone loop; an unknown prefix of zones was actually
  unassigned and the OH gets a bare 500.
- **3.4 Admin voucher actions have no failure feedback.** OBSERVED —
  `VoucherReviewPage.tsx:167,179,258`: `review`/`markPaid` rejections (including the
  legitimate `VOUCHER_INVALID_STATE` 409, `vouchers.controller.ts:155-157`) are unhandled —
  the click silently does nothing and the operator never learns the voucher was already
  decided.
- **3.5 Admin reload during a backend blip destroys valid tokens.** OBSERVED —
  `admin client.ts:34-42` + `AuthProvider.tsx:96-109` + `http.ts:42-43`: network failure and
  401 are the same `UNAUTHORIZED`; a failed refresh during an outage clears both tokens and
  lands the user on login although their tokens were valid.
- **3.6 AutoPlant MySQL pool can wedge under sustained black-holing.** OBSERVED —
  `autoplant-mysql.client.ts:84-131`: pool of 4, no socket/read/per-query timeout;
  `withQueryTimeout` races a timer and abandons the driver promise. INFERRED (mysql2
  semantics): an abandoned query's connection is returned only when the query completes or the
  socket errors — on a packet-black-holing VPN each timed-out tick can strand one of the 4
  connections; after 4, every subsequent tick fails on acquisition until process restart, and
  shutdown's `pool.end()` hangs. Medium-high confidence (driver semantics from knowledge, not
  verified against the installed version).
- **3.7 No stale-run reaper for `dispatch_runs`.** OBSERVED — `dispatch-run.service.ts:156,224`:
  a crash between create-RUNNING and finalize leaves a phantom eternally-RUNNING ledger row;
  snapshot and master-sync both have reapers, dispatch does not (no functional lockout — the
  in-flight guard is in-process and released in `finally`).
- **3.8 Mobile mislabels every unrecognized non-2xx as `UNAUTHORIZED`** (`mobile client.ts`),
  and `LoginScreen.tsx:18-21` renders any failure, including network/500, as "Invalid email or
  password". Feeds 2.6's offline conflation.

---

## 4. Scale: queries fine on fixtures, doubtful at fleet size

Current exercised volumes are e2e fixtures — ~11 devices, ~10 snapshots per file
(`data/autoplant/test-fixtures/*.csv`); the large-fixture dataset (`test/env/book8/`, ~12k rows)
is opt-in and its CSV is absent from this working copy. The export machinery is built for a
market of ~19k devices (`entity-mapping-export.service.ts`, keyset-paginated by design).

- **4.1 `zm-performance` cron seq-scans `audit_logs`, an unbounded, unpartitioned table.**
  OBSERVED — `zm-performance-aggregation.service.ts:66` filters
  `actor_role + created_at + action`; the table's only indexes are
  `(entityType, entityId)` and `(actedAsRole, actingZone, createdAt)` (schema ~L1506) — neither
  applies. Every mutation in the system appends an audit row in-tx; there is no retention and
  no partitioning (partitioning exists only for `raw_device_snapshots` —
  `partition-planner.ts`, migrations `20260619153000`/`20260706130000`). Monthly full scan of
  a forever-growing table, plus the growth itself as its own liability (same unbounded-growth
  class: `ticket_events`, `notification_deliveries`, and `refresh_tokens` — revoked but never
  deleted, `prisma-refresh-token-store.ts:47,99`, no cleanup job).
- **4.2 Fleet-uptime monthly run: full-table loads + one upsert per device.** OBSERVED —
  `fleet-uptime-aggregation.service.ts:51` loads every `device_states` row; :58 scans
  `failure_cycles` on unindexed `opened_at`/`closed_at` (indexes are `(state)`,
  `(deviceId, openedAt)`, `(previousFailureCycleId)`); :72 filters `tickets.closed_at`
  (unindexed); :82-120 awaits one `upsert` per device — ~19k sequential round-trips at fleet
  size. Degrades (a very long guarded tick), does not corrupt.
- **4.3 Verification sweep N+1 every 5 minutes.** OBSERVED — `verification.service.ts:32,46,
  194,202`: unbounded findMany of pending tickets (indexed), then per-ticket submission lookup,
  run get-or-create, and an un-`take`d ping fetch. Ping volume is bounded by 7-day telemetry
  retention at 30-minute cadence (≤ ~336 rows/device) and the partitioned unique index prunes —
  so hot, not fatal. The unwired auto-recovery sweep would inherit the same shape.
- **4.4 Recommender fan-out.** OBSERVED — `recommender.service.ts:113,204,207,247,419`:
  unbounded open-ticket findMany, then per-ticket candidate queries (each ≥2 queries) and
  per-ticket create + trace createMany; SE-level lookups are memoized (partial mitigation).
  INFERRED: thousands of open tickets/zone → tens of thousands of sequential queries per
  nightly run — slow inside its advisory lock, not wrong.
- **4.5 Master-sync plants leg is N+1** (up to 4 queries per plant,
  `master-sync.service.ts:178` + `mapping-table-zone-resolver.ts:62-108`) while its
  vehicle/device/company legs are properly key-set-batched and chunked — bounded by master-table
  size, nightly; low urgency.
- **Sound at scale (checked):** exports keyset pagination; tickets/devices/notifications/
  dispatch-run list endpoints all capped; dashboard aggregates are set-based `$queryRaw` with
  no row materialization; ingestion and device-state recompute are chunked/set-based; ping
  queries carry range predicates that prune partitions.

---

## 5. Test honesty

The suite is unusually honest overall — see §6 — with one systemic defect and three
certification gaps.

- **5.1 Shared-fixture zone corruption is order-dependent and file-persistent.** OBSERVED —
  15 spec files upsert an `engineerMaster` row for the same fixture SE UUID
  (`2222…2222`, seeded once per run by `test/global-setup.ts` → `auth-fixture-seed.ts`) with
  `update: {}` but **different `zoneId` values in `create`** (e.g.
  `shadow-use-controller.e2e-spec.ts:48` zone 1; `troubleshoot-controller.e2e-spec.ts:69-70`
  its own throwaway zone; `verification-controller.e2e-spec.ts:73` zone 'North'). First file
  to run pins the zone for the whole run; cleanup is asymmetric
  (`troubleshoot-controller.e2e-spec.ts:88-94` deletes only the other SE's row) and the DB is
  truncated once per run, not per file. Consequence path OBSERVED: `vouchers.service.ts:162`
  snapshots the SE's zone from `engineerMaster` at create and :217 filters the ZM queue by it —
  which is exactly the mechanism that makes the voucher-controller lifecycle assertions
  order-dependent. INFERRED: any of the ~58 files logging in as the fixture SE whose code path
  reads zone via `engineerMaster` is in the same class. Compounding: the runner's crash-retry
  re-runs a dropped file after a fresh truncate+reseed (`scripts/run-tests.mjs`), so a crash
  can convert an order-dependence red into a green.
- **5.2 `dispatch-transactional.e2e-spec.ts` no longer tests a rollback.** OBSERVED — the
  describe says "rolls back a partial SE plan" (:17) but the single test (:108-134) exercises
  the skip-guard; no test anywhere aborts `dispatchForZone` mid-transaction and asserts zero
  partial rows. A regression persisting half an SE plan on a late insert failure would pass.
- **5.3 Cron expressions and timezones of the 11 business sweeps are certified by nothing.**
  OBSERVED — sweep specs drive tick methods directly and registration specs assert only job
  *names* (`business-sweep-scheduler.e2e-spec.ts:262-277`, `-wiring.e2e-spec.ts:22-37`);
  only dispatch gets a behavioural next-fire-instant assertion
  (`dispatch-scheduler.e2e-spec.ts:103-125`). A wrong expression, a name/expression swap, or
  the missing-`timeZone` drift (2.9) is invisible to the suite — as is the unwired
  auto-recovery sweep (2.1), whose spec is green because it calls the method directly.
- **5.4 Mock-boundary casts** (`as unknown as VerificationService`,
  `business-sweep-scheduler.e2e-spec.ts:59-69`) defeat signature checking; mitigated by each
  sweep's own DB-backed spec and the real-DI wiring spec.

---

## 6. Negatives — what was checked and found sound

**Backend transaction discipline (verified across all 28 `$transaction` files, 24 read in
full):** audit rows commit in-tx via `AuditService.withAudit`; **zero empty catch blocks** in
`src/` (multiline grep); **zero floating promises** (`void` fire-and-forgets: only `main.ts:33`
wrapping a self-handling fatal guard); **no `this.prisma.` writes inside any `$transaction`
callback**; **no network/MySQL/HTTP call inside any transaction** (AutoPlant reads complete
before write batches; all notification I/O is post-commit — sometimes to a fault, 2.11). Every
`@Cron` handler contains its errors; no cron body can produce an unhandled rejection. Ticket
lifecycle cores (submit tx, ticket-creation with P2002-skip, verification finalize internals,
install CSV all-or-nothing, vehicle-unavailability), device-state recompute
(invariant-asserting tx), and device-departure reconcile are single well-formed transactions.

**Concurrency done right (the patterns the broken paths should copy):** the dispatch cluster —
shared-path in-process guard, per-zone `pg_try_advisory_xact_lock`, durable partial uniques
(one-active-schedule, one-active-per-ticket), recommendation consumption for idempotent re-runs,
orphan-cleanup keyed by run+zone, benign skips recorded on the ledger; schedule-closure takes
the same zone lock try-variant and re-reads inside it; snapshot/master-sync runs use advisory
lock + durable partial-unique in-flight index + stale-run reaping (the correct three-layer
pattern); the intraday state machine is the one flow that uses `transitionOrConflict`
everywhere and answers lost races idempotently; ticket numbering is a Postgres sequence; boot
races are serialized under an advisory lock; Prisma pool is bounded with `statement_timeout`
and `idle_in_transaction_session_timeout` pushed per-connection; `enableShutdownHooks` wired;
no `setInterval` and no listener registrations anywhere in backend `src/`.

**Admin:** single-flight token refresh with rotation, retry-once, terminating logout path — no
refresh loop possible (`http.ts:20-60`); every sampled API module throws on non-2xx (the
silent-empty pattern lives in pages, not clients); type parity verified field-for-field on 7
sampled contracts (tickets, vouchers, dispatch-runs, verification, non-op, snapshots, fleet
counts); role gating agrees on all sampled surfaces (OH-only reports/exports/settings,
warehouse routes, dispatch); both polling intervals clean up; no optimistic updates → no
desync class; KitchenSink is dev-only by static `import.meta.env.DEV`; ingestion double-fire is
guarded client-side and 409-backstopped server-side; IST helpers exist and are used correctly
for leave/planner.

**Mobile:** the API layer never fabricates success (every failure throws — screens, not the
client, do the swallowing); keychain token storage; refresh rotation persisted before the
retried call, single call site → no refresh race; no GPS watchers/intervals/listeners to leak —
nothing polls, so nothing can poll after logout; Business-409 conflict modeling is genuinely
good (typed conflict errors, duplicate-as-200 vs conflict-as-409 correct on both sides);
`X-Device-Id`/`X-App-Version` on every request; the IST leave-day round-trip is correct and
deliberately handset-timezone-proof; status enums for vouchers, component requests, leave match
Prisma exactly; field-diffed availability/leave/voucher/component-request/intraday/notification
response shapes — currently identical (though most are hand-duplicated rather than typed
against the shared package, so nothing prevents drift).

**Tests:** zero `.skip`/`.only`/`.todo` (grep); no retry config; TZ pinned at three layers
(worker env, DB session with its own regression spec, env allowlist — itself unit-tested);
services take injected `now` instead of ambient clocks; real race tests exist with second
connections holding advisory locks (`dispatch-concurrent`, `schedule-closure` APPEND race,
`intraday-accept-timeout-race`); aggregation specs compute expected values independently;
a meta-spec (`tier-override-fixture-guard.spec.ts`) actively polices a fixture-decay class;
the runner fails loudly on dropped files. Structural coverage is broad: every backend module
has at least one named suite.

### Not reached

Named so the unexamined is not mistaken for the verified: `OverrideService` command bodies
beyond ~line 470 (defer/reorder/swap); `RecommenderService` scoring internals beyond query
shape; `master-sync.service.ts` upsert internals; notification/WhatsApp delivery paths beyond
structure; media upload validation; planner service; admin Settings sections (~800 lines),
Planner grid, Territory page, CSV bulk-install flow; the `X-Acting-As-Zone` backend resolution
per endpoint (the client-side inconsistency is OBSERVED: shared `authHeaders` sends the header,
several modules' private copies — `devices.ts:7-10`, `verification.ts:7-13`,
`schedules.ts:8-14` — do not); mobile Android native layer; EXPLAIN-level index verification
(static analysis only); no test was executed (the suite needs a live Postgres); external
callers outside this repo (orphan-endpoint status is relative to the two in-repo clients plus
e2e specs). Roughly 45 of 351 test files were read in full or targeted excerpt; the rest were
covered at grep level.

### Closing hygiene list (compact; no further action implied)

Orphan endpoints with zero in-repo callers: `GET /audit-trail/tickets/:id`,
`POST /tickets/:id/auto-recovery-close`, `GET /verification/fraud-flags`,
`POST /role-unavailability`, `POST /me/activity-ping`, `GET /me/shared-pool`,
`GET /me/tickets/:id/forms`, `GET /dashboard/fleet-composition` (named only inside a tooltip
string), `GET+PUT /settings`, `POST /notifications/device-token`,
`POST /component-requests/:id/confirm-resubmit`, `GET /me/vehicle-unavailability` (SEs can file
but never see their filings), snapshot/integration/intraday manual triggers (plausibly
ops-only). Dead enum values (no writer in non-test src): `InstallTriggerSource.EXTERNAL_API`,
`NonOpState.UNMARKED`, `VerifyOutcome.PARTIAL_RECOVERY`/`FAILED_ACTIVATION`,
`NotificationDeliveryStatus.SKIPPED`/`FAILED`. Dead schema field: `Device.simId` (read into
API views, written by nothing — install writes `Ticket.installSimId`). Admin:
`apiTicketsByPlant` dead export; `TierOverridesPage` missing effect-cleanup flag; two
`authHeaders` implementations. Mobile: `writeQueue.ts`/`connectivity.ts` dead (also finding
2.6); module-level day-plan-cue caches survive a user switch (`dayPlanCues.ts:3-4`) — latent
only because no SE-reachable logout exists (`ProfileScreen` has none; `logout` never calls
`POST /auth/logout`, so the server-side refresh token would outlive it anyway); `console.log`
of the login flow left in `LoginScreen.tsx:14,19`; "Pull to retry" copy with no
pull-to-refresh implemented.

---

## Verdict

**Is this structurally sound enough to put in front of a field engineer for real work? Not yet —
and the gap is lopsided.** The backend core is genuinely strong: transaction discipline, the
dispatch/closure/ingestion concurrency architecture, error containment, and test honesty are
well above what greenfield codebases usually show, and the broken spots are deviations from
patterns the codebase itself already demonstrates correctly elsewhere. But the platform's
riskiest surface is precisely the one a field engineer touches: the mobile app can lose a
repair report without feedback (2.2), double-submit a voucher on retry (1.6), tell a connected
SE they're offline within 15 minutes of opening the app (2.6), and never inform them of a
CRITICAL intraday offer unless they cold-start the app inside the window (2.6). Behind that,
two backend flows can misstate physical inventory (1.1, 1.8), and the automated recovery loop
the ticket lifecycle appears designed around does not run at all (2.1).

**The three fixes I would make first, and why these three:**

1. **Make mobile submission honest: surface every failure, and move idempotency-key generation
   from per-tap to per-draft** (2.2 + 1.6; a `useRef`/state-held `clientSubmissionId` created
   when the form opens, and an error banner on the troubleshoot/receipt/on-site/offer paths).
   This is the smallest change with the largest field consequence: it converts "repair reports
   can silently vanish and vouchers can silently duplicate" into ordinary retryable errors,
   and it needs no backend change — the backend's dedupe and 409 contracts are already built
   for it.
2. **Fix the mobile session/refresh loop: refresh on 401 (or proactively), and stop mapping
   every failure to offline/empty** (2.6). Until this lands, the app is effectively a
   15-minute demo: every list an SE sees after that is stale or falsely "offline," which
   destroys trust in everything else the platform shows them — including correct data.
3. **Put state predicates in the WHERE of every terminal transition and an atomic
   decrement/unique key under every counter the money and stock paths touch** (1.1, 1.2, 1.8,
   2.4, 2.5; concretely: `{ decrement }` for van stock, `updateMany`-with-status-guard — the
   existing `transitionOrConflict` — for troubleshoot submit, verification finalize/manual
   actions, and voucher review/markPaid, plus unique dimensional keys on the three summary
   tables and `CrossZoneEscalation.ticketId`). These are all instances of one defect class the
   repo already owns a primitive for; a single disciplined pass eliminates the entire
   data-corruption tier and most of the silent-wrong-output tier at once.

Fourth, deliberately not in the top three but close: wire `runAutoRecovery` into the business
sweep scheduler (2.1) — it is implemented and tested, just never called; and decide the
sweeps' `timeZone` question (2.9) the same day, since both are one-line scheduler changes that
alter business behaviour and deserve an explicit decision rather than a drive-by fix.
