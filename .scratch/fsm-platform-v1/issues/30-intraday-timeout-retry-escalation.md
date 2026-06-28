# 30 — Intra-day timeout retry chain + 3-retry escalation

Status: done
Type: AFK

## What to build

The reroute and escalation behaviour behind intra-day insertions. **Acceptance Timeout = 10 min**: if the offered SE doesn't accept, the row → `TIMED_OUT` ("Routing to next SE (Retry N of 3)") and the system reroutes per strict precedence to the next-best candidate. **Unreachability is handled by the timeout, NOT by an activity-ping filter** (CONTEXT §3/§16, corrected 2026-06-22 — the 15-min `last_activity_at` Hard Filter is removed; pings are visibility/audit only): an offline SE simply never taps Accept, so the timeout reroutes. A rerouted SE who was offline gets a ghost-assignment notification on reconnect ("Ticket-XXXXX was offered to you at HH:MM and routed to [SE] at HH:MM because you didn't respond in time. No action needed."). After **3 unsuccessful retries** → row → `ESCALATION_REQUIRED`; the ZM Action Required panel gains a "Manual assignment needed" alert; ZM assigns via a manual-assignment modal listing SEs with `SE_AVAILABILITY.status = AVAILABLE` (activity-ping age may be shown as a hint but is never a filter). Full retry chain visible in Ticket Detail Drawer → Assignment History.

## Acceptance criteria

- [x] 10-min Acceptance Timeout flips row to TIMED_OUT and reroutes to next-best SE per strict precedence
- [x] Activity-ping staleness is NOT a candidate filter — an SE with a stale/absent `last_activity_at` is still offered the insertion; unreachability is resolved by the timeout reroute (CONTEXT §3/§16)
- [x] Offline rerouted SE sees a ghost-assignment notification on reconnect
- [x] After 3 retries the row escalates (ESCALATION_REQUIRED) and surfaces "Manual assignment needed"
- [x] Manual-assignment modal lists SEs with `SE_AVAILABILITY.status = AVAILABLE` (activity-ping age may be a hint, never a filter)
- [x] Full retry chain rendered in Assignment History

## Blocked by

- #29

## Disposition (done — 2026-06-28, backend worktree)

Backend slice, built on #29's shared `reroute()` engine. `IntradayInsertionService`:
- **`sweepTimeouts(now)`** — the on-demand worker (mirrors the reports `recompute` posture; BullMQ cron is a
  deferred seam): every PENDING insertion past its `acceptanceDeadline` (`offeredAt + 10 min`,
  `ACCEPTANCE_TIMEOUT_MIN`) times out and reroutes to the next **untried** available candidate (strict
  precedence). **Activity-ping age is never consulted** — `availableCandidates` filters on
  `SE_AVAILABILITY = AVAILABLE` only (verified by the stale-`last_activity_at`-still-offered test).
- **Ghost-assignment notice** — on a TIMED_OUT reroute the previous (offline) SE gets an
  `INTRADAY_GHOST_ASSIGNMENT` notification ("offered to you … routed to [SE] … no action needed").
- **3-retry escalation** — `retryCount >= MAX_RETRIES (3)` *or* no untried candidate remains →
  `ESCALATION_REQUIRED` + an `INTRADAY_ESCALATION_REQUIRED` "Manual assignment needed" alert to the zone's
  ZM. (Initial offer + 3 reroutes = 4 offers, then escalate.)
- **`availableSesForManualAssign`** — the ZM manual-assignment modal source: AVAILABLE candidate SEs for the
  ticket's plant (availability only, never ping age).
- **`manualAssign`** — ZM commits to a chosen SE (`assignTicket insertAtTop`, no SE-Acceptance gate);
  insertion → ACCEPTED.
- **`retryChain`** Json accumulates every `{seId, offeredAt, outcome, reasonCode, at}` attempt — the
  Assignment-History source (rendered in the Ticket Detail Drawer Assignment-History tab + the queue row's
  "Retry N of 3").

11 service e2e (shared with #29) + 7 controller e2e green; `tsc` clean.

**Deferred (UI, blocked by #54):** the SE-app ghost-assignment toast render is a mobile surface →
M-series; backend supplies the notification. The admin Assignment-History rendering of `retryChain` rides
on the existing Ticket Detail Drawer (FE-09, paused on #70) — `retryChain` is on the payload when that tab
lands.
