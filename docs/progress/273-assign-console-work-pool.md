# #273 — Assign Work Console S1: the work pool, the ledger, one predicate (TDD completion report)

**Date:** 2026-08-20 · **Branch:** `feat/autoplant-integration` · **Type:** AFK · Backend + Admin
**Issue:** [`.scratch/fsm-platform-v1/issues/273-assign-console-work-pool.md`](../../.scratch/fsm-platform-v1/issues/273-assign-console-work-pool.md)
**Design (authoritative):** `docs/ui/desktop/approved-designs/assign-work-console.html`
**Sequenced as:** P9 slice 1 of 5, behind #178 ✅ and beside #269 ✅.

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## What was wrong

Seven surfaces could move work to an engineer and **not one showed a count** — the volume arrived
afterwards, in a toast. Every one is shaped N→1 (many tickets, one engineer, written immediately, no
preview, no residual) while a dispatcher's job is M→N. And the top-bar **Assign SE** button — prominent,
on every manager screen — called `navigate('/')`. It opened nothing, for its entire life.

## The two definitions, and the third that nearly happened

`assignPlants` writes `OPEN + UNASSIGNED + not-deferred-today`. `plantDeviceStats` counts a plant's
tickets by `assignment_state` alone. Feeding a console from the second while committing through the
first puts a number on screen the button beside it cannot move.

`src/ticketing/assignable-work.ts` is now the one predicate — `assignableTickets(day)` — shared by the
new read and by `assignPlants`. Its complement `heldTickets(day)` is **reported, not derived by
subtraction**: a dispatcher offered 9 of 12 devices needs the missing 3 accounted for, and deriving it
would quietly absorb any future exclusion into "held".

**The read is counted in memory from the Prisma predicate, not in SQL.** A `GROUP BY` would be cheaper
and would be a second spelling of the same rule — the exact fork R3 exists to close, on the one screen
that cannot afford it.

## The AC asked for a weaker test than the one that was needed

AC-1 asked for a test that calls the predicate and `assignPlants`' selection and compares ticket-id
sets. Once both call sites import the same function that assertion is tautological — it can only fail
if someone deletes the import, which the compiler already catches.

The test built instead is the one AC-1 was reaching for: **the read predicts the write.** It takes the
count the API just published — no hardcoded number anywhere — runs the real `assignPlants` the console
commits through, and asserts the write moved exactly that many with nothing changing in between. It
then asserts the negative that gives the positive meaning: the `VERIFICATION_PENDING` and deferred
tickets at the same plant are still `UNASSIGNED`. A write that simply assigned everything would pass
the first assertion and fail this one.

## Two structural facts found by reading the schema

**A plant has no company.** `plants` carries no `company_id` — several companies' fleets sit at one
site. So the tree groups by the **ticket's** company, and the same plant legitimately appears under
more than one with its own count and its own device denominator.

**But the write is plant-shaped, and the two disagree.** `assignPlants` takes plant ids and moves *all*
of a plant's assignable work regardless of which company's row was ticked. Drafting UltraTech's 4
devices at a shared site commits Acme's 6 as well. A draft that counted only the ticked row would
under-report its own commit — R3's failure reappearing one layer up. So the ledger counts the **whole
plant** once any of its company rows is drafted, and the row says so on screen: *"serves 2 companies —
all of its unassigned work moves together."* Pinned by test. It disappears with #275's ticket-level
`assign-batch`; until then the honest move is to count what the button does and name it.

## Acting-zone, honoured here rather than deferred

