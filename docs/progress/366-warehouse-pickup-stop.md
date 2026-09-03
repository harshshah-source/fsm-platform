# 366 — Zone Warehouse pickup stop on the Day Plan

**Done 2026-09-04.** Wave 5 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey id SCH-03. Red-first. Depends on
#352 (the component-request wire contract these rows are derived from) and on the design stop, which
the operator cleared on 2026-09-03 — decision record
`.scratch/fsm-platform-v1/issues/369-decision-warehouse-pickup-stop.md`, approved design
`docs/ui/desktop/approved-designs/warehouse-pickup-stop.html`.

## What it closes

An SE whose part had been shipped to the zone warehouse had no warehouse stop on their day plan.
`DayPlanStop` had no stop kind, and `day-plan-query.service.ts`'s own docblock deferred the pickup
step ("needs component data from Issues 21/22 and is added when that lands" — that data landed in
#352). The engineer either drove to the plant without the part and could not do the job, or found
out informally and improvised a detour nobody planned. The day plan is supposed to be the whole day.

The pickup is now stop 0 on both reads of a day plan: the SE's own (`GET /api/schedules/me`) and the
manager's schedule detail (`GET /api/schedules/:engineerId`, rendered on `ScheduleDetailPage`).

## Where the premise was wrong — no schema change was needed, and that is the better answer

Plan §4 and the issue file both ask for a **"pickup flag/row on the schedule + migration"**, and the
round brief reserved `schema.prisma` to this slice alone for that reason. **`schema.prisma` is
untouched, no migration was written, and `npx prisma generate` was not run** — which also means the
four concurrent agents' generated client never moved under them.

The reason is the approved design's own rule: *"Stop 0 appears only when it is real."* **Real is
present tense.** A flag stamped on the schedule at dispatch would be wrong within hours in both
directions:

- a part shipped at 10:00, after the 04:00 dispatch, must appear on the plan — a dispatch-time flag
  never would;
- the moment the SE confirms receipt, the stop must disappear, because there is nothing left to
  collect — a stamped flag would keep sending them to the warehouse.

Everything the stop needs already exists and is already live: `component_request.status = 'SHIPPED'`
**is** "shipped and not yet received" (the lifecycle is REQUESTED → APPROVED | REJECTED → SHIPPED →
RECEIVED, so confirming receipt moves the row out of SHIPPED rather than setting a second field);
the parts come from `component_request` joined to `component_master`; and the warehouse is named
from the schedule's zone, because `zone_warehouse_stock` is keyed by zone alone and there is no
warehouse entity to read. A stored flag would have been a denormalisation of a query that is one
indexed lookup, bought at the price of being wrong.

`batch-assignment.service.ts` therefore emits nothing new, and its class docblock now says so and
why, so that the next reader who comes from plan §4 looking for a stop-0 write finds the decision
instead of a gap.

## The shape of the fix

`warehouse-pickup.ts` is the one definition of the pickup — deliberately shared by the two reads for
the same reason `liveBatchFilter` and `committedDayLoad` are shared: the dispatcher checking a plan
and the engineer working it must be told the same thing. It takes the plan's **live** ticket ids
(the caller has already applied the hollow-stop and `removedAt` rules) and returns one stop or
`null`.

`DayPlanStop` became a discriminated union in `packages/shared`:

```ts
export type DayPlanStop = DayPlanPlantStop | DayPlanWarehousePickupStop;
```

## Decisions worth keeping

**1. A discriminated `kind`, not a boolean — and the mobile compile error is the feature working.**
The decision record asks for `kind: 'PLANT' | 'WAREHOUSE_PICKUP'` because the two shapes genuinely
differ: a pickup has parts and no tickets, no device count and no SLA. Making it a union broke
`HomeScreen.tsx`, which read `stops[0].plantName` — exactly the mistake a boolean flag would have
let through silently at runtime. Mobile now narrows to `kind === 'PLANT'` and behaves precisely as it
did (Next Visit is the first *plant*; a warehouse contributes no workload card), which is the right
outcome while mobile rendering is out of scope.

**2. The ZM detail carries `pickup` as its own field, not as a member of `stops`.** On the SE read
the pickup lives in `stops`, because nothing there treats a stop as anything but a stop. On the
manager read `ZmDetailStop` **is a batch** — the Console board, the reorder/remove/reassign/split
controls and the `/batches/:batchId` link all key off `batchId`, and a pickup has none. Putting it in
that array would have handed every override surface a row it cannot act on. It renders at sequence 0
ahead of the plant stops either way, which is what the design pins; the wire shape is an
implementation detail of two different consumers.

**3. No `delivery_destination` filter, and this is a considered default.** The enum is `SE_LOCATION |
PLANT_WAREHOUSE`; neither value names the zone warehouse, because that enum exists to drive
Floating-SE resubmit ownership (ADR-0008), not to say where the SE collects. Filtering on it would
have made the feature dead for every request ever written. The AC's wording is unconditional —
"SHIPPED-not-RECEIVED component requests" — so that is the rule implemented. If the product later
wants a genuine pickup-location distinction, that is a new enum value and a new decision, not a
filter that can be quietly added here.

**4. `REQ-1a2b3c4d` is a client-side truncation, not a new column.** `component_request` has no
human-readable reference; `tracking_ref` is the shipment's, recorded at SHIPPED. The page truncates
the request id the way it already truncates ticket and engineer ids, and the tracking reference
rides in the row's `title` rather than taking a column that would push the part names off the line.
Nothing invented on the wire.

**5. `×1` per part is true, not decoration.** One component request is for one component, so the
quantity is structurally 1. It is rendered because the design shows it and because it separates the
segments of the parts line; it is not a field on the wire pretending to vary.

**6. Violet by Tailwind scale with explicit `dark:` variants, not the `tier-cross` token.** The
design specifies violet, reasoning that crimson is already spent on critical and amber on
over-capacity, so a pickup — neither urgent nor wrong — gets its own hue. The admin's existing violet
token is `--color-tier-cross`, whose meaning in the approved grammar is *"a human crossed a coverage
tier"* (#290); reusing it would be exactly the one-colour-two-meanings mistake #290 exists to
prevent, and adding a new token means editing the shared `index.css` under four concurrent agents.
The row therefore uses `violet-500/50` with `dark:` counterparts, following the existing raw-violet
precedent in `ticketBadges.tsx` and `DeviceDetailPage.tsx`. The **`Pickup` tag carries the meaning in
text**, so the row survives grayscale, colour-blind rendering and a screen reader without the hue.

## What was tested, and why in that shape

**One backend fixture, four assertions, because they are one fact.** The pickup test builds a real
dispatched two-plant plan and then writes three component requests in three deliberately different
states: two SHIPPED on two *different* tickets, and one already RECEIVED. That is the smallest
fixture in which the three rules the design pins can actually fail independently —

- two SHIPPED on two tickets is what makes *"never more than one, however many parts are waiting"* a
  real assertion rather than a tautology on a single-part plan;
- the RECEIVED row is the part already in the van: it must not be listed, and only a row in a
  different state can prove the filter is `status = 'SHIPPED'` rather than "any request";
- asserting the plant stops still read `[1, 2]` is what pins *"sequence 0 leaves the numbering
  untouched"* — a pickup that renumbered the day would be a worse bug than no pickup at all.

A second backend test asserts the **absence** case on the existing plan fixture, because "a plan with
no pickup is exactly today's plan" is half the acceptance criterion and is the half a careless
implementation breaks.

On the admin side the ordering assertion is deliberately `compareDocumentPosition` rather than "the
pickup renders": *stop row, not banner* is the whole content of the design decision, and the only
thing that distinguishes them is that the pickup precedes stop 1 in the ordered list. A separate test
asserts the kind tag's **text**, because the design's colour argument explicitly requires the row to
survive without colour.

## Acceptance criteria

- **AC1 — a plan whose tickets have SHIPPED-not-RECEIVED component requests carries exactly one
  pickup stop, first; no pickup stop otherwise; the admin schedule detail shows it.** Met.
  `day-plan-query.e2e-spec.ts` covers exactly one, first, at sequence 0, naming both waiting parts
  and excluding the RECEIVED one, with plant numbering unchanged; and the no-pickup case on a plan
  with no component requests. `schedule-pickup-stop.test.tsx` covers the admin rendering, its
  position ahead of stop 1, the named parts with request references, the text kind tag, and the
  untouched no-pickup page.

## Tests, verbatim

```
$ .scratch/locks/backend-test.sh npx vitest run test/day-plan-query.e2e-spec.ts \
    test/day-plan-date-filter.e2e-spec.ts test/day-plan-notification-counts.e2e-spec.ts \
    test/override-schedule-live.e2e-spec.ts test/override-defer-leaves-today.e2e-spec.ts

 ✓ test/override-schedule-live.e2e-spec.ts (5 tests) 3315ms
 ✓ test/day-plan-query.e2e-spec.ts (5 tests) 1436ms
 ✓ test/override-defer-leaves-today.e2e-spec.ts (6 tests) 1236ms
 ✓ test/day-plan-notification-counts.e2e-spec.ts (3 tests) 1220ms
 ✓ test/day-plan-date-filter.e2e-spec.ts (3 tests) 1082ms

 Test Files  5 passed (5)
      Tests  22 passed (22)

$ .scratch/locks/backend-test.sh npx vitest run test/schedules-route-conflicts.e2e-spec.ts

 ✓ test/schedules-route-conflicts.e2e-spec.ts (12 tests) 3785ms
 Test Files  1 passed (1)
      Tests  12 passed (12)

$ cd apps/admin && npx vitest run test/schedule-pickup-stop.test.tsx test/schedule-detail.test.tsx \
    test/schedule-override.test.tsx test/dispatch-cross-view-links.test.tsx \
    test/override-impact-preview.test.tsx

 ✓ test/schedule-pickup-stop.test.tsx (4 tests) 213ms
 ✓ test/schedule-detail.test.tsx (3 tests) 390ms
 ✓ test/dispatch-cross-view-links.test.tsx (6 tests) 309ms
 ✓ test/schedule-override.test.tsx (9 tests) 4472ms
 ✓ test/override-impact-preview.test.tsx (20 tests) 4763ms

 Test Files  5 passed (5)
      Tests  42 passed (42)

$ cd apps/mobile && npx jest src/navigation/screens/HomeScreen.test.tsx
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total

$ cd apps/admin && npx tsc -b                        # clean
$ cd apps/mobile && npx tsc --noEmit -p tsconfig.typecheck.json   # clean
```

`apps/backend` `npx tsc --noEmit` reports four errors, all in files this slice does not touch
(`engineers-query.service.ts`, `intraday-insertion.service.ts`, `notifications/prd-event-notice.ts`,
`recommender.service.ts`) and all belonging to slices running concurrently. Nothing under
`src/scheduling/`.

**Two specs could not be run to completion, for a reason outside this slice.**
`schedules-controller.e2e-spec.ts` and `zm-schedules-controller.e2e-spec.ts` bootstrap the whole
`AppModule` and currently fail at DI with *"Nest can't resolve NotificationService … in
RecommenderModule"* — `src/notifications/prd-event-notice.ts` is a new untracked file from the
concurrent #361. Both should be re-run once that slice lands; neither touches the pickup, but
`zm-schedules-controller` is the HTTP-level cover for the `pickup` field added to `ZmScheduleDetail`.

**The Prisma drift gate was not run** — it cannot run on this box (the local `fsm` role cannot
`CREATE DATABASE`). It is also moot here: `schema.prisma` is unmodified and there is no migration.
`prisma/drift-baseline.txt` was not regenerated.

## Files outside this slice's ownership that it had to touch

Called out explicitly, all additive and minimal:

- `apps/backend/src/scheduling/zm-schedule-query.service.ts` — the admin schedule detail is served by
  `ZmScheduleQueryService`, not `DayPlanQueryService`, so the AC's "the admin schedule detail shows
  it" is unreachable without it. One optional field on the response and one call to the shared
  helper.
- `apps/admin/src/api/schedules.ts` — the client type for that field.
- `apps/mobile/src/navigation/screens/HomeScreen.tsx` and `HomeScreen.test.tsx` — narrowing forced by
  the discriminated union, so the repo still compiles. Behaviour unchanged.

## Follow-ups this slice does not own

- **Mobile rendering of the pickup stop.** Explicitly out of scope per the approved design and the
  decision record — an operator-set scope boundary, not a parity-gate deferral. The contract mobile
  will consume already exists (`DayPlanWarehousePickupStop` in `packages/shared`, already served by
  `GET /api/schedules/me`), and the design says the screen inherits this grammar when it is built —
  a distinct kind, first in the list, parts named — rather than inventing its own. **Nothing in the
  Wave 5 backlog follows to pick this up; it needs filing.**
- **Should the day-plan notification's stop count include the pickup?** It does not today: `stops`
  counts plant stops, which are the SE's actual work, and the count is written at dispatch when the
  pickup may not yet exist. Left deliberately unchanged so #321's "both numbers on one basis"
  invariant is not quietly redefined by this slice. Worth a product ruling if the mobile screen ever
  shows the count beside a list that includes stop 0.
