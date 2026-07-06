/**
 * SLA Bucket classifier (LLD §9 / CONTEXT "SLA Bucket").
 *
 * A device's inactivity-age band, a pure function of
 * `inactivity_hours = (now − latest_gps_datetime)`. Boundaries are closed-lower / open-upper
 * (CRITICAL = 24 ≤ x < 48). The 0–4h ACTIVE band is **not** a queue bucket — it returns `null`,
 * which `device_states.sla_bucket` stores as NULL so ACTIVE devices never surface in a queue.
 *
 * The enum deliberately omits `ACTIVE` (it is the absence of a bucket) and uses `LONG_PENDING`
 * (never `AGED_CRITICAL`) for the 7d+ top band.
 */
import { SLA_BANDS, type SlaBucket } from '@fsm/shared';

// Re-exported so existing `import { SlaBucket } from './sla-bucket'` call sites keep working; the
// definition now lives in @fsm/shared alongside the band boundaries (single source of truth).
export type { SlaBucket };

/** Closed-lower bounds (hours), highest band first. The first whose bound ≤ hours wins. */
const BANDS: ReadonlyArray<readonly [number, SlaBucket]> = SLA_BANDS;

/**
 * Returns the device's SLA bucket, or `null` for the 0–4h ACTIVE band (including a negative age
 * from clock skew — treated as ACTIVE rather than throwing, since the DB clamps `inactivity_hours
 * >= 0` upstream).
 */
export function classifySlaBucket(inactivityHours: number): SlaBucket | null {
  for (const [lowerBound, bucket] of BANDS) {
    if (inactivityHours >= lowerBound) return bucket;
  }
  return null;
}

/**
 * The SQL projection of {@link classifySlaBucket}, generated from the SAME `SLA_BANDS` array so the
 * set-based `device_states` derive (R4-B) and the TS classifier can never drift. `hoursCol` is a SQL
 * expression yielding the (clamped, nullable) inactivity hours — e.g. a CTE column `dr.hours`. Emits a
 * `CASE … END::"sla_bucket"`: highest band first (first match wins, exactly like the TS loop), NULL for
 * the 0–4h ACTIVE band and for a NULL age. Bucket names are validated as bare identifiers before
 * interpolation (defence-in-depth; they are compile-time enum constants, never external input).
 */
export function slaBucketCaseSql(hoursCol: string): string {
  const whens = BANDS.map(([lowerBound, bucket]) => {
    if (!/^[A-Z_]+$/.test(bucket)) throw new Error(`Unexpected SLA bucket identifier: ${bucket}`);
    if (!Number.isFinite(lowerBound)) throw new Error(`Unexpected SLA band bound: ${lowerBound}`);
    return `WHEN ${hoursCol} >= ${lowerBound} THEN '${bucket}'`;
  }).join(' ');
  return `(CASE WHEN ${hoursCol} IS NULL THEN NULL ${whens} ELSE NULL END)::"sla_bucket"`;
}
