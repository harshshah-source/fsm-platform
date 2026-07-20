import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { AuditService } from '../src/audit/audit.service';
import { DeviceStateService } from '../src/device-state/device-state.service';
import { getBuildInfo } from '../src/build-info/build-info';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings.service';

/**
 * #130 L5 — every recompute appends a `device_state_recomputes` row (counts + build stamp + trigger),
 * and an eligible-count swing beyond the threshold logs the LOUD canary warning (never throws). This
 * is the attribution the incident's write class never had.
 */
describe('#130 L5 — recompute ledger + semantic canary', () => {
  let prisma: PrismaService;
  let service: DeviceStateService;

  const NOW = new Date(Date.UTC(2026, 6, 20, 12, 0, 0));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const settings = new SettingsService(prisma, new AuditService(prisma));
    await settings.seedDefaults();
    service = new DeviceStateService(prisma, settings);
  });

  // The `_test` DB persists across runs, and other spec files' real DeviceStateService.recompute()
  // calls append ledger rows as a side effect (by design). Clean both before AND after each test so
  // this file's row-count assertions never depend on what ran earlier in the shared DB.
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM device_state_recomputes');
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM device_state_recomputes');
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('appends one ledger row per recompute — counts match device_states, stamped with build + trigger', async () => {
    await service.recompute(NOW, 'test');

    const rows = await prisma.deviceStateRecompute.findMany({ orderBy: { computedAt: 'desc' } });
    expect(rows).toHaveLength(1);
    const row = rows[0];

    const [live] = await prisma.$queryRawUnsafe<Array<{ total: string; eligible: string; inactive: string; departed: string }>>(
      `SELECT count(*)::text total,
              count(*) FILTER (WHERE eligible_for_uptime)::text eligible,
              count(*) FILTER (WHERE is_inactive)::text inactive,
              count(*) FILTER (WHERE is_departed)::text departed
       FROM device_states`,
    );
    expect(row.totalCount).toBe(Number(live.total));
    expect(row.eligibleCount).toBe(Number(live.eligible));
    expect(row.inactiveCount).toBe(Number(live.inactive));
    expect(row.departedCount).toBe(Number(live.departed));

    const build = getBuildInfo();
    expect(row.buildVersion).toBe(BigInt(build.version));
    expect(row.buildFingerprint).toBe(build.fingerprint);
    expect(row.trigger).toBe('test');
  });

  it('logs the LOUD canary warning when the eligible count swings beyond threshold (both fingerprints + delta)', async () => {
    // Baseline: a prior recompute at a wildly different eligible count, so whatever the current
    // (small, test-DB) eligible count is, the relative swing is ~100% → a guaranteed breach.
    await prisma.deviceStateRecompute.create({
      data: {
        computedAt: new Date(NOW.getTime() - 3_600_000),
        eligibleCount: 1_000_000,
        inactiveCount: 0,
        departedCount: 0,
        totalCount: 1_000_000,
        buildVersion: 1n,
        buildFingerprint: 'prevbuild',
        trigger: 'cron',
      },
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.recompute(NOW, 'test');

    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => /canary/i.test(m));
    expect(line, 'a canary warn line should be emitted').toBeDefined();
    expect(line).toMatch(/1000000/); // previous count
    expect(line).toMatch(/prevbuild/); // previous build fingerprint
    expect(line).toContain(getBuildInfo().fingerprint); // current build fingerprint
  });

  it('does not warn when the eligible count is unchanged (same data, same now)', async () => {
    await service.recompute(NOW, 'test'); // row 1
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await service.recompute(NOW, 'test'); // row 2 — identical eligible count → delta 0

    const canaryWarned = warn.mock.calls.map((c) => String(c[0])).some((m) => /canary/i.test(m));
    expect(canaryWarned).toBe(false);
  });
});
