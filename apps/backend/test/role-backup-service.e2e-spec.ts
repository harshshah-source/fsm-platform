import { PrismaService } from '../src/prisma/prisma.service';
import { RoleBackupService } from '../src/roles/role-backup.service';

/**
 * Issue 27 slice 1 — role backup cascade (CONTEXT.md §15). The strict upward cascade
 * ZONAL_MANAGER → CENTRAL_SERVICE_MANAGER → OPERATIONS_HEAD, driven by `role_unavailability`. When a
 * zone's ZM is marked unavailable the CSM holds the duty; if the CSM is also out, Operations Head does.
 * Marking is Operations-Head / CSM only.
 */
const NS = Date.now();
const NOW = new Date('2026-06-25T12:00:00Z');
const WIN = { windowStart: new Date('2026-06-25T00:00:00Z'), windowEnd: new Date('2026-06-26T00:00:00Z') };

describe('Issue 27 slice 1 — RoleBackupService cascade', () => {
  let prisma: PrismaService;
  let svc: RoleBackupService;
  let zoneA: bigint;
  let zoneB: bigint;
  const ids: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new RoleBackupService(prisma);
    zoneA = (await prisma.zone.create({ data: { name: 'Z-rbA-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-rbB-' + NS } })).zoneId;
  });

  afterAll(async () => {
    await prisma.roleUnavailability.deleteMany({ where: { id: { in: ids } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  const opsHead = { userId: '33333333-3333-3333-3333-333333333333', role: 'OPERATIONS_HEAD', zoneId: null };

  it('with no unavailability, the zone ZM holds the duty', async () => {
    expect(await svc.currentActingRoleForZone(Number(zoneA), NOW)).toBe('ZONAL_MANAGER');
  });

  it('a ZM marked unavailable hands the duty to the CSM (cascade up)', async () => {
    const out = await svc.markUnavailable({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA), ...WIN, reason: 'leave' }, opsHead);
    expect(out.result).toBe('OK');
    ids.push(BigInt(out.id!));
    expect(await svc.currentActingRoleForZone(Number(zoneA), NOW)).toBe('CENTRAL_SERVICE_MANAGER');
    // Zone B is unaffected — the cascade is zone-specific for the ZM tier.
    expect(await svc.currentActingRoleForZone(Number(zoneB), NOW)).toBe('ZONAL_MANAGER');
  });

  it('if the CSM is also unavailable, Operations Head holds the duty', async () => {
    const out = await svc.markUnavailable({ role: 'CENTRAL_SERVICE_MANAGER', zoneId: null, ...WIN }, opsHead);
    ids.push(BigInt(out.id!));
    expect(await svc.currentActingRoleForZone(Number(zoneA), NOW)).toBe('OPERATIONS_HEAD');
  });

  it('forbids a ZM from marking role unavailability', async () => {
    const out = await svc.markUnavailable(
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneB), ...WIN },
      { userId: 'zm', role: 'ZONAL_MANAGER', zoneId: Number(zoneB) },
    );
    expect(out.result).toBe('FORBIDDEN');
  });
});
