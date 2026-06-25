import { AuditService } from '../src/audit/audit.service';
import { DeviceService } from '../src/devices/device.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 49 slice 1 — Operations-Head manual `deal_type` tagging (CONTEXT "Deal Type"; ADR-0014). The
 * `device.deal_type` column already exists (Issue 05 spine); this slice adds the audited write
 * (`DEVICE_DEAL_TYPE_TAG`) and the device read path #35 depends on. NULL = untagged until tagged.
 */
const NS = Date.now();
const OH = { userId: '49000000-0000-0000-0000-000000000000', role: 'OPERATIONS_HEAD', actedAsRole: null };

describe('Issue 49 slice 1 — DeviceService.setDealType', () => {
  let prisma: PrismaService;
  let svc: DeviceService;
  let deviceId: bigint;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new DeviceService(prisma, new AuditService(prisma));
    deviceId = BigInt(12_000_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'device', entityId: String(deviceId) } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.onModuleDestroy();
  });

  it('tags a device deal_type and writes an audit row', async () => {
    const out = await svc.setDealType(deviceId, 'RECURRING', OH);
    expect(out.result).toBe('OK');
    const device = await prisma.device.findUniqueOrThrow({ where: { deviceId } });
    expect(device.dealType).toBe('RECURRING');

    const audits = await prisma.auditLog.findMany({ where: { entityType: 'device', entityId: String(deviceId) } });
    expect(audits.some((a) => a.action === 'DEVICE_DEAL_TYPE_TAG')).toBe(true);
  });

  it('re-tags to a different value (CRM correction)', async () => {
    const out = await svc.setDealType(deviceId, 'ONE_TIME', OH);
    expect(out.result).toBe('OK');
    const device = await prisma.device.findUniqueOrThrow({ where: { deviceId } });
    expect(device.dealType).toBe('ONE_TIME');
  });

  it('returns NOT_FOUND for an unknown device', async () => {
    const out = await svc.setDealType(BigInt(99_999_999_999), 'RECURRING', OH);
    expect(out.result).toBe('NOT_FOUND');
  });

  it('reads the device deal_type back via the read path', async () => {
    const device = await svc.getDevice(deviceId);
    expect(device?.dealType).toBe('ONE_TIME');
  });
});
