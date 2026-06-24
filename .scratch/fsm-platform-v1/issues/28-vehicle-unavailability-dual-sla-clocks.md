# 28 — Vehicle Unavailability Report + dual SLA clocks + readiness

Status: ready-for-agent
Type: AFK

## What to build

Vehicle-access pauses and the dual SLA clock model. On mobile, when the vehicle is not available to work, the SE sees the Transporter name + contact (tap to call) and files a **Vehicle Unavailability Report**: `reason_code` (VEHICLE_ON_TRIP / VEHICLE_NOT_AT_PLANT / DRIVER_NOT_AVAILABLE / CUSTOMER_REFUSED / OTHER), `transporter_contacted`, expected-availability window (from/to), notes, GPS if available. On submit the **primary SLA pauses** with `pause_reason = VEHICLE_UNAVAILABLE`; the system resurfaces the Ticket for scheduling at the expected-availability date. The **Secondary SLA Clock** (true elapsed, never pauses) renders only for ZM / CSM / Operations Head — never the SE. ZM reviews reports (reason, transporter contacted, expected window), can edit/confirm the date or manually resume SLA, and resolves readiness conflicts (UNKNOWN / STALE / WAITING_CONFIRMATION). Readiness colour hints (`UPCOMING_TRIP` / `ON_TRIP` / `UNKNOWN` / `STALE`) shown on SE Ticket Detail as warnings only — only `ON_TRIP` blocks normal assignment; raw readiness alone never pauses SLA and never shows a pause indicator.

## Acceptance criteria

- [ ] SE files Vehicle Unavailability Report with all fields; Transporter tap-to-call shown
- [ ] Submit pauses primary SLA with `pause_reason = VEHICLE_UNAVAILABLE`; Ticket resurfaces at expected date
- [ ] Secondary SLA Clock (never pauses) visible only to ZM/CSM/OH, never the SE
- [ ] ZM can edit/confirm expected-availability date or manually resume SLA
- [ ] Readiness hints render as warnings; only ON_TRIP blocks assignment; raw readiness never pauses SLA
- [ ] Readiness conflicts (UNKNOWN / STALE / WAITING_CONFIRMATION) resolvable by ZM

## Blocked by

- #16
