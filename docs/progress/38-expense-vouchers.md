# Issue 38 — Expense Vouchers end-to-end · progress (2026-06-28)

**Branch:** `feat/fe-enterprise-ui` (FE worktree). **Status:** done, committed, all gates green.

## Verification finding (Phase 2)
The previous session left #38 essentially unstarted: the only trace was `EXPENSE_VOUCHER` as a value in
the generic `submission_type` enum (an offline-queue seam). No Voucher model, migration, service,
controller, UI, or tests existed (confirmed by `git grep voucher` + INDEX showing no `(done)`). So this
session built it from scratch under strict TDD.

## What shipped
- **Migration** `20260628120000_add_expense_vouchers` (35th): `expense_vouchers` + `expense_voucher_items`,
  `voucher_status` / `expense_category` enums, `(se_id, client_submission_id)` unique, `amount ≥ 0` CHECK,
  FK `se_id → engineer_master`. Applied via `migrate deploy` + `generate` (DB up to date).
- **Backend** `apps/backend/src/vouchers/`: `vouchers.service.ts`, `vouchers.controller.ts`,
  `vouchers.module.ts`, `voucher-notifier.ts` (Issue-03 seam, `LoggingVoucherNotifier`). Registered in
  `app.module.ts`. Lifecycle: create (idempotent, ≥1 photo, → ZONAL_MANAGER_REVIEW) → review
  (APPROVE/REJECT/NEEDS_CLARIFICATION, mandatory reason, own-zone + no-self-approve, SE notify) →
  resubmit → OH export (monthly APPROVED CSV) + multi-select mark-paid.
- **Admin** `apps/admin`: `api/vouchers.ts`, `pages/vouchers/VoucherReviewPage.tsx`, route in
  `AppRoutes.tsx` (manager-gated `/vouchers`), sidebar link in `nav.ts`. Queue recipe + activity check +
  over-limit-red + photo lightbox; OH Finance view (Export + Mark PAID).

## Gates
- Backend: `voucher-service` (13) + `voucher-controller` (5) green; **full suite 561 passed / 2 skipped / 0 failed**; `tsc --noEmit` clean.
- Admin: `vouchers-review` (5) green; **full suite 108 passed**; `vite build` OK.

## Decisions / deferrals
- **SE mobile capture** → already-filed **#61** (blocked by mobile foundation #54). INDEX-linked, not silent.
- **"Finance Excel" = CSV** — matches repo `lib/csv.ts` convention (opens in Excel, zero new dep).
- **Per-category limits** = `CATEGORY_LIMITS` service constant (advisory, drives over-limit red). Moving
  to `system_settings` is a future enhancement, not an AC.
- **Real-time Finance integration** explicitly out of v1 (CONTEXT §Expense Vouchers).

## Commit scope
Issue-38 files only (explicit pathspecs); excluded pre-existing unrelated changes
(`role-backup-controller.e2e-spec.ts`, `test/env/`, `apps/admin/tsconfig.tsbuildinfo`) and the gitignored
`src/generated/`. `pnpm-lock.yaml` untouched.
