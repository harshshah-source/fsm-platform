import { NO_TIMING, timing } from '../src/reports/commissioning-aggregation.service';
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
