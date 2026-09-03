# 308 — One terminal-ticket-status vocabulary; guarded closes on departure/deactivation
Status: **done** (2026-09-02) — report [`docs/progress/308-terminal-status-vocabulary-fold.md`](../../../docs/progress/308-terminal-status-vocabulary-fold.md). Two things the issue did not have: (a) a **sixth** spelling — `devices/device.service.ts` hand-writes the set inside a raw-SQL `NOT IN (…)`, where nothing typechecks it and an import-graph drift check would never see it (hence the source-text pin); (b) the `FAILED_VERIFICATION` ruling could not be a vocabulary change alone. Verification closes the failure cycle only on `CLOSED`, so such a ticket is terminal while its cycle is live, and the old code reached that cycle ONLY as a side effect of the wrong re-close — folding the list by itself would have stranded live cycles on departed devices while `has_open_failure_cycle` was cleared anyway (#218's exact contradiction). Both paths now end live cycles directly.
Type: AFK
Wave: 2 · Severity: P2 · Findings: CB-5 + AR-9a,
`audit/2026-09-01-scheduler-engine-forensics.md` §6/§7

## Problem

Four spellings of "terminal ticket status" exist; two are **divergent** (4 members vs the
canonical 7) and sit in front of unguarded writes:

- `device-departure.service.ts:36-41` + `plant-deactivation.service.ts:20-25` — a ticket already
  terminal at `FAILED_ACTIVATION` or `RECEIVED_AT_WAREHOUSE` is re-closed as
  `CLOSED / DEVICE_UNDEPLOYED_CLOSE`, `closureType`/`closedAt` overwritten, a second closure
  event appended (departure cancel write at `:255-296` has no status guard).
- `entity-mapping-export.service.ts:17` — `openTicketCount` counts three terminal statuses
  (`FAILED_VERIFICATION`, `FAILED_ACTIVATION`, `RECEIVED_AT_WAREHOUSE`) as open.
- Identical (non-divergent, still copies): `schedule-closure-scheduler.service.ts:61` and
  `dashboard.service.ts:316`. The canonical file (`ticketing/resolved-ticket-status.ts:19`)
  documents the fork as unresolved.

## Root cause

The fold-in the canonical file planned was deferred and never happened; the departure/deactivation
writes rely on the scan-time filter alone.

## Affected files / symbols

- `apps/backend/src/ticketing/resolved-ticket-status.ts` (canonical — the one definition)
- `apps/backend/src/device-departure/device-departure.service.ts`
- `apps/backend/src/plant-deactivation/plant-deactivation.service.ts`
- `apps/backend/src/exports/entity-mapping-export.service.ts`
- `apps/backend/src/scheduling/schedule-closure-scheduler.service.ts` (fold the identical copy)
- `apps/backend/src/dashboard/dashboard.service.ts` (fold the identical copy)

## Intended behavior after fix

- Every consumer imports the canonical set (or a canonically-derived subset with a written reason
  — e.g. if `FAILED_VERIFICATION` is ruled still-live for departure purposes, that ruling lives
  next to the canonical set, once, with the repeat-escalation consumer named).
- Departure/deactivation close writes are guarded `updateMany` on non-terminal status — a ticket
  terminal at write time is skipped, counted, and keeps its original closure.
- The export's `openTicketCount` counts the canonical complement.
- A drift-pinning test fails if any file re-spells the set.

## Implementation boundaries

- Vocabulary + guards only. No status *semantics* change; no migration; no data backfill
  (re-closed history stays as history — repairing it is a separate decision, not smuggled here).
- `FAILED_VERIFICATION`'s membership for the departure path is the one judgement call — decide it
  from the repeat-escalation consumer's actual need and record it in the canonical file; if the
  code cannot answer it, mark that one member's handling needs-info rather than blocking the rest.

## DB / API / frontend impact

DB: none. API: export counts correct themselves (numbers shift — expected). Frontend: none.

## Dependencies

None. Independent of the dispatch-file sequence.

## Regression risks

- Dashboard/closure consumers folding to the canonical set must remain behavior-identical
  (the copies are identical today — pin with a snapshot before folding).
- Departure cancel flows that legitimately close OPEN work must keep doing so.

## Tests required

- Drift pin: one spec asserting no second spelling exists (grep-based or import-graph based).
- Guarded write: departure cancel over a `RECEIVED_AT_WAREHOUSE` ticket → untouched, counted as
  skipped; over an OPEN ticket → closed exactly as today.
- Export: fixture with the three contested statuses → not counted open.

## Acceptance criteria

- [x] AC1 — one definition; every consumer imports it (six, including the raw-SQL one via
      `Prisma.join`); drift pinned by `test/terminal-status-vocabulary.spec.ts`, which scans source text,
      names the offending file, and carries its own discrimination check so it cannot pass vacuously.
- [x] AC2 — no write can transition a terminal ticket to a different terminal state. Departure and
      deactivation closes are guarded in the WHERE, and the writes that follow describe the tickets that
      actually moved (the batch path re-reads its own stamp; the loop path skips on `count === 0`).
- [x] AC3 — export open-counts exclude all seven canonical members. Asserted on the
      `open_ticket_count` column looked up by header name, not by eyeballing the CSV row.

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

— (independent)
