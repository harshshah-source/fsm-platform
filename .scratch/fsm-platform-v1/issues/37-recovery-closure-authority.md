# 37 — Recovery closure authority + ZM decision queue + stalled flags

Status: done
Type: AFK
Done: 2026-06-25 — ZM decision-queue actions (Reschedule / Close FAILED_RECOVERY / Escalate), manual
closure authority (closure_type by acting role + full audit), OH override-close any zone, non-standard
closure compliance read, and the stalled-14d Action Required card (backend + admin). No migration (#36
pre-provisioned the enum + columns). Web-only per spec. See
`docs/progress/37-recovery-closure-authority.md`.

## What to build

The Recovery Ticket exception/closure-authority layer. The ZM decision queue (surfaced in Action Required) for "unable to collect" Recovery Tickets, where the ZM chooses: **Reschedule** (assign a new SE attempt on the same Ticket), **Close as FAILED_RECOVERY** (mandatory reason; `closure_type = FAILED_RECOVERY_CLOSE`), or **Escalate to Operations Head**. Manual closure (web only) from the Ticket Detail Drawer by ZM / Operations Head / CSM-acting with a mandatory reason — `closure_type` set to `ZM_MANUAL_CLOSE`, `OPERATIONS_HEAD_OVERRIDE_CLOSE`, or `CSM_ACTING_CLOSE`; full audit (`actor_id`, `actor_role`, `closure_type`, `reason`, `timestamp`, `previous_state`, `device_serial`). Manual close never silently bypasses warehouse receipt — all manual closures flagged non-standard in compliance reports. Recovery Tickets with no state progression for 14+ days surface in the ZM Action Required panel.

## Acceptance criteria

- [x] ZM decision queue offers Reschedule / Close FAILED_RECOVERY (reason) / Escalate to OH
- [x] Manual close by ZM / OH / CSM-acting records the correct `closure_type` + full audit fields
- [x] Operations Head can override-close any zone (`OPERATIONS_HEAD_OVERRIDE_CLOSE`)
- [x] Manual closures flagged non-standard in compliance reports (never silently bypass receipt)
- [x] Recovery Tickets with no progression for 14+ days surface in ZM Action Required

## Blocked by

- #36
