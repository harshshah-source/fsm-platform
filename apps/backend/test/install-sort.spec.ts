import { type InstallCandidate, installSort } from '../src/recommender/canonical-sort';

/**
 * Issue 75 slice 1 — install-backlog ordering. The Recommender processes TROUBLESHOOT first (canonical
 * sort), then the Install backlog in this deterministic order: Company Tier desc → Company Priority Rank
 * asc → oldest backlog (installTargetDate) first → ticketId asc (absolute tie-break). Installs have no
 * SLA bucket, so they never enter the ADR-0017 comparator.
 */
const mk = (over: Partial<InstallCandidate>): InstallCandidate => ({
  ticketId: 't',
  companyTier: 'GOLD',
  companyPriorityRank: 'B',
  backlogAnchor: new Date('2026-06-01'),
  ...over,
});

describe('Issue 75 slice 1 — installSort', () => {
  it('orders Company Tier descending (PLATINUM before GOLD before SILVER)', () => {
    const out = installSort([mk({ ticketId: 's', companyTier: 'SILVER' }), mk({ ticketId: 'p', companyTier: 'PLATINUM' }), mk({ ticketId: 'g', companyTier: 'GOLD' })]);
    expect(out.map((c) => c.ticketId)).toEqual(['p', 'g', 's']);
  });

  it('orders Company Priority Rank ascending within a tier (A before B)', () => {
    const out = installSort([mk({ ticketId: 'b', companyPriorityRank: 'B' }), mk({ ticketId: 'a', companyPriorityRank: 'A' })]);
    expect(out.map((c) => c.ticketId)).toEqual(['a', 'b']);
  });

  it('orders oldest backlog first within tier+rank', () => {
    const out = installSort([
      mk({ ticketId: 'new', backlogAnchor: new Date('2026-06-20') }),
      mk({ ticketId: 'old', backlogAnchor: new Date('2026-05-01') }),
    ]);
    expect(out.map((c) => c.ticketId)).toEqual(['old', 'new']);
  });

  it('sorts a null backlog anchor last, then breaks ties by ticketId', () => {
    const out = installSort([
      mk({ ticketId: 'z', backlogAnchor: null }),
      mk({ ticketId: 'a', backlogAnchor: null }),
      mk({ ticketId: 'dated', backlogAnchor: new Date('2026-06-10') }),
    ]);
    expect(out.map((c) => c.ticketId)).toEqual(['dated', 'a', 'z']);
  });
});
