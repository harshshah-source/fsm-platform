# Progress — Issue 19: Verification Review page + fraud flag

> Build date: 2026-06-23 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Backend **+4 tests / +1 file**; admin **+4 tests /
> +1 file**; `tsc --noEmit` clean both apps. No migration (builds on Issue 18's `verification_runs`).

## Scope & decisions

The ZM-facing GPS Verification Review page (`/verification`) over Issue 18's `verification_runs`, plus
the two row actions. Full-stack: a zone-scoped review list + escalate + mark-auto-recovery API, and the
React page that renders rows by type with the fraud / partial / failed / closed treatments.

Decisions:

1. **`rowType` derived server-side.** The review query maps `(outcome, fraud_flag, pings)` →
   `PARTIAL_RECOVERY` / `FAILED_NO_PINGS` / `FAILED_FRAUD` / `CLOSED` / `CLOSED_AUTO_RECOVERY` / `PENDING`
   so the page renders a single label per row; the 24 h partial countdown deadline (`startedAt + 24 h`)
   is computed alongside.
2. **Mark CLOSED_AUTO_RECOVERY is a new post-submission action** (`VerificationService.markAutoRecovery`)
   — Issue 08's `manualClose` only handles pre-submission OPEN tickets; the review page acts on
   VERIFICATION_PENDING / FAILED rows, so it gets its own zone-scoped action that closes the ticket
   CLOSED_AUTO_RECOVERY + cycle VERIFIED + stamps the run outcome.
3. **Deep-link to the drawer Verification tab** via `?tab=Verification`; the Issue 07 drawer now reads
   the tab from the URL search param (default Overview), so a row click lands on the right tab.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Review filterable by outcome / zone / company / date; default non-CLOSED sorted by submitted_at desc | 🟢 | `VerificationQueryService.review` — zone-scoped, outcome/company/date filters, default `OR(outcome null, ≠ CLOSED)`, `startedAt desc`. `verification-review.e2e-spec.ts` list test. |
| 2 | Row types render correctly incl. PARTIAL_RECOVERY ping count + 24h countdown | 🟢 | `OutcomeCell` renders `N/3 pings · Xh left` from `pingsReceivedCount` + `partialDeadline`. `verification-review.test.tsx` row-types test. |
| 3 | FAILED_VERIFICATION split into "no pings" vs "fraud flag" with distance-delta chip | 🟢 | `rowTypeFor` → `FAILED_NO_PINGS` / `FAILED_FRAUD`; orange `… m off` chip from `firstPingDistanceMeters`. Backend + frontend tests. |
| 4 | Row click opens Ticket Detail Drawer at the Verification tab | 🟢 | Row → `navigate('/tickets/:id?tab=Verification')`; drawer initialises `tab` from the search param. `verification-review.test.tsx` deep-link test. |
| 5 | Escalate (mandatory reason) on fraud rows; Mark CLOSED_AUTO_RECOVERY on auto-recovery rows | 🟢 | `POST /verification/:id/escalate` (400 without reason → ESCALATED) + `POST /verification/:id/mark-auto-recovery`; modal + buttons. Backend (escalate + mark tests) + frontend (escalate + mark tests). |
| 6 | Role/zone scoping enforced | 🟢 | `/verification` route `RoleRoute` manager-only; API `@Roles(MANAGER_ROLES)` (SE 403); ZM pinned to own zone server-side. Backend 403 test. |

## Slice-by-slice RED→GREEN report

- **Backend — review + actions.** `VerificationQueryService.review(filters, scope)` (zone-scoped list +
  derived rowType + partial deadline); `VerificationService.escalateFraud` (→ ESCALATED, mandatory
  reason, audited) + `markAutoRecovery` (→ CLOSED_AUTO_RECOVERY); controller `GET /verification/review`,
  `POST /verification/:id/escalate`, `POST /verification/:id/mark-auto-recovery`.
  `verification-review.e2e-spec.ts` (4).
- **Frontend — review page.** `VerificationReviewPage` (`/verification`) — outcome/company filters,
  per-type `OutcomeCell`, escalate modal (mandatory reason), mark-auto-recovery button, row→drawer
  deep-link; `api/verification.ts` client; route + nav link; drawer `?tab` support.
  `verification-review.test.tsx` (4).

## Deviations / deferred (read before extending)

1. **Action Required panel cross-link deferred.** The "What to build" notes failed-verification items
   should also surface in the ZM dashboard Action Required panel; the review page is the primary
   surface, and the dashboard cross-link is a small follow-up (the panel lives in Issue 06/13's
   dashboard query).
2. **Date-range filter is API-ready, UI shows outcome + company.** The backend `review` accepts
   `dateFrom`/`dateTo`; the page exposes outcome + company controls (date pickers are a trivial add).
3. **Countdown is computed on render** (`hoursLeft`), not a live ticking timer — refreshes on refetch.
4. **`markAutoRecovery` is unconditional for manager scope** — it trusts the ZM's judgement on a review
   row; it does not re-check device pings (that evidence is already visible on the row / drawer).

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run test/verification-review.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/verification-review.test.tsx
# tsc --noEmit clean in both apps
```
