# Progress — Issue 15: SE soft states + activity ping + derived Activity Status

> Build date: 2026-06-23 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 7 acceptance criteria green. Backend: **+42 tests / +11 files** for this issue;
> `tsc --noEmit` clean (PostgreSQL 16 + PostGIS on :5433). Migration **21** (`add_soft_states`).

## Scope & decisions

The SE soft-state lifecycle (schema D7) and the derived SE Activity Status (ADR-0023). Soft states are
field-progress signals on a ticket — never a ticket lifecycle state and never a lock (CONTEXT §Soft
State). A single SE walks the chain **VIEWED → ON_SITE → TROUBLESHOOT_STARTED**; different SEs may hold
states on the same ticket concurrently (that overlap is the input to Activity Status, not a conflict).

Forks resolved up front:

1. **Advancing resolves the prior state.** Each forward step resolves the SE's current state
   (`resolved_by=SE`, `reason=ADVANCED`) so a single SE holds at most one active state per ticket. This
   keeps the transition guard and the derived Activity Status unambiguous. CONTEXT lists timeout as
   VIEWED's clear trigger; superseding-on-advance is an additional, non-conflicting resolution event.
2. **`onsite_source` derived server-side from a captured point + plant geofence.** No geofence table
   exists, so AUTO_GEOFENCE = the captured point is within a configurable radius (`DEFAULT_GEOFENCE_
   RADIUS_M`, 200 m) of the plant point (PostGIS `ST_DWithin`); otherwise (no location / capture failed
   / outside the fence) the SE's tap is MANUAL and is **audited** (`SOFT_STATE_ONSITE_MANUAL`).
3. **Activity Status availability source is stubbed AVAILABLE.** ADR-0023's precedence puts
   `SE_AVAILABILITY.status` first, but that table lands with Issue 25. The pure `deriveActivityStatus`
   takes `availabilityStatus` as an input (fully tested incl. the override branch); the DB-backed
   `activityStatusFor` passes `'AVAILABLE'` until Issue 25 wires `se_availability` in.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | VIEWED → ON_SITE → TROUBLESHOOT_STARTED enforced; invalid transitions rejected | 🟢 | `SoftStateService.advance` rank-guard (skip/backward/start-above-VIEWED → INVALID_TRANSITION; same-state → IDEMPOTENT; `ux_ss_active` partial unique backs it). `soft-state-transitions.e2e-spec.ts` (5). |
| 2 | ON_SITE auto-set from geofenced action (AUTO_GEOFENCE) with audited manual fallback (MANUAL) | 🟢 | `setOnSite` resolves source via `ST_DWithin` against the plant point; MANUAL writes a `SOFT_STATE_ONSITE_MANUAL` audit row in the same tx. `soft-state-onsite-source.e2e-spec.ts` (3). |
| 3 | SE-initiated actions update `last_activity_at`; background processes do not; pings never clear soft states | 🟢 | `recordActivityPing` + a stamp inside every `runAdvance`; the ping only touches `last_activity_at`, never resolves a state. `soft-state-activity-ping.e2e-spec.ts` (3). |
| 4 | VIEWED clears on configurable timeout; ON_SITE / TROUBLESHOOT_STARTED do not expire by time | 🟢 | VIEWED `timeout_at = set_at + viewed_soft_state_timeout_minutes` (setting, default 90); `clearExpiredViewed` resolves expired VIEWED (SYSTEM/VIEWED_TIMEOUT, row retained); ON_SITE/TS carry NULL `timeout_at` (CHECK) → never swept. `soft-state-viewed-timeout.e2e-spec.ts` (4). |
| 5 | Stale-work warning fires at configured threshold without clearing state | 🟢 | `staleWorkWarnings` reads active ON_SITE/TS older than `onsite_stale_warning_hours` / `troubleshoot_started_stale_warning_hours` (default 2 h) — a pure read, never resolves. `soft-state-stale-warning.e2e-spec.ts` (3). |
| 6 | Activity Status derived at render time (never stored); OFFLINE = "app not recently used" | 🟢 | Pure `deriveActivityStatus` (ADR-0023 precedence) + DB-backed `activityStatusFor`; a soft state outranks a stale heartbeat so OFFLINE never hides active work. `activity-status.spec.ts` (9) + `soft-state-activity-status.e2e-spec.ts` (5). |
| 7 | Real `SoftStateConflictPort` adapter wired to the `SOFT_STATE_CONFLICT` token | 🟢 | `PrismaSoftStateConflictPort` reports tickets with an active ON_SITE/TROUBLESHOOT_STARTED; bound in `scheduling.module.ts` replacing `NoConflictSoftStatePort`. `soft-state-conflict-port.e2e-spec.ts` (2); `batch-override-onsite` still green. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — `soft_states` schema.** `SoftState` model + `SoftStateType`/`OnsiteSource` enums +
  back-relations; migration `20260623120000_add_soft_states` (table, `ux_ss_active` partial unique, 3
  CHECKs tying `timeout_at`/`onsite_source` to type, 4 indexes). `soft-states-schema.e2e-spec.ts` (3).
