# FE-16 — Recovery + Non-Op queues parity

Status: ready-for-agent
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

- [ ] All three queues use the shared recipe; status pills correct per flow
- [ ] Recovery receipt confirm + ZM decision actions via `Modal`; Non-Op dual-confirmation modal preserved
- [ ] Existing APIs, role gating, and selectors preserved

## Reusable components introduced

- `ConfirmModal`, `DualConfirmModal` (composition)

## Affected pages

- `RecoveryReceiptQueuePage`, `RecoveryDecisionQueuePage`, `NonOperationalQueuePage` (**[RP]**)

## Reference

- `20` (+ flow context from Issues 35/36/37)

## Verification

- `recovery-receipt-queue.test.tsx`, `recovery-decision-queue.test.tsx`, `non-operational-queue.test.tsx` green; Playwright ≈ `20`
