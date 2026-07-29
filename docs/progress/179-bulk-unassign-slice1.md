# 179 — OH bulk unassign, Slice 1 (backend preview + execute)

TDD completion report. Frozen once written — corrections go to INDEX/SYSTEM-STATE, not here.

## Process note (read first)

`execute()` — its advisory-lock handling, the in-transaction audit write, and the preview-token
verify/staleness logic — was written in full immediately after the *first* RED test (preview
classification), before any test drove that code. This is a genuine deviation from the session's
RED-first discipline. Caught before running the test against it (nothing committed). Per operator
instruction, fully reverted (deleted back to `preview()`/`classifyZone()` only, the code that *was*
test-driven) and rebuilt from scratch through five genuine RED→GREEN cycles:

1. advisory lock (skip a contended zone, report it, touch nothing)
2. happy path (unassign eligible/on-site/component-blocked; exclude closed/install-recovery/deferred)
3. audit contract (full `BULK_UNASSIGN_ZONE` metadata + one notification per affected SE)
4. re-dispatch (APPEND-onto-empty against the real recommender/dispatcher, capacity freed)
5. Pan-India token (missing → refused, stale → refused with fresh counts, fresh → succeeds)

The operator's stated reasoning for requiring the redo: this project's two worst defects (#153,
#155) were both found by a RED test failing for the wrong reason, not by code review. Lock
handling, in-tx audit writes, and token staleness are exactly the class of logic where an untested
assumption hides silently — test-after can only confirm a belief already written into the code.

## AC-by-AC

- **Preview returns per-zone counts + mints a token** — `bulk-unassign.e2e-spec.ts`, 2 tests
  (single-zone classification of all six classes; Pan-India aggregation across zones, asserted by
  zone id, not list length, since the shared `fsm_test` DB carries other suites' fixtures/seed
  zones). The Pan-India test passed on its first run — a legitimate regression lock on `preview()`'s
  already-correct scope-generic loop, not a new RED, and reported here as such rather than staged as
  a false RED/GREEN pair.
- **Execute unassigns in-scope tickets, excludes the rest, writes the full contract** —
  `bulk-unassign-execute.e2e-spec.ts`, cycles 1–3. Verified: `removed_at`/`removed_by` stamped (never
  deleted) on eligible/on-site/component-blocked batch rows; `assignment_state → UNASSIGNED`; one
  `BULK_UNASSIGNED` `ticket_events` row per touched ticket; `work_schedules.status` stays `ACTIVE`
  with `lastOverriddenBy/At` stamped (D3); `PlantBatchAssignment.status` untouched; closed/install-
  recovery/deferred tickets untouched (deferred ticket's `deferredUntil` neither set nor cleared);
  one `BULK_UNASSIGN_ZONE` audit row per zone with `operationId`/`counts`/`buildFingerprint`/
  `buildVersion`; one `DAY_PLAN_REBALANCED` notification per affected SE.
- **Advisory lock, non-blocking** — cycle 1. A concurrently-held lock (simulated on a second raw
  connection) is skipped, reported (`skipReason: 'LOCK_CONTENDED'`) via a standalone audit row
  (`AuditService.record`, no mutation), never blocked on.
- **Re-dispatch reuses the schedule, frees capacity** — cycle 4, against the real
  `RecommenderService`/`BatchAssignmentService` (not mocks). Capacity-discriminator fixture (10
  capacity / 6 tickets) proves `committedDayLoad` reads `removed_at`, not stale state: re-dispatch
  recommends all 6, not 4. Same schedule id reused (APPEND-onto-empty), stays `ACTIVE`. Stop
  numbering continues over the emptied stop, asserted directly — the #127 artifact, left as the
  issue records it, not "fixed" here.
- **Pan-India token gate** — cycle 5, split into three isolated tests (missing / stale / fresh),
  each with its own fixture. Deliberately not one combined test: a Pan-India `execute()` sweeps
  every active zone in the shared `fsm_test` DB, so the very first (necessarily unguarded) RED run
  of the "missing token" case executes for real — isolating it to one disposable fixture ticket
  keeps that RED run's blast radius contained instead of contaminating the stale/fresh assertions
  in the same test. This is the same class of shared-test-DB risk #156 already documents; not a
  new problem, just visible again at the edge of a Pan-India-scoped feature.
- **`POST /api/schedules/bulk-unassign`, OH-only** — `bulk-unassign-controller.e2e-spec.ts`, 6
  tests: OH succeeds, CSM and SE forbidden (deliberately narrower than `dispatch-run`'s OH+CSM, per
  D6/#119), unauthenticated rejected, missing `zoneId` on `ZONE` scope → 400, missing `reasonCode` →
  400.
- **`liveScheduleFilter()` used everywhere, no hand-spelled `status: 'ACTIVE'`** — the only schedule
  read in `classifyZone` goes through the shared helper (`schedule-status.ts`); greppable.

## Tests / typecheck

- New: `test/bulk-unassign.e2e-spec.ts` (2), `test/bulk-unassign-execute.e2e-spec.ts` (7),
  `test/bulk-unassign-controller.e2e-spec.ts` (6) — 15 tests, 15 green.
- Fixed: `test/schedules-route-conflicts.e2e-spec.ts` — added the missing `BulkUnassignService`
  mock provider its standalone `SchedulesController` testing module needed after the wiring change;
  3/3 green.
- Touched-neighbourhood regression sweep: `dispatch-run`, `dispatch-run-controller`,
  `schedules-controller`, `schedules-route-conflicts`, `override-schedule-live`,
  `dispatch-same-day-append`, `zm-schedules-controller`, `dispatch-zone-wedge`,
  `dispatch-transactional`, `dispatch-per-se-isolation`, `zm-schedule-query`,
  `dispatch-run-detail-build-stamp` — 14 files / 51 tests green (includes the 3 above).
- One unrelated pre-existing failure observed and left alone:
  `dispatch-run-tier-override-snapshot.e2e-spec.ts` hardcodes `NOW = 2026-07-23` and an
  `expiresAt` one day later; the live `company_tier_overrides_expiry_window_chk` constraint checks
  against real wall-clock time, which has since passed that window. Confirmed via `git log`/`git
  status` that this file is untouched by this session — same failure occurs with or without these
  changes.
- `npx tsc --noEmit -p .`: clean throughout, checked after every cycle.

## REFACTOR

None beyond the process-correction revert itself (which was a full rewrite back to the tested
subset, not a refactor of working code). No dead code left from the reverted attempt — confirmed by
re-reading the final `bulk-unassign.service.ts` end to end.

## Remaining work (Slices 2–4, not started this session)

- **Slice 2** — optional `zoneId` on `POST /schedules/dispatch-run`, proven byte-identical when
  omitted.
- **Slice 3** — filter zero-live-ticket batches out of the SE day-plan and ZM schedule reads.
  Shares `day-plan-query.service.ts` with #147/#165 — coordinate, do not absorb their scope.
- **Slice 4** — OH-only admin page (Plant Deactivations pattern): two buttons, preview modal with
  class counts, typed confirmation, `audit_logs`-backed history.
