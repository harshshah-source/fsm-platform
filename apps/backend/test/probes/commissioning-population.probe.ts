import { PrismaPg } from '@prisma/adapter-pg';
import { describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client';
import { CommissioningAggregationService } from '../../src/reports/commissioning-aggregation.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * #233 AC-1 / AC-6 — the population fix, exercised against the LIVE dev `fsm` database.
 *
 * This file is a PROBE, not part of the suite: `vitest.config.ts` collects `*.spec.ts` against
 * `fsm_test`, and this one deliberately points a second client at `fsm` instead. It is named
 * `*.probe.spec.ts` and run explicitly, because the figures it asserts are properties of a mutating
 * mirror, not of a fixture — re-running it after a master sync will legitimately move them.
 *
 * It exists because #232's AC-2 ("validate against live `fsm`") was written, left unexecuted for
 * three days, and when finally executed turned out to be the defect report for #233. Fixture greens
 * did not catch a missing predicate, because every fixture device was operational. The lesson is
 * cheap to encode: run the real service against the real mirror and look at the number.
 *
 * Deliberately NOT a hand-copied query. It instantiates the actual `CommissioningAggregationService`,
 * so what is measured is the code path the endpoint serves — a second spelling would only prove the
 * second spelling agrees with itself.
 */
const LIVE_URL = process.env.LIVE_FSM_URL ?? 'postgresql://fsm:test123@localhost:5433/fsm';
const OH = { role: 'OPERATIONS_HEAD', zoneId: null };
const BASE = { graceHours: 48, zoneId: null, plantId: null, remarks: null } as const;

describe('LIVE fsm — commissioning population (#233)', () => {
  // Same adapter shape `PrismaService` uses (Prisma 7 takes a driver adapter, not a datasource URL),
  // pointed at the live database instead of the `_test` one the suite provisions.
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: LIVE_URL }) }) as unknown as PrismaService;
  const service = new CommissioningAggregationService(prisma);

  it('reports the operational fleet by default, and the pre-#233 population under all', async () => {
    const operational = await service.cohort(OH, { ...BASE, cohortDays: 90, population: 'operational' });
    const all = await service.cohort(OH, { ...BASE, cohortDays: 90, population: 'all' });

    // eslint-disable-next-line no-console
    console.log(
      '\n#233 live fsm, 90-day cohort\n' +
        `  all         fitments=${all.totals.fitments} online=${all.totals.online} pending=${all.totals.pending} failed=${all.totals.failed}` +
        ` (${pct(all.totals.failed, all.totals.fitments)}% failed)\n` +
        `  operational fitments=${operational.totals.fitments} online=${operational.totals.online} pending=${operational.totals.pending} failed=${operational.totals.failed}` +
        ` (${pct(operational.totals.failed, operational.totals.fitments)}% failed)\n` +
        `  census      ${JSON.stringify(operational.population)}\n` +
        `  ttfr        median=${operational.totals.ttfr.medianHours}h p95=${operational.totals.ttfr.p95Hours}h n=${operational.totals.ttfr.sampleSize}\n`,
    );

    // The mirror grows with every master sync, so these are RELATIONS between the two runs rather than
    // the literal 6,832 / 2,645 measured on 2026-08-13. A frozen literal would fail on the next sync
    // and teach the next reader to delete the test.
    expect(all.totals.fitments).toBeGreaterThan(operational.totals.fitments);
    expect(operational.totals.failed).toBeLessThan(all.totals.failed);
    // The defect, stated as an inequality: warehouse devices were dominating the failure count.
    expect(pct(operational.totals.failed, operational.totals.fitments)).toBeLessThan(
      pct(all.totals.failed, all.totals.fitments) / 2,
    );

    // AC-3 over real data, where every category is genuinely populated — unlike the fixture, which
    // has to manufacture an unmirrored row to reach the fourth branch.
    const c = operational.population;
    expect(c.operational + c.warehouse + c.deactivatedPlant + c.unmirrored).toBe(c.fitmentsInWindow);
    expect(c.warehouse).toBeGreaterThan(0);
    expect(operational.totals.fitments).toBe(c.operational);
    expect(all.totals.fitments).toBe(c.fitmentsInWindow);
    expect(all.population).toEqual(operational.population);
  }, 60_000);

  it('holds the plan at the 90-day ceiling — the window ceiling is a measured contract', async () => {
    const started = Date.now();
    await service.cohort(OH, { ...BASE, cohortDays: 90, population: 'operational' });
    const elapsed = Date.now() - started;

    // eslint-disable-next-line no-console
    console.log(`#233 live fsm, cohort(90d) round trip: ${elapsed} ms`);
    // Measured 23.9 ms of server time on 2026-08-13 (all buffers cached, quicksort in memory). The
    // generous ceiling is for round-trip and cold cache; what it actually guards is the one shape that
    // changes plan — a sequential scan with the GROUP BY spilling to disk, which lands near 1,078 ms.
    expect(elapsed).toBeLessThan(750);
  }, 60_000);

  it('applies the same predicate to install quality', async () => {
    const operational = await service.installQuality(OH, {
      lookbackDays: 90, groupBy: 'installer', sort: 'neverOnlineRate', minInstalls: 30,
      population: 'operational', zoneId: null, plantId: null, remarks: null,
    });
    const all = await service.installQuality(OH, {
      lookbackDays: 90, groupBy: 'installer', sort: 'neverOnlineRate', minInstalls: 30,
      population: 'all', zoneId: null, plantId: null, remarks: null,
    });

    const worst = (r: { rows: { neverOnlineRate: number }[] }) => r.rows[0]?.neverOnlineRate ?? 0;
    // eslint-disable-next-line no-console
    console.log(
      `#233 live fsm, installers(90d, n>=30): all=${all.rows.length} rows worst=${worst(all)} · ` +
        `operational=${operational.rows.length} rows worst=${worst(operational)}`,
    );

    const installs = (r: { rows: { installs: number }[] }) => r.rows.reduce((s, x) => s + x.installs, 0);
    expect(installs(operational)).toBeLessThan(installs(all));
    expect(operational.filters.population).toBe('operational');
  }, 60_000);
});

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}
