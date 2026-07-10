# Progress — Issue 37: Recovery closure authority + ZM decision queue + stalled flags

> Build date: 2026-06-25 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE (backend + admin)** — ZM decision-queue actions, manual closure authority (closure
> type by acting role), stalled-14d Action Required card, and the non-standard-closure compliance read.
> **No migration** — #36 pre-provisioned the `closure_type` enum + columns. Backend **+1 controller-
> expansion / +3 e2e (11 tests)**; admin **+1 page / +1 drawer control / +2 tests (4)**. Backend
> **528/528**, admin **88/88**, both `tsc` clean.

## Authority

CONTEXT.md **§14** "Closure authority" + the **Recovery Ticket** glossary. The five `closure_type`
values were defined complete in #36, so #37 only adds behaviour — no schema change.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | ZM decision queue offers Reschedule / Close FAILED_RECOVERY (reason) / Escalate to OH | 🟢 | `rescheduleRecovery` (→ SCHEDULED, new assignee, unable-flag cleared), `closeFailedRecovery` (mandatory reason → FAILED_RECOVERY / `FAILED_RECOVERY_CLOSE`), `escalateToOh` (notifier). Admin `/readiness/recovery-decisions` exposes all three. `recovery-decision-queue` (5), `recovery-decision-controller` (3), `recovery-decision-queue.test` (3). |
| 2 | Manual close by ZM / OH / CSM-acting records the correct `closure_type` + full audit | 🟢 | `manualClose` sets the closure type by acting role (`ZM_MANUAL_CLOSE` / `OPERATIONS_HEAD_OVERRIDE_CLOSE` / `CSM_ACTING_CLOSE`) and audits `previousState` + `deviceSerial` + reason. Web-only entry point: the Ticket Detail Drawer (`recovery-manual-close`). `recovery-drawer-close.test`. |
| 3 | Operations Head can override-close any zone (`OPERATIONS_HEAD_OVERRIDE_CLOSE`) | 🟢 | `manualClose` for an `OPERATIONS_HEAD` actor → `OPERATIONS_HEAD_OVERRIDE_CLOSE`; not zone-restricted. Verified over HTTP in `recovery-decision-controller`. |
| 4 | Manual closures flagged non-standard in compliance reports (never silently bypass receipt) | 🟢 | `nonStandardClosures()` lists every RECOVERY ticket closed with a manual closure type (auto-receipt excluded); `GET /recovery/non-standard-closures`. `recovery-compliance-stalled`. |
| 5 | Recovery Tickets with no progression for 14+ days surface in ZM Action Required | 🟢 | `stalledRecoveries()` + the wired `recovery_stalled` Action Required card (zone-scoped count via plant→zone), available with a real count. `recovery-compliance-stalled` + the updated `dashboard-action-required`. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — decision-queue actions + manual close.** `rescheduleRecovery` / `closeFailedRecovery` /
  `escalateToOh` (decision-queue gated: unable-flagged + non-terminal) + `manualClose` (closure type by
  acting role, full audit). RED `recovery-decision-queue` (5).
- **Slice 2 — stalled + compliance reads + card.** `stalledRecoveries` (no progression 14+ days),
  `nonStandardClosures` (manual closure types), and the wired `recovery_stalled` dashboard card
  (zone-scoped SQL). RED `recovery-compliance-stalled` (3); updated the Issue-06 action-required test
  to treat `recovery_stalled` as wired (same pattern as Issue 23's `waiting_component_overdue`).
- **Slice 3 — HTTP.** `RecoveryController` gains reschedule / close-failed / escalate / manual-close +
  the stalled / non-standard-closures reads (role-gated, `@CurrentActor()`). RED `recovery-decision-controller` (3).
- **Slice 4 — admin.** `/readiness/recovery-decisions` (Reschedule / Close FAILED_RECOVERY / Escalate)
  + a "Manually close Recovery Ticket" control on the Ticket Detail Drawer for managers. RED
  `recovery-decision-queue.test` (3) + `recovery-drawer-close.test` (1).

## Deviations / decisions

1. **No migration.** #36 defined the full `closure_type` enum (incl. the manual/failed types) and the
   `closure_*` columns up front, so #37 is pure behaviour. The reschedule clears `unable_to_collect_*`
   (existing columns); stalled + non-standard are derived reads.
2. **Escalate = audit event + notifier, no new state.** Escalation records `RECOVERY_ESCALATED_TO_OH`
   + fires the optional `RecoveryNotifier.escalatedToOh` and leaves the ticket in the queue so an
   Operations Head (all-zones) can override-close it; no dedicated `ESCALATED` recovery state is
   introduced (the status enum is fixed).
3. **CSM manual close ⇒ CSM_ACTING_CLOSE.** A CSM closing operates in their acting (backup-cascade)
   scope, so any CSM manual close is classified `CSM_ACTING_CLOSE` (CONTEXT §14/§15).
4. **`recovery_stalled` card urgency 9.** Appended after the existing eight cards; the panel renders in
   ascending urgency, so it sorts last among the wired/stub cards.

## Parity-gate disposition

- **Admin:** ZM decision queue + drawer manual-close built. ✅
- **Mobile:** **n/a** — Issue 37 is explicitly **web-only** ("Manual closure (web only)"); the decision
  queue + closure authority are manager/Operations surfaces. No mobile follow-up.
- The stalled flag surfaces in the existing **Action Required** panel (card wired); a dedicated
  compliance-report admin page over `nonStandardClosures()` can follow if Operations wants a UI (the
  read is exposed at `/recovery/non-standard-closures`).

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/recovery-decision-queue.e2e-spec.ts test/recovery-compliance-stalled.e2e-spec.ts \
  test/recovery-decision-controller.e2e-spec.ts test/dashboard-action-required.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run \
  test/recovery-decision-queue.test.tsx test/recovery-drawer-close.test.tsx
```
