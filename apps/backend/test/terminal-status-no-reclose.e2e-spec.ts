import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { DeviceDepartureService } from '../src/device-departure/device-departure.service';
import { ENTITY_MAPPING_HEADERS, EntityMappingExportService } from '../src/exports/entity-mapping-export.service';
import { PlantDeactivationService } from '../src/plant-deactivation/plant-deactivation.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #308 AC2/AC3 — a terminal ticket keeps its own closure, and the export stops counting terminal work
 * as open.
 *
 * The departure and deactivation paths carried a **four-member** spelling of "terminal", so a ticket
 * that had already ended at `FAILED_VERIFICATION`, `FAILED_ACTIVATION` or `RECEIVED_AT_WAREHOUSE` was
 * re-closed as `CLOSED` with its `closure_type`, `closure_reason` and `closed_at` overwritten and a
 * second closure event appended — a ticket recorded as having ended twice, for two different reasons,
 * the later one wrong.
 *
 * The subtle half is the failure cycle. Verification closes the cycle only on `CLOSED`, so a
 * `FAILED_VERIFICATION` ticket is terminal while its cycle is still live — and the old code reached
 * that cycle *only* as a side effect of the wrong re-close. Widening the vocabulary alone would have
 * stranded those cycles open on a departed device while `has_open_failure_cycle` was cleared anyway,
 * which is the exact contradiction #218's lifecycle check exists to catch. These cases pin both halves.
 */
const NS = Date.now();

