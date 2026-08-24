import {
  applyHardFilters,
  evaluateAllFilters,
  notEnforcedFilters,
  type SeCandidateReadiness,
} from '../src/recommender/hard-filters';

/**
 * Issue 10, slice 3 — Recommender Hard Filters (ADR-0003 layer 1, LLD §13.1, AC#2). Drops ineligible
 * candidates BEFORE scoring: vehicle ON_TRIP, SE unavailable, over Daily Capacity, incomplete Common
 * Kit, a required component unavailable. `STALE`/`UNKNOWN` vehicle readiness is a ZM conflict signal,
 * NOT a drop.
 *
 * **SE activity-ping staleness is NOT a Hard Filter** — `last_activity_at` is visibility/audit only
 * and never removes a candidate (CONTEXT.md Decisions §3 & §16, revised 2026-06-09; the prior 15-min
 * intra-day HEARTBEAT_STALE filter is removed). An SE working offline / in a no-network field area
 * must stay a candidate; intra-day unreachability is handled downstream by the Acceptance Timeout +
 * reroute (Issue 29/30), never by dropping the candidate here.
 */
const ready = (over: Partial<SeCandidateReadiness> = {}): SeCandidateReadiness => ({
  seId: 's1',
  vehicleReadiness: 'READY',
  // #270 — unit tests of the pure filter function feed "real" data by default (enforced: true), so
  // the existing ON_TRIP/COMPONENT_UNAVAILABLE drop assertions below stay byte-identical. The stub
  // feed site (`candidate-readiness.ts`) is what actually sets these `false` in production today.
  vehicleReadinessEnforced: true,
  available: true,
  overCapacity: false,
  commonKitComplete: true,
  expectedComponentsAvailable: true,
  componentAvailabilityEnforced: true,
  ...over,
});

const dropReasons = (c: SeCandidateReadiness) => applyHardFilters([c]).dropped.map((d) => d.reason);

describe('Issue 10 slice 3 — Hard Filters', () => {
  it('keeps a fully-ready candidate', () => {
    const { passed, dropped } = applyHardFilters([ready()]);
    expect(passed.map((c) => c.seId)).toEqual(['s1']);
    expect(dropped).toEqual([]);
  });

  it('drops vehicle ON_TRIP, unavailable, over-capacity, kit-incomplete, component-missing', () => {
    expect(dropReasons(ready({ vehicleReadiness: 'ON_TRIP' }))).toContain('VEHICLE_ON_TRIP');
    expect(dropReasons(ready({ available: false }))).toContain('SE_UNAVAILABLE');
    expect(dropReasons(ready({ overCapacity: true }))).toContain('OVER_CAPACITY');
    expect(dropReasons(ready({ commonKitComplete: false }))).toContain('COMMON_KIT_INCOMPLETE');
    expect(dropReasons(ready({ expectedComponentsAvailable: false }))).toContain('COMPONENT_UNAVAILABLE');
  });

  it('does NOT drop STALE/UNKNOWN vehicle readiness (a ZM conflict signal, not a drop)', () => {
    expect(applyHardFilters([ready({ vehicleReadiness: 'STALE' })]).passed).toHaveLength(1);
    expect(applyHardFilters([ready({ vehicleReadiness: 'UNKNOWN' })]).passed).toHaveLength(1);
  });

  it('never drops a candidate for activity-ping staleness — pings are visibility/audit only (CONTEXT §3/§16)', () => {
    // Regression guard for the 2026-06-09 business-rule correction: the readiness shape carries no
    // activity-ping field and there is no `intraday` option, so a fully-eligible SE always passes
    // regardless of how long ago (or whether ever) the app last pinged. Unreachability is resolved by
    // the intra-day Acceptance Timeout + reroute (Issue 29/30), not by a candidate drop.
    expect(applyHardFilters([ready()]).passed).toHaveLength(1);
    expect(applyHardFilters([ready()]).dropped).toEqual([]);
    // The filter exposes no activity/heartbeat drop reason at all.
    const reasons = applyHardFilters([ready({ available: false })]).dropped.map((d) => d.reason);
    expect(reasons).not.toContain('HEARTBEAT_STALE');
  });
});

/**
 * #270 — honest filter transparency. `VEHICLE_ON_TRIP`/`COMPONENT_UNAVAILABLE` report NOT_ENFORCED
 * while Issues 28/22's feeds are unbuilt, never a fabricated PASSED; a real feed flips the state with
 * no change to `hard-filters.ts` itself (AC3's seam).
 */
describe('#270 — tri-state filter honesty', () => {
  it('a stubbed feed (enforced: false) reports NOT_ENFORCED, never PASSED, and never drops', () => {
    const c = ready({ vehicleReadinessEnforced: false, componentAvailabilityEnforced: false });
    const states = evaluateAllFilters(c);
    expect(states.find((s) => s.filter === 'VEHICLE_ON_TRIP')?.state).toBe('NOT_ENFORCED');
    expect(states.find((s) => s.filter === 'COMPONENT_UNAVAILABLE')?.state).toBe('NOT_ENFORCED');
    expect(applyHardFilters([c]).passed).toHaveLength(1);
    expect(notEnforcedFilters(c)).toEqual(['VEHICLE_ON_TRIP', 'COMPONENT_UNAVAILABLE']);
  });

  it('an enforced feed evaluates for real: PASSED when clean, FAILED when the condition fires — no filter-layer edit needed', () => {
    // Feeding real data directly into the readiness shape (bypassing the still-stubbed feed site)
    // proves hard-filters.ts already handles it: AC3's "wiring flips the state" seam.
    const passing = ready({ vehicleReadinessEnforced: true, vehicleReadiness: 'READY' });
    expect(evaluateAllFilters(passing).find((s) => s.filter === 'VEHICLE_ON_TRIP')?.state).toBe('PASSED');

    const failing = ready({ vehicleReadinessEnforced: true, vehicleReadiness: 'ON_TRIP' });
    expect(evaluateAllFilters(failing).find((s) => s.filter === 'VEHICLE_ON_TRIP')?.state).toBe('FAILED');
    expect(applyHardFilters([failing]).dropped[0]?.reason).toBe('VEHICLE_ON_TRIP');
  });

  it('the three real filters report PASSED/FAILED exactly as their booleans say, drop behaviour unchanged', () => {
    const c = ready();
    const states = evaluateAllFilters(c);
    expect(states.find((s) => s.filter === 'SE_UNAVAILABLE')?.state).toBe('PASSED');
    expect(states.find((s) => s.filter === 'OVER_CAPACITY')?.state).toBe('PASSED');
    expect(states.find((s) => s.filter === 'COMMON_KIT_INCOMPLETE')?.state).toBe('PASSED');

    const unavailable = ready({ available: false });
    expect(evaluateAllFilters(unavailable).find((s) => s.filter === 'SE_UNAVAILABLE')?.state).toBe('FAILED');
    expect(applyHardFilters([unavailable]).dropped[0]?.reason).toBe('SE_UNAVAILABLE');
  });

  it("today's production feed (buildCandidateReadiness-shaped) never reports a PASSED for either stubbed filter", () => {
    // Mirrors what `candidate-readiness.ts` actually emits today, without importing it (that
    // function has its own DB-shaped input) — the same enforced:false pair.
    const c = ready({ vehicleReadinessEnforced: false, componentAvailabilityEnforced: false });
    const states = evaluateAllFilters(c);
    for (const f of states) {
      if (f.filter === 'VEHICLE_ON_TRIP' || f.filter === 'COMPONENT_UNAVAILABLE') {
        expect(f.state).not.toBe('PASSED');
      }
    }
  });
});
