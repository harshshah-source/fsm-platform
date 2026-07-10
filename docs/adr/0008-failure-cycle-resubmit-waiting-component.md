# ADR-0008: Failure-Cycle Resubmit After Component Wait — State, Cardinality, and Ownership

## Status

Accepted

## Context

When an SE submits a Troubleshoot form with `component_unavailable=true`, the Ticket stalls waiting on a spare part. The PRD's original "one cycle → one ticket → one form" rule doesn't accommodate this: a second form submission after spare arrival would be the same Ticket, not a new one. Resubmit ownership also differs by SE type — a Dedicated SE will return to the plant anyway; a Floating SE may have moved hundreds of km.

## Decision

The "one cycle → one ticket → one form" rule is replaced with **"one cycle → one ticket → 1+ submissions"**. Each submission carries its own `client_submission_id`. Inventory transactions are tracked per submission and finalise together on auto-verification.

When `component_unavailable=true`, the Failure Cycle enters state **`WAITING_COMPONENT`** and a Component Request is opened. A `WAITING_COMPONENT` cycle exceeding **7 days** auto-escalates to the Zonal Manager.

**Resubmit ownership** when the spare arrives:

- **Dedicated SE / Multi-Plant SE** — soft ownership; original SE re-suggested first; pool fallback only if unavailable.
- **Floating SE** — geography-dependent:
  - Spare delivered to **SE's current location** → original SE re-suggested.
  - Spare delivered to **Plant warehouse** → Ticket returns to open Recommendation pool.
- **All cases require Zonal Manager confirmation** before the resubmit binding is committed.

SLA is paused at `WAITING_COMPONENT` entry; resumed at manager-confirmation, not at delivery.

## Consequences

- `FAILURE_CYCLE` state machine gains `WAITING_COMPONENT` state.
- `TROUBLESHOOTING_FORM_SUBMISSION` becomes a 1-to-many child of `TICKET`.
- `INVENTORY_TRANSACTION` rows are tagged with `submission_id`.
- `COMPONENT_REQUEST` gains `delivery_destination = SE_LOCATION | PLANT_WAREHOUSE`.
- The PRD's `VERIFICATION_PENDING_COMPONENT` literal is dropped — the Ticket stays in `OPEN` state; SE/manager UIs derive the "awaiting component" badge from the Failure Cycle state.
