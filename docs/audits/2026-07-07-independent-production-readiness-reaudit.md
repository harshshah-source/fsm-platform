# FSM Platform — Independent Production-Readiness Re-Audit

**Date:** 2026-07-07
**Scope:** Full platform at the current working tree of `feat/autoplant-integration` (including the
~138-file uncommitted layer — audited as it would ship). Backend (NestJS / Prisma 7 / Postgres 16 +
PostGIS / read-only AutoPlant MySQL), admin frontend (React + Vite), Prisma schema + all 44+
migrations, docs/ADRs, issue backlog.
**Method:** Independent re-verification — the 2026-07-03 audit was treated as *claims to test*, not
truth. Every prior finding was re-checked against current code with file:line evidence; fresh sweeps
ran over the post-audit code (R3/R4 ingestion rewrites, scheduler, master-sync), auth/API surface,
schema/migrations, and the admin frontend (which the previous audit did not cover).
**Prior audit:** `2026-07-03-backend-production-readiness-audit.md`. Hardening backlog filed from it
earlier today: issues **98–107**. This re-audit adds **108–111**.

---

## Verdict

The four days since the previous audit materially changed the picture: **the ingestion half of the
core loop is now real and self-running** (live AutoPlant reader, in-process cron scheduler,
stale-run reaper, real daily partitioning + retention, set-based recompute maintained at ingest).
The R3/R4/#97 code is careful, well-commented, and passed this audit's fresh sweep with only an
observability nit. What has *not* changed: the write-side concurrency posture (racy
read-check-update across ~15 state machines, non-transactional dispatch), the dev-scaffolding auth
layer, and the absent ops surface. And three gaps the previous audit under-weighted or missed are
now the sharpest edges: **the business sweeps still never run unattended** (an SE offer literally
cannot time out without an admin pressing a button every 10 minutes), **the admin app logs every
user out after 15 minutes** (refresh token discarded), and **there is no deployment artifact of any
kind** in the repo.

---

## Part 1 — Previously reported issues now FIXED (verified in code)

