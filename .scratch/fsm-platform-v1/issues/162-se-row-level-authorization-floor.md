# 162 — SE row-level authorization floor (coverage scoping on SE reads/writes)

Status: ready-for-agent
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

- [ ] An SE submitting a troubleshoot form for a ticket outside their coverage gets 403/404, never a submission row
- [ ] Soft-state writes reject tickets that don't exist, are terminal, or are outside coverage; existing legal flows unchanged (e2e over the M3 soft-state ladder stays green)
- [ ] Confirm-receipt by a non-owning SE is rejected; owner flow unchanged
- [ ] SE verification read is own-tickets only; ZM/CSM/OH reads unchanged
- [ ] One shared coverage predicate, unit-covered, reused by #161 (no second copy)
- [ ] Regression: the sanctioned two-SE 409/Shadow-Use race still works for two SEs covering the same plant

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
