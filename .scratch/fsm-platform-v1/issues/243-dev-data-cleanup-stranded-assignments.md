# 243 — Development-data cleanup: stranded and dead assignment state

Status: ready-for-human
Type: HITL · Data operation (no application code)

Filed 2026-08-19. Approved scope (operator, 2026-08-19 brief §19) — **described here; execution
requires the separate implementation approval and happens before #242 is enabled.** Counts are from
the 2026-08-18 snapshot of `fsm` @ 5433 and MUST be re-measured at execution time (ingestion was
off; the DB is a dev mirror).

## What to build

A single documented, transactional cleanup script (run manually or via a one-off admin script — not
a migration, not application code), preceded by `pg_dump` of `batch_assignment_tickets`, `tickets`,
`work_schedules`.

### Scope (approved)

| Class | What | Expected (re-measure) | Action |
|---|---|---|---|
| **C1** | Live batch rows on resolved/cancelled tickets — departure/plant-deactivation left them live; includes 20 on today's ACTIVE schedules rendering cancelled tickets as SE work-to-do | 3,310 | `removed_at = now`, `removed_by = NULL`, `removal_reason = 'DEV_CLEANUP'` |
| **C2** | Stranded OPEN tickets on PARTIAL schedules (the pre-recycling backlog; ~1,357 pass the 48-h gate today) | 4,684 rows/tickets | row stamped as C1 **+** `ticket.assignment_state = 'UNASSIGNED'` **+** one `ticket_events` row per ticket (`reason_code = 'DEV_CLEANUP'`, the bulk-unassign precedent) |
| **C3** | `FORMALLY_ASSIGNED` on closed auto-recovered tickets with no live row (auto-recovery never reset the state) | 1,092 | `assignment_state = 'UNASSIGNED'` |

### Explicitly untouched (approved)

The 299 live rows on ACTIVE schedules (current work) · all `soft_states` · all `ticket_events`
history · `vehicle_unavailability_reports` · `recommendations` (0 SUGGESTED orphans exist) ·
schedules (0 past-dated live exist).

### Verification (all must hold after execution)

```sql
-- V1: no live row on a non-live schedule
SELECT count(*) FROM batch_assignment_tickets b
JOIN plant_batch_assignments p ON p.batch_id=b.batch_id
JOIN work_schedules w ON w.schedule_id=p.schedule_id
WHERE b.removed_at IS NULL AND w.status NOT IN ('ACTIVE','OVERRIDDEN');          -- = 0
-- V2: no live row on a resolved ticket
SELECT count(*) FROM batch_assignment_tickets b JOIN tickets t ON t.ticket_id=b.ticket_id
WHERE b.removed_at IS NULL AND t.status IN ('CLOSED','CLOSED_AUTO_RECOVERY',
 'CLOSED_NON_OPERATIONAL','FAILED_VERIFICATION','FAILED_ACTIVATION','FAILED_RECOVERY',
 'RECEIVED_AT_WAREHOUSE');                                                        -- = 0
-- V3/V4: assignment-state invariant, both directions
SELECT count(*) FROM tickets t WHERE t.assignment_state='FORMALLY_ASSIGNED'
 AND NOT EXISTS (SELECT 1 FROM batch_assignment_tickets b
                 WHERE b.ticket_id=t.ticket_id AND b.removed_at IS NULL);         -- = 0
SELECT count(*) FROM tickets t WHERE t.assignment_state='UNASSIGNED'
 AND EXISTS (SELECT 1 FROM batch_assignment_tickets b
             WHERE b.ticket_id=t.ticket_id AND b.removed_at IS NULL);             -- = 0
-- V5: deltas match the measured scope
SELECT count(*) FROM batch_assignment_tickets WHERE removal_reason='DEV_CLEANUP'; -- = C1+C2
```

### Rollback

Pre-commit: the transaction. Post-commit: every touched row is identifiable — clear
`removed_at`/`removal_reason` where `removal_reason = 'DEV_CLEANUP'`; restore `FORMALLY_ASSIGNED`
on the tickets carrying a `DEV_CLEANUP` ticket event; C3 identifiable by status. The dump is the
last resort.

### Attempt-history guarantee

No cleaned row can ever count toward Special: the `DEV_CLEANUP` reason is not a countable cause
(#244), and the reached-evidence requirement independently excludes them (virtually no historical
row has a `soft_states` row — 17 exist in the whole DB).

## Acceptance criteria

- [ ] AC1 — Executed only after explicit operator approval, after #241's column exists, and before
      #242 is enabled; counts re-measured and recorded at execution time.
- [ ] AC2 — `pg_dump` taken and its location recorded before the transaction.
- [ ] AC3 — V1–V5 all pass and their outputs are recorded in this issue's progress doc.
- [ ] AC4 — Nothing in the untouched list changed (row counts compared before/after).
- [ ] AC5 — The one-off script is committed under `.scratch/` or `docs/runbooks/` for the record —
      it is not application code and registers no scheduler/cron.

## UI surfaces

n/a

## Reference

n/a

## Blocked by

#241 (needs `removal_reason`). Gates the enablement of #242.
