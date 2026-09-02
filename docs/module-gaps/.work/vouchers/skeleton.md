# skeleton — Expense Vouchers (vouchers)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/vouchers` — AppRoutes.tsx:469

## backend endpoints
### apps/backend/src/vouchers/me-vouchers.controller.ts  `@Controller('me/vouchers')`
- `GET /api/me/vouchers` → `list()` :15

### apps/backend/src/vouchers/vouchers.controller.ts  `@Controller('vouchers')`
- `POST /api/vouchers` → `create()` :62
- `GET /api/vouchers` → `queue()` :100
- `GET /api/vouchers/export` → `export()` :108
- `POST /api/vouchers/mark-paid` → `markPaid()` :121
- `POST /api/vouchers/:id/review` → `review()` :134
- `POST /api/vouchers/:id/resubmit` → `resubmit()` :161

## backend units (services / schedulers / jobs)
- `apps/backend/src/vouchers/me-vouchers.service.ts` — class MeVouchersService:66 · getMyVouchers():69
- `apps/backend/src/vouchers/voucher-notifier.ts` — reviewed():24 · paid():25 · class LoggingVoucherNotifier:31 · reviewed():33 · paid():38
- `apps/backend/src/vouchers/vouchers.service.ts` — class VouchersService:134 · create():146 · reviewQueue():210 · review():238 · resubmit():285 · markPaid():312 · exportApproved():358 · if():491 · if():499

## admin UI files
- `apps/admin/src/pages/vouchers/VoucherReviewPage.tsx` — 296 loc · **no data hook**

## admin api client calls (apps/admin/src/api)

## mobile screens
- `apps/mobile/src/vouchers/voucherDisplay.ts` — 39 loc
- `apps/mobile/src/vouchers/VoucherFormScreen.tsx` — 210 loc

## tests touching this module
- `apps/backend/test/me-vouchers-controller.e2e-spec.ts`
- `apps/mobile/src/navigation/screens/VouchersScreen.test.tsx`