describe('#308 — terminal tickets are not re-closed', () => {
  let prisma: PrismaService;
  let departures: DeviceDepartureService;
  let deactivations: PlantDeactivationService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const vehicleNos: string[] = [];

  const oh = { userId: randomUUID(), role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null, zoneId: null };

  /**
   * Drive the real reconcile entry point. `syncedPlantIds: []` keeps the ABSENCE pass out of scope —
   * without it, every other device this file seeds on the same plant would be missing from `observed`
   * and get mass-departed as absent, quietly wrecking the next case.
   */
  const departDevices = (ids: string[], operational: string[] = []) =>
    departures.reconcile({
      observed: new Map([
        ...ids.map((d) => [d, 'UNDEPLOYED'] as const),
        ...operational.map((d) => [d, 'DEPLOYED'] as const),
      ]),
      syncedPlantIds: [],
    });

  /**
   * The work type each terminal status actually belongs to. #309's `tickets_work_type_status` CHECK
   * refuses a TROUBLESHOOT row at `FAILED_ACTIVATION` or `RECEIVED_AT_WAREHOUSE` — pairs no writer
   * has ever produced — so the fixture now names the ladder each status comes from. Nothing about
   * this file's subject changes: the departure/deactivation guard under test reads `status` alone,
   * and the live cycle it must still end is reached through `tickets.failure_cycle_id`, which the
   * seed keeps on every row (legal for all three work types — the pre-existing cycle CHECK only
   * constrains TROUBLESHOOT in the other direction).
   */
  const WORK_TYPE_OF: Record<string, 'TROUBLESHOOT' | 'INSTALL' | 'RECOVERY'> = {
    FAILED_VERIFICATION: 'TROUBLESHOOT',
    FAILED_ACTIVATION: 'INSTALL',
    RECEIVED_AT_WAREHOUSE: 'RECOVERY',
  };

  /**
   * A device whose only ticket is already terminal, with a still-live failure cycle — the exact state
   * a failed verification leaves behind.
   */
  const seedTerminal = async (
    status: 'FAILED_VERIFICATION' | 'FAILED_ACTIVATION' | 'RECEIVED_AT_WAREHOUSE',
  ): Promise<{ deviceId: string; ticketId: string; cycleId: string; vehicleId: bigint }> => {
    const deviceId = String(11_950_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    const vehicleNo = `V308${NS}${deviceIds.length}`;
    vehicleNos.push(vehicleNo);
    const vehicle = await prisma.vehicle.create({ data: { vehicleNo, plantId, companyId, status: 'DEPLOYED' } });
    await prisma.device.create({ data: { deviceId, currentVehicleId: vehicle.vehicleId } });
    const cycle = await prisma.failureCycle.create({
      data: { deviceId, state: 'SUBMITTED', openedAt: new Date(Date.now() - 3 * 60 * 60_000) },
    });
    const ticket = await prisma.ticket.create({
      data: {
        workType: WORK_TYPE_OF[status],
        status,
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        closureType: 'ZM_MANUAL_CLOSE',
        closureReason: 'the original closure, which must survive',
        closedAt: new Date('2026-08-01T10:00:00Z'),
        lastStateChangedAt: new Date('2026-08-01T10:00:00Z'),
      },
    });
    ticketIds.push(ticket.ticketId);
    await prisma.deviceState.create({
      data: { deviceId, vehicleId: vehicle.vehicleId, plantId, companyId, hasOpenFailureCycle: true, computedAt: new Date() },
    });
    return { deviceId, ticketId: ticket.ticketId, cycleId: cycle.cycleId, vehicleId: vehicle.vehicleId };
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    departures = new DeviceDepartureService(prisma);
    deactivations = new PlantDeactivationService(prisma, new AuditService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-308-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-308-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-308-' + NS, zoneId } })).plantId;
  });

  afterAll(async () => {
    await prisma.plantDeactivation.deleteMany({ where: { plantId } });
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ticketIds, ...deviceIds, String(plantId)] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo: { in: vehicleNos } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  describe('device departure', () => {
    it('AC2 — leaves a FAILED_VERIFICATION ticket exactly as it was, and still ends its live cycle', async () => {
      const { deviceId, ticketId, cycleId } = await seedTerminal('FAILED_VERIFICATION');

      const result = await departDevices([deviceId]);

      expect(result.departed).toBe(1);
      expect(result.cancelledTickets).toBe(0);
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      // The original closure survives intact — status, type, reason and instant.
      expect(ticket.status).toBe('FAILED_VERIFICATION');
      expect(ticket.closureType).toBe('ZM_MANUAL_CLOSE');
      expect(ticket.closureReason).toBe('the original closure, which must survive');
      expect(ticket.closedAt?.toISOString()).toBe('2026-08-01T10:00:00.000Z');
      // No second closure event on work that was already over.
      expect(await prisma.ticketEvent.count({ where: { ticketId } })).toBe(0);
      // …and the half that would break if the vocabulary were widened on its own: the live cycle is
      // still ended, so the departed device does not keep an open episode.
      expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } })).state).toBe('FAILED');
      expect((await prisma.deviceState.findUniqueOrThrow({ where: { deviceId } })).hasOpenFailureCycle).toBe(false);
    });

    it('AC2 — the same for FAILED_ACTIVATION and RECEIVED_AT_WAREHOUSE', async () => {
      const a = await seedTerminal('FAILED_ACTIVATION');
      const b = await seedTerminal('RECEIVED_AT_WAREHOUSE');

      await departDevices([a.deviceId, b.deviceId]);

      for (const seeded of [a, b]) {
        const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: seeded.ticketId } });
        expect(ticket.closureType).toBe('ZM_MANUAL_CLOSE');
        expect(await prisma.ticketEvent.count({ where: { ticketId: seeded.ticketId } })).toBe(0);
        expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId: seeded.cycleId } })).state).toBe('FAILED');
      }
    });

    it('regression — an OPEN ticket is still cancelled exactly as before', async () => {
      const { deviceId, ticketId, cycleId } = await seedTerminal('FAILED_VERIFICATION');
      await prisma.ticket.update({
        where: { ticketId },
        data: { status: 'OPEN', closureType: null, closureReason: null, closedAt: null },
      });

      const result = await departDevices([deviceId]);

      expect(result.cancelledTickets).toBe(1);
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      expect(ticket.status).toBe('CLOSED');
      expect(ticket.closureType).toBe('DEVICE_UNDEPLOYED_CLOSE');
      expect(await prisma.ticketEvent.count({ where: { ticketId, reasonCode: 'DEVICE_UNDEPLOYED' } })).toBe(1);
      expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } })).state).toBe('FAILED');
    });
  });

  describe('plant deactivation', () => {
    it('AC2 — leaves a terminal ticket alone, ends its live cycle, and does not count it cancelled', async () => {
      const { ticketId, cycleId } = await seedTerminal('FAILED_VERIFICATION');

      const result = await deactivations.deactivate(plantId, 'site closed', oh);

      expect(result.result).toBe('OK');
      expect(result.result === 'OK' && result.cancelledTickets).toBe(0);
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      expect(ticket.status).toBe('FAILED_VERIFICATION');
      expect(ticket.closureType).toBe('ZM_MANUAL_CLOSE');
      expect(await prisma.ticketEvent.count({ where: { ticketId } })).toBe(0);
      expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } })).state).toBe('FAILED');

      await deactivations.reactivate(plantId, null, oh);
    });
  });

  describe('entity-mapping export', () => {
    it('AC3 — open-ticket counts exclude all seven canonical terminal statuses', async () => {
      const seeded = await seedTerminal('FAILED_VERIFICATION');

      const exporter = new EntityMappingExportService(prisma);
      const chunks: string[] = [];
      for await (const chunk of exporter.toCsvStream()) chunks.push(String(chunk));
      const line = chunks
        .join('')
        .split('\n')
        .find((l) => l.startsWith(seeded.deviceId + ','));

      expect(line).toBeDefined();
      // The divergent four-member copy counted this terminal ticket as open work in a CSV operators
      // reconcile against. The number moving is the fix, not a side effect — so assert the column
      // itself, not merely that a zero appears somewhere on the row.
      const col = ENTITY_MAPPING_HEADERS.indexOf('open_ticket_count');
      expect(line!.split(',')[col]).toBe('0');
    });
  });
});
