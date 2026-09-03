import type { Prisma } from '../generated/prisma/client';

/**
 * #295 — how long an **assignment** may sit untouched before the dispatch board calls it aged.
 *
 * **Why this is a third key rather than a reuse of either neighbour.** The registry already holds two
 * hour-counts that look like this one and answer different questions:
 *
 * - `inactivity_threshold_hours` is a **measurement** definition. It sets `device_states.is_inactive`,
 *   the Fleet-Uptime denominator and the Soft Inactive Count that zones are *graded on*. Moving it to
 *   change a dispatch colour would silently restate every historical KPI — the argument set out at
 *   length in `assignment-threshold.ts` and `docs/proposals/zone-engine-customization-2026-07-21.md`.
 * - `se_assignment_threshold_hours` (#238) decides when **device silence** becomes an SE's problem.
 *   Its clock starts when the device goes quiet, which is typically long before anybody was assigned:
 *   a ticket dispatched at hour 30 against a 24 h threshold would be "aged" the instant it landed, so
 *   on the shipped default nearly every untouched card would have been yellow from birth.
 *
 * This key measures the one interval neither of them does: **now − `batch_assignment_tickets.created_at`**,
 * for work with no unresolved `TROUBLESHOOT_STARTED` against it. It is a dispatcher-attention dial and
 * nothing downstream computes from it — no SLA, no KPI, no engine decision. Moving it changes a colour
 * on one board and nothing else, which is exactly the blast radius an operator-tunable dial should have.
 */
export const ASSIGNED_UNTOUCHED_AGING_KEY = 'assigned_untouched_aging_hours';

/**
 * The selectable ladder.
 *
 * Unlike `ASSIGNMENT_THRESHOLD_OPTIONS`, these are **not** SLA band bounds, and pretending otherwise
 * would be a false analogy — nothing downstream draws a boundary at these numbers. They are a ladder
 * for two plainer reasons: `SETTING_VALIDATORS` echoes `allowed` back to the operator when a write is
 * refused, which needs a finite list to be useful; and an attention dial set to 3.7 hours buys nothing
 * an operator can perceive while letting a typo through as a legitimate value. The range spans "within
 * the hour" to "a whole working day" because both are real dispatch postures.
 */
export const AGING_THRESHOLD_OPTIONS: readonly number[] = [1, 2, 4, 6, 8, 12, 24];

/**
 * The default.
 *
 * **A filed guess, not a derived number** — no existing rule in this repo states when an untouched
 * assignment becomes worth chasing, and inventing a derivation would dress a judgement call as a
 * finding. Four hours is roughly half a field shift: long enough that a dispatcher is not nagged about
 * work an engineer is simply driving to, short enough that a morning's worth of ignored work is amber
 * before the afternoon. It is the first number an operator should be invited to move.
 */
export const DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS = 4;

export const ASSIGNED_UNTOUCHED_AGING_DESCRIPTION =
  'Hours an assigned ticket may sit with no TROUBLESHOOT_STARTED soft state before the dispatch ' +
  'board shows it as aged-untouched. The clock starts at assignment ' +
  '(batch_assignment_tickets.created_at) — NOT at device silence. Distinct from ' +
  'se_assignment_threshold_hours, whose clock is the device going quiet, and from ' +
  'inactivity_threshold_hours, which is a measurement definition behind Fleet Uptime and must not be ' +
  'moved for dispatch reasons. Affects one board colour and nothing else.';

/** Why a proposed threshold was refused — surfaced verbatim, never left to the operator to guess. */
export type AgingThresholdRejection = 'NOT_A_NUMBER' | 'NOT_AN_ALLOWED_OPTION';

export type ParsedAgingThreshold =
  | { ok: true; hours: number }
  | { ok: false; reason: AgingThresholdRejection };

/**
 * Validate a candidate against the ladder. Pure, and the only place a value is admitted. Accepts a
 * numeric string because form bodies carry strings — the same allowance
 * `parseAssignmentThresholdHours` makes, for the same reason.
 */
export function parseAgingThresholdHours(raw: unknown): ParsedAgingThreshold {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, reason: 'NOT_A_NUMBER' };
  if (!AGING_THRESHOLD_OPTIONS.includes(n)) return { ok: false, reason: 'NOT_AN_ALLOWED_OPTION' };
  return { ok: true, hours: n };
}

/** The stored value, coerced defensively: an older deploy's option or a hand-edited row falls back to
 *  the default rather than colouring the whole board off a value nothing understands. */
export function coerceStoredAgingThreshold(value: unknown): number {
  const parsed = parseAgingThresholdHours(value);
  return parsed.ok ? parsed.hours : DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS;
}

/** The minimal Prisma surface this reader needs — so callers can pass a client OR a transaction. */
type SettingReader = {
  systemSetting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: Prisma.JsonValue } | null>;
  };
};

/**
 * Read the live threshold. A free function over the Prisma client rather than an injected
 * `SettingsService`, matching `readAssignmentThresholdHours`: the consumer is a query service that
 * tests construct with nothing but a Prisma client. Read per request, never cached — an operator edit
 * shows on the next Console refresh with no restart.
 */
export async function readAgingThresholdHours(prisma: SettingReader): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: ASSIGNED_UNTOUCHED_AGING_KEY } });
  if (row == null) return DEFAULT_ASSIGNED_UNTOUCHED_AGING_HOURS;
  return coerceStoredAgingThreshold(row.value);
}
