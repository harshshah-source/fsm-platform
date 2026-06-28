import type { ActionRequiredCard } from '../../api/dashboard';
import { Card } from '../../components/ui';
import { cn } from '../../lib/cn';

/**
 * Action Required panel (Issue 06 AC#1 · FE-06). Urgency-ordered reference card grid; each card whose
 * source is not yet built renders as a graceful "coming soon" stub and lights up with its real count
 * once the owning issue wires it. Backend returns the cards already sorted by ascending urgency.
 *
 * Presentation-only refactor (FE-06): the live data, ordering, and the `action-card` selector contract
 * are preserved — only the markup is re-skinned to the enterprise card grid.
 */
export function ActionRequiredPanel({ cards }: { cards: ActionRequiredCard[] }) {
  const ordered = [...cards].sort((a, b) => a.urgency - b.urgency);

  return (
    <section aria-labelledby="action-required-heading" className="mb-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h3
          id="action-required-heading"
          className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
        >
          Action Required
        </h3>
        <span className="text-xs text-ink-muted">{ordered.length} sources</span>
      </div>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {ordered.map((c) => (
          <li key={c.key}>
            <Card
              data-testid="action-card"
              className={cn(
                'relative h-full overflow-hidden p-4',
                'before:absolute before:inset-y-0 before:left-0 before:w-1',
                c.available ? 'before:bg-brand-600' : 'before:bg-line-strong',
                !c.available && 'opacity-70',
              )}
            >
              <div className="pl-1.5">
                <div className="text-[11px] font-semibold uppercase leading-tight tracking-wide text-ink-caps">
                  {c.label}
                </div>
                {c.available ? (
                  <div className="mt-2 text-2xl font-bold text-ink-strong">{c.count}</div>
                ) : (
                  <div className="mt-2 text-xs italic text-ink-muted">coming soon</div>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
