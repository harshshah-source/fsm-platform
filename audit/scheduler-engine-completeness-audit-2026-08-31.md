# Scheduler Engine — Completeness & Mobile-Delivery Audit

**Date:** 2026-08-31 · **Branch:** `feat/autoplant-integration` @ `b184bd6`
**Method:** code read first, docs second; claims re-verified by running the relevant e2e specs
against the live `fsm_test` database (`localhost:5433`).
**Scope:** analysis only — no source, schema, issue or tracker file was modified.

---

## A. The three questions, answered up front

| Question | Answer |
|---|---|
| **Is the scheduler engine completely implemented?** | **Yes, functionally.** Every ratified decision in the #258 production-readiness set (16 items) and the #272 Assign-Console set (6 items) is built and test-pinned. Eight residual items remain, all observability/hygiene; none stop a day plan being produced. |
| **Does it work across the whole application?** | **Backend: yes. Admin: yes. Mobile: read path yes, delivery path no.** The engine runs on cron and on demand, the admin has a full cockpit (`/dispatch/today` Scheduler Console), and the SE-facing reads are real and correct. What is missing is everything that would *push* a change at the handset. |
| **Will it send data to the mobile application?** | **Only if the SE cold-opens the app, and only within 15 minutes of logging in.** The data is correct and served; the client has no push, no polling, no pull-to-refresh, and no mid-session token refresh. See §D. |

---

## B. What was verified — run, not read

All against the real database, this session:

```
test/dispatch-run.e2e-spec.ts                     1 test   PASS
test/dispatch-scheduler-tick.e2e-spec.ts          2 tests  PASS
test/scheduler-wiring.e2e-spec.ts                 2 tests  PASS
test/cron-tick-claim-wiring.e2e-spec.ts          12 tests  PASS
test/mv-freshness-signal.e2e-spec.ts              5 tests  PASS
test/dispatch-crashed-zone-recovery.e2e-spec.ts  12 tests  PASS
test/day-plan-query.e2e-spec.ts                   3 tests  PASS
test/day-plan-notifier-spine.e2e-spec.ts          2 tests  PASS
test/day-plan-notification-outbox.e2e-spec.ts     7 tests  PASS
test/batch-dispatch-notify.e2e-spec.ts            1 test   PASS
test/me-tickets-controller.e2e-spec.ts           11 tests  PASS
                                                 ---------
                                                 58 tests, 0 failures
```

`npx tsc --noEmit -p apps/backend/tsconfig.json` → **exit 0** (src only; see §F.4).

A full scheduler tick was observed producing a real day plan end to end:

```
[DispatchRunService] run 1: plant_eligible_floating_se has not rebuilt for this operating day
                     (last success never) - floating candidates may come from out-of-date
                     territory data. Proceeding.
[DayPlanNotifier]    Day Plan is live - se=fddc35dc... schedule=1 stops=1 tickets=1
[DispatchRunService] dispatch run: 2 zones, 1 schedules, 1 tickets, 0 errors, 0 contended
```

