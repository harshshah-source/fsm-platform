# Progress — Issue 02: Org / reference config + Settings

> Assessment + build date: 2026-06-18 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **ACCEPTED WITH FOLLOW-UP** (deep review 2026-06-18). AC complete enough to unblock
> Issue 04 — zones/plants/companies tables + idempotent seed exist and Issue 04 only *reads*
> reference data. **AC#2 downgraded to PARTIAL** (plants not in Admin UI; company update path
> absent); AC#5 deferred. Issue 02 **not reopened** — gaps tracked as follow-ups #45–#48.
> Backend 61 tests / 23 files green, admin 7 tests green, both typecheck clean (local PostgreSQL 18,
> no Docker).

## Summary

Operations-Head configuration end-to-end: every reference/config entity is editable through a
guarded API, every mutation is written in the same transaction as its `audit_logs` row, and the
admin `/settings` page (Operations-Head-only) edits them. Built on the Issue 01 primitives
(`AuthGuard→RoleGuard`, `@Roles('OPERATIONS_HEAD')`, in-tx `AuditService`, Prisma 7 on PG18).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | `/settings` gated to Operations Head; others can't reach it | 🟢 | `RoleRoute(['OPERATIONS_HEAD'])` route guard + Operations-Head-only nav link; backend `@Roles` is the server-side twin. `apps/admin/test/settings.test.tsx` (ops head reaches it; ZM redirected to shell). |
| 2 | Zones, plants, SE mappings, coverage types editable & persisted | 🟡 **Partial** | Zones + SE mappings/coverage fully editable in API **and** UI: `engineer_master` + `se_coverage` with the DEDICATED/MULTI_PLANT/FLOATING enum, partial-unique (one row per DEDICATED SE) + `coverage_type <> 'FLOATING'` CHECK; `test/org-se-coverage.e2e-spec.ts` (7); Admin SE Coverage tab. **Gaps:** (a) **plants editable via API only** — `PlantsAdminController` persists, but no Plants tab and no `listPlants`/`createPlant` in `api/org.ts`; SE Coverage form needs a hand-typed `plantId` → **follow-up #45**. (b) **no company update path** (create-only) → **follow-up #46**. |
| 3 | SLA rules, Tier/Rank, Common Kit, scoring weights configurable w/o code | 🟢 | `company_master` (companies), `sla_rule_config`, `priority_rule_config`, `common_kit_definition`. Tests: `org-companies` (4), `org-sla-rules` (4), `org-scoring-weights` (3), `org-common-kit` (3). Admin tabs for each. |
| 4 | User accounts manageable (ZM/CSM/WM/SE) | 🟢 | `org-users` (prior) — create + activate/disable; admin Users tab. |
| 5 | `device.deal_type` manually taggable | 🔴 **Deferred** | The `devices` table is owned by Issue 04 (snapshot ingestion). Tagging a column on a non-existent table is impossible here; deferred rather than creating a `devices` stub that would collide with Issue 04. |
| 6 | Every config mutation writes an audit entry | 🟢 | All writes go through `AuditService.withAudit` (one tx). Distinct actions: `COMPANY_CREATED`, `ENGINEER_REGISTERED`, `SE_COVERAGE_ADDED/REMOVED`, `SLA_RULE_UPDATED`, `SCORING_WEIGHT_UPDATED`, `COMMON_KIT_UPDATED` (+ prior ZONE/PLANT/USER/SETTING). |
| 7 | Reference/org seed loads for downstream slices | 🟢 | `src/org/org-seed.ts` (idempotent) + `pnpm --filter @fsm/backend seed`; `test/org-seed.e2e-spec.ts` proves idempotency. Seeds zones/plant/companies/SLA/weights/common-kit. |

## Slices delivered (build order)

