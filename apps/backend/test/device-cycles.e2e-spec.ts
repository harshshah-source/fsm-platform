import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { DeviceDetailService } from '../src/devices/device-detail.service';

/**
 * Issue 44 slice 2 — `DeviceDetailService.deviceCycles`. The Device Detail per-cycle list (hot operational
 * records): each Failure Cycle with downtime start/end + duration, the SLA bucket the cycle reached,
 * repeat-failure, assigned SE, plant, company, root cause, component-related / vehicle-unavailable /
 * component-blocked impact, verification outcome, closure type, and the auto-recovery flag. ZM is scoped
 * to their own zone (out-of-zone → NOT_FOUND, no existence leak); Operations Head / CSM see any device.
 */
const NS = Date.now();
const NOW = new Date(Date.UTC(2026, 5, 1, 0, 0, 0));

describe('Issue 44 slice 2 — DeviceDetailService.deviceCycles', () => {
  let prisma: PrismaService;
  let service: DeviceDetailService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let seId: string;
  let deviceId: bigint;
  const userIds: string[] = [];
  const cycleIds: string[] = [];
  const ticketIds: string[] = [];
  const submissionIds: string[] = [];
  const requestIds: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new DeviceDetailService(prisma);

    zoneA = (await prisma.zone.create({ data: { name: 'ZA-dc-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'ZB-dc-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-dc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'PA-dc-' + NS, zoneId: zoneA } })).plantId;
    const t = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + t, role: 'SERVICE_ENGINEER', phone: 'dc-' + t, email: `dc-${t}@dc.test`, zoneId: zoneA } });
    seId = u.userId;
    userIds.push(seId);
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId: zoneA, dailyCapacity: 10 } });

    deviceId = BigInt(9_445_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    await prisma.deviceState.create({ data: { deviceId, eligibleForUptime: true, plantId: plantA, companyId, computedAt: NOW } });

    // A rich closed cycle: 3-day outage, repeat-failure, root cause, component request, passed verification.
    const cycle = await prisma.failureCycle.create({
      data: { deviceId, state: 'VERIFIED', openedAt: new Date(Date.UTC(2026, 4, 5)), closedAt: new Date(Date.UTC(2026, 4, 8)), repeatFailure: true },
    });
    cycleIds.push(cycle.cycleId);
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'CLOSED', failureCycleId: cycle.cycleId, deviceId, plantId: plantA, companyId, companyTier: 'GOLD', assignedSeId: seId, closureType: 'ZM_MANUAL_CLOSE', lastStateChangedAt: NOW },
    });
    ticketIds.push(ticket.ticketId);
    const sub = await prisma.troubleshootingSubmission.create({
      data: { ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionType: 'TROUBLESHOOTING_FORM', clientSubmissionId: randomUUID(), seId, presenceSource: 'NONE', rootCauseCategory: 'WIRING_ISSUE', submittedAt: new Date(Date.UTC(2026, 4, 6)) },
    });
    submissionIds.push(sub.submissionId);
    const req = await prisma.componentRequest.create({ data: { ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionId: sub.submissionId, seId, status: 'RECEIVED' } });
    requestIds.push(req.requestId);
    const run = await prisma.verificationRun.create({
      data: { ticketId: ticket.ticketId, submissionId: sub.submissionId, deviceId, startedAt: new Date(Date.UTC(2026, 4, 7)), phase: 'PHASE_2_PASS', outcome: 'CLOSED', outcomeAt: new Date(Date.UTC(2026, 4, 8)) },
    });
    runIds.push(run.runId);

    // A second, plain open cycle (no submission) → newest first.
    const c2 = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date(Date.UTC(2026, 4, 20)) } });
    cycleIds.push(c2.cycleId);
    const t2 = await prisma.ticket.create({ data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: c2.cycleId, deviceId, plantId: plantA, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW } });
    ticketIds.push(t2.ticketId);
  });

  afterAll(async () => {
    await prisma.verificationRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.componentRequest.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { submissionId: { in: submissionIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: plantA } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  const oh = { role: 'OPERATIONS_HEAD', zoneId: null };

  it('lists each cycle newest-first with all documented per-cycle fields', async () => {
    const out = await service.deviceCycles(deviceId, oh, NOW);
    expect(out.result).toBe('OK');
    if (out.result !== 'OK') return;
    expect(out.cycles).toHaveLength(2);
    expect(out.cycles[0].closedAt).toBeNull(); // open cycle (opened May 20) is newest

    const rich = out.cycles[1];
    expect(rich.durationSeconds).toBe(3 * 86_400);
    expect(rich.slaBucketReached).toBe('SEVERE'); // 72h ≤ 3d < 5d
    expect(rich.repeatFailure).toBe(true);
    expect(rich.assignedSeId).toBe(seId);
    expect(rich.plantId).toBe(String(plantA));
    expect(rich.companyId).toBe(String(companyId));
    expect(rich.rootCauseCategory).toBe('WIRING_ISSUE');
    expect(rich.componentRelated).toBe(true);
    expect(rich.componentBlockedImpact).toBe(true);
    expect(rich.verificationOutcome).toBe('CLOSED');
    expect(rich.closureType).toBe('ZM_MANUAL_CLOSE');
    expect(rich.autoRecovery).toBe(false);
  });

  it('a ZM in the device’s zone sees the cycles', async () => {
    const out = await service.deviceCycles(deviceId, { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, NOW);
    expect(out.result).toBe('OK');
  });

  it('a ZM in another zone gets NOT_FOUND (no existence leak)', async () => {
    const out = await service.deviceCycles(deviceId, { role: 'ZONAL_MANAGER', zoneId: Number(zoneB) }, NOW);
    expect(out.result).toBe('NOT_FOUND');
  });

  it('an unknown device is NOT_FOUND', async () => {
    const out = await service.deviceCycles(999_999_999_999n, oh, NOW);
    expect(out.result).toBe('NOT_FOUND');
  });
});
