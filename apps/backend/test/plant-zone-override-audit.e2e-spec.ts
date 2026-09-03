import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../src/audit/audit.service';
import { ZoneMappingService } from '../src/org/zone-mapping.service';
import type { RequestActor } from '../src/common/request-actor';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #158 S1 — the audit trail of a plant zone reassignment.
 *
 * `plant_zone_overrides` holds ONE row per plant (`sourcePlantId @unique`) and re-pinning a plant
 * UPSERTS it: the previous zone and the previous reason are overwritten in place, and `createdBy`
 * is never refreshed. So `audit_logs` is the only record of "who moved this plant from East to
 * South, and why" — which it could not answer before this slice, because the SET/CLEARED entries
 * carried no metadata at all. These tests pin the metadata contract.
 */
describe('#158 — plant zone override audit trail', () => {
  let prisma: PrismaService;
  let service: ZoneMappingService;

  let northId: bigint;
  let westId: bigint;

  // Isolated from zone-mapping-resolver.e2e-spec.ts's 995001/995002.
  const SRC_PLANT = 995101n;

  const actor: RequestActor = {
    userId: '00000000-0000-0000-0000-000000000001',
    role: 'OPERATIONS_HEAD',
    actedAsRole: null,
    actingZone: null,
    zoneId: null,
  };

  const auditRows = async (action: string) =>
    prisma.auditLog.findMany({
      where: { entityType: 'plant_zone_overrides', entityId: SRC_PLANT.toString(), action },
      orderBy: { id: 'asc' },
    });

  const cleanup = async (): Promise<void> => {
    await prisma.plantZoneOverride.deleteMany({ where: { sourcePlantId: SRC_PLANT } });
    await prisma.auditLog.deleteMany({
      where: { entityType: 'plant_zone_overrides', entityId: SRC_PLANT.toString() },
    });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ZoneMappingService(prisma, new AuditService(prisma));

    const north = await prisma.zone.upsert({ where: { name: 'North' }, create: { name: 'North' }, update: {} });
    const west = await prisma.zone.upsert({ where: { name: 'West' }, create: { name: 'West' }, update: {} });
    northId = north.zoneId;
    westId = west.zoneId;
  });

  beforeEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  it('records the new zone and reason when a plant is pinned for the first time', async () => {
    await service.upsertOverride(SRC_PLANT, northId, 'initial pin', actor);

    const [row] = await auditRows('PLANT_ZONE_OVERRIDE_SET');
    expect(row.metadata).toEqual({
      prevFsmZoneId: null,
      newFsmZoneId: northId.toString(),
      reason: 'initial pin',
    });
  });

  it('records BOTH the previous and the new zone when an existing pin is moved', async () => {
    // The load-bearing case: the upsert overwrites the row, so without this metadata the fact that
    // the plant used to be pinned to North is gone from the system entirely.
    await service.upsertOverride(SRC_PLANT, northId, 'initial pin', actor);
    await service.upsertOverride(SRC_PLANT, westId, 'moved to west', actor);

    const rows = await auditRows('PLANT_ZONE_OVERRIDE_SET');
    expect(rows).toHaveLength(2);
    expect(rows[1].metadata).toEqual({
      prevFsmZoneId: northId.toString(),
      newFsmZoneId: westId.toString(),
      reason: 'moved to west',
    });
  });

  it('records the zone it cleared from when an override is removed', async () => {
    await service.upsertOverride(SRC_PLANT, westId, 'pin west', actor);
    await service.deleteOverride(SRC_PLANT, actor);

    const [row] = await auditRows('PLANT_ZONE_OVERRIDE_CLEARED');
    expect(row.metadata).toEqual({
      prevFsmZoneId: westId.toString(),
      newFsmZoneId: null,
      reason: 'pin west',
    });
  });

  it('rejects a zone reassignment with no reason', async () => {
    await expect(service.upsertOverride(SRC_PLANT, northId, null, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(await prisma.plantZoneOverride.findUnique({ where: { sourcePlantId: SRC_PLANT } })).toBeNull();
  });
});
