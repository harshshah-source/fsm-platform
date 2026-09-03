import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { DeviceDepartureService } from '../src/device-departure/device-departure.service';
import { AppModule } from '../src/app.module';
import { ComponentRequestService } from '../src/component-request/component-request.service';
import { InventoryService } from '../src/inventory/inventory.service';
import type { NotifyInput } from '../src/notifications/notification.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PRD_NOTICE_TYPES, noticeDayKey, queueWarehouseNotice } from '../src/notifications/prd-event-notice';
import {
  PRD_EVENT_NOTICE_JOB_NAME,
  PrdEventNoticeService,
} from '../src/notifications/prd-event-notice.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { DAY_PLAN_NOTIFIER, SpineDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { INSTALL_NOTIFIER, SpineInstallNotifier } from '../src/ticketing/install-notifier';
import { RECOVERY_NOTIFIER, SpineRecoveryNotifier } from '../src/ticketing/recovery-notifier';
import { NotificationVoucherNotifier } from '../src/vouchers/notification-voucher-notifier';
import { VOUCHER_NOTIFIER } from '../src/vouchers/voucher-notifier';

/**
 * #76 adoption — proves the real app boots with the Spine*Notifier classes as the DI default for
 * each token, not just that the classes work in isolation (the `*-notifier-spine.e2e-spec.ts`
 * files prove the mapping logic; this proves the module wiring that puts them in the request path).
 *
 * **#361 extends it to the remaining PRD events**, and to the property that matters more than the
 * binding: that each of those events actually produces a notice, addressed to the role the PRD names.
 *
 * The reason both halves live in one file is that #361 closed a gap #76 could not see. A DI assertion
 * proves a *port is bound*; it cannot prove anybody calls it. `VOUCHER_NOTIFIER` was bound for a year
 * to a notifier that logged and told nobody, while the Voucher Review page said "the SE is notified" —
 * a binding assertion would have passed happily throughout. So every case below asserts the outbox
 * row: who it is addressed to, that there is exactly one of it, and — for the three condition-driven
 * events — that running the sweep a second time does not produce a second one.
 */
