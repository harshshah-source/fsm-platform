import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * TB6 — the AuditService writes exactly one audit_logs row in the SAME transaction as the
 * mutation it records, stamping acted_as_role. Atomicity (rollback) is covered separately.
 */
describe('TB6 — in-transaction audit write', () => {
  let prisma: PrismaService;
  let audit: AuditService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    audit = new AuditService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('writes one audit row, stamped with acted_as_role, in the same tx as the mutation', async () => {
    const key = `__audit_probe_${randomUUID()}`;
    const action = `TEST_SETTING_CREATED_${randomUUID()}`;

    await audit.withAudit(
      {
        actorId: 'csm-1',
        actorRole: 'CENTRAL_SERVICE_MANAGER',
        actedAsRole: 'CENTRAL_SERVICE_MANAGER',
        action,
        entityType: 'system_settings',
        entityId: key,
      },
      (tx) => tx.systemSetting.create({ data: { key, value: 1 } }),
    );

    const setting = await prisma.systemSetting.findUnique({ where: { key } });
    expect(setting).not.toBeNull();

    const rows = await prisma.auditLog.findMany({ where: { action } });
    expect(rows).toHaveLength(1);
    expect(rows[0].actedAsRole).toBe('CENTRAL_SERVICE_MANAGER');
    expect(rows[0].entityId).toBe(key);
  });

  it('rolls back the mutation and the audit row together when the work throws', async () => {
    const key = `__audit_probe_${randomUUID()}`;
    const action = `TEST_SHOULD_ROLLBACK_${randomUUID()}`;

    await expect(
      audit.withAudit(
        {
          actorId: 'ops-1',
          actorRole: 'OPERATIONS_HEAD',
          actedAsRole: null,
          action,
          entityType: 'system_settings',
          entityId: key,
        },
        async (tx) => {
          await tx.systemSetting.create({ data: { key, value: 1 } });
          throw new Error('mutation failed');
        },
      ),
    ).rejects.toThrow('mutation failed');

    // Same-tx guarantee: a non-transactional impl would leave the setting behind.
    expect(await prisma.systemSetting.findUnique({ where: { key } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { action } })).toBe(0);
  });
});
