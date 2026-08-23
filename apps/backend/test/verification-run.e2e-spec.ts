import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeCoverageService } from '../src/shared-pool/se-coverage.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';
import { VerificationService } from '../src/verification/verification.service';

/**
 * Issue 18, slice 3 — VerificationWorker orchestration. A submitted ticket whose device resumes pinging
 * near the SE anchor through the 1 h window auto-closes (cycle VERIFIED); a far Phase-1 ping is
 * fraud-flagged with the distance delta and FAILED_VERIFICATION; 1–2 pings stay VERIFICATION_PENDING
 * with the partial-recovery ping count; presence=NONE skips the geo-check (no fraud).
 */
const NS = Date.now();
const T0 = new Date('2026-06-23T06:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const ANCHOR = { lat: 12.9716, lon: 77.5946 };
const NEAR = { lat: 12.9721, lon: 77.5946 };
const FAR = { lat: 13.4716, lon: 77.5946 };

describe('Issue 18 slice 3 — verification run', () => {
  let prisma: PrismaService;
  let verify: VerificationService;
  let submit: TroubleshootSubmissionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let snapshotRunId: bigint;
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const actor = () => ({ userId: se, role: 'SERVICE_ENGINEER' });

  const makeTicket = async (): Promise<{ ticketId: string; deviceId: string; cycleId: string }> => {
    const deviceId = String(11_600_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

  const addPing = async (deviceId: string, time: Date, loc: { lat: number; lon: number }) => {
    await prisma.rawDeviceSnapshot.create({
      data: { runId: snapshotRunId, deviceId, gpsDatetime: time, lat: loc.lat, lon: loc.lon },
    });
  };

  const submitForm = async (ticketId: string, presence: 'FORM_GPS' | 'NONE') =>
    submit.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'POWER_ISSUE',
      seGps: presence === 'FORM_GPS' ? { lat: ANCHOR.lat, lon: ANCHOR.lon } : undefined,
      presenceSource: presence,
      actor: actor(),
      now: T0,
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    verify = new VerificationService(prisma);
    submit = new TroubleshootSubmissionService(prisma, new SeCoverageService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-vr-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-vr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vr-' + NS, zoneId } })).plantId;
    snapshotRunId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS', startedAt: T0 } })).runId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@vr.test`, zoneId },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });
  });

  afterAll(async () => {
    await prisma.seCoverage.deleteMany({ where: { seId: se } });
    await prisma.verificationRun.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.rawDeviceSnapshot.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.vehicleUnavailabilityReport.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    const cycleIds = await prisma.failureCycle.findMany({ where: { deviceId: { in: deviceIds } }, select: { cycleId: true } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'failure_cycles', entityId: { in: cycleIds.map((c) => c.cycleId) } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.snapshotRun.deleteMany({ where: { runId: snapshotRunId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('auto-closes a ticket whose device pings near the anchor through the 1 h window', async () => {
    const { ticketId, deviceId, cycleId } = await makeTicket();
    await submitForm(ticketId, 'FORM_GPS');
    for (const m of [1, 20, 45, 65]) await addPing(deviceId, at(m), NEAR);

    const res = await verify.runVerification(at(70), { ticketIds: [ticketId] });
    expect(res.closed).toBe(1);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('CLOSED');
    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.state).toBe('VERIFIED');
    const run = await prisma.verificationRun.findFirstOrThrow({ where: { ticketId } });
    expect(run.outcome).toBe('CLOSED');
    expect(run.fraudFlag).toBe(false);
  });

  it('fraud-flags a far Phase-1 ping and records the distance delta', async () => {
    const { ticketId, deviceId } = await makeTicket();
    await submitForm(ticketId, 'FORM_GPS');
    for (const m of [1, 8, 16]) await addPing(deviceId, at(m), FAR);

    const res = await verify.runVerification(at(70), { ticketIds: [ticketId] });
    expect(res.fraud).toBe(1);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('FAILED_VERIFICATION');
    const run = await prisma.verificationRun.findFirstOrThrow({ where: { ticketId } });
    expect(run.fraudFlag).toBe(true);
    expect(Number(run.firstPingDistanceMeters)).toBeGreaterThan(500);
    expect(run.outcome).toBe('FAILED_VERIFICATION');
  });

  it('keeps a 1–2 ping ticket in VERIFICATION_PENDING with the partial-recovery ping count', async () => {
    const { ticketId, deviceId } = await makeTicket();
    await submitForm(ticketId, 'FORM_GPS');
    await addPing(deviceId, at(5), NEAR); // a single ping

    const res = await verify.runVerification(at(30), { ticketIds: [ticketId] });
    expect(res.pending).toBe(1);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('VERIFICATION_PENDING');
    const run = await prisma.verificationRun.findFirstOrThrow({ where: { ticketId } });
    expect(run.pingsReceivedCount).toBe(1);
    expect(run.outcome).toBeNull();
  });

  it('skips the geo-check (no fraud) when presence is NONE, and still closes on good evidence', async () => {
    const { ticketId, deviceId } = await makeTicket();
    await submitForm(ticketId, 'NONE');
    for (const m of [1, 20, 45, 65]) await addPing(deviceId, at(m), FAR); // far, but no anchor

    const res = await verify.runVerification(at(70), { ticketIds: [ticketId] });
    expect(res.closed).toBe(1);
    const run = await prisma.verificationRun.findFirstOrThrow({ where: { ticketId } });
    expect(run.fraudFlag).toBe(false);
  });

  it('fails a ticket with no pings once the 24 h window expires', async () => {
    const { ticketId } = await makeTicket();
    await submitForm(ticketId, 'FORM_GPS');
    // #148: expiry now requires telemetry to have actually advanced past the submission — 25 h of
    // wall-clock against a frozen pipeline proves nothing. This test has always meant "telemetry is
    // flowing and the device still did not ping"; that precondition is now stated instead of
    // inherited from whatever watermark other specs left in the shared database.
    // `verification-staleness.e2e-spec.ts` owns the stale-telemetry half of the pair.
    await prisma.snapshotRun.create({
      data: { status: 'SUCCESS', startedAt: T0, dataAsOf: new Date(T0.getTime() + 26 * 60 * 60_000) },
    });

    const res = await verify.runVerification(new Date(T0.getTime() + 25 * 60 * 60_000), { ticketIds: [ticketId] });
    expect(res.failed).toBe(1);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('FAILED_VERIFICATION');
  });

  /**
   * #271 — verification is a terminal boundary, not a resume boundary (Q7 Case 1). By the time a
   * ticket reaches VERIFICATION_PENDING, submission has already folded any running VU pause (#271's
   * own submission-side fix) — so the ordinary case here is "nothing to do", pinned by asserting no
   * SECOND resume event is ever recorded once verification runs. AC-3's defensive clause ("a cycle
   * reaching VERIFIED must not carry sla_paused = true") is pinned separately, against a cycle
   * deliberately re-paused after submission to exercise a state the ordinary flow cannot produce.
   */
  describe('#271 — SLA boundary at verification', () => {
    it('AC-3 — verification success: one fold total (at submission), none at closure', async () => {
      const { ticketId, deviceId, cycleId } = await makeTicket();
      await prisma.failureCycle.update({
        where: { cycleId },
        data: { slaPaused: true, slaPauseReason: 'VEHICLE_UNAVAILABLE', slaPausedAt: at(-120), slaPauseSource: 'SE_VEHICLE_UNAVAILABLE' },
      });
      await prisma.vehicleUnavailabilityReport.create({
        data: {
          ticketId,
          failureCycleId: cycleId,
          seId: se,
          reasonCode: 'VEHICLE_ON_TRIP',
          transporterContacted: false,
          proposedFrom: T0,
          expectedFrom: T0,
          status: 'OPEN',
        },
      });

      await submitForm(ticketId, 'FORM_GPS');
      for (const m of [1, 20, 45, 65]) await addPing(deviceId, at(m), NEAR);
      const res = await verify.runVerification(at(70), { ticketIds: [ticketId] });
      expect(res.closed).toBe(1);

      const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
      expect(cycle.state).toBe('VERIFIED');
      expect(cycle.closedAt).not.toBeNull();
      expect(cycle.slaPaused).toBe(false);
      // 120 minutes folded at submission; nothing added since.
      expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(120 * 60);

      const audits = await prisma.auditLog.findMany({
        where: { entityType: 'failure_cycles', entityId: cycleId, action: 'VU_SLA_AUTO_RESUMED' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toMatchObject({ resumedBy: 'SUBMISSION' });
    });

    it('AC-4 — verification failure: the clock keeps running from the submission resume, no second fold', async () => {
      const { ticketId, cycleId } = await makeTicket();
      await prisma.failureCycle.update({
        where: { cycleId },
        data: { slaPaused: true, slaPauseReason: 'VEHICLE_UNAVAILABLE', slaPausedAt: at(-60), slaPauseSource: 'SE_VEHICLE_UNAVAILABLE' },
      });
      await prisma.vehicleUnavailabilityReport.create({
        data: {
          ticketId,
          failureCycleId: cycleId,
          seId: se,
          reasonCode: 'VEHICLE_ON_TRIP',
          transporterContacted: false,
          proposedFrom: T0,
          expectedFrom: T0,
          status: 'OPEN',
        },
      });

      await submitForm(ticketId, 'FORM_GPS');
      // No pings at all; the window expires with nothing received.
      await prisma.snapshotRun.create({
        data: { status: 'SUCCESS', startedAt: T0, dataAsOf: new Date(T0.getTime() + 26 * 60 * 60_000) },
      });
      const res = await verify.runVerification(new Date(T0.getTime() + 25 * 60 * 60_000), { ticketIds: [ticketId] });
      expect(res.failed).toBe(1);

      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      // The automatic sweep's failure verdict is FAILED_VERIFICATION (terminal for the ticket); ESCALATED
      // is reached only by a human's `escalateFraud` on a fraud-flagged run, a different, manual path.
      expect(ticket.status).toBe('FAILED_VERIFICATION');

      const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
      // The clock resumed at submission and finalize() takes no cycle action on this outcome.
      expect(cycle.slaPaused).toBe(false);
      expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(60 * 60);
      expect(cycle.state).toBe('SUBMITTED'); // untouched by the FAILED_VERIFICATION outcome

      const audits = await prisma.auditLog.findMany({
        where: { entityType: 'failure_cycles', entityId: cycleId, action: 'VU_SLA_AUTO_RESUMED' },
      });
      expect(audits).toHaveLength(1); // submission's fold only — nothing from verification
    });

    it('AC-3 defensive backstop — a cycle somehow still paused at VERIFIED is folded and cleared', async () => {
      const { ticketId, deviceId, cycleId } = await makeTicket();
      await submitForm(ticketId, 'FORM_GPS');
      // Simulate a pause that stands despite submission — a state the ordinary flow cannot produce,
      // exercised directly to pin the backstop rather than leave it untested dead code.
      const rePausedAt = at(10);
      await prisma.failureCycle.update({
        where: { cycleId },
        data: { slaPaused: true, slaPauseReason: 'VEHICLE_UNAVAILABLE', slaPausedAt: rePausedAt, slaPauseSource: 'SE_VEHICLE_UNAVAILABLE' },
      });

      for (const m of [1, 20, 45, 65]) await addPing(deviceId, at(m), NEAR);
      const res = await verify.runVerification(at(70), { ticketIds: [ticketId] });
      expect(res.closed).toBe(1);

      const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
      expect(cycle.state).toBe('VERIFIED');
      expect(cycle.slaPaused).toBe(false);
      expect(cycle.slaPauseReason).toBeNull();
      expect(cycle.slaPausedAt).toBeNull();
      // at(70) - at(10) = 60 minutes.
      expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(60 * 60);
    });
  });
});
