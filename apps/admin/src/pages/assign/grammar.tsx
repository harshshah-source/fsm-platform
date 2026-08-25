/**
 * The Assign Work Console's visual grammar (#290, decision #272's non-negotiable table).
 *
 * | Meaning | Form |
 * |---|---|
 * | Assignment inside the engineer's own coverage | solid border + dot |
 * | A human crossed a coverage tier | dashed border, violet |
 * | Critical work | heavy crimson border + flag |
 * | Over capacity | amber lane treatment — a state, never a barrier |
 *
 * **One colour, one meaning.** Amber is over capacity. Crimson is critical. Violet is a human
 * crossing a coverage tier. The console shipped with the first two swapped — over capacity in crimson,
 * a crossing in amber — which is worse than no grammar at all: an operator scanning lanes could not
 * tell "past their cap" from "this is on a clock", and those two prompt opposite actions.
 *
 * **Every meaning survives grayscale.** Colour is the second signal; the first is *shape* — solid 1px,
 * dashed, solid 2px, three distinct borders — and there is a test that asserts the three cannot
 * collapse into two.
 *
 * It lives beside the lanes rather than inside them so the legend and the chips are drawn from **one**
 * definition. A legend that describes a grammar the chips no longer use is worse than no legend.
 */
import { cn } from '../../lib/cn';

/** What a chip is saying about the work it holds. Exactly one applies. */
export type ChipMeaning = 'OWN_COVERAGE' | 'TIER_CROSSING' | 'CRITICAL' | 'NO_COVERAGE';

/**
 * The border treatment for each meaning. Read as a table on purpose: this is the grammar, and it has
 * to be changeable in one place or it will drift the moment a fifth meaning is added.
 */
export const CHIP_FORM: Record<ChipMeaning, string> = {
  OWN_COVERAGE: 'border border-line-strong text-ink',
  TIER_CROSSING: 'border border-dashed border-tier-cross text-tier-cross',
  CRITICAL: 'border-2 border-critical text-critical font-semibold',
  // The engineer covers this plant at no tier at all. Crimson, because it is the same class of
  // problem as critical work — somebody has to act — but dashed, so it never reads as critical work.
  NO_COVERAGE: 'border border-dashed border-critical text-critical',
};

/** The plain sentence each form means, reused verbatim by the chip's title and by the legend. */
export const CHIP_MEANING_LABEL: Record<ChipMeaning, string> = {
  OWN_COVERAGE: "inside the engineer's own coverage",
  TIER_CROSSING: 'a human crossed a coverage tier',
  CRITICAL: 'critical work',
  NO_COVERAGE: 'the engineer covers this plant at no tier',
};

/**
 * Which meaning a chip carries. Critical wins, because it is the one an operator must not miss: a
 * critical chip on a crossed tier is still first a piece of work on a clock, and the crossing is
 * already said by the lane's own coverage badge.
 */
export function chipMeaning(opts: { critical: boolean; tierCrossing: boolean; noCoverage: boolean }): ChipMeaning {
  if (opts.critical) return 'CRITICAL';
  if (opts.noCoverage) return 'NO_COVERAGE';
  if (opts.tierCrossing) return 'TIER_CROSSING';
  return 'OWN_COVERAGE';
}

/**
 * The three-swatch legend the design puts beneath the lanes.
 *
 * Rendered from `CHIP_FORM` rather than from its own copy of the classes, so a swatch cannot describe
 * a border the chips stopped using. `NO_COVERAGE` is deliberately absent: the rail it appears in
 * already labels itself in words, and a four-swatch legend for a three-meaning grammar reads as four
 * things to learn.
 */
export function GrammarLegend({ className }: { className?: string }) {
  const swatches: { id: string; meaning: ChipMeaning; text: string }[] = [
    { id: 'swatch-own', meaning: 'OWN_COVERAGE', text: `solid — assignment ${CHIP_MEANING_LABEL.OWN_COVERAGE}` },
    { id: 'swatch-crossing', meaning: 'TIER_CROSSING', text: `dashed — ${CHIP_MEANING_LABEL.TIER_CROSSING}` },
    { id: 'swatch-critical', meaning: 'CRITICAL', text: `heavy crimson — ${CHIP_MEANING_LABEL.CRITICAL}` },
  ];
  return (
    <div
      data-testid="grammar-legend"
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md bg-surface-sunken px-3 py-2 text-[10px] text-ink-muted',
        className,
      )}
    >
      {swatches.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            data-testid={s.id}
            className={cn('h-3 w-5 shrink-0 rounded-sm bg-surface', CHIP_FORM[s.meaning])}
          />
          {s.text}
        </span>
      ))}
    </div>
  );
}
