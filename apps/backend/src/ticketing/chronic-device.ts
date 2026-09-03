/**
 * **Chronic device** — how many recorded failure cycles make a unit worth questioning rather than
 * merely worth fixing (#284 Phase 3.4, published for the board by #295).
 *
 * The surface reads `CHR ×4` and asks a maintenance question — *replace this unit?* — which is
 * deliberately not a dispatch question: the Console's own copy says "dispatch treats these normally".
 *
 * ## Why this is its own constant and not `REPEAT_THRESHOLD`
 *
 * `RepeatEscalationService` holds a `REPEAT_THRESHOLD = 3` from ADR-0021, and it is tempting to
 * export that one number and be done. It answers a different question. That rule is **3 repeat
 * episodes within a rolling 7 days**, and crossing it *acts*: the device's live cycle and ticket are
 * driven to ESCALATED and managers are notified. This one is **lifetime cycles, no window**, and
 * crossing it only *says something* — a token on a card.
 *
 * Sharing a constant between a windowed action rule and a lifetime display rule would mean an
 * operator retuning escalation sensitivity silently repainted every board, and vice versa. That is
 * precisely the coupling `assignment-threshold.ts` refused when it split the dispatch dial from
 * `inactivity_threshold_hours`, and it is the same reason this repo's colour grammar forbids one hue
 * carrying two meanings.
 *
 * The two are numerically equal today, exactly as #238's dial shipped equal to its twin — so nothing
 * changes on the day this lands, and either can move later without dragging the other with it. If the
 * chronic badge ever needs to be operator-tunable it becomes a settings key here, next to this
 * comment, and not by widening ADR-0021's rule.
 */
export const CHRONIC_FAILURE_CYCLE_THRESHOLD = 3;
