# #284 + #285 — the today read layer and the Today's Dispatch cockpit · completion report

**Landed 2026-08-25.** Owning decision: [#282](../../.scratch/fsm-platform-v1/issues/282-decision-todays-dispatch-crew-deck.md) R1/R5/R6.
Design: [`docs/ui/desktop/approved-designs/todays-dispatch-crew-deck.html`](../ui/desktop/approved-designs/todays-dispatch-crew-deck.html).

## #284 — the read layer

Three reads that did not exist, each assembled from services that already did. **Nothing here
computes a scheduling decision.**

- **`GET /dispatch/today?zoneId=`** (`DispatchTodayQueryService`) — the operating day, the zone, the
  run that produced it, one lane per engineer with ordered stops and per-ticket provenance, the
  situation counters, and the three rails.
- **`GET /dispatch/changes-today?zoneId=`** (`DispatchChangesTodayService`) — adds, removes and
  swaps, IST-day-bounded and zone-scoped.
- Both on `DispatchTodayController`, `@CurrentScope()`-scoped so acting-zone works and a ZM cannot
  widen past their own zone.

### Two things the read had to get right that the existing ones do not

**It is scoped to the operating day.** `ZmScheduleQueryService.listSchedules` filters on live status
alone with no date predicate, so `/schedules` returns stale never-closed plans beside today's while
its nav row, its page copy and `DispatchTimelineNote` all promise "today". The cockpit applies
`dateFrom <= day <= dateTo` — the rule `DayPlanQueryService` already uses for the SE-facing read —
and a test pins that a week-old ACTIVE plan is absent.

**An engineer with no plan is a row.** An empty lane is how an operator sees who is free; omitting
it would make the deck answer a different question than the one it is for.

### Capacity has one definition

`committedDayPlan` in a single batched query for the whole zone — the same function the engine
enforces against (#269 / #272 R9). Over-capacity uses `>=`, matching the engine's own
`OVER_CAPACITY` filter, so the badge cannot disagree with the rule it mirrors.

### Policy-withheld is a count, and says so

The payload carries `{ count, itemised: false }`. The engine counts this work and never itemises it
— those tickets get no recommendation, no row and no trace — so there is nothing to list. Publishing
a fabricated list, or a count that looks like a truncated one, is what #282 R6 forbids.

## #285 — the cockpit

`/dispatch/today`, three modes over one layout, `MANAGER_ROLES`, mode reflected in the URL.

- **Live** — the crew deck (one card per engineer: tier, load as a shape, ordered stop chips,
  availability, over-capacity treatment), the critical interception strip fed by
  `ESCALATION_REQUIRED`, and the work rail (unassignable with reasons, held with return dates,
  policy-withheld as a labelled count, changes today).
- **Plan** and **Replay** deliberately compose rather than rebuild: Plan links to the Scheduler
  Preview that already owns the projection (#250/#251) and to Run dispatch; Replay links to the run
  ledger and DecisionTrace that already own the history. #282 R5 forbids a second implementation of
  either.

### The provenance grammar, and its one hard rule

Rendered from #283's data: solid + dot = system, dashed = human, dashed violet = a human crossed a
coverage tier, heavy crimson = critical direct-assigned, `RET` = vehicle due back. A new
`--color-tier-cross` token was added in both themes rather than reusing `--color-verified`: the two
mean unrelated things and a shared value would couple them silently.

**Unknown provenance renders as unknown.** A pre-#283 row gets the dotted treatment and a tooltip
saying so — never the solid system treatment. That is the one direction the grammar must not fail in,
and it has its own test.

### No fake data

Every counter traces to a payload field. The wireframe's "42 placed · 3 unassignable" are example
values and a test asserts the rendered numbers come from the response.

## Navigation

`Today's Dispatch` leads the Dispatch cluster; Preview, Schedules, Intra-day and Dispatch Runs remain
beneath it as supporting and historical surfaces. **Nothing was deleted.** #281's grouping, hints and
cross-links are what the cockpit sits on.

`#281`'s nav test was amended, not weakened: its assertions about the four surfaces' routes, order,
hints and role gating all still run, and #280 R9 (Intra-day subordinate to Schedules) is still
pinned. The amendment is recorded in the test's own docblock, including why #280 R8 no longer binds.

## Tests

- `test/dispatch-today-read.e2e-spec.ts` (6) — operating day, stale-plan exclusion, empty lane,
  persisted order + provenance + no-fabricated-time, capacity parity, zone clamp.
- `test/dispatch-changes-today.e2e-spec.ts` (5) — the override the Intra-day Queue cannot see, swap
  counted once, assign-then-move as two decisions, day bounding, and the engine's own dispatch not
  counting as changes.
- `apps/admin/test/todays-dispatch.test.tsx` (8) — lanes, empty lane, system vs human chips, unknown
  provenance, interception strip, policy-withheld wording, counters from payload, error state.

Full admin suite: 110 files / 613 tests green.

## Deferred, deliberately

The run-level decision stream (`GET /dispatch-runs/:runId/decisions`) and the `?date=` filter on
`/schedules` are specified in #284 and not yet built; Replay currently links to the existing ledger
and per-ticket trace, which is honest but thinner than the design's decision stream.
