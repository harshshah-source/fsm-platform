# 07 — Ticket List & Detail Drawer

Status: done
Type: AFK
Progress: DONE (2026-06-21) — strict TDD slices A–D. Backend 149 tests / 44 files + admin 24 tests /
10 files, both typecheck clean. Decision: built `ticket_events` (LLD spine) now; retrofitted Issue 05's
TicketCreationService to write the OPEN event. List zone-scoping added (ZM own zone). PARTIAL_RECOVERY
+ FRAUD badges deferred (verification data is Issue 18/19). See docs/progress/07-ticket-list-detail-drawer.md.

## What to build

The Ticket List (`/tickets`) and the inline Ticket Detail Drawer (`/tickets/:ticketId`). List filterable by `work_type`, `status`, `company`, `plant`, SLA bucket, and assignment state; default sort SLA bucket descending; colour-coded bucket badges. Inline badges: `WAITING_COMPONENT` (amber + days elapsed), `PARTIAL_RECOVERY` (teal + N/3 pings), `REPEAT FAILURE` (flame + link to prior cycle), `ESCALATED`, `FRAUD FLAG` (distance delta), `CLOSED_AUTO_RECOVERY` (grey "auto"). Clicking a row slides in the Detail Drawer (list stays visible) with tabs: Overview, Lifecycle, Forms, Verification, Components, Assignment History. Tabs render the data that exists now and gain content as later slices land.

End-to-end: a ZM filters the list to a slice of their zone, opens a ticket, and sees its lifecycle/overview from real data.

## Acceptance criteria

- [x] List filters (work_type, status, company, plant, bucket, assignment state) produce correct row subsets
- [x] Default sort is SLA bucket descending with correct colour-coded badges
- [x] Inline badges render for each documented condition (PARTIAL_RECOVERY/FRAUD await verification data — Issue 18/19)
- [x] Detail Drawer opens inline over the list with the six tabs
- [x] Overview + Lifecycle tabs render real ticket data (actor, role, timestamp per transition)
- [x] Role/zone scoping enforced

## Blocked by

- #05
