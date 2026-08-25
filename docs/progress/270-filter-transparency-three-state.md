# 270 — Honest filter transparency: PASSED / FAILED / NOT_ENFORCED

**Status:** DONE · 2026-08-24 · branch `feat/autoplant-integration`
**Issue:** `.scratch/fsm-platform-v1/issues/270-filter-transparency-three-state.md` · **Decision:**
#258 Q5 (both filters stay non-blocking in Phase 1) + Q4 (eligibility proxy stated, not hidden)
**Suite at completion:** backend hard-filters + recommender/dispatch-transparency specs green (see §4);
admin `tsc --noEmit` clean, 6 new admin component tests green.

---

## 1. What was wrong

`hard-filters.ts` evaluated five filters but only ever reported the **first failing** one per
candidate; a candidate that passed had no per-filter record at all. Two of the five filters
(`VEHICLE_ON_TRIP`, `COMPONENT_UNAVAILABLE`) are fed by stubs that can never fire
(`vehicleReadiness` hardcoded `'UNKNOWN'`, `expectedComponentsAvailable` hardcoded `true` in
`candidate-readiness.ts`), so they always read as an implicit pass — indistinguishable from a real
evaluation in the trace, the admin trace drawer, or anywhere else. The `eligibility_mode` proxy
(`all-deployed`, live since 2026-07-10) was documented only in SYSTEM-STATE prose, not on the admin
surface an operator actually reads the setting from.

## 2. What was built

**One honesty vocabulary, defined once (`hard-filters.ts`):**

```ts
export type FilterState = 'PASSED' | 'FAILED' | 'NOT_ENFORCED';
```

`SeCandidateReadiness` gained two booleans — `vehicleReadinessEnforced`, `componentAvailabilityEnforced`
— set at the **feed site** (`candidate-readiness.ts`, both `false` today). `evaluateFilter`/
`evaluateAllFilters` read them; `firstFailure` (drop selection) now skips any `NOT_ENFORCED` result
exactly like a `PASSED` one, so **drop semantics and `dropCounts` are byte-identical** to before this
issue — the only change is that a stubbed filter now says so explicitly instead of silently never
appearing.

**Wired into the trace (`recommender.service.ts`):** every `chosen` and `runnersUp` entry in
`dispatch_decision_traces.trace` now carries its own `filterStates: {filter, state}[]`, plus a
top-level `notEnforcedFilters: HardFilterReason[]` (identical for every candidate today — both stub
feeds are global — computed once per ticket). `PreviewDecision` (the dry-run projection) gained the
same `notEnforcedFilters` field, so a preview carries the same honesty as a real run.

**Admin surfaces:**
- `DecisionTrace.tsx` (the transparency drawer, Issue 123's "why this SE" panel) renders a muted
  "Not enforced — data source pending: … (#65/#22)" line when `notEnforcedFilters` is non-empty;
  absent entirely for an older backend build that never sent the field (version skew, matching the
  file's existing `identity?` guard convention).
- `ConfigInEffectPanel.tsx` (Dispatch Run detail's "Configuration in effect" panel) — the actual
  surface an operator reads `eligibility_mode`'s live value from today (there is no dedicated Settings-
  page row for this key; see §3) — now shows the proxy limitation text when the value is
  `'all-deployed'`: *"ACTIVE/DEPLOYED vehicle proxy — includes deployed-but-idle vehicles; PGI-based
  eligibility is Phase 2 (#116)."*

## 3. Corrections to the issue text

- **"Settings page `eligibility_mode` row"does not exist.** `apps/admin/src/pages/settings/sections.tsx`
  has no row for this key at all — it is set only via the generic `PUT /api/settings/:key` endpoint and
  read back only in `ConfigInEffectPanel` (the Dispatch Run detail page's frozen per-run config
  snapshot). That panel is the actual surface an operator reads the live value from, so the helper text
  landed there instead. Filed as observed reality, not a new gap: adding a full editable Settings-page
  section for `eligibility_mode` was out of this issue's scope (helper text only, no behaviour change).
- **`(#65/#51)` — no `#51` issue file exists.** `.scratch/fsm-platform-v1/issues/` has no `51-*.md`;
  the component-availability seam this issue means is `#22`
  (`22-component-request-flow-waiting-component.md`), which is what the existing `candidate-readiness.ts`
  docstring already calls "Issue 22" and what `21-van-stock-common-kit-component-blocked.md` cites as
  the deferred leg. The admin drawer cites `(#65/#22)`.
- **`scoreBreakdown` never had a "filter section."** `ScoringWeights`/`ScoreBreakdown`
  (`scoring.ts`) are score-component-only and always have been; there was nothing filter-shaped there
  to make tri-state. The tri-state honesty lives in the trace's `filterStates`/`notEnforcedFilters` and
  the preview's `notEnforcedFilters` — what the trace drawer and every AC actually read.

## 4. Tests

- `test/hard-filters.spec.ts` — extended fixture (`vehicleReadinessEnforced`/`componentAvailabilityEnforced`
  default `true`, matching "unit tests feed real data" so existing ON_TRIP/COMPONENT_UNAVAILABLE drop
  assertions stay byte-identical) + new `#270` describe block: stub → NOT_ENFORCED never PASSED never
  drops; enforced feed flips PASSED/FAILED with **no filter-layer edit** (AC3, the Phase-2 seam); the
  three real filters unchanged (AC2). 8 → 12 tests, all green.
- `test/recommender-filter-honesty.e2e-spec.ts` (new) — a real dispatch run (`DispatchRunService` →
  `dispatch_decision_traces`), asserting the winner's `filterStates` show `NOT_ENFORCED` for
  `VEHICLE_ON_TRIP`/`COMPONENT_UNAVAILABLE` and never `PASSED` for either (AC1, "over a full run's
  traces"), `notEnforcedFilters` names exactly those two, and the three real filters read `PASSED` for
  a clean candidate (AC2). 3 tests, green.
- `apps/admin/test/decision-trace-not-enforced.test.tsx` (new) — the drawer renders the muted note when
  present, renders nothing when the list is empty or the field is absent (version skew). 3 tests, green.
- `apps/admin/test/config-in-effect-eligibility.test.tsx` (new) — the proxy caveat shows only under
  `all-deployed`, not `pgi`, not when the setting was never captured (AC4). 3 tests, green.
- Regression: `recommender-trace-scores`, `recommender-run`, `recommender-dry-run`,
  `recommender-availability`, `recommender-common-kit`, `recommender-score-selection`,
  `dispatch-transparency(-api)`, `dispatch-run(-controller)`, `scheduler-wiring`,
  `assign-console-candidates`, `intraday-insertions-controller` — all green, no drop-behaviour or
  cron-count regressions. Backend `tsc --noEmit` and admin `tsc --noEmit` both clean.

## 5. What's left

None on this issue's own ACs. `docs/SYSTEM-STATE-2026-07.md`'s `eligibility_mode` config-table line
(§ config table) was re-read, not edited — it already states the `all-deployed` proxy and its
limitation accurately (line ~1766), so AC4's "re-verified" is satisfied with no edit needed.
