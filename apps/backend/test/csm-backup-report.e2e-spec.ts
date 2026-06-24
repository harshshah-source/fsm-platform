import { PrismaService } from '../src/prisma/prisma.service';
import { RoleBackupService } from '../src/roles/role-backup.service';

/**
 * Issue 27 slice 2 (AC#5) — per-zone CSM backup share. From `audit_logs.acting_zone` + `acted_as_role`,
 * the share of acted-as-backup actions performed by a CSM in each zone for the period, so Operations
 * Head can spot zones where ZM backup is becoming routine.
 */
const NS = Date.now();
const PERIOD_START = new Date('2026-06-01T00:00:00Z');
const PERIOD_END = new Date('2026-07-01T00:00:00Z');
const AT = new Date('2026-06-15T10:00:00Z');

describe('Issue 27 slice 2 — CSM backup share by zone', () => {
  let prisma: PrismaService;
  let svc: RoleBackupService;
  const zoneA = BigInt(910_000 + (NS % 1000));
  const zoneB = zoneA + 1n;
  const auditIds: bigint[] = [];

  const audit = async (actingZone: bigint, actedAsRole: string) => {
    const row = await prisma.auditLog.create({
      data: {
        actorId: '33333333-3333-3333-3333-333333333333',
        actorRole: actedAsRole,
        actedAsRole,
        actingZone,
        action: 'BATCH_OVERRIDE',
        entityType: 'plant_batch_assignments',
        entityId: 'e-' + NS,
        createdAt: AT,
      },
    });
    auditIds.push(row.id);
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new RoleBackupService(prisma);
    // Zone A: 2 CSM-acted + 1 Ops-acted ⇒ CSM share 66.7%.
    await audit(zoneA, 'CENTRAL_SERVICE_MANAGER');
    await audit(zoneA, 'CENTRAL_SERVICE_MANAGER');
    await audit(zoneA, 'OPERATIONS_HEAD');
    // Zone B: 1 CSM-acted ⇒ 100%.
    await audit(zoneB, 'CENTRAL_SERVICE_MANAGER');
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
    await prisma.onModuleDestroy();
  });

  it('computes per-zone CSM backup share for the period', async () => {
    const rows = await svc.csmBackupShareByZone(PERIOD_START, PERIOD_END);
    const a = rows.find((r) => r.zoneId === String(zoneA))!;
    const b = rows.find((r) => r.zoneId === String(zoneB))!;
    expect(a).toMatchObject({ csmActions: 2, totalActedActions: 3, sharePct: 66.7 });
    expect(b).toMatchObject({ csmActions: 1, totalActedActions: 1, sharePct: 100 });
  });

  it('excludes actions outside the period', async () => {
    const rows = await svc.csmBackupShareByZone(new Date('2026-05-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
    expect(rows.find((r) => r.zoneId === String(zoneA))).toBeUndefined();
  });
});
