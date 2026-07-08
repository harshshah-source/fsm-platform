import { AuditService } from '../src/audit/audit.service';
import { DeviceStateService } from '../src/device-state/device-state.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings.service';

/**
 * Issue 112 Slice A — the `eligibility_mode` setting (review B7/R2 interim proxy).
 *
 *  - mode `all-deployed`: a device fitted to an ACTIVE/DEPLOYED vehicle is eligible with NO PGI
 *  - mode `all-deployed`: no current fitment, or an UNDEPLOYED/null-status vehicle → ineligible
 *  - mode `all-deployed`: a CONFIRMED Non-Op marking still short-circuits ineligible (both modes)
 *  - junk / unset mode value falls back to the canonical `pgi` gate (never silently widens)
 */
const DEV_DEPLOYED = String(9_112_001n);
const DEV_UNDEPLOYED = String(9_112_002n);
const DEV_NULL_STATUS = String(9_112_003n);
const DEV_NO_FITMENT = String(9_112_004n);
const DEV_NONOP = String(9_112_005n);
const ALL = [DEV_DEPLOYED, DEV_UNDEPLOYED, DEV_NULL_STATUS, DEV_NO_FITMENT, DEV_NONOP];

describe('Issue 112 Slice A — eligibility_mode setting', () => {
  let prisma: PrismaService;
  let settings: SettingsService;
  let service: DeviceStateService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let vehicleIds: bigint[] = [];

  const NOW = new Date(Date.UTC(2026, 6, 7, 12, 0, 0));

  const setMode = (value: unknown) =>
    prisma.systemSetting.upsert({
      where: { key: 'eligibility_mode' },
      create: { key: 'eligibility_mode', value: value as object },
      update: { value: value as object },
    });

  const eligibilityOf = async (deviceId: string): Promise<boolean> => {
    const state = await prisma.deviceState.findUnique({ where: { deviceId } });
    return state!.eligibleForUptime;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    settings = new SettingsService(prisma, new AuditService(prisma));
    await settings.seedDefaults();
    service = new DeviceStateService(prisma, settings);

    const zone = await prisma.zone.create({ data: { name: 'Z-112a-' + Date.now() } });
    zoneId = zone.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co-112a', companyTier: 'SILVER', companyPriorityRank: 'C' },
    });
    companyId = company.companyId;
    const plant = await prisma.plant.create({ data: { name: 'P-112a', zoneId } });
    plantId = plant.plantId;

    const mkVehicle = async (vehicleNo: string, status: string | null) => {
      const v = await prisma.vehicle.create({
        data: { vehicleNo, plantId, companyId, status },
      });
      vehicleIds.push(v.vehicleId);
      return v.vehicleId;
    };

    const fitted: Array<[string, bigint | null]> = [
      [DEV_DEPLOYED, await mkVehicle('VH-112-DEP', 'DEPLOYED')],
      [DEV_UNDEPLOYED, await mkVehicle('VH-112-UND', 'UNDEPLOYED')],
      [DEV_NULL_STATUS, await mkVehicle('VH-112-NUL', null)],
      [DEV_NO_FITMENT, null],
      [DEV_NONOP, await mkVehicle('VH-112-NOP', 'DEPLOYED')],
    ];
    for (const [deviceId, currentVehicleId] of fitted) {
      await prisma.device.create({ data: { deviceId, currentVehicleId } });
    }
    await prisma.nonOperationalMarking.create({
      data: { deviceId: DEV_NONOP, state: 'CONFIRMED' },
    });
    // No pgi_history rows at all — the whole point of the interim proxy.
  });

  afterAll(async () => {
    await setMode('pgi'); // never leak a widened gate into other specs
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.nonOperationalMarking.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.vehicle.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('all-deployed: a device on a DEPLOYED vehicle is eligible with no PGI at all', async () => {
    await setMode('all-deployed');
    await service.recompute(NOW);
    expect(await eligibilityOf(DEV_DEPLOYED)).toBe(true);
  });

  it('all-deployed: UNDEPLOYED or unknown-status fitment and no fitment are ineligible', async () => {
    await setMode('all-deployed');
    await service.recompute(NOW);
    expect(await eligibilityOf(DEV_UNDEPLOYED)).toBe(false);
    expect(await eligibilityOf(DEV_NULL_STATUS)).toBe(false);
    expect(await eligibilityOf(DEV_NO_FITMENT)).toBe(false);
  });

  it('all-deployed: a CONFIRMED Non-Op marking still excludes a deployed device', async () => {
    await setMode('all-deployed');
    await service.recompute(NOW);
    expect(await eligibilityOf(DEV_NONOP)).toBe(false);
  });

  it('a junk mode value falls back to the canonical pgi gate (no PGI → ineligible)', async () => {
    await setMode('definitely-not-a-mode');
    await service.recompute(NOW);
    expect(await eligibilityOf(DEV_DEPLOYED)).toBe(false);
  });

  it('registers the pgi default in the settings registry', async () => {
    await prisma.systemSetting.delete({ where: { key: 'eligibility_mode' } });
    await settings.seedDefaults();
    expect(await settings.get('eligibility_mode')).toBe('pgi');
  });
});
