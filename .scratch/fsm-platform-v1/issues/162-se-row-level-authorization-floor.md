# 162 — SE row-level authorization floor (coverage scoping on SE reads/writes)

Status: done (2026-08-03) — all five sites closed on `feat/autoplant-integration`, uncommitted this
session. Shared `SeCoverageService.coveredPlantIds`/`isPlantCovered` (`src/shared-pool/se-coverage.service.ts`)
extracted from `SharedPoolService` and reused by troubleshoot-submit, soft-state, and #161's merged
tickets read (no second copy — AC met). See the dated comment below for per-site detail, tests, and
the one deviation found (verification-read scope is narrower than plain coverage — "own", not
"any covered plant" — matching the issue's own 2026-07-28 correction).
Type: AFK · Backend · **Security**

Filed 2026-07-28 (`docs/status/backend-mobile-readiness-plan-2026-07-28.md` §A-§8, §B N2-N4).
`ZoneScopeGuard` passes every non-ZM unconditionally (`common/guards/zone-scope.guard.ts:27-29`),
so SE row-level security is per-endpoint discipline — and four endpoints have none.

**Measured blast radius (2026-07-28):** 13,941 OPEN troubleshoot tickets across 5 zones /
146 plants writable by any authenticated SE (was 9,280 on 07-22). One SE credential exists today;
**#91 mints 75. This issue must land no later than #91's rollout.**

## What to build

The spec-backed coverage floor (workflow:792, :2011 — an SE must never touch tickets for plants
outside their coverage) on the four unscoped sites, via one shared scoping helper (reuse the
`SharedPoolService.coveredPlantIds` ∪ floating-MV shape; build alongside #161 which needs the same
predicate):

1. **`POST /tickets/:id/troubleshoot`** — validation is existence + workType + `status==='OPEN'`
   only (`troubleshoot-submission.service.ts:107-116`). Add: ticket's plant ∈ SE coverage
   (assignment not required — the Business-409/Shadow-Use model, workflow:931-935, sanctions
   covered-plant races; covered-any vs covered-claimed is HITL-7 and does not block the floor).
2. **`POST /tickets/:id/soft-state`** — `runAdvance` never queries `tickets`
   (`soft-state.service.ts:250-288`): any SE can stamp VIEWED/ON_SITE/TROUBLESHOOT_STARTED on any
   ticket incl. CLOSED, polluting Activity Status and ZM stale-work views. Add ticket
   existence + open-ish status + coverage.
3. **`POST /component-requests/:id/confirm-receipt`** — existence + `status==='SHIPPED'` only
   (`component-request.service.ts:171-179`); any SE can flip another SE's request `RECEIVED` and
   **resume the SLA clock** (`:187`). Add `existing.seId === actor.userId`. (Latent: 0 rows today —
   arms with the component flow.)
4. **`GET /tickets/:id/verification`** — `forTicket(ticketId)` takes no user scope
   (`verification.controller.ts:103-109`); workflow:68 says SEs view outcomes on **own** tickets.
   Scope to own-submission/assigned tickets for the SE role (manager roles unchanged).

Non-goals: no change to the correctly-scoped endpoints (recovery/install `isAssignedSe`, intraday
`offeredSeId`, VU/availability self-checks, notifications ownership — all re-verified correct
2026-07-28); no ZoneScopeGuard redesign (the guard stays ZM-only; SE scoping is service-layer, per
the existing pattern).

## Acceptance criteria

- [x] An SE submitting a troubleshoot form for a ticket outside their coverage gets 403/404, never a submission row
- [x] Soft-state writes reject tickets that don't exist, are terminal, or are outside coverage; existing legal flows unchanged (e2e over the M3 soft-state ladder stays green)
- [x] Confirm-receipt by a non-owning SE is rejected; owner flow unchanged
- [x] SE verification read is own-tickets only; ZM/CSM/OH reads unchanged
- [x] One shared coverage predicate, unit-covered, reused by #161 (no second copy)
- [x] Regression: the sanctioned two-SE 409/Shadow-Use race still works for two SEs covering the same plant

## UI surfaces

n/a (authorization tightening; no surface changes).

## Reference

n/a.

## Blocked by

- None. Sequence: land before or with #91's credential rollout; build alongside #161.

## Comments

### 2026-07-28 — corrections from independent re-verification (freeze plan §1.4)

All four sites re-confirmed at HEAD by a fresh pass. Three corrections:

1. **The verification-read gap is not SE-specific.** `verification.controller.ts:103-109` →
   `verification-query.service.ts:94-109`: `forTicket(ticketId)` takes no scope argument and
   `@CurrentUser()` is not even injected, so the handler is unscoped for **every** role including
   ZONAL_MANAGER — while sibling reads (`review()` at `:117-118`, `escalateFraud` at
   `verification.service.ts:74-76`) *do* zone-scope. **The fix is a scope argument on `forTicket`,
   not an SE ownership check.** Re-scope this AC.
2. **`confirm-receipt`'s SLA side effect is dormant.** Resume is gated on `sla_resume_on_receipt`
   (`component-request.service.ts:280-285`), which defaults **OFF** and is **absent from the live
   `system_settings` table**. The unauthorised write is still real and still worth fixing: it burns
   the one-way `SHIPPED→RECEIVED` transition the genuine owner needs, and gates the ZM resubmit
   binding (`:230-232`).
3. **Soft-state nuance.** `soft_states.ticket_id` has an FK (`schema.prisma:789`), so a *fabricated*
   UUID produces a Prisma FK violation → generic 500, not silent acceptance. The exploitable surface
   is **real ticket ids the SE has no relationship to** (including CLOSED and other-zone), which is
   the substantive point — "any ticket id" overstated it.

**Exposure re-measured 2026-07-28: 14,019 OPEN troubleshoot tickets / 152 plants / 5 zones**
(was 13,941 / 146). 75 active engineers.

### 2026-07-28 — fifth site added: an SE can self-grant leave

Found by the six-screen data-needs derivation (`docs/status/se-screen-data-needs-2026-07-28.md`).
**Spec-vs-code, and it bypasses an entire approval flow.**

`POST /api/engineers/:seId/availability` accepts `SETTABLE_STATUSES` = `['ON_LEAVE','OFF_SHIFT',
'WEEKLY_OFF','SOFT_UNAVAILABLE']` (`engineers.controller.ts:68`), and the service authorises an SE
for **any** of them on themselves — the only check is `actor.userId === input.seId`
(`se-availability.service.ts:62`).

The spec is unambiguous and says the opposite:
- workflow:1338 — *"SE **cannot self-approve**. Only ZM (or acting role) can write `ON_LEAVE` or
  `WEEKLY_OFF`."*
- workflow:1360-1363 tabulates `ON_LEAVE`, `WEEKLY_OFF` and `OFF_SHIFT` as **ZM-only**.
- PRD:496 gives the SE **only** SOFT_UNAVAILABLE.

**Consequence:** the mobile app could write `ON_LEAVE` directly and skip the Leave Request flow
(#86) — no ZM approval, no `decisionReason`, no audit of an approval that never happened. It also
silently removes the SE from intraday candidate scoring (`intraday-insertion.service.ts:514`).

**Fix:** restrict the SE role to `SOFT_UNAVAILABLE` at the service layer (managers keep the full
set). Note this is an **authorization narrowing on an existing endpoint**, not a new scoping
predicate like the other four sites — but it belongs here because it is the same class: a write an
SE should not be able to make.

Not exploitable today beyond one synthetic account (#91 mints 75), and unlike the troubleshoot gap
it needs no guessed UUID — the SE simply calls it on themselves.

### 2026-07-28 — the fifth site is now COUPLED to #87's unlock

**These two must ship in the same slice.** #87 settled that `AVAILABLE` will be added to
`SETTABLE_STATUSES` so an SE can clear their own `SOFT_UNAVAILABLE` (today an open-ended one is
unrecoverable via the API by any role). **Shipping that unlock without this issue's narrowing is
strictly worse than today**: an SE would gain the ability to write `AVAILABLE` on top of a
**ZM-set `ON_LEAVE`** and clear it — turning a self-grant bug into a self-*revoke* bug against a
manager decision.

The narrowing, precisely: an SE may set **only `SOFT_UNAVAILABLE`**, and may set `AVAILABLE` **only
where the window it supersedes is their own `SOFT_UNAVAILABLE`**. Managers keep the full
`SETTABLE_STATUSES` set. Enforced at the service layer (`se-availability.service.ts:62`), where the
role check already lives.

### 2026-08-03 — closed: all five sites, built alongside #161's coverage-predicate consumer

**Shared predicate.** `coveredPlantIds` moved out of `SharedPoolService` into a new
`SeCoverageService` (`src/shared-pool/se-coverage.service.ts`, exported from `SharedPoolModule`), so
it is one definition reused by `SharedPoolService`, `TroubleshootSubmissionService`,
`SoftStateService`, and #161's `MeTicketsQueryService` — never a second copy.

1. **Troubleshoot submit** (`troubleshoot-submission.service.ts`) — coverage check added right after
   the existence/workType check, ahead of the OPEN-status branch, so an out-of-coverage SE gets 404
   without ever learning a closed ticket's conflict/winner details. `troubleshoot-controller.e2e-spec.ts`
   gained the wrong-SE case (404, zero submission rows written).
2. **Soft-state** (`soft-state.service.ts`) — `runAdvance` truly had no ticket query at all, confirmed.
   Added `assertInScope` (ticket exists, `status === 'OPEN'`, plant covered) ahead of the transaction in
   both `advance()` and `setOnSite()`; new `AdvanceOutcome.NOT_FOUND` → controller 404. "Terminal" is
   defined as "not OPEN" — the VIEWED→ON_SITE→TROUBLESHOOT_STARTED chain is a pre-submission signal
   with no meaning once the ticket has moved on; RECOVERY already has its own on-site tracking via
   `/recovery/:id/on-site`, untouched. `soft-state-controller.e2e-spec.ts` gained the wrong-SE case.
   **Ripple:** 7 direct-instantiation soft-state specs + `troubleshoot-submission.e2e-spec.ts` +
   4 more troubleshoot-consumer specs (`component-request-raise/-resubmit`, `inventory-rollback`,
   `shadow-use-conflict`) + 3 verification specs had no `se_coverage` fixture rows at all — every one
   needed a `seCoverage.create` added (or, for the resubmit spec's FLOATING SE, correctly *not* added —
   `se_coverage` has a DB check constraint rejecting FLOATING rows; Floating coverage comes only from
   the `plant_eligible_floating_se` MV, and that spec's FLOATING SE never calls `submit()` anyway).
3. **Confirm-receipt** (`component-request.service.ts`) — `existing.seId === actor.userId` check added
   ahead of the state branch; new `WmOutcome.FORBIDDEN` → 403. The shared `resolve()` in
   `warehouse.controller.ts` also needed the branch to stay exhaustive over `WmOutcome`, even though
   approve/ship/reject never produce it. `component-request-controller.e2e-spec.ts` gained the
   wrong-SE case (403, request status untouched).
4. **Verification read** (`verification-query.service.ts` / `verification.controller.ts`) — confirmed
   the 2026-07-28 correction: this was unscoped for **every** role, `@CurrentUser()` wasn't even
   injected. Added a scope argument to `forTicket`: SE → own troubleshoot submission, own RECOVERY
   `assignedSeId`, or own `BatchAssignmentTicket`→`PlantBatchAssignment.seId` (the "both paths" the
   task called out); ZONAL_MANAGER → own zone (mirrors `review()`/`escalateFraud`); CSM/OPERATIONS_HEAD
   unrestricted. **Note this is narrower than the plain plant-coverage floor used in sites 1–2** — "own
   tickets" per workflow:68, not "any covered-plant ticket" — because verification is a read of an
   individual SE's/manager's outcome, not a covered-plant race. `verification-controller.e2e-spec.ts`
   gained both the SE-wrong-ticket and ZM-cross-zone cases (both 404).
5. **Availability self-grant** (`se-availability.service.ts`) — self-set narrowed to `SOFT_UNAVAILABLE`
   only; managers keep the full `SETTABLE_STATUSES` set. **This one bit three existing fixtures that
   were, unintentionally, exercising the exact bug being fixed** — `engineers-detail.e2e-spec.ts`,
   `engineers-list.e2e-spec.ts`, and `recommender-availability.e2e-spec.ts` all self-granted `ON_LEAVE`
   as pure setup for unrelated assertions; re-pointed to a ZM actor. `engineers-availability-controller.e2e-spec.ts`
   gained both the self-SOFT_UNAVAILABLE-allowed and self-ON_LEAVE-forbidden HTTP cases.
6. **Regression (AC#6, two-SE race)** — `shadow-use-conflict.e2e-spec.ts` now seeds coverage for
   *both* winner and loser at the same plant; the test already exercised the 409/Shadow-Use race, so
   this is the sanctioned-race regression the AC asks for, not a new test.

**Verified:** `tsc --noEmit` clean; every touched/new e2e spec green individually (soft-state ×8,
troubleshoot ×2, shared-pool ×4, component-request ×5, inventory-rollback, shadow-use-conflict,
verification ×5, engineers ×4, recommender-availability, me-tickets ×1 — 90+ tests). **A green
full-suite pass could not be obtained in one shot** — three full runs (via the retry-wrapped
`node scripts/run-tests.mjs`) each hit one or both of two independent, pre-existing, already-documented
failure classes unrelated to this slice, isolated by `git stash`-ing this slice's exact file set and
re-running on the base commit:
- **#184 (Windows fork native fault, `Worker exited unexpectedly`)** — landed on a different file each
  run (`global-guard-validation`, `voucher-controller`); its own closed AC-4 evidence already names
  both files as prior victims, predating this session. Sampled 0/4-clean-tree vs. 2/6-slice-tree crash
  rate on `global-guard-validation` in isolation — too small a sample to call a regression, and the
  crash signature (child-process fault, zero JS stack) is one #184 already explains; the assertions in
  that file (including the sweep over every route this slice touches) passed 100% of the times the
  file didn't crash.
- **DB-state bleed across a full run** (`override-defer-frees-capacity`, `dispatch-run-zone-scoped`) —
  both pass clean in isolation; `dispatch-run-zone-scoped` is explicitly named in #184's own
  "out of scope" list as one of "the three DB-state failures... all #180." Neither touches code this
  slice modified (scheduling/override, not troubleshoot/soft-state/component-request/verification/
  engineers).

**One further, unrelated, pre-existing defect found incidentally**: `voucher-controller.e2e-spec.ts`
fails 3/5 (`expected 201, got 400`) deterministically — reproduced identically on the un-stashed base
commit, so this slice is not the cause. Not filed as a new issue per instruction; noted here and in
the session log for whoever next touches `#38`/vouchers.

Order within the slice: narrowing first, unlock second — never the reverse, and never separately.
