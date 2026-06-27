/**
 * Weighted candidate scoring within a (Company Tier × Device Bucket) cell (ADR-0003 layer 4). Pure +
 * explainable: combines company_priority_rank, vehicle dispatch urgency, a repeat-failure penalty and
 * (Floating only) distance-from-previous-stop, each scaled by a configurable weight from
 * `priority_rule_config`, then multiplied by the Plant Cluster Multiplier for additional same-Plant
 * tickets. Returns a breakdown for the persisted `score_breakdown` ("why suggested?").
 *
 * The exact numeric shape is deliberately a project choice (the docs fix the components + directions,
 * not the curve); these are monotonic, bounded transforms chosen for explainability.
 */

export interface ScoringWeights {
  [component: string]: number;
}

export interface ScoringFeatures {
  /** Company priority rank letter (A best). */
  companyPriorityRank: string;
  /** Vehicle dispatch urgency, 0..1. */
  dispatchUrgency: number;
  repeatFailure: boolean;
  /** Device inactivity (hours silent); drives the PREVENTIVE-mode aged-device bias. null = unknown. */
  inactivityHours: number | null;
  /** Distance from the SE's previous stop in km (Floating only); null = not applicable. */
  distanceFromPrevStopKm: number | null;
}

export interface ScoreBreakdown {
  rankScore: number;
  urgency: number;
  repeatPenalty: number;
  /** Device-age score 0..1 (capped at 7d); contributes only when `device_age` is weighted (PREVENTIVE). */
  ageScore: number;
  distanceScore: number;
  weights: ScoringWeights;
  baseScore: number;
  clusterMultiplier: number;
}

export interface ScoredCandidate {
  score: number;
  breakdown: ScoreBreakdown;
}

const W_RANK = 'company_priority_rank';
const W_URGENCY = 'dispatch_urgency';
const W_REPEAT = 'repeat_failure_penalty';
const W_DISTANCE = 'distance';
// PREVENTIVE-mode components (Issue 72). Absent from the DEFICIT set → default 0 → no effect there.
const W_REPEAT_BONUS = 'repeat_failure_bonus';
const W_AGE = 'device_age';
/** Inactivity hours capped at 7 days → 0..1. Older (more inactive) device → higher age score. */
const AGE_CAP_HOURS = 168;

/** A=1.0, B=0.9, C=0.8 … clamped to [0,1]. Higher rank → higher score. */
function rankScore(letter: string): number {
  const idx = letter.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
  if (Number.isNaN(idx) || idx < 0) return 0;
  return Math.max(0, 1 - 0.1 * idx);
}

/** Nearer previous stop → higher score; null distance is neutral (0). */
function distanceScore(km: number | null): number {
  if (km === null) return 0;
  return 1 / (1 + Math.max(0, km));
}

/** Device-age score: inactivity hours / 7d, clamped to [0,1]. null/undefined/negative = neutral (0). */
function ageScoreFrom(inactivityHours: number | null): number {
  if (inactivityHours == null || Number.isNaN(inactivityHours)) return 0;
  return Math.min(1, Math.max(0, inactivityHours) / AGE_CAP_HOURS);
}

export function scoreCandidate(
  features: ScoringFeatures,
  weights: ScoringWeights,
  clusterMultiplier = 1,
): ScoredCandidate {
  const rs = rankScore(features.companyPriorityRank);
  const ds = distanceScore(features.distanceFromPrevStopKm);
  const penalty = features.repeatFailure ? 1 : 0;
  const ageScore = ageScoreFrom(features.inactivityHours);

  const wRank = weights[W_RANK] ?? 0;
  const wUrgency = weights[W_URGENCY] ?? 0;
  const wRepeat = weights[W_REPEAT] ?? 0;
  const wDistance = weights[W_DISTANCE] ?? 0;
  // PREVENTIVE bias (Issue 72): repeat-failure becomes a bonus, aged devices add. Both default 0 in the
  // DEFICIT set, so DEFICIT scoring is byte-identical.
  const wRepeatBonus = weights[W_REPEAT_BONUS] ?? 0;
  const wAge = weights[W_AGE] ?? 0;

  const baseScore =
    wRank * rs +
    wUrgency * features.dispatchUrgency -
    wRepeat * penalty +
    wRepeatBonus * penalty +
    wAge * ageScore +
    wDistance * ds;

  return {
    score: baseScore * clusterMultiplier,
    breakdown: {
      rankScore: rs,
      urgency: features.dispatchUrgency,
      repeatPenalty: penalty,
      ageScore,
      distanceScore: ds,
      weights,
      baseScore,
      clusterMultiplier,
    },
  };
}
