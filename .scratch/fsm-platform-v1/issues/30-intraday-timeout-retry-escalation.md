# 30 — Intra-day timeout retry chain + 3-retry escalation

Status: ready-for-agent
Type: AFK

## What to build

The reroute and escalation behaviour behind intra-day insertions. **Acceptance Timeout = 10 min**: if the offered SE doesn't accept, the row → `TIMED_OUT` ("Routing to next SE (Retry N of 3)") and the system reroutes per strict precedence to the next-best candidate. **Unreachability is handled by the timeout, NOT by an activity-ping filter** (CONTEXT §3/§16, corrected 2026-06-22 — the 15-min `last_activity_at` Hard Filter is removed; pings are visibility/audit only): an offline SE simply never taps Accept, so the timeout reroutes. A rerouted SE who was offline gets a ghost-assignment notification on reconnect ("Ticket-XXXXX was offered to you at HH:MM and routed to [SE] at HH:MM because you didn't respond in time. No action needed."). After **3 unsuccessful retries** → row → `ESCALATION_REQUIRED`; the ZM Action Required panel gains a "Manual assignment needed" alert; ZM assigns via a manual-assignment modal listing SEs with `SE_AVAILABILITY.status = AVAILABLE` (activity-ping age may be shown as a hint but is never a filter). Full retry chain visible in Ticket Detail Drawer → Assignment History.

## Acceptance criteria

- [ ] 10-min Acceptance Timeout flips row to TIMED_OUT and reroutes to next-best SE per strict precedence
- [ ] Activity-ping staleness is NOT a candidate filter — an SE with a stale/absent `last_activity_at` is still offered the insertion; unreachability is resolved by the timeout reroute (CONTEXT §3/§16)
- [ ] Offline rerouted SE sees a ghost-assignment notification on reconnect
- [ ] After 3 retries the row escalates (ESCALATION_REQUIRED) and surfaces "Manual assignment needed"
- [ ] Manual-assignment modal lists SEs with `SE_AVAILABILITY.status = AVAILABLE` (activity-ping age may be a hint, never a filter)
- [ ] Full retry chain rendered in Assignment History

## Blocked by

- #29
