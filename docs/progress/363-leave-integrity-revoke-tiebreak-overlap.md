# 363 — Leave integrity: revoke, tie-break, overlap guard

**Done 2026-09-03.** Wave 4 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids ENG-G4 and ENG-G6. Red-first.
Depends on #343 (the leave audit writers this slice's `LEAVE_REVOKED` row sits beside), closed
earlier the same day.

## What it closes

Three defects with one consequence: an engineer on the board who is not available, or off it when
they are — and the dispatcher finds out when the SE does not turn up.

1. **The correction lost.** `se_availability` is append-only: a manager who gets a day wrong writes a
   new window over the same range rather than editing the old one. All three reads ordered on
   `windowStart desc` with no secondary key, so those two rows tied and the database chose. It chose
   the **older** row — reproducibly, on this box, red before the fix — so `currentStatus` and
   `currentStatusMany` (the Recommender's hard filter) kept reading the row that had just been
   corrected, while `listWindows` — the query behind the manager's own screen — showed the correction
   on top. The screen and the dispatch decision disagreed, and dispatch won.
2. **Approval was terminal.** No revoke route existed. Leave approved by mistake, or leave the SE
   cancelled, could not be undone: the request stayed APPROVED and — the part that actually costs a
   day — the `se_availability` window it wrote stayed on the board. An engineer standing in the depot
   was invisible to the Recommender for the rest of the window.
3. **The same absence could be filed twice.** `submit` had no overlap query, so duplicate and
   overlapping PENDING windows were accepted and the same day could be approved twice: two
   availability windows, two audit trails, one absence, and a queue in which a manager could not tell
   which row the SE meant.

## The shape of the fix

**One order for every availability read.** `SeAvailabilityService.LATEST_FIRST` =
`[{windowStart:'desc'},{id:'desc'}]`, used by `currentStatus`, `currentStatusMany` and `listWindows`.
`id` is the write order, so "the latest write for the day wins" now means one thing across the
service instead of three.

**Revoke writes an `AVAILABLE` window over exactly the leave's range** rather than deleting the leave
window — and that is what makes AC2 fall out of AC1 rather than needing machinery of its own: same
start instant, later id, so the tie-break hands the day back and the very next `runForZone` books the
engineer. Nothing is reassigned; giving the day back is the decision, redistributing it stays the
ZM's (#282 R4).

**The overlap guard is on live rows only** — PENDING (awaiting a decision) and APPROVED-not-revoked
(holding a window). Half-open intervals, so `[10,12)` and `[12,14)` touch without colliding, matching
the active-window predicate and #204's IST day bounds. A REJECTED request holds no day: blocking on
it would refuse the very revision the SE was asked to make.

## Decisions worth keeping

**1. `REVOKED` is derived, not stored — because the schema was not mine to change.**
`leave_request_status` has three members and #357 owns `schema.prisma` this round, so adding a fourth
was out. The row stays `APPROVED` and carries the revocation in `decision_reason` (the same column a
rejection uses, under the same mandatory-reason rule); `isRevoked()` is the single predicate, and
`toRow()` maps it to `'REVOKED'` for **every** reader — the ZM queue, `/me/leave-requests`, the mobile
list. `LeaveRequestRow.status` is already `string` in `@fsm/shared` and the mobile label helper
word-splits whatever it is given, so nothing needed a type change.

The alternative — leaving the row reading `APPROVED` after a revoke — was rejected outright: it
recreates this issue's own defect, a screen that disagrees with the board. Adding `REVOKED` to the
enum is filed as a follow-up; it is a display-layer change when it lands, not a behavioural one.

**2. Revoke takes `(id, reason, actor)`, not the plan's `(id, actor, reason)`.** `reject` — the other
mandatory-reason decision on this service — already reads that way. Two sibling methods that take the
same three things in different orders is a bug waiting for a call site.

**3. 409, not 400, for an overlap, and it names the row.** The submit is well-formed; it is the SE's
own diary that refuses it. `conflictId` names the request holding the day so the manager can open it
instead of guessing which of two identical-looking rows the SE meant.

**4. `mapOutcome` takes the invalid-state code.** Approve/reject want a PENDING request; revoke wants
an APPROVED one. Reusing `LEAVE_NOT_PENDING` for a revoke would tell a manager the request "is not
pending" when the problem is precisely that it is not *approved*.

**5. The admin page gained "File leave for an engineer".** The overlap error state the AC asks for had
nowhere to happen: the page has no submit, so a 409 was unreachable from the admin app and the error
copy would have been dead code. `POST /leave-requests` has always accepted an own-zone ZM filing on
behalf of an SE (the phone call a ZM takes when an engineer cannot use the app) and no admin surface
reached it — the surfacing rule says build it, since it consumes an endpoint already in this repo.
ZM/CSM only; Operations Head still sees the read-only table.

**6. Overlap refusals are not audited.** `audit_log` records actions taken; a refused submit mutates
nothing and would let anyone fill the ledger by retrying a form. AC4 is met by the writes: approve and
reject (#343) and now `LEAVE_REVOKED`, plus the `SE_AVAILABILITY_SET` row the revoke's window write
produces.

## Where the issue's premise was wrong

- **The admin leave client is `apps/admin/src/api/leaveRequests.ts`**, not `api/engineers.ts` as the
  issue and plan §4 both say. The revoke client went where the rest of the leave surface lives;
  `api/engineers.ts` was **not edited** (the page reuses its existing `apiEngineers()` for the SE
  picker).
- The cited line numbers were close enough — `se-availability.service.ts` had the un-tie-broken
  `orderBy` in all **three** reads (the issue names two), and `listWindows` is the one whose result
  the manager actually sees.
- Everything else in the premise held, including the direction of the tie: the older row won.

## What was tested, and why in that shape

The tie-break is asserted through **all three reads at once** on a dedicated engineer
(`se-availability-service`), because the defect was not "a query is wrong" but "two queries disagree";
one of them was always right.

AC2 is proven through a real `runForZone` in `recommender-availability`, not by reading
`currentStatus`. "The day is back" only means something if the next run books it — and that spec now
also pins the tie-break from the other side: the case that follows writes an `ON_LEAVE` window with
the same start instant as the revoke's `AVAILABLE` one and still excludes the SE, because it is later.

The overlap guard is asserted on the boundary as well as the hit: an overlapping window and an
identical window are refused, an adjacent end-exclusive window is not, and the existing
reject-then-resubmit case (same window, deliberately) proves a rejected request never blocks the
revision it asked for.

**Both leave specs had to be rewritten to file one window per case.** They shared a single window
across every test, which is exactly the state the guard refuses. That is not test noise — it is the
first thing the guard caught. While there, both now clean up the audit rows #343 leaves behind, which
they were leaking into `audit_log`.

## Acceptance criteria

- [x] **AC1** — the latest write for a day wins, in both the availability reads and the recommender.
  `se-availability-service` (all three reads); `recommender-availability` (the ON_LEAVE case now sits
  behind an AVAILABLE row with the same start).
- [x] **AC2** — revoke returns the day to the recommender within one run. `recommender-availability`:
  approve → `UNASSIGNABLE`, revoke → next `runForZone` → `SUGGESTED` to the same SE.
- [x] **AC3** — an overlapping submit → 409 `OVERLAP` (with `conflictId`).
  `leave-request-service` + `leave-request-controller`.
- [x] **AC4** — all of the above are audited. `LEAVE_REVOKED` keyed on the request, written **inside**
  the mutation's transaction via `withAudit` (#343's shape), carrying both the superseded and the new
  availability id.
- [x] **UI** — Revoke with a mandatory reason on APPROVED rows, a `REVOKED` state, and the overlap
  error state on a surface that can actually produce it. `apps/admin/test/leave-requests.test.tsx`.

## Tests, verbatim

Backend (through `.scratch/locks/backend-test.sh`):

```
 ✓ test/leave-request-controller.e2e-spec.ts (10 tests) 1414ms
 ✓ test/leave-request-service.e2e-spec.ts (9 tests) 564ms
 ✓ test/recommender-availability.e2e-spec.ts (3 tests) 834ms
 ✓ test/se-availability-service.e2e-spec.ts (5 tests) 530ms

 Test Files  4 passed (4)
      Tests  27 passed (27)
```

The red that started it (before the tie-break landed):

```
 × #363 AC1 — with two windows on the same day the latest write wins in currentStatus,
   currentStatusMany and listWindows
   → expected 'ON_LEAVE' to be 'AVAILABLE'
```

Regression sweep of the availability/leave neighbours, including the acting-scope route sweep over
the new revoke door:

```
 ✓ test/se-unavailable-stranded-work.e2e-spec.ts (9 tests)
 ✓ test/acting-scope-route-sweep.spec.ts (6 tests)
 ✓ test/engineers-availability-controller.e2e-spec.ts (17 tests)
 ✓ test/override-defer-leaves-today.e2e-spec.ts (6 tests)
 ✓ test/available-ses-candidate-shape.e2e-spec.ts (3 tests)
 ✓ test/me-availability-controller.e2e-spec.ts (4 tests)
 ✓ test/me-leave-requests-controller.e2e-spec.ts (3 tests)
 ✓ test/se-availability-schema.e2e-spec.ts (3 tests)
 ✓ test/soft-unavailable.e2e-spec.ts (1 test)

 Test Files  9 passed (9)
      Tests  52 passed (52)
```

Admin (`cd apps/admin && npx vitest run`):

```
 ✓ test/leave-requests.test.tsx (8 tests) 2286ms
 ✓ test/acting-header-builder.test.ts (3 tests)
 ✓ test/leave-window-display.test.ts (6 tests)
```

`npx tsc --noEmit` (backend) and `npx tsc -b` (admin) are both clean.

## Follow-ups this slice does not own

1. **`REVOKED` as a `leave_request_status` member** (schema; #357 owns `schema.prisma` this round).
   One enum value + a migration; `isRevoked()` and `toRow()` become a column read, and the derived
   mapping can be deleted. No behaviour changes.
2. **`dispatch-today-query.service.ts:725` (`availabilityBySe`) has the same un-tie-broken
   `orderBy: {windowStart:'desc'}`** and its own copy of the first-row-wins loop — the Cockpit strip
   can still show the superseded status. Not edited: the file belongs to another slice's owner set
   this round. The fix is one line, and the deeper fix is that the read should call
   `SeAvailabilityService.currentStatusMany` rather than keep a second copy of it.
3. **A revoke does not notify the SE.** The approve/reject decision notification is the Issue 03 seam
   and revoke sits in the same gap — an SE whose approved leave is revoked currently learns it from
   their day plan.
