# #308 — One terminal-ticket-status vocabulary; guarded closes on departure/deactivation

**Landed 2026-09-02** · branch `feat/autoplant-integration` · issue
[`.scratch/fsm-platform-v1/issues/308-terminal-status-vocabulary-fold.md`](../../.scratch/fsm-platform-v1/issues/308-terminal-status-vocabulary-fold.md)
· findings CB-5 + AR-9a, `audit/2026-09-01-scheduler-engine-forensics.md` §6/§7

## What was wrong

"This ticket's work is over" was spelled out in several places. Two spellings had **four** members
against the canonical seven, and they sat in front of unguarded closure writes: a ticket already
terminal at `FAILED_VERIFICATION`, `FAILED_ACTIVATION` or `RECEIVED_AT_WAREHOUSE` was re-closed as
`CLOSED` by a device departure or a plant deactivation, with its `closure_type`, `closure_reason` and
`closed_at` overwritten and a second closure event appended — a ticket recorded as having ended twice,
for two different reasons, the later one wrong. A third four-member copy made the entity-mapping
export count terminal tickets as open work in a CSV operators reconcile against.

## Root cause verified against the tree — and a sixth copy the finding did not count

The issue names four spellings. The tree has six:

| File | Members | Note |
|---|---|---|
| `ticketing/resolved-ticket-status.ts` | 7 | canonical |
| `scheduling/schedule-closure-scheduler.service.ts` | 7 | identical copy |
| `dashboard/dashboard.service.ts` | 7 | identical copy |
| **`devices/device.service.ts`** | 7 | **not in the issue** — hand-written inside a raw-SQL `NOT IN (…)` |
| `device-departure/device-departure.service.ts` | 4 | divergent, in front of a closure write |
| `plant-deactivation/plant-deactivation.service.ts` | 4 | divergent, in front of a closure write |
| `exports/entity-mapping-export.service.ts` | 4 | divergent, wrong report numbers |

The raw-SQL one is the most instructive: nothing typechecks a string, so it agreed with the canonical
set by luck rather than by construction, and an import-graph-based drift check would never have seen
it. That is why the pinning test scans source text.

Two lists that look similar were checked and left alone: `ops-explorer/dataset-registry.ts` and
`ticketing/ticket-query.service.ts:145` spell the **complete** `TicketStatus` enum for a filter's
allowed values, not the terminal subset.

## The judgement call, decided

The issue flagged `FAILED_VERIFICATION`'s membership for the departure path as the one thing to decide
from the code. Decided **in**, and recorded in the canonical file:

- Nothing treats those three as live work. `device.service.ts`'s open-ticket lateral, the dashboard's
  assignment counts and the schedule-closure sweep all already excluded them.
- Repeat-escalation — the consumer that might have needed one of them to stay "open" — keys on
  `failure_cycles.state`, never on `tickets.status`, so widening this set cannot reach it.

**But the departure/deactivation paths never actually wanted the ticket — they wanted the cycle.**
Verification closes the failure cycle only on `CLOSED`, so a `FAILED_VERIFICATION` ticket is terminal
while its cycle is still live, and the old code reached that cycle *only* as a side effect of the
wrong re-close. Folding the vocabulary on its own would therefore have introduced a fresh bug:
departed devices keeping a live episode while `has_open_failure_cycle` was cleared anyway — exactly
the contradiction #218's lifecycle check exists to detect. So both paths now:

- select tickets to close with the canonical complement, and
- terminate live failure cycles **directly**, sourced from all of the device's / plant's tickets and
  guarded on the cycle still being live (`LIVE_FAILURE_CYCLE_STATES`, added beside the canonical set),
- with the departure's cycle write hoisted **out** of its `open.length > 0` branch, so a device whose
  only ticket is already terminal still has its episode ended.

## What was built

- `resolved-ticket-status.ts` — the ruling above, plus `LIVE_FAILURE_CYCLE_STATES`.
- All five other consumers import the canonical set; the raw-SQL one interpolates it via
  `Prisma.join`.
- Departure and deactivation closes are guarded (`status: { notIn: … }` in the WHERE), and the writes
  that follow describe the tickets that **actually** moved: the departure re-reads its own stamp after
  the batch `updateMany` (which reports a count, not rows); the deactivation's per-ticket loop skips on
  `count === 0`. `cancelledTickets` counts real cancellations.

## Tests

- `test/terminal-status-vocabulary.spec.ts` (new, 3) — **AC1.** Scans `src/` source text for a window
  naming the terminal markers without live ones, and fails naming the offending file. It carries its
  own discrimination check: the scan must fire on a respelled four-member copy and must **not** fire on
  the full enum, so the pin cannot pass vacuously. It also pins the canonical membership, so the fold
  cannot be "kept" by quietly narrowing what it folds to.
- `test/terminal-status-no-reclose.e2e-spec.ts` (new, 5) — **AC2/AC3.** A departure over a
  `FAILED_VERIFICATION` ticket leaves status, closure type, reason and instant untouched and writes no
  second event — *and still ends the live cycle and clears the flag*; the same for `FAILED_ACTIVATION`
  and `RECEIVED_AT_WAREHOUSE`; the same for a plant deactivation; an OPEN ticket is still cancelled
  exactly as before; and the export's `open_ticket_count` **column** (looked up by header, not by
  eyeballing the row) reads 0 for a terminal ticket.

**Red before green**: restoring the three four-member copies turns **5 red** — 4 behavioural cases plus
the drift pin, which names `plant-deactivation.service.ts` in its diff.

One test-harness note worth keeping: the departure spec drives the real `reconcile()` entry point with
`syncedPlantIds: []`. Without that, every device the file seeds on the shared plant is missing from
`observed`, in scope for the **absence** pass, and gets mass-departed — quietly wrecking the next case.

## Validation

- Targeted: 8/8 across the two new files. Departure, deactivation, stand-down export, entity-mapping
  export, device list/detail, dashboard drill-downs, lifecycle health, closure scheduler/recycling/
  wiring, fleet-uptime and device-cycles surfaces (21 files, 148 tests) green.
- Full backend suite and `tsc --noEmit`: recorded with Wave 2's combined run in
  [`INDEX.md`](../../.scratch/fsm-platform-v1/INDEX.md)'s session log.

## Follow-ups

None filed. Explicitly **not** done, per the issue's own boundary: no backfill of history that was
already double-closed. Repairing those rows is a separate decision with an operator in it, not
something to smuggle into a vocabulary fold.
