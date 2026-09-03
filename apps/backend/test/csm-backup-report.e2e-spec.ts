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

  /**
   * #340 AC3/AC4 — the report counts **acting** rows, and only those.
   *
   * `acting_zone` was carrying two different meanings. Bulk unassign (`bulk-unassign.service.ts`)
   * wrote the *target* zone of a pan-India rebalance into it with no `acted_as_role` at all, and this
   * report reads any non-null `acting_zone` as a backup action. So every rebalance inflated
   * `totalActedActions` without ever adding to `csmActions`, and the CSM share it reported was a
   * number divided by the wrong denominator — silently, and worse in exactly the zones an Operations
   * Head touches most.
   *
   * Two independent fixes, and this file pins the read half: a row is a backup action **because it
   * names the role that acted**, not because it happens to name a zone. The write half — bulk unassign
   * no longer writing `acting_zone` at all — is pinned in `bulk-unassign-history.e2e-spec.ts`, where
   * the same target zone is read back from `entityId`. Either fix alone would make this month's number
   * right; only both make the column mean one thing.
   */
  describe('#340 — only rows that name an acting role are backup actions', () => {
    const foreignIds: bigint[] = [];

    /** A row shaped exactly like bulk unassign's: a zone, and nobody acting as anyone. */
    const zoneOnlyRow = async (actingZone: bigint) => {
      const row = await prisma.auditLog.create({
        data: {
          actorId: '33333333-3333-3333-3333-333333333333',
          actorRole: 'OPERATIONS_HEAD',
          actedAsRole: null,
          actingZone,
          action: 'BULK_UNASSIGN_ZONE',
          entityType: 'zones',
          entityId: String(actingZone),
          createdAt: AT,
        },
      });
      foreignIds.push(row.id);
    };

    afterEach(async () => {
      if (foreignIds.length) {
        await prisma.auditLog.deleteMany({ where: { id: { in: foreignIds } } });
        foreignIds.length = 0;
      }
    });

    it('ignores a zone-stamped row with no acting role, leaving the share unchanged', async () => {
      await zoneOnlyRow(zoneA);
      await zoneOnlyRow(zoneA);

      const rows = await svc.csmBackupShareByZone(PERIOD_START, PERIOD_END);
      const a = rows.find((r) => r.zoneId === String(zoneA))!;
      // Without the filter these two rows land in `total` and nowhere else: 2/5 = 40.0%.
      expect(a).toMatchObject({ csmActions: 2, totalActedActions: 3, sharePct: 66.7 });
    });

    it('does not invent a zone whose only rows are non-acting', async () => {
      const zoneC = zoneA + 2n;
      await zoneOnlyRow(zoneC);

      const rows = await svc.csmBackupShareByZone(PERIOD_START, PERIOD_END);
      expect(rows.find((r) => r.zoneId === String(zoneC))).toBeUndefined();
    });
  });
});
