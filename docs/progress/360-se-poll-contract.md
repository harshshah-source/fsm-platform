# 360 — SE poll contract: paginated tickets, VU-deferred visibility, readable day-plan notices

**Done 2026-09-03.** Wave 3 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids TKT-11, TKT-12, SCH-09 and
closing the **tickets leg of #165** (the shared-pool and day-plan bounding legs stay on #165).
Red-first. No dependencies.

## What it closes

`GET /api/me/tickets` is the contract a field engineer's phone polls all day, from a plant yard, on
whatever connection that yard has. Three things were wrong with it, and all three cost the SE
something they then phoned somebody about.

1. **It was unpaginated.** The whole covered set came back on every poll — 521 rows on the dev DB.
   The largest payload in the system, landing on the worst network in it, on a timer.
2. **A ticket the SE filed vehicle unavailability on disappeared from their own list.** Filing sets
   `assignment_state = UNASSIGNED` + `deferred_until` (`vehicle-unavailability.service.ts`), and the
   pool branch's `notDeferredOn` then excluded it. The engineer who *personally reported the absence*
   watched the ticket vanish, concluded the platform had lost it, and rang the dispatcher to ask.
3. **The day-plan notice body was `` `Your Day Plan was updated (${action}).` ``** — a raw audit-action
   enum (`REMOVE_TICKET`, `ASSIGN_BATCH_COMMIT`) on a field engineer's lock screen. A notice nobody
   can act on teaches them that none of these notices are worth opening, and the day-plan channel is
   the only one dispatch has.

**The issue's premise checked out in full.** Every cited `file:line` matched the working tree
(`me-tickets-query.service.ts:72-96` unpaginated, `:81` `notDeferredOn`, `day-plan-notifier.ts:75`
the enum body, `day-plan-notification-outbox.ts:54` the noun-less payload). Nothing was refuted.

## The shape of the fix

### Paging (AC1, AC4)

`GET /me/tickets?take=&cursor=&section=` → `{ items, cursor, total }`.

- **Keyset, not offset.** The read is ordered `[plantId asc, createdAt asc, ticketId asc]` and the
  cursor is an opaque base64url of exactly that triple, resumed with a spelled-out row comparison
  (`afterKey`). An SE's pool changes under them between polls; `skip`/`take` would silently drop or
  repeat rows across pages precisely when the day is busiest.
- `ticketId` is in the sort key **only** to make the order total. Without it, two tickets created in
  the same millisecond at the same plant have no defined order between pages and a keyset cursor
  either skips one or repeats it — silently, and only under load.
- `take + 1` is fetched: the extra row's presence is what distinguishes "last page" from "there is
  more", so `cursor` is null exactly when the walk is done and no second count is needed.
- `total` is a separate `count()` over the same predicate. Deriving it from the page would make it
  lie on every page but the last, and it is what the screen's "N open tickets" header shows.

### The VU branch (AC2)

A fifth `MeTicketWorkState`, `VEHICLE_UNAVAILABLE`, plus a `vehicleUnavailability` object on the row
(`reportId`, `status`, `expectedFrom`, `expectedTo`, `reasonCode`; dates as IST `YYYY-MM-DD`). Tickets
carrying the **caller's own** OPEN `VehicleUnavailabilityReport` join the visibility `OR`, and the
work state takes precedence over the other four.

### Readable notices (AC3)

`dayPlanOverriddenBody` is now a closed action → sentence map with a nameless fallback, and the nouns
it needs are resolved **at enqueue, inside the producing transaction**, by
`queueDayPlanOverridden` itself.

## Decisions worth keeping

