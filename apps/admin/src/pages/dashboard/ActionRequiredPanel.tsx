import type { ActionRequiredCard } from '../../api/dashboard';

/**
 * Action Required panel (Issue 06 AC#1). Urgency-ordered cards; each card whose source is not yet
 * built renders as a graceful "coming soon" stub, and lights up with its real count once the owning
 * issue wires it. Backend returns the cards already sorted by ascending urgency.
 */
export function ActionRequiredPanel({ cards }: { cards: ActionRequiredCard[] }) {
  const ordered = [...cards].sort((a, b) => a.urgency - b.urgency);

  return (
    <section aria-labelledby="action-required-heading" className="mb-8">
      <h3 id="action-required-heading" className="mb-2 text-lg font-semibold">
        Action Required
      </h3>
      <ul className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {ordered.map((c) => (
          <li
            key={c.key}
            data-testid="action-card"
            className={`rounded border p-3 ${c.available ? 'bg-white' : 'bg-slate-50 text-slate-400'}`}
          >
            <div className="text-sm font-medium">{c.label}</div>
            {c.available ? (
              <div className="mt-1 text-2xl font-semibold">{c.count}</div>
            ) : (
              <div className="mt-1 text-xs italic">coming soon</div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
