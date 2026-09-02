# vouchers primer — for later walkers (first walker, S3, 2026-09-02)

Module lives at `apps/backend/src/vouchers/` (7 endpoints, `/api/vouchers` + `/api/me/vouchers`),
admin screen `apps/admin/src/pages/vouchers/VoucherReviewPage.tsx` (`/vouchers`, ZM/CSM/OH),
mobile `apps/mobile/src/vouchers/VoucherFormScreen.tsx` + `navigation/screens/VouchersScreen.tsx`.

## Login / instrument
`api-walk <ZM|ZM_SOUTH|CSM|OH|WM|SE> <METHOD> <path-no-leading-slash> ['{json}']`. Nothing else
is needed — do not open a browser for anything the API can settle.

## Seeded state: THE TABLE IS EMPTY, AND YOU CANNOT FILL IT
`GET /vouchers` as ZM/CSM/OH → `[]`. `GET /me/vouchers` as SE → `[]`. Zero rows in every status.

**`POST /vouchers` as the SE persona fails: `400 SE_NOT_FOUND`.** `auth-fixture-seed.ts:74`
creates the `users` row for `se.north@fsm.test` (`user_id 22222222-2222-2222-2222-222222222222`)
but no `engineer_master` row, and `vouchers.service.ts:162` requires one. The 15 real engineers
from `GET /engineers` have no password, so no JWT can be minted for them. Result: **no voucher can
be created through the app by any available credential.** Do not burn calls rediscovering this —
see `not-walked.json` → `rootBlocker.fixture` for the one row that unblocks the whole module.

## Traps
- `clientSubmissionId` is `@db.Uuid` but the controller only checks `typeof === 'string'`
  (`:63`). A non-UUID gives an unhandled **500**, not a 400. Send a real UUID.
- `POST /vouchers/mark-paid` returns **200 `result:OK`** even when every id failed; the failure is
  only in `skipped[]`. Never read the HTTP status as success.
- `GET /vouchers` ignores any `status` except `APPROVED`; anything else silently means
  `ZONAL_MANAGER_REVIEW` (`controller.ts:102`).
- A **404 `VOUCHER_NOT_FOUND`** on `/review` or `/resubmit` is a PASS signal for check 6 — the
  guard cleared and the service ran. Compare against the 403 the wrong role gets.

## Settled, free — do not re-walk (all E4, 2026-09-02)
Role gating is real and tight: SE→`GET /vouchers` 403 · WM→`GET /vouchers` 403 ·
ZM→`POST /vouchers` 403 · ZM and CSM→`GET /vouchers/export` 403 · ZM→`mark-paid` 403 ·
WM→`/review` 403 · ZM→`/resubmit` 403 · ZM→`GET /me/vouchers` 403. Export is OH-only, so **no ZM
can pull another zone's money data** — that worry is falsified, the export gap is audit, not scope.
`/api/audit-trail` serves **tickets only** — no role can read a voucher's audit trail anywhere.
