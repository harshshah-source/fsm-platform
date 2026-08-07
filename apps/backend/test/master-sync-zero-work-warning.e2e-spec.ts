import { Logger } from '@nestjs/common';
import { vi } from 'vitest';
import { MasterSyncRunService } from '../src/ingestion/autoplant/master-sync-run.service';
import {
  MasterSyncService,
  type MasterSyncSource,
  type PlantZoneResolver,
} from '../src/ingestion/autoplant/master-sync.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 218 — FIX-PLAN §4 layer 2, "a zero-work warning".
 *
 * The defect ran dead for 17 days with no error, no log line and green CI. Four detection layers were
 * agreed; this is the second: *"`reconcileDepartures` currently returns silently when the collaborator
 * is missing. Make that path log a `logger.warn` naming the missing dependency. A sync that decides
 * not to do lifecycle work should say so."*
 *
 * 218b fixed the wiring, so on the Nest path these guards should now never fire — which is exactly
 * why the warning matters. `@Optional()` is deliberately kept (the CLI runner and several specs
 * construct the service with fewer arguments), so the silent-`undefined` failure mode remains
 * *reachable* by any future wiring mistake. This is the line that would have named it on day one.
 *
 * The guards must stay non-fatal: the CLI runner constructs the service without these collaborators
 * on purpose, and a warning that broke that path would be a worse bug than the one it reports.
 */
const emptySource: MasterSyncSource = {
  readCompanies: async () => [],
  readTransporters: async () => [],
  readPlants: async () => [],
  readVehicleMasters: async () => [],
};
const zoneResolver: PlantZoneResolver = { resolve: async () => null };

describe('Issue 218 §4 layer 2 — a sync that skips lifecycle work says so', () => {
  let prisma: PrismaService;
  let runService: MasterSyncRunService;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    runService = new MasterSyncRunService(prisma);
  });
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    warn.mockRestore();
    await prisma.masterSyncRun.deleteMany({ where: { status: 'RUNNING' } });
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  /** The shape the CLI runner and the pre-218b Nest graph both produce: no lifecycle collaborators. */
  const unwiredService = (): MasterSyncService =>
    new MasterSyncService(prisma, runService, emptySource, zoneResolver, { plantStatuses: ['ACTIVE'] });

  const messages = (): string[] => warn.mock.calls.map((c) => String(c[0]));

  it('warns, naming DeviceDepartureService, when the lifecycle pass is skipped', async () => {
    const result = await unwiredService().sync();

    expect(result.status).toBe('SUCCESS');
    expect(messages().some((m) => m.includes('DeviceDepartureService'))).toBe(true);
  });

  it('warns, naming PlantEligibleFloatingSeService, when the MV refresh is skipped', async () => {
    const result = await unwiredService().sync();

    expect(result.status).toBe('SUCCESS');
    expect(messages().some((m) => m.includes('PlantEligibleFloatingSeService'))).toBe(true);
  });

  it('still succeeds — the warning reports the skip, it does not become the failure', async () => {
    // The CLI runner (`autoplant-sync.ts`) constructs the service exactly this way on purpose. A
    // warning that broke it would be a worse bug than the silence it replaces.
    const result = await unwiredService().sync();

    expect(result.status).toBe('SUCCESS');
  });

  it('stays quiet when both collaborators are wired — no cry-wolf on the healthy path', async () => {
    const departures = { reconcile: vi.fn(async () => ({ departed: 0, restored: 0, cancelledTickets: 0, absentCandidates: 0, guardTripped: false, skippedByReason: {} })) };
    const eligibility = { refresh: vi.fn(async () => undefined) };
    const service = new MasterSyncService(
      prisma,
      runService,
      emptySource,
      zoneResolver,
      { plantStatuses: ['ACTIVE'] },
      {},
      departures as never,
      eligibility as never,
    );

    const result = await service.sync();

    expect(result.status).toBe('SUCCESS');
    expect(messages().some((m) => m.includes('DeviceDepartureService') || m.includes('PlantEligibleFloatingSeService'))).toBe(false);
  });
});
