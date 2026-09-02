# skeleton — GPS Verification Review (verification)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
- `/verification` — AppRoutes.tsx:459

## backend endpoints
### apps/backend/src/verification/verification.controller.ts  `@Controller('')`
- `GET /api/verification/review` → `review()` :42
- `POST /api/verification/:ticketId/escalate` → `escalate()` :67
- `POST /api/verification/:ticketId/mark-auto-recovery` → `markAutoRecovery()` :88
- `GET /api/tickets/:id/verification` → `forTicket()` :103
- `GET /api/verification/fraud-flags` → `fraudFlags()` :111

## backend units (services / schedulers / jobs)
- `apps/backend/src/verification/verification-criteria.ts` — if():63 · if():67 · if():70
- `apps/backend/src/verification/verification-query.service.ts` — if():54 · if():55 · if():56 · if():57 · if():82 · if():83 · class VerificationQueryService:105 · forTicket():115 · review():173 · fraudFlags():214
- `apps/backend/src/verification/verification.service.ts` — class VerificationService:43 · runVerification():48 · escalateFraud():84 · markAutoRecovery():157

## admin UI files
- `apps/admin/src/pages/verification/VerificationReviewPage.tsx` — 295 loc · **no data hook**

## admin api client calls (apps/admin/src/api)

## mobile screens
_no mobile surface declared for this module_

## tests touching this module
- `apps/backend/test/install-verification.e2e-spec.ts`
- `apps/backend/test/verification-controller.e2e-spec.ts`
- `apps/backend/test/verification-criteria.spec.ts`
- `apps/backend/test/verification-guarded-transitions.e2e-spec.ts`
- `apps/backend/test/verification-review.e2e-spec.ts`
- `apps/backend/test/verification-run.e2e-spec.ts`
- `apps/backend/test/verification-runs-schema.e2e-spec.ts`
- `apps/backend/test/verification-staleness.e2e-spec.ts`
- `apps/mobile/src/tickets/verification/VerificationScreen.test.tsx`
