/**
 * **The per-term score breakdown** — slice C7 and §10.6.
 *
 * `scoreBreakdown` is computed by the recommender, persisted on every `recommendations` row, returned
 * by `GET /dispatch-runs/:runId/tickets/:ticketId/trace`, and **typed in the client and rendered
 * nowhere**. #266 landed the *numeric* score — the chosen engineer's, each runner-up's own, and the
 * `scoreDegenerate` explanation — but the terms that produced those numbers have been crossing the
 * wire and being dropped on the floor ever since. This panel is the whole of that fix; no backend
 * change is involved.
 *
 * **The arithmetic rendered here is the engine's, restated, not re-derived.** `scoring.ts` computes
 *
 * ```
 * baseScore = w_rank·rankScore + w_urgency·urgency − w_repeat·repeatPenalty
 *           + w_repeatBonus·repeatPenalty + w_age·ageScore + w_distance·distanceScore
 * score     = max(baseScore, 0) × clusterMultiplier
 * ```
 *
 * and each row below is one of those products. The panel shows the persisted feature and the
 * persisted weight side by side so the contribution is checkable rather than asserted — which is the
 * point of showing it at all.
 *
 * **Three rules this panel exists to honour:**
 *
 * 1. **A weight of zero is shown, not hidden.** A term that contributed nothing is a fact about how
 *    this zone is configured — `device_age` and `repeat_failure_bonus` are PREVENTIVE-mode components
 *    that default to 0 in the DEFICIT set, and an operator reading a Catch-up decision needs to see
 *    that they were not consulted. Dropping zero rows would make the two modes look identical.
 * 2. **The floor is shown when it bites.** `score` is `max(baseScore, 0) × clusterMultiplier`, so a
 *    negative `baseScore` is clamped before the cluster bonus multiplies it. When that happens the
 *    displayed score does not equal the sum of the rows, and the panel says why rather than leaving an
 *    operator to conclude the arithmetic is wrong.
 * 3. **`repeat_failure_penalty` is rendered as a term and never as a lever.** It is a live,
 *    OH-editable weight that changes no decision — it is a *ticket* property in a score that picks an
 *    *engineer*, so it shifts every candidate identically and cancels out. Showing what it contributed
 *    to this decision is honest; offering it as a control on a screen whose purpose is teaching would
 *    actively mis-teach, and the slice refuses it in §11.
 */

