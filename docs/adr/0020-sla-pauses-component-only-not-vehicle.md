# ADR-0020: SLA Pauses Only for Component Unavailability, Never for Vehicle Unavailability

## Status

**Superseded (2026-06-08)** — vehicle unavailability *can* now pause SLA, but only via a documented **Vehicle Unavailability Report** filed by the SE (Transporter contacted, reason code, expected-availability window), recorded as `pause_reason = VEHICLE_UNAVAILABLE` + `pause_source`. **Raw readiness (`ON_TRIP`/`STALE`/`UNKNOWN`) still never auto-pauses** — the core concern of this ADR is preserved by requiring a human-documented signal. A manager-only **Secondary SLA Clock** never pauses, so paused time can't hide real aging. The component-pause rule (`WAITING_COMPONENT`) is unchanged. See `CONTEXT.md` *SLA* / *Vehicle Unavailability Report* / *Secondary SLA Clock* glossary entries and the 2026-06-08 business edits.

The decision below — "SLA pauses **only** for `WAITING_COMPONENT`, never for vehicle unavailability" — is **no longer in force**. The primary SLA clock now pauses for **two** documented reasons: `WAITING_COMPONENT` **and** `VEHICLE_UNAVAILABLE`. The second pause is triggered **only** by a filed **Vehicle Unavailability Report** (SE physically at the Plant, contacted the Transporter, recorded reason + expected-availability window). **This ADR's core reasoning still holds:** raw readiness (`ON_TRIP` / `STALE` / `UNKNOWN`) **never** pauses SLA by itself — only the documented human report does. A manager-only **Secondary SLA Clock** (never pauses) now runs alongside the primary so paused time cannot hide true aging. The `pause_reason` enum is now `{WAITING_COMPONENT, VEHICLE_UNAVAILABLE}` (was `{WAITING_COMPONENT}` only).

_Original status: Accepted._

## Context

PRD §4.7 includes `pause_when_vehicle_unavailable` as an SLA config option alongside `pause_when_component_unavailable`. The intent behind vehicle-unavailability pause is reasonable: if a vehicle is ON_TRIP, the SE cannot physically access it, so counting those hours against the submit window seems unfair.

However, vehicle readiness signals (ON_TRIP, STALE, UNKNOWN) are confidence-scored estimates — not confirmed facts. A vehicle's location is frequently uncertain in this system. Pausing SLA on an unconfirmed signal would create a mechanism that is easily gamed or silently incorrect, masking real SE inaction behind an unreliable readiness feed.

Component unavailability is structurally different: it is confirmed through a documented warehouse workflow (Component Request → Warehouse Manager approval), creates a clear paper trail, and has a defined resolution path. There is no ambiguity about whether the component is missing.

## Decision

- **SLA pauses only when a Failure Cycle enters `WAITING_COMPONENT` state** — a confirmed, documented blocker with a warehouse approval trail (see ADR-0008).
- **SLA does not pause for vehicle readiness states** (`ON_TRIP`, `STALE`, `UNKNOWN`, `WAITING_CONFIRMATION`). The system cannot confirm vehicle location with sufficient reliability to use it as a clock-freeze signal.
- The PRD's `pause_when_vehicle_unavailable` config option **defaults to off** and is effectively unused in production. It may be removed in a future cleanup.
- The Zonal Manager can see readiness status alongside SLA timers on the dashboard and can make a manual judgment call to extend or escalate — human override is the intended mechanism for genuine vehicle-unavailability situations.

## Consequences

- SLA computation logic has exactly one pause trigger: `failure_cycle.status = WAITING_COMPONENT`.
- Dashboard SLA countdown runs continuously for all other states including ON_TRIP vehicles — Zonal Manager sees both the SLA risk and the readiness state side by side.
- `SLA_EVENT_LOG` records pause/resume events with reason code; only valid reason code is `WAITING_COMPONENT`.
- Reports may show SLA "breaches" on ON_TRIP vehicles — this is intentional. It surfaces that the vehicle is inactive and unavailable, prompting either readiness resolution or manual SLA extension by the Zonal Manager.
