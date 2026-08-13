# FSM Platform — Backend Code Analysis (Complete Session Record)

> **This is NOT a current-state document and must never be treated as one.**
> Per `CLAUDE.md`, `docs/SYSTEM-STATE-2026-07.md` remains the only current-state source of truth and
> `.scratch/fsm-platform-v1/INDEX.md` the only work tracker. This file is a **point-in-time
> code-reading record** produced in one analysis session: what the code actually said on the date
> below, with file references. Where it disagrees with SYSTEM-STATE, §D lists the corrections that
> should be edited **in place** into SYSTEM-STATE rather than carried here.

| Field | Value |
|---|---|
| Repository | `C:\fsm-platform-backup` |
| Branch | `feat/autoplant-integration` |
| Analysis date | 2026-08-11 |
| Subject | `apps/backend` only (admin SPA and mobile app out of scope) |
| Method | Direct source reading. No assumptions from filenames, NestJS convention, or documentation. |
| Rule applied | Code is implementation truth. Anything unconfirmed is marked **NOT VERIFIED FROM CODE**. |

**Document map**

- **Part A** — Scope of verification (what was read in full, what was not)
- **Part B** — Backend SDE Architecture, §0 → §26
- **Part C** — File deep-dives (`main.ts` at two levels, `config/boot-config.ts`)
- **Part D** — Documentation vs actual code: corrections found
- **Part E** — Explicit not-verified inventory

---

# PART A — Scope of Verification

## A.1 Read in full

`main.ts` · `app.config.ts` · `app.module.ts` · `config/boot-config.ts` · `bootstrap-guard.ts` ·
all of `common/` (3 guards, 4 decorators, `all-exceptions.filter.ts`, `request-actor.ts`,
`ist-day.ts`, `transition-or-conflict.ts`) · `prisma/prisma.service.ts` · all of `build-info/`
(`boot-guard.ts`, `build-info.ts`, `migration-skew.ts`, `runtime-lock.ts`, `run-stamp.ts`) ·
all of `auth/` (module, controller, service, `token.service.ts`, `password-hasher.ts`,
`prisma-user-store.ts`, `prisma-refresh-token-store.ts`, `acting-context.ts`) ·
`health/` (controller + service).

Ingestion: `ingestion.module.ts` · `autoplant-mysql.client.ts` · `source-reader.ts` ·
`autoplant-source-reader.ts` · `mapping.ts` · `normalize.ts` · `snapshot-ingestion.worker.ts` ·
`snapshot-ingestion.service.ts` · `snapshot-run.service.ts` · `stale-run.ts` ·
`master-sync.service.ts` · `master-mapping.ts` · `integration-sync.service.ts` ·
`integration-scheduler.service.ts`.

Device state: `device-state.service.ts` · `eligibility.ts` · `sla-bucket.ts` ·
`device-state.module.ts` · `recompute-canary.ts`.

Ticketing: `ticket-creation.service.ts` · `auto-recovery.service.ts` · `recovery-criteria.ts` ·
`troubleshoot-submission.service.ts` (first 170 lines) · `ticketing.module.ts`.

Recommender: all 6 files (`recommender.service.ts`, `candidate-selection.service.ts`,
`hard-filters.ts`, `scoring.ts`, `canonical-sort.ts`, `recommender.module.ts`).

Scheduling: `batch-assignment.service.ts` · `dispatch-run.service.ts` ·
`business-sweep-scheduler.service.ts` · `dispatch-scheduler.service.ts` ·
`schedule-closure-scheduler.service.ts` (first 80 lines) · `scheduling.module.ts`.

Other: `settings/settings.service.ts` · `audit/audit.service.ts` ·
`verification/verification-criteria.ts` · `verification/verification.service.ts` (first 130 lines) ·
`shared-pool/se-coverage.service.ts` · `me-tickets/se-ticket-access.ts` ·
`ops-explorer/ops-explorer-enabled.guard.ts` · `ticketing/tickets.controller.ts` ·
`zones/zones.controller.ts` · `notifications/notifications.controller.ts` ·
`exports/exports.controller.ts`.

Non-source: `prisma/schema.prisma` (model/enum/constraint inventory + full text of `Device`,
`DeviceDeparture`, `Vehicle`, `Transporter`, `DeviceState`, `FailureCycle`, `Ticket`,
`TicketEvent`) · all 77 migrations' raw-SQL invariant lines (grep) · full controller/route/role
inventory (grep across every `*.controller.ts`) · `package.json` · `.env.example` ·
`vitest.config.ts` · `test/global-setup.ts` · `test/setup-env.ts` · `scripts/run-tests.mjs` ·
the 357-file `test/` listing · repo root listing (CI present, no Docker).

## A.2 NOT read (statements about these come from wiring, doc comments, call sites, route signatures)

`dashboard.service.ts` · the five `reports/*-aggregation.service.ts` bodies ·
`ops-explorer/dataset-query*.ts` · `intraday-insertion.service.ts` ·
`cross-zone-escalation.service.ts` · all `inventory/*` service bodies ·
all `component-request/*` service bodies · all `vouchers/*` service bodies ·
all `engineers/*` service bodies · all `org/*` CRUD service bodies ·
`install.service.ts` / `install-lifecycle.service.ts` · `recovery.service.ts` ·
`non-operational.service.ts` · `override.service.ts` · `same-day-update.service.ts` ·
`bulk-unassign.service.ts` · `me-tickets/*` query service bodies ·
`device-departure.service.ts` · `partition-maintenance.service.ts` ·
`plant-eligibility-refresh-scheduler.service.ts` · `repeat-escalation.service.ts` ·
`tier-override-expiry.service.ts` · individual test file bodies.

---

# PART B — Backend SDE Architecture

## §0. Executive Summary

This is a **single-process NestJS 10 modular monolith** on **Postgres 16 + PostGIS via Prisma 7**
(driver-adapter, no bundled query engine), reading from an **external AutoPlant MySQL** system over
VPN.

There is **no Redis, no BullMQ, no S3, no message broker, no microservices, no repository layer, no
CQRS, no event bus.** The only `redis`/`bullmq`/`s3` hits anywhere in `src/**` are three code
comments saying those things were deferred:
- `dashboard.service.ts:404` — *"same posture as Issue 04's deferred BullMQ"*
- `reports.controller.ts:28` — *"until a month-end BullMQ cron lands"*
- `repeat-escalation.service.ts:20` — *"Scheduling (cron) is deferred, same posture as Issue 04's BullMQ"*

Verified against the `apps/backend/package.json` dependency list, not inferred.

The system is a **funnel**: AutoPlant telemetry → snapshots → derived device state → tickets →
recommendations → dispatched SE day plans → field loop → GPS verification → report cubes. Two of the
three master cron switches are **OFF** in `.env`, so the top half of the funnel does not currently
self-run.

**Four properties make this codebase unusual. Internalise them before touching anything:**

1. **Database constraints ARE the business rules.** ~17 partial unique indexes and 10 CHECK
   constraints, all in raw-SQL appendices inside migrations (Prisma cannot express them). Application
   code catches `P2002` and treats it as a normal outcome, not an error.
2. **Every long-running job has a run ledger row** — `snapshot_runs`, `master_sync_runs`,
   `dispatch_runs`, `device_state_recomputes` — with a single-in-flight guard and a stale-run reaper.
3. **Doc comments carry incident forensics.** Comments tagged `#222`, `#229`, `#230`, `#218`, `#153`,
   `#130`, `#126`, `#223` name a specific production defect, its measurement, and why the fix has the
   shape it does. They are the highest-value documentation in the repo — read them before changing
   the line above them.
4. **Anti-drift is structural, not conventional.** The pure `master-mapping.ts` layer *cannot*
   overwrite FSM-owned columns, because those columns are physically absent from every `update`
   object it produces. There is no flag to forget.

---

## §1. System Architecture

### 1.1 The real diagram

```
                       ADMIN SPA (React/Vite)          SE MOBILE (Expo, auth shell only)
                              │                                  │
                              └──────────────┬───────────────────┘
                                             │ HTTPS  Bearer JWT (HS256)
                                             │ + X-Device-Id, X-Acting-As-Zone, X-Correlation-Id
                                             ▼
   ┌────────────────────────────────────────────────────────────────────────────────────┐
   │  SINGLE NODE PROCESS   (apps/backend)   port PORT ?? 3000                           │
   │                                                                                     │
   │  main.ts                                                                            │
   │    validateBootConfig()  ── boot-config.ts:26  (JWT secret >=32ch, DATABASE_URL URL)│
   │    new PrismaService().onModuleInit()  ── PREFLIGHT: connect + build guards, close  │
   │    NestFactory.create(AppModule, {bodyParser:false})                                │
   │    app.enableShutdownHooks()                                                        │
   │    configureApp(app)  ── /api prefix · URI versioning ['1',NEUTRAL] · CORS · 1MB    │
   │    app.listen()                                                                     │
   │                                                                                     │
   │  ┌── GLOBAL PIPELINE (app.module.ts:197-217) ───────────────────────────────────┐   │
   │  │  APP_PIPE   ValidationPipe(whitelist, forbidNonWhitelisted, transform)       │   │
   │  │  APP_GUARD  AuthGuard   → RoleGuard   → ZoneScopeGuard                       │   │
   │  │  APP_FILTER AllExceptionsFilter (sanitised 500 + x-correlation-id)           │   │
   │  └──────────────────────────────────────────────────────────────────────────────┘   │
   │              │                                                                      │
   │   ~68 CONTROLLERS (57 registered in AppModule + IngestionModule's 2 + others)       │
   │              │                                                                      │
   │   ~90 SERVICES across 32 feature modules  ── ALL business logic lives here          │
   │              │                                                                      │
   │   ┌──────────┴───────────┬──────────────────────┬───────────────────────────────┐  │
   │   │                      │                      │                               │  │
   │   ▼                      ▼                      ▼                               ▼  │
   │  PrismaService     IN-PROCESS CRON        AutoPlantMysqlClient          Notification│
   │  (@prisma/         @nestjs/schedule       (mysql2, lazy pool,           seam        │
   │   adapter-pg)      ScheduleModule         connLimit 4, read-only        (no real    │
   │  pool max 25       .forRoot() lives in    prefix guard, 30s query TO,   external    │
   │  acquire TO 5s     IngestionModule        10s connect TO)               adapter)    │
   │  stmt TO 120s      → 16 registered jobs                                             │
   │  idle-in-tx 60s                                                                     │
   │  session TZ=UTC                                                                     │
   └───────┬────────────────────────────────────────────────┬───────────────────────────┘
           │                                                │  READ ONLY, over VPN
           ▼                                                ▼
   ┌───────────────────────┐                    ┌──────────────────────────────┐
   │ POSTGRES 16 + PostGIS │                    │  AUTOPLANT MySQL (external)  │
   │ ~90 models + ~40 enums│                    │   ap_masters : mst_company   │
   │ 77 migrations         │                    │                mst_plant     │
   │ raw_device_snapshots  │                    │                mst_vehicle   │
   │   RANGE-partitioned   │                    │                mst_transporter│
   │   daily by gps_datetime│                   │   ap_widgets : tb_vehiclemaster│
   │ 1 materialized view   │                    │                (latest state) │
   └───────────────────────┘                    └──────────────────────────────┘
```

### 1.2 Component-by-component

| Component | Reality in this repo | Evidence |
|---|---|---|
| Application type | NestJS 10 modular monolith; HTTP + in-process cron in one process | `package.json`, `app.module.ts:101-134` |
| Node process model | Single process. No clustering, no `worker_threads`, no runtime child processes | no such import in `src/**` |
| HTTP server | Express via `@nestjs/platform-express`; `bodyParser:false` then explicit JSON parser | `main.ts:26`, `app.config.ts:38-41` |
| Config validation | Hand-written, zero-dependency, fail-fast | `config/boot-config.ts:26` |
| ORM | Prisma 7 via `@prisma/adapter-pg` over `pg` — **no bundled query engine** | `prisma.service.ts:75-80` |
| PostGIS | `Unsupported(MultiPolygon)` on `engineer_territory_coverage.polygon` (**reserved, no v1 writer**) + the `plant_eligible_floating_se` MV | schema:405-418, migration `20260621160000` |
| AuthN | Hand-rolled HS256 JWT on `node:crypto`. No `@nestjs/jwt`, no passport | `auth/token.service.ts` |
| AuthZ | 3 global guards + per-service zone predicates + coverage checks | `common/guards/*` |
| Background jobs | `@nestjs/schedule` `@Cron` only — 16 registered jobs, 3 env master switches | exhaustive grep over `src/**` |
| Logging | Nest built-in `Logger` only. No pino, winston, Sentry, OpenTelemetry, metrics | grep: zero hits |
| Health | `GET /api/health` (liveness), `/health/ready` (DB), `/api/integration/health` (AutoPlant, OH-only) | `health/`, `integration-health.controller.ts` |
| Deployment | **NOT PRESENT** — no Dockerfile, no compose, no k8s manifests. CI exists: `.github/workflows/ci.yml` | repo root listing |

---

## §2. Bootstrap & Infrastructure

### 2.1 Verified execution order

The real sequence in `src/main.ts`. Note it differs from the "obvious" order in one important way:
**the Prisma preflight runs before `NestFactory.create`, and the build guards therefore run twice.**

```
runWithFatalGuard(bootstrap, {exit, logFatal})        bootstrap-guard.ts:13
   │
   ├─ 1. validateBootConfig()                         main.ts:12  → config/boot-config.ts:26
   │       throws on: JWT_ACCESS_SECRET unset
   │                  JWT_ACCESS_SECRET === 'dev-access-secret-change-me'
   │                  JWT_ACCESS_SECRET.length < 32
   │                  DATABASE_URL unset
   │                  DATABASE_URL not a postgres:/postgresql: URL
   │
   ├─ 2. PREFLIGHT PrismaService                      main.ts:18-23
   │       new PrismaService()      → builds PrismaPg adapter with poolOptions()
   │       .onModuleInit()          → $connect() + assertRuntimeBuildGuards()
   │            ├─ L4 assertMigrationsInSync()        build-info/migration-skew.ts:56
   │            │     bundled prisma/migrations/* dirs  vs  _prisma_migrations rows
   │            │       onlyInDb  → FATAL "this build is older than the schema"
   │            │       onlyInApp → FATAL "run prisma migrate deploy"
   │            │       table absent → WARN + skip (a db-push test DB has no ledger)
   │            └─ L1 assertBuildNotStale()           build-info/runtime-lock.ts:171
   │                  $transaction { pg_advisory_xact_lock(hashtext('runtime_lock'));
   │                                 read runtime_lock id=1;
   │                                 build.version < db.version → FATAL refuse
   │                                 build.version > db.version → take lock
   │                                 equal + same fingerprint  → refresh boot metadata
   │                                 equal + diff fingerprints, neither dirty → FATAL
   │                                 equal + diff, either dirty → WARN takeover }
   │       .onModuleDestroy()       → $disconnect()   (in a finally block)
   │
   ├─ 3. NestFactory.create(AppModule, { bodyParser: false })    main.ts:26
   │       → module graph constructed
   │       → the REAL PrismaService singleton's onModuleInit runs the guards AGAIN
   │       → SettingsService.onModuleInit() seeds SETTINGS_DEFAULTS  settings.service.ts:66
   │       → ScheduleModule.forRoot() explorer registers all 16 @Cron jobs
   │       → DispatchScheduleService.onApplicationBootstrap() re-points the
   │         dispatch job at system_settings.dispatch_cron            (#213)
   │
   ├─ 4. app.enableShutdownHooks()                    main.ts:30
   ├─ 5. configureApp(app)                            main.ts:31 → app.config.ts:15
   │       setGlobalPrefix('api')
   │       enableVersioning({URI, defaultVersion:['1', VERSION_NEUTRAL]})
   │       enableCors({origin: ADMIN_ORIGIN ?? http://localhost:5173, credentials:true})
   │       useBodyParser('json', {limit: BODY_LIMIT_JSON ?? '1mb'})
   │
   └─ 6. app.listen(PORT ?? 3000)                     main.ts:32
```

**Why the double Prisma init exists** (`main.ts:13-17` comment): the structural guarantee is
`PrismaService.onModuleInit`, so *every* entrypoint gets it — including the five hand-constructed CLI
scripts (`autoplant:ping`, `autoplant:sync`, `autoplant:departure-dryrun`, `autorecovery:dryrun`,
`runtime-lock:reset`). The `main.ts` preflight is a *belt-and-braces earlier tripwire* so a skewed
HTTP server dies before Nest builds the graph. Cost: one extra connect/disconnect at boot.

**Why `bodyParser: false`** (`app.config.ts:8-13`): if Nest's default parser registers first, its
default limit wins and `configureApp`'s explicit cap becomes dead code.

**Why `defaultVersion: ['1', VERSION_NEUTRAL]`** (`app.config.ts:19-30`): every route answers at
**both** `/api/v1/x` and `/api/x`. This is a deliberate migration window — 90 e2e specs and the whole
`apps/admin` client use the unversioned path. Removing the neutral alias breaks both apps at once.

### 2.2 Startup failure behaviour — the complete list

| Refusal | Where | Message shape |
|---|---|---|
| `JWT_ACCESS_SECRET` unset | `boot-config.ts:27-29` | `Boot config: JWT_ACCESS_SECRET is not set. Set a random secret of at least 32 chars.` |
| `JWT_ACCESS_SECRET` is the published dev default | `boot-config.ts:30-34` | `… is still the published dev default. Set a unique random secret.` |
| `JWT_ACCESS_SECRET` < 32 chars | `boot-config.ts:35-39` | `… is too short (N chars). Use at least 32.` |
| `DATABASE_URL` unset | `boot-config.ts:42-44` | `Boot config: DATABASE_URL is not set.` |
| `DATABASE_URL` not a parseable postgres URL | `boot-config.ts:45-47` | `… is not a parseable postgres connection URL.` |
| DB has migrations this build lacks | `migration-skew.ts:80` | `FATAL migration-skew refused: … this build is older than the schema. Deploy the current build.` |
| Build has migrations the DB lacks | `migration-skew.ts:88` | `FATAL migration-skew refused: … run 'prisma migrate deploy' before starting.` |
| Build older than `runtime_lock.version` | `runtime-lock.ts:60` | `FATAL stale-build refused: this process is build X@vN, but database D requires >= vM … Deploy the current build or run 'npm run runtime-lock:reset' to authorize a rollback.` |
| Same version, two clean differing SHAs | `runtime-lock.ts:158` | same message (a true ambiguity) |
| `TokenService` constructed with no secret | `token.service.ts:88` | `JWT_ACCESS_SECRET is not set — refusing to sign tokens with a fallback secret.` |
| Postgres unreachable | `$connect()` in `onModuleInit` | driver error |

All of these surface identically: `runWithFatalGuard` catches, logs one `logger.fatal` line with the
stack, and calls `process.exit(1)` (`bootstrap-guard.ts:19-22`).

**This is the single most important operational property of the app: it never boots half-configured.**

### 2.3 Shutdown — verified

```
SIGTERM / SIGINT
   ↓  (only because main.ts:30 called app.enableShutdownHooks())
Nest lifecycle: onModuleDestroy across the graph
   ├─ PrismaService.onModuleDestroy()          prisma.service.ts:104  → $disconnect()
   └─ AutoPlantMysqlClient.onModuleDestroy()   autoplant-mysql.client.ts → pool.end(), pool=null
   ↓
@nestjs/schedule tears down its registered CronJobs (framework-owned)
   ↓
process exits
```

**Not implemented:** no in-flight-request draining beyond Express/Nest defaults; no "finish the
current cron tick before exiting"; no explicit `snapshot_runs` finalisation on shutdown. A SIGTERM
mid-snapshot-run leaves a `RUNNING` row — which is precisely what `reapStaleRuns()`
(`snapshot-run.service.ts:38`) exists to clean up on the next `startRun()`, after
`INGESTION_STALE_RUN_MIN` (default 30) minutes.

---

## §3. Complete Module Map

`AppModule` imports **31 feature modules** and registers **57 controllers** at app level.
`IngestionModule` self-registers 2 more; several modules register their own.

### 3.1 The table

| Module | Responsibility | Controllers | Core services | Guards | Primary DB models | Depends on | Used by |
|---|---|---|---|---|---|---|---|
| `PrismaModule` | Prisma singleton + pool/timeout posture + boot guards | — | `PrismaService` | — | all | — | everything |
| `AuthModule` | Login/refresh/logout, JWT mint+verify | `AuthController` | `AuthService`, `TokenService`, `PrismaUserStore`, `PrismaRefreshTokenStore` | `@Public` | `users`, `user_credentials`, `refresh_tokens` | Notifications (DeviceToken) | AuthGuard (exports `TokenService`), IngestionModule |
| `SettingsModule` | `system_settings` audited registry + boot defaults | `SettingsController` | `SettingsService` | OH only | `system_settings` | Audit | DeviceState, Recommender, Reports, DispatchRun |
| `AuditModule` | In-transaction audit writer + ticket audit trail | `AuditTrailController` | `AuditService` | ZM/CSM/OH | `audit_logs` | Prisma | Org, Ticketing, Scheduling, Settings, Exports |
| `OrgModule` | Org-graph CRUD + rule config + zone crosswalk + floating-SE MV | 13 | 16 services (`ZonesService`…`TierOverridesService`, `PlantEligibleFloatingSeService`, `TierOverrideExpiryService`) | OH mostly | `zones`, `plants`, `company_master`, `users`, `engineer_master`, `se_coverage`, `engineer_territory_coverage`, `zone_mappings`, `plant_zone_overrides`, `sla_rule_config`, `priority_rule_config`, `common_kit_definition`, `tiers`, `company_tier_overrides`, MV | Audit | Ingestion, BusinessSweep, Recommender (via `effective-tier.ts`) |
| `IngestionModule` | Everything AutoPlant + partitions + **owns `ScheduleModule.forRoot()`** | `SnapshotsController`, `IntegrationHealthController`, `IntegrationSyncController` | `MasterSyncService`, `SnapshotIngestionWorker`, `SnapshotIngestionService`, `SnapshotRunService`, `MasterSyncRunService`, `IntegrationSyncService`, `IntegrationSchedulerService`, `PartitionMaintenanceService`, `AutoPlantHealthService`, `SnapshotQueryService` | own `AuthGuard`+`RoleGuard`, OH | `raw_device_snapshots`, `snapshot_runs`, `snapshot_run_chunks`, `master_sync_runs`, `master_sync_rejects`, `devices`, `vehicles`, `plants`, `company_master`, `transporters`, `device_commissioning` | Auth, DeviceState, DeviceDeparture, Settings, Ticketing, Org | — (top of funnel) |
| `DeviceStateModule` | Set-based derive of `device_states` + canary | — | `DeviceStateService` | — | `device_states`, `device_state_recomputes`, `device_commissioning`, `device_departures`, `pgi_history`, `non_operational_markings` | Settings | **only IngestionModule** |
| `DeviceDepartureModule` | Device left the deployed fleet (FSM-owned side table) | — | `DeviceDepartureService` | — | `device_departures` | Prisma | IngestionModule |
| `TicketingModule` | Ticket creation + all 3 work types + auto-recovery + VU + Non-Op | 7 | `TicketCreationService`, `TicketQueryService`, `AutoRecoveryService`, `RepeatEscalationService`, `TroubleshootSubmissionService`, `VehicleUnavailabilityService`, `NonOperationalService`, `RecoveryService`, `InstallService`, `InstallLifecycleService` | ZM/CSM/OH + SE + 1 `@Public` | `tickets`, `failure_cycles`, `ticket_events`, `troubleshooting_submissions`, `vehicle_unavailability_reports`, `non_operational_markings` | Audit, SharedPool, Notifications | Ingestion, BusinessSweep |
| `DevicesModule` | Device list, detail, cycles, downtime trend, deal-type tag | `DevicesController` | `DeviceService`, `DeviceDetailService` | ZM/CSM/OH/WM; PATCH OH | `devices`, `device_states`, `tickets`, `failure_cycles` | Prisma | — |
| `RecommenderModule` | Candidate → filter → score → sort → `recommendations` | **none** | `RecommenderService`, `CandidateSelectionService` | — | `recommendations`, `dispatch_decision_traces`, `tickets`, `engineer_master`, `se_coverage`, MV, `priority_rule_config` | Inventory, Engineers, Reports (soft-inactive), Org (effective-tier), Scheduling (schedule-status) | SchedulingModule |
| `SchedulingModule` | Dispatch, day plans, override, same-day, closures, transparency | 4 | `BatchAssignmentService`, `DispatchRunService`, `DispatchSchedulerService`, `DispatchScheduleService`, `ScheduleClosureScheduler`, `OverrideService`, `SameDayUpdateService`, `BulkUnassignService`, 3 query services | ZM/CSM/OH + SE | `work_schedules`, `plant_batch_assignments`, `batch_assignment_tickets`, `dispatch_runs`, `dispatch_run_zones`, `dispatch_decision_traces` | Recommender, Audit, Notifications, SoftState | DispatchRun cron |
| `BusinessSweepSchedulerModule` | 11 `@Cron` field-loop + report sweeps | none | `BusinessSweepSchedulerService` | — | via its 11 collaborators | Verification, Intraday, CrossZone, Install, RepeatEscalation, TierOverrideExpiry, 5 report services | **leaf** |
| `IntradayModule` | CRITICAL insertion offer state machine | 2 | `IntradayInsertionService` | mgr + SE | `intraday_insertions` | *(NOT VERIFIED)* | BusinessSweep |
| `CrossZoneModule` | Platinum auto-escalation + manual flag/approve/deny/defer | `CrossZoneController` | `CrossZoneEscalationService` | mgr | `cross_zone_escalations` | *(NOT VERIFIED)* | BusinessSweep |
| `SharedPoolModule` | SE coverage predicate + shared-pool read | `SharedPoolController` | `SeCoverageService`, `SharedPoolService` | SE | `se_coverage`, MV, `tickets` | Prisma | Ticketing, MeTickets |
| `MeTicketsModule` | SE-facing ticket API (`/api/me/*`) | `MeTicketsController` | `MeTicketsQueryService`, `MeTicketDetailService`, `MeTicketFormsService`, `MeWorkHistoryService` | SE | `tickets`, `batch_assignment_tickets`, `work_schedules` | SharedPool, Scheduling (`schedule-status.ts`) | — |
| `PlannerModule` | ZM plant-visit intent (soft recommender bias) | `SePlannerController` | `SePlannerService` | mgr | `se_planner` | Prisma | Recommender (reads the table directly) |
| `DashboardModule` | Zone aggregates, KPI tiles, fleet directory, operating mode | 2 | `DashboardService` | ZM/CSM/OH | reads `device_states`, `tickets`, `plants` *(NOT VERIFIED in detail)* | Prisma | — |
| `ReportsModule` | 5 aggregation cubes + read endpoints + commissioning cohort | `ReportsController` | `FleetUptimeAggregationService`, `RootCauseAnalyticsAggregationService`, `ZmPerformanceAggregationService`, `SystemEfficiencyAggregationService`, `SoftInactiveCountService`, `CommissioningAggregationService`, `ReportsService` | mgr read / OH recompute | 5 summary tables + `device_commissioning` | Prisma | BusinessSweep, Recommender (`SoftInactiveCountService.modeForZone`) |
| `SoftStateModule` | VIEWED / ON_SITE / TROUBLESHOOT_STARTED + activity ping | `SoftStateController` | `SoftStateService` | SE | `soft_states`, `engineer_master.last_activity_at` | Prisma | Scheduling (`SOFT_STATE_CONFLICT` port) |
| `VerificationModule` | 3-phase GPS verification, review queue, fraud flag | `VerificationController` | `VerificationService`, `VerificationQueryService` | SE read + mgr | `verification_runs`, `tickets`, `failure_cycles`, `raw_device_snapshots` | Prisma | BusinessSweep |
| `InventoryModule` | Van stock, ledger, shadow use, zone warehouse stock | 4 | `InventoryService`, `ShadowUseService`, `WarehouseStockService` | SE / WM / mgr | `se_van_stock`, `inventory_transactions`, `component_blocked_queue`, `zone_warehouse_stock`, `common_kit_definition` | Prisma | Recommender (`commonKitStatus`, `recordComponentBlock`) |
| `ComponentRequestModule` | WAITING_COMPONENT flow, WM queue, oversight | 3 | `ComponentRequestService` | SE / WM / mgr | `component_request` | *(NOT VERIFIED)* | Ticketing (troubleshoot submit) |
| `EngineersModule` | SE directory/admin, availability, leave | 4 | `EngineerAdminService`, `EngineersQueryService`, `SeAvailabilityService`, `LeaveRequestService` | mgr + SE | `engineer_master`, `se_availability`, `leave_requests`, `se_coverage` | Prisma | Recommender (`currentStatusMany`) |
| `RoleBackupModule` | ZM→CSM→OH backup cascade + CSM approval-share report | `RoleBackupController` | `RoleBackupService` | OH/CSM | `role_unavailability`, `audit_logs` | Prisma | — |
| `NotificationsModule` | In-app spine + channel-gateway seam + device tokens | `NotificationsController` | `NotificationService`, `DeviceTokenService` | any auth; SE for token | `notifications`, `notification_deliveries`, `device_tokens` | Prisma | Auth, Ticketing, Scheduling |
| `VouchersModule` | Expense vouchers SE→ZM→OH→PAID | 2 | `VouchersService`, `MeVouchersService` | SE / review / OH | `expense_vouchers`, `expense_voucher_items` | *(NOT VERIFIED)* | — |
| `ExportsModule` | OH entity-mapping CSV (audited download) | `ExportsController` | `EntityMappingExportService` | OH | reads org graph | Audit | — |
| `OpsExplorerModule` | OH read-only ad-hoc dataset explorer, feature-flagged | `OpsExplorerController` | `DatasetQueryService`, `ReconciliationService` | `OpsExplorerEnabledGuard` (404s when off) + OH | allow-listed datasets | Prisma | — |
| `PlantDeactivationModule` | OH plant deactivate/reactivate + ticket cancellation | `PlantDeactivationController` | `PlantDeactivationService` | OH | `plant_deactivations`, `tickets` | Audit | TicketCreation, Recommender (read the table) |
| `MediaModule` | Multer file upload + retrieval | `MediaController` | `MediaService` | SE upload, SE+review read | `media_objects` | Prisma | — |
| `MeModule` | Session profile | `MeController` | `MeService` | any auth | `users` | Prisma | — |
| `health/`, `zones/`, `build-info/`, `common/`, `config/` | no module wrapper — providers/controllers registered directly in `AppModule` | | | | | | |

### 3.2 Module deep-dives (the seven you will actually work in)

The A–O questions are answered for the seven modules with real complexity. The table above plus §21
covers the rest.

---

#### `IngestionModule` — the funnel's mouth

**A/B. Responsibility & why it exists.** FSM does not own the fleet data — AutoPlant does. This
module is the *entire* boundary: it mirrors the org graph, journals telemetry, and orchestrates the
four downstream stages. It is deliberately self-contained: it provides its own `AuthGuard`/`RoleGuard`
and its own `ScheduleModule.forRoot()` (`ingestion.module.ts:60-66` comment: to avoid touching the
concurrently-edited `AppModule`).

**C. Entry points (3, all verified):**
- `@Cron('*/30 * * * *')` `IntegrationSchedulerService.telemetryTick()` — `integration-scheduler.service.ts:70`
- `@Cron('0 2 * * *')` `IntegrationSchedulerService.mastersTick()` — `:87`
- `POST /api/integration/sync-masters` and `POST /api/integration/run-pipeline`, both class-level
  `@Roles('OPERATIONS_HEAD')` — `integration-sync.controller.ts:20-44`
