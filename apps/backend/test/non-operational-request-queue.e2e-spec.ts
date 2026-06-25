import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { NonOperationalService } from '../src/ticketing/non-operational.service';
import type { RequestActor } from '../src/common/request-actor';

/**
 * Issue 35, slice 1 — Non-Operational dual-confirmation marking, request + queue (AC#1).
 * Requesting a marking snapshots the device deal type, defaults the effective window by reason
 * (90d, or 365d for scrapped/sold), stamps `awaiting_since`, and parks the row at
 * AWAITING_ZM_CONFIRMATION. The dual-confirmation queue lists open rows sorted by `awaiting_since`
 * asc, each carrying a days-elapsed badge.
 */
const DEV_A = 9_350_001n;
const DEV_B = 9_350_002n;
const ALL = [DEV_A, DEV_B];

const zm: RequestActor = {
  userId: '11111111-1111-1111-1111-111111111111',
  role: 'ZONAL_MANAGER',
  actedAsRole: null,
  actingZone: null,
};

describe('Issue 35 slice 1 — NonOperationalService request + queue', () => {
  let prisma: PrismaService;
  let service: NonOperationalService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;

  const NOW = new Date(Date.UTC(2026, 5, 25, 12, 0, 0));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new NonOperationalService(prisma, new AuditService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-nonop-' + Date.now() } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: 'Co-nonop-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' },
      })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-nonop', zoneId } })).plantId;

    await prisma.device.create({ data: { deviceId: DEV_A, dealType: 'RECURRING' } });
    await prisma.device.create({ data: { deviceId: DEV_B, dealType: 'ONE_TIME' } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'non_operational_markings' } });
    await prisma.nonOperationalMarking.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('requests a marking — snapshots deal type, defaults the 90-day window, parks at AWAITING_ZM', async () => {
    const out = await service.requestMarking(
      { deviceId: DEV_B, reasonCode: 'COMPANY_PAUSED' },
      zm,
      NOW,
    );
    expect(out.result).toBe('OK');
    if (out.result !== 'OK') return;

    const row = await prisma.nonOperationalMarking.findUniqueOrThrow({
      where: { markingId: out.marking.markingId },
    });
    expect(row.state).toBe('AWAITING_ZM_CONFIRMATION');
    expect(row.reasonCode).toBe('COMPANY_PAUSED');
    expect(row.dealTypeAtMarking).toBe('ONE_TIME');
    expect(row.awaitingSince?.getTime()).toBe(NOW.getTime());
    // default 90-day window for a non scrapped/sold reason
    const days = Math.round((row.effectiveTo!.getTime() - row.effectiveFrom!.getTime()) / 86_400_000);
    expect(days).toBe(90);
  });

  it('defaults a 365-day window for VEHICLE_SCRAPPED', async () => {
    const out = await service.requestMarking(
      { deviceId: DEV_A, reasonCode: 'VEHICLE_SCRAPPED' },
      zm,
      new Date(NOW.getTime() - 3 * 86_400_000), // 3 days earlier → sorts first in the queue
    );
    expect(out.result).toBe('OK');
    if (out.result !== 'OK') return;
    const row = await prisma.nonOperationalMarking.findUniqueOrThrow({
      where: { markingId: out.marking.markingId },
    });
    const days = Math.round((row.effectiveTo!.getTime() - row.effectiveFrom!.getTime()) / 86_400_000);
    expect(days).toBe(365);
  });

  it('lists the dual-confirmation queue sorted by awaiting_since asc with a days-elapsed badge', async () => {
    const rows = await service.queue(NOW);
    const mine = rows.filter((r) => ALL.includes(r.deviceId));
    expect(mine.map((r) => r.deviceId)).toEqual([DEV_A, DEV_B]); // A awaited 3 days earlier → first
    expect(mine[0].daysElapsed).toBe(3);
    expect(mine[1].daysElapsed).toBe(0);
    expect(mine[0].state).toBe('AWAITING_ZM_CONFIRMATION');
  });

  it('rejects OTHER without free-text and an unknown device', async () => {
    const noText = await service.requestMarking({ deviceId: DEV_B, reasonCode: 'OTHER' }, zm, NOW);
    expect(noText.result).toBe('INVALID_REASON_TEXT');
    const missing = await service.requestMarking(
      { deviceId: 9_999_999n, reasonCode: 'COMPANY_PAUSED' },
      zm,
      NOW,
    );
    expect(missing.result).toBe('NOT_FOUND');
  });

  it('rejects a second active marking for the same device', async () => {
    const dup = await service.requestMarking({ deviceId: DEV_B, reasonCode: 'COMPANY_PAUSED' }, zm, NOW);
    expect(dup.result).toBe('CONFLICT');
  });
});
