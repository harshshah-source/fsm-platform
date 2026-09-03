import {
  deriveTicketActionStatus,
  hoursSinceAssignment,
} from '../src/scheduling/ticket-action-status';

/**
 * #295 — the dispatch board's per-ticket action status. A render-time derivation, never stored, and
 * a sibling in spirit to `deriveActivityStatus` (ADR-0023) — which is the *engineer's* label and
 * cannot answer this question.
 *
 * The whole point of this module is that **two clocks are not one clock**. A device may have been
 * silent for 40 hours; that is `inactivityHours`, it is printed on the card, and it says nothing
 * about whether anyone has picked the work up. What turns a card yellow is the *assignment* going
 * untouched — time since `batch_assignment_tickets.created_at` with no TROUBLESHOOT_STARTED against
 * it. A ticket dispatched ten minutes ago is red however long its device has been quiet.
 */
describe('deriveTicketActionStatus (#295)', () => {
  const base = { troubleshootingStarted: false, hoursSinceAssignment: 0, agingThresholdHours: 4 };

  it('IN_PROGRESS the moment troubleshooting has started — it outranks every age', () => {
    expect(deriveTicketActionStatus({ ...base, troubleshootingStarted: true })).toBe('IN_PROGRESS');
    // Long past the threshold, and still green: somebody is on it, which is the question the colour
    // answers. Aging describes work nobody has touched.
    expect(
      deriveTicketActionStatus({ ...base, troubleshootingStarted: true, hoursSinceAssignment: 99 }),
    ).toBe('IN_PROGRESS');
  });

  it('NOT_STARTED while untouched and inside the threshold', () => {
    expect(deriveTicketActionStatus({ ...base, hoursSinceAssignment: 0 })).toBe('NOT_STARTED');
    expect(deriveTicketActionStatus({ ...base, hoursSinceAssignment: 3.9 })).toBe('NOT_STARTED');
  });

  it('AGING_UNTOUCHED once untouched past the threshold', () => {
    expect(deriveTicketActionStatus({ ...base, hoursSinceAssignment: 4.1 })).toBe('AGING_UNTOUCHED');
    expect(deriveTicketActionStatus({ ...base, hoursSinceAssignment: 40 })).toBe('AGING_UNTOUCHED');
  });

  /**
   * `>=`, matching `overCapacity`'s convention in the same payload (`committed >= dailyCapacity`).
   * One comparison operator for "has reached its limit" across the surface, so an operator who has
   * learnt the capacity badge has learnt this too.
   */
  it('exactly at the threshold is already aging', () => {
    expect(deriveTicketActionStatus({ ...base, hoursSinceAssignment: 4 })).toBe('AGING_UNTOUCHED');
  });

  /** Clock skew, not a business case: a negative age must not wrap round into "aged". */
  it('an assignment timestamped in the future reads as untouched, never as aged', () => {
    expect(deriveTicketActionStatus({ ...base, hoursSinceAssignment: -2 })).toBe('NOT_STARTED');
  });

  it('honours the threshold it is given rather than a constant of its own', () => {
    const twelveHoursOld = { ...base, hoursSinceAssignment: 12 };
    expect(deriveTicketActionStatus({ ...twelveHoursOld, agingThresholdHours: 8 })).toBe('AGING_UNTOUCHED');
    expect(deriveTicketActionStatus({ ...twelveHoursOld, agingThresholdHours: 24 })).toBe('NOT_STARTED');
  });
});

describe('hoursSinceAssignment (#295)', () => {
  const NOW = new Date('2026-09-01T12:00:00Z');

  it('measures from the assignment timestamp to now, in hours', () => {
    expect(hoursSinceAssignment(new Date('2026-09-01T09:00:00Z'), NOW)).toBe(3);
    expect(hoursSinceAssignment(new Date('2026-09-01T11:30:00Z'), NOW)).toBe(0.5);
  });

  it('is zero at the instant of assignment', () => {
    expect(hoursSinceAssignment(NOW, NOW)).toBe(0);
  });
});
