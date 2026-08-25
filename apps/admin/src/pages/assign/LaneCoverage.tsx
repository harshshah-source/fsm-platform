import { TIER_LABEL, type CandidatesView, type CoverageType, type PlantCandidates } from '../../api/candidates';
import { Badge } from '../../components/ui';
import { isOverCapacity } from '../../lib/capacity';
import { cn } from '../../lib/cn';
import { formatPlantDisplayName } from '../../lib/plantNames';

/** Precedence as a number — lower is stronger. Mirrors the server's `tierRank`. */
const RANK: Record<CoverageType, number> = { DEDICATED: 1, MULTI_PLANT: 2, FLOATING: 3 };

export interface LaneCoverageFact {
  plantId: string;
  plantName: string;
  /** Null when the engineer is not a candidate for this plant at all — coverage, not tier, is missing. */
  coverageType: CoverageType | null;
  /**
   * The engineer's coverage here is weaker than a tier that is still **passing** at this plant, so a
   * human has overridden the engine's precedence (#272 R6). Never a block.
   */
  tierCrossing: boolean;
}

/**
 * What this engineer's coverage actually is, plant by plant, for the plants on their lane.
 *
 * **Per (engineer, plant) — decision #272 R4.** `AssignSePanel` shows `engineer_master.coverage_type`,
 * a single global value, which for a multi-plant engineer says nothing about whether they cover the
 * plants being assigned. The per-pair answer has always been in `se_coverage`; nothing rendered it.
 *
 * **A crossing is measured against the best *passing* tier, not against the tier list.** A floating
 * engineer taking a plant whose only dedicated candidate was dropped has overridden nothing — floating
 * is the top of the reachable list there. Marking that as a crossing would train the operator to
 * ignore the marking on the occasions it means something.
 */
export function laneCoverage(
  seId: string,
  plantIds: string[],
  candidates: CandidatesView | null,
  plantName: (plantId: string) => string,
): LaneCoverageFact[] {
  // Same defensiveness as the column: coverage badges are worth losing, the lane is not.
  const byPlant = new Map<string, PlantCandidates>((candidates?.plants ?? []).map((p) => [p.plantId, p]));
  return plantIds.map((plantId) => {
    const plant = byPlant.get(plantId);
    const mine = plant?.candidates.find((c) => c.seId === seId) ?? null;
    const bestPassing = plant?.candidates
      .filter((c) => c.verdict === 'PASSED')
      .reduce<number | null>((best, c) => (best === null ? RANK[c.coverageType] : Math.min(best, RANK[c.coverageType])), null);
    return {
      plantId,
      plantName: plant?.plantName ?? plantName(plantId),
      coverageType: mine?.coverageType ?? null,
      tierCrossing:
        mine !== null && bestPassing !== null && bestPassing !== undefined && RANK[mine.coverageType] > bestPassing,
    };
  });
}

/**
 * The lane header's coverage badges and load.
 *
 * The load reads `committed → after / capacity`: what the engineer carries now, what this draft would
 * take them to, and the cap. Nothing is written until commit, so the middle number is arithmetic over
 * the draft rather than a second read — which is exactly what makes the residual live.
 *
 * Amber at `after >= capacity`, matching #269's `isOverCapacity` and therefore the recommender's own
 * `OVER_CAPACITY` boundary. **A state, not a barrier** (#258 Q2): nothing here disables anything.
 */
export function LaneHeader({
  seId,
  coverage,
  committed,
  after,
  dailyCapacity,
}: {
  seId: string;
  coverage: LaneCoverageFact[];
  committed: number;
  after: number;
  dailyCapacity: number | null;
}) {
  const over = dailyCapacity !== null && isOverCapacity({ committed: after, dailyCapacity });
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {coverage.map((c) => (
        <Badge
          key={c.plantId}
          data-testid={`coverage-${seId}-${c.plantId}`}
          data-tier-crossing={String(c.tierCrossing)}
          // #290 — a crossing is **violet**, not amber. Amber is over-capacity and nothing else; using
          // it here said "this engineer is past their cap" about an engineer who may be well under it,
          // which is how a grammar stops being read at all. The token exists now
          // (`--color-tier-cross`, added with #285's provenance grammar), so the two boards finally
          // spell the same meaning the same way.
          tone={c.coverageType === null ? 'critical' : c.tierCrossing ? 'tierCross' : 'success'}
          // Dashed carries the meaning in grayscale — the colour is the second signal, never the only
          // one — and the state is exposed as data + title besides.
          className={cn(c.tierCrossing && 'border border-dashed border-tier-cross ring-0')}
          {...(c.tierCrossing ? { title: 'Tier crossing — a stronger tier is available and passing' } : {})}
        >
          {c.coverageType === null ? 'No coverage' : TIER_LABEL[c.coverageType].toUpperCase()} ·{' '}
          {formatPlantDisplayName(c.plantName)}
        </Badge>
      ))}

      <span
        data-testid={`lane-load-${seId}`}
        data-over-capacity={String(over)}
        // #290 — **amber**, not crimson. Crimson is critical work; over capacity is a state and an
        // administrative right (#258 Q2), and rendering it in the critical colour said the opposite of
        // what that ruling means.
        className={cn('ml-auto tabular-nums text-xs', over ? 'font-semibold text-warning' : 'text-ink-muted')}
        {...(over ? { title: 'This draft takes the engineer to or past capacity — still assignable' } : {})}
      >
        <span className="text-ink-muted">{committed} →</span> {after}
        {dailyCapacity !== null && <span className="text-ink-muted"> / {dailyCapacity}</span>}
      </span>
    </div>
  );
}
