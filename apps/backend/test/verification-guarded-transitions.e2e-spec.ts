import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeCoverageService } from '../src/shared-pool/se-coverage.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';
import { VerificationService } from '../src/verification/verification.service';

/**
 * #301 (forensics RC-1) — guarded status transitions in verification finalize / fraud / auto-recovery.
 *
 * All three writers used `read → check in JS → update by primary key`. Under READ COMMITTED that lets
 * the 5-minute sweep overwrite a fraud escalation a manager just made, or stomp an auto-recovery
 * close, or be stomped by either — and the interleavings do not merely disagree on the label:
 * finalize-FAILED restores the SE's van stock and auto-recovery does not, so the loser's inventory
 * effect could commit against the winner's status.
 *
 * ## How the race is made deterministic
 *
 * `Promise.all([sweep(), sweep()])` would only *start* the two together and leave the interesting
 * interleaving to the scheduler (see `test/support/concurrency.ts` on why that proves little). None of
 * these methods has an injection point at the write, so instead of adding a production seam for the
 * test, the spec wraps the Prisma client and fires the competing write **once, immediately before the
 * service opens its transaction** — which is exactly the window between the candidate read and the
 * guarded write. The interleaving is then a property of the test, not of luck.
 */
const NS = Date.now();
const T0 = new Date('2026-06-23T06:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const ANCHOR = { lat: 12.9716, lon: 77.5946 };
const NEAR = { lat: 12.9721, lon: 77.5946 };

/**
 * A Prisma facade that runs `interfere()` exactly once, just before the next `$transaction` the
 * service under test opens. Reads and every other delegate pass straight through, so the service sees
 * the real database throughout — only the *timing* of the competing write is controlled.
 */
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

describe('#301 — verification writers cannot overwrite a concurrent winner', () => {
  let prisma: PrismaService;
  let verify: VerificationService;
  let submit: TroubleshootSubmissionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let se: string;
  let snapshotRunId: bigint;
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const zmActor = { userId: randomUUID(), role: 'ZONAL_MANAGER' };
  const anyZone = () => ({ role: 'OPERATIONS_HEAD', zoneId: null });

  const makeTicket = async (): Promise<{ ticketId: string; deviceId: string; cycleId: string }> => {
    const deviceId = String(11_930_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: T0 } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: T0,
      },
    });
    ticketIds.push(ticket.ticketId);
    await prisma.deviceState.create({
      data: { deviceId, isInactive: true, hasOpenFailureCycle: true, plantId, companyId, computedAt: T0 },
    });
    return { ticketId: ticket.ticketId, deviceId, cycleId: cycle.cycleId };
  };

  const addPing = (deviceId: string, time: Date) =>
    prisma.rawDeviceSnapshot.create({ data: { runId: snapshotRunId, deviceId, gpsDatetime: time, ...NEAR } });

  /** Pings far from the SE's anchor — the phase-1 location-mismatch fraud verdict. */
  const addFarPings = async (deviceId: string) => {
    for (const m of [1, 8, 16]) {
      await prisma.rawDeviceSnapshot.create({
        data: { runId: snapshotRunId, deviceId, gpsDatetime: at(m), lat: 13.4716, lon: 77.5946 },
      });
    }
  };

  const submitForm = (ticketId: string) =>
    submit.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'POWER_ISSUE',
      seGps: { lat: ANCHOR.lat, lon: ANCHOR.lon },
      presenceSource: 'FORM_GPS',
      actor: { userId: se, role: 'SERVICE_ENGINEER' },
      now: T0,
    });

  /** A PRE_VERIFICATION component consumption — the inventory effect AC3 is about. */
  const consumeComponent = (ticketId: string) =>
    prisma.inventoryTransaction.create({
      data: { seId: se, componentId, qty: 1, ticketId, type: 'TICKET_CONSUMPTION', status: 'PRE_VERIFICATION' },
    });

  const setStatus = (ticketId: string, status: string) =>
    prisma.ticket.update({ where: { ticketId }, data: { status: status as never } });

  const eventsFor = (ticketId: string) =>
    prisma.ticketEvent.findMany({ where: { ticketId }, orderBy: { at: 'asc' } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    verify = new VerificationService(prisma);
    submit = new TroubleshootSubmissionService(prisma, new SeCoverageService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-301-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-301-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-301-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'cmp-301-' + NS } })).componentId;
    snapshotRunId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS', startedAt: T0 } })).runId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@v301.test`, zoneId },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });
  });

  afterAll(async () => {
    await prisma.seCoverage.deleteMany({ where: { seId: se } });
    await prisma.inventoryTransaction.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.seVanStock.deleteMany({ where: { seId: se } });
    await prisma.verificationRun.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.rawDeviceSnapshot.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.vehicleUnavailabilityReport.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    const cycleIds = await prisma.failureCycle.findMany({ where: { deviceId: { in: deviceIds } }, select: { cycleId: true } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'failure_cycles', entityId: { in: cycleIds.map((c) => c.cycleId) } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.snapshotRun.deleteMany({ where: { runId: snapshotRunId } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC1/AC3 — a CLOSED finalize loses to a fraud escalation that landed first, and consumes no inventory', async () => {
    const { ticketId, deviceId, cycleId } = await makeTicket();
    await submitForm(ticketId);
    for (const m of [1, 20, 45, 65]) await addPing(deviceId, at(m));
    const txn = await consumeComponent(ticketId);

    // The ZM escalates between the sweep's candidate read and its write.
    const raced = new VerificationService(interferingPrisma(prisma, () => setStatus(ticketId, 'ESCALATED')));
    const res = await raced.runVerification(at(70), { ticketIds: [ticketId] });

    expect(res.skipped).toBe(1);
    expect(res.closed).toBe(0);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('ESCALATED'); // the winner's verdict stands
    // The whole per-ticket transaction rolled back: no cycle close, no run outcome, no event…
    expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } })).state).toBe('SUBMITTED');
    expect((await prisma.verificationRun.findFirstOrThrow({ where: { ticketId } })).outcome).toBeNull();
    expect((await eventsFor(ticketId)).some((e) => e.toState === 'CLOSED')).toBe(false);
    // …and, the part that makes this corruption rather than a wrong label: the component consumption
    // is NOT confirmed as DEDUCTED against a verdict that never happened.
    expect((await prisma.inventoryTransaction.findUniqueOrThrow({ where: { id: txn.id } })).status).toBe(
      'PRE_VERIFICATION',
    );
  });

  it('AC1/AC3 — a FAILED finalize loses to an auto-recovery close, and restores no van stock', async () => {
    const { ticketId, cycleId } = await makeTicket();
    await submitForm(ticketId);
    // No pings + an advanced telemetry watermark ⇒ the window expires ⇒ FAILED_VERIFICATION.
    await prisma.snapshotRun.create({
      data: { status: 'SUCCESS', startedAt: T0, dataAsOf: new Date(T0.getTime() + 26 * 60 * 60_000) },
    });
    const txn = await consumeComponent(ticketId);

    const raced = new VerificationService(
      interferingPrisma(prisma, () => setStatus(ticketId, 'CLOSED_AUTO_RECOVERY')),
    );
    const res = await raced.runVerification(new Date(T0.getTime() + 25 * 60 * 60_000), { ticketIds: [ticketId] });

    expect(res.skipped).toBe(1);
    expect(res.failed).toBe(0);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('CLOSED_AUTO_RECOVERY');
    expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } })).state).toBe('SUBMITTED');
    // Auto-recovery does NOT restore van stock; a lost FAILED finalize must not restore it either.
    expect((await prisma.inventoryTransaction.findUniqueOrThrow({ where: { id: txn.id } })).status).toBe(
      'PRE_VERIFICATION',
    );
    expect(await prisma.seVanStock.findUnique({ where: { seId_componentId: { seId: se, componentId } } })).toBeNull();
  });

  it('AC2 — escalateFraud loses cleanly when the ticket moved under it: no write, no audit, no 500', async () => {
    const { ticketId, deviceId } = await makeTicket();
    await submitForm(ticketId);
    // Far pings fraud-flag the run and finalize FAILED_VERIFICATION — the state the ZM acts on.
    await addFarPings(deviceId);
    expect((await verify.runVerification(at(70), { ticketIds: [ticketId] })).fraud).toBe(1);
    const eventsBefore = (await eventsFor(ticketId)).length;

    const raced = new VerificationService(
      interferingPrisma(prisma, () => setStatus(ticketId, 'CLOSED_AUTO_RECOVERY')),
    );
    const outcome = await raced.escalateFraud(ticketId, 'suspected fraud', zmActor, anyZone());

    // The documented lost-race mapping (`common/lost-race.ts`): the row you asked me to act on is no
    // longer the row you read. An honest 404, never a silent overwrite and never a 500.
    expect(outcome).toBe('NOT_FOUND');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('CLOSED_AUTO_RECOVERY');
    expect((await eventsFor(ticketId)).length).toBe(eventsBefore);
    expect(
      await prisma.auditLog.count({ where: { entityId: ticketId, action: 'VERIFICATION_FRAUD_ESCALATED' } }),
    ).toBe(0);
  });

  it('AC2 — markAutoRecovery loses cleanly, leaving the cycle and the day plan alone', async () => {
    const { ticketId, cycleId } = await makeTicket();
    await submitForm(ticketId);
    const eventsBefore = (await eventsFor(ticketId)).length;

    const raced = new VerificationService(interferingPrisma(prisma, () => setStatus(ticketId, 'ESCALATED')));
    const outcome = await raced.markAutoRecovery(ticketId, zmActor, anyZone());

    expect(outcome).toBe('NOT_FOUND');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('ESCALATED');
    expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } })).state).toBe('SUBMITTED');
    expect((await eventsFor(ticketId)).length).toBe(eventsBefore);
    expect(await prisma.auditLog.count({ where: { entityId: ticketId, action: 'MANUAL_AUTO_RECOVERY' } })).toBe(0);
  });

  it('two overlapping sweeps close the ticket exactly once, and stamp one run outcome', async () => {
    const { ticketId, deviceId } = await makeTicket();
    await submitForm(ticketId);
    // One ping first, so a PENDING pass creates the verification run: both sweeps below then find the
    // SAME run and contend for its outcome, instead of each creating one of their own.
    await addPing(deviceId, at(1));
    expect((await verify.runVerification(at(30), { ticketIds: [ticketId] })).pending).toBe(1);
    for (const m of [20, 45, 65]) await addPing(deviceId, at(m));

    // `Promise.all([sweep(), sweep()])` would NOT do this: both calls start together but the second is
    // entered only when the first hits an await, and nothing makes them straddle the write. (Proved by
    // trying it — the ungarded code passes that version, which is the trap `support/concurrency.ts`
    // documents.) Driving the second sweep from the first one's pre-transaction hook puts them in the
    // critical section together by construction.
    const raced = new VerificationService(
      interferingPrisma(prisma, async () => {
        expect((await verify.runVerification(at(70), { ticketIds: [ticketId] })).closed).toBe(1);
      }),
    );
    const res = await raced.runVerification(at(70), { ticketIds: [ticketId] });

    expect(res).toMatchObject({ closed: 0, skipped: 1 });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('CLOSED');
    const closes = (await eventsFor(ticketId)).filter((e) => e.toState === 'CLOSED');
    expect(closes).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { entityId: ticketId, action: 'VERIFICATION_CLOSED' } })).toBe(1);
    // The `outcome: null` guard on the run: one conclusion, not two writes over each other.
    const runs = await prisma.verificationRun.findMany({ where: { ticketId } });
    expect(runs.filter((r) => r.outcome !== null)).toHaveLength(1);
  });

  describe('regression — the guards do not narrow any legitimate transition', () => {
    it('escalateFraud still escalates a fraud-flagged ticket', async () => {
      const { ticketId, deviceId } = await makeTicket();
      await submitForm(ticketId);
      await addFarPings(deviceId);
      await verify.runVerification(at(70), { ticketIds: [ticketId] });

      expect(await verify.escalateFraud(ticketId, 'reviewed', zmActor, anyZone())).toBe('OK');
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('ESCALATED');
    });

    it('markAutoRecovery still closes a pending ticket and verifies its cycle', async () => {
      const { ticketId, deviceId, cycleId } = await makeTicket();
      await submitForm(ticketId);
      // One ping leaves the ticket PENDING and, more to the point, creates the verification_run whose
      // outcome markAutoRecovery stamps — the state the ZM's review queue actually acts on.
      await addPing(deviceId, at(1));
      expect((await verify.runVerification(at(30), { ticketIds: [ticketId] })).pending).toBe(1);

      expect(await verify.markAutoRecovery(ticketId, zmActor, anyZone())).toBe('OK');
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      expect(ticket.status).toBe('CLOSED_AUTO_RECOVERY');
      expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } })).state).toBe('VERIFIED');
      expect((await prisma.verificationRun.findFirstOrThrow({ where: { ticketId } })).outcome).toBe(
        'CLOSED_AUTO_RECOVERY',
      );
    });

    it('an uncontended sweep still closes, verifies the cycle and deducts the component', async () => {
      const { ticketId, deviceId, cycleId } = await makeTicket();
      await submitForm(ticketId);
      for (const m of [1, 20, 45, 65]) await addPing(deviceId, at(m));
      const txn = await consumeComponent(ticketId);

      const res = await verify.runVerification(at(70), { ticketIds: [ticketId] });

      expect(res).toMatchObject({ closed: 1, skipped: 0 });
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('CLOSED');
      expect((await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } })).state).toBe('VERIFIED');
      expect((await prisma.inventoryTransaction.findUniqueOrThrow({ where: { id: txn.id } })).status).toBe('DEDUCTED');
    });
  });
});
