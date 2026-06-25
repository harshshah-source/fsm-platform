import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { NonOperationalService } from '../src/ticketing/non-operational.service';
import type {
  CustomerConfirmationNotifier,
  CustomerConfirmationRequest,
} from '../src/ticketing/customer-confirmation-notifier';
import type { RequestActor } from '../src/common/request-actor';

/**
 * Issue 35, slice 4 — customer confirmation via a one-time tokenised email link (AC#6). Requesting a
 * marking issues a one-time token and fires it through the CustomerConfirmationNotifier seam (Issue 03
 * replaces the stub). The customer confirms by presenting the token; a used or expired token is rejected.
 */
const DEV = 9_353_001n;
const DEV2 = 9_353_002n;
const ALL = [DEV, DEV2];

const zm: RequestActor = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null, actingZone: null };

describe('Issue 35 slice 4 — customer token confirmation', () => {
  let prisma: PrismaService;
  let service: NonOperationalService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const sent: CustomerConfirmationRequest[] = [];
  const notifier: CustomerConfirmationNotifier = {
    sendConfirmationLink: (r) => { sent.push(r); },
  };

  const NOW = new Date(Date.UTC(2026, 5, 25, 12, 0, 0));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new NonOperationalService(prisma, new AuditService(prisma), notifier);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-nopt-' + Date.now() } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-nopt-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-nopt', zoneId } })).plantId;
    await prisma.device.create({ data: { deviceId: DEV, dealType: 'ONE_TIME' } });
    await prisma.device.create({ data: { deviceId: DEV2, dealType: 'ONE_TIME' } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'non_operational_markings' } });
    await prisma.nonOperationalMarking.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('issues a one-time token, fires the notifier, and confirms the customer leg by token', async () => {
    const req = await service.requestMarking({ deviceId: DEV, reasonCode: 'COMPANY_PAUSED' }, zm, NOW);
    if (req.result !== 'OK') throw new Error(req.result);

    expect(sent).toHaveLength(1);
    expect(sent[0].deviceId).toBe(DEV);
    expect(sent[0].confirmUrl).toContain(sent[0].token);

    const row = await prisma.nonOperationalMarking.findUniqueOrThrow({ where: { markingId: req.marking.markingId } });
    expect(row.customerToken).toBe(sent[0].token);

    const ok = await service.confirmByCustomerToken(sent[0].token, NOW);
    expect(ok.result).toBe('OK');
    const after = await prisma.nonOperationalMarking.findUniqueOrThrow({ where: { markingId: req.marking.markingId } });
    expect(after.customerConfirmedAt).not.toBeNull();
    expect(after.customerToken).toBeNull(); // one-time — consumed
  });

  it('rejects an unknown and an expired token', async () => {
    expect((await service.confirmByCustomerToken('does-not-exist', NOW)).result).toBe('NOT_FOUND');

    const req = await service.requestMarking({ deviceId: DEV2, reasonCode: 'COMPANY_PAUSED' }, zm, NOW);
    if (req.result !== 'OK') throw new Error(req.result);
    const token = sent.at(-1)!.token;
    const wayLater = new Date(NOW.getTime() + 999 * 86_400_000);
    expect((await service.confirmByCustomerToken(token, wayLater)).result).toBe('EXPIRED');
  });
});