1. **S5 Companies** — `/api/org/companies`; tier (enum) + single-letter rank validation. (RED left by a prior session → GREEN.)
2. **S6 SE coverage** — `engineer_master` + `se_coverage` migration (partial-unique + CHECK added by hand to the generated SQL); `/api/org/engineers`, `/api/org/se-coverage`.
3. **S7 SLA rules** — `sla_rule_config`; `GET/PUT /api/org/sla-rules`, upsert on `(scope,key)`.
4. **S8 Scoring weights** — `priority_rule_config`; `GET/POST /api/org/scoring-weights`, upsert on `(weight_set_ref,component)`.
5. **S9 Common Kit** — `common_kit_definition`; `GET/POST /api/org/common-kit`, upsert on `component_id`.
6. **S10 Seed** — idempotent `seedOrgReferenceData` + `seed.ts` entrypoint + `seed` script.
7. **S11 Admin Settings** — `/settings` route, `RoleRoute`, tabbed `SettingsPage`, `src/api/org.ts` client, gated nav link.

## Data model added (migrations, this issue)

- `20260618121101_add_engineer_se_coverage` — `coverage_type` enum, `engineer_master`, `se_coverage` (+ partial-unique index + not-FLOATING CHECK appended manually).
- `20260618121547_add_sla_scoring_kit_config` — `sla_rule_config`, `priority_rule_config`, `common_kit_definition` (+ `min_qty > 0` CHECK appended manually).
- `company_master` migrated in a prior session.

## Deviations / deferred (read before extending)

1. **AC#5 `device.deal_type` deferred** — needs the device/commercial-attrs table. Deferral is
   valid (can't tag a column on a non-existent table), but the original "to Issue 04" target is
   wrong: `deal_type` appears in **no** issue between 02 and **35** (Non-Operational, which depends
   on it to trigger Recovery Tickets). Re-pointing tracked as **follow-up #48** so it isn't lost.
2. **`common_kit_definition.component_id` has no FK yet** — `component_master` is Issue 21. Modelled
   as a plain bigint; add the FK with the inventory slice. Seed uses placeholder ids 1–4 (cable/SIM/antenna/fuse).
3. **`engineer_master.preferred_notification_channel` is text, not the `notify_channel` enum** — the
   enum belongs to the notification spine (Issue 03); widen to the enum when it lands.
4. **`shift_start/shift_end`, `last_activity_at`** columns exist on `engineer_master` but are not yet
   surfaced in the API/UI (downstream: activity ping Issue 15, notifications Issue 29).
5. **Auth users vs DB users** — login still uses the in-memory store (Issue 01 debt). `engineer_master`
   FK→`users` requires a **DB** user row, so an SE must be created via `POST /api/org/users` before an
   engineer profile. Seed deliberately seeds reference data, not credentials.
6. **`AuthProvider` gained a test-only `initialSession` prop** (defaults `null`) so route-gating is
   unit-testable without the login dance. Harmless in prod.

## Follow-ups (deep review 2026-06-18)

Issue 02 stays **accepted / not reopened**. These are tracked as new backlog items:

| # | Title | Severity | Why |
|---|-------|----------|-----|
| 45 | Plants Admin UI | P1 | Closes the AC#2 gap — plants editable via API but absent from `/settings`. |
| 46 | Company Update API + UI | P1 | Company is create-only; CONTEXT "Ops Head can override per-company" unmet. |
| 47 | RequestActor acting-attribution seam | P1 (before #27/#33/#35) | `acted_as_role` is structurally always `null` on mutations — correct for OpsHead config today, wrong once acting-capable mutations land. |
| 48 | `deal_type` ownership clarification | P1 (tracking) | AC#5 deferral target mis-stated; no issue between 02 and 35 owns it. |

## How to run / verify

```
# backend (local PG18 must be up)
cd apps/backend && node node_modules/vitest/vitest.mjs run     # 61 green
node node_modules/prisma/build/index.js migrate dev            # apply migrations
pnpm --filter @fsm/backend build && pnpm --filter @fsm/backend seed   # load reference data

# admin
cd apps/admin && node node_modules/vitest/vitest.mjs run       # 7 green
# demo: start backend + admin, log in ops.head@fsm.test / correct-password → Settings link
```

Note: `pnpm exec` triggers a network deps-check that FortiGate blocks; run the vitest/prisma/tsc
binaries directly via `node node_modules/...` as above.
