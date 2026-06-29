# 20 — QR Scanner + Technical Hints (mobile)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

Two SE mobile capabilities. **QR Scanner**: scan a vehicle QR, device QR, or device serial barcode from
Home to open the matching active Ticket directly — entry shortcut only, never creates/assigns/claims/
submits/closes. Online: backend searches active eligible Tickets by `vehicle_no` / `device_id`; match
opens Ticket Detail, no match shows "No active ticket found". Multiple active Tickets for one vehicle →
disambiguation list. Manual text-entry fallback for damaged labels. Offline: cached matched Ticket opens
read-only with offline indicator; uncached shows "Cannot search ticket while offline." **Technical
Hints**: advisory diagnostic signals derived at API time from the latest snapshot telemetry — card shows
the single highest-severity hint; Ticket Detail shows all hints + the full raw telemetry field set,
always visible (no collapse). "Telemetry unavailable" shown when snapshot data is missing. Hints never
affect lifecycle, SLA, assignment, scoring, verification, or closure.

> **Backend split (dependency correction).** Neither backend capability exists today. Split into:
> 1. **Backend: ticket-search** — `GET /api/tickets/search?vehicleNo=|deviceId=` (active eligible
>    tickets; disambiguation when >1). Owned by **#83**.
> 2. **Backend: Technical Hints** — derive hints from latest snapshot telemetry per PRD §641 Flow 14
>    (rules below) + expose on the ticket payload + a raw-telemetry read. Owned by **#84**.
> 3. **This issue (20, mobile)** — scanner + hints UI, consuming (1) and (2). Now also blocked by #54.

## Business rules (authority)

- PRD §623 Flow 13 (QR — entry shortcut only, no state changes) and §641 Flow 14 (Technical Hints —
  the full condition→hint table + raw-telemetry field set + "Telemetry unavailable"). These rules are
  fully specified in the PRD; the backend issues implement them verbatim (no new business logic).

## Acceptance criteria

- [ ] QR scan resolves vehicle/device to its active Ticket; "No active ticket found" on no match
- [ ] Multi-device vehicle shows disambiguation list; manual text-entry fallback available
- [ ] Offline: cached ticket opens read-only; uncached shows offline message; never mutates state
- [ ] Technical Hints derived from latest snapshot telemetry per the documented rules; highest-severity on card
- [ ] Ticket Detail shows all hints + full raw telemetry, always visible; "Telemetry unavailable" when missing
- [ ] No hint changes Ticket state, SLA, or assignment

## API contract (authority: #83 Ticket Search + #84 Technical Hints)

- `GET /api/tickets/search?vehicleNo=|deviceId=` → active eligible ticket(s); >1 → disambiguation list.
- Technical Hints + raw telemetry on the ticket detail payload (or a dedicated read) per PRD §641.
- This mobile issue is **blocked** until both exist — do not invent the search or hint endpoints.

## Validation & error codes

- No match → "No active ticket found" (not an error state). Offline + uncached → "Cannot search ticket while offline."

## Permissions

- SE-only. The scanner is a read/navigation shortcut — it performs no mutations by design.

## Offline behaviour

- Cached matched ticket → read-only open with offline indicator; uncached → offline message; no search call.

## Edge cases & failures

- Damaged/missing label → manual `vehicle_no` / `device_id` text entry.
- Missing snapshot telemetry → "Telemetry unavailable" (hints section empty; raw section shows the message).

## UI surfaces

- **Mobile:** QR scanner + Technical Hints (card + Ticket Detail section). Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/*` (Home scan entry + Ticket Detail technical section)

## Tests (TDD targets — red first)

- Scan → single match opens Ticket Detail; no match → message; multi-match → disambiguation list.
- Offline cached → read-only open; offline uncached → offline message; no mutation in any path.
- Hint card shows the highest-severity hint; Ticket Detail shows all hints + raw telemetry; missing → "Telemetry unavailable".

## Blocked by

- #07
- #16
- #54 (Mobile Foundation)
- #83 — Ticket Search API
- #84 — Technical Hints API
