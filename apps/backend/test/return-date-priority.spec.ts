import { CRITICAL_PLUS_BUCKETS, isCriticalPlus } from '../src/device-state/sla-bucket';
import { canonicalSort, type CandidateTicket, type DeviceBucket } from '../src/recommender/canonical-sort';

/**
 * #248 — Return-Date Priority (Decision 15, Option C): **Critical/Severe → return-date → normal
 * backlog**, expressed as one new comparator key rather than a second priority system.
 *
 * The key sits at **2b — after Device Bucket, gated to buckets below CRITICAL+**
 * (`docs/audits/four-decisions-readiness-2026-08-18.md` §9). Two consequences follow from that
 * placement and both are pinned below, because they are the whole of why it is safe:
 *
 *  - Step 2 has already ordered a CRITICAL+ ticket ahead before 2b is ever consulted, so the flag
 *    cannot promote work past SLA severity — including when the returning ticket is *itself* the
 *    CRITICAL+ one, in which case the key is never read at all.
 *  - Because step 2 returns whenever the buckets differ, 2b decides only between tickets sharing a
 *    sub-CRITICAL bucket. It outranks Company Priority Rank there, and nothing else moves.
 *
 * The alternative — promoting `sla_bucket` to express priority — was rejected outright: it is a stored
 * enum feeding Fleet Uptime, the Soft Inactive Count that zones are *graded* on, SLA reporting and
 * `dispatch_decision_traces`, and every one of those would be corrupted by it (AC4).
 */
const t = (iso: string) => new Date(iso);

const base = {
  companyTier: 'GOLD',
  companyPriorityRank: 'B',
  latestGpsDatetime: t('2026-06-20T10:00:00Z'),
} as const;

const c = (
  ticketId: string,
  deviceBucket: DeviceBucket,
  over: Partial<CandidateTicket> = {},
): CandidateTicket => ({ ...base, ticketId, deviceBucket, deviceId: ticketId, ...over });

const order = (rows: CandidateTicket[]) => canonicalSort(rows).map((r) => r.ticketId);

