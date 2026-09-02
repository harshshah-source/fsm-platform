> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — Reports & Analytics (reports)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/reports/commissioning/cohort` | apps/backend/src/reports/reports.controller.ts:55 | ...MANAGER_ROLES | no | no | no |
| `GET /api/reports/commissioning/installers` | apps/backend/src/reports/reports.controller.ts:80 | ...MANAGER_ROLES | no | no | no |
| `GET /api/reports/fleet-uptime` | apps/backend/src/reports/reports.controller.ts:108 | ...MANAGER_ROLES | no | no | no |
| `POST /api/reports/fleet-uptime/recompute` | apps/backend/src/reports/reports.controller.ts:125 | 'OPERATIONS_HEAD' | no | yes | no |
| `GET /api/reports/soft-inactive-trend` | apps/backend/src/reports/reports.controller.ts:133 | 'OPERATIONS_HEAD' | no | no | no |
| `POST /api/reports/soft-inactive/recompute` | apps/backend/src/reports/reports.controller.ts:141 | 'OPERATIONS_HEAD' | no | no | no |
| `GET /api/reports/root-cause` | apps/backend/src/reports/reports.controller.ts:149 | 'OPERATIONS_HEAD' | no | no | no |
| `POST /api/reports/root-cause/recompute` | apps/backend/src/reports/reports.controller.ts:176 | 'OPERATIONS_HEAD' | no | yes | no |
| `GET /api/reports/zm-scorecard` | apps/backend/src/reports/reports.controller.ts:187 | 'OPERATIONS_HEAD' | no | no | no |
| `POST /api/reports/zm-scorecard/recompute` | apps/backend/src/reports/reports.controller.ts:194 | 'OPERATIONS_HEAD' | no | yes | no |
| `GET /api/reports/efficiency` | apps/backend/src/reports/reports.controller.ts:205 | ...MANAGER_ROLES | no | no | no |
| `GET /api/reports/work-type-mix` | apps/backend/src/reports/reports.controller.ts:232 | ...MANAGER_ROLES | no | no | no |
| `GET /api/reports/verification-outcomes` | apps/backend/src/reports/reports.controller.ts:246 | ...MANAGER_ROLES | no | no | no |
| `POST /api/reports/efficiency/recompute` | apps/backend/src/reports/reports.controller.ts:261 | 'OPERATIONS_HEAD' | no | no | yes |
| `GET /api/exports/entity-mapping/summary` | apps/backend/src/exports/exports.controller.ts:20 | 'OPERATIONS_HEAD' | no | yes | no |
| `GET /api/exports/entity-mapping` | apps/backend/src/exports/exports.controller.ts:26 | 'OPERATIONS_HEAD' | ? | ? | ? |

**totals:** 16 endpoints · 0 with no @Roles at handler or class · 0 @Public · 5 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
_no model name matched the slug — surveyor must map by hand_

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-10 | verification · Run · FRAUD_SUSPECT | tickets | route `POST /api/verification/:ticketId/escalate` (tx+audit) | ZM click | ticketId, reason, actor | `/tickets` + `/reports/root-cause` · ZM/OH | `mark-auto-recovery` :88 is the other branch; no un-escalate | E2 `verification/verification.controller.ts:67,88` | tickets | PARTIAL — no reverse ⇒ S3 |
| E-17 | vouchers · Voucher · APPROVED | reports (finance) | **file export** `GET /api/vouchers/export` then `POST /vouchers/mark-paid` by hand | OH click | voucherId, seId, amount, approvedBy | *(blank — no finance/payroll system seam)* | no un-pay path | E2 `vouchers/vouchers.controller.ts:108,121` · `vouchers/vouchers.service.ts:358` | vouchers | MANUAL — S3 + DANGEROUS (financial) |
| E-28 | tickets + verification + vouchers · closures | reports | nightly cron recomputes (efficiency, root-cause, ZM scorecard, fleet uptime) | cron `systemEfficiencyTick` etc. | closure counts, verdicts, SLA breaches, per-SE totals | `/reports/*` · OH/ZM | manual `POST /reports/*/recompute` | E2 `scheduling/business-sweep-scheduler.service.ts:255,260,265,270` · `reports/reports.controller.ts:125,176,194,261` | reports | OK |

## env flags referenced in this module
_none_
