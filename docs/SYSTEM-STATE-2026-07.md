# SYSTEM STATE — 2026-07-10

**Single source of truth for what the FSM platform actually is today**, reconciled against the
doc set. Code is truth; docs are claims. Every statement cites evidence (`file:line`, migration
name, test, commit). Inference is marked `[INFERRED]`; anything not directly verified is marked
`[UNVERIFIED]`. Written on branch `feat/autoplant-integration` at commit `eeb5601` (plus an
uncommitted working-tree layer of admin-UI polish + device/schedule read tweaks — see §1.5).

Section order is the resume order for future sessions.

> **2026-07-22 — the working tree is now clean (#144).** The dispatch-correctness layer that had been
> running the live cron while existing only as uncommitted files on one machine is committed:
> **#127** same-day APPEND + run-attribution moved down from `work_schedules` to
> `plant_batch_assignments`, **#138** floating-eligibility MV freshness, and the migration
> `20260721120000_batch_run_attribution` that had **already been applied to the live dev DB while
> untracked** — so the repository can now reproduce the running schema. Landed as four explicit-path
> commits (backend · SE-directory rework → #150 · dashboard/shell polish → #151 · docs), verified
> green beforehand (dispatch 14 files/47 tests, recommender 9 files/22 tests, tsc clean). The "plus an
> uncommitted working-tree layer" caveat above and in §1.5/§4 refers to earlier sessions and is
> historical; `git status` is clean as of this entry.
>
> **Known, tracked, and NOT fixed by #144:** the repo has **pre-existing schema drift across 22
> unrelated tables** (18 renamed indexes, 1 renamed FK, FK/default annotation differences) between the
> hand-written migration set and `schema.prisma`. `prisma migrate diff` against a fully migrated
> database is non-empty. This is cosmetic (naming conventions, not structure) but **#107's
> from-zero-migrate "no drift" acceptance criterion will trip on it** and must either absorb it or
> normalise it first. The #144 migration itself is drift-free — its table appears zero times in the
> report.

> **2026-07-22 (#153) — `OVERRIDDEN` is a LIVE work-schedule state, and now behaves like one.**
> Every ZM override flips the *schedule* to `OVERRIDDEN` (`override.service.ts:487-490`) purely to
> record provenance, but six read sites filtered `status: 'ACTIVE'` and so treated a ZM-adjusted plan
> as non-existent. Consequences, all real and all now closed: the SE's **entire day plan returned
> empty**, `committedDayLoad` **reset their committed load to 0** (so the next dispatch run could hand
> them a full second day of work on top of the invisible first), and #127's same-day APPEND created a
> **second schedule** for the same (SE, zone, day). Liveness now has exactly one definition —
> `LIVE_SCHEDULE_STATUSES` in `apps/backend/src/scheduling/schedule-status.ts`; `COMPLETED`/`PARTIAL`
> stay excluded, pinned by test. Commits `2532d36` (day plan + capacity) and `161a596` (dispatch +
> override lookups). Report: `docs/progress/153-overridden-schedule-is-live.md`.
>
> **Two things this exposed that are still open:**
>
> 1. **`work_schedules_one_active_per_se_zone_day` does not cover overridden schedules.** It is
>    **partial** on `status = 'ACTIVE'` (migration `20260708120000`), so the duplicate day-plan above
>    was created **unopposed** — no P2002, no rollback, no ledger skip reason. The code path is fixed,
>    but the invariant is currently enforced **only in application code**. → **#155** (needs a
>    duplicate probe before the index can be created; do not assume zero).
> 2. **The `status` column still conflates lifecycle with provenance.** #153 made that safe behind one
>    constant; it did not remove it. `lastOverriddenBy`/`lastOverriddenAt` already exist on the row.
>    → **#154** (needs an `OVERRIDDEN`-consumer sweep + a backfill decision; 5 admin surfaces and
>    `ticket-query.service.ts:147` read the enum value).
>
> **The local test suite is no longer a reliable green/red signal.** `fsm_test` is long-lived and
> `test/global-setup.ts` migrates + seeds but **never truncates**, so every spec that dies before its
> `afterAll` leaks fixtures permanently. Measured 2026-07-22: **780 orphan zones, 404 orphan
> engineers**. Three consecutive full backend runs on one commit gave three *different* non-green
> results (1 worker crash, then 3, then a `dispatch-run-controller` 5 s timeout) with **zero assertion
> failures** and every affected file passing in isolation — `dispatch-run-controller` iterates every
> zone, so its cost grows with the orphan count. The previous baseline ("287 files / 1176 passed /
> exit 0 / 494 s") therefore **no longer reproduces, and #153 is not the reason**. → **#156**.
> Treat any local "full suite green" claim from before that issue lands as unverified; CI (#107)
> provisions a fresh DB per run and is immune.
>
> **2026-08-19/20 update — two of the three causes above are closed; the signal is usable again, with
> one time-of-day caveat.** `test/global-setup.ts` **does** truncate now (`truncateTestDatabase`, #180
> R2), so the "never truncates / leaks fixtures permanently" sentence above no longer describes this
> repo — it is kept for the history it explains. The shared-fixture collision that made a red run need
> hand-triage is closed by **#255** (`test/fixtures/shared-auth-se.ts` — the shared auth SE's coverage
> is written MULTI_PLANT, so the `se_coverage_dedicated_se_key` partial unique cannot be raced). The
> **#184** Windows worker crash remains, but `scripts/run-tests.mjs` detects and retries it, and both
> runs below recovered every file. **Two full suites on one tree, 2026-08-19:** 388 files both times —
> 18:03 IST 1890 passed / 2 failed, 23:33 IST 1889 passed / 3 failed, **zero suite-level `beforeAll`
> failures in either**. The time-of-day failure those runs exposed — `plant-zone-change-impact`,
> whose fixture stated a **UTC** day against an **IST**-day read and so was red only from 00:00 to
> 05:30 IST — is closed by **#256**, with a 24-hour pin so it cannot drift back unnoticed.
> A third full run after that fix (05:25 IST, 388 files) came back **1892 passed / 2 failed / 5
> skipped in a single pass, no crash-retry** — the whole red surface being the one file below.
> **2026-08-20 later the same day — the list is now EMPTY.** #187+#215 landed together (the shared
> SE's `engineer_master` row is canonical seeded state in North — `test/global-setup.ts` →
> `seedSharedAuthSeEngineer`), and the first full run after them came back **390 files, 386 passed /
> 0 failed / 3 skipped (1898 tests, 0 failed)** — the first all-green full suite this repo has
> recorded. **The known-pre-existing failure list is empty: any red file on a local run is real**
> (after one #184 crash-retry, which `scripts/run-tests.mjs` performs and reports itself). The same
> session closed #257 — the `could not be applied … No Cron Job was found` ERROR that opened every
> app boot was #213's boot-apply failing on framework hook ordering, meaning a stored dispatch
> schedule did not survive a restart; `main.ts` now applies it after `listen()` — and #254, the last
> unpinned wall-clock cron (`plant-eligibility-refresh`, now 04:30 IST).

> **2026-08-13 — currency marker.** This document is current through **2026-08-13**. Reconciled this
> session: **§3l is new** (the #232 commissioning cohort / install-quality endpoints, which existed as
> uncommitted files with no issue, no INDEX line and no section here), and **§5's "`device_commissioning`
> is empty" note is superseded** — master sync 117 populated it with ~24,294 rows on 2026-08-10, so
> #223's coverage acceptance is measurable locally now and has simply not been measured. The three
> days of work behind #229/#230/#231 are committed (`b82c5af`), including a migration that had been
> **applied to both databases while its file was untracked**.
>
> **2026-08-09 — currency marker.** This document was current through **2026-08-09**. It had been
> current only through #218b (`9c00ad6`, 2026-08-07) and carried **zero** mentions of the fleet-health
> defects found since. Now reconciled: §2.2 records `device_states.first_reported_at` and the
> `device_commissioning` fact table, §5 opens with the #222/#223/#226/#227/#228 callout, and §6.1's
> #218 block is amended to separate *landed* from *exercised*.
>
> **2026-08-09 (later the same day) — the commissioning capture is FINISHED and COMMITTED.** The
> paragraph that stood here described it as parked with its migration applied-but-untracked; that state
> is gone. The writer exists (`MasterSyncService.appendCommissioning`), the migration file is tracked,
> and `git status` and `_prisma_migrations` agree again — the #144-shaped divergence is closed rather
> than carried. `HANDOFF-commissioning-capture.md` was consumed and is archived at
> `docs/archive/HANDOFF-commissioning-capture.md`. Both specs are green and, unlike before, are
> **typechecked**: `tsconfig.test.json` now covers `test/**`, which is what made the original fixture
> errors visible at all. See §2.2 for the two schema objects.
>
> **A five-minute status ledger across both recent sessions** — what is shipped vs committed-not-
> applied vs written-not-committed vs designed vs idea, the dependency graph, the decided/outstanding
> split, and a recommended build order — is `audit/STATUS.md`. That document is a point-in-time audit,
> not a second current-state doc; this file remains the only one (CLAUDE.md).

---

## 1. SYSTEM OVERVIEW

### 1.1 What the platform is

A GPS Field Service Management platform for a fleet-telematics fitment business: GPS devices are
fitted on customer vehicles at plants; when a device stops reporting, the platform detects it,
opens a ticket, recommends a Service Engineer (SE), dispatches a day plan, and tracks the field
loop (troubleshoot → GPS-verified fix → reports). Two user-facing products over one backend:

- **Admin Web Dashboard** — React 18 + TypeScript + Vite SPA (`apps/admin/`), role-variant UI for
  Zone Manager (ZM), CSM, Operations Head (OH), Warehouse Manager (WM).
- **SE Mobile App** — React Native + Expo (`apps/mobile/`) — **auth shell only** today: login /
  session / token store (14 files, `apps/mobile/src/auth/*`, `apps/mobile/app/index.tsx`).
  Issue #54 (Mobile Foundation) is not done; every M-series mobile surface is unbuilt.
- **Backend** — NestJS modular monolith (`apps/backend/`), Postgres 16 + PostGIS via Prisma 7,
  reading from the external **AutoPlant** MySQL system over VPN.

### 1.2 The funnel (one diagram)

```
AutoPlant MySQL (VPN, read-only)
  │  masters daily · telemetry every 30 min          [IntegrationSchedulerService — env-gated OFF]
  ▼
[a] Master sync  ─ ap_masters → companies/plants/vehicles/transporters (ACTIVE plants, DEPLOYED
  │                devices, zone-normalised via zone_mapping, else UNZONED)   master-sync.service.ts
  ▼
[b] Snapshot ingestion ─ keyset reader ≤90 rows/query → raw_device_snapshots (daily partitions)
  │                      run ledger + stale-run reaper            snapshot-ingestion.worker.ts
  ▼
[c] Device-state recompute ─ set-based upsert of device_states (inactivity hrs, SLA bucket,
  │                          eligibility)                          device-state.service.ts
  ▼
[d] Auto-recovery pre-check ─ device healthy now + ping evidence → close VERIFIED
  │                     [#229; LLD:615 order. Inert: needs INGESTION_SCHEDULER_ENABLED]
  ▼
[e] Ticket creation ─ inactive + eligible → OPEN ticket + failure_cycle   [NOT "0 today": dev runs
  │                                       eligibility_mode='all-deployed', 15,696 eligible — #229 §3.3]
  ▼
[f] Recommender ─ hard filters + scoring + canonical sort → recommendations (SUGGESTED)
  │                                                                 recommender.service.ts
  ▼
[g] Batch dispatch ─ SUGGESTED→DISPATCHED, work_schedules Day Plan (transactional, advisory-
  │                  locked, idempotent)  batch-assignment.service.ts · daily cron dispatch-
  │                  scheduler.service.ts               [BUSINESS_SWEEPS_ENABLED, default OFF]
  ▼
[h] Field loop ─ SE soft states · troubleshoot submission · intraday CRITICAL insertion ·
  │              ZM override/same-day · cross-zone escalation · install & recovery lifecycles ·
  │              inventory/van stock/component requests
  ▼
[i] Verification ─ first-valid-ping GPS sweeps → CLOSED / PARTIAL_RECOVERY / failed
  ▼
[j] Reports ─ monthly/daily aggregation cubes → fleet uptime, root cause, efficiency, ZM scorecard
```

**Funnel status (verified 2026-07-09, `INDEX.md:124-139`, spot-checked this session):** every stage
is code-complete and tested; activation is blocked by (1) empty `engineer_master`/`se_coverage`
data, (2) the B7 eligibility business decision (`pgi_history` empty) — **which gates the `pgi` mode
only; the dev DB runs `all-deployed` and creation is live, corrected 2026-08-10 per #229 §3.3** —
and (3) the ops switches in
§6.2 — of which **`BUSINESS_SWEEPS_ENABLED` is `"true"` in `apps/backend/.env:38` and its eleven crons
are running now**, while `INGESTION_SCHEDULER_ENABLED` (`:18`) and `PARTITION_MAINTENANCE_ENABLED`
(`:24`) are `"false"`. See §6.

> **Corrected 2026-07-22 (#149).** This paragraph previously read *"two **deliberately-OFF** ops
> switches … **Nothing runs unattended today**"* — describing **code defaults** in a sentence phrased
> as **deployed reality**. It was false, and it was the single most consequential operational claim in
> this document. (`:468` *"All three master switches **default** OFF"* is a claim about
> `business-sweep-scheduler.service.ts:27-36` and remains **accurate**; the `:770` blockquote is dated
> history and is correctly frozen. Neither was changed.)
>
> **Why it matters, not just that it is wrong:** the verification sweep fires every 5 minutes and
> expires its 24-hour window on **wall-clock**, while `INGESTION_SCHEDULER_ENABLED="false"` means
> nothing automatically writes the telemetry it reads. A troubleshoot submission made during an
> ingestion pause therefore ages into an **irreversible** `FAILED_VERIFICATION` — with its
> `PRE_VERIFICATION` inventory rolled back — regardless of whether the SE actually fixed the device.
> Exposure is 0 only because no SE has submitted a form yet: **armed, not safe.** Owned by
> [#148](../.scratch/fsm-platform-v1/issues/148-sweep-staleness-precondition.md).

### 1.3 Runtime topology

| Component | Reality | Evidence |
|---|---|---|
| Backend | Single NestJS process, port `PORT ?? 3000`, global prefix `/api`, CORS to `ADMIN_ORIGIN ?? http://localhost:5173` | `main.ts:9`, `app.config.ts:9-13` |
| Primary DB | Postgres 16 + PostGIS, Prisma 7 (`prisma@^7.8.0`), 55 migrations `20260617103804_init…` → `20260709120000_intraday_one_live_offer` | `apps/backend/prisma/migrations/` |
| External source | AutoPlant MySQL over VPN, `mysql2@^3.15.3`, lazy pool, unset env ⇒ empty/mock sources so dev/CI boots | `ingestion.module.ts` (`readAutoPlantMysqlConfig()===null` branches) |
| Cron | **In-process** `@nestjs/schedule@^4.1.2` only. Two scheduler homes: `IntegrationSchedulerService` (ingestion, owns `ScheduleModule.forRoot()` in `ingestion.module.ts`) and `BusinessSweepSchedulerModule`+`DispatchSchedulerService` (field-loop sweeps + daily dispatch) | `ingestion.module.ts`, `scheduling/business-sweep-scheduler.service.ts`, `scheduling/dispatch-scheduler.service.ts` |
| Queueing | **None.** No Redis, no BullMQ, no S3 in `apps/backend/package.json` — CLAUDE.md's "Redis/BullMQ, S3" line is aspirational, not current (§4 correction) | `package.json` deps grep |
| Auth store | **Postgres-backed** users + refresh tokens (`PrismaUserStore`/`PrismaRefreshTokenStore`, #91 S1–S4 done 2026-08-03; `auth/user-store.ts` is deleted). A dev database gets its logins from `npm run seed:dev` (#194) — nothing seeds them at boot any more. See §3j | `auth/prisma-user-store.ts`, `auth/prisma-refresh-token-store.ts`, `auth/dev-seed.ts` |
| Deployment | **None** — no Dockerfile, no compose, no runbook (issue #111 open) | repo root inspection; `docs/audits/2026-07-07-…reaudit.md` |

### 1.4 Module map

`AppModule` (`app.module.ts:80-106`) imports 24 feature modules and mounts ~45 controllers at the
app level; guards `AuthGuard → RoleGuard → ZoneScopeGuard` are providers applied per-controller
via `@UseGuards` — **there is no global `APP_GUARD`** (issue #99 open; an unguarded controller is
silently public).

| Module | Responsibility | Notable exports / notes |
|---|---|---|
| `prisma` | PrismaService singleton | imported everywhere |
| `auth` | Login/refresh/JWT (HS256 `{user_id, role, zone_id}`), scrypt hashes, 15-min access / 30-day rotating refresh | in-memory stores (→ #91); `acting-context.ts` acting-role attribution |
| `settings` | `system_settings` audited key-value (incl. `eligibility_mode`) | `SettingsService` |
| `audit` | `audit_logs` writer + `/api/audit-trail/tickets/:id` viewer | `AuditService` |
| `org` | Org graph CRUD: zones, plants, companies, users, engineers, SE coverage/territory, SLA rules, scoring weights, common kit, geography (PostGIS), zone-mapping | 14 admin controllers; `plant-eligible-floating-se.service.ts` MV refresh |
| `ingestion` | Everything AutoPlant: master sync, snapshot worker, run ledgers, partitions, health, **ingestion scheduler** | see §3a/§3b; self-contained (own guards + `ScheduleModule.forRoot()`) |
| `device-state` | Set-based recompute, SLA buckets, eligibility modes | **imported only by IngestionModule** (`device-state.module.ts:12-13`); other consumers reach the table via their own Prisma (#105 territory) |
| `ticketing` | Ticket creation, query, troubleshoot submission, auto-recovery, repeat-escalation, vehicle-unavailability, non-op 
dual-confirm, recovery lifecycle, install create+lifecycle | 8 controllers |
| `devices` | Device list read + per-device cycles/downtime-trend + deal-type tag | `DeviceService`, `DeviceDetailService` |
| `recommender` | Candidate selection, hard filters, scoring, canonical sort → `recommendations` | consumed by SchedulingModule |
| `scheduling` | Batch dispatch, day-plan/schedule queries, ZM override, same-day update, dispatch-run + daily dispatch cron, **daily work-schedule closure cron** (#147, recycling unresolved assignments since #242) | `SchedulingModule` imports `RecommenderModule` (#113) |
| `business-sweep-scheduler` (in `scheduling/`) | 11 env-gated `@Cron` sweeps: verification, install-verification, intraday-timeout, cross-zone, repeat-escalation, tier-override-expiry, soft-inactive, system-efficiency, 3 month-start cubes | leaf module (#108) |
| `intraday` | CRITICAL insertion offer state machine, accept/decline/timeout | #29/#30/#101 |
| `cross-zone` | Platinum auto-escalation + manual flag, approve/deny/defer/re-escalate | #32 |
| `shared-pool` | SE shared ticket pool | #12 |
| `planner` | SE planner grid CRUD + recommender bias | #14 |
| `dashboard` | Zone dashboard aggregates | #06 |
| `reports` | fleet-uptime, soft-inactive trend, root-cause, efficiency, ZM scorecard + aggregation services | #39–#44 |
| `soft-state` | SE soft states + activity ping | #15 |
| `verification` | GPS three-phase verification, review, fraud flag | #18/#19 |
| `inventory` | Van stock, ledger, shadow-use, zone warehouse stock | #21/#24/#73 |
| `component-request` | Request flow, WAITING_COMPONENT, WM queue, oversight | #22/#23 |
| `engineers` | SE directory/admin CRUD (Phase 4), availability, leave | `EngineerAdminService` |
| `roles` | Role-backup cascade + CSM acting scope | #27 |
| `notifications` | In-app spine + channel-gateway seam (no real external adapters — #76) | `NotificationService` |
| `vouchers` | Expense vouchers SE→ZM→OH finance | #38 |
| `me`, `zones` | Thin identity + zone-list controllers (AppModule-level, no module) | `me.controller.ts`, `zones.controller.ts` |

### 1.5 Branch / working-tree state at time of writing

- Branch `feat/autoplant-integration`; `main` exists but the integration line has **not** been
  promoted to `main` (INDEX.md:19). ✅ **As of 2026-07-10 the branch is pushed to `origin`** (tip
  `e5006ae`) — it is no longer disk-only, though still un-promoted to `main`.
- Uncommitted working tree at session start (admin UI visual polish + `devices.ts`/`schedules.ts` API
  clients + `device.service.ts`/`devices.controller.ts`/`zm-schedule-query.service.ts` + tests) has
  since been **committed** as WIP slice `e5006ae` (§8).
- ✅ **Standing trap resolved**: `.gitignore`'s `data/` rule no longer shadows
  `apps/admin/src/components/data/` (anchored to `/data/`); the dir is tracked and the branch tip
  builds from a fresh clone (issue #114, **done**).

---

## 2. DATA LAYER

Source: `apps/backend/prisma/schema.prisma` (2,055 lines, 59 models + 1 materialized view),
55 migrations (`20260617103804_init_system_settings` → `20260709120000_intraday_one_live_offer`).
Conventions: snake_case via `@map`, timestamptz UTC, BigInt ids (except uuid for tickets/cycles/
submissions/users), PostGIS via `Unsupported(...)` + raw SQL, and **raw-SQL appendices** in
migrations for everything Prisma can't express (partial uniques, CHECKs, partitioning, the MV).

### 2.1 Org graph & reference config

| Table | Purpose | Key constraints / notes |
|---|---|---|
| `company_master` | Companies; recommender's tier gate + priority tie-break | `sourceCompanyId` unique (AutoPlant mirror key); `companyTier`+`companyPriorityRank` FSM/CRM-owned (schema:56-78) |
| `zones` | Unit of ZM authority + row scoping | `name` unique + case-insensitive `zones_name_ci_key (lower(name))` (migration `20260707120000`); contains the **UNZONED** holding zone |
| `plants` | Sites; clustering unit | `zoneId` **NOT NULL** (schema:197 comment: nullable-deferral rejected; unzoned plants land in UNZONED zone instead); `sourcePlantId` unique; full AutoPlant mirror columns (`source_zone_name`, `plant_state`…) stored verbatim for audit/derivation |
| `zone_mappings` | R6 crosswalk: normalized raw `zone_name` → FSM zone; PENDING/MAPPED/IGNORED, auto-discovered during sync | unique `(source_field, source_value_key)`; edits apply via `ZoneMappingService.reapply`, never re-sync (schema:1536-1565) |
| `plant_zone_overrides` | Per-plant pin to an FSM zone (highest precedence) | `sourcePlantId` unique |
| `users` | Account registry (RBAC actor) | **No credentials** — login is in-memory (#91); `phone`/`email` unique |
| `engineer_master` | SE profile (coverage type, capacity, shift, activity ping) | 1:1 `engineerId`=`users.userId`; `lastActivityAt` never gates scoring (ADR-0023/24) |
| `se_coverage` | DEDICATED/MULTI_PLANT plant assignment | CHECK `coverage_type <> 'FLOATING'`; partial unique `se_coverage_dedicated_se_key (se_id) WHERE DEDICATED` |
| `engineer_territory_coverage` | FLOATING SE territory (state/region/district ∪ polygon) | polygon `Unsupported(MultiPolygon)` **reserved, unused in v1** (schema:263); raw CHECK ≥1 dimension |
| `regions` / `districts` | Indian admin geography (~700 districts) | `districts` unique `(name, state)` |
| `sla_rule_config` | Tunable SLA windows | unique `(scope, key)` |
| `priority_rule_config` | Versioned recommender weight sets | unique `(weightSetRef, component)`; active set stamped into recommendations |
| `component_master` / `common_kit_definition` | Component catalog + common-kit hard-filter source | `min_qty > 0` CHECK |
| `system_settings` | OH-owned audited key-value JSONB (incl. `eligibility_mode`, `telemetry_retention_days`) | string PK |
| MV `plant_eligible_floating_se` | Plant↔floating-SE territory membership for the recommender | `CREATE MATERIALIZED VIEW` (migration `20260621160000`); refreshed by `plant-eligible-floating-se.service.ts` |

### 2.2 Devices & telemetry

| Table | Purpose | Constraints / writer status |
|---|---|---|
| `devices` | GPS unit registry; `deviceId` is the AutoPlant business string (leading-zero IMEIs) | `deal_type` NULL ⇒ OH manual tag (endpoint exists, #49); `device_type` + `imsi_no` are written by master sync from an `ap_widgets.tb_vehiclemaster` join (see §3a). **Correction (2026-07-17):** the earlier claim here that `device_type` "is written" was wrong — `master-mapping.ts` mirrored it, but `autoplant-master-source.ts` fed it `NULL AS device_type`, so every sync wrote NULL (verified: 0 of 20,935 non-null). Fixed by the enrichment join; `imsi_no` added alongside |
| `vehicles` | Fitment anchor → plant/company/transporter | `vehicle_no` unique; `status` mirrors AutoPlant deployment; transporter FK wired in migration `20260703120000` after nulling dangling values |
| `transporters` | AutoPlant `mst_transporter` mirror | `sourceTransporterId` unique; written by master sync |
| `raw_device_snapshots` | One row per ping — highest-volume table | **RANGE-partitioned daily** by `gps_datetime` (rebuilt in `20260706130000` — the original `20260619153000` declared PARTITION BY but only had a DEFAULT partition); PK `(id, gps_datetime)`; unique `(device_id, gps_datetime)` + `ON CONFLICT DO NOTHING` ⇒ idempotent chunk re-runs |
| `device_states` | Derived hot row per device: inactivity hours, `sla_bucket` (stored), eligibility, denormalised vehicle/plant/company, `trip_creation_datetime`, `first_reported_at` | CHECK `inactivity_hours >= 0`; recomputed set-based by `DeviceStateService`; **18,528 rows in dev DB** (INDEX.md:132). `trip_creation_datetime` (2026-07-17) is maintained at INGEST by `SnapshotIngestionService`, like `latest_gps_datetime` — it is live trip state (18.4%/day churn), not master data; see §3b. **`first_reported_at` + `first_reported_offset_min` (2026-08-09, migration `20260809120000`)**: the first GPS ping ever seen for a device, write-once via `COALESCE` in the same ingest upsert. Nothing else in FSM retains it — `latest_gps_datetime` is overwritten every tick and `raw_device_snapshots` drops partitions after 7 days — so it is observable exactly once, as it happens. Written at **true UTC (offset 0)**, because a write-once column frozen under #222's wrong constant would carry the 5.5 h error permanently. **#222 landed 2026-08-09 and `AUTOPLANT_UTC_OFFSET_MIN` is now 0, so the dual-write is degenerate in production** — kept anyway, because the offset is still a per-call parameter (`MapOptions.offsetMinutes`), i.e. the two converge by *configuration*, not by construction, and this is the one irreversible column on the path. **Covered since 2026-08-09** by `snapshot-first-reported-dualwrite.e2e-spec.ts` (7 tests): write-once against both a later AND an earlier ping (COALESCE, not LEAST — a LEAST would pin every device to its pre-#222 value forever), chunk-**min** not chunk-max, offset 0 recorded, and a null corrected timestamp leaving the column unset rather than freezing a `+330` value. **`never_reported` is NOT a column here** — it is derived at read time from `latest_gps_datetime IS NULL` (#223), because that column is maintained at ingest while a derived flag would be written by the recompute, so a stored flag would be stale on exactly the transition that matters |
| `device_commissioning` | Append-only fitment fact — one row per (device, vehicle, `installed_at`), carrying `installed_by`, `installation_remark`, denormalised plant/company, and the `first_reported_at` snapshot | **Migration `20260809120000` applied AND tracked; written by `MasterSyncService.appendCommissioning` since 2026-08-09.** The writer is best-effort — `createMany({ skipDuplicates: true })` inside one try/catch, running *after* every mirror write and outside any `$transaction`, so a fitment-write failure can neither fail the sync nor roll back the mirror; the run records `entity_stats.commissioning` (`inserted` / `skipped` = already-recorded fitments / `observed`) and `skippedByReason.APPEND_FAILED` when it does fail. Scoped to the devices the run actually **mirrored**, not the whole widened read — writing the ~27k never-mirrored rows would make this table describe a different population than every other FSM surface. It is a table rather than columns on `devices` because `tb_vehiclemaster` rewrites fitment in place (measured: 10,565 devices have had `first_installed_dt` moved, 1,757 by more than a year), so anything reading only the live source row measures a silently-mutating population. Append-only is structural: the unique key IS the fitment identity and the writer is `INSERT … ON CONFLICT DO NOTHING`. **The unique index needs `NULLS NOT DISTINCT`, which Prisma 7.8 cannot express** — `prisma migrate dev` will offer a replacement without it, and accepting that silently breaks append-only-ness (`installed_at` is null on ~13% of source rows; `NULL <> NULL` re-inserts every one on every daily sync). Verified present in the DB via `pg_index.indnullsnotdistinct`. Full state: `.scratch/fsm-platform-v1/HANDOFF-commissioning-capture.md` |
| `snapshot_runs` / `snapshot_run_chunks` | Ingestion run ledger + per-chunk retry; drives data-as-of banner | partial unique `snapshot_runs_one_in_flight (status) WHERE 'RUNNING'` |
| `master_sync_runs` / `master_sync_rejects` | Master-sync ledger + itemised skip accounting (#97 Slice 4) | reject rows capped per run, best-effort writes |
| `pgi_history` | SAP Post-Goods-Issue events feeding the `pgi` eligibility gate | **NO production writer** — read-only in `device-state.service.ts:64`; SAP feed external/deferred, rows must be seeded (schema:1830-1832). This emptiness is blocker B7 |

### 2.3 Tickets & failure cycles

| Table | Purpose | Constraints |
|---|---|---|
| `failure_cycles` | Immutable inactivity episode; SLA primary-clock anchor; pause bookkeeping (`sla_accumulated_pause_seconds`) | **I1**: partial unique `failure_cycles_one_active_per_device WHERE state IN (OPEN, WAITING_COMPONENT, SUBMITTED, REPEAT, ESCALATED)` (widened in `20260621011500`); CHECKs `valid_close`, `pause_coupling (sla_paused = (sla_pause_reason IS NOT NULL))`; optimistic `version` |
| `tickets` | Unified work item, `work_type` ∈ TROUBLESHOOT/INSTALL/RECOVERY discriminates column families (install fitment cols, recovery collection cols) | **I2**: `failure_cycle_id` UNIQUE; raw CHECK TROUBLESHOOT ⇒ cycle NOT NULL; partial index `(plant_id) WHERE OPEN+UNASSIGNED` (shared pool, `20260621190000`); optimistic `version`. **No index on `device_id`/`vehicle_id`** (#103 open) |
| `ticket_events` | Append-only lifecycle timeline (narrower than audit_logs) | append-only by construction only — no DB trigger (schema:1812) |
| `vehicle_unavailability_reports` | SE-filed VU → SLA pause + dual clocks (#28); since **#245** the system of record for the return-date decision — immutable `proposed_from` vs authoritative `expected_from`, decision columns (`decided_by`/`_role`/`_at`, `decision`, `override_reason`), `SUPERSEDED` status | `(status, expected_from)` index; **partial unique `(ticket_id) WHERE status = 'OPEN'`** (one live report per ticket, #245); CHECKs: decision is who+when+what or nothing, vocabulary `APPROVED\|OVERRIDDEN`, override states a reason |
| `non_operational_markings` | Dual-confirmation Non-Op lifecycle + customer token + recovery-ticket back-ref | **I13**: partial unique one-active-per-device `WHERE state IN (CONFIRMED, ACTIVE)`; `customer_token` unique |
| `troubleshooting_submissions` | SE form: structured root cause (analytics source), GPS anchor, idempotency | unique `(se_id, client_submission_id)`; CHECK restricts `submission_type` to the two form types |
| `verification_runs` | Three-phase GPS verification per submission | partial unique `ux_vr_active (ticket_id) WHERE outcome IS NULL` |
| `soft_states` | VIEWED/ON_SITE/TROUBLESHOOT_STARTED field progress | partial unique `ux_ss_active (ticket_id, se_id, type) WHERE resolved_at IS NULL` + 3 raw CHECKs; `(ticket_id, set_at)` for the assignment-window join (#241) |

### 2.4 Scheduling & recommendations

| Table | Purpose | Constraints |
|---|---|---|
| `recommendations` | Append-only "why suggested" explainability (scoreBreakdown JSONB, canonical `processing_rank`) | partial unique `recommendations_one_suggested_per_ticket WHERE status='SUGGESTED'` (#100, `20260708120000`) |
| `work_schedules` | Per-SE Day-Plan container (no approval gate — ADR-0007/0019 superseded). **Lifecycle now terminates** (#147): `ScheduleClosureScheduler` writes `COMPLETED`/`PARTIAL` onto past-dated rows under the zone's dispatch advisory lock, so schedules stop accreting as permanently live; the day-plan read is date-bounded independently of it. **Closure also ends the day's *assignments*** (#242): unresolved rows on the closing schedules are stamped `PLAN_EXPIRED` and their tickets returned to `UNASSIGNED`, so a terminal schedule no longer strands live work | partial unique `work_schedules_one_active_per_se_zone_day (se_id, zone_id, date_from) WHERE ACTIVE` — **zone_id deliberately in the key** vs the #100 spec, to allow cross-zone plans (INDEX.md:97) |
| `plant_batch_assignments` / `batch_assignment_tickets` | **Also the attempt ledger** (#244 — one row = one attempt *window*; `soft_states` inside it = **reached**, a `troubleshooting_submissions` row = **success**). Plant-stop batches + per-ticket rows with override history (`removed_at`, `deferred_to_date`, **`removal_reason`** — #241: why the row stopped being live, closed vocabulary in `scheduling/removal-reason.ts`, NULL ⟺ still live; `removed_by IS NULL` is auto-recovery's signature and must **not** be read as "system" generally) | partial unique `batch_assignment_tickets_one_active_per_ticket WHERE removed_at IS NULL` (`20260621180000:78`); plain `(ticket_id)` for the per-ticket history read (#241). #242's nightly recycle writes `PLAN_EXPIRED` (unresolved, ticket also flipped to `UNASSIGNED`) and `RESOLVED_AT_CLOSURE` (a straggler row on an already-resolved ticket — stamped, never unassigned) |
| `se_planner` | ZM plant-visit intent; **soft bias** to the recommender, never a constraint | unique `(se_id, plant_id, planned_date)` |
| `intraday_insertions` | Mutable CRITICAL-insertion offer state machine + `retry_chain` JSONB | partial unique `intraday_insertions_one_live_offer_per_ticket WHERE PENDING_ACCEPTANCE` (#101, `20260709120000`) |
| `cross_zone_escalations` | Parallel escalation record — ticket never leaves home queue | indexes on `(status, escalation_type)`, `home_zone_id` |

### 2.5 Inventory

| Table | Purpose | Constraints |
|---|---|---|
| `se_van_stock` | Per-SE carried components (common-kit filter source) | CHECK `qty >= 0`; written only via ledger |
| `inventory_transactions` | Ledger: PRE_VERIFICATION→DEDUCTED/ROLLED_BACK; 409-loser SHADOW_USE→RECONCILED/DISPUTED | CHECK `qty > 0` |
| `component_request` | WAITING_COMPONENT flow REQUESTED→…→RECEIVED | `submission_id` unique (idempotent raise); optimistic `version` |
| `component_blocked_queue` | Tickets undispatchable for missing kit | partial unique `ux_cbq_active WHERE resolved_at IS NULL` |
| `zone_warehouse_stock` | Zone×SKU on-hand/reserved (#73) | unique `(zone_id, component_id)`; **manually WM-managed** — no automated replenishment/decrement (#95 open); `reserved` has no writer yet `[INFERRED — #95 owns allocation]` |

### 2.6 Availability, escalation actors, vouchers

| Table | Purpose |
|---|---|
| `se_availability` | Windowed planning availability; only AVAILABLE ⇒ recommender-eligible (ADR-0010) |
| `leave_requests` | SE-filed leave w/ ZM approval → writes an availability window (`availability_id` link) |
| `role_unavailability` | Manager-tier backup cascade windows (ZM→CSM→OH, #27) |
| `expense_vouchers` / `expense_voucher_items` | Voucher lifecycle DRAFT→…→PAID; unique `(se_id, client_submission_id)`; item cascade-delete |

### 2.7 Auth / audit / notifications

| Table | Purpose / posture |
|---|---|
| `users` | See §2.1 — registry only, no credentials (#91) |
| `audit_logs` | Same-transaction immutable audit; `acted_as_role`/`acting_zone` proxy attribution. **Append-only, unpartitioned, no retention** (#104) |
| `notifications` / `notification_deliveries` | In-app spine + per-channel delivery records; external send is a seam (#76). Same growth posture (#104) |

### 2.8 Reporting summaries (all delete+insert idempotent rebuilds, cron deferred → #108 now provides ticks)

| Table | Grain | Writer |
|---|---|---|
| `device_downtime_summary_monthly` | device×month downtime + #44 cycle metrics | `FleetUptimeAggregationService` |
| `soft_inactive_count_history` | zone×half-day soft-inactive snapshot | `SoftInactiveCountService` |
| `root_cause_summary_monthly` | month×zone×company×plant×device_type×SE×category cube | `RootCauseAnalyticsAggregationService` |
| `zm_performance_summary_monthly` | month×zone×ZM decision-activity counts | `ZmPerformanceAggregationService` |
| `system_efficiency_summary_daily` | day×dims additive counters + stage-time sums (11 INSERT…SELECT families) | `SystemEfficiencyAggregationService` |

### 2.9 Growth & retention posture

- **Partitioned + retained:** only `raw_device_snapshots` — daily partitions, 3-day create-ahead
  (`partition-maintenance.service.ts:13`), retention from `system_settings.telemetry_retention_days`,
  O(1) `DROP TABLE` per day, DEFAULT partition never dropped. Gated by
  `PARTITION_MAINTENANCE_ENABLED=true` (`:53`, default OFF) — **must be flipped with the ingestion
  scheduler or pings silently pile into DEFAULT after the 3-day runway** (INDEX.md:150-153).
- **Append-only with NO retention/partitioning:** `audit_logs`, `ticket_events`, `notifications`,
  `recommendations`, `master_sync_rejects`, `soft_inactive_count_history` (#104 open).
- **No production writer (awaiting external feed or manual entry):** `pgi_history` (SAP feed absent —
  blocker B7); `zone_warehouse_stock.reserved` (allocation flow → #95); `users` credentials (#91);
  `engineer_territory_coverage.polygon` (v1 uses hierarchy only); `regions`/`districts` seed-only.
- **Optimistic-version columns** exist on `failure_cycles`, `tickets`, `component_request`,
  `non_operational_markings` — enforcement is per-service and incomplete (#101 partial, see §5).

---

## 3. PIPELINE LOGIC, SUBSYSTEM BY SUBSYSTEM

### 3a. AutoPlant master sync (#96)

**Algorithm** (`master-sync.service.ts:79-95`): read `ap_masters` (`mst_company`/`mst_transporter`/
`mst_vehicle`) + a device-identity join to `ap_widgets.tb_vehiclemaster`; upsert into FSM Postgres keyed by
`source_*_id` in FK order companies → transporters → plants → vehicles → devices. **Plant-first
derivation**: scope anchors on `mst_plant.status='ACTIVE'`; companies are *derived* (created only
when an in-scope plant names them) — no company allow-list, no reliance on the dirty
`mst_company.company_type`. Vehicles filtered to `deployment_status='DEPLOYED'`
(`ingestion.module.ts` binds `deploymentStatuses: ['DEPLOYED']`).
- **Zone resolution**: injected `PlantZoneResolver` = `MappingTableZoneResolver` — precedence
  `plant_zone_overrides` pin → `zone_mappings` MAPPED row (normalized `zone_name`) → **UNZONED
  holding zone** for PENDING/IGNORED; unseen raw values auto-discovered as PENDING rows.
  **Admin surface (#158, 2026-07-23):** the override half is no longer curl-only — OH-only
  **Plant Zones** page (`apps/admin/src/pages/admin/PlantZonesPage.tsx`, route `/plant-zones`)
  sets/clears pins and **chains `reapply`**, because a pin is inert on its own. `SET`/`CLEARED`
  audit rows now carry `{prevFsmZoneId, newFsmZoneId, reason}` (the row is upserted, so the previous
  zone survives nowhere else) and a reason is mandatory. Verified by test, not assertion: a zone
  change re-scopes the plant's devices, its open tickets and both ZM dashboards **with zero writes
  to the ticket or device-state rows** — `plants.zone_id` is the only stored copy of a plant's zone,
  which is why no recompute job exists. A `zoneChangeImpact` probe
  (`GET /api/org/plant-zone-overrides/:sourcePlantId/impact`) warns before a **mid-day** move: the
  tickets follow the plant but today's dispatched `work_schedules` stay under the old zone, so until
  the next run one ZM holds the plan and another sees the tickets.
- **Anti-drift (R4) is structural**: the pure `master-mapping` layer excludes every FSM-owned column
  (`ops_override`, tier/rank, operational `zone_id`, `deal_type`) from its update set
  (`master-sync.service.ts:92-94`) — edits re-apply via `ZoneMappingService.reapply`, never re-sync.
- **Skip accounting**: itemised per-reason counters + `master_sync_rejects` rows, capped 5,000/run,
  best-effort writes (`master-sync.service.ts:71-76,123-130`).
- **Device-identity enrichment (2026-07-17)**: `readVehicleMasters` reaches across the schema boundary —
  `LEFT JOIN ap_widgets.tb_vehiclemaster w ON w.vehicle_no = v.vehicle_no` — for `DEVICE_TYPE` +
  `IMSI_NO` (neither exists in `ap_masters`; this read previously fed `NULL AS device_type`, which is why
  `devices.device_type` was NULL fleet-wide). Free and fan-out-safe: `tb_vehiclemaster.vehicle_no` is the
  PK and verified unique (60,601 rows / 60,601 distinct), 100% of DEPLOYED vehicles match, and it rides
  the SAME paged queries — query count and the <100-row cap unchanged. **Only STATIC identity crosses this
  join** (measured: 91 of 24,173 devices ever changed `device_type` across 922k pings = 0.38%).
  `TRIP_CREATION_DATETIME` deliberately does NOT — it is live trip state and rides the snapshot tick
  (§3b). A widgets outage now FAILS the master run rather than degrading it: since `mapDevice` mirrors
  these columns, a run that substituted NULLs would wipe them fleet-wide, whereas a failed run writes
  nothing and is visible in `master_sync_runs`.
- **Batching**: reads ≤90 rows/query (DBA <100 cap); writes batched 500-row `$transaction`s
  (`UPSERT_BATCH_SIZE`, `master-sync.service.ts:56-63`).
- **Guards**: `master_sync_runs` single-in-flight (409 `RUN_IN_PROGRESS`), stale-run reaper shared
  with snapshots. Unconfigured env binds `EMPTY_MASTER_SOURCE` → no-op.
- **Known limit**: zone coverage is data-starved — zone_name is ~98% complete fleet-wide but
  near-absent in the ACTIVE plants FSM syncs, so ~83% of synced devices landed UNZONED
  (`docs/audits/unzoned-plants-2026-07-07.md` `[spot-checked below, §4]`). **Reduced to 23% on
  2026-07-13 via 47 plant_zone_overrides (§6.1); the mechanism-starvation itself is unchanged.**

### 3b. Snapshot ingestion (#04/#97)

**Algorithm** (`snapshot-ingestion.worker.ts:31-137`): open a RUNNING `snapshot_runs` row → drain
the `SourceReader` keyset-cursor chunk by chunk (default tick chunkSize 90,
`integration-sync.service.ts:72`) → each chunk retries ×3 with exponential backoff independently →
finalize SUCCESS/PARTIAL/FAILED.
- **Idempotency**: `raw_device_snapshots` unique `(device_id, gps_datetime)` + `ON CONFLICT DO
  NOTHING` — chunk re-runs and cursor overlap are free.
- **Two-cursor asymmetry** (review A3, `worker:120-128`): `data_as_of` = conservative display
  watermark (high-water of succeeded chunks, never advances on lost data); resume `cursor` =
  optimistic re-read floor (first failed chunk's lower bound on PARTIAL).
- **Read-error fall-through** (`worker:64-68,102-104`): a mid-scan source read throw (VPN drop) no
  longer orphans the run — caught, run finalized PARTIAL/FAILED (the "run 456" fix).
- **Run ledger + reaper**: `snapshot_runs_one_in_flight` partial unique; `reapStaleRuns()`
  (`stale-run.ts`, wired in `snapshot-run.service.ts:43` per INDEX.md:91) fails runs stuck RUNNING
  past `INGESTION_STALE_RUN_MIN`.
- **Partitioning**: daily partitions + 3-day create-ahead + settings-driven retention, gated
  `PARTITION_MAINTENANCE_ENABLED` (§2.9).
- **UTC normalization**: `AUTOPLANT_SOURCE_UTC_OFFSET_MIN` env feeds the reader
  (`ingestion.module.ts`) — the AutoPlant session is known non-UTC (§5 env issues).
- **Trip-creation enrichment (2026-07-17)**: the reader also selects `TRIP_CREATION_DATETIME` (no extra
  query — same scan), and `SnapshotIngestionService` maintains `device_states.trip_creation_datetime`
  in the SAME set-based `unnest`+`GREATEST` upsert as `latest_gps_datetime`. It lives here, not in the
  daily master sync, because it is **live trip state**: measured 2026-07-17, 2,614 of 14,205 DEPLOYED
  vehicles (18.4%) change it per DAY and it tracks `active_trip_id` — vs 0.2%/day for a genuine fitment
  attribute (`device_installation_date`). A daily mirror would be stale for ~2,600 vehicles at a time.
  It goes on the hot `device_states` row, NOT `raw_device_snapshots` (per-ping, partitioned, retention-
  dropped) — it is current state, not a ping observation.
  **Timezone trap:** the two source stamps in one row do NOT share a zone. `latest_gps_datetime` is a
  naive MySQL DATETIME written in IST ⇒ normalize +330. `TRIP_CREATION_DATETIME` is a MySQL **TIMESTAMP**,
  which the server converts to the session zone on read, and the AutoPlant session is **UTC**
  (`@@system_time_zone`=UTC, `@@session.time_zone`=SYSTEM) ⇒ it arrives ALREADY UTC and takes offset **0**
  (`mapping.ts parseTripCreation`). Applying the IST offset would shift every trip stamp by 5.5h. Pinned
  by `test/autoplant-mapping.spec.ts`.
- **Schema-qualification (mandatory)**: `AutoPlantSourceReader` reads
  `` `<widgets>`.tb_vehiclemaster `` schema-qualified via the injected `widgetsSchema`
  (`ingestion.module.ts` passes `cfg.dbWidgets`). The pool's **default schema is `ap_masters`**
  (the connect-time-validated live-consumer schema — see `buildPoolOptions`), where
  `tb_vehiclemaster` does not exist. An unqualified read therefore fails `ER_NO_SUCH_TABLE` on
  the first chunk → run FAILED with zero chunks. **This caused every run 64–70 to fail (2026-07-14→15)
  after the `default=ap_widgets`→`ap_masters` client change** (INDEX 2026-07-15 line); fixed by
  qualifying the reader to match `ping()`/`AutoPlantMasterSource`.

### 3c. Device-state recompute (#05, R4-B set-based)

**Algorithm** (`device-state.service.ts:41-99`): two set-based statements, no telemetry scan —
(1) `INSERT … ON CONFLICT DO NOTHING` guarantees a `device_states` row per device; (2) one UPDATE
derives `inactivity_hours` (= now − `latest_gps_datetime`, clamped ≥0; the latest ping is maintained
incrementally **at ingest** by `SnapshotIngestionService`), `is_inactive` (vs
`inactivity_threshold_hours` setting, default 24), `sla_bucket` (SQL CASE generated from the same
`SLA_BANDS` as the TS classifier — cannot drift, `sla-bucket.ts`), `eligible_for_uptime`, and the
denormalised fitment columns. Runs on the telemetry tick because bucket aging is a function of
wall-clock time.
- **Eligibility modes** (`eligibility.ts`, #112): `pgi` (canonical) = EXISTS `pgi_history` row ≤15
  days (`DEFAULT_PGI_WINDOW_DAYS`); `all-deployed` (interim proxy) = vehicle status ∈
  (ACTIVE, DEPLOYED). Both AND NOT an active Non-Op marking (`device-state.service.ts:60-87`).
- `has_open_failure_cycle` deliberately untouched here — owned by ticket creation.

### 3d. Ticket creation (#05/#08/#112)

**Algorithm** (`ticket-creation.service.ts:27-108`): select `device_states` WHERE inactive AND
eligible AND no open cycle AND has plant+company → per device, one `$transaction` creating
`failure_cycle` (OPEN, or REPEAT if a VERIFIED cycle closed ≤24h prior — ADR-0021), the parented
TROUBLESHOOT `ticket` (tier denormalised), the OPEN `ticket_event`, and the
`has_open_failure_cycle` flip. Invariant I1 partial-unique backstops races — P2002 ⇒ silent skip.
- **Gate**: candidates exist only if `eligible_for_uptime` is true. **Corrected 2026-08-10 (#229
  §3.3):** the long-standing "`eligibility_mode='pgi'` over an empty `pgi_history` ⇒ **0 tickets
  created today**" framing is **wrong for the dev database as configured** — `system_settings.
  eligibility_mode` is **`all-deployed`**, 15,696 devices carry `eligible_for_uptime = true`, and the
  31,162 `OPEN` events prove creation has been running. B7 remains a real blocker for the *`pgi`*
  mode; it is not what is gating ticket creation here.
- **Auto-recovery** (`auto-recovery.service.ts`) closes a cycle whose device resumed pinging as
  `CLOSED_AUTO_RECOVERY`. **Corrected 2026-08-10 (#229): until this date it had no production caller
  at all** — no cron, no route, no CLI — so despite being built, documented and tested since Issue 08
  it had never executed once (0 `CLOSED_AUTO_RECOVERY` rows in 42,955 `ticket_events`), and ~11,042
  closable tickets accumulated. It is now the **auto-recovery pre-check** the LLD always specified
  (`fsm-backend-low-level-design.md:615`), called by `IntegrationSyncService` between device-state
  recompute and ticket creation on both `ingestTelemetry()` and `runPipeline()`. **It still has not
  run**, and will not until `INGESTION_SCHEDULER_ENABLED` is turned on: enabling it is an
  operator-gated ~9,888-closure event (#229 "Gating posture"), bounded by `AUTO_RECOVERY_MAX_PER_PASS`
  (default 200/pass). The scan closes only devices that are healthy at the recompute that just ran, so
  flapping devices keep their tickets. Repeat-escalation (`repeat-escalation.service.ts`) escalates
  repeat offenders, driven by #108's cron.
- **Known limit**: per-candidate loop (one transaction per device) — fine at current volumes;
  unbounded candidate list is a #106-family concern only if a mass outage flips thousands inactive
  at once `[INFERRED]`.
- **Deactivated-plant exclusion (#119, 2026-07-14)**: FSM-owned `plant_deactivations` side table
  (`plant-deactivation/` module; partial-unique one-active-row-per-plant, anti-drift like
  `plant_zone_overrides` — never in the master-sync update set). OH-only
  `POST /api/plants/:id/deactivate|reactivate` + `GET /api/plants/deactivations` + admin
  **Plant Deactivations** page. Deactivate cancels the plant's open tickets in one audited tx
  (`CLOSED` + `closureType OPERATIONS_HEAD_OVERRIDE_CLOSE` + `closureReason
  'PLANT_DEACTIVATED: <reason>'`, parent FailureCycle → `FAILED` so no REPEAT mis-flag) and the
  plant is excluded from ticket creation (here), dashboard counts, recommender dispatch, and the
  #121 export (`plant_fsm_status='deactivated'`). Reactivation stamps history; the pipeline
  re-creates tickets for still-inactive devices next run. Applied to the 6 STAR CEMENT plants
  on the dev DB (§6.1).

### 3e. Recommender (#10/#72/#75)

**Entry**: `RecommenderService.runForZone(zoneId)` (`recommender.service.ts:76`) — no own cron;
called by the dispatch run (#113) or HTTP.
**Special tickets (#244) are DERIVED, never stored.** A ticket that was repeatedly dispatched, actually
*reached* in the mobile app, and never successfully worked: countable attempts (window ended
`PLAN_EXPIRED`/`VEHICLE_UNAVAILABLE`, reached, unsubmitted) ≥ `special_ticket_attempt_threshold`
(default 3, ladder 2-10, OH-owned) AND no submission ever AND `status = OPEN` AND
`work_type = TROUBLESHOOT` (the last clause is a recorded narrowing — an install can never have a
troubleshooting submission, so without it every repeatedly-dispatched install would be Special by
vacuous truth). No column, no counter, no writer: a threshold change reclassifies the open book on the
next read and a late submission un-Specials a ticket with nothing to undo. One SQL expression
(`ticketing/special-ticket.query.ts`) is evaluated by the queue badge, the `special=true` filter, the
count and the Device read, so those four surfaces cannot disagree. Special is **not** a status, not a
priority input, and never touches REPEAT/ESCALATED — pinned by an ordering test, and since #248
**structurally**: the comparator's candidate type has no Special input at all.
**Canonical processing order gained one key (#248, Decision 15 / Option C):** Company Tier ↓ → Device
Bucket ↓ → **Return Due Today ↓ (2b, only when both buckets are below CRITICAL+)** → Company Priority
Rank ↑ → Oldest Inactive ↑ → Device ID ↑. Placement is the safety property: step 2 has already ordered
CRITICAL+ work ahead before 2b is read, and a returning ticket that itself aged into CRITICAL+ never
consults the key — so 2b decides only between tickets sharing a sub-CRITICAL bucket, where it outranks
Priority Rank. `sla_bucket` is untouched (promoting it would corrupt Fleet Uptime, the Soft Inactive
Count zones are graded on, SLA reporting and the decision traces). `returnDueToday` is derived per run
from an OPEN vehicle report whose authoritative `expected_from` has reached the run's IST day — one
batched read, no stored flag, no schema change. `CRITICAL_PLUS_BUCKETS` is now a single export in
`device-state/sla-bucket.ts`, **derived from `SLA_BANDS`**, consumed by the comparator gate, cross-zone
escalation and the dashboard. **There is no SQL mirror of the comparator** — the selection read carries
no `orderBy` and the sort is applied once in process; the docstring that claimed otherwise was stale
and is corrected, because believing a mirror exists invites someone to build one.
**Unrankable tickets are dropped before any decision, and now counted** (#242): the canonical sort needs
an SLA bucket, so a ticket whose `device_states.sla_bucket` is NULL (or whose device has no state row)
falls out with no recommendation, no UNASSIGNABLE row and no decision trace — it used to appear nowhere
on the run report at all. **5,127 of 6,464** OPEN+UNASSIGNED Troubleshoot tickets were in that class on
the dev mirror (2026-08-19), i.e. the majority of the pool. Now stamped as
`dispatch_runs.bucketless_dropped` + `dispatch_run_zones.bucketless_dropped`, **nullable** (the drop
predates the counter, so 0 on a historical row would claim a measurement nobody took). Kept apart from
its two neighbours because they route to different teams: `unassignable` = the engine looked and found
nobody (Ops), `withheld_below_threshold` = it deliberately did not look yet (policy), `bucketless_dropped`
= it could not look (data). **Neither of the last two is rendered anywhere yet — the transparency zone
card projects neither → #252.**
**Mode switch**: `SoftInactiveCountService.modeForZone` — soft-inactive count > threshold% ⇒
DEFICIT, else PREVENTIVE (#40); PREVENTIVE appends the INSTALL backlog (REQUESTED+UNASSIGNED,
`installSort`: tier → rank → oldest backlog) after TROUBLESHOOT candidates (#75).
**Candidate order per plant** (ADR-0001, `candidate-selection.service.ts:13-17`): strict precedence
DEDICATED → MULTI_PLANT (both `se_coverage`) → FLOATING (`plant_eligible_floating_se` MV), fallback
to next tier when hard-filtered out.
**Effective company tier** (#157, S1–S5): the tier driving canonical sort key 1 is the *effective*
tier from the shared resolver `effective-tier.ts` — the newest ACTIVE, **unexpired**
`company_tier_overrides` row for the candidate's (company, zone) (stacking allowed, newest-wins),
else the global `companies.company_tier`. CSM/ZM create these scoped, expiring overrides (mandatory
reason, ≤2-month expiry) at the role-variant **Tier Overrides** admin page
(`apps/admin/src/pages/admin/TierOverridesPage.tsx`, route `/tier-overrides`; ZM own-zone, CSM/OH any
zone), which doubles as the monthly report and badges the live winning override per pair. Reads
predicate on `expires_at`, never the swept `status`, so an override goes inert the instant it expires
regardless of the hourly `business-tier-override-expiry` sweep (§3g). Ticket creation stamps the
effective tier onto `tickets.company_tier`; existing tickets are never re-stamped (Q-B, live reads
only). The extended authority (OH global; CSM/ZM scoped + expiring) is recorded in `CONTEXT.md`
(Company Master + OH persona) and PRD story 54 (#157 AC-8). Because overrides key on `(company,
zone)`, a #158 plant zone move silently re-attaches them: the extended `zoneChangeImpact` now names
the winning overrides a move **detaches** (current zone) and **attaches** (target zone) for the
plant's open-ticket companies, surfaced in the Plant Zones confirm dialog (AC-9). **#157 is complete
(S1–S6); the plant-ranking half remains split out — Q-F.**
**Hard filters** (`hard-filters.ts:40-47`, first-failure-wins) and their **actual data feed**
(`recommender.service.ts:147-157`):

| Filter | Drop condition | Feed today |
|---|---|---|
| VEHICLE_ON_TRIP | readiness = ON_TRIP | **Stubbed `'UNKNOWN'` constant** (`:152`) — Issue 28 VU is a ZM review flow, not wired as a feed; this filter can never fire in production |
| SE_UNAVAILABLE | not (`engineer_master.is_active` AND current `se_availability` window = AVAILABLE) | real (`se-availability.service.ts`) |
| OVER_CAPACITY | assigned-today count ≥ `engineer_master.daily_capacity` | real — **whole-day** count (NEW-A1 fix 2026-07-21): the per-run `assigned` map is seeded from `committedDayLoad(day)` (non-removed `batch_assignment_tickets` across ALL the SE's ACTIVE `work_schedules` for the run day), so cap is enforced across zones + prior runs + intraday inserts, not just this zone-run. **#269 (2026-08-20) moved that predicate to `src/scheduling/committed-day-load.ts` as the ONE definition** — the recommender delegates to it and so does every manager read, so what a dispatcher is shown is what this filter enforces (pinned by `capacity-overload-visibility.e2e-spec.ts`, which runs a dry-run of the real recommender against the picker payload). It had forked twice before: `EngineersQueryService` counted the same thing with **no date filter**, `ZmScheduleRow.ticketCount` counted one schedule rather than one day; both are retired. Since #178, `removed_at IS NULL` also excludes work that has finished. |
| COMMON_KIT_INCOMPLETE | `se_van_stock` fails `common_kit_definition` min quantities | real (`InventoryService.commonKitStatus`) |
| COMPONENT_UNAVAILABLE | expected components OOS | **Stubbed `true`** — expected-component leg is open #51 |

Activity-ping staleness is deliberately NOT a filter (CONTEXT decision revised 2026-06-09,
`hard-filters.ts:9-13`).
**Scoring** (`scoring.ts`): weighted components `company_priority_rank` (A=1.0, B=0.9…),
`dispatch_urgency` (bucket severity 0..1), `repeat_failure_penalty`, `distance` (floating), plus
PREVENTIVE-only `repeat_failure_bonus`/`device_age` (inactivity/7d); Plant Cluster Multiplier
(default 1.25) on additional same-plant tickets; active weight set from `priority_rule_config`
(default `v1`; PREVENTIVE looks for `<set>_preventive`, else code defaults). SE-Planner entry =
soft bias among eligible candidates (ADR-0022).
**Canonical sort** (ADR-0017, `canonical-sort.ts`): Tier desc → Bucket desc → PriorityRank asc →
Oldest-inactive asc → DeviceID asc; `processing_rank` persisted.
**Output**: one `recommendations` row per ticket — SUGGESTED (with scoreBreakdown + weightSetRef +
mode) or UNASSIGNABLE (never silently dropped); one-SUGGESTED-per-ticket partial unique (#100).

### 3f. Batch dispatch (#11/#100)

**Algorithm** (`batch-assignment.service.ts:41-130`): single `$transaction`: (1) per-zone
`pg_try_advisory_xact_lock(hashtext('dispatch_zone_<id>'))` — non-blocking; a concurrent dispatch
skips with `{0,0,0}` (`:57-62`); (2) load SUGGESTED recs with SE, canonical `processingRank` order;
(3) group SE → plant → tickets; (4) create ACTIVE `work_schedules` + AUTO_ASSIGNED
`plant_batch_assignments` (stop-sequenced) + `batch_assignment_tickets` (sort-ordered); flip each
ticket `FORMALLY_ASSIGNED` (leaves shared pool); (5) consume recommendations SUGGESTED→DISPATCHED —
second call returns `{0,0,0}` (idempotent). Day-plan notifier events buffered in-tx, fired
post-commit (`:44-46`). Durable backstops: the three partial uniques (one-SUGGESTED-per-ticket,
one-ACTIVE-schedule-per-se/zone/day, one-active-batch-per-ticket). Graceful P2002 handling.
Verified by 4 specs added with #100 (INDEX.md:97; suite 920 pass at that commit).

### 3g. Schedulers (#97-A1 / #108 / #113)

All in-process `@nestjs/schedule`; cron expressions resolved from env **once at decorator
evaluation** (flag flips need a restart — `integration-scheduler.service.ts:46-47`); the
enabled/dormant gate is re-checked every tick; every handler has a per-name single-in-flight guard
and never throws out of cron context.

**Two timezone regimes, and the difference is load-bearing.** The `business-*` sweeps on
`BusinessSweepSchedulerService` are registered **unpinned** — correct for cadences that mean "every N
minutes" and mean nothing in wall-clock terms. Every job whose semantics are *a business hour or a
calendar day* is pinned to `Asia/Kolkata` instead (`BUSINESS_TIMEZONE`), because no `TZ` is set in any
compose/Dockerfile/env here and an unpinned daily cron fires in host time: #240's bug, where `0 4 * * *`
landed at 09:30 IST — **after** the 05:00 IST dispatch it was supposed to precede. The intended daily
chain is 03:30 → 04:00 → 04:30 → 05:00, and where it is pinned it is asserted behaviourally (absolute
next-firing instant) rather than by reading back stored options. `scheduler-wiring.e2e-spec.ts` pins the
**exact** registered cron-name set (18) against the real `AppModule`, so a job that stops registering is
a test failure.

**One link in that chain is still unpinned: `plant-eligibility-refresh`** (`:59` — no `timeZone`), and
its own docstring shows the confusion, calling `30 4 * * *` "04:30 UTC … shortly before the default
05:00 dispatch tick". 05:00 dispatch is **IST** (23:30 UTC), so on a UTC host the refresh fires at
10:00 IST — five hours *after* the batch it exists to feed, which consumes a `plant_eligible_floating_se`
MV up to a day stale. Same defect #240 fixed for closure, still live here → filed as **#254**.

| Cron name | Default | Env override | Master switch | Calls |
|---|---|---|---|---|
| `ingestion-telemetry` | `*/30 * * * *` | `INGESTION_TELEMETRY_CRON` | `INGESTION_SCHEDULER_ENABLED` | `ingestTelemetry()` = snapshot→recompute→ticket-create |
| `ingestion-masters` | `0 2 * * *` | `INGESTION_MASTERS_CRON` | `INGESTION_SCHEDULER_ENABLED` | `syncMastersTick()` |
| partition maintenance | daily tick inside ingestion scheduler `[INFERRED — gated separately]` | — | `PARTITION_MAINTENANCE_ENABLED` | `PartitionMaintenanceService.tick()` |
| `vu-auto-resume` **(IST)** | `30 3 * * *` | `VU_AUTO_RESUME_CRON` | `BUSINESS_SWEEPS_ENABLED` | #247 `VehicleReturnResumeService.sweepReturnedVehicles` — OPEN vehicle reports whose authoritative `expected_from` has reached today's IST day: primary SLA resumed, interval folded in once, batched `VU_SLA_AUTO_RESUMED` SYSTEM audit. Reason-checked (a `WAITING_COMPONENT` pause is never touched) and idempotent through that same check. **Does not resolve the report** (Decision 16) |
| `schedule-closure` **(IST)** | `0 4 * * *` | `SCHEDULE_CLOSURE_CRON` | `BUSINESS_SWEEPS_ENABLED` | #147 S2 + #242 — yesterday's plans to `COMPLETED`/`PARTIAL` under the per-zone dispatch lock, recycling unresolved assignments (`PLAN_EXPIRED`) |
| `plant-eligibility-refresh` **(UNPINNED — see #254)** | `30 4 * * *` | `PLANT_ELIGIBILITY_REFRESH_CRON` | `BUSINESS_SWEEPS_ENABLED` | #138 S3 — `REFRESH … CONCURRENTLY` on `plant_eligible_floating_se`, meant to run before the morning batch consumes it. On a UTC host it fires **after** it |
| `business-dispatch` **(IST)** | `0 5 * * *` | `BUSINESS_SWEEP_DISPATCH_CRON` (bootstrap only — `system_settings.dispatch_cron` is the source of truth, #213) | `BUSINESS_SWEEPS_ENABLED` | `DispatchRunService.runForActiveZones` (per active zone: runForZone → dispatchForZone, per-zone error contained) |
| `business-verification` | `*/5 * * * *` | `BUSINESS_SWEEP_VERIFICATION_CRON` | `BUSINESS_SWEEPS_ENABLED` | verification sweep |
| `business-install-verification` | `*/5 * * * *` | … | 〃 | install first-ping sweep |
| `business-intraday-timeout` | `*/2 * * * *` | … | 〃 | `sweepTimeouts` |
| `business-cross-zone` | `*/15 * * * *` | … | 〃 | `sweepAutoEscalations` |
| `business-repeat-escalation` | `*/15 * * * *` | … | 〃 | repeat escalation |
| `business-tier-override-expiry` | `0 * * * *` | `BUSINESS_SWEEP_TIER_OVERRIDE_EXPIRY_CRON` | 〃 | tier-override expiry sweep (#157 S4): ACTIVE→EXPIRED past `expires_at` + `TIER_OVERRIDE_EXPIRED` audit — status-truth only, resolver keys on `expires_at` |
| `business-soft-inactive` | `0 6,18 * * *` | … | 〃 | soft-inactive snapshot |
| `business-system-efficiency` | `30 1 * * *` | … | 〃 | previous-day cube |
| `business-fleet-uptime` | `0 3 1 * *` | … | 〃 | previous-month cube |
| `business-root-cause` | `15 3 1 * *` | … | 〃 | previous-month cube |
| `business-zm-performance` | `30 3 1 * *` | … | 〃 | previous-month cube |

(Defaults: `business-sweep-scheduler.service.ts:27-36`, `dispatch-cron.ts:16-19`,
`schedule-closure-scheduler.service.ts:18`, `plant-eligibility-refresh-scheduler.service.ts:10`,
`vehicle-return-resume-scheduler.service.ts:19`, `integration-scheduler.service.ts:21-23`.) **All three master switches default OFF.** Manual HTTP
triggers (`POST /api/integration/run-pipeline`, `POST /api/schedules/dispatch-run`, per-sweep
POSTs) drive identical code paths with no cron.

### 3h. Manual scheduling / override / intraday / cross-zone (ZM & CSM/OH paths)

- **Assign Work Console** (#273/P9, `GET /api/schedules/assignable-work` +
  `AssignableWorkQueryService`): the M→N surface the manual paths never had. Every other entry in this
  section is N→1 — many tickets, one engineer, written immediately, no preview and no residual — and
  none of them shows a count. The console reads the pool (company → plant, with the assignable count,
  the device denominator, critical+, oldest-silent and held), drafts against it client-side, shows the
  residual live, and commits. **`src/ticketing/assignable-work.ts` is the one predicate** it shares
  with `assignPlants`, so the count and the write cannot drift; `heldTickets` is its reported
  complement, never a subtraction. Selection is **plant-shaped** in slice 1 because `assignPlants`
  is — a shared site's whole set moves, which the ledger counts and the row states. #274–#277 add the
  candidate column, the transactional `assign-batch`, Distribute, and absorb the orphaned surfaces.
- **ZM override engine** (#13a, `override.service.ts` header): each action (reassign/split/remove/
  defer/reorder) commits immediately, flips batch + schedule to OVERRIDDEN with mandatory reason +
  overrider, audits in-transaction, fires a push. No approval gate. Overriding work an SE is ON_SITE
  on goes through the conflict seam (`soft-state-conflict.ts`).
- **Return-date deferrals are overridable, never bypassable** (#249, Decision 17). `assignTicket`
  refuses a ticket held to a future `deferred_until` with `CONFLICT_DEFERRED` (409) carrying the
  deferral date and, when a report exists, the SE's `proposed_from` beside the authoritative
  `expected_from`; `confirm: true` + a non-empty reason proceeds, writes `OVERRIDE_DEFERRED_ASSIGN`
  naming what was overridden, and **spends** the deferral the way dispatch does. The VU report is left
  untouched — overriding the hold is not deciding the return date. Move actions
  (REASSIGN/SPLIT_BATCH/SWAP_SE) carry the same gate as defence in depth and **preserve** the deferral;
  REMOVE/DEFER/REORDER are deliberately outside it. The rule lives in `assignTicket`, so the same-day
  ADD leg and every other caller inherit it. Deliberately the existing `CONFLICT_ON_SITE` mechanism
  (same 409 shape, same confirm+reason, same admin banner) rather than a second confirm vocabulary.
- **Same-day update** (#31, `same-day-update.service.ts` header): ZM add/remove/reorder mid-shift;
  applies immediately (no SE acceptance); logged `MANUAL_ZM_UPDATE`; the **Intra-day Queue is a view
  over AuditLog** (2026-06-25 decision — no new model); reuses the #13 override engine.
- **Intraday CRITICAL insertion** (#29/#30, `intraday-insertion.service.ts`): CRITICAL+ bucket fires
  `fireForZone` → best AVAILABLE candidate by strict precedence (ping staleness never filters) →
  `intraday_insertions` PENDING_ACCEPTANCE offer (10-min `ACCEPTANCE_TIMEOUT_MIN`) + push +
  first-class SE_ACCEPTANCE WhatsApp record. Accept → `assignTicket(insertAtTop)` (top of Day Plan);
  decline (reason code) or timeout → reroute to next SE, `retry_chain` appended; 3 retries →
  ESCALATION_REQUIRED + ZM "Manual assignment needed" (`availableSesForManualAssign`/`manualAssign`).
  **Accept-vs-timeout race guarded** by `transitionOrConflict` + the one-live-offer partial unique
  (#101 leg, commit `9940534`).
- **Cross-zone escalation** (#32, `cross-zone-escalation.service.ts`): `sweepAutoEscalations` —
  Platinum unassigned 1h in CRITICAL+ or 4h OPEN → one AUTO_PLATINUM row to the CSM/OH queue;
  ZM `flag` for Gold/Silver (manual). Decider approve (target zone + SE → cross-zone assignment) /
  deny (reason; ticket stays home) / defer (review date); home-ZM `reEscalateToOps` on denied AUTO.
  Ticket never leaves its home queue. **Read-model gap**: `listForScope` omits DENIED AUTO rows, so
  the home ZM can't see the row to re-escalate (#93 open).

### 3i. Field loop: troubleshoot → verification → install/recovery/non-op → inventory

- **Troubleshoot submission** (#16, `troubleshoot-submission.service.ts` header): one transaction —
  Ticket OPEN→VERIFICATION_PENDING, cycle OPEN→SUBMITTED, SE's active soft states resolved, audit +
  lifecycle event; idempotent on `(se_id, client_submission_id)` (duplicate returns the original,
  `duplicate=true`). `component_unavailable=true` → auto-raises a `component_request`, cycle →
  WAITING_COMPONENT, primary SLA pauses (#22). It also **resolves** any OPEN vehicle report (#245 AC5)
  and deliberately does not resume the clock — see the stranded-pause edge under #253 below.
- **The primary SLA clock: two pausers, two resumers, one reason check** (#247). It pauses for
  `WAITING_COMPONENT` (the line above) or `VEHICLE_UNAVAILABLE` (filing a report), and `fileReport`
  refuses to re-pause an already-paused cycle, so whichever reason was standing survives. Resuming now
  mirrors that: `resumeSla` (the manual path) and `VehicleReturnResumeService` (the 03:30 IST sweep,
  the only *automatic* resumer) both clear a pause **only when its reason is `VEHICLE_UNAVAILABLE`** —
  before #247 the manual path cleared any pause, so resolving a vehicle report on a component-paused
  cycle silently restarted the clock on a ticket nobody could work. The reason check is also what makes
  the sweep idempotent: after the flip the cycle is not paused, so the next night finds nothing.
  Auto-resume does **not** resolve the report (Decision 16). The **secondary** clock is derived from
  `failure_cycles.opened_at`, is structurally unpausable, and is manager-only by type omission.
  **Known edge → [#253]**: a submission that resolves a vehicle report *before* the return date leaves
  the cycle paused with no automatic resumer left, since the sweep only looks at OPEN reports.
- **Verification** (#18, `verification.service.ts` header): re-entrant scan of VERIFICATION_PENDING
  tickets; Phase 1 = first ping ±500 m of the SE's form GPS (skipped without fraud when
  `presence_source=NONE`), Phase 2 = continued pinging; terminal outcomes CLOSED /
  FAILED_VERIFICATION / PARTIAL_RECOVERY transition ticket + cycle, resolve inventory
  PRE_VERIFICATION → DEDUCTED or ROLLED_BACK (#24), and set `fraud_flag` for the review page (#19).
  Driven by the #108 5-min sweep (or HTTP).
- **Install lifecycle** (#33/#34/#102, `install-lifecycle.service.ts` header): manual create (single
  or all-or-nothing CSV with line-numbered errors) → SCHEDULED → ON_SITE → FITTED (serials + photo)
  → ACTIVATED → first-valid-ping auto-verification within 24h → CLOSED, else FAILED_ACTIVATION
  (late ping still closes). Zone scoping (#102, `f48108f`): ZM clamped to home zone, SE own-ticket
  read, CSM/OH/WM cross-zone.
- **Non-Op** (#35): dual confirmation (manager + customer tokenised email) → CONFIRMED side-effects:
  auto-close open tickets `CLOSED_NON_OPERATIONAL`, eligibility exclusion, auto-create RECOVERY
  ticket for qualifying RECURRING deals; OH 7-day no-response override.
- **Recovery** (#36/#37): SE collection form (serial + condition) → COLLECTED → WM receipt
  auto-close (`AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`); unable-to-collect → ZM decision queue; manual
  closure classified by acting role; stalled-14d Action-Required flag.
- **Inventory / van stock** (#21/#24/#73, `inventory.service.ts` header): `se_van_stock` read-only
  to the SE, mutated only via the ledger; common-kit completeness feeds the hard filter;
  Component-Blocked Queue for kit-incomplete drops; business 409 on already-closed ticket →
  loser's consumption recorded SHADOW_USE → WM reconciliation; `zone_warehouse_stock` manual WM
  set/adjust + fulfillment-SLA read.

### 3j. Auth / session / RBAC

**Backend**: HS256 JWT `{user_id, role, zone_id}`, 15-min access (`token.service.ts:19`), 30-day
single-use rotating refresh with reuse detection. Both stores are now **Postgres-backed** (#91 S1–S4,
2026-08-03): `auth.module.ts` provides `PrismaUserStore` + `PrismaRefreshTokenStore`, credentials live
in `user_credentials` (scrypt), sessions survive a restart, and `src/auth/user-store.ts`
(`InMemoryUserStore`) has been **deleted**. The four per-zone ZM accounts — `zm.north`/`zm.south`/
`zm.east`/`zm.west` (zones 1–4) — plus OH/CSM/WM/SE (#133, 2026-07-20) now live in
`src/auth/auth-fixture-seed.ts`; the guard chain clamps each ZM to their `zone_id`.
**Correction (2026-08-04):** this paragraph previously said the dev *seed* carries those accounts. It
does not — `seedAuthFixtureUsers` is called only from `test/global-setup.ts`, i.e. against `fsm_test`.
**Closed by #194 (2026-08-13):** `npm run seed:dev` (`src/seed-dev.ts` → `src/auth/dev-seed.ts`) is
the committed dev entrypoint that was missing. It reuses the same fixture list — so the eight
accounts a spec logs in as and the eight a browser logs in as are the same rows — and is **default-off
in every environment**: it requires `ALLOW_DEV_SEED=true` and is refused outright under
`NODE_ENV=production`, which the flag cannot override (`src/auth/dev-seed.config.ts`). It preflights
that the operational zones exist, because a ZM seeded against an unseeded database gets a null
`zone_id` and becomes a login that authenticates then 403s everywhere; the enforced order is
migrate → `seed` → `seed:dev` → start. `src/seed.ts` is untouched: the wall that keeps a real-database
seed from minting `*@fsm.test` credentials stands, and #194 built the other half rather than relaxing
it. Runbook: `docs/runbooks/local-development-login.md`. Before this, a clean clone could start the
backend and still have every login 401 (`user_credentials` measured empty on the dev DB, 0 rows) with
no diagnostic — #91 S4's in-memory retirement had removed the implicit dev-login provision without a
replacement, and `test/dev-seed.e2e-spec.ts` is now the tripwire against that regressing again.
~~`JWT_ACCESS_SECRET` falls back to a hardcoded dev secret~~ **closed by #98
(done 2026-07-12, 4 slices `25a46d4`…`55183e6`): fail-fast boot config (no JWT fallback), public
liveness/readiness probes, graceful shutdown + fatal bootstrap guard, global exception filter with
error correlation ids (pino swap deliberately not adopted — Nest Logger retained).**
Guard chain AuthGuard → RoleGuard → ZoneScopeGuard is now **global `APP_GUARD`** (#99, done
2026-07-13 `aaf233e`): every route authenticates by default, `@Public()` opts out (login/refresh,
health probes, non-op customer confirm — allowlist pinned by the route-sweep e2e). A global
`ValidationPipe` (whitelist/forbid/transform) + cross-zone format DTOs turn body garbage into 400s;
explicit `BODY_LIMIT_JSON` (1mb) + `INSTALL_CSV_MAX_ROWS` (1000) cap payloads.
`ZoneScopeGuard` rejects a ZM targeting another zone via `:zoneId`/`zone_id` param (403
ZONE_SCOPE_VIOLATION); **deeper zone clamping is service-level and uneven** — e.g. install scope
was only closed by #102; cross-zone/CSM acting scope threads through `acting-context.ts` +
`RequestActor` (#47). No rate limiting anywhere (#110): `/auth/login` scrypt is a CPU-DoS vector.
**Admin FE session** (#109, done): single-flight rotating refresh on 401 with one retry
(`apps/admin/src/api/http.ts`), reload rehydration via `/me` behind a loading gate, honest login
errors; tokens in memory/storage (httpOnly-cookie upgrade deferred to #91).

### 3k. Admin FE architecture

React 18 + Vite + React Router (`AppRoutes.tsx`, ~100 route/element entries) behind
`ProtectedRoute` + `RoleRoute` role gates mirroring backend `@Roles`. Data layer: one thin typed
client per backend area (`apps/admin/src/api/*.ts`, 29 modules) over the shared `http.ts`
interceptor — **no react-query/SWR; hand-rolled hooks** (`hooks/index.ts`). Pages compose the
design-system primitives (`components/data/` DataTable/MetricStrip/PageHeader…, `components/ui`,
`components/overlay`, chart kit per `DESIGN-SYSTEM.md`). **Selector contract**: FE-series reskins
preserved test ids/aria-labels; vitest suite (200+ tests) asserts against them.
**No mock-data remnants found in pages** (`grep -rl "mock" apps/admin/src/pages` = 0 hits) — all
pages consume real API clients; remaining gated placeholders are *documented omissions* wired to
missing backend endpoints (#90 work-type mix, #94 ticket chrome, #74 scorecard causality).
Known FE gaps: `window.prompt` reason legs (#80), Playwright visual baseline (FE-00 partial),
`components/data/` untracked by git (#114).

**#273 the Assign Work Console — slice 1 (done, 2026-08-20):** `/assign` exists, gated to manager
roles, and the top-bar **Assign SE** button opens it — it called `navigate('/')` for its entire life,
a prominent button on every manager screen that opened nothing. The console answers the question none
of the **seven** existing assign surfaces could: *how much is left?* Work pool (company → plant, with
`open / devices`, critical+, oldest-silent and held counts) → client-side draft lanes → a running
ledger (`open · in draft · left after commit · critical+ in draft`) → commit. **Nothing is written
until commit** (#272 R2), which is what makes the residual live rather than retrospective; the draft
is **session-local** and says so on screen (#272 Q2). Backed by `GET /api/schedules/assignable-work`
and, crucially, by **one predicate** — `src/ticketing/assignable-work.ts` — that the read and
`assignPlants` share, so the number on screen is the number the button moves (#272 R3). Two structural
facts drive the shape: `plants` carries **no `company_id`** (several companies' fleets sit at one
site), so the tree groups by the *ticket's* company; and `assignPlants` is **plant-shaped**, so
drafting one company's row at a shared site commits every company's work there — the ledger counts the
whole plant and the row says so, rather than under-reporting its own commit. Ticket-level selection,
the transactional write, Distribute and the orphaned surfaces follow in #274–#277. **Acting-zone is
honoured on this surface** (inline collapse from the committed `RequestActor` + the shared
`authHeaders()` client, both halves together) rather than waiting for #239's sweep: on a screen about
what is left in *this* zone, an acting OH reading pan-India is about to hand out another zone's work.

**#269 capacity is visible on the admin (done, 2026-08-20):** `daily_capacity` shipped with Issue 13b
and was rendered in **zero** places — it had no numerator, so an overload today was discoverable only
by counting an SE's batch rows by hand. The backend now supplies `committed` from the one
`committedDayLoad` definition the recommender enforces against, and five surfaces render
`committed / dailyCapacity`: the **SE Planner grid** (a rightmost `Load / Cap` column plus an
`Over Capacity` KPI tile — both drawn in v2 reference 16 and built to the image), the **Batch Schedule
list** (joined from `/schedules/engineers`, deliberately *not* from `ScheduleRow.ticketCount`, which
counts one schedule rather than one day), the **SE Management directory** (its bare "Active Tickets"
column gained the denominator), and the **assign pickers** — Critical queue, Swap/Reassign/Split
targets, commissioning cohort, and the Device-Detail `AssignSePanel`. (The cohort picker's own line
lands with the **uncommitted #236** work — that control does not exist at HEAD, so its three lines
could not be committed with #269.) One vocabulary behind all of
them: `lib/capacity.ts` (`isOverCapacity` / `formatLoad` / `engineerOptionLabel`) + `ui/LoadBadge`,
so no surface can answer "is this engineer full?" with its own inline comparison. Marked at
`committed >= dailyCapacity`, matching the engine's own `OVER_CAPACITY` drop. **Visibility only** —
#258 Q2 rules manual overload an administrative right, so nothing here disables an option, blocks a
button or interposes a confirmation, and that is pinned by test on both the admin and backend sides.

**#160 admin table & chrome UX pass (done, 2026-07-27/28):** `TopBar` renders a real breadcrumb
(`shell/breadcrumb.ts` `resolveBreadcrumb`, off `buildNav` + a small detail-route table) — the former
"FSM Command Console" eyebrow + stale `PAGE_TITLES` prefix table are retired. Every `DataTable`
(38 render sites) plus the two bespoke drill-downs (`CompanyPlantTable`, `ZoneDispatchTable`) gained a
leading, non-sortable `S.No.` column and one table-level download control (`TableDownloadButton`, a
Radix dropdown over CSV/Excel/PDF/PNG) — a deliberate DOM read (`lib/tableExport.ts`), not a data-model
read, so the export can only ever contain what is already rendered (the zone-scoping proof) and always
matches the on-screen post-filter/post-sort view (fixing a real bug: every #122-era export silently
ignored the active column sort). The five page-level `ExportMenu` instances this made redundant were
removed.

**#176 dashboard KPI transparency (done, 2026-07-29):** every operational count on the dashboard —
fleet KPI strip, zone rows, company×plant rows, Fleet Directory companies and plants — is now selected
by a **single shared SQL fragment**, `FLEET_COUNT_COLUMNS` in `dashboard.service.ts`, differing only in
`GROUP BY`:

```
mirroredDevices      COUNT(*)
operationalDevices   COUNT(*) FILTER (WHERE is_departed = false)
warehouseDevices     COUNT(*) FILTER (WHERE is_departed = true)
inactiveOperational  COUNT(*) FILTER (WHERE is_departed = false AND is_inactive AND sla_bucket IS NOT NULL)
healthyOperational   COUNT(*) FILTER (WHERE is_departed = false AND NOT (is_inactive AND sla_bucket IS NOT NULL))
```

This closed a live correctness defect: the zone/company denominators had **no `is_departed`
predicate** while their numerators excluded departed devices structurally (§3c forces
`is_inactive = NOT departed AND …`), so `inactive / total` mixed populations — pan-India 3,476 / 23,238
against a 17,415 "Active Fleet" KPI. Warehouse stock is uneven (West 14.7% departed, South 39.4%), so
it **re-ordered the Zone Performance Scorecard**: South showed 21.4% inactive against an actual 35.2%.
A latent second defect went with it — zone/company rows were built from the *inactive* query, so an
entity at 100% health vanished from the table and its devices dropped out of the column totals; rows
are now driven by the counts query (company×plant 135 → 205 live).

Current pan-India funnel (dev DB, master sync run 90): catalog **50,270** → mirrored 24,225 (−26,045
never mirrored) → on live plants 23,238 (−987 deactivated plants) → operational **17,415** + warehouse
**5,823**; operational splits 13,939 healthy + 3,476 inactive. New `GET /api/dashboard/fleet-composition`
serves that funnel with every drop named; a ZM's copy omits the catalog steps (the source counter has
no zone attribution).

Naming is now explicit per Part 9 of the operator spec: **AutoPlant Catalog** (was "Total Devices",
now carrying its sync timestamp), **Operational Fleet** (was "Active Fleet"), **Inactive Operational**
(was "Inactive / Total"). `apps/admin/src/lib/kpiCatalog.ts` is the single source of truth for every
KPI's definition / exclusions / source table / refresh trigger / formula, rendered in-product by
`components/data/KpiInfo.tsx` on every card and counted column header, and restated with the SQL in
**`docs/kpi-definitions.md`**. The reconciliation identities are enforced over the whole database by
`apps/backend/test/dashboard-kpi-reconciliation.e2e-spec.ts` (14 tests), not by a fixture.

**#193 zone drill-down enrichment (done, 2026-08-04):** `/reports/device` is no longer only a device
table. When it is entered with a single numeric `zoneId` — the Zone Performance Scorecard's row
click-through — `ZoneDrilldownSection` renders above the table: the v2 reference's scope-chip band
(zone · active status · snapshot stamp, previously never built), a six-card KPI strip, an operational
composition bar, ranked plants, the SLA spread, and the **reused** `CompanyPlantTable`. Everything is
scoped by the page's live `zoneId` + `status`; the aggregates load in parallel with the device list and
neither gates the other. Two rules are deliberate and load-bearing: a **zero row is kept** (sorted
last, dimmed) because a plant with no inactive devices is a result rather than an absence, while an
all-zero SLA **column** under an ACTIVE-only scope *is* dropped; and a `zoneId` of `UNZONED` or none
renders an **explanation instead of numbers**, never a silent fallback to all-zones (see #192 — the
word names two different device populations across surfaces).

Backend additions are additive and manager-roled: `company-plant-overview` gained a `zoneId` filter
ANDed with the ZM clamp (a ZM requesting a foreign zone gets `[]`), and a new
`GET /api/dashboard/zone-operations?zoneId=&status=` serves the one thing nothing served —
assigned/unassigned open work, live batches, overridden batches and SEs engaged for a zone. It reuses
the Device Detail list's live-ticket status set and `removed_at IS NULL` batch link (now a named
constant) so it cannot disagree with that table's per-row assignment column, and filters `status`
through the same `FLEET_COUNT_COLUMNS` inactive predicate above rather than a second spelling of it.
The clamp lives in the service because the global `ZoneScopeGuard` inspects `:zoneId` route params and
the `zone_id` query spelling — not `zoneId` — the same posture `activityTrend` already takes.

**#217 Operations Data Explorer, Slice 1 (done, 2026-08-06):** a new OH-only, **read-only** surface —
route `/ops-explorer`, module `apps/backend/src/ops-explorer/` — whose purpose is to walk any rendered
number back to the rows that produced it, for debugging/reconciliation/audit rather than reporting.

Gated **twice**: `@Roles` from the single constant `OPS_EXPLORER_ROLES` (`ops-explorer-access.ts`) and
the `OPS_EXPLORER_ENABLED` env flag, which **defaults off in every environment** and makes every route
return **404, not 403** — a disabled diagnostic tool should not confirm its own existence. No sixth RBAC
role was added: CONTEXT.md:28 is explicit that no Admin persona exists, and the one-constant allow-list
is what makes a future `PLATFORM_DEVELOPER` a one-line append instead of a redesign. A second flag,
`OPS_EXPLORER_DEVELOPER_MODE` (on outside production), adds the lineage layer — source column, SQL
expression, formula, endpoint, per-query timings, bound parameters, raw response — **stripped
server-side** in `serializeDataset`, so with it off those fields are absent from the payload rather than
hidden in the client. The guard reads both flags **per request** (unlike the cron schedulers, which
resolve once at decorator evaluation), so an operator can turn the tool on mid-incident without a bounce.

The engine is a **dataset registry** (`dataset-registry.ts`) plus a pure builder (`dataset-query.ts`):
a dataset declares its FROM/JOIN and its columns with full provenance, and a new dataset is a registry
entry — no new controller, service or route. The injection boundary is the registry lookup: a request
names a column by `key`, the builder resolves it or 400s `UNKNOWN_COLUMN`, and the SQL emitted is the
code-authored fragment from the registry while every value is bound. LIKE metacharacters are escaped,
`eq`/`neq` against null route to `IS [NOT] NULL`, `neq` is `IS DISTINCT FROM`, and an empty `in` list
becomes an explicit `FALSE`. The builder is DB-free and carries 36 unit tests, deliberately: #156
established the e2e suite is not a reliable green/red signal, and these are the properties that must not
regress. Export is **server-side and streamed** — #160's `TableDownloadButton` DOM read is right for an
operational table but structurally cannot export past the rendered page, and this is the app's only
server-paged table.

Reconciliation (`reconciliation.service.ts`) evaluates five identities over the whole database — zone
roll-up and company roll-up against the KPI strip, plus the three structural partitions — reporting both
sides, **how each side was measured**, the signed difference, and ranked candidate causes on failure. It
**imports** `FLEET_COUNT_COLUMNS` and `EXCLUDE_DEACTIVATED_PLANTS` from `dashboard.service.ts` (both
newly exported for this) rather than restating the predicates: a checker written from a second spelling
only verifies that the second spelling agrees with itself, which is the defect class #176 closed.

Slice 1 shipped the `devices` dataset. **Slice 2 (same day) grew it to 11 datasets** —
`zones`/`companies`/`plants`/`vehicles` (FSM + AutoPlant master data), `engineers`, `tickets`,
`batches`, `dispatchRuns`, `recommendations`, `auditLogs` (operational state, dispatch, audit trail) —
purely as registry entries over the unchanged S1 engine: zero new routes/controllers/pages. Each
drilldown targets an **existing** route (`/schedules/:engineerId`, `/tickets/:ticketId`,
`/batches/:batchId`, `/dispatch-runs/:runId`, `/reports/device?{zoneId,companyId,plantId}=`), confirmed
by reading each target page's actual param contract; `auditLogs` gets no drilldown (`entityType` varies
row to row with no single safe target).

**S2 found and fixed a real S1 defect**: `devices.plantName`'s drilldown needed the plant's numeric id
but the column *displays* `plants.name`, so `:value` was silently substituted with the wrong thing;
`devices.deviceId`'s drilldown target read no `deviceId` param at all. Fixed with
`DatasetColumn.drilldown.valueSql` — an optional companion SQL expression projected as a hidden
`__dd_<key>` row field, so a column can display one value and link on another without a second visible
column. `serializeDataset` strips it in both modes (a raw-SQL field, not a Developer Mode field) —
caught by a new test after the first pass only *documented* that promise without enforcing it.
`deviceId`'s broken link was removed rather than left pointing nowhere; `zoneName`/`companyName` on
`devices` gained real drilldowns as a result.

**Reconciliation gained a 6th identity, `dispatchBatchLedger`**
(`Σ dispatch_runs.batches = COUNT(plant_batch_assignments) WHERE run_id IS NOT NULL`) — deliberately a
batch-ROW check, not a ticket-count check, because `batch_assignment_tickets.removed_at` reflects
legitimate ZM overrides and a ticket-level identity would FAIL chronically for correct business reasons.

**S3 shipped re-scoped**, with the operator's sign-off: not a 12th browsable AutoPlant dataset (the
original plan), but **reuse of the existing** `AutoPlantHealthService.reconciliationHealth()`
(`ingestion/autoplant/health.service.ts:219`) — already a live source-vs-FSM row-COUNT diff for plants
and vehicles behind `/api/integration/health` (review A6/#97 Slice 5). A bulk per-row browsable dataset
would have duplicated it while risking the **DBA's <100-row-per-query cap** every other AutoPlant read
in this codebase respects (master sync pages at ≤90 rows/query for the same reason) — a live filterable
table over that source does not fit that cap. `reconciliationHealth()` was made public and injected by
having `OpsExplorerModule` **import** `IngestionModule` (not re-`useFactory`'d locally, which would
have been the exact "silent duplicate singleton" #105 documents elsewhere) — the reconciliation panel
gained 2 identities (`autoplantPlantsCount`/`autoplantVehiclesCount`, 8 total) and a third
`IdentityStatus`, `UNAVAILABLE` — distinct from `FAIL`, since "could not be checked" (no VPN, env
unconfigured) is not the same claim as "checked and disagrees"; `ReconciliationReport.status` never
flips to FAIL on UNAVAILABLE alone. Verified deterministically: `test/setup-env.ts`'s allowlist (#182)
deletes every `AUTOPLANT_MYSQL_*` var for the whole e2e suite, so "unconfigured" is the real state of
every test run, not a mock of one.

Issue #217 is **closed** — S1–S3 done. Final verification 2026-08-06: backend unit **44** + e2e **18**
(was 16) green, `dashboard-kpi-reconciliation` regression **14** green, the pre-existing
`autoplant-health`/`integration-health-*` specs (12 tests) unaffected by the visibility change, admin
**94 files / 442 tests** (was 441) green, both apps `tsc --noEmit` clean.

**Post-close follow-up (2026-08-06, operator ask on the `plants` dataset):** 7 new registry columns, no
engine change. `companyNames` (scalar `STRING_AGG` over `vehicles ⋈ company_master` at the plant, since a
plant has no direct company FK — company only reaches a plant transitively through its vehicles) is both
displayed and added to `searchColumns`, giving "filter plants by company name" for free through the
existing `contains`/`eq` filter UI. `vehicleCount`/`deviceCount` are scalar-subquery counts (`vehicles`/
`device_states` at `plant_id`) — deliberately subqueries, not a join, so the dataset's one-row-per-plant
grain can't fan out. `deployedVehicleCount`/`undeployedVehicleCount` split on `vehicles.status`, reusing
`OPERATIONAL_DEPLOYMENT_STATUSES` from `master-mapping.ts` (the same allow-list `isOperationalStatus`
uses) rather than a second hardcoded list, so "deployed" can't drift between the master sync and the
Explorer. `activeDeviceCount`/`inactiveDeviceCount` mirror `FLEET_COUNT_COLUMNS.healthyOperational` /
`.inactiveOperational`'s predicates (`is_departed = false` and `is_inactive`) — same population definition
as the dashboard, not a restatement. Verified against real dev data (not just the empty test fixture):
`RCP-9211` returns 2,457 vehicles / 2,475 devices / 1,400 deployed / 1,057 undeployed / 1,508 active / 253
inactive, and a `companyNames contains "Nuvista"` filter correctly narrows 930 plants to 23. Backend unit
+ e2e suites (64 tests) still green; rebuilt and restarted against the session's isolated dev backend
(`:3011`) for live verification.

**SLA severity ramp (app-wide, same change):** the eight bands are now an ordinal ramp carried by
**lightness first, hue second**, so severity survives red/green colour blindness. The previous
eyeballed ramp did not: `EARLY_RISK`/`RISK` sat 0.01 apart in OKLab L (ΔE 2.7 under deuteranopia —
indistinguishable) and `SEVERE`/`HIGH_CRITICAL` ΔE 7.1 apart *with full colour vision*, while overall
lightness ran non-monotonically so "darker" did not mean "worse". The replacement is monotone with
≥0.06 steps, script-validated, and keeps PRD:302's green→red heat coding (semantic heat being the
sanctioned multi-hue sequential exception, always shipped with a legend). Dark-mode steps are
**selected against the dark surface**, not flipped — the deep-red end previously fell to 1.27:1 on the
near-black canvas. Both ramps live in `index.css` as `--sla-*`; `lib/slaBucket.ts` exposes them as
`BUCKET_COLOR` (theme-aware, for charts) and `BUCKET_HEX` (light literals), and `BUCKET_CLASS` badges
now draw from the same tokens, so a bucket cannot be one colour in a table and another in the chart
beside it.

---

### 3l. Commissioning cohort & install quality (#232) — backend live, no UI

`GET /api/reports/commissioning/cohort` and `/installers` (`reports.controller.ts`, both
`@Roles(...MANAGER_ROLES)`, ZM clamped to their own zone and told so via `scopedToZoneId`), served by
`CommissioningAggregationService` over `device_commissioning ⋈ device_states`. **No new module, no new
table**: cohort membership is derived (`installed_at >= now() - N days`), so nothing moves a device
between states and a device ageing out of the window requires no write.

> **Amended 2026-08-13 (#233) — the cohort had no operational-fleet predicate, and now it does.** Every
> count on both endpoints defaults to `population=operational` (`device_states.is_departed = false` plus
> the **imported** `EXCLUDE_DEACTIVATED_PLANTS`); `population=all` reproduces the previous behaviour for
> reconciliation. Before the fix a device returned to a warehouse — silent because it is in a box —
> was graded a **failed install**: live `fsm` over 90 days read **6,810 fitments / 2,655 failed (39.0%)**
> against **2,623 / 136 (5.2%)** once departed devices are excluded, 4,187 of the window's fitments
> being warehouse. Same defect class as #176, in a new surface, invisible because no screen calls these
> endpoints. The payload now carries a `population` census
> (`fitmentsInWindow = operational + warehouse + deactivatedPlant + unmirrored`, the last computed as a
> remainder so the partition holds by construction) so every drop is named. `FLEET_COUNT_COLUMNS` was
> **not** modified — only imported. Report: `docs/progress/233-commissioning-population.md`.
>
> The validation that found it is also new infrastructure: **`test/probes/` + `vitest.probe.config.ts`**,
> a lane for checks that run against the live dev mirror, kept structurally outside the suite's
> collection glob because they assert properties of mutating data and cannot be a green/red gate.
> #232's AC-2 ("validate against live `fsm`") had sat unexecuted for three days behind 35 green fixture
> tests that could not have caught this, every fixture device being operational.
>
> **Also 2026-08-13 (#234) — the cohort payload carries a `resolution` curve**: % online by hours since
> fitment (bands 4/12/24/48/72), as `count(*) FILTER (…)` columns on the *same* `GROUPING SETS` pass —
> no second query, no new endpoint, no new table, no job. It is the only cohort trend FSM can honestly
> compute today; the calendar-time inactivity series stays **deferred with its precondition stated**,
> because #229's auto-recovery has still never run and 1,799 of the operational cohort's 2,183
> `failure_cycles` are `OPEN`, which would make any calendar series rise as a scheduler artefact.
> Two exclusions make it correct and both are reported rather than silent: **maturity** (a fitment
> younger than the widest band cannot be graded against that band) and the **epoch gate applied
> symmetrically** — pre-epoch fitments leave the curve whatever they did. The first cut excluded only
> the pre-epoch fitments that came *online* and read **37.2% online-by-48 h against a true 83.1%**;
> every fixture passed and only the live probe showed it. Live today: 83.1% by 48 h and flat after,
> `curve=65 (sample 56 + never 9)`, `preEpochExcluded=2040`, 520 immature of 2,625, **26 ms** at the
> 90-day ceiling. The pre-epoch contamination ages out with no backfill — once the epoch passes 90 days
> (~2026-11-07) no cohort window can contain a pre-epoch fitment. Report:
> `docs/progress/234-commissioning-resolution-curve.md`.

Three things a reader of these numbers has to know, all of them counter-intuitive:

- **Online is `device_states.first_reported_at`, never `device_commissioning.first_reported_at`.** The
  latter is an observation-time snapshot, populated on **371 of 25,387 rows** (corrected 2026-08-13 —
  the figure here previously read "0 of 24,294"; later syncs snapshot the value for devices that have
  since begun reporting, which is exactly why it is provenance and not outcome). A reader requiring
  both to agree reports almost nothing as commissioned.
- **Fitments before `COMMISSIONING_TTFR_EPOCH` count as installs but contribute no *timing* sample.**
  The write-once column captured a last-seen value for devices already reporting when it landed —
  15,345 of 23,086 stamped on the day it shipped, 2,138 stamped before their own `installed_at`, median
  TTFR ~8,707 h against 17.26 h for fitments observed after. Never-online stays meaningful across the
  whole history, because a null stamp means the device has not pinged since the epoch either.
- **There is no commissioning tail.** 96.97% of genuine new installations report within 12–24 h and the
  curve is flat after, so silence past the grace cutoff is `failed`, not `pending`. This is an
  install-quality surface, not a fault queue.

Request windows are capped (`COHORT_DAYS` ≤ 90, `GRACE_HOURS` ≤ 720, `LOOKBACK_DAYS` ≤ 365) as a
**measured** performance contract, not taste: bounded shapes hold the index plan (6.8/9.7 ms today,
62.7/172.1 ms at 4× the one-year projection), while an unbounded lookback abandons the index and spills
the `GROUP BY` to disk at 1,078 ms. No index fixes it — the cost is the sort forced by the
`count(DISTINCT …)` aggregates, and the best of three candidates bought 9%.

~~**Not built: any admin surface.**~~ **Built 2026-08-13 — #232 is done and the parity-gate item is
closed.** Route `/reports/commissioning` (Analytics nav, `MANAGER_ROLES`), built to
`docs/ui/desktop/v2-reference/21-reports.png` and composed **entirely from existing primitives** —
the predicted "new bucket-histogram component" turned out to be `BarList` over pre-computed
percentages. Presentation only: nothing is recomputed in the browser, because the population
predicate and the "came online" definition live in one SQL expression. Three rendering rules are
correctness rather than polish and each is pinned by test — a null median renders **"—" never 0**
with `sampleSize` on the card; installer logins are **shown and labelled, never ranked as people**;
and the window says **"last 90 days", not "3 months"** (the ceiling is 90 and a 92-day request 400s).
The page also states its census (`6,810 in window = 2,623 operational + 4,187 warehouse + 0 + 0`) and
its curve basis, so a reader reconciling against AutoPlant is not left concluding the page is broken.
`kpiCatalog` gained 6 entries and `docs/kpi-definitions.md` a §8 written from them. Admin suite
**456 tests / 95 files** green. Reports: `docs/progress/232-commissioning-admin-surface.md`,
`233-commissioning-population.md`, `234-commissioning-resolution-curve.md`.

**Drill-through (#235, done 2026-08-13):** one optional `commissionedWithinDays` param on
`GET /api/devices`, and links out of the cohort's plant rows into `/reports/device`. **No migration,
no index, no new endpoint.** Its substance is `src/reports/commissioning-window.ts` — the cohort
report iterates fitments (`FROM device_commissioning`) while the device list filters devices
(`EXISTS (…)`), so the **window predicate** is shared and "recently commissioned" has exactly one
definition; the two surfaces are one click apart and a second spelling would show two answers to one
question. Grain differs by design and is stated on both — the cohort counts **fitments**, the list
counts **devices**, and 6.4% of cohort devices carry more than one fitment in 90 days.
Report: `docs/progress/235-commissioning-drillthrough.md`.

**Still open:** neither page has **ever been opened in a browser against a live backend**; both are
proven by tests over payload shapes taken from the live probe's real output, which is not the same as
having watched them render. The *reason* is gone as of 2026-08-13 — #194 landed `npm run seed:dev`,
so a dev login is now reproducible on any machine — but the eyeball pass itself has not been done.
Full investigation: `audit/recently-commissioned-devices-investigation-2026-08-13.md`.

---

## 4. DOCS vs CODE RECONCILIATION

Method: every issue file's `Status:` line was extracted (`grep -H -m1 "^Status:" issues/*.md`,
138 files) and compared against INDEX.md and against code evidence from §3. INDEX.md (updated
2026-07-09) proved **accurate on every entry spot-checked** (evidence for #100/#101/#102/#108/
#112/#113 re-verified this session: `transition-or-conflict.ts` exists and is adopted only by
intraday; `dispatch-run.service.ts:46 runForActiveZones`; the partial uniques in `20260708120000`/
`20260709120000`; the cron tables in §3g). **The issue FILES lag the INDEX** — the index was
updated without touching the files.

### 4.1 Issue files whose `Status:` line is STALE (file says ≠ verified reality)

| Issue file | File claims | Verified status | Correction |
|---|---|---|---|
| `02-org-reference-config-settings.md` | ready-for-agent | done in practice — org module + Settings shipped; ACs closed via #45/#46/#47 (all done) | mark done, note AC ownership |
| `28-vehicle-unavailability-dual-sla-clocks.md` | ready-for-agent | accepted core (INDEX.md:72 — VU report + dual clocks + ZM review, backend+admin; `vehicle-unavailability.service.ts` exists) | mark accepted-core; residual → #64/#65 |
| `31-zm-manual-same-day-update.md` | ready-for-agent | accepted core (INDEX.md:75; `same-day-update.service.ts` exists) | mark accepted-core; mobile cues → #66 |
| `45-plants-admin-ui.md` | ready-for-agent | done (INDEX.md:163; `org/plants.controller.ts` + admin Plants tab) | mark done |
| `46-company-update-api-ui.md` | ready-for-agent | done (INDEX.md:164; `PATCH /org/companies/:id`) | mark done |
| `49-device-deal-type-column-tagging.md` | ready-for-agent | done (INDEX.md:167; deal-type tag endpoint + FE-22 admin control) | mark done |
| `62-ticket-detail-components-tab.md` | ready-for-agent | done (INDEX.md:172) | mark done |
| `69-admin-install-create-ui.md` | ready-for-agent | done (INDEX.md:179; `/install` route + `api/install.ts`) | mark done |
| `FE-21…FE-25` (5 files) | ready-for-agent | done (INDEX.md:280-284, dated 2026-06-29/07-01; routes + tests exist in `apps/admin/src/pages/reports/`) | mark done |
| `FE-12-schedules-batch-parity.md` | done, "badges → **#71**" | badges follow-up was **renumbered #79** at the 2026-06-28 integration merge (INDEX.md:189) | fix stale cross-ref |
| `FE-16-recovery-nonop-queues-parity.md` | done, "Modal upgrade → **#72**" | renumbered **#80** (INDEX.md:190) | fix stale cross-ref |

Consistent (no correction needed): all remaining files match INDEX/code — includes the done set
(04–16, 18/19, 29/30, 32–44, 47/48, 72/73/75, 100/102/108/109/112/113, FE-01–08/10–20/26), the
partials (21, 101, FE-00, FE-09), the open backlog (17, 20, 50, 54–61, 63–68, 71, 74, 76, 77,
81–95 present, 98/99, 103–107, 110/111, 114), and the gated ones (91 needs-triage, 96/97
ready-for-human tails, 88 needs-info).

### 4.2 Issue numbers with INDEX entries but NO file in `issues/`

`#51, #53, #70, #78, #79, #80, #95` are described in INDEX.md (some at length, e.g. #70 done,
#78 done-core) but have no `issues/NN-*.md` file. #70/#78 are done so only history is missing;
**#51, #53, #79, #80, #95 are OPEN work items that exist only as INDEX prose** — they should get
stub files or be explicitly tracked as index-only. (Correction applied in the finale: noted in
INDEX.md header.)

### 4.3 Major documents

| Document | Claim vs reality | Verdict |
|---|---|---|
| `CLAUDE.md:5` | "…backend (Postgres 16 + PostGIS + Prisma, **Redis/BullMQ, S3**)" — no Redis/BullMQ/S3 dependency exists (`package.json`; #97 note "No Redis/BullMQ") | **wrong** → correct the stack line |
| `.scratch/fsm-platform-v1/INDEX.md` | funnel table, activation checklist, per-issue notes | **accurate** (spot-checked; last verified 2026-07-09) |
| `docs/PRD-fsm-admin-dashboard.md:293` | "**Data layer (current): Static mock data** in the admin data directory drives all pages" | **wrong/stale** — all admin pages consume real API clients (§3k); needs a banner note |
| PRD generally | roles, SLA buckets, page inventory, invariants | accurate as *requirements*; unimplemented rules listed in §4.4 |
| `docs/workflow/fsm-business-technical-workflow.md` | 2,253-line business workflow; §14 offline queue, §21/22 hints/QR, §24 workers | accurate as spec; **describes subsystems that do not exist yet** (§4.4); its §25 "suggested tables" superseded by the real schema (§2) |
| `docs/audits/2026-07-03-backend-production-readiness-audit.md` | 13 findings | **partially superseded** — #1 scheduler, #4 reaper, #6 recompute/partitioning, MySQL timeouts RESOLVED since (re-audit + INDEX.md:88-93); rest live as #98–#107 |
| `docs/audits/2026-07-07-independent-production-readiness-reaudit.md` | re-verified all findings, filed #108–#111 | **accurate** |
| `docs/audits/2026-07-07-production-validation-audit.md` | live end-to-end run: 438 s pipeline, 0 orphans; 83% UNZONED; auth in-memory; Fleet-Uptime empty (no PGI); session TZ `Asia/Calcutta` | **accurate** — the strongest runtime evidence in the repo |
| `docs/audits/unzoned-plants-2026-07-07.md` | zone-completeness inversion (ACTIVE plants lack zone_name) | accurate `[spot-checked header only]` |
| `docs/architecture/autoplant-integration-progress-tracker.md:7` | "Last verified 2026-07-03 · HEAD `b45d00b`" | **stale** — ~40 commits behind; phase marks predate #97 slices 2–7, #100–#113 | 
| `docs/architecture/autoplant-integration-session-handoff.md` | session handoff from the same era | **stale** — superseded by `docs/HANDOFF-autoplant-ingestion-2026-07-07.md` + `97-PROGRESS.md` |
| `docs/architecture/backend-engineering-review-2026-07-05.md` | Part III A1–A6 remediation plan | **implemented** — all six landed as #97 slices (INDEX.md:42); mark as executed |
| `docs/HANDOFF-autoplant-ingestion-2026-07-07.md` | 5 commits, partition/ingestion pairing warning | accurate; its "pending" items partially closed since (#108/#112/#113) — needs a pointer |
| `.scratch/…/issues/97-HANDOFF.md` | already banner-marked SUPERSEDED 2026-07-09 | accurate (self-corrected) |
| `docs/progress/*` (49 files) | per-issue TDD reports + dated handoffs | historical records — no correction; do not treat any as current state |

> **Doc consolidation applied 2026-07-12:** every superseded handoff/progress-board above (the two
> stale `docs/architecture/` tracker/handoff files, `docs/HANDOFF-autoplant-ingestion-2026-07-07.md`,
> `97-HANDOFF.md`, the 11 dated handoffs + `FE-enterprise-ui-parity.md` from `docs/progress/`, and the
> four consumed `.scratch` planning artifacts) now lives in **`docs/archive/`** with ARCHIVED banners.
> Per-issue TDD reports stay in `docs/progress/` as frozen completion records. The progress convention
> going forward is in `CLAUDE.md` ("Progress & state convention").

### 4.4 Business rules in PRD/workflow that the code does NOT implement

1. **The SE mobile app** (PRD §SE-Mobile screens :479-663; workflow §11–§14): substantially built as
   of 2026-08-04 — foundation/shell, Home, Tickets, Ticket Detail + soft-states, Troubleshoot form,
   Verification, Stock/Vouchers, Vehicle Unavailability, same-day plan cues, Recovery screens, Install
   screens, intra-day accept/decline, Notifications, Leave Request, Availability (#54–#61, #63/#64/
   #66/#68/#71/#77/#85/#86/#87, #81) are done. `.scratch/fsm-platform-v1/INDEX.md`'s Session log is
   the live status source — do not re-derive from this line. Still unbuilt: Push (#89).
2. **Offline-first queue + batched sync** (PRD :309-310 WatermelonDB/SQLite; workflow §14):
   nothing client- or server-side; server API is #82, client #17.
3. **QR scanner + Technical Hints** (PRD §SE-QR/§Hints; workflow §21/§22): no code; needs #83
   (ticket search) + #84 (hints derivation) then #20.
4. **Push / WhatsApp / SMS / email actual delivery** (PRD :311, workflow §23): recorded in
   `notification_deliveries` via the gateway seam but **no external adapter sends anything** (#76).
   The PRD's "WhatsApp shown as sent — first-class" is honored in data (`first_class=true`).
5. **SAP PGI feed** (PRD Fleet-Uptime eligibility; workflow §7): `pgi_history` has no writer (§2.2);
   eligibility falls back to the `all-deployed` proxy only if Ops flips the setting (#112 shipped
   the mechanism, the feed itself has no owner issue — see §5 new stub).
6. **Media upload** (photos on troubleshoot/voucher/install): `photo_refs` columns exist; no
   upload/storage API (#81). S3 mentioned only in CLAUDE.md (wrongly).
7. **Vehicle readiness from AutoPlant LR-Date/Next-Trip** (workflow §9, PRD readiness hints):
   recommender readiness is stubbed UNKNOWN (§3e); source integration → #65.
8. **Expected-component hard-filter leg** (workflow §15): stubbed pass (#51).
9. **Warehouse replenishment / auto-decrement** (workflow §16 inventory lifecycle): warehouse
   on-hand is manual-set only (#95).
10. **Outcome-causality ZM scorecard metrics** (PRD §OH-Analytics): #74 — needs a
    decision→outcome linkage model that doesn't exist.
11. **EXPECTED_BACK readiness state** (v2 reference): deliberately omitted (FE-14, INDEX.md:269).
12. **Daily-status source for SE profile** (PRD M8d): still `needs-info` (#88).

### 4.5 Code behaviors the PRD/workflow do NOT describe (doc additions needed)

- The **zone-mapping crosswalk + UNZONED holding zone + per-plant override** machinery (§3a) —
  the workflow doc still assumes plants arrive zoned.
- **`eligibility_mode` setting** with the `all-deployed` interim proxy (#112) and its audited flip.
- **FSM-owned plant deactivation** (#119, §3d) — the workflow doc assumes every synced plant is
  serviceable; deactivation + cancel-open-tickets semantics exist only in code/issue file.
- The **three ops master switches** + per-sweep cron env matrix (§3g) and the
  ingestion↔partition-maintenance coupling rule.
- **Master-sync skip accounting** (`master_sync_rejects`) and `/api/integration/health`
  source-vs-FSM reconciliation.
- **Advisory-lock + consume-on-dispatch idempotency** design of batch dispatch (#100).
- **In-memory auth store** reality (PRD assumes real users; validation audit documents shared
  password dev store).
- The **Intra-day Queue = AuditLog view** decision (2026-06-25) — workflow §10 implies a table.
- **Repeat window = 24h from VERIFIED closure** (ADR-0021) — workflow §8 leaves the window vague.

---

## 5. GAPS, WEAK POINTS, BREAKING POINTS (ranked)

Ranked by blast-radius × likelihood once the funnel activates. Each cites its owner issue; two NEW
findings from this audit are filed as **#115** and **#116** (stubs in
`.scratch/fsm-platform-v1/issues/`).

> **2026-08-09 — the fleet-health state model WAS wrong in two measured, partly-cancelling ways.
> BOTH ARE NOW FIXED, in one slice, backend + admin.** The description below is kept as the record of
> what was wrong and how it was established; the resolution follows it. Added out-of-band rather than
> renumbering the ranked list below; by blast radius these sat around items 3–5. Both were found by
> reconciling AutoPlant against an operator-verified Excel and confirmed by an independent blind read
> (`audit/cross-analysis.md`).
>
> - **[#222] Every stored GPS timestamp is 5.5 h early.** `AUTOPLANT_UTC_OFFSET_MIN = 330` is wrong —
>   AutoPlant writes **UTC** into its naive `DATETIME` columns, measured two independent ways (95
>   snapshot runs flat in a 5.52–5.65 h band; `FIRST_INSTALLED_DATE_TIME` agreeing to the minute with
>   a `TIMESTAMP` column in the same row across 17,985 devices). Impact: **434 devices falsely
>   inactive (16.2% of the queue), all 434 holding an open TROUBLESHOOT ticket**, and 434 of the 665
>   `CRITICAL` devices fabricated (65% of the band). The `+330` was wrong when written; the 2026-07-17
>   verification that "confirmed" it used a fleet-wide `MAX()`, which is decided by **4 devices out of
>   56,564** that genuinely write IST. **Not a one-line constant change** — flipping it without the
>   two-directional skew guard makes those ~5 IST-writers read as permanently fresh (negative
>   inactivity clamped to 0 at `device-state.service.ts:100`), i.e. never inactive, never ticketed.
> - **[#223] Devices that have never reported are counted as healthy.** `healthyOperational` is the
>   *negation* of inactive, so `latest_gps_datetime IS NULL` lands in healthy by construction —
>   **913 devices**, all of them also `eligible_for_uptime` with no failure cycle, therefore scoring
>   **100% Fleet Uptime**. 892 verified at source as genuinely never having reported; 602 (66%) were
>   fitted over a year ago. The NULL *was* guarded at `device-state.service.ts:108` but never followed
>   through to consumers, and **§"Healthy Operational Devices" in `docs/kpi-definitions.md` then
>   hardened the binary on purpose** — *"the identity holds by construction"* — which is the sentence
>   that made a third state unrepresentable. **Operator decision 2026-08-07: a fitted tracker that has
>   never reported is a fault** — counted inactive, ticketed, dispatched.
>
> **They partly cancel, which is why they shipped together** (operator decision): Fleet Health read
> **82.96%** → 81.90% with #223 alone → 85.72% with #222 alone → **84.84%** correct. #223 alone moves
> the number *down* and reads as a regression caused by a bug fix.
>
> ---
>
> **RESOLVED 2026-08-09 — #222 + #223 landed as one slice.** What changed:
>
> - **`AUTOPLANT_UTC_OFFSET_MIN = 0`** and the pinned test that asserted `330` is gone, replaced by a
>   contract test that maps a wall clock through `mapVehicleMasterRow` against a **literal** expectation
>   — an assertion computed from the constant would now be satisfied by any value.
> - **Two-directional skew guard (P6).** The future tolerance is tightened 24 h → **1 h**, in the same
>   release as the constant, so the ~5 genuine IST-writers are **rejected** rather than reading as
>   permanently fresh. Rejections are counted per chunk on `SourceChunk.rejected` and logged — a drop
>   is only "visible as a gap" if something looks. The past arm is a **sentinel floor (year 2000)**, and
>   deliberately not the fleet-percentile guard #222 proposed: a ping older than p99 is not implausible
>   data, it is the finding this platform exists to produce. Catching a *systematic* shift needs a
>   per-run distributional check, which is [#228]'s R2 and is not built here.
> - **Three-state fleet model.** `operational = healthy + inactive + neverReported`, with both rates now
>   taken over **`reportingOperational`** (operational − never-reported) — operator decision P3:
>   never-reported devices are excluded from Fleet Health, not scored 0%. The three predicates are
>   defined once in `dashboard.service.ts` (`HEALTHY_OPERATIONAL`, `INACTIVE_OPERATIONAL`,
>   `NEVER_REPORTED_OPERATIONAL`) and imported by every consumer rather than respelled.
> - **`never_reported` is derived at read time, NOT a stored column** — a deliberate deviation from
>   #223's own design. `latest_gps_datetime` is maintained at **ingest** while a stored flag would be
>   written by the **recompute**, so between the two a stored flag would say "never reported" about a
>   device that had just come alive.
> - **`DeviceStateService.recompute` ages a never-reported device from `MIN(device_commissioning.installed_at)`**
>   (P1), with the 24 h grace window falling out of the existing `inactivity_threshold_hours` for free
>   (P2 — no new setting; 48 h was considered and declined on the measured evidence, recorded in #223).
>   MIN not MAX, because the device has produced nothing under any fitment and `tb_vehiclemaster`
>   rewrites fitment in place.
> - **All six read surfaces** from `cross-analysis.md` §2.3 now exclude never-reported devices from
>   "healthy"/"active": KPI strip, Fleet Directory filter, device-list `status` filter (which gains
>   `NEVER_REPORTED`), **Fleet Uptime**, the soft-inactive denominator (fixed *via* the state layer, by
>   design — see the note in that service), and the entity-mapping export (new `never_reported` column).
> - **The Fleet Uptime exclusion is applied in the aggregation, NOT by clearing `eligible_for_uptime`** —
>   that flag is also the ticket-creation gate, so clearing it would have silently cancelled P1 and left
>   the 892 confirmed-NDD devices unticketable. Two decided requirements pulling opposite ways through
>   one shared flag.
> - **`reconciliation.service.ts`'s `operationalPartition` identity is no longer a tautology.**
>   `neverReported` is measured independently rather than as anyone's complement, so the check can now
>   fail on data. A second, honestly-labelled `reportingPartition` carries the structural check.
> - `docs/kpi-definitions.md` amended **in place**, including a correction of the "the identity holds by
>   construction" paragraph that made the third state unrepresentable.
>
> **Still true and expected:** `soft_inactive_count_history` holds denominators snapshotted under the old
> definition, so trend charts show a **step discontinuity on the fix day** — documented, not a regression.
>
> ~~**Not done, deliberately, and NOT blocking:** `device_commissioning` is **empty in the dev DB** (0 rows)
> because no master sync has run since its migration landed…~~ **SUPERSEDED 2026-08-13.** That state is
> gone: master sync **117** ran on 2026-08-10 (the operator's `run-pipeline` press — see [#230]/[#231])
> and `device_commissioning` now holds **~24,294 rows**. So #223's *coverage* acceptance
> ("`installed_at` ≥ 99% of operational devices") and the fleet-wide 84.84% figure are measurable
> locally now and **have not yet been measured** — the data arrived through an event nobody planned as
> the verification run, which is why the check did not happen with it.
>
> One consequence worth naming, because it is not obvious from the row count: of those 24,294 rows,
> **0 carry `first_reported_at`**. That column is an observation-time snapshot — a later first ping does
> not retro-fill an older row — so it is provenance, never outcome. Anything asking "did this device
> come online?" must read `device_states.first_reported_at` instead (see §3l).
>
> Two data-loss findings sit inside the same population: **[#226]** 15 of those 913 have live
> telemetry at source that FSM stored NULL over (14 pinged within 24 h) — and 15 is only the slice
> visible from a NULL, so the true radius is unmeasured; **[#227]** 6 are absent from
> `tb_vehiclemaster` entirely, whose disposition must be decided **once, jointly with [#220]**.
>
> **[#228] is the cross-cutting finding and the reason this section needed a callout at all.** Each of
> the three defects found in two days had a guard that could not fail in the direction its bug
> travelled: #218's `@Optional()` cannot fail on absence, #223's `healthy + inactive = operational` was
> a **tautology** (`reconciliation.service.ts` said so out loud) that stayed green over 913
> misclassified devices, and #222's skew guard rejected only the **future**. Compounded by a suite that
> tested the system against its own beliefs — `autoplant-mapping.spec.ts:131` **asserted the wrong
> constant**, pinning it.
>
> **Three of the four specimens are now closed by the #222+#223 slice** (the tautological identity, the
> one-directional skew guard, and the pinned-constant test). #228 itself stays open: its four remedies
> — R4 boot-time DI resolution test, **R2 per-run distributional source-contract fingerprints**, R1
> empirical identities, R3 typed zeros — are unbuilt, and R2 is the one that would actually have caught
> #222 on 2026-07-07. Nothing in this slice substitutes for it.
>
> **[#229] filed 2026-08-09 while satisfying the operator's pre-application gate on #222.** Answering
> "what is the expected auto-recovery closure count" surfaced that **the sweep never runs**:
> `runAutoRecovery()` has no `@Cron`, no route and no CLI caller — its only call site is a spec — and
> `ticket_events` holds **zero `CLOSED_AUTO_RECOVERY` rows** across 42,955 transitions. **11,042 of the
> 12,571 open TROUBLESHOOT tickets (87.8%) already satisfy the sweep's own predicate today**, 9,888 of
> them on devices that are healthy right now. The #222 timestamp fix moves that number by **+5**, so the
> queue overstatement is a pre-existing condition and must not be attributed to this slice. That 12,571
> baseline is quoted in both #222 and #223 and is **not** a count of broken devices.
>
> **Two of those closed on 2026-08-09.** `first_reported_at` no longer ships with zero coverage
> (`snapshot-first-reported-dualwrite.e2e-spec.ts`, 7 tests). And the typecheck blind spot has a
> lever: `apps/backend/tsconfig.test.json` covers `src/**` + `test/**`, so spec-file type errors are
> visible for the first time. **It is not yet clean and is not yet wired into `pnpm typecheck`** —
> the first run surfaced **97 pre-existing errors across ~20 spec files** (bigint/string id
> confusion, `Partial<>` spreads against required fields, enum literals). None are caused by the
> commissioning slice, and none are fixed here; `pnpm typecheck` still covers `src/**` only. Making
> `tsconfig.test.json` clean and making it the default is unowned work — see the INDEX entry.
> `autoplant-mapping.spec.ts:131` still asserts the wrong constant; #222 owns it.

1. **Auth is a dev scaffold** (#91 + #98 + #110). In-memory users/refresh tokens (restart = mass
   logout, DB users can't log in), hardcoded fallback JWT secret (`token.service.ts:18`), zero rate
   limiting on scrypt login (CPU-DoS vector, `110-…md` evidence). Blast radius: the whole product;
   nothing can be exposed beyond a demo network until #91/#98/#110 land.
2. **No deployment/DR story** (#111) — no Dockerfile/compose/runbook/backup. Compounded by the NEW
   finding **#115: `.gitignore:21 docs/*` leaves the entire PRD/workflow/audit/UI-reference doc set
   untracked** — a single-disk loss destroys the requirements + audit record, and a fresh clone
   can't even follow the documented agent workflow. (Same family as #114 `data/` shadowing the
   admin UI source, which also still makes the branch tip unbuildable from clone.)
3. **UNZONED zone-derivation problem** (data, not code) — **materially reduced 2026-07-13**: was
   83% of synced devices UNZONED (validation audit exec summary); after the zone-application
   session pinned 47 plants via `plant_zone_overrides` + reapply, UNZONED devices are
   **4,603 of 20,098 (23%)** (§6.1); **further reduced 2026-07-14** — the 6 STAR CEMENT shutdown
   plants were deactivated via #119, so the *operational* UNZONED count (what dashboards/dispatch
   see) is **3,620** (987 devices now on deactivated plants). Root cause stands: ACTIVE plants FSM
   syncs mostly lack `zone_name`, so the crosswalk (§3a) stays starved — the residual 191-plant
   worklist is `docs/audits/v2UnzonnedPlants.md` (mostly zero-vehicle depots; per-company asks with
   Ops). Remaining blast radius: ~18% of fleet invisible to ZM dashboards/dispatch until B8
   completes.
4. **PGI feed absence** — NEW stub **#116**: `pgi_history` has no writer; `pgi` eligibility mode is
   permanently 0-candidate and Fleet-Uptime is structurally empty. #112 shipped the mode switch and
   B7 records the pending decision, but no issue owned building the feed until now.
5. **#101 remaining races** (partial — only intraday accept-vs-timeout is guarded). Untreated
   confirmed sites (`101-…md:28-49`): SE-submit vs auto-recovery; two SEs submitting the same
   ticket (double stock decrement); non-op dual-confirmation stale writes (device can end
   permanently P2002-skipped); overlapping verification sweeps (double rollback of van stock;
   `markAutoRecovery` never resolves PRE_VERIFICATION inventory); `confirmResubmit` re-opening
   VERIFIED cycles; van-stock decrement from stale reads (`Math.max(0, qty-n)`) + missing
   `clientSubmissionId` persistence on the CONFLICT path (mobile retry double-decrements). Blast
   radius grows from ~zero (single operator, sweeps off) to real the day `BUSINESS_SWEEPS_ENABLED`
   flips with concurrent SEs.
6. **Perf cliffs** (#106): `criticalQueue` unbounded; all-default Prisma/pg pool with no
   `statement_timeout` (a runaway query hangs a connection); per-request dashboard scans with no
   cache. Also §3d's per-candidate transaction loop under a mass-outage spike `[INFERRED]`.
7. **Missing hot-FK indexes/constraints** (#103): `tickets.device_id`/`vehicle_id` unindexed
   (device-detail + verification lookups will seq-scan as tickets grow), `audit_logs(actor_role,
   created_at)` missing (ZM-scorecard aggregation pivots on it monthly).
8. **Module wiring forks** (#105): `recommender.module.ts` re-provides `InventoryService`/
   `SeAvailabilityService`/`SoftInactiveCountService`; `engineers.module.ts` re-provides
   `InventoryService`; `recommender.service.ts:71-73` `new`s cross-module services as constructor
   defaults. Silent duplicate singletons — becomes a correctness bug the day any of them caches.
9. **No CI** (#107): 920+ backend tests + 211 admin tests run only by hand on one OOM-prone 8GB
   box (full vitest runs randomly lose a fork worker — memory note); no from-zero-migration test,
   no concurrency suite, no route-guard sweep. Every "green" claim is a local claim.
10. **Append-only growth** (#104): `audit_logs`/`ticket_events`/`notifications`/`recommendations`
    unpartitioned with no retention — slow-burn until they aren't.
11. **No global guard/validation** (#99): a controller missing `@UseGuards` is silently public; no
    global `ValidationPipe` or body-size limits (CSV upload path).
12. **Environment integrity**: container clock drift ~5.5h + DB session `TimeZone=Asia/Calcutta`
    contradicting ADR-0025 UTC (validation audit finding 3, `:194`); AutoPlant source offset handled
    only via `AUTOPLANT_SOURCE_UTC_OFFSET_MIN`; health `ageMinutes` is clock-sensitive.
13. **Cross-zone re-escalate read-model hole** (#93): DENIED AUTO rows invisible to the home ZM —
    Issue 32's re-escalate AC only notionally met.
14. **Open funnel-quality gaps**: recommender vehicle-readiness stubbed UNKNOWN (#65) and
    expected-component leg stubbed pass (#51) — two of five hard filters can never fire (§3e table).

**New issue stubs filed by this audit**: `115-docs-tree-untracked-dr-exposure.md`,
`116-sap-pgi-feed-seam.md`. Everything else above already has an owner.

---

## 6. ACTIVATION & OPERATIONS STATE

### 6.1 Settings (`system_settings`, OH-owned, audited)

| Key | Default / effect | Current live value |
|---|---|---|
| `eligibility_mode` | `pgi` (canonical — requires PGI feed, i.e. 0 eligible today) \| `all-deployed` (interim proxy: vehicle status ∈ ACTIVE/DEPLOYED). Applied at next recompute; harmless to set while schedulers OFF | **`all-deployed`** — set 2026-07-10 via audited `PUT /api/settings/eligibility_mode` (audit id 16, OPERATIONS_HEAD). Effect verified live: 100% of inactive devices (5,505/5,505) are eligible, i.e. all sit on ACTIVE/DEPLOYED vehicles. |
| `inactivity_threshold_hours` | 24 (`device-state.service.ts:8`) | **24** (verified via `GET /api/settings`) |
| `telemetry_retention_days` | drives partition drops (`partition-maintenance.service.ts:62`) | **7** (verified via `GET /api/settings`) |
| soft-inactive `threshold_pct` | 2% default (#40) — DEFICIT/PREVENTIVE switch | not present in `system_settings` registry (defaults to 2% in code) — recommender ran in `DEFICIT` mode for every ticket this session |

> **Live funnel — activated 2026-07-10 (watched, all-manual, schedulers OFF).** First end-to-end run of
> the whole funnel against the dev DB (19,457 devices). Two watched `run-pipeline` calls → device-state
> recompute + ticket creation; one `dispatch-run` → recommender + Day-Plan dispatch; ZM override loop +
> intraday offer/timeout exercised. Scoreboard (single-moment snapshot):
> **inactive 5,505 → eligible 5,505 (100%, all-deployed) → open tickets 5,947 (1:1 with devices, 0 dupes)
> → recommended 5,765 → dispatched today 275 (13 SE Day Plans, capacity-bound at 25/SE) →
> unassignable 5,259** (`NO_ELIGIBLE_SE`; of open tickets, 1,463 have **no SE coverage** — 1,369 of them
> UNZONED, the B8 gap — and the rest are **capacity-exhausted** in covered plants).
> Mock SE workforce (dev seed, commit `0df556a`): 13 SEs / 30 coverage rows — North 1 · South 4 · East 1
> · West 3 · UNZONED 4. **Surprise:** a concurrent actor (or a runtime scheduler override — `.env` has
> `INGESTION_SCHEDULER_ENABLED=false`) ran the pipeline 4 more times mid-session (snapshot 51–54); it
> caused no duplication (idempotency held: 0 duplicate tickets) but drifted the totals. Env master
> switches confirmed OFF the whole session: `INGESTION_SCHEDULER_ENABLED=false`,
> `PARTITION_MAINTENANCE_ENABLED=false`, `BUSINESS_SWEEPS_ENABLED` unset.

> **Zone application — 2026-07-13 (B8 partially executed).** 47 UNZONED plants (10,599 audit
> vehicles) pinned via `PUT /api/org/plant-zone-overrides` (reason carries sub-zone + provenance:
> 20 Nuvista Excel(1), 20 vehicle-join, 6 EXCEL-3, 1 RISDA-family; East A/B→East, West A/B→West) +
> `POST /reapply` (`updated: 47`). Survival proven both ways: `sync-masters` run 31 (751 plants
> updated, zones untouched — insert-only upsert) and reapply #2 (`updated: 0`). 4 sub-zone synonym
> rows inserted MAPPED (fresh-install seed = #118); `sdf` IGNORED via API; `central` left PENDING
> (deliberate). Full pipeline run 32 (snapshot 19,175; device-state 20,098; 97 new tickets).
> **Devices by zone, before → after: UNZONED 16,535 → 4,603 (23% of 20,098) · East 56 → 7,015 ·
> North 174 → 3,714 · South 2,514 → 3,114 · West 794 → 1,652.** Plants: UNZONED 247 → 200.
> Audit trail: 47× `PLANT_ZONE_OVERRIDE_SET`, 2× `ZONE_MAPPING_REAPPLIED`, 1× `ZONE_MAPPING_IGNORED`.
> Residual: 191-plant worklist (`docs/audits/v2UnzonnedPlants.md`), 6 STAR CEMENT SHUTDOWN rows
> deferred to #119, admin UI gap #120.

> **Live funnel re-run — 2026-07-13, post-zone-application (watched, all-manual, schedulers OFF).**
> Mock SE workforce extended additively to the new zone weights (+9 SEs/+18 coverage rows on top of
> the 0df556a 13; now 22 SEs: East 6 · South 6 · North 3 · West 3 · UNZONED 4 — existing SEs and
> coverage untouched; every zone already had a mock ZM). `run-pipeline` (228 s): device-state
> 20,106; **tickets created 5, total delta exactly 5, 0 devices with >1 open ticket — idempotency
> held.** `dispatch-run` (16 s): **24 schedules · 567 tickets dispatched · 0 errors** (vs 13 · 275
> on 2026-07-10). Scoreboard (single-moment): **inactive 5,843 → eligible 5,843 (100%,
> all-deployed) → open tickets 6,840 → recommended 6,331 → dispatched 567 (≈95% of the 600
> capacity ceiling) → unassignable 5,764, all `NO_ELIGIBLE_SE`.**
> Per zone (schedules / dispatched / unassignable): East 7/158/1,306 · South 6/150/1,189 ·
> North 4/100/590 · UNZONED 4/100/2,455 · West 3/59/224. East went from a 1-SE afterthought to the
> biggest dispatch zone — the zone application is live in dispatch, not just in counts. Open
> tickets on plants with NO SE coverage: 814 (was 1,463) — UNZONED 407 · West 203 · East 156 ·
> South 46 · North 2. Only 1 SE / 3 plants ended up with cross-zone coverage after the plant moves
> (the 07-10 UNZONED SE whose plants are now East/North); dispatch handled it via a cross-zone
> schedule row (#100's zone_id-in-key design working as intended). Remaining unassignable mass is
> capacity (5,764 tickets vs 600/day) + the UNZONED residual — a workforce/data question, not code.

> **Plant deactivation application — 2026-07-14 (#119 slice 4).** The 6 STAR CEMENT shutdown
> plants (3040, 3530, 3078, 3529, 3619, 3187 — all zone 5/UNZONED) deactivated through the real
> OH API on the dev DB: **935 open tickets cancelled** (`OPERATIONS_HEAD_OVERRIDE_CLOSE`,
> cycles → FAILED), **UNZONED operational device count 4,607 → 3,620** (Δ 987). Each reason
> records the disputed-claim caveat (AutoPlant `mst_plant` still lists all six ACTIVE) —
> reversible via reactivate if the DB team overturns `docs/audits/shutdown-plants-2026-07-13.md`.
> Verified: LIST endpoint shows 6; #121 export reports all 987 devices `plant_fsm_status=
> deactivated`; all 6 rows survive a simulated master-sync mirror refresh (real sync VPN-blocked).

> **Device deployment lifecycle backfill — 2026-07-18 (#128 Slice 1 landed + first live pass).** The
> #128 departure mechanism (widened master read at every `deployment_status` + `device_departures`
> side table, **insert scope pinned** to DEPLOYED/ACTIVE) was applied to the working FSM DB by
> master-sync **run 64** — a *manual* `npm run autoplant:sync pipeline` at 03:28 UTC, **not** a cron:
> `INGESTION_SCHEDULER_ENABLED=false`, no runs 65+, snapshot cadence irregular. One pass marked
> **5,523 devices departed** (4,436 UNDEPLOYED + 1,079 MISSING_FROM_SOURCE + 8 MAINTENANCE; the
> inferred absence path was 5.1% of the in-scope fleet, under the 10% guard) and **cancelled 4,552
> open tickets** (`DEVICE_UNDEPLOYED_CLOSE`, #119 semantics), all audited (5,523 `DEVICE_DEPARTED`).
> `vehicles.status` is now truthful: **16,766 DEPLOYED / 4,435 UNDEPLOYED / 40 ACTIVE / 8 MAINTENANCE**
> (was 20,856 all-DEPLOYED). run 64's pipeline recompute had run via the standalone runner's settings
> stub → pgi mode → `eligible_for_uptime` transiently **0** fleet-wide (a runner quirk, not a #128
> regression; the DB setting is unchanged `all-deployed`); a corrective all-deployed recompute restored
> the honest denominator. **Before (pre-#128, 2026-07-17) → after (2026-07-18):**
>
> | metric | before | after |
> |---|---|---|
> | mirrored devices | 20,925 | 21,322 |
> | departed (active `device_departures`) | 0 | 5,523 |
> | operational (non-departed) | 20,925 | 15,799 |
> | `eligible_for_uptime` (all-deployed) | 20,925 (100% — gate a no-op) | 15,799 (operational only) |
> | `is_inactive` | ~6,000 | 2,943 |
> | open tickets on departed devices | ~3,700 (est) | 0 (4,552 cancelled) |
>
> Verification (2026-07-18): **0** departed devices are eligible / inactive / SLA-bucketed; eligible
> (15,799) **exactly equals** operational; recommender Troubleshoot + ticket-creation exclude
> active-departed (`device.departures none restoredAt:null` / `isDeparted:false`; INSTALL backlog
> deliberately not filtered); dispatch has 0 open tickets on departed. Fleet reconciles:
> operational + departed = 21,322 (the dashboards' inactive/SLA/eligible tallies already drop departed
> via `is_inactive=false`/`sla_bucket=NULL`/`eligible=false`; the *raw* fleet total keeps them, so the
> departed tally is surfaced separately → #129). Reversible (restore path + tickets closed-with-reason,
> not deleted); idempotent (a re-run dry-run found 0 new departures). Dashboards shrinking to the true
> operational fleet is the honest, correct outcome.

**Superseded 2026-08-07 — the mechanism above is correct but has not been executing.** The backfill
described was applied by *manual CLI* runs (64 and 80). On the Nest-wired path — the scheduler and the
"Run Ingestion Now" API — `MasterSyncService`'s lifecycle pass has never run: `master-sync.service.ts`
imports `DeviceDepartureService` with `import type`, TypeScript erases it, `design:paramtypes` emits
`Object`, and `@Optional()` turns the unresolvable dependency into a silent `undefined` so the pass
returns before doing anything. Runs 81–113 recorded `{inserted: 0, updated: 0}` for 27 consecutive
successful syncs, with no error and a green CI.

Measured 2026-08-07 against production AutoPlant: **4,028 missed departures + 1,130 missed restores =
5,134 contradicting devices**, and **1,050 devices silent >24 h that cannot raise a ticket** because
`is_departed` gates ticket creation. A further 1,131 devices are departed with their source row
hard-deleted from `mst_vehicle`, so their `vehicles.status` mirror is frozen and can never agree —
excluded from the drift figure by design, surfaced separately (see #220).

**Detection landed first, deliberately** ([#218](../.scratch/fsm-platform-v1/issues/218-lifecycle-drift-detection.md)
slice a): `AutoPlantHealthService.lifecycleHealth()` reports `drift` (correct value 0),
`missingFromSource`, and `quietRuns` — consecutive syncs that moved nothing, the signal that sat unread
in `entity_stats.departures`. It is a top-level field on `/api/integration/health` rather than part of
`reconciliation`, because it is derived entirely in Postgres and must stay readable when AutoPlant is
unreachable; Ops Explorer folds the same call in as a 9th identity rather than respelling it. Baseline
at ship time: `drift 5134 · missingFromSource 1131 · quietRuns 27 · healthy false`.

**The fix (218b) has landed; the catch-up window (218c) has NOT run — no production data has been
written.** The two are independent: 218b restores the wiring (value imports **plus** explicit
`@Inject()` tokens — the union parameter type erases to `Object` regardless of import style, so
neither alone suffices), which changes *future* syncs only and applies no catch-up. The dev-DB reading
after 218b is byte-identical to the baseline above, confirming exactly that. A sync that skips the
lifecycle pass now also logs a warning naming the unresolved collaborator, so the silent-skip failure
mode cannot recur unobserved. The backlog itself is cleared only by 218c, which is operator-gated and
unapproved; `npm run autoplant:window-preflight` is its programmatic precondition check.

**Amended 2026-08-09 — 218b has landed but has never been exercised here, and those are different
claims.** The fix is committed (`9c00ad6`) and proven against the real `AppModule` by
`master-sync-di-wiring.e2e-spec.ts`. But **no master sync has run in this environment since it
landed**: the dev DB still reads `drift 5134 · missingFromSource 1131 · quietRuns 27`, and
`quietRuns` is still **27** — the same 27 consecutive no-op syncs this issue was opened about, with
not one run added under the fixed code. So the accurate statement is *repaired in code, verified in a
spec that boots the production graph, and still never having done lifecycle work on the Nest-wired
path here.* This is the expected consequence of a fix that changes future syncs only while
`INGESTION_SCHEDULER_ENABLED=false` and 218c stays ungated — not a defect — but "the DI fix landed"
reads, days later, as "the lifecycle pass is working", and the dev DB says otherwise. The first sync
whose `entity_stats.departures` is non-zero is what converts *landed* into *exercised*; per
`WINDOW-PREP-2026-08-07.md`, running 218c through `POST /api/integration/run-pipeline` rather than the
CLI runner would double as exactly that proof.

**Still blocking closure:** [#224](../.scratch/fsm-platform-v1/issues/224-lifecycle-health-integration-page.md)
(the `lifecycle` field ships in the API but no admin page renders it — a CLAUDE.md parity gate, and
the deferral reason is not an external-integration blocker) and
[#225](../.scratch/fsm-platform-v1/issues/225-218-doc-deliverables.md) (the `kpi-definitions.md`
lifecycle entry and the `docs/progress/218-*.md` completion report, which should be written *after*
218c runs so it carries the window's actual readings against its own falsifiable predictions).

### 6.2 Env flags (all master switches default OFF; cron strings read once at boot)

| Flag | Effect |
|---|---|
| `INGESTION_SCHEDULER_ENABLED=true` | self-running pipeline: masters daily 02:00, telemetry */30 |
| `PARTITION_MAINTENANCE_ENABLED=true` | **must flip together with the above** — else pings pile into the DEFAULT partition after the 3-day runway and retention never runs |
| `INGESTION_STALE_RUN_MIN` | reaper threshold — set above telemetry cadence |
| `BUSINESS_SWEEPS_ENABLED=true` | dispatch cron + the field-loop/aggregation sweeps **and** the daily chain (§3g): `vu-auto-resume` 03:30 IST, `schedule-closure` 04:00 IST, `plant-eligibility-refresh` 04:30 **unpinned — #254**, `business-dispatch` 05:00 IST |
| `VU_AUTO_RESUME_CRON`, `SCHEDULE_CLOSURE_CRON`, `PLANT_ELIGIBILITY_REFRESH_CRON` | per-job overrides for the daily chain — `VU_AUTO_RESUME_CRON` and `SCHEDULE_CLOSURE_CRON` are read as **IST** expressions |
| `BUSINESS_SWEEP_*_CRON`, `INGESTION_*_CRON` | per-tick overrides (§3g table) |
| `AUTOPLANT_*` (MySQL host/creds/schemas, `AUTOPLANT_SOURCE_UTC_OFFSET_MIN`) | unset ⇒ mock/empty sources, app boots fine |
| `JWT_ACCESS_SECRET` | **required at boot** — fail-fast validation, no fallback (#98 slice 1, `25a46d4`) |
| `PORT`, `ADMIN_ORIGIN` | 3000 / `http://localhost:5173` defaults |

### 6.3 What blocks activation — classified

- **Data-blocked**: SE roster + coverage (`engineer_master`/`se_coverage` empty in prod-shaped DBs;
  admin-enterable via `/engineers/manage`, tested seed exists — commit `0df556a`); zone mappings
  (was 83% UNZONED; **23% since the 2026-07-13 application, 3,620 operational devices after the
  2026-07-14 #119 STAR CEMENT deactivations** — residual is the v2 worklist + B8 sign-off);
  `pgi_history` (needs #116 or the proxy).
- **Decision-blocked**: B7 eligibility mode (business accepts the `all-deployed` proxy or waits for
  PGI); B8 zone ratification; credential-column placement for #91 (HITL).
- **Code-blocked**: nothing in the funnel itself (INDEX funnel table, re-verified §3). Hardening
  that *should* precede real traffic: #101-rest/#103/#99/#98/#110 (§7).
- **Access-blocked (HITL)**: live-VPN runtime verification of the scheduler (#97 tail), SAP PGI
  contract (#116), external notification channel accounts (#76), deployment target (#111).

**Enable order** (INDEX.md:141-160, verified against code): (1) set `eligibility_mode`; (2) flip
`INGESTION_SCHEDULER_ENABLED` **+** `PARTITION_MAINTENANCE_ENABLED` as one switch + set
`INGESTION_STALE_RUN_MIN`; (3) flip `BUSINESS_SWEEPS_ENABLED` only once SE/coverage data exists
(else every ticket → UNASSIGNABLE). Manual HTTP triggers exercise every path with flags OFF.

---

## 7. FORWARD PLAN (corrected priority order)

**Track A — activate the funnel (no code):** A1 zone ratification + mapping entry (B8; unblocks
UNZONED); A2 enter SE roster + coverage (or run the tested mock seed in dev); A3 B7 decision →
set `eligibility_mode`; A4 flip the paired ingestion+partition switches; A5 flip business sweeps.
Risk if skipped: the platform stays a demo. Prereqs: Ops-Head availability only.

**Track B — hardening before real traffic** (order matters):
1. **#91 auth store** (+ its #109 leftover: httpOnly refresh cookie) — prereq for any exposure;
   HITL decision on credential placement. Risk: total.
2. ~~#98 boot/ops~~ **done 2026-07-12** (4 slices `25a46d4` `e61b71a` `8c3a26f` `55183e6`; pino
   swap deliberately not adopted — see issue file). Unblocks #111.
3. **#99 global guard + ValidationPipe** — closes the silently-public-endpoint class.
4. **#110 rate limiting** — with #91/#98, completes the auth surface.
5. **#101 remaining races** — before `BUSINESS_SWEEPS_ENABLED` + concurrent SEs (§5.5 list is the
   worklist; the helper + pattern exist).
6. **#103 hot-FK indexes** — cheap, before ticket volume grows.
7. **#107 CI** — before any second contributor; the OOM box makes local green unreliable.
8. **#106 perf** (LIMIT, pool, timeout, cache) → **#104 retention matrix** → **#105 wiring** —
   medium urgency, pre-scale.
9. **#111 deployment/runbook** (HITL infra target) + **#115 docs tracking policy** + **#114
   gitignore fix** — the "survives a disk failure / fresh clone" set.

**Track C — product completion:** #116 PGI feed (HITL, restores canonical eligibility +
Fleet-Uptime); #93 cross-zone read model; #94 ticket chrome enrichment; #90 report aggregations;
#79/#80 FE polish; #51 expected-components; #65 vehicle readiness source; #95 warehouse
replenishment; #74 scorecard causality; #76 notification adapters (HITL accounts).

**Track D — mobile:** #54 foundation (blocks all M-series) → #81–#84 backend deps → #55–#61,
#63/#64/#66/#68/#71/#77/#85–#89 → #17/#20.

**Issue files needing SCOPE edits** (requirements changed since writing, not just status):
- `104-…` — raw-snapshot partitioning already shipped (R3); scope shrinks to the four append-only
  business tables.
- `91-…` — add the #109 leftover (httpOnly cookie upgrade) explicitly.
- `76-…` — carries the added transactional-outbox scope (INDEX.md:120-122); reflect in the file.
- `21-…` — remaining legs are only #51 + mobile; core is long done.
- `65-…` — AC#6 authority conflict already RESOLVED (2026-06-25, INDEX.md:175); file should stop
  presenting it as open.
**Status-only corrections**: the §4.1 table (applied in the finale commit).

---

## 8. GIT / GITHUB STATE — problems, commits, pushes needed

> **UPDATE 2026-07-10 (activation session, Phase 0 — DR closeout).** The disk-failure exposure below is
> **resolved**: `feat/autoplant-integration` is now **pushed to origin** (tip `e5006ae`, upstream set,
> 0/0 divergence), with #114 + #115 fixed so the pushed branch is buildable + documented. Sequence:
> `f5a7f90` (gitignore anchors + docs/data versioned for DR, tsbuildinfo untracked), `e5006ae`
> (reviewed WIP working-tree slice), then this docs/status commit. The branch tip builds standalone
> (backend `tsc` clean; admin `tsc -b && vite build` = 962 modules). Original findings kept below for
> the record; ✅ marks what is now closed.

- **Remote**: `origin = github.com/harshshah-source/fsm-platform`. Remote had only `main`,
  `docs/ui-parity-governance`, `feat/issues-28-31-45-46-49-62`. ✅ now also
  `feat/autoplant-integration`.
- ✅ **`feat/autoplant-integration` now has a remote counterpart** — was 49 (→54 by push time) commits
  ahead of local `main`, disk-only. The whole AutoPlant integration, the hardening series #100–#113,
  the admin UI source under `components/data/`, and every doc are now on origin. #114 (`data/`
  shadowing) and #115 (docs untracked) are **done** — see their issue files + INDEX.
- **`integration/fe-plus-backend` merge line** (INDEX.md:11-19) is also local-only
  `[UNVERIFIED whether fully merged into this branch — the branch list shows it still exists]`.
- ✅ **Uncommitted working tree** (at session start): admin UI polish (overlay/shell/ui components,
  `index.css`, dashboard/device/schedule pages + tests), backend `device.service.ts`/
  `devices.controller.ts`/`zm-schedule-query.service.ts` + e2e specs. Reviewed and committed as its
  own WIP-labeled feature slice (`e5006ae`: Device Detail filter/sort/pagination + `filter-options`
  endpoint + ZM stop badges (Issue 79) + design-system refresh) — not swept into docs commits.
- ✅ **`apps/admin/tsconfig.tsbuildinfo`** — `git rm --cached` + `*.tsbuildinfo` ignore rule (`f5a7f90`).
- **Issue files without files** (§4.2): #51/#53/#79/#80/#95 exist only as INDEX prose.
- No open GitHub Issues/PR workflow is in use — the tracker is the local markdown backlog by
  design (CLAUDE.md Issue-tracker section).

---

## Appendix: completion record

Sections 1–8 complete 2026-07-10. Finale applied in commit `44a1472`: 13 issue-file status
corrections + FE-12/FE-16 renumber fixes + INDEX.md (#115/#116 registered, index-only note) +
CLAUDE.md stack-line fix. Banners added on disk to the gitignored docs (progress tracker, session
handoff, 2026-07-03 audit, 2026-07-05 review, 2026-07-07 handoff, PRD :294) — versioning them is
#115's decision. New issue stubs: #115, #116. This document supersedes all prior "current state"
claims; update it, don't fork it.
