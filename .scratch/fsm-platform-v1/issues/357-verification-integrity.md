# 357 — Verification integrity: zone-scoped fraud flags, run verdict, de-escalate, reasons
Status: done 2026-09-03 — report docs/progress/357-verification-integrity.md
Type: AFK
Wave: 3 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

Five integrity gaps in the verification module, all backend.

- `fraudFlags()` (`verification-query.service.ts:214-226`) takes no scope, while `review()` and
  `forTicket()` clamp a ZM to their own zone (`:161-183`). A ZM can read every zone's fraud flags.
- `verification.service.ts:183-186` marks auto-recovery only on runs with `outcome: null`. A
  `FAILED_NO_PINGS` run therefore keeps `FAILED` while the ticket becomes `CLOSED_AUTO_RECOVERY` —
  two ledgers disagree, and `/reports/verification-outcomes` counts the run as FAILED.
- No route reverses ESCALATED (`verification.controller.ts:67-101`).
- The escalation reason lives only in `auditLog.metadata` (`verification.service.ts:138`); it is
  readable in Ops Explorer (§1 correction V-05) but absent from reports and from the run row.
- Mark-auto-recovery takes no reason (`verification.service.ts:88-101`).

## Current code

- `apps/backend/src/verification/verification-query.service.ts:214-226` — `fraudFlags()` has no
  scope parameter; `:161-183` — `review()` / `forTicket()` clamp ZM.
- `apps/backend/src/verification/verification.controller.ts:111-115` — fraud-flags route does not
  pass scope; `:67-101` — transition routes, no de-escalate.
- `apps/backend/src/verification/verification.service.ts:183-186` — auto-recovery marks only
  `outcome: null` runs; `:138` — escalation reason written to `auditLog.metadata` only;
  `:88-101` — mark-auto-recovery has no reason input.
- `apps/backend/src/reports/reports.service.ts:545-556` — verification-outcomes report, no
  reason/outcome columns.
- `VerificationRun` has no `escalationReason` column (`schema.prisma`).

## What to build

- `verification-query.service.ts` — `fraudFlags(scope)`; ZM clamped to own zone, CSM/OH all zones.
- `verification.controller.ts:111-115` — pass `@CurrentScope()` into `fraudFlags`.
- `verification.service.ts:183` — on mark-auto-recovery, update the run to the
  `CLOSED_AUTO_RECOVERY` outcome for FAILED rows too, guarded by #301's `stampOnceOrLose`.
- `verification.service.ts` — new `deescalate(ticketId, actor, reason)`: ESCALATED → back to the
  pre-escalation review state, audited, guarded; refused on a closed ticket. Exposed via a route
  in `verification.controller.ts` for ZM/CSM/OH.
- `schema.prisma` — `VerificationRun.escalationReason` + migration; the escalation writer persists
  the reason on the run as well as in the audit metadata.
- `reports.service.ts:545-556` — verification-outcomes report returns reason and outcome columns.
- `mark-auto-recovery` request body — `{reason}` required; missing → 400.
- Tests: `verification-controller`, `verification-guarded-transitions`,
  `verification-staleness` e2e.

## Acceptance criteria
- [x] AC1 — ZM gets own-zone fraud flags only; CSM/OH get all zones.
- [x] AC2 — after mark-auto-recovery the run and the ticket agree, and the outcomes report counts
      it as auto-recovery.
- [x] AC3 — de-escalate exists for ZM/CSM/OH, requires a reason, is audited, and is refused on a
      closed ticket.
- [x] AC4 — the escalation reason is persisted on the run and returned by the outcomes report.
- [x] AC5 — mark-auto-recovery without a reason → 400.

**One line of the premise had moved.** The reports edit is cited at `reports.service.ts:545-556`;
#347 landed there earlier the same day and `verificationOutcomes` is now `:600-624`. Everything else
reproduced as written.

## Verification

e2e per AC, using the #336 seeded verification runs (zone-1 `FAILED_NO_PINGS`, zone-2
`fraudFlag=true`, zone-1 CLOSED).

## UI surfaces

n/a (backend-only; the admin page consumes these changes in #358).

## Reference

n/a.

## Blocked by
- #336 — dev seed fixtures (the verification runs this slice is tested against).

## Absorbs / supersedes
- survey ids: V-01, V-02, V-04, V-05 (narrowed per §1 — reason is already readable in Ops
  Explorer; this slice adds it to the run row and the report), V-07 (API half; the UI half is #358).
- existing issues: none.
