import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AutoRecoveryService } from '../src/ticketing/auto-recovery.service';

/**
 * Issue 08 slice 2 + **#229** — the auto-recovery pre-check.
 *
 * Issue 08 established the core rule: a device that resumes pinging while its Troubleshoot Ticket is
 * OPEN auto-closes as CLOSED_AUTO_RECOVERY with no form, the cycle goes VERIFIED, and the open-cycle
 * flag clears. #229 found that rule had no production caller — 11,042 closable tickets had piled up —
 * and that closing them as written would have produced wrong reports and wrong screens. This spec
 * covers both the rule and the four things that must be true for a closure to be *complete*.
 *
 * The fixtures are the four cases that separate "resumed pinging at some point" from "is back now":
 *
 * | device        | healthy now | ping evidence      | closes? |
 * |---------------|-------------|--------------------|---------|
 * | RECOVERED     | yes         | 3 pings, 70 min    | yes     |
 * | RECOVERED_2   | yes         | 3 pings, 70 min    | yes (newer cycle — the cap's second pass) |
 * | FLAPPING      | **no**      | 3 pings, 70 min    | **no** — qualifying evidence, still down (#229 D3) |
 * | BRIEF         | yes         | 3 pings, 20 min    | **no** — under CONTEXT's =1h stability |
 * | STILL_DOWN    | no          | 1 ping             | no      |
 */
const DEV_RECOVERED = String(9_081_001n);
const DEV_STILL_DOWN = String(9_081_002n);
const DEV_FLAPPING = String(9_081_003n);
const DEV_BRIEF = String(9_081_004n);
const DEV_RECOVERED_2 = String(9_081_005n);
const ALL = [DEV_RECOVERED, DEV_STILL_DOWN, DEV_FLAPPING, DEV_BRIEF, DEV_RECOVERED_2];

