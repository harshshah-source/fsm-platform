import { randomUUID } from 'node:crypto';
import { AutoRecoveryService } from '../src/ticketing/auto-recovery.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #302 (forensics RC-2) — auto-recovery's close is guarded on the ticket still being OPEN.
 *
 * The sweep reads its candidates with `status: 'OPEN'` and then closes them by primary key, minutes
 * later — per-ticket ping queries, up to 200 closures a pass. Anything that moves a ticket in that
 * window is silently overwritten, and the one thing most likely to move it is the very event the rule
 * forbids: an SE submitting a troubleshooting form (`VERIFICATION_PENDING`). The service's own comment
 * claims the OPEN scan enforces CONTEXT's "no SE troubleshooting form may have been submitted" — the
 * scan cannot enforce anything about the moment of the write.
 *
 * The race is made deterministic the same way #301's is: the Prisma client is wrapped so the competing
 * write fires exactly once, immediately before the service opens its transaction — the window between
 * the candidate read and the close. No production seam is added for the test.
 */
const NS = Date.now();

function interferingPrisma(prisma: PrismaService, interfere: () => Promise<void>): PrismaService {
  let fired = false;
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return async (...args: unknown[]) => {
          if (!fired) {
            fired = true;
            await interfere();
          }
          return (target as unknown as Record<string, (...a: unknown[]) => unknown>).$transaction(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaService;
}

describe('#302 — auto-recovery cannot close a ticket that moved under it', () => {
  let prisma: PrismaService;
  let recovery: AutoRecoveryService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let snapshotRunId: bigint;
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const zm = { userId: randomUUID(), role: 'ZONAL_MANAGER' };

  /** An OPEN troubleshoot ticket on a device that is healthy again and has recovery-grade pings. */
  const seedRecoverable = async (): Promise<{ ticketId: string; deviceId: string; cycleId: string }> => {
    const deviceId = String(11_940_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    const openedAt = new Date(Date.now() - 6 * 60 * 60_000);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: openedAt,
      },
    });
    ticketIds.push(ticket.ticketId);
    // `inactivityHours: 0` — healthy at the recompute that just ran, which is the sweep's own gate.
    await prisma.deviceState.create({
      data: { deviceId, inactivityHours: 0, hasOpenFailureCycle: true, plantId, companyId, computedAt: new Date() },
    });
    // Ping evidence spanning long enough to meet the recovery criteria.
    for (let i = 0; i < 6; i++) {
      await prisma.rawDeviceSnapshot.create({
        data: {
          runId: snapshotRunId,
          deviceId,
          gpsDatetime: new Date(openedAt.getTime() + (i + 1) * 30 * 60_000),
          lat: 12.97,
          lon: 77.59,
        },
      });
    }
    return { ticketId: ticket.ticketId, deviceId, cycleId: cycle.cycleId };
  };

  const rowsFor = async (ticketId: string) => ({
    events: await prisma.ticketEvent.count({ where: { ticketId } }),
    audits: await prisma.auditLog.count({ where: { entityId: ticketId, action: 'AUTO_RECOVERY_CLOSED' } }),
    softStates: await prisma.softState.count({ where: { ticketId, resolvedAt: { not: null } } }),
  });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    recovery = new AutoRecoveryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-302-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-302-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-302-' + NS, zoneId } })).plantId;
    snapshotRunId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS', startedAt: new Date() } })).runId;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.rawDeviceSnapshot.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.snapshotRun.deleteMany({ where: { runId: snapshotRunId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC1/AC2 — an SE submission mid-sweep wins; the sweep skips and writes nothing', async () => {
    const { ticketId, cycleId } = await seedRecoverable();
    const before = await rowsFor(ticketId);

    // The SE submits their troubleshooting form between the candidate scan and the close — the exact
    // case CONTEXT forbids auto-recovery from overwriting.
    const raced = new AutoRecoveryService(
      interferingPrisma(prisma, async () => {
        await prisma.ticket.update({ where: { ticketId }, data: { status: 'VERIFICATION_PENDING' } });
      }),
    );
    const result = await raced.runAutoRecovery({ zoneId: Number(zoneId) });

    expect(result.closed).toBe(0);
    expect(result.skipped).toBe(1);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('VERIFICATION_PENDING');
    // AC2 — the seven-write transaction rolled back whole: no event, no audit, no cycle change.
    expect(await rowsFor(ticketId)).toEqual(before);
    expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } })).state).toBe('OPEN');
  });

  it('AC3 — sweep vs manualClose closes exactly once; the loser gets a conflict, not a second close', async () => {
    const { ticketId } = await seedRecoverable();

    // The manager closes it by hand while the sweep is mid-pass.
    const raced = new AutoRecoveryService(
      interferingPrisma(prisma, async () => {
        expect(await recovery.manualClose(ticketId, { role: 'OPERATIONS_HEAD', zoneId: null }, zm)).toBe('CLOSED');
      }),
    );
    const result = await raced.runAutoRecovery({ zoneId: Number(zoneId) });

    expect(result.closed).toBe(0);
    expect(result.skipped).toBe(1);
    const events = await prisma.ticketEvent.findMany({ where: { ticketId, toState: 'CLOSED_AUTO_RECOVERY' } });
    expect(events).toHaveLength(1);
    expect(events[0].reasonCode).toBe('MANUAL_AUTO_RECOVERY');
    expect(await prisma.auditLog.count({ where: { entityId: ticketId, action: 'AUTO_RECOVERY_CLOSED' } })).toBe(1);
  });

  it('AC3 — manualClose on a ticket closed under it returns its conflict, not a double close', async () => {
    const { ticketId } = await seedRecoverable();

    const raced = new AutoRecoveryService(
      interferingPrisma(prisma, async () => {
        await prisma.ticket.update({
          where: { ticketId },
          data: { status: 'CLOSED_AUTO_RECOVERY', closedAt: new Date() },
        });
      }),
    );
    const outcome = await raced.manualClose(ticketId, { role: 'OPERATIONS_HEAD', zoneId: null }, zm);

    // NOT_OPEN is the door's existing 409 — an honest conflict where a silent double close happened.
    expect(outcome).toBe('NOT_OPEN');
    expect(await prisma.ticketEvent.count({ where: { ticketId, toState: 'CLOSED_AUTO_RECOVERY' } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: ticketId, action: 'AUTO_RECOVERY_CLOSED' } })).toBe(0);
  });

  describe('regression — an uncontended pass is unchanged', () => {
    it('closes the ticket, verifies the cycle and writes its event and audit exactly once', async () => {
      const { ticketId, cycleId, deviceId } = await seedRecoverable();

      const result = await recovery.runAutoRecovery({ zoneId: Number(zoneId) });

      expect(result.closed).toBe(1);
      expect(result.skipped).toBe(0);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('CLOSED_AUTO_RECOVERY');
      expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } })).state).toBe('VERIFIED');
      expect(
        (await prisma.deviceState.findUniqueOrThrow({ where: { deviceId } })).hasOpenFailureCycle,
      ).toBe(false);
      expect(await prisma.ticketEvent.count({ where: { ticketId, toState: 'CLOSED_AUTO_RECOVERY' } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityId: ticketId, action: 'AUTO_RECOVERY_CLOSED' } })).toBe(1);
    });
  });
});
