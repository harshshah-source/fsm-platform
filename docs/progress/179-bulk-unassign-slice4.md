# 179 — OH bulk unassign, Slice 4 (admin UI) — issue complete

TDD completion report. Frozen once written — corrections go to INDEX/SYSTEM-STATE, not here.
All four slices of #179 are now done; this closes the issue.

## AC-by-AC

- **`BulkUnassignService.history()` + `GET /api/schedules/bulk-unassign/history` (OH-only)** —
  reads `audit_logs` where `action = 'BULK_UNASSIGN_ZONE'`, newest first, joins zone names, and
  derives `ticketsUnassigned` from the stored `counts` (`eligible + onSite + componentBlocked`).
  Skipped (lock-contended) rows carry `skipped: true` / `skipReason` and `ticketsUnassigned: 0`.
- **Admin page: two buttons, deliberately separate** — `BulkUnassignPage.tsx`. "Unassign" opens the
  preview modal; "Run dispatch" calls the existing `POST /schedules/dispatch-run` (Slice 2's
  optional `zoneId`) directly, with its own result rendering — a failure in one action is legible
  independently of the other, matching the operator's stated reason (know exactly where you stand).
- **Preview modal with per-class counts** — renders `"N eligible · N on-site · N waiting on parts"`
  plus the three excluded classes, per zone.
- **Typed confirmation** — the zone's name (or the literal `"PAN INDIA"` for Pan-India scope) must
  be typed before the confirm button's click handler will call `executeBulkUnassign`; a mismatch
  sets an inline error and makes no network call.
- **Result by zone incl. skipped** — after execute, each zone renders either
  `"<ticketsUnassigned> unassigned"` or `"Skipped — <skipReason>"`.
- **History list from `audit_logs`** — the `DataTable` below the controls, refreshed after every
  successful execute.
- **The "only helps when data changed" copy, verbatim** — rendered as static text beside the
  Unassign button (not only inside the modal), asserted by regex in the first FE test.
- **Nav + route, OH-only** — `Bulk Unassign` under the Admin nav group (`IconShuffle`), route
  `/bulk-unassign` behind `RoleRoute roles={['OPERATIONS_HEAD']}`, both mirroring Plant
  Deactivations' registration.

## RED → GREEN

**Backend (2 cycles):**
1. `test/bulk-unassign-history.e2e-spec.ts` — drove one completed unassign (through the
   already-tested `execute()`) and one lock-contended run (a second `execute()` call while a
   second connection holds the same advisory lock key) into the audit log, then asserted
   `history()`'s shape for both. RED: `svc.history is not a function`. GREEN: the method above.
2. `test/bulk-unassign-controller.e2e-spec.ts` (appended `describe` block) — RED: 404 on all three
   role-guard cases (route didn't exist). GREEN: `GET bulk-unassign/history`, `@Roles('OPERATIONS_HEAD')`.

**Frontend (one RED file, five tests, built together as one component):**
Wrote all five tests first (nav gating + four page-interaction tests) against a component that
didn't exist; confirmed RED (`Failed to resolve import`), then built `BulkUnassignPage.tsx` in one
pass to satisfy all five — the same granularity as the earlier backend cycles that drove multiple
assertions from one implementation, since these tests all exercise one cohesive component's
behavior rather than independently addable features. 4 of 5 passed on the first implementation
pass; the fifth (nav gating) needed the nav entry + route, added as a small separate step.

**A real bug the tests caught before commit:** the confirm handler's first draft called `onDone()`
(which both closed the modal and refreshed history) immediately after a successful execute — that
would have unmounted the `PreviewDialog` before the OH could read the per-zone result, including
whether a zone was skipped for lock contention. The "shows the per-zone result" assertion
(`findByTestId('unassign-result-1')`) is what caught it: it needs the modal still open to query
against. Fixed by splitting `onExecuted` (history refresh only) from `onClose` (the OH's own
dismissal).

**Two component-API mismatches found while wiring, not bugs in the app itself:** the shared `Select`
component doesn't accept a `data-testid` prop (no rest-spread onto the trigger button) — the test
was rewritten to query by `getByRole('combobox', {name: 'Zone'})` instead, which is arguably the
more correct assertion anyway. And a loosely-typed `fetchMock.mock.calls.some(([u, i]: [...]) =>
...)` destructuring pattern didn't satisfy `tsc` against Vitest's mock-call array type; rewritten
without the destructured tuple annotation.

## Tests / typecheck

- New backend: `test/bulk-unassign-history.e2e-spec.ts` (1 test). Extended (not modified
  elsewhere): `test/bulk-unassign-controller.e2e-spec.ts` (+3 tests in a new `describe`, existing 6
  unchanged).
- New admin: `test/bulk-unassign-page.test.tsx` (5 tests).
- Backend regression: `bulk-unassign`, `bulk-unassign-execute`, `bulk-unassign-controller`,
  `bulk-unassign-history`, `schedules-controller`, `schedules-route-conflicts`,
  `dispatch-run-controller` — 7 files / 29 tests green.
- Admin regression: `routing`, `build-health-page`, `plant-zones`, `tier-overrides`,
  `dispatch-runs`, `exports-page`, `plant-deactivations-page`, `bulk-unassign-page` — 8 files / 36
  tests green.
- `npx tsc --noEmit -p .`: clean, both apps.

## REFACTOR

The `onExecuted`/`onClose` split described above (was a bug, not a stylistic refactor — recorded
under RED→GREEN, not here, since it was caught by the test rather than cleaned up after).

## Remaining work

None on #179 — all four slices are done. The issue is closed by this report.
