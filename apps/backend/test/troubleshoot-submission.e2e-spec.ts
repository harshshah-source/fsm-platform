import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftStateService } from '../src/soft-state/soft-state.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';

/**
 * Issue 16, slices 2–3 — the troubleshooting-form online submit. A fresh submit creates the structured
 * record (silent SE GPS anchor), moves the Ticket to VERIFICATION_PENDING and the cycle to SUBMITTED,
 * resolves the SE's active soft states, and audits. A repeat with the same client_submission_id is a
 * no-op returning the existing record (duplicate=true) — never a second row.
 */
const NS = Date.now();
const NOW = new Date('2026-06-23T09:00:00Z');

describe('Issue 16 slices 2–3 — troubleshoot submission', () => {
  let prisma: PrismaService;
  let svc: TroubleshootSubmissionService;
  let soft: SoftStateService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const actor = () => ({ userId: se, role: 'SERVICE_ENGINEER' });

  const makeTicket = async (): Promise<{ ticketId: string; cycleId: string }> => {
    const deviceId = BigInt(11_400_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    return { ticketId: ticket.ticketId, cycleId: cycle.cycleId };
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new TroubleshootSubmissionService(prisma);
    soft = new SoftStateService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-tf-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-tf-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-tf-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@tf.test`, zoneId },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('submits the form, captures GPS silently, and moves the ticket to VERIFICATION_PENDING', async () => {
    const { ticketId, cycleId } = await makeTicket();
    // SE was ON_SITE; submitting the form should resolve that soft state.
    await soft.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });
    await soft.advance({ ticketId, seId: se, target: 'ON_SITE', now: NOW });

    const outcome = await svc.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'POWER_ISSUE',
      diagnosisNotes: 'fuse replaced',
      photoRefs: ['s3://photo/1.jpg'],
      seGps: { lat: 12.97, lon: 77.59 },
      actor: actor(),
      now: NOW,
    });

    expect(outcome.result).toBe('OK');
    expect(outcome.result === 'OK' && outcome.submission.seGpsLat).toBe(12.97);
    expect(outcome.result === 'OK' && outcome.submission.presenceSource).toBe('FORM_GPS');

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('VERIFICATION_PENDING');
    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.state).toBe('SUBMITTED');

    // The SE's active soft states are resolved by the submission.
    const active = await prisma.softState.findMany({ where: { ticketId, seId: se, resolvedAt: null } });
    expect(active.length).toBe(0);

    // A lifecycle event records the transition.
    const events = await prisma.ticketEvent.findMany({ where: { ticketId, toState: 'VERIFICATION_PENDING' } });
    expect(events.length).toBe(1);
  });

  it('is idempotent: a repeat of the same client_submission_id returns the existing record', async () => {
    const { ticketId } = await makeTicket();
    const clientSubmissionId = randomUUID();
    const first = await svc.submit({
      ticketId,
      seId: se,
      clientSubmissionId,
      rootCauseCategory: 'SIM_NETWORK_ISSUE',
      actor: actor(),
      now: NOW,
    });
    expect(first.result).toBe('OK');

    const second = await svc.submit({
      ticketId,
      seId: se,
      clientSubmissionId,
      rootCauseCategory: 'SIM_NETWORK_ISSUE',
      actor: actor(),
      now: NOW,
    });
    expect(second.result).toBe('DUPLICATE');
    expect(second.result === 'DUPLICATE' && second.duplicate).toBe(true);
    expect(first.result === 'OK' && second.result === 'DUPLICATE' && second.submission.submissionId).toBe(
      first.result === 'OK' ? first.submission.submissionId : '',
    );

    // Exactly one row exists for this (se, client_submission_id).
    const rows = await prisma.troubleshootingSubmission.findMany({ where: { seId: se, clientSubmissionId } });
    expect(rows.length).toBe(1);
  });

  it('returns NOT_OPEN when the ticket is no longer OPEN (another submission already won)', async () => {
    const { ticketId } = await makeTicket();
    await svc.submit({ ticketId, seId: se, clientSubmissionId: randomUUID(), rootCauseCategory: 'UNKNOWN', actor: actor(), now: NOW });
    // A different SE draft on a now-VERIFICATION_PENDING ticket.
    const outcome = await svc.submit({ ticketId, seId: se, clientSubmissionId: randomUUID(), rootCauseCategory: 'UNKNOWN', actor: actor(), now: NOW });
    expect(outcome.result).toBe('NOT_OPEN');
  });
});
