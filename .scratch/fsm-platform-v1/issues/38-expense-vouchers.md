# 38 — Expense Vouchers end-to-end

Status: ready-for-agent
Type: AFK

## What to build

The full Expense Voucher lifecycle. SE creates a voucher **offline-capable** draft (date, plant, expense type, amount per category, ≥1 photo proof required, optional Ticket and/or Vehicle link) with a draft-time `client_submission_id` for dedup. Status flow DRAFT → SUBMITTED → ZONAL_MANAGER_REVIEW → APPROVED / REJECTED / NEEDS_CLARIFICATION → PAID. ZM review (`/vouchers`): list of `ZONAL_MANAGER_REVIEW` sorted by `submitted_at`; activity check (system finds/warns on the linked Ticket), expense items with over-limit rows in red, photo thumbnails + full-screen lightbox; actions Approve / Reject (mandatory reason) / Needs Clarification (comment; SE notified). Operations Head: **Export Finance Excel** (monthly batch of all APPROVED vouchers) and, after Finance confirms, multi-select **Mark PAID** (SE notified). No real-time Finance integration in v1.

## Acceptance criteria

- [ ] SE creates an offline-capable draft with ≥1 photo and a draft-time `client_submission_id`
- [ ] Status flow DRAFT → SUBMITTED → ZONAL_MANAGER_REVIEW → APPROVED/REJECTED/NEEDS_CLARIFICATION → PAID
- [ ] ZM review shows activity check, over-limit rows in red, photo lightbox; Approve/Reject/Needs Clarification work
- [ ] Reject/Needs Clarification require reason/comment and notify the SE
- [ ] OH exports a monthly Finance Excel of all APPROVED vouchers
- [ ] OH multi-select Mark PAID updates status and notifies SEs

## Blocked by

- #07
