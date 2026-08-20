# #178 — Terminal closure clears the assignment (TDD completion report)

**Date:** 2026-08-20 · **Branch:** `feat/autoplant-integration` · **Type:** AFK · Backend
**Issue:** [`.scratch/fsm-platform-v1/issues/178-closure-never-clears-assignment.md`](../../.scratch/fsm-platform-v1/issues/178-closure-never-clears-assignment.md)
**Sequenced as:** P8 hard prerequisite of #269 (and therefore of P9 #274).

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## What was wrong

No terminal closure path ended the ticket's assignment. The batch row stayed live and
`assignment_state` stayed `FORMALLY_ASSIGNED`, so:

- `committedDayLoad` (`recommender.service.ts:926-937`) counts live batch rows on live schedules with
  **no ticket-status filter** — a finished ticket burned one of the SE's capacity slots indefinitely,
  and the recommender under-filled that SE accordingly. This is the exact figure #269 was about to
  render as fact, which is why #178 was promoted to a hard prerequisite.
- Every day-plan read filters `removed_at` only, so finished work rendered as live stops.

## The issue's writer list was stale — corrected at implementation time

Filed 2026-07-29; #241 landed in between and had already fixed two of the six paths it named. Verified
against the tree before writing any code:

| Terminal writer | State on arrival |
|---|---|
| `device-departure.service.ts` | already stamped by #241 (`TICKET_CANCELLED`) |
| `plant-deactivation.service.ts` | already stamped by #241 (`TICKET_CANCELLED`) |
| `auto-recovery.service.ts` | already stamped (`AUTO_RECOVERY`) |
| `verification.service.ts` `markAutoRecovery` | unstamped → fixed |
| `verification.service.ts` `finalize` (CLOSED / FAILED_VERIFICATION) | unstamped → fixed |
| `recovery.service.ts` `confirmWarehouseReceipt` | unstamped → fixed |
| `recovery.service.ts` `closeWith` (manual + failed-recovery close) | unstamped → fixed — **never named in the issue** |
| `install-lifecycle.service.ts` `closeVerified` + `failActivation` | unstamped → fixed |
| `non-operational.service.ts` `runConfirmedSideEffects` | unstamped → fixed — **never named in the issue** |

Two terminal paths the issue never listed are why the fix went in behind **one shared writer** rather
than six inline copies. `committedDayLoad`'s cited location (`:600-607`) was also stale; it is
`:926-937`.

## What was built

**`src/scheduling/close-assignment.ts` — `retireAssignmentOnClosure(tx, ticketIds, now)`.** One writer,
called inside each closure's existing transaction. It stamps the live batch row and clears
`assignment_state` only for tickets left with no live row, so a concurrent re-assignment is not dragged
back. The `removed_at IS NULL` predicate in the write makes it idempotent and stops it overwriting a
ZM's actor/reason in the race window — the same shape, and the same reasoning, as
`schedule-closure-scheduler.service.ts`.

**`REMOVAL_REASONS.TICKET_RESOLVED`.** Distinct from `TICKET_CANCELLED` (work called off from outside)
because here the work genuinely finished. Safe for #244 by construction: `COUNTABLE_REMOVAL_REASONS` is
an **allow-list**, so a new reason is excluded by default — pinned by an assertion, not left to trust.

**Actor is NULL by design.** Somebody closed the *ticket*; nobody withdrew the *assignment*. Who closed
it is already on the ticket's event and audit trail. Mirrors #241's choice for the cancellation paths.

**`plantDeviceStats` gained the missing status filter** (approved mid-slice as a required consequence).
It counted `assignment_state` with no status filter, so clearing the state on closure would have moved
finished tickets from the "assigned" column to "unassigned" and still reported them as work at the
plant. A closed ticket now counts in neither. `src/ticketing/resolved-ticket-status.ts` holds the
canonical set; the three pre-existing near-duplicate copies are documented there and deliberately **not**
folded in — one of them (`entity-mapping-export.service.ts`) has four members rather than seven, and
whether that is scoping or drift is a question for its own slice.

## Tests — 8 new, red before green on every slice

`test/closure-clears-assignment.e2e-spec.ts`, one vertical slice per closure family, each driven
through a real entry point (HTTP route where one exists; the sweep method where the path is cron-driven
and has none):

1. `mark-auto-recovery` (HTTP) · 2. non-operational confirmation (HTTP) · 3. warehouse receipt (HTTP) ·
4. recovery manual close (HTTP, covers the shared `closeWith`) · 5. install verification (sweep) ·
6. verification worker close (sweep) · 7. AC-2 invariant over everything the spec closed ·
8. `TICKET_RESOLVED` stamped, actor NULL, row kept, and excluded from #244's countable set.

Test 6 also pins the negative: a `VERIFICATION_PENDING` ticket is **not** terminal, and its assignment
must stay live until the worker decides.

Plus one in `test/dispatch-transparency-api.e2e-spec.ts` — a before/after assertion that a closed ticket
at a dispatched plant changes neither the assigned nor the unassigned count.

**Seam note.** The AC-2 invariant is scoped to the spec's own tickets, not table-wide. The suite shares
one database and other specs legitimately construct resolved-but-assigned rows as fixtures, so a
table-wide assertion would fail on their data rather than on a defect. Catching a *seventh* closure path
therefore needs a new test beside the others, not a wider query — stated here so the limitation is not
mistaken for coverage.

## The backfill was built and NOT executed — and it belongs to #243

AC-2 asks for the historical rows to be cleaned after a dry-run report.
`npm run closure-backfill:probe` is read-only by default; `--apply` is a deliberate second act. The
probe measured the dev mirror:

| | |
|---|---|
| Live batch rows on resolved tickets | **3,310** |
| Resolved tickets still `FORMALLY_ASSIGNED` | **4,402** |

The issue's headline "351" is stale by an order of magnitude. More importantly, this is not a new
population — it is **exactly #243's already-ratified C1 + C3**, and the arithmetic closes to the row:
C1 3,310 + C3 1,092 = 4,402.

#243 is HITL-gated and stamps `DEV_CLEANUP`, which its own text names as the rollback handle. Applying
this backfill first would silently consume C1+C3 under a different reason and destroy that handle — so
it was not applied. **This is a live backlog-ownership decision for the operator**, recorded in both
issue files. What is *not* in question: the mechanism is live, so the population stops growing today.

## Verification

- Backend `tsc --noEmit`: clean.
- New spec: 8/8. Transparency spec: 13/13 (12 pre-existing + 1 new).
- Full backend suite: see the INDEX session-log row for this date.
- No admin/mobile change: `plantDeviceStats`'s response shape is unchanged, only its honesty.

## Deliberate omissions

- The three duplicate closed-status lists are catalogued, not consolidated (behaviour-affecting; its own
  slice).
- No capacity-freed behavioural test — `committedDayLoad` is private, and proving it through a full
  dispatch run per family was judged disproportionate against #184's known Windows worker-crash rate.
  The live-row assertion is the same predicate `committedDayLoad` keys on.
