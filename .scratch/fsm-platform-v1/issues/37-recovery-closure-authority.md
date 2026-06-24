# 37 — Recovery closure authority + ZM decision queue + stalled flags

Status: ready-for-agent
Type: AFK

## What to build

The Recovery Ticket exception/closure-authority layer. The ZM decision queue (surfaced in Action Required) for "unable to collect" Recovery Tickets, where the ZM chooses: **Reschedule** (assign a new SE attempt on the same Ticket), **Close as FAILED_RECOVERY** (mandatory reason; `closure_type = FAILED_RECOVERY_CLOSE`), or **Escalate to Operations Head**. Manual closure (web only) from the Ticket Detail Drawer by ZM / Operations Head / CSM-acting with a mandatory reason — `closure_type` set to `ZM_MANUAL_CLOSE`, `OPERATIONS_HEAD_OVERRIDE_CLOSE`, or `CSM_ACTING_CLOSE`; full audit (`actor_id`, `actor_role`, `closure_type`, `reason`, `timestamp`, `previous_state`, `device_serial`). Manual close never silently bypasses warehouse receipt — all manual closures flagged non-standard in compliance reports. Recovery Tickets with no state progression for 14+ days surface in the ZM Action Required panel.

## Acceptance criteria

- [ ] ZM decision queue offers Reschedule / Close FAILED_RECOVERY (reason) / Escalate to OH
- [ ] Manual close by ZM / OH / CSM-acting records the correct `closure_type` + full audit fields
- [ ] Operations Head can override-close any zone (`OPERATIONS_HEAD_OVERRIDE_CLOSE`)
- [ ] Manual closures flagged non-standard in compliance reports (never silently bypass receipt)
- [ ] Recovery Tickets with no progression for 14+ days surface in ZM Action Required

## Blocked by

- #36
