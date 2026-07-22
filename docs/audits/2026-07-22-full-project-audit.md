# FSM Platform — Full Project Audit & Next-Work Selection

**Date:** 2026-07-22 · **Branch:** `feat/autoplant-integration` · **HEAD:** `ad03769` (+ 28 modified / 9 untracked)
**Type:** READ-ONLY audit. No code changed. One temporary probe script was created and deleted.

Method: read the authority docs (`CLAUDE.md`, `SYSTEM-STATE-2026-07.md`, `INDEX.md`, the four 2026-07
audits, PRD/workflow references), then **cross-checked every load-bearing claim against the tree and
against the live dev database**. Docs are claims; code and DB rows are evidence. Every finding below
cites `file:line` or a query result. Anything I could not prove is marked **Unable to verify**.

---

## 0. What changed my conclusions

Three things I assumed from the docs turned out to be wrong when probed. They are stated up front
because they invert the priority order a docs-only read would produce.

| Assumption from docs | Reality (probed 2026-07-22) |
|---|---|
| All three ops master switches are OFF; "nothing runs unattended" (SYSTEM-STATE §1.2, §6.2) | **`BUSINESS_SWEEPS_ENABLED="true"`** in `apps/backend/.env`. The dispatch cron and all 10 field-loop sweeps are live. `dispatch_runs` row 4 has `trigger='CRON'`, started 2026-07-22 09:31. |
| Ingestion is off, so telemetry is stale and the sweeps will mis-fail work | Telemetry is **fresh**: `max(raw_device_snapshots.gps_datetime)` = 2026-07-22 10:11, last `snapshot_runs` SUCCESS 10:08 — despite `INGESTION_SCHEDULER_ENABLED="false"`. Someone/something is driving the pipeline manually. The mis-fail risk is therefore **latent, not active**. |
| The recent audits' unowned findings (NEW-A1/A2/C1) are the top open risks | Measured exposure on the dev DB is **zero for all of them today**: 0 FLOATING SEs, 0 rows in the floating MV, 0 null-bucket open tickets, 0 SEs over capacity. They are latent. The live risk is elsewhere — see §5. |

---

## 1. Current state (Phase 2)

### 1.1 What is genuinely complete

The nine-stage funnel (master sync → snapshots → device-state → tickets → recommender → dispatch →
field loop → verification → report cubes) is **code-complete, tested, and now demonstrably running**.
This is not a docs claim — `dispatch_runs` row 4 is a CRON-triggered run across 5 zones that produced
52 schedules / 80 batches / 1,114 dispatched tickets.

