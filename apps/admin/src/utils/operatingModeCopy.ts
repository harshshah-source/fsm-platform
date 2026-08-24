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
  /** Plain-language "how is this decided?" text for the card's Info tooltip. */
  help: string;
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

// "How is this decided?" — the Info-tooltip body. Mode-independent (it explains the whole switch),
// so it reads the same for Catch-up and Steady; only the voice (your zone vs a zone) changes.
const HELP_SELF =
  'We look at how many of the devices we track in your zone have gone quiet. When a lot are quiet at once, the system switches to Catch-up so engineers reach those outages first; otherwise it stays Steady and also fits in routine visits and new installations.';
const HELP_OTHER =
  "We look at how many of a zone's tracked devices have gone quiet. When a lot are quiet at once, that zone is in Catch-up so engineers reach outages first; otherwise it stays Steady and also does routine and install work.";

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
 * The plain label alone, for a surface that knows a zone's mode but not its counts — the Scheduler
 * Preview renders the mode the *projection* ran under (#281 AC10), which is not necessarily the live
 * mode `apiOperatingMode` would report, so it cannot borrow a whole row. Same LABEL map as
 * {@link operatingModeCopy}: the enum still never leaves this module.
 */
export function operatingModeLabel(mode: string | null | undefined): string | null {
  if (mode == null) return null;
  return LABEL[mode as OperatingMode] ?? null;
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
    help: perspective === 'self' ? HELP_SELF : HELP_OTHER,
    tone: TONE[row.mode],
  };
}
