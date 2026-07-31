import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { mapPlant, type MstPlantRow } from '../src/ingestion/autoplant/master-mapping';
import { ZoneMappingService } from '../src/org/zone-mapping.service';
import type { RequestActor } from '../src/common/request-actor';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #158 S3 — what a plant zone reassignment actually does downstream, proven rather than asserted.
 *
 * The claim under test is that `plants.zone_id` is the SINGLE denormalised copy of a plant's
 * operational zone: tickets, devices and vehicles hold none, so every zone-scoped read re-scopes
 * through the plant join the moment `reapply` moves it. There is no recompute job because there is
 * nothing to recompute — which is a strong claim, and the kind that is worth a test rather than a
 * paragraph. The dashboard read here is the real `DashboardService.zoneOverview` a ZM loads, not a
 * hand-written predicate standing in for it.
 *
 * Also pins the sync-survival property the whole feature rests on (the 2026-07-14 verification, as a
 * regression): a master-sync re-read must not move a pinned plant back.
 */
const NS = Date.now();
const SRC_PLANT = 995301n;
const DEVICE_ID = `ZONE-MOVE-${NS}`;

describe('#158 — downstream effects of a plant zone change', () => {
  let prisma: PrismaService;
  let service: ZoneMappingService;
  let dashboard: DashboardService;

  let eastId: bigint;
  let southId: bigint;
  let plantId: bigint;
  let vehicleId: bigint;
  let companyId: bigint;
  let ticketId: string;
  let cycleId: string;

  const actor: RequestActor = {
    userId: '00000000-0000-0000-0000-000000000001',
    role: 'OPERATIONS_HEAD',
    actedAsRole: null,
    actingZone: null,
  };

  /** The real read a Zonal Manager's dashboard performs for their own zone. */
  const zmInactiveCount = async (zoneId: bigint): Promise<number> => {
    const rows = await dashboard.zoneOverview({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    return rows.find((r) => r.zoneId === zoneId.toString())?.inactiveOperational ?? 0;
  };

  /** Every zone-scoped consumer in the codebase filters tickets exactly this way — via the plant join. */
  const openTicketIdsInZone = async (zoneId: bigint): Promise<string[]> => {
    const rows = await prisma.ticket.findMany({
      where: { status: 'OPEN', plant: { zoneId } },
      select: { ticketId: true },
    });
    return rows.map((r) => r.ticketId);
  };

  const devicesInZone = async (zoneId: bigint): Promise<string[]> => {
    const rows = await prisma.device.findMany({
      where: { currentVehicle: { plant: { zoneId } } },
      select: { deviceId: true },
    });
    return rows.map((r) => r.deviceId);
  };

  const cleanup = async (): Promise<void> => {
    await prisma.deviceState.deleteMany({ where: { deviceId: DEVICE_ID } });
    await prisma.ticket.deleteMany({ where: { plant: { sourcePlantId: SRC_PLANT } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: DEVICE_ID } });
    await prisma.device.deleteMany({ where: { deviceId: DEVICE_ID } });
    await prisma.vehicle.deleteMany({ where: { plant: { sourcePlantId: SRC_PLANT } } });
    await prisma.plantZoneOverride.deleteMany({ where: { sourcePlantId: SRC_PLANT } });
    await prisma.auditLog.deleteMany({
      where: { entityType: 'plant_zone_overrides', entityId: SRC_PLANT.toString() },
    });
    await prisma.plant.deleteMany({ where: { sourcePlantId: SRC_PLANT } });
    await prisma.company.deleteMany({ where: { name: `ZoneMove Co ${NS}` } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ZoneMappingService(prisma, new AuditService(prisma));
    dashboard = new DashboardService(prisma);

    const east = await prisma.zone.upsert({ where: { name: 'East' }, create: { name: 'East' }, update: {} });
    const south = await prisma.zone.upsert({ where: { name: 'South' }, create: { name: 'South' }, update: {} });
    eastId = east.zoneId;
    southId = south.zoneId;

    await cleanup();

    const company = await prisma.company.create({
      data: { name: `ZoneMove Co ${NS}`, companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;

    // A plant that came from AutoPlant, currently resolved into East.
    const plant = await prisma.plant.create({
      data: {
        name: `ZoneMove Plant ${NS}`,
        zoneId: eastId,
        sourcePlantId: SRC_PLANT,
        sourceZoneName: 'EASTERN REGION',
      },
    });
    plantId = plant.plantId;

    const vehicle = await prisma.vehicle.create({
      data: { vehicleNo: `ZM-VEH-${NS}`, plantId, companyId, status: 'DEPLOYED' },
    });
    vehicleId = vehicle.vehicleId;

    await prisma.device.create({ data: { deviceId: DEVICE_ID, currentVehicleId: vehicleId } });

    // An inactive device state — this is what the ZM dashboard aggregates.
    await prisma.deviceState.create({
      data: {
        deviceId: DEVICE_ID,
        isInactive: true,
        slaBucket: 'CRITICAL',
        vehicleId,
        plantId,
        companyId,
        computedAt: new Date(),
      },
    });

    const cycle = await prisma.failureCycle.create({
      data: { deviceId: DEVICE_ID, state: 'OPEN', openedAt: new Date() },
    });
    cycleId = cycle.cycleId;

    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        failureCycleId: cycleId,
        deviceId: DEVICE_ID,
        vehicleId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: new Date(),
      },
    });
    ticketId = ticket.ticketId;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  it('starts with the plant, its device and its open ticket all scoped to East', async () => {
    expect(await openTicketIdsInZone(eastId)).toContain(ticketId);
    expect(await devicesInZone(eastId)).toContain(DEVICE_ID);
    expect(await zmInactiveCount(eastId)).toBeGreaterThanOrEqual(1);
  });

  it('moves the device, the open ticket and the ZM dashboard to South — with no writes to any of them', async () => {
    const ticketBefore = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    const eastBefore = await zmInactiveCount(eastId);
    const southBefore = await zmInactiveCount(southId);

    await service.upsertOverride(SRC_PLANT, southId, 'ops confirmed the site is South', actor);

    // The contract the admin UI is built on: the pin ALONE is inert. Master sync is insert-only on
    // plants.zone_id, so nothing has moved yet and a UI that stopped here would silently do nothing.
    expect((await prisma.plant.findUniqueOrThrow({ where: { plantId } })).zoneId).toBe(eastId);
    expect(await openTicketIdsInZone(eastId)).toContain(ticketId);

    await service.reapply(actor);

    expect((await prisma.plant.findUniqueOrThrow({ where: { plantId } })).zoneId).toBe(southId);

    // The SAME ticket, still open, now reads as South's work.
    expect(await openTicketIdsInZone(southId)).toContain(ticketId);
    expect(await openTicketIdsInZone(eastId)).not.toContain(ticketId);
    expect(await devicesInZone(southId)).toContain(DEVICE_ID);
    expect(await devicesInZone(eastId)).not.toContain(DEVICE_ID);

    // The ZM dashboards on both sides follow.
    expect(await zmInactiveCount(southId)).toBe(southBefore + 1);
    expect(await zmInactiveCount(eastId)).toBe(eastBefore - 1);

    // The load-bearing half: nothing was written to the ticket or the device state. They re-scoped
    // purely by derivation, which is why no migration job exists and nothing can go stale.
    const ticketAfter = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticketAfter.status).toBe('OPEN');
    expect(ticketAfter.updatedAt).toEqual(ticketBefore.updatedAt);
    const state = await prisma.deviceState.findUniqueOrThrow({ where: { deviceId: DEVICE_ID } });
    expect(state.plantId).toBe(plantId); // still the same plant; only the plant's zone changed
  });

  it('survives a master-sync re-read of the same plant (the 2026-07-14 verification, as a regression)', async () => {
    const row: MstPlantRow = {
      plant_id: Number(SRC_PLANT),
      company_id: Number(companyId),
      plant_name: `ZoneMove Plant ${NS}`,
      zone_id: null,
      zone_name: 'EASTERN REGION', // AutoPlant still claims East
      region_id: null,
      region_name: null,
      plant_state: null,
      plant_district: null,
      master_plant_id: null,
      master_plant_code: null,
      status: 'ACTIVE',
    };
    // Whatever the resolver would say on a fresh insert is irrelevant on re-sync: zone_id is in the
    // upsert's `create` set only. Feed it East to prove the update path cannot drag the plant back.
    const mapped = mapPlant(row, { zoneId: eastId, districtId: null });
    await prisma.plant.upsert({
      where: { sourcePlantId: SRC_PLANT },
      create: mapped.create,
      update: mapped.update,
    });

    expect((await prisma.plant.findUniqueOrThrow({ where: { plantId } })).zoneId).toBe(southId);
    const override = await prisma.plantZoneOverride.findUniqueOrThrow({ where: { sourcePlantId: SRC_PLANT } });
    expect(override.fsmZoneId).toBe(southId);
    expect(override.reason).toBe('ops confirmed the site is South');
    expect(await openTicketIdsInZone(southId)).toContain(ticketId);
  });
});
