# ADR-0009: Auto-GPS Verification Is Three-Phase; ±500m Applies Only to the First Post-Submission Ping

## Status

Accepted

## Context

The PRD's original rule required every verification ping to fall within ±500m of the SE's confirmed submission location. This produced false `FAILED_VERIFICATION` outcomes whenever a vehicle moved after the 1-hour stability wait — which is exactly what a freshly-repaired GPS-equipped vehicle does. The rule conflated proof-of-repair (device works) with proof-of-co-location (device is where it was last seen).

## Decision

Auto-verification runs in three phases:

**Phase 1 — Recovery Confirmation (15–30 min after form submission)**
- Requires ≥3 valid pings, spanning ≥15 min, with no gap >30 min.
- The **first** valid ping must fall within ±500m of the SE's confirmed submission location *or* inside the Plant geofence.
- This is the only phase with a geographic constraint.

**Phase 2 — Stability (1h after Phase 1's first ping)**
- Device must keep pinging with no gap >30 min.
- Movement is welcome and expected — no geographic constraint.
- Coverage gaps >30 min do **not** flip to `FAILED_VERIFICATION`; they leave the Ticket in `VERIFICATION_PENDING` and continue monitoring.

**Phase 3 — Close**
- Transitions the Ticket to `CLOSED` once Phase 2 passes.
- No further geographic constraint.

For device replacements, verification follows the **new** `device_id`'s pings.

## Consequences

- Auto-verification service persists `se_gps_lat/lon` from `TROUBLESHOOTING_FORM_SUBMISSION` for the Phase-1 check.
- A device pinging from a wildly-wrong Phase-1 location (e.g., 100km off) raises a fraud-investigation flag visible to the Zonal Manager.
- Reports distinguish `FAILED_VERIFICATION (no pings)` from `FAILED_VERIFICATION (fraud flag)`.
- Only the 24h overall escalation flips `VERIFICATION_PENDING` to a failed state.
