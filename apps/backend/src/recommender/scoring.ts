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

import { NOT_AVAILABLE, type DistanceKm } from './distance';

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
  /** #267 — the raw distance the score above was derived from, or `NOT_AVAILABLE` (never a fabricated
   *  0/`(0,0)`) when the SE has no home base and no prior stop, or the plant has no geometry. */
  distanceKm: DistanceKm;
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

/**
 * #266 — the closed vocabulary of scoring components: every weight `scoreCandidate` actually reads,
 * and nothing else.
 *
 * This exists because the weight set was open. `priority_rule_config` accepted any component string,
 * the admin form's Component field is free text, and `activeWeights` loads whatever is active — so a
 * weight named anything at all would appear in the settings table beside the real ones and ride along
 * in every persisted `score_breakdown.weights`, contributing nothing. Three had been seeded that way
 * since Issue 02 (`company_tier`, `device_bucket`, `sla_urgency`) and were read by nothing.
 *
 * Deactivating those three without closing the set would have fixed the instance and left the class:
 * the next dead lever is one form submission away. The scorer is the only thing that can say what a
 * lever is, so it says it here and the admin API validates against it.
 */
export const SCORING_COMPONENTS = [
  W_RANK,
  W_URGENCY,
  W_REPEAT,
  W_DISTANCE,
  W_REPEAT_BONUS,
  W_AGE,
] as const;

/** True when `component` is a weight the scorer reads. */
export function isScoringComponent(component: string): boolean {
  return (SCORING_COMPONENTS as readonly string[]).includes(component);
}

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
    // #266 — the cluster bonus multiplies a FLOORED base (operator-ruled). `baseScore` can reach zero
    // or go negative: with the seeded DEFICIT weights an install-backlog ticket has `dispatchUrgency`
    // 0 by design, so a repeat-failure ticket for a company at rank F scores exactly 0 (the bonus is a
    // no-op) and at rank G or below scores negative — where a 1.25x "bonus" would make the SE already
    // going to that plant score WORSE than one who has never been. `company_priority_rank` is a free
    // String column, not an enum, so those letters are reachable. The floor keeps the bonus pointing
    // in one direction; the breakdown still carries the true `baseScore` so nothing is hidden.
    score: Math.max(baseScore, 0) * clusterMultiplier,
    breakdown: {
      rankScore: rs,
      urgency: features.dispatchUrgency,
      repeatPenalty: penalty,
      ageScore,
      distanceScore: ds,
      distanceKm: features.distanceFromPrevStopKm === null ? NOT_AVAILABLE : features.distanceFromPrevStopKm,
      weights,
      baseScore,
      clusterMultiplier,
    },
  };
}
