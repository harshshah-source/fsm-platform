# ADR-0023: SE Activity Status Is Derived at Query Time, Never Stored

## Status

Accepted

## Context

PRD §4.25 lists SE statuses (`AVAILABLE`, `ON_SITE`, `BUSY`, `SHIFT_ENDING`, `OFFLINE`) for display on the Zonal Manager dashboard. CONTEXT.md already defines `SE_AVAILABILITY.status` (`AVAILABLE | ON_LEAVE | OFF_SHIFT | WEEKLY_OFF | SOFT_UNAVAILABLE | OFFLINE`) as the canonical stored planning flag used by the Recommender's Hard Filter.

These two sets of statuses share some names but serve entirely different purposes:
- `SE_AVAILABILITY.status` answers: *"Is this SE eligible for a Day Plan today?"* — a planning-level flag, set intentionally by Zonal Manager or SE.
- SE Activity Status answers: *"What is this SE doing right now?"* — a real-time display label derived from ticket soft states, heartbeat, and shift schedule.

Storing the Activity Status as a separate field would create two sources of truth that drift: a stale `BUSY` stored value would show a false-busy SE whose TROUBLESHOOT_STARTED soft state expired hours ago.

## Decision

- **SE Activity Status is never stored.** It is computed at query time from three sources:
  1. `SE_AVAILABILITY.status` — if not `AVAILABLE`, that status takes precedence (ON_LEAVE, OFF_SHIFT, etc.)
  2. Active ticket soft states — if `AVAILABLE` and holds a TROUBLESHOOT_STARTED soft state → `BUSY`; holds VIEWED or ON_SITE soft state → `ON_SITE`
  3. Shift schedule + heartbeat — if `AVAILABLE`, within 1h of `shift_end` → `SHIFT_ENDING`; `last_heartbeat_at < now - 1h` → `OFFLINE`
- **`SE_AVAILABILITY.status` remains the canonical stored model** (ADR-0010). The Activity Status displayed on PRD §4.25's SE Activity page is always a derived label.
- PRD §4.25's enumeration of `ON_SITE`, `BUSY`, `SHIFT_ENDING` are **display labels only** — not database enum values, not stored fields.

## Consequences

- The SE Activity query is a JOIN across `SE_AVAILABILITY`, `TICKET` (soft states), and `ENGINEER_MASTER` (heartbeat, shift times). It must be efficient — Redis cache or materialised view recommended for the dashboard polling interval.
- Ticket soft state expiry (VIEWED 1h, ON_SITE 4h, TROUBLESHOOT_STARTED 6h) automatically refreshes the displayed Activity Status on next query — no separate cleanup needed for the display layer.
- Reporting on "time spent ON_SITE" or "time spent BUSY" is derived from `TICKET_STATE_HISTORY` (soft state log) and `WORK_ACTIVITY_LOG`, not from a stored Activity Status field.
- Any future request to add a new Activity Status display label requires no schema change — only a new derivation rule in the query layer.
