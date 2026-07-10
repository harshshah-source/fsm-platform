# ADR-0010: SE Availability Is One Time-Windowed Table; Zonal Manager and SE Are the Only Setters

## Status

Accepted

## Context

SE availability affects Recommender candidate scoring (Hard Filter: only `AVAILABLE` SEs are candidates) and manager operational oversight. Three modelling options were evaluated: separate per-dimension tables (multiple joins per Recommender tick), materialised view over source tables (refresh complexity not worth it at 40 SEs), and a single time-windowed table.

Authority was also in question — giving Admin write access to operational state conflates system configuration (Admin's domain) with operational scheduling (Zonal Manager's domain).

## Decision

SE availability is a single `SE_AVAILABILITY` table of time-windowed rows:

```
(engineer_id, from_ts, to_ts, status, reason_code, set_by, set_by_role, notes, created_at, updated_at)
```

Status enum: `AVAILABLE | ON_LEAVE | OFF_SHIFT | WEEKLY_OFF | SOFT_UNAVAILABLE | OFFLINE`.

**Authority** is restricted to:
- **Zonal Manager** — sets/approves availability for SEs in their zone (planned leave, shift exceptions, weekly-off, phone-in-sick). Cannot set availability for an SE outside their zone — cross-zone changes route through Operations Head.
- **SE** — requests leave, posts real-time `SOFT_UNAVAILABLE` flags from mobile. The mobile app's "I'm unavailable for 2h" action writes a `SOFT_UNAVAILABLE` row, auto-resolves at `to_ts`.

**Admin has no role in availability tracking.**

Reason codes: `SICK | VACATION | HOLIDAY | DOCTOR | TRAINING | PERSONAL | NETWORK_OUT | OTHER`.

## Consequences

- `SE_AVAILABILITY` enforces non-overlap per `engineer_id` per status family.
- Heartbeat-derived `OFFLINE` rows are short-lived and tagged so they don't appear as "leave" in reports.
- The Recommender's Hard Filter checks "is SE-X `AVAILABLE` at planning timestamp" via a single index intersection.
- Cross-zone availability changes route through Operations Head, preserving zone authority boundaries.
