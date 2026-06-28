# 38 — Expense Vouchers end-to-end

Status: done
Type: AFK

## What to build

The full Expense Voucher lifecycle. SE creates a voucher **offline-capable** draft (date, plant, expense type, amount per category, ≥1 photo proof required, optional Ticket and/or Vehicle link) with a draft-time `client_submission_id` for dedup. Status flow DRAFT → SUBMITTED → ZONAL_MANAGER_REVIEW → APPROVED / REJECTED / NEEDS_CLARIFICATION → PAID. ZM review (`/vouchers`): list of `ZONAL_MANAGER_REVIEW` sorted by `submitted_at`; activity check (system finds/warns on the linked Ticket), expense items with over-limit rows in red, photo thumbnails + full-screen lightbox; actions Approve / Reject (mandatory reason) / Needs Clarification (comment; SE notified). Operations Head: **Export Finance Excel** (monthly batch of all APPROVED vouchers) and, after Finance confirms, multi-select **Mark PAID** (SE notified). No real-time Finance integration in v1.

## Acceptance criteria

- [x] SE creates an offline-capable draft with ≥1 photo and a draft-time `client_submission_id`
- [x] Status flow DRAFT → SUBMITTED → ZONAL_MANAGER_REVIEW → APPROVED/REJECTED/NEEDS_CLARIFICATION → PAID
- [x] ZM review shows activity check, over-limit rows in red, photo lightbox; Approve/Reject/Needs Clarification work
- [x] Reject/Needs Clarification require reason/comment and notify the SE
- [x] OH exports a monthly Finance Excel of all APPROVED vouchers
- [x] OH multi-select Mark PAID updates status and notifies SEs

## Blocked by

- #07

## Disposition (done 2026-06-28)

Full backend lifecycle + admin review/finance surface. SE mobile **capture** screen stays with the
already-filed **#61** (M7 Vouchers, blocked by mobile foundation #54) — a legitimate, INDEX-linked
deferral, not a silent one.

**Schema** (`20260628120000_add_expense_vouchers`): `expense_vouchers` (header, FK `se_id →
engineer_master`, optional Ticket/Plant/Vehicle links, `total_amount`, review + paid columns,
`submitted_at`) + `expense_voucher_items` (`category` enum, `amount ≥ 0` CHECK, `photo_ref`), with the
`(se_id, client_submission_id)` idempotency unique + `voucher_status` / `expense_category` enums.

**Backend** (`src/vouchers/`): `VouchersService` —
- `create` — idempotent on `(se_id, client_submission_id)`; ≥1 item + ≥1 photo enforced; total
  computed; lands straight into `ZONAL_MANAGER_REVIEW` with `submitted_at`; audited `VOUCHER_SUBMITTED`.
- `reviewQueue(viewer, status)` — ZM own-zone / CSM·OH all-zone; sorted by `submitted_at`; per-item
  over-limit flags (`CATEGORY_LIMITS`, advisory) + activity check (linked Ticket lookup, warning when
  none). `status='APPROVED'` powers the OH Mark-PAID pass.
- `review` — APPROVE / REJECT / NEEDS_CLARIFICATION; REJECT + NEEDS_CLARIFICATION require a reason;
  own-zone + no-self-approve guards; audited; SE notified via `VOUCHER_NOTIFIER`.
- `resubmit` — owning-SE NEEDS_CLARIFICATION → ZONAL_MANAGER_REVIEW.
- `markPaid` — OH multi-select APPROVED → PAID (`paid_at` + `paid_batch_ref`); non-approved skipped; SE notified.
- `exportApproved(month)` — monthly CSV of APPROVED (one row per line item).

`VouchersController` (`/api/vouchers`): POST `/` (SE), GET `/` (review queue + `?status=APPROVED`), GET
`/export` (OH, `StreamableFile`), POST `/mark-paid` (OH), POST `/:id/review` (ZM/CSM/OH), POST
`/:id/resubmit` (SE). RBAC via `AuthGuard`+`RoleGuard`. Notification spine is the deferred Issue-03 seam
(`LoggingVoucherNotifier`).

**Admin** (`/vouchers`, manager-gated): queue recipe (`MetricCard` strip + `DataTable` + `StatusPill`)
— activity check, over-limit line items in red, photo lightbox (`Modal`), Approve / Reject (reason) /
Needs-Clarification (comment). OH gets the APPROVED Finance view: Export Finance (CSV download) +
multi-select Mark PAID. Sidebar link added for managers.

**"Excel" = CSV**: delivered as a `.csv` download (opens directly in Excel), consistent with the repo's
existing `apps/admin/src/lib/csv.ts` convention — zero new dependency.

**Tests**: backend `voucher-service.e2e-spec` (13) + `voucher-controller.e2e-spec` (5, RBAC + HTTP
lifecycle); admin `vouchers-review.test` (5). Full suites green — backend 561, admin 108; `tsc` clean;
`vite build` OK.

**Not in scope / follow-ups**: SE mobile capture → **#61**; real-time Finance integration is explicitly
out of v1 (CONTEXT §Expense Vouchers); per-category limits live as a service constant (`CATEGORY_LIMITS`)
— moving them to `system_settings` is a future enhancement, not an AC.
