import { NO_TIMING, resolution, timing, type RawCohortRow } from '../src/reports/commissioning-aggregation.service';
import { RESOLUTION_BUCKET_HOURS, RESOLUTION_MATURITY_HOURS } from '../src/reports/commissioning.config';
import { classifyInstaller } from '../src/reports/installer-classification';

/**
 * The two pieces of the commissioning view that must be explicit rather than emergent: the
 * no-measurement answer, and person-vs-machine attribution. Both are pure functions, so they are
 * pinned directly here rather than only through the e2e's HTTP surface.
 */
describe('commissioning timing — "no data" is not "commissioned instantly"', () => {
  it('returns null medians for an empty sample REGARDLESS of what the aggregates say', () => {
    // The load-bearing case. `percentile_cont` does return null over an empty input, but if it ever
    // returned 0 — or if a future rewrite used COALESCE, or SUM/COUNT, or a summary table that
    // zero-fills — the answer must still be null. The branch is on the sample size alone.
    expect(timing(0, 0, 0)).toEqual({ medianHours: null, p95Hours: null, sampleSize: 0 });
    expect(timing(0, 5, 9)).toEqual({ medianHours: null, p95Hours: null, sampleSize: 0 });
    expect(timing(0, null, null)).toEqual(NO_TIMING);
  });

  it('reports a measured zero as zero, which is a different claim', () => {
    // A device that reported in the same second it was fitted really did commission instantly. That
    // is a measurement, and it must survive — the null is for absence, not for smallness.
    expect(timing(1, 0, 0)).toEqual({ medianHours: 0, p95Hours: 0, sampleSize: 1 });
  });

  it('rounds a real sample to two decimals', () => {
    expect(timing(2, 4.005_1, 5.797)).toEqual({ medianHours: 4.01, p95Hours: 5.8, sampleSize: 2 });
  });
});

/**
 * The resolution curve (#234).
 *
 * Pinned here rather than through HTTP on purpose. Reaching this arithmetic from the e2e would need
 * fixtures that are simultaneously matured (older than RESOLUTION_MATURITY_HOURS) and post-epoch
 * (younger than COMMISSIONING_TTFR_EPOCH) — a window whose width is a function of today's date. Such a
 * test passes this week and silently stops exercising its branches later, which is worse than not
 * having it. Here every input is stated.
 */
describe('commissioning resolution curve', () => {
  /** Cumulative counts, as the SQL emits them: r0..r4 are `ttfr_hours < 4 | 12 | 24 | 48 | 72`. */
  const row = (over: Partial<RawCohortRow>): RawCohortRow =>
    ({
      gPlant: 1, gInstaller: 1, plantId: null, zoneId: null, plantName: null, installerKey: null,
      fitments: 0, online: 0, pending: 0, failed: 0, ttfrSample: 0, medianHours: null, p95Hours: null,
      censusFitments: 0, censusOperational: 0, censusWarehouse: 0, censusUnmirrored: 0,
      r0: 0, r1: 0, r2: 0, r3: 0, r4: 0, rSample: 0, rNever: 0, rPreEpoch: 0, rMatured: 0,
      ...over,
    }) as RawCohortRow;

  it('derives each band as the difference between two cumulative counts', () => {
    // A band can never disagree with the curve drawn above it, because it is not independently
    // counted. 10 online by 4h, 25 by 12h, 60 by 24h, 70 by 48h, 72 by 72h.
    const r = resolution(row({ r0: 10, r1: 25, r2: 60, r3: 70, r4: 72, rSample: 75, rNever: 25, rMatured: 100 }));

    expect(r.buckets.map((b) => b.fitments)).toEqual([10, 15, 35, 10, 2]);
    expect(r.buckets.map((b) => b.cumulativeOnline)).toEqual([10, 25, 60, 70, 72]);
    expect(r.buckets.map((b) => b.upToHours)).toEqual([...RESOLUTION_BUCKET_HOURS]);
    // Measurable, online, and slower than the widest band — 75 measured, 72 inside 72h.
    expect(r.beyondLastBucket).toBe(3);
  });

  it('takes the percentage over sample + never-online, NOT over every matured fitment', () => {
    // The denominator is the whole design. Pre-epoch fitments are excluded WHATEVER THEY DID: their
    // stamp measures the epoch, not the install (median ~8,707h against 17.26h after). Including 400
    // of them would drag every point on the curve toward a population nobody can time.
    const r = resolution(row({ r0: 0, r1: 30, r2: 60, r3: 75, r4: 75, rSample: 75, rNever: 25, rPreEpoch: 400, rMatured: 500 }));

    // 60 of (75 + 25) = 60.0%, not 60 of 500 = 12%.
    expect(r.buckets.map((b) => b.cumulativeOnlinePct)).toEqual([0, 30, 60, 75, 75]);
    expect(r.preEpochExcluded).toBe(400);
    expect(r.curveFitments).toBe(100);
  });

  it('returns NULL percentages when nothing was measured, never zero', () => {
    // NO_TIMING's rule, applied to the curve: "no sample" and "nothing came online in the first four
    // hours" are different claims. On a chart the second draws a line along the floor; the first must
    // draw nothing at all. A cohort of pre-epoch fitments hits this exactly — matured and online, but
    // with no measurable timing anywhere.
    const r = resolution(row({ rSample: 0, rNever: 0, rPreEpoch: 12, rMatured: 12 }));

    expect(r.buckets.every((b) => b.cumulativeOnlinePct === null)).toBe(true);
    expect(r.buckets.every((b) => b.fitments === 0)).toBe(true);
    expect(r.sampleSize).toBe(0);
  });

  it('reports 0% — a real measurement — when there IS a sample and none of it came online', () => {
    // The complement of the case above, and the reason the null branch is on the denominator rather
    // than on the counts. 40 matured fitments, all still silent: that is a 0% curve, not a missing one.
    const r = resolution(row({ rSample: 0, rNever: 40, rMatured: 40 }));

    expect(r.buckets.every((b) => b.cumulativeOnlinePct === 0)).toBe(true);
    expect(r.neverOnline).toBe(40);
  });

  it('partitions the matured population exactly', () => {
    // sample + never = curve, and curve + preEpoch = matured. The two identities are what make the
    // denominator arithmetic rather than a claim, so they are asserted rather than assumed.
    const r = resolution(row({ r0: 5, r1: 8, r2: 9, r3: 9, r4: 9, rSample: 9, rNever: 3, rPreEpoch: 4, rMatured: 16 }));

    expect(r.sampleSize + r.neverOnline).toBe(r.curveFitments);
    expect(r.curveFitments + r.preEpochExcluded).toBe(r.maturedFitments);
    expect(r.maturityHours).toBe(RESOLUTION_MATURITY_HOURS);
  });

  it('excludes pre-epoch fitments SYMMETRICALLY — the correction that inverted the live answer', () => {
    // The bug this pins, found by running the first cut against live `fsm`: pre-epoch fitments that
    // came ONLINE were excluded (no measurable timing) while pre-epoch fitments that stayed SILENT
    // were kept in the denominator. That put the legacy blank-remark bulk load — 1,960 online and
    // silent alike — on one side of the ratio only, and the curve read 37.2% online-by-48h against an
    // actual 96.97%. Not a rounding error: an inverted conclusion.
    //
    // Here: 54 measured (all online inside 48h), 4 post-epoch silent, 1,960 pre-epoch of every kind.
    const r = resolution(row({ r0: 2, r1: 11, r2: 42, r3: 54, r4: 54, rSample: 54, rNever: 4, rPreEpoch: 1_960, rMatured: 2_018 }));

    // 54 of 58 = 93.1%. Under the asymmetric denominator this same row read 54 of 145 = 37.2%.
    expect(r.buckets.find((b) => b.upToHours === 48)!.cumulativeOnlinePct).toBe(93.1);
    expect(r.curveFitments).toBe(58);
    // Whatever they did, pre-epoch fitments are in ONE bucket and it is not the denominator.
    expect(r.preEpochExcluded).toBe(1_960);
  });

  it('keeps the curve monotone', () => {
    // Cumulative counts cannot fall, and neither can the percentages. This is guaranteed by the SQL
    // (`ttfr_hours < bound` over widening bounds) rather than enforced here — which is exactly why it
    // is worth a test: a future rewrite to independently-counted bands could break it silently.
    const r = resolution(row({ r0: 1, r1: 1, r2: 40, r3: 41, r4: 41, rSample: 41, rNever: 9, rMatured: 50 }));

    const pcts = r.buckets.map((b) => b.cumulativeOnlinePct!);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
    expect(r.buckets.every((b) => b.fitments >= 0)).toBe(true);
  });
});

