# 152 — Normalise migration index/FK names to eliminate the schema-drift baseline
Status: needs-triage
Type: AFK

> Filed 2026-07-22 by [#107](./107-ci-concurrency-guard-migration-tests.md) slice 2, on an explicit
> operator decision: scope the CI drift gate to *new* drift now, normalise the pre-existing naming
> drift later. Discovered while verifying [#144](./144-commit-dispatch-correctness-layer.md).

## Background

`prisma migrate diff` between a database built purely by `prisma migrate deploy` and `schema.prisma`
is **non-empty on this repo** and has been for a long time. #107's original AC#2 ("a migration-from-zero
test asserts a clean migrate with no drift") is therefore unsatisfiable as literally written.

## Problem

**72 drift lines across 22 unrelated tables.** All cosmetic — naming, not structure:

- **18 renamed indexes** — e.g. `zpsm_month_idx` → `zm_performance_summary_monthly_month_idx`,
  `vehicle_unavail_ticket_idx` → `vehicle_unavailability_reports_ticket_id_idx`.
- **1 renamed foreign key** — `vehicle_unavail_ticket_fkey` →
  `vehicle_unavailability_reports_ticket_id_fkey`.
- **FK re-declaration pairs** (`[-] Removed foreign key on columns (x)` immediately followed by
  `[+] Added foreign key on columns (x)`) — the same constraint, re-expressed under a different name.
- **A few `Altered column … default changed`** annotations where a DB-side default
  (e.g. `gen_random_uuid()`) is not represented in `schema.prisma`.

## Root Cause

Hand-written migration SQL chose short, human-friendly index and constraint names. Prisma's
introspected default naming convention is `<table>_<columns>_idx` / `_fkey`. Neither is wrong; they
simply disagree, and nothing ever reconciled them because no drift check existed before #107.

## Evidence

Baseline captured at `apps/backend/prisma/drift-baseline.txt` (72 entries + a self-documenting
header). Reproduce with:

```
cd apps/backend
DATABASE_URL=<a migrate-deploy-built, NEVER-BOOTED database> node scripts/check-schema-drift.mjs
```

> **Do not run it against a booted database.** `runtime_lock` is created at boot by
> `PrismaService.onModuleInit` (#130 L1 build-fingerprint lock), not by a migration, so a booted DB
> reports it as drift. CI uses a dedicated `fsm_drift` database that is migrated and never booted.

## Current Behaviour

The CI drift gate ([#107](./107-ci-concurrency-guard-migration-tests.md) slice 2) fails only on drift
**not** present in the committed baseline. Pre-existing naming drift is tolerated; anything new — a
migration applied but never committed (the #144 defect class), or a `schema.prisma` edit without a
matching migration — fails the build.

## Expected Behaviour

`drift-baseline.txt` is **empty**, and the gate becomes a plain zero-drift assertion with nothing
excluded.

## What to build

One migration renaming the 18 indexes and 1 foreign key to Prisma's convention, plus either
representing the DB-side defaults in `schema.prisma` or removing them, until the baseline is empty.

## Acceptance criteria

- [ ] A migration renames the drifting indexes/constraints to match `schema.prisma`'s expectations.
- [ ] `Altered column … default changed` entries are resolved — either the default is declared in `schema.prisma` or dropped from the DB, with the choice recorded per column.
- [ ] `node scripts/check-schema-drift.mjs` reports **zero** current drift lines against a freshly migrated, never-booted database.
- [ ] `drift-baseline.txt` is reduced to its header (or deleted, with the gate switched to a plain zero-drift assertion and `check-schema-drift.mjs` simplified accordingly).
- [ ] Full backend suite green; from-zero migrate still succeeds.

## TDD Strategy

The failing check already exists and is automated: `check-schema-drift.mjs` is the RED, and it goes
GREEN as the baseline shrinks. Work it in batches (a few tables per commit), re-baselining after each
so the file monotonically shrinks and every commit is independently mergeable.

**Do not re-baseline to make a red gate green** — that is the one misuse of the `--write` flag, and it
would silently re-admit exactly the drift this issue exists to remove.

## Implementation Slices

Batch by table group — each slice is one migration, one re-baseline, independently mergeable:

1. **Slice 1** — report/summary tables (`zm_performance_summary_monthly`, `root_cause_summary_monthly`,
   `system_efficiency_summary_daily`, `device_downtime_summary_monthly`).
2. **Slice 2** — operational tables (`vehicle_unavailability_reports`, `verification_runs`,
   `troubleshooting_submissions`, `intraday_insertions`, `cross_zone_escalations`).
3. **Slice 3** — inventory/component tables (`component_request`, `component_blocked_queue`,
   `inventory_transactions`, `expense_vouchers`).
4. **Slice 4** — remaining tables, then delete the baseline and simplify the gate to zero-drift.

Each slice: **Files** the migration + `drift-baseline.txt`; **Database** renames only, no structural
change; **Services / Frontend** none; **Tests** full backend suite + the drift gate; **DoD** baseline
strictly smaller, suite green, from-zero migrate clean.

## Rollback Plan

Renames are reversible with an inverse migration and touch no data. Because each slice is one
migration plus one baseline update, any slice reverts independently.

## Dependencies

None. **Not blocking anything** — #107's gate already protects against new drift. Low priority: this
is debt paydown that makes the gate strictly simpler, not a defect that can bite a user.

## Estimated Effort

Half a day, spread across 4 slices. **Priority: P3.**

> **Deliberately NOT scheduled ahead of the gate.** Doing this first would land a broad migration
> touching 22 tables with no CI in existence to verify it — which is precisely the risk profile #107
> was built to remove.

## UI surfaces
n/a (schema/infra)

## Reference
n/a

## Blocked by
None. Best done after [#107](./107-ci-concurrency-guard-migration-tests.md) is green and trusted.
