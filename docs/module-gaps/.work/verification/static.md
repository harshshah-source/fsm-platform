> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — GPS Verification Review (verification)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/verification/review` | apps/backend/src/verification/verification.controller.ts:42 | ...MANAGER_ROLES | no | no | no |
| `POST /api/verification/:ticketId/escalate` | apps/backend/src/verification/verification.controller.ts:67 | ...MANAGER_ROLES | yes | yes | yes |
| `POST /api/verification/:ticketId/mark-auto-recovery` | apps/backend/src/verification/verification.controller.ts:88 | ...MANAGER_ROLES | yes | yes | yes |
| `GET /api/tickets/:id/verification` | apps/backend/src/verification/verification.controller.ts:103 | 'SERVICE_ENGINEER',...MANAGER_ROLES | no | no | no |
| `GET /api/verification/fraud-flags` | apps/backend/src/verification/verification.controller.ts:111 | ...MANAGER_ROLES | no | no | no |

**totals:** 5 endpoints · 0 with no @Roles at handler or class · 0 @Public · 0 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
- `VerificationRun :1291`

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-09 | tickets · Submission · saved | verification | cron sweep `runVerification` | cron `verificationTick` | ticketId, submissionId, GPS pair, device telemetry | `/verification` VerificationReviewPage.tsx · ZM | none | E2 `verification/verification.service.ts:48` · `scheduling/business-sweep-scheduler.service.ts:219` | verification | OK |
| E-10 | verification · Run · FRAUD_SUSPECT | tickets | route `POST /api/verification/:ticketId/escalate` (tx+audit) | ZM click | ticketId, reason, actor | `/tickets` + `/reports/root-cause` · ZM/OH | `mark-auto-recovery` :88 is the other branch; no un-escalate | E2 `verification/verification.controller.ts:67,88` | tickets | PARTIAL — no reverse ⇒ S3 |
| E-28 | tickets + verification + vouchers · closures | reports | nightly cron recomputes (efficiency, root-cause, ZM scorecard, fleet uptime) | cron `systemEfficiencyTick` etc. | closure counts, verdicts, SLA breaches, per-SE totals | `/reports/*` · OH/ZM | manual `POST /reports/*/recompute` | E2 `scheduling/business-sweep-scheduler.service.ts:255,260,265,270` · `reports/reports.controller.ts:125,176,194,261` | reports | OK |

## env flags referenced in this module
_none_
