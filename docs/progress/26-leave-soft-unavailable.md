# Progress — Issue 26: Leave Request + SOFT_UNAVAILABLE

> Build date: 2026-06-24 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **ACCEPTED** (backend AC#1–#5 + admin `/leave-requests` approvals page; mobile SE
> submit/PENDING/SOFT_UNAVAILABLE-set → M-series, blocked-by #54; notifications → #03 seam).
> Backend **+3 e2e files / LeaveRequestService + controller / migration**; admin **+1 page / +1 api /
> +1 test**; `tsc` clean both apps. Migration **20260624180000_add_leave_request**.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | SE submits leave (ON_LEAVE/WEEKLY_OFF + range); ZM notified; SE sees PENDING | 🟢 | `LeaveRequestService.submit` → PENDING; `POST /api/leave-requests`. ZM-notify = #03 seam; SE PENDING badge mobile → M-series. `leave-request-service`/`-controller`. |
| 2 | ZM approve updates `se_availability` + excludes the SE for the window | 🟢 | `approve` calls `SeAvailabilityService.setAvailability` (status = leave type) + links `availability_id`; recommender exclusion is Issue-25 AC#4. Auto-revert verified. |
| 3 | ZM reject notifies SE with reason; SE can revise + resubmit | 🟢 | `reject` (mandatory reason, REJECTED + `decision_reason`); a fresh `submit` is allowed (resubmit). HTTP: 400 without reason. |
| 4 | SOFT_UNAVAILABLE window excludes from intra-day scoring + notifies ZM | 🟢 | SOFT_UNAVAILABLE via `setAvailability`; recommender drops any non-AVAILABLE window (same Hard-Filter path as `recommender-availability`). ZM-notify = #03 seam. `soft-unavailable`. |
| 5 | SOFT_UNAVAILABLE auto-reverts to AVAILABLE at `to_ts` | 🟢 | Time-windowed `currentStatus` returns the active window's status else AVAILABLE — no cron. `soft-unavailable` + `leave-request-service` auto-revert assertions. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — schema.** `LeaveRequest` model + `LeaveRequestType` (ON_LEAVE/WEEKLY_OFF) +
  `LeaveRequestStatus` (PENDING/APPROVED/REJECTED); FK to engineer_master; window-order CHECK; migration
  `20260624180000_add_leave_request` (applied + `prisma generate`).
- **Slice 2 — service.** `LeaveRequestService` submit / approve (→ writes availability window) / reject /
  listForZone; zone-scoped auth (SE-self or own-zone ZM/CSM). `leave-request-service` (6). RED found a
  test-only bug (manager actor built before `beforeAll` set the zone → NaN); fixed lazily.
- **Slice 3 — controller.** `LeaveRequestController` (`/api/leave-requests`): submit (SE/ZM/CSM), list
  (manager), approve/reject (ZM/CSM); validation (type, window, mandatory reject reason); outcome→status.
  `leave-request-controller` (5).
- **Slice 4 — SOFT_UNAVAILABLE.** Explicit AC#4/#5 coverage: SE-set window is active mid-range and
  auto-reverts after `to_ts`. `soft-unavailable` (1).
- **Slice 5 — admin page.** `LeaveRequestsPage` (`/leave-requests`): leave list + Approve / Reject
  (mandatory reason) for ZM/CSM, read-only for Operations Head. Route + nav wired. `leave-requests` (4).

## Deviations / decisions

1. **Approve writes availability, doesn't duplicate it.** `approve` reuses `setAvailability` with the
   leave `type` as the availability status and links the created row via `availability_id` — one source
   of truth for "is the SE off", consumed by the recommender (Issue 25 AC#4).
2. **SOFT_UNAVAILABLE auto-revert is free.** The time-windowed availability model already reverts at
   `window_end`; no scheduler/cron — consistent with `currentStatus` semantics.
3. **Rejected is terminal; resubmit = new row.** Simpler + auditable than mutating a rejected request.
4. **No dedicated v2 mockup for leave** — the admin approvals page follows the established queue layout
   (table + per-row actions + mandatory-reason inline form), parity-consistent with §18/§19 queues.

## Parity-gate disposition

- **Admin surface built in-issue:** `/leave-requests` ZM approvals page.
- **Mobile** SE leave submit + PENDING badge + SOFT_UNAVAILABLE set: M-series, `blocked-by #54`.
- **Notifications** (ZM-on-submit, SE-on-decision): Issue 03 seam (HITL).

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/leave-request-service.e2e-spec.ts test/leave-request-controller.e2e-spec.ts \
  test/soft-unavailable.e2e-spec.ts
cd apps/admin && node node_modules/vitest/vitest.mjs run test/leave-requests.test.tsx
```