describe('installer classification', () => {
  it('classifies the four shapes found in the source data', () => {
    expect(classifyInstaller('PRATIK PAWAR')).toBe('PERSON');
    expect(classifyInstaller('INTEGRATION_SERVICE')).toBe('SERVICE_ACCOUNT');
    expect(classifyInstaller('RISDA_DURGESH')).toBe('UNCLASSIFIED');
    expect(classifyInstaller(null)).toBe('UNATTRIBUTED');
    expect(classifyInstaller('   ')).toBe('UNATTRIBUTED');
  });

  it('matches machine patterns BEFORE the human-name heuristic', () => {
    // 'TRIP CREATOR' carries a space and would be classified PERSON by shape alone. The ordering in
    // MACHINE_ACCOUNT_PATTERNS is what stops a machine appearing on a technician leaderboard.
    expect(classifyInstaller('TRIP CREATOR')).toBe('SERVICE_ACCOUNT');
  });

  it('catches the depot and admin account families seen in the mirror', () => {
    for (const login of ['UTCL_SERVICE_DEPOT_CBT', 'UTCL_SERVICE_GGU', 'VICAT_KADAPA_SERVICE', 'PRISM_IVTS', 'SERVICE_DGFC']) {
      expect(classifyInstaller(login)).toBe('SERVICE_ACCOUNT');
    }
    for (const login of ['COKE_ADMIN', 'ADANIRMC_ADMIN', 'UTCL_IMPADMIN']) {
      expect(classifyInstaller(login)).toBe('SERVICE_ACCOUNT');
    }
  });

  it('treats hyphen and underscore as the same separator', () => {
    // AutoPlant carries both conventions for the same kind of account. An underscore-only pattern list
    // filed these 245 rows under a technician's label, which is how the gap was found — by running the
    // classifier over every distinct login in the mirror rather than over the ones already imagined.
    expect(classifyInstaller('SERVICE-ACCOUNT-INTEGRATION-SERVICE')).toBe('SERVICE_ACCOUNT');
    expect(classifyInstaller('SERVICE-ACCOUNT-EPOD-SERVICE')).toBe('SERVICE_ACCOUNT');
    expect(classifyInstaller('VBLSERVICE_USER01')).toBe('SERVICE_ACCOUNT');
  });

  it('never merges an unresolvable login into either real class', () => {
    // 17,712 of 24,294 rows are this shape and nothing in the data separates plant-prefixed people
    // from depot accounts. Labelled, shown, never ranked — and never silently called a person.
    for (const login of ['CHITTOR_NARAYAN', 'JOJOBERA_BASTA', 'RCP_AJIT']) {
      expect(classifyInstaller(login)).toBe('UNCLASSIFIED');
    }
  });
});
