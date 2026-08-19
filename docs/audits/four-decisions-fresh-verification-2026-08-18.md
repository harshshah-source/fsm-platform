# Four Decisions — Fresh Architecture & Implementation-Readiness Verification

**Analysis only. No code, migration, schema, issue, slice, production data, or AutoPlant change was made.**

| | |
|---|---|
| **Date** | 2026-08-18 (second pass, same day) |
| **Decisions** | 1 Non-blocking preview · 2 No vehicle-location rule · 3 Special Ticket (3, configurable) · 4 Return-date priority (Option C) |
| **Method** | Independent re-trace of `apps/backend/src`, `apps/mobile/src`, `apps/admin/src`, Prisma schema + migrations, and live FSM Postgres (`fsm` @ 5433). Prior audits (`four-decisions-readiness-2026-08-18.md` and its three companions) were treated as claims to be tested, not as sources. |
| **Result of the re-test** | Most prior claims held. **Nine were wrong or materially incomplete** (§2), and **twelve previously unreported latent defects** were found that intersect the four decisions (§3). |

---

## 1. Core answer

> ## YES, WITH CHANGES
>
> The four decisions are mutually coherent. Decisions 1, 2 and 4 are implementable on existing
> primitives. Decision 3 remains blocked by the same two facts the prior report found — nothing
> automatically re-assigns an unworked ticket, and no delivery-to-mobile signal exists — **both
> re-confirmed independently here**, with corrected numbers and three new complications
> (closure-cron timezone, the auto-recovery `removed_at` collision, and a third recycle path that
> already exists for components). Eleven questions require operator decision before slicing (§12).

---

## 2. Corrections to the prior reports

Each of these was re-derived from source this session. Line numbers at commit `0b72976`.

