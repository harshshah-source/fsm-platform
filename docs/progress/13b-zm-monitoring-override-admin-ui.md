# Progress — Issue 13b: ZM Monitoring & Override admin UI

> Build date: 2026-06-22 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Admin **38 tests / 15 files**, backend **268 tests /
> 86 files** (+5: one zone-SE endpoint spec), both `tsc --noEmit` clean (PostgreSQL 16 + PostGIS on
> :5433). One small backend addition (a zone-scoped SE-list endpoint); migration count unchanged.

## Scope & decisions

The React admin front-end half of Issue 13 (the backend override engine + API shipped as 13a). Two
forks were surfaced and HITL-confirmed up front:

1. **Override reason = free-text (v1).** No canonical override reason-code vocabulary exists (the backend
   `override_reason` is a free string; CONTEXT/PRD say "reason-coded" but enumerate no set). v1 captures
   a mandatory free-text reason on every override; a controlled vocabulary is deferred (would belong in
   CONTEXT.md).
2. **Target-SE picker needs a new endpoint.** `/api/org/engineers` is `@Roles('OPERATIONS_HEAD')` — a ZM
   gets 403. Added a zone-scoped, manager-readable SE list (`GET /api/schedules/engineers` →
   `ZmScheduleQueryService.listZoneEngineers`) reusing the existing zone scope. Used by Swap / Reassign /
   Split and the Critical-queue assign.

A third decision (Slice 4): **Reorder is a target-position control, not HTML5 drag** — jsdom-hostile drag
buys nothing here, and the backend `REORDER` takes a `stopSequence`, so a "Move to position" number +
reason maps directly and stays consistent with the other reason-coded overrides.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Schedule list `AUTO_ASSIGNED`/`OVERRIDDEN` badges; no Approve, no countdown | 🟢 | `SchedulesPage` (`/schedules`) reads `GET /api/schedules`. `schedules-list.test.tsx` (asserts badges + absence of Approve/countdown). |
| 2 | "Why suggested?" chip expands to reasoning | 🟢 | `ScheduleDetailPage` `WhySuggested` (Tier/Bucket/Rank/Cluster, collapsed by default). `schedule-detail.test.tsx`. |
| 3 | Each override control commits + reflects `OVERRIDDEN` | 🟢 | Remove/Defer/Reassign (ticket), Swap/Split/Reorder (stop) → `POST /api/batches/:id/override` + refetch. `schedule-override.test.tsx` (6 actions). |
| 4 | Override propagates to the SE Day Plan + UI reflects it | 🟢 | Backend propagation in 13a; UI refetches detail after each commit (status flip + moved/removed work disappears). `schedule-override.test.tsx`. |
| 5 | ON_SITE conflict banner + mandatory reason + confirm | 🟢 | `apiOverrideBatch` throws `OverrideConflictError` on 409; page holds the command, shows `onsite-conflict-banner`, re-submits with `confirm:true`. `schedule-override.test.tsx`. |
| 6 | CriticalQueue "Assign" creates a Formal Assignment | 🟢 | `CriticalQueue` AssignControl → `apiAssignTicket` per cluster ticket (`POST /api/schedules/assign`). `critical-assign.test.tsx`. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — Schedule list.** `src/api/schedules.ts` (`apiListSchedules`) + `SchedulesPage` + route
  (manager `RoleRoute`) + activated the inert "Schedules" nav link. `schedules-list.test.tsx` (2).
- **Slice 2 — Detail + reasoning.** `apiScheduleDetail` + `ScheduleDetailPage` (ordered stops,
  expandable `WhySuggested`). `schedule-detail.test.tsx` (2).
- **Slice 3 — Override controls.** `apiOverrideBatch` + per-ticket Remove/Defer and SE-moving
  Swap/Reassign/Split (zone picker). **Backend:** `listZoneEngineers` + `GET /api/schedules/engineers`
  (declared before `:engineerId` to avoid the param collision — the RED run proved it). `zone-engineers.e2e-spec.ts` (5, backend); `schedule-override.test.tsx` (5).
- **Slice 4 — Reorder.** Per-stop "Move to position" + reason → `REORDER {stopSequence}`; refetch
  reflects the new order. `schedule-override.test.tsx` (+1).
- **Slice 5 — ON_SITE conflict.** `OverrideConflictError` (409 parse) + page-level conflict banner +
  confirm-retry. `schedule-override.test.tsx` (+1).
- **Slice 6 — Critical-queue assign.** `apiAssignTicket` + `CriticalQueue` AssignControl (SE picker,
  per-ticket assign, `onAssigned` refetch); `DashboardHome` loads zone engineers + refetches.
  `critical-assign.test.tsx` (1); existing `dashboard-critical-action.test.tsx` still green (Assign
  disabled until an SE is picked).

Test counts added: admin **+12 tests / +4 files** (26→38 / 11→15), backend **+5 tests / +1 file**
(263→268 / 85→86).

## Deviations / deferred (read before extending)

1. **Free-text reason, not a coded vocabulary** — `ReasonInput` is a plain text field. A controlled
   override-reason-code set is a domain decision for CONTEXT.md if/when reporting needs it.
2. **ON_SITE conflict is contract-tested, not live end-to-end** — the backend only returns the 409 once
   Issue 15 wires the real `SoftStateConflictPort` (13a left `NoConflictSoftStatePort`). The banner +
   confirm flow is verified against the documented 409 payload; it will light up for real with 15.
3. **Reorder is position-based, not drag** — `REORDER {stopSequence}`. A drag affordance is a later
   polish; the commit semantics are final.
4. **Critical-queue assign loops `assignTicket` per cluster ticket** — the 13a endpoint is per-ticket;
   assigning a plant cluster issues N idempotent assigns (each reuses the SE's same-day plant batch).
5. **Zone-SE endpoint returns id + coverage + zone** — no SE display name (name lives on `users`, not
   `engineer_master`); the picker shows `engineerId`. A name join is a later nicety.
6. **DashboardHome loads zone engineers for the assign picker** — tolerant (failure leaves the picker
   empty); only manager roles reach the dashboard.

## How to run / verify

```
cd apps/admin   && node node_modules/vitest/vitest.mjs run     # 38 green
cd apps/backend && node node_modules/vitest/vitest.mjs run test/zone-engineers.e2e-spec.ts \
  test/zm-schedules-controller.e2e-spec.ts                      # 11 green (route-collision guard)
# focused admin: node node_modules/vitest/vitest.mjs run test/schedules-list.test.tsx \
#   test/schedule-detail.test.tsx test/schedule-override.test.tsx test/critical-assign.test.tsx
```

Both apps: `node node_modules/typescript/bin/tsc --noEmit` clean. The full backend suite shows the known
transient teardown flake (shared Postgres; "1 error", no failing assertion) — clears on re-run; the
13b-relevant specs pass cleanly in isolation.