describe('#248 — return-date priority, one key below CRITICAL_PLUS', () => {
  it('AC3 — CRITICAL_PLUS is derived from the SLA bands, in severity order, and nothing below CRITICAL is in it', () => {
    expect([...CRITICAL_PLUS_BUCKETS]).toEqual(['CRITICAL', 'HIGH_CRITICAL', 'SEVERE', 'VERY_SEVERE', 'LONG_PENDING']);
    for (const b of ['WARNING', 'EARLY_RISK', 'RISK'] as DeviceBucket[]) expect(isCriticalPlus(b)).toBe(false);
    for (const b of CRITICAL_PLUS_BUCKETS) expect(isCriticalPlus(b)).toBe(true);
    // A missing bucket is not CRITICAL+ — installs and unrankable tickets must not fall into the gate.
    expect(isCriticalPlus(null)).toBe(false);
  });

  it('AC1 — among tickets sharing a sub-CRITICAL bucket, return-due sorts first, ahead of Priority Rank', () => {
    // `due` carries the WORSE priority rank, so a pass would be indistinguishable from rank ordering
    // if the key did nothing.
    const due = c('due', 'RISK', { companyPriorityRank: 'C', returnDueToday: true });
    const normal = c('normal', 'RISK', { companyPriorityRank: 'A' });
    expect(order([normal, due])).toEqual(['due', 'normal']);
    expect(order([due, normal])).toEqual(['due', 'normal']);
  });

  it('AC1 — a return-due ticket never outranks a CRITICAL_PLUS bucket', () => {
    const due = c('due', 'RISK', { returnDueToday: true });
    const critical = c('crit', 'CRITICAL');
    const longPending = c('long', 'LONG_PENDING');
    expect(order([due, critical, longPending])).toEqual(['long', 'crit', 'due']);
    // Pinned the other way too: severity ordering among the CRITICAL+ pair is untouched by the flag.
    expect(order([longPending, critical])).toEqual(['long', 'crit']);
  });

  it('AC1 — a returning ticket that has itself aged into CRITICAL_PLUS never consults the key', () => {
    // Both CRITICAL, so the gate is closed; rank must decide, exactly as it did before this slice.
    const dueWorseRank = c('due', 'CRITICAL', { companyPriorityRank: 'C', returnDueToday: true });
    const normalBetterRank = c('normal', 'CRITICAL', { companyPriorityRank: 'A' });
    expect(order([dueWorseRank, normalBetterRank])).toEqual(['normal', 'due']);
  });

  it('AC1 — the gate is per-pair: a sub-CRITICAL return-due does not jump its own bucket ordering', () => {
    // Option C is a rank *below* CRITICAL+, not a rank above SLA severity generally: bucket still
    // decides between two different sub-CRITICAL buckets, because step 2 returns before 2b is read.
    const dueLowBucket = c('due', 'WARNING', { returnDueToday: true });
    const normalHighBucket = c('normal', 'RISK');
    expect(order([dueLowBucket, normalHighBucket])).toEqual(['normal', 'due']);
  });

  it('AC1/AC5 — two return-due tickets fall through to rank, age and device id, unchanged', () => {
    const rows: CandidateTicket[] = [
      c('z', 'RISK', { returnDueToday: true, companyPriorityRank: 'A', latestGpsDatetime: t('2026-06-20T10:00:00Z'), deviceId: '9' }),
      c('y', 'RISK', { returnDueToday: true, companyPriorityRank: 'A', latestGpsDatetime: t('2026-06-20T10:00:00Z'), deviceId: '3' }),
      c('x', 'RISK', { returnDueToday: true, companyPriorityRank: 'A', latestGpsDatetime: t('2026-06-20T08:00:00Z'), deviceId: '9' }),
      c('w', 'RISK', { returnDueToday: true, companyPriorityRank: 'C', latestGpsDatetime: t('2026-06-20T01:00:00Z'), deviceId: '1' }),
    ];
    // rank A before C; within A, oldest first; within the same age, device id ascending.
    expect(order(rows)).toEqual(['x', 'y', 'z', 'w']);
  });

  it('AC5 — deterministic: the same inputs produce the same order however they arrive', () => {
    const rows: CandidateTicket[] = [
      c('a', 'CRITICAL'),
      c('b', 'RISK', { returnDueToday: true }),
      c('c', 'RISK', { deviceId: '0' }),
      c('d', 'WARNING', { returnDueToday: true }),
      c('e', 'LONG_PENDING', { returnDueToday: true }),
    ];
    const expected = ['e', 'a', 'b', 'c', 'd'];
    expect(order(rows)).toEqual(expected);
    expect(order([...rows].reverse())).toEqual(expected);
    expect(order([rows[2], rows[4], rows[0], rows[3], rows[1]])).toEqual(expected);
  });

  it('#244 AC-6 cross-pin — Special is not an input to the comparator at all', () => {
    // Structural, not behavioural: the only way Special could affect ordering is by being readable
    // here, and it is not. #244 is identification-first, and a second invisible priority input is
    // exactly what that rules out.
    const keys = Object.keys(c('k', 'RISK', { returnDueToday: true }));
    expect(keys).not.toContain('isSpecial');
    expect(keys.some((k) => k.toLowerCase().includes('special'))).toBe(false);
  });

  it('ADR-0017 — the key is absent by default, so pre-#248 candidates order exactly as before', () => {
    const rows: CandidateTicket[] = [c('p', 'RISK', { companyPriorityRank: 'B' }), c('q', 'RISK', { companyPriorityRank: 'A' })];
    expect(rows.every((r) => r.returnDueToday === undefined)).toBe(true);
    expect(order(rows)).toEqual(['q', 'p']);
  });
});