describe('#76 / #361 — notifier adoption + PRD event producers', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const NOW = new Date('2026-09-04T09:00:00Z');
  const NS = Date.now();

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let seId: string;
  let zmId: string;
  let wmId: string;
  let ohId: string;
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const createdUserIds: string[] = [];

  /** Every notice type this slice produces, so cleanup can be exhaustive without listing entities. */
  const ALL_TYPES = Object.values(PRD_NOTICE_TYPES);

  const noticesOfType = (type: string, entityId?: string) =>
    prisma.dayPlanNotificationOutbox.findMany({
      where: {
        eventType: 'NOTIFY',
        AND: [
          { payload: { path: ['type'], equals: type } },
          ...(entityId === undefined ? [] : [{ payload: { path: ['entityId'], equals: entityId } }]),
        ],
      },
      orderBy: { id: 'asc' },
    });

  const payloadOf = (row: { payload: unknown }) => row.payload as unknown as NotifyInput;

  async function makeUser(role: string, label: string): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        name: `${label} ${tag}`,
        role: role as never,
        phone: `${label}-${tag}`.slice(0, 18),
        email: `${label}-${tag}@n361.test`,
        zoneId,
      },
    });
    createdUserIds.push(user.userId);
    return user.userId;
  }

  /** A ticket at `plantId` on a fresh device — the entity most of these notices hang off. */
  async function makeTicket(): Promise<{ ticketId: string; deviceId: string; cycleId: string }> {
    const deviceId = String(12_600_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
      },
    });
    ticketIds.push(ticket.ticketId);
    return { ticketId: ticket.ticketId, deviceId, cycleId: cycle.cycleId };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-n361-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-n361-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-n361-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'kit-n361-' + NS } })).componentId;

    seId = await makeUser('SERVICE_ENGINEER', 'se');
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 8 } });
    zmId = await makeUser('ZONAL_MANAGER', 'zm');
    wmId = await makeUser('WAREHOUSE_MANAGER', 'wm');
    ohId = await makeUser('OPERATIONS_HEAD', 'oh');
    // The designated manager wins over role-holders (#356) — pinned so the ZM cases below assert an
    // exact recipient rather than "somebody in the zone".
    await prisma.zone.update({ where: { zoneId }, data: { zonalManagerUserId: zmId } });
  });

  afterAll(async () => {
    // Per type, not one `in` filter: Prisma's JSON path filters take `equals`, not `in`.
    for (const type of ALL_TYPES) {
      await prisma.dayPlanNotificationOutbox.deleteMany({
        where: { eventType: 'NOTIFY', payload: { path: ['type'], equals: type } },
      });
    }
    await prisma.notification.deleteMany({ where: { recipientUserId: { in: createdUserIds } } });
    await prisma.componentBlockedQueue.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ticketIds, ...deviceIds] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: seId } });
    await prisma.zone.update({ where: { zoneId }, data: { zonalManagerUserId: null } });
    await prisma.user.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  // ---- #76: the ports are bound -------------------------------------------------------------

  it('DAY_PLAN_NOTIFIER resolves to SpineDayPlanNotifier', () => {
    expect(app.get(DAY_PLAN_NOTIFIER)).toBeInstanceOf(SpineDayPlanNotifier);
  });

  it('RECOVERY_NOTIFIER resolves to SpineRecoveryNotifier', () => {
    expect(app.get(RECOVERY_NOTIFIER)).toBeInstanceOf(SpineRecoveryNotifier);
  });

  it('INSTALL_NOTIFIER resolves to SpineInstallNotifier', () => {
    expect(app.get(INSTALL_NOTIFIER)).toBeInstanceOf(SpineInstallNotifier);
  });

  /**
   * #361 — the binding this issue exists to change. `LoggingVoucherNotifier` is gone from the graph;
   * if it ever comes back the Voucher Review page's "the SE is notified" becomes false again.
   */
  it('VOUCHER_NOTIFIER resolves to NotificationVoucherNotifier, not a logging stub', () => {
    expect(app.get(VOUCHER_NOTIFIER)).toBeInstanceOf(NotificationVoucherNotifier);
  });

  /**
   * The two condition-driven events have no mutation to hang off, so a bound service that nothing ever
   * calls would be #229's exact failure — built, tested, and with no production caller for months.
   * Assert the tick is registered with the container's own scheduler registry.
   */
  it('the PRD-event sweep is a registered cron job, not an orphan service', () => {
    expect(app.get(PrdEventNoticeService)).toBeInstanceOf(PrdEventNoticeService);
    expect([...app.get(SchedulerRegistry).getCronJobs().keys()]).toContain(PRD_EVENT_NOTICE_JOB_NAME);
  });

  // ---- #361: one notice per event, to the role the PRD names ---------------------------------

  it('a Common-Kit short tells the ENGINEER, and only once a day however often dispatch runs', async () => {
    const { ticketId } = await makeTicket();
    const inventory = app.get(InventoryService);
    const missing = [{ componentId: String(componentId), name: 'kit-n361-' + NS, shortBy: 2 }];

    await inventory.recordComponentBlock(ticketId, seId, missing, undefined, NOW);
    // The recommender re-evaluates and REFRESHES this row on every run; without the dedup that is a
    // fresh push at every dispatch tick for as long as the van stays short.
    await inventory.recordComponentBlock(ticketId, seId, missing, undefined, NOW);

    const rows = await noticesOfType(PRD_NOTICE_TYPES.commonKitShort, ticketId);
    expect(rows).toHaveLength(1);
    const payload = payloadOf(rows[0]);
    expect(payload.recipients).toEqual([{ userId: seId, role: 'SERVICE_ENGINEER' }]);
    // Naming the shortfall is what makes it actionable rather than a nag.
    expect(payload.body).toContain('kit-n361-' + NS);
    expect((payload.metadata as Record<string, unknown>).noticeDay).toBe(noticeDayKey(NOW));

    // The block row itself still exists exactly once — the dedup suppresses the notice, not the work.
    expect(await prisma.componentBlockedQueue.count({ where: { ticketId, resolvedAt: null } })).toBe(1);
  });

  it('a component request raised by an SE tells the WAREHOUSE MANAGER', async () => {
    const { ticketId, cycleId } = await makeTicket();
    const submission = await prisma.troubleshootingSubmission.create({
      data: {
        ticketId,
        failureCycleId: cycleId,
        submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(),
        seId,
        presenceSource: 'NONE',
        componentUnavailable: true,
        componentUnavailableItem: componentId,
        rootCauseCategory: 'GPS_ANTENNA_ISSUE',
        submittedAt: NOW,
      },
    });
    // The raise's own notice is written by `TroubleshootSubmissionService`; this asserts the producer
    // contract it calls, on a request created the same way, so the case does not depend on driving a
    // whole form submission through its validation.
    const request = await prisma.componentRequest.create({
      data: { ticketId, failureCycleId: cycleId, submissionId: submission.submissionId, seId, componentId, status: 'REQUESTED' },
    });
    const notifications = app.get(NotificationService);
    await prisma.$transaction((tx) =>
      queueWarehouseNotice(tx, notifications, { requestId: request.requestId, ticketId, seId }),
    );

    const rows = await noticesOfType(PRD_NOTICE_TYPES.componentRequestRaised, request.requestId);
    expect(rows).toHaveLength(1);
    const recipients = payloadOf(rows[0]).recipients;
    // Every WM, because the warehouse queue is not zone-scoped — and no other role.
    expect(recipients.map((r) => r.role)).toEqual(recipients.map(() => 'WAREHOUSE_MANAGER'));
    expect(recipients.map((r) => r.userId)).toContain(wmId);
    expect(recipients.map((r) => r.userId)).not.toContain(seId);
  });

  it('a component request waiting over 7 days tells the ZM — once, however often the sweep runs', async () => {
    const { ticketId, cycleId } = await makeTicket();
    const submission = await prisma.troubleshootingSubmission.create({
      data: {
        ticketId,
        failureCycleId: cycleId,
        submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(),
        seId,
        presenceSource: 'NONE',
        componentUnavailable: true,
        // `ts_submissions_component_unavailable_item` — a submission that claims a component was
        // unavailable has to say which one.
        componentUnavailableItem: componentId,
        rootCauseCategory: 'GPS_ANTENNA_ISSUE',
        submittedAt: NOW,
      },
    });
    await prisma.componentRequest.create({
      data: {
        ticketId,
        failureCycleId: cycleId,
        submissionId: submission.submissionId,
        seId,
        componentId,
        status: 'REQUESTED',
        // Nine days old: nothing happens on day seven, which is why only a clock can find this.
        createdAt: new Date(NOW.getTime() - 9 * 24 * 60 * 60 * 1000),
      },
    });

    const svc = app.get(ComponentRequestService);
    const first = await svc.sweepWaitingComponentEscalations(NOW);
    await svc.sweepWaitingComponentEscalations(NOW);
    expect(first.notified).toBeGreaterThanOrEqual(1);

    // AC3 — a double sweep yields ONE notice. Asserted on this zone's row count rather than on the
    // sweep's global tally: the sweep is DB-wide and other spec files share this database, so a tally
    // of zero would be a claim about their fixtures as well as ours.
    const rows = await noticesOfType(PRD_NOTICE_TYPES.componentRequestOverdue, String(zoneId));
    expect(rows).toHaveLength(1);
    const payload = payloadOf(rows[0]);
    expect(payload.recipients).toEqual([{ userId: zmId, role: 'ZONAL_MANAGER' }]);
    // One notice per zone, not per request: the ZM has one job to do about all of them.
    expect(payload.body).toContain('9 days');
  });

  it('a departure auto-close tells the ZM, once, naming the count', async () => {
    const { ticketId, deviceId } = await makeTicket();
    const departures = app.get(DeviceDepartureService);
    const out = await departures.reconcile({
      observed: new Map([[deviceId, 'UNDEPLOYED']]),
      syncedPlantIds: [plantId],
      now: NOW,
    });
    expect(out.departed).toBe(1);
    expect(out.cancelledTickets).toBe(1);

    const rows = await noticesOfType(PRD_NOTICE_TYPES.deviceDepartureAutoClose, String(zoneId));
    expect(rows).toHaveLength(1);
    const payload = payloadOf(rows[0]);
    expect(payload.recipients).toEqual([{ userId: zmId, role: 'ZONAL_MANAGER' }]);
    expect((payload.metadata as { ticketIds: string[] }).ticketIds).toContain(ticketId);

    // A second reconcile over the same read closes nothing, so it enqueues nothing — this event needs
    // no dedup because it is driven by a mutation, not by a condition that persists.
    await departures.reconcile({ observed: new Map([[deviceId, 'UNDEPLOYED']]), syncedPlantIds: [plantId], now: NOW });
    expect(await noticesOfType(PRD_NOTICE_TYPES.deviceDepartureAutoClose, String(zoneId))).toHaveLength(1);
  });

  it('a wedged ingestion pipeline tells the OPERATIONS HEAD — once a day, not once a tick', async () => {
    const sweep = app.get(PrdEventNoticeService);
    // Three consecutive FAILED runs, newest last: past `DEFAULT_INGESTION_STREAK_THRESHOLD`.
    const runIds: bigint[] = [];
    for (let i = 3; i >= 1; i--) {
      const run = await prisma.snapshotRun.create({
        data: {
          status: 'FAILED',
          startedAt: new Date(NOW.getTime() - i * 30 * 60 * 1000),
          finishedAt: new Date(NOW.getTime() - i * 30 * 60 * 1000 + 60_000),
        },
      });
      runIds.push(run.runId);
    }
    try {
      const first = await sweep.sweepIngestionAlerts(NOW);
      const second = await sweep.sweepIngestionAlerts(NOW);
      expect(first.notified).toBeGreaterThanOrEqual(1);
      // AC3, and the reason it matters most here: this tick runs hourly and an outage lasts hours. A
      // fresh push every hour is how an Operations Head learns to mute the channel.
      expect(second.notified).toBe(0);

      const rows = await noticesOfType(PRD_NOTICE_TYPES.ingestionSnapshotFailed, 'telemetry');
      expect(rows).toHaveLength(1);
      const recipients = payloadOf(rows[0]).recipients;
      expect(recipients.map((r) => r.role)).toEqual(recipients.map(() => 'OPERATIONS_HEAD'));
      expect(recipients.map((r) => r.userId)).toContain(ohId);
    } finally {
      await prisma.snapshotRun.deleteMany({ where: { runId: { in: runIds } } });
    }
  });
});
