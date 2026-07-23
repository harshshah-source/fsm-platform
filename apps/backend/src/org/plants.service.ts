import { Injectable, NotFoundException } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { PrismaService } from '../prisma/prisma.service';

/**
 * API shape of a plant. BigInt ids surfaced as JSON-safe numbers.
 *
 * `sourcePlantId` is the AutoPlant id and is the key `plant_zone_overrides` pins on (#158) — it is a
 * string because it is an opaque external identifier, and null for FSM-created plants. `sourceZoneName`
 * is what AutoPlant claims the zone is; when the crosswalk cannot resolve it the plant lands UNZONED,
 * which is exactly when an admin needs to see both it and the resolved `zoneName` side by side.
 */
export interface PlantView {
  plantId: number;
  name: string;
  zoneId: number;
  zoneName: string | null;
  sourcePlantId: string | null;
  sourceZoneName: string | null;
}

@Injectable()
export class PlantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(zoneId?: number): Promise<PlantView[]> {
    const rows = await this.prisma.plant.findMany({
      where: zoneId === undefined ? undefined : { zoneId: BigInt(zoneId) },
      include: { zone: { select: { name: true } } },
      orderBy: { plantId: 'asc' },
    });
    return rows.map(toPlantView);
  }

  /** Creates a plant under an existing zone, audited (AC#6). Unknown zone → 404. */
  async create(name: string, zoneId: number, actor: RequestActor): Promise<PlantView> {
    const zone = await this.prisma.zone.findUnique({ where: { zoneId: BigInt(zoneId) } });
    if (!zone) {
      throw new NotFoundException(`Zone not found: ${zoneId}`);
    }
    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'PLANT_CREATED',
        entityType: 'plants',
        entityId: name,
      },
      async (tx) =>
        toPlantView(
          await tx.plant.create({
            data: { name, zoneId: BigInt(zoneId) },
            include: { zone: { select: { name: true } } },
          }),
        ),
    );
  }
}

function toPlantView(row: {
  plantId: bigint;
  name: string;
  zoneId: bigint;
  sourcePlantId?: bigint | null;
  sourceZoneName?: string | null;
  zone?: { name: string } | null;
}): PlantView {
  return {
    plantId: Number(row.plantId),
    name: row.name,
    zoneId: Number(row.zoneId),
    zoneName: row.zone?.name ?? null,
    sourcePlantId: row.sourcePlantId != null ? row.sourcePlantId.toString() : null,
    sourceZoneName: row.sourceZoneName ?? null,
  };
}
