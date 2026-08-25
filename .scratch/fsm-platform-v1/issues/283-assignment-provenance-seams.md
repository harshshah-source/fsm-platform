# 283 — Assignment provenance: a human decision must not look like a system one

Status: **ready-for-agent**
Type: AFK · Backend (+ migration)
Decision: [#282](./282-decision-todays-dispatch-crew-deck.md) R2 — the provenance grammar is binding,
and the UI may only render provenance the data truthfully supports. **This issue is what makes the
grammar renderable at all**; #285 must not ship dashed-vs-solid chips before it lands.
Evidence: [`audit/scheduler-engine-forensics-2026-08-25.md`](../../../audit/scheduler-engine-forensics-2026-08-25.md) §E.

## Objective

The data can answer, for any assigned ticket: **who put it on this plan, why, through which door,
and did that cross a coverage tier.** Today it can answer none of those four.

## Current behaviour (verified against the tree 2026-08-25, file:line)

- **Four writers create `batch_assignment_tickets` rows and all four set exactly three fields**
  (`batchId`, `ticketId`, `sortOrder`): `batch-assignment.service.ts:254` (engine),
  `override.service.ts:516` (`assignTicket`), `:756` (`assignLane`), `:922` (`moveTickets`).
  The **removal** side has carried `removedAt` / `removedBy` / `removalReason` since #241; the **add**
  side is anonymous. There is no `added_by`, no `add_reason`, no `add_source`.
- **Human-created batches are stamped `AUTO_ASSIGNED`** — `override.service.ts:511` and `:750` write
  the same `status` the engine writes at `batch-assignment.service.ts:247`. The only discriminator is
  `plant_batch_assignments.run_id IS NOT NULL`, which is also null for pre-attribution history.
- **A system-generated CRITICAL assignment produces a `ZM_MANUAL` schedule.** Chain:
  `business-sweep-scheduler.service.ts:232` → `intraday-insertion.service.ts:331` → `:158` → `:278`
  (`assignTicket(..., SYSTEM_SCOPE, SYSTEM_ACTOR, ...)`) → `override.service.ts:501` →
  `ensureSchedule` `:966-976`, which writes `source: 'ZM_MANUAL'` **unconditionally** (`:973`).
  `ensureSchedule`'s signature (`:940-945`) takes no actor, though `assignTicket` has
  `actor.role === 'SYSTEM'` in scope at the call site.
- **Tier crossing is unrecorded on every manual path.** The engine persists `chosen.coverageType` and
  `tierEvaluated` on each decision trace; `assignLane` applies no coverage check and stores nothing.
  A ZM handing a DEDICATED plant's work to a FLOATING engineer is indistinguishable in the data.
- The intraday **system** path is the one write site where the tier is already free:
  `intraday-insertion.service.ts:228` loads `orderedCandidatesForPlant`, and `chosen.coverageType` is
  in scope at `:278` — and is thrown away, because `assignTicket` has no parameter to carry it.

## Required change

1. **Migration** — three provenance columns plus one tier column on `batch_assignment_tickets`,
   mirroring the removal side:
   `added_by uuid NULL` · `add_reason TEXT NULL` · `add_source TEXT NULL` ·
   `coverage_type_at_assign TEXT NULL`.
   All **TEXT, not PG enums**, following the deliberate `removal_reason` precedent
   (`schema.prisma:721-724`): the closed set is enforced in TypeScript so later slices add members
   without a migration. All nullable — history cannot be backfilled and must not be guessed.
2. **`src/scheduling/add-source.ts`** — the closed vocabulary, shaped exactly like
   `removal-reason.ts`: `AUTO_DISPATCH` · `SYSTEM_CRITICAL` · `MANUAL_ASSIGN` ·
   `MANUAL_BATCH_ASSIGN` · `MANUAL_PLANT_ASSIGN` · `MANUAL_REASSIGN` · `MANUAL_SPLIT` ·
   `SAME_DAY_ADD` · `CROSS_ZONE_ASSIGN`. Plus `COVERAGE_AT_ASSIGN`: `DEDICATED` · `MULTI_PLANT` ·
   `FLOATING` · `NONE` (**`NONE` is required** — a human may assign an SE with no coverage row for
   that plant at all, which is not one of the three tiers and must not be recorded as one).
3. **Every writer stamps it** — all four sites above, not one. The engine passes `AUTO_DISPATCH`;
   `assignTicket` distinguishes `SYSTEM_CRITICAL` (when `actor.role === 'SYSTEM'`) from the human
   `auditAction`-derived sources; `assignLane` passes its mandatory `reasonCode` as `add_reason`.
4. **`ensureSchedule` takes the actor** and writes `source: 'SYSTEM_GENERATED'` when the actor is
   SYSTEM. **No new `ScheduleSource` value** — `SYSTEM_GENERATED` already means "the system created
   this", which is exactly true of an engine CRITICAL insert. Update the two stale docstrings that
   say run-id-null implies ZM_MANUAL (`dispatch-transparency-query.service.ts:199`,
   `ops-explorer/dataset-registry.ts:2015`).
5. **Coverage at assign** — resolve the chosen SE's tier for that plant at write time:
   - intraday SYSTEM path: thread the already-computed `chosen.coverageType` through (free);
   - `manualAssign`: the service already holds `CandidateQueryService` and the sibling read
     `availableSesForManualAssign` (`:372-382`) already resolves `plantId` → tier; add the `include`;
   - `assignTicket` / `assignLane` / `moveTickets`: single indexed lookup on the existing
     `se_coverage` `@@unique([seId, plantId])`, **one pre-pass per distinct plant per lane** — never
     per-ticket inside the transaction loop. `NONE` when no row and not floating-eligible.

## Explicitly NOT in scope — and why (do not "fix" these later without reading this)

- **No new `BatchStatus` value for manual batches.** Seven production readers use
  `status IN ('AUTO_ASSIGNED','OVERRIDDEN')` as the *live batch* predicate
  (`engineers-query.service.ts:201,275`, `me-tickets/se-ticket-access.ts:53`,
  `me-tickets-query.service.ts:49`, `zm-schedule-query.service.ts:106,133`,
  `day-plan-query.service.ts:43`). Adding `MANUAL_ASSIGNED` would silently drop every manual batch
  out of "live" in all seven — a data-loss-shaped bug wearing a provenance-fix hat. `status` is a
  **lifecycle** column (`COMPLETED`/`PARTIAL` prove it); provenance belongs on the ticket row.
- **No backfill of history.** Null means "written before provenance existed", and the UI must render
  that as unknown, never as system.

## Existing code to reuse

`removal-reason.ts` (the vocabulary shape and its TEXT-not-enum rationale) · `ActorContext` /
`RequestActor` · `CandidateSelectionService.orderedCandidatesForPlant` ·
`CandidateQueryService.listForPlants` · the `se_coverage` `@@unique([seId, plantId])` index.

## Data model / API

Migration `20260825120000_assignment_add_provenance`. No API shape change in this issue — #284
publishes the new columns.

## UI surfaces

None. #285 consumes it.

## Acceptance criteria

- [ ] AC1 — Migration adds the four columns, all nullable; `scheduling-schema.e2e-spec.ts` gains the
      column-shape assertions beside the existing `batch_assignment_tickets` FK/partial-unique test.
- [ ] AC2 — `add-source.ts` exports both closed vocabularies; a spec pins that every production
      writer's value is a member (the `removal-reason` precedent, which has no such test — add it for
      both sides while here).
