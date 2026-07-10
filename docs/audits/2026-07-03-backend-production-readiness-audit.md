# FSM Backend — Production Readiness Audit

> ⚠️ **PARTIALLY SUPERSEDED (marked 2026-07-10 by the SYSTEM-STATE audit).** Findings #1
> (scheduler), #4 (reaper), #6 (recompute/partitioning) and the MySQL timeouts are RESOLVED by
> the #97/R3/R4 work. The remaining findings live as issues #98–#107 (+#108–#111 from the
> 2026-07-07 re-audit). Consult the re-audit + `docs/SYSTEM-STATE-2026-07.md` §5, not this file.

**Date:** 2026-07-03
**Branch audited:** `feat/autoplant-integration`
**Scope:** `apps/backend` — NestJS modular monolith, Prisma 7 / Postgres 16 + PostGIS, read-only MySQL source (AutoPlant). ~17,700 non-generated lines, 44 controllers, ~40 services, 1,972-line schema, 40 migrations, 201 test files / 1,036 tests.
**Method:** Six independent review passes (architecture, correctness/concurrency, database, security, reliability/performance, testing/quality). Every finding verified in code with file:line evidence; cross-pass duplicates merged. Claims that could not be proven from code are marked as such.

---

## One-paragraph verdict

The domain modeling, DB-invariant discipline, and test depth are genuinely strong — better than typical for mid-build. But the platform currently **cannot run its own core loop** (device-state recompute and ticket creation have no callers; there is no scheduler of any kind; the production source reader is an empty stub), the **write-side concurrency posture is systematically wrong** (one racy read-check-update idiom repeated across ~15 services, including the dispatch spine, verification, inventory, and the SE-accept flow), and the **auth/ops layer is dev scaffolding** (5 hardcoded in-memory users, fallback JWT secret, no health check, no graceful shutdown, no structured logging). None of these are "unfinished features" — they are load-bearing gaps in the direction the finished system needs.

---

## CRITICAL FINDINGS

