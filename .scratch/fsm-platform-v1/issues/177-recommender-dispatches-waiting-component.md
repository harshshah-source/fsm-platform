# 177 — Recommender dispatches WAITING_COMPONENT tickets

Status: ready-for-agent — **sequenced into P8 as a hard prerequisite of [#266](./266-score-selects-within-tier.md)** (2026-08-20 pre-implementation review). Two reasons: a selection rewrite belongs over a correct candidate pool, and [#268](./268-critical-direct-assignment.md)'s automatic CRITICAL direct assignment inherits this gap through the shared chooser — without the fix, component-blocked CRITICAL work would be pushed to SEs automatically and routinely rather than only via a manual path.
Type: AFK · Backend

Filed 2026-07-29 (found during the #179 bulk-unassign design investigation; companion to
[#179](./179-oh-bulk-unassign-rebalance.md) but **pre-existing and independent** of it).

## The defect

The recommender's ticket selection has **no failure-cycle-state filter**: the `where` is
`workType TROUBLESHOOT + status OPEN + assignmentState UNASSIGNED + notDeferredOn + plant/device
guards` (`recommender.service.ts:113-127`) — zero `WAITING_COMPONENT` references anywhere in
`src/recommender` (grep 2026-07-29). A component-blocked ticket (cycle `WAITING_COMPONENT`, SLA
paused, part on order — `troubleshoot-submission.service.ts:151-178`) stays OPEN by design
(ADR-0008), so the moment it is also UNASSIGNED it is dispatched like any other ticket.

The same gap exists at the intraday offer sweep: `fireForZone` selects
`status OPEN + assignmentState UNASSIGNED` with no cycle filter
(`intraday-insertion.service.ts:101-111`) — a component-blocked CRITICAL ticket can be *offered*
to an SE who cannot work it.

## How a component-blocked ticket becomes UNASSIGNED

- **Today (incidental):** ZM `REMOVE_TICKET` on a blocked ticket — `removeTicket` checks cycle
  state nowhere (`override.service.ts:134-152`). Also `DEFER_TICKET` (`:161-204`), same blindness;
  the deferral date only delays the re-dispatch.
- **After #179 (routine):** the bulk unassign sweeps component-blocked tickets deliberately
  (operator decision 2026-07-29, consequences accepted and recorded in #179's "Known accepted
  costs"). What was an incidental per-ticket path becomes a systematic one — this issue is filed
  as #179's pair for exactly that reason.

Note the legitimate one: `confirmResubmit`'s floating-SE `RETURN_TO_POOL`
(`component-request.service.ts:240-244`) unassigns **after** the cycle is back to OPEN and the part
is at the plant warehouse — that re-dispatch is correct and must keep working.

## Consequence

The new SE is handed a ticket that cannot be fixed until the part arrives: a burned capacity slot
and a wasted site visit; on site they submit `componentUnavailable` again (submit gate is
`status==='OPEN'`, `troubleshoot-submission.service.ts:116`) → a **second live
`component_request`** — the only unique on that table is `submission_id` (migration
`20260624120000:31`); there is no one-active-per-ticket guard. Two live requests, two pause
claims, WM confusion.

Exposure today: **0 `component_request` rows in dev** (measured 2026-07-29) — latent on zero rows,
the same condition the 07-22 audits warned about. Do not read the zero as safety.

## What to build

1. **Recommender**: exclude tickets whose failure cycle is `WAITING_COMPONENT` from the morning
   selection (one `where` clause on the cycle relation). The exclusion must NOT catch the
   RETURN_TO_POOL case — that cycle is already back to OPEN, so a state filter is sufficient;
   assert it in a test.
2. **Intraday sweep**: same clause in `fireForZone`'s selection.
3. **Transparency**: excluded tickets should be visible, not vanished — either an
   `unassignableReasons` bucket (`WAITING_COMPONENT`) on the run summary or a decision-trace note,
   matching how other exclusions surface (`recommender.service.ts:189-193`).
4. **Flag, decide-don't-build here**: the missing one-live-request-per-ticket partial unique on
   `component_request` is its own small hardening (same posture as
   `recommendations_one_suggested_per_ticket`) — record it; add only if trivially safe against
   existing data.

## Acceptance criteria

- [ ] A WAITING_COMPONENT ticket that is OPEN + UNASSIGNED is not recommended, not dispatched, and
      not offered intraday (e2e both paths)
- [ ] A RETURN_TO_POOL resubmit ticket (cycle back to OPEN) IS re-dispatchable (regression e2e)
- [ ] The exclusion is visible on the run's unassignable/trace surface, not silent
- [ ] #179 interplay: bulk-unassigned component-blocked tickets sit UNASSIGNED until their cycle
      returns to OPEN, then re-dispatch normally (e2e)

## UI surfaces

n/a (dispatch-run transparency drill-down may show the new reason bucket — display-only if so).

## Reference

n/a.

## Blocked by

- None. Pairs with #179 (which makes the path routine) but lands independently. Note: this narrows
  #179's accepted cost (a) — the wasted-visit leg; costs (b)/(c) (duplicate request, part/assignee
  mismatch at resubmit) remain accepted and recorded there.
