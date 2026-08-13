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

/**
 * Upper bounds, in hours since fitment, of the resolution curve's bands (#234).
 *
 * The question this answers is "how fast does a batch of fitments come online", which is the only
 * cohort trend FSM can honestly compute today. `device_states` is overwritten in place,
 * `raw_device_snapshots` is 7-day retained, and reconstructing silence from `failure_cycles` intervals
 * is distorted while auto-recovery has never run (#229) — 1,799 of the operational 90-day cohort's
 * 2,183 cycles sit `OPEN`, so a calendar-time series would rise monotonically as an artefact of the
 * scheduler being off. This curve depends on none of that: it is `first_reported_at - installed_at`,
 * two stored facts.
 *
 * The boundaries are where the measured distribution actually bends rather than round numbers —
 * live `fsm`, post-epoch, 520 samples: `<1h` 52 · `1–4h` 87 · `4–12h` 93 · `12–24h` **189** · `24–48h`
 * 91 · `48–72h` 6 · `>72h` 2. The mass is in 12–24 h and the tail is gone by 48 h, which is what makes
 * `GRACE_HOURS.fallback = 48` a measurement rather than a preference.
 */
export const RESOLUTION_BUCKET_HOURS = [4, 12, 24, 48, 72] as const;

/**
 * How old a fitment must be to enter the curve — the widest band, so every fitment on the chart has
 * been observed for the full range the chart plots.
 *
 * **This is the difference between a correct curve and a subtly wrong one.** A device fitted two hours
 * ago and still silent has not "failed to report within 72 h"; it has not had 72 hours. Counting it in
 * the denominator of every band biases the whole curve downward, and worse, biases it most on exactly
 * the recent cohort an operator is looking at. Excluding immature fitments is the cheap form of the
 * right-censoring a survival model would do properly, and the count that gets excluded is reported
 * (`immatureFitments`) rather than silently dropped.
 *
 * The residual error it accepts: a fitment matured at exactly 72 h that would have come online at 100 h
 * is recorded as never-online. Measured, that is under 0.4% of samples.
 */
export const RESOLUTION_MATURITY_HOURS = RESOLUTION_BUCKET_HOURS[RESOLUTION_BUCKET_HOURS.length - 1];

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
