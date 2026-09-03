import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideProjectionService } from '../src/scheduling/override-projection.service';
import { OverrideService } from '../src/scheduling/override.service';
import { PrismaSoftStateConflictPort } from '../src/soft-state/soft-state-conflict.adapter';

/**
 * #311 (forensics CB-4) — the preview reads the ON_SITE conflict source the commit gates on.
 *
 * `conflictsFor` hardcoded `onSite: []` on the premise that `soft_states` "does not exist yet". It
 * does: `PrismaSoftStateConflictPort` is implemented, bound in the same module, and
 * `OverrideService.override` gates on it. So the preview reported no conflict for a batch whose
 * engineer is standing at the plant, and the identical confirm body then came back
 * `CONFLICT_ON_SITE` — precisely the preview/commit drift the projection's own docblock calls
 * *"worse than no preview, because the operator would have trusted it"*.
 *
 * The parity is asserted by driving **both** paths over one fixture in one test, rather than by
 * asserting each against a list written here: a spec that spells the expected set twice can go on
 * agreeing with itself while the two code paths diverge, which is the failure mode under repair.
 */
const NS = Date.now();

describe('#311 — override preview and commit agree on ON_SITE', () => {
  let prisma: PrismaService;
  let projection: OverrideProjectionService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let fromSe: string;
  let toSe: string;
  let scheduleId: bigint;
  let batchId: bigint;
  let onSiteTicket: string;
  let quietTicket: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-25T06:00:00Z');
  const DAY = istDate(NOW);
  let scope: { role: string; zoneId: number };

  const makeSe = async (label: string): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: `SE ${label} ${tag}`, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@o311.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 20 },
    });
    return u.userId;
  };

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(11_200_000_000 + (NS % 100_000) * 100 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
        assignmentState: 'FORMALLY_ASSIGNED',
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    // The real port on BOTH services. The forensic A6 note is exactly this: both classes fall back to
    // `NoConflictSoftStatePort` when constructed without one, so a hand-built fixture that omits it
    // asserts the seam's silence rather than the behaviour.
    const conflict = new PrismaSoftStateConflictPort(prisma);
    projection = new OverrideProjectionService(prisma, conflict);
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier(), conflict);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-311-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-311-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-311-' + NS, zoneId } })).plantId;

    fromSe = await makeSe('from');
    toSe = await makeSe('to');
    onSiteTicket = await makeTicket();
    quietTicket = await makeTicket();

    scheduleId = (
      await prisma.workSchedule.create({
        data: { seId: fromSe, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'SYSTEM_GENERATED' },
      })
    ).scheduleId;
    batchId = (
      await prisma.plantBatchAssignment.create({
        data: { scheduleId, plantId, seId: fromSe, status: 'AUTO_ASSIGNED', stopSequence: 1 },
      })
    ).batchId;
    await prisma.batchAssignmentTicket.create({ data: { batchId, ticketId: onSiteTicket, sortOrder: 1, createdAt: NOW } });
    await prisma.batchAssignmentTicket.create({ data: { batchId, ticketId: quietTicket, sortOrder: 2, createdAt: NOW } });

    // The engineer is standing at the plant on ONE of the two tickets — unresolved, so it is live.
    await prisma.softState.create({
      data: { ticketId: onSiteTicket, seId: fromSe, type: 'ON_SITE', setAt: NOW },
    });
  });

  afterAll(async () => {
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId } });
    await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId } });
    await prisma.dayPlanNotificationOutbox.deleteMany({ where: { scheduleId } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [String(batchId), ...ticketIds] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC1 — the preview names exactly the tickets the confirm would refuse on', async () => {
    const cmd = { action: 'SWAP_SE' as const, newSeId: toSe, reasonCode: 'ZM_JUDGEMENT' };

    const preview = await projection.projectOverride(batchId, cmd, scope, NOW);
    const confirm = await override.override(batchId, cmd, scope, ZM, NOW);

    // The commit's own answer, unchanged by this slice — the gate has always worked.
    expect(confirm.result).toBe('CONFLICT_ON_SITE');
    if (confirm.result !== 'CONFLICT_ON_SITE') return;
    expect(confirm.ticketIds).toEqual([onSiteTicket]);

    expect(preview.result).toBe('OK');
    if (preview.result !== 'OK') return;
    // The parity itself. Before the fix this was `[]` while the confirm refused — the drift the
    // projection's docblock calls worse than no preview at all.
    expect([...preview.conflicts.onSite].sort()).toEqual([...confirm.ticketIds].sort());
    // …and it is the real set, not merely an equal one: the quiet ticket on the same batch is absent.
    expect(preview.conflicts.onSite).not.toContain(quietTicket);
  }, 30_000);

  it('a resolved soft state is not a conflict on either path', async () => {
    // The port's rule (VIEWED and resolved states do not count) has to reach the preview intact —
    // reading the same *table* would not be enough if the preview read it with its own predicate.
    await prisma.softState.updateMany({
      where: { ticketId: onSiteTicket, resolvedAt: null },
      data: { resolvedAt: NOW, resolutionReason: 'test' },
    });

    const cmd = { action: 'SWAP_SE' as const, newSeId: toSe, reasonCode: 'ZM_JUDGEMENT' };
    const preview = await projection.projectOverride(batchId, cmd, scope, NOW);

    expect(preview.result).toBe('OK');
    if (preview.result !== 'OK') return;
    expect(preview.conflicts.onSite).toEqual([]);

    // Put it back for any later case / a re-run of the file.
    await prisma.softState.updateMany({
      where: { ticketId: onSiteTicket },
      data: { resolvedAt: null, resolutionReason: null },
    });
  }, 30_000);

  it('AC2 — the preview still writes nothing, conflicts included', async () => {
    // #289's load-bearing property. Counting rows across every table a real move touches is the only
    // assertion worth making here, and reading a second table must not have cost it.
    const counts = async () => ({
      schedules: await prisma.workSchedule.count({ where: { zoneId } }),
      batches: await prisma.plantBatchAssignment.count({ where: { scheduleId } }),
      batchTickets: await prisma.batchAssignmentTicket.count({ where: { ticketId: { in: ticketIds } } }),
      softStates: await prisma.softState.count({ where: { ticketId: { in: ticketIds } } }),
      audits: await prisma.auditLog.count({ where: { entityId: String(batchId) } }),
      outbox: await prisma.dayPlanNotificationOutbox.count({ where: { scheduleId } }),
    });

    const before = await counts();
    await projection.projectOverride(
      batchId,
      { action: 'SWAP_SE', newSeId: toSe, reasonCode: 'ZM_JUDGEMENT' },
      scope,
      NOW,
    );
    expect(await counts()).toEqual(before);
  }, 30_000);
});
