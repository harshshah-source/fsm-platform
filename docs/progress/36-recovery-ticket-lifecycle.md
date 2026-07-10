# Progress — Issue 36: Recovery Ticket lifecycle + warehouse receipt auto-close + unable-to-collect

> Build date: 2026-06-25 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE (backend + admin WM surface)** — full Recovery field lifecycle, warehouse-receipt
> auto-close, closure/unable notifier seam, and the WM "Awaiting Receipt" admin queue. Backend
> **+1 service / +1 controller / +1 notifier seam / +1 additive migration / +3 e2e (9 tests)**;
> admin **+1 page / +1 api client / +1 test (2)**. Backend **517/517**, admin **84/84**, both `tsc` clean.
> SE field screens (mobile) → **#68** (blocked by #54). Builds on the Recovery ticket #35 auto-creates.

## Authority

CONTEXT.md **§14** + the **Recovery Ticket** / **Closure authority** glossary entries. Lifecycle
`REQUESTED → SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED`. The `TicketStatus`
enum already carried every state; this issue adds the field-workflow data + `closure_type` via an
additive migration (the schema reserved these columns for "owning issues 36/37").

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Lifecycle SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED enforced | 🟢 | `RecoveryService` state-guards every transition (wrong state → `WRONG_STATE`); each writes a `ticket_events` row. `recovery-lifecycle` (2), `recovery-receipt-unable` (4), `recovery-controller` (2). |
| 2 | COLLECTED captures mandatory device-serial confirmation (validated) + condition notes | 🟢 | `markCollected` rejects a serial ≠ the ticket's `deviceId` (`INVALID_SERIAL`) and blank notes (`NOTES_REQUIRED`); stores `collected_device_serial` + `collection_condition_notes`. |
| 3 | WM receipt auto-closes (`AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`), no ZM approval | 🟢 | `confirmWarehouseReceipt` (WAREHOUSE_MANAGER only, COLLECTED only) writes RECEIVED_AT_WAREHOUSE then CLOSED in one tx with `closure_type = AUTO_CLOSED_ON_WAREHOUSE_RECEIPT` + `closed_at`. Admin WM "Awaiting Receipt" queue drives it. |
| 4 | SE + ZM receive closure notification | 🟢 (seam) | `RecoveryNotifier.recoveryClosed` fired after commit through the `RECOVERY_NOTIFIER` port (logging stub; Issue 03 swaps it). Verified via a capturing stub in `recovery-receipt-unable`. |
| 5 | Unable to Collect requires a reason + routes to the ZM decision queue | 🟢 | `markUnableToCollect` (assigned SE, ON_SITE) validates the reason enum, stamps `unable_to_collect_reason` + `unable_to_collect_at`, fires `RecoveryNotifier.unableToCollect`, and surfaces on `zmDecisionQueue()` (the queue's *actions* are Issue 37). |

## Slice-by-slice RED→GREEN report

- **Slice 1 — migration + schedule/on-site/collected.** Additive migration `20260625130000_add_recovery_lifecycle`
  (`closure_type` + `unable_to_collect_reason` enums; `tickets` recovery columns). `scheduleRecovery`
  (manager → SCHEDULED + assignee), `markOnSite` / `markCollected` (assigned-SE only, serial validation,
  mandatory notes), state guards + events. RED `recovery-lifecycle` (2).
- **Slice 2 — receipt auto-close + unable-to-collect.** `confirmWarehouseReceipt` (WM → RECEIVED →
  CLOSED auto), `markUnableToCollect` (reason → ZM queue flag), `awaitingReceipt` + `zmDecisionQueue`
  reads, `RecoveryNotifier` seam. RED `recovery-receipt-unable` (4).
- **Slice 3 — HTTP.** `RecoveryController` (`/api/recovery`, `@CurrentActor()`): schedule / on-site /
  collected / unable-to-collect / receipt + awaiting-receipt + zm-queue reads, role-gated. Module +
  AppModule wiring. RED `recovery-controller` (2, incl. role gating).
- **Slice 4 — admin WM queue.** `/warehouse/recovery-receipt` (WM-only): COLLECTED tickets with serial +
  condition + Confirm Receipt (auto-close). API client + route + nav. RED `recovery-receipt-queue.test` (2).

## Deviations / decisions

1. **"Device serial" = the device id.** The GPS unit's `device_id` is the AutoPlant business serial
   (schema: "not a surrogate"), so the Collection-Form serial is validated against `String(deviceId)`.
2. **Unable-to-Collect keeps status ON_SITE + a flag.** There is no `UNABLE_TO_COLLECT` ticket status
   (the enum is fixed), so the ticket is flagged (`unable_to_collect_reason`) and surfaced on
   `zmDecisionQueue()` rather than moved to a new state. Issue 37 acts on that queue.
3. **`assigned_se_id` on the ticket.** Recovery uses a direct assignee column (set at SCHEDULED) so the
   field legs can enforce "the assigned SE". For v1 the dispatch sets it directly; full recommender/Day-
   Plan integration of RECOVERY work is a thin seam on top.
4. **Closure-type enum defined complete.** All five closure types (incl. the manual/failed ones #37
   uses) are defined now so Issue 37 never `ALTER TYPE`s — matching the repo's enum convention.

## Parity-gate disposition

- **Admin:** the Warehouse-Manager receipt surface is built (`/warehouse/recovery-receipt`). ✅
- **Mobile:** the SE field actions (Mark On-Site, Collection Form, Unable to Collect) are SE mobile
  surfaces → **#68**, blocked by **#54 (Mobile Foundation)** — a true backlog dependency (the RN shell
  doesn't exist), filed + linked in INDEX, not a silent defer.
- The ZM decision queue **actions** (Reschedule / Close FAILED_RECOVERY / Escalate) + manual closure
  authority are **Issue 37** by design; #36 exposes the queue *read* only.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/recovery-lifecycle.e2e-spec.ts test/recovery-receipt-unable.e2e-spec.ts test/recovery-controller.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/recovery-receipt-queue.test.tsx
```
