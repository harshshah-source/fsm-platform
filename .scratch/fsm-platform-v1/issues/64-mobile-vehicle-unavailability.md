# 64 — SE mobile Vehicle Unavailability file screen + Transporter tap-to-call + readiness hints

Status: ready-for-agent
Type: AFK

## What to build

The SE-side mobile half of Issue 28. On a Ticket the SE cannot work, the mobile app shows the
**Transporter name + contact (tap-to-call)** and a **Vehicle Unavailability Report** form:
`reason_code` (VEHICLE_ON_TRIP / VEHICLE_NOT_AT_PLANT / DRIVER_NOT_AVAILABLE / CUSTOMER_REFUSED /
OTHER), `transporter_contacted`, expected-availability window (from/to), notes, GPS if available —
posting to the existing `POST /api/vehicle-unavailability` endpoint (built in Issue 28). The SE
**never** sees the Secondary SLA Clock. Readiness **colour hints** (`UPCOMING_TRIP` / `ON_TRIP` /
`UNKNOWN` / `STALE`) render on the SE Ticket Detail as **warnings only** — only `ON_TRIP` blocks
normal assignment; the hint never shows a pause indicator and raw readiness never pauses the SLA.
Readiness hint *source* depends on Issue 65 (vehicle readiness source); ship the warning chip against
the readiness seam shape and wire to the real source when 65 lands.

## Acceptance criteria

- [ ] SE Ticket Detail shows Transporter name + contact with tap-to-call
- [ ] SE files a Vehicle Unavailability Report (all fields) → `POST /api/vehicle-unavailability`
- [ ] SE never sees the Secondary SLA Clock (manager-only)
- [ ] Readiness colour hints render as warnings on Ticket Detail; only ON_TRIP blocks; no pause indicator

## UI surfaces

- **Mobile:** SE Ticket Detail — Transporter tap-to-call + Vehicle Unavailability form + readiness hint chip. Owned by this issue.
- **Admin:** n/a (ZM review page built in Issue 28).

## Reference

- `docs/ui/mobile/troubleshooting.png.png` (Ticket Detail / unable-to-work path)
- `docs/ui/desktop/v2-reference/11-vehicle-unavailability.png` (field parity reference for the report fields)

## Blocked by

- #28
- #54
