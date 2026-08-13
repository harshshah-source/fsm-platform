/**
 * Commissioning view configuration — the time-to-first-report epoch and the window ceilings.
 *
 * Kept a pure function of `env` (no `@nestjs/config`, matching `ops-explorer.config.ts` and
 * `boot-config.ts`) so it is directly unit-testable and needs no DI plumbing to evaluate.
 */

/**
 * The instant `device_states.first_reported_at` began being written, i.e. the first telemetry tick
 * after the column shipped (migration `20260809120000_device_commissioning`).
 *
 * **Why this has to exist.** The column is filled write-once by
 * `COALESCE(device_states.first_reported_at, EXCLUDED.latest_gps_datetime)`. For a device that was
 * ALREADY reporting when the column landed, that first COALESCE captured whatever `latest_gps_datetime`
 * happened to be at the time — a LAST-seen value wearing a first-seen name. Measured on the dev mirror:
 * 15,345 of 23,086 populated values are stamped on the single day the column shipped, the minimum is
 * 2024-01-07 (a device whose last ping was in 2024), and 2,138 rows carry a stamp EARLIER than their own
 * `installed_at`. Time-to-first-report over that population has a median of ~8,707 hours (≈363 days)
 * versus 17.26 hours for fitments observed after the epoch.
 *
 * So a fitment from before this instant can be counted as an install and as online, but its TTFR is a
 * measurement of the epoch rather than of the install, and must be excluded from every timing sample.
 * Never-online remains meaningful across the whole history — a null stamp means the device has not
 * pinged at all since the epoch, which is exactly the "broken, not slow" population.
 *
 * Configurable because a future re-baseline (a backfill, a fresh mirror) moves it, and that must be an
 * operator change rather than a code change.
 */
export const DEFAULT_TTFR_EPOCH = '2026-08-09T00:00:00.000Z';

/**
 * Request-window ceilings. These are a performance contract, not taste.
 *
 * Measured on the dev mirror (24,294 rows) and on a 242,940-row fixture ≈4× the one-year projection at
 * the observed 97.3 fitments/day: every *bounded* shape keeps the same plan — bitmap index scan on
 * `device_commissioning_installed_at_idx`, then hash joins — at 6.8 ms / 9.7 ms today and 62.7 ms /
 * 172.1 ms at that scale. The one shape that changes plan is an UNBOUNDED lookback: the planner
 * abandons the index for a sequential scan and the `GROUP BY` spills to disk (measured 1,078 ms with a
 * 9.5 MB external merge sort). No index fixes that — three candidate indexes were measured and the best
 * bought 9%, because the cost is the sort forced by the `count(DISTINCT …)` aggregates, not the access
 * path. The ceiling is what keeps that plan unreachable.
 */
export const COHORT_DAYS = { min: 1, max: 90, fallback: 7 } as const;
export const GRACE_HOURS = { min: 1, max: 720, fallback: 48 } as const;
export const LOOKBACK_DAYS = { min: 1, max: 365, fallback: 30 } as const;

export interface CommissioningConfig {
  /** Fitments observed before this instant contribute to counts but never to a timing sample. */
  ttfrEpoch: Date;
}

export function readCommissioningConfig(env: NodeJS.ProcessEnv = process.env): CommissioningConfig {
  const raw = env.COMMISSIONING_TTFR_EPOCH?.trim();
  const parsed = raw ? new Date(raw) : new Date(DEFAULT_TTFR_EPOCH);
  // An unparseable override falls back rather than poisoning every timing sample with `Invalid Date`,
  // which SQL would reject at bind time and turn into a 500 on a read-only report.
  return { ttfrEpoch: Number.isNaN(parsed.getTime()) ? new Date(DEFAULT_TTFR_EPOCH) : parsed };
}
