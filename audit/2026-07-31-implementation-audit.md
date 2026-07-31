# FSM Platform — Engineering Implementation Audit

**Date:** 2026-07-31
**Branch:** `feat/autoplant-integration` @ `a0d8b31`
**Method:** documentation read first, then verified against code, schema, runtime wiring, and executed test runs. Every conclusion is backed by repository evidence. No files were modified during the audit.

**Live measurements taken this session:**

| Check | Command | Result |
|---|---|---|
| Backend suite | `vitest run` (isolated `fsm_test`) | ❌ 7 files failed · 8 tests failed · 1,271 passed · 11 skipped · **exit 1** (814 s) |
| Admin suite | `vitest run` | ✅ 89 files · 386 tests · **exit 0** (76 s) |
| Mobile suite | `jest` | ✅ 6 suites · 20 tests · **exit 0** (7 s) |
| Typecheck | `turbo run typecheck` | ✅ 4/4 workspaces clean |
| Working tree | `git status --short` | 45 dirty paths (10 new files) |
| Branch | `git rev-list` | 226 commits ahead of `main`; **7 commits unpushed** |

---

## 1. Executive Summary

This is a **substantially built, single-line-of-development greenfield platform** that is far past prototype and well short of production. What exists is real: a NestJS modular monolith with **27 feature modules, 54 controllers, 205 HTTP endpoints**, a **69-model / 69-migration** Postgres+PostGIS schema, a **65-page / 44-route** React admin SPA wired to **37 typed API clients**, and **~1,700 tests** across three workspaces.

The full business funnel — AutoPlant master sync → snapshot ingestion → device-state recompute → ticket creation → recommender → batch dispatch → field loop → GPS verification → reporting cubes — is **code-complete and runtime-wired**, not stubbed. Each stage's service, module registration, and cron/HTTP entry point was verified individually.

Three things disqualify it from production, and all three are structural rather than cosmetic:

1. **Authentication is a dev scaffold.** `auth.module.ts:14-15` still provides `InMemoryUserStore` / `InMemoryRefreshTokenStore`. Migration `20260729120000_production_auth_credentials_refresh_tokens` created the tables — *nothing reads or writes them*. There is **zero** rate-limiting code in `apps/backend/src`.
2. **The SE mobile app does not exist.** `apps/mobile` is 14 files: login, session, token store. Every field-worker screen in the PRD is unbuilt, and the backend cannot serve one yet (`GET /api/tickets/:id` is manager-only; `ZoneScopeGuard` is a no-op for `SERVICE_ENGINEER`).
3. **The backend test suite is RED at HEAD**, and has been for several commits — measured above.

The most important finding is not any single defect — it is that **the project's own documented control (CI, added in `b5eceb1` / `eb791d0`) is not holding.** The suite went red on a *pushed* commit (`4d9ecc8`) and stayed red, which is the precise failure mode issue #141 was filed to eliminate. Meanwhile the last completed feature (#176) exists **only as 45 uncommitted working-tree paths** while `docs/SYSTEM-STATE-2026-07.md` already describes it as done — a recurrence of the #144 pattern.

**Documentation quality is unusually high.** `docs/SYSTEM-STATE-2026-07.md` is itself a rigorous, evidence-cited audit and was accurate on nearly every claim re-verified here. Its drift is limited to items that changed *after* it was written.

---

## 2. Current Development Stage

**Stage: late feature-build, entering hardening. Not pre-production.**

