# 36 — Recovery Ticket lifecycle + warehouse receipt auto-close + unable-to-collect

Status: done
Type: AFK
Done: 2026-06-25 — full Recovery field lifecycle (schedule → on-site → collected → warehouse receipt
auto-close) + Collection-Form validation + unable-to-collect routing + closure/unable notifier seam
(backend) + Warehouse-Manager "Awaiting Receipt" admin queue. SE mobile field screens → #68 (blocked
by #54). ZM decision-queue actions + manual-close authority = #37. See
`docs/progress/36-recovery-ticket-lifecycle.md`.

## What to build

The Recovery Ticket field workflow. Lifecycle SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED, in the Day Plan as a first-class work type. SE marks ON_SITE, then COLLECTED via the Collection Form: device serial confirmation (mandatory, validated against the Ticket record) and physical condition notes (mandatory). SE returns the device to the Zone Warehouse; the Warehouse Manager physically checks the device + serial and confirms receipt → `RECEIVED_AT_WAREHOUSE` → Ticket **auto-closes** (`closure_type = AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`, no ZM approval); SE and ZM notified. **Unable to collect** path: SE taps Unable to Collect with a mandatory reason code (COMPANY_REFUSED / VEHICLE_UNREACHABLE / DEVICE_MISSING / OTHER), routing the Ticket to the ZM decision queue (handled in #37).

## Acceptance criteria

- [x] Recovery lifecycle SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED enforced
- [x] COLLECTED captures mandatory device-serial confirmation (validated) + condition notes
- [x] Warehouse Manager receipt auto-closes the Ticket (`AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`), no ZM approval
- [x] SE + ZM receive closure notification (notifier seam; Issue 03 delivery)
- [x] Unable to Collect requires a reason code and routes the Ticket to the ZM decision queue

## Blocked by

- #35
