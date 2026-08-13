import { describe, expect, it } from 'vitest';
import { meetsRecoveryCriteria, summariseRecoveryPings } from '../src/ticketing/recovery-criteria';

/**
 * Issue 08 slice 1 + **#229** — the auto-recovery ping criteria (CONTEXT "Auto-Recovery").
 *
 * **The rule changed on 2026-08-10, deliberately.** Issue 08 implemented two of CONTEXT.md:117's
 * three clauses — ≥3 pings, ≥15 min span — and deferred the third (**≥1 h stability**) to "GPS
 * verification (Issue 18), which owns it". Verification never adopted it, and `meetsRecoveryCriteria`
 * turned out to have exactly one caller, so the weaker predicate was simply the shipped behaviour,
 * diverging from CONTEXT with nothing to reconcile it against. #229 closed that: the full three-part
 * rule now lives here.
 *
 * Measured before changing it: of the 11,042 tickets satisfying ≥3 pings/≥15 min on the live backlog,
 * **all 11,042 also span ≥60 min** — so the tightening removes a doc/code divergence and moves no
 * real ticket. The tests below that used to assert a 16-minute span recovers now assert it does not;
 * that inversion is the change, not a fixture accident.
 *
 * What this predicate deliberately CANNOT see: whether the device is up *right now*. A device that
 * pinged steadily for two hours and then went silent still satisfies every clause here. That
 * liveness question is answered by the caller against `device_states.is_inactive` (#229 D3) — keeping
 * it out of this pure function is why the two concerns stay separable.
 */
const base = Date.UTC(2026, 5, 20, 12, 0, 0);
const at = (mins: number) => new Date(base + mins * 60_000);

describe('Issue 08 slice 1 / #229 — meetsRecoveryCriteria', () => {
  it('is false below the minimum ping count, however long the span', () => {
    expect(meetsRecoveryCriteria([at(0), at(120)])).toBe(false);
  });

  it('is true with ≥3 pings spanning ≥1 h', () => {
    expect(meetsRecoveryCriteria([at(0), at(30), at(75)])).toBe(true);
  });

  it('is true exactly at the 60-minute stability boundary', () => {
    expect(meetsRecoveryCriteria([at(0), at(30), at(60)])).toBe(true);
  });

  it('is false just under the stability boundary', () => {
    expect(meetsRecoveryCriteria([at(0), at(30), at(59)])).toBe(false);
  });

  it('#229 — a 16-minute span no longer recovers: ≥15 min alone was never the CONTEXT rule', () => {
    // This exact input asserted `true` until 2026-08-10. Kept, inverted, as the record of the change.
    expect(meetsRecoveryCriteria([at(0), at(8), at(16)])).toBe(false);
  });

  it('honours custom thresholds — including relaxing stability below the CONTEXT default', () => {
    // Every clause is overridable. Stability must be named explicitly to be relaxed: overriding only
    // `minSpanMinutes` leaves CONTEXT's ≥1 h in force, because the two are separate sentences in the
    // spec and the binding constraint is the larger of them.
    expect(
      meetsRecoveryCriteria([at(0), at(30)], { minPings: 2, minSpanMinutes: 15, minStabilityMinutes: 15 }),
    ).toBe(true);
    expect(meetsRecoveryCriteria([at(0), at(30)], { minPings: 2, minSpanMinutes: 15 })).toBe(false);
  });

  it('is order-independent', () => {
    expect(meetsRecoveryCriteria([at(75), at(0), at(30)])).toBe(true);
  });

  it('summarises the evidence behind a verdict, so a dry-run can show its working', () => {
    expect(summariseRecoveryPings([at(75), at(0), at(30)])).toEqual({
      pingCount: 3,
      firstPing: at(0),
      lastPing: at(75),
      spanMinutes: 75,
    });
  });

  it('summarises an empty ping set without inventing a span', () => {
    expect(summariseRecoveryPings([])).toEqual({
      pingCount: 0,
      firstPing: null,
      lastPing: null,
      spanMinutes: 0,
    });
  });
});
