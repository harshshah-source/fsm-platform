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
  let plantId: bigint;
  let companyId: bigint;
  let seId: string;

  const cleanup = async (): Promise<void> => {
    await prisma.batchAssignmentTicket.deleteMany({ where: { batch: { plantId } } }).catch(() => undefined);
    await prisma.plantBatchAssignment.deleteMany({ where: { plantId } }).catch(() => undefined);
    await prisma.workSchedule.deleteMany({ where: { seId } }).catch(() => undefined);
    await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } }).catch(() => undefined);
    await prisma.deviceState.deleteMany({ where: { deviceId: DEVICE_ID } });
    await prisma.ticket.deleteMany({ where: { plant: { sourcePlantId: SRC_PLANT } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: DEVICE_ID } });
    await prisma.device.deleteMany({ where: { deviceId: DEVICE_ID } });
    await prisma.vehicle.deleteMany({ where: { plant: { sourcePlantId: SRC_PLANT } } });
    await prisma.plant.deleteMany({ where: { sourcePlantId: SRC_PLANT } });
    await prisma.user.deleteMany({ where: { email: `impact-se-${NS}@fsm.test` } });
    await prisma.company.deleteMany({ where: { name: `Impact Co ${NS}` } });
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
});
