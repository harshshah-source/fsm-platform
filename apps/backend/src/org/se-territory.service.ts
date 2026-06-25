import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { PrismaService } from '../prisma/prisma.service';
import { PlantEligibleFloatingSeService } from './plant-eligible-floating-se.service';

export interface TerritoryView {
  id: number;
  seId: string;
  districtId: number | null;
  regionId: number | null;
  state: string | null;
}

export interface CreateTerritoryInput {
  seId: string;
  districtId?: number | null;
  regionId?: number | null;
  state?: string | null;
}

/**
 * Floating-SE Territory config (`engineer_territory_coverage`, ADR-0006, Issue 09). Operations Head
 * adds hierarchical (State / Region / District) union-membership rows for a FLOATING SE; the union of
 * a SE's rows is their Territory, resolved to plants by the `plant_eligible_floating_se` MV. Only
 * FLOATING SEs have a Territory — DEDICATED/MULTI_PLANT use `se_coverage` (→ 400). Each row must set
 * at least one dimension (→ 400). Polygon membership is reserved (no map-drawing editor in v1), so
 * this API exposes only the hierarchical dimensions.
 */
@Injectable()
export class SeTerritoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly eligibility: PlantEligibleFloatingSeService,
  ) {}

  async listTerritory(seId?: string): Promise<TerritoryView[]> {
    const rows = await this.prisma.engineerTerritoryCoverage.findMany({
      where: seId === undefined ? undefined : { seId },
      orderBy: { id: 'asc' },
    });
    return rows.map(toTerritoryView);
  }

  /** Adds one hierarchical territory row for a FLOATING SE, audited. Non-FLOATING / no dimension →
   * 400; unknown SE / district / region → 404. */
  async addTerritory(input: CreateTerritoryInput, actor: RequestActor): Promise<TerritoryView> {
    const districtId = input.districtId ?? null;
    const regionId = input.regionId ?? null;
    const state = input.state ?? null;
    if (districtId === null && regionId === null && (state === null || state === '')) {
      throw new BadRequestException('A territory row must set at least one of district, region or state');
    }

    const engineer = await this.prisma.engineerMaster.findUnique({ where: { engineerId: input.seId } });
    if (!engineer) {
      throw new NotFoundException(`SE profile not found: ${input.seId}`);
    }
    if (engineer.coverageType !== 'FLOATING') {
      throw new BadRequestException('Only FLOATING SEs have a territory; use se_coverage for DEDICATED/MULTI_PLANT');
    }
    if (districtId !== null && !(await this.prisma.district.findUnique({ where: { districtId: BigInt(districtId) } }))) {
      throw new NotFoundException(`District not found: ${districtId}`);
    }
    if (regionId !== null && !(await this.prisma.region.findUnique({ where: { regionId: BigInt(regionId) } }))) {
      throw new NotFoundException(`Region not found: ${regionId}`);
    }

    const view = await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'SE_TERRITORY_ADDED',
        entityType: 'engineer_territory_coverage',
        entityId: input.seId,
      },
      async (tx) =>
        toTerritoryView(
          await tx.engineerTerritoryCoverage.create({
            data: {
              seId: input.seId,
              districtId: districtId === null ? null : BigInt(districtId),
              regionId: regionId === null ? null : BigInt(regionId),
              state,
            },
          }),
        ),
    );
    // The territory set changed → refresh the plant→eligible-SE MV (after the tx commits, since a
    // CONCURRENTLY refresh cannot run inside a transaction).
    await this.eligibility.refresh();
    return view;
  }

  /** Removes a territory row, audited. Unknown id → 404. */
  async removeTerritory(id: number, actor: RequestActor): Promise<{ id: number }> {
    const existing = await this.prisma.engineerTerritoryCoverage.findUnique({ where: { id: BigInt(id) } });
    if (!existing) {
      throw new NotFoundException(`Territory row not found: ${id}`);
    }
    const result = await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'SE_TERRITORY_REMOVED',
        entityType: 'engineer_territory_coverage',
        entityId: String(id),
      },
      async (tx) => {
        await tx.engineerTerritoryCoverage.delete({ where: { id: BigInt(id) } });
        return { id };
      },
    );
    await this.eligibility.refresh();
    return result;
  }
}

function toTerritoryView(row: {
  id: bigint;
  seId: string;
  districtId: bigint | null;
  regionId: bigint | null;
  state: string | null;
}): TerritoryView {
  return {
    id: Number(row.id),
    seId: row.seId,
    districtId: row.districtId === null ? null : Number(row.districtId),
    regionId: row.regionId === null ? null : Number(row.regionId),
    state: row.state,
  };
}