**1. Resolve the notice's nouns at the outbox writer, not at the seven producers and not at drain.**
The plan offered both. Enqueue-time wins for the reason #345 already established for `plantName`: the
row has to say what the stop was called *when the plan changed*, and a rename or master-sync between
the enqueue and the drain would otherwise rewrite history in the notice the engineer finally reads.
#360 extends the same rule to the ticket label. Doing it inside `queueDayPlanOverridden` rather than
at its call sites is the other half: every caller already computes the `batchId`, and the plant is one
primary-key hop from it, so pushing the lookup outward would have been seven chances to forget it — on
a payload whose entire job is to be complete enough to write a sentence from. `plant-deactivation`
still supplies its own `plantName` (#345) and still wins: it deactivated the plant, so it is the better
authority on what to call it.

**2. A missing batch or ticket yields `null`, never a throw.** The resolution runs inside a
committed-or-not override transaction. A notice that cannot be fully worded is never a reason to roll
back the plan change it announces, and `dayPlanOverriddenBody` has a nameless form for exactly this.

**3. The fallback deliberately does not interpolate the action.** The enum leak *is* the defect. A
fallback that printed `event.action` would let the next new action walk straight back through the hole
this slice closed, quietly, on the day somebody added it.

**4. #345's argument for keeping ZM overrides generic no longer holds, so it was retired.** #345 kept
`Your Day Plan was updated (ACTION)` for ZM actions on the grounds that "the manager who made the
change is the SE's own manager, usually mid-conversation, and the action word is the whole content."
That is true of a ZM leaning over a desk. It is not true of the intra-day queue, the assign-batch lane,
`CRITICAL_ASSIGN`, or a plan changed while the SE was under a truck. All of them now name the stop.
The raw action survives in `metadata` — the operator's audit trail is not the engineer's sentence.

**5. `section` is a database predicate, not a post-filter.** The obvious implementation — fetch the
page, derive `workState`, drop non-matching rows — pages over the *unfiltered* set and hands back
short, arbitrarily-sized pages: ask for 50 "Verify" rows, get 3, with no way to tell that from "there
are only 3". Every distinction `workStateFor` makes is already available here as an id set, so the
filter and the derived state are two spellings of one rule and the
`VEHICLE_UNAVAILABLE > VERIFY > IN_WORK > PLAN > VISIT_NOW` precedence is kept identical in both.

**6. `section` vocabulary is `MeTicketWorkState | 'ALL'`, not a second parallel set.** The mobile
Tickets screen's chips (`docs/ui/mobile/tickets-priority-view.png`: All / Visit Now / Plan / In Work /
Verify) filter exactly what the row glyph shows. Two vocabularies for one control is how they drift.

**7. Junk `take`/`section` degrade; a junk `cursor` 400s.** The first two follow the `work-history`
posture — a query value arrives as an unvalidated string and an engineer standing in a yard should get
a default screen, not an error. `cursor` is the exception: it is opaque and only ever comes from a
previous response, so a malformed one is a caller bug, and "silently start again" would loop a polling
client forever over page one — *worse* than the unpaginated read this slice replaced.

**8. `take` is clamped to 200.** Present so that "give me everything" stops being expressible from the
client side. Without a ceiling the defect this slice closes is one `?take=100000` away from returning.

**9. The direct-assignment id set is read only for the two sections that need it.** `assignedSeId` has
no status bound (nor does the visibility branch that has always used it), so that set grows with the
engineer's career rather than with their day. `PLAN` and `VISIT_NOW` need it as a `notIn`; the default
read — the one the phone actually polls — never issues the query. It is materialised as an id set
rather than expressed as `NOT (assigned_se_id = $1)` because that predicate drops every NULL row, which
is almost all of them.

**10. The VU branch is scoped to the caller's own reports.** It is a compensation for *the SE's own*
filing — another engineer's report is not something this engineer reported on, and resurrecting a
deferred ticket for everybody would undo the deferral itself. A resolved/superseded report releases the
row back to its ordinary state.

## What was tested, and why in that shape

**Paging is tested as a walk, not as a page.** The load-bearing property is not "a page has ≤ N rows"
— it is that walking the cursor to exhaustion visits every row **exactly once, in the same order** as
one big read. That single test catches the skip, the repeat, the wrong comparison operator and the
cursor that never terminates (guarded with an explicit page cap, since a non-terminating cursor
otherwise hangs rather than fails).

