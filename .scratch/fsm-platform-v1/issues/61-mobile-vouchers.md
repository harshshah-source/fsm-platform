# 61 — M7: Vouchers (mobile capture)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE Vouchers tab (Issue 38 expense-vouchers backend): voucher capture (amount, category, photo of
receipt), submission, and a status list. Drafts are **offline-capable** with a `client_submission_id`
(PRD Flow 9). Consumes the Issue 38 voucher endpoints.

## Business rules (authority)

- PRD §597 Flow 9 (offline draft, ≥1 photo required before submit) + §494 (My Vouchers statuses:
  DRAFT / SUBMITTED / ZONAL_MANAGER_REVIEW / APPROVED / REJECTED / NEEDS_CLARIFICATION / PAID).

## Acceptance criteria

- [ ] Voucher capture form (amount, category, receipt photo) submits to `/api/vouchers`
- [ ] Submitted vouchers list with status rendered
- [ ] Photo capture wired via the component kit
- [ ] Draft is created locally with a `client_submission_id` and works offline (PRD Flow 9)

## API contract (authority: backend on `main`)

- `POST /api/vouchers` — body `{ clientSubmissionId (required), plantId?, ticketId?, vehicleId?,
  items:[{ category, amount, merchantVendorName?, expenseDatetime?, photoRef? }] }`
  (`vouchers/vouchers.controller.ts`). Idempotent on `(se_id, client_submission_id)`.
- List read: the SE's own vouchers with status (Issue 38 read surface).

## Validation & error codes

- `CLIENT_SUBMISSION_ID_REQUIRED`, `NO_ITEMS`, `INVALID_CATEGORY { category }`, `INVALID_AMOUNT`,
  **`PHOTO_REQUIRED`** (≥1 item must carry a non-empty `photoRef`) — all 400; surface inline.
- Category picker mirrors the server's `VALID_CATEGORIES`; advisory per-category soft limits exist
  server-side (CATEGORY_LIMITS) and are review-only — do not block submit on them.

## Photo handling ⚠

- `photoRef` is a STRING reference, not a blob/multipart. The capture→ref step needs the media-upload
  endpoint (**#81 — Media Upload API**); block the photo AC on it.

## Permissions

- SE owns create/resubmit. Review (Approve/Reject/Needs-Clarification) + Mark PAID are manager/OH (Issue 38).

## Offline behaviour (PRD §599)

- Draft created locally with `clientSubmissionId`, fully offline; auto-submits on reconnect via Issue 17.

## Edge cases & failures

- Submit with 0 photos → `PHOTO_REQUIRED`.
- Duplicate `client_submission_id` retry → returns the existing voucher (no second record).

## UI surfaces

- **Mobile:** Vouchers tab. Owned by this issue.
- **Admin:** n/a (admin voucher review is Issue 38).

## Reference

- `docs/ui/mobile/vouchers.png`

## Tests (TDD targets — red first)

- Submit with no photo → `PHOTO_REQUIRED`; invalid category → `INVALID_CATEGORY`.
- Idempotent re-submit returns the same voucher.
- My-Vouchers list renders all 7 statuses.

## Blocked by

- #54, #38
- (offline-draft AC) #17 — Offline queue (which depends on #82 sync transport)
- (photo AC) #81 — Media Upload API

## Comments

### 2026-07-28 — #172 decision 6

The upload block has **3 named document types** — `Receipt`, `Photo`, `Bill` — not one opaque
`photoRef` per item. **#81** owes the slot semantics. The claim-list half of this screen (rollups,
statuses, rejection reason to act on) is unreadable by an SE today and is owned by **#163**; the
item DTO also has no `description` field, which the form shows.