- [ ] AC3 — **All four** ticket writers stamp `added_by` / `add_source`; a sweep test asserts no
      `batch_assignment_tickets` row created by production code in the suite has a null `add_source`.
- [ ] AC4 — An engine-dispatched ticket has `add_source='AUTO_DISPATCH'` and `added_by IS NULL`
      (nobody added it — the run did; `run_id` is its handle, exactly as closure uses a null
      `removed_by` for `TICKET_RESOLVED`).
- [ ] AC5 — A system CRITICAL insert produces `add_source='SYSTEM_CRITICAL'` **and** a
      `work_schedules` row with `source='SYSTEM_GENERATED'` — the currently-untested
      `ZM_MANUAL`-for-a-system-assign behaviour is inverted and pinned.
- [ ] AC6 — A ZM one-click assign of the same ticket produces `add_source='MANUAL_ASSIGN'` and
      `added_by = <that user>`; the two are distinguishable **from the row alone**, with no join to
      `audit_logs`.
- [ ] AC7 — `assign-batch` stamps its mandatory `reasonCode` as `add_reason` on every ticket in the
      lane.
- [ ] AC8 — `coverage_type_at_assign` is recorded on all manual paths; a manual assign of a plant's
      work to a FLOATING engineer where a DEDICATED engineer covers that plant is identifiable from
      the row (this is the dashed-violet signal #285 renders).
- [ ] AC9 — No behaviour change to what is assignable, to capacity (Q2), or to any live-batch read:
      the seven `AUTO_ASSIGNED`/`OVERRIDDEN` readers return byte-identical results before and after.
- [ ] AC10 — Full backend suite green; the enum exact-array pins at `scheduling-schema.e2e-spec.ts:67`
      and `:81-86` are **unchanged** (this issue adds no enum values).
