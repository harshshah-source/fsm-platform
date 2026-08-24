import { Link } from 'react-router-dom';

/**
 * #281 AC2/AC8 (#280 R1/R2/R8/R9) — the one visible sentence that says which question a dispatch
 * surface answers, and where the other three questions live.
 *
 * **Why this exists at all.** `PageHeader` renders screen-reader-only, so the subtitle each of these
 * four pages already carries reaches nobody looking at the screen. The navigation-IA audit's finding
 * was that a new Zonal Manager cannot rank the four dispatch nouns; a heading in the sidebar ranks
 * them, but only the page itself can say what it is — and, critically, what it is *not*.
 *
 * **Why it is prose and not a tab strip.** #280 R8 rejected a tab-like control over one shared
 * header outright: a segmented control asserts that the views are interchangeable slides of one
 * dataset, which is exactly the error #280 R2 forbids — an operator must never read a projection as
 * a commitment. So each surface states its own question in full, the current view is never rendered
 * as one of the choices, and every sibling link is labelled with the *question* it moves to rather
 * than with a bare page name. The cross-view mechanism #280 R8 actually ruled — contextual,
 * per-record links — lives on the pages themselves (an SE's row links to that SE's record on the
 * sibling view); this note is the orientation those links are read against, not a substitute for
 * them.
 *
 * Intra-day is deliberately described as changes to today's plan rather than a fourth tense
 * (#280 R9): it hangs off Schedules, and the copy here says so in the same words the sidebar does.
 */
export type DispatchTimelinePosition = 'future' | 'present' | 'intraday' | 'past';

interface Surface {
  /** The tense chip. Intra-day gets no tense of its own — R9. */
  tense: string;
  to: string;
  /** What this surface answers, in full, on its own page. */
  statement: string;
  /** How a *sibling* names it: the question a link to it moves to. */
  question: string;
}

const SURFACES: Record<DispatchTimelinePosition, Surface> = {
  future: {
    tense: 'Future',
    to: '/schedules/preview',
    statement:
      'What the next dispatch run would do for the selected date. This is a projection: nothing here is committed, and the run re-evaluates everything when it fires.',
    question: 'what the next run would do',
  },
  present: {
    tense: 'Present',
    to: '/schedules',
    statement:
      "What today's run actually committed — one day plan per Service Engineer. These are live plans, and a Zonal Manager can still override them.",
    question: 'what is committed today',
  },
  intraday: {
    // Not a tense. #280 R9: the record of changes to the present, subordinate to Schedules.
    tense: "Changes to today's plan",
    to: '/intraday',
    statement:
      "Every change made to today's committed day plans after dispatch — same-day Zonal-Manager updates and system CRITICAL assignments. It is not a run of its own.",
    question: "what changed on today's plans",
  },
  past: {
    tense: 'Past',
    to: '/dispatch-runs',
    statement:
      'The ledger of dispatch runs that have already happened, and the configuration each ran under. Read-only: a record of decisions already taken, not a plan you can edit.',
    question: 'what past runs did',
  },
};

/** Timeline reading order. Intra-day sits after Schedules because it is a view OF Schedules. */
const ORDER: DispatchTimelinePosition[] = ['future', 'present', 'intraday', 'past'];

export function DispatchTimelineNote({ position }: { position: DispatchTimelinePosition }) {
  const self = SURFACES[position];
  const siblings = ORDER.filter((p) => p !== position);

  return (
    <div
      data-testid="dispatch-timeline-note"
      className="mb-4 rounded-lg border border-line bg-surface-alt px-3 py-2 text-sm"
    >
      <p className="text-ink">
        <span
          data-testid="dispatch-timeline-tense"
          className="mr-2 inline-flex items-center rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted"
        >
          {self.tense}
        </span>
        {self.statement}
      </p>
      <p className="mt-1.5 text-xs text-ink-muted">
        Elsewhere on the dispatch timeline:{' '}
        {siblings.map((p, i) => (
          <span key={p}>
            {i > 0 && <span aria-hidden> · </span>}
            <Link to={SURFACES[p].to} className="text-link hover:underline">
              {SURFACES[p].question}
            </Link>
          </span>
        ))}
      </p>
    </div>
  );
}
