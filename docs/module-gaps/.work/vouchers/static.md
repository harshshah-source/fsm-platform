> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — Expense Vouchers (vouchers)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/me/vouchers` | apps/backend/src/vouchers/me-vouchers.controller.ts:15 | 'SERVICE_ENGINEER' | no | yes | no |
| `POST /api/vouchers` | apps/backend/src/vouchers/vouchers.controller.ts:62 | 'SERVICE_ENGINEER' | yes | yes | no |
| `GET /api/vouchers` | apps/backend/src/vouchers/vouchers.controller.ts:100 | ...REVIEW_ROLES | yes | yes | no |
| `GET /api/vouchers/export` | apps/backend/src/vouchers/vouchers.controller.ts:108 | 'OPERATIONS_HEAD' | no | yes | no |
| `POST /api/vouchers/mark-paid` | apps/backend/src/vouchers/vouchers.controller.ts:121 | 'OPERATIONS_HEAD' | yes | yes | no |
| `POST /api/vouchers/:id/review` | apps/backend/src/vouchers/vouchers.controller.ts:134 | ...REVIEW_ROLES | yes | yes | no |
| `POST /api/vouchers/:id/resubmit` | apps/backend/src/vouchers/vouchers.controller.ts:161 | 'SERVICE_ENGINEER' | yes | yes | no |

**totals:** 7 endpoints · 0 with no @Roles at handler or class · 0 @Public · 0 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
_no model name matched the slug — surveyor must map by hand_

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-15 | tickets · Ticket · CLOSED | vouchers | **a human remembers** — SE opens the Vouchers tab and re-keys the trip | SE decides | amount, category, photo, date | `/vouchers` VoucherReviewPage.tsx · ZM/CSM | resubmit :161 | E2 `vouchers/vouchers.controller.ts:62` · mobile `vouchers/VoucherFormScreen.tsx` (no ticket carrier from TicketDetailScreen) | vouchers | MANUAL — S3 (C2) |
| E-16 | vouchers · Voucher · REJECTED | vouchers (mobile) | route `POST /api/vouchers/:id/resubmit` | SE edit | voucherId, reject reason | VoucherFormScreen.tsx · SE | resubmit is the reverse | E2 `vouchers/vouchers.controller.ts:134,161` | vouchers | OK |
| E-17 | vouchers · Voucher · APPROVED | reports (finance) | **file export** `GET /api/vouchers/export` then `POST /vouchers/mark-paid` by hand | OH click | voucherId, seId, amount, approvedBy | *(blank — no finance/payroll system seam)* | no un-pay path | E2 `vouchers/vouchers.controller.ts:108,121` · `vouchers/vouchers.service.ts:358` | vouchers | MANUAL — S3 + DANGEROUS (financial) |
| E-28 | tickets + verification + vouchers · closures | reports | nightly cron recomputes (efficiency, root-cause, ZM scorecard, fleet uptime) | cron `systemEfficiencyTick` etc. | closure counts, verdicts, SLA breaches, per-SE totals | `/reports/*` · OH/ZM | manual `POST /reports/*/recompute` | E2 `scheduling/business-sweep-scheduler.service.ts:255,260,265,270` · `reports/reports.controller.ts:125,176,194,261` | reports | OK |

## env flags referenced in this module
_none_
