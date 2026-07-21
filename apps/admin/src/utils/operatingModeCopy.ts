import type { OperatingMode, ZoneOperatingMode } from '../api/operatingMode';

// ── FINAL-COPY EDIT SURFACE (Issue 136 vocabulary rule) ─────────────────────────────
// Every word a non-technical manager reads about the operating mode lives in THIS file.
// No engine term (DEFICIT / PREVENTIVE / "threshold" / "soft inactive count") ever leaves
// this module — the mode enum is translated here and nowhere else. Changing the final
// wording (pending CONTEXT.md domain sign-off) is a one-file edit; callers never inline copy.

export type OperatingModeTone = 'attention' | 'calm';

export interface OperatingModeCopy {
  /** Plain label shown in place of the enum ("Catch-up" / "Steady"). */
  label: string;
  /** One-line plain-language meaning. */
  reason: string;
  /** The supporting counts rendered as a human sentence — never a %, never "threshold". */
  primaryFact: string;
  /** Semantic tone for styling (mapped to a Badge tone by the component, not here). */
  tone: OperatingModeTone;
}

const LABEL: Record<OperatingMode, string> = {
  DEFICIT: 'Catch-up',
  PREVENTIVE: 'Steady',
};

// "self" = a ZM reading their own zone; "other" = an OH/CSM reading a named zone in the strip.
const REASON_SELF: Record<OperatingMode, string> = {
  DEFICIT:
    'Too many devices in your zone have gone quiet, so the system is focused on getting engineers to those outages first.',
  PREVENTIVE:
    'Quiet devices in your zone are under control, so the system is also fitting in routine visits and new installations.',
};

const REASON_OTHER: Record<OperatingMode, string> = {
  DEFICIT: 'Too many devices here have gone quiet — the system is prioritising outages first.',
  PREVENTIVE: 'Quiet devices here are under control — the system is also doing routine and install work.',
};

const TONE: Record<OperatingMode, OperatingModeTone> = {
  DEFICIT: 'attention',
  PREVENTIVE: 'calm',
};

const num = (n: number): string => n.toLocaleString();

/** Plain-language rendering of the supporting counts for a ZM's own zone. */
function primaryFactSelf(silent: number, eligible: number): string {
  if (eligible <= 0) return "We aren't tracking any devices in your zone yet.";
  return `${num(silent)} of ${num(eligible)} devices we track in your zone are currently quiet.`;
}

/** Compact plain-language counts for a named zone in the cross-zone strip. */
function primaryFactOther(silent: number, eligible: number): string {
  if (eligible <= 0) return 'No devices tracked yet.';
  return `${num(silent)} of ${num(eligible)} devices quiet.`;
}

/**
 * Translate a zone's raw operating-mode row into everything the UI renders — label, reason, a
 * human-readable supporting fact, and a styling tone. `perspective` picks the ZM's own-zone voice
 * ("your zone") or the cross-zone strip's third-person voice.
 */
export function operatingModeCopy(
  row: ZoneOperatingMode,
  perspective: 'self' | 'other' = 'self',
): OperatingModeCopy {
  return {
    label: LABEL[row.mode],
    reason: perspective === 'self' ? REASON_SELF[row.mode] : REASON_OTHER[row.mode],
    primaryFact:
      perspective === 'self'
        ? primaryFactSelf(row.silentCount, row.eligibleCount)
        : primaryFactOther(row.silentCount, row.eligibleCount),
    tone: TONE[row.mode],
  };
}
