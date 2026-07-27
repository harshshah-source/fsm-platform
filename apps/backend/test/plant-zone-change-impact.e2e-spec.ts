import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AuditService } from '../src/audit/audit.service';
import { ZoneMappingService } from '../src/org/zone-mapping.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #158 S3 / AC-6 — the blast radius an admin should see BEFORE moving a plant.
 *
 * A zone change re-scopes devices and open tickets instantly and harmlessly. The one genuinely
 * confusing case is a move made mid-day on a plant whose work is already on a dispatched day plan:
 * `work_schedules` are keyed by the zone at dispatch time and stay under the OLD zone (that is
 * provenance, and correct), while the tickets re-scope to the new one. Nothing corrupts, but the old
 * zone's ZM holds a plan for tickets the new zone's ZM now sees. The admin gets told, rather than
 * finding out.
 */
const NS = Date.now();
const SRC_PLANT = 995401n;
const DEVICE_ID = `IMPACT-${NS}`;

describe('#158 — zone change impact probe', () => {
  let prisma: PrismaService;
  let service: ZoneMappingService;

  let eastId: bigint;
  let southId: bigint;
  let plantId: bigint;
  let companyId: bigint;
  let otherCompanyId: bigint;
  let seId: string;

  const cleanup = async (): Promise<void> => {
    await prisma.batchAssignmentTicket.deleteMany({ where: { batch: { plantId } } }).catch(() => undefined);
    await prisma.plantBatchAssignment.deleteMany({ where: { plantId } }).catch(() => undefined);
    await prisma.workSchedule.deleteMany({ where: { seId } }).catch(() => undefined);
    await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } }).catch(() => undefined);
    await prisma.deviceState.deleteMany({ where: { deviceId: DEVICE_ID } });
    await prisma.companyTierOverride
      .deleteMany({ where: { companyId: { in: [companyId, otherCompanyId].filter((v) => v != null) } } })
      .catch(() => undefined);
    await prisma.ticket.deleteMany({ where: { plant: { sourcePlantId: SRC_PLANT } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: DEVICE_ID } });
    await prisma.device.deleteMany({ where: { deviceId: DEVICE_ID } });
    await prisma.vehicle.deleteMany({ where: { plant: { sourcePlantId: SRC_PLANT } } });
    await prisma.plant.deleteMany({ where: { sourcePlantId: SRC_PLANT } });
    await prisma.user.deleteMany({ where: { email: `impact-se-${NS}@fsm.test` } });
    await prisma.company.deleteMany({ where: { name: `Impact Co ${NS}` } });
    await prisma.company.deleteMany({ where: { name: `Impact Other Co ${NS}` } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ZoneMappingService(prisma, new AuditService(prisma));

    const east = await prisma.zone.upsert({ where: { name: 'East' }, create: { name: 'East' }, update: {} });
    eastId = east.zoneId;

    const company = await prisma.company.create({
      data: { name: `Impact Co ${NS}`, companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;

    const plant = await prisma.plant.create({
      data: { name: `Impact Plant ${NS}`, zoneId: eastId, sourcePlantId: SRC_PLANT },
    });
    plantId = plant.plantId;

    const vehicle = await prisma.vehicle.create({
      data: { vehicleNo: `IMP-VEH-${NS}`, plantId, companyId, status: 'DEPLOYED' },
    });
    await prisma.device.create({ data: { deviceId: DEVICE_ID, currentVehicleId: vehicle.vehicleId } });

    const cycle = await prisma.failureCycle.create({
      data: { deviceId: DEVICE_ID, state: 'OPEN', openedAt: new Date() },
    });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        assignmentState: 'FORMALLY_ASSIGNED',
        failureCycleId: cycle.cycleId,
        deviceId: DEVICE_ID,
        vehicleId: vehicle.vehicleId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: new Date(),
      },
    });

    const se = await prisma.user.create({
      data: {
        name: `Impact SE ${NS}`,
        role: 'SERVICE_ENGINEER',
        zoneId: eastId,
        phone: `9${String(NS).slice(-9)}`,
        email: `impact-se-${NS}@fsm.test`,
        status: 'ACTIVE',
      },
    });
    seId = se.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'MULTI_PLANT', zoneId: eastId, dailyCapacity: 25 },
    });

    // Today's dispatched day plan carrying this plant's ticket.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const schedule = await prisma.workSchedule.create({
      data: { seId, zoneId: eastId, dateFrom: today, dateTo: today, status: 'ACTIVE' },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId, stopSequence: 1, status: 'AUTO_ASSIGNED' },
    });
    await prisma.batchAssignmentTicket.create({
      data: { batchId: batch.batchId, ticketId: ticket.ticketId, sortOrder: 1 },
    });

    // #157 S6 (AC-9) fixtures: overrides that a zone move would detach/attach for the plant's company.
    const south = await prisma.zone.upsert({ where: { name: 'South' }, create: { name: 'South' }, update: {} });
    southId = south.zoneId;
    const now = Date.now();
    // Current-zone (East) winning override for the plant's open-ticket company — should DETACH on a move.
    await prisma.companyTierOverride.create({
      data: {
        companyId, zoneId: eastId, tier: 'PLATINUM', reason: 'east override on the plant company',
        status: 'ACTIVE', createdAt: new Date(now - 60 * 60 * 1000), expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
      },
    });
    // An expired East override for the same company — must be excluded (reads predicate on expiresAt).
    await prisma.companyTierOverride.create({
      data: {
        companyId, zoneId: eastId, tier: 'SILVER', reason: 'expired east override must not surface',
        status: 'ACTIVE', createdAt: new Date(now - 3 * 60 * 60 * 1000), expiresAt: new Date(now - 60 * 1000),
      },
    });
    // Target-zone (South) override for the plant's company — should ATTACH after a move to South.
    await prisma.companyTierOverride.create({
      data: {
        companyId, zoneId: southId, tier: 'SILVER', reason: 'south override that would start applying',
        status: 'ACTIVE', createdAt: new Date(now - 60 * 60 * 1000), expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
      },
    });
    // A DIFFERENT company with no open ticket at this plant — its East override must be excluded (stake filter).
    const other = await prisma.company.create({
      data: { name: `Impact Other Co ${NS}`, companyTier: 'SILVER', companyPriorityRank: 'C' },
    });
    otherCompanyId = other.companyId;
    await prisma.companyTierOverride.create({
      data: {
        companyId: otherCompanyId, zoneId: eastId, tier: 'PLATINUM', reason: 'other company override, no stake here',
        status: 'ACTIVE', createdAt: new Date(now - 60 * 60 * 1000), expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  it('reports the devices and open tickets that will re-scope, and the work already dispatched today', async () => {
    const impact = await service.zoneChangeImpact(SRC_PLANT);

    expect(impact).toMatchObject({
      plantName: `Impact Plant ${NS}`,
      currentZoneName: 'East',
      deviceCount: 1,
      openTicketCount: 1,
      dispatchedTodayCount: 1,
    });
  });

  it('404s for a plant that was never synced from AutoPlant', async () => {
    await expect(service.zoneChangeImpact(99999999n)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('names the winning active overrides for the plant’s open-ticket companies in the current and target zone (#157 S6, AC-9)', async () => {
    const impact = await service.zoneChangeImpact(SRC_PLANT, southId);

    // Current zone (East): the winning override detaching on a move — expired and non-stakeholder rows excluded.
    expect(impact.currentZoneOverrides).toEqual([
      { companyId: Number(companyId), companyName: `Impact Co ${NS}`, tier: 'PLATINUM' },
    ]);
    // Target zone (South): the override that would start applying after the move.
    expect(impact.targetZoneOverrides).toEqual([
      { companyId: Number(companyId), companyName: `Impact Co ${NS}`, tier: 'SILVER' },
    ]);
  });

  it('returns no target-zone overrides when no target zone is supplied', async () => {
    const impact = await service.zoneChangeImpact(SRC_PLANT);
    expect(impact.targetZoneOverrides).toEqual([]);
    expect(impact.currentZoneOverrides.map((o) => o.tier)).toEqual(['PLATINUM']);
  });
});
