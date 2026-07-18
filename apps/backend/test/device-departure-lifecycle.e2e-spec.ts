import { DeviceDepartureService } from '../src/device-departure/device-departure.service';
import { DeviceStateService } from '../src/device-state/device-state.service';
import { MasterSyncRunService } from '../src/ingestion/autoplant/master-sync-run.service';
import {
  MasterSyncService,
  type MasterSyncSource,
  type PlantZoneResolver,
} from '../src/ingestion/autoplant/master-sync.service';
import type {
  MasterSyncScope,
  MstCompanyRow,
  MstPlantRow,
  MstTransporterRow,
  VehicleMasterMasterRow,
} from '../src/ingestion/autoplant/master-mapping';
import { PrismaService } from '../src/prisma/prisma.service';
import type { SettingsService } from '../src/settings/settings.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * Issue 128 — FSM-owned device deployment lifecycle, driven by the master sync against a fake
 * `ap_masters` source (the same seam `master-sync-service.e2e-spec` uses).
 *
 * The gap this pins: master sync used to read `deployment_status IN ('DEPLOYED')` and only upsert the
 * rows the filtered read returned, so a device that LEFT the deployed fleet was frozen in FSM at
 * 'DEPLOYED' forever (measured 2026-07-17: 42.5% of live-batch devices were undeployed at source).
 *
 * The decided shape (operator, 2026-07-17):
 *   • the READ widens to ALL statuses, but the CREATE does NOT — only DEPLOYED/ACTIVE are ever
 *     created (the insert-scope pin); a never-known UNDEPLOYED row is counted, not mirrored, so the
 *     mirror never balloons from the operational fleet to the whole source catalog;
 *   • a KNOWN device leaving that scope opens an audited, reversible `device_departures` row and
 *     cancels its open tickets with reason DEVICE_UNDEPLOYED (#119 semantics);
 *   • a departed device is excluded from inactive / SLA / eligibility — a warehouse device is not
 *     broken — and re-deployment restores it automatically with nothing destroyed.
 */
describe('Device departure lifecycle (Issue 128, e2e)', () => {
  let prisma: PrismaService;
  let sync: MasterSyncService;
  let departures: DeviceDepartureService;
  let deviceState: DeviceStateService;
  let ticketCreation: TicketCreationService;
  let zoneId: bigint;

  const NS = Date.now() % 100_000;
  /** Seed in the real past so a cancellation's closed_at (real now) satisfies the failure_cycles CHECK. */
  const PAST = new Date(Date.now() - 4 * 86_400_000);

  const SRC_COMPANY = 928001n;
  const SRC_PLANT = 928002n;
  const SRC_TRANSPORTER = 928004n;

  // Four vehicles spanning the decision matrix: deployed control, deployed-then-departing,
  // never-known undeployed, never-known maintenance.
  const V_DEP = `ZZ128DEP${NS}`;
  const V_ACT = `ZZ128ACT${NS}`;
  const V_UND = `ZZ128UND${NS}`;
  const V_MNT = `ZZ128MNT${NS}`;
  const D_DEP = `RR_D128DEP${NS}`;
  const D_ACT = `RR_D128ACT${NS}`;
  const D_UND = `RR_D128UND${NS}`;
  const D_MNT = `RR_D128MNT${NS}`;

  const scope: MasterSyncScope = { plantStatuses: ['ACTIVE'] };
  const companies: MstCompanyRow[] = [
    { company_id: Number(SRC_COMPANY), company_name: `Dep Cement ${NS}`, company_type: 'NA', status: 'ACTIVE' },
  ];
  const transporters: MstTransporterRow[] = [
    {
      transporter_id: Number(SRC_TRANSPORTER),
      company_id: Number(SRC_COMPANY),
      transporter_name: `Dep Roadways ${NS}`,
      status: 'ACTIVE',
    },
  ];
  const plants: MstPlantRow[] = [
    {
      plant_id: Number(SRC_PLANT),
      company_id: Number(SRC_COMPANY),
      plant_name: `Dep Plant ${NS}`,
      zone_id: 2039,
      zone_name: 'South India',
      region_id: null,
      region_name: null,
      plant_state: 'Andhra Pradesh',
      plant_district: 'Kadapa',
      master_plant_id: null,
      master_plant_code: null,
      status: 'ACTIVE',
    },
  ];

  const vehicle = (no: string, dev: string, status: string): VehicleMasterMasterRow => ({
    vehicle_no: no,
    device_id: dev,
    plant_id: Number(SRC_PLANT),
    company_id: Number(SRC_COMPANY),
    transporter_id: Number(SRC_TRANSPORTER),
    device_type: 'V5',
    deployment_status: status,
  });

  /** The mutable source read — tests rewrite this between syncs to simulate AutoPlant changing. */
  let vehicleMasters: VehicleMasterMasterRow[] = [];

  const source: MasterSyncSource = {
    readCompanies: async () => companies,
    readTransporters: async () => transporters,
    readPlants: async () => plants,
    readVehicleMasters: async () => vehicleMasters,
  };
  const zoneResolver: PlantZoneResolver = { resolve: async () => ({ zoneId, districtId: null }) };
  const settingsStub = {
    get: async (key: string) => (key === 'inactivity_threshold_hours' ? 24 : 'all-deployed'),
  } as unknown as SettingsService;

  const activeDeparture = (deviceId: string) =>
    prisma.deviceDeparture.findFirst({ where: { deviceId, restoredAt: null } });

  const cleanup = async (): Promise<void> => {
    const devIds = [D_DEP, D_ACT, D_UND, D_MNT];
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: { in: devIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'DEVICE', entityId: { in: devIds } } });
    const tickets = await prisma.ticket.findMany({ where: { deviceId: { in: devIds } }, select: { ticketId: true } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: tickets.map((t) => t.ticketId) } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: devIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: devIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: devIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: devIds } } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo: { in: [V_DEP, V_ACT, V_UND, V_MNT] } } });
    await prisma.transporter.deleteMany({ where: { sourceTransporterId: SRC_TRANSPORTER } });
    await prisma.plant.deleteMany({ where: { sourcePlantId: SRC_PLANT } });
    await prisma.company.deleteMany({ where: { sourceCompanyId: SRC_COMPANY } });
    await prisma.masterSyncRun.deleteMany({ where: { status: 'RUNNING' } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    departures = new DeviceDepartureService(prisma);
    deviceState = new DeviceStateService(prisma, settingsStub);
    ticketCreation = new TicketCreationService(prisma);
    sync = new MasterSyncService(
      prisma,
      new MasterSyncRunService(prisma),
      source,
      zoneResolver,
      scope,
      undefined,
      departures,
    );
    zoneId = (await prisma.zone.create({ data: { name: `Z128_${NS}_${Date.now()}` } })).zoneId;
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('insert-scope pin: a mixed-status read creates ONLY the DEPLOYED/ACTIVE devices', async () => {
    vehicleMasters = [
      vehicle(V_DEP, D_DEP, 'DEPLOYED'),
      vehicle(V_ACT, D_ACT, 'ACTIVE'),
      vehicle(V_UND, D_UND, 'UNDEPLOYED'),
      vehicle(V_MNT, D_MNT, 'MAINTENANCE'),
    ];
    const result = await sync.sync();
    expect(result.status).toBe('SUCCESS');

    // Operational rows mirrored…
    expect(await prisma.vehicle.findUnique({ where: { vehicleNo: V_DEP } })).not.toBeNull();
    expect(await prisma.vehicle.findUnique({ where: { vehicleNo: V_ACT } })).not.toBeNull();
    expect(await prisma.device.findUnique({ where: { deviceId: D_DEP } })).not.toBeNull();
    expect(await prisma.device.findUnique({ where: { deviceId: D_ACT } })).not.toBeNull();

    // …never-known non-operational rows are READ but NOT created (the pin: read !== create).
    expect(await prisma.vehicle.findUnique({ where: { vehicleNo: V_UND } })).toBeNull();
    expect(await prisma.vehicle.findUnique({ where: { vehicleNo: V_MNT } })).toBeNull();
    expect(await prisma.device.findUnique({ where: { deviceId: D_UND } })).toBeNull();
    expect(await prisma.device.findUnique({ where: { deviceId: D_MNT } })).toBeNull();

    // Counted, not silently dropped.
    expect(result.stats.vehicles.skippedByReason?.NOT_DEPLOYED_NEVER_KNOWN).toBe(2);
    const rejects = await prisma.masterSyncReject.count({
      where: { runId: result.runId, reason: 'NOT_DEPLOYED_NEVER_KNOWN' },
    });
    expect(rejects).toBeGreaterThanOrEqual(2);

    // No departures: nothing FSM knew has left.
    expect(await prisma.deviceDeparture.count({ where: { deviceId: { in: [D_DEP, D_ACT] } } })).toBe(0);
  });

  it('departure detection: a known device flipping to UNDEPLOYED opens an audited departure and cancels its open ticket', async () => {
    // An open Troubleshoot ticket on the soon-to-depart device (what a wasted truck roll looks like).
    const cycle = await prisma.failureCycle.create({ data: { deviceId: D_DEP, state: 'OPEN', openedAt: PAST } });
    const plant = await prisma.plant.findUniqueOrThrow({ where: { sourcePlantId: SRC_PLANT } });
    const company = await prisma.company.findUniqueOrThrow({ where: { sourceCompanyId: SRC_COMPANY } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId: D_DEP,
        plantId: plant.plantId,
        companyId: company.companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: PAST,
      },
    });

    vehicleMasters = [
      vehicle(V_DEP, D_DEP, 'UNDEPLOYED'), // ← departed
      vehicle(V_ACT, D_ACT, 'ACTIVE'),
      vehicle(V_UND, D_UND, 'UNDEPLOYED'),
      vehicle(V_MNT, D_MNT, 'MAINTENANCE'),
    ];
    const result = await sync.sync();
    expect(result.status).toBe('SUCCESS');

    // The mirror is finally truthful — the row is UPDATED, never deleted.
    expect((await prisma.vehicle.findUnique({ where: { vehicleNo: V_DEP } }))?.status).toBe('UNDEPLOYED');

    const dep = await activeDeparture(D_DEP);
    expect(dep).not.toBeNull();
    expect(dep?.observedStatus).toBe('UNDEPLOYED');
    expect(dep?.reason).toBe('SOURCE_STATUS');
    expect(dep?.detectedByRunId).toBe(result.runId);
    expect(dep?.cancelledTicketsCount).toBe(1);

    // Ticket cancelled with the decided reason, #119 semantics.
    const closed = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: ticket.ticketId } });
    expect(closed.status).toBe('CLOSED');
    expect(closed.closureReason).toContain('DEVICE_UNDEPLOYED');
    expect(closed.closedAt).not.toBeNull();
    const event = await prisma.ticketEvent.findFirst({
      where: { ticketId: ticket.ticketId, reasonCode: 'DEVICE_UNDEPLOYED' },
    });
    expect(event?.toState).toBe('CLOSED');
    // Parent cycle terminated so a returned device can open a fresh one (not mis-flagged REPEAT).
    expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId: cycle.cycleId } })).state).toBe('FAILED');

    // Audited, system-actor.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'DEVICE_DEPARTED', entityType: 'DEVICE', entityId: D_DEP },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe('SYSTEM');

    expect(result.stats.departures?.inserted).toBe(1);
    // The still-ACTIVE control device is untouched.
    expect(await activeDeparture(D_ACT)).toBeNull();
  });

  it('eligibility: a departed device is excluded from inactive / SLA / eligible (a warehouse device is not broken)', async () => {
    // Both devices are long-silent; only the departed one must drop out. Master sync never touches
    // device_states, so materialise the rows first (recompute creates one per device) — otherwise the
    // updateMany below matches nothing and both devices keep a NULL latest ping (never-pinged, not silent).
    await deviceState.recompute();
    const silent = new Date(Date.now() - 72 * 3_600_000);
    await prisma.deviceState.updateMany({
      where: { deviceId: { in: [D_DEP, D_ACT] } },
      data: { latestGpsDatetime: silent },
    });
    await deviceState.recompute();

    const departed = await prisma.deviceState.findUniqueOrThrow({ where: { deviceId: D_DEP } });
    expect(departed.isDeparted).toBe(true);
    expect(departed.isInactive).toBe(false);
    expect(departed.slaBucket).toBeNull();
    expect(departed.eligibleForUptime).toBe(false);

    // The control device — same silence, still deployed — still ages normally.
    const control = await prisma.deviceState.findUniqueOrThrow({ where: { deviceId: D_ACT } });
    expect(control.isDeparted).toBe(false);
    expect(control.isInactive).toBe(true);
    expect(control.slaBucket).not.toBeNull();
    expect(control.eligibleForUptime).toBe(true);

    // …and ticket-creation therefore never re-tickets the departed device.
    await ticketCreation.createForInactiveEligible();
    expect(await prisma.ticket.count({ where: { deviceId: D_DEP, status: 'OPEN' } })).toBe(0);
  });

  it('sync survival: a re-run does not duplicate or clear an active departure', async () => {
    const before = await activeDeparture(D_DEP);
    const result = await sync.sync();
    expect(result.status).toBe('SUCCESS');

    const after = await activeDeparture(D_DEP);
    expect(after?.id).toBe(before?.id); // same row — not re-opened
    expect(await prisma.deviceDeparture.count({ where: { deviceId: D_DEP } })).toBe(1);
    expect(result.stats.departures?.inserted).toBe(0); // idempotent: nothing new to mark
  });

  it('auto-restore: the device returning to DEPLOYED closes the departure and resumes eligibility — no manual step', async () => {
    vehicleMasters = [
      vehicle(V_DEP, D_DEP, 'DEPLOYED'), // ← back
      vehicle(V_ACT, D_ACT, 'ACTIVE'),
      vehicle(V_UND, D_UND, 'UNDEPLOYED'),
      vehicle(V_MNT, D_MNT, 'MAINTENANCE'),
    ];
    const result = await sync.sync();

    expect(await activeDeparture(D_DEP)).toBeNull();
    const history = await prisma.deviceDeparture.findFirstOrThrow({ where: { deviceId: D_DEP } });
    expect(history.restoredAt).not.toBeNull(); // history kept, nothing destroyed
    expect(history.restoredStatus).toBe('DEPLOYED');
    expect(history.restoredByRunId).toBe(result.runId);
    expect(result.stats.departures?.updated).toBe(1); // counted as a restore

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'DEVICE_REDEPLOYED', entityType: 'DEVICE', entityId: D_DEP },
    });
    expect(audit).not.toBeNull();

    // Eligibility resumes on the next recompute with no operator action.
    await deviceState.recompute();
    const state = await prisma.deviceState.findUniqueOrThrow({ where: { deviceId: D_DEP } });
    expect(state.isDeparted).toBe(false);
    expect(state.eligibleForUptime).toBe(true);
    expect(state.isInactive).toBe(true); // still silent → the pipeline may legitimately re-ticket it
  });

  it('never-known-then-deployed: a previously skipped UNDEPLOYED device is created when it deploys', async () => {
    expect(await prisma.device.findUnique({ where: { deviceId: D_UND } })).toBeNull();
    vehicleMasters = [
      vehicle(V_DEP, D_DEP, 'DEPLOYED'),
      vehicle(V_ACT, D_ACT, 'ACTIVE'),
      vehicle(V_UND, D_UND, 'DEPLOYED'), // ← deploys for the first time
      vehicle(V_MNT, D_MNT, 'MAINTENANCE'),
    ];
    await sync.sync();

    // The create rule is status-based, not history-based — never-known is not a permanent exile.
    expect(await prisma.device.findUnique({ where: { deviceId: D_UND } })).not.toBeNull();
    expect((await prisma.vehicle.findUnique({ where: { vehicleNo: V_UND } }))?.status).toBe('DEPLOYED');
    expect(await activeDeparture(D_UND)).toBeNull();
  });

  it('absence-diff guard rail: a truncated read marks NOTHING (inference never mass-departs the fleet)', async () => {
    const activeBefore = await prisma.deviceDeparture.count({
      where: { deviceId: { in: [D_DEP, D_ACT, D_UND] }, restoredAt: null },
    });

    // Simulate a partial/truncated source read: every known device vanishes at once.
    vehicleMasters = [];
    const result = await sync.sync();
    expect(result.status).toBe('SUCCESS');

    // 100% of the synced scope would be marked absent → the guard trips and nothing is written.
    expect(result.stats.departures?.skippedByReason?.ABSENCE_GUARD_TRIPPED).toBeGreaterThan(0);
    expect(await activeDeparture(D_DEP)).toBeNull();
    expect(await activeDeparture(D_ACT)).toBeNull();
    expect(
      await prisma.deviceDeparture.count({
        where: { deviceId: { in: [D_DEP, D_ACT, D_UND] }, restoredAt: null },
      }),
    ).toBe(activeBefore);
  });

  it('absence-diff: a device genuinely gone from the source is marked MISSING_FROM_SOURCE', async () => {
    // Only D_ACT vanishes — a small, believable diff well under the guard ratio.
    vehicleMasters = [
      vehicle(V_DEP, D_DEP, 'DEPLOYED'),
      vehicle(V_UND, D_UND, 'DEPLOYED'),
      vehicle(V_MNT, D_MNT, 'MAINTENANCE'),
    ];
    const result = await sync.sync({ maxAbsenceRatio: 0.9 });

    const dep = await activeDeparture(D_ACT);
    expect(dep).not.toBeNull();
    expect(dep?.reason).toBe('ABSENT_FROM_READ');
    expect(dep?.observedStatus).toBe('MISSING_FROM_SOURCE');
    expect(result.stats.departures?.inserted).toBe(1);
  });
});