That one log block exercises four subsystems together: the MV-freshness warning (#287), the run
ledger, the batch-assignment writer, and the day-plan notifier.

---

## C. The engine, layer by layer

### C.1 Scheduling — complete

21 cron jobs register against the real `AppModule`, pinned exactly by
`test/scheduler-wiring.e2e-spec.ts:33-93` — a job that stops registering is a test failure. The
dispatch family is three of them:

| Job | Default | TZ | Purpose |
|---|---|---|---|
| `business-dispatch` | `0 5 * * *` (source of truth: `system_settings.dispatch_cron`) | **IST** | `DispatchRunService.runForActiveZones` |
| `business-dispatch-reaper` | `*/3 * * * *` | IST | frees zones of runs whose process died; **records that the zone is owed a day** |
| `business-dispatch-recovery` | `*/5 * * * *` | IST | collects on those marks — bounded re-dispatch (3 attempts, 18:00 IST cutoff) |

`apps/backend/src/scheduling/dispatch-scheduler.service.ts:83,127,171`.

Concurrency is layered, and every layer is DB-coordinated rather than in-process:

1. **Tick claim** — `cron_tick_claims`, `INSERT … ON CONFLICT DO NOTHING`. One instance runs a
   given (job, UTC-minute) window; the rest return `{ran:false, reason:'TICK_CLAIMED'}` (#263).
2. **Zone claim** — the `dispatch_run_zones` row *is* the claim, behind
   `ux_dispatch_run_zones_one_running_per_zone`. All-held → 409 with zero rows; partial → run row
   plus `CONTENDED` rows (#259).
3. **Per-SE transaction** with `SELECT … FOR UPDATE SKIP LOCKED` — one engineer's failure costs
   that engineer only, never the zone (#262, `batch-assignment.service.ts:52-58`).
4. **Heartbeat + reaper**, threshold `DISPATCH_STALE_RUN_MIN` (10 min), with the documented and
   checkable invariant `reap ≤ retry deadline` (#261/#260, `dispatch-cron.ts:180-196`).
5. **Bounded patient retry** on the cron path only; a manual run is never patient (#260).

The `@Cron` expression is only a compile-time default — `DispatchScheduleService` re-points the
live job from `system_settings.dispatch_cron` at boot and on every write, so an operator changes
the dispatch hour without a redeploy (#213), and `cronTimeCtorOf` takes the validating parser off a
live job instance so the parser that accepts an expression is provably the one that will run it.

### C.2 Selection — complete, with two honest non-enforcements

`apps/backend/src/recommender/` (1,988 LOC) implements the ratified #258 model: tier-scoped scoring
with candidate-specific plant clustering (Q-A), capacity headroom, CRITICAL direct assignment with
escalation when no capacity-eligible SE exists (Q-B), route-chain distance from SE home base, and
tri-state filter honesty.

The tri-state is the important design property. `hard-filters.ts:45,64-81` reports each filter as
`PASSED` / `FAILED` / **`NOT_ENFORCED`**, and `NOT_ENFORCED` never drops a candidate. Two filters
sit there today because their data sources do not exist yet:

- `VEHICLE_ON_TRIP` — awaits Issue 28's feed (`vehicleReadinessEnforced === false`)
- component availability — `componentAvailabilityEnforced === false`

This is a correct representation of an incomplete input, not a defect: the run records that it did
not enforce the filter rather than silently pretending it passed.

### C.3 Dispatch write — complete

`BatchAssignmentService.dispatchForZone` writes, per engineer in one transaction: an ACTIVE
`WorkSchedule`, one `PlantBatchAssignment` per plant, and its `batch_assignment_tickets` — now
carrying add-side provenance (`added_by`, `add_source`, #283, `scheduling/add-source.ts`,
`schema.prisma:729,736`). Dispatched directly, no approval gate; the ZM overrides post-hoc
(Decision §7).

The "Day Plan is live" intent is written to `day_plan_notification_outbox` **inside** that same
per-SE transaction, so it commits with the plan or not at all; delivery is attempted post-commit
and retried by the `business-notification-outbox` sweep with bounded attempts (#264,
`scheduling/day-plan-notification-outbox.ts`). A rolled-back plan can never announce itself.

### C.4 Admin surface — complete

`/dispatch/today` is the **Scheduler Console** (`apps/admin/src/pages/dispatch/console/`, 16
modules, routed at `AppRoutes.tsx:96`): an engineer × day board, contextual inspector, the six
overrides plus assign/hold/release with both 409 confirm gates and the impact preview, drag-and-drop
as a dialog initiator only, zone picker with remembered zone, Run Now with in-flight guard.
Alongside it: the run ledger, per-zone detail, decision traces, config-in-effect (including the MV
staleness warning at `ConfigInEffectPanel.tsx:123-143`), and the Assign Work Console at `/assign`.

**There is no scheduler blind spot the operator cannot reach from the admin.**

---

## D. The mobile question

### D.1 The read path is real and correct

| Endpoint | Service | What it returns |
|---|---|---|
| `GET /api/schedules/me` | `DayPlanQueryService` | ordered, plant-clustered stops from the live `WorkSchedule` → `PlantBatchAssignment` → tickets chain; empty-state before dispatch |
| `GET /api/me/tickets` | `MeTicketsQueryService` | assigned (day-plan-derived) **plus** covered-pool tickets merged, with `removedFromPlanAt` / `deferredToDate` / soft state / SLA bucket / technical hints |

Both are IST-day-scoped and tolerate the states a ZM override produces: `OVERRIDDEN` schedules
still serve (an override must not blank the plan), and hollow stops whose tickets were all removed
are hidden rather than shown as zero-device stops. `GET /api/me/tickets` also picks up CRITICAL
direct assignments through its `assignedSeId` branch — those have no batch row at all. Both
re-verified green this session.

The API prefix is **not** a problem: `app.config.ts:18-30` registers every route at both
`/api/v1/...` and `/api/...` (`defaultVersion: ['1', VERSION_NEUTRAL]`), and the mobile client's
`EXPO_PUBLIC_API_URL` targets `/api/v1` (`apps/mobile/src/api/client.ts:93`). They match.

Contracts are also in sync where they were deliberately retired: #268 removed SE acceptance from
the CRITICAL path, and both sides agree — the backend controller no longer exposes
`/me/intraday-insertions`, and `client.ts:420-424` records the removal of the three client
functions that called it.

### D.2 Four reasons the SE still will not see a fresh day plan

**1 — There is no push. At all.**
`LoggingChannelGateway` (`notifications/notification-channel.gateway.ts:35-40`) returns
`UNAVAILABLE` for every external channel and logs the intent. The FCM/APNs adapter is #76,
HITL-blocked on account provisioning. On the client, `apps/mobile/package.json` has **no
`expo-notifications` dependency**, no push handler, and never calls the
`POST /api/notifications/device-token` endpoint the backend already exposes. #89 is
`ready-for-agent`, blocked-by-external on #76.

So "Your Day Plan is live" is written as an **in-app** notification row only. It reaches the
handset when — and only when — the app asks for it.

**2 — Nothing on the handset ever asks again.**
A repo-wide grep across `apps/mobile/src` for `RefreshControl`, `onRefresh`, `useFocusEffect` and
`setInterval` returns **zero production hits**. `HomeScreen.tsx:85` and `TicketsScreen.tsx:73` each
run one `useEffect(..., [])` on mount. `SeTabShell.tsx:66-70` uses default bottom-tab behaviour
(no `unmountOnBlur`), so screens stay mounted and switching tabs does not refetch.

The SE sees whatever was true at cold start. A ZM override at 11:00 is invisible until the app is
force-closed and reopened.

**3 — The session silently dies after 15 minutes.**
`token.service.ts:22` sets `accessTtlSec = 15 * 60`. The client refreshes **only** in
`AuthProvider.tsx:28`, on a 401 from `/me` at login or rehydrate-on-mount. There is no per-request
401 interceptor and no timer. Every data call in `client.ts` throws on `!res.ok`, and `HomeScreen`
maps that throw to `status: 'offline'`.

Fifteen minutes after login, a working handset on a working network renders **"Offline"** over data
that is perfectly fine on the server. Flagged in
`audit/mobile-contract-sync-audit-2026-08-04.md`; still live.

**4 — The server's authoritative change signal has no reader (#201).**
`MeTicketsQueryService` publishes `removedFromPlanAt` and `deferredToDate` on every row. Grepping
`apps/mobile/src` for either name outside tests returns **nothing**. The client instead uses
`tickets/dayPlanCues.ts`, an in-memory diff of consecutive fetches whose own docstring says it
exists "since the server has no added/removed-since signal" — untrue since #161. That diff cannot
see a change made while the app was closed, resets on cold start, and collapses *deferred* into
*removed*, so the return date is never shown.

### D.3 Verdict

> The scheduler produces correct data for the mobile app and serves it over correct, tested
> endpoints. **It does not deliver it.** Delivery is four separate unbuilt pieces — push
> (#89/#76), refresh (unfiled), session continuity (#202), and the change signal (#201) — and only
> the first is blocked on anything external.

The cheapest meaningful fix is *not* push. It is a 401-refresh interceptor plus a focus/interval
refetch: together they turn a 15-minute session into a working day and make every existing server
change visible within a poll interval — no external account, no APK-invalidating native dependency,
no backend work.

---

## E. Residual engine gaps (real, all non-blocking)

Verified still open against current source. Ranked by operational weight.

| # | Gap | Evidence | Impact |
|---|---|---|---|
| 1 | **Policy-withheld / bucketless / component-blocked populations are counts, not lists** | `dispatch-today-query.service.ts:166-173` publishes `{count, itemised:false}` — deliberately honest, but unenumerable | A manager sees "47 withheld" and cannot act on it |
| 2 | **#104 retention matrix unimplemented** — documented in `schema.prisma`, built nowhere beyond the outbox/tick-claim prunes riding `partition-maintenance` | issue `104-…md` Status `ready-for-agent` | Unbounded growth in append-only tables under real traffic |
| 3 | **`PlantBatchAssignment.status` still reads `AUTO_ASSIGNED` for human-created batches** | `override.service.ts:530,791` | Cosmetic today — #283 solved provenance at the *ticket* row (`add_source`), which is what the UI reads — but a future reader keying on batch status would draw the wrong conclusion |
| 4 | **Two hard filters permanently `NOT_ENFORCED`** (vehicle-on-trip, component availability) | `hard-filters.ts:67,76` | Correctly *reported*; the gap is the missing upstream feeds (#28, #65), not the scheduler |
| 5 | **Runner-up trace capped at 5 in precedence order, not score order**; `orderPlantStops` is still a seam awaiting real geometry | `batch-assignment.service.ts:325-327` | Replay is less useful than it looks; stop order is priority order, not a route |
| 6 | **No escalation on repeated run failure** — warnings only, nothing pages a human | `dispatch-scheduler.service.ts:110,141,166` are all `logger.error`/`logger.warn` | A dispatch failing every morning is found by someone noticing |
| 7 | **No boot-time reap** — claims orphaned by a restart wait for the reaper cron, which sits behind `BUSINESS_SWEEPS_ENABLED` | — | With sweeps off, a restart-orphaned zone claim never clears |
| 8 | **`validateDispatchCron` accepts sub-daily expressions** (`* * * * *` is valid) | `dispatch-cron.ts:229-241`, acknowledged in its own docstring | An operator can configure a schedule that stacks ~15 concurrent patient runs |

None of these prevent a day plan from being produced, dispatched, or read.

---

## F. Documentation drift found

The repo's own trackers **understate** what is built. Four corrections, each source-verified:

1. **#287 (MV freshness) is DONE, not `ready-for-agent`.**
   `.scratch/fsm-platform-v1/issues/287-mv-freshness-signal.md:3` says `**ready-for-agent**` and
   the INDEX P11 row carries no completion marker. All five ACs are in fact met:
   `plant-eligible-floating-se.service.ts` records the refresh outcome and exposes `freshness()`;
   `dispatch-run.service.ts:1189-1262` stamps `mvFreshness` (with a `stale` flag, unknown → stale,
   the safe direction) into `config_snapshot`; `ConfigInEffectPanel.tsx:123-143` renders the
   warning; `test/mv-freshness-signal.e2e-spec.ts` (5 tests) passes.

2. **#254 (unpinned `plant-eligibility-refresh` cron) is DONE (2026-08-20).**
   `plant-eligibility-refresh-scheduler.service.ts:71-73` now pins `timeZone: BUSINESS_TIMEZONE`.
   But `docs/SYSTEM-STATE-2026-07.md` §3g still carries two paragraphs and a table row asserting it
   is **"UNPINNED — see #254"** and that "on a UTC host the refresh fires at 10:00 IST — five hours
   *after* the batch it exists to feed." That is the most misleading sentence currently in the
   current-state document: it describes a live production defect that no longer exists. §3g also
   still says "20 registered cron names"; the pinned count is **21**.

3. **#283 (assignment provenance) is DONE but its Status line reads `**ready-for-agent**`.**
   `scheduling/add-source.ts` carries the full closed vocabulary, `schema.prisma:729,736` carry the
   columns, and INDEX records it done 2026-08-25.

4. **#293 is real and worth doing.** `apps/backend/tsconfig.json` includes only `src`, so the clean
   `tsc --noEmit` in §B says nothing about the ~430 spec files. The blind spot is genuine.

---

## G. Operational state — the engine is built, the funnel is half-off

From `apps/backend/.env`:

```
INGESTION_SCHEDULER_ENABLED="false"
BUSINESS_SWEEPS_ENABLED="true"
```

Worth flagging. Business sweeps are **on**, so `business-dispatch` fires at 05:00 IST — but
ingestion is **off**, so no new snapshots arrive, no device state is recomputed, and no new tickets
are created. The dispatch run therefore executes correctly every morning against a ticket pool that
no longer changes.

`docs/SYSTEM-STATE-2026-07.md` §6.3 states the intended enable order (eligibility mode → the paired
ingestion + partition switches → business sweeps). The current pairing is the reverse of it.
Whether that is deliberate for this working tree is an operator question, not a code defect — but
anyone inspecting "is the scheduler working" against this environment would see healthy, empty runs
and could draw the wrong conclusion in either direction.

---

## H. Bottom line

**The scheduler engine is production-grade and substantially finished.** Its concurrency model is
DB-coordinated at four independent layers, each pinned by two-connection e2e specs; its failure
modes — crash, contention, per-engineer conflict, stale eligibility data, lost notification — each
have a named, tested recovery; and its decisions are recorded well enough to replay months later.
The admin can see and drive all of it from one screen.

**The gap is not the engine. It is the last hop to the handset.** Four unbuilt client-side
mechanisms stand between a correct day plan on the server and an engineer who can see it, and only
one of the four (push) is blocked on anything outside this repo.

**Recommended order, if this is to be closed:**

1. 401-refresh interceptor + focus/interval refetch on mobile *(unfiled; largest effect per unit of
   work — turns a 15-minute session into a working day)*
2. **#201** — read the server's `removedFromPlanAt` / `deferredToDate`; retire the client diff
3. **#89 / #76** — push, once the FCM account exists (HITL)
4. §E gaps 1 and 2 — itemisation, then #104 retention, before real ticket volume
5. §F documentation corrections, made **in place**, per the repo's no-forks convention

---

*Audit produced 2026-08-31. Report-only.*
