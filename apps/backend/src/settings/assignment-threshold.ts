import { SLA_BANDS } from '@fsm/shared';
import type { Prisma } from '../generated/prisma/client';

/**
 * #238 — the SE-assignment threshold: how long a device must have been silent before the platform
 * turns that silence into work for a Service Engineer.
 *
 * **Why this is NOT `inactivity_threshold_hours`.** The two look interchangeable and are not.
 * `inactivity_threshold_hours` defines `device_states.is_inactive`, which is the denominator of
 * Fleet Uptime % and the Soft Inactive Count that the platform *grades zones on*
 * (`device-state.service.ts:179`, `soft-inactive-count.service.ts`). Moving it to change dispatch
 * behaviour would silently restate every historical KPI and make zones non-comparable in the exact
 * reports built to compare them — the argument set out at length in
 * `docs/proposals/zone-engine-customization-2026-07-21.md` §3.1, and the reason
 * `audit/STATUS.md:281` says in as many words: *do not overload `inactivity_threshold_hours`.*
 *
 * So this is a second, independent dial. `is_inactive` keeps meaning "silent past the canonical 24 h"
 * for every report; this key alone decides when that silence becomes a Failure Cycle and a dispatch.
 * The two are free to differ in either direction, and at the default (24) they agree exactly, so
 * turning this feature on changes nothing until somebody deliberately moves it.
 */
export const SE_ASSIGNMENT_THRESHOLD_KEY = 'se_assignment_threshold_hours';

/**
 * The selectable ladder. These are not arbitrary round numbers — they are exactly the SLA band lower
 * bounds (`SLA_BANDS`, `packages/shared`), so every choice an operator can make lands on a boundary
 * the rest of the platform already draws: picking 48 means *"assign from HIGH_CRITICAL onward"*, and
 * the queue colour an operator is looking at while they decide is the same one the threshold speaks in.
 * A free-text hour count would let someone pick 37 and split a bucket, which nothing downstream could
 * render honestly.
 */
export const ASSIGNMENT_THRESHOLD_OPTIONS: readonly number[] = [...SLA_BANDS]
  .map(([hours]) => hours)
  .sort((a, b) => a - b);

/** The canonical default — deliberately equal to `inactivity_threshold_hours`, so #238 is inert
 *  until an operator moves it (no behaviour change lands with the deploy). */
export const DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS = 24;

export const SE_ASSIGNMENT_THRESHOLD_DESCRIPTION =
  'Hours of device silence before a Troubleshoot Ticket is opened and an SE may be auto-dispatched ' +
  'for it. Co-owned by the Operations Head and the CSM; the OH can lock the key to take sole ' +
  'control. Distinct from inactivity_threshold_hours, which defines is_inactive and the Fleet-Uptime ' +
  'denominator and must not be moved for dispatch reasons.';

/** Why a proposed threshold was refused — surfaced verbatim so the operator is never left guessing. */
export type ThresholdRejection = 'NOT_A_NUMBER' | 'NOT_AN_ALLOWED_OPTION';

export type ParsedThreshold = { ok: true; hours: number } | { ok: false; reason: ThresholdRejection };

/**
 * Validate a candidate threshold against the ladder. Pure, and the ONLY place a value is admitted —
 * both the dedicated writer and the settings seed go through it, so an out-of-ladder value cannot
 * reach the column by any route. Accepts a numeric string (`"48"`) because form bodies carry strings.
 */
export function parseAssignmentThresholdHours(raw: unknown): ParsedThreshold {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, reason: 'NOT_A_NUMBER' };
  if (!ASSIGNMENT_THRESHOLD_OPTIONS.includes(n)) return { ok: false, reason: 'NOT_AN_ALLOWED_OPTION' };
  return { ok: true, hours: n };
}

/** The stored value, coerced defensively. A row holding anything the ladder no longer admits (an
 *  older deploy's option, a hand-edited row) falls back to the default rather than gating the whole
 *  ticket pipeline on a value nothing else in the system understands. */
export function coerceStoredThreshold(value: unknown): number {
  const parsed = parseAssignmentThresholdHours(value);
  return parsed.ok ? parsed.hours : DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS;
}

/** The minimal Prisma surface this reader needs — so callers can pass a client OR a transaction. */
type SettingReader = {
  systemSetting: { findUnique(args: { where: { key: string } }): Promise<{ value: Prisma.JsonValue } | null> };
};

/**
 * Read the live threshold. Deliberately a free function over the Prisma client rather than an
 * injected `SettingsService`: the three hot-path consumers (ticket creation, auto-recovery, the
 * recommender) are all constructed directly in tests with nothing but a Prisma client, and the same
 * one-line `systemSetting.findUnique` shape is already how the recommender reads
 * `plant_cluster_multiplier` (`recommender.service.ts:576`). Read per run, never cached — an operator
 * edit takes effect on the next tick with no restart, matching every other setting in the registry.
 */
export async function readAssignmentThresholdHours(prisma: SettingReader): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SE_ASSIGNMENT_THRESHOLD_KEY } });
  if (row == null) return DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS;
  return coerceStoredThreshold(row.value);
}
