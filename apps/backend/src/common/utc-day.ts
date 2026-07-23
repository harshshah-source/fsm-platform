/**
 * UTC midnight of the day containing `now` — the single coverage date a daily Day Plan is keyed on.
 *
 * Consolidated here by #146 slice 3, which needed a third copy. `recommender.service.ts` and
 * `dispatch-run.service.ts` had each grown their own identical private version; a deferral date gate
 * that disagreed with the dispatch day by even an hour would release deferred work early or hold it
 * an extra day, so the three call sites now share one definition rather than three that can drift.
 */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