| # | Prior claim | What the code/data actually says |
|---|---|---|
| C1 | `assignPlants` bypasses `notDeferredOn` (readiness §12 Scenario C, analysis §13) | **Wrong.** `override.service.ts:350` spreads `notDeferredOn(istDate(now))` into the plant-scoped select, with a #146 comment explaining exactly why. The bypass list is: **`assignTicket`, `SPLIT_BATCH`, `REASSIGN` (`moveTickets`), and `SWAP_SE`**. `assignPlants` deliberately honours deferral — and then calls `assignTicket`, which wouldn't, an internal asymmetry. |
| C2 | `canonicalSort` "is mirrored as a SQL ORDER BY" and any new term must change in both places | **The mirror does not exist.** The recommender's live query has no `orderBy` at all (`recommender.service.ts:133-179`); ordering happens once, in TS, at `:216`. The docstring at `canonical-sort.ts:4-5` is stale/aspirational. The only SQL rank expressions in the repo are unrelated list sorts (`device.service.ts:104-122`, 4 keys; `ticket-query.service.ts:141,317`, 2 keys). Consequence: **Option C's new sort key is a TS-only change on the dispatch path** — the real obligation is to fix the stale docstring and not to *introduce* a divergent SQL copy. |
| C3 | "`removed_at` is only ever set by a human" (readiness §7.2) | **Wrong.** `AutoRecoveryService` stamps `removed_at` with `removed_by = NULL` when it closes a ticket (`auto-recovery.service.ts:303-306`, added as a bug fix so closed tickets stop rendering on the SE's app). **1,092 rows in the DB are system-removed, all on `CLOSED_AUTO_RECOVERY` tickets.** So `removed_by IS NULL` already means "auto-recovery", and a recycling sweep that also stamps `removed_by = NULL` would make recovery-removals and recycle-removals indistinguishable. A removal-cause field (or reason code) is required, not optional. |
| C4 | Post-submission closure goes through CSM verification review | **Wrong.** Verification is a fully automated GPS-ping worker (`verification.service.ts`, cron `business-verification` every 5 min): pass → ticket `CLOSED` + cycle `VERIFIED`; fraud or 24-h window expiry → `FAILED_VERIFICATION`, documented in-code as **IRREVERSIBLE** (`:175`) — there is **no path back to OPEN** and no approve/reject endpoint (`GET /verification/review` is a read). |
| C5 | Offline submissions "arrive late" via the mobile write queue (readiness Q6) | **The queue has zero production callers.** `writeQueue.ts` exists but nothing instantiates it; every mobile write is a bare `fetch`. An offline submit **throws and is lost**, and a user retry generates a **new** `clientSubmissionId` per attempt (`TroubleshootFormScreen.tsx:56`, pinned by its own test), so the backend idempotency key does not dedupe user-level retries. The false-Special risk is not "late arrival" — it is "the SE genuinely submitted and the server never heard it". |
| C6 | 7,590 stranded tickets would flood the queue when recycling turns on | **Overstated ~5×.** 7,590 live batch rows sit on PARTIAL schedules, but only **4,684** belong to still-OPEN tickets, and **3,327 of those are now below the 48-h dispatch threshold** (devices resumed reporting) — so roughly **1,350** would actually re-enter the dispatchable set today. Separately, **~2,900 live batch rows belong to closed/cancelled tickets** — a hygiene debt regardless of any decision. |
| C7 | `batch_assignment_tickets` = 15,092 rows; attempts = the 05:00 dispatch | **16,184 rows**, from **three writers**: the 05:00 batch run (`batch-assignment.service.ts:172`), `OverrideService.assignTicket` (`:311` — used by ZM same-day ADD, the Critical Queue one-click, **intraday accept**, and the Device-Detail manual assign; ~2,400 rows trace to `MANUAL_PLANT_ASSIGN` audits), and `moveTickets` (`:442`, REASSIGN/SPLIT_BATCH). Any attempt definition must state which writers count. |
| C8 | The recycle prerequisite has no precedent anywhere | **A partial precedent exists.** `ComponentRequestService` already returns a `WAITING_COMPONENT` ticket to `UNASSIGNED` when the component arrives (`component-request.service.ts:256`) — the platform already contains one system path that recycles an assigned ticket into the pool. |
| C9 | `RepeatEscalationService` has no cron ("scheduling deferred") | Its own doc comment is stale — `business-repeat-escalation` runs `*/15 * * * *` under `BUSINESS_SWEEPS_ENABLED` (`business-sweep-scheduler.service.ts:172`). ESCALATED does fire automatically when sweeps are on. |

Two prior data figures also refreshed: `soft_states` = 17 rows (9 VIEWED / 5 ON_SITE / 3 TROUBLESHOOT_STARTED); `troubleshooting_submissions`, `vehicle_unavailability_reports`, `device_tokens`, `tickets.deferred_until` all still 0.

---

## 3. Newly found latent defects intersecting the four decisions

Flagged, not fixed. None is a business question by itself, but several are prerequisites.

| # | Finding | Where | Why it matters here |
|---|---|---|---|
| D1 | **`ScheduleClosureScheduler`'s `@Cron` has no `timeZone`** (unlike dispatch), and its cron is env-only, not settings-driven. On a UTC host `0 4 * * *` fires at **09:30 IST — after the 05:00 dispatch**, inverting the "closure runs before dispatch" ordering the whole recycle design assumes. | `schedule-closure-scheduler.service.ts:91` vs `dispatch-scheduler.service.ts:63` | Q1's natural home (closure) is only correct if this is fixed first. |
| D2 | `plannerForDate` derives its day with **UTC** components, not `istDate` — between 00:00 and 05:29 IST it reads the previous day's planner rows. | `recommender.service.ts:590-591` | Any future-date preview that parameterises the planner must not copy this. |
| D3 | `clearFinalizedOrphans` is **zone-wide, not run-scoped** — a second concurrent invocation of the recommender deletes another run's SUGGESTED recommendations. | `recommender.service.ts:504-513` | A preview built by calling `runForZone` would destroy a live run's state. Hard argument for a true dry-run seam. |
| D4 | `runForZone` also **mutates `component_blocked_queue`** (`recordComponentBlock` / `resolveComponentBlock`) — a fourth write the "just skip the recommendation writes" framing misses. | `recommender.service.ts:365,372` | The dry-run seam must suppress these too. |
| D5 | Tickets whose device has **no `slaBucket` are silently dropped** from the run — not recommended, not counted as unassignable, not on the ledger. | `recommender.service.ts:197` | A recycled ticket whose state row went stale would vanish without trace. |
| D6 | `bulk-unassign`'s `deferredExcluded` count uses `deferredUntil >= targetDate` while the engine's eligibility is `deferredUntil <= day` — a ticket deferred **to today** is counted "excluded" while the recommender treats it as dispatchable. | `bulk-unassign.service.ts:445` vs `deferral.ts:25` | Off-by-one in an operator-facing count; return-date work multiplies the population it misleads on. |
| D7 | `se-ticket-access.ts:34` **hand-rolls a copy** of the deferral predicate instead of importing `notDeferredOn` — the exact #153 drift shape the deferral module exists to prevent. | `me-tickets/se-ticket-access.ts:34` | Any deferral semantics change must touch this copy too. |
| D8 | `CRITICAL_PLUS` exists **twice** — `cross-zone-escalation.service.ts:18` and `dashboard.service.ts:348-353`. | — | Option C's gate must reuse one, not add a third. |
| D9 | On `FAILED_VERIFICATION`, the cycle is left in `SUBMITTED` with `hasOpenFailureCycle` still true (finalize updates the cycle only on `CLOSED`). The device can then **never open a new failure cycle**, and its terminal ticket is invisible to everything. | `verification.service.ts:304-323` | A failed-verification device silently exits the entire Special/return-date universe. |
| D10 | `resumeSla` does **not check `slaPauseReason`** — resuming a VU report on a `WAITING_COMPONENT`-paused cycle clears the component pause. Mirror-image of `fileReport`'s `!cycle.slaPaused` guard. | `vehicle-unavailability.service.ts:195` | Both holes need a reason predicate before any SLA automation stacks on top (Q5). |
| D11 | `confirmDate` (ZM edits `expectedFrom`) writes **no audit row, no history** — unlike every other governed write in the codebase. Nothing prevents **multiple OPEN reports per ticket** either (`fileReport` always creates; `resumeSla` resolves exactly one). | `vehicle-unavailability.service.ts:178-184` | If `expectedFrom` starts driving scheduling, an unaudited edit becomes a scheduling action, and "which report's date wins" is a live correctness question (Q7). |
| D12 | The VU schema comment and migration header **claim "the Ticket resurfaces at the expected-availability date"** — behaviour that was never built. | `schema.prisma:2254-2255`, `migrations/20260624220000.../migration.sql:2` | Decision 4 either implements the claim or the comment must be corrected; today it misleads every reader of the data model. |

Also re-confirmed as intentionally latent (Decision 2 context): `vehicleReadiness: 'UNKNOWN'` hardcoded at `recommender.service.ts:283` makes `VEHICLE_ON_TRIP` unreachable — and `expectedComponentsAvailable: true` at `:287` makes `COMPONENT_UNAVAILABLE` unreachable too. Two dead filters, not one.

---

## 4. Decision 1 — Non-blocking preview (re-verified)

### 4.1 Already supported / partially supported / requires new design

**Already supported**
- Manual run (`POST /api/schedules/dispatch-run`, roles OH/CSM), in-flight report, per-zone `pg_try_advisory_xact_lock`, `SUGGESTED → DISPATCHED` consumption, `batch_assignment_tickets_one_active_per_ticket` partial unique, run ledger with `config_snapshot`, per-ticket decision traces, post-run transparency UI.
- Hold primitive: `tickets.deferred_until` + `notDeferredOn()` (inclusive: eligible when `deferredUntil <= day`), spread from one definition into 8 call sites — recommender (×3), shared pool, intraday, cross-zone, me-tickets, and `assignPlants`. Writers: exactly two (`override.service.ts:203` sets; `batch-assignment.service.ts:182` clears on dispatch). 0 rows today.
- The stale-preview pattern: `BulkUnassignService` HMAC-SHA256 token (`JWT_ACCESS_SECRET`), 10-min TTL, `countsByZone` snapshot, `TOKEN_STALE` → fresh preview, admin page, audit-backed history. All verified line-exact.
- Holds coexist safely with the 05:00 run: holds write `tickets`, the run locks scheduling tables; no shared lock, no ordering dependency. Admin inaction ⇒ run proceeds unchanged — Decision 1's core property holds.

**Partially supported**
- Preview **content**: the recommender can produce the projection, but more than three reads are `now`-bound: deferral/planner day, `committedDayLoad`, `currentStatusMany` (not `currentStatus`), **plus** `modeForZone(now)` (DEFICIT vs PREVENTIVE — decides whether installs appear at all), `resolveActiveOverrides(now)` (tier overrides), and the PREVENTIVE age-score term. All are parameterisable.
- **One thing is not parameterisable at all**: `device_states.slaBucket` / `inactivity_hours` are materialised as-of the last recompute. Canonical-sort key #2 *is* that column, and no as-of-date variant exists. A preview for D+1 ranks on today's buckets while claiming to show tomorrow. This is acceptable for a preview **only if stated on the page** — it is the honest limit of the design, not a bug to engineer away.

**Requires new design**
- A true `DRY_RUN` seam on `runForZone`. "Skip the writes" must cover **four** mutations: recommendations, traces, `clearFinalizedOrphans` (zone-wide delete — D3), and the component-blocked queue (D4). It must also not reserve the in-process in-flight guard, not take the advisory lock, and not create a `dispatch_runs` row (the trigger enum has no PREVIEW value).
- The `now` parameter is **not** a preview lever: `runForActiveZones(now)` with a future date creates *real* future-dated schedules and flips tickets `FORMALLY_ASSIGNED`. Only the controller's hardcoded `new Date()` prevents this today. A preview needs a separate `targetDate` distinct from wall-clock `now`.
- Pre-run **changes** beyond a hold still have nothing to attach to — every `OverrideService` action operates on a batch that does not exist until dispatch. Holds-only, pre-assignment table, or planner rows: operator's call (Q11).
- The token helpers are module-private in `bulk-unassign.service.ts` — extraction into a shared module is part of the work, not an afterthought.

### 4.2 Specific answers

| Question | Answer |
|---|---|
| Future-date preview via the actual recommender? | Yes, after the dry-run seam + target-date parameters; bucket/inactivity stay as-of-now (state that on the page) |
| Non-mutating? | Achievable; four mutations to suppress, two guards/locks to avoid |
| Admin holds before the run? | Yes — `deferred_until`, existing predicate, zero coordination |
| Admin changes before the run? | Holds only, today. Anything richer needs new persistence (Q11) |
| 05:00 runs if admin does nothing? | Yes, unchanged — verified no shared lock or dependency |
| Manual run coexistence? | Safe — same path, `trigger=MANUAL`, advisory lock + consumption + partial unique |
| Stale preview? | Solved pattern (`TOKEN_STALE` → fresh preview); bind to a snapshot, refuse to execute on a stale one |
| Reuse existing mechanisms? | Yes — bulk-unassign is the template for the flow, `deferred_until` for holds |

---

## 5. Decision 2 — No vehicle-location rule (re-verified)

**Zero implementation work. The scheduler already operates with no location input.**

Complete geospatial inventory of the backend, re-swept this session:

1. `resolveOnsiteSource()` — the only live raw-PostGIS query (`soft-state.service.ts:253-268`, 200 m `ST_DWithin`). Requires `p.location IS NOT NULL`; `plants.location` is NULL for all 933 rows, so `onsiteSource` is always `MANUAL`. Provenance label, not a scheduling decision.
2. `plant_eligible_floating_se` MV — has an `ST_Contains` branch that can never match (NULL locations). Nuance the prior reports missed: the MV **is read on the recommender hot path** (`candidate-selection.service.ts:41-50`) for the FLOATING leg — but with 0 floating SEs and 0 territory rows, the geometry branch is inert. If floating coverage is ever populated with polygons, geometry quietly enters candidate selection; worth remembering, not acting on.
3. Non-PostGIS lat/lon: verification's haversine fraud check, submission GPS anchor, VU report GPS (write-only), ingestion telemetry (display-only). None touches dispatch.
4. Dead filters: `VEHICLE_ON_TRIP` (unreachable; describes the SE's van, not the tracked truck) and `COMPONENT_UNAVAILABLE` (also unreachable — `expectedComponentsAvailable` hardcoded `true`).

No presence table, no presence service, no position columns on `device_states`, `raw_device_snapshots.lat/lon` read by nothing downstream. **Decision 2 is honoured by doing nothing.** Optional hygiene (not required by the decision): annotate the two dead filters as intentionally inert; correct the VU schema comment (D12).

---

## 6. Decision 3 — Special Ticket (deep re-investigation)

### 6.A What proves the ticket reached the SE's mobile? — Nothing, still

Re-traced independently; the prior conclusion stands, with sharper edges:

- `GET /me/tickets` and `GET /me/tickets/:id` are pure reads; no ack, receipt, or sync endpoint exists anywhere (no `POST /api/sync/batch` — that is unbuilt Issue 17). No API access log; `audit_logs` records mutations only. No delivered-at/read-receipt columns anywhere in the schema.
- The day-plan notification is schedule-level **by explicit design** (`day-plan-notifier.ts:51-54`: a day plan "isn't a single ticket entity to tap-route into"). `notification_deliveries.SENT` is a seam whose gateway **always returns UNAVAILABLE** (`assertNotificationSeamInert` enforces that no real adapter exists). `device_tokens`: 0 rows.
- The one per-ticket signal: **`soft_states.VIEWED`, auto-posted** by `TicketDetailScreen.tsx:96-118` when the detail screen reaches ready state (TROUBLESHOOT-only, skipped past ON_SITE). Two caveats found this pass: the post's failure is **swallowed with no retry** (`catch {}` — a VIEWED that 404s/500s leaves no trace), and `assertInScope` requires `status = OPEN` + plant coverage, so soft states cannot be posted on a ticket that left OPEN.
- **Double limbo re-confirmed and sharpened**: `getMyTickets` and `se-ticket-access` both scope through `liveScheduleFilter()` (ACTIVE | OVERRIDDEN). A batch-assigned TROUBLESHOOT ticket on a closed schedule vanishes from the SE's list **and 404s on detail** — while staying `FORMALLY_ASSIGNED` and invisible to the recommender. (RECOVERY/INSTALL survive via `assignedSeId`; TROUBLESHOOT batch assignment never sets it.)
- **The platform's only genuine per-ticket offer/response/timeout ledger is intraday**: `intraday_insertions` records `offeredSeId`, `offeredAt`, `acceptanceDeadline`, `respondedAt`, and a `retryChain` of `TIMED_OUT`/`DECLINED` entries; its offer notification carries `entityType:'ticket'` so `in_app_read_at` is a real per-ticket read receipt — for CRITICAL/HIGH_CRITICAL intraday offers only. This is the existing in-repo model for what a delivery receipt looks like if one is ever built (Q2 option c).

### 6.B / 6.C Attempt started / success — confirmed with one correction

- **Started**: `soft_states.VIEWED` (earliest, automatic). `ON_SITE` = attended, self-declared, never geofence-verified (D9 in §3 of the prior report holds: always `MANUAL`). Chain `VIEWED → ON_SITE → TROUBLESHOOT_STARTED` enforced by the service; note the DB uniqueness is per **(ticket, se, type)**, so the one-active-per-SE invariant is service-level only.
- **Success**: `troubleshooting_submissions` (idempotent on `(se_id, client_submission_id)`), ticket `OPEN → VERIFICATION_PENDING`, cycle → `SUBMITTED` — **except the component-unavailable branch**, where a submission row EXISTS but the ticket **stays OPEN** (self-transition event `COMPONENT_REQUESTED`, cycle → `WAITING_COMPONENT`). So "a submission row exists" is the right *negative* gate for Special ("the SE diagnosed it") but is **not** the same event as "ticket progressed".
- Downstream, "successfully reached a troubleshooting outcome" in the fullest sense = ticket `CLOSED` via automated GPS verification (C4). `FAILED_VERIFICATION` is terminal and irreversible, and strands the cycle (D9).

### 6.D The ten cases — re-tested

| # | Case | Evidence signature (verified) | Counts toward threshold? |
|---|---|---|---|
| 1 | Assigned, never opened | Batch row; no `soft_states` at all. Indistinguishable from "never delivered" (and from "VIEWED post silently failed") | **Business — Q2** |
| 2 | Opened, never on site | `VIEWED` (→`VIEWED_TIMEOUT` after 90 min); no `ON_SITE` | **Business — Q2/Q4** |
| 3 | On site, vehicle unavailable | `ON_SITE` + VU report row (+ primary SLA paused unless already paused) | **Business — Q5.3** |
| 4 | On site, component unavailable | Submission row **exists** (`componentUnavailable`), cycle `WAITING_COMPONENT`; ticket stays OPEN; later `COMPONENT_RESUBMIT`. Note: the component path **already recycles** — ticket returns to `UNASSIGNED` on arrival (C8) | **NO — code-determined** (SE diagnosed it) |
| 5 | Started, never submitted | `TROUBLESHOOT_STARTED` active, no submission, stale-work warning at 2 h | **Business — Q2/Q4** |
| 6 | Submitted successfully | Submission + `VERIFICATION_PENDING` | **NO — code-determined** |
| 7 | Submitted, sync failed | **Corrected (C5):** no offline queue is live; the submit throws and is lost; a retry mints a new `clientSubmissionId`. The hazard is a genuine visit with *no server record at all* | **Business — Q6 (reframed)** |
| 8 | Admin removes/reassigns | `removed_at` + `removed_by` set (human) | **NO — strong precedent** (`ScheduleClosureScheduler`: withdrawals are not unfinished work) — ratify in Q4 |
| 9 | Manually deferred | `DEFER_TICKET` three-write | **NO — same precedent** — Q4 |
| 10 | Closed automatically | Two distinct paths, both verified: auto-recovery (`CLOSED_AUTO_RECOVERY`, batch row system-removed) and **departure/plant-deactivation cancellation** (`CLOSED`, cycle `FAILED`, batch row **left live**) | **NO — code-determined** (not OPEN ⇒ not Special) |

### 6.E The prerequisite — automatic reassignment (re-verified, refined)

Current behaviour re-confirmed: closure flips `work_schedules.status` and nothing else; the recommender reads `UNASSIGNED` only; a dispatched-and-unworked ticket is stranded permanently. Max assignments ever: **2** (all double-assignments trace to 20 human `BULK_UNASSIGN_ZONE` operations). `attempts >= 3` matches zero tickets until recycling exists.

The exact change required (unchanged in shape) — at day-plan closure, per unresolved live batch row: stamp `removed_at`, return the ticket to `UNASSIGNED`, record the attempt outcome. Refinements from this pass:

1. **Fix D1 first** — the closure cron's missing timezone means the 04:00→05:00 ordering the design assumes is not guaranteed in deployment.
2. **`removed_by = NULL` is taken** (auto-recovery, C3). Recycling needs its own discriminator — the natural shape is a removal-reason column on `batch_assignment_tickets` (values like `ZM_WITHDRAWN` / `ZM_DEFERRED` / `AUTO_RECOVERY` / `PLAN_EXPIRED`), which also cleans up the existing three-way ambiguity.
3. **The flood is ~1,350, not 7,590** (C6) — and the ~2,900 live rows on closed tickets are a separate one-off hygiene fix.
4. `committedDayLoad` counts live schedules only — stamping `removed_at` at closure does not disturb capacity accounting (re-verified).
5. The lock-window warning in the closure file is real; writes must be set-based, not per-ticket fan-out.

### 6.F Threshold configuration — pattern confirmed, now with a richer precedent

`assignment-threshold.ts` (#238, at HEAD) is the exemplar and is **stronger than the prior report described**: named key + option ladder + pure parser with typed rejections + `coerceStored` fallback + per-run read, **plus** co-ownership as data (`SETTING_WRITE_ROLES` = OH + CSM), OH-only lock/unlock/revert, an append-only `setting_changes` history table carrying the replaced value, and a controller-registration-order pin. A `special_ticket_attempt_threshold` key should copy this wholesale. Ladder minimum **2** (0 = everything Special; 1 = Special on first failure ≈ the whole stranded backlog on day one). Derived-vs-stored decides retroactivity (Q8).

### 6.G Status vs attribute — verdict unchanged, consumers re-verified

`SPECIAL` cannot be a `TicketStatus` value (breaks the recommender's `status:'OPEN'` selector, `RESOLVED_TICKET_STATUSES`, shared pool, `isTicketReadableBySe`, mobile `workStateFor`, auto-recovery matching). Not `assignmentState` (binary, positional), not `workType`, and never `failure_cycles.repeat_failure` (REPEAT = fixed-then-broke, per-device 3-in-7 escalation — near-opposite semantics; note `REPEAT` is a **cycle state only**, the ticket stays OPEN with a `repeat_failure` boolean, and `TicketStatus.SUBMITTED` is a dead enum value nothing writes). Derived view vs stored attribute: Q8.

### 6.H Attempt-count semantics — what is missing, restated precisely

```text
attempt          := one batch_assignment_tickets row     (16,184 rows; 3 writers — which count? Q4)
attempt_reached  := a soft_states row within the window  (only if the SE opened it; post can silently fail)
attempt_success  := a troubleshooting_submissions row    (reliable; exists even when component-blocked)
attempt_failed   := reached ∧ ¬success ∧ status OPEN     (negation only; nothing positively records failure)
attempt_ended_at := still nothing                        (closure doesn't touch the ticket; recycling would create this boundary)
```

Missing, as before: a delivery receipt (Q2), an attempt boundary object, a positive failure record. Query-cost note re-verified: `batch_assignment_tickets` has `(batch_id)` and the partial unique on `(ticket_id) WHERE removed_at IS NULL` — a full per-ticket attempt count cannot use either; a plain `(ticket_id)` index is required for either representation.

---

## 7. Decision 4 — Return date (re-verified)

### 7.1 Today — confirmed, with three sharpened facts

`fileReport()` does exactly: report row → primary-SLA pause (guarded `!cycle.slaPaused` — will not re-pause; a `WAITING_COMPONENT` cycle keeps the component reason) → `lastStateChangedAt` (only when a failure cycle exists). No `deferredUntil`, no `assignmentState`, no batch write. `expectedFrom` has **zero scheduling readers** — the `@@index([status, expectedFrom])` serves no query. Resume is manual (`resumeSla`, ZM zone-clamped / CSM / OH) and is the only writer of report `RESOLVED`.

Sharpened this pass:
- **`confirmDate` exists** (ZM/CSM/OH edit of `expectedFrom`) — writes one column, no audit, no history (D11).
- **Mobile presets cap the date at ~tomorrow 2 PM** (`In 2 hours / In 4 hours / Tomorrow 9 AM / Tomorrow 2 PM`); the API accepts any parseable date with no bound. The SE cannot currently express "back next week" at all — the Decision 4 flow as drawn assumes date flexibility the form does not yet offer.
- **Granularity mismatch (new)**: `expectedFrom` is a timestamp; `deferredUntil` is a DATE compared inclusively against the IST day-start. Mapping "In 2 hours" → `deferredUntil = today` is a **same-day no-op** — the ticket is immediately eligible again. Sub-day returns need a defined mapping (Q6-new, folded into Q7 below as Q7b).

### 7.2 The wiring — unchanged, one write-shape already proven

`OverrideService.deferTicket` demonstrates the three writes (`deferredToDate` + `removed_at`/`removed_by` on the batch row; `UNASSIGNED` + `deferredUntil` on the ticket; batch/schedule flagged `OVERRIDDEN`). `notDeferredOn` is inclusive on the return date; re-entry needs **no new job** — though `TierOverrideExpiryService` (`status ACTIVE ∧ expiresAt <= now` → flip + audit) is the in-repo precedent if a date sweep is ever preferred, and its own doc states why predicate-at-read beats sweep when readers can predicate on the date.

### 7.3 Option C priority — safe shape confirmed, implementation simpler than reported

Verified order: Tier ↓ → Bucket ↓ → **[new: returnDueToday ↓, only when both below CRITICAL+]** → Rank ↑ → Oldest ↑ → DeviceId ↑. Because bucket compares first, CRITICAL+ always outranks the flag — exactly Option C. `sla_bucket` untouched (it feeds Fleet Uptime, Soft Inactive grading, SLA reports).

Corrections that simplify: **no SQL mirror exists to keep in sync** (C2) — the comparator is the single live sort on the dispatch path; the change is TS-only plus fixing the stale docstring. Reuse `CRITICAL_PLUS` from cross-zone (and note the second copy in dashboard, D8 — don't add a third). `returnDueToday` must be computable, not a stored flag; whether it derives from `deferred_until = today` or from the OPEN VU report is Q7.

Also relevant: while a vehicle is away the device keeps aging, so a long-deferred ticket often re-enters already CRITICAL+ — the 2b key then never fires, which is correct under Option C.

### 7.4 Edge cases — deltas from the prior table only

| Case | Delta |
|---|---|
| Return today | Confirmed eligible same day (inclusive predicate); if 05:00 passed, waits for tomorrow or a manual run |
| Return date changed | Now worse than reported: `confirmDate` is unaudited, multiple OPEN reports can coexist, and nothing reconciles them (D11) → Q7 |
| Returns early | Confirmed undetectable (Decision 2); human pull-forward exists **today** via `assignTicket`, which ignores deferral — the escape hatch is already built (Q11 decides whether it stays) |
| Returns late | Confirmed self-correcting loop (new report, new date) — this loop is what feeds Special |
| Never returns | Unbounded (server accepts any date; no deferral-count cap). Mobile presets bound it accidentally today; that is UI, not policy → Q10 |
| Special + return today | Structurally compatible (attribute vs date) — precedence only matters if Special ever gains priority (Q9) |
| Special + CRITICAL+ | Option C holds by construction (bucket compares first) |

### 7.5 SLA — confirmed; two new holes feed Q5

Pause on file (primary only, guarded); secondary structurally unpausable (derived from `openedAt`, manager-only by type omission); resume manual-only; report `OPEN` forever if nobody acts; **nothing date-driven** touches SLA. New: D10 (resume ignores pause reason) and the false schema comment (D12). The recommender never reads `slaPaused`, so an auto-returned ticket is dispatchable with a frozen primary clock — unchanged, still Q5.

---

## 8. Interactions (preview × return date × Special) — re-run with corrected mechanics

**A. Special, return tomorrow, admin does nothing, 05:00 runs.** `deferredUntil = tomorrow` excludes it today (recommender, shared pool, me-tickets access all through the one predicate — plus the hand-rolled copy, D7). Tomorrow it enters with the Option C rank. Coherent.

**B. Special, return today, admin holds it.** The hold overwrites the return date on the shared `deferred_until` column; the VU report still says today. **Confirmed, and this is the strongest argument for deriving `returnDueToday` from the report rather than the column** (Q7). Note bulk-unassign's `deferredExcluded` would also miscount this ticket (D6).

**C. Special, return today, admin manually reassigns.** Corrected: `assignTicket` (single-ticket, Critical Queue, intraday accept, Device-Detail assign) bypasses deferral; **`assignPlants` does not** (C1); `SPLIT_BATCH`/`REASSIGN`/`SWAP_SE` bypass. The bypass also skips `canonicalSort`, so Option C priority is moot on manual paths. Whether the bypass is policy or accident: Q11.

---

## 9. End-to-end simulation (Day 0 → Day 6)

Identical to the prior report's table with three corrections: (i) each 04:00 closure step requires D1 fixed and the recycle stamping a **distinct removal reason** (not bare `removed_by NULL`, which auto-recovery owns); (ii) on D4 the SE can only choose return presets up to "tomorrow 2 PM" — a return date of D5 is expressible, D7 would not be; (iii) at D5 the ticket's own bucket has kept escalating, so it may sort as CRITICAL+ regardless of the return flag. Open ends unchanged: SLA resume (Q5), VU-attempt counting (Q5.3), loop bound (Q10).

---

## 10. Contradiction check — consolidated

Standing (all re-verified): the two Decision-3 blockers (no recycle; no delivery signal); `deferred_until` serving two masters; manual-override bypass (corrected scope, C1); VU pause with no auto-resume; stranded tickets in double limbo; Special vs REPEAT/ESCALATED vocabulary (avoidable); SPECIAL-as-status breaks ≥6 consumers (avoidable); `fileReport` won't re-pause / `resumeSla` won't check reason (paired holes); threshold 0/1 destructive (preventable by ladder).

Resolved by this pass: comparator/SQL divergence (no SQL mirror exists — C2); offline-late-arrival (no queue in use — C5; replaced by the lost-submission hazard); `assignPlants` bypass (never existed — C1).

New: closure-cron timezone (D1); `removed_by` collision (C3); cancellation paths leaving live batch rows (C6/hygiene); `FAILED_VERIFICATION` stranded cycles (D9); unaudited `confirmDate` + report multiplicity (D11); granularity mismatch on sub-day returns (§7.1).

**No unavoidable contradiction between the four decisions.** Every conflict is either an operator question (§12) or avoidable by construction.

---

## 11. Performance / integrity

Unchanged from the prior report where re-checked, with additions: attempt counting needs a `(ticket_id)` index (partial unique doesn't serve historical counts); a single writer for attempt outcomes (derive from the ledger and this is free); recycle stamping must be idempotent (second stamp = no-op — the partial unique already enforces one live row); the dry-run path must not touch the advisory lock, the in-flight guard, `dispatch_runs`, or the component-blocked queue; D5 (bucket-less tickets silently dropped) becomes more likely under recycling and should at least be counted.

---

## 12. Questions requiring operator approval

Eleven questions. **Q1 and Q2 are hard blockers for Decision 3**; the rest block slicing detail. Recommendations are labelled as recommendations.

**Q1 — Automatic recycle at day-plan closure?** Options: (a) in `ScheduleClosureScheduler` under the existing per-zone lock; (b) a separate sweep; (c) either, but only for tickets with no field activity (no soft_states); (d) don't — accept Special never fires. *Recommendation: (a) with (c)'s guard, set-based writes, after fixing D1 and adding a removal-reason discriminator.* Blocks all of Decision 3.

**Q2 — What counts as "reached the SE mobile workflow"?** (a) `VIEWED` = reached (excludes never-opened, and undercounts when the post silently fails); (b) dispatch = reached (the assumption the operator explicitly rejected); (c) build a real per-ticket delivery receipt (the intraday offer ledger is the in-repo model); (d) count both dispatched and reached separately, threshold on one. *Recommendation: (d) now, (c) later.* Blocks the attempt definition.

**Q3 — Release policy for the stranded backlog when recycling lands?** ~4,700 OPEN stranded (~1,350 currently dispatchable), plus ~2,900 live rows on closed tickets (hygiene, decide-once). (a) all at once; (b) N per zone per day; (c) forward-only; (d) one-off remediation first. *Recommendation: (d) for the closed-ticket rows regardless; then (b) or (c).*

**Q4 — Which assignment events and removals count as attempts?** Three creators (05:00 batch; `assignTicket` incl. intraday/critical/manual; `moveTickets`); removals: ZM withdraw, ZM defer, auto-recovery, future plan-expiry. Precedent says withdrawals ≠ unfinished work. *Recommendation: count system dispatches + intraday accepts; exclude human withdrawals/defers and auto-recovery removals.*

**Q5 — SLA + report lifecycle on the return date.** (1) auto-resume primary on re-entry? (2) auto-resolve the report, or supersede-only? (3) do VU-terminated attempts count toward Special? (4) new absence = new report + new attempt? Also fix D10 (reason-check) either way. *Recommendation: resume on re-entry; resolve on supersession or submission, never on a date nobody observed; yes, VU attempts count (it is how a never-returning vehicle surfaces); yes.*

**Q6 — Lost-submission protection (reframed).** No offline queue exists; a failed submit is lost and a retry mints a new idempotency key. (a) lazy/derived Special evaluation (late or re-sent submissions self-correct the classification); (b) grace period; (c) accept. *Recommendation: (a) — free if Q8 chooses derived; separately flag the mobile retry-key behaviour as its own defect.*

**Q7 — Which date wins, and what does `returnDueToday` derive from?** SE re-file vs ZM `confirmDate` (unaudited, D11) vs admin hold on the shared column (Scenario B). (a) latest report wins; (b) ZM outranks; (c) earliest; (d) derive return-due from the **report**, keep `deferred_until` for holds. **Q7b:** sub-day returns ("In 2/4 hours") — same-day eligible (no-op defer) or round up to tomorrow? *Recommendation: (a)+(d); for Q7b, same-day = no defer at all (the ticket simply stays eligible), presets ≥ tomorrow defer.*

**Q8 — Special: derived view or stored attribute?** *Recommendation: derived (identification is the stated purpose; retroactive on threshold change; immune to drift and to Q6), with the `(ticket_id)` index; move to stored only if Q9 gives Special a scheduling effect.*

**Q9 — Does Special affect priority, or identification only?** *Recommendation: identification only, for now.*

**Q10 — Bounds.** Server accepts any `expectedFrom`; nothing caps consecutive VU deferrals; mobile presets bound it only by accident. (a) horizon cap; (b) max consecutive deferrals → escalation; (c) both; (d) rely on Special. *Recommendation: (c).*

**Q11 — Manual-override bypass + preview change scope.** Corrected bypass list: `assignTicket`, `SPLIT_BATCH`, `REASSIGN`, `SWAP_SE` ignore deferral; `assignPlants` honours it. (a) keep as ZM authority; (b) block; (c) allow with explicit `confirm` + reason (the pattern already exists on override commands). Preview changes: (i) holds only; (ii) + pre-assignment table; (iii) + planner rows. *Recommendation: (c) and (i) — and make the four bypass paths consistent with each other whichever way is chosen.*

---

*Analysis only. No application code, database schema, migration, issue, slice, production data, or AutoPlant data was modified. Verified against commit `0b72976` and the live dev database on 2026-08-18.*