Verified subsystems: ingestion + run ledger + partitioning; device-state set-based recompute with the
#130 departure invariant; ticket creation with I1/I2 backstops; recommender with precedence + scoring
+ transparency traces; batch dispatch with advisory lock + three partial uniques; plant deactivation
(#119); device departure lifecycle (#128); build-fingerprint/migration-skew guard (#130); global
guard chain + ValidationPipe (#99); boot hardening (#98).

Code quality is unusually high for a project this size: **one TODO in the entire backend `src/`**
(`recommender.service.ts:371`) and **zero silently-swallowed catch blocks** found by pattern sweep.
`tsc --noEmit` is clean on the backend with the full uncommitted layer applied.

### 1.2 What is partially implemented

| Area | State | Evidence |
|---|---|---|
| Two of five recommender hard filters | Permanently inert — `VEHICLE_ON_TRIP` reads a stubbed `'UNKNOWN'`, `COMPONENT_UNAVAILABLE` a stubbed `true` | `recommender.service.ts:191,195`; owners #65 / #51 |
| ZM override engine | 3 of 5 actions work. `DEFER_TICKET` is write-only (§5.1); `REMOVE_TICKET` has no exclusion memory (§5.2) | `override.service.ts:149,182` |
| `#124` effective config snapshot | Snapshot captures DB-overridden settings only. Run 4's `config_snapshot.settings` = `{eligibility_mode, plant_cluster_multiplier}` — **omits `inactivity_threshold_hours`** (present in `system_settings` as 24) and the DEFICIT/PREVENTIVE `threshold_pct` code default | probed run 4 |
| Warehouse stock | Manual WM entry only; `reserved` has no writer | #95 |
| Cross-zone read model | DENIED AUTO rows invisible to home ZM | #93 |

### 1.3 What is missing

- **SE mobile app in its entirety.** Auth shell only (14 files). Every M-series screen unbuilt. This
  is the single largest scope gap against the PRD and it is not a code problem — #54 has no owner
  session.
- **CI.** `ls .github` → does not exist. Confirmed; #107 open.
- **Deployment / DR.** No Dockerfile, compose, or runbook. #111 open.
- **Production auth.** `InMemoryUserStore` still live; DB `users` cannot log in. #91 open.
- **Rate limiting.** No throttler anywhere. #110 open.
- **SAP PGI feed.** `pgi_history` has no writer; `eligibility_mode` runs on the `all-deployed` proxy
  (confirmed: `system_settings.eligibility_mode = 'all-deployed'`).

### 1.4 Prototype / dev-scaffold code still in the live path

- In-memory auth stores (#91).
- Mock SE workforce: **75 SEs, 63 DEDICATED + 12 MULTI_PLANT, 0 FLOATING**, seeded by
  `scripts/reset-reseed-ses.cjs`. Every capacity is exactly 25 (run-4 config snapshot).
- `scripts/reset-reseed-ses.cjs` and `db-explore.cjs` are untracked/loosely-tracked dev tools that
  mutate production-shaped data.

---

## 2. Cross-validation (Phase 3) — doc ↔ issue ↔ code ↔ DB ↔ API ↔ UI

Findings where the layers **disagree**:

| # | Disagreement | Evidence |
|---|---|---|
| X1 | SYSTEM-STATE §1.2/§6.2 and INDEX §"Activation checklist" both state all master switches are OFF and "nothing runs unattended today". | `.env` has `BUSINESS_SWEEPS_ENABLED="true"`; `dispatch_runs` run 4 `trigger='CRON'`. **The authoritative current-state doc is stale on the single most consequential operational fact.** |
| X2 | INDEX Next-up row 8 says #124 **"Gates `BUSINESS_SWEEPS_ENABLED` — recorded prod dispatch history is un-interpretable otherwise; can't retrofit past runs."** | The gate has been crossed with #124 unbuilt. Run 4 is the first CRON run to write a permanently incomplete `config_snapshot`. One more is due at 05:00 daily. |
| X3 | INDEX Next-up preamble: hardening (#91/#98/#99/#110/#107) and #101-remaining + #103 come **"before `BUSINESS_SWEEPS_ENABLED` is ever flipped."** | #91, #110, #107, #101-remaining, #103 (partial) are all still open. |
| X4 | SYSTEM-STATE §6.1 documents `system_settings` as 4 keys. | DB has **8**: adds `onsite_stale_warning_hours`, `recompute_canary_threshold_pct`, `troubleshoot_started_stale_warning_hours`, `viewed_soft_state_timeout_minutes`. Doc drift, harmless. |
| X5 | `deferredToDate` is a documented ZM override outcome (schema comment `schema.prisma:545-546`, FE action `ScheduleDetailPage.tsx:381`, API type `schedules.ts:134`). | Written at `override.service.ts:182`, **read by nothing** — grep across `apps/backend/src` returns 3 hits, all writes/type declarations. Schema → API → UI all agree; the read layer does not exist. |

Layers that **agree** (spot-checked, no correction needed): the funnel table in INDEX vs code; the
#126/#130/#128 fix claims vs the cited lines; the transparency ledger shape vs `dispatch_runs`
columns; the RBAC guard chain; the `all-deployed` eligibility setting; the #103 partial fix
(`tickets(device_id, created_at DESC)` present in schema **and** as a committed migration).

---

## 3. Production audit (Phase 4)

### 3.1 Governance / operational risk — the dominant finding

**The code driving the live dispatch cron exists only as uncommitted files on one machine.**

- `runtime_lock` (the #130 identity row) reads
  `version=1784632691, fingerprint="d1764e3-dirty", boot_at=2026-07-21T18:05, hostname=NVT-L-0473`.
  The running backend was built from a **dirty working tree** at commit `d1764e3`.
- `git rev-list --left-right --count origin/...HEAD` → **`0 4`**: four commits unpushed.
- On top of that, 28 modified + 9 untracked files, including the **#127 APPEND fix**
  (`batch-assignment.service.ts`, `dispatch-run.service.ts`, migration
  `20260721120000_batch_run_attribution`) and the **NEW-A1 capacity fix** (`recommender.service.ts`).
- Those uncommitted fixes are **demonstrably working in production**: run 3 (pre-fix) recorded
  `recommended=1370 / dispatched=1045` — the 325-ticket gap the operator reported, with
  `dispatch_run_zones.error = "SCHEDULE_CONFLICT: SE(s) … ; 325 orphan SUGGESTED rec(s) cleared"`.
  Run 4 (post-fix, CRON) recorded `recommended=1114 / dispatched=1114` — **reconciles exactly**.

A disk failure now loses a proven correctness fix for the safety-critical assignment path, plus a
schema migration the live DB has already applied. There is no CI and no second copy.

**Severity: HIGH. Likelihood: the only variable is time. Effort to fix: minutes.**

### 3.2 Scalability, indexes, constraints

- **`tickets.vehicle_id` unindexed** (`schema.prisma` `model Ticket` has `@@index` on
  `(status, plantId)`, `(workType, status)`, `(companyId)`, `(deviceId, createdAt desc)`,
  `(nonOpMarkingId)` — none on `vehicleId`). #103 leg still open.
- **`audit_logs` index/query column mismatch.** The only composite index is
  `(acted_as_role, acting_zone, created_at)` (`schema.prisma:1317`), but the monthly ZM scorecard
  aggregation filters `WHERE actor_role = 'ZONAL_MANAGER' AND created_at …`
  (`zm-performance-aggregation.service.ts:69`). Different column → **full seq scan** on an
  append-only, unpartitioned, retention-less table. Currently cheap (10,727 rows); grows unbounded
  (#104). The existing index looks like coverage and is not.
- **`work_schedules` are never closed.** No code path writes a terminal status — the only
  `workSchedule.update` calls are `override.service.ts:365,487` (→ `OVERRIDDEN`). Confirmed on the
  DB: **52 ACTIVE schedules dated today and 50 still-ACTIVE dated yesterday.** They accumulate
  forever. The day-bounded consumers (`committedDayLoad`, the dispatch `existing` lookup) filter by
  date and are safe; `DayPlanQueryService.getDayPlan` is not (§5.3).
- **Backlog vs capacity is the real operational ceiling**, not code: 9,280 OPEN + UNASSIGNED
  troubleshoot tickets against 75 SEs × 25 capacity ≈ 1,875/day. `recommendations` currently holds
  **19,408 UNASSIGNABLE vs 2,159 DISPATCHED**.

### 3.3 Architecture-level risks

- **In-process `@nestjs/schedule` cron means the backend is single-instance by construction.** Two
  replicas would double-run every sweep; the in-memory per-sweep lock does not cross processes
  (pipeline-risk audit NEW-5). This is fine today and is a hard constraint on any HA deployment —
  it should be written into #111 rather than discovered during deployment.
- **Module wiring forks (#105)**: `recommender.module.ts` re-provides `InventoryService` /
  `SeAvailabilityService` / `SoftInactiveCountService`. Duplicate singletons; latent, becomes a
  correctness bug the day any of them caches.
- **No queue / outbox.** Notifications are fired post-commit in-process
  (`batch-assignment.service.ts:223-225`); a crash between commit and notify loses the event
  silently. Same shape as #140. Acceptable at current scale; an outbox is the eventual answer (#76
  already carries that scope).

### 3.4 Prior conclusions challenged

- **NEW-C1 (departure absence-guard) — mechanism half CONFIRMED, trigger half still open.** The
  audit left "does the reader terminate a drain on a short page without erroring?" untraced. It
  does: `autoplant-master-source.ts:149` — `if (page.length < this.pageSize) break;`. Any short page
  ends the drain silently, and every device after the truncation point becomes `ABSENT_FROM_READ`.
  The remaining unknown is whether MySQL/mysql2 can *produce* a silent short page (a query timeout
  raises `ER_QUERY_TIMEOUT`; a dropped connection rejects). **Unable to verify** without VPN access.
  One sub-hypothesis is now **ruled out**: keyset pagination cannot skip rows, because
  `mst_vehicle.vehicle_no` is a single-column `PRI`
  (`docs/autoplant/Complete structure of mst_vehicle.md:1`).
- **The `#127` APPEND fix introduces no P2002 risk** from duplicate plant stops: there is **no**
  unique constraint on `plant_batch_assignments(schedule_id, plant_id)` (`schema.prisma:516-543`).
  Verified, because the fix deliberately creates a second stop row for an already-visited plant.
- **`dispatch_run_zones.schedules` changed meaning** under APPEND: `schedules++` now counts
  schedules *touched* (created **or** appended-to), and the day-plan notification's `stops` field is
  now the schedule's **total** stop count, not this run's. Both are defensible; neither is
  documented. Cosmetic, flagged so it is not later diagnosed as a bug.

---

## 4. Architecture review (Phase 7)

**Verdict: GOOD. No rewrite is warranted. Do not refactor.**

The NestJS modular monolith over Postgres+PostGIS with Prisma still satisfies the PRD. The design
choices that matter are all correct and well-defended in-repo: set-based recompute instead of
per-device scans; partial unique indexes as durable invariants rather than application-level
locking; advisory locks scoped to the transaction; append-only explainability (`recommendations`,
`dispatch_decision_traces`) instead of mutable state; anti-drift side tables
(`plant_deactivations`, `plant_zone_overrides`, `device_departures`) instead of writing FSM opinions
into mirrored columns. The #130 build-fingerprint lock is a genuinely sophisticated answer to a real
incident.

Three architectural gaps are worth naming, none requiring redesign:

1. **Single-instance cron** (§3.3) — constrains deployment, must be stated in #111.
2. **No transactional outbox** — three separate findings (#140, the day-plan notifier, the
   post-commit MV refresh) are the same missing primitive. Build it once, with the first real
   channel adapter (#76 already owns the scope).
3. **`sla_rule_config` is editable-but-inert** — no runtime consumer (established by the 2026-07-21
   proposal analysis). Either wire it or mark it reserved; an editable no-op config table is a trap.

---

## 5. Bug discovery (Phase 6) — new, not in any existing issue or audit

Only findings I could prove are listed. Exposure counts are from the live dev DB, 2026-07-22.

### B1 — `DEFER_TICKET` is a write-only field: deferring a ticket does nothing, and it still burns the SE's daily capacity

- **Severity:** HIGH (correctness of an operator-facing control). **Likelihood:** certain, on first use.
  **Current exposure:** 0 rows (`batch_assignment_tickets WHERE deferred_to_date IS NOT NULL` = 0) — **latent**.
- **Root cause:** `deferredToDate` has a writer and no reader.
  - Written: `override.service.ts:182` (`data: { deferredToDate: new Date(cmd.deferredToDate) }`).
  - Read: **nowhere.** `grep -rn "deferredToDate|deferred_to_date" apps/backend/src` → 3 hits, all in
    `override.service.ts` (the command type at `:21`, the audit payload at `:175`, the write at `:182`).
- **Three consequences, each independently verified:**
  1. The ticket stays on **today's** plan. `DayPlanQueryService.getDayPlan` filters batch tickets on
     `removedAt: null` only (`day-plan-query.service.ts:52`); so do
     `zm-schedule-query.service.ts:99,130` and `dispatch-transparency-query.service.ts:357,373,494`.
     No read anywhere filters `deferredToDate`.
  2. The ticket is **never re-dispatched on the deferred date**. `deferTicket` does not touch
     `assignmentState`, so the ticket stays `FORMALLY_ASSIGNED` and the recommender — which selects
     `status: 'OPEN', assignmentState: 'UNASSIGNED'` (`recommender.service.ts:103-108`) — can never
     pick it up again.
  3. It **consumes capacity today**. The new `committedDayLoad` counts
     `batchAssignmentTicket WHERE removedAt: null` (`recommender.service.ts:548-555`), so a deferred
     ticket occupies one of the SE's 25 slots for a day on which it will not be worked.
- **Reproduction:** `POST /api/schedules/:id/override` with
  `{action:'DEFER_TICKET', ticketId, deferredToDate: <tomorrow>, reasonCode}` → 200 + audit row +
  `OVERRIDDEN` badge. Then `GET` the SE's day plan: the ticket is still listed for today. Wait for
  tomorrow's dispatch run: it is not re-planned.
- **Suggested fix:** decide the semantic first, then implement one of —
  (a) *defer = remove-with-a-date*: set `removedAt` + `deferredToDate`, flip the ticket to
  `UNASSIGNED`, and have the recommender skip it until `deferredToDate` (needs a ticket-level
  `deferred_until`, since the batch row is per-plan); or
  (b) *defer = display-only*: filter `deferredToDate > today` out of the day-plan and capacity reads
  and leave the assignment intact.
  (a) matches the ZM's mental model; (b) is a two-line change. **This is a business-rule call, not
  an engineering one** — CONTEXT.md/PRD authority.
- **Confidence: HIGH** (grep is exhaustive; all three consequences traced to specific lines).

### B2 — `REMOVE_TICKET` has no exclusion memory, so the next dispatch run can return the ticket to the same SE

- **Severity:** MEDIUM. **Current exposure:** 0 rows (`removed_at IS NOT NULL` = 0) — **latent**.
- **Root cause:** removal sets `removedAt` and flips the ticket to `UNASSIGNED`
  (`override.service.ts:144-149`) — deliberately, "Returned to the Shared Pool". Nothing records
  *which SE it was removed from*. The recommender then re-selects it (`OPEN` + `UNASSIGNED`), and the
  new idempotency guard excludes only tickets with a **live** batch row
  (`batch-assignment.service.ts:90-91`, `removedAt: null`), so a removed ticket is fully eligible again.
- **Why it matters more now:** before the #127 APPEND change, a same-day second dispatch run
  P2002'd and rolled back the whole zone, so removals survived *by accident*. APPEND makes the
  second run succeed — the removal is now silently reversible within the same day.
- **Nuance (stated honestly):** "return to the shared pool" is the documented intent, and
  re-assignment to a *different* SE is correct. The defect is narrower: **nothing prevents
  re-assignment to the SE the ZM just removed it from.**
- **Suggested fix:** a soft negative-preference — the recommender de-prioritises (not hard-filters) an
  SE who had this ticket removed today. Mirrors the existing SE-Planner soft-bias mechanism
  (ADR-0022), so no new concept.
- **Confidence: HIGH** on the mechanism; **MEDIUM** on it being unintended (needs a product call).

### B3 — `work_schedules` are never closed, and the SE day-plan read has no date filter

- **Severity:** MEDIUM (mobile-facing; mobile is unbuilt, so today it is dormant).
  **Current exposure:** 50 ACTIVE schedules dated 2026-07-21 still ACTIVE on 2026-07-22.
- **Root cause:** no code writes a terminal `work_schedules.status`. `DayPlanQueryService.getDayPlan`
  selects `findFirst({ where: { seId, status: 'ACTIVE' }, orderBy: { dispatchedAt: 'desc' } })`
  (`day-plan-query.service.ts:40-43`) — **no `dateFrom`/`dateTo` predicate**.
- **Failure scenario:** an SE with no dispatched work today is served **yesterday's** day plan as
  today's, with no indication it is stale. Under APPEND this also gets subtler: appending to an
  existing schedule does not refresh `dispatchedAt`, so the `orderBy` tiebreak is now on a stamp that
  no longer tracks last-modification.
- **Suggested fix:** add `dateFrom: { lte: today }, dateTo: { gte: today }` to the day-plan read
  (one line, no schema change), and file the schedule-lifecycle closure separately.
- **Confidence: HIGH.**

### B4 — Business sweeps and ingestion are coupled but the coupling is unenforced and undocumented

- **Severity:** HIGH if it occurs. **Current exposure: 0** — telemetry is fresh
  (`max(gps_datetime)` = today 10:11) and there are **0 troubleshooting submissions and 0
  verification runs** on this DB, so nothing can currently mis-fail.
- **Root cause:** `BUSINESS_SWEEPS_ENABLED=true` runs the verification sweep every 5 min
  (`business-sweep-scheduler.service.ts:26`) and install-activation likewise. Both resolve a 24-hour
  window against `raw_device_snapshots`:
  - `verification.service.ts:158-162` reads pings after submission; `:182` `expired = now - startedAt
    >= TWENTY_FOUR_HOURS_MS`; `:186-187` → `FAILED_VERIFICATION` when Phase 1 has not passed.
  - `install-lifecycle.service.ts:30,181,211-216` → `FAILED_ACTIVATION` on the same window.
  With `INGESTION_SCHEDULER_ENABLED=false` and nobody driving the pipeline manually, **no new pings
  are written**, so every submission ages out into an irreversible failed terminal state regardless
  of whether the SE actually fixed the device — and inventory `PRE_VERIFICATION` is rolled back with it.
- **Why this is a real gap and not a hypothetical:** the repo already documents exactly this class of
  coupling for ingestion↔partition-maintenance ("treat the two as one switch", INDEX activation
  checklist §2) — and enforces neither. Today the system is one manual-runner interruption away from
  the failure. Ingestion is currently running *despite* its own flag being `false`, which means the
  freshness the sweeps depend on is unowned.
- **Suggested fix:** a staleness precondition in both sweeps — do not expire a verification window
  while the telemetry watermark (`snapshot_runs.data_as_of`) has not advanced past the submission
  time. This is strictly safer than the current behaviour and needs no ops discipline.
- **Confidence: HIGH** on the mechanism and the code path; the exposure statement is measured.

### B5 — ZM-scorecard aggregation seq-scans `audit_logs` behind an index that looks like coverage

- Covered in §3.2. **Severity:** LOW now (10,727 rows), grows unbounded. **Confidence: HIGH.**
- Fold into #103 rather than filing separately; note explicitly that
  `(acted_as_role, acting_zone, created_at)` does **not** serve `WHERE actor_role = …`.

### Not re-reported (already owned, verified still-open)

NEW-A2 null-bucket silent drop (`recommender.service.ts:122`; **live exposure 0** — 0 of 9,280 open
unassigned tickets have a null bucket) · NEW-C1 (§3.4) · NEW-C2 deactivation TOCTOU · #132 reaper ·
#139 / #140 cross-zone orphans (**0 escalation rows**, latent) · #101-remaining races · #105 wiring ·
#124 · #51 / #65 inert filters.

---

## 6. Ranked next work (Phase 5)

Ranked on business impact × production risk × time-decay × inverse effort. Effort is my estimate.

| Rank | Work | Why now | Deps | Risk of doing it | Effort | Confidence |
|---|---|---|---|---|---|---|
| 1 | **Commit + push the dispatch-correctness layer** | The proven fix for the live cron exists only on one disk; 4 commits unpushed; no CI; migration already applied to the live DB (§3.1) | none | Very low — code is tsc-clean and its tests are written | **Minutes** | HIGH |
| 2 | **#124 effective config snapshot** | Time-decaying and un-retrofittable by the tracker's own note. The cron writes an incomplete snapshot every 05:00; run 4 already did (§2 X2) | #123 slice 2 (done) | Low — additive write | **S** | HIGH |
| 3 | **Override integrity — B1 + B2 + B3** | The ZM override engine is the human safety valve over an engine that is now unattended, and 2 of its 5 actions do not do what they say | Needs one product decision on defer semantics | Low–Medium | **S/M** | HIGH (B1/B3), MEDIUM (B2) |
| 4 | **B4 sweep-staleness precondition** | Removes a whole class of irreversible wrong outcomes without relying on ops discipline | none | Low — strictly more conservative | **S** | HIGH |
| 5 | **#107 CI** | Every "green" is a local claim on one OOM-prone box; #1 makes it possible, #107 makes it durable | #99 (done) | Low | **M** | HIGH |
| 6 | **#103 remaining legs** (+ B5) | Cheap, before ticket volume grows past 21k | none | Very low | **S** | HIGH |
| 7 | **#91 auth + #110 rate limiting** | Gates any exposure beyond a demo network | HITL: credential-column placement | Medium | **L + S** | HIGH |
| 8 | **#101 remaining races** | Was gated on `BUSINESS_SWEEPS_ENABLED`; that gate is now open, but exposure is still ~0 (single operator, 0 submissions) | none | Medium | **M/L** | HIGH |
| 9 | **#129 departure UI parity, #132 reaper, #139/#140** | Real but latent (0 rows each) | none | Low | S–M each | HIGH |
| 10 | **#54 mobile foundation** | Largest PRD gap; unblocks ~18 M-series issues. Not urgent *today* because no SE uses the system yet | #81–#84 | High | **XL** | HIGH |

### Immediate (this session)
1, 2, and 3 — they are one coherent session: land what is already proven, then close the two things
that make the *now-unattended* engine trustworthy (interpretable history, working override actions).

### Next sprint
4, 5, 6 — the "make green claims real and keep them real" set.

### Future
7, 8, 9 — before any exposure beyond the demo network; 8 specifically before a second concurrent
operator exists.

### Never / re-scope
- **Per-zone engine configuration** — already correctly decided against (INDEX "Deferred /
  decided-against", proposal `f0f3dcb`). Do not revisit; the KPI-denominator and self-grading
  arguments are sound.
- **#52** — superseded by #55/#60, retained for history only.
- **`sla_rule_config`** — editable with no runtime consumer. Either wire it or mark it reserved in
  the schema; leaving it editable-and-inert is a trap for a future operator.
- **Any rewrite or large refactor.** The architecture is sound (§4). #105 module wiring is the only
  refactor worth scheduling, and only when something starts caching.

---

## 7. Recommended implementation plan

### Slice 0 — Land the live-correctness layer *(rank 1, minutes)*

- **Objective:** the code running the production cron exists in more than one place.
- **Files:** `batch-assignment.service.ts`, `dispatch-run.service.ts`,
  `dispatch-transparency-query.service.ts`, `recommender.service.ts`, `schema.prisma`,
  `prisma/migrations/20260721120000_batch_run_attribution/`, the three new/updated e2e specs.
- **Do not sweep in** the concurrent admin-session files (`SeManagementDirectoryPage.tsx`,
  `engineersAdmin.ts`, `EditableCell.tsx`, `InactiveCountLink.tsx`, the dashboard/shell edits) — stage
  by explicit path, the discipline this repo already uses for concurrent trees.
- **Tests:** `dispatch-same-day-append.e2e-spec.ts`, `recommender-cross-zone-capacity.e2e-spec.ts`,
  plus the updated `dispatch-zone-wedge` / `dispatch-transactional` suites. Run before committing.
- **AC:** two commits (#127 APPEND, NEW-A1 capacity), branch pushed, `git status` clean of backend
  scheduling/recommender files, INDEX session-log line appended.
- **Rollback:** `git revert`; the migration is additive (nullable FK, `onDelete: SetNull`) and
  already applied — no down-migration needed.

### Slice 1 — #124 effective config snapshot *(rank 2, S)*

- **Objective:** `dispatch_runs.config_snapshot` records the **effective** value of every
  behaviour-changing knob, with provenance (`db-override` vs `code-default`).
- **Files:** `dispatch-run.service.ts` (`captureConfigSnapshot`, currently ~`:204-223`),
  `dispatch-transparency-query.service.ts` (surface provenance),
  `apps/admin/src/pages/dispatch/…` config panel (replace "Default (not overridden)" with the value).
- **Services:** `SettingsService`, `SoftInactiveCountService` (threshold_pct), `DeviceStateService`
  (inactivity_threshold_hours), scoring defaults.
- **Database:** none — `config_snapshot` is JSONB.
- **Must include** (verified missing from run 4): `inactivity_threshold_hours`, soft-inactive
  `threshold_pct`, the code-default weight set when `priority_rule_config` has no row, and the
  PREVENTIVE weight-set resolution.
- **Tests:** e2e asserting a run started with **zero** `system_settings` rows still snapshots every
  knob with `source: 'code-default'`; a snapshot round-trips through the transparency read.
- **AC:** a future reader can reconstruct exactly why run N chose what it chose, from the row alone.
- **Rollback:** revert; snapshots are write-once ledger rows, older shape still reads (the FE already
  tolerates missing keys via the `?? {}` guard pattern used in `getZoneDetail`).

### Slice 2 — Override integrity *(rank 3, S/M)*

- **Blocking product decision (one question, carried to the operator):** does DEFER mean *"take it
  off today's plan and re-plan it on date D"* (option a) or *"keep the assignment, just don't show
  it until D"* (option b)? I recommend **(a)** — it matches "defer" and is what the ZM believes they
  did. Everything else below is decision-independent and can start now.
- **Files:** `override.service.ts` (defer + remove), `day-plan-query.service.ts` (date filter, B3),
  `recommender.service.ts` (defer-aware selection + soft negative preference for B2),
  `zm-schedule-query.service.ts` / `dispatch-transparency-query.service.ts` (defer-aware reads).
- **Database:** option (a) needs a ticket-level `deferred_until` (`DATE`, nullable) — the batch row is
  per-plan and cannot survive re-planning. Additive migration, no backfill (0 existing rows).
- **Tests (TDD, RED first):** defer → ticket absent from today's day plan → present in tomorrow's
  recommender run → does **not** count against today's `committedDayLoad`; remove → same SE is
  de-prioritised, a different SE is not; day-plan read returns empty (not yesterday's plan) for an SE
  with no schedule dated today.
- **AC:** every ZM override action has an observable effect matching its label, and none silently
  reverses on the next run.
- **Rollback:** revert; `deferred_until` is nullable and unread by older code.

### Slice 3 — Sweep staleness precondition *(rank 4, S)*

- **Objective:** a verification/activation window cannot expire while telemetry is not advancing.
- **Files:** `verification.service.ts` (guard around `:182` `expired`),
  `install-lifecycle.service.ts` (same at `:181`), reading `snapshot_runs.data_as_of`.
- **Tests:** submission + stale watermark + 25h elapsed → stays `PENDING`, not `FAILED_VERIFICATION`;
  watermark advances past the submission with no ping → fails as before (unchanged behaviour).
- **AC:** no ticket reaches a failed terminal state on the basis of telemetry that was never ingested.
- **Rollback:** revert; the guard is purely conservative.

---

## 8. Scores

| Dimension | Score | Basis |
|---|---|---|
| **Progress vs PRD** | **~70%** | Backend funnel ~98% · Admin FE ~95% · Mobile ~2% (auth shell only). Mobile is roughly 30% of the PRD surface and is the whole gap. |
| **Backlog completion** | **~93%** | 163 issue files; the open set is the hardening track (#91/#101/#103/#104/#105/#106/#107/#110/#111), the mobile M-series, and 6 fast-follows. |
| **Architecture health** | **GOOD** | §4. No rewrite warranted. Three named gaps, all additive. |
| **Production readiness** | **4 / 10** | Funnel proven end-to-end and running (+3). Guard chain, boot hardening, build-fingerprint lock, transparency ledger (+2). Minus: in-memory auth, no rate limiting, no CI, no deployment/DR, single-instance-only cron, live code uncommitted and unpushed, activation gate crossed with 4 of its gating items unbuilt. |
| **Test posture** | **Medium** | 1,000+ backend and ~290 admin tests with genuine TDD discipline — but every green is a local claim on one OOM-prone box. #107 is what converts posture into evidence. |

---

## 9. Confidence

- **HIGH** — everything cited with `file:line` or a query result: B1, B3, B4 (mechanism), B5, §3.1
  governance, §3.2 indexes and schedule accumulation, §2 X1/X2/X3/X5, the NEW-C1 short-page
  confirmation, the keyset-safety refutation, ranks 1/2/4/5/6.
- **MEDIUM** — B2 being *unintended* rather than accepted design (needs a product call); the
  70%-of-PRD figure (a judgement about mobile's share of scope, not a measurement); the effort
  estimates.
- **LOW / Unable to verify** — whether AutoPlant/mysql2 can produce a silent short page (the
  remaining half of NEW-C1); anything requiring the VPN; whether the full test suite passes today
  (I ran `tsc --noEmit` clean but did not run the suites — the docs' own OOM warning makes an
  unattended full run unreliable, and a partial run would be weaker evidence than none).

---

*Read-only audit. No code changed. No issue files created — triage owns that. The temporary probe
script used for the DB measurements was deleted; all queries were `SELECT`-only.*
