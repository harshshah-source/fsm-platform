import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import type { DayPlanDispatchedEvent, DayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import {
  drainRows,
  drainUnsent,
  pruneSentDayPlanOutbox,
  queueDayPlanDispatched,
  queueDayPlanOverridden,
} from '../src/scheduling/day-plan-notification-outbox';

/**
 * #264 — the durable day-plan notification outbox module, tested at its own seam (the four exported
 * functions), independent of the two writers (`BatchAssignmentService`, `OverrideService`) that call
 * it. `day-plan-notification-outbox-writers.e2e-spec.ts` covers the writer-side integration ACs
 * (the notifier-throw misreport inversion, the rolled-back-tx guarantee from a real dispatch).
 */
const NOW = new Date('2026-08-24T06:00:00Z');

class RecordingNotifier implements DayPlanNotifier {
  calls: { type: 'dispatched' | 'overridden'; seId: string }[] = [];
  private shouldThrow = false;

  throwNext(): void {
    this.shouldThrow = true;
  }

  dayPlanDispatched(event: DayPlanDispatchedEvent): void {
    if (this.shouldThrow) {
      this.shouldThrow = false;
      throw new Error('channel unavailable');
    }
    this.calls.push({ type: 'dispatched', seId: event.seId });
  }

  dayPlanOverridden(event: { seId: string }): void {
    this.calls.push({ type: 'overridden', seId: event.seId });
  }
}

describe('#264 — day-plan notification outbox', () => {
  let prisma: PrismaService;
  const rowIds: bigint[] = [];

  const event = (seId: string): DayPlanDispatchedEvent => ({
    seId,
    scheduleId: BigInt(1),
    zoneId: BigInt(1),
    stops: 2,
    tickets: 3,
  });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.dayPlanNotificationOutbox.deleteMany({ where: { id: { in: rowIds } } });
    await prisma.onModuleDestroy();
  });

  it('AC — a row written and never drained (simulated crash) is delivered once by the sweep, sentAt gets stamped', async () => {
    const seId = randomUUID();
    const id = await queueDayPlanDispatched(prisma, event(seId));
    rowIds.push(id);

    const notifier = new RecordingNotifier();
    const { drained } = await drainUnsent(prisma, notifier, NOW);
    expect(drained).toBeGreaterThanOrEqual(1);
    expect(notifier.calls.filter((c) => c.seId === seId)).toHaveLength(1);

    const row = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.sentAt).not.toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('AC — a notifier that throws leaves the row unsent with lastError, never propagates', async () => {
    const seId = randomUUID();
    const id = await queueDayPlanDispatched(prisma, event(seId));
    rowIds.push(id);

    const notifier = new RecordingNotifier();
    notifier.throwNext();
    await drainRows(prisma, notifier, [id], NOW); // must not throw

    const row = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.sentAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('channel unavailable');

    // A later drain (the sweep, next tick) retries it successfully.
    const retryNotifier = new RecordingNotifier();
    await drainRows(prisma, retryNotifier, [id], new Date(NOW.getTime() + 60_000));
    const retried = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id } });
    expect(retried.sentAt).not.toBeNull();
    expect(retryNotifier.calls).toHaveLength(1);
  });

  it('AC — a rolled-back writing transaction leaves no outbox row', async () => {
    const seId = randomUUID();
    let idInsideTx: bigint | null = null;
    await expect(
      prisma.$transaction(async (tx) => {
        idInsideTx = await queueDayPlanDispatched(tx, event(seId));
        throw new Error('simulated rollback');
      }),
    ).rejects.toThrow('simulated rollback');

    expect(idInsideTx).not.toBeNull();
    const row = await prisma.dayPlanNotificationOutbox.findUnique({ where: { id: idInsideTx! } });
    expect(row).toBeNull();
  });

  it('AC — a duplicate drain (two racers on the same unsent row) delivers exactly once', async () => {
    const seId = randomUUID();
    const id = await queueDayPlanDispatched(prisma, event(seId));
    rowIds.push(id);

    const notifierA = new RecordingNotifier();
    const notifierB = new RecordingNotifier();
    // Both "racers" read the same unsent row and attempt to drain it concurrently.
    await Promise.all([drainRows(prisma, notifierA, [id], NOW), drainRows(prisma, notifierB, [id], NOW)]);

    const totalDeliveries = notifierA.calls.length + notifierB.calls.length;
    expect(totalDeliveries).toBe(1);
    const row = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.sentAt).not.toBeNull();
  });

  it('AC — dayPlanOverridden intents drain through the same mechanism', async () => {
    const seId = randomUUID();
    const id = await queueDayPlanOverridden(prisma, {
      seId,
      scheduleId: BigInt(1),
      batchId: BigInt(2),
      action: 'REMOVE_TICKET',
    });
    rowIds.push(id);

    const notifier = new RecordingNotifier();
    await drainRows(prisma, notifier, [id], NOW);
    expect(notifier.calls).toEqual([{ type: 'overridden', seId }]);
  });

  it('an exhausted row (>= MAX_OUTBOX_ATTEMPTS) is excluded from the sweep and stays visible via lastError', async () => {
    const seId = randomUUID();
    const id = await queueDayPlanDispatched(prisma, event(seId));
    rowIds.push(id);
    await prisma.dayPlanNotificationOutbox.update({ where: { id }, data: { attempts: 5, lastError: 'exhausted' } });

    const notifier = new RecordingNotifier();
    await drainUnsent(prisma, notifier, NOW);
    expect(notifier.calls.filter((c) => c.seId === seId)).toHaveLength(0);

    const row = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.sentAt).toBeNull();
    expect(row.lastError).toBe('exhausted');
  });

  it('pruneSentDayPlanOutbox removes only sent rows past the retention window', async () => {
    const seId = randomUUID();
    const id = await queueDayPlanDispatched(prisma, event(seId));
    const old = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000);
    await prisma.dayPlanNotificationOutbox.update({ where: { id }, data: { sentAt: old, createdAt: old } });

    const recentSeId = randomUUID();
    const recentId = await queueDayPlanDispatched(prisma, event(recentSeId));
    rowIds.push(recentId);
    await prisma.dayPlanNotificationOutbox.update({ where: { id: recentId }, data: { sentAt: NOW } });

    const count = await pruneSentDayPlanOutbox(prisma, NOW);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(await prisma.dayPlanNotificationOutbox.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.dayPlanNotificationOutbox.findUnique({ where: { id: recentId } })).not.toBeNull();
  });

  /**
   * #360 AC3 — the notice's nouns are resolved at ENQUEUE, inside the producing transaction, not at
   * drain time and not at the seven call sites.
   *
   * Enqueue-time, because #345 already established that the row must say what the plant was called
   * *when the plan changed* — a rename between the enqueue and the drain would otherwise rewrite
   * history in the notice the engineer finally reads. Here rather than at the producers, because
   * every one of them already passes the `batchId`, and the plant is one indexed read away from it:
   * pushing the lookup into seven `override.service` call sites would have been seven chances to
   * forget it, on a payload whose whole job is to be complete.
   */
  describe('#360 — the override row resolves its own nouns at enqueue', () => {
    const NS = Date.now();
    let zoneId: bigint;
    let companyId: bigint;
    let plantId: bigint;
    let scheduleId: bigint;
    let batchId: bigint;
    let ticketId: string;
    let ticketNo: bigint;
    let engineerId: string;
    const deviceId = String(9_910_000_000 + (NS % 100_000));

    beforeAll(async () => {
      zoneId = (await prisma.zone.create({ data: { name: 'Z-dpo-' + NS } })).zoneId;
      companyId = (await prisma.company.create({ data: { name: 'Co-dpo-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
      plantId = (await prisma.plant.create({ data: { name: 'Sanand Yard ' + NS, zoneId } })).plantId;
      await prisma.device.create({ data: { deviceId } });
      // `tickets_troubleshoot_requires_cycle` — a TROUBLESHOOT ticket has to own a failure cycle.
      const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
      const ticket = await prisma.ticket.create({
        data: {
          workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId,
          companyTier: 'GOLD', lastStateChangedAt: NOW,
        },
      });
      ticketId = ticket.ticketId;
      ticketNo = ticket.ticketNo;
      const tag = randomUUID().slice(0, 8);
      const u = await prisma.user.create({
        data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'dpo-' + tag, email: `dpo-${tag}@dpo.test`, zoneId },
      });
      engineerId = u.userId;
      await prisma.engineerMaster.create({ data: { engineerId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
      const schedule = await prisma.workSchedule.create({
        data: { seId: engineerId, zoneId, dateFrom: NOW, dateTo: NOW, dispatchedAt: NOW },
      });
      scheduleId = schedule.scheduleId;
      batchId = (
        await prisma.plantBatchAssignment.create({
          data: { scheduleId, plantId, seId: engineerId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
        })
      ).batchId;
    });

    afterAll(async () => {
      await prisma.plantBatchAssignment.deleteMany({ where: { batchId } });
      await prisma.workSchedule.deleteMany({ where: { scheduleId } });
      await prisma.ticket.deleteMany({ where: { ticketId } });
      await prisma.failureCycle.deleteMany({ where: { deviceId } });
      await prisma.device.deleteMany({ where: { deviceId } });
      await prisma.engineerMaster.deleteMany({ where: { engineerId } });
      await prisma.user.deleteMany({ where: { userId: engineerId } });
      await prisma.plant.deleteMany({ where: { plantId } });
      await prisma.company.deleteMany({ where: { companyId } });
      await prisma.zone.deleteMany({ where: { zoneId } });
    });

    it('resolves plantName from the batch and the ticket label from ticketId, and the drained event carries both', async () => {
      const seId = randomUUID();
      const id = await queueDayPlanOverridden(prisma, { seId, scheduleId, batchId, action: 'REMOVE_TICKET', ticketId });
      rowIds.push(id);

      const row = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id } });
      const payload = row.payload as { plantName: string | null; ticketNoDisplay: string | null };
      expect(payload.plantName).toBe('Sanand Yard ' + NS);
      expect(payload.ticketNoDisplay).toBe(`TCK-${String(ticketNo).padStart(5, '0')}`);

      const seen: Array<{ plantName?: string | null; ticketNoDisplay?: string | null }> = [];
      const notifier: DayPlanNotifier = {
        dayPlanDispatched: () => undefined,
        dayPlanOverridden: (e) => {
          seen.push({ plantName: e.plantName, ticketNoDisplay: e.ticketNoDisplay });
        },
      };
      await drainRows(prisma, notifier, [id], NOW);
      expect(seen).toEqual([{ plantName: 'Sanand Yard ' + NS, ticketNoDisplay: `TCK-${String(ticketNo).padStart(5, '0')}` }]);
    });

    it('an explicit plantName from the producer wins over the batch lookup (#345 PLANT_DEACTIVATED)', async () => {
      const seId = randomUUID();
      const id = await queueDayPlanOverridden(prisma, {
        seId, scheduleId, batchId, action: 'PLANT_DEACTIVATED', plantName: 'Named By Producer',
      });
      rowIds.push(id);
      const row = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id } });
      expect((row.payload as { plantName: string | null }).plantName).toBe('Named By Producer');
    });

    it('a batch that no longer exists enqueues a nameless row rather than throwing into the producer transaction', async () => {
      const seId = randomUUID();
      const id = await queueDayPlanOverridden(prisma, { seId, scheduleId, batchId: 987_654_321n, action: 'REORDER' });
      rowIds.push(id);
      const row = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id } });
      expect((row.payload as { plantName: string | null }).plantName).toBeNull();
    });
  });
});
