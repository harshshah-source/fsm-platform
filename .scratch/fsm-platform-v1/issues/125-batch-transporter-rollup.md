# 125 — Batch-level transporter rollup for dispatch transparency
Status: ready-for-agent
Type: AFK

> Source: #123 transparency enrichment (2026-07-16). Adding plant/company/transporter context to the
> drill-down tables surfaced that transporter has no clean batch-level value.

## Problem

The enrichment added `companyName` to zone-detail **batch rows** (derived from the batch's tickets via
`distinctLabel` — a batch is one plant, normally one company). Transporter, however, is
**per-vehicle-per-ticket** (`ticket.vehicle.transporter`), and a batch's tickets can span vehicles from
different transporters — so there is no single honest transporter value for a batch row. Rather than
reshape the batch row or invent an aggregate, transporter was surfaced only at the per-ticket levels
(assignment rows + trace identity strip) where it is unambiguous.

## What to build

Decide and implement a batch-level transporter treatment (if any is wanted):
- Option A — a `transporters` summary on the batch row (distinct set, e.g. "Blue Dart +2"), mirroring the
  `distinctLabel` company approach; or
- Option B — leave batch rows without transporter (transporter lives at the ticket level only) and close
  this as "won't do" with the reasoning recorded.

Keep it observe-only; no dispatch behavior change.

## Acceptance criteria

- [ ] A decision is recorded (A or B) with the domain reasoning.
- [ ] If A: `DispatchBatchRow` carries a distinct-transporter summary, e2e asserts it, FE shows it under
      the existing plant/company subtitle without adding a column.
- [ ] Existing transparency e2e + admin suites stay green.

## Blocked by
None — extends the #123 query service (`getZoneDetail` batch mapping).
