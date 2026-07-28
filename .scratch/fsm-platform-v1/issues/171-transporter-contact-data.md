# 171 — Transporter contact data (schema + ingestion source)

Status: ready-for-human
Type: HITL · Backend · Schema

Filed 2026-07-28 (`docs/status/mobile-backend-freeze-plan-2026-07-28.md` §1.1, F2.5).
**The most expensive thing in the mobile programme to discover late**, and it was found once —
by the field-level screen derivation, in a single pass.

## The problem

Three SE mobile screens require **tap-to-call / WhatsApp the transporter**:
the Tickets list (`Call` and `WhatsApp` buttons per row, `docs/ui/mobile/tickets-priority-view.png`),
Ticket Detail, and the Vehicle Unavailability flow — PRD §484, §513.1, §549.1 all specify
"Transporter name + contact number (tap to call)".

**There is no phone column.** `transporters` carries exactly
`transporterId, sourceTransporterId, name, companyId, status, createdAt, updatedAt`
(`prisma/schema.prisma:1742-1754`). No phone, no WhatsApp, no contact person, no email.

This is not a payload gap — it is a **migration plus a data-sourcing decision**, which is why it
cannot be treated as an additive change late in the build.

## Decisions required (operator)

1. **Is transporter contact data in the AutoPlant master?** If `mst_transporter` (or equivalent)
   carries a phone, this is an ingestion mapping. If not, it is FSM-owned data requiring an admin
   entry surface and an ownership policy. **Nobody has asked this question yet** — it needs your
   knowledge of the source schema.
2. **If FSM-owned:** who maintains it, and what does the SE see when it is absent? (The UI has no
   empty state for a missing number.)
3. **Is one number enough**, or does the design need a contact person + role + separate WhatsApp
   number? The images show one `Call` and one `WhatsApp` button.

## What to build (once decided)

- Migration adding contact fields to `transporters` (+ an FSM-owned side table if the master is
  authoritative and must not be written to — the `plant_deactivations` anti-drift pattern from #119
  is the precedent).
- Ingestion mapping if sourced, or an admin maintenance surface if FSM-owned.
- Expose on the SE ticket read (**#161**) and shared pool (**#165**) payloads.
- An explicit "no contact on file" state in the contract, so the client renders something honest.

## Acceptance criteria

- [ ] Transporter contact is available on every SE surface the PRD requires it (3 screens)
- [ ] The source of truth is decided and documented; if ingested, it survives a master-sync run
- [ ] Absent contact data is representable in the contract and rendered honestly
- [ ] If FSM-owned, an admin surface exists to maintain it

## UI surfaces

- **Admin:** transporter contact maintenance (only if FSM-owned — else n/a).
- **Mobile:** consumed by #56/#57/#64; those issues own the buttons.

## Reference

- `docs/ui/mobile/tickets-priority-view.png` (Call / WhatsApp buttons), `ticket-detail-ready.png`.

## Blocked by

- Operator decisions above (D-3).
