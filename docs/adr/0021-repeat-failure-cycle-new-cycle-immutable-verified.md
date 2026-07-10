# ADR-0021: Repeat Failure Opens a New Cycle; VERIFIED Cycles Are Immutable

## Status

Accepted

## Context

When a repaired device fails again within 24h, the PRD lists `REPEAT` as a Failure Cycle state but also states (§4.6, rule 3): "If same device re-fails after closure, create new failure cycle." These two rules could be read as contradictory: does REPEAT mutate the old cycle, or does it describe the new one?

Two models were considered:
1. **Reopen the old cycle** — update the VERIFIED cycle to REPEAT status. Simpler cardinality (one cycle per inactivity episode chain), but violates the immutability of closed audit records and conflates two distinct inactivity episodes.
2. **New cycle with REPEAT status** — the old cycle stays VERIFIED and closed; a new Failure Cycle opens for the new inactivity episode, flagged `repeat_failure = true`, linked via `previous_failure_cycle_id`. Two episodes, two audit records.

## Decision

- When a device re-fails within 24h of a prior `VERIFIED` closure, a **new Failure Cycle** is created for the new inactivity episode.
- The new cycle opens with `status = REPEAT` and `repeat_failure = true`, linked to the prior cycle via `previous_failure_cycle_id`.
- The prior `VERIFIED` cycle **remains VERIFIED and immutable** — it is never reopened or updated.
- **Repeat detection** (setting `repeat_failure = true`) is event-driven at new-cycle creation — immediate, no lag.
- **3+ escalation** (escalating to Zonal Manager and Warehouse Manager) runs as a **daily batch job** — once per day, scans all devices with `repeat_failure = true` and counts cycles in the last 7-day window. Up to 24h lag between the third repeat occurring and escalation firing; this is acceptable given the 7-day window makes the pattern visible well in advance.
- "Repair completion" for the purposes of the 24h repeat window is defined as **GPS-verified closure** (`failure_cycle.status = VERIFIED`) — not form submission. A submitted form that failed verification did not complete the repair.

## Consequences

- `FAILURE_CYCLE` is append-only: once a cycle reaches a terminal state (`VERIFIED`, `FAILED`, `ESCALATED`), no fields change.
- `DEVICE_REPEAT_FAILURE_LOG` links chains of repeat cycles for reporting and escalation.
- At new-cycle creation, the system checks `FAILURE_CYCLE` for a prior `VERIFIED` cycle on the same `device_id` within the last 24h. If found: set `repeat_failure = true`, `status = REPEAT` — event-driven, immediate.
- A **daily batch job** (runs once per day) scans all devices with `repeat_failure = true`, counts `REPEAT` cycles per `device_id` in the last 7 days. If count ≥ 3, fires escalation to Zonal Manager and Warehouse Manager for that device.
- Reports distinguish `REPEAT` cycles from first-time `OPEN` cycles, exposing chronically failing devices.