| Dimension | % | Reasoning (evidence-based) |
|---|---|---|
| Foundation / infra-in-repo | **85%** | pnpm+turbo monorepo, Prisma 7 + PostGIS, 69 migrations, fail-fast boot (`validateBootConfig`), global guard chain + exception filter, liveness/readiness probes, build-fingerprint runtime lock, CI workflow with from-zero-migrate + drift gate. Missing: no container, no secrets management. |
| Backend (admin-facing v1) | **85%** | Every funnel stage implemented and wired. Gaps are known stubs, not absences. |
| Backend (SE/mobile-facing) | **20%** | 20 of 166 `@Roles` declarations include `SERVICE_ENGINEER`; core SE reads are manager-only; 1 of 54 controllers uses DTO validation. |
| Frontend (admin) | **90%** | 65 pages, 44 routes, role-gated, real API clients, 386 green tests. Zero mock-data pages. |
| Frontend (mobile) | **5%** | Auth shell only — 14 files. |
| Infrastructure / deployment | **25%** | CI exists. No Dockerfile, no compose, no runbook, no backup/DR, no metrics, no structured logging. |
| Testing | **70%** | Excellent breadth (1,295 backend + 386 admin + 20 mobile). Undermined by: red suite, shared non-truncating test DB (#156), and a self-inflicted time-bomb fixture. |
| Documentation | **80%** | Best-in-class depth and honesty; drift is recent and localised. |
| **Production readiness** | **35%** | Gated by auth, deployment, observability, and an unenforced green-build signal. |

**If a new team joined today:** they would inherit a working, richly-tested business engine with an exceptional written record, and would spend their first 4–8 weeks on identity, packaging, and restoring a trustworthy build signal — not on features.

---

## 3. Repository Overview

```
fsm-platform/  (pnpm workspaces + turbo)
├── apps/
│   ├── backend/   NestJS 10 · Prisma 7 · Postgres16+PostGIS · mysql2 (AutoPlant, read-only)
│   │              src: 311 .ts (234 hand-written + 77 generated) · 54 controllers · 205 endpoints
│   │              prisma: schema 2,432 lines · 69 models · 69 migrations · 1 materialized view
│   │              test: 317 files
│   ├── admin/     React 18 · Vite · React Router · Tailwind design system
│   │              src: 183 .ts(x) · 65 pages · 44 routes · 37 API clients · test: 89 files
│   └── mobile/    React Native 0.81 · Expo 54 · expo-router — 14 files, auth only
├── packages/shared/   ONE file, 76 lines (Role + login/session DTOs)
├── docs/          PRD, CONTEXT (129KB), 25 ADRs, 23 audits, 49 progress reports, UI refs
├── .scratch/fsm-platform-v1/   the live issue tracker — INDEX.md + 202 issue files
└── .github/workflows/ci.yml    the only infrastructure-as-code in the repo
```

**Runtime topology (verified).** One NestJS process, global prefix `/api`, dual-registered at `/api/v1` and unversioned (`app.config.ts:27-30`). In-process `@nestjs/schedule` only — **16 `@Cron` handlers**; no Redis, no BullMQ, no S3 (`apps/backend/package.json`). External AutoPlant MySQL over VPN; unset env ⇒ mock sources so dev/CI boot.

**Scheduler inventory (16 `@Cron`):** 2 ingestion (`ingestion-telemetry`, `ingestion-masters`), 1 partition maintenance, 1 `plant-eligibility-refresh` *(undocumented in SYSTEM-STATE §3g)*, 11 business sweeps, 1 `business-dispatch`.

---

## 4. Module Status Matrix

| Module | Status | % | Evidence |
|---|---|---|---|
| `prisma` | ✅ Implemented | 100 | `PrismaService` with `statement_timeout` / `idle_in_transaction_session_timeout` pool opts (`prisma.service.ts:52`); boot-time runtime lock |
| `auth` | 🟡 Partial | 40 | JWT/scrypt/rotating-refresh logic real; **stores in-memory** (`auth.module.ts:14-15`); DB tables exist, unused |
| `org` | ✅ | 95 | 32 files, 14 admin controllers; zones/plants/companies/users/SE-coverage/territory/SLA/weights/tiers/tier-overrides/geo/zone-mapping |
| `ingestion` | ✅ | 95 | 29 files; master sync, keyset snapshot worker, run ledger, reaper, partitions, health, scheduler |
| `device-state` | ✅ | 95 | Set-based recompute, SLA bands shared TS/SQL, eligibility modes |
| `ticketing` | ✅ | 90 | 22 files, 8 controllers; creation, troubleshoot, auto-recovery, repeat-escalation, VU, non-op, recovery, install |
| `recommender` | 🟡 | 75 | Filters/scoring/canonical-sort/persistence real; **2 of 5 hard filters are stubs** (§7) |
| `scheduling` | ✅ | 90 | 19 files; advisory-locked idempotent dispatch, override engine, same-day, bulk-unassign, dispatch-run ledger |
| `business-sweep-scheduler` | 🟡 | 85 | 11 crons wired and correct; **its own spec file is red** (§9) |
| `verification` | ✅ | 90 | Three-phase GPS, fraud flag, inventory resolution |
| `intraday` / `cross-zone` / `shared-pool` / `planner` / `soft-state` | ✅ | 85–90 | All present, module-registered, e2e-covered; two latent orphan bugs filed (#139/#140) |
| `inventory` / `component-request` | ✅ | 85 | Ledger, shadow-use, warehouse stock, blocked queue |
| `dashboard` | ✅ | 95 | 8 endpoints; single shared `FLEET_COUNT_COLUMNS` SQL fragment (**uncommitted**) |
| `reports` | ✅ | 90 | 12 endpoints, 5 aggregation cubes |
| `engineers` / `roles` / `vouchers` / `exports` / `plant-deactivation` / `devices` / `settings` / `audit` | ✅ | 85–95 | All wired in `AppModule` |
| `notifications` | 🏗 Skeleton | 35 | Spine + delivery rows real; **only `LoggingChannelGateway`** — no FCM/APNs/WhatsApp/SMS/email adapter |
| `@fsm/shared` | 🏗 | 10 | 76 lines: `Role`, `SessionView`, login DTOs. #169's "54 error codes + response types" not started |
| `apps/mobile` | 🏗 | 5 | 14 files, auth only |

---

## 5. Feature Matrix

| Feature | Docs | Code | Runtime | Tests | Status |
|---|---|---|---|---|---|
| AutoPlant master sync | ✔ | ✔ | cron (OFF) + HTTP | ✔ | ✅ |
| Snapshot ingestion + partitions | ✔ | ✔ | cron **OFF** | ✔ | ✅ code / ⛔ dormant |
| Device-state recompute · SLA buckets | ✔ | ✔ | on tick | ✔ | ✅ |
| Ticket creation + failure cycles | ✔ | ✔ | on tick | ✔ | ✅ |
| Recommender scoring + canonical sort | ✔ | ✔ | dispatch run | ✔ | ✅ |
| — vehicle-readiness hard filter | ✔ | stub | never fires | — | 🏗 `vehicleReadiness: 'UNKNOWN'` (`recommender.service.ts:221`) |
| — expected-component hard filter | ✔ | stub | never fires | — | 🏗 `expectedComponentsAvailable: true` (`recommender.service.ts:225`) |
| Batch dispatch (advisory lock, idempotent) | ✔ | ✔ | cron **ON** | ✔ | ✅ |
| ZM override / same-day / intraday / cross-zone | ✔ | ✔ | ✔ | ✔ | ✅ |
| GPS three-phase verification | ✔ | ✔ | cron **ON** | ✔ | ✅ ⚠ armed (§7) |
| Install / recovery / non-op lifecycles | ✔ | ✔ | ✔ | ✔ | ✅ |
| Inventory / van stock / component requests | ✔ | ✔ | ✔ | ✔ | ✅ |
| Reporting cubes (5) | ✔ | ✔ | month/day crons | ✔ | ✅ |
| Effective company tier + scoped overrides | ✔ | ✔ | ✔ | ⛔ **all 6 engine tests error out** | 🟡 |
| Admin dashboard + 44 routes | ✔ | ✔ | ✔ | 386 ✔ | ✅ |
| KPI transparency / operational population (#176) | ✔ | ✔ | ✔ | ✔ | 🟡 **entirely uncommitted** |
| Audit-trail viewer UI | ✔ | backend only | endpoint live | backend ✔ | 📄 **zero** admin references |
| Persistent auth / credentials | ✔ | schema only | not wired | — | 🏗 |
| Rate limiting | ✔ | — | — | — | ❌ |
| SE mobile app (all screens) | ✔ | — | — | — | ❌ |
| Offline queue / batched sync | ✔ | — | — | — | ❌ |
| QR scanner · technical hints | ✔ | — | — | — | ❌ |
| Push / WhatsApp / SMS / email delivery | ✔ | seam | logs only | — | 🏗 |
| SAP PGI feed | ✔ | reader only | no writer | — | ❌ (blocker B7) |
| Media/photo upload + storage | ✔ | ref column only | — | — | ❌ |
| Deployment / Docker / runbook | ✔ | — | — | — | ❌ |
| Metrics / structured logging | ✔ | — | — | — | ❌ (no pino/winston/prom-client) |

---

## 6. Documentation Accuracy

`docs/SYSTEM-STATE-2026-07.md` is the strongest artifact in this repo — it self-corrects, cites `file:line`, and marks inference. **It was accurate on every claim independently re-verified, except the following**, all of which are *newer-than-the-doc* drift.

### 6.1 Now-stale (reality moved ahead of the doc)

1. §5.9 *"No CI (#107)"* — **wrong now.** `.github/workflows/ci.yml` exists: Postgres+PostGIS service, from-zero migrate, drift gate, all three suites on their own exit codes.
2. §5.7 *"`tickets.device_id` unindexed"* — **fixed.** `@@index([deviceId, createdAt(sort: Desc)])`. `vehicleId` remains unindexed; `audit_logs` has `(actedAsRole, actingZone, createdAt)`.
3. §5.6 *"all-default pool with no `statement_timeout`"* — **fixed** in `prisma.service.ts:52`.
4. §1.3 *"55 migrations"* → **69**. §2 *"59 models"* → **69**. Schema is 2,432 lines, not 2,055.
5. §1.4 *"24 feature modules"* → **27**.
6. INDEX #136 (zone operating-mode visibility) is listed `ready-for-agent`; it is **built** (`ZoneOperatingModeCard.tsx`, `ZoneOperatingModeTable.tsx`, `api/operatingMode.ts`).

### 6.2 Actively misleading (doc claims completion the repo does not hold)

7. §3k documents **#176 as "done, 2026-07-29"**. It is **not committed** — `dashboard.service.ts`, `kpiCatalog.ts`, `KpiInfo.tsx`, `OperationalFleetSection.tsx`, `docs/kpi-definitions.md`, `dashboard-kpi-reconciliation.e2e-spec.ts`, and the issue file itself are all in `git status`. **A fresh clone does not have this feature.** This is the #144 pattern repeating.
8. INDEX #157 records *"all 9 ACs checked"*; three of its engine specs cannot execute (§9).

### 6.3 Confirmed still accurate

In-memory auth reality · `BUSINESS_SWEEPS_ENABLED="true"` with ingestion OFF · notification-adapter seam · the two recommender stubs · #145's zero admin references · #105's duplicate singletons · #178's unfiltered `committedDayLoad` · #162's SE-blind zone guard · #155's partial unique index.

### 6.4 Undocumented implementations

`/api/v1` dual-serve · the `plant-eligibility-refresh` cron (a 16th scheduled job absent from §3g's table) · the schema-drift baseline mechanism (`prisma/drift-baseline.txt`).

### 6.5 Issue-file status distribution (202 files)

65 `done` · 64 `ready-for-agent` · 8 `ready-for-human` · 8 `needs-triage` · 8 `accepted` · 1 `needs-info` · 1 `deferred` · 1 `superseded` · remainder carry long-form dated statuses. One file (`97-PROGRESS.md`) has no `Status:` line.

---

## 7. Backend Audit

### Completed & wired

Every module in `AppModule.imports` resolves; every controller is registered. The guard chain is genuinely global (`APP_GUARD` × 3 + `APP_FILTER` + `APP_PIPE`), with exactly **4 `@Public()` sites** — login/refresh, health, and the non-op customer confirm. Boot is fail-fast on missing `JWT_ACCESS_SECRET`; shutdown hooks fire Prisma/MySQL disconnects; a build-fingerprint preflight runs before Nest constructs the module graph (`main.ts:17-22`).

### Partial

- **Recommender:** 2 of 5 hard filters can never fire. `VEHICLE_ON_TRIP` receives a constant `'UNKNOWN'` (`recommender.service.ts:221`); `COMPONENT_UNAVAILABLE` receives a constant `true` (`:225`). Dispatch quality is structurally capped until #65/#51.
- **Validation:** `class-validator` appears in **exactly one file** (`cross-zone/cross-zone.dtos.ts`). Nest's `ValidationPipe` skips non-class metatypes, so the global pipe is inert for the other ~200 endpoints. Malformed client input returns 500, not 400 (#174).
- **Module wiring (#105):** `recommender.module.ts` re-provides `InventoryService`, `SeAvailabilityService`, and `SoftInactiveCountService` locally — three duplicate singletons. Harmless today; a correctness bug the day any of them caches.
- **Persisted auth (#91):** tables shipped, wiring did not.

### Missing

Rate limiting (zero hits for `throttler|Throttle|rate-limit`). Media upload/storage (`photoRef` is a client-supplied string; no `FileInterceptor`/multer anywhere). External notification adapters. PGI writer. Structured logging and metrics (no `pino`/`winston`/`prom-client`/`@nestjs/terminus` in `package.json`).

### Broken / armed

- ⚠️ **The verification sweep is armed against a paused pipeline.** `apps/backend/.env` has `BUSINESS_SWEEPS_ENABLED="true"` while `INGESTION_SCHEDULER_ENABLED="false"` and `PARTITION_MAINTENANCE_ENABLED="false"`. The 5-minute verification sweep expires its window on wall-clock and reads telemetry that nothing is writing. A troubleshoot submission would age into an **irreversible** `FAILED_VERIFICATION` with its `PRE_VERIFICATION` inventory rolled back — regardless of whether the SE actually fixed the device. Exposure is zero only because no SE has submitted a form. **Armed, not safe** (#148).
- **`committedDayLoad`** (`recommender.service.ts:600-607`) filters on `removedAt: null` with **no ticket-status predicate**, and no closure path clears `assignmentState` — so closed work consumes SE capacity permanently (#178).

---

## 8. Frontend Audit

### Completed

65 pages across 20 domains behind `ProtectedRoute` + `RoleRoute` gates mirroring backend `@Roles`. Hand-rolled hooks over a single `http.ts` interceptor implementing single-flight rotating refresh on 401. Shared design system (`components/data|ui|overlay|charts|shell`) with `DataTable`, real breadcrumb resolution (`shell/breadcrumb.ts`), per-table CSV/Excel/PDF/PNG export read from the **DOM** (so an export can only ever contain what the user is authorised to see, and always matches the post-filter/post-sort view). Dark mode. **89 test files / 386 tests pass, exit 0** — verified this session against the current working tree.

### Partial / disconnected

- **#145 parity-gate violation stands:** `grep -ril "audit-trail|auditTrail" apps/admin/src` → **0 hits**, while `audit-trail.controller.ts` is live and registered in `AppModule`. An implemented, guarded, tested backend capability has no consumer.
- **#120 half-built:** the `plant_zone_overrides` pin has an admin page (`PlantZonesPage.tsx`); the `zone_mappings` crosswalk itself is still API-only.
- **#176's UI is uncommitted** (`KpiInfo.tsx`, `OperationalFleetSection.tsx`, `lib/kpiCatalog.ts`, `lib/fleetFormat.ts`).

### Unused / dead

`api/authHeaders.ts` has zero importers. `/_kitchensink` is `import.meta.env.DEV`-guarded — acceptable.

### Broken

None found. `tsc --noEmit` clean.

---

## 9. Testing Audit — the headline finding

All three suites and the workspace typecheck were executed. Results are in the header table.

Two independent root causes, both worth escalating.

### (a) A stale constructor — red since a *pushed* commit

`#157 slice 4` (`4d9ecc8`, 2026-07-27) inserted `tierOverrideExpiry` as the **6th** constructor parameter of `BusinessSweepSchedulerService` and added `tierOverrideExpiryCron` to its config object. `test/business-sweep-scheduler.e2e-spec.ts` was last touched **2026-07-07** (`cd5c4a2`) and still passes 10 positional collaborators — so every dependency after `repeatEscalation` shifts by one, producing:

```
ERROR [BusinessSweepSchedulerService] soft-inactive tick failed:
      this.softInactive.recompute is not a function
```

6 failures here, plus 2 more in the `-intraday` / `-install` companions from a second cause: `test/setup-env.ts` neutralises `AUTOPLANT_MYSQL_*`, `DATABASE_URL`, and `JWT_ACCESS_SECRET` — but **not** `BUSINESS_SWEEPS_ENABLED`, which the developer's `.env` sets to `"true"`. Every "dormant when the master switch is off" assertion therefore fires against an *enabled* scheduler. CI passes that gate only because CI's environment never defines the variable.

### (b) A calendar time-bomb — #157's engine has no passing coverage

Migration `20260723130000_company_tier_overrides` enforces:

```sql
CONSTRAINT "company_tier_overrides_expiry_window_chk"
  CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '2 months')
```

`created_at` defaults to the **real** `CURRENT_TIMESTAMP`. Three specs (`recommender-tier-override`, `ticket-creation-tier-override`, `dispatch-run-tier-override-snapshot`) build fixtures from a **frozen literal** `NOW = new Date('2026-07-23T06:00:00Z')` with `expiresAt = NOW + 24h`. Since 2026-07-24 that value is in the past relative to wall-clock `created_at`, so every insert is rejected:

```
DriverAdapterError: new row for relation "company_tier_overrides"
violates check constraint "company_tier_overrides_expiry_window_chk"
```

`beforeAll` throws, all 6 tests report as skipped, and the files count as failed. **The effective-tier resolver's engine bite (AC-4), ticket-creation tier stamping, and dispatch-run config snapshot (AC-6) currently have zero executing tests** — while the issue file records "all 9 ACs checked."

### Why this matters more than the eight failures

Commit `4d9ecc8` **is pushed to origin**, so CI should have caught it. It did not stop anything. The last **7 commits (all of #179) are unpushed** and therefore never CI'd at all. The control exists; the loop is not closed.

### Structural test-infrastructure debt

`test/global-setup.ts` migrates and seeds but never truncates, so interrupted runs leak fixtures permanently (#156 measured 780 orphan zones / 404 orphan engineers). This run also produced one `Error: Worker exited unexpectedly` unhandled error — the load-related crash mode #156 documents as unresolved by a clean DB. **Any local "suite green" claim in this repo should be treated as unverified.**

---

## 10. API Audit

**205 endpoints across 54 controllers**, all reachable via `AppModule`. Every route is registered twice (`/api/...` and `/api/v1/...`) by design (`app.config.ts:27-30`).

- **Implemented & consumed:** the admin surface — 37 client modules cover dashboard, reports, tickets, devices, schedules, dispatch-runs, org admin, inventory, cross-zone, install, vouchers, exports, integration health, bulk-unassign.
- **Implemented but unconsumed:** `GET /api/audit-trail/tickets/:id` — zero admin references (#145). The clearest orphaned-capability instance in the repo.
- **Missing for the stated next milestone:** no SE-callable ticket detail (`tickets.controller.ts:70-71` allows only ZM/CSM/OH), no SE self-artifact reads (vouchers/leave/intraday all manager-only), no SE component-request create, no batched-sync endpoint, no media upload, no ticket search, no technical hints.
- **Undocumented:** `/api/v1` aliasing; `GET /api/dashboard/fleet-composition` exists in code but only in the *uncommitted* layer.
- **Authorisation floor:** `ZoneScopeGuard.canActivate` returns `true` immediately unless `role === 'ZONAL_MANAGER'` (`zone-scope.guard.ts:27-29`) — there is **no row-level scoping for `SERVICE_ENGINEER`**. Any authenticated SE can currently write against every open troubleshoot ticket in every zone (#162). Latent only because no SE client exists.

---

## 11. Database Audit

**Strong.** 69 models / 2,432 lines / 69 migrations, from `20260617103804_init_system_settings` to `20260729120000_production_auth_credentials_refresh_tokens`. Conventions are consistent: snake_case `@map`, timestamptz UTC, BigInt ids (uuid for tickets/cycles/submissions/users), PostGIS via `Unsupported(...)`.

**The invariant work is the best part of this codebase.** Raw-SQL appendices carry what Prisma cannot express: partial uniques (one active failure cycle per device, one SUGGESTED recommendation per ticket, one in-flight snapshot run, one live intraday offer, one active batch row per ticket), CHECK constraints, daily RANGE partitioning on `raw_device_snapshots`, and the `plant_eligible_floating_se` materialized view.

**Verified gaps:**

- `work_schedules_one_active_per_se_zone_day` is **partial on `status='ACTIVE'`**, so `OVERRIDDEN` rows are invisible to it — the one-plan-per-(SE, zone, day) invariant is enforced **in application code only** (#155).
- `tickets.vehicle_id` still unindexed (`tickets.device_id` was fixed by `20260714130000`).
- **Retention/partitioning exists for exactly one table.** `audit_logs`, `ticket_events`, `notifications`, `recommendations`, `master_sync_rejects` are append-only, unpartitioned, unretained (#104).
- **Known cosmetic drift across 22 tables** (18 renamed indexes, 1 renamed FK) between migrations and `schema.prisma`, deliberately pinned in `prisma/drift-baseline.txt` so CI fails on *new* drift only. A well-reasoned compromise, documented at length in `scripts/check-schema-drift.mjs`.
- **No production writer:** `pgi_history` (blocker B7), `zone_warehouse_stock.reserved`, `users` credentials, `engineer_territory_coverage.polygon`.
- **Seeding:** `seed.ts` is 29 lines delegating to `seedOrgReferenceData` — org/reference data only. No production data seed path.

---

## 12. Technical Debt (prioritised)

### Critical

1. Backend suite red at HEAD; CI gate demonstrably not enforced (§9).
2. `#176` shipped only into the working tree — 45 dirty paths, 10 of them new files, documented as done.
3. In-memory auth + zero rate limiting; scrypt login is an unthrottled CPU-DoS vector.
4. `ZoneScopeGuard` has no SE row-level floor.

### High

5. Verification sweep armed against a paused ingestion pipeline (#148).
6. `#157` tier-override engine has no executing tests (time-bomb fixtures).
7. `class-validator` in 1 of 54 controllers — global pipe inert; client errors surface as 500s.
8. `committedDayLoad` counts closed work forever; closure never clears assignment (#178).
9. No deployment artifact of any kind (no Dockerfile, compose, or runbook).

### Medium

10. `#105` duplicate singletons in `recommender.module.ts` / `engineers.module.ts`.
11. Append-only tables with no retention or partitioning (#104).
12. Shared test DB never truncates → flaky full runs (#156).
13. `#145` orphaned audit-trail endpoint; `#120` half-built zone-mapping admin.
14. Two of five recommender hard filters permanently inert.
15. `@fsm/shared` is 76 lines — the contract-freeze substrate (#169) does not exist yet.

### Low

16. `tickets.vehicle_id` index; `api/authHeaders.ts` dead; SYSTEM-STATE §1.3/§2/§5 counts stale; 7 unpushed commits.

---

## 13. Risks Blocking Production

| # | Risk | Blast radius |
|---|---|---|
| R1 | No real identity store; restart = mass logout; DB users cannot log in | Total — nothing may be exposed beyond a demo network |
| R2 | No rate limiting on scrypt login | Trivial CPU exhaustion of the single process |
| R3 | No SE row-level authz | Cross-zone data exposure the moment a mobile client ships |
| R4 | Green build not enforced; suite red on pushed commits | Every correctness claim in the repo degrades to a local claim |
| R5 | No deployment/DR story — no image, no backup, no restore drill | Cannot ship; cannot recover |
| R6 | Sweeps armed while ingestion is paused | Silent, irreversible `FAILED_VERIFICATION` + inventory rollback on first real SE submission |
| R7 | No metrics, no structured logging, no access log | A production incident would be undiagnosable |
| R8 | Single process, no queue, no HA; append-only tables unbounded | Slow-burn until it isn't |
| R9 | Data-blocked activation: ~23% of fleet UNZONED, `engineer_master`/`se_coverage` empty in prod-shaped DBs, `pgi_history` empty | The funnel runs and produces `NO_ELIGIBLE_SE` |

---

## 14. Next Recommended Development Phase

**Milestone: "Trustworthy Build + Real Identity" — restore the signal, then close the security floor.**

Deliberately *not* mobile: shipping a client against today's authorization and validation surface would expose every zone's data.

### P0 — restore the control loop (days)

1. Fix `business-sweep-scheduler.e2e-spec.ts` for the 11-collaborator constructor; add `BUSINESS_SWEEPS_ENABLED` (and the other master switches) to `test/setup-env.ts` neutralisation.
2. Rebase the three `*-tier-override` specs onto a relative clock so `expires_at` is always ahead of a live `created_at`. **Do not weaken the CHECK constraint.**
3. Commit or explicitly revert the #176 working tree — it is the sole copy of a feature the docs call done.
4. Make CI blocking and confirm it actually runs on `origin`; push the 7 orphaned #179 commits.
5. Truncate + reseed in `test/global-setup.ts` (#156).

### P1 — security floor (2–4 weeks)

6. `#91` Postgres credential store + persistent refresh tokens (tables already shipped) → `#110` rate limiting → `#109`'s httpOnly-cookie leftover.
7. `#162` SE row-level authorization.
8. `#174` DTOs on all SE write routes — the global `ValidationPipe` is inert until classes exist.
9. `#148` gate sweeps on telemetry freshness, not wall-clock.

### P2 — operability (3–5 weeks)

10. `#111` Dockerfile + compose + runbook + backup/restore drill.
11. `#167` request-scoped observability: correlation ids on success, access log, `(actorId, createdAt)` index.
12. `#178` closure-stamp helper + dry-run-gated backfill; `#155` unique-index backstop (probe for duplicates first); `#104` retention matrix; `#105` wiring de-fork.
13. `#145` audit-trail viewer — close the parity-gate violation.

### P3 — mobile enablement, in the plan's own order

14. `#169` contract freeze into `@fsm/shared` → `#161` SE read surface → `#164`/`#165` retry + poll bounding → `#166` capture-time authority (HITL D5) → `#82`/`#17` offline sync → `#170` OTA / min-client-version gate.

### Parallel, HITL-gated, non-engineering

B8 zone ratification (unblocks ~23% of the fleet) · SE roster + coverage entry · B7 eligibility standing decision · `#116` SAP PGI feed contract · `#76` external notification channel accounts.

---

## One-line answer

> A well-architected, densely-tested, exceptionally-documented business engine that is roughly **85% feature-complete for the admin product, ~5% for mobile, and ~35% production-ready** — currently blocked less by missing features than by three governance failures: a red build that CI isn't catching, a completed feature that exists only in one machine's working tree, and an authentication layer that is still a development scaffold.
