# 237 — Devices that fail to commission and carry no ticket are invisible to dispatch

Status: needs-triage
Type: Backend/Product · Ticketing

Filed 2026-08-13, a follow-up from [#236](./236-commissioning-device-list-and-dispatch.md), which put
the Commissioning Cohort's device list on the page for the first time and made the size of this gap
visible rather than theoretical.

## The gap

A device that was fitted and simply never reported may have **no open ticket** at all. #236's Assign SE
control reads this honestly — a row with no `openTicketId` shows "No open ticket" and offers no control
— rather than papering over it, and that honesty is what makes the size of the gap visible for the
first time.

**Correction while filing this:** the first draft of this issue named
[#229](./229-auto-recovery-sweep-unwired.md)'s auto-recovery sweep as the mechanism that would fix
this. That is wrong and worth recording so nobody repeats it — #229's `AutoRecoveryService` only
**closes** tickets (it re-checks `latest_gps_datetime` freshness on already-open tickets and closes the
ones that turn out to be false positives); it does not create anything. The actual ticket-creation path
is `TicketCreationService.createForInactiveEligible` (called from `ingestTelemetry` + `runPipeline`,
per #229 §"wiring"). Whether *that* mechanism's eligibility gate covers a device whose
`latest_gps_datetime` has never been set at all (true `NEVER_REPORTED`, not merely stale) is the actual
open question — not investigated further here; see "What needs deciding" below.

## Measured, not estimated

Queried directly against the live dev backend (`GET /api/devices?commissionedWithinDays=90&status=
NEVER_REPORTED`, as `ops.head@fsm.test`) while #236 was being built — not through the admin UI, which
the Chrome extension could not reach this session (see #236's "Not done" note):

| | |
|---|---|
| Devices `NEVER_REPORTED` within the last 90 days (server-side total) | **573** |
| Sampled (first page, `limit=200`) | 200 |
| — with no open ticket at all | **79 (40% of the sample)** |
| — with an open ticket (assignable) | 121 (60% of the sample) |

The commissioning cohort's own `failed` bucket (past the 48h grace window, `population=operational`,
90-day window) measured **127** fitments at the same moment. `NEVER_REPORTED` is a broader, device-
grain vocabulary than the cohort's fitment-grain `failed` (it also includes devices still inside the
grace window), so the two numbers are not directly comparable — see #236's device-list scope-note for
why reconciling them would mean inventing a second definition. Both point the same direction: a
substantial share of devices that failed to commission have nothing dispatchable against them.

573 is itself a lower bound — it is `NEVER_REPORTED`, not `NEVER_REPORTED AND no open ticket`; the
79-of-200 ratio on the sample is the actual "nothing owns this" rate and has not been measured against
the full 573.

## What needs deciding (investigation + product, not mechanical)

- **Does `createForInactiveEligible` already fire for a device with no `latest_gps_datetime` at all?**
  Unknown as of filing. If it does, the 79 no-ticket devices are a wiring/timing gap (a scheduler or
  manual-trigger cadence question), not a missing capability — much cheaper to close than it looks. If
  it does not (its gate may require a prior fix to measure staleness against), this needs a genuinely
  new path — a `COMMISSIONING_FAILED` ticket origin, distinct from troubleshoot/install/recovery.
- **SLA and priority**, if a new origin is needed. A device that has never reported is a different risk
  profile from one that went dark after reporting — its own SLA clock, or inherit troubleshoot's?
- **Dedup on re-fitment.** A device re-mapped during the window (6.4% of cohort devices carry more than
  one fitment in 90 days, per #235) must not accumulate one ticket per fitment for the same silence.

## Non-goals

- Not re-litigating #229 — that issue owns the auto-recovery *closure* path and its own operator-gated
  decisions; this issue is about *ticket creation* for never-reported devices, a different mechanism.
- Not a change to #236's Assign SE control — its "No open ticket" branch is correct as built and stays
  exactly that until this issue decides what, if anything, should exist to assign instead.
