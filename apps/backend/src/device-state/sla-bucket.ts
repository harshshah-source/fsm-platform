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
export type SlaBucket =
  | 'WARNING'
  | 'EARLY_RISK'
  | 'RISK'
  | 'CRITICAL'
  | 'HIGH_CRITICAL'
  | 'SEVERE'
  | 'VERY_SEVERE'
  | 'LONG_PENDING';

/** Closed-lower bounds (hours), highest band first. The first whose bound ≤ hours wins. */
const BANDS: readonly [number, SlaBucket][] = [
  [168, 'LONG_PENDING'], // 7d+
  [120, 'VERY_SEVERE'], // 5–7d
  [72, 'SEVERE'], // 3–5d
  [48, 'HIGH_CRITICAL'], // 48–72h
  [24, 'CRITICAL'], // 24–48h
  [12, 'RISK'], // 12–24h
  [8, 'EARLY_RISK'], // 8–12h
  [4, 'WARNING'], // 4–8h
];

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