- **Slice 2 — transition guard.** `advance` rank-chain enforcement + supersede-on-advance. (5).
- **Slice 3 — ON_SITE source.** `setOnSite` geofence (`ST_DWithin`) vs audited MANUAL fallback. (3).
- **Slice 4 — activity ping.** `recordActivityPing` + per-advance stamp. (3).
- **Slice 5 — VIEWED timeout.** Configurable `timeout_at` + `clearExpiredViewed` sweep. (4).
- **Slice 6 — stale-work warning.** `staleWorkWarnings` read. (3).
- **Slice 7 — Activity Status.** Pure `deriveActivityStatus` + `activityStatusFor`. (9 + 5).
- **Slice 8 — conflict port.** `PrismaSoftStateConflictPort` + token wiring. (2).
- **Slice 9 — HTTP surface.** `SoftStateController` (`POST /api/tickets/:id/soft-state`,
  `POST /api/me/activity-ping`), `SoftStateModule`, registered in AppModule. `soft-state-controller.e2e-spec.ts` (5).

## Deviations / deferred (read before extending)

1. **No scheduler.** `clearExpiredViewed` and `staleWorkWarnings` are service methods invoked on demand
   — no cron yet (same no-scheduler posture as Issues 04/08/14a). A SoftStateTimeoutWorker / stale
   sweep wires them to BullMQ when scheduling lands.
2. **`SE_AVAILABILITY` not yet a source** for `activityStatusFor` (stubbed AVAILABLE) — Issue 25 wires
   it. The pure function already honours the full ADR-0023 precedence.
3. **Geofence radius is a constant** (`DEFAULT_GEOFENCE_RADIUS_M` = 200 m), not yet a setting. Promote
   to `system_settings` if Operations Head needs per-deploy tuning.
4. **No mobile UI.** The SE mobile app is still an auth shell (no Day Plan / ticket-detail screens), so
   Issue 15 ships the backend service + HTTP surface that the mobile soft-state actions will call. The
   on-screen VIEWED/ON_SITE/troubleshoot actions land with the mobile ticket screens (Issues 16/20 +
   the mobile Day Plan view).
5. **Stale warnings + Activity Status are global service reads**, not yet zone-scoped or surfaced on
   the ZM dashboard — the dashboard integration (zone-scoped panels) layers on in the ZM dashboard /
   Issue 25 SE Management page, consuming these methods.

## Environment note

`tsc --noEmit` clean. Migration created by hand (shadow-DB `CREATE DATABASE` is denied to the `fsm`
role) then `migrate deploy` + `generate` — the established workflow for this repo's raw-SQL migrations
(partial uniques / CHECKs).

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run     # full suite (PG16 + PostGIS on :5433)
# focused:
node node_modules/vitest/vitest.mjs run test/soft-states-schema.e2e-spec.ts \
  test/soft-state-transitions.e2e-spec.ts test/soft-state-onsite-source.e2e-spec.ts \
  test/soft-state-activity-ping.e2e-spec.ts test/soft-state-viewed-timeout.e2e-spec.ts \
  test/soft-state-stale-warning.e2e-spec.ts test/activity-status.spec.ts \
  test/soft-state-activity-status.e2e-spec.ts test/soft-state-conflict-port.e2e-spec.ts \
  test/soft-state-controller.e2e-spec.ts
```
