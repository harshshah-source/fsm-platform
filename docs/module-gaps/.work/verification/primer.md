# verification — module primer (first walker, 2026-09-02)

Read `_shared-primer.md` first; this adds only what is module-specific.

## Where the module lives
- backend `apps/backend/src/verification/` — `verification.controller.ts` (5 routes, all on the bare
  `@Controller()`, so paths are absolute), `verification.service.ts` (sweep + the two writes),
  `verification-query.service.ts` (all three reads), `verification-criteria.ts` (thresholds).
- admin `apps/admin/src/pages/verification/VerificationReviewPage.tsx`, route `/verification`
  (`AppRoutes.tsx:459`), client `apps/admin/src/api/verification.ts`.
- mobile `apps/mobile/src/tickets/verification/VerificationScreen.tsx` (read-only badge view).

## The five routes and who may reach them (all measured, E4)
| route | 200 for | 403 for |
|---|---|---|
| `GET verification/review` | ZM, ZM_SOUTH, CSM, OH | WM, SE |
| `GET verification/fraud-flags` | ZM, ZM_SOUTH, CSM, OH | WM, SE |
| `POST verification/:ticketId/escalate` | MANAGER_ROLES | WM, SE |
| `POST verification/:ticketId/mark-auto-recovery` | MANAGER_ROLES | WM, SE |
| `GET tickets/:id/verification` | + SERVICE_ENGINEER | — |

Role gating is real everywhere. Zone clamping is real in `review()`, `forTicket()` and
`escalateFraud()` — and absent in `fraudFlags()` (V-02).

## Data state — read this before planning any walk
**The module has zero live rows.** `verification/review` = 0 and `verification/fraud-flags` = 0 for
all four manager roles; `/reports/verification-outcomes` total = 0. There is no seeded record in any
lifecycle state. Consequence: check 3 is untestable module-wide, every empty list is uninformative,
and V-01 and V-02 cannot be promoted past E2. Filed as V-08 (O4, dev-process — not a feature gap).

Seed that unblocks seven capabilities: 2-3 `VerificationRun` rows across zone 1 and zone 2 — one with
`fraudFlag=true`, one FAILED_NO_PINGS, one PARTIAL_RECOVERY with 1-2 pings and a stalled watermark.
