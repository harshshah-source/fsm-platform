import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiActionRequired, type ActionRequiredCard } from '../../../api/dashboard';
import { Badge } from '../../../components/ui';
import { ACTION_REQUIRED_DESTINATIONS } from '../../../lib/actionRequiredDestinations';
import { cn } from '../../../lib/cn';

/**
 * **ATTENTION — what needs me, ranked** (Phase 3.2, recomposed per the correction §11).
 *
 * The composition changed — a compact **top-bar strip** that expands into the **right rail**, where
 * the old build gave it a full-width band at the very bottom that the field-ops review found
 * unreadably positioned — but every rule from Phase 3.2 is kept verbatim:
 *
 * 1. **One definition of "what needs a manager".** This reads `dashboard/action-required`, the same
 *    nine urgency-ordered cards the dashboard renders. A Console-local queue would drift from it the
 *    day either changed.
 * 2. **Co-scoped with the deck (B5).** `zoneId` is passed; a CSM sees this zone's counts beside this
 *    zone's board, never a national number under a zone's heading.
 * 3. **A stub is not a zero.** `available: false` renders as *not counted yet*, sorted below the
 *    live cards — never as "0", which would report the absence of a counter as the absence of work.
 * 4. **Every item names its owner and one action**; a live count with no destination page says
 *    "no queue page yet" rather than inventing a link.
 */

/**
 * Where the work for each card actually lives — moved to `lib/actionRequiredDestinations` by **#350**,
 * which needed the same answer on the dashboard's Action Required panel. Behaviour here is unchanged:
 * absent still means no destination exists yet, and the row still says so.
 */
const CARD_DESTINATION = ACTION_REQUIRED_DESTINATIONS;

export interface AttentionState {
  cards: ActionRequiredCard[] | null;
  failed: boolean;
}

/**
 * One fetch, shared by the strip and the rail — two renderings of one answer, never two answers.
 *
 * `undefined` suspends the fetch: until the deck's payload names the zone, there is no zone to
 * co-scope with (B5), and firing with an empty id would ask the global question the whole rule
 * exists to prevent — then answer it under the zone's heading a moment later.
 */
export function useActionRequired(zoneId: string | undefined): AttentionState {
  const [cards, setCards] = useState<ActionRequiredCard[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!zoneId) return;
    let live = true;
    setCards(null);
    setFailed(false);
    void apiActionRequired(zoneId)
      .then((c) => live && setCards(c))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [zoneId]);

  return { cards, failed };
}

/**
 * The top-bar strip: total plus the two largest categories, and the door to the rail list.
 * `⚠ 6 need attention · 3 chronic · 2 approvals ▸`
 */
export function AttentionStrip({
  state,
  expanded,
  onToggle,
}: {
  state: AttentionState;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (state.failed) {
    return <span className="text-[11px] text-ink-muted">attention queue unavailable</span>;
  }
  if (!state.cards) return null;

  const live = state.cards.filter((c) => c.available && c.count > 0).sort((a, b) => a.urgency - b.urgency);
  const total = live.reduce((n, c) => n + c.count, 0);
  const top = live.slice(0, 2);

  return (
    <button
      type="button"
      data-testid="attention-strip"
      aria-expanded={expanded}
      onClick={onToggle}
      className={cn(
        // Same shape and same hover as the frame's other secondary controls (`FRAME_CONTROL` in
        // TodaysDispatchPage); only the colour departs, and only when it has something to say.
        'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors',
        total > 0
          ? 'border-warning bg-warning-bg/30 text-ink hover:bg-warning-bg/50'
          : 'border-line text-ink-muted hover:bg-surface-sunken hover:text-ink',
        expanded && 'ring-1 ring-brand-600',
      )}
    >
      <span aria-hidden>{total > 0 ? '⚠' : '✓'}</span>
      <span className="tabular-nums font-semibold">{total}</span>
      {total === 1 ? 'needs attention' : 'need attention'}
      {top.map((c) => (
        <span key={c.key} className="hidden text-ink-muted sm:inline">
          · {c.count} {c.label.toLowerCase().slice(0, 24)}
        </span>
      ))}
      <span aria-hidden>{expanded ? '▾' : '▸'}</span>
    </button>
  );
}

/** The rail occupant — the full ranked list, sharing the right-rail slot with the Work Pool. */
export function AttentionRail({
  state,
  zoneName,
  onClose,
}: {
  state: AttentionState;
  zoneName: string;
  onClose: () => void;
}) {
  const { cards, failed } = state;

  return (
    <section
      data-testid="console-attention"
      aria-label="Needs attention"
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
    >
      <h2 className="flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        Needs attention
        {/* Stated on the band, because the whole point of B5 is that these counts are this zone's. */}
        <span className="font-normal normal-case tracking-normal">{zoneName}</span>
      </h2>
      <button type="button" data-testid="rail-back-to-pool" onClick={onClose} className="self-start text-[11px] text-link">
        ‹ Back to work pool
      </button>

      {failed ? (
        <p className="text-[11px] text-ink-muted">
          The attention queue could not be loaded. The board is unaffected.
        </p>
      ) : !cards ? null : (
        <AttentionList cards={cards} zoneName={zoneName} />
      )}
    </section>
  );
}

function AttentionList({ cards, zoneName }: { cards: ActionRequiredCard[]; zoneName: string }) {
  // Live cards with work first, in the urgency order the endpoint already ranks them by; then live
  // cards that are genuinely clear; then the unwired ones, which are a different statement entirely.
  const live = cards.filter((c) => c.available);
  const needsAttention = live.filter((c) => c.count > 0).sort((a, b) => a.urgency - b.urgency);
  const clear = live.filter((c) => c.count === 0);
  const stubs = cards.filter((c) => !c.available);

  return (
    <>
      {needsAttention.length === 0 ? (
        <p data-testid="attention-clear" className="text-[11px] text-ink-muted">
          Nothing in {zoneName} is waiting on a manager right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {needsAttention.map((c) => {
            const dest = CARD_DESTINATION[c.key];
            return (
              <li
                key={c.key}
                data-testid={`attention-${c.key}`}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2 py-1.5 text-[11px]"
              >
                <span className="tabular-nums text-sm font-semibold text-ink">{c.count}</span>
                <span className="min-w-0 flex-1 text-ink">{c.label}</span>
                {dest ? (
                  <Link to={dest.to} className="text-link">
                    {dest.verb} →
                  </Link>
                ) : (
                  // A count with no verb, said out loud rather than dressed up as one.
                  <span className="text-ink-muted">no queue page yet</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {clear.length > 0 && needsAttention.length > 0 && (
        <p className="text-[10px] text-ink-muted">Clear: {clear.map((c) => c.label).join(' · ')}</p>
      )}

      {stubs.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[10px] text-ink-muted" data-testid="attention-stubs">
            {stubs.length} {stubs.length === 1 ? 'category is' : 'categories are'} not counted yet
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {stubs.map((c) => (
              <li key={c.key} className="flex items-center gap-2 text-[10px] text-ink-muted">
                <Badge tone="neutral">not counted</Badge>
                <span>{c.label}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
