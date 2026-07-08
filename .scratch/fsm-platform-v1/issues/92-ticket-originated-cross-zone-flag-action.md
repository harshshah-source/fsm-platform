# 92 — Ticket-originated Cross-Zone Flag action

Status: ready-for-agent
Type: AFK · Frontend
Origin: Issue 78 follow-up (2026-07-01) — surfaced building the Admin Cross-Zone page.

## Background

Issue 32 built the full cross-zone escalation backend, including a **manual flag**:
`POST /api/cross-zone/flag` `{ ticketId, reason }` — a Zonal Manager (own-zone) or CSM pushes a
**Gold/Silver** Ticket to the cross-zone (CSM/OH) queue (Platinum escalates automatically). The endpoint
is implemented, RBAC-guarded (`@Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER')`), and returns typed
errors (`TICKET_NOT_FOUND` 404, `TICKET_OUT_OF_ZONE` 403, `PLATINUM_USES_AUTO_ESCALATION` 400,
`ALREADY_ESCALATED` 409). Issue 78 shipped the Cross-Zone **decision** page (`/cross-zone`) and its
typed client already exports `apiCrossZoneFlag(ticketId, reason)`.

## Problem

The **flag action has no origination point in the Admin UI.** `flag` is a per-Ticket action
(`{ ticketId }`), initiated by the person looking at a Ticket — not a row action on the escalation
queue (an escalation row only exists *after* a flag). Issue 78 deliberately did **not** add a raw
"paste a ticket id" box to `/cross-zone` (poor UX, wrong surface). The natural home is the **Ticket
workflow** — the Ticket Detail Drawer (Issue 07, done), which already hosts per-ticket manager actions
(e.g. manual-close Recovery). Until this lands, a ZM cannot manually flag a Gold/Silver Ticket for
cross-zone help from the product at all.

## Scope

Presentation-only over the existing Issue 32 endpoint. No backend change.

- Add a **"Flag for cross-zone help"** action to the **Ticket Detail Drawer** (`/tickets/:ticketId`),
  visible to `ZONAL_MANAGER` and `CENTRAL_SERVICE_MANAGER` only.
- Collect the mandatory `reason` (Modal preferred per DESIGN-SYSTEM §5.4; a prompt is acceptable if it
  matches current house style — coordinate with #80).
- On submit call `apiCrossZoneFlag(ticketId, reason)`; on success show a confirmation / "Cross-Zone
  Flagged" affordance; map the typed errors to inline messages:
  `PLATINUM_USES_AUTO_ESCALATION` → "Platinum tickets escalate automatically", `TICKET_OUT_OF_ZONE` →
  forbidden, `ALREADY_ESCALATED` → "Already escalated".
- (Optional, same slice) a "Cross-Zone Flagged" badge on the drawer/list when an escalation exists.

## Out of scope

- Any backend change to `flag` or the escalation model.
- The decision queue itself (owned by #78).
- Re-escalate surfacing (owned by #93).

## Acceptance criteria

- [ ] ZM / CSM see a "Flag for cross-zone help" action on the Ticket Detail Drawer; SE / WM / OH do not.
- [ ] Submitting with a reason calls `POST /api/cross-zone/flag` with `{ ticketId, reason }`.
- [ ] The four typed error codes render as inline messages (no uncaught throw).
- [ ] No backend change — consumes the Issue 32 endpoint as-is.

## Dependencies

- **#32** — cross-zone flag backend (done).
- **#07** — Ticket Detail Drawer (done) — the host surface.
- **#78** — Cross-Zone admin page (done) — `apiCrossZoneFlag` client already exists.
- Soft: **#80** — Modal-ize prompt legs (share the reason-Modal pattern).

## UI placement

Ticket Detail Drawer action row (alongside existing manager actions). Optional badge on the drawer
header and the Tickets list row.

## API usage

`POST /api/cross-zone/flag` `{ ticketId, reason }` → `{ result:'OK', escalationId }` |
`404 TICKET_NOT_FOUND` | `403 TICKET_OUT_OF_ZONE` | `400 PLATINUM_USES_AUTO_ESCALATION` |
`409 ALREADY_ESCALATED`. No new endpoint.

## TDD plan (RED → GREEN → REFACTOR)

- **RED:** drawer test — action visible to ZM, hidden for SE; clicking + reason → `POST /cross-zone/flag`
  with the ticket id; a `PLATINUM_USES_AUTO_ESCALATION` response renders the inline message.
- **GREEN:** add the gated action + reason capture + error map, reusing `apiCrossZoneFlag`.
- **REFACTOR:** share the reason-capture with the existing drawer actions; preserve the selector contract.

## Priority

Low–medium. Edge operational action; unblocked now (all deps done). Place among the Admin follow-ups,
not ahead of the #70+FE-09 / report-exposure work.
