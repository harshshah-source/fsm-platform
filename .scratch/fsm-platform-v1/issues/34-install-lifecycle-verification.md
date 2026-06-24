# 34 — Install lifecycle + verification + serial visibility

Status: ready-for-agent
Type: AFK

## What to build

The SE Install workflow and its verification. Install Tickets appear in the Day Plan with lifecycle SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED. SE marks ON_SITE, then FITTED via the Install Form: GPS device serial (mandatory), SIM serial (mandatory), installation photo (optional) → Ticket → ACTIVATED and GPS auto-verification begins (waits for the first valid ping post-fitment, tracking the new `device_id`). First valid ping → push "Installation verified — Ticket CLOSED". If no ping within the expected window → FAILED_ACTIVATION push so the SE can return or escalate. Warehouse Manager sees GPS + SIM serial numbers on Install Tickets to verify component usage. (Per LLD open item #5, no geofence is applied to the first post-fitment ping in v1 — no prior location known.)

## Acceptance criteria

- [ ] Install lifecycle SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED enforced
- [ ] FITTED captures mandatory GPS device serial + SIM serial (optional photo)
- [ ] ACTIVATED triggers install verification tracking the new `device_id`
- [ ] First valid ping closes the Ticket with a verified push; timeout sets FAILED_ACTIVATION with push
- [ ] Warehouse Manager can see GPS + SIM serials on Install Tickets
- [ ] No geofence applied to the first post-fitment ping (v1)

## Blocked by

- #33
- #18
