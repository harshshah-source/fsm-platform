/**
 * Uptime-eligibility gate (CONTEXT "Eligible Device" / LLD `device_eligibility` MV).
 *
 * A Device counts toward the Fleet Uptime denominator — and is eligible for Troubleshoot Ticket
 * creation — iff it has an **active PGI within the window** (default ≤15 days, proof of active
 * commercial use) AND is **not** excluded by a CONFIRMED/ACTIVE Non-Operational marking. Non-Op
 * short-circuits to ineligible regardless of PGI.
 *
 * Pure function of already-resolved facts: the latest PGI date and whether an active Non-Op marking
 * exists. The DB reads that produce those facts live in DeviceStateService.
 */
const MS_PER_DAY = 86_400_000;
const DEFAULT_PGI_WINDOW_DAYS = 15;

export function isEligibleForUptime(params: {
  latestPgiDate: Date | null;
  hasActiveNonOp: boolean;
  now: Date;
  pgiWindowDays?: number;
}): boolean {
  const { latestPgiDate, hasActiveNonOp, now, pgiWindowDays = DEFAULT_PGI_WINDOW_DAYS } = params;
  if (hasActiveNonOp) return false;
  if (latestPgiDate === null) return false;
  const daysSincePgi = (now.getTime() - latestPgiDate.getTime()) / MS_PER_DAY;
  return daysSincePgi <= pgiWindowDays;
}

export { DEFAULT_PGI_WINDOW_DAYS };
