# #289 — Override impact preview · completion report

**Backend landed 2026-08-25; the UI half landed the same day** and is reported in its own section at
the foot of this file — the backend half above it is left exactly as it was written. The handoff that
carried the ruling between the two sessions is consumed:
[`docs/archive/HANDOFF-P11-289-ui.md`](../archive/HANDOFF-P11-289-ui.md).
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

---

# The UI half — 2026-08-25 (fourth session)

Appended, not rewritten: everything above is the backend half as it was reported. **#289 is now
done.** The handoff that carried the ruling between the two sessions
(now `docs/archive/HANDOFF-P11-289-ui.md`) is consumed and archived.

## What landed

`apps/admin/src/components/domain/OverrideImpactPanel.tsx` and `apiOverridePreview` in
`apps/admin/src/api/schedules.ts`, rendered inside **all three** move panels on Schedule Detail —
Swap SE and Split batch on the stop, Reassign on the ticket row — between choosing a target SE and
pressing Confirm. Four rows, the design's step 3: both lanes' `committed → after / capacity`, the
system's view of the target, the route effect, and the conflicts the confirm will gate on.

## Decisions worth recording

**The preview is keyed on the target, not on the form.** The projection is a function of *which
engineer the work moves to* and *which work moves* — never of the reason typed beside it, so a
manager writing three sentences of justification fires one projection, not thirty. For Split that
means the ticket selection is an input too: ticking a second ticket re-projects, because the impact
of moving two tickets is not the impact of moving one. `reasonCode` is still **sent**, because the
preview and the confirm take the identical body; a preview that trimmed the object would be the first
step towards two vocabularies for one command.

**A failed projection loses the panel, never the Confirm.** #258 Q2 again: the preview is an aid, so a
manager whose projection 500s keeps a move they are entitled to make, and gets no error surface for a
thing they did not ask for. Its own test drives a 500 and then commits.

**The 409 path was left exactly where it was (AC4).** The lost-race conflict belongs to the write and
is answered on the write; nothing about the preview routes through `OverrideConflictError`. A test
opens the panel, commits into a 409, and asserts the existing banner — not an error page — still
appears and still re-submits with `confirm: true`.

**The "Human override" chip is neutral, where the design draws it amber.** #272's grammar table gives
amber exactly one meaning — over capacity — and this pill would have sat inches from the amber
capacity lane, same shape, different meaning: the precise defect #290 spent a slice removing from
`/assign`, re-introduced for literal fidelity to a drawing. Violet was not the answer either; the
table spends it on "a human crossed a coverage tier", which this move need not be. The words carry the
meaning and no colour has to. **The lane treatment itself stays amber**, which is what the table
actually assigns the colour to.

**The design's pronoun is not rendered.** The panel says "existing stops are not reordered" where the
design says "her route is not reordered". Nothing in the system records an engineer's pronouns, and a
name is not one — so the sentence is written about the route rather than about the person, which is
also the fact being promised.

**The rank sentence names the run by id, and links to it.** The design writes "in the 05:00 run"; the
projection carries `runId`, not a start time, so the row says `run 900` and links to
`/dispatch-runs/900`, where the time is. The alternative — a second fetch to decorate one sentence —
buys a phrase and costs a request on every target change.

## A defect the suite found, and what it actually was

Three tests in `schedule-override.test.tsx` failed the moment the page started previewing, with
"found a label … no form control associated". The label was fine. The stub matched `/override` and
POST, so it answered the **preview** with the commit's `{result:'OK'}` payload — the panel then read
`from.dailyCapacity` off `undefined` and took the tree down with it, and a form inside an unmounted
tree has no controls.

Both halves were fixed as fidelity, not as appeasement: the stubs now match `/override/preview`
**first**, as the real backend's two routes do, and `overrideCall()` — the helper asserting *what was
written* — excludes the preview explicitly. That second half mattered more than it looks: a preview
carries an empty `reasonCode`, so a helper that matched it would let a commit with a **missing
mandatory reason** pass the "the reason was sent" assertion unnoticed.

## Tests

New: `test/override-impact-preview.test.tsx` (20) — the two lanes' before → after; over capacity
marked and Confirm still enabled; the rank sentence and its run link; **two silence tests** (no rank
recorded, and no run at all) that assert the absence of "unranked"; three route sentences (appended /
joins an existing stop / opens a new day plan); conflicts clear, held-to-a-return-date, and on-site;
the request cadence (nothing before a target, the identical body, no re-projection on typing, a
re-projection on a new target); all three move panels including Split's selection dependency; the
one-lane actions never projecting; the failed-projection and lost-race guards; and the header naming
the move.

Amended: `test/schedule-override.test.tsx` (+1 stub route, helper narrowed) — see above.

Admin suite **112 files / 653 tests, 0 failed**; `tsc --noEmit` clean. (One unhandled error remains in
`ticket-drawer-tabs.test.tsx`; it reproduces on a file this work never touched and its three tests
pass.) No backend change: the endpoint shipped with `8f4550e` and was not edited.
