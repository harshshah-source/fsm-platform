# 268 — CRITICAL direct assignment: retire acceptance from the critical path, wire the automatic trigger

Status: done (2026-08-24) — see `docs/progress/268-critical-direct-assignment.md`
Type: AFK · Backend + Admin + Mobile (contract retirement)
Decision: #258 Q3 (no PENDING_ACCEPTANCE / no 10-min window / no accept-decline / no
acceptance-driven retry for CRITICAL) + Q2 (system path respects capacity; manual overload remains
a manager right)

## Objective

A CRITICAL-bucket ticket is assigned directly to the best eligible SE and lands at the top of their
day plan, automatically, with escalation to the ZM only when no eligible SE exists — no offer, no
timeout, no SE veto.

## Current behaviour (verified)

- `fireForZone` (`intraday-insertion.service.ts:100`) builds a PENDING_ACCEPTANCE offer with a
  10-minute deadline, reroute chain, 3-retry escalation — and has **no automatic caller**: the only
  non-test entry is `POST /intraday-insertions/fire` (`intraday-insertion.controller.ts:44-54`).
  The 2-min `business-intraday-timeout` sweep only expires offers, it never creates them.
- Candidate pick is tier-precedence `[0]` filtered to AVAILABLE (`:118`, `:532-540`) — **no
  capacity check, no score**; N critical tickets all target the same first SE.
