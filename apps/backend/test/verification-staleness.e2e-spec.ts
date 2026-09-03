import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeCoverageService } from '../src/shared-pool/se-coverage.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';
import { VerificationService } from '../src/verification/verification.service';

/**
 * #148 — a verification window must not expire on STALE telemetry.
 *
 * The sweep runs every 5 minutes (`BUSINESS_SWEEPS_ENABLED="true"` in `.env:41`) and expires its
 * 24-hour window on wall-clock alone, while `INGESTION_SCHEDULER_ENABLED="false"` means nothing
 * automatically writes the `raw_device_snapshots` it reads. A submission made during an ingestion
 * pause therefore ages into an IRREVERSIBLE `FAILED_VERIFICATION` — with its `PRE_VERIFICATION`
 * inventory rolled back — regardless of whether the SE actually fixed the device.
 *
 * The precondition: expire only once the telemetry watermark (`snapshot_runs.data_as_of`) has
 * advanced past the submission. Strictly more conservative — it can only ever DELAY a failure
 * verdict, never cause one — and it needs no ops discipline to be correct.
 *
 * TWO OF THE THREE CASES BELOW PIN EXISTING BEHAVIOUR and must pass before any source change. If (b)
 * or (c) ever fails, the harness is wrong and must be fixed before touching the service.
 *
 * The watermark is global (latest `snapshot_runs` row with a non-null `data_as_of`), so every case
 * sets it explicitly via `setWatermark`. The pre-#148 suite depended on whatever ambient value other
 * specs happened to leave behind; making it explicit is what keeps these tests deterministic in
 * isolation as well as in a full run.
 */
const NS = Date.now();
const T0 = new Date('2026-06-23T06:00:00Z');
const HOURS = (h: number) => new Date(T0.getTime() + h * 60 * 60_000);
const ANCHOR = { lat: 12.9716, lon: 77.5946 };

describe('#148 — verification does not expire on stale telemetry', () => {
  let prisma: PrismaService;
  let verify: VerificationService;
  let submit: TroubleshootSubmissionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const watermarkRunIds: bigint[] = [];

  /** Make `data_as_of` the newest watermark in the table — the value the precondition reads. */
  const setWatermark = async (dataAsOf: Date) => {
    const run = await prisma.snapshotRun.create({
      data: { status: 'SUCCESS', startedAt: T0, dataAsOf },
    });
    watermarkRunIds.push(run.runId);
    return run.runId;
  };

  const makeTicket = async (): Promise<{ ticketId: string; deviceId: string }> => {
    const deviceId = String(11_480_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    return { ticketId: ticket.ticketId, deviceId };
  };

  /** Submit with no pings ever arriving — the only thing under test is WHEN that becomes a failure. */
  const submitForm = (ticketId: string) =>
    submit.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'POWER_ISSUE',
      seGps: ANCHOR,
      presenceSource: 'FORM_GPS',
      actor: { userId: se, role: 'SERVICE_ENGINEER' },
      now: T0,
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    verify = new VerificationService(prisma);
    submit = new TroubleshootSubmissionService(prisma, new SeCoverageService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-vs-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-vs-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vs-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@vs.test`, zoneId },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });
  });

  afterAll(async () => {
    await prisma.seCoverage.deleteMany({ where: { seId: se } });
    await prisma.verificationRun.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.snapshotRun.deleteMany({ where: { runId: { in: watermarkRunIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  // (a) THE NEW BEHAVIOUR — fails before #148.
  it('does NOT expire while the telemetry watermark is behind the submission', async () => {
    const { ticketId } = await makeTicket();
    await submitForm(ticketId);
    // Ingestion paused an hour before the SE submitted: no ping could possibly have been recorded,
    // so 25 h of wall-clock proves nothing about whether the device recovered.
    await setWatermark(HOURS(-1));

    const res = await verify.runVerification(HOURS(25), { ticketIds: [ticketId] });

    expect(res.failed).toBe(0);
    expect(res.pending).toBe(1);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('VERIFICATION_PENDING');
  });

  // (b) PINS EXISTING BEHAVIOUR — must pass before the source change.
  it('DOES expire at 25 h when the watermark has advanced past the submission', async () => {
    const { ticketId } = await makeTicket();
    await submitForm(ticketId);
    // Telemetry is flowing and current — 25 h of silence from this device is real evidence.
    await setWatermark(HOURS(26));

    const res = await verify.runVerification(HOURS(25), { ticketIds: [ticketId] });

    expect(res.failed).toBe(1);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('FAILED_VERIFICATION');
  });

  /**
   * #357 — the expired window is exactly where the two ledgers used to part company. Once the sweep
   * has written FAILED_VERIFICATION, a ZM who judges the device recovered anyway moves the TICKET to
   * CLOSED_AUTO_RECOVERY; the run's stamp was skipped (`outcome: null` in the WHERE), so the platform
   * kept two permanent, contradictory records of the same event — and the outcomes report published
   * the failure. This case starts from the real FAILED state case (b) produces rather than a seeded
   * one, because "auto-recovery after an expiry" is the only way that contradiction arises.
   */
  it('#357 — auto-recovery after an expired window leaves the run and the ticket agreeing', async () => {
    const { ticketId } = await makeTicket();
    await submitForm(ticketId);
    await setWatermark(HOURS(26));
    expect((await verify.runVerification(HOURS(25), { ticketIds: [ticketId] })).failed).toBe(1);
    expect((await prisma.verificationRun.findFirstOrThrow({ where: { ticketId } })).outcome).toBe(
      'FAILED_VERIFICATION',
    );

    const outcome = await verify.markAutoRecovery(
      ticketId,
      'device came back on its own after the window closed',
      { userId: randomUUID(), role: 'ZONAL_MANAGER' },
      { role: 'OPERATIONS_HEAD', zoneId: null },
    );

    expect(outcome).toBe('OK');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('CLOSED_AUTO_RECOVERY');
    expect((await prisma.verificationRun.findFirstOrThrow({ where: { ticketId } })).outcome).toBe(
      'CLOSED_AUTO_RECOVERY',
    );
  });

  // (c) PINS EXISTING BEHAVIOUR — the window itself is unchanged.
  it('does not expire before 24 h even with a fresh watermark', async () => {
    const { ticketId } = await makeTicket();
    await submitForm(ticketId);
    await setWatermark(HOURS(26));

    const res = await verify.runVerification(HOURS(23), { ticketIds: [ticketId] });

    expect(res.failed).toBe(0);
    expect(res.pending).toBe(1);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('VERIFICATION_PENDING');
  });

  // COLD START (no watermark at all) is deliberately NOT covered here. The watermark is global, so
  // asserting it would mean nulling `data_as_of` on every row in a database shared with the rest of
  // the suite — and a mid-test failure would leave that corruption behind for whatever runs next.
  // The service treats a null watermark as "telemetry has not advanced" (same branch as case (a), at
  // its limit): with no successful snapshot run ever recorded, no ping could have arrived, so
  // expiring would be exactly the wrong verdict. See the guard's docblock.
});
