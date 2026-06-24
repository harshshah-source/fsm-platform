import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';
import { VerificationService } from '../src/verification/verification.service';

/**
 * Issue 24, slice 3 — inventory follows the verification outcome (CONTEXT §Inventory: PRE_VERIFICATION
 * → DEDUCTED lifecycle). A consumed component is PRE_VERIFICATION at submit. On a verified CLOSE it
 * becomes DEDUCTED (genuinely used; van stock stays down). On a FAILED verification (device not
 * actually repaired) it ROLLS BACK and the SE's van stock is restored to physical reality.
 */
const NS = Date.now();
const T0 = new Date('2026-06-23T06:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const ANCHOR = { lat: 12.9716, lon: 77.5946 };
const NEAR = { lat: 12.9721, lon: 77.5946 };

describe('Issue 24 slice 3 — inventory rollback on verification outcome', () => {
  let prisma: PrismaService;
  let verify: VerificationService;
  let submit: TroubleshootSubmissionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let cable: bigint;
  let se: string;
  let snapshotRunId: bigint;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<{ ticketId: string; deviceId: bigint; cycleId: string }> => {
    const deviceId = BigInt(12_700_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: T0 } });
    const ticket = await prisma.ticket.create({ data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: T0 } });
    ticketIds.push(ticket.ticketId);
    await prisma.deviceState.create({ data: { deviceId, isInactive: true, hasOpenFailureCycle: true, plantId, companyId, computedAt: T0 } });
    return { ticketId: ticket.ticketId, deviceId, cycleId: cycle.cycleId };
  };
  const addPing = (deviceId: bigint, time: Date, loc: { lat: number; lon: number }) =>
    prisma.rawDeviceSnapshot.create({ data: { runId: snapshotRunId, deviceId, gpsDatetime: time, lat: loc.lat, lon: loc.lon } });
  const submitForm = (ticketId: string) =>
    submit.submit({ ticketId, seId: se, clientSubmissionId: randomUUID(), rootCauseCategory: 'WIRING_ISSUE', seGps: ANCHOR, presenceSource: 'FORM_GPS', consumedComponents: [{ componentId: cable, qty: 2 }], actor: { userId: se, role: 'SERVICE_ENGINEER' }, now: T0 });
  const stock = async () => (await prisma.seVanStock.findFirstOrThrow({ where: { seId: se, componentId: cable } })).qty;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    verify = new VerificationService(prisma);
    submit = new TroubleshootSubmissionService(prisma);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-ir-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-ir-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ir-' + NS, zoneId } })).plantId;
    cable = (await prisma.componentMaster.create({ data: { name: 'cable-ir-' + NS } })).componentId;
    snapshotRunId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS', startedAt: T0 } })).runId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@ir.test`, zoneId } });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seVanStock.create({ data: { seId: se, componentId: cable, qty: 10 } });
  });

  afterAll(async () => {
    await prisma.inventoryTransaction.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.verificationRun.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.rawDeviceSnapshot.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seVanStock.deleteMany({ where: { seId: se } });
    await prisma.componentMaster.deleteMany({ where: { componentId: cable } });
    await prisma.snapshotRun.deleteMany({ where: { runId: snapshotRunId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('marks consumption DEDUCTED on a verified close (van stock stays down)', async () => {
    const { ticketId, deviceId } = await makeTicket();
    await submitForm(ticketId); // stock 10 → 8, PRE_VERIFICATION
    for (const m of [1, 20, 45, 65]) await addPing(deviceId, at(m), NEAR);
    const res = await verify.runVerification(at(70), { ticketIds: [ticketId] });
    expect(res.closed).toBe(1);
    const txn = await prisma.inventoryTransaction.findFirstOrThrow({ where: { ticketId } });
    expect(txn.status).toBe('DEDUCTED');
    expect(await stock()).toBe(8);
  });

  it('rolls back consumption and restores van stock on a failed verification', async () => {
    const before = await stock(); // 8 after the previous test
    const { ticketId } = await makeTicket();
    await submitForm(ticketId); // stock → before-2, PRE_VERIFICATION
    expect(await stock()).toBe(before - 2);
    const res = await verify.runVerification(new Date(T0.getTime() + 25 * 60 * 60_000), { ticketIds: [ticketId] });
    expect(res.failed).toBe(1);
    const txn = await prisma.inventoryTransaction.findFirstOrThrow({ where: { ticketId } });
    expect(txn.status).toBe('ROLLED_BACK');
    expect(await stock()).toBe(before); // restored
  });
});
