# 36 — Recovery Ticket lifecycle + warehouse receipt auto-close + unable-to-collect

Status: ready-for-agent
Type: AFK

## What to build

The Recovery Ticket field workflow. Lifecycle SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED, in the Day Plan as a first-class work type. SE marks ON_SITE, then COLLECTED via the Collection Form: device serial confirmation (mandatory, validated against the Ticket record) and physical condition notes (mandatory). SE returns the device to the Zone Warehouse; the Warehouse Manager physically checks the device + serial and confirms receipt → `RECEIVED_AT_WAREHOUSE` → Ticket **auto-closes** (`closure_type = AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`, no ZM approval); SE and ZM notified. **Unable to collect** path: SE taps Unable to Collect with a mandatory reason code (COMPANY_REFUSED / VEHICLE_UNREACHABLE / DEVICE_MISSING / OTHER), routing the Ticket to the ZM decision queue (handled in #37).

## Acceptance criteria

- [ ] Recovery lifecycle SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED enforced
- [ ] COLLECTED captures mandatory device-serial confirmation (validated) + condition notes
- [ ] Warehouse Manager receipt auto-closes the Ticket (`AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`), no ZM approval
- [ ] SE + ZM receive closure notification
- [ ] Unable to Collect requires a reason code and routes the Ticket to the ZM decision queue

## Blocked by

- #35
