# 270 — Honest filter transparency: evaluated-passed / evaluated-failed / NOT_ENFORCED

Status: done — 2026-08-24, docs/progress/270-filter-transparency-three-state.md
Type: AFK · Backend + Admin
Decision: #258 Q5 (both filters stay non-blocking in Phase 1; transparency must not claim a pass
that was never enforceable) + Q4 documentation AC (eligibility proxy stated, not hidden)

## Objective

The trace/breakdown/UI never show "Filter → PASSED" for a filter whose authoritative data does not
exist. `VEHICLE_ON_TRIP` and `COMPONENT_UNAVAILABLE` report NOT_ENFORCED until their Phase 2 feeds
(#65, #51) land.

## Current behaviour (verified)

- `hard-filters.ts:40-47` evaluates five filters; two are fed constants —
  `vehicleReadiness: 'UNKNOWN'` (`recommender.service.ts:452`) and
  `expectedComponentsAvailable: true` (`:457`) — so they can never fire, yet they sit in the same
  enum/trace/UI vocabulary as the real three, indistinguishable from a genuine pass.
- The filter-reason buckets (`unassignableReasons` dropBuckets) and the admin trace drawer render
  all five as if enforced.
- Q4 context: `eligibility_mode='all-deployed'` proxy is live (set 2026-07-10, audited); its
  limitation is documented only in SYSTEM-STATE prose, not on the surface where an operator reads
  the setting.

## Required change

1. Filter evaluation returns a tri-state per filter: `PASSED | FAILED | NOT_ENFORCED`. Drop
   semantics unchanged (first FAIL wins; NOT_ENFORCED never drops — Phase 1 ruling). The two
   stubbed feeds map to NOT_ENFORCED **at the feed site**, so when #65/#51 land, wiring real data
   flips the state with no filter-layer change.
2. Trace rows, `scoreBreakdown` filter section, and preview decisions carry the tri-state; the
   admin trace drawer renders NOT_ENFORCED distinctly (muted "not enforced — data source pending
   (#65/#51)"), never as a pass.
3. `#267`'s `distance: NOT_AVAILABLE` uses the same vocabulary (one honesty convention, defined
   once in `hard-filters.ts`/a shared type).
4. Q4 doc AC: the Settings page `eligibility_mode` row's helper text states the proxy limitation
   ("ACTIVE/DEPLOYED vehicle proxy — includes deployed-but-idle vehicles; PGI-based eligibility is
   Phase 2 (#116)"); SYSTEM-STATE §config table line re-verified. No behaviour change (Q4 confirms
   the current proxy).

## Existing code to reuse

`hard-filters.ts` (shape change, logic intact); trace plumbing; `FilterDropReason` vocabulary;
settings page sections (#136 posture text precedent).

## Data model

None (JSON shape addition inside existing columns).

## API

Trace/preview payloads gain the tri-state field (additive).

## UI surfaces

Admin: dispatch trace drawer (state chip), Settings eligibility row (helper text). Mobile: n/a.

## Reference

`docs/ui/desktop/v2-reference/` transparency + settings pages (text/chip only, no redesign).

## Acceptance criteria

- [x] With today's stub feeds, every trace shows VEHICLE_ON_TRIP and COMPONENT_UNAVAILABLE as
      NOT_ENFORCED — zero occurrences of a PASSED claim for either (asserted over a full run's
      traces). `test/recommender-filter-honesty.e2e-spec.ts`.
- [x] Real filters unchanged: SE_UNAVAILABLE/OVER_CAPACITY/COMMON_KIT show PASSED/FAILED exactly as
      before; drop behaviour byte-identical. `test/hard-filters.spec.ts`.
- [x] Feeding a real readiness value in a test flips VEHICLE_ON_TRIP to PASSED/FAILED with no
      filter-layer edit (the Phase 2 seam proven). `test/hard-filters.spec.ts`.
- [x] Settings page shows the proxy limitation text — **correction:** no dedicated Settings-page row
      for `eligibility_mode` exists; the text landed on `ConfigInEffectPanel`, the actual surface an
      operator reads the live value from. See `docs/progress/270-filter-transparency-three-state.md` §3.

## Tests

Unit: tri-state mapping; e2e: trace-honesty spec + settings text; update `hard-filters.spec.ts`.

## Dependencies / Blocked by

None. #267 shares the vocabulary (coordinate the shared type if concurrent).

## Risks

Low — additive honesty. The only care point: `unassignableReasons` bucket keys must not silently
change (transparency history reads them).

## Rollback

Code-only.
