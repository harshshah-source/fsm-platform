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

/**
 * How `eligible_for_uptime` is derived (`eligibility_mode` system setting, Issue 112 / review B7):
 *  - `pgi` — the canonical CONTEXT.md gate: active PGI within the window. Default.
 *  - `all-deployed` — declared interim proxy while the SAP PGI feed is unbuilt (R2): the device's
 *    current vehicle fitment carries deployment status ACTIVE/DEPLOYED. PGI is not consulted.
 * The Non-Op exclusion applies in BOTH modes.
 */
export type EligibilityMode = 'pgi' | 'all-deployed';

/** Junk or unset setting values fall back to `pgi` — the gate never silently widens. */
export function parseEligibilityMode(value: unknown): EligibilityMode {
  return value === 'all-deployed' ? 'all-deployed' : 'pgi';
}

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
