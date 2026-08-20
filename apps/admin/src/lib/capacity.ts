/**
 * The `n / cap` vocabulary — #269.
 *
 * `dailyCapacity` shipped on `ZoneEngineer` and `EngineerListRow` with Issue 13b and was rendered in
 * **zero** places, because nothing supplied a numerator: an overload today was discoverable only by
 * counting an SE's batch rows by hand. #269 supplies `committed` from the single backend definition
 * (`scheduling/committed-day-load.ts`) that the recommender itself enforces against, and every surface
 * where a manager assigns or reviews work now reads it the same way.
 *
 * **One helper, because "over capacity" must mean one thing.** The planner grid, the Critical-queue
 * picker, the Swap/Reassign/Split target picker, the commissioning-cohort assign and the SE directory
 * all ask the same question, and a surface that answered it with its own inline `>` would be the
 * front-end half of exactly the fork #269 spent its backend slice closing.
 */

/** The two fields every capacity-bearing row carries; deliberately structural, not a named type. */
export interface CapacityLoad {
  committed: number;
  dailyCapacity: number;
}

/**
 * Is the engine full for this engineer?
 *
 * **`>=`, not `>`.** The recommender drops a candidate at `used >= dailyCapacity`
 * (`recommender.service.ts` → `hard-filters.ts` `OVER_CAPACITY`), so an SE at exactly `6/6` is one no
 * automatic path will add to. #269's prose says `n > cap`, but its own acceptance criterion — the
 * displayed figure equals the recommender's own count — settles it here: showing `6/6` as having room
 * would put the badge back in disagreement with the enforcement it exists to mirror.
 *
 * A capacity of 0 or less is treated as unset rather than as "always full" — no engineer should be
 * painted permanently overloaded because their master row was never given a number.
 */
export function isOverCapacity({ committed, dailyCapacity }: CapacityLoad): boolean {
  return dailyCapacity > 0 && committed >= dailyCapacity;
}

/** `4/6` — the compact form for a table cell or a badge. */
export function formatLoad({ committed, dailyCapacity }: CapacityLoad): string {
  return `${committed}/${dailyCapacity}`;
}

/**
 * The engineer's name with their load appended — the form for an `<option>`, which cannot carry a
 * badge, a colour or a nested element of any kind. The over-capacity case is therefore spelled out in
 * words rather than shown: a picker that marked it only by colour would say nothing at all here.
 *
 * The option stays **selectable** either way (#258 Q2 — overload is an administrative right, never a
 * gate); this text is the whole of the treatment.
 */
export function engineerOptionLabel(
  engineer: { name?: string | null; engineerId: string } & Partial<CapacityLoad>,
): string {
  const name = engineer.name ?? engineer.engineerId;
  if (typeof engineer.committed !== 'number' || typeof engineer.dailyCapacity !== 'number') return name;
  const load = formatLoad({ committed: engineer.committed, dailyCapacity: engineer.dailyCapacity });
  return isOverCapacity({ committed: engineer.committed, dailyCapacity: engineer.dailyCapacity })
    ? `${name} — ${load} · over capacity`
    : `${name} — ${load}`;
}
