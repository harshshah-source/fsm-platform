import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { InstallLifecycleService, INSTALL_ACTIVATION_WINDOW_MS } from '../src/ticketing/install-lifecycle.service';
import type { InstallNotifier } from '../src/ticketing/install-notifier';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  INSTALL_FAILED_ACTIVATION_EVENT_TYPE,
  INSTALL_VERIFIED_EVENT_TYPE,
  drainRows,
} from '../src/scheduling/day-plan-notification-outbox';
import { EnqueueFailed, failingNotifyEnqueue, inertDayPlanNotifier } from './fixtures/outbox-crash-injection';

/**
 * Issue 34 — install auto-verification sweep (AC#3, AC#4, AC#6). A re-entrant scan of ACTIVATED
 * INSTALL tickets watches the new `device_id`'s pings after `activated_at`. The FIRST valid ping
 * closes the Ticket (CLOSED) and fires the "installation verified" push — with NO geofence (no prior
 * location is known, LLD open item #5). If no valid ping arrives within the activation window the
 * Ticket goes FAILED_ACTIVATION with a push so the SE can return or escalate.
 */
const NS = Date.now();
const T_ACT = new Date(Date.UTC(2026, 5, 26, 8, 0, 0)); // activation time

describe('Issue 34 — InstallLifecycleService.runInstallVerification', () => {
  let prisma: PrismaService;
  let service: InstallLifecycleService;

  const verified: string[] = [];
  const failed: string[] = [];
  const spyNotifier: InstallNotifier = {
    installVerified: (e) => { verified.push(e.ticketId); },
    failedActivation: (e) => { failed.push(e.ticketId); },
  };

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let snapshotRunId: bigint;
  const watermarkRunIds: bigint[] = [];
  let deviceSeq = 9_342_000n;
  const createdTicketIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new InstallLifecycleService(prisma, new AuditService(prisma), spyNotifier);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-iv-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-iv-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-iv-' + NS, zoneId } })).plantId;
    snapshotRunId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS', startedAt: T_ACT } })).runId;
  });

  afterAll(async () => {
    await prisma.rawDeviceSnapshot.deleteMany({ where: { runId: snapshotRunId } });
    await prisma.snapshotRun.deleteMany({ where: { runId: { in: [snapshotRunId, ...watermarkRunIds] } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: createdTicketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { gte: '9342000', lt: '9343000' } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /** An ACTIVATED install ticket whose device is freshly fitted (verification anchor = T_ACT). */
  const makeActivated = async (): Promise<{ ticketId: string; deviceId: string }> => {
    const deviceId = String(deviceSeq++);
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'INSTALL', status: 'ACTIVATED', deviceId, plantId, companyId, companyTier: 'GOLD',
        assignedSeId: randomUUID(), installTriggerSource: 'MANUAL_OPERATIONS',
        fittedGpsSerial: String(deviceId), fittedSimSerial: 'SIM-IV', fittedAt: T_ACT, activatedAt: T_ACT,
        lastStateChangedAt: T_ACT,
      },
    });
    createdTicketIds.push(t.ticketId);
    return { ticketId: t.ticketId, deviceId };
  };

  const ping = (deviceId: string, at: Date, lat = 0, lon = 0): Promise<unknown> =>
    prisma.rawDeviceSnapshot.create({ data: { runId: snapshotRunId, deviceId, gpsDatetime: at, lat, lon } });

  it('first valid post-fitment ping → Ticket CLOSED + verified push (no geofence)', async () => {
    const { ticketId, deviceId } = await makeActivated();
    // A ping AFTER activation, far from any anchor (lat/lon arbitrary) — no geofence applies.
    await ping(deviceId, new Date(T_ACT.getTime() + 30 * 60_000), 72.9, 19.1);

    const res = await service.runInstallVerification(new Date(T_ACT.getTime() + 60 * 60_000), { ticketIds: [ticketId] });
    expect(res.verified).toBe(1);

    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(t.status).toBe('CLOSED');
    expect(t.closedAt).not.toBeNull();
    const ev = await prisma.ticketEvent.findFirst({ where: { ticketId, toState: 'CLOSED' } });
    expect(ev?.fromState).toBe('ACTIVATED');
    expect(verified).toContain(ticketId);
  });

  it('no ping yet, still inside the activation window → stays ACTIVATED (pending)', async () => {
    const { ticketId } = await makeActivated();
    const res = await service.runInstallVerification(new Date(T_ACT.getTime() + 60 * 60_000), { ticketIds: [ticketId] });
    expect(res.pending).toBe(1);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('ACTIVATED');
  });

  it('a ping recorded BEFORE activation does not count as a valid post-fitment ping', async () => {
    const { ticketId, deviceId } = await makeActivated();
    await ping(deviceId, new Date(T_ACT.getTime() - 60 * 60_000)); // before activation
    const res = await service.runInstallVerification(new Date(T_ACT.getTime() + 60 * 60_000), { ticketIds: [ticketId] });
    expect(res.pending).toBe(1);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('ACTIVATED');
  });

  /**
   * #148 — make the newest `data_as_of` in the table the telemetry watermark the sweep reads.
   * Registered for cleanup alongside the fixture's own snapshot run.
   */
  const setWatermark = async (dataAsOf: Date) => {
    const run = await prisma.snapshotRun.create({ data: { status: 'SUCCESS', startedAt: T_ACT, dataAsOf } });
    watermarkRunIds.push(run.runId);
  };

  it('no ping within the activation window → FAILED_ACTIVATION + push', async () => {
    const { ticketId } = await makeActivated();
    const past = new Date(T_ACT.getTime() + INSTALL_ACTIVATION_WINDOW_MS + 60_000);
    // #148: expiry now also requires telemetry to have advanced past activation. This test has always
    // meant "telemetry is flowing and the device still did not ping" — stated explicitly rather than
    // inherited from whatever watermark other specs left in the shared database.
    await setWatermark(new Date(T_ACT.getTime() + INSTALL_ACTIVATION_WINDOW_MS + 2 * 60 * 60_000));
    const res = await service.runInstallVerification(past, { ticketIds: [ticketId] });
    expect(res.failed).toBe(1);
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(t.status).toBe('FAILED_ACTIVATION');
    const ev = await prisma.ticketEvent.findFirst({ where: { ticketId, toState: 'FAILED_ACTIVATION' } });
    expect(ev?.fromState).toBe('ACTIVATED');
    expect(failed).toContain(ticketId);
  });

  it('a late ping still verifies even past the window (a real device that came up late)', async () => {
    const { ticketId, deviceId } = await makeActivated();
    const lateNow = new Date(T_ACT.getTime() + INSTALL_ACTIVATION_WINDOW_MS + 2 * 60 * 60_000);
    await ping(deviceId, new Date(T_ACT.getTime() + INSTALL_ACTIVATION_WINDOW_MS + 60 * 60_000));
    const res = await service.runInstallVerification(lateNow, { ticketIds: [ticketId] });
    expect(res.verified).toBe(1);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('CLOSED');
  });

  /**
   * #148 slice 2 — the install half of the staleness precondition, mirroring
   * `verification-staleness.e2e-spec.ts`. The install sweep resolves the same 24 h window against the
   * same `raw_device_snapshots`, so it carries the same defect: with ingestion paused, a device that
   * was fitted and activated perfectly ages into FAILED_ACTIVATION because no ping *could* be written.
   *
   * The case above ("no ping within the activation window") pins the fresh-telemetry behaviour and
   * must keep passing; this one is the new branch.
   */
  it('#148 — does NOT fail activation while the telemetry watermark is behind activation', async () => {
    const { ticketId } = await makeActivated();
    // Ingestion stopped an hour BEFORE the device was activated: no ping could have been recorded,
    // so 25 h of wall-clock is not evidence the install failed.
    await setWatermark(new Date(T_ACT.getTime() - 60 * 60_000));
    const past = new Date(T_ACT.getTime() + INSTALL_ACTIVATION_WINDOW_MS + 60_000);

    const res = await service.runInstallVerification(past, { ticketIds: [ticketId] });

    expect(res.failed).toBe(0);
    expect(res.pending).toBe(1);
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(t.status).toBe('ACTIVATED');
    expect(failed).not.toContain(ticketId);
  });

  /**
   * #338 — the install pushes are durable, and they commit with the state change they announce.
   *
   * Both fired *after* `closeVerified`/`failActivation` had committed, with nothing behind them: a
   * crash in the gap closed a ticket and told the engineer nothing, and a throwing port abandoned the
   * rest of the sweep's ACTIVATED tickets. The row now goes into the same transaction as the closure.
   *
   * The event goes into the row and the drain hands it to `InstallNotifier` — the port keeps its job.
   * That is the #264 shape (`DayPlanNotifier` has always been fed this way) and it is why the spy
   * above still records both events: it is now called by the post-commit drain rather than directly.
   */
  describe('#338 — the install notices are outbox rows delivered through the port', () => {
    const dead = { installVerified: () => { throw new Error('injected: the install push failed'); },
      failedActivation: () => { throw new Error('injected: the install push failed'); } } satisfies InstallNotifier;

    const rowsOfType = async (eventType: string, ticketId: string) => {
      const rows = await prisma.dayPlanNotificationOutbox.findMany({ where: { eventType }, orderBy: { id: 'asc' } });
      return rows.filter((r) => (r.payload as { ticketId?: string } | null)?.ticketId === ticketId);
    };

    it('a port that throws leaves the ticket CLOSED and the verified push retryable', async () => {
      const service = new InstallLifecycleService(prisma, new AuditService(prisma), dead);
      const { ticketId, deviceId } = await makeActivated();
      await ping(deviceId, new Date(T_ACT.getTime() + 30 * 60_000));

      const res = await service.runInstallVerification(new Date(T_ACT.getTime() + 60 * 60_000), { ticketIds: [ticketId] });
      expect(res.verified).toBe(1);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('CLOSED');

      const rows = await rowsOfType(INSTALL_VERIFIED_EVENT_TYPE, ticketId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.sentAt).toBeNull();
      expect(row.lastError).toMatch(/injected/);
      expect(verified).not.toContain(ticketId);

      // The sweep's drain carries the real port: one delivery, and draining again does not repeat it.
      await drainRows(prisma, inertDayPlanNotifier, [row.id], new Date(), { install: spyNotifier });
      expect(verified.filter((t) => t === ticketId)).toHaveLength(1);
      await drainRows(prisma, inertDayPlanNotifier, [row.id], new Date(), { install: spyNotifier });
      expect(verified.filter((t) => t === ticketId)).toHaveLength(1);
      await prisma.dayPlanNotificationOutbox.deleteMany({ where: { id: row.id } });
    });

    it('a failed enqueue rolls the closure back — no ticket closed without its notice', async () => {
      const service = new InstallLifecycleService(failingNotifyEnqueue(prisma), new AuditService(prisma), spyNotifier);
      const { ticketId, deviceId } = await makeActivated();
      await ping(deviceId, new Date(T_ACT.getTime() + 30 * 60_000));

      await expect(
        service.runInstallVerification(new Date(T_ACT.getTime() + 60 * 60_000), { ticketIds: [ticketId] }),
      ).rejects.toThrow(EnqueueFailed);

      const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      expect(t.status).toBe('ACTIVATED');
      expect(t.closedAt).toBeNull();
      expect(await prisma.ticketEvent.count({ where: { ticketId, toState: 'CLOSED' } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { entityId: ticketId, action: 'INSTALL_VERIFIED' } })).toBe(0);
      expect(await rowsOfType(INSTALL_VERIFIED_EVENT_TYPE, ticketId)).toHaveLength(0);
    });

    it('the FAILED_ACTIVATION notice is written in the same transaction as the failure', async () => {
      const service = new InstallLifecycleService(failingNotifyEnqueue(prisma), new AuditService(prisma), spyNotifier);
      const { ticketId } = await makeActivated();
      await setWatermark(new Date(T_ACT.getTime() + INSTALL_ACTIVATION_WINDOW_MS + 2 * 60 * 60_000));
      const past = new Date(T_ACT.getTime() + INSTALL_ACTIVATION_WINDOW_MS + 60_000);

      await expect(service.runInstallVerification(past, { ticketIds: [ticketId] })).rejects.toThrow(EnqueueFailed);

      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('ACTIVATED');
      expect(await rowsOfType(INSTALL_FAILED_ACTIVATION_EVENT_TYPE, ticketId)).toHaveLength(0);
      expect(failed).not.toContain(ticketId);
    });
  });
});
