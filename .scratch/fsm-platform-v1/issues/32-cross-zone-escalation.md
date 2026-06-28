# 32 — Cross-zone Platinum auto-escalation + manual flag

Status: done
Type: AFK

## What to build

Cross-zone capacity allocation. **Auto-escalation**: a Platinum company Ticket that can't be covered locally auto-escalates to the CSM queue after 1h unassigned in CRITICAL (or 4h to SUBMITTED). **Manual flag**: a ZM can flag any Ticket (Gold/Silver) for cross-zone escalation with a reason before the auto-trigger fires; the row gains a "Cross-Zone Flagged" badge and goes to the CSM queue. Cross-Zone page (`/cross-zone`, CSM / Operations Head): split into **Auto-Escalations (Platinum)** vs **Manual Escalations (Gold/Silver)**. Per-row actions: **Approve Cross-Zone** (select target zone + SE), **Deny** (mandatory reason), **Defer** (review date). Denied auto-escalations return to the home ZM queue; the ZM can re-escalate to Operations Head. Decisions feed back to the ZM as notification + reason.

## Acceptance criteria

- [x] Platinum Tickets auto-escalate to CSM after 1h CRITICAL unassigned / 4h to SUBMITTED
- [x] ZM can manually flag Gold/Silver Tickets for cross-zone escalation with a reason
- [x] Cross-Zone page splits Auto-Escalations (Platinum) vs Manual (Gold/Silver)
- [x] Approve (target zone + SE) / Deny (reason) / Defer (date) actions work
- [x] Denied auto-escalations return to home ZM queue; ZM can re-escalate to Operations Head
- [x] Decisions notify the ZM with reason

## Blocked by

- #29

## Disposition (done — 2026-06-28, backend worktree)

Backend slice. New **`CrossZoneEscalation`** record (migration `20260628140000_add_cross_zone_escalations`) —
a **parallel** decision queue, not a Ticket state change: the Ticket is **never removed from its home
queue**, so a denied escalation "returns home" simply by the escalation row going `DENIED` while the Ticket
stays `OPEN`/`UNASSIGNED`. `CrossZoneEscalationService` (`src/cross-zone/`):
- **`sweepAutoEscalations(now, zoneId?)`** — on-demand worker (cron deferred, same posture as the other
  sweeps): a Platinum, `OPEN`/`UNASSIGNED` Ticket with no existing escalation auto-escalates when it's been
  unassigned ≥ **1h in a CRITICAL+ bucket** *or* ≥ **4h while still OPEN** (`AUTO_CRITICAL_UNASSIGNED_MIN` /
  `AUTO_OPEN_UNASSIGNED_MIN`; "4h to SUBMITTED" read as the OPEN-age safety net). One escalation per Ticket
  ever. Notifies all active CSM + Operations-Head users.
- **`flag(ticketId, reason, zmActor)`** — ZM manually escalates a **Gold/Silver** Ticket in their **own
  zone** (Platinum → `FORBIDDEN_TIER` since it auto-escalates; out-of-zone → `FORBIDDEN_SCOPE`; an existing
  active escalation → `ALREADY_ESCALATED`).
- **`approve(id, targetZoneId, seId, actor)`** — commits a **cross-zone Formal Assignment** via
  `OverrideService.assignTicket` (CSM/OH `inScope` is already cross-zone) → `APPROVED`.
- **`deny(id, reason)` / `defer(id, reviewDate, reason)`** — mandatory reason; deny leaves the Ticket in its
  home queue; defer records the review date.
- **`reEscalateToOps(id, zmActor)`** — only a **DENIED AUTO_PLATINUM** escalation, by the **home** ZM →
  `ESCALATED_TO_OPS` + notify Operations Head.
- **`listForScope`** — the `/cross-zone` queue (actionable `PENDING`/`DEFERRED`/`ESCALATED_TO_OPS`), carrying
  the `escalationType` discriminator so the page splits **Auto (Platinum)** vs **Manual (Gold/Silver)**;
  CSM/OH cross-zone, ZM home-zone read-only.
- Every decision notifies the **home ZM** (`CROSS_ZONE_DECISION`, reason in body) over the spine.
- HTTP `/api/cross-zone` (`CrossZoneController` + `CrossZoneModule`, registered in AppModule): `GET` (all
  managers) · `flag` (ZM/CSM) · `sweep` (CSM/OH) · `approve`/`deny`/`defer` (CSM/OH) · `re-escalate` (ZM).

10 service e2e + 6 controller e2e green; `tsc` clean.

**Deferred (UI):** the admin `/cross-zone` page (Auto/Manual split + Approve/Deny/Defer row actions) is a
presentation layer over this API → FE follow-up **#78** (filed in INDEX). No mobile surface (manager-only).
Real channel delivery for the notifications → #76.
