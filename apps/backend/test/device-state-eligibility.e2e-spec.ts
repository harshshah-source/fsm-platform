import { AuditService } from '../src/audit/audit.service';
import { DeviceStateService } from '../src/device-state/device-state.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings.service';

/**
 * Issue 05, slice 4 — DeviceStateService writes `eligible_for_uptime` from real PGI / Non-Op rows
 * (AC#4, the data side of the eligibility gate).
 *
 *  - recent PGI + no Non-Op  → eligible
 *  - PGI older than the window → ineligible
 *  - no PGI                    → ineligible
 *  - CONFIRMED Non-Op marking  → ineligible even with a fresh PGI
 */
const DEV_ELIGIBLE = 9_054_001n;
const DEV_STALE_PGI = 9_054_002n;
const DEV_NO_PGI = 9_054_003n;
const DEV_NONOP = 9_054_004n;
const ALL = [DEV_ELIGIBLE, DEV_STALE_PGI, DEV_NO_PGI, DEV_NONOP];

describe('Issue 05 slice 4 — eligibility on device_states', () => {
  let prisma: PrismaService;
  let service: DeviceStateService;

  const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));
  const pgiDaysAgo = (d: number) => new Date(Date.UTC(2026, 5, 20 - d, 0, 0, 0));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const settings = new SettingsService(prisma, new AuditService(prisma));
    await settings.seedDefaults();
    service = new DeviceStateService(prisma, settings);

    for (const deviceId of ALL) await prisma.device.create({ data: { deviceId } });
    await prisma.pgiHistory.create({ data: { deviceId: DEV_ELIGIBLE, pgiDate: pgiDaysAgo(5) } });
    await prisma.pgiHistory.create({ data: { deviceId: DEV_STALE_PGI, pgiDate: pgiDaysAgo(20) } });
    await prisma.pgiHistory.create({ data: { deviceId: DEV_NONOP, pgiDate: pgiDaysAgo(1) } });
    await prisma.nonOperationalMarking.create({
      data: { deviceId: DEV_NONOP, state: 'CONFIRMED' },
    });
  });

  afterAll(async () => {
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.nonOperationalMarking.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.pgiHistory.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.onModuleDestroy();
  });

  const eligibilityOf = async (deviceId: bigint): Promise<boolean> => {
    const state = await prisma.deviceState.findUnique({ where: { deviceId } });
    return state!.eligibleForUptime;
  };

  it('marks a device with a recent PGI and no Non-Op eligible', async () => {
    await service.recompute(NOW);
    expect(await eligibilityOf(DEV_ELIGIBLE)).toBe(true);
  });

  it('marks a device with a stale PGI ineligible', async () => {
    await service.recompute(NOW);
    expect(await eligibilityOf(DEV_STALE_PGI)).toBe(false);
  });

  it('marks a device with no PGI ineligible', async () => {
    await service.recompute(NOW);
    expect(await eligibilityOf(DEV_NO_PGI)).toBe(false);
  });

  it('marks a Non-Operational device ineligible despite a fresh PGI', async () => {
    await service.recompute(NOW);
    expect(await eligibilityOf(DEV_NONOP)).toBe(false);
  });
});
