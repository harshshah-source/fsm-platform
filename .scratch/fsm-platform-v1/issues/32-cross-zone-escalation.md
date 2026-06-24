# 32 — Cross-zone Platinum auto-escalation + manual flag

Status: ready-for-agent
Type: AFK

## What to build

Cross-zone capacity allocation. **Auto-escalation**: a Platinum company Ticket that can't be covered locally auto-escalates to the CSM queue after 1h unassigned in CRITICAL (or 4h to SUBMITTED). **Manual flag**: a ZM can flag any Ticket (Gold/Silver) for cross-zone escalation with a reason before the auto-trigger fires; the row gains a "Cross-Zone Flagged" badge and goes to the CSM queue. Cross-Zone page (`/cross-zone`, CSM / Operations Head): split into **Auto-Escalations (Platinum)** vs **Manual Escalations (Gold/Silver)**. Per-row actions: **Approve Cross-Zone** (select target zone + SE), **Deny** (mandatory reason), **Defer** (review date). Denied auto-escalations return to the home ZM queue; the ZM can re-escalate to Operations Head. Decisions feed back to the ZM as notification + reason.

## Acceptance criteria

- [ ] Platinum Tickets auto-escalate to CSM after 1h CRITICAL unassigned / 4h to SUBMITTED
- [ ] ZM can manually flag Gold/Silver Tickets for cross-zone escalation with a reason
- [ ] Cross-Zone page splits Auto-Escalations (Platinum) vs Manual (Gold/Silver)
- [ ] Approve (target zone + SE) / Deny (reason) / Defer (date) actions work
- [ ] Denied auto-escalations return to home ZM queue; ZM can re-escalate to Operations Head
- [ ] Decisions notify the ZM with reason

## Blocked by

- #29
