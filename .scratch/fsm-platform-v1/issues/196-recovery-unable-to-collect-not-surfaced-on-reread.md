# 196 — Recovery: a filed Unable-to-Collect isn't distinguishable from a fresh ON_SITE ticket

Status: needs-triage
Type: AFK · Mobile + Backend
Origin: #68 comment (b), 2026-07-28; carried forward when #68 shipped 2026-08-04.

## What to build

`unableToCollectAt` (`schema.prisma:2056`) and `closureReason`/`unableToCollectReason`
(`schema.prisma:2058` / `RecoveryView.unableToCollectReason`, `recovery.service.ts:26-36`) exist on
the ticket but are not exposed on `MeTicketDetailView` (`me-ticket-detail.service.ts`) or
`MeTicketsView` (`me-tickets-query.service.ts`). `markUnableToCollect` (`recovery.service.ts:~178`)
sets `unableToCollectReason` and posts a `TicketEvent` but leaves `ticket.status` at `ON_SITE` (the ZM
decision, not the filing, is what closes the ticket out — see #37) — so an SE who backs out of
`UnableToCollectScreen` and reopens the same ticket sees an identical `recovery-card` (Mark On-Site
hidden correctly since status ≠ SCHEDULED, but Collection Form + Unable to Collect both still shown)
with no indication a decision is already pending with the ZM.

Add `unableToCollectReason` (+ ideally `unableToCollectAt`) to `MeTicketDetailView`, and have
`TicketDetailScreen`'s `recovery-card` render a "Pending Zone Manager decision" state instead of the
two action buttons when it's non-null.

## Acceptance criteria

- [ ] `MeTicketDetailView` carries `unableToCollectReason` (and `unableToCollectAt` if useful for
      display) for RECOVERY tickets
- [ ] `TicketDetailScreen`'s recovery card shows a "pending ZM decision" state (not the Collection
      Form / Unable to Collect buttons) once `unableToCollectReason` is set and the ZM hasn't yet
      decided (ticket still `ON_SITE`)

## UI surfaces

- **Mobile:** `TicketDetailScreen` recovery card (extends #68's surface).
- **Admin:** n/a.

## Reference

- No mockup — extends #68's PRD §567 Flow 7 basis; the "already routed to ZM, don't re-offer the
  action" behavior is implied by the same flow, not a new UI concept.

## Blocked by

- #68 (done — the surface this extends)
- #36 (done — backend fields already exist)

## Priority

Low–medium — polish/data-completeness on a shipped, working flow. Not a parity-gate violation: #68's
own ACs don't require this, and re-filing Unable-to-Collect on an already-pending ticket doesn't
corrupt data (the server-side decision queue is scoped from `TicketEvent`/ZM read models, not from
this mobile read).