| Prior finding | Status | Evidence |
|---|---|---|
| #1 (partial): no scheduler; stub source reader; in-request drain; cursor never resumed | **RESOLVED for ingestion** | `integration-scheduler.service.ts` — telemetry (30-min) + masters (daily) `@Cron`, env-gated, overlap-safe (`skipOnOverlap` converts the 409 to a skip). `SOURCE_READER` binds the real `AutoPlantSourceReader` when configured (`ingestion.module.ts:128-140`). The cursor complaint is **superseded by design**: the reader deliberately full-scans `tb_vehiclemaster` by immutable `device_id` keyset each run (latest-state table; correctness must not depend on a persisted watermark — documented at `autoplant-source-reader.ts:8-30`); `ON CONFLICT DO NOTHING` makes re-reads free. |
| #4: crash mid-ingestion permanently wedges all future runs | **RESOLVED** | Two independent fixes: `SnapshotRunService.reapStaleRuns` (30-min stale threshold, called inside `startRun`, mirrored in `MasterSyncRunService`; shared policy in `stale-run.ts`) + the worker now catches mid-scan read errors and always finalizes (`snapshot-ingestion.worker.ts:64-134`, PARTIAL/FAILED with an asymmetric display-vs-resume cursor). |
| #6: DEFAULT-only partition; O(fleet) sequential recompute | **RESOLVED (core)** | Migration `20260706130000` converts DEFAULT into real per-UTC-day partitions (drains held rows, keeps an empty DEFAULT as safety net); `PartitionMaintenanceService` does daily create-ahead(3d)+retention with settings-driven window and a strict DDL-name allowlist. Recompute is now two set-based statements (`device-state.service.ts:45-86`) with `latest_gps_datetime` maintained **at ingest** via a deduped `unnest … ON CONFLICT GREATEST` upsert (`snapshot-ingestion.service.ts:95-102`) that skips unmastered devices via INNER JOIN (no FK violations, counted for visibility). Residual: retention for the *other* append-only tables → **#104**. |
| Medium: AutoPlant MySQL pool had no timeouts | **RESOLVED** | `autoplant-mysql.client.ts` — `connectTimeout`, per-statement timeout budget (`Promise.race` fail-fast wrapper), `connectionLimit: 4` (#97 Slice A4). |
| #2's recommender-duplication leg (concurrent runs) | **PARTIALLY MITIGATED** | Master/snapshot runs now have reapers + advisory locks; but the dispatch leg of #2 is fully intact — see Part 2. |

Also verified as **fine** (fresh sweep, no finding): zero injectable SQL (all dynamic fragments are
allowlisted/regex-guarded — partition DDL included), no XSS vectors in the admin app (no
`innerHTML`), customer-confirmation tokens are `randomUUID` one-time + expiring, notification
service properly awaits its chain, strict TS with no floating promises found, money as
`Decimal(12,2)`, `pgi_history`/`non_operational_markings` carry exactly the indexes the new
recompute's EXISTS subqueries need.

## Part 2 — Previously reported issues STILL OPEN (re-verified at working tree)

All are owned by the backlog filed earlier today; none were found to be stale:

| Finding | Re-verified evidence (2026-07-07) | Owner |
|---|---|---|
| #2 dispatch non-transactional, non-idempotent, recommendations never consumed | `batch-assignment.service.ts:40-118` — bare sequential creates, zero `$transaction`, no code flips `SUGGESTED` | **#100** |
| #3 racy read→check→update across ~15 state machines; zero concurrency tests | no `transitionOrConflict` anywhere; idiom intact in troubleshoot/auto-recovery/non-op/intraday/verification/component-request | **#101** |
| #5 residual: fallback JWT secret, no env validation | `token.service.ts:18` `?? 'dev-access-secret-change-me'`; `main.ts` bare `void bootstrap()` | **#98** |
| #7 no health/shutdown/exception-filter/structured logs | only `/api/integration/health` exists; no `enableShutdownHooks` | **#98** |
| #8 in-memory users + refresh tokens (leak confirmed: `consume` marks revoked but never deletes; expired entries never pruned — unbounded Map) | `user-store.ts`, `refresh-token-store.ts` | **#91** |
| #9 install lifecycle no zone scope | `install-lifecycle.service.ts:206-216` `load`/`getInstallView` findUnique with no zone predicate | **#102** |
| #10 opt-in guards, no validation pipe, no body limits | `app.module.ts:152` guards as plain providers; `app.config.ts` prefix+CORS only | **#99** |
| #11/#12 missing partial uniques + hot-FK indexes | schema at working tree: no unique on `work_schedules(seId,dateFrom)` (plain `@@index` only), no `tickets(device_id)`/`(vehicle_id)` index | **#100/#101/#103** |
| #13 module facade / cross-module re-provision | all 44 controllers in `AppModule`; `recommender.module` still re-provides foreign services | **#105** |
| Mediums: `criticalQueue` unbounded (re-verified — no LIMIT, `dashboard.service.ts:229-262`), Postgres pool all-defaults (`prisma.service.ts:13-15`), per-poll dashboard scans, notification outbox, no CI | | **#106/#107/#76** |

## Part 3 — NEWLY discovered production issues (this re-audit)

| # | Finding | Impact one-liner |
|---|---|---|
| **108** | **Business sweeps never run unattended.** The #97 scheduler covers ingestion only; `sweepTimeouts` (the 10-min intraday contract), `runSweep` (verification), `sweepAutoEscalations`, `runInstallVerification`, repeat-escalation, soft-inactive snapshots, and every report recompute are HTTP-POST-only — cross-zone auto-escalation currently fires from an **admin-page button**. | Offers never time out; verifications never resolve; PRE_VERIFICATION stock never settles; Platinum breaches never escalate — unless a human drives each loop on a timer. |
| **109** | **Admin session lifecycle is broken.** `AuthProvider` discards the refresh token (grep: zero frontend references); access tokens live 15 min; no 401 interception; reload drops the session even with a valid stored token; `apiLogin` maps backend-down to "invalid credentials". | Every real user is silently logged out mid-shift every 15 minutes into dead error states; F5 = logout. Dashboard unusable for an ops shift. |
| **110** | **Zero rate limiting** on `/auth/login` (scrypt per guess = CPU-DoS amplifier), `/auth/refresh`, and the public `/api/non-op/confirm`. | Unbounded credential stuffing + cheap CPU exhaustion on the API process. |
| **111** (HITL) | **No deployment story**: no Dockerfile/compose/manifest, no enumerated prod config, no rollback convention for forward-only migrations, no backup/restore drill, no DR statement. | Production bring-up and every incident are improvisation. |

Plus one improvement folded into an existing issue rather than duplicated: **#104** gains a
DEFAULT-partition watchdog AC (maintenance is env-gated OFF; if disabled or down past the 3-day
create-ahead runway, telemetry silently re-accumulates in the DEFAULT partition — the exact
condition R3 ended — with nothing reporting it).

**Explicitly examined, deliberately not filed:** scheduler cron expressions resolve env at decorator
evaluation (restart-to-change — documented in code, acceptable); `lastResumeCursor` is now
test-harness-only after the reader redesign (dead-ish code, cosmetic); `useAsyncAction` re-entry
between click and render (buttons bind `loading`, negligible); tickets-list computed ORDER BY +
OFFSET pagination (real but low-impact at v1 scale — noted for #106's perf pass); acting-half ticket
creation remains **flagged-not-filed** (needs-info: eligibility decision, review B7).

## Part 4 — Production-readiness score

| Dimension | 07-03 | Now | Movement |
|---|---|---|---|
| Architecture | 6/10 | **6.5/10** | Scheduler layer exists (ingestion); module facade + no central transition owner unchanged. |
| Scalability | 4/10 | **6/10** | Real partitioning + retention + set-based recompute + ingest-maintained watermark — the two compounding ceilings are gone. Dashboards/dispatch still per-request/round-trip bound. |
| Performance | 5/10 | **5.5/10** | Recompute fixed; criticalQueue/pool/dashboard cache open; still no load test. |
| Security | 5/10 | **4.5/10** | Nothing regressed, but the frontend review widened the surface: forgeable-secret risk + in-memory auth + no rate limiting + install cross-zone hole all still live. |
| Reliability | 3/10 | **5/10** | Reaper + read-error finalization + fail-fast MySQL + overlap-safe ticks landed. Still: no health/shutdown/env validation (#98), business sweeps manual (#108). |
| Maintainability | 7/10 | **7/10** | Unchanged; new ingestion code keeps the comment/idiom discipline. |
| Testability | 7/10 | **7/10** | Suite grew with #97 slices; still zero concurrency tests, no CI. |
| **Production readiness** | **2/10** | **4/10** | Data now flows unattended end-to-end on a configured runtime — but nobody real can log in (#91), stay logged in (#109), or be paged when it breaks (#98), and the acting loops are hand-cranked (#108). |

## Part 5 — Release blockers (must land before any production deployment)

Ranked; "→" = the owning issue.

1. **#91 — Postgres-backed auth.** Real users cannot log in at all; refresh state is process-local.
2. **#109 — Session lifecycle.** Even the users who can log in are logged out every 15 minutes.
3. **#108 — Business-sweep scheduler.** The SE/manager loop does not self-run; SLA-critical timeouts depend on button presses.
4. **#98 — Boot/ops hardening.** Fallback JWT secret (forgeable admin tokens if env is missed), no health probe, no graceful shutdown — every other failure becomes invisible or corrupting.
5. **#100 + #101 — Dispatch transactionality + guarded transitions.** The concurrency premise of the product (multiple ZMs/SEs, mobile retries) corrupts state today; constraints get more expensive with every row of real data.
6. **#99 — Global guard + validation.** One forgotten decorator ships a world-readable route; garbage bodies are raw 500s.
7. **#102 — Install cross-zone escalation.** Concretely exploitable privilege hole.
8. **#111 — Deployment packaging/runbook.** There is no defined way to put any of the above into production or roll it back.

#110 (rate limiting), #103/#104 (indexes/retention), #105–#107 are pre-beta hardening rather than
absolute blockers — with the note that #103/#104's constraints are only cheap while tables are empty.

---

*Issues 98–111 in `.scratch/fsm-platform-v1/issues/`; INDEX.md "Production readiness" section is the
live tracker. Evidence limits: concurrency findings verified from code + isolation semantics (no
load harness exists); the uncommitted working-tree layer was audited as-is and its commit hygiene is
a known caveat (see memory note / branch state).*