Every sibling read on this controller builds its scope from the JWT claims, which structurally cannot
carry acting (#239 owns the sweep, and explicitly says *decide per surface, don't sweep*). On a
dashboard, ignoring it is a wrong number. On a console whose entire purpose is *what is left in **this**
zone, and who takes it*, it is an operator about to hand out another zone's work — so this surface
honours it from the start.

Done **without depending on #239's uncommitted work**: the collapse is inline in the controller from
the already-committed `RequestActor`, and `api/assignWork.ts` uses the committed shared `authHeaders()`
rather than `api/schedules.ts`' local bearer-only builder — both halves land together, which #239's own
text names as the condition for the change being visible at all. When #239 sweeps `/schedules`, its
`@CurrentScope()` helper replaces the inline expression as a one-line no-op; the behaviour is
deliberately identical.

## Slices (red → green)

| # | Seam | Red produced |
|---|---|---|
| B1 | `GET /api/schedules/assignable-work` | `400` — the `:engineerId` route captured it |
| B2 | read-predicts-write, via the real `assignPlants` | the AC that matters |
| B3 | held work excluded, counted, plant still listed | — |
| B4 | ZM clamp · OH pan-India · acting-OH collapsed | — |
| A1 | pool rows: `12 / 38`, crit, held, oldest-silent | 5 reds |
| A2 | ledger arithmetic, incl. the shared-plant case | 2 reds |
| A3 | per-lane commit + independence | 1 red |
| A4 | top-bar → `/assign` | 1 red |

Two traps worth recording:

- **A `*/` hid inside a docblock.** `**R1**/**R3**` contains the sequence `*` `*` `/` — the comment
  terminated early and the file failed to parse with errors pointing at the prose. Same class as the
  handoff's backticks-in-`Prisma.sql` note: a content character that closes the construct around it.
- **`inactivity_hours` is a nullable `Decimal`, not a number.** `Math.max` on a Prisma `Decimal`
  yields `NaN`, which would have silently poisoned the oldest-silent figure for every row at a plant.
  Converted explicitly and guarded with `Number.isFinite`; null stays null, because a device whose
  state was never recomputed must not read as "just now" on the row that most needs attention.

## Deliberate scope calls

- **Selection is plant-shaped in S1** — operator-ruled. `assignPlants` takes no ticket subset, so the
  design's `×3 crit` sub-plant chips wait for #275. The alternative considered and rejected: N
  un-transactioned `POST /schedules/assign` calls per lane, which builds a write path #275 deletes and
  leaves a half-assigned lane on partial failure.
- **The candidates column states which slice owns it** rather than sitting blank. #274 carries ordered
  candidates, dropped ones with their reason, and coverage per (engineer, plant).
- **The console opens with one empty lane.** No lane meant a pool you could tick with nowhere to put
  it — a dead end on the first screen.
- **Commit uses the existing `assignPlants`, per the issue.** The per-lane result shape is already what
  `assign-batch` will return, so #275's swap is behind one function.

## Verification

- Backend `tsc` clean; admin `tsc` clean.
- **Full admin suite: 103 files, 532 passed / 0 failed.** The one unhandled render error
  (`TicketDetailDrawer.tsx:440`) is the same pre-existing one recorded under #269 — it reproduces with
  its own spec run alone and neither that file nor its test is modified in the tree.
- Targeted backend regression over the predicate's blast radius before the full run: 9 files, 52/52
  (`issue-122b-fleet-assign`, `deferral-override-confirm`, `critical-assign`, both dispatch-transparency
  specs, `override-defer-leaves-today`, `zone-scope`, plus #269's and this slice's own).
- **Full backend suite: 391 files passed / 3 skipped (394), 1928 passed / 0 failed / 5 skipped,
  exit 0**, clean on the first attempt with no #184 worker crash. This is the **second** full run — the
  first is why (below); it measured 1923 passed / 9 skipped and lost one unrelated file to a
  `Worker exited unexpectedly` that the harness re-ran 6/6 (`#184 AC-4: recovered — all 394 files
  accounted for after 2 attempts`). The +5 passed / −4 skipped between the two runs is exactly the
  repaired spec, which is the point of re-running rather than reporting a figure that no longer
  matched the tree.

### The first full run caught a regression the targeted run could not

`schedules-route-conflicts.e2e-spec.ts` hand-constructs `SchedulesController` with an explicit provider
list. Adding `AssignableWorkQueryService` to the constructor without adding a stub there made its
`beforeAll` throw — and **vitest reports that as `4 skipped`, not as a failure**. The suite exited 0
with the file contributing **zero coverage**, and the file it silenced is the one that pins route
ordering against `GET :engineerId` — the exact trap this slice had already fallen into once (the new
route 400'd from `ParseUUIDPipe` before it was moved above the param route).

This is the failure mode #255's INDEX note describes, reached from a different direction. The tell in
the output is `❯ <file> (N tests | N skipped)` — a `❯` marker with everything skipped, sitting among
the `✓` lines. Fixed by stubbing the new dependency **and** by adding the missing route-ordering
assertion for `assignable-work`, so the ordering is now a property of the suite rather than of whoever
edits the controller next. That file is 5/5.

**Worth carrying forward:** a constructor change to a controller that any spec builds by hand is
silently uncovered, not loudly broken. `grep -rln "controllers: \[SchedulesController\]" test/`
finds them; only this one exists today.

## Not done here

- Ticket-level chips, the transactional write, Distribute, and the orphaned surfaces — #275, #276, #277.
- The work-type and Critical+ **filter chips** on the pool. The counts they would filter are per plant,
  and with plant-shaped selection a Critical+ filter would change which rows are *visible* without
  changing what a commit moves — a control that looks like it narrows the write and does not. It
  belongs with #275's ticket-level selection, where it can mean what it appears to mean.
