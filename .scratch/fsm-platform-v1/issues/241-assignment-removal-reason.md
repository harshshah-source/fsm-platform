# 241 — Assignment removal-cause: `removal_reason` on batch rows, writer stamps, backfill, indexes

Status: done (2026-08-19)
Type: AFK · Backend + migration

Filed 2026-08-19 from the approved scheduler-decisions plan. The schema foundation for recycling
(#242), cleanup (#243), and Special attempt counting (#244). Approved rule it serves: use a
dedicated assignment-removal reason rather than inferring recycling from `removed_by`.

## What to build

### Current behaviour (verified)

- `batch_assignment_tickets` has `removed_at` / `removed_by` only. `removed_by = NULL` is **already
  owned by auto-recovery** (`auto-recovery.service.ts:303-306`; 1,092 rows in the dev DB) — it does
  NOT mean "human vs system-recycle" and cannot be overloaded further.
- Removal writers today: `override.service.ts` `removeTicket:147-152`, `deferTicket:190-204`,
  `moveTickets:441` (source rows); `bulk-unassign.service.ts:270-277`; `auto-recovery.service.ts:303-306`.
- Two paths end an assignment **without stamping the row**: departure / plant-deactivation
  cancellation (`device-departure.service.ts` closes the ticket, cycle → FAILED, row left live —
  3,310 such rows exist, 20 of them on today's ACTIVE schedules rendering cancelled tickets as
  work-to-do on SE day plans) and `component-request.service.ts:256` (ticket → UNASSIGNED on
  component arrival, row left live).
- Index reality: only `(batch_id)` plus the partial unique `(ticket_id) WHERE removed_at IS NULL`.
  A historical per-ticket attempt count seq-scans ~16k rows; `soft_states` has no `(ticket_id, set_at)`
  index for window joins.

### Required change

1. **Migration (describe + create in-slice when implemented; not before):**
   - `batch_assignment_tickets.removal_reason text NULL`
   - `CREATE INDEX ON batch_assignment_tickets (ticket_id);`
   - `CREATE INDEX ON soft_states (ticket_id, set_at);`
   - Backfill existing removed rows: `removed_by IS NULL` → `AUTO_RECOVERY`; `removed_by IS NOT NULL`
     → `ZM_DEFERRED` where `deferred_to_date IS NOT NULL`, else `HUMAN_REMOVED` (withdraw / reassign
     source / bulk are not distinguishable retroactively and do not need to be — all are excluded
     from attempt counting anyway).
2. **Reason vocabulary** (single exported constant set, not free text):
   `ZM_WITHDRAWN · ZM_DEFERRED · REASSIGNED · BULK_UNASSIGNED · AUTO_RECOVERY · TICKET_CANCELLED ·
   COMPONENT_WAIT · PLAN_EXPIRED (written by #242) · VEHICLE_UNAVAILABLE (written by #246) ·
   RESOLVED_AT_CLOSURE (backstop, #242) · DEV_CLEANUP (written by #243) · HUMAN_REMOVED (backfill only)`.
3. **Writer stamps:** each existing writer sets its reason. New symmetric stamps:
   departure/plant-deactivation cancellation stamps its tickets' live rows
   (`TICKET_CANCELLED`, `removed_by NULL`) in the same transaction that closes the tickets;
   `ComponentRequestService` stamps `COMPONENT_WAIT` when it unassigns.
4. **Invariant established going forward:** `assignment_state = 'FORMALLY_ASSIGNED'` ⟺ exactly one
   live batch row (the partial unique already gives "at most one"; the new stamps close the "closed
   ticket with a live row" leaks).

### Existing code to reuse

All writers listed above; `AuditService.withAudit` (writers already audit — no new audit shape);
Prisma migration conventions per `prisma/migrations/`.

### Tests

Per-writer e2e assertions that the reason is stamped; backfill leaves zero removed rows with NULL
reason; departure-cancellation e2e extended: cancelled ticket's row is stamped and disappears from
`/me/tickets`; component-arrival e2e extended likewise.

### Risks / rollback

Column is additive and nullable — rollback is dropping it. Backfill is re-runnable (idempotent
`UPDATE … WHERE removal_reason IS NULL`). The departure-stamp change also fixes the live defect of
cancelled tickets rendering on SE day plans — behaviour change is strictly corrective.

## Acceptance criteria

- [x] AC1 — `removal_reason` exists; every current writer stamps its documented reason; the reason
      vocabulary is a single exported constant set used by all writers.
- [x] AC2 — Backfill: zero rows with `removed_at IS NOT NULL AND removal_reason IS NULL`.
- [x] AC3 — Departure / plant-deactivation cancellation stamps live rows (`TICKET_CANCELLED`) in the
      same transaction; a cancelled ticket no longer appears on any SE day plan.
- [x] AC4 — `ComponentRequestService` stamps `COMPONENT_WAIT` when returning a ticket to the pool.
- [x] AC5 — Indexes `(ticket_id)` on `batch_assignment_tickets` and `(ticket_id, set_at)` on
      `soft_states` exist; the per-ticket attempt-count query plan uses them.
- [x] AC6 — Auto-recovery rows carry `AUTO_RECOVERY`; nothing anywhere infers "system" from
      `removed_by IS NULL` alone any more.

## UI surfaces

n/a

## Reference

n/a (backend-only)

## Blocked by

Nothing. Blocks #242, #243, #244, #246.
