import { canonicalSort, type CandidateTicket } from '../src/recommender/canonical-sort';

/**
 * Issue 10, slice 2 — canonical candidate processing order (ADR-0017, AC#3). Strict deterministic
 * order: Company Tier (PLATINUM>GOLD>SILVER) → Device Bucket (LONG_PENDING→WARNING) → Company Priority
 * Rank (A→B→C) → Oldest Inactive (older first) → Device ID asc. Pinned by a fixture so a refactor
 * cannot silently reorder.
 */
const t = (iso: string) => new Date(iso);

// Intentionally shuffled input covering every tie-break level.
const INPUT: CandidateTicket[] = [
  { ticketId: 'A', companyTier: 'PLATINUM', deviceBucket: 'CRITICAL', companyPriorityRank: 'B', latestGpsDatetime: t('2026-06-20T10:00:00Z'), deviceId: 5n },
  { ticketId: 'B', companyTier: 'PLATINUM', deviceBucket: 'CRITICAL', companyPriorityRank: 'A', latestGpsDatetime: t('2026-06-20T12:00:00Z'), deviceId: 9n },
  { ticketId: 'C', companyTier: 'PLATINUM', deviceBucket: 'LONG_PENDING', companyPriorityRank: 'C', latestGpsDatetime: t('2026-06-20T09:00:00Z'), deviceId: 1n },
  { ticketId: 'D', companyTier: 'GOLD', deviceBucket: 'VERY_SEVERE', companyPriorityRank: 'A', latestGpsDatetime: t('2026-06-20T08:00:00Z'), deviceId: 2n },
  { ticketId: 'E', companyTier: 'PLATINUM', deviceBucket: 'CRITICAL', companyPriorityRank: 'A', latestGpsDatetime: t('2026-06-20T10:00:00Z'), deviceId: 3n },
  { ticketId: 'F', companyTier: 'PLATINUM', deviceBucket: 'CRITICAL', companyPriorityRank: 'A', latestGpsDatetime: t('2026-06-20T10:00:00Z'), deviceId: 7n },
];

describe('Issue 10 slice 2 — canonical candidate sort (ADR-0017)', () => {
  it('orders Tier → Bucket → Rank → Oldest Inactive → Device ID', () => {
    const order = canonicalSort(INPUT).map((c) => c.ticketId);
    // C: Platinum LONG_PENDING (bucket beats the Platinum CRITICALs).
    // E,F,B: Platinum CRITICAL rank A — E & F older (10:00) before B (12:00); E(dev3) before F(dev7).
    // A: Platinum CRITICAL rank B (after rank A).
    // D: Gold (after every Platinum).
    expect(order).toEqual(['C', 'E', 'F', 'B', 'A', 'D']);
  });

  it('does not mutate the input array', () => {
    const copy = [...INPUT];
    canonicalSort(INPUT);
    expect(INPUT).toEqual(copy);
  });
});
