# 154 — Stop overloading `work_schedules.status`: derive override provenance from `last_overridden_at`
Status: needs-triage
Type: AFK

> Follow-up to [#153](./153-override-blanks-day-plan-and-capacity.md), which took design **(a)**
> (widen every liveness filter behind one constant) to stop the bleeding. This issue is design **(b)**,
> recorded there as the cleaner end state. #153 stays **accepted** per the accepted-with-follow-up rule.

## Background

`WorkScheduleStatus` is `ACTIVE | OVERRIDDEN | COMPLETED | PARTIAL` (`schema.prisma:457-463`). #153
established that the column conflates two independent facts:

- **lifecycle** — is this plan live today? (`ACTIVE`/`OVERRIDDEN` vs `COMPLETED`/`PARTIAL`)
- **provenance** — did a Zonal Manager adjust it? (`OVERRIDDEN` vs everything else)

Every reader wants the first; the writer (`override.service.ts:487-490`) sets it for the second. That
mismatch is what blanked the SE day plan and zeroed capacity accounting for every override.

## Problem

#153 made the conflation **safe** — one shared `LIVE_SCHEDULE_STATUSES` predicate — but did not remove
it. The failure mode is still one careless `status: 'ACTIVE'` away, and the value is now load-bearing in
two directions at once: a future lifecycle state (say `SUSPENDED`) cannot be added without deciding what
it means for provenance, and vice versa.

The provenance columns **already exist on the row** and are already written on every override:
`lastOverriddenBy`, `lastOverriddenAt`. Nothing needs to be added to answer "was this overridden?" —
it is `lastOverriddenAt != null`.

## What to build

Keep a schedule's `status` at `ACTIVE` through an override; answer "was it overridden?" from
`lastOverriddenAt`. `LIVE_SCHEDULE_STATUSES` collapses back to `['ACTIVE']` and the liveness question
stops having an override-shaped exception in it.

## Why this is NOT a mechanical change

`OVERRIDDEN` is a **persisted enum value that operator-facing surfaces read**. It must be swept before
anything is written:

- `SchedulesPage.tsx:29,56,118` — the "ZM Adjusted" vs "Auto-Dispatched" label and the overridden count
- `ScheduleDetailPage.tsx:35,197` — the status badge tone
- `SeManagementPage.tsx:239`, `DeviceDetailPage.tsx:503` — per-stop / per-batch overridden badges
- `ticket-query.service.ts:147` — `COALESCE(asg.batch_status = 'OVERRIDDEN' OR asg.schedule_status = 'OVERRIDDEN', false) AS "overridden"`
- ZM performance aggregation and any report keying on schedule status
- **Existing rows in dev already carry `status = 'OVERRIDDEN'`** — a backfill decision is required, not
  just a code change.

Note the **batch**-level `BatchStatus.OVERRIDDEN` is a separate enum with the same smell; decide
explicitly whether it is in scope or stays.

## Acceptance criteria

- [ ] A sweep of every `OVERRIDDEN` consumer (backend + admin + reports) is recorded in the issue before any code lands.
- [ ] After a ZM override, `work_schedules.status` stays `ACTIVE` and `lastOverriddenAt` is set.
- [ ] Every surface that today shows "ZM Adjusted" / an overridden badge still does, sourced from `lastOverriddenAt`.
- [ ] `LIVE_SCHEDULE_STATUSES` is `['ACTIVE']` and `schedule-status.ts`'s conflation note is deleted, not amended.
- [ ] Existing `OVERRIDDEN` rows are migrated (status → `ACTIVE`, `lastOverriddenAt` backfilled where null) or the decision to leave them is recorded with its consequence.
- [ ] `#153`'s regression tests stay green **unchanged** — they assert behaviour, not the status value.
- [ ] Both suites green.

## TDD Strategy

#153's specs are the safety net and must not be edited: `override-schedule-live.e2e-spec.ts` asserts the
day plan survives, capacity still counts, and `COMPLETED` stays excluded — all through public seams, so
they hold regardless of how provenance is stored. Add RED for the provenance read itself (a ZM-adjusted
schedule reports as adjusted on the ZM surfaces while its status reads `ACTIVE`).

## Dependencies

Blocked by [#153](./153-override-blanks-day-plan-and-capacity.md) (done). Best sequenced **after**
[#146](./146-zm-override-integrity-defer-remove.md) so the override engine is not moving underneath a
schema/semantics change.

## Estimated Effort

M. **Priority: P3** — #153 removed the live defect; this removes the trap that produced it. Not urgent,
but it should not sit forever: every new schedule reader is a chance to reintroduce #153.

## UI surfaces

Admin: Schedules list, Schedule Detail, SE Management, Device Detail — all must keep their current
appearance. Display parity is the point; a visible change means the sweep missed something.

## Reference
- `docs/ui/desktop/v2-reference/12-batch-schedule-review.png`

## Blocked by
- [#153](./153-override-blanks-day-plan-and-capacity.md) — done
