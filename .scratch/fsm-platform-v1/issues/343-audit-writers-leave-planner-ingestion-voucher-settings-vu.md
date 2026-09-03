# 343 — Audit writers: leave, planner, ingestion triggers, voucher export, settings from/to, VU pause/resume
Status: ready-for-agent
Type: AFK
Wave: 1 · Severity: P2 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

Six write paths change dispatch, money or the SLA clock with a missing or unusable audit row:

- leave approve writes only `SE_AVAILABILITY_SET` with no request id, and reject writes **zero**
  rows (`engineers/leave-request.service.ts:96-137`);
- planner intent upsert/delete is unaudited (`planner/se-planner.service.ts:44-98`);
- `sync-masters`, `run-pipeline` and `POST /snapshots/run` write no audit
  (`ingestion/autoplant/integration-sync.controller.ts:37-50`, `snapshots.controller.ts:48-56`);
- `GET /vouchers/export` is unaudited (`vouchers.service.ts:358-410`);
- `SETTING_UPDATED` carries no previous/next value (`settings/settings.service.ts:224-238`);
- VU `fileReport` pauses and manual `resumeSla` resumes the SLA with no audit
  (`ticketing/vehicle-unavailability.service.ts:140-219, 434-456`).

The survey's AC-04 (b) — that Ops Explorer projects no `metadata` column — was incorrect
(`ops-explorer/dataset-registry.ts:2628-2640` projects it); AC-04 shrinks to the settings-service
writer, half (a), which is in this slice (plan §1).

## Current code

- `engineers/leave-request.service.ts:96-137` — approve writes `SE_AVAILABILITY_SET` only; reject
  writes nothing
- `planner/se-planner.service.ts:44-98` — upsert/delete unaudited
- `ingestion/autoplant/integration-sync.controller.ts:37-50` — `sync-masters`, `run-pipeline`
  unaudited
- `snapshots.controller.ts:48-56` — `POST /snapshots/run` unaudited
- `vouchers.service.ts:358-410` — export unaudited
- `settings/settings.service.ts:224-238` — `SETTING_UPDATED` without previous/next
- `ticketing/vehicle-unavailability.service.ts:140-219, 434-456` — SLA pause / manual resume
  unaudited

## What to build

Each of the six files above writes through `AuditService.withAudit`, in the same transaction as
the write, with the controller passing `@CurrentActor()`:

- leave: `LEAVE_APPROVED` / `LEAVE_REJECTED` (reject carries the reason; rows carry the request id)
- planner: `PLANNER_ENTRY_SET` / `PLANNER_ENTRY_REMOVED`
- ingestion: `MANUAL_SYNC_TRIGGERED` / `PIPELINE_RUN_TRIGGERED` / `SNAPSHOT_RUN_TRIGGERED`
- vouchers: `VOUCHER_EXPORT_DOWNLOADED`
- settings: `SETTING_UPDATED` + `metadata:{key, previous, next}`
- vehicle unavailability: `VU_SLA_PAUSED` / `VU_SLA_RESUMED_MANUAL`
- Tests: `leave-request-*`, `se-planner-*`, `snapshots-api`, `integration-health-api`,
  `voucher-controller`, `settings-write`, `vehicle-unavailability-*` e2e
- Expected behaviour: every one of these actions is reconstructible — actor, acting role, entity,
  reason, before/after

## Acceptance criteria

- [ ] AC1 — one audit row per action, written inside the same transaction as the write, carrying
      the metadata named above
- [ ] AC2 — leave reject carries the reason
- [ ] AC3 — settings rows carry previous and next

## Verification

e2e asserting row + metadata per path.

## UI surfaces

n/a (backend only; rows become readable via 342)

## Reference

n/a

## Blocked by

— (none; readable via 342, which is not a build dependency)

## Absorbs / supersedes

- survey ids: ENG-G1, ENG-G2, ING-05, VCH-09, AC-04(a), TKT-01
- existing issues: none named

## Downstream

363 (leave integrity) depends on this (plan §3).
