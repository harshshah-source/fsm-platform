# 103 — Hot-FK indexes + remaining DB constraints
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-03-backend-production-readiness-audit.md` — HIGH #12 (+ the
> non-dispatch, non-intraday residue of HIGH #11). Verified still-open 2026-07-07: `schema.prisma`
> has no index on `tickets.device_id` or `tickets.vehicle_id`; the `audit_logs` composite leads with
> `acted_as_role` (NULL for native actions) and does not serve the ZM-performance monthly query
> keyed on `actor_role, created_at`.

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
