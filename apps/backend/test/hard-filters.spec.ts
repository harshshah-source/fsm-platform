import { applyHardFilters, type SeCandidateReadiness } from '../src/recommender/hard-filters';

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
  available: true,
  overCapacity: false,
  commonKitComplete: true,
  expectedComponentsAvailable: true,
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
