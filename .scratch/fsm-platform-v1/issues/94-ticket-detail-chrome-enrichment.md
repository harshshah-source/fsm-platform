# 94 — Ticket Detail chrome enrichment (status tiles / readiness / assignment / manager controls)

Status: ready-for-agent
Type: AFK · Backend (read enrichment) + Frontend (drawer chrome)
Origin: FE-09 follow-up (2026-07-01) — surfaced finishing the Ticket Detail Drawer.

## Background

FE-09 brought the Ticket Detail Drawer's **data tabs** to real data: Forms (via #70), Verification
(via the Issue 18 `GET /tickets/:id/verification` read), and Assignment History (derived from the
loaded `ticket.lifecycle`). The recovery manual-close reason is now a `Modal` (AC#3), and no stub tabs
remain. What is **not** done is the full `08`/`28` reference **chrome**: the status-tile row, the named
meta chip row, the Readiness-Evidence / Dispatch-Field-Activity panels, and the Manager-Controls /
Critical-Facts right column (FE-09 AC#1 + AC#4).

## Problem — why the backend cannot support the chrome

Reference `08-ticket-detail.png` shows data the current ticket-detail read does **not** carry:

- **Status-tile row:** PRIMARY SLA + SECONDARY SLA **clock durations** ("1d 9h"), **readiness**
  ("Assignable / AVAILABLE FOR REPAIR"), and the **assigned SE name** ("Karan Singh"). The payload has
  only `slaBucket`, `assignmentState`, `failureCycleState` — no elapsed clocks, no readiness label, no
  assignee name.
- **Meta chip row:** PLANT / COMPANY / TRANSPORTER / ZONE by **name**. The payload carries only
  `plantId`/`companyId` (numeric ids) and no transporter/zone at all.
- **Readiness Evidence + Dispatch & Field Activity** panels: last-ping time, last SE action, coverage,
  captured-at — none present in the payload.
- **Critical Facts** (ON_TRIP blocker / SLA paused / failed-verification / component-blocker / repeat)
  as a consolidated read.

Per the CLAUDE.md **parity gate**, a missing *internal* backend read is a backlog gap to escalate, not
to stub or fabricate. FE-09 therefore shipped the backed pieces and filed this issue for the rest.

## Repository evidence

- `apps/admin/src/api/tickets.ts` — `TicketDetail` fields: no SLA durations, readiness, assignee name,
  or entity names; ids only.
- `apps/backend/src/ticketing/ticket-query.service.ts` — `getById` selects the ticket + lifecycle; no
  clock/readiness/assignment-name projection.
- `docs/ui/desktop/v2-reference/08-ticket-detail.png`, `28-tickets-drawer.png`, `09-...readonly.png`.

## Scope

- **Backend:** extend the ticket-detail read (or a sibling `GET /tickets/:id/detail-extras`) with the
  chrome data — dual SLA clock elapsed values (primary + never-pausing secondary), readiness
  label/evidence, assigned SE (id + name), named plant/company/transporter/zone, and the Critical-Facts
  booleans. Zone-scoped like `getById`.
- **Frontend:** render the `08`/`28` chrome — ID header band, named meta chip row, four status tiles,
  Readiness-Evidence + Dispatch panels, and the Manager-Controls + Critical-Facts right column.
- **AC#4:** Manager Controls render **read-only for Operations Head** (reference `09`).
- **AC#5:** omit superseded states (no `REVIEW_PENDING` / SE-Confirmation / `trust_score`).

## Acceptance criteria

- [ ] Backend read returns SLA clocks, readiness, assigned-SE (id+name), named entities, critical facts.
- [ ] Drawer renders the status-tile row + named meta chips + readiness/dispatch panels + right column.
- [ ] Manager Controls are read-only for Operations Head.
- [ ] Existing drawer selector contract preserved (`role="complementary"`, the six tabs, the tab data
      already wired by FE-09, `recovery-manual-close` + its Modal).

## Dependencies

- **FE-09** (tab data + Modal — done) is the base; this completes its AC#1 + AC#4.
- Reads relate to Issues 05 (SLA/bucket), 11/13 (assignment/override), 28 (dual SLA clocks), 09 (coverage).

## TDD plan (RED → GREEN → REFACTOR)

- **RED (backend e2e):** seed a ticket with an assignment + SLA state; assert the enriched read returns
  clocks/readiness/assignee/named-entities/critical-facts; zone-scope 404 preserved.
- **GREEN:** add the projection/endpoint.
- **RED (admin):** the drawer renders the status tiles + named meta + right column; Ops-Head sees Manager
  Controls read-only.
- **GREEN:** build the chrome; **REFACTOR:** extract `DeviceDetailHeader`/`ManagerControlsPanel`/
  `CriticalFactsList` compositions (FE-09 "reusable components introduced").

## Priority

Low–medium. Presentation-fidelity + a read enrichment; the drawer is fully functional without it
(all data tabs + actions work). Place with the Admin-parity follow-ups, not ahead of report exposure.
