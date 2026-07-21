import { vi } from 'vitest';
import { MasterSyncRunService } from '../src/ingestion/autoplant/master-sync-run.service';
import {
  MasterSyncService,
  type MasterSyncSource,
  type PlantZoneResolver,
} from '../src/ingestion/autoplant/master-sync.service';
import type { PlantEligibleFloatingSeService } from '../src/org/plant-eligible-floating-se.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 138 slice 2 — master-sync is the only bulk writer of the MV's geometry inputs (plant
 * district_id / location). After a SUCCESS sync it must refresh `plant_eligible_floating_se` so
 * new/relocated plants get correct floating coverage at the next dispatch — without waiting for an
 * unrelated territory edit or the periodic backstop (slice 3). Best-effort: a refresh failure must
 * NEVER fail the mirror sync that already committed (same posture as the Issue 128 departure pass).
 */
const emptySource: MasterSyncSource = {
  readCompanies: async () => [],
  readTransporters: async () => [],
  readPlants: async () => [],
  readVehicleMasters: async () => [],
};
const zoneResolver: PlantZoneResolver = { resolve: async () => null };

describe('Issue 138 slice 2 — master-sync refreshes the floating-eligibility MV on success', () => {
  let prisma: PrismaService;
  let runService: MasterSyncRunService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    runService = new MasterSyncRunService(prisma);
  });
  afterEach(async () => {
    await prisma.masterSyncRun.deleteMany({ where: { status: 'RUNNING' } });
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('calls PlantEligibleFloatingSeService.refresh() once after a SUCCESS sync', async () => {
    const eligibility = { refresh: vi.fn(async () => undefined) };
    const service = new MasterSyncService(
      prisma, runService, emptySource, zoneResolver, { plantStatuses: ['ACTIVE'] }, {}, null,
      eligibility as unknown as PlantEligibleFloatingSeService,
    );
    const result = await service.sync();
    expect(result.status).toBe('SUCCESS');
    expect(eligibility.refresh).toHaveBeenCalledTimes(1);
  });

  it('a refresh failure does not fail the mirror sync (best-effort, swallowed)', async () => {
    const eligibility = { refresh: vi.fn(async () => { throw new Error('refresh boom'); }) };
    const service = new MasterSyncService(
      prisma, runService, emptySource, zoneResolver, { plantStatuses: ['ACTIVE'] }, {}, null,
      eligibility as unknown as PlantEligibleFloatingSeService,
    );
    const result = await service.sync();
    expect(result.status).toBe('SUCCESS');
    expect(eligibility.refresh).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (no throw) when no eligibility service is wired', async () => {
    const service = new MasterSyncService(
      prisma, runService, emptySource, zoneResolver, { plantStatuses: ['ACTIVE'] },
    );
    const result = await service.sync();
    expect(result.status).toBe('SUCCESS');
  });
});
