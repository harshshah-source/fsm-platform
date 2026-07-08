# 104 — Retention + partition matrix for append-only tables
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-03-backend-production-readiness-audit.md` — the retention *tail* of
> CRITICAL #6 and HIGH #12. Already landed (do NOT redo): commit `65aa6e2` (R3) added real daily
> partitioning + configurable retention for `raw_device_snapshots`, and `partition-maintenance.service.ts`
> runs it on a `@Cron`. What remains is retention/growth management for the other append-only tables.

## What to build

Extend the retention/partition discipline that `raw_device_snapshots` now has to the remaining
fastest-growing append-only tables — `audit_logs` (one row per mutation, in-transaction; the fastest
grower after telemetry), `ticket_events`, `notifications`/`notification_deliveries`, and
`recommendations`. Deliver a single configurable retention matrix (per-table window, env/settings
driven) with a maintenance job, reusing the `partition-maintenance` cron pattern rather than adding a
new scheduler.

Note the financial-retention exception: `expense_vouchers` carries a 7-year retention comment and
must be excluded from any aggressive purge.

## Acceptance criteria

- [ ] A retention matrix (per-table window) exists as config, honoring the 7-year `expense_vouchers` exception.
- [ ] A maintenance job (extending or paralleling `partition-maintenance.service.ts`, same `@Cron` posture) enforces retention for `audit_logs`, `ticket_events`, `notifications`/`notification_deliveries`, and `recommendations`.
- [ ] Where a table warrants partitioning (audit_logs by time), the migration converts it before it grows large, or the decision to keep it non-partitioned with time-bounded deletes is documented with rationale.
- [ ] The job is idempotent and safe to run repeatedly; a test drives it against seeded old rows and asserts only out-of-window rows are removed.
- [ ] from-zero migrate green; existing suite green.
- [ ] **DEFAULT-partition watchdog** (added by the 2026-07-07 re-audit): the R3 design keeps an empty
      `raw_device_snapshots_default` as a safety net, and `PartitionMaintenanceService` is env-gated
      OFF by default — if it is disabled or the process is down past the 3-day create-ahead runway,
      telemetry silently re-accumulates in DEFAULT (the exact condition R3 was built to end). Add a
      check (integration `/health` field and/or maintenance-tick log/metric) that reports a non-empty
      DEFAULT partition and the days-of-runway remaining, so the failure is visible instead of silent.

## UI surfaces
n/a (backend/ops)

## Reference
n/a

## Blocked by
None — can start immediately.
