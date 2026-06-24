/**
 * Pure three-phase GPS verification criteria (Issue 18, LLD §17 / workflow §17.1). Kept side-effect
 * free so the VerificationWorker can re-run them on every 5-min scan without touching the DB.
 *
 * Phase 1 (0–30 min): ≥3 valid pings from the named device, span ≥15 min, no gap >30 min, and the
 *   **first** ping within ±500 m of the SE anchor (form GPS / ON_SITE capture) — the geo-check is
 *   skipped (no fraud) when `presence_source = NONE`. 1–2 pings → PARTIAL_RECOVERY badge.
 * Phase 2 (1 h from the Phase-1 first ping): the device keeps pinging with no gap >30 min; movement is
 *   welcome (no ±500 m). A coverage gap stays PENDING — Phase 2 never auto-fails.
 */
export const FIRST_PING_RADIUS_M = 500;
export const PHASE1_MIN_PINGS = 3;
export const PHASE1_MIN_SPAN_MIN = 15;
export const MAX_GAP_MIN = 30;
export const PHASE2_STABILITY_MIN = 60;

/** Great-circle distance in metres between two WGS-84 points. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface Phase1Ping {
  time: Date;
  lat: number | null;
  lon: number | null;
}

export interface Phase1Input {
  pings: Phase1Ping[];
  /** SE anchor (form GPS / ON_SITE capture); null when no location was captured. */
  anchor: { lat: number; lon: number } | null;
  /** True when `presence_source = NONE` — skip the ±500 m geo-check, never flag fraud. */
  skipGeoCheck: boolean;
  thresholds?: { minPings?: number; minSpanMin?: number; maxGapMin?: number; radiusM?: number };
}

export interface Phase1Result {
  passed: boolean;
  partial: boolean;
  pingsCount: number;
  firstPingDistanceMeters: number | null;
  fraud: boolean;
}

export function evaluatePhase1(input: Phase1Input): Phase1Result {
  const minPings = input.thresholds?.minPings ?? PHASE1_MIN_PINGS;
  const minSpanMin = input.thresholds?.minSpanMin ?? PHASE1_MIN_SPAN_MIN;
  const maxGapMin = input.thresholds?.maxGapMin ?? MAX_GAP_MIN;
  const radiusM = input.thresholds?.radiusM ?? FIRST_PING_RADIUS_M;

  const pings = [...input.pings].sort((a, b) => a.time.getTime() - b.time.getTime());
  const pingsCount = pings.length;

  // First-ping distance to the anchor (info + fraud), computed whenever both points are known.
  let firstPingDistanceMeters: number | null = null;
  const first = pings[0];
  if (!input.skipGeoCheck && input.anchor && first && first.lat != null && first.lon != null) {
    firstPingDistanceMeters = haversineMeters(input.anchor.lat, input.anchor.lon, first.lat, first.lon);
  }

  if (pingsCount === 0) {
    return { passed: false, partial: false, pingsCount: 0, firstPingDistanceMeters, fraud: false };
  }
  if (pingsCount < minPings) {
    // 1–2 pings → PARTIAL_RECOVERY badge (not a pass, not a fraud signal).
    return { passed: false, partial: true, pingsCount, firstPingDistanceMeters, fraud: false };
  }

  const times = pings.map((p) => p.time.getTime());
  const spanMin = (times[times.length - 1] - times[0]) / 60_000;
  const maxGap = Math.max(...times.slice(1).map((t, i) => (t - times[i]) / 60_000), 0);
  const evidenceOk = spanMin >= minSpanMin && maxGap <= maxGapMin;

  const fraud = !input.skipGeoCheck && firstPingDistanceMeters != null && firstPingDistanceMeters > radiusM;
  const geoOk = input.skipGeoCheck || (firstPingDistanceMeters != null && firstPingDistanceMeters <= radiusM);

  return { passed: evidenceOk && geoOk && !fraud, partial: false, pingsCount, firstPingDistanceMeters, fraud };
}

export interface Phase2Input {
  pingTimes: Date[];
  /** The Phase-1 first-ping time — the start of the 1 h stability window. */
  phase1Start: Date;
  now: Date;
  thresholds?: { stabilityMin?: number; maxGapMin?: number };
}

export interface Phase2Result {
  passed: boolean;
  coverageGap: boolean;
  windowElapsed: boolean;
}

export function evaluatePhase2(input: Phase2Input): Phase2Result {
  const stabilityMin = input.thresholds?.stabilityMin ?? PHASE2_STABILITY_MIN;
  const maxGapMin = input.thresholds?.maxGapMin ?? MAX_GAP_MIN;
  const windowEnd = input.phase1Start.getTime() + stabilityMin * 60_000;
  const windowElapsed = input.now.getTime() >= windowEnd;

  const times = input.pingTimes
    .map((t) => t.getTime())
    .filter((t) => t >= input.phase1Start.getTime())
    .sort((a, b) => a - b);

  const maxGap = times.length > 1 ? Math.max(...times.slice(1).map((t, i) => (t - times[i]) / 60_000)) : 0;
  const lastPing = times[times.length - 1] ?? input.phase1Start.getTime();
  // Coverage must reach the window end (a final ping within maxGap of it), with no interior gap.
  const reachesEnd = lastPing >= windowEnd - maxGapMin * 60_000;
  const coverageGap = maxGap > maxGapMin || (windowElapsed && !reachesEnd);

  return { passed: windowElapsed && !coverageGap, coverageGap, windowElapsed };
}