### 1. The core business loop is unwired, and there is no scheduler anywhere
- **Category:** Architecture / background processing
- **Location:** `src/device-state/device-state.service.ts:27`, `src/ticketing/ticket-creation.service.ts:27`, `src/ingestion/ingestion.module.ts:28`, `package.json`
- **Evidence:** `DeviceStateService.recompute` and `TicketCreationService.createForInactiveEligible` are registered but **called by no controller and no worker** (grep-verified). The only `setTimeout` in the repo is a retry backoff (`snapshot-ingestion.worker.ts:29`); no `@nestjs/schedule`, BullMQ, or Redis exists. `SOURCE_READER` is bound to `new InMemorySourceReader([])` — `POST /snapshots/run` reads 0 rows and reports SUCCESS. Every periodic behavior (verification sweep, 10-min intraday timeouts, aggregations) exists only as an Operations-Head POST, and `POST /snapshots/run` executes the **entire multi-chunk drain synchronously inside the HTTP request** (`snapshots.controller.ts:48-54`).
- **Why it matters:** Deployed today, device states never update, SLA clocks never move, tickets never open, offers never time out — while every endpoint reports healthy. At target scale the in-request drain exceeds any LB timeout; with N instances, HTTP-triggered sweeps have no leader election and become duplicate-execution vectors (see #3).
- **Fix:** Introduce the planned job runner (BullMQ; `@nestjs/schedule` as an interim), wire recompute + ticket creation into the post-ingestion chain, convert `/snapshots/run` to 202-enqueue, and resume from the persisted cursor — `finishRun` stores it (`snapshot-run.service.ts:54-62`) but `run()` always restarts from `null` (`snapshot-ingestion.worker.ts:57`), so every run re-reads full source history.
- **Timing:** **Before next feature.** This is the product.

### 2. Batch dispatch (Recommender → Day Plan) is non-idempotent, non-transactional, and never consumes recommendations
- **Category:** Correctness / transactions
- **Location:** `src/scheduling/batch-assignment.service.ts:40-118`, `src/recommender/recommender.service.ts:76-241`
- **Evidence:** `dispatchForZone` reads `recommendation.findMany({ status: 'SUGGESTED' })` and **no code in the repo ever updates a recommendation's status** (grep: zero matches). The dispatch loop is bare sequential creates + `ticket.update` with **zero `$transaction`**. Schema has no backstop: no unique on `recommendations(ticketId)`, `work_schedules(seId, dateFrom)`, or `batch_assignment_tickets(batchId, ticketId)`.
- **Failure scenarios (verified):** double-invoke (retry, double-click, second instance) re-dispatches the same SUGGESTED set → duplicate ACTIVE WorkSchedules, then an unhandled P2002 500 **mid-loop** with no rollback; crash between batch-ticket create and ticket update leaves a ticket in an active batch but UNASSIGNED → recommender re-suggests it → next dispatch crashes again; concurrent recommender runs can suggest one ticket to **two different SEs**.
- **Fix:** Per-zone/per-SE `$transaction` that flips recommendations to a consumed status; partial uniques `recommendations(ticket_id) WHERE status='SUGGESTED'`, `work_schedules(se_id, date_from) WHERE status='ACTIVE'`; advisory lock like `SnapshotRunService` already does.
- **Timing:** **Before next feature** — the uniques are free now, a data-repair migration later.

### 3. One systemic write idiom makes ~15 state machines racy: read → check in JS → `update` by id
The single largest correctness class. All transactions run at READ COMMITTED; no `update` on a state machine carries a state guard in its WHERE. Concrete confirmed instances:

| Race | Location | Outcome |
|---|---|---|
| SE submit vs auto-recovery (the documented 409) | `troubleshoot-submission.service.ts:112-116,207-210` + `auto-recovery.service.ts:100-104` | Submission silently orphaned; PRE_VERIFICATION inventory rows **stuck forever**; or a closed ticket overwritten back to VERIFICATION_PENDING |
| Two SEs submit same ticket | same | Both pass the OPEN check; loser never routed to shadow-use; both decrement stock |
| Non-op dual confirmation | `non-operational.service.ts:236-256,338-367` | Customer's stale write **erases** the manager's confirmation leg; marking never reaches CONFIRMED |
| Intraday accept vs timeout reroute | `intraday-insertion.service.ts:124-162,362-408` | Ticket committed to timed-out SE A while SE B holds a live offer; B's accept then returns OK **with A's schedule** — both SEs told the CRITICAL ticket is theirs |
| Overlapping verification sweeps | `verification.service.ts:248-302` | FAILED-path rollback **double-restores van stock** (both sweeps read PRE_VERIFICATION pre-commit) |
| ZM `markAutoRecovery` | `verification.service.ts:114-143` | Never resolves PRE_VERIFICATION inventory → permanently stuck ledger rows |
| `confirmResubmit` re-opens closed cycles | `component-request.service.ts:225-263` | Forces a VERIFIED cycle back to OPEN with `closedAt` set — corrupts the episode even sequentially |
| Van-stock decrement | `troubleshoot-submission.service.ts:313-321` | JS `Math.max(0, qty - n)` from a stale read: lost updates and silently swallowed over-consumption |
| Shadow-use conflict path | `troubleshoot-submission.service.ts:265-303` | `clientSubmissionId` never persisted on the CONFLICT path → mobile retry **double-decrements stock** |

- **Why it matters:** Multiple ZMs/SEs acting concurrently is the product's stated premise; mobile retries are the norm. The correct pattern (guarded `updateMany` + count check, partial unique + P2002-as-outcome) already exists in this repo — soft-states, failure-cycle I1, snapshot runs — it just wasn't applied to these paths. Compounding: **zero concurrency tests exist** (no `Promise.all` in any of 201 test files), so none of this can regress-fail.
- **Fix:** One shared `transitionOrConflict(tx, model, id, fromStates, data)` helper adopted site-by-site; flip inventory rows with guarded `updateMany` before restocking; persist the idempotency key on the conflict path; `qty: { decrement }` + `CHECK (qty >= 0)`.
- **Timing:** **Before beta** (the intraday/verification ones before any second instance or cron).

### 4. A crash mid-ingestion permanently wedges all future runs
- **Category:** Reliability
- **Location:** `snapshot-ingestion.worker.ts:50-105`, `snapshot-run.service.ts:26-44`
- **Evidence:** The in-flight guard is the partial unique `snapshot_runs_one_in_flight WHERE status='RUNNING'`. `run()` has no try/finally; `readChunk` sits outside the retry envelope; the advisory lock is transaction-scoped and dies with the crash, but the RUNNING row survives. **No reaper exists anywhere** — the book8 test harness even hand-deletes RUNNING rows to unwedge itself, which is evidence the failure mode is real.
- **Risk:** First deploy/OOM mid-run → every subsequent run 409s forever; the entire telemetry pipeline halts silently (no health check or alerting to notice, see #7).
- **Fix:** try/catch/finally finalizing FAILED; startup + startRun-time stale-RUNNING expiry; heartbeat column per chunk.
- **Timing:** **Before beta.**

### 5. Forgeable admin tokens via fallback JWT secret; zero boot-time env validation
- **Category:** Security
- **Location:** `src/auth/token.service.ts:18`, `src/main.ts:6-12`
- **Evidence:** `process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me'` — a repo-published constant. No config validation anywhere: `DATABASE_URL` passes unchecked into the adapter; a missed env var silently signs every token with the public default → anyone forges `{role:'OPERATIONS_HEAD'}`.
- **Fix:** Fail-fast boot validation (throw if unset/short, always in production); validate `DATABASE_URL`.
- **Timing:** **Before beta.** (The crypto itself is fine — HMAC recomputed regardless of header `alg`, `timingSafeEqual`, scrypt passwords.)

### 6. Telemetry partitioning exists in name only; the core recompute is O(fleet) sequential round trips
- **Category:** Database / scalability
- **Location:** migration `20260619153000:61-66`, `device-state.service.ts:40-96`
- **Evidence:** `raw_device_snapshots` is `PARTITION BY RANGE` with **only a DEFAULT partition**, no partition-maintenance job, no retention for any append-only table (raw snapshots, `audit_logs`, `ticket_events`, notifications, recommendations — grep confirms only summary-rebuild DELETEs exist). `recompute` then does an unbounded `groupBy` over the entire telemetry table, loads **every device into memory**, and issues **one `upsert` per device** — 50k sequential round trips today, non-viable at 300k. Same shape in `fleet-uptime-aggregation.service.ts:51-119` and N+1 in `ticket-creation.service.ts:48-105` (a 20k-device mass-outage morning ≈ 100k sequential queries).
- **Why it matters:** Converting DEFAULT-partition data into real partitions requires ACCESS EXCLUSIVE + manual row movement — **the cost grows with every ingested day**. Recompute duration outgrowing its cadence means stale SLA buckets: the product's core signal.
- **Fix:** Partition-maintenance job (pg_partman or cron) + retention matrix now, while the table is small; rewrite recompute as one set-based `INSERT … SELECT DISTINCT ON … ON CONFLICT DO UPDATE` (or maintain `latest_gps_datetime` incrementally from the ingested chunk); the repo already contains the correct pattern (`system-efficiency-aggregation` does transactional `DELETE` + `INSERT … SELECT`).
- **Timing:** Partition job **before beta**; recompute rewrite while wiring it (#1).

---

## HIGH FINDINGS

**7. No operational visibility, no graceful shutdown.** No `/health`, no metrics, no global exception filter, no request logging or correlation IDs; the `AuditLog` schema comment references "Pino logs" but pino isn't installed. `main.ts` never calls `enableShutdownHooks()` → `onModuleDestroy` (Prisma disconnect, MySQL pool end) **never fires on SIGTERM**; `void bootstrap()` leaves boot failures as unhandled rejections. A wedged run (#4) or dead DB is invisible. *(main.ts:6-12; app.module.ts:150; package.json)* — **Before beta.**

**8. Auth state is process-local: 5 hardcoded users, in-memory refresh tokens with a leak, no logout.** `InMemoryUserStore` (`user-store.ts:20-48`, all password `'correct-password'`) is the **only** login path — real users in the `users` table cannot log in. `InMemoryRefreshTokenStore` never deletes consumed/expired records (unbounded Map growth), breaks on restart, and makes a second instance impossible. No revoke endpoint exists. Well-documented as temporary (Issue #91), but it is the single hard blocker to HA and to any real multi-user use. *(refresh-token-store.ts:19-38)* — **Before beta.**

**9. Install lifecycle has no zone scoping — horizontal privilege escalation.** `scheduleInstall`/`markOnSite`/`markFitted`/`getInstallView` check role or assigned-SE only; `load` is `findUnique` by ticketId with no zone predicate. A zone-1 ZM can schedule SEs onto and read install tickets in zone 2; any SE can read any install ticket's serials. Contrast: create/CSV paths *do* pass scope, and dashboard/reports/verification services clamp ZM zone correctly — the transitions dropped it. *(install-lifecycle.service.ts:84-90,93,107,206-216; install.controller.ts:166,206-208)* — **Before beta.**

**10. Auth is opt-in per controller; validation is absent framework-wide.** No `APP_GUARD` — 43 of 44 controllers remember `@UseGuards`; the next one that forgets ships world-readable, and no test sweeps the route map. No `ValidationPipe`/zod anywhere: bodies are compile-time interfaces; `BigInt(body.zoneId)` on garbage throws raw 500s (`cross-zone.controller.ts:49-50`); no body-size limits for the CSV upload path. Mass assignment is currently avoided **by discipline only** (field-by-field whitelisting was verified — no `...body` spreads into Prisma). *(app.module.ts:150; app.config.ts:8-14)* — **Before beta.**

**11. Missing DB constraints behind "at most one live X" assumptions.** No partial uniques for one-SUGGESTED-recommendation-per-ticket, one-ACTIVE-schedule-per-SE-day (`ensureSchedule` is findFirst-then-create — two ZMs racing → two ACTIVE day plans, `override.service.ts:389-404`), or one-live-intraday-offer-per-ticket (dedupe is a query-time `none` check, `intraday-insertion.service.ts:104`). Where partial uniques *do* exist, P2002 sometimes surfaces as 500 instead of the graceful outcome (`assignTicket`, duplicate-submission race — `vouchers.service.ts:157-160`). — **Before beta** (constraints are cheap only while tables are empty).

**12. Missing indexes on hot FKs.** No index on `tickets.device_id` (device-detail drawer, per-device history, FK checks) or `tickets.vehicle_id`; `audit_logs` has no index serving the ZM-performance monthly query (`actor_role, created_at` — the existing composite leads with `acted_as_role`, NULL for native actions). Audit log is the fastest-growing table after telemetry (one row per mutation, in-transaction) with no partition/retention plan. *(schema.prisma Ticket indexes ~1713-1719; zm-performance-aggregation.service.ts:66-71)* — Indexes **before beta**; retention **before production**.

**13. Module system is a facade.** All 44 controllers registered in `AppModule` ("so the guard chain resolves"); feature modules re-provide each other's **service classes** (`recommender.module.ts:18` provides `InventoryService`, `SeAvailabilityService`, `SoftInactiveCountService`; `engineers.module.ts:15` provides `InventoryService`) creating **separate instances per injector**; `recommender.service.ts:71-73` even `new`s cross-module services as constructor defaults. Works today because services are stateless; the first service that adds caching or `OnModuleInit` state forks silently. *(app.module.ts:104-149)* — **Before next feature** (cost grows with every module added on this pattern).

---

## MEDIUM FINDINGS (condensed)

- **Ticket lifecycle logic scattered:** 23 `ticketEvent.create` sites across 12 files, no central transition map — nothing prevents CLOSED → ON_SITE except each service's local checks; `fromState` written from possibly-stale reads. Fix rides along with the #3 helper.
- **Notification delivery is synchronous, in-process, at-most-once.** `notifyOne` awaits the channel chain inline in request/sweep paths; state-mutating tx commits, then `notify()` — a crash between loses it. Harmless while the gateway is a logging stub; must become a transactional outbox **with** the first real FCM/WhatsApp adapter, not after. *(notification.service.ts:132-175)*
- **Connection pooling all defaults:** no pool sizing/timeouts on Postgres (`prisma.service.ts:13-15`), no `statement_timeout`; AutoPlant MySQL pool has no `connectTimeout`/query timeout over a VPN — a black-holed tunnel hangs the run rather than failing the chunk. *(autoplant-mysql.client.ts:75-86)* — Before the real SourceReader wires in.
- **Dashboard scans per request; `criticalQueue` has no LIMIT.** Rollups re-run 2–4 aggregate scans of `device_states` per poll per manager (matview/cache explicitly deferred in a comment); a bad week with 10k CRITICAL tickets serializes 10k rows per request. The LIMIT is a one-liner — do it now. *(dashboard.service.ts:126-262)*
- **Further guarded-update gaps (same family as #3, lower blast radius):** component-request approve/reject double-processing (`component-request.service.ts:308-335`); leave approve = two separate commits (`leave-request.service.ts:79-105` — REJECTED request can coexist with a live ON_LEAVE window); voucher review/markPaid; recovery/install `transition()` guards are pre-reads only; SLA pause-accumulator read-modify-write; repeat-escalation can overwrite a just-closed cycle; non-op confirm sets `closedAt` but leaves cycle state active → device permanently P2002-skipped if it re-enters the fleet (`non-operational.service.ts:421-426`).
- **Tunables hardcoded despite a Settings system:** 24h/7d windows, activation windows, overdue thresholds are module constants; `SettingsService` is consumed by exactly one service, while the Settings UI implies tunability. *(verification.service.ts:15, ticket-creation.service.ts:11, etc.)*
- **Testing gaps:** zero concurrency tests; **no CI** (no `.github`), no coverage config; shared long-lived dev DB with hand-ordered 15-line `afterAll` teardowns; migration test only checks `SELECT 1`. Ticket list uses un-indexable computed ORDER BY + OFFSET; offset pagination elsewhere. Twelve near-identical `{role, zoneId}` scope interfaces with per-service zone-filter reimplementation. `reports.service.ts` at 702 lines is the one genuine god-file (trivially splittable).

---

## Overall 

| Dimension | Score | Justification |
|---|---|---|
| **Architecture** | **6/10** | Thin controllers, real ports-and-adapters seams, pure domain kernels, correct build order (read models, summary cubes, invariant-first schema). Held back by: no scheduler/orchestration layer for a background-processing product, module facade (#13), no central state-transition owner, notification flow not durable. |
| **Scalability** | **4/10** | The schema is built to scale (partition-ready, BigInt PKs, denormalized hot rows, summary cubes) but the code isn't yet: O(fleet) sequential upsert loops in the three core batch paths, DEFAULT-only partition, no cache/matview on dashboards, no retention anywhere. All fixable, several get more expensive weekly (#6). |
| **Performance** | **5/10** | Hot *read* paths are genuinely healthy — parameterized SQL, capped LIMITs, matched indexes, reports served from pre-aggregated cubes. Hot *write*/batch paths are round-trip bound (#6). Unproven under any load test. |
| **Security** | **5/10** | Fundamentals unusually good for hand-rolled: scrypt + timing-safe compare, HMAC verification immune to alg-confusion, zero injectable SQL call sites, server-side ZM zone clamps, no secrets in logs. Dragged down by: fallback signing secret, in-memory auth store, opt-in guards, one real cross-zone bypass (#9), no validation layer, no rate limiting. |
| **Maintainability** | **7/10** | Clean, uniform, commented-with-why, ~zero TODO debt, discriminated-union outcomes, one true god-file. Main tax: the racy transition idiom copy-pasted ~15× and 12 duplicate scope types — both fixable with one helper each. |
| **Reliability** | **3/10** | No health probe, no metrics, no structured logs, no graceful shutdown, no env validation, a known permanent-wedge failure mode (#4), best-effort notifications, in-memory session state. This is the weakest dimension and it's almost all absent-infrastructure rather than wrong code. |
| **Testability** | **7/10** | 1,036 tests against real Postgres with deep row-level assertions, injected clocks (zero sleeps), a production-seam data harness — rare at this stage. Missing exactly the tests this audit needed: concurrency, route-guard sweep, fresh-DB migration; and no CI to run any of it. |
| **Production readiness** | **2/10** | Deployed today: nobody real can log in, no data flows (stub reader + unwired pipeline + no scheduler), and the first crash mid-run silently halts ingestion forever. Not close — but the distance is mostly wiring and hardening, not redesign. |

---

## Top 10 Highest-Risk Issues (ranked)

1. **Core loop unwired + no scheduler + stub source reader** — the product does not function (#1)
2. **Systemic unguarded state transitions** — double-assignment to SEs, double stock restore, erased confirmations, orphaned submissions (#3)
3. **Dispatch pipeline non-idempotent/non-transactional, recommendations never consumed** (#2)
4. **In-memory auth + fallback JWT secret** — forgeable admin tokens, HA-blocking, real users can't log in (#5, #8)
5. **Stuck-RUNNING ingestion deadlock with no reaper and no monitoring to notice** (#4, #7)
6. **DEFAULT-partition telemetry + O(fleet) recompute** — the two compounding scale ceilings, cost growing daily (#6)
7. **Inventory idempotency: shadow-use double-decrement on retry, stock floor masking, stuck PRE_VERIFICATION rows** (#3)
8. **No validation layer + opt-in guards** — every future endpoint inherits the risk (#10)
9. **Install-lifecycle cross-zone escalation** — concrete, exploitable today (#9)
10. **Zero ops surface: no health/metrics/logs/shutdown** — every other failure above becomes invisible (#7)

---

## Technical Debt That Compounds

Ordered by how fast postponement raises the price:

1. **Partition conversion + retention** — grows per ingested day.
2. **Missing partial uniques** — free now, data-repair migration after real data exists.
3. **Validation retrofit and APP_GUARD** — grows per endpoint (~44 already).
4. **HTTP-POST-as-scheduler contract baked into the admin FE** — breaking change later across every trigger.
5. **Module-wiring convention** — every new module copies it.
6. **Concurrency-test + CI absence** — every fix in #3 lands unverifiable without them.
7. **Post-launch index additions requiring `CONCURRENTLY`** outside Prisma's migration transaction — adopt the convention before there's production data.

---

## Things Done Well (verified, genuinely strong)

- **DB-enforced invariants as the concurrency backstop**: partial uniques for one-active-failure-cycle-per-device, one-active-batch-per-ticket, one-in-flight-run, one-active-verification-run, soft-state uniqueness — with P2002 handled as the designed race-loser path in the best sites. This is the template the rest of the code should copy.
- **`AuditService.withAudit`** — mutation + audit row in one transaction at 40+ call sites; no unaudited-mutation window. Rarely done this well.
- **Ports-and-adapters seams** (SourceReader, notification gateway, soft-state-conflict port) proven by the book8 harness driving unmodified production code.
- **Idempotent ingestion writes**: `createMany skipDuplicates` on `(device_id, gps_datetime)`; advisory lock + durable unique for run start.
- **Zero injectable SQL** across heavy raw-SQL usage; enum allow-lists and regex guards on every dynamic fragment.
- **Test discipline**: real-DB integration depth, injected clocks everywhere, no sleeps.
- **Paying the `device_id` TEXT migration early** (leading-zero IMEIs) — exactly the right time.

---

## Recommended Next Steps (in order)

1. **One refactor pass on write safety**: `transitionOrConflict` helper + the three missing partial uniques + P2002→outcome mapping. Kills issue #3 and half the mediums; cheapest-per-risk item in the audit. Add the first concurrency tests (`Promise.all` double-submit/double-dispatch) alongside.
2. **Wire the core loop**: scheduler (interim `@nestjs/schedule` is fine), connect recompute + ticket creation post-ingestion, cursor resume, 202-async run trigger, stuck-run reaper — and make dispatch transactional + consuming (#2) as part of the same slice.
3. **Boot + ops hardening**: fail-fast env validation (JWT secret, DATABASE_URL), `enableShutdownHooks`, global exception filter + pino, `/health`. Small, unblocks everything else being observable.
4. **Auth to Postgres** (users + refresh tokens, logout/revoke), global `APP_GUARD` with `@Public()` opt-out, fix the install-lifecycle zone scope.
5. **Global validation pipe** + body limits + CSV row caps.
6. **Scale pass**: set-based rewrites of recompute / fleet-uptime / ticket-creation, partition-maintenance + retention matrix, the `tickets.device_id` and `audit_logs` indexes, pool sizing + timeouts (both DBs), dashboard cache + `criticalQueue` LIMIT.
7. **CI with a disposable migrated-from-zero database** running the existing 1,036 tests + a route-guard sweep test.
8. **Transactional notification outbox** — landing together with the first real channel adapter, not after.

---

## Evidence limits

- Concurrency findings are verified from code and isolation semantics, not reproduced under live load (no concurrency tests or load harness exist to do so).
- The customer-confirmation token's entropy/expiry generation (`NonOperationalService`) was not traced to its source.
- Whether `JWT_ACCESS_SECRET` is set in the real deployment environment is unknowable from the repo — #5 is a latent risk, not a confirmed live exposure.
- `RecommenderService` re-run duplication assumes no external "recommend exactly once per day" operational convention; if one exists, #2's recommender leg drops from Critical to High (the dispatch leg stands regardless).
