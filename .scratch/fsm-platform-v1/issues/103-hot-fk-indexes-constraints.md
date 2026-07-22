# 103 — Hot-FK indexes + remaining DB constraints
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-03-backend-production-readiness-audit.md` — HIGH #12 (+ the
> non-dispatch, non-intraday residue of HIGH #11). Verified still-open 2026-07-07: `schema.prisma`
> has no index on `tickets.device_id` or `tickets.vehicle_id`; the `audit_logs` composite leads with
> `acted_as_role` (NULL for native actions) and does not serve the ZM-performance monthly query
> keyed on `actor_role, created_at`.
>
> **2026-07-14 — `tickets(device_id)` leg landed** as the composite
> `tickets(device_id, created_at DESC)` (migration `20260714130000_tickets_device_created_idx`),
> hotfixing the Device Detail page's 86-second list query (the latest-live-ticket LATERAL seq-scanned
> tickets once per device; measured 86s → 0.4s at 20k devices / 19k tickets). Do not re-add a plain
> `tickets(device_id)` — the composite covers it. Still open here: `tickets(vehicle_id)`,
> `audit_logs(actor_role, created_at)`, the remaining partial uniques, and the `CONCURRENTLY` note.
>
> **2026-07-22 — evidence refreshed (full-project audit B5 / adversarial review v3 §2).** The
> `audit_logs` leg is **re-verified still open**, and the audit's B5 finding is folded in here rather
> than filed separately (its own recommendation: *"Fold into #103 rather than filing separately"*).
> Re-read on disk 2026-07-22:
> - Query: `reports/zm-performance-aggregation.service.ts:69` →
>   `WHERE actor_role = 'ZONAL_MANAGER' AND created_at >= … AND created_at < … GROUP BY actor_id, action`.
> - Only composite on `model AuditLog`: `@@index([actedAsRole, actingZone, createdAt])`
>   (`schema.prisma:1317`; columns at `:1307` `actor_role`, `:1308` `acted_as_role`, `:1314` `created_at`).
>
> **Different leading column — and `acted_as_role` is NULL for native (non-acting) actions**, so the
> existing index cannot serve this predicate at all. It *looks* like coverage and is not. Severity LOW
> today (~10.7k rows, measured by the prior audit) and grows unbounded with every audited action, which
> is the argument for doing it while the table is still small. AC#1 and AC#2 below already cover it;
> no scope change, evidence only.

## What to build

Add the missing indexes on hot foreign keys and the remaining cheap constraints — while the tables
are still small (post-launch index additions require `CONCURRENTLY` outside Prisma's migration
transaction, a convention this repo should adopt before production data exists).

1. **Indexes:** `tickets(device_id)` (device-detail drawer, per-device history, FK checks),
   `tickets(vehicle_id)`, and an `audit_logs(actor_role, created_at)` index serving the ZM-performance
   monthly aggregation (`zm-performance-aggregation.service.ts`).
2. **Remaining constraints** not already owned by #100/#101: any "at most one live X" partial unique
   the audit flagged that isn't the dispatch (#100) or intraday-offer (#101) leg — e.g. the
   one-ACTIVE-schedule-per-SE-day case where `ensureSchedule` is findFirst-then-create
   (`override.service.ts`), if not already covered by #100's `work_schedules` unique.
3. Where a partial unique already exists but P2002 surfaces as a 500 instead of the graceful outcome
   (`assignTicket`, `vouchers.service.ts` duplicate-submission race), map it to the outcome.

## Acceptance criteria

- [ ] Migration adds `tickets(device_id)`, `tickets(vehicle_id)`, and an `audit_logs(actor_role, created_at)` index; from-zero migrate has no drift; existing suite green.
- [ ] The ZM-performance monthly query plan uses the new `audit_logs` index (verify with EXPLAIN in a test or a documented check).
- [ ] Any remaining "at most one live X" partial unique flagged by the audit and not owned by #100/#101 is added, with P2002 handled as the graceful outcome at its call site.
- [ ] The repo documents the `CONCURRENTLY` convention for post-launch index additions (short note in the migration/agents docs).

## UI surfaces
n/a (backend/schema)

## Reference
n/a

## Blocked by
None — but coordinate ordering with #100 (`work_schedules`/`recommendations` uniques) and #101 (intraday-offer unique) to avoid duplicate migrations.
