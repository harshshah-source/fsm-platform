import { type CapacityLoad, formatLoad, isOverCapacity } from '../../lib/capacity';
import { Badge } from './Badge';

export interface LoadBadgeProps extends Partial<CapacityLoad> {
  /** Used only for the `load-<seId>` test id, so a grid row can be addressed by engineer. */
  seId?: string;
}

/**
 * `committed / dailyCapacity` for one engineer — #269's badge, the one shown wherever a manager can
 * put work on somebody (SE Planner grid `LOAD / CAP` column per v2 reference 16, the SE directory,
 * the assign panels).
 *
 * **Visibility, not a gate.** Over capacity is marked and nothing more: #258 Q2 rules manual overload
 * an administrative right, so no surface rendering this badge may disable, block or demand a
 * confirmation for the engineer it marks. The badge's job is to make the decision a *seen* one.
 *
 * The state is exposed as `data-over-capacity` and as a `title`, not by tone alone — a colour-only
 * treatment tells a screen reader nothing, and it makes tests assert a class name where they should
 * be asserting a meaning.
 *
 * An engineer whose `dailyCapacity` was never set renders their bare load with no denominator and no
 * marking, rather than being painted permanently overloaded by a missing master-data field.
 */
export function LoadBadge({ committed, dailyCapacity, seId }: LoadBadgeProps) {
  if (typeof committed !== 'number') return null;
  const testId = seId ? { 'data-testid': `load-${seId}` } : {};

  if (typeof dailyCapacity !== 'number' || dailyCapacity <= 0) {
    return (
      <span {...testId} data-over-capacity="false" className="tabular-nums text-ink-muted">
        {committed}
      </span>
    );
  }

  const load = { committed, dailyCapacity };
  const over = isOverCapacity(load);
  return (
    <span {...testId} data-over-capacity={String(over)}>
      <Badge
        tone={over ? 'critical' : 'neutral'}
        className="tabular-nums"
        {...(over ? { title: 'At or over capacity — assignment is still allowed' } : {})}
      >
        {formatLoad(load)}
      </Badge>
    </span>
  );
}
