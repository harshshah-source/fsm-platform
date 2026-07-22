import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { InstallLifecycleService, INSTALL_ACTIVATION_WINDOW_MS } from '../src/ticketing/install-lifecycle.service';
import type { InstallNotifier } from '../src/ticketing/install-notifier';
import { PrismaService } from '../src/prisma/prisma.service';

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
});
