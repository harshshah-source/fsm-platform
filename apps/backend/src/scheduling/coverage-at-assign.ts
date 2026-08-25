import { Prisma } from '../generated/prisma/client';
import { COVERAGE_AT_ASSIGN, type CoverageAtAssign } from './add-source';

/**
 * What coverage the chosen SE had of this plant, at the moment the assignment was written (#283).
 *
 * **Why stamped and not derived later.** `se_coverage` is mutable and **hard-deleted** on removal
 * (`schema.prisma:305-318`; only an `SE_COVERAGE_REMOVED` audit row survives), and the FLOATING leg
 * depends on a materialized view refreshed on territory edits (#138). A lookup run next week
 * therefore answers a different question than "what was true when this was assigned" — which is the
 * question the dashed-violet tier-crossing signal in the approved grammar actually asks (#282 R2).
 *
 * **Why it mirrors `orderedCandidatesForPlant` rather than calling it.** That service returns the
 * whole ordered candidate list for a plant — two queries, built for choosing among many. Here the SE
 * is already chosen and the question is a single membership test, so this is one indexed lookup on
 * the existing `se_coverage` `@@unique([seId, plantId])`, with the MV consulted only when the row is
 * absent. The FLOATING leg re-validates against `engineer_master` exactly as #138 requires, for the
 * same reason: the MV alone would resurrect a now-DEDICATED or deactivated SE.
 *
 * Runs against the caller's transaction client, so the recorded value is consistent with the write
 * it accompanies rather than with a moment slightly before or after it.
 */
export async function resolveCoverageAtAssign(
  tx: Prisma.TransactionClient,
  seId: string,
  plantId: bigint,
): Promise<CoverageAtAssign> {
  const covered = await tx.seCoverage.findUnique({
    where: { seId_plantId: { seId, plantId } },
    select: { coverageType: true },
  });
  if (covered?.coverageType === 'DEDICATED') return COVERAGE_AT_ASSIGN.DEDICATED;
  if (covered?.coverageType === 'MULTI_PLANT') return COVERAGE_AT_ASSIGN.MULTI_PLANT;
  if (covered?.coverageType === 'FLOATING') return COVERAGE_AT_ASSIGN.FLOATING;

  const floating = await tx.$queryRaw<{ se_id: string }[]>(
    Prisma.sql`
      SELECT pefs.se_id
      FROM plant_eligible_floating_se pefs
      JOIN engineer_master em ON em.engineer_id = pefs.se_id
      WHERE pefs.plant_id = ${plantId}
        AND pefs.se_id = ${seId}::uuid
        AND em.coverage_type = 'FLOATING'
        AND em.is_active = true
      LIMIT 1`,
  );
  if (floating.length > 0) return COVERAGE_AT_ASSIGN.FLOATING;

  // Covered in no tier at all. Not an error: a manager may assign outside the engine's candidate set
  // (#272 R6 permits and marks tier crossing), and calling that FLOATING would be a fabrication.
  return COVERAGE_AT_ASSIGN.NONE;
}

/**
 * The same answer for a whole lane, in one pass per distinct plant.
 *
 * `assignLane` writes ticket-by-ticket inside one transaction, so a naive per-ticket resolve would
 * multiply queries by the lane size for an answer that only varies by plant. Callers resolve once per
 * distinct plant and read from the returned map.
 */
export async function resolveCoverageForPlants(
  tx: Prisma.TransactionClient,
  seId: string,
  plantIds: readonly bigint[],
): Promise<Map<string, CoverageAtAssign>> {
  const out = new Map<string, CoverageAtAssign>();
  for (const plantId of new Set(plantIds.map((p) => String(p)))) {
    out.set(plantId, await resolveCoverageAtAssign(tx, seId, BigInt(plantId)));
  }
  return out;
}
