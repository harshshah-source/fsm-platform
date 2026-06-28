# FE-16 — Recovery + Non-Op queues parity

Status: done (window.prompt → Modal upgrade → #72)
Type: AFK · Frontend · Phase F4
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8 (queue recipe + modals). Global DoD applies.

## What to build

Apply the queue recipe + confirm/dual-confirm `Modal`s to `RecoveryReceiptQueuePage`,
`RecoveryDecisionQueuePage`, and `NonOperationalQueuePage` (warehouse-stock aesthetic of `20`). Warehouse-
receipt auto-close, ZM unable-to-collect decision, and Non-Op dual-confirmation flows preserved.

## Dependencies

- FE-03, FE-04

## Acceptance criteria

- [x] All three queues use the shared recipe; status pills correct per flow
- [~] Recovery receipt confirm + ZM decision actions via `Modal`; Non-Op dual-confirmation modal preserved
  — Non-Op Mark dual-confirmation modal preserved + re-skinned; receipt/decision actions stay
  direct/`window.prompt` (see deviation) → `Modal` upgrade filed as #72
- [x] Existing APIs, role gating, and selectors preserved

## Outcome (done with follow-up — presentation-only, FE-16)

All three queues on the canonical recipe (`PageHeader` + `MetricCard` + `DataTable` + `Badge`/
`StatusPill`):
- **RecoveryReceiptQueuePage** — `Awaiting Warehouse Receipt` table + `StatusPill`; `rcv-row-*` /
  `rcv-receipt-*` ids + single-click Confirm-Receipt preserved.
- **RecoveryDecisionQueuePage** — `Recovery decision queue` table; `rdq-row-*` / `rdq-reschedule-*` /
  `rdq-close-failed-*` / `rdq-escalate-*` ids + Reschedule/Close/Escalate behaviour preserved.
- **NonOperationalQueuePage** — `Non-Operational dual confirmation` table with state + days `Badge`s; the
  **Mark dual-confirmation modal** (Device ID / Reason / RECURRING warning + acknowledge / submit) is
  preserved and re-skinned onto the tokens; `nonop-row-*` / `nonop-confirm-*` / `nonop-override-*` ids
  preserved.

**Deviation → #72:** AC#2 asks for `Modal`-driven receipt-confirm + ZM-decision actions, but all three
tests assert those actions as a **direct (or `window.prompt`→) POST on click** — introducing a blocking
confirm/reason `Modal` would change that asserted behaviour and break the locked tests. The Non-Op Mark
dual-confirmation modal (the one true multi-field modal here) is delivered; the remaining `window.prompt`
legs (recovery reschedule / close-failed reason; non-op override reason) are filed as #72 to be
Modal-ized **with** the coordinated test updates. Verified: admin `tsc --noEmit` clean · vitest **98/98**
· `vite build` OK.

## Reusable components introduced

- `ConfirmModal`, `DualConfirmModal` (composition)

## Affected pages

- `RecoveryReceiptQueuePage`, `RecoveryDecisionQueuePage`, `NonOperationalQueuePage` (**[RP]**)

## Reference

- `20` (+ flow context from Issues 35/36/37)

## Verification

- `recovery-receipt-queue.test.tsx`, `recovery-decision-queue.test.tsx`, `non-operational-queue.test.tsx` green; Playwright ≈ `20`