- Plus `POST /api/snapshots/run` (OH) for a bare snapshot run.

**D. Controllers.** `IntegrationSyncController` (OH-only), `IntegrationHealthController`
(`GET /api/integration/health`, OH), `SnapshotsController` (`GET /snapshots/latest` ZM/CSM/OH,
`GET /snapshots/runs` OH, `POST /snapshots/run` OH).

**E. Core service — `IntegrationSyncService`.** Three public methods:

```
ingestTelemetry({chunkSize=90})                       :88
  skipOnOverlap(() => snapshotWorker.run({chunkSize}))
    → a 409 RUN_IN_PROGRESS becomes {skipped:true}; it never throws
  runPostIngestStages('telemetry tick', snap.status, 'cron')

syncMastersTick()                                     :~200
  skipOnOverlap(() => syncMasters())

runPipeline({chunkSize=90})                           :~230   ← OH manual, NOT overlap-guarded
  syncMasters()  →  snapshotWorker.run()  →  runPostIngestStages(..., 'api')
```

`runPostIngestStages` (`:135`) is the **#230 incomplete-ingest gate** and the single most important
control-flow decision in the whole funnel:

```ts
const ingestComplete = snapshotStatus === 'SUCCESS';
await this.deviceState.recompute(new Date(), trigger, { skipDerivation: !ingestComplete });
if (!ingestComplete) {
  // WARN + return {recovered:{closed:0,…}, tickets:{created:0}, ingestComplete:false}
  return …;                        // auto-recovery and ticket creation NEVER RUN
}
const recovered = await this.runAutoRecoveryStage(label);
const tickets   = await this.ticketCreation.createForInactiveEligible();
```

The comment records the incident verbatim: on 2026-08-10 snapshot run 153 aborted after 2,610 of
27,032 devices; the downstream chain aged the unseen 24,422 into `is_inactive` and opened **3,439
Failure Cycles, 99.6% of them fabricated**. The run's own `PARTIAL` verdict was already recorded
correctly — nobody was consulting it. `PipelineSummary.ingestComplete` is a **typed field, not a log
line**, because *"we chose not to act"* and *"there was nothing to do"* must not look identical
downstream.

**The stage order is load-bearing, not stylistic** (`integration-sync.service.ts:59-66`):
- auto-recovery reads `device_states.is_inactive`, which recompute just rewrote;
- auto-recovery *after* creation would be a no-op by construction, because creation skips any device
  with `has_open_failure_cycle = true`;
- creation takes `is_inactive = true`, recovery takes `is_inactive = false` — **exact complements**,
  so no device can be touched by both in one pass.

**F. DB.** Reads AutoPlant MySQL. Writes `raw_device_snapshots`, `snapshot_runs`,
`snapshot_run_chunks`, `master_sync_runs`, `master_sync_rejects`, `device_commissioning`,
`device_departures`, the five mirror tables, and
`device_states.{latest_gps_datetime, trip_creation_datetime, first_reported_at, first_reported_offset_min}`.

**G/H.** Depends on Auth, DeviceState, DeviceDeparture, Settings, Ticketing, Org. Used by nothing —
it is the source.

**I. Business rules.** Plant-first scope derivation; ACTIVE-plant-only create scope; operational
deployment-status insert pin; anti-drift column exclusion; zone precedence override → mapping →
UNZONED; UTC offset 0 with a two-directional skew guard.

**J. Failure.** A master-sync throw → run finalized `FAILED` with the error, rejects flushed,
rethrown (`master-sync.service.ts:393-399`). A snapshot read throw mid-scan → caught, run finalized
`PARTIAL`/`FAILED`, **never left `RUNNING`** (`snapshot-ingestion.worker.ts:129-131` — the "run 456"
fix). A cron tick failure → logged, returns `{ran:false, reason:'ERROR'}`, never throws out of the
cron context.

**K. Idempotency.** Total. `raw_device_snapshots (device_id, gps_datetime)` UNIQUE + `ON CONFLICT DO
NOTHING`; master upserts keyed on `source_*_id`; `device_commissioning` unique-with-`NULLS NOT
DISTINCT` + `skipDuplicates`.

**L. Transactions.** `batchUpsert` groups 500 upserts per `$transaction`
(`master-sync.service.ts:592`). The device-state chunk upsert is one statement. `appendCommissioning`
and `reconcileDepartures` run **outside any transaction, after every mirror write**, inside their own
try/catch — deliberately inert (`:441-457`).

**M. Concurrency.** `pg_try_advisory_xact_lock(hashtext('snapshot_run'))` +
`snapshot_runs_one_in_flight` partial unique. Same shape for `master_sync_runs_one_in_flight`. A
second start → 409 `RUN_IN_PROGRESS`; a *scheduled* caller swallows it as a skip, an *HTTP* caller
receives the 409.

**N. Security.** All mutating ingestion routes are `@Roles('OPERATIONS_HEAD')`. The MySQL seam has a
read-only prefix allow-list enforced in code regardless of grants
(`autoplant-mysql.client.ts:~205`).

**O. Observability.** `snapshot_runs` (status, chunks, `data_as_of`, `cursor`, build stamp);
`snapshot_run_chunks` (per-chunk status/retry/error); `master_sync_runs.entity_stats` (per-entity
inserted/updated/skipped/observed + `skippedByReason`); `master_sync_rejects` (itemised, capped
5,000/run); `GET /api/integration/health`.

---

#### `DeviceStateModule` — the derive engine

**A/B.** Turns a raw ping watermark plus reference data into the operational facts every other
surface reads. It is a separate module so the derive can be triggered at runtime rather than only
hand-constructed in tests (`device-state.module.ts:5-9`).

**C. Entry point.** Exactly one caller: `IntegrationSyncService.runPostIngestStages`. **No cron of
its own, no HTTP route.** It runs on the telemetry tick because *bucket aging is a function of
wall-clock time* — a silent device must keep advancing WARNING→CRITICAL→SEVERE with no new telemetry
arriving (`device-state.service.ts:22-25`).

**E. The algorithm** — `DeviceStateService.recompute(now, trigger, {skipDerivation})`:

```
if (skipDerivation)                                          device-state.service.ts:~115
   INSERT INTO device_states(device_id, computed_at)
     SELECT d.device_id, now FROM devices d ON CONFLICT DO NOTHING
   WARN + return {upserted:0, derived:false}
   → inactivity_hours / is_inactive / sla_bucket / computed_at KEEP their last-good values,
     so computed_at visibly lags. Stale-but-true, never fresh-and-fabricated.

threshold        = settings.inactivity_threshold_hours ?? 24
eligibilityMode  = parseEligibilityMode(settings.eligibility_mode)     // 'pgi' | 'all-deployed'

STEP 1  INSERT … SELECT devices … ON CONFLICT DO NOTHING     // a row per device, incl. never-pinged

STEP 2  $transaction {
          WITH install AS (SELECT device_id, MIN(installed_at) FROM device_commissioning …),
               derived AS (SELECT ds.device_id,
                             CASE WHEN ds.latest_gps_datetime IS NOT NULL
                                    THEN GREATEST(0, EXTRACT(EPOCH FROM (now - latest_gps))/3600)
                                  WHEN ic.installed_at IS NOT NULL
                                    THEN GREATEST(0, EXTRACT(EPOCH FROM (now - installed_at))/3600)
                                  ELSE NULL END AS hours,
                             EXISTS(device_departures WHERE restored_at IS NULL) AS departed …)
          UPDATE device_states SET
            inactivity_hours    = dr.hours
            is_departed         = dr.departed
            is_inactive         = NOT departed AND hours IS NOT NULL AND hours >= threshold
            sla_bucket          = CASE WHEN departed THEN NULL ELSE <slaBucketCaseSql('dr.hours')> END
            eligible_for_uptime = NOT departed
                                  AND <eligibilityBase>
                                  AND NOT EXISTS(non_operational_markings IN ('CONFIRMED','ACTIVE'))
            vehicle_id/plant_id/company_id/transporter_id = <current fitment>
            computed_at = now
          FROM derived dr JOIN devices d LEFT JOIN vehicles v ON v.vehicle_id = d.current_vehicle_id
          ;
          assertDepartureInvariant(tx)      ← throws ⇒ the whole UPDATE rolls back
        }

STEP 3  recordRecomputeAndCanary(now, trigger)               // outside the tx, after commit
```

Three details a maintainer must not miss:

- **`slaBucketCaseSql` is generated from the same `SLA_BANDS` array as the TS classifier**
  (`sla-bucket.ts:~70`), so the SQL `CASE` and `classifySlaBucket()` cannot drift. Bucket identifiers
  are regex-validated (`/^[A-Z_]+$/`) before interpolation.
- **#223 — never-reported devices age from their install date, not from nothing.** The original
  `hours IS NOT NULL` guard was locally correct ("never heard from it" ≠ "it went silent") but was
  never followed through to the consumers: those devices, excluded from `inactive`, were swept into
  `healthy` by negation, and **913 fitted-and-dead trackers counted as the healthiest devices in the
  fleet**. `MIN(installed_at)`, not `MAX` — because `tb_vehiclemaster` rewrites fitment in place
  (10,565 devices moved, 1,757 by more than a year), so `MAX` would let a never-working device look
  freshly commissioned indefinitely. The 24 h grace window falls out of the existing
  `hours >= threshold` comparison for free (operator decision P2 — no new setting).
- **#130 L2 — the UPDATE and the invariant assertion are in ONE transaction.** Rollback-and-throw,
  not log-and-alert. This is the run-65 shape: a stale-code recompute cleared `is_departed`
  fleet-wide while the ledger still held active departures.

**J/K/L/M.** Fully idempotent (a pure function of `now` + current DB state); transactional; **no
concurrency guard of its own** — it is protected only by being reachable exclusively from inside the
ingestion in-flight guard. Two concurrent callers would be two competing full-table UPDATEs.
*(Latent risk — see §22 H3.)*

