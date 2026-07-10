# ADR-0014: Non-Operational Marking Requires Dual Confirmation; Recurring-Deal Devices Trigger a Recovery Ticket

## Status

Accepted

## Context

Marking a Device Non-Operational excludes it from Fleet Uptime and stops new Failure Cycles. In recurring deals the device is provider-owned; a unilateral customer mark could lose the asset. A unilateral manager mark could alienate customers whose vehicles are being silently delisted. An SE driving to "fix" a scrapped vehicle is a real, expensive mistake.

## Decision

Non-Operational marking is a multi-step workflow with the following lifecycle: `REQUESTED → AWAITING_<OTHER_PARTY>_CONFIRMATION → CONFIRMED → ACTIVE → EXPIRED | UNMARKED`.

- Initiator (Zonal Manager, Operations Head, or Customer) creates the row in `REQUESTED`.
- The system routes for the **other party's confirmation**: Manager-initiated marks await Customer confirmation (one-time tokenised email link in v1); Customer-initiated marks await Zonal Manager confirmation.
- If the other party doesn't respond within **7 days**, Operations Head can override-confirm with an explicit audit reason.

Only when state reaches `CONFIRMED` does the marking take effect:
- New Failure Cycle creation for this Device is **blocked** (hard pause).
- Any **in-flight** Ticket auto-closes as `CLOSED_NON_OPERATIONAL` with a back-reference to the marking row.
- If the Device's **Deal Type is `RECURRING`** *and* the reason ∈ `{VEHICLE_SCRAPPED, VEHICLE_SOLD, COMPANY_PAUSED, DEVICE_REPLACEMENT_PENDING}`, a **Recovery Ticket** (`work_type = RECOVERY`) is auto-created and enters the Recommender.
- The Device is excluded from Fleet Uptime Eligible denominator for the duration of `CONFIRMED/ACTIVE`.

**Reason codes**: `VEHICLE_SCRAPPED | VEHICLE_SOLD | VEHICLE_ACCIDENT | COMPANY_PAUSED | DEVICE_REPLACEMENT_PENDING | COMPLIANCE_HOLD | OTHER` (OTHER requires free-text).

**Effective window**: default 90 days (`VEHICLE_SCRAPPED` / `VEHICLE_SOLD` default to 365 days). Auto-lifts to `EXPIRED` if not renewed before expiry.

## Consequences

- `Device.deal_type` sourced from CRM/SAP; falls back to Operations Head manual tagging in Settings (acceptable v1 gap).
- `NON_OPERATIONAL_MARKING` carries: `initiated_by_role`, `initiated_at`, `awaiting_role`, `confirmed_by_role`, `confirmed_at`, `effective_from`, `effective_to`, `reason_code`, `notes`, `state`.
- Operations Head override-confirms are flagged in reports so audit can spot patterns of bypassed customer confirmation.
- `CLOSED_NON_OPERATIONAL` is a distinct Ticket close reason — reports don't conflate marking-related closures with normal repair success or verification failure.
- Customer portal for confirmation is a v2 roadmap item; v1 uses tokenised email.
