import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { ConfigActor } from '../common/config-actor';
import { PrismaService } from '../prisma/prisma.service';

/** API shape of a plant. BigInt ids surfaced as JSON-safe numbers. */
export interface PlantView {
  plantId: number;
  name: string;
  zoneId: number;
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
      orderBy: { plantId: 'asc' },
    });
    return rows.map(toPlantView);
  }

  /** Creates a plant under an existing zone, audited (AC#6). Unknown zone → 404. */
  async create(name: string, zoneId: number, actor: ConfigActor): Promise<PlantView> {
    const zone = await this.prisma.zone.findUnique({ where: { zoneId: BigInt(zoneId) } });
    if (!zone) {
      throw new NotFoundException(`Zone not found: ${zoneId}`);
    }
    return this.audit.withAudit(
      {
        actorId: actor.user_id,
        actorRole: actor.role,
        actedAsRole: actor.acted_as_role ?? null,
        action: 'PLANT_CREATED',
        entityType: 'plants',
        entityId: name,
      },
      async (tx) =>
        toPlantView(await tx.plant.create({ data: { name, zoneId: BigInt(zoneId) } })),
    );
  }
}

function toPlantView(row: { plantId: bigint; name: string; zoneId: bigint }): PlantView {
  return { plantId: Number(row.plantId), name: row.name, zoneId: Number(row.zoneId) };
}