**O.** `device_state_recomputes` ledger row per run (eligible/inactive/departed/total counts,
`trigger`, `build_version`, `build_fingerprint`) plus the **semantic canary**: an eligible-count swing
beyond `recompute_canary_threshold_pct` (default 5%) in either direction logs one LOUD warning naming
both builds (`recompute-canary.ts`, `device-state.service.ts:~250`). It **warns, never throws** —
legitimate mass events (#119 deactivations) also swing hard, and hard-failing true corruption is L2's
job.

---

#### `TicketingModule` — the domain core

**C. Entry points.** `TicketCreationService` ← ingestion pipeline only. `AutoRecoveryService.runAutoRecovery`
← ingestion pipeline only; `.manualClose` ← `POST /api/tickets/:id/auto-recovery-close`.
`RepeatEscalationService` ← `business-repeat-escalation` cron. `TroubleshootSubmissionService` ←
`POST /api/tickets/:id/troubleshoot` (SE). Plus 6 more controllers for Install / Recovery / VU / Non-Op.

**E1. `TicketCreationService.createForInactiveEligible(now)`** — `ticket-creation.service.ts:31`:

```
1. deactivatedPlantIds ← plant_deactivations WHERE reactivated_at IS NULL
2. candidates ← device_states WHERE
       is_inactive = true
   AND eligible_for_uptime = true
   AND has_open_failure_cycle = false
   AND device.departures NONE (restored_at IS NULL)      ← re-reads the LEDGER, not is_departed
   AND plant_id IS NOT NULL AND plant_id NOT IN deactivated
   AND company_id IS NOT NULL
3. batch: companies → tier map; plants → zone map; resolveActiveOverrides(zoneIds, now)
4. FOR EACH candidate:
     globalTier = tierByCompany[companyId]           (missing ⇒ skip defensively, no counter)
     companyTier = override(company,zone)?.tier ?? globalTier          ← #157 effective tier
     priorVerified = failure_cycles WHERE device, state=VERIFIED, closed_at >= now-24h  (ADR-0021)
     isRepeat = priorVerified !== null
     TRY $transaction {
        failure_cycle.create({state: isRepeat?'REPEAT':'OPEN', repeatFailure, previousFailureCycleId})
        ticket.create({workType:'TROUBLESHOOT', status:'OPEN', failureCycleId, companyTier, …})
        ticket_event.create({fromState:null, toState:'OPEN'})     ← no actor: system-generated
        device_state.update({hasOpenFailureCycle:true})
     } CATCH P2002 → continue   ← invariant I1 already holds; silent skip
5. return {created}
```

**Why the departure gate re-reads the ledger instead of trusting `is_departed`** (`:41-49`): the
2026-07-19 run-65 incident. A stale-code recompute cleared the derived flag fleet-wide while the
ledger still held active departures, and a flag-only gate opened tickets for every departed device.
*"The derived flag stays a useful fast filter elsewhere; this write path is safety-critical, so it
re-reads the source of truth."* **Memorise this distinction — it is the repo's model for when a
denormalised flag is and is not acceptable.**

**E2. `AutoRecoveryService.runAutoRecovery(options)`** — `auto-recovery.service.ts:~135`:

```
candidates ← tickets WHERE workType=TROUBLESHOOT AND status='OPEN'
                       AND device.state.isInactive = false     ← healthy AT THE RECOMPUTE JUST RUN
                       [AND plant.zoneId = zoneId]
             include failureCycle, plant.zoneId
             ORDER BY failureCycle.openedAt ASC        ← oldest first ⇒ a capped pass is a PREFIX

FOR EACH (stop when closed >= maxClosures, set capped=true):
   pings ← raw_device_snapshots WHERE device_id AND gps_datetime > cycle.openedAt     ← N+1
   evidence = summariseRecoveryPings(pings)
   if (!meetsRecoveryEvidence(evidence))  continue   // >=3 pings AND span >= max(15,60) min
   dryRun ? plan.push(...) : closeAsAutoRecovery(...)
```

`closeAsAutoRecovery` is **seven writes in one transaction** (`:~265`):
1. ticket → `CLOSED_AUTO_RECOVERY` + `closureType` + `closureReason` + `closedAt` + `lastStateChangedAt`
2. cycle → `VERIFIED` + `closedAt`
3. `ticket_events` row (`reasonCode` `AUTO_RECOVERY` or `MANUAL_AUTO_RECOVERY`)
4. `device_states.hasOpenFailureCycle = false`
5. **all** active `soft_states` on the ticket resolved (`resolvedBy: 'SYSTEM'`)
6. **all** live `batch_assignment_tickets` detached (`removedAt`)
7. `audit_logs` row with the ping evidence in metadata

Four of those seven were added by #229 and each had produced a wrong screen or a wrong number — most
notably `closed_at`, without which `fleet-uptime-aggregation.service.ts:86-91` counted **zero**
auto-recovery closures no matter how many fired. The others: the audit row every sibling
system-closure writer emits; soft-state resolution (CONTEXT names auto-recovery as an explicit
resolution event); and batch detachment (`MeTicketsQueryService` builds the SE day plan from
`batch_assignment_tickets` with no status filter, so a closed ticket rendered as work-to-do
indefinitely).

**Why the scan requires a currently-healthy device** (`:~110`): auto-recovery is a claim about *now*.
A flapping device satisfies the ping evidence and is still down; closing its ticket only for creation
to reopen a `REPEAT`-flagged cycle milliseconds later manufactures escalations for work nobody did.
**The filter is meaningful only at this position in the pipeline** — a standalone cron would read a
figure up to a full cadence stale. Placement and correctness are the same decision.

`AUTO_RECOVERY_MAX_PER_PASS` defaults to **200, not unlimited** (`readAutoRecoveryMaxPerPass`,
`:~65`). Unset means 200; the literal string `"unlimited"` removes the bound. The qualifying backlog
is ~9,888–11,042 tickets whose evidence is already on disk — an uncapped first pass would be an
operational event arriving as a deploy side-effect.

**E3. Recovery criteria** (`recovery-criteria.ts`): CONTEXT's full three-part rule is **>=3 pings,
>=15 min span, >=1 h stability**. The >=1 h clause was **not implemented** until #229 — the file
carried only the first two and deferred stability to "GPS verification (Issue 18), which owns it",
a claim that was stale (verification never adopted it). Measured against the live backlog on
2026-08-10, the tightening moves nothing: of 11,042 tickets satisfying >=3 pings/>=15 min, all 11,042
also span >=60 min. Both span-shaped clauses are kept as separate named thresholds because they are
two separate sentences in CONTEXT and move independently; the binding one is simply the larger.

**M. Concurrency.** `failure_cycles_one_active_per_device` partial unique (on
`OPEN|WAITING_COMPONENT|SUBMITTED|REPEAT|ESCALATED`) is the race-safe backstop;
`has_open_failure_cycle` is merely the cheap filter. `tickets.failure_cycle_id` UNIQUE means a cycle
can never have two tickets. **This is genuinely race-safe** because the check is a database
constraint, not a read-then-write.

---

#### `RecommenderModule` — pure selection, no I/O boundary of its own

**C. Entry point.** `RecommenderService.runForZone(zoneId, {now, runId})` — **no controller, no
cron.** Called only by `DispatchRunService.execute` (`dispatch-run.service.ts:~205`).

**E. The pipeline** — `recommender.service.ts:104`:

```
mode      ← SoftInactiveCountService.modeForZone(zoneId, now)      → 'DEFICIT' | 'PREVENTIVE'
overrides ← resolveActiveOverrides(prisma, [zoneId], now)          // #157, one batched lookup

tickets ← TROUBLESHOOT + OPEN + UNASSIGNED
          + notDeferredOn(istDate(now))                            // #146
          + plant.zoneId AND plant has no active deactivation      // #119
          + device has no active departure                         // #128 defence-in-depth
rankable = tickets.filter(t => t.device.state?.slaBucket != null)  ← UNRANKABLE TICKETS ARE DROPPED
sorted   = canonicalSort(rankable)                                 // ADR-0017
runList  = [...sorted, ...(mode==='PREVENTIVE' ? installBacklog(...) : [])]

weights          ← activeWeights(mode)          // priority_rule_config, `<base>_preventive` variant
clusterMultiplier← system_settings.plant_cluster_multiplier ?? 1.25
capacity         ← engineer_master {dailyCapacity, isActive}
assigned         ← committedDayLoad(istDate(now))    ← NEW-A1: seeds from the SE's WHOLE-DAY plan
clearFinalizedOrphans(zoneId)                        ← #126: delete SUGGESTED recs of finalized runs

FOR i, t IN runList:                       processingRank = i+1
   ordered   = candidates.orderedCandidatesForPlant(t.plantId)   // DEDICATED→MULTI_PLANT→FLOATING
   readiness = ordered.map(c => ({
        vehicleReadiness: 'UNKNOWN',                             ← STUB
        available: (cap?.isActive ?? true) && availability[c] === 'AVAILABLE',
        overCapacity: cap !== undefined && (assigned[c] ?? 0) >= cap.dailyCapacity,
        commonKitComplete: kitStatus[c]?.complete ?? true,
        expectedComponentsAvailable: true,                       ← STUB
   }))
   filtered = applyHardFilters(readiness)                        // FIRST-FAILURE-WINS
   chosen   = planned?.find(passed) ?? passed[0] ?? null         // SE-Planner soft bias, ADR-0022

   if chosen === null:
      recommendations.create({status:'UNASSIGNABLE', scoreBreakdown:{reason:'NO_ELIGIBLE_SE',…}})
      unassignableReasons[ordered.length===0 ? 'NO_COVERAGE' : 'ALL_DROPPED']++
      if a candidate was dropped COMMON_KIT_INCOMPLETE → inventory.recordComponentBlock(...)
      continue

   inventory.resolveComponentBlock(ticketId, now)
   scored = scoreCandidate(features, weights, isFirstTicketForPlant ? 1 : clusterMultiplier)
   TRY recommendations.create({status:'SUGGESTED', seId, scoreBreakdown, processingRank, runId})
   CATCH P2002 → continue        ← #126 guard-not-throw: a concurrent RUNNING run owns this ticket
   assigned[chosen]++ ; recommended++
   traceRows.push({...})                     ← observe-only decision trace

dispatchDecisionTrace.createMany(traceRows)
```

**Hard filters and their real feed** (`hard-filters.ts:711`, `recommender.service.ts:~217`):

| Filter | Drop condition | Actual feed today | Status |
|---|---|---|---|
| `VEHICLE_ON_TRIP` | `vehicleReadiness === 'ON_TRIP'` | hard-coded `'UNKNOWN'` | **CONFIGURED BUT UNUSED — can never fire** |
| `SE_UNAVAILABLE` | `!(engineer_master.isActive && availability === 'AVAILABLE')` | `SeAvailabilityService.currentStatusMany` | IMPLEMENTED |
| `OVER_CAPACITY` | `committedDayLoad + in-run >= dailyCapacity` | real, **whole-day** across zones and prior runs | IMPLEMENTED |
| `COMMON_KIT_INCOMPLETE` | `se_van_stock` fails `common_kit_definition` min qty | `InventoryService.commonKitStatus` | IMPLEMENTED |
| `COMPONENT_UNAVAILABLE` | expected components OOS | hard-coded `expectedComponentsAvailable: true` | **PLANNED ONLY (#51)** |

Activity-ping staleness is **deliberately not a filter** (`hard-filters.ts:680-684`; CONTEXT §3/§16
revised 2026-06-09, superseding ADR-0016/0024) — an SE working offline or in a no-network field area
must stay a candidate; intra-day unreachability is resolved by the acceptance timeout + reroute
(#29/#30), not by dropping the candidate here.

**Scoring** (`scoring.ts:~75`) is deterministic and explainable — **no AI, no ML, no heuristic
learning, no external inference call**:

```
baseScore = w_rank·rankScore(A=1.0,B=0.9,…)
          + w_urgency·dispatchUrgency(bucketIndex/7)
          − w_repeat_penalty·(repeat?1:0)
          + w_repeat_bonus·(repeat?1:0)               [PREVENTIVE only, default 0]
          + w_device_age·min(1, inactivityHours/168)  [PREVENTIVE only, default 0]
          + w_distance·(1/(1+km))                     [always 0 today — distance is null]
score     = baseScore × clusterMultiplier
```

**Canonical sort** (`canonical-sort.ts:784`): Tier desc → Bucket desc → PriorityRank asc →
Oldest-inactive asc → DeviceID asc. `TIER_ORDER_EFFECTIVE_PRIORITY_DESC` is **derived** from
`TIER_ORDER` by `.reverse()`, not hand-duplicated, so a drift between the two encodings is a real
test failure (#157 AC-1 spec-pin).

**The floating leg re-validates against the source table.** `orderedCandidatesForPlant` joins
`plant_eligible_floating_se` to `engineer_master` and requires `coverage_type='FLOATING' AND
is_active=true` (`candidate-selection.service.ts:656-665`), because the MV is a *territory-geometry
index only* — its definition cannot express coverage type or active status, and it is refreshed only
on territory edits. Trusting it alone would resurrect a now-DEDICATED or deactivated SE as a floating
candidate.

**A trap flagged in the code itself** (`recommender.service.ts:405-409`): runner-up scores in the
trace are computed from the *ticket's* features, not per-candidate. That is honest today because
`scoreDegenerate` is true (distance is always null). **When distance scoring lands, `scoreCandidate`
MUST receive per-candidate features** or the trace becomes an actively wrong "why this SE"
explanation.

---

#### `SchedulingModule` — the transactional dispatcher

**E. `BatchAssignmentService.dispatchForZone(zoneId, opts)`** — `batch-assignment.service.ts:53`:

```
$transaction {
  1. pg_try_advisory_xact_lock(hashtext('dispatch_zone_<id>'))     ← NON-BLOCKING
        not acquired → return null  → caller reports skipReason 'LOCK_CONTENDED'
  2. recs ← recommendations WHERE status='SUGGESTED' AND seId NOT NULL AND ticket.plant.zoneId
            ORDER BY processingRank ASC
  3. alreadyAssigned ← batch_assignment_tickets WHERE ticketId IN recs AND removedAt IS NULL
     freshRecs = recs − alreadyAssigned      ← idempotency belt (the partial unique is the braces)
  4. group  se → plant → [ticketIds]  (insertion order = canonical order)
  5. FOR EACH se:
       existing = work_schedules WHERE se,zone,dateFrom AND liveScheduleFilter()  ← #153 incl. OVERRIDDEN
                  ORDER BY scheduleId ASC       (oldest-first: keep the plan being executed)
       scheduleId = existing ?? create({status:'ACTIVE', source:'SYSTEM_GENERATED', runId})
       stopSequence = MAX(existing stops)          ← APPEND, never reorder
       FOR EACH plant:
          stopSequence++
          plant_batch_assignments.create({status:'AUTO_ASSIGNED', stopSequence, runId})
          FOR EACH ticket:
             batch_assignment_tickets.create({sortOrder})
             ticket.update({assignmentState:'FORMALLY_ASSIGNED', deferredUntil:null})
       notifications.push({seId, scheduleId, stops, tickets})      ← BUFFERED, not sent
  6. recommendations.updateMany(recs → status:'DISPATCHED')     ← CONSUME ALL, incl. duplicates
}
CATCH:
  clearRunZoneOrphans(runId, zoneId)     ← FIRST, rollback-cause-agnostic
  P2002 → return {skipReason:'SCHEDULE_CONFLICT: SE(s) … already hold an ACTIVE schedule …'}
  else  → rethrow (a genuine failure, recorded on the zone row)

AFTER COMMIT: fire the buffered notifications   ← a rolled-back plan never announces "Day Plan is live"
```

Four things to memorise:

1. **`try_` advisory lock, not blocking.** A concurrent dispatch *skips with a reason*; it does not queue.
2. **Notifications are buffered in-tx and fired post-commit.** Network I/O has no place inside a DB
   transaction, and a rolled-back plan must not notify.
3. **`liveScheduleFilter()` includes `OVERRIDDEN`, but `conflictingScheduleSeIds` deliberately does
   not** (`:~250`) — that method answers "which rows did the *database* refuse to duplicate?", and
   the index is partial on `status='ACTIVE'`; naming overridden schedules there would blame rows that
   cannot have caused the collision.
4. **#153's real cost:** six read sites independently filtered `status:'ACTIVE'`, so a ZM-adjusted
   plan looked non-existent. The SE's whole day returned empty; `committedDayLoad` reset their load
   to 0 (so the next run could hand them a full second day); and the same-day APPEND created a
   *second* schedule **unopposed**, because `work_schedules_one_active_per_se_zone_day` is partial on
   `ACTIVE`. `LIVE_SCHEDULE_STATUSES` in `scheduling/schedule-status.ts` is now the one definition of
   "live"; `COMPLETED`/`PARTIAL` stay excluded, pinned by test.

**`DispatchRunService.runForActiveZones`** (`dispatch-run.service.ts:~120`) wraps this with: an
**in-process per-zone in-flight map** returning `{result:'CONFLICT', inFlight:[…]}`; a `dispatch_runs`
ledger row with a **config snapshot frozen at run start** (active weight sets, cluster multiplier,
`eligibility_mode`, the per-SE capacity map, scheduler flag + cron, and every ACTIVE unexpired tier
override — so history shows the config that applied); audit brackets `DISPATCH_RUN_STARTED` /
`DISPATCH_RUN_FINISHED`; one `dispatch_run_zones` row per zone **written for successes AND contained
failures**; and per-zone error containment. Status: `SUCCESS` if zero zones had an issue, `FAILED` if
every zone errored, else `PARTIAL`.

The in-flight guard **lives in `runForActiveZones`, not on the scheduler** — deliberately (`:~135`):
the scheduler's private field guarded only its own tick, and the manual trigger (the path an operator
reaches for in an emergency) called straight past it. It is released in a `finally` so a throwing run
cannot wedge its zones permanently refusing.

---

## §4. Authentication & Authorization

### 4.1 The full trace

```
POST /api/auth/login   { email, password }   [+ X-Device-Id]
  ↓  AuthGuard: @Public() on AuthController class → bypass          auth.controller.ts:17
  ↓  RoleGuard: no @Roles → pass
  ↓  ZoneScopeGuard: no user on request → pass (role !== ZONAL_MANAGER branch)
  ↓  ValidationPipe: body typed as the INTERFACE LoginRequest, not a class
     ⇒ Nest skips non-class metatypes ⇒ NO VALIDATION RUNS on this body
  ↓  AuthController.login(body, deviceId ?? randomUUID())           auth.controller.ts:21
  ↓  AuthService.login(email, password, deviceId)                   auth.service.ts:18
  ↓  PrismaUserStore.validateCredentials(email, password)           prisma-user-store.ts:36
  │     user ← users.findUnique({where:{email}, include:{credential:true}})
  │     if (!user || !user.credential) { await hashDummyPassword(password); return null }  ← timing
  │     verifyPassword(password, credential.passwordHash, credential.passwordSalt)
  │        scryptAsync(password, salt, 64) + timingSafeEqual        password-hasher.ts:36
  │     → {userId, email, role, zoneId}   |   null → 401 UnauthorizedException
  ↓  AuthService.issueTokens(user, deviceId)                        auth.service.ts:52
  │     accessToken  = TokenService.signAccessToken({user_id, role, zone_id})
  │        header  base64url {"alg":"HS256","typ":"JWT"}
  │        payload base64url {user_id, role, zone_id, iat, exp: iat+900}   ← 15 MIN
  │        sig     HMAC-SHA256(header.payload, JWT_ACCESS_SECRET).base64url
  │     refreshToken = PrismaRefreshTokenStore.issue({userId, deviceId, rotatedFrom})
  │        $transaction([
  │           refresh_tokens.updateMany({userId, revokedAt:null} →
  │                                     {revokedAt:now, revokedReason:'REPLACED_BY_NEW_DEVICE'}),
  │           refresh_tokens.create({tokenHash: sha256(random32), deviceId, expiresAt: +30d})
  │        ])                                   ← D-2 one-active-device, replace-on-login
  │        returns the RAW token; ONLY its SHA-256 is persisted
  ↓  200 { accessToken, refreshToken }

──────────────────────────────────────────────────────────────────────────────────

ANY authenticated request:   Authorization: Bearer <access>
  ↓  AuthGuard.canActivate                                          auth.guard.ts:31
  │     @Public on handler OR class → return true
  │     no header / not "Bearer " → 401
  │     tokens.verifyAccessToken(token)                             token.service.ts:37
  │        3 parts? → recompute HMAC-SHA256 over "header.payload"
  │        length-equal + timingSafeEqual → else "Invalid signature" → 401
  │        decoded.exp < now → "Token expired" → 401
  │        return {user_id, role, zone_id}
  │     request.user = claims
  ↓  RoleGuard.canActivate                                          role.guard.ts:22
  │     required = @Roles on handler ?? class      (getAllAndOverride: handler WINS)
  │     none/empty → true
  │     required.includes(request.user.role) → true, else 403 ForbiddenException
  ↓  ZoneScopeGuard.canActivate                                     zone-scope.guard.ts:20
  │     role !== 'ZONAL_MANAGER' → true     ← CSM / OH / WM / SE are NOT zone-clamped here
  │     requestedZone = Number(params.zoneId ?? query.zone_id)
  │     undefined / '' / NaN → true          ← NO EXPLICIT ZONE TARGET ⇒ NOT CLAMPED
  │     requestedZone !== user.zone_id → 403 'ZONE_SCOPE_VIOLATION'
  ↓  ValidationPipe (class-typed DTOs only)
  ↓  Controller → Service
```

### 4.2 Authentication vs Authorization — where each lives

**Authentication ("who is this?")** is entirely `AuthGuard` + `TokenService`. Claims are
`{user_id, role, zone_id}` — nothing else. No `iss`, no `aud`, no `jti`, no session lookup on the
access path.

**Authorization ("what may they touch?")** is enforced in **four distinct layers**. You must know all
four:

| Layer | Mechanism | Where | Covers |
|---|---|---|---|
| 1. Role allow-list | `@Roles(...)` + `RoleGuard` | declarative, per route/class | "can this role call this endpoint at all" |
| 2. Explicit zone-param clamp | `ZoneScopeGuard` | global | `:zoneId` route param, `?zone_id` query — **ZM only** |
| 3. Implicit row scoping | per-service `Prisma.sql` predicates | e.g. `ticket-query.service.ts:254`, `:312` | list/detail endpoints that take **no** zone param |
| 4. Ownership / coverage | `SeCoverageService`, `isTicketReadableBySe` | `shared-pool/se-coverage.service.ts`, `me-tickets/se-ticket-access.ts` | SE-facing surfaces |

Layer 3, verified concretely: `TicketsController.list` passes `{role: user.role, zoneId: user.zone_id}`
(`tickets.controller.ts:52`) and `TicketQueryService.list` appends
`` AND p.zone_id = ${BigInt(scope.zoneId)} `` only when `role === 'ZONAL_MANAGER' && zoneId !== null`
(`ticket-query.service.ts:254-255`). Same in `getById` (`:312`) and `formsForTicket` (`:345`, which
delegates to `getById`). **This is a per-service convention, not a framework guarantee.**

Layer 4, verified: `isTicketReadableBySe` (`se-ticket-access.ts:~25`) — a ticket is SE-readable if
**(a)** `assignedSeId === seId`, **or** it appears in the SE's live
`WorkSchedule → PlantBatchAssignment → BatchAssignmentTicket` chain, **or (b)** it is `OPEN` +
`UNASSIGNED` + not deferred at a plant the SE covers. `SeCoverageService.coveredPlantIds` =
`se_coverage` ∪ `plant_eligible_floating_se` MV.

`TroubleshootSubmissionService.submit` enforces the coverage floor **before** the status branch,
*"so an out-of-coverage SE never learns a closed ticket's winner/conflict details"*
(`troubleshoot-submission.service.ts:~123`) — a deliberate information-leak defence.

### 4.3 Acting-as attribution (attribution, NOT authorization)

`resolveActingContext` (`auth/acting-context.ts`) reads `X-Acting-As-Zone`. A
`CENTRAL_SERVICE_MANAGER` or `OPERATIONS_HEAD` targeting a zone gets `actedAsRole = their own role`
and `actingZone = the zone`. `@CurrentActor()` resolves this at the controller seam into a
`RequestActor`, which `auditActor()` flattens onto every `audit_logs` row.

**Read the comment at `acting-context.ts:26-28`: this is *request-context attribution only*.** The
backup-cascade *authorization* — who may act when, driven by `role_unavailability` — is explicitly
noted as landing "with the DB slices (TB6+)". I found **no code that checks `role_unavailability`
before honouring `X-Acting-As-Zone`**. A CSM or OH can set that header unconditionally. Today that is
harmless because CSM/OH are not zone-clamped anyway, but it means the header is attribution, not a
permission grant. **Do not build authorization on it.**

### 4.4 Possible authorization gaps — each supported by actual code

| # | Gap | Evidence | Real impact |
|---|---|---|---|
| A1 | **`ZoneScopeGuard` reads only `params.zoneId` and `query.zone_id`.** A zone id arriving in a **request body**, or under any other param name, is not clamped. | `zone-scope.guard.ts:45` | Any ZM-writable route taking a zone in the body relies entirely on its service. Not exploitable on the routes I read; a **standing footgun for new endpoints**. |
| A2 | **A blank or non-numeric zone param silently passes.** `''` → `undefined` → allow; `Number('abc')` → `NaN` → allow. | `zone-scope.guard.ts:47-52` | `?zone_id=` is treated as "no zone target". Whether that widens a read depends on the service's fallback. |
| A3 | **`GET /api/zones/:zoneId` has no `@Roles`.** Any authenticated user — including a `SERVICE_ENGINEER`. | `zones/zones.controller.ts:5-12` | Body is a stub returning `{zoneId: Number(zoneId)}`. Harmless **today**; will not be once implemented. |
| A4 | **Access tokens are not revocable.** Logout revokes the refresh token and clears the push token, but the 15-minute access token stays valid — no `jti`, no denylist. | `auth.service.ts:43-47`, `token.service.ts:37` | Up to 15 min of post-logout API access. A standard trade-off, but state it explicitly in any security review. |
| A5 | **`consume()` is a read-then-write, not an atomic conditional update.** `findUnique` → check `revokedAt === null` → `update`. No transaction. | `prisma-refresh-token-store.ts:77-92` | Two concurrent refreshes with the same token both pass the check. Impact is bounded because `issue()` revokes all active tokens for the user in a transaction, so one survives — but **there is no reuse detection**, which is the point of rotation. |
| A6 | **No global rate limiting or lockout on `/auth/login`.** No `@nestjs/throttler` in `package.json`. | dependency list | Online password guessing is bounded only by scrypt cost. |
| A7 | **`X-Device-Id` falls back to `randomUUID()` per login.** | `auth.controller.ts:26-29` | The one-active-device invariant only meaningfully activates once a client sends a stable id. Called out in the code as an accepted, documented limitation (#54). |

**Two things that are correctly handled — do not "fix" them:**

- **`alg:none` is not exploitable.** `verifyAccessToken` never reads the header's `alg`; it
  unconditionally recomputes HS256 over `header.payload` and `timingSafeEqual`s. A forged header
  simply fails signature comparison.
- **Email enumeration via timing is defended.** `hashDummyPassword` runs a real scrypt derivation with
  a fixed salt on the unknown-email path (`password-hasher.ts:47-56`), and `scryptAsync` is used
  everywhere — never `scryptSync`, explicitly because the sync form would stall the whole event loop
  during a shift-start login wave (`:20-27`). This is a preserved 2026-07-28 amendment, not a style
  choice.

---

## §5. HTTP Request Lifecycle — three real endpoints

### 5.1 Authentication: `POST /api/auth/login`

| Stage | Actual code |
|---|---|
| Prefix / version | `/api/auth/login` **and** `/api/v1/auth/login` both resolve (`app.config.ts:31-34`) |
| Body parse | Express JSON, 1 MB cap → 413 via `AllExceptionsFilter`'s `httpErrorStatus` branch |
| AuthGuard | `@Public()` on the class → bypass (`auth.controller.ts:17`) |
| RoleGuard | no `@Roles` → pass |
| ZoneScopeGuard | no `request.user` → pass |
| ValidationPipe | body typed `LoginRequest` (an **interface** from `@fsm/shared`) → Nest skips non-class metatypes → **no validation** |
| Controller | `AuthController.login` — `@HttpCode(200)`, not 201 |
| Service | `AuthService.login` → `PrismaUserStore.validateCredentials` → `issueTokens` |
| Queries | `SELECT … FROM users WHERE email = $1` + join `user_credentials`; then `$transaction([UPDATE refresh_tokens …, INSERT refresh_tokens …])` |
| Models | `users`, `user_credentials`, `refresh_tokens` |
| Response | `200 { accessToken, refreshToken }` |
| Error paths | unknown email / no credential row / bad password → all `401 UnauthorizedException` with equalised timing |

### 5.2 Operational read: `GET /api/tickets?status=OPEN&limit=50`

| Stage | Actual code |
|---|---|
| AuthGuard | verifies Bearer, attaches `{user_id, role, zone_id}` |
| RoleGuard | `@Roles('ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD')` (`tickets.controller.ts:39`) |
| ZoneScopeGuard | no `:zoneId` param, no `?zone_id` → **passes without clamping** |
| ValidationPipe | all params are `@Query() x?: string` primitives → no DTO class → nothing validated |
| Controller | `TicketsController.list` (`:41`) — passes `{role, zoneId}` scope + 10 filter params, `Number()`-coercing `limit`/`offset` |
| Service | `TicketQueryService.list(scope, filters)` (`ticket-query.service.ts:252`) |
| Authorization | `` if (scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null) conds.push(Prisma.sql`AND p.zone_id = ${BigInt(scope.zoneId)}`) `` (`:254-255`) |
| Query | one composed `Prisma.sql` raw query joining `tickets → plants → zones → company_master → devices → device_states` |
| Indexes used | `tickets(status, plant_id)`, `tickets(work_type, status)`, `device_states(is_inactive, sla_bucket)` |
| Response | `TicketView[]` — `bigint` fields projected `::text` (`:143`) because BigInt does not survive JSON |
| Error paths | 401 / 403 from guards; a malformed `limit` becomes `NaN` — **NOT VERIFIED** what the service does with it; there is no `ParseIntPipe` |

### 5.3 Mutation: `POST /api/tickets/:id/troubleshoot`

```
AuthGuard → RoleGuard @Roles('SERVICE_ENGINEER')        troubleshoot.controller.ts:45
ZoneScopeGuard → SE is not ZM → pass
  ↓
TroubleshootController.submit(...)  → TroubleshootSubmissionService.submit(input)
  ↓                                                     troubleshoot-submission.service.ts:~105
1. IDEMPOTENCY   troubleshooting_submissions.findUnique({seId_clientSubmissionId})
                 hit → { result:'DUPLICATE', duplicate:true, submission }   NO SECOND WRITE
2. LOOKUP        tickets.findUnique({ticketId})
                 !ticket || workType !== TROUBLESHOOT || !failureCycleId → NOT_FOUND
3. COVERAGE      SeCoverageService.isPlantCovered(seId, ticket.plantId) → false → NOT_FOUND
                 ← checked BEFORE the status branch, deliberately (info-leak defence)
4. STATUS        ticket.status !== 'OPEN' → handleConflict(...)
                 → { result:'CONFLICT', winnerSeId/Name/At, shadowUseRecorded }   (Business 409)
5. presenceSource = input.presenceSource ?? (seGps ? 'FORM_GPS' : 'NONE')
6. $transaction {
     troubleshooting_submissions.create({ rootCause*, seGpsLat/Lon, presenceSource,
                                          componentUnavailable, photoRefs, submittedAt })
     soft_states.updateMany({ticketId, seId, resolvedAt:null} →
                            {resolvedAt, resolvedBy:'SE', resolutionReason:'FORM_SUBMITTED'})
     IF componentUnavailable:                             ← ADR-0008 / CONTEXT §8
        ticket stays OPEN (only lastStateChangedAt bumped)
        failure_cycle → WAITING_COMPONENT, primary SLA pauses
        a ComponentRequest routes to the WM
     ELSE:  (per the class docstring; body beyond :170 NOT READ IN FULL)
        ticket OPEN → VERIFICATION_PENDING
        failure_cycle OPEN → SUBMITTED
        + audit + ticket_event
   }
```

**Constraint backing it:** `troubleshooting_submissions_se_id_client_submission_id_key` UNIQUE. The
application-level `findUnique` is the fast path; the index is what makes it race-safe.

---

## §6. API Map

**Convention:** every route is `/api/<path>` **and** `/api/v1/<path>`. Auth = Bearer required unless
marked `@Public`. Roles as declared; ZM zone-clamping applies to any route carrying `:zoneId` /
`?zone_id`, plus per-service row scoping where noted. Abbreviations: `MGR` = ZM+CSM+OH,
`WM` = WAREHOUSE_MANAGER, `SE` = SERVICE_ENGINEER.

### Auth & identity
| Method | Route | Controller | Roles | Kind |
|---|---|---|---|---|
| POST | `/auth/login` | `AuthController` | **@Public** | operational |
| POST | `/auth/refresh` | `AuthController` | **@Public** | operational |
| POST | `/auth/logout` | `AuthController` | **@Public** | operational |
| GET | `/me` | `MeController` | any auth | read |
| GET | `/zones/:zoneId` | `ZonesController` | **any auth (no `@Roles`)** | read (stub) |
| GET | `/health`, `/health/ready` | `HealthController` | **@Public** | internal |

### Ingestion & integration (all `OPERATIONS_HEAD`)
| Method | Route | Kind |
|---|---|---|
| GET | `/integration/health` | internal |
| POST | `/integration/sync-masters` | sync |
| POST | `/integration/run-pipeline` | sync |
| GET | `/snapshots/latest` (MGR) · `/snapshots/runs` (OH) | read |
| POST | `/snapshots/run` | ingestion |

### Org admin (`OPERATIONS_HEAD` unless noted)
`GET|POST /org/zones` · `GET|POST /org/plants` · `GET|POST|PATCH /org/companies` · `GET /org/tiers` ·
`GET|POST|DELETE /org/tier-overrides` **(OH+CSM+ZM)** · `GET|POST /org/users`,
`PATCH /org/users/:userId` · `GET|POST /org/engineers` · `GET|POST /org/se-coverage`,
`DELETE /org/se-coverage/:id` · `GET|POST /org/se-territory`, `DELETE /:id` ·
`GET /org/geo/{states,regions,districts}` **(any auth)** · `GET|PUT /org/sla-rules` ·
`GET|POST /org/scoring-weights` · `GET|POST /org/common-kit` ·
`GET /org/zone-mappings[/pending]`, `POST /org/zone-mappings/:id/{map,ignore}`,
`POST /org/zone-mappings/reapply` · `GET|PUT|DELETE /org/plant-zone-overrides[...]`,
`GET /org/plant-zone-overrides/:sourcePlantId/impact` · `GET|PUT /settings[/:key]` ·
`GET /plants/deactivations`, `POST /plants/:plantId/{deactivate,reactivate}`

### Tickets & field loop
| Method | Route | Roles |
|---|---|---|
| GET | `/tickets`, `/tickets/:id`, `/tickets/:id/forms` | MGR (ZM row-scoped in service) |
| POST | `/tickets/:id/auto-recovery-close` | MGR |
| POST | `/tickets/:id/troubleshoot` | SE |
| POST | `/tickets/:id/soft-state` · `/me/activity-ping` | SE |
| POST/GET | `/vehicle-unavailability` (SE+MGR / MGR), `POST /:id/{confirm-date,resume-sla}` (MGR) | |
| GET | `/me/vehicle-unavailability` | SE |
| POST/GET | `/non-op` , `/non-op/queue`, `/non-op/:id/confirm` (MGR); `/non-op/:id/override-confirm` (OH) | |
| GET | `/non-op/confirm` | **@Public** — the customer confirmation link |
| — | `/recovery/*` — 12 routes (schedule/on-site/collected/unable-to-collect MGR+SE; receipt WM; queues MGR) | |
| — | `/install/*` — 7 routes (create/upload creator roles; schedule scheduler roles; on-site/fitted SE; get reader roles) | |
| GET/POST | `/verification/review`, `/verification/:ticketId/{escalate,mark-auto-recovery}`, `/verification/fraud-flags` (MGR); `/tickets/:id/verification` (SE+MGR) | |
| GET/POST | `/cross-zone` (MGR); `/cross-zone/{sweep,flag}`, `/:id/{approve,deny,defer,re-escalate}` | |
| — | `/intraday-insertions/*` — 7 routes (MGR fire/manual-assign; SE accept/decline) | |
| GET | `/me/intraday-insertions` | SE |

### Scheduling & dispatch
| Method | Route | Roles |
|---|---|---|
| GET/PUT | `/schedules/dispatch-schedule` | OH |
| POST/GET | `/schedules/dispatch-run`, `/schedules/dispatch-run/in-flight` | OH+CSM |
| POST/GET | `/schedules/bulk-unassign`, `/schedules/bulk-unassign/history` | OH |
| GET | `/schedules/me` | SE |
| POST | `/schedules/assign`, `/schedules/assign-plants` | MGR |
| GET | `/schedules`, `/schedules/engineers`, `/schedules/:engineerId` | MGR |
| GET/POST | `/batches/:batchId`, `/batches/:id/override` | MGR |
| GET/POST | `/intraday-updates`, `/intraday-updates/{add,remove,reorder}` | MGR |
| GET | `/dispatch-runs`, `/:runId`, `/:runId/zones/:zoneId`, `/:runId/tickets/:ticketId/trace` | MGR |
| GET/POST/DELETE | `/planner`, `/planner/plants`, `/planner/:id` | MGR |

### SE-facing (`/me/*`) — all `@Roles('SERVICE_ENGINEER')`
`GET /me/tickets` · `/me/tickets/:id` · `/me/tickets/:id/forms` · `/me/work-history` ·
`/me/shared-pool` · `/me/van-stock` · `/me/component-requests` · `/me/leave-requests` ·
`/me/availability` · `/me/vouchers`

### Inventory, warehouse, component requests
`GET /component-blocked` (MGR) · `GET|PATCH /inventory/warehouse-stock` + `/fulfillment-sla`
(read roles / write roles) · `GET /warehouse/shadow-use`, `POST /:id/{reconcile,dispute}` (WM) ·
`GET /warehouse/requests`, `POST /:id/{approve,ship,reject}` (WM) ·
`GET /component-requests[/by-ticket/:ticketId]` (MGR), `POST /:id/confirm-receipt` (SE),
`POST /:id/confirm-resubmit` (MGR)

### Engineers, roles, notifications, media, vouchers
`GET /engineers[/directory]`, `POST /engineers`, `PATCH /engineers/:seId`,
`POST /engineers/:seId/{status,coverage,availability}`,
`DELETE /engineers/:seId/coverage/:coverageId`, `GET /engineers/:seId` (MGR; availability also SE) ·
`POST|GET /leave-requests`, `POST /:id/{approve,reject}` · `POST /role-unavailability` (OH+CSM) ·
`GET /notifications`, `POST /notifications/read-all`, `POST /:id/read` (any auth, own rows only),
`POST /notifications/device-token` (SE) · `POST /media/upload` (SE), `GET /media/:id` (SE+review) ·
`POST /vouchers` (SE), `GET /vouchers` (review), `GET /vouchers/export`, `POST /vouchers/mark-paid`
(OH), `POST /:id/review` (review), `POST /:id/resubmit` (SE)

### Reports, dashboards, exports, explorer, devices, audit
`GET /dashboard/{zone-overview, company-plant-overview, zone-operations, critical-queue,
action-required, fleet-composition, fleet-summary, fleet-directory, activity-trend}` +
`/dashboard/operating-mode` — all MGR ·
`GET /reports/{commissioning/cohort, commissioning/installers, fleet-uptime, root-cause, efficiency,
work-type-mix, verification-outcomes}` (MGR); `/reports/{soft-inactive-trend, zm-scorecard}` (OH);
`POST /reports/*/recompute` ×5 (OH) · `GET /reports/csm-approval-share` (OH) ·
`GET /exports/entity-mapping[/summary]` (OH, audited) ·
`GET|POST /ops-explorer/*` (OH + `OpsExplorerEnabledGuard` → **404 when the flag is off**) ·
`GET /devices`, `/devices/filter-options`, `/devices/:id[/cycles|/downtime-trend]` (read roles),
`PATCH /devices/:id/deal-type` (OH) · `GET /audit-trail/tickets/:ticketId` (MGR)

### The public-surface allow-list

**Exactly four `@Public` surfaces exist**, and the decorator's own doc comment names them as the only
legitimate ones (`public.decorator.ts:5-11`):

1. `/auth/login`, `/auth/refresh`, `/auth/logout`
2. `/health`, `/health/ready`
3. `GET /non-op/confirm` (the external customer's confirmation link — the customer has no `User` row)

**`test/global-guard-validation.e2e-spec.ts` fails until its public allow-list matches.** That test is
the guard against accidental exposure.

---

## §7. Core FSM Business Flow

### 7.1 Stage table

| # | Stage | Class | Method (file) | Input | Output | Reads | Writes | Rules | Failure | Idempotent |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | Trigger | `IntegrationSchedulerService` | `telemetryTick()` `integration-scheduler.service.ts:70` | cron `*/30` | `SchedulerTickOutcome` | env | — | `INGESTION_SCHEDULER_ENABLED==='true'` **AND** `client.isConfigured()` | catches all → `{ran:false,'ERROR'}` | yes (no state) |
| 1 | Orchestrate | `IntegrationSyncService` | `ingestTelemetry()` `:88` | `{chunkSize=90}` | `TelemetryTickResult` | — | — | 409 → `{skipped:true}` | `skipOnOverlap` swallows only `RUN_IN_PROGRESS`; anything else propagates | yes |
| 2 | Open run | `SnapshotRunService` | `startRun()` `snapshot-run.service.ts:48` | — | `{runId}` | `snapshot_runs` | `snapshot_runs` RUNNING + build stamp | reap stale >30 min → FAILED; `pg_try_advisory_xact_lock('snapshot_run')`; P2002 → 409 | 409 `RUN_IN_PROGRESS` | yes (guarded) |
| 3 | Read source | `AutoPlantSourceReader` | `readChunk(cursor, size)` `autoplant-source-reader.ts:~95` | keyset `device_id` | `{rows, nextCursor, rejected?}` | `ap_widgets.tb_vehiclemaster` | none | `latest_gps_datetime NOT NULL AND device_id NOT NULL AND TRIM(device_id) <> ''`; `ORDER BY device_id LIMIT n` | throw → worker catches, run PARTIAL/FAILED | yes (pure read) |
| 4 | Map / normalize | `mapVehicleMasterRow` | `mapping.ts:~200` | `VehicleMasterRow` | `SourceSnapshotRow \| null` | — | — | offset **0**; skip null device / null ping; reject `> now+60min` (`FUTURE_SKEW`) or `< 2000-01-01` (`IMPLAUSIBLE_PAST`) | `normalizeGpsTimestamp` **throws** on an unparseable stamp | pure |
| 5 | Journal | `SnapshotIngestionService` | `ingestChunk(runId, rows)` `snapshot-ingestion.service.ts:47` | <=90 rows | `{inserted, deviceStatesUpserted, unknownDevices}` | `devices` | `raw_device_snapshots`, `device_states` | `createMany skipDuplicates`; per-device dedupe (max ping, max trip, **min** first-report) | throw → chunk retried ×3 exp-backoff | **yes** — `(device_id, gps_datetime)` UNIQUE |
| 6 | Finalize | `SnapshotIngestionWorker` | `run()` `snapshot-ingestion.worker.ts:47` | opts | `SnapshotRunResult` | chunk outcomes | `snapshot_runs`, `snapshot_run_chunks` | SUCCESS / PARTIAL / FAILED; two asymmetric cursors | read error → PARTIAL if any chunk landed, else FAILED | yes |
| 7 | **GATE** | `IntegrationSyncService` | `runPostIngestStages()` `:135` | `snapshotStatus` | staged summary | — | — | **must be `SUCCESS` or stages 8–10 do not run** | n/a | yes |
| 8 | Derive | `DeviceStateService` | `recompute(now, trigger, {skipDerivation})` `device-state.service.ts:~110` | `now` | `{upserted, derived}` | `devices`, `vehicles`, `device_commissioning`, `device_departures`, `pgi_history`, `non_operational_markings`, `system_settings` | `device_states`, `device_state_recomputes` | inactivity, `is_inactive`, `sla_bucket`, eligibility, departure exclusion | `assertDepartureInvariant` throws → **UPDATE rolls back** | yes (function of `now`) |
| 9 | Auto-recover | `AutoRecoveryService` | `runAutoRecovery({maxClosures})` `auto-recovery.service.ts:~135` | cap = 200 | `{closed, scanned, examined, capped}` | `tickets`, `failure_cycles`, `raw_device_snapshots` | ticket, cycle, event, device_state, soft_states, batch rows, audit | healthy device + >=3 pings + span >=60 min | per-ticket tx; a throw aborts the pass | yes (a closed ticket leaves the scan) |
| 10 | Create | `TicketCreationService` | `createForInactiveEligible(now)` `ticket-creation.service.ts:31` | `now` | `{created}` | `device_states`, `company_master`, `plants`, `company_tier_overrides`, `plant_deactivations`, `failure_cycles` | `failure_cycles`, `tickets`, `ticket_events`, `device_states` | I1; ADR-0021 24h REPEAT; effective tier; deactivated-plant + departure exclusion | P2002 → skip that device | **yes** — I1 partial unique |
| 11 | Recommend | `RecommenderService` | `runForZone(zoneId, {runId})` `recommender.service.ts:104` | zone | `RunSummary` | tickets, coverage, MV, `engineer_master`, availability, van stock, weights, planner | `recommendations`, `dispatch_decision_traces` | precedence, hard filters, scoring, canonical sort | P2002 → skip ticket; orphans cleared pre-run | **partially** — clears finalized orphans then re-creates |
| 12 | Dispatch | `BatchAssignmentService` | `dispatchForZone(zoneId, opts)` `batch-assignment.service.ts:53` | dates, runId | `DispatchSummary` | `recommendations` | `work_schedules`, `plant_batch_assignments`, `batch_assignment_tickets`, `tickets`, `recommendations` | advisory lock; APPEND not collide; consume all recs | P2002 → `skipReason`; else rethrow after orphan cleanup | **yes** — consumption + 3 partial uniques |
| 13 | Field loop | 11 sweeps | `BusinessSweepSchedulerService` | cron | per-sweep | — | many | per-sweep | never throws out of cron | per-sweep |
| 14 | Verify | `VerificationService` | `runVerification(now)` `verification.service.ts:33` | `now` | `{closed, failed, fraud, pending}` | `tickets`, `verification_runs`, `raw_device_snapshots` | `verification_runs`, `tickets`, `failure_cycles`, `audit_logs` | Phase 1 >=3 pings / >=15 min span / gap <=30 min / first ping within ±500 m; Phase 2 1 h stability | per-ticket | yes — recomputes from pings each scan |
| 15 | Report | 5 aggregation services | `computeMonth` / `computeDay` | period | counts | operational tables | 5 summary tables | delete+insert rebuild | contained by `runGuarded` | **yes** by construction |

### 7.2 The same flow in plain English

Every 30 minutes (when enabled), the scheduler checks two gates — the env flag and whether AutoPlant
credentials exist — and if both pass calls the orchestrator. The orchestrator asks the snapshot worker
for a run. The worker opens a `snapshot_runs` row behind an advisory lock and a partial unique index,
then walks `tb_vehiclemaster` by keyset on the immutable `device_id`, 90 rows at a time.

It uses `device_id` and **not** a telemetry watermark, and the reason is worth understanding:
`device_id` is immutable and finite, so the keyset walks a strictly-increasing key space once and
finishes in `ceil(N / 90)` queries regardless of how actively the fleet pings. And because scan
membership and order ride the immutable key rather than the mutating telemetry timestamp, a device
that re-pings mid-scan (advancing `latest_gps_datetime`) can neither sort ahead of the cursor to be
re-read, nor fall below a watermark to be skipped. Every device is visited exactly once per run with
whatever value it holds at scan time; the next run re-reads it, and `ON CONFLICT DO NOTHING` makes the
unchanged re-reads free. **There is deliberately no cross-run resume cursor** — correctness must not
depend on a persisted watermark. `snapshot_runs.data_as_of` exists for the freshness banner only and
never gates which rows are scanned.

Each row is mapped by a pure function that reads the naive `DATETIME` **as UTC** (offset 0 — this was
`330` for a month and was wrong; see §8.3) and rejects anything more than an hour in the future or
before the year 2000. Each chunk is written with `INSERT … ON CONFLICT DO NOTHING`, retried three
times with exponential backoff, and recorded individually in `snapshot_run_chunks`. The same chunk
write also maintains, in one `unnest` statement, the hot `device_states` columns:
`latest_gps_datetime` and `trip_creation_datetime` by `GREATEST` (never regress), and
`first_reported_at` by `COALESCE` (write-once — `LEAST` would have been wrong in a specific way:
after the offset fix, correct values are 5.5 h *later*, so `LEAST` would pin every device to its
poisoned pre-fix value forever).

The run finalizes SUCCESS, PARTIAL, or FAILED. **That verdict is now consulted.** On anything but
SUCCESS the derive pass runs in `skipDerivation` mode — it still guarantees a row per device, but
leaves inactivity, bucket and `computed_at` at their last-good values so the dashboard visibly lags
rather than confidently lying — and auto-recovery and ticket creation are skipped entirely.

On SUCCESS, the derive pass rewrites every `device_states` row in two set-based statements. Then
auto-recovery closes tickets whose device is healthy *at this recompute* and has produced >=3 pings
spanning >=60 minutes since the cycle opened, capped at 200 per pass, oldest failure first. Then
ticket creation opens a Failure Cycle plus one parented TROUBLESHOOT ticket for every device that is
inactive, eligible, not departed, at a live plant with a company, and has no open cycle — the exact
complement of the auto-recovery set.

Separately, at 05:00 (business timezone, settings-configurable), the dispatch run loops every zone with
at least one plant. For each it runs the recommender — which sorts tickets canonically, walks
candidate SEs in strict coverage precedence, drops them through five hard filters (two of which are
stubs today), scores the survivor, and writes a `recommendations` row with a full explainability
breakdown — then hands the SUGGESTED set to the dispatcher, which under a per-zone advisory lock
builds or appends to each SE's day plan and flips every recommendation to DISPATCHED so a re-run is a
clean no-op.

---

## §8. AutoPlant Integration

### 8.1 The ownership boundary

```
             FSM (Postgres, read-write)                 AUTOPLANT (MySQL, READ ONLY)
             ─────────────────────────                  ────────────────────────────
FSM OWNS:                                    AUTOPLANT OWNS:
  zones                                        mst_company.{company_name, company_type, status}
  plants.zone_id, plants.district_id           mst_plant.{plant_name, zone_*, region_*,
  company_master.company_tier                            plant_state, plant_district,
  company_master.company_priority_rank                   master_plant_*, status}
  company_tier_overrides                       mst_transporter.{transporter_name, status}
  devices.deal_type                            mst_vehicle / tb_vehiclemaster:
  plant_zone_overrides                            vehicle_no (natural key)
  plant_deactivations                             device_id  (natural key)
  device_departures                               plant_id / company_id / transporter_id
  device_commissioning (append-only)              deployment_status
  zone_mappings                                   DEVICE_TYPE, IMSI_NO
  everything ticket/schedule/inventory            FIRST_INSTALLED_DATE_TIME / _BY
                                                  INSTALLATION_REMARK
                                                  latest_gps_datetime, latitude/longitude, speed,
                                                  IGNITION_STATUS, TRIP_CREATION_DATETIME,
                                                  gpssignal (JSON)
```

**The anti-drift guarantee is structural.** `master-mapping.ts` builds each `UpsertPlan` as
`{where, create, update}` where `update` = `mirrored` — a spread of AutoPlant-authoritative fields
only. FSM-owned columns appear in `create` (as neutral INSERT-ONLY defaults: `SILVER` tier, rank `C`,
the resolved `zoneId`/`districtId`) and are **physically absent from `update`**. There is no flag to
forget. `mapDevice` does not mention `dealType` at all.

### 8.2 Production safety constraints — verified in code, not assumed from docs

| Constraint | Enforced? | Where |
|---|---|---|
| **Read-only** | YES — code-level allow-list `SELECT\|SHOW\|DESCRIBE\|DESC\|EXPLAIN` on the first token, rejecting everything else *"regardless of what the account is granted"* | `autoplant-mysql.client.ts:~205` |
| **Page size <=90 (DBA <100/query cap)** | YES — telemetry: default `chunkSize` 90 + `LIMIT ${limit}` in the reader. Master source: paginated <=90, asserted by `test/autoplant-master-source-pagination.spec.ts` | reader + module wiring |
| **Connection limit** | YES — `connectionLimit: 4`, `waitForConnections: true` | `buildPoolOptions` |
| **Per-statement timeout** | YES — `withQueryTimeout(work, 30_000ms, sql)` via `Promise.race`; env `AUTOPLANT_QUERY_TIMEOUT_MS` | `:~150` |
| **TCP connect timeout** | YES — `connectTimeout: 10_000ms`; env `AUTOPLANT_CONNECT_TIMEOUT_MS` | `buildPoolOptions` |
| **Lazy pool** | YES — created on first query; unset env never blocks boot | `getPool()` |
| **Cleanup** | YES — `onModuleDestroy` → `pool.end()`, `pool = null` | end of class |
| **No implicit TZ conversion** | YES — `dateStrings: true`, so DATETIMEs arrive as raw wall-clock strings and the timezone decision stays in our normaliser, not the driver | `buildPoolOptions` |
| **Schema qualification** | YES — pool default is `ap_masters`; every `ap_widgets` read is backtick-qualified from `cfg.dbWidgets` | reader ctor, `AutoPlantMasterSource` |
| **Write-side batching** | YES — 500 upserts per `$transaction`; commissioning 1,000 per `createMany` (bind-param ceiling: 65,535 ÷ 9 cols ≈ 7,281) | `master-sync.service.ts:79,101` |
| **Reject cap** | YES — 5,000 `master_sync_rejects` rows per run | `:92` |
| Circuit breaker | **NOT PRESENT** — no breaker, no bulkhead beyond `connectionLimit: 4` | — |

**The `ap_widgets` qualification is a scar, not a style choice.** The pool's default schema was
changed from `ap_widgets` to `ap_masters` on 2026-07-14 (MySQL validates the default DB at connect
time and the account needed a reachable one). Every unqualified `FROM tb_vehiclemaster` then resolved
to `ap_masters` and failed `ER_NO_SUCH_TABLE` — **runs 64 through 70 all FAILED with zero chunks.**
Both readers are now qualified. A 2026-07-17 correction in the same comment block also records that
earlier claims about `ap_widgets` "not existing" on the production account were **false** — the
original connect failure was about the DEFAULT schema, not the grant.

### 8.3 The two timezone constants — the highest-value thing to understand here

`mapping.ts` defines two separate constants that currently hold the same value, and the comment
explains at length why collapsing them would be a mistake:

```ts
export const AUTOPLANT_UTC_OFFSET_MIN   = 0;   // latest_gps_datetime: a naive DATETIME that
                                               // AutoPlant WRITES UTC into. Nothing converts it.
const TRIP_CREATION_UTC_OFFSET_MIN      = 0;   // TRIP_CREATION_DATETIME: a TIMESTAMP the SERVER
                                               // converts to the session zone (= UTC) on read.
```

> *"The two columns arrive UTC for **different reasons** … and only one of those reasons is a property
> of MySQL. Collapsing them into one constant would encode the coincidence and lose the distinction
> that took #222 a month to recover."*

`AUTOPLANT_UTC_OFFSET_MIN` was `330` from the very first run and was **wrong**. FSM stored every ping
5.5 h earlier than it happened, inflating `inactivity_hours` fleet-wide and **fabricating 434 of the
665 devices in the CRITICAL band**. Two independent measurements established the truth:

1. **95 snapshot runs time-travelled.** `raw_device_snapshots.gps_datetime` holds the post-conversion
   value and `snapshot_runs` records when each run ran, so per-run
   `percentile(finished_at − gps_datetime)` reconstructs the contract at every past instant. Every run
   since the first on 2026-07-07 sits in a **flat 5.52–5.65 h band with no discontinuity.** A vendor
   change would show a step. There was none: it was never IST.
2. **A second column, a different method.** `FIRST_INSTALLED_DATE_TIME` (also a naive `DATETIME`)
   agrees to the minute with `device_installation_date` (a `TIMESTAMP` in the same row, which the
   server returns already-UTC) across **17,985 devices at exactly 0 minutes, zero at ±330**.

So *"naive `DATETIME` ⇒ IST"* is wrong as a house rule for this source, not merely for this column.

**And the methodological lesson, which is the part to actually memorise:** the original 2026-07-17
verification compared `MAX(latest_gps_datetime)` (11:49:46) against an IST wall clock (11:50) and
concluded the column tracked IST. It was reading **5 devices out of 56,564** — three plants that
genuinely write IST into this UTC column — and those 5 alone decide the maximum.
***"`MAX()` is not a valid probe for a source contract: it reports the most extreme writer, not the
convention. Use percentiles."*** The comment notes that trap fired three separate times during the
investigation, **including on the investigator.**

Those ~5 IST writers are now caught by the future-skew guard, which was tightened 24 h → 1 h **in the
same release as the constant flip, not as a follow-up**. With the offset at 0 they land at
`now + 5:30`; the old 24 h tolerance accepted them; `device-state.service.ts` then clamps their
negative inactivity to 0 via `GREATEST(0, …)`, so they would read as **permanently fresh — never
inactive, never eligible for a ticket, however long they actually stay dark.** Flipping the constant
without tightening the guard would have converted a visible fleet-wide 5.5 h error into five
permanently invisible devices. 1 h is far wider than any honest disagreement (the source clock is
accurate to ~15 s and the widest observed read gap is ~27 min) and narrower than 5:30 by design.

The past-direction guard is deliberately modest — **the year 2000, and nothing cleverer.** #222
proposed rejecting pings older than the fleet p99. The code refuses, and says why: *"A device silent
for a year is not implausible data — it is the finding this platform exists to produce."* A past guard
tuned to fleet percentiles would drop exactly the devices the system exists to catch. What the guard
*can* do is reject sentinels — MySQL's `0000-00-00 00:00:00` zero-date and epoch garbage both satisfy
the naive-timestamp grammar and would otherwise be journalled as genuine pings. It explicitly **does
not** catch a systematic offset; a row shifted 5.5 h into the past is indistinguishable, per row, from
a device that pinged 5.5 h ago. Only a distributional check over a whole run can see that, and that
check is **#228 R2 and is NOT BUILT.**

### 8.4 What crosses the schema boundary, and what deliberately does not

`readVehicleMasters` does `LEFT JOIN ap_widgets.tb_vehiclemaster w ON w.vehicle_no = v.vehicle_no` for
`DEVICE_TYPE` and `IMSI_NO`, which do not exist in `ap_masters`. Before this join,
`autoplant-master-source.ts` fed `NULL AS device_type` and every sync wrote NULL — **0 of 20,935
devices had a non-null `device_type`.** The join is free (it rides the SAME paged queries; query count
and the <100-row cap unchanged) and fan-out-safe (`tb_vehiclemaster.vehicle_no` is the PK, verified
unique 60,601/60,601, and 100% of DEPLOYED vehicles match).

**Only STATIC identity crosses this join** — measured: 91 of 24,173 devices ever changed `device_type`
across 922k pings spanning 2023-03 → 2026-07 (0.38%). `TRIP_CREATION_DATETIME` deliberately does
**not** cross it: 18.4% of the DEPLOYED fleet (2,614 of 14,205) changes it per **day** and it tracks
`active_trip_id`, so it rides the 30-minute telemetry tick instead, and lands on the hot
`device_states` row rather than in the partitioned, retention-dropped `raw_device_snapshots`.

A consequence of mirroring these columns: **a widgets outage now FAILS the master run rather than
degrading it.** Since `mapDevice` mirrors `device_type`/`imsi_no`, a run that substituted NULLs would
wipe them fleet-wide; a failed run writes nothing and is visible in `master_sync_runs`.

---

## §9. Master Data Synchronization

### 9.1 The real order (it is plant-first, not company-first)

`MasterSyncService.sync()` (`master-sync.service.ts:160`) runs in FK-dependency order, anchored on
plants:

```
1. PLANTS       readPlants()                      ← the SCOPE ANCHOR
                 plantInScope(status ∈ ['ACTIVE'])          fail → skip OUT_OF_SCOPE_STATUS
                 zoneResolver.resolve(plant)                null → skip ZONE_UNRESOLVED
                 collect plant.company_id → neededCompanyIds
2. COMPANIES    readCompanies() → DERIVED: only those an in-scope plant names
                 not needed → skip NO_INSCOPE_PLANT
3. TRANSPORTERS readTransporters() → best-effort company FK
4. VEHICLES     readVehicleMasters()   ← read at ALL deployment statuses (#128)
                 plant/company unsynced → skip PLANT_NOT_SYNCED / COMPANY_NOT_SYNCED
                 !operational && !alreadyKnown → skip NOT_DEPLOYED_NEVER_KNOWN  ← INSERT-SCOPE PIN
5. DEVICES      from the same rows; same pin; no fitted device → skip NO_FITTED_DEVICE
                 stats.devices.observed = |distinct source device_ids|  ← the "Total Devices" number
6. COMMISSIONING appendCommissioning(...)   best-effort, OUTSIDE any transaction
7. DEPARTURES    reconcileDepartures(...)   best-effort, OUTSIDE any transaction
8. flushRejects → finishRun(SUCCESS) → refreshFloatingEligibility()  best-effort
```

**There is no Zone or Region sync stage.** Zones are FSM-owned; `regions`/`districts` are seed-only
(`org-seed.ts`); AutoPlant's `zone_id` / `zone_name` / `region_id` / `region_name` are mirrored onto
`plants.source_*` columns **verbatim, for audit and derivation only**, and never drive FSM's
operational `zone_id`.

**Why plant-first:** `mst_plant` is the authoritative master (per the DB team) and its `company_id` is
NOT NULL, whereas `mst_company.company_type` is dirty (real customers are typed `'NA'`) and
`mst_vehicle.company_id` is 0. So companies are **derived** — there is no company allow-list,
transporters never become companies (they own no plants), and INACTIVE/vendor companies fall out
because no in-scope plant references them.

### 9.2 Per-entity table

| Entity | Source of truth | External id | FSM id | Strategy | Insert | Update | Deactivation | Duplicate handling | Status |
|---|---|---|---|---|---|---|---|---|---|
| **Zone** | **FSM** | — | `zones.zone_id` | not synced | admin | admin | — | `zones_name_key` + `zones_name_ci_key(lower(name))` | IMPLEMENTED |
| **Region / District** | seed | — | bigint | `org-seed.ts`, idempotent | seed | seed | — | `districts(name,state)` UNIQUE | IMPLEMENTED (seed-only) |
| **Company** | AutoPlant (name/type/status); **FSM** (tier/rank) | `source_company_id` | `company_id` | **DERIVED** — created only when an in-scope plant names it | `mapCompany.create` incl. `SILVER`/`C` defaults | `{name, companyType, status}` **only** | none | `company_master_source_company_id_key` | IMPLEMENTED |
| **Plant** | AutoPlant (name/hierarchy/status); **FSM** (`zone_id`, `district_id`) | `source_plant_id` | `plant_id` | scope anchor | `mapPlant.create` incl. resolved zone | mirrored cols only — **`zone_id` never re-written** | `plant_deactivations` side table | `plants_source_plant_id_key` | IMPLEMENTED |
| **Transporter** | AutoPlant | `source_transporter_id` | `transporter_id` | plain upsert | `mapTransporter` | `{name, companyId, status}` | none | `transporters_source_transporter_id_key` | IMPLEMENTED |
| **Vehicle** | AutoPlant | `vehicle_no` (natural) | `vehicle_id` | upsert with **insert-scope pin** | only if operational **or** already known | always, incl. `status` — *this update is exactly what the departure pass keys on* | via `device_departures` | `vehicles_vehicle_no_key` | IMPLEMENTED |
| **Device** | AutoPlant (`device_type`, `imsi_no`, fitment); **FSM** (`deal_type`) | `device_id` (natural, **String**) | `device_id` | upsert; skipped if its vehicle did not sync this run | same pin | `{deviceType, imsiNo, currentVehicleId}` | `device_departures` | `devices_pkey` | IMPLEMENTED |
| **Commissioning** | AutoPlant observation | `(device_id, vehicle_id, installed_at)` | `id` | **append-only**, `ON CONFLICT DO NOTHING` | new fitment identity | **none — no UPDATE path exists** | n/a | unique index with `NULLS NOT DISTINCT` | IMPLEMENTED |
| **PGI history** | SAP | — | `id` | — | — | — | — | — | **PLANNED ONLY — no production writer.** Read-only in `device-state.service.ts`; blocker B7 |

### 9.3 Three decisions worth understanding deeply

**Why the read widened but the create did not (#128).** The `deploymentStatuses` filter was widened to
`[]` (all statuses) so a device *leaving* the fleet is **observed** rather than inferred — the
DEPLOYED-only read froze departed devices at `'DEPLOYED'` forever. But
`OPERATIONAL_DEPLOYMENT_STATUSES = ['DEPLOYED','ACTIVE']` is an **allow-list, not a deny-list**,
because AutoPlant's vocabulary is dirty (measured 2026-07-17: UNDEPLOYED 32,892 · DEPLOYED 15,652 ·
MAINTENANCE 157 · ACTIVE 40 · `'DEPLOYED/UNDEPLOYED'` 4). Anything unrecognised is treated as
non-operational rather than silently widening the fleet on a value nobody has reviewed. **Without the
pin, `vehicles` goes from ~21k to ~48.5k and every dashboard total and fleet denominator silently
changes meaning** (operator decision, 2026-07-17).

**Why `device_commissioning` is a table and not columns on `devices`.** `tb_vehiclemaster` **rewrites
fitment in place**: a re-map destroys the previous `FIRST_INSTALLED_DATE_TIME` / `FIRST_INSTALLED_BY`
at source. Measured: **10,565 devices (12.96%) have already had this moved, 1,757 by more than a
year.** Anything reading only the current source row is measuring a silently-mutating population.
Append-only is **structural, not conventional**: the unique index IS the fitment identity and the
write is `createMany({skipDuplicates:true})` → `INSERT … ON CONFLICT DO NOTHING`. There is no UPDATE
path to regress into — a re-map changes `vehicleId`, which is a NEW identity, so it appends and the
prior row is untouched. The table carries **no FKs and no NOT NULLs beyond the key**, so a fact
survives a device the mirror later loses (#227).

The writer is **inert by construction**, and two things make that guarantee real rather than hopeful:
(1) it runs OUTSIDE any transaction — the only `$transaction` on the path is `batchUpsert`, which has
already committed — so a rejection cannot poison an open transaction or roll back the mirror; and
(2) it is called AFTER every mirror write, so there is no later step whose inputs it could corrupt. A
lost run of facts costs at most one day of `observed_at` precision.

**Why `@Inject` on the two optional collaborators is load-bearing (#218).**
`DeviceDepartureService | null` and `PlantEligibleFloatingSeService | null` are **union types**, which
TypeScript always erases to `Object` in `design:paramtypes`. Without an explicit token Nest has
nothing to resolve by, and `@Optional()` turns that into a silent `undefined`. **Measured: the
departure pass ran dead for 27 consecutive syncs, all reporting SUCCESS.** The fix needs *both* the
explicit `@Inject(Class)` token *and* a value import (not `import type`, which is erased) — dropping
the `import type` alone does NOT fix it (verified by test). `#218 §4 layer 2` added the second half:
the `if (!this.departures) { logger.warn(…) }` guard, so an unresolved dependency is **named** rather
than returning into a fortnight of silence. The MV-refresh sibling carried the identical defect and
produced no symptom only because `PlantEligibilityRefreshScheduler` — which is `useFactory`-provided
with an explicit `inject:` array, and so was never affected — kept the MV fresh.

### 9.4 Zone resolution (R6)

Injected `PlantZoneResolver` = `MappingTableZoneResolver`. Precedence:

```
plant_zone_overrides pin  →  zone_mappings MAPPED row (normalized zone_name)  →  UNZONED holding zone
```

Unseen raw values are auto-discovered as `PENDING` rows. `PENDING`/`IGNORED` both land the plant in
UNZONED. Edits apply via `ZoneMappingService.reapply`, **never** by re-syncing —
`plants.zone_id` is the only stored copy of a plant's zone, which is why no recompute job exists when a
zone changes: the tickets, device-state rows and both ZM dashboards re-scope with **zero writes** to
ticket or device-state rows. A `zoneChangeImpact` probe
(`GET /api/org/plant-zone-overrides/:sourcePlantId/impact`) warns before a **mid-day** move: the
tickets follow the plant but today's dispatched `work_schedules` stay under the old zone, so until the
next run one ZM holds the plan and another sees the tickets.

**Known limit:** zone coverage is data-starved. `zone_name` is ~98% complete fleet-wide but near-absent
in the ACTIVE plants FSM syncs, so ~83% of synced devices originally landed UNZONED (reduced to ~23%
on 2026-07-13 via 47 `plant_zone_overrides`; the mechanism-starvation itself is unchanged).

---

## §10. Device State Engine

### 10.1 Field-by-field derivation (INPUT → CONDITION → RESULT)

```
INPUT                                    CONDITION                              RESULT
─────                                    ─────────                              ──────
latest_gps_datetime (from INGEST)        NOT NULL                               hours = GREATEST(0, (now − it)/3600)
  ↓ else
device_commissioning MIN(installed_at)   NOT NULL                               hours = GREATEST(0, (now − it)/3600)   [#223]
  ↓ else                                                                        hours = NULL   (the 6 source-orphans of #227)

device_departures WHERE restored_at NULL EXISTS                                 is_departed = true

hours, threshold(=24), departed          NOT departed AND hours >= threshold     is_inactive = true
hours, departed                          departed                               sla_bucket = NULL
                                         else                                   sla_bucket = slaBucketCaseSql(hours)
                                                                                  hours NULL          → NULL
                                                                                  first band <= hours → that bucket
                                                                                  (0–4h ACTIVE band)  → NULL

eligibility_mode = 'all-deployed'        COALESCE(v.status IN ('ACTIVE','DEPLOYED'), false)
eligibility_mode = 'pgi'                 EXISTS pgi_history WHERE now − pgi_date <= 15 days
  AND NOT departed
  AND NOT EXISTS non_operational_markings IN ('CONFIRMED','ACTIVE')             eligible_for_uptime

devices.current_vehicle_id → vehicles    LEFT JOIN                              vehicle_id, plant_id,
                                                                                company_id, transporter_id
                                         always                                 computed_at = now
```

`has_open_failure_cycle` is **deliberately untouched here** — it is owned by ticket creation and
auto-recovery.

The `all-deployed` base uses `COALESCE(..., false)` so no fitment / a null status is **ineligible**,
not NULL. The Non-Op exclusion applies in **both** modes. A departed device is excluded from
inactivity, bucket and eligibility in both modes — and the exclusion is explicit rather than left to
the `all-deployed` status mirror, because it must also cover the `MISSING_FROM_SOURCE` case (a
vanished `device_id` whose mirror status nobody can refresh).

### 10.2 What the engine does NOT compute

Ignition state, GPS validity, and signal state are **not derived into `device_states`.** They are
captured per-ping into `raw_device_snapshots` (`ignition_status`, `gps_validity`, `gps_mode`, `creg`,
`cgreg`, `csq`, `mains_status`, `mains_voltage`) and then **retention-dropped after
`telemetry_retention_days` (default 7)**.

Of those, `mapping.ts` populates only `ignitionStatus`, `deviceType`, `mainsStatus`, `mainsVoltage`,
`lat`, `lon`, `speed`. `gpsValidity`, `gpsMode`, `creg`, `cgreg`, `csq`, `ipAddress`, `portNo`,
`simSubscriberName`, `unitNo` are hard-coded `null` because *"Not present anywhere in ap_widgets"* —
the Technical Hints surface degrades gracefully on them.

`mainsStatus` / `mainsVoltage` are extracted from the `gpssignal` JSON's `power.mainstatus` /
`power.mainvoltage`, normalised across two vendor dialects: AutoPlant writes `"1"`/`"0"`, third
parties write `"ON"`/`"OFF"` (`coerceMainsStatus`).

**"Device silence" is the only health signal the derive engine computes.** That is the whole model:
`now − latest_gps_datetime`.

### 10.3 The SLA bucket, concretely

`SLA_BANDS` lives in `@fsm/shared` and is consumed twice — by `classifySlaBucket()` (TS) and by
`slaBucketCaseSql()` (SQL generator). Both iterate highest-band-first, first match wins. The enum
omits `ACTIVE` because *"it is the absence of a bucket"* — the 0–4 h band stores `NULL` so ACTIVE
devices never surface in a queue. The top band is `LONG_PENDING` (never `AGED_CRITICAL`). Bounds are
closed-lower / open-upper (CRITICAL = 24 <= x < 48).

**Worked example.** A device whose last ping was 30 h ago → `hours = 30` → `is_inactive = true`
(30 >= 24) → `sla_bucket = 'CRITICAL'` (24 <= 30 < 48) → if eligible, not departed, at a live plant,
and with no open cycle, a ticket opens on the next pass.

---

## §11. Ticket Engine

### 11.1 Lifecycle

```
device_states: is_inactive ∧ eligible_for_uptime ∧ ¬has_open_failure_cycle ∧ ¬departed
               ∧ plant live ∧ company present
   ↓  TicketCreationService.createForInactiveEligible          [ONE $transaction per device]
failure_cycles(OPEN | REPEAT)  ──1:1──  tickets(TROUBLESHOOT, OPEN, UNASSIGNED)
   │                                       + ticket_events(null → OPEN)
   │                                       + device_states.has_open_failure_cycle = true
   │
   ├─ device resumes, no SE form  → AutoRecoveryService  → CLOSED_AUTO_RECOVERY / cycle VERIFIED
   ├─ recommender + dispatch      → assignmentState FORMALLY_ASSIGNED, on a day plan
   ├─ SE soft states              → VIEWED / ON_SITE / TROUBLESHOOT_STARTED
   ├─ SE submits form
   │     component available      → VERIFICATION_PENDING, cycle SUBMITTED
   │     component unavailable    → stays OPEN, cycle WAITING_COMPONENT, SLA pauses, WM request
   ├─ VerificationService sweep   → CLOSED / PARTIAL_RECOVERY / FAILED_VERIFICATION / fraud→ESCALATED
   ├─ VU report                   → SLA pause + resurface at the expected-availability date
   ├─ Non-Op dual confirm         → CLOSED_NON_OPERATIONAL + an auto-created RECOVERY ticket
   ├─ repeat escalation sweep     → ESCALATED
   ├─ cross-zone (Platinum)       → parallel escalation record; ticket NEVER leaves its home queue
   └─ plant deactivated (#119)    → CLOSED + closureType OPERATIONS_HEAD_OVERRIDE_CLOSE
                                     + closureReason 'PLANT_DEACTIVATED: <reason>'
                                     parent FailureCycle → FAILED (so no REPEAT mis-flag)
```

### 11.2 **What prevents duplicate tickets for the same incident?** — the direct answer

**Four layers, and only the DB ones are race-safe:**

| Layer | Mechanism | Race-safe? |
|---|---|---|
| 1. Application filter | `device_states.hasOpenFailureCycle = false` in the candidate query (`ticket-creation.service.ts:37`) | **NO** — read-then-write across a transaction boundary |
| 2. **DB constraint** | `failure_cycles_one_active_per_device` — partial UNIQUE on `device_id WHERE state IN (OPEN, WAITING_COMPONENT, SUBMITTED, REPEAT, ESCALATED)` (widened in migration `20260621011500`) | **YES — this is the real guarantee** |
| 3. DB constraint | `tickets.failure_cycle_id` UNIQUE + a raw CHECK that `work_type='TROUBLESHOOT'` implies `failure_cycle_id NOT NULL` | **YES** — one cycle can never have two tickets |
| 4. Atomicity | All four writes in one `$transaction` — a device can never end up with a cycle but no ticket | **YES** |

The application code is written to *expect* layer 2 to fire:
`catch (e) { if (isUniqueViolation(e)) continue; throw e }` (`:110-113`), with the comment
*"invariant I1: an active cycle already exists — skip."*

**What is NOT prevented, by design:** if a device genuinely flaps in and out of inactivity across
passes, each new episode legitimately opens a new cycle — ADR-0021 flags it `REPEAT` when a VERIFIED
cycle closed within 24 h. And `is_inactive` re-derived from a partial telemetry read could open a
cycle for a device that was never actually read — **that is exactly the #230 hole, now closed by the
SUCCESS gate.**

### 11.3 SLA clocks, transitions, versioning

**SLA clocks.** The **primary** clock anchors on `failure_cycles.opened_at` and pauses via
`sla_paused` / `sla_pause_reason` / `sla_paused_at` / `sla_accumulated_pause_seconds`. A CHECK
enforces coupling: `sla_paused = (sla_pause_reason IS NOT NULL)`. The **secondary** clock is true
elapsed, never pauses, is derived from `opened_at`, and is shown only to ZM/CSM/OH (schema:2195).
Windows are tunable via `sla_rule_config (scope, key)`.

**Transitions.** `TicketStatus` has 20+ values, `FailureCycleState` 6+. Every mutating service writes
a `ticket_events` row. **Append-only is enforced by construction only — there is no DB trigger**
(schema:2349 doc comment).

**Optimistic versioning.** `version Int @default(0)` exists on `failure_cycles`, `tickets`,
`component_request`, `non_operational_markings`, and `common/transition-or-conflict.ts` is the shared
helper. I did **not** audit every mutation path for its use; SYSTEM-STATE §2.9 records enforcement as
*"per-service and incomplete."* Treat versioning as **PARTIALLY IMPLEMENTED.**

---

## §12. Recommendation Engine

**Deterministic business rules — no AI, no ML, no heuristic learning, no external inference call.**
Verified: nothing in `recommender/` imports a model, calls an API, or reads a learned artifact. The
word "score" refers to a closed-form weighted sum.

- **Trigger.** `DispatchRunService.execute` only (cron `0 5 * * *` in `Asia/Kolkata` by default, or
  `POST /api/schedules/dispatch-run`).
- **Inputs.** OPEN + UNASSIGNED + non-deferred TROUBLESHOOT tickets in the zone (plus the INSTALL
  backlog in PREVENTIVE mode); the coverage graph; the floating-eligibility MV; `engineer_master`
  capacity/active flags; `se_availability`; `se_van_stock` vs `common_kit_definition`;
  `priority_rule_config` weights; `system_settings.plant_cluster_multiplier`; `se_planner`;
  `company_tier_overrides`.
- **Mode switch.** `SoftInactiveCountService.modeForZone(zoneId, now)` → `DEFICIT` | `PREVENTIVE`
  (soft-inactive count above a threshold % ⇒ DEFICIT). PREVENTIVE appends the install backlog
  (REQUESTED + UNASSIGNED, `installSort`: tier → rank → oldest backlog) **after** the TROUBLESHOOT
  candidates, and swaps in the `<base>_preventive` weight set (or a code-derived default: repeat
  penalty → 0, repeat *bonus* 0.5, device-age 0.5).
- **Install backlog is deliberately NOT filtered on device departure** — *"An Install exists to bring
  a device INTO the fleet, so 'not currently deployed at source' is its normal starting state;
  excluding it would block exactly the work that makes the device deployed."*
- **Outputs.** Exactly one `recommendations` row per processed ticket: `SUGGESTED` with a full
  `scoreBreakdown` JSONB, or `UNASSIGNABLE` with `{reason:'NO_ELIGIBLE_SE'}`. **Never silently
  dropped** — except tickets whose device has no computed `slaBucket`, which are filtered out at
  `:136` and produce **no row at all**. Plus one `dispatch_decision_traces` row per ticket when a
  `runId` is supplied.
- **Persistence & idempotency.** `recommendations_one_suggested_per_ticket` partial UNIQUE (#100).
  Before the loop, `clearFinalizedOrphans(zoneId)` deletes SUGGESTED recs owned by a finalized or null
  run (#126 — a leftover from a rolled-back dispatch would otherwise P2002-wedge the whole zone on
  every subsequent run). Recs owned by a still-RUNNING run are deliberately left alone; the per-create
  `catch P2002 → continue` skips those tickets instead.
- **API exposure.** Not directly. Surfaced through
  `GET /api/dispatch-runs/:runId/tickets/:ticketId/trace` and the `dispatch_run_zones` rollup
  (`unassignableReasons`: `NO_COVERAGE` vs `ALL_DROPPED` plus per-filter `dropBuckets`).
- **Effective company tier (#157).** The tier driving canonical sort key 1 is the *effective* tier
  from the shared resolver `org/effective-tier.ts`: the newest ACTIVE, **unexpired**
  `company_tier_overrides` row for the (company, zone) pair, else the global
  `companies.company_tier`. Reads predicate on `expires_at`, **never** the swept `status`, so an
  override goes inert the instant it expires regardless of whether the hourly sweep has run. Ticket
  creation stamps the effective tier onto `tickets.company_tier`; existing tickets are never
  re-stamped.

---

## §13. Background/Cron Processing

### 13.1 Every registered job — verified by exhaustive grep over `src/**`

**16 `@Cron` decorators. Zero `setInterval`. Zero `@Interval`/`@Timeout`. Zero queue consumers. Zero
polling loops.** Three lifecycle hooks: `PrismaService.onModuleInit`, `SettingsService.onModuleInit`,
`DispatchScheduleService.onApplicationBootstrap`.

| Job name | Default | Env override | Master switch | Entry point | Calls | Failure | Idempotent |
|---|---|---|---|---|---|---|---|
| `ingestion-telemetry` | `*/30 * * * *` | `INGESTION_TELEMETRY_CRON` | `INGESTION_SCHEDULER_ENABLED` **+ AutoPlant configured** | `IntegrationSchedulerService.telemetryTick` `:70` | `ingestTelemetry()` | catch → `{ran:false,'ERROR'}` | yes |
| `ingestion-masters` | `0 2 * * *` | `INGESTION_MASTERS_CRON` | same | `.mastersTick` `:87` | `syncMastersTick()` | same | yes |
| `partition-maintenance` | `10 0 * * *` | `PARTITION_MAINTENANCE_CRON` | `PARTITION_MAINTENANCE_ENABLED` | `PartitionMaintenanceService` `:51` | create-ahead + retention drop | *(NOT VERIFIED)* | yes (DDL IF NOT EXISTS) |
| `plant-eligibility-refresh` | from `readPlantEligibilityRefreshConfig()` | `PLANT_ELIGIBILITY_*` | own | `PlantEligibilityRefreshScheduler` `:59` | MV `REFRESH` | *(NOT VERIFIED)* | yes |
| `business-verification` | `*/5 * * * *` | `BUSINESS_SWEEP_VERIFICATION_CRON` | `BUSINESS_SWEEPS_ENABLED` | `.verificationTick` `:152` | `VerificationService.runVerification` | `runGuarded` catch | yes |
| `business-install-verification` | `*/5 * * * *` | `…INSTALL_VERIFICATION_CRON` | same | `:157` | `InstallLifecycleService.runInstallVerification` | same | yes |
| `business-intraday-timeout` | `*/2 * * * *` | `…INTRADAY_TIMEOUT_CRON` | same | `:162` | `IntradayInsertionService.sweepTimeouts` | same | yes |
| `business-cross-zone` | `*/15 * * * *` | `…CROSS_ZONE_CRON` | same | `:167` | `CrossZoneEscalationService.sweepAutoEscalations` | same | yes |
| `business-repeat-escalation` | `*/15 * * * *` | `…REPEAT_ESCALATION_CRON` | same | `:172` | `RepeatEscalationService.runEscalationScan` | same | yes |
| `business-tier-override-expiry` | `0 * * * *` | `…TIER_OVERRIDE_EXPIRY_CRON` | same | `:177` | `TierOverrideExpiryService.sweepExpiredOverrides` | same | yes |
| `business-soft-inactive` | `0 6,18 * * *` | `…SOFT_INACTIVE_CRON` | same | `:182` | `SoftInactiveCountService.recompute` | same | yes |
| `business-system-efficiency` | `30 1 * * *` | `…SYSTEM_EFFICIENCY_CRON` | same | `:187` | `.computeDay(previousUtcDayStart)` | same | yes (delete+insert) |
| `business-fleet-uptime` | `0 3 1 * *` | `…FLEET_UPTIME_CRON` | same | `:192` | `.computeMonth(previousUtcMonthStart)` | same | yes |
| `business-root-cause` | `15 3 1 * *` | `…ROOT_CAUSE_CRON` | same | `:197` | same shape | same | yes |
| `business-zm-performance` | `30 3 1 * *` | `…ZM_PERFORMANCE_CRON` | same | `:202` | same shape | same | yes |
| **`dispatch-run`** | `DEFAULT_DISPATCH_CRON`, TZ `Asia/Kolkata` | **`system_settings.dispatch_cron`** (not env) | `BUSINESS_SWEEPS_ENABLED` | `DispatchSchedulerService.dispatchTick` `:63` | `DispatchRunService.runForActiveZones` | catch → ERROR | yes |
| `schedule-closure` | `0 4 * * *` | `SCHEDULE_CLOSURE_CRON` | `BUSINESS_SWEEPS_ENABLED` | `ScheduleClosureScheduler` `:91` | close past-dated schedules under the zone lock | same | yes |

**Cadence rationale, recorded in `business-sweep-scheduler.service.ts:20-31`:** verification and
install-verification are minutes-scale because a `VERIFICATION_PENDING` ticket must resolve quickly
and a 5-min lag is invisible to the field; intraday timeouts are 2-min because the #30 contract is a
10-min acceptance window and sub-window granularity keeps reroute latency small; cross-zone and repeat
escalation are ~15-min because they are SLA-breach detection, not real-time; tier-override-expiry is
hourly and is **status truthfulness only** (the resolver predicates on `expires_at`, so nothing
dispatch-relevant depends on its cadence); the three month-start cubes are staggered 03:00 / 03:15 /
03:30 so three heavy recomputes never start the same minute.

### 13.2 Cron mechanics you must know

- **Expressions are resolved ONCE at decorator evaluation.** `@Cron(readXConfig().someCron, …)` is a
  function call in the decorator argument, evaluated at class-decoration time. **Changing a cron env
  var requires a restart.** The `enabled` gate is re-checked **every tick**, so flipping a master
  switch does not.
- **`dispatch-run` is the one exception.** `@Cron(DEFAULT_DISPATCH_CRON, {name, timeZone})` is only
  the compile-time default; `DispatchScheduleService.onApplicationBootstrap` re-points the *registered
  job* at `system_settings.dispatch_cron`, and again on every write through
  `PUT /api/schedules/dispatch-schedule`. It uses `onApplicationBootstrap`, not `onModuleInit`,
  because `@nestjs/schedule` mounts decorator-declared jobs into its registry between those two hooks.
  This is why `SettingsService.set` **refuses** `dispatch_cron` through the generic
  `PUT /api/settings/:key` and returns `{result:'DELEGATED', endpoint:'PUT /api/schedules/dispatch-schedule'}`:
  writing it generically would accept an unparseable expression **and** leave the job on the old
  schedule, so the setting would read as changed while dispatch kept firing at the old hour.
- **`ScheduleModule.forRoot()` is registered exactly once, in `IngestionModule`.** Its explorer
  discovers every `@Cron` across the whole graph (`business-sweep-scheduler.module.ts:27`). Remove
  `IngestionModule` from `AppModule` and **all 16 jobs silently stop being registered.**
- **Every tick body follows the same three-part shape:** dormant gate → single-in-flight guard →
  try/catch returning a structured `SchedulerTickOutcome`. **No tick ever throws out of the cron
  context.** `BusinessSweepSchedulerService.runGuarded` (`:~135`) is the canonical implementation.
- **`ScheduleClosureScheduler` takes the same `dispatch_zone_<id>` advisory lock the dispatch holds**,
  with the *try* variant, and the code explains why in both directions: #127's APPEND reads an SE's
  existing live schedule and extends it inside one transaction, so a closer that flipped that schedule
  terminal in between would strand freshly-written stops on a closed plan — and only under
  concurrency, so nothing would fail loudly. Contention the other way is the costlier one (a dispatch
  that finds the lock held records `LOCK_CONTENDED` and leaves that zone's SEs without a plan for the
  day), which is kept off the table by two things, not one: the crons are an hour apart (04:00 vs
  05:00), and each zone closes in its own short transaction.

### 13.3 Is the funnel order enforced by code, or only logically expected?

```
Master Sync ──?── Snapshot Ingestion ──?── Device State ──?── Auto-recovery ──?── Ticket Creation
                                                                                        │
                                                                                        ?
                                                                                        ▼
                                                                                 Recommender ── Dispatch
```

| Edge | Enforced how |
|---|---|
| Master → Snapshot | **NOT enforced.** Two independent crons (`0 2 * * *` vs `*/30`). Coupled only inside `runPipeline()` (the OH manual path). The consequence is handled gracefully: telemetry for an unmastered `device_id` is journalled into `raw_device_snapshots` but the `device_states` upsert's `JOIN devices` skips it, counted and WARNed as `unknownDevices` (`snapshot-ingestion.service.ts:~150`). |
| Snapshot → DeviceState → AutoRecovery → TicketCreation | **HARD-ENFORCED, in code, sequentially, in one method.** `runPostIngestStages` awaits each in turn, and the whole chain is gated on `snapshotStatus === 'SUCCESS'`. This is the strongest ordering guarantee in the system. |
| TicketCreation → Recommender | **NOT enforced.** Different cron (`0 5` vs `*/30`), different module. The recommender simply reads whatever OPEN + UNASSIGNED tickets exist. Ordering is *logical only* — a ticket created at 05:01 waits for tomorrow's run or a manual trigger. |
| Recommender → Dispatch | **HARD-ENFORCED per zone**, sequentially inside `DispatchRunService.execute`'s loop, and reinforced by the `recommendations.status` state machine (only `SUGGESTED` is dispatchable). |

---

## §14. Database Architecture

**Scale:** `prisma/schema.prisma` is 2,591 lines — **~90 models + ~40 enums + 1 materialized view** —
across **77 migrations** (`20260617103804_init_system_settings` → `20260810120000_auto_recovery_closure_type`).

**Conventions:** snake_case via `@map`; `timestamptz(6)` UTC everywhere; `BigInt` autoincrement ids,
**except** UUID for `tickets`, `failure_cycles`, `troubleshooting_submissions`, `users`,
`non_operational_markings`, `media_objects`; `devices.device_id` is a **String** natural key (the
AutoPlant business id — leading-zero IMEIs like `0869925073271551` and alphanumerics like `AP03TC0959`
survive verbatim; a BigInt key would corrupt or drop them); PostGIS via `Unsupported(...)` + raw SQL;
**everything Prisma cannot express lives in raw-SQL appendices inside migrations.**

### 14.1 Core ER diagram (derived from actual `@relation` declarations)

```
                        ┌──────────┐
                        │  zones   │ ◄─── the UNZONED holding zone lives here
                        └────┬─────┘      zones_name_key + zones_name_ci_key(lower(name))
                             │ 1:N  zone_id NOT NULL (nullable-deferral explicitly rejected)
  ┌───────────────┐     ┌────▼─────┐     ┌──────────────────────┐
  │ company_master│◄────┤  plants  ├────►│ plant_deactivations  │ partial-U one active
  │  source_co_id │ N:1 │ source_  │     └──────────────────────┘
  │  company_tier │     │ plant_id │◄────┤ plant_zone_overrides │ source_plant_id UNIQUE
  │  priority_rank│     └────┬─────┘     └──────────────────────┘
  └───┬───────┬───┘          │ 1:N
      │       │              │
      │  ┌────▼──────────────▼─┐    ┌───────────────┐
      │  │      vehicles       ├───►│ transporters  │  source_transporter_id UNIQUE
      │  │  vehicle_no UNIQUE  │N:1 └───────────────┘
      │  │  status (AP mirror) │
      │  └──────────┬──────────┘
      │             │ 1:N  current_vehicle_id
      │        ┌────▼──────────────────────┐
      │        │        devices            │  device_id = PK (String, AutoPlant natural key)
      │        │  device_type, imsi_no     │  deal_type (FSM-owned, absent from every update set)
      │        └──┬──────┬────────┬────┬───┘
      │           │1:1   │1:N     │1:N │1:N
      │  ┌────────▼──┐ ┌─▼──────┐ │  ┌─▼────────────────────┐
      │  │device_    │ │device_ │ │  │ non_operational_     │ partial-U one active
      │  │ states    │ │departu-│ │  │  markings            │ customer_token UNIQUE
      │  │ latest_gps│ │ res    │ │  └──────────────────────┘
      │  │ inactivity│ │partial │ │
      │  │ sla_bucket│ │-U one  │ │  ┌──────────────────────┐
      │  │ eligible  │ │ active │ │  │ device_commissioning │ APPEND-ONLY
      │  │ has_open… │ └────────┘ │  │ U(device,vehicle,    │ NULLS NOT DISTINCT
      │  │ is_departed│           │  │   installed_at)      │ (no FKs — survives #227)
      │  │ first_rep… │           │  └──────────────────────┘
      │  │ trip_creat│            │
      │  └───────────┘            │
      │                           │  ┌──────────────────────┐
      │                           └─►│ raw_device_snapshots │ RANGE-PARTITIONED daily
      │                              │ PK(id, gps_datetime) │ by gps_datetime
      │                              │ U(device_id,gps_dt)  │ 7-day retention (settings-driven)
      │                              └──────────────────────┘
      │        ┌──────────────────┐
      │        │  failure_cycles  │  partial-U one active per device  ← INVARIANT I1
      │        │  opened/closed   │  CHECK valid_close, CHECK pause_coupling
      │        │  sla_pause*      │  self-ref RepeatChain (previous_failure_cycle_id)
      │        │  version         │
      │        └────────┬─────────┘
      │                 │ 1:1  (tickets.failure_cycle_id UNIQUE)   ← INVARIANT I2
      │        ┌────────▼──────────────────────────────────┐
      └───────►│                 tickets                    │
         N:1   │  work_type ∈ TROUBLESHOOT|INSTALL|RECOVERY │ discriminates 3 column families
               │  ticket_no BIGSERIAL UNIQUE (display label)│ TCK-##### — NEVER a FK or lookup key
               │  company_tier (denormalised at creation)   │
               │  assignment_state, deferred_until, version │
               │  partial idx (plant_id) WHERE OPEN+UNASSIGNED  ← shared pool
               └─┬───┬───┬────┬────┬────┬────┬────┬────┬───┘
                 │   │   │    │    │    │    │    │    │
    ticket_events│   │   │    │    │    │    │    │    └── vehicle_unavailability_reports
   recommendations───┘   │    │    │    │    │    └─────── inventory_transactions
        partial-U one    │    │    │    │    └──────────── component_request / _blocked_queue
        SUGGESTED/ticket │    │    │    └───────────────── verification_runs  partial-U ux_vr_active
                         │    │    └────────────────────── troubleshooting_submissions U(se,client_id)
                         │    └─────────────────────────── soft_states  partial-U ux_ss_active + 3 CHECKs
                         └──────────────────────────────── batch_assignment_tickets  partial-U one active
                                                                     │ N:1
                                                            plant_batch_assignments
                                                                     │ N:1
                                                            work_schedules  partial-U (se,zone,date)
                                                                              WHERE status='ACTIVE'  ⚠
                                                                     │ N:1
                                                            dispatch_runs / dispatch_run_zones
                                                                              / dispatch_decision_traces
```

### 14.2 The complete invariant inventory (raw SQL, extracted from all 77 migrations)

**Partial unique indexes — these ARE the business rules:**

| Index | Table | Predicate | Rule enforced |
|---|---|---|---|
| `failure_cycles_one_active_per_device` | `failure_cycles` | state ∈ 5 active states | **I1** — one live episode per device |
| `tickets_failure_cycle_id_key` | `tickets` | (full unique) | **I2** — one ticket per cycle |
| `recommendations_one_suggested_per_ticket` | `recommendations` | `status='SUGGESTED'` | one live suggestion per ticket |
| `work_schedules_one_active_per_se_zone_day` | `work_schedules` | **`status='ACTIVE'`** ⚠ | one day plan — **does not cover OVERRIDDEN (#155)** |
| `batch_assignment_tickets_one_active_per_ticket` | | `removed_at IS NULL` | one live batch row per ticket |
| `intraday_insertions_one_live_offer_per_ticket` | | `PENDING_ACCEPTANCE` | one live offer |
| `non_operational_markings_one_active_per_device` | | state ∈ (CONFIRMED, ACTIVE) | **I13** |
| `device_departures_one_active_per_device` | | `restored_at IS NULL` | one live departure |
| `plant_deactivations_one_active_per_plant` | | `reactivated_at IS NULL` | one live deactivation |
| `snapshot_runs_one_in_flight` | | `status='RUNNING'` | one snapshot run system-wide |
| `master_sync_runs_one_in_flight` | | `status='RUNNING'` | one master sync system-wide |
| `ux_vr_active` | `verification_runs` | `outcome IS NULL` | one live verification per ticket |
| `ux_ss_active` | `soft_states` | `resolved_at IS NULL` | one live soft state per (ticket, se, type) |
| `ux_cbq_active` | `component_blocked_queue` | `resolved_at IS NULL` | one live block per ticket |
| `se_coverage_dedicated_se_key` | `se_coverage` | `coverage_type='DEDICATED'` | an SE is dedicated to at most one plant |
| `device_commissioning_device_id_vehicle_id_installed_at_key` | | **`NULLS NOT DISTINCT`** | append-only fitment identity |
| `zones_name_ci_key` | `zones` | `lower(name)` | case-insensitive zone names |

**Other uniques worth knowing:** `troubleshooting_submissions(se_id, client_submission_id)`,
`expense_vouchers(se_id, client_submission_id)`, `component_request.submission_id`,
`se_planner(se_id, plant_id, planned_date)`, `zone_warehouse_stock(zone_id, component_id)`,
`se_van_stock(se_id, component_id)`, `priority_rule_config(weight_set_ref, component)`,
`sla_rule_config(scope, key)`, `districts(name, state)`, `dispatch_run_zones(run_id, zone_id)`,
`dispatch_decision_traces.recommendation_id`, `refresh_tokens.token_hash`, `users.email`,
`users.phone`, `tiers.rank`, `raw_device_snapshots(device_id, gps_datetime)`,
`snapshot_run_chunks(run_id, chunk_no)`.

**CHECK constraints (10 found):** `device_states.inactivity_hours >= 0` ·
`failure_cycles.closed_at IS NULL OR closed_at >= opened_at` ·
`failure_cycles.sla_paused = (sla_pause_reason IS NOT NULL)` · `common_kit_definition.min_qty > 0` ·
`inventory_transactions.qty > 0` · `se_coverage.coverage_type <> 'FLOATING'` ·
`se_van_stock.qty >= 0` · plus raw CHECKs on `troubleshooting_submissions.submission_type` (restricted
to the two form types), on `tickets` (TROUBLESHOOT ⇒ `failure_cycle_id` NOT NULL), and on
`engineer_territory_coverage` (at least one dimension present).

**Partial indexes (non-unique):** `ix_ss_active_ticket` (`soft_states(ticket_id) WHERE resolved_at IS NULL`),
`ix_ss_stale` (`soft_states(set_at) WHERE resolved_at IS NULL`),
`ix_ss_viewed_timeout` (`soft_states(timeout_at) WHERE resolved_at IS NULL AND type='VIEWED'`),
plus the shared-pool `tickets(plant_id) WHERE status='OPEN' AND assignment_state='UNASSIGNED'`
(migration `20260621190000`).

**Partitioning:** only `raw_device_snapshots`, `PARTITION BY RANGE (gps_datetime)`, daily. The original
migration `20260619153000` declared the clause but created only a DEFAULT partition; **rebuilt in
`20260706130000`.** 3-day create-ahead, retention from `system_settings.telemetry_retention_days`,
O(1) `DROP TABLE` per day, DEFAULT partition never dropped.

**Materialized view:** `plant_eligible_floating_se` (migration `20260621160000`) plus a
`plant_eligible_floating_se_pk` unique index (required for `REFRESH … CONCURRENTLY`).

**Soft deletion:** none. Deactivation is modelled as **FSM-owned side tables** with an active-row
partial unique — `plant_deactivations`, `device_departures`, `non_operational_markings`. This is the
repo's consistent idiom and it is deliberate: it keeps the mirror tables purely AutoPlant-authoritative,
so a re-sync cannot resurrect a deactivation.

**Audit fields:** `created_at` / `updated_at` (`@updatedAt`) on most mutable models; `audit_logs` for
the cross-cutting trail; `ticket_events` for the narrower, faster lifecycle timeline.

**Reporting summaries (all delete+insert idempotent rebuilds):** `device_downtime_summary_monthly`
(device × month), `soft_inactive_count_history` (zone × half-day),
`root_cause_summary_monthly` (month × zone × company × plant × device_type × SE × category),
`zm_performance_summary_monthly` (month × zone × ZM),
`system_efficiency_summary_daily` (day × dims, 11 `INSERT…SELECT` families).

**`NULLS NOT DISTINCT` is a trap.** `device_commissioning`'s unique index needs it, **Prisma 7.8
cannot express it**, and `prisma migrate dev` will offer a replacement without it. Accepting that
silently breaks append-only-ness: `installed_at` is null on ~13% of source rows and `NULL <> NULL`
would re-insert every one on **every daily sync**. Verify with `pg_index.indnullsnotdistinct` after
any schema change near that table.

---

## §15. Database Query & Transaction Analysis

### 15.1 Transaction inventory

| Site | Shape | Grouped because |
|---|---|---|
| `runtime-lock.ts:171` | interactive + `pg_advisory_xact_lock('runtime_lock')` | read→decide→write on the lock must be atomic across concurrent boots, so two boots cannot lose an update and leave an older build as the mark |
| `snapshot-run.service.ts:50` | interactive + `pg_try_advisory_xact_lock('snapshot_run')` | lock + insert, so a lost race never leaves a RUNNING row |
| `master-sync.service.ts:595` | **array form**, 500 ops per batch | throughput only — collapses a ~108k-round-trip storm (a `findUnique` + `upsert` per source row over ~54k vehicles + ~54k devices) |
| `device-state.service.ts:~200` | interactive: UPDATE + `assertDepartureInvariant` | a violated invariant **rolls back the UPDATE** rather than committing corruption |
| `ticket-creation.service.ts:~90` | interactive, **one per device** | cycle + ticket + event + flag must be all-or-nothing |
| `auto-recovery.service.ts:~275` | interactive, 7 writes | closure is one fact; a partial close is a wrong screen |
| `batch-assignment.service.ts:63` | interactive + per-zone advisory lock | the whole zone's day plan is one unit |
| `audit.service.ts:~58` `withAudit` | interactive wrapper | *"there is no window where a mutation is persisted unaudited"* |
| `prisma-refresh-token-store.ts:57` | **array form** | revoke-all + issue-new must not interleave |
| `verification.service.ts:~92` | interactive | ticket + event + audit |
| `troubleshoot-submission.service.ts:~130` | interactive | submission + soft-state resolution + cycle/ticket transition |

### 15.2 Locking

| Mechanism | Where | Blocking? |
|---|---|---|
| `pg_advisory_xact_lock(hashtext('runtime_lock'))` | boot guard | **blocking** — concurrent boots serialize |
| `pg_try_advisory_xact_lock(hashtext('snapshot_run'))` | `startRun` | non-blocking → 409 |
| `pg_try_advisory_xact_lock(hashtext('dispatch_zone_<id>'))` | dispatch + schedule closure | non-blocking → skip with a named reason |
| 17 partial unique indexes | schema-wide | the durable cross-process backstop |
| In-process `Map` / `Set` guards | `DispatchRunService.inFlight`, `BusinessSweepSchedulerService.inFlight` | **single-process only** — informative refusal, not the correctness mechanism |

**No `SELECT … FOR UPDATE` anywhere. No pessimistic row locking.** The model is: advisory locks for
coarse serialization, partial uniques for correctness, optimistic `version` columns where implemented.

### 15.3 Performance concerns — only those supported by actual code

| # | Concern | Evidence | Severity |
|---|---|---|---|
| P1 | **N+1 over a partitioned table in auto-recovery.** One `rawDeviceSnapshot.findMany` **per candidate ticket**, and `candidates` is an unbounded `findMany` over all OPEN TROUBLESHOOT tickets on healthy devices — loaded in full *before* the 200-closure cap applies. With ~12k open tickets the scan cost is paid every pass. | `auto-recovery.service.ts:~150-180` | **HIGH** |
| P2 | **Per-device transaction in ticket creation.** `candidates` is unbounded; a mass-inactive event over 15,696 eligible devices means 15,696 sequential transactions plus 15,696 `failureCycle.findFirst` round trips. Acknowledged in code as a #106-family concern. | `ticket-creation.service.ts:~78-115` | **HIGH under a mass outage** |
| P3 | **`orderedCandidatesForPlant` is called once per ticket, not per plant.** Two queries (`seCoverage.findMany` + a raw MV join) per ticket, even when 40 tickets share a plant. Kit status and availability *are* memoised across the run; coverage is not. | `recommender.service.ts:208` | MEDIUM |
| P4 | **`SeCoverageService.isPlantCovered` loads the SE's entire covered-plant set to answer one membership question**, and `isTicketReadableBySe` calls it per ticket. | `se-coverage.service.ts:~30` | MEDIUM |
| P5 | **`master-sync.existingKeys` loads whole mirror tables into memory** (all `vehicleNo`, all `deviceId` — ~21k + ~21k strings per sync). **Deliberate and documented**: avoids the 65,535 bind-parameter ceiling and is a single sequential scan. | `master-sync.service.ts:584` | LOW (intentional trade) |
| P6 | **`appendCommissioning` loads every non-null `firstReportedAt`** in one query — same deliberate trade, same reasoning. | `:488-494` | LOW |
| P7 | **`recommender.committedDayLoad` loads every live batch-assignment ticket for the day, fleet-wide**, then counts in JS. | `recommender.service.ts:601` | LOW–MEDIUM |
| P8 | **No index on `tickets.device_id` alone** — there is `(device_id, created_at DESC)` which covers the common lateral, and no `vehicle_id` index. SYSTEM-STATE tracks this as #103. | schema:2330-2340 | LOW |
| P9 | **`statement_timeout = 120s` is deliberately generous** — the comment says *"the goal is to bound a stuck query, not to police slow ones… Tighten it once per-statement timings exist."* No per-statement timings exist. | `prisma.service.ts:38-46` | informational |

**Indexes added for a measured reason** (know these before "cleaning up"): `tickets(device_id, created_at DESC)`
— *"without this the 20k-device fleet list seq-scans tickets once per device (~80s page load)"*
(schema:2333-2335). And `idx_device_id` on the **source** `tb_vehiclemaster.device_id`, without which
each keyset page filesorts the whole table on AutoPlant's side.

---

## §16. Idempotency & Concurrency

### 16.1 The audit table

| Operation | Idempotent? | Duplicate risk | Concurrency protection | Transaction | Evidence |
|---|---|---|---|---|---|
| **Snapshot run start** | Yes | None | `pg_try_advisory_xact_lock` + `snapshot_runs_one_in_flight` partial-U; P2002 → 409 | Yes | `snapshot-run.service.ts:48-70` |
| **Snapshot chunk write** | **Yes, by construction** | None | `(device_id, gps_datetime)` UNIQUE + `skipDuplicates` | Single stmt | `snapshot-ingestion.service.ts:78-81` |
| **device_states ping upsert** | Yes | None | `ON CONFLICT (device_id) DO UPDATE` with `GREATEST`/`COALESCE`; deduped per device in JS first so one statement never hits a conflict key twice | Single stmt | `:~160-190` |
| **Master sync start** | Yes | None | `master_sync_runs_one_in_flight` partial-U + advisory lock | Yes | `master-sync-run.service.ts` |
| **Master entity upsert** | Yes | None | `source_*_id` / natural-key UNIQUE | 500/tx | `master-sync.service.ts:592` |
| **Commissioning append** | Yes | **Yes if the `NULLS NOT DISTINCT` index is lost** | that index + `skipDuplicates` | **No — deliberately outside any tx** | `:458-519` |
| **Departure reconcile** | *(NOT VERIFIED — body unread)* | — | `device_departures_one_active_per_device` | No | `:535` |
| **Device-state recompute** | Yes (function of `now`) | None | **NONE of its own** — relies on being reachable only inside the ingestion guard | Yes (UPDATE + invariant) | `device-state.service.ts:~200` |
| **Auto-recovery pass** | Yes | None | none needed — a closed ticket leaves the `status='OPEN'` scan | Per-ticket | `auto-recovery.service.ts:~275` |
| **Ticket creation** | **Yes** | None | `failure_cycles_one_active_per_device` partial-U; P2002 → skip | Per-device | `ticket-creation.service.ts:110-113` |
| **Recommender run** | **Partial** | Low | clears finalized orphans, then `recommendations_one_suggested_per_ticket` + `catch P2002 → continue` | **No wrapping tx** | `recommender.service.ts:203, 356-359` |
| **Batch dispatch** | **Yes** | None | per-zone advisory lock + 3 partial-U + SUGGESTED→DISPATCHED consumption | Whole zone in one tx | `batch-assignment.service.ts:63-200` |
| **Dispatch run** | Yes | None | in-process per-zone `inFlight` Map (informative) + the above (durable) | ledger writes not in one tx | `dispatch-run.service.ts:~130` |
| **Troubleshoot submit** | **Yes** | None | `(se_id, client_submission_id)` UNIQUE; app-level `findUnique` fast path | Yes | `troubleshoot-submission.service.ts:~110` |
| **Voucher submit** | Yes *(inferred from schema)* | None | `(se_id, client_submission_id)` UNIQUE | *(NOT VERIFIED)* | schema:1023 |
| **Component request raise** | Yes *(inferred)* | None | `component_request.submission_id` UNIQUE | *(NOT VERIFIED)* | schema:1269 |
| **Verification sweep** | Yes | None | `ux_vr_active` partial-U; recomputes from pings each scan | Per-ticket | `verification.service.ts:33` |
| **Report cube recompute** | Yes | None | delete+insert rebuild | *(NOT VERIFIED)* | doc comments |
| **Refresh-token consume** | **NO** | **Yes** | **none — `findUnique` then `update`, no tx, no conditional update** | **No** | `prisma-refresh-token-store.ts:77-92` |
| **Business sweep tick** | Yes | None | per-name in-process `Set` guard — **single-process only**; the underlying sweeps carry no guard of their own | per-sweep | `business-sweep-scheduler.service.ts:~135` |

### 16.2 The five questions, answered from code

**"If it runs twice?"** Every pipeline stage is safe. The mechanism is always a database constraint
plus a caught `P2002`, never an existence check. The one exception is the recommender, which *deletes*
stale SUGGESTED rows and re-creates them; that is safe because it only deletes rows owned by finalized
or null runs.

**"If two instances run simultaneously?"** Snapshot/master: one gets 409. Dispatch: one gets the
advisory lock, the other records `LOCK_CONTENDED`. Device-state recompute: **nothing stops two
concurrent full-table UPDATEs.** In-process guards are explicitly documented as *informative*, not
correctness mechanisms — *"the cross-process guarantee is the advisory lock plus idempotency, which
degrade an overlap to benign skips; a second instance would not double-assign, it would simply not be
refused as informatively"* (`dispatch-run.service.ts:~100`). **This system has never been run
multi-instance and the code says so.**

**"Is the check race-safe?"** Only where the database enforces it. `hasOpenFailureCycle`, the
`alreadyAssigned` set in dispatch, and the `findUnique` in troubleshoot-submit are all **fast paths
whose correctness comes from the index behind them.** The refresh-token `consume` has **no index
behind it** and is therefore the one genuinely unsafe check.

**"If the process crashes halfway?"** Every open transaction rolls back. Orphaned `RUNNING` ledger
rows are reaped after 30 minutes (`reapStaleRuns`, run *before* `startRun` takes the lock). Orphaned
`SUGGESTED` recommendations from a rolled-back dispatch are cleared by `clearRunZoneOrphans` in the
dispatcher's `catch` (keyed by `(run_id, zone)` so a concurrent run's recs are never touched) and by
`clearFinalizedOrphans` at the start of the next recommender run. Commissioning facts lost to a crash
cost *at most one day of `observed_at` precision* — the next sync re-derives them from the source.

---

## §17. Error Handling & Reliability

### 17.1 The layers

| Layer | Implementation |
|---|---|
| Global filter | `AllExceptionsFilter` — `@Catch()` with no argument, so it catches everything |
| `HttpException` | status + `getResponse()` reproduced **verbatim**, so route error contracts like `{code:'BATCH_NOT_FOUND'}` never change; logged at `warn` |
| `http-errors` family (body-parser 413 / 400) | status honoured if 4xx; the library message is used **only if it set `expose: true`**, else `'Request rejected'` |
| Unknown error | full stack logged server-side at `error`; client gets `{statusCode:500, message:'Internal server error', correlationId, path, timestamp}` — **no internal detail ever leaks** |
| Correlation id | `x-correlation-id` request header, else `randomUUID()`; **always** set on the response header before any body is written |
| Prisma `P2002` | caught explicitly at 6+ sites and treated as a *normal outcome* |
| Cron | never throws out of context; structured `SchedulerTickOutcome` |
| MySQL | 30 s per-statement `Promise.race` timeout, 10 s connect timeout, ×3 chunk retry with exponential backoff |
| Boot | fail-fast, single fatal line, `exit(1)` |
| Circuit breaker / bulkhead | **NOT PRESENT** beyond `connectionLimit: 4` + timeouts |
| Retry (general) | **Only** the chunk retry. No HTTP retry, no DB retry, no backoff library. |

### 17.2 Dependency-failure matrix

| Scenario | Actual behaviour |
|---|---|
| **Postgres unreachable at boot** | `validateBootConfig` passes (the URL is only parsed), then the preflight `$connect()` throws → `runWithFatalGuard` → fatal + exit 1. |
| **Postgres unreachable at runtime** | `GET /health` stays **200** (deliberately no DB touch, so liveness stays green during a DB blip). `GET /health/ready` returns **503** `{status:'error', db:'down'}`. Every route 500s with a correlation id. Cron ticks log ERROR and return `{ran:false}`. |
| **Postgres saturated** | `connectionTimeoutMillis: 5000` → acquisition fails fast. *"A request that cannot get a connection must fail fast so the caller learns the server is saturated; queueing forever means a mobile retry loop stacks on top of the queue invisibly."* |
| **A query hangs** | `statement_timeout = 120s` kills it. A leaked open transaction is killed by `idle_in_transaction_session_timeout = 60s` — which *"only fires on a transaction that is open but not executing, i.e. exactly the leaked-connection case, never healthy work."* |
| **AutoPlant unconfigured (dev/test/CI)** | `readAutoPlantMysqlConfig()` → `null` → DI binds `EMPTY_MASTER_SOURCE` and `InMemorySourceReader([])`. Schedulers report `{ran:false, reason:'UNCONFIGURED'}`. **The app boots and behaves normally.** |
| **AutoPlant VPN drops mid-scan** | The read throws → the worker's outer `catch` sets `readError` → the loop stops → the run finalizes **PARTIAL** (if any chunk landed) or **FAILED**. **Never left RUNNING.** Then the #230 gate skips all downstream stages. |
| **AutoPlant blackholes packets** | `withQueryTimeout` rejects at 30 s. Without it, `readChunk` would pend forever and pin the run RUNNING — this is exactly what review A4 was about. |
| **`ap_widgets` grant/schema lost** | `ER_NO_SUCH_TABLE` on the first chunk → run FAILED with 0 chunks. This is the runs-64–70 signature. |
| **Invalid telemetry** | An unparseable `gps_datetime` → `normalizeGpsTimestamp` **throws** (a bad ping is not recoverable) → propagates as a chunk failure → retried ×3 → chunk FAILED, siblings unaffected. Contrast `parseTripCreation` / `parseInstalledAt`, which are **non-throwing by design** because they are enrichment: *"a blank or malformed trip stamp must degrade to null, never drop the row's actual GPS ping."* |
| **Malformed data (skew)** | Row dropped, counted per reason, surfaced on `SourceChunk.rejected`, and WARNed with a message that names the likely cause. *"A dropped row leaves no trace anywhere else… this field is the only place the drop is observable, which is the entire justification for preferring rejection over silent acceptance."* |
| **Duplicate record** | `ON CONFLICT DO NOTHING` or a caught `P2002` at every write site. |
| **Cron executes twice** | Same-process: the in-flight `Set`/`Map` skips. Cross-process: the advisory lock / partial unique makes the second a 409 or a benign skip. |
| **Two workers simultaneously** | See §16.2 — safe for snapshot / master / dispatch, **unguarded for device-state recompute.** |
| **Service crashes mid-operation** | Transaction rolls back; ledger row is reaped; orphan recs are cleared. |

### 17.3 The one armed-but-unsafe interaction

The verification sweep runs every 5 minutes and expires its 24-hour window on **wall-clock**
(`TWENTY_FOUR_HOURS_MS`, `verification.service.ts:19`), under `BUSINESS_SWEEPS_ENABLED` — which is
`"true"` — while `INGESTION_SCHEDULER_ENABLED="false"` means **nothing is writing the telemetry it
reads.**

A troubleshoot submission made during an ingestion pause therefore ages into an **irreversible
`FAILED_VERIFICATION`** — with its `PRE_VERIFICATION` inventory rolled back — regardless of whether
the SE actually fixed the device. Exposure is currently zero only because no SE has submitted a form.
**Armed, not safe.** Owned by #148. Partial mitigation already in place: `telemetryWatermark()` is
read once per sweep (`:47`), which is the hook a staleness precondition would use.

---

## §18. Observability & Debugging

### 18.1 What exists

| Capability | Status | Detail |
|---|---|---|
| Logging | **IMPLEMENTED (basic)** | Nest's built-in `Logger`, one instance per class, plain text to stdout |
| Structured logging | **NOT PRESENT** | no pino, no winston, no JSON formatter |
| Request logging | **NOT PRESENT — errors only** | `AllExceptionsFilter` logs `METHOD URL → status [correlationId] message` |
| Correlation ids | **PARTIAL** | generated/echoed on **error responses only**; not threaded into service logs on the success path |
| Error tracking | **NOT PRESENT** | no Sentry, no Bugsnag |
| Metrics | **NOT PRESENT** | no Prometheus, no StatsD, no OpenTelemetry |
| Tracing | **NOT PRESENT** | — |
| Health | **IMPLEMENTED** | `/api/health`, `/api/health/ready`, `/api/integration/health` |
| **Run ledgers** | **IMPLEMENTED — the real observability layer** | see below |
| **Build attribution** | **IMPLEMENTED** | `buildStampFields()` stamps `build_version` + `build_fingerprint` onto `snapshot_runs`, `dispatch_runs`, `device_state_recomputes` |
| **Semantic canary** | **IMPLEMENTED** | eligible-count swing > threshold between recomputes → one LOUD warn naming both builds |
| **Ops Explorer** | **IMPLEMENTED, flag-gated OFF** | OH-only read-only dataset explorer + reconciliation |

**The run ledgers are how you actually debug this system:**

- `snapshot_runs` — status, chunks, `data_as_of`, `cursor`, build stamp
- `snapshot_run_chunks` — per-chunk status, `retry_count`, `error`
- `master_sync_runs.entity_stats` — per-entity `{inserted, updated, skipped, observed, skippedByReason}`
- `master_sync_rejects` — entity, source key, reason (capped 5,000/run, best-effort writes)
- `dispatch_runs` — config snapshot frozen at run start
- `dispatch_run_zones` — per-zone totals, mode, `unassignableReasons`, contained error
- `dispatch_decision_traces` — per-ticket "why this SE": candidates total, passed count, per-filter drop
  counts, chosen (with precedence rank, planner-bias flag, capacity-at-decision, cluster-seed flag),
  up to 5 runners-up, `scoreDegenerate`, `poolEmptyReason`
- `device_state_recomputes` — counts + trigger + build fingerprint
- `audit_logs` — cross-cutting, same-transaction, with acting attribution
- `ticket_events` — narrower lifecycle timeline

### 18.2 Debugging path: *"vehicle MHXX is missing from the dashboard"*

A real, executable path through this repo.

```
STEP 0 — Is the funnel even running?
  GET /api/integration/health              (OH)  → configured? reachable? reconciliation drift?
  psql: SELECT run_id, status, started_at, finished_at, data_as_of, build_fingerprint
          FROM snapshot_runs ORDER BY run_id DESC LIMIT 10;
  ⚠ If INGESTION_SCHEDULER_ENABLED is "false" (it is, today) the answer is likely "nothing has run".

STEP 1 — Does the vehicle exist in FSM at all?
  SELECT * FROM vehicles WHERE vehicle_no = 'MHXX';
  MISS → it never synced. Go to STEP 2.
  HIT  → go to STEP 4.

STEP 2 — Why did master sync skip it?  ← this is what master_sync_rejects is FOR
  SELECT r.entity, r.source_key, r.reason, r.run_id
    FROM master_sync_rejects r
   WHERE r.source_key = 'MHXX' ORDER BY r.run_id DESC;

  reason = 'PLANT_NOT_SYNCED'          → its plant is not ACTIVE, or its zone did not resolve
  reason = 'COMPANY_NOT_SYNCED'        → no in-scope plant names that company
  reason = 'NOT_DEPLOYED_NEVER_KNOWN'  → the #128 insert-scope pin: non-operational deployment_status
                                          and FSM has never seen this vehicle. WORKING AS DESIGNED.
  reason = 'NO_FITTED_DEVICE'          → device_id null/blank at source

  For a plant-level reason:
  SELECT entity, source_key, reason FROM master_sync_rejects
   WHERE entity='plants' AND run_id = <same run>;
   'OUT_OF_SCOPE_STATUS' → the plant is not ACTIVE at source
   'ZONE_UNRESOLVED'     → fix via GET /api/org/zone-mappings/pending  (map the raw zone_name)
                             or PUT /api/org/plant-zone-overrides      (pin the plant)
                           …then POST /api/org/zone-mappings/reapply   ← A PIN IS INERT WITHOUT THIS

  Also check the run-level counters:
  SELECT run_id, status, entity_stats FROM master_sync_runs ORDER BY run_id DESC LIMIT 5;

STEP 3 — If it should have synced but the run itself failed:
  SELECT run_id, status, error FROM master_sync_runs WHERE status='FAILED' ORDER BY run_id DESC;
  ⚠ Also grep the log for the #218 guards — they are WARNs, not errors, and each cost a fortnight:
       "deployment-lifecycle pass SKIPPED — DeviceDepartureService did not resolve"
       "floating-eligibility MV refresh SKIPPED"

STEP 4 — Vehicle exists. Is its device mirrored and does it have state?
  SELECT d.device_id, d.device_type, d.current_vehicle_id,
         s.latest_gps_datetime, s.inactivity_hours, s.is_inactive, s.sla_bucket,
         s.eligible_for_uptime, s.has_open_failure_cycle, s.is_departed,
         s.plant_id, s.company_id, s.computed_at
    FROM devices d LEFT JOIN device_states s USING (device_id)
   WHERE d.current_vehicle_id = (SELECT vehicle_id FROM vehicles WHERE vehicle_no='MHXX');

  no device row            → the mirror skipped it (back to STEP 2, entity='devices')
  no device_states row     → the recompute has not run since the device was mirrored
  computed_at is STALE     → ★ #230: the last ingest was PARTIAL and derivation was SKIPPED.
                               Confirm: SELECT status FROM snapshot_runs ORDER BY run_id DESC LIMIT 1;
                               Confirm in the log: "derivation SKIPPED — the telemetry read … incomplete"
  is_departed = true       → SELECT * FROM device_departures WHERE device_id=… AND restored_at IS NULL;
                               observed_status tells you whether it was OBSERVED (SOURCE_STATUS) or
                               inferred (ABSENT_FROM_READ / MISSING_FROM_SOURCE)
  eligible_for_uptime=false→ SELECT value FROM system_settings WHERE key='eligibility_mode';
                               'pgi'  → SELECT * FROM pgi_history WHERE device_id=…  (likely EMPTY — B7)
                               'all-deployed' → check vehicles.status ∈ (ACTIVE, DEPLOYED)
                               either mode → SELECT * FROM non_operational_markings
                                               WHERE device_id=… AND state IN ('CONFIRMED','ACTIVE');
  latest_gps_datetime NULL → never reported. #223 ages it from device_commissioning.installed_at:
                               SELECT MIN(installed_at) FROM device_commissioning WHERE device_id=…;
                               If that is ALSO null, hours stays NULL and the device is invisible
                               by design (the 6 source-orphans of #227).

STEP 5 — State is fine but the dashboard is empty → it is a ZONE-SCOPING problem
  SELECT p.plant_id, p.name, p.zone_id, z.name AS zone
    FROM plants p JOIN zones z USING (zone_id)
   WHERE p.plant_id = <device_states.plant_id>;
  zone = 'UNZONED' → the ZM's zone filter excludes it. Fix via zone mapping / plant override.
  Also: is the caller a ZONAL_MANAGER whose token zone_id ≠ this zone? (ticket-query.service.ts:254)
  Also: SELECT * FROM plant_deactivations WHERE plant_id=… AND reactivated_at IS NULL;

STEP 6 — Recompute health / stale-build check
  SELECT computed_at, total_count, eligible_count, inactive_count, departed_count,
         trigger, build_fingerprint
    FROM device_state_recomputes ORDER BY computed_at DESC LIMIT 20;
  A cliff in eligible_count → grep the log for "[recompute-canary] eligible-count swing".
  SELECT * FROM runtime_lock;   -- which build owns this database?

STEP 7 — Last resort, if a 500 was involved
  The client's x-correlation-id RESPONSE header → grep the server log for that UUID.
  That is the ONLY link between a client-visible error and its server-side stack.
```

**What you cannot do today:** there is no request log, no latency metric, no per-query timing, and no
error aggregation. "How many 500s in the last hour?" requires grepping stdout.

---

## §19. Production End-to-End Example

**Scenario: vehicle MH-12-AB-1234 stops sending valid telemetry at 09:00 UTC on 2026-08-11.**

| # | Arrow | Class · method · file | Data / model | Condition | Failure mode | Debug location |
|---|---|---|---|---|---|---|
| 1 | Device stops writing | AutoPlant device firmware | `ap_widgets.tb_vehiclemaster.latest_gps_datetime` frozen at `2026-08-11 09:00:00` | — | device could still be alive with a SIM fault | source only |
| 2 | Cron fires 09:30 | `IntegrationSchedulerService.telemetryTick` `:70` | — | `INGESTION_SCHEDULER_ENABLED==='true'` **AND** `client.isConfigured()` | dormant → `{ran:false,'DISABLED'\|'UNCONFIGURED'}` | log; **currently DISABLED** |
| 3 | → orchestrator | `IntegrationSyncService.ingestTelemetry` `:88` | `chunkSize=90` | 409 → skip | — | `"telemetry tick skipped"` |
| 4 | → run open | `SnapshotRunService.startRun` `:48` | `snapshot_runs` RUNNING + build stamp | advisory lock + partial-U | 409 `RUN_IN_PROGRESS` | `snapshot_runs` |
| 5 | → read | `AutoPlantSourceReader.readChunk` | `SELECT … FROM \`ap_widgets\`.tb_vehiclemaster WHERE latest_gps_datetime IS NOT NULL AND device_id IS NOT NULL AND TRIM(device_id)<>'' AND device_id > ? ORDER BY device_id LIMIT 90` | keyset walks to this device | VPN drop → throw → PARTIAL | `snapshot_run_chunks` |
| 6 | → map | `mapVehicleMasterRow` (`mapping.ts`) | `{deviceId, gpsDatetime: 2026-08-11T09:00Z, …}` | offset 0; `09:00 < now+60min`; `> 2000` | reject → `SourceChunk.rejected.FUTURE_SKEW` | WARN `"skew guard dropped N row(s)"` |
| 7 | → journal | `SnapshotIngestionService.ingestChunk` `:47` | `raw_device_snapshots` (partition `2026-08-11`) | `ON CONFLICT DO NOTHING` | throw → retry ×3 | chunk `error` |
| 8 | → watermark | `.upsertDeviceStates` `:88` | `device_states.latest_gps_datetime = GREATEST(old, 09:00Z)` | `JOIN devices` | device unmastered → skipped, WARN `unknownDevices` | log |
| 9 | → finalize | `SnapshotIngestionWorker.run` `:47` | `snapshot_runs` SUCCESS, `data_as_of=09:00Z` | all chunks ok | any chunk failed → PARTIAL | `snapshot_runs.status` |
| 10 | **→ GATE** | `.runPostIngestStages` `:135` | `ingestComplete = (status==='SUCCESS')` | **PARTIAL ⇒ stop here** | WARN `"device-state derivation, auto-recovery and ticket creation all SKIPPED (#230)"` | log + `PipelineSummary.ingestComplete` |
| 11 | → derive (09:30) | `DeviceStateService.recompute` | `hours = 09:30 − 09:00 = 0.5` → `is_inactive=false`, `sla_bucket=NULL` | `0.5 < 24` | — | `device_state_recomputes` |
| 12 | → **…16 ticks later, 2026-08-12 09:30** | same | `hours = 24.5` → **`is_inactive = true`**, `sla_bucket = 'CRITICAL'` | `24.5 >= threshold(24)`; `24 <= 24.5 < 48` | — | `device_states` |
| 13 | → auto-recover | `AutoRecoveryService.runAutoRecovery` | scans `device.state.isInactive = false` | **this device is inactive → not a candidate** | — | log `closed X/Y` |
| 14 | → create | `TicketCreationService.createForInactiveEligible` | `failure_cycle(OPEN)` + `ticket(TROUBLESHOOT, OPEN, UNASSIGNED, companyTier)` + `ticket_events(null→OPEN)` + `has_open_failure_cycle=true` | eligible ∧ ¬departed ∧ live plant ∧ company | P2002 → skip (I1 holds) | `ticket_events`, `tickets.ticket_no` |
| 15 | → **05:00 next day** | `DispatchSchedulerService.dispatchTick` `:63` | — | `BUSINESS_SWEEPS_ENABLED==='true'` **(it IS today)** | CONFLICT → skip | log |
| 16 | → run | `DispatchRunService.runForActiveZones` `:~120` | `dispatch_runs` + frozen config snapshot | in-flight map | CONFLICT | `dispatch_runs` |
| 17 | → recommend | `RecommenderService.runForZone` `:104` | `recommendations(SUGGESTED, seId, scoreBreakdown, processingRank)` + trace | needs a non-null `slaBucket` (has `CRITICAL`) and a surviving candidate | none → `UNASSIGNABLE` + `poolEmptyReason` | `dispatch_run_zones.unassignableReasons` |
| 18 | → dispatch | `BatchAssignmentService.dispatchForZone` `:53` | `work_schedules(ACTIVE)` + `plant_batch_assignments(AUTO_ASSIGNED, stopSequence)` + `batch_assignment_tickets(sortOrder)`; ticket → `FORMALLY_ASSIGNED`; recs → `DISPATCHED` | per-zone advisory lock | lock held → `LOCK_CONTENDED`; P2002 → `SCHEDULE_CONFLICT` | `dispatch_run_zones.error` |
| 19 | → notify | `SpineDayPlanNotifier.dayPlanDispatched` | `notifications` | **post-commit only** | — | `notifications` |
| 20 | → SE reads | `MeTicketsQueryService` via `GET /api/me/tickets` | live schedule → batch → ticket | `isTicketReadableBySe` | — | — |
| 21 | → SE submits | `TroubleshootSubmissionService.submit` | `troubleshooting_submissions` + soft-state resolution; ticket → `VERIFICATION_PENDING`, cycle → `SUBMITTED` | coverage floor; `(se_id, client_submission_id)` unique | `DUPLICATE` / `CONFLICT` (Business 409) | `ticket_events` |
| 22 | → verify (every 5 min) | `VerificationService.runVerification` `:33` | `verification_runs` | **Phase 1:** >=3 pings, span >=15 min, no gap >30 min, first ping within ±500 m of the SE anchor (skipped when `presence_source = NONE`). **Phase 2:** 1 h stability from the Phase-1 first ping, no gap >30 min | 1–2 pings → `PARTIAL_RECOVERY`; >500 m → **fraud flag**; 24 h elapsed → `FAILED_VERIFICATION` (⚠ §17.3 — fires on wall-clock even if telemetry is paused) | `verification_runs.outcome`, `audit_logs` |
| 23 | → close | `VerificationService` (tx) | ticket → `CLOSED`, cycle → `VERIFIED`, `closed_at` set | Phase 2 passed | — | `ticket_events` |
| 24 | → report | `FleetUptimeAggregationService.computeMonth` | `device_downtime_summary_monthly` | month-start cron `0 3 1 * *`; counts closures by `closed_at` | delete+insert rebuild | `GET /api/reports/fleet-uptime` |
| 25 | → dashboard | `DashboardService` → `GET /api/dashboard/zone-overview` | reads `device_states` + `tickets` | ZM row-scoped | — | *(service body NOT VERIFIED)* |
| 26 | → React | `apps/admin` | JSON | — | — | browser |

**The two places this trace silently stops today:** step 2 (`INGESTION_SCHEDULER_ENABLED="false"` —
nothing runs unattended above step 15) and step 10 (a PARTIAL read halts everything downstream,
correctly).

---

## §20. Test Architecture

### 20.1 Harness

| Aspect | Reality |
|---|---|
| Runner | **Vitest 2** with `unplugin-swc` (so Nest decorators + `emitDecoratorMetadata` work) |
| Invocation | `npm test` → `node scripts/run-tests.mjs` — **not** bare vitest |
| Parallelism | **`fileParallelism: false`** — files run serially, because the suite shares one Postgres with global invariants (e.g. only one `snapshot_runs` row may be RUNNING system-wide) |
| Isolation | `test/global-setup.ts` runs **once**: `prisma migrate deploy` against a **sibling `_test` database** → `truncateTestDatabase` → `seedOrgReferenceData` → `seedAuthFixtureUsers` |
| Why a sibling DB | `.env.example`: once a real AutoPlant sync loads ~17.9k devices into the dev DB, full-fleet operations (recompute, fleet-uptime aggregation) iterate every row and exceed the per-test timeout |
| One-time bootstrap | The `fsm_test` DB itself is a **superuser** step (it needs `CREATE EXTENSION postgis`, which the app role cannot do). Documented in `.env.example`. |
| Env hygiene | `test/setup-env.ts` is an **ALLOWLIST, not a deny-list** (#182): deletes every var in the app namespace (9 literals + 7 prefix families: `AUTOPLANT_`, `AUTO_RECOVERY_`, `BUSINESS_SWEEP`, `INGESTION_`, `PARTITION_`, `PLANT_ELIGIBILITY_`, `DB_`), then re-sets 5 fixed test values. A **new** flag added to `.env` is neutralised automatically with no harness edit. Also deletes all `PG*` and pins `TZ=UTC`. |
| Crash recovery | `run-tests.mjs` reconciles vitest's `failed \| passed \| skipped (total)` line against the collected total; on a mismatch it diffs which spec files never printed a per-file summary line and **re-runs only those**, up to `RETRY_BUDGET = 3`. Root cause is documented as a Windows child-process native fault, not fixable in test or app code (#184). |
| Fixtures | `test/fixtures/csv-source-reader.ts`; `test/env/book8`; `truncate-test-db.ts`, `test-db-url.ts`, `crash-diagnostics.ts` (no-op unless `TINYPOOL_CRASH_LOG`) |
| Mocking | **Almost none.** No `vi.mock` culture. Substitution happens through **DI tokens** (`SOURCE_READER`, `MASTER_SYNC_SOURCE`, `PLANT_ZONE_RESOLVER`, `DAY_PLAN_NOTIFIER`, `SOFT_STATE_CONFLICT`, the three notifier tokens) and constructor config-override params — which is precisely why the seam design exists. |
| Counts | **310 `*.e2e-spec.ts` + 47 pure `*.spec.ts` = 357 spec files** |

**"e2e" here means "against a real Postgres"**, not "against a running HTTP server" — many use
`Test.createTestingModule` + supertest, others construct services directly. Both hit the real DB.

### 20.2 Module → test mapping

| Module | Unit (`.spec.ts`) | Integration / E2E (`.e2e-spec.ts`) | Important scenarios pinned |
|---|---|---|---|
| Bootstrap / config | `boot-config`, `bootstrap-guard`, `build-info`, `migration-skew` | `migration`, `health`, `cors`, `api-versioning`, `exception-filter` | every boot refusal; the dual `/api` + `/api/v1` mount |
| Auth | `token-service` | `auth`, `login`, `logout`, `db-backed-login`, `me`, `me-profile`, `acting-context`, `book-role-logins` | rotation, DB-backed credentials, acting attribution |
| **Global guards** | — | **`global-guard-validation`** | **sweeps every route; fails until the `@Public` allowlist matches** |
| Zone scoping | — | `zone-scope`, `install-lifecycle-zone-scope` | 403 `ZONE_SCOPE_VIOLATION` |
| AutoPlant mapping | `autoplant-mapping`, `autoplant-master-mapping`, `normalize`, `source-reader`, `autoplant-config`, `autoplant-source-reader`, `autoplant-master-source`, `autoplant-master-source-pagination`, `autoplant-mysql-timeout`, `zone-mapping-normalize`, `autoplant-state-map-zone-resolver`, `autoplant-state-zone-map` | `autoplant-health`, `integration-health-api`, `integration-health-build`, `integration-reconciliation`, `integration-sync-api`, `integration-sync-tickets` | **the ±330 timezone asymmetry**, the <=90 page cap, the 30 s timeout, schema qualification |
| Snapshot ingestion | — | `snapshot-worker`, `snapshot-ingest-chunk`, `snapshot-run-lifecycle`, `snapshot-partial-cursor`, `snapshot-device-state-dualwrite`, `snapshot-first-reported-dualwrite`, `snapshot-trip-creation-dualwrite`, `snapshots-api`, `stale-run-reaper`, `snapshot-ingestion-schema` | two-cursor asymmetry; **`first_reported_at` write-once (7 tests): COALESCE not LEAST, chunk-min not chunk-max, offset 0 recorded, a null corrected timestamp leaving the column unset** |
| Master sync | — | `master-sync-service`, `-run-lifecycle`, `-skip-accounting`, `-di-wiring`, `-eligibility-refresh`, `-zero-work-warning`, `device-commissioning`, `commissioning-cohort`, `entity-mapping-export` | **`master-sync-di-wiring` is the #218 regression test** |
| Device state | `eligibility`, `sla-bucket` | `device-state-recompute`, `-eligibility`, `-eligibility-mode`, `departure-invariant`, `device-departure-lifecycle`, `stand-down-export` | rollback-on-invariant-violation |
| Ticketing | `verification-criteria`, `recovery-criteria` | `ticket-creation`, `-gate`, `-tier-override`, `-departed-source-of-truth`, `auto-recovery`, `-manual`, `autorecovery-plan-export`, `i1-repeat-escalated-guard`, `troubleshoot-submission`, `ticket-events`, `tickets-api`, `tickets-list-detail`, `ticket-activation`, `ticket-waiting-component`, `install-*` (8), `non-operational-*` (5), `vehicle-unavailability-*` (2), `waiting-component-escalation` | **`i1-repeat-escalated-guard` pins the widened I1 predicate**; `-departed-source-of-truth` pins the ledger-not-flag rule |
| Recommender | `canonical-sort`, `install-sort`, `hard-filters`, `scoring`, `effective-tier-resolver`, `tiers-spec-pin` | `candidate-selection`, `candidate-selection-coverage-drift`, `soft-inactive-count`, `shared-pool-floating` | **`-coverage-drift` pins the MV-vs-`engineer_master` re-validation** |
| Scheduling | `dispatch-run-containment`, `transition-or-conflict`, `ist-day` | ~30 files: `batch-dispatch*` (3), `dispatch-*` (18), `batch-override-*` (4), `bulk-unassign*` (4), `schedule-closure-*` (2), `zm-schedule*`, `day-plan-*` | `dispatch-concurrent`, `dispatch-idempotent`, `dispatch-transactional`, `dispatch-uniques`, `dispatch-zone-wedge`, `dispatch-in-flight-guard`, `dispatch-same-day-append`, `dispatch-run-tier-override-snapshot` |
| Schedulers | — | `scheduler-wiring`, `business-sweep-scheduler` (+`-install`, `-intraday`, `-wiring`), `integration-scheduler`, `dispatch-scheduler`, `dispatch-scheduler-tick`, `dispatch-schedule-config`, `schedule-closure-wiring`, `telemetry-tick`, `notifier-adoption-wiring` | **`scheduler-wiring` asserts the registered job-name set — the answer to "does this actually run?"** |
| Verification | `verification-criteria` | `verification-run`, `-review`, `-controller`, `-staleness`, `-runs-schema`, `install-verification` | phase evidence, fraud radius, staleness |
| Inventory / requests | — | `inventory-rollback`, `-schema`, `-service`, `inventory-transactions-schema`, `shadow-use-*` (3), `warehouse-stock`, `component-request-*` (8), `component-blocked-controller` | 409-loser shadow use |
| SE surfaces | `technical-hints`, `activity-status` | `me-tickets-controller`, `me-ticket-detail-controller`, `me-ticket-forms-controller`, `me-tickets-removal-metadata`, `me-work-history`, `me-*-controller` (6 more), `shared-pool-*` (4), `soft-state-*` (9) | coverage floor, removal metadata |
| Reports / dashboard | `ops-explorer-query`, `commissioning-units` | `dashboard-*` (9), `fleet-uptime-aggregation`, `fleet-uptime-report`, `zm-performance-aggregation`, `zm-scorecard-*` (2), `system-efficiency-*` (2), `soft-inactive-trend-controller`, `downtime-summary-cycle-metrics`, `ops-explorer` | `dashboard-kpi-reconciliation`, `dashboard-total-devices` |
| Org / settings / audit | `setup-env-allowlist`, `tier-override-fixture-guard`, `zone-mapping-normalize` | `org-*` (7), `settings`, `settings-endpoint`, `settings-write`, `audit`, `audit-trail-controller`, `zone-mapping-resolver`, `zone-plants`, `zone-engineers`, `territory-*` (3), `tier-override-expiry-sweep`, `company-update` | |
| Cross-cutting | `shared-contract` (e2e) | `notification-service`, `notifications-controller`, `notification-seam-assertion`, `media-controller`, `voucher-service`, `voucher-controller`, `engineer-admin`, `engineers-*` (3), `leave-request-*` (2), `lifecycle-health`, `critical-assign`, `cross-zone-*` (2), `intraday-*` (4), `csm-backup-report`, `issue-122*` (2), `seed-mock-engineers`, `se-planner-*` (3), `se-availability-*` (2), `device-*` (8) | |

### 20.3 Coverage gaps — asserted only where I actually checked

| Gap | Basis |
|---|---|
| **Refresh-token concurrent-consume race** | No spec name suggests it. `auth`, `login`, `logout`, `db-backed-login` exist; a concurrency test would need a distinctive name and there is none. |
| **Concurrent `DeviceStateService.recompute`** | `device-state-recompute.e2e-spec.ts` exists; there is no `-concurrent` sibling, unlike `dispatch-concurrent.e2e-spec.ts`. |
| **`ZoneScopeGuard` body-param bypass** | `zone-scope.e2e-spec.ts` exists, but the guard reads only `params`/`query`; nothing could pin body behaviour because the behaviour does not exist. |
| **Rate limiting / login lockout** | No throttler in the dependency list ⇒ nothing to test. |
| **`NULLS NOT DISTINCT` index survival** | `device-commissioning.e2e-spec.ts` exists and the model doc says the property was verified via `pg_index.indnullsnotdistinct`; whether that assertion is *in the spec* is **NOT VERIFIED** (I did not read the file). **This is the single highest-value assertion to confirm exists.** |
| **Multi-instance behaviour** | Structurally untestable in this harness (`fileParallelism: false`, one process). |
| Reports aggregation SQL correctness | Specs exist per cube; their depth is **NOT VERIFIED**. |

**A stale caveat, corrected.** `docs/SYSTEM-STATE-2026-07.md:53-62` reports the local suite became an
unreliable green/red signal (leaked fixtures — 780 orphan zones, 404 orphan engineers, three different
non-green results on one commit). That was **fixed by #180**: `global-setup.ts` now calls
`truncateTestDatabase` before seeding, which is in the code I read. The SYSTEM-STATE warning is stale.

---

## §21. Dependency Graph

### 21.1 Import graph (from actual `imports:` arrays)

```
LEVEL 0 — infrastructure, reached by nearly everything
  PrismaModule ── (PrismaService injected directly across the app)

LEVEL 1 — leaf services with no feature dependencies
  AuditModule → Prisma
  NotificationsModule → Prisma
  SharedPoolModule → Prisma
  SoftStateModule → Prisma
  DeviceDepartureModule → Prisma
  MeModule · MediaModule · ExportsModule(→Audit) · PlantDeactivationModule(→Audit)

LEVEL 2
  SettingsModule → Prisma, Audit
  AuthModule → Notifications                    [exports TokenService]
  OrgModule → Audit
  DeviceStateModule → Settings
  InventoryModule · EngineersModule · ReportsModule · ComponentRequestModule
  IntradayModule · CrossZoneModule · VouchersModule · RoleBackupModule
  DashboardModule · DevicesModule · PlannerModule · OpsExplorerModule · VerificationModule

LEVEL 3
  TicketingModule → Prisma, Audit, SharedPool, Notifications
  MeTicketsModule → SharedPool (+ reads scheduling/schedule-status.ts as a FILE, not a module)

LEVEL 4
  RecommenderModule → Inventory, Engineers, Reports(SoftInactiveCount),
                      Org(effective-tier.ts), Scheduling(schedule-status.ts),
                      Ticketing(deferral.ts)
                      ⚠ the last three are FILE imports of PURE helpers, not module imports

LEVEL 5
  SchedulingModule → Recommender, Audit, Notifications, SoftState(adapter)

LEVEL 6 — the two composition roots
  IngestionModule → Auth, DeviceDeparture, DeviceState, Settings, Ticketing, Org,
                    ScheduleModule.forRoot()      ★ owns the cron explorer for the WHOLE app
  BusinessSweepSchedulerModule → Verification, Intraday, CrossZone,
                    Ticketing(Install, RepeatEscalation), Org(TierOverrideExpiry),
                    Reports ×5                    ★ pure leaf, nothing imports it
```

### 21.2 Classification

- **Core (removing them breaks everything):** `PrismaModule`, `AuthModule`, `AuditModule`,
  `SettingsModule`, `OrgModule`, `TicketingModule`.
- **True leaves (nothing imports them):** `BusinessSweepSchedulerModule`, `IngestionModule`,
  `DashboardModule`, the HTTP half of `ReportsModule`, `OpsExplorerModule`, `ExportsModule`,
  `MediaModule`, `MeModule`, `VouchersModule`, `RoleBackupModule`.
- **Most heavily coupled:** `RecommenderModule` — 6 inbound dependencies across 5 modules, three of
  them **file-level imports of pure helpers** (`org/effective-tier.ts`,
  `scheduling/schedule-status.ts`, `ticketing/deferral.ts`) rather than module imports. **That is how
  the graph stays acyclic: pure functions cross module boundaries as files; stateful services cross as
  module imports.**

### 21.3 Circular dependencies: NONE

I checked the three risky edges explicitly, and each carries a comment recording that it was verified:

- `IngestionModule → TicketingModule` — *"No cycle: Ticketing imports only Prisma + Audit."*
- `IngestionModule → OrgModule` — *"No cycle: OrgModule imports only AuditModule."*
- `master-sync.service.ts → DeviceDepartureService` (a **value** import, required by #218) —
  *"Neither module imports this one, so the value import introduces no cycle (verified 2026-08-07)."*

**No `forwardRef()` anywhere in `src/**`.**

### 21.4 The two structural single points of failure

1. **`ScheduleModule.forRoot()` lives only in `IngestionModule`.** Its explorer discovers every
   `@Cron` in the entire application. Remove or conditionally import `IngestionModule` and **all 16
   jobs silently stop registering** — no error, no warning.
2. **`DeviceStateModule` is imported by exactly one module.** Everything else reaching `device_states`
   does so via its own Prisma queries against the table. That is why the "flag vs ledger" distinction
   (§11.2) must be re-litigated at each read site rather than centralised.

---

## §22. Architecture Risks

Every entry is grounded in a specific line of code that was read.

### CRITICAL

**C1 — `work_schedules_one_active_per_se_zone_day` does not cover `OVERRIDDEN`; the invariant is
enforced only in application code.**
- *Evidence:* migration `20260708120000` creates the index `WHERE status = 'ACTIVE'`;
  `scheduling/schedule-status.ts` defines `LIVE_SCHEDULE_STATUSES` to include `OVERRIDDEN`;
  `batch-assignment.service.ts:~130` comment: *"here the index canNOT be the safety net: it is partial
  on `status = 'ACTIVE'`, so once a ZM override flipped the schedule this lookup missed it, the create
  succeeded **unopposed**, and the SE ended the day with two day-plans."*
- *Scenario:* a ZM overrides today's plan (schedule → `OVERRIDDEN`), then a second dispatch run fires
  for that zone. `liveScheduleFilter()` now finds it and appends correctly — **but any future write
  path that forgets `liveScheduleFilter()` gets no database backstop.** No P2002, no rollback, no
  ledger skip reason.
- *Impact:* duplicate day plans, doubled committed load, an SE dispatched a second full day.
- *Owner:* **#155** — needs a duplicate probe before the index can be recreated; do not assume zero
  existing duplicates.

**C2 — Access tokens are unrevocable and the refresh-token `consume` is not race-safe.**
- *Evidence:* `token.service.ts:37` has no `jti` and no denylist lookup;
  `prisma-refresh-token-store.ts:77-92` is `findUnique` → check `revokedAt === null` → `update`, with
  **no transaction and no conditional update**.
- *Scenario:* a stolen refresh token replayed concurrently with the legitimate client — both `consume`
  calls read `revokedAt: null` before either writes. Both get new token pairs; `issue()`'s revoke-all
  means one survives, but **the theft is never detected**, which is the entire purpose of rotation.
  Separately, logout leaves up to 15 minutes of valid access.
- *Fix shape:* make `consume` an atomic
  `updateMany({where:{tokenHash, revokedAt:null}, data:{…}})` and treat `count === 0` as failure; on a
  token whose `rotatedFrom` chain is already consumed, revoke the whole family.

**C3 — `INGESTION_SCHEDULER_ENABLED` is off while `BUSINESS_SWEEPS_ENABLED` is on: the verification
sweep can irreversibly fail a ticket on wall-clock with no telemetry to read.**
- *Evidence:* `verification.service.ts:19` `TWENTY_FOUR_HOURS_MS`; the sweep runs `*/5` under
  `BUSINESS_SWEEPS_ENABLED` (`business-sweep-scheduler.service.ts:152`); `.env` has sweeps `"true"`
  and ingestion `"false"`.
- *Scenario:* an SE submits a troubleshoot form during an ingestion pause. No new pings land. 24 h
  later the sweep writes `FAILED_VERIFICATION` and rolls back the `PRE_VERIFICATION` inventory —
  regardless of whether the device was actually fixed.
- *Impact:* irreversible wrong closure + wrong inventory + wrong SE productivity number.
- Exposure is 0 **only** because no SE has submitted a form yet. **Armed, not safe.** *Owner:* **#148**.

**C4 — Enabling `INGESTION_SCHEDULER_ENABLED` is a ~9,888-closure operational event.**
- *Evidence:* `auto-recovery.service.ts:~50` — *"the qualifying backlog is ~11,042 tickets whose ping
  evidence is already on disk, so an uncapped first pass would close all of them in one transaction
  storm the moment telemetry is enabled — an operational event arriving as a deploy side-effect."*
- Mitigated but not eliminated: `AUTO_RECOVERY_MAX_PER_PASS` defaults to 200 and passes are resumable
  prefixes (oldest-cycle-first). Still: **at `*/30`, 200/pass drains ~9,888 in ≈50 passes ≈ 25 hours
  of continuous closure.** Preview first with
  `npm run autorecovery:dryrun -- --export plan.csv`.

### HIGH

**H1 — Auto-recovery loads every candidate before applying the cap, then N+1s over a partitioned
table.** `auto-recovery.service.ts:~150`: `candidates = tickets.findMany({…})` is unbounded and
includes `failureCycle` + `plant`; the `maxClosures` break happens **inside the loop**, after the full
load. Then per candidate: `rawDeviceSnapshot.findMany({deviceId, gpsDatetime:{gt: cycle.openedAt}})` —
one query per ticket against the largest, partitioned table, **selecting all matching rows** rather
than aggregating. With 12,000 open tickets: 12,000 row objects in memory plus up to 12,000 queries per
pass, every 30 minutes, to close at most 200. *Fix shape:* `take: maxClosures * k` on the candidate
query, and replace the per-ticket ping scan with one aggregate over the candidate set.

**H2 — Ticket creation is one transaction plus one `findFirst` per candidate device, with an unbounded
candidate list.** `ticket-creation.service.ts:78-115`, acknowledged in code as a #106-family concern.
With 15,696 eligible devices, a genuine mass outage (a regional network failure flipping thousands
inactive in one recompute) means thousands of sequential round-trip pairs inside a single cron tick,
competing with the same 25-connection pool that serves HTTP. The `*/30` cadence and the 120 s
statement timeout do not bound this: it is many short statements, not one long one.

**H3 — `DeviceStateService.recompute` has no concurrency guard of its own.** It is a full-table
`UPDATE … FROM derived` inside a transaction with no advisory lock; its only protection is that its
single caller sits inside the snapshot run's in-flight guard. Any future second caller — a manual
recompute endpoint, a backfill script, a second process — produces two competing full-table UPDATEs.
Postgres serializes at the row level so the result is not corrupt, but it is a long lock-contention
window on the hottest table plus two `device_state_recomputes` ledger rows and a spurious canary
warning. *Cheap fix:* `pg_try_advisory_xact_lock(hashtext('device_state_recompute'))` at the top of
the transaction, matching the house idiom.

**H4 — The two stubbed hard filters mean two documented business rules cannot fire.**
`recommender.service.ts:~220`: `vehicleReadiness: 'UNKNOWN'` (constant) and
`expectedComponentsAvailable: true` (constant). `VEHICLE_ON_TRIP` is unreachable — an SE can be
dispatched to a vehicle that is on a trip. `COMPONENT_UNAVAILABLE` is unreachable — the
expected-component leg is #51. These are **CONFIGURED BUT UNUSED**, not bugs, but a reader of
`hard-filters.ts` alone would reasonably conclude both are live. **The trap is that the filter list
*looks* complete.**

**H5 — The runner-up trace becomes actively wrong the moment distance scoring lands.**
`recommender.service.ts:405-409` carries the warning in the code itself: runner-up scores are computed
from the **ticket's** features, not per-candidate. That is honest today only because `scoreDegenerate`
is true. Turn on `weights.distance` and populate `distanceFromPrevStopKm`, and every runner-up will
report a score identical to the winner's while `scoreDegenerate` reads `false` — a "why this SE"
explanation that is confidently wrong.

### MEDIUM

**M1 — `ZoneScopeGuard` covers only `params.zoneId` and `query.zone_id`** (`zone-scope.guard.ts:45`).
A zone id in a request body, or under any other param name, is unclamped. No route I read is
exploitable, but every new ZM-writable endpoint must remember to scope in its service. **There is no
lint, no test, and no type that enforces this.**

**M2 — Blank / non-numeric zone params silently pass the guard.** `''` → `undefined` → allow;
`Number('abc')` → `NaN` → allow (`:47-52`). Behaviour then depends entirely on the service's fallback
for a missing zone.

**M3 — No global rate limiting.** No `@nestjs/throttler`. Login is bounded only by scrypt cost; every
other endpoint is unbounded.

**M4 — `GET /api/zones/:zoneId` has no `@Roles` and returns a stub** (`zones/zones.controller.ts`).
Any authenticated user including an SE. Harmless while the body is `{zoneId: Number(zoneId)}`; a
latent exposure the moment someone implements it.

**M5 — Prisma schema drift across 22 unrelated tables.** SYSTEM-STATE top-matter: 18 renamed indexes,
1 renamed FK, FK/default annotation differences between the hand-written migration set and
`schema.prisma`; `prisma migrate diff` against a fully-migrated DB is non-empty. Cosmetic (naming, not
structure), but **#107's from-zero "no drift" acceptance criterion will trip on it** and must either
absorb it or normalise it first.

**M6 — `NULLS NOT DISTINCT` will be silently removed by `prisma migrate dev`.** Both `master-mapping.ts`
and the `DeviceCommissioning` model doc warn: Prisma 7.8 cannot express it, `migrate dev` offers a
replacement without it, and accepting that re-inserts every null-`installed_at` fitment (~13% of source
rows) **on every daily sync**. Append-only-ness breaks silently and the table grows unboundedly.

**M7 — Unbounded, unpartitioned, no-retention append-only tables.** `audit_logs`, `ticket_events`,
`notifications`, `recommendations`, `dispatch_decision_traces`, `master_sync_rejects`,
`soft_inactive_count_history`, `device_state_recomputes`. Only `raw_device_snapshots` is partitioned
and retained. `recommendations` and `dispatch_decision_traces` grow with **tickets × zones × daily
runs**. *Owner:* #104.

**M8 — `PARTITION_MAINTENANCE_ENABLED` must be flipped together with the ingestion scheduler.**
`partition-maintenance.service.ts:13` creates 3 days ahead. Turn on ingestion without it and, after
the 3-day runway, every ping silently piles into the DEFAULT partition — which is never dropped, so
retention stops working and the table degenerates to unpartitioned.

**M9 — In-process-only guards will be wrong under horizontal scaling.** `DispatchRunService.inFlight`
(Map) and `BusinessSweepSchedulerService.inFlight` (Set). The code documents this as intentional and
names the fallback (advisory lock + idempotency). But **all 16 crons would fire in every replica**,
and the sweeps that carry *no* underlying guard — verification, intraday timeout, cross-zone, repeat
escalation, tier-override expiry, and the five report cubes — would run concurrently against the same
rows. The report cubes are delete+insert rebuilds, so two concurrent runs could interleave a delete
with the other's insert.

**M10 — `slaBucketCaseSql(hoursCol)` interpolates its argument into raw SQL** (`sla-bucket.ts:~70`,
used via `Prisma.raw`). Bucket *names* are regex-validated; `hoursCol` is not. The single caller passes
the literal `'dr.hours'`, so there is no injection today — but the function's signature invites one.

**M11 — Query params are never validated.** `ValidationPipe` only fires on class metatypes; every list
endpoint takes `@Query('limit') limit?: string` and does `Number(limit)`. `?limit=abc` becomes `NaN`.
**NOT VERIFIED** what each service does with it; there is no `ParseIntPipe` anywhere.

**M12 — `POST /api/integration/run-pipeline` is not overlap-guarded at the orchestrator level.**
`runPipeline()` calls `syncMasters()` and `snapshotWorker.run()` **directly**, not through
`skipOnOverlap` (`integration-sync.service.ts:~230`). The underlying run guards still return 409, so
the caller gets a clean conflict rather than a corrupt run — but the OH sees a raw 409 mid-pipeline
rather than a structured skip, and `runPipeline` will already have completed the master sync before
failing on the snapshot.

### LOW

**L1 — Double Prisma initialisation at boot** (preflight + real singleton) → two connect/disconnect
cycles and two full build-guard evaluations, including two advisory-lock transactions. Deliberate and
cheap, but surprising on first read.

**L2 — `TicketCreationService` silently `continue`s when a company row is missing** (`:83` —
*"skip defensively rather than violate the FK"*). No counter, no log. A data-integrity problem would
be invisible.

**L3 — `master-sync.existingKeys` loads whole mirror tables into memory** (~21k + 21k strings).
Documented and deliberate (bind-param ceiling), but it scales with the fleet.

**L4 — `AllExceptionsFilter` sets `x-correlation-id` only on error responses.** Success responses
carry none, so a client cannot correlate a *slow* or *wrong* response with server logs — only a failed
one.

**L5 — No structured logging.** Every operational question ("how many 500s in the last hour?")
requires grepping stdout.

**L6 — The `X-Acting-As-Zone` header grants attribution without checking `role_unavailability`**
(`acting-context.ts:26-28` states the authorization half is deferred). Currently harmless because
CSM/OH are not zone-clamped anyway — but do not build authorization on it.

---

## §23. Implemented vs Partial vs Planned

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| **Authentication** | IMPLEMENTED | `auth/*`, `users`+`user_credentials`+`refresh_tokens`, `db-backed-login.e2e-spec.ts` | Hand-rolled HS256 on `node:crypto`. Async scrypt + dummy-hash timing defence. 15 min / 30 day rotating. **SYSTEM-STATE §1.3's "in-memory stores (#91)" is STALE — the Prisma stores are live.** |
| **Authorization** | IMPLEMENTED | 3 global `APP_GUARD`s + per-service predicates + coverage checks | **SYSTEM-STATE §1.4's "there is no global `APP_GUARD` (#99 open)" is STALE.** Gaps: M1, M2, M4, L6. |
| Global validation | PARTIALLY IMPLEMENTED | `APP_PIPE` at `app.module.ts:213` | Fires only on class-typed DTOs; interface-typed bodies and all query params are unvalidated (M11) |
| Global exception handling | IMPLEMENTED | `AllExceptionsFilter` | 3 branches; contracts preserved; correlation id on errors only |
| **Master sync** | IMPLEMENTED | `master-sync.service.ts`, 8 e2e specs | Plant-first, anti-drift, itemised rejects, insert-scope pin, commissioning append, departure reconcile, MV refresh |
| **Telemetry ingestion** | IMPLEMENTED | `snapshot-ingestion.worker.ts`, 10 e2e specs | Keyset, chunked, ×3 retry, two cursors, run ledger, reaper, skew guard |
| Snapshot partitioning | IMPLEMENTED, **NOT WIRED** | `PARTITION_MAINTENANCE_ENABLED` default OFF, `.env` `"false"` | see M8 |
| **Device state engine** | IMPLEMENTED | `device-state.service.ts`, 6 e2e specs | Two set-based statements, SQL/TS band parity, #223 install-date fallback, #230 skip mode, invariant rollback, canary |
| Eligibility `all-deployed` | IMPLEMENTED | `eligibility.ts`, `device-state-eligibility-mode.e2e-spec.ts` | The dev DB runs this mode; 15,696 eligible |
| Eligibility `pgi` (canonical) | **PLANNED ONLY** | `pgi_history` has **no production writer**; the SAP feed is external | Blocker B7. The mode's code path exists and is tested. |
| **Ticket creation** | IMPLEMENTED | `ticket-creation.service.ts`, 5 e2e specs | I1-backed, ADR-0021 repeat, effective tier, deactivation + departure exclusion |
| **Auto-recovery** | IMPLEMENTED | `auto-recovery.service.ts`, 2 e2e specs, dry-run CLI | Wired into the pipeline **2026-08-10 (#229)** after 11 months with zero production callers. **Has still never executed** — gated on `INGESTION_SCHEDULER_ENABLED`. |
| **Recommendations** | PARTIALLY IMPLEMENTED | `recommender/*`, 6 unit + 4 e2e specs | 3 of 5 hard filters real (H4); distance scoring always 0; PREVENTIVE install backlog live |
| **Batch dispatch** | IMPLEMENTED | `batch-assignment.service.ts`, ~30 e2e specs | Advisory-locked, transactional, idempotent, APPEND-not-collide, post-commit notify |
| Dispatch transparency ledger | IMPLEMENTED | `dispatch_runs`/`_zones`/`_traces`, `dispatch-transparency*.e2e-spec.ts` | Config snapshot frozen at run start |
| **Cron processing** | IMPLEMENTED | 16 `@Cron`, `scheduler-wiring.e2e-spec.ts` | In-process only |
| — business sweeps (11) | IMPLEMENTED **and running** | `BUSINESS_SWEEPS_ENABLED="true"` in `.env` | |
| — dispatch run + closure | IMPLEMENTED **and running** | shares `BUSINESS_SWEEPS_ENABLED` | Schedule is settings-backed and hot-reloadable (#213) |
| — ingestion (2) | IMPLEMENTED, **NOT WIRED** | `INGESTION_SCHEDULER_ENABLED="false"` | The whole top of the funnel is inert |
| Verification (3-phase GPS) | IMPLEMENTED | `verification-criteria.ts` + service, 6 e2e specs | ⚠ see C3 |
| Install / Recovery work types | IMPLEMENTED | 8 + 5 e2e specs | |
| Non-Op dual confirmation | IMPLEMENTED | 5 e2e specs, public customer-token route | |
| Intraday / cross-zone / shared pool / soft state / inventory / component requests / vouchers / leave | IMPLEMENTED *(module wiring + specs; service bodies NOT VERIFIED)* | ~50 e2e specs | |
| Report cubes (5) | IMPLEMENTED | 5 services + month/day crons + OH recompute routes | Delete+insert rebuilds |
| Optimistic versioning | PARTIALLY IMPLEMENTED | `version` on 4 models; `transition-or-conflict.ts` | Enforcement is per-service and incomplete |
| **Health checks** | IMPLEMENTED | `health/`, `integration-health.controller.ts` | Liveness has no dependencies by design |
| Build/runtime guards (#130) | IMPLEMENTED | `build-info/*`, 3 specs | L1 version lock, L3 run stamps, L4 migration skew, L5 canary |
| **Observability** | PARTIALLY IMPLEMENTED | run ledgers + build stamps + canary + Ops Explorer | **No structured logs, no metrics, no tracing, no error tracking, no request log.** Correlation ids on errors only. |
| Ops Explorer | IMPLEMENTED, **NOT WIRED** | `OPS_EXPLORER_ENABLED` off by default in **every** environment | Guard returns 404 (not 403) when off, so a disabled feature does not confirm its own existence |
| Notification external channels | **PLANNED ONLY** | `notification-channel.gateway.ts` / `notification-seam.ts` are seams; `LoggingCustomerConfirmationNotifier` is a stub | #76. In-app spine + `device_tokens` are real. The customer-confirmation notifier stays a stub **structurally** — an external party has no internal `User` row, so it cannot route through `NotificationService.notify`'s `{userId, role}` recipient model. |
| **Production scheduler** (external) | **NOT PRESENT** | in-process `@nestjs/schedule` only | No k8s CronJob, no external orchestrator |
| **Redis** | **NOT PRESENT** | not in `package.json`; zero `src/**` imports | |
| **BullMQ** | **NOT PRESENT** | not in `package.json`; 3 comments say "deferred" | |
| **S3 / object storage** | **NOT PRESENT** | `MediaModule` uses multer; no AWS SDK | |
| Deployment artifacts | **NOT PRESENT** | no Dockerfile, no compose, no runbook | #111. CI exists: `.github/workflows/ci.yml`. |
| Rate limiting | **NOT PRESENT** | no throttler | M3 |
| Circuit breaker | **NOT PRESENT** | only `connectionLimit: 4` + timeouts | |
| Horizontal scaling | **NOT SUPPORTED** | in-process crons + in-process guards | M9 |

---

## §24. SDE Code Reading Guide

### Phase 1 — the skeleton (~45 min). Five files, ~800 lines, the whole surface.

| # | File → class → method | Why read it | What you must come away knowing | Next |
|---|---|---|---|---|
| 1 | `src/main.ts` → `bootstrap()` | The only place the real startup order is visible | Config validates before anything; Prisma preflights **before** Nest; shutdown hooks are opt-in and someone had to remember | 2 |
| 2 | `src/app.config.ts` → `configureApp()` | Shared by prod and every e2e test | `/api` prefix; **the dual `/api` + `/api/v1` mount is deliberate and load-bearing**; the 1 MB cap requires `bodyParser:false` | 3 |
| 3 | `src/config/boot-config.ts` → `validateBootConfig()` + `src/bootstrap-guard.ts` | The fail-fast contract | Exactly five refusal conditions; every failure is one fatal line + exit 1 | 4 |
| 4 | `src/prisma/prisma.service.ts` → `poolOptions()`, `onModuleInit()` | Every query in the app goes through it | Pool 25 / acquire 5 s / statement 120 s / idle-in-tx 60 s / **session TZ=UTC**; the boot guard lives here so every entrypoint runs it | 5 |
| 5 | `src/app.module.ts` (lines 101–219 only) | The map | 31 modules, 57 controllers, the 3-guard chain order, the global pipe and filter | 6 |

### Phase 2 — the security substrate (~30 min).

| # | File → what to read | What you must come away knowing | Next |
|---|---|---|---|
| 6 | `common/guards/auth.guard.ts`, `role.guard.ts`, `zone-scope.guard.ts` | Deny-by-default; `@Roles` handler-overrides-class; **ZoneScopeGuard clamps only ZM, only on an explicit zone param** | 7 |
| 7 | `common/decorators/public.decorator.ts` (the doc comment) | The four legitimate public surfaces, and that `global-guard-validation.e2e-spec.ts` fails until the allowlist matches | 8 |
| 8 | `auth/token.service.ts` → `signAccessToken`, `verifyAccessToken` | Claims are only `{user_id, role, zone_id}`; no `jti`; `alg` is never read (which is why `alg:none` fails) | 9 |
| 9 | `auth/prisma-refresh-token-store.ts` → `issue`, `consume` | One-active-token-per-user; only a SHA-256 is stored; **and spot the non-atomic `consume`** | 10 |
| 10 | `common/request-actor.ts` + `audit/audit.service.ts` → `withAudit` | Acting attribution reaches the audit row; the mutation and its audit commit together | 11 |

### Phase 3 — the funnel (~2 hours). This is the core.

| # | File → class → method | Why | What you must come away knowing | Next |
|---|---|---|---|---|
| 11 | `ingestion/autoplant/integration-sync.service.ts` — **read every doc comment** | The whole pipeline in one file | Stage order is load-bearing; the #230 SUCCESS gate; `ingestComplete` is typed, not logged | 12 |
| 12 | `ingestion/autoplant/mapping.ts` — the two offset constants' comments | The densest piece of institutional knowledge in the repo | Why the offset is 0; why two constants holding 0 are not one constant; **why `MAX()` is not a valid probe for a source contract**; why the skew guard was tightened in the same release | 13 |
| 13 | `ingestion/snapshot-ingestion.worker.ts` → `run()` | The retry / finalize / cursor model | Per-chunk independent retry; the two asymmetric cursors; the read-error fall-through that stops runs hanging RUNNING | 14 |
| 14 | `ingestion/snapshot-ingestion.service.ts` → `upsertDeviceStates` | The idiom every set-based write here follows | `unnest` + `JOIN devices` + `GREATEST`/`COALESCE`; **why `first_reported_at` is COALESCE and LEAST would be wrong** | 15 |
| 15 | `device-state/device-state.service.ts` → `recompute` | Where raw pings become business facts | The two statements; `skipDerivation`; the #223 install-date fallback and why MIN not MAX; invariant-rollback-in-transaction | 16 |
| 16 | `device-state/sla-bucket.ts` → `slaBucketCaseSql` | The SQL/TS parity trick | One `SLA_BANDS` array feeds both the classifier and the generated `CASE` | 17 |
| 17 | `ticketing/ticket-creation.service.ts` → `createForInactiveEligible` | The canonical transactional write | I1 partial unique is the guarantee, `hasOpenFailureCycle` is the fast path; **why the departure gate re-reads the ledger, not the flag** | 18 |
| 18 | `ticketing/auto-recovery.service.ts` — class docstring + `closeAsAutoRecovery` | Placement-is-correctness, and what "complete" means | Why healthy-now is required and only meaningful at this pipeline position; why the closure is seven writes | 19 |
| 19 | `ingestion/autoplant/master-sync.service.ts` → `sync()` | The mirror | Plant-first derivation; the insert-scope pin; best-effort passes outside any transaction; **the #218 `@Inject` erasure trap** | 20 |
| 20 | `ingestion/autoplant/master-mapping.ts` → any `mapX` | Anti-drift made structural | FSM-owned columns are physically absent from every `update` object | 21 |

### Phase 4 — assignment (~1 hour).

| # | File | What you must come away knowing | Next |
|---|---|---|---|
| 21 | `recommender/canonical-sort.ts` → `compareCandidates` | The 5-key order; `TIER_ORDER_EFFECTIVE_PRIORITY_DESC` is derived, not duplicated | 22 |
| 22 | `recommender/hard-filters.ts` → `firstFailure` | First-failure-wins; **two of five are stubbed**; activity staleness is deliberately not a filter | 23 |
| 23 | `recommender/scoring.ts` → `scoreCandidate` | Deterministic weighted sum; PREVENTIVE flips repeat penalty → bonus | 24 |
| 24 | `recommender/recommender.service.ts` → `runForZone` | The orchestration, `committedDayLoad` seeding, orphan clearing, guard-not-throw, the trace | 25 |
| 25 | `scheduling/batch-assignment.service.ts` → `dispatchForZone` | `try_` advisory lock; APPEND not collide; consume-all; post-commit notify; the P2002 skip-reason path | 26 |
| 26 | `scheduling/schedule-status.ts` | `LIVE_SCHEDULE_STATUSES` is the one definition of "live" — and why the index does not match it | 27 |

### Phase 5 — the periphery (~45 min).

| # | File | What you must come away knowing |
|---|---|---|
| 27 | `scheduling/business-sweep-scheduler.service.ts` → `runGuarded` + the 11 `@Cron`s | The uniform tick shape; expressions resolve once at decorator time |
| 28 | `scheduling/dispatch-scheduler.service.ts` + `dispatch-schedule.service.ts` | The one job whose schedule is DB-backed and hot-reloadable — and why `SettingsService.set` refuses `dispatch_cron` |
| 29 | `verification/verification-criteria.ts` → `evaluatePhase1`/`evaluatePhase2` | The exact evidence rules; the ±500 m fraud check and its `skipGeoCheck` escape |
| 30 | `me-tickets/se-ticket-access.ts` + `shared-pool/se-coverage.service.ts` | The SE authorization model: assigned-or-covered |
| 31 | `prisma/schema.prisma` **plus** `grep -h "CREATE UNIQUE INDEX\|CHECK" prisma/migrations/*/migration.sql` | The invariants are in the migrations, not the schema file |
| 32 | `test/setup-env.ts` + `test/global-setup.ts` + `vitest.config.ts` | Why tests are serial, why the DB is a sibling, why the env is an allowlist |

### Safe to skip initially

`src/generated/**` (80 files, 152,856 lines — Prisma output, never edit) · every `org/*.controller.ts`
+ `*.service.ts` CRUD pair (thin and uniform — read one and you have read all thirteen) ·
`vouchers/`, `media/`, `roles/`, `planner/`, `exports/`, `me/`, `zones/` ·
`build-info/runtime-lock-reset.ts` · the five `ingestion/autoplant/*-dryrun.ts` / `*-preflight.ts` CLI
scripts · `ops-explorer/` unless you are extending it · `reports/*-aggregation.service.ts` until you
need a specific cube.

---

## §25. If I Join This Team Tomorrow

**Week 1 — before writing any code.** Read Phases 1–3 above. Run `npm run build && npm test` and let
`run-tests.mjs` do its reconciliation; that tells you whether your machine has a working `fsm_test`
sibling database (the one-time superuser bootstrap in `.env.example` is a real prerequisite — the app
role cannot `CREATE EXTENSION postgis`). Then open `psql` against the dev DB and read the last 10 rows
of `snapshot_runs`, `master_sync_runs`, `dispatch_runs`, and `device_state_recomputes`. **Those four
tables tell you more about the live system than any dashboard.**

**Your first safe change** should be additive and in a leaf module — a new read endpoint on
`DevicesModule`, or a new `dispatch_run_zones` column. Ship it with an e2e spec and a `@Roles`
decorator. **Do not start in `ingestion/`, `device-state/`, or `scheduling/`:** those three have the
highest ratio of "one line changes a fleet-wide number."

**Before every PR, ask five questions.** They map directly onto the defect classes the comments record:

1. **Am I about to trust a denormalised flag on a write path?** If yes, re-read the ledger instead
   (`ticket-creation.service.ts:41-49`, the run-65 incident).
2. **Am I adding a read that filters `status: 'ACTIVE'`?** Use `liveScheduleFilter()` /
   `LIVE_SCHEDULE_STATUSES` (#153).
3. **Am I making a claim about the fleet from a partial read?** Check the run's own SUCCESS verdict
   first (#230).
4. **Am I injecting an optional or union-typed dependency?** It needs an explicit `@Inject(Token)`
   **and** a value import, or it resolves to `undefined` silently (#218).
5. **Am I measuring a source contract with `MAX()`?** Use percentiles — `MAX` reports the most extreme
   writer, not the convention (#222).

**Two operational facts to hold in your head at all times.** `BUSINESS_SWEEPS_ENABLED` is `"true"` —
thirteen jobs are running right now against the dev database. `INGESTION_SCHEDULER_ENABLED` is
`"false"` — nothing is feeding them fresh telemetry. **That combination is C3**, and it is the single
most consequential thing about the current deployment.

**Where to look when something is wrong.** Start at the run ledgers, not the logs.
`master_sync_rejects` answers "why is this entity missing" directly, with a reason string.
`dispatch_run_zones.unassignableReasons` answers "why did nobody get assigned."
`dispatch_decision_traces` answers "why *this* SE." `device_state_recomputes` plus the canary warning
answers "why did the numbers move." The full walkthrough is §18.2.

---

## §26. What I Should Memorize

1. **One process. Postgres + Prisma 7 driver-adapter + in-process `@nestjs/schedule`.** No Redis, no
   BullMQ, no S3, no queue, no second service. Verified against `package.json`, not assumed.
2. **`main.ts` order:** `validateBootConfig` → Prisma preflight (+ migration-skew and version-lock
   guards) → `NestFactory.create` → `enableShutdownHooks` → `configureApp` → `listen`. Any failure =
   one fatal line + exit 1.
3. **The guard chain is `AuthGuard → RoleGuard → ZoneScopeGuard`, registered globally.**
   Deny-by-default; exactly four `@Public` surfaces; **`ZoneScopeGuard` clamps only ZM, and only when
   a zone appears in `params.zoneId` or `query.zone_id`.** Everything else is per-service row scoping.
4. **The partial unique indexes ARE the business rules.**
   `failure_cycles_one_active_per_device` (I1) is what actually prevents duplicate tickets —
   `hasOpenFailureCycle` is just the cheap filter. Code catches `P2002` and continues.
5. **`work_schedules_one_active_per_se_zone_day` is partial on `status='ACTIVE'` and therefore does
   NOT cover `OVERRIDDEN`.** That invariant lives in application code only (#155).
6. **`runPostIngestStages` gates device-state derivation, auto-recovery, and ticket creation on
   `snapshotStatus === 'SUCCESS'`.** A partial read must produce *less* data, never *confidently
   wrong* data (#230).
7. **The pipeline order recompute → auto-recovery → creation is load-bearing.** Creation takes
   `is_inactive = true`, recovery takes `is_inactive = false` — exact complements.
8. **`AUTOPLANT_UTC_OFFSET_MIN = 0`.** It was 330 and that was wrong from the very first run —
   5.5 h fleet-wide, fabricating 434 of 665 CRITICAL devices. **`MAX()` is not a valid probe for a
   source contract; use percentiles.**
9. **Anti-drift is structural:** FSM-owned columns are physically absent from every `update` object
   `master-mapping.ts` produces. A re-sync cannot clobber an OH decision.
10. **The master read is widened to all deployment statuses; the CREATE scope is pinned to
    `['DEPLOYED','ACTIVE']` as an allow-list.** Widening the create takes `vehicles` from ~21k to
    ~48.5k and silently changes the meaning of every dashboard denominator.
11. **`ScheduleModule.forRoot()` lives only in `IngestionModule`** and its explorer registers all 16
    crons app-wide. **Cron expressions resolve once at decorator evaluation** (env change ⇒ restart);
    the `enabled` gate is re-checked every tick (flag flip ⇒ no restart). **`dispatch-run` is the one
    exception** — it is settings-backed and hot-reloadable.
12. **`try_` advisory locks, never blocking.**
    `pg_try_advisory_xact_lock(hashtext('snapshot_run' | 'dispatch_zone_<id>'))`. A contended dispatch
    **skips with a named reason**; it does not queue.
13. **Run ledgers are the observability layer** — `snapshot_runs`, `snapshot_run_chunks`,
    `master_sync_runs.entity_stats`, `master_sync_rejects`, `dispatch_runs`, `dispatch_run_zones`,
    `dispatch_decision_traces`, `device_state_recomputes`. There are no metrics, no traces, no
    structured logs, and correlation ids appear only on error responses.
14. **The recommender is deterministic — no AI.** Five hard filters (first-failure-wins), **two of them
    stubbed and unable to fire**; a weighted sum; a five-key canonical sort; and `UNASSIGNABLE` is a
    recorded outcome, not a silent drop.
15. **Three master switches:** `BUSINESS_SWEEPS_ENABLED` (**on** — 13 jobs running),
    `INGESTION_SCHEDULER_ENABLED` (**off** — the funnel's top half is inert),
    `PARTITION_MAINTENANCE_ENABLED` (**off** — must be flipped together with ingestion, or pings pile
    into the DEFAULT partition after 3 days).
16. **Read the doc comments before the code they sit above.** `#222`, `#229`, `#230`, `#218`, `#153`,
    `#130`, `#126`, `#223` each name a real incident with its measurement. They are why the line below
    them has the shape it does.

---

# PART C — File Deep-Dives

## C.1 `src/main.ts` — SDE level

### The full file

```ts
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './app.config';
import { AppModule } from './app.module';
import { runWithFatalGuard } from './bootstrap-guard';
import { validateBootConfig } from './config/boot-config';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap(): Promise<void> {
  // Fail-fast before any module boots: refuse to start on a missing/unsafe secret or bad DB URL (#98).
  validateBootConfig();
  // #130 belt-and-braces: run the build guard (L4 schema-skew → L1 version lock) before Nest even
  // constructs the module graph, so a stale/skewed build of the HTTP server fails fast. The structural
  // guarantee remains PrismaService.onModuleInit (which every entrypoint runs); this is the earlier
  // tripwire. A refusal throws here and runWithFatalGuard turns it into a single fatal line + exit.
  const preflight = new PrismaService();
  try {
    await preflight.onModuleInit();
  } finally {
    await preflight.onModuleDestroy();
  }
  // bodyParser off so configureApp's explicit, env-tunable JSON limit is the ONLY parser (#99).
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  // SIGTERM/SIGINT now run the Nest lifecycle, so onModuleDestroy (Prisma $disconnect, AutoPlant MySQL
  // pool end) actually fires on a graceful shutdown instead of the process being hard-killed (#98).
  app.enableShutdownHooks();
  configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

const logger = new Logger('Bootstrap');
void runWithFatalGuard(bootstrap, {
  exit: (code) => process.exit(code),
  logFatal: (message) => logger.fatal(message),
});
```

### Line by line

**`import 'reflect-metadata'`** — must be the first import in any NestJS app. Nest's DI container reads
TypeScript's emitted design-time metadata (parameter types, decorators) off `reflect-metadata`'s global
polyfill. If this import happens after anything that constructs a decorated class, DI breaks in ways
that are annoying to diagnose. Being first is the whole point.

**`validateBootConfig()`** — see §C.3. Runs first and synchronously; checked *before* touching the
database, so a bad `JWT_ACCESS_SECRET` or a malformed `DATABASE_URL` fails instantly with no network
round trip.

**The Prisma preflight block** — the part that is easy to miss on a skim and is genuinely unusual. It
**hand-constructs a second, throwaway `PrismaService`** (not the one that will serve the app),
connects it, runs `onModuleInit()` (which per `prisma.service.ts` does `$connect()` then
`assertRuntimeBuildGuards()` — the L4 migration-skew check and the L1 stale-build version-lock check
from `build-info/`), then immediately disconnects it in a `finally`, whether the check passed or threw.

Why bother, when `NestFactory.create(AppModule)` a few lines down constructs the *real*
`PrismaService` singleton and runs the exact same `onModuleInit()` guards anyway? The comment answers
directly: the **structural** guarantee — every entrypoint (the HTTP server plus five separate
hand-rolled CLI scripts: `autoplant:ping`, `autoplant:sync`, `autoplant:departure-dryrun`,
`autorecovery:dryrun`, `runtime-lock:reset`) gets the guard because they all construct
`PrismaService` — lives in the service itself. This extra call in `main.ts` is an *earlier* checkpoint
specifically for the HTTP server: if the build is stale or the schema is skewed, you find out before
Nest spends time wiring up 31 modules, 57 controllers, and 16 cron jobs. The cost is one extra
connect/disconnect at boot, which is cheap next to that.

**`NestFactory.create(AppModule, { bodyParser: false })`** — where the real module graph is built:
every `@Module` import resolves, every provider constructs, the *real* `PrismaService` singleton runs
its own `onModuleInit()` (so the guards technically run twice), `SettingsService.onModuleInit()` seeds
`SETTINGS_DEFAULTS`, `ScheduleModule.forRoot()`'s explorer registers all 16 `@Cron` jobs, and
`DispatchScheduleService.onApplicationBootstrap()` re-points the dispatch job at
`system_settings.dispatch_cron`.

`bodyParser: false` is critical and easy to get backwards: it tells Nest/Express **not** to register
its default body parser, so `configureApp()` can install its own JSON parser with an explicit,
env-tunable size limit (`BODY_LIMIT_JSON ?? '1mb'`). Drop it and Express's default parser registers
first and wins — `configureApp`'s limit becomes silently dead code.

**`app.enableShutdownHooks()`** — this is what makes `OnModuleDestroy` actually fire on
`SIGTERM`/`SIGINT`. Without it, Nest's lifecycle hooks are opt-in and a container orchestrator's
graceful-shutdown signal just hard-kills the process. With it: `PrismaService.onModuleDestroy()` runs
(`$disconnect()`), and `AutoPlantMysqlClient.onModuleDestroy()` runs (`pool.end()`, `pool = null`) —
so the MySQL pool and the Postgres connection are both closed cleanly rather than yanked.

**`configureApp(app)`** — delegates to `app.config.ts`: the `/api` global prefix, URI versioning (both
`/api/v1/*` and `/api/*` resolve), CORS to `ADMIN_ORIGIN`, and the explicit JSON body limit. This
function is shared verbatim between `main.ts` and every e2e test's app bootstrap, so production and
tests can never drift on these basics.

**`app.listen(process.env.PORT ?? 3000)`** — starts accepting connections. Last step.

### The fatal-guard wrapper — why `bootstrap()` is not just called directly

```ts
export async function runWithFatalGuard(boot, deps): Promise<void> {
  try {
    await boot();
  } catch (err) {
    deps.logFatal(`Application bootstrap failed — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    deps.exit(1);
  }
}
```

If `main.ts` had written `void bootstrap()` directly, a thrown error inside that async function would
become an **unhandled promise rejection** — Node would print a warning (or nothing, depending on
version and flags) and the process might limp on in a half-initialized state, or exit with a generic
non-descriptive failure. Wrapping it means every boot failure — from `validateBootConfig`, the Prisma
preflight, or `NestFactory.create` itself — funnels through one place that logs a single clear fatal
line (with the full stack) and calls `process.exit(1)` deliberately. `exit` and `logFatal` are injected
as parameters specifically so the wrapper is unit-testable without actually calling `process.exit` in
a test run (`test/bootstrap-guard.spec.ts`).

### The sequence to hold in your head

```
reflect-metadata loads
  ↓
validateBootConfig()          — throws on bad JWT secret / bad DATABASE_URL, no DB touch yet
  ↓
throwaway PrismaService       — connect → L4 (migration skew) + L1 (stale build) → disconnect
  ↓
NestFactory.create(AppModule) — real module graph; real PrismaService runs the same guards again;
                                SettingsService seeds defaults; ScheduleModule registers all 16 crons;
                                DispatchScheduleService re-points the dispatch job at the DB cron
  ↓
enableShutdownHooks()         — SIGTERM/SIGINT now run onModuleDestroy across the graph
  ↓
configureApp()                — /api prefix, versioning, CORS, body limit
  ↓
listen(PORT ?? 3000)
```

Any failure at any step → one `logger.fatal` line + `process.exit(1)`. **That is the entire contract
this file establishes: the app never boots half-configured.**

---

## C.2 `src/main.ts` — junior-developer level

### The big picture first

This file is the **starting point** of the whole backend. When you run `node dist/main.js`, this runs
first.

Think of starting this app like starting a car:

1. Check you have fuel and the key is not broken (**validate config**)
2. Check the engine actually turns over before pulling out of the driveway (**check the database**)
3. Actually start the engine (**build the app**)
4. Turn on the lights so people can see you are driving (**start listening for requests**)

If any step fails, the whole thing refuses to start — it will not let you drive off with a broken
engine. **That is the philosophy behind this file: fail loudly and immediately, do not limp along
broken.**

### The code, piece by piece

**`import 'reflect-metadata'`** — has to be first. NestJS uses "decorators" (those `@Injectable()`,
`@Controller()` things above classes) to know how to wire everything together automatically.
`reflect-metadata` is a helper library that makes those decorators work. Think of it as: "turn on the
machinery that makes NestJS decorators function." You do not need to understand how it works — just
know it must be imported before anything else.

**`async function bootstrap()`** — `bootstrap` is just a name; it is the function that does the actual
"starting up" work. It is `async` because starting the app involves waiting on things (connecting to a
database takes time).

#### Step 1 — check the environment is sane

```ts
validateBootConfig();
```

Before anything else, this checks two things from your `.env` file:

- Is `JWT_ACCESS_SECRET` set, long enough, and NOT the default placeholder that is checked into the repo?
- Is `DATABASE_URL` set and does it look like a real Postgres connection string?

If either is wrong, this line **throws immediately**. No database call, no server startup — an instant
refusal. This is on purpose: if your JWT secret is the same default value sitting in a public repo,
that is a serious security hole, and the app would rather not start at all than start insecurely.

#### Step 2 — check the database is reachable and compatible

```ts
const preflight = new PrismaService();
try {
  await preflight.onModuleInit();
} finally {
  await preflight.onModuleDestroy();
}
```

`PrismaService` is the class that manages the connection to Postgres. Here we create **one just to
test it**, then throw it away.

Why create one and immediately throw it away, when the real app creates its own connection two lines
later? Because `onModuleInit()` does not just connect — it also checks two things:

- **"Is this build of the code even compatible with the current database schema?"** (imagine someone
  ran a database migration but forgot to deploy the matching code — this catches that)
- **"Is this build newer than or equal to whatever build last touched this database?"** (this stops an
  old, rolled-back version of the app from running against a newer database and corrupting things)

So this is a **quick sanity check**: before spending time building the whole application (wiring up
50+ modules, registering routes, starting 16 scheduled jobs), make sure the database is even
compatible. If it is not, fail fast. The `try/finally` makes sure we always close this test
connection, whether the check passed or failed.

#### Step 3 — actually build the application

```ts
const app = await NestFactory.create(AppModule, { bodyParser: false });
```

This is the real deal — NestJS reads `AppModule` (which lists every feature module: auth, tickets,
scheduling, etc.) and wires the entire application together: every controller, every service, every
database connection, every scheduled job.

`{ bodyParser: false }` is a small but important detail. Normally Express (the HTTP library underneath
NestJS) automatically parses incoming JSON request bodies using its own default settings. We are
telling it **"don't do that automatically — I'll set it up myself in a minute, with my own
settings."** (You will see why in step 5.)

#### Step 4 — make sure shutdown works properly

```ts
app.enableShutdownHooks();
```

When you deploy this app and later need to stop it (a deploy, a restart), the operating system sends a
signal called `SIGTERM` ("please shut down"). Without this line, NestJS just gets killed abruptly — any
cleanup code (like "close the database connection nicely") never runs.

This one line tells NestJS: **"when you get a shutdown signal, run all the cleanup code first."** That
cleanup code lives inside each service as an `onModuleDestroy()` method — for example, `PrismaService`
closes its database connection, and the AutoPlant MySQL client closes its connection pool.

#### Step 5 — configure how the server behaves

```ts
configureApp(app);
```

This calls a separate function (in `app.config.ts`) that sets up:

- The URL prefix `/api` (so routes are `/api/tickets`, not just `/tickets`)
- API versioning
- CORS (which frontend URLs are allowed to call this API)
- The JSON body parser we disabled in step 3, now configured with an explicit 1 MB size limit

It is a separate function (instead of being inline here) because **the test suite calls this exact same
function** when it spins up a test server. That way tests and the real production server can never
accidentally behave differently on these basics.

#### Step 6 — start listening for requests

```ts
await app.listen(process.env.PORT ?? 3000);
```

The actual "turn on the server" step. `process.env.PORT ?? 3000` means: use the `PORT` environment
variable if set, otherwise default to `3000`. Once this runs, the server is live.

### The wrapper around all of it — "what if something goes wrong?"

```ts
const logger = new Logger('Bootstrap');
void runWithFatalGuard(bootstrap, {
  exit: (code) => process.exit(code),
  logFatal: (message) => logger.fatal(message),
});
```

Why not just write `bootstrap();`?

Because `bootstrap()` is an `async` function, and if you call it without handling its errors, and
something inside throws (say the database is down), you get an **"unhandled promise rejection."** In
Node.js that can print a confusing warning, or on some setups crash silently, or do nothing obvious at
all — the process could genuinely limp along in a broken, half-started state. That is exactly the
opposite of what we want.

`runWithFatalGuard` fixes this. It is a small helper that does basically:

```ts
try {
  await bootstrap();
} catch (err) {
  logFatal("Application bootstrap failed — " + err);
  process.exit(1);
}
```

So **any** failure at **any** step gets caught in one place, logged clearly, and the process exits with
code `1` (which tells whatever is running the app — Docker, a process manager — "I failed, don't treat
me as healthy").

### Put it all together

```
1. Check .env is safe and sane         → bad? throw immediately, no DB touch yet
2. Quick DB compatibility check         → bad? throw, don't bother building the app
3. Build the whole NestJS app           → wires up everything: auth, tickets, cron jobs, etc.
4. Turn on graceful shutdown            → so SIGTERM cleans up instead of killing abruptly
5. Configure routes/CORS/body-parsing   → shared with the test suite, so tests match prod
6. Start listening on a port            → app is now live

Any step fails →  one clear log line + exit(1). Never a half-broken server.
```

Every single line is answering the same question: **"how do we make sure this app never starts in a
broken or insecure state?"**

---

## C.3 `src/config/boot-config.ts`

A small, dependency-free fail-fast validator that runs as the very first line of `main.ts`, before
Nest even starts building the module graph. Its job is to refuse to boot the process at all if the
environment is missing or unsafe, rather than let the app start and fail (or worse, succeed
insecurely) later.

### What it exports

```ts
export const DEV_DEFAULT_JWT_SECRET = 'dev-access-secret-change-me';
export const MIN_JWT_SECRET_LENGTH = 32;

export interface BootConfig {
  jwtAccessSecret: string;
  databaseUrl: string;
}

export function validateBootConfig(env: NodeJS.ProcessEnv = process.env): BootConfig
```

### What it checks, in order

**1. `JWT_ACCESS_SECRET` presence**
```ts
if (!secret) throw new Error('Boot config: JWT_ACCESS_SECRET is not set. …');
```

**2. Not the published dev default**
```ts
if (secret === DEV_DEFAULT_JWT_SECRET) throw new Error('… still the published dev default …');
```
This exists because `dev-access-secret-change-me` is committed in the repo (it is literally this
constant's value). If someone copies `.env.example` to `.env` and forgets to change it, every
environment running that value would share a **known, public** signing secret — anyone could forge a
valid JWT for any user and role. This check closes that specific hole. `TokenService` used to fall
back to this value; #98 removed the fallback and added this guard.

**3. Minimum length (32 chars)**
```ts
if (secret.length < MIN_JWT_SECRET_LENGTH) throw new Error(`… too short (${secret.length} chars) …`);
```
An HS256 secret that is too short is brute-forceable. 32 is a reasonable entropy floor.

**4. `DATABASE_URL` presence**
```ts
if (!databaseUrl) throw new Error('Boot config: DATABASE_URL is not set.');
```

**5. `DATABASE_URL` is a parseable Postgres URL**
```ts
function isParseablePostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}
```
Uses the built-in `URL` parser — if it throws (malformed) or the protocol is not
`postgres:`/`postgresql:`, it is rejected. This catches typos and copy-paste mistakes (an accidentally
pasted MySQL URL, for instance) before Prisma ever tries to connect.

If all five pass, it returns a typed `{ jwtAccessSecret, databaseUrl }` — though notably **nothing
downstream consumes that return value**. `main.ts` calls `validateBootConfig()` and discards the
result; the real consumers (`TokenService`, `PrismaService`) re-read `process.env` themselves. So this
function's real job is the validation side-effect (throw-or-don't), not supplying config.

### Why it is always fatal, with no lenient mode

The doc comment is explicit: *"Always fatal (throwing) — there is no lenient mode: a weak or missing
secret is a security defect in every environment, so dev/test/CI must supply a real one."* There is no
`NODE_ENV === 'production'` branch that is stricter than dev — the same 32-char / non-default rule
applies everywhere. That is why `test/setup-env.ts` sets a fixed 32+ char test secret
(`'test-jwt-access-secret-000000000000000000'`) rather than leaving it unset.

### Why it is dependency-free

No zod, no joi, no class-validator — just plain `if`/`throw`. The comment ties this to *"keeping with
the auth slice's zero-registry stance"*: a project-wide preference in this slice for hand-rolled
validation over a schema library, matching `TokenService`'s hand-rolled HS256 (`node:crypto`, no
`@nestjs/jwt`).

### How it is wired into boot

```ts
async function bootstrap(): Promise<void> {
  validateBootConfig();                    // ← throws here if misconfigured
  const preflight = new PrismaService();
  await preflight.onModuleInit();          // DB connect + build guards
  ...
}
```

It runs **before** the Prisma preflight connect, so a bad secret or a bad DB URL string is caught
without even attempting a network call. Any throw propagates to `runWithFatalGuard` in
`bootstrap-guard.ts`, which logs one `logger.fatal(...)` line with the message and stack and calls
`process.exit(1)` — a clean, loud refusal.

### Test coverage

`test/boot-config.spec.ts` exists (a pure unit spec, not e2e) and presumably pins each of the five
refusal branches. I did **not** read that file's body, so I cannot confirm exactly which cases it
covers — but the function's small surface (5 branches, all pure, injectable `env` parameter) makes it
straightforward to test exhaustively without touching a real DB.

---

# PART D — `DOCUMENTATION vs ACTUAL CODE`

Three claims in `docs/SYSTEM-STATE-2026-07.md` contradict the code as it stands on this branch.
Per `CLAUDE.md`'s progress convention these should be edited **in place** in SYSTEM-STATE, not
carried in a second document.

### D1 — Auth stores: documented as in-memory, actually Prisma-backed

| | |
|---|---|
| **Doc says** | §1.3 Runtime topology, "Auth store" row: *"**In-memory** users + refresh tokens (`InMemoryUserStore`/`InMemoryRefreshTokenStore`); DB `users` table exists but cannot log in — owned by open issue #91"*. §1.4 Module map, `auth` row: *"in-memory stores (→ #91)"*. |
| **Code says** | `auth/auth.module.ts` provides `PrismaUserStore` and `PrismaRefreshTokenStore`. `PrismaUserStore.validateCredentials` reads `users` JOIN `user_credentials`. `PrismaRefreshTokenStore` persists SHA-256 hashes to `refresh_tokens` with 30-day expiry, rotation lineage (`rotatedFrom`), and one-active-device replace-on-login. Migration `20260729120000_production_auth_credentials_refresh_tokens` created both tables. `test/db-backed-login.e2e-spec.ts` exists. |
| **Truth** | #91 S2/S3 landed. Login is DB-backed. There are no `InMemory*` classes in `src/auth/`. |
| **Residual accuracy** | The `.env`-independent limitation the code *does* still carry is `X-Device-Id`: no client sends a stable one yet, so `auth.controller.ts:26-29` falls back to `randomUUID()` per login, which means one-active-device enforcement only meaningfully activates once a real client sends a stable id (tracked on #54). That is worth keeping in the doc; "in-memory" is not. |

### D2 — Global guards: documented as absent, actually registered

| | |
|---|---|
| **Doc says** | §1.4: *"guards `AuthGuard → RoleGuard → ZoneScopeGuard` are providers applied per-controller via `@UseGuards` — **there is no global `APP_GUARD`** (issue #99 open; an unguarded controller is silently public)."* |
| **Code says** | `app.module.ts:208-210` registers all three as `APP_GUARD` providers, in that order, with a comment explaining the design: *"every route authenticates by default (`@Public` opts out), then `@Roles` allow-lists, then ZM zone clamping. Per-controller `@UseGuards` stays valid (re-runs are idempotent) — but forgetting it no longer exposes a route."* `app.module.ts:213-216` also registers a global `ValidationPipe`, and `:204` a global `AllExceptionsFilter`. `common/decorators/public.decorator.ts` exists and its doc comment references `test/global-guard-validation.e2e-spec.ts`, which sweeps every route and fails until its public allow-list matches. |
| **Truth** | #99 landed. An unguarded controller is **no longer** silently public. Several controllers (`exports.controller.ts`, `plant-deactivation.controller.ts`, `ops-explorer.controller.ts`) now correctly carry only `@Roles` with no `@UseGuards`, relying on the global chain — which would be a security bug under the documented (old) model and is correct under the actual one. |

### D3 — Test-suite reliability: documented as broken, actually fixed

| | |
|---|---|
| **Doc says** | §top-matter (2026-07-22): *"The local test suite is no longer a reliable green/red signal. `fsm_test` is long-lived and `test/global-setup.ts` migrates + seeds but **never truncates**, so every spec that dies before its `afterAll` leaks fixtures permanently. Measured 2026-07-22: 780 orphan zones, 404 orphan engineers… → **#156**. Treat any local 'full suite green' claim from before that issue lands as unverified."* |
| **Code says** | `test/global-setup.ts` now calls `truncateTestDatabase(prisma, url)` between `prisma migrate deploy` and the seeds, with the comment *"truncate + reset identities (#180 R2) … Order matters: truncate before seed."* `test/truncate-test-db.ts` exists. Additionally `scripts/run-tests.mjs` (#184) detects a worker crash by reconciling vitest's own summary counts and re-runs only the dropped files, up to 3 times. |
| **Truth** | The leak class is closed (#180 R2), and the separate worker-crash class is detected and auto-recovered (#184). The blanket "treat local green as unverified" warning is stale. |

### D4 — Minor: `hard-filters.ts` reads as complete but two filters cannot fire

Not a SYSTEM-STATE error (§3e's table already records both stubs correctly), but worth calling out
because the **code file itself** is the misleading artifact: `hard-filters.ts` presents five filters
with real, tested drop logic, and nothing in that file indicates that `vehicleReadiness` and
`expectedComponentsAvailable` are fed constants by the only caller. The stubs are visible only in
`recommender.service.ts:~220`. A reader of the pure filter module alone would reasonably conclude both
are live.

---

# PART E — Explicit `NOT VERIFIED FROM CODE` inventory

Everything in this document is drawn from files I actually opened, **except** the following, which are
inferred from module wiring, doc comments, call sites, route signatures, or schema shape. Each is
flagged inline where it appears; this is the consolidated list.

### E.1 Service bodies not read

| Item | What I asserted | Basis |
|---|---|---|
| `dashboard.service.ts` | reads `device_states` + `tickets` + `plants`; ZM row-scoped | route roles + `DashboardModule` wiring + one comment at `:404` |
| `reports/*-aggregation.service.ts` (×5) | delete+insert idempotent rebuilds into 5 summary tables | `BusinessSweepSchedulerService` call sites + schema table docs + `POST /reports/*/recompute` routes |
| `commissioning-aggregation.service.ts`, `installer-classification.ts` | cohort/installer reporting off `device_commissioning` | route names + file names |
| `intraday-insertion.service.ts` | offer state machine; `sweepTimeouts` | cron call site + `intraday_insertions` schema + route names |
| `cross-zone-escalation.service.ts` | `sweepAutoEscalations`; parallel escalation record | cron call site + `cross_zone_escalations` schema |
| `inventory/*` (3 services) | van stock, ledger, shadow use, warehouse stock | `RecommenderService` call sites (`commonKitStatus`, `recordComponentBlock`, `resolveComponentBlock`) + schema |
| `component-request/*` | WAITING_COMPONENT flow, WM queue | `troubleshoot-submission.service.ts` comment + route names + schema |
| `vouchers/*`, `engineers/*`, `org/*` CRUD, `roles/*`, `planner/*`, `media/*` | per the module table | route/role inventory + schema |
| `install.service.ts`, `install-lifecycle.service.ts`, `recovery.service.ts`, `non-operational.service.ts` | work-type lifecycles | `TicketingModule` wiring + route inventory + `Ticket` column families |
| `override.service.ts`, `same-day-update.service.ts`, `bulk-unassign.service.ts`, the 3 scheduling query services | ZM override, #127 APPEND, rebalance, read surfaces | `SchedulingModule` wiring + route inventory + `schedule-status.ts` |
| `me-tickets/*` query bodies | SE day-plan + detail + forms + work history | `se-ticket-access.ts` (which I did read) + route inventory |
| `device-departure.service.ts` | `reconcile({observed, syncedPlantIds, runId, maxAbsenceRatio})` → `{departed, restored, skippedByReason}` | its **call site** in `master-sync.service.ts:558` + `device_departures` schema |
| `partition-maintenance.service.ts` | daily partition create-ahead + settings-driven retention | its `@Cron` line + `.env.example` + schema comments |
| `plant-eligibility-refresh-scheduler.service.ts` | periodic MV refresh backstop | its `@Cron` line + the #218 comment naming it as the reason the MV stayed fresh |
| `repeat-escalation.service.ts`, `tier-override-expiry.service.ts` | escalation scan / status sweep | cron call sites + one comment each |
| `ops-explorer/dataset-query*.ts`, `reconciliation.service.ts` | allow-listed dataset queries | `dataset-registry.ts` name + the guard (which I did read) + route names |
| `verification.service.ts` beyond line 130 | `verifyTicket` internals, the phase state machine's writes | the class docstring + `verification-criteria.ts` (read in full) + `verification_runs` schema |
| `troubleshoot-submission.service.ts` beyond line 170 | the non-component-unavailable branch (ticket → VERIFICATION_PENDING, cycle → SUBMITTED, audit + event) | the class docstring, which states it explicitly |

### E.2 Behaviours I could not confirm

| Question | Status |
|---|---|
| What does `TicketQueryService.list` do with `limit = NaN`? | **NOT VERIFIED** — no `ParseIntPipe`; behaviour depends on unread service code |
| Does `device-commissioning.e2e-spec.ts` assert `pg_index.indnullsnotdistinct`? | **NOT VERIFIED** — the model doc says the property was verified in the DB; whether the spec pins it is unknown. **Highest-value thing to confirm.** |
| Exact assertions inside any individual spec file | **NOT VERIFIED** — I read the 357-file listing and inferred coverage from names, not bodies |
| Whether every `version` column actually has enforcement | **NOT VERIFIED** — `transition-or-conflict.ts` exists; I did not audit every mutation path. SYSTEM-STATE §2.9 says "per-service and incomplete" |
| Contents of `.github/workflows/ci.yml` | **NOT VERIFIED** — confirmed to exist, not read |
| `app.config.ts` behaviour in tests that skip `bodyParser:false` | Stated in its own comment (*"test apps that skip that option simply keep the default parser, so this is additive there"*) — accepted from the comment, not independently verified |
| Whether any route accepts a zone id in a request body | **NOT VERIFIED** — I read every controller's decorators and paths, not every body DTO |

### E.3 Things explicitly proven ABSENT (not merely unverified)

These were checked by dependency-list inspection and/or exhaustive grep over `src/**`, and are
**NOT PRESENT**:

Redis · BullMQ · any queue broker · S3 / any AWS SDK / any object-storage client · microservices ·
a repository layer · CQRS · an event bus · `forwardRef()` · `SELECT … FOR UPDATE` ·
`@nestjs/throttler` (rate limiting) · Sentry / Bugsnag · Prometheus / StatsD / OpenTelemetry ·
pino / winston · `@nestjs/jwt` / passport · zod / joi · a Dockerfile / compose / k8s manifests ·
`setInterval` / `@Interval` / `@Timeout` / `cluster` / `worker_threads` in runtime code.

---

## Appendix — Session command log (what was actually run)

All read-only. **No files were modified, no migrations run, no packages installed, no database
altered.** The only write in this session is this document itself.

| Purpose | Tool |
|---|---|
| Read `docs/SYSTEM-STATE-2026-07.md` (first 578 lines of 1,438) | Read |
| List module dirs + root source files | Bash `ls` |
| Per-module file/controller/service/LOC counts | Bash `find` + `wc` |
| Full file listings per module (all 38 dirs) | Bash `find` |
| Controller base paths, then full route + `@Roles` + `@UseGuards` inventory | Bash `grep` |
| Exhaustive `@Cron` / `setInterval` / `onModuleInit` grep | Bash `grep` |
| Prisma model / enum / view inventory; `@@unique` / `@@id` / `@@map` inventory | Bash `grep` |
| Core entity model text (`Device`, `DeviceDeparture`, `Vehicle`, `Transporter`, `DeviceState`, `FailureCycle`, `Ticket`, `TicketEvent`) | Bash `sed` |
| All migration raw-SQL invariants (`CREATE UNIQUE INDEX`, `CHECK`, `PARTITION BY`, `CREATE MATERIALIZED`) | Bash `grep` across 77 migration files |
| `package.json`, `.env.example`, migration count/tail, test-file listing | Bash `cat` / `ls` |
| Redis / BullMQ / S3 absence check | Bash `grep` over `src` + `package.json` |
| CI / Dockerfile presence check | Bash `ls` |
| ~45 individual source files read in full | Bash `cat` / `sed` (batched) |

---

*End of document.*

