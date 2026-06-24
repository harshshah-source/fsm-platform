# 20 — QR Scanner + Technical Hints

Status: ready-for-agent
Type: AFK

## What to build

Two SE mobile capabilities. **QR Scanner**: scan a vehicle QR, device QR, or device serial barcode from Home to open the matching active Ticket directly — entry shortcut only, never creates/assigns/claims/submits/closes. Online: backend searches active eligible Tickets by `vehicle_no` / `device_id`; match opens Ticket Detail, no match shows "No active ticket found". Multiple active Tickets for one vehicle → disambiguation list. Manual text-entry fallback for damaged labels. Offline: cached matched Ticket opens read-only with offline indicator; uncached shows "Cannot search ticket while offline." **Technical Hints**: advisory diagnostic signals derived at API time from the latest snapshot telemetry — card shows the single highest-severity hint (e.g. "No main power — check fuse", "Weak GSM signal", "GPS signal invalid"); Ticket Detail shows all hints + the full raw telemetry field set, always visible (no collapse). "Telemetry unavailable" shown when snapshot data is missing. Hints never affect lifecycle, SLA, assignment, scoring, verification, or closure.

## Acceptance criteria

- [ ] QR scan resolves vehicle/device to its active Ticket; "No active ticket found" on no match
- [ ] Multi-device vehicle shows disambiguation list; manual text-entry fallback available
- [ ] Offline: cached ticket opens read-only; uncached shows offline message; never mutates state
- [ ] Technical Hints derived from latest snapshot telemetry per the documented rules; highest-severity on card
- [ ] Ticket Detail shows all hints + full raw telemetry, always visible; "Telemetry unavailable" when missing
- [ ] No hint changes Ticket state, SLA, or assignment

## Blocked by

- #07
- #16
