import { describe, expect, it } from 'vitest';
import { isEligibleForUptime } from '../src/device-state/eligibility';

/**
 * Issue 05 slice 4 — the uptime-eligibility gate (CONTEXT "Eligible Device" / LLD `device_eligibility`).
 *
 * Pure predicate: a device counts toward Fleet Uptime (and is ticketable) iff it has an **active
 * PGI within the window (≤15 days)** AND is **not** under a CONFIRMED/ACTIVE Non-Operational marking.
 * Non-Op short-circuits to ineligible regardless of PGI.
 */
const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe('Issue 05 slice 4 — isEligibleForUptime', () => {
  it('is eligible with a recent PGI and no Non-Op marking', () => {
    expect(
      isEligibleForUptime({ latestPgiDate: daysAgo(5), hasActiveNonOp: false, now: NOW }),
    ).toBe(true);
  });

  it('is eligible at the 15-day window boundary (inclusive)', () => {
    expect(
      isEligibleForUptime({ latestPgiDate: daysAgo(15), hasActiveNonOp: false, now: NOW }),
    ).toBe(true);
  });

  it('is ineligible once the PGI is older than the window', () => {
    expect(
      isEligibleForUptime({ latestPgiDate: daysAgo(16), hasActiveNonOp: false, now: NOW }),
    ).toBe(false);
  });

  it('is ineligible with no PGI at all', () => {
    expect(
      isEligibleForUptime({ latestPgiDate: null, hasActiveNonOp: false, now: NOW }),
    ).toBe(false);
  });

  it('is ineligible under a Non-Op marking even with a fresh PGI (short-circuit)', () => {
    expect(
      isEligibleForUptime({ latestPgiDate: daysAgo(1), hasActiveNonOp: true, now: NOW }),
    ).toBe(false);
  });

  it('honours a custom window', () => {
    expect(
      isEligibleForUptime({
        latestPgiDate: daysAgo(20),
        hasActiveNonOp: false,
        now: NOW,
        pgiWindowDays: 30,
      }),
    ).toBe(true);
  });
});