**The notice wording is tested over the whole action vocabulary, twice.** `it.each` runs every action
a producer emits today, in both its named and nameless forms, against a SCREAMING_SNAKE regex. A
per-action string assertion would pin today's copy and say nothing about the action somebody adds next
month; the regex is the actual invariant — *no enum reaches an engineer* — and it fails for a new
action that forgets its sentence.

**The VU read is tested on a shared-pool ticket with no batch row.** The PRD:510 removed-today branch
already keeps a VU-deferred ticket visible *on the day it was filed*, so a fixture with a batch row
would have passed before this slice and proved nothing. No batch row, deferral in the future: invisible
before, visible after.

**The VU fixture writes the report through Prisma rather than the filing endpoint.** The filing path is
already pinned end-to-end by `vu-deferral-wiring.e2e-spec.ts`, and `vehicle-unavailability.service.ts`
was owned by another agent this round; what this file owns is the **read**.

**The enqueue resolution is tested through the real outbox writer against real rows** (a batch whose
plant has a name, a ticket whose label is derived), including the two degenerate cases: a producer that
supplies its own `plantName`, and a `batchId` that no longer exists.

## Acceptance criteria

- [x] **AC1** — `GET /me/tickets` is paged, cursor-stable, default 50, and returns `total`.
- [x] **AC2** — an SE who filed vehicle unavailability still sees the ticket, with its state and
      return date (`workState: 'VEHICLE_UNAVAILABLE'` + `vehicleUnavailability.expectedFrom/To`).
- [x] **AC3** — day-plan notices read "Stop added: <plant> (<ticket ref>)" and similar; no enum leaks,
      including for an action nobody has written a sentence for yet.
- [x] **AC4** — unpaginated callers keep working via the defaults (the mobile client's
      `apiGetMyTickets` is unchanged; every pre-existing `me-tickets` e2e passes untouched).

## Tests, verbatim

```
apps/backend
  test/me-tickets-controller.e2e-spec.ts        17 passed  (6 pre-existing + 6 new #360 paging)
  test/me-tickets-removal-metadata.e2e-spec.ts   9 passed  (4 pre-existing + 5 new #360 VU)
  test/day-plan-notifier-spine.e2e-spec.ts      15 passed  (1 rewritten + 13 new #360 wording)
  test/day-plan-notification-outbox.e2e-spec.ts 10 passed  (7 pre-existing + 3 new #360 enqueue)
  → Test Files 4 passed (4) · Tests 51 passed (51)

regression sweep over everything that touches the changed contracts:
  day-plan-notification-outbox-writers, schedule-closure-recycling, batch-override-remove,
  plant-deactivation, intraday-ledger-atomicity, notification-outbox-generic,
  batch-dispatch-notify, vu-deferral-wiring, me-ticket-detail-controller
  → Test Files 9 passed (9) · Tests 67 passed (67)

apps/mobile
  npx jest src/navigation/screens/TicketsScreen.test.tsx  → 14 passed
  (HomeScreen, home/, api/client → 96 passed in the same run)

typecheck
  apps/backend  npx tsc --noEmit  → clean of #360 errors
  apps/mobile   npx tsc --noEmit  → clean
  apps/admin    npx tsc -b        → clean of #360 errors (admin does not consume MeTicketsView)
```

## Follow-ups this slice does not own

- **The mobile Tickets screen does not use the new contract yet.** It still fetches one page and
  filters client-side, and does not render `VEHICLE_UNAVAILABLE` rows as their own section, show
  `total`, or follow `cursor`. Plan §4 scopes #360 to the backend contract ("the mobile list that
  renders it is out of scope"), and the endpoint is fully backward-compatible, so nothing regressed —
  but the *user-visible* half of AC2 lands only when the screen renders it. Filed as a follow-up for
  the mobile-surfacing wave, not deferred silently: the app shell exists and the work is real.
- **`SWAP_SE` and `moveTickets` still enqueue without a `ticketId`.** Both are batch-level in their
  producer, so their notices name the plant but not a ticket ref. The payload accepts one the moment a
  producer has it.
- **#165 keeps its shared-pool and day-plan bounding legs**; only the `/me/tickets` paging leg closes
  here.
