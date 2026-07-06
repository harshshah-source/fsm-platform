import { PartitionMaintenanceService } from '../src/ingestion/partition-maintenance.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SettingsService } from '../src/settings/settings.service';

/**
 * `PartitionMaintenanceService` unit tests against fake Prisma/Settings (no DB). We assert the job wires
 * the pure planner to real DDL correctly: it reads the retention window from settings (default 7d), never
 * drops the DEFAULT partition, drops expired dated partitions, and creates create-ahead partitions.
 */

const NOW = new Date('2026-07-15T09:00:00Z');

/** Fake Prisma: `$queryRawUnsafe` returns the scripted partition list; `$executeRawUnsafe` records DDL. */
function fakePrisma(partitions: string[]) {
  const executed: string[] = [];
  const prisma = {
    $queryRawUnsafe: async () => partitions.map((relname) => ({ relname })),
    $executeRawUnsafe: async (sql: string) => {
      executed.push(sql);
      return 0;
    },
  } as unknown as PrismaService;
  return { prisma, executed };
}

const fakeSettings = (retention: number | undefined): SettingsService =>
  ({ get: async () => retention }) as unknown as SettingsService;

describe('PartitionMaintenanceService', () => {
  it('defaults to a 7-day retention window when the setting is unset', async () => {
    const { prisma, executed } = fakePrisma([
      'raw_device_snapshots_default',
      'raw_device_snapshots_y2026m07d06', // 9 days old → expired under 7d
      'raw_device_snapshots_y2026m07d15', // today → kept
    ]);
    const svc = new PartitionMaintenanceService(prisma, fakeSettings(undefined));

    const res = await svc.runMaintenance(NOW);

    expect(res.retentionDays).toBe(7);
    expect(res.dropped).toContain('raw_device_snapshots_y2026m07d06');
    expect(executed).toContain('DROP TABLE IF EXISTS "raw_device_snapshots_y2026m07d06"');
    // The catch-all default is NEVER dropped.
    expect(executed.some((s) => /DROP.*raw_device_snapshots_default/.test(s))).toBe(false);
  });

  it('honours a custom retention value and drops nothing still inside the window', async () => {
    const { prisma, executed } = fakePrisma([
      'raw_device_snapshots_default',
      'raw_device_snapshots_y2026m07d06',
    ]);
    const svc = new PartitionMaintenanceService(prisma, fakeSettings(14));

    const res = await svc.runMaintenance(NOW);

    expect(res.retentionDays).toBe(14);
    expect(res.dropped).toEqual([]);
    expect(executed.some((s) => s.startsWith('DROP TABLE'))).toBe(false);
  });

  it('creates create-ahead partitions that do not yet exist', async () => {
    const { prisma, executed } = fakePrisma(['raw_device_snapshots_y2026m07d15']);
    const svc = new PartitionMaintenanceService(prisma, fakeSettings(7));

    const res = await svc.runMaintenance(NOW);

    expect(res.created).toContain('raw_device_snapshots_y2026m07d16');
    expect(
      executed.some((s) =>
        /CREATE TABLE IF NOT EXISTS "raw_device_snapshots_y2026m07d16" PARTITION OF raw_device_snapshots FOR VALUES FROM \('2026-07-16 00:00:00\+00'\) TO \('2026-07-17 00:00:00\+00'\)/.test(
          s,
        ),
      ),
    ).toBe(true);
  });
});