/** The recommender's weight keys, in the order `scoring.ts` applies them. */
const TERMS: {
  weightKey: string;
  label: string;
  /** The 0..1 feature this weight multiplies, as persisted in the breakdown. */
  featureKey: string;
  /** `repeat_failure_penalty` is the one term subtracted from the base. */
  sign: 1 | -1;
  what: string;
}[] = [
  {
    weightKey: 'company_priority_rank',
    label: 'Company priority',
    featureKey: 'rankScore',
    sign: 1,
    what: "the company's commercial rank, normalised",
  },
  {
    weightKey: 'dispatch_urgency',
    label: 'Dispatch urgency',
    featureKey: 'urgency',
    sign: 1,
    what: 'how urgently the vehicle needs the device back',
  },
  {
    weightKey: 'repeat_failure_penalty',
    label: 'Repeat-failure penalty',
    featureKey: 'repeatPenalty',
    sign: -1,
    what: 'subtracted for a repeatedly-failing device (Catch-up)',
  },
  {
    weightKey: 'repeat_failure_bonus',
    label: 'Repeat-failure bonus',
    featureKey: 'repeatPenalty',
    sign: 1,
    what: 'added instead of subtracted, in Steady mode',
  },
  {
    weightKey: 'device_age',
    label: 'Device age',
    featureKey: 'ageScore',
    sign: 1,
    what: 'hours silent, capped at 7 days (Steady mode)',
  },
  {
    weightKey: 'distance',
    label: 'Distance',
    featureKey: 'distanceScore',
    sign: 1,
    what: 'proximity to the engineer’s previous stop',
  },
];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function ScoreBreakdownPanel({
  breakdown,
  titled = true,
}: {
  breakdown: Record<string, unknown> | null;
  /**
   * Drops the panel's own "Score breakdown" caption — for the one caller that already names it, the
   * Inspector's disclosure, whose `<summary>` *is* the heading. The mode and weight-set line stays
   * either way: which weights produced these numbers is part of the reading, not decoration.
   */
  titled?: boolean;
}) {
  if (!breakdown) return null;

  // An unassignable decision persists a breakdown too, but it is a reason rather than a computation:
  // `{reason:'NO_ELIGIBLE_SE', mode, weightSetRef, …}` with no weights and no terms. Rendering an
  // empty score table for it would invent a comparison the engine never made.
  if (typeof breakdown.reason === 'string' && breakdown.weights === undefined) {
    return (
      <div data-testid="score-breakdown-none" className="text-[11px] text-ink-muted">
        No score was computed — {String(breakdown.reason) === 'NO_ELIGIBLE_SE' ? 'no engineer was eligible' : String(breakdown.reason)}.
      </div>
    );
  }

  const weights = (breakdown.weights ?? {}) as Record<string, unknown>;
  const baseScore = num(breakdown.baseScore);
  const clusterMultiplier = num(breakdown.clusterMultiplier);
  const score = num(breakdown.score);
  const distanceKm = breakdown.distanceKm;
  const mode = typeof breakdown.mode === 'string' ? breakdown.mode : null;
  const weightSetRef = typeof breakdown.weightSetRef === 'string' ? breakdown.weightSetRef : null;

  const rows = TERMS.map((t) => {
    const w = num(weights[t.weightKey]) ?? 0;
    const f = num(breakdown[t.featureKey]) ?? 0;
    return { ...t, weight: w, feature: f, contribution: t.sign * w * f };
  });

  const floored = baseScore !== null && baseScore < 0;

  return (
    <div data-testid="score-breakdown" className="text-[11px]">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-ink-muted">
        {titled && <span className="font-semibold uppercase tracking-wide">Score breakdown</span>}
        {/* UI§34.1 — the engine's enum names never reach a user-facing surface. */}
        {mode && <span>mode: {mode === 'DEFICIT' ? 'Catch-up' : mode === 'PREVENTIVE' ? 'Steady' : mode}</span>}
        {weightSetRef && <span>weights: {weightSetRef}</span>}
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-ink-muted">
            <th className="py-0.5 pr-2 font-medium">Term</th>
            <th className="py-0.5 pr-2 text-right font-medium">Value</th>
            <th className="py-0.5 pr-2 text-right font-medium">Weight</th>
            <th className="py-0.5 text-right font-medium">Contribution</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.weightKey}
              data-testid={`score-term-${r.weightKey}`}
              className={r.weight === 0 ? 'text-ink-muted' : 'text-ink'}
            >
              <td className="py-0.5 pr-2">
                <span title={r.what}>{r.label}</span>
                {r.weight === 0 && <span className="ml-1 text-[10px]">· not weighted here</span>}
              </td>
              <td className="py-0.5 pr-2 text-right tabular-nums">{r.feature.toFixed(3)}</td>
              <td className="py-0.5 pr-2 text-right tabular-nums">{r.weight.toFixed(2)}</td>
              <td className="py-0.5 text-right tabular-nums">
                {r.contribution >= 0 ? '+' : '−'}
                {Math.abs(r.contribution).toFixed(3)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-line">
          {baseScore !== null && (
            <tr>
              <td className="py-0.5 pr-2 font-medium text-ink" colSpan={3}>
                Base score
              </td>
              <td className="py-0.5 text-right tabular-nums text-ink">{baseScore.toFixed(3)}</td>
            </tr>
          )}
          {clusterMultiplier !== null && clusterMultiplier !== 1 && (
            <tr>
              <td className="py-0.5 pr-2 text-ink" colSpan={3}>
                Same-plant cluster bonus
              </td>
              <td className="py-0.5 text-right tabular-nums text-ink">×{clusterMultiplier.toFixed(2)}</td>
            </tr>
          )}
          {score !== null && (
            <tr>
              <td className="py-0.5 pr-2 font-semibold text-ink-strong" colSpan={3}>
                Score
              </td>
              <td className="py-0.5 text-right font-semibold tabular-nums text-ink-strong">
                {score.toFixed(3)}
              </td>
            </tr>
          )}
        </tfoot>
      </table>

      {floored && (
        <p data-testid="score-floored" className="mt-1 text-ink-muted">
          The base score was negative and is floored at zero before the cluster bonus is applied, so
          the score above is not the sum of the rows. The true base is shown so nothing is hidden.
        </p>
      )}

      {/* #267 — never a fabricated 0 km. NOT_AVAILABLE means no home base, no prior stop, or no plant
          geometry, and it is a different statement from "zero distance away". */}
      {distanceKm !== undefined && (
        <p className="mt-1 text-ink-muted">
          Distance from previous stop:{' '}
          {typeof distanceKm === 'number' ? `${distanceKm.toFixed(1)} km` : 'not available'}
        </p>
      )}
    </div>
  );
}
