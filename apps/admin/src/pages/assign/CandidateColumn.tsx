import {
  DROP_REASON_TEXT,
  TIER_LABEL,
  TIER_ORDER,
  type CandidateRow,
  type CoverageType,
  type PlantCandidates,
} from '../../api/candidates';
import { Badge, Button, LoadBadge } from '../../components/ui';
import { isOverCapacity } from '../../lib/capacity';
import { cn } from '../../lib/cn';
import { formatPlantDisplayName } from '../../lib/plantNames';

/** What a tier with nobody in it says. Named per tier, because the absence means different things. */
const EMPTY_TIER: Record<CoverageType, string> = {
  DEDICATED: 'No dedicated engineer for this plant.',
  MULTI_PLANT: 'No multi-plant engineer covers this plant.',
  FLOATING: 'No floating engineer is eligible here.',
};

export interface CandidateColumnProps {
  /** The plant the operator is working on; null before the pool has loaded. */
  plant: PlantCandidates | null;
  loading: boolean;
  /** Put this engineer on a lane holding the focused plant. Never disabled — see below. */
  onAssign: (seId: string) => void;
}

/**
 * **Candidates** — `orderedCandidatesForPlant` rendered honestly (#274, decision #272 R6).
 *
 * The engine's list arrives in strict precedence order and is displayed in **exactly** that order,
 * grouped under its tier headings. Nothing here re-sorts: not by name, not by load, not by "most
 * likely to say yes". The column's claim to the operator is that this is the order dispatch itself
 * walks, and #266 had to land first for that claim to be true at all.
 *
 * **Every tier heading renders, populated or not.** "No dedicated engineer for this plant" is what
 * makes the floating candidate below it legible as the fallback it is; a heading that disappeared
 * when empty would leave the operator to infer coverage from an absence.
 *
 * **Dropped candidates are shown, muted, with their reason — and remain assignable.** The engine's
 * verdict and the operator's authority are different things (#258 Q1/Q2): dispatch will not pick an
 * over-capacity or on-leave engineer, a human may, and the row says both. Nothing here is disabled,
 * because a front-end that greyed the row out would be quietly reinstating the gate Q2 removed.
 */
export function CandidateColumn({ plant, loading, onAssign }: CandidateColumnProps) {
  return (
    <section
      data-testid="candidate-column"
      className="rounded-card border border-line bg-surface-card p-3"
      aria-label="Candidates"
    >
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-strong">Candidates</h2>
        {plant && (
          <span data-testid="candidate-plant" className="truncate text-xs text-ink-muted">
            {formatPlantDisplayName(plant.plantName)}
          </span>
        )}
      </header>

      {!plant && (
        <p className="text-xs text-ink-muted">
          {loading ? 'Loading candidates…' : 'Pick a plant in the work pool to see who can cover it.'}
        </p>
      )}

      {plant && (
        <div className="space-y-3">
          {TIER_ORDER.map((tier) => {
            const rows = plant.candidates.filter((c) => c.coverageType === tier);
            return (
              <div key={tier} data-testid={`tier-${tier}`}>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-surface-sunken tabular-nums">
                    {TIER_ORDER.indexOf(tier) + 1}
                  </span>
                  {TIER_LABEL[tier]}
                </div>
                {rows.length === 0 ? (
                  <p className="px-1 text-[11px] text-ink-muted">{EMPTY_TIER[tier]}</p>
                ) : (
                  <ul className="space-y-1">
                    {rows.map((c) => (
                      <Candidate key={c.seId} candidate={c} onAssign={onAssign} />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Candidate({ candidate, onAssign }: { candidate: CandidateRow; onAssign: (seId: string) => void }) {
  const dropped = candidate.verdict === 'DROPPED';
  // Over capacity is read from the published figures with #269's one helper rather than from the drop
  // reason, so the marking survives an engineer who is over capacity *and* dropped for something the
  // filter reports first — `firstFailure` returns SE_UNAVAILABLE before OVER_CAPACITY, and the
  // operator still needs to see the load they would be adding to.
  const over =
    candidate.dailyCapacity !== null &&
    isOverCapacity({ committed: candidate.committed, dailyCapacity: candidate.dailyCapacity });

  return (
    <li
      data-testid={`candidate-${candidate.seId}`}
      data-se-id={candidate.seId}
      data-verdict={candidate.verdict}
      className={cn('rounded-md border border-line px-2 py-1.5 text-sm', dropped && 'bg-surface-sunken')}
    >
      <div className="flex items-center gap-2">
        <span className={cn('min-w-0 flex-1 truncate font-medium', dropped ? 'text-ink-muted' : 'text-ink-strong')}>
          {candidate.name ?? candidate.seId}
        </span>
        <LoadBadge
          seId={candidate.seId}
          committed={candidate.committed}
          dailyCapacity={candidate.dailyCapacity ?? undefined}
        />
        <Button size="sm" variant="ghost" onClick={() => onAssign(candidate.seId)}>
          Assign
        </Button>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1">
        {dropped ? (
          <Badge tone={candidate.dropReason === 'OVER_CAPACITY' ? 'warning' : 'critical'}>
            Dropped · {DROP_REASON_TEXT[candidate.dropReason!] ?? candidate.dropReason}
          </Badge>
        ) : (
          <Badge tone="success">Passed</Badge>
        )}
        {/* Q2, stated on the row rather than in a confirm dialog nobody reads. */}
        {over && (
          <span className="text-[11px] font-medium text-warning">over capacity — still assignable</span>
        )}
        {!candidate.kitComplete && !dropped && (
          <Badge tone="warning" title={candidate.missingKit.join(', ')}>
            Kit short ×{candidate.missingKit.length}
          </Badge>
        )}
        {candidate.availabilityStatus !== 'AVAILABLE' && (
          <span className="text-[11px] uppercase tracking-wide text-ink-muted">
            {candidate.availabilityStatus.replace(/_/g, ' ').toLowerCase()}
          </span>
        )}
      </div>
    </li>
  );
}