describe('Issue 08 slice 2 / #229 — AutoRecoveryService', () => {
  let prisma: PrismaService;
  let service: AutoRecoveryService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let runId: bigint;
  let seId: string;
  let scheduleId: bigint;
  let batchId: bigint;

  const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));
  /** Cycle opened 4h before NOW, so every ping offset below still lands in the past. */
  const openedFor = (device: string) =>
    new Date(NOW.getTime() - (device === DEV_RECOVERED_2 ? 200 : 240) * 60_000);
  const ticketIdByDevice = new Map<string, string>();

  const seed = async (
    deviceId: string,
    pingOffsets: number[],
    opts: { isInactive: boolean },
  ) => {
    const opened = openedFor(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: opts.isInactive,
        inactivityHours: opts.isInactive ? 2 : 0,
        slaBucket: opts.isInactive ? 'CRITICAL' : null,
        // #215 hygiene — `runAutoRecovery` never reads `eligible_for_uptime` (it scans open
        // TROUBLESHOOT tickets filtered on ticket status + device liveness), so seeding it `true`
        // bought this fixture nothing and put 5 devices into the scope of every unscoped
        // "all eligible devices" report assertion in the suite. Left false deliberately.
        eligibleForUptime: false,
        hasOpenFailureCycle: true,
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({
      data: { deviceId, state: 'OPEN', openedAt: opened },
    });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: opened,
      },
    });
    ticketIdByDevice.set(deviceId, ticket.ticketId);
    await prisma.ticketEvent.create({
      data: { ticketId: ticket.ticketId, fromState: null, toState: 'OPEN', at: opened },
    });
    for (const off of pingOffsets) {
      await prisma.rawDeviceSnapshot.create({
        data: { runId, deviceId, gpsDatetime: new Date(opened.getTime() + off * 60_000) },
      });
    }
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new AutoRecoveryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-ar-' + Date.now() } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: 'Co-ar', companyTier: 'GOLD', companyPriorityRank: 'B' },
      })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ar', zoneId } })).plantId;
    runId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS' } })).runId;

    await seed(DEV_RECOVERED, [70, 100, 140], { isInactive: false });
    await seed(DEV_STILL_DOWN, [90], { isInactive: true });
    // Qualifying ping evidence, but the recompute that just ran says it is down again.
    await seed(DEV_FLAPPING, [70, 100, 140], { isInactive: true });
    // Healthy, but three pings inside 20 minutes is not an hour of stability.
    await seed(DEV_BRIEF, [70, 80, 90], { isInactive: false });
    await seed(DEV_RECOVERED_2, [70, 100, 140], { isInactive: false });

    // An SE holding a soft state on the recovered ticket, and a live day-plan batch containing it —
    // the two surfaces #229 §5.2 found the closure was leaving behind.
    const tag = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ar-' + tag, email: `${tag}@ar.test`, zoneId },
    });
    seId = user.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    await prisma.softState.create({
      data: { ticketId: ticketIdByDevice.get(DEV_RECOVERED)!, seId, type: 'ON_SITE', setAt: NOW },
    });
    const schedule = await prisma.workSchedule.create({
      data: {
        seId,
        zoneId,
        dateFrom: new Date('2026-05-20T00:00:00.000Z'),
        dateTo: new Date('2026-05-20T00:00:00.000Z'),
        status: 'ACTIVE',
        dispatchedAt: NOW,
      },
    });
    scheduleId = schedule.scheduleId;
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    batchId = batch.batchId;
    await prisma.batchAssignmentTicket.create({
      data: { batchId, ticketId: ticketIdByDevice.get(DEV_RECOVERED)!, sortOrder: 1 },
    });
  });

  afterAll(async () => {
    const ticketIds = [...ticketIdByDevice.values()];
    await prisma.auditLog.deleteMany({ where: { entityType: 'TICKET', entityId: { in: ticketIds } } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } });
    await prisma.user.deleteMany({ where: { userId: seId } });
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.rawDeviceSnapshot.deleteMany({ where: { runId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.snapshotRun.deleteMany({ where: { runId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  // Ordered: the dry run must observe the untouched fixture, then the cap, then the drain.

  it('dry-run reports the qualifying plan with its evidence and writes nothing', async () => {
    const result = await service.runAutoRecovery({ now: NOW, dryRun: true });

    // Only the two healthy, hour-stable devices qualify — FLAPPING and BRIEF are scanned or excluded
    // but never planned, and STILL_DOWN never reaches the scan at all.
    expect(result.plan?.map((r) => r.deviceId).sort()).toEqual([DEV_RECOVERED, DEV_RECOVERED_2]);
    expect(result.closed).toBe(2);
    const row = result.plan!.find((r) => r.deviceId === DEV_RECOVERED)!;
    expect(row.pingCount).toBe(3);
    expect(row.spanMinutes).toBe(70);
    expect(row.zoneId).toBe(zoneId.toString());

    // Nothing was written.
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_RECOVERED } });
    expect(ticket.status).toBe('OPEN');
    expect(ticket.closedAt).toBeNull();
  });

  it('honours maxClosures and takes the oldest failure cycle first', async () => {
    const result = await service.runAutoRecovery({ now: NOW, maxClosures: 1 });

    expect(result.closed).toBe(1);
    expect(result.capped).toBe(true);
    // DEV_RECOVERED's cycle opened 40 min before DEV_RECOVERED_2's, so it is the deterministic first.
    const first = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_RECOVERED } });
    expect(first.status).toBe('CLOSED_AUTO_RECOVERY');
    const second = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_RECOVERED_2 } });
    expect(second.status).toBe('OPEN');
  });

  it('writes a complete closure — closed_at, closure type, audit row, soft state, batch detachment', async () => {
    const ticketId = ticketIdByDevice.get(DEV_RECOVERED)!;
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });

    // Without closed_at the Fleet Uptime cube counts this closure as zero (#229 §1.3).
    expect(ticket.closedAt).toEqual(NOW);
    expect(ticket.closureType).toBe('AUTO_RECOVERY_CLOSE');
    expect(ticket.closureReason).toContain('AUTO_RECOVERY');

    const cycle = await prisma.failureCycle.findFirstOrThrow({ where: { deviceId: DEV_RECOVERED } });
    expect(cycle.state).toBe('VERIFIED');
    expect(cycle.closedAt).toEqual(NOW);

    const state = await prisma.deviceState.findUniqueOrThrow({ where: { deviceId: DEV_RECOVERED } });
    expect(state.hasOpenFailureCycle).toBe(false);

    const events = await prisma.ticketEvent.findMany({ where: { ticketId }, orderBy: { at: 'asc' } });
    expect(events.at(-1)!.toState).toBe('CLOSED_AUTO_RECOVERY');
    expect(events.at(-1)!.reasonCode).toBe('AUTO_RECOVERY');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'TICKET', entityId: ticketId, action: 'AUTO_RECOVERY_CLOSED' },
    });
    expect(audit.actorId).toBe('SYSTEM');
    expect(audit.metadata).toMatchObject({ deviceId: DEV_RECOVERED, manual: false, pingCount: 3 });

    // CONTEXT §Soft States names auto-recovery an explicit resolution event.
    const soft = await prisma.softState.findFirstOrThrow({ where: { ticketId } });
    expect(soft.resolvedAt).toEqual(NOW);
    expect(soft.resolutionReason).toBe('AUTO_RECOVERY');

    // Off the SE's day plan — otherwise it renders as work-to-do indefinitely (#229 §3.4 #3).
    const planRow = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { ticketId } });
    expect(planRow.removedAt).toEqual(NOW);
  });

  it('closes the deferred remainder on the next pass, and reports not-capped once drained', async () => {
    const result = await service.runAutoRecovery({ now: NOW });

    expect(result.closed).toBe(1);
    expect(result.capped).toBe(false);
    const second = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_RECOVERED_2 } });
    expect(second.status).toBe('CLOSED_AUTO_RECOVERY');
  });

  it('leaves a FLAPPING device open — qualifying pings, but inactive at the recompute that just ran', async () => {
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_FLAPPING } });
    expect(ticket.status).toBe('OPEN');
    // The point of the rule: closing it would clear has_open_failure_cycle and let ticket creation
    // re-open a REPEAT-flagged cycle on the same tick, manufacturing an escalation nobody worked.
    const cycle = await prisma.failureCycle.findFirstOrThrow({ where: { deviceId: DEV_FLAPPING } });
    expect(cycle.state).toBe('OPEN');
  });

  it('leaves a device whose recovery pings span under an hour open (CONTEXT =1h stability)', async () => {
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_BRIEF } });
    expect(ticket.status).toBe('OPEN');
  });

  it('leaves a still-inactive device with no recovery evidence open', async () => {
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_STILL_DOWN } });
    expect(ticket.status).toBe('OPEN');
  });

  it('scopes to a zone when asked, so the first drain can be staged', async () => {
    const elsewhere = await service.runAutoRecovery({ now: NOW, zoneId: Number(zoneId) + 999_999 });
    expect(elsewhere.scanned).toBe(0);
    expect(elsewhere.closed).toBe(0);
  });
});
