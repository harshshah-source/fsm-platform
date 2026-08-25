# #283 — Assignment provenance seams · completion report

**Landed 2026-08-25.** Owning decision: [#282](../../.scratch/fsm-platform-v1/issues/282-decision-todays-dispatch-crew-deck.md) R2.
Evidence base: [`audit/scheduler-engine-forensics-2026-08-25.md`](../../audit/scheduler-engine-forensics-2026-08-25.md) §E.

## What was wrong

`batch_assignment_tickets` recorded the **end** of an assignment (`removed_at` / `removed_by` /
`removal_reason`, since #241) and nothing about its **start**. All four writers set exactly three
fields, so "who put this ticket on this plan, and why" was answerable only by joining `audit_logs` —
and on the intraday CRITICAL path not even then, because the engine and a ZM both audit as
`CRITICAL_ASSIGN`. Two further defects compounded it: human-created batches were stamped
`AUTO_ASSIGNED`, and a schedule the *system* created through the intraday sweep was stamped
`ZM_MANUAL`.

The consequence was not cosmetic: it made the approved provenance grammar unrenderable. #282 R2
requires that a human decision never look like a system one, and the UI may only draw provenance the
data supports.

## What landed

- **Migration** `20260825120000_assignment_add_provenance` — `added_by` (uuid), `add_reason`,
  `add_source`, `coverage_type_at_assign` (all TEXT/uuid, all nullable, none backfilled).
- **`src/scheduling/add-source.ts`** — two closed vocabularies (`ADD_SOURCES`,
  `COVERAGE_AT_ASSIGN`), `isSystemAddSource`, and `addProvenanceSourceFor`, which resolves the door
  from the actor first and the audit action second (the system/ZM `CRITICAL_ASSIGN` collision is
  exactly what needed breaking).
- **`src/scheduling/coverage-at-assign.ts`** — resolves the chosen SE's tier for the plant at write
  time, mirroring `orderedCandidatesForPlant`'s FLOATING re-validation (#138) but as a single
  membership test. Memoised per plant for lane writes.
- **All four writers stamp** — the engine (`AUTO_DISPATCH`, null actor), `assignTicket`,
  `assignLane` (carrying its mandatory `reasonCode` onto every row), `moveTickets`.
- **`ensureSchedule` takes the actor** and writes `SYSTEM_GENERATED` for the engine. No new
  `ScheduleSource` value was needed.
- **Two stale docstrings corrected** — `dispatch-transparency-query.service.ts:199` and
  `ops-explorer/dataset-registry.ts:2015` both asserted a run-id/`ZM_MANUAL` correspondence that this
  change makes untrue.

## Two decisions worth recording

**No new `BatchStatus` value.** The obvious "fix" for human batches stamped `AUTO_ASSIGNED` is a
`MANUAL_ASSIGNED` member. It would have been a data-loss bug: **seven** production readers use
`status IN ('AUTO_ASSIGNED','OVERRIDDEN')` as the *live batch* predicate
(`engineers-query.service.ts:201,275`, `me-tickets/se-ticket-access.ts:53`,
`me-tickets-query.service.ts:49`, `zm-schedule-query.service.ts:106,133`,
`day-plan-query.service.ts:43`), so every manual batch would have silently dropped out of "live" in
all seven. `status` is a lifecycle column — `COMPLETED`/`PARTIAL` prove it — and provenance belongs
on the ticket row. The enum exact-array pins at `scheduling-schema.e2e-spec.ts:67,81-86` are
deliberately unchanged.

**`created_at` is now stamped from the caller's clock, not the column default.** Found by a failing
test rather than by inspection: the removal side has always written `removedAt: now`, so with the add
side left to a DB-evaluated `now()` the two ends of a single reassignment landed at different
instants. Harmless until something reads them as a pair — which #284's day-bounded ledger does.

## Tests

New: `test/assignment-add-provenance.e2e-spec.ts` (4 — columns, no PG enum, both vocabularies),
`test/assignment-add-provenance-writers.e2e-spec.ts` (5 — AC3/AC5/AC6/AC7/AC8).
Amended: `test/batch-dispatch.e2e-spec.ts` gains AC4 (engine path).

**One pre-existing fixture had to change.** `day-plan-notification-outbox-writers.e2e-spec.ts:187`
built its actor as `'zm-obx-' + NS` — a synthetic string for a manager who never existed. Harmless
while the add side had no actor column; now it is written to a `uuid` and rejected. The fixture now
creates a real ZM, which was always implied by the behaviour under test.

## Not done here

History is **not** backfilled. A pre-#283 row genuinely does not record who added it, and NULL means
unknown — which readers must render as unknown, never as system. That rule is enforced at the UI in
#285 and pinned by its own test.
