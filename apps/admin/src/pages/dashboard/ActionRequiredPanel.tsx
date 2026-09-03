import { Link } from 'react-router-dom';
import type { ActionRequiredCard } from '../../api/dashboard';
import { destinationFor } from '../../lib/actionRequiredDestinations';
import { Card } from '../../components/ui';
import { cn } from '../../lib/cn';

/**
 * Action Required panel (Issue 06 AC#1 · FE-06 · completed by **#350**). Urgency-ordered card grid;
 * the backend returns the cards already sorted by ascending urgency.
 *
 * **Every card is a door.** #350's finding was that the panel was the dashboard's front door and most
 * of it was painted shut: five of the nine sources had never been counted (the card read "coming
 * soon"), and the four that did carry a number were inert — a count with no way to act on it. Each card
 * is now a `Link` to the surface that lists exactly those rows, resolved through
 * `lib/actionRequiredDestinations` — the same map the Scheduler Console's attention band reads, so the
 * two surfaces cannot come to disagree about where a manager goes to do the same job.
 *
 * **A stub is still not a zero.** Nothing renders the unwired branch today (all nine sources are
 * counted), but it survives, because the day a tenth card is added ahead of its source, "not counted
 * yet" and "0" are opposite statements and only one of them is true. It no longer says "coming soon",
 * which read as a product promise rather than as the measurement gap it was.
 *
 * The `action-card` selector contract and the urgency ordering are preserved from FE-06.
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
        {ordered.map((c) => {
          const dest = destinationFor(c.key);
          // The count and the label are one link target, so the whole card is the affordance and the
          // accessible name says which queue it opens — never a bare "0" announced with no subject.
          const body = (
            <>
              <div className="text-[11px] font-semibold uppercase leading-tight tracking-wide text-ink-caps">
                {c.label}
              </div>
              {c.available ? (
                <div className="mt-2 text-2xl font-bold text-ink-strong">{c.count}</div>
              ) : (
                <div className="mt-2 text-xs italic text-ink-muted">not counted yet</div>
              )}
              {dest && (
                <div className="mt-1 text-[11px] text-link">{dest.verb} →</div>
              )}
            </>
          );

          return (
            <li key={c.key}>
              <Card
                data-testid="action-card"
                className={cn(
                  'relative h-full overflow-hidden p-4',
                  'before:absolute before:inset-y-0 before:left-0 before:w-1',
                  c.available ? 'before:bg-brand-600' : 'before:bg-line-strong',
                  !c.available && 'opacity-70',
                  dest && 'transition-colors hover:bg-surface-sunken',
                )}
              >
                {dest ? (
                  <Link
                    to={dest.to}
                    aria-label={`${c.label} — ${dest.verb}`}
                    className="block pl-1.5 focus-ring"
                  >
                    {body}
                  </Link>
                ) : (
                  // A count with no destination, said out loud rather than dressed up as a link.
                  <div className="pl-1.5">
                    {body}
                    <div className="mt-1 text-[11px] text-ink-muted">no queue page yet</div>
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