- `accept` → `assignTicket(insertAtTop)` with the known deferral-omission defect (#265 item 4).
- Escalation path (`ESCALATION_REQUIRED` + ZM alert + `availableSesForManualAssign`/`manualAssign`)
  exists and is the piece worth keeping.
- Mobile #77 accept/decline screens + `/me/intraday-insertions` endpoints exist; push channels are
  the inert `LoggingChannelGateway`, so offers were unservable anyway — the ruling matches the
  operational reality.

## Required change

1. **Direct assignment**: replace the offer step — for each eligible CRITICAL/HIGH_CRITICAL
   `OPEN+UNASSIGNED` ticket (existing selection incl. `notDeferredOn` at `:107` — a deferral is
   never overridden by the system path), select the SE by the SAME discipline as the morning batch:
   hard eligibility (availability; capacity as an automatic constraint per Q2 — over-capacity SEs
   are not candidates for the system) → coverage tier → score (#266's selection, reused not
   re-implemented — extract the tier+score chooser into a shared function in `recommender/`) →
   `assignTicket(..., 'CRITICAL_ASSIGN', insertAtTop=true)` with SYSTEM actor. Notify the SE via
   the spine (informational, not a request).
2. **No capacity-eligible SE → escalate (Q-B, ruled 2026-08-20).** When every candidate is filtered
   out *or* every eligible candidate is at `daily_capacity`, the ticket goes to
   `ESCALATION_REQUIRED` + the existing ZM "Manual assignment needed" alert. The ZM's `manualAssign`
   may then exceed capacity — Q2's administrative right, on the existing MANAGER-RBAC path, with no
   new gate and no forced reason.
   **There is NO automatic CRITICAL-only capacity bypass**: the scheduler never self-authorises an
   overload, however urgent the ticket. Both approved rules are preserved intact — automatic
   respects capacity, authorized humans may exceed it. The escalation must be operationally visible
   (the ZM alert plus the intraday-queue row are that visibility; assert both).
3. **Automatic trigger**: repurpose the 2-min intraday sweep tick to call the direct-assign per
   zone (rename `business-intraday-timeout` → `business-critical-assign`). Sweep-based rather than
   a bucket-transition hook: it fits the existing sweep family, survives missed transitions
   (recycled tickets re-entering UNASSIGNED), and needs no new infrastructure.
   **Cron-pin coordination:** this rename and #264's new outbox sweep both edit the exact-name/count
   assertion in `scheduler-wiring.e2e-spec.ts:33-52,77-82`. Whichever lands second updates the pin
   to include the other's change — never reverts it.
4. **Retire the acceptance machinery**: `intraday_insertions` remains as the LEDGER of critical
   insertions. **Status vocabulary — corrected by the pre-implementation review: add
   `ASSIGNED_DIRECT` ONLY, and KEEP `ESCALATION_REQUIRED` exactly as spelled.** Do not introduce
   `ESCALATED_NO_CANDIDATE` or rename anything: `system-efficiency-aggregation.service.ts:214-219`
   counts `intraday_insertions WHERE status = 'ESCALATION_REQUIRED'` into the daily
   `auto_escalations` cube, and a renamed status would silently zero a live report. The status's
   *meaning* narrows (from "3 SEs declined or timed out" to "no capacity-eligible SE"); record that
   in the report's own documentation rather than changing the value.
   PENDING_ACCEPTANCE/timeout/reroute code paths are deleted with their sweeps' offer-expiry half;
   `accept`/`decline` endpoints (admin + `/me/*` mobile) are removed.
   **Sequencing — mobile and backend ship together.** Removing `/me/intraday-insertions`,
   `/accept`, `/decline` breaks the shipped #77 screens, so the backend removal and the mobile
   retirement must land in one coordinated change; the pilot is not live (#197/#209 open), which is
   what makes this acceptable rather than a migration problem. **#169 SE-API-contract impact:
   record the removal through that issue's process**, and file the mobile screen retirement in the
   M-series rather than dropping it silently (surfacing rule).
5. The manual `fire` endpoint survives as a manual sweep trigger (same code path, MANAGER-gated),
   matching the manual-trigger convention every other sweep has.

## Existing code to reuse

`assignTicket(insertAtTop)`; `CandidateSelectionService`; #266's tier+score chooser;
`SeAvailabilityService`; `committedDayLoad` (capacity read — note #178 makes it overcount closed
tickets until the 04:00 sweep; acceptable Phase 1, tightens when #178 lands); escalation + ZM alert
paths; `transitionOrConflict` for insertion-row state flips; audit vocabulary `CRITICAL_ASSIGN`.

## Data model

`intraday_insertions.status` enum gains `ASSIGNED_DIRECT`, `ESCALATED_NO_CANDIDATE` (or reuse
existing ESCALATION_REQUIRED); offer-specific columns stay for history. One migration.

**Corrected during implementation:** `offered_se_id` and `acceptance_deadline` could not stay
`NOT NULL`. Q-B's escalation can now fire with **no SE ever offered anything** (zero candidates, or
every candidate at capacity, on the very first evaluation) — there is no SE to name and no acceptance
window to bound. Both columns made nullable in the same migration
(`20260824120000_critical_direct_assign`); no sentinel value invented. See the completion report §4.

## API

Remove: `POST .../accept`, `POST .../decline`, `GET /me/intraday-insertions` (contract change,
#169). Keep: `POST /intraday-insertions/fire` (manual trigger), ZM escalation queue reads.

## UI surfaces

Admin: Intraday queue page shows direct-assignment rows + escalations (existing FE-13 surface,
status vocabulary update). Mobile: offer screen retired; the assigned ticket appears through the
normal day-plan flow (#66 cues; #201 signal).

## Reference

`docs/ui/desktop/v2-reference/` intraday queue page; `docs/ui/mobile/` day-plan screens.

## Acceptance criteria

- [x] A CRITICAL ticket becomes assigned within one sweep tick with NO acceptance state ever
      created; it sits at stop 1 of the chosen SE's plan.
- [x] SE choice honours tier precedence and score (#266 chooser — one shared implementation,
      asserted by construction/test), skips unavailable AND at-capacity SEs.
- [x] **Q-B**: every eligible SE at capacity → ticket is NOT auto-assigned to anyone; an
      `ESCALATION_REQUIRED` row + ZM alert appear; the ZM's `manualAssign` then succeeds and pushes
      that SE past capacity with no block and no forced confirm (Q2 pinned as a test).
- [x] No code path lets the system assign a CRITICAL ticket to an over-capacity SE (asserted
      negatively: capacity map exhausted → zero new `batch_assignment_tickets` rows written by the
      sweep).
- [x] `system_efficiency_summary_daily.auto_escalations` still populates from
      `ESCALATION_REQUIRED` rows after the change (cube-continuity regression). **Found and fixed in
      passing: `manual_assignments` needed the same protection** — a SYSTEM-actor `CRITICAL_ASSIGN`
      row would otherwise have counted as a human's manual assignment; excluded by `actor_role`.
- [x] A deferred CRITICAL ticket is never system-assigned (deferral honoured; #249 override remains
      human-only).
- [x] N criticals spread across eligible SEs by capacity/score instead of stacking on `[0]`.
- [x] Cron wiring pin updated (`business-intraday-timeout` → `business-critical-assign`); retired
      endpoints return 404; the mobile retirement is recorded as its own issue,
      [#279](./279-retire-intraday-offer-accept-mobile.md), and #169 has a dated comment recording
      the four route removals per its own process.

## Tests

Rework the intraday e2e family (offer/timeout specs retire; direct-assign, escalation, capacity,
deferral specs replace); sweep-wiring pin; mobile contract test update.

## Dependencies / Blocked by

**#266** (shared tier+score chooser) and **#265** (its item 4 fixes the `manualAssign` deferral
omission this issue depends on) — both are HARD prerequisites, upgraded from "or fold" by the
pre-implementation review. **#177** transitively (via #266) so the critical pool excludes
WAITING_COMPONENT tickets — otherwise direct assignment pushes component-blocked work to SEs
automatically and routinely, which is strictly worse than today's manual-only path.

## Risks

Business-visible behaviour change for SEs (work appears without consent — ruled, but the mobile
day-plan signal (#201, open) is what makes it *visible*; note the pairing in the report). Deleting
the offer machinery touches #77/#169 mobile surface — the contract step is the risk to sequence,
not the backend.

## Rollback

The offer machinery is deleted, not flagged off — rollback is a revert; the insertion ledger rows
remain readable under both vocabularies.
