# #289 — Override impact preview · backend completion report

**Backend landed 2026-08-25. The UI half is open** — see
[`HANDOFF-P11-289-ui.md`](../../.scratch/fsm-platform-v1/HANDOFF-P11-289-ui.md).
Owning decision: [#282](../../.scratch/fsm-platform-v1/issues/282-decision-todays-dispatch-crew-deck.md) R1
(the design's step 3).

## What was wrong

The approved flow is **inspect → understand → override → preview impact → confirm**. The system had
the first three and the last one. Every override in `OverrideService` commits immediately —
reason-gated, audited, but with no projection — so an operator's only way to see what a move would do
was to make it.

## What landed

`src/scheduling/override-projection.service.ts` — `projectOverride(batchId, cmd, scope, now)`, and
`POST /api/batches/:id/override/preview`.

It answers the four things the design's step-3 panel shows:

- **Both lanes' capacity**, `committed → after / capacity`, with `overCapacity` on each side.
- **Rank context** — where the run that placed this ticket ranked the *target* engineer, read from
  that run's own `dispatch_decision_traces` row.
- **The route effect** — which stop the work lands on, and whether it joins an existing stop.
- **The conflicts** the confirm will gate on: held-to-a-return-date, and ON_SITE.

## Five decisions worth recording

**It writes nothing, and that is asserted by counting rows, not by reading the code.** There is no
`create`, `update`, `$transaction` or `$executeRaw` in the file — the posture
`DistributeProjectionService` (#276) holds and #250's dry run proved. But a spec that only read the
source would not catch the next edit, so AC2 snapshots `work_schedules`, `plant_batch_assignments`,
`batch_assignment_tickets`, `audit_logs` and the notification outbox across three projections and
asserts the counts are identical. A projection that quietly created a schedule row would otherwise be
indistinguishable from a working preview until an operator cancelled and found the plan already
changed.

**It re-derives nothing.** Capacity comes from `committedDayPlan` — the definition the engine itself
enforces against (#269 / #272 R9) — the conflicts use the same predicates `override()` gates on, and
the route effect mirrors what `moveTickets` actually does. A preview computed a second way is a
preview that will eventually disagree with the commit it precedes, which is worse than no preview
because the operator would have trusted it.

**A one-lane action is refused, not answered with zeros.** REMOVE / DEFER / REORDER move no work
between engineers, so "both lanes' capacity" has no meaning for them. Returning `0 → 0` would read as
"this move costs nothing", which is the opposite of what removing somebody's work does. They get
`NOT_PROJECTABLE` (HTTP 400 with the reason).

**Null rank is unknown, never "unranked".** A ticket no run placed has no engine opinion to report.
Inventing a rank — zero, or "last" — would be read as the engine having considered and rejected the
target. Same rule #283's provenance follows, with its own test.

**Over capacity is stated, never a refusal.** #258 Q2 rules manual overload an administrative right;
a projection that refused a move taking the target past their cap would turn a preview into the gate
that ruling forbids. It reports `overCapacity: true` and projects anyway, pinned by a test.

## The AC5 deviation, and why

**AC5 says "the cockpit renders the preview". It will be Schedule Detail instead** — put to the
operator explicitly on 2026-08-25 and ruled by them.

The cockpit has no override controls: `/dispatch/today` links out to `/schedules/:engineerId`, which
is where an operator actually chooses an override. Hosting the move flow in the cockpit would mean
building a second copy of a surface that already exists, which #282 R5 forbids. The option was
offered — with the larger scope stated — and not taken. The issue text is corrected in place rather
than rewritten, so the reasoning survives.

## Tests

New: `test/override-impact-preview.e2e-spec.ts` (8) — the full impact shape, the zero-write property
across every table, a whole-batch SWAP_SE, an over-cap move that still projects, the zone clamp, the
one-lane refusal, an unknown target, and the honest-null rank.

The fixture dispatches **through a real run** rather than run-less, because rank context is read from
that run's traces and traces are only written when a run id is threaded through — a run-less fixture
would have quietly proved only that "no run means no rank". Its engineer capacities are assigned
*after* the run, from whichever engineer the engine picked, so which one that is cannot decide what
the spec asserts.

Amended: `test/batches-controller.e2e-spec.ts` (+3) — the endpoint's 404, its 400 for a one-lane
action, and the same role gate as the confirm.

## Not done here

**The UI (AC5) and therefore AC6's admin half.** The backend is complete, tested and wired; the panel
that renders it is the next session's work, and the handoff carries the ruling above plus the exact
component shape and the design lines to read.
