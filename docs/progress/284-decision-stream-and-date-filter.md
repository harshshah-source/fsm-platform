# #284 §C/§D — the decision stream and the date filter · completion report

**Landed 2026-08-25**, closing the two parts [#284](../../.scratch/fsm-platform-v1/issues/284-dispatch-today-read-layer.md)
left open when §A/§B shipped ([`docs/progress/284-285-dispatch-today-cockpit.md`](./284-285-dispatch-today-cockpit.md)).
Owning decision: [#282](../../.scratch/fsm-platform-v1/issues/282-decision-todays-dispatch-crew-deck.md) R1/R5.

## §C — `GET /dispatch-runs/:runId/decisions`

### What was wrong

Replay had no run-level read. The per-ticket trace answered "why this SE for **this** ticket"; nothing
answered "what did this run decide, and in what order" — though `recommendations.processing_rank` has
persisted exactly that since the ledger existed. So #285's Replay shipped as two links to the ledger:
honest about what it could offer, and not Replay.

### What landed

`DispatchTransparencyQueryService.getRunDecisions` + the route, ordered by `processing_rank`.

**Driven from `dispatch_decision_traces`, not from `recommendations`**, for two reasons. The trace
carries a denormalised `zone_id`, which makes the zone clamp a predicate instead of a join through
ticket → plant. And the recommender writes one trace per decision **including the unassignable ones**
(the `chosen === null` branch pushes its own row), so "every decision this run made" is exactly this
table's contents for the run.

An **unassignable decision is a decision** and gets a row, with `poolEmptyReason` and a null SE.
Listing only the placements would show a run doing less than it did — the same class of omission
#282 R6 forbids on the counters.

A **`RETIRED` recommendation (#286) is kept.** It is what the run intended for a ticket it did not end
up placing, which is the question Replay exists to answer — and it only survives at all because #286
stopped deleting those rows earlier the same day.

### Two decisions worth recording

**A ZM naming another zone is refused, not answered.** `?zoneId` is camelCase, so the global
`ZoneScopeGuard` (which reads `:zoneId` / `?zone_id`) never fires on it. The service raises 403
`ZONE_SCOPE_VIOLATION` rather than silently substituting the ZM's own zone: quietly answering a
different question than the one asked is worse than saying no, and it would have made a scoping bug in
a caller invisible.

**Paging is ordered by `(processing_rank, trace_id)`.** `processing_rank` is per **zone**, so a
multi-zone run has as many rank 1s as it had zones. Without the tiebreak, two pages of the same query
can drop a row and repeat another — the classic unstable-pagination defect, and one that would have
looked like missing decisions rather than like a bug.

## §D — `GET /schedules?date=`

### What was wrong

`listSchedules` filters on live status alone and has **no date predicate at all**, so a never-closed
plan from last week comes back beside today's — while the nav row, the page copy and
`DispatchTimelineNote` all promise "today". The page has been saying something untrue of its own table.

### What landed

An optional `?date=YYYY-MM-DD`, applying the `dateFrom <= day <= dateTo` rule `DayPlanQueryService`
has always used for the SE-facing read, with the same `istWindowStart` parser and the same
`INVALID_DATE` shape as `GET /schedules/preview`.

**Additive, and deliberately not a new default** (AC10). The issue's prose says "defaulting to today";
the acceptance criterion says the no-param behaviour is preserved for callers that depend on it, and
the criterion is the binding statement. Making today the default would silently narrow every existing
caller — a page, a link and a test each expecting the all-live list — which is a behaviour change
wearing a bugfix's clothes. The surface that promises "today" passes the parameter instead.

## Surfacing

**Replay is real.** `/dispatch/today?mode=replay` lists the run's decisions in `processing_rank` order
— rank, ticket, plant, SLA bucket, the SE or the honest "Unassignable — no coverage" — and each row
expands into the existing `TracePanel`. The deep "why this SE" view is reached from here, never
rebuilt. Empty and error states are explicit (#285 AC9), including "no run for this zone today", which
is a different fact from "a run that decided nothing".

**The Batch Schedule page now scopes to the operating day by default**, with an `All live plans`
toggle — put to the operator and chosen by them rather than assumed. The toggle exists because a plan
that was never closed is a **real fault**: a page that only hid it would trade a wrong list for a
missing one. Two states and no date picker, because #280 R8's reasoning still holds — this page is
every SE's day plan, not a single-date view — and the narrower question here has exactly two honest
answers.

## Tests

Amended: `test/dispatch-transparency-api.e2e-spec.ts` (+5 — order, ZM clamp, `?zoneId` narrowing,
disjoint pagination over a stable total, 404 on an unknown run), `test/zm-schedule-query.e2e-spec.ts`
(+3 — no-arg unchanged, covering day kept, non-covering day dropped),
`test/zm-schedules-controller.e2e-spec.ts` (+1 — the param over the wire and `INVALID_DATE`),
`test/todays-dispatch.test.tsx` (+2 — the decision list and the empty state),
`test/schedules-list.test.tsx` (+2 — the default scope and the escape hatch).

Backend blast radius (schedules / dispatch / transparency / recommender / batch / override / intraday
and their neighbours) green; admin **110 files / 620 tests** green.

## Not done here

**No full-input replay snapshotting.** #282's "open, and deliberately not ruled here" list still
stands: the stream replays what the run *recorded*, not the world it saw. That is a storage decision,
not a read one.

**No export.** The page is capped at 100 decisions with the total stated beside it (`20 of 340`) and a
line saying so. A caller wanting all of a 2,000-decision run is asking for an export, which is a
different endpoint's job — and saying "showing the first N of M" is the alternative to a silent cap.
