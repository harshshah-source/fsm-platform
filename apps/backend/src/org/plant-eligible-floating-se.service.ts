import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * `plant_eligible_floating_se` materialized view access (ADR-0006, Issue 09). The MV precomputes the
 * plant → eligible-Floating-SE union (district / region / state hierarchical membership ∪
 * `ST_Contains(polygon, plant.location)`), keeping the Recommender hot path (Issue 10) an index
 * lookup. `refresh()` rebuilds it — invoked on territory edits and (later) nightly.
 */
@Injectable()
export class PlantEligibleFloatingSeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Rebuild the MV from current plants + territory. Refreshes CONCURRENTLY (readers keep the old
   * snapshot, no lock) via the unique index; falls back to a plain refresh for the first-ever run,
   * when the MV is still unpopulated (created WITH NO DATA) and CONCURRENTLY is not yet allowed. */
  async refresh(): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY "plant_eligible_floating_se"');
    } catch {
      await this.prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW "plant_eligible_floating_se"');
    }
  }

  /** The FLOATING SEs whose territory covers this plant, per the precomputed MV. */
  async eligibleSeIdsForPlant(plantId: bigint | number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ se_id: string }[]>(
      Prisma.sql`SELECT se_id FROM plant_eligible_floating_se WHERE plant_id = ${BigInt(plantId)}`,
    );
    return rows.map((r) => r.se_id);
  }
}
