import type { PrismaService } from '../prisma/prisma.service';
import type { LatLng } from './distance';
import type { ScoringWeights } from './scoring';

/** The narrow slice of the client these reads touch — a transaction client satisfies it too. */
type ScoringConfigClient = Pick<PrismaService, 'priorityRuleConfig' | 'systemSetting' | 'engineerMaster'>;

export const DEFAULT_WEIGHT_SET = 'v1';
/** Suffix marking a PREVENTIVE-mode weight-set ref, derived from its DEFICIT/base counterpart. */
export const PREVENTIVE_SUFFIX = '_preventive';
const DEFAULT_CLUSTER_MULTIPLIER = 1.25;

/**
 * #268 — the config reads `RecommenderService` and the CRITICAL direct-assign sweep both need to
 * agree on, extracted for the same reason `committed-day-load.ts` and `candidate-readiness.ts` were:
 * two callers asking the identical question of the identical tables must get the identical answer, or
 * "same discipline" is a claim nobody can verify. `RecommenderService.activeWeights` layers its
 * PREVENTIVE-mode branch on top of {@link readBaseActiveWeights} rather than duplicating the base
 * read; intraday direct-assign — CRITICAL/HIGH_CRITICAL work, never backlog — uses only the base read,
 * deliberately never PREVENTIVE's repeat-failure-bonus/aged-device bias, which exists to redirect
 * attention toward backlog when a zone is *healthy* and would be a live contradiction on an active
 * emergency ticket. This is a scope decision #268's own text does not make, so it is recorded here
 * rather than silently inherited.
 */
export async function readBaseActiveWeights(
  prisma: ScoringConfigClient,
): Promise<{ weights: ScoringWeights; weightSetRef: string }> {
  const active = await prisma.priorityRuleConfig.findMany({ where: { active: true }, orderBy: { id: 'asc' } });
  const baseRef =
    active.find((r) => r.component === 'company_priority_rank' && !r.weightSetRef.endsWith(PREVENTIVE_SUFFIX))
      ?.weightSetRef ??
    active.find((r) => !r.weightSetRef.endsWith(PREVENTIVE_SUFFIX))?.weightSetRef ??
    DEFAULT_WEIGHT_SET;
  const weights: ScoringWeights = {};
  for (const r of active) if (r.weightSetRef === baseRef) weights[r.component] = Number(r.weight);
  return { weights, weightSetRef: baseRef };
}

/** The Plant Cluster Multiplier (#266) — one operator-configured setting, read the same way everywhere. */
export async function readPlantClusterMultiplier(prisma: ScoringConfigClient): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: 'plant_cluster_multiplier' } });
  const v = Number(row?.value);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CLUSTER_MULTIPLIER;
}

/** Every engineer's `daily_capacity` + `is_active`, keyed by `engineer_id` — the hard-filter's input. */
export async function readEngineerCapacity(
  prisma: ScoringConfigClient,
): Promise<Map<string, { dailyCapacity: number; isActive: boolean }>> {
  const rows = await prisma.engineerMaster.findMany({ select: { engineerId: true, dailyCapacity: true, isActive: true } });
  return new Map(rows.map((r) => [r.engineerId, { dailyCapacity: r.dailyCapacity, isActive: r.isActive }]));
}

/**
 * #267 — every engineer's admin-entered home base, keyed by `engineer_id`. An SE with either
 * coordinate NULL is simply absent from the map (never a fabricated `(0,0)`) — the recommender reads
 * an absent entry the same way it reads a plant with no geometry: NOT_AVAILABLE, 0 contribution,
 * never a drop. Not zone-scoped, matching {@link readEngineerCapacity}'s own scope: a floating/
 * multi-plant SE's home base is a global fact, not a per-zone one.
 */
export async function readEngineerHomeBases(prisma: ScoringConfigClient): Promise<Map<string, LatLng>> {
  const rows = await prisma.engineerMaster.findMany({ select: { engineerId: true, homeLat: true, homeLng: true } });
  const bases = new Map<string, LatLng>();
  for (const r of rows) {
    if (r.homeLat !== null && r.homeLng !== null) bases.set(r.engineerId, { lat: r.homeLat, lng: r.homeLng });
  }
  return bases;
}
