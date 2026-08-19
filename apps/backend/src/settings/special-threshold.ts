import type { Prisma } from '../generated/prisma/client';

/**
 * #244 — how many unsuccessful *reached* attempts make a Troubleshoot ticket **Special**.
 *
 * "Reached" is the load-bearing word and it is defined in `ticketing/special-ticket.query.ts`, not
 * here; this module owns only the number and who may move it.
 *
 * **Why the ladder starts at 2.** 1 and 0 are expressible and operationally destructive. Special is a
 * *derived* classification with no stored counter, so a threshold change reclassifies the entire open
 * book on the next read — at 1, every ticket ever dispatched, opened by an SE and left unworked
 * becomes Special at once, which is indistinguishable from the flag meaning nothing; at 0 a ticket
 * nobody has ever visited is Special. Both are recoverable only by moving the key back, after
 * everyone has already seen the queue light up. The parser therefore refuses them, and refuses them
 * **with the allowed list**, because the bound appears nowhere else an operator can read.
 *
 * **Why 10 is the ceiling.** Above it the classification cannot fire before the ticket has outlived
 * any plausible service conversation — a Special that arrives after two weeks of daily attempts is a
 * post-mortem, not an intervention. The ladder is every integer between, because unlike #238's
 * threshold (which lands on SLA-band boundaries the UI already draws) an attempt count has no
 * external scale to snap to; the honest constraint is just the floor and the ceiling.
 *
 * **Authority: Operations Head, with no co-owner.** #238's threshold is co-owned by the CSM because
 * they run the cross-zone service picture and feel dispatch volume first. Nobody feels a
 * classification threshold day to day — it changes what a queue is *called*, not what the engine
 * does — so there is nothing to delegate and the registry default stands.
 */
export const SPECIAL_ATTEMPT_THRESHOLD_KEY = 'special_ticket_attempt_threshold';

/** Every integer from the floor to the ceiling; see the module docstring for why those two. */
export const SPECIAL_ATTEMPT_THRESHOLD_OPTIONS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10];

/** The approved default (Decision 7). Three unsuccessful reached attempts. */
export const DEFAULT_SPECIAL_ATTEMPT_THRESHOLD = 3;

export const SPECIAL_ATTEMPT_THRESHOLD_DESCRIPTION =
  'Unsuccessful *reached* attempts before an open Troubleshoot Ticket is identified as Special ' +
  '(2-10, default 3). An attempt counts only if the SE actually opened the ticket in the mobile ' +
  'workflow and the assignment window then ended as PLAN_EXPIRED or VEHICLE_UNAVAILABLE; manager ' +
  'withdrawals, defers, reassignments and cancellations never count. Special is DERIVED — there is ' +
  'no stored counter, so changing this reclassifies existing tickets on the next read.';

/** Why a proposed threshold was refused — surfaced verbatim so the operator is never left guessing. */
export type SpecialThresholdRejection = 'NOT_A_NUMBER' | 'NOT_AN_ALLOWED_OPTION';

export type ParsedSpecialThreshold =
  | { ok: true; attempts: number }
  | { ok: false; reason: SpecialThresholdRejection };

/**
 * Validate a candidate threshold against the ladder. Pure, and the ONLY place a value is admitted —
 * the settings writer and the seed both go through it, so an out-of-ladder value cannot reach the
 * column by any route. Accepts a numeric string (`"3"`) because form bodies carry strings.
 */
export function parseSpecialAttemptThreshold(raw: unknown): ParsedSpecialThreshold {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, reason: 'NOT_A_NUMBER' };
  if (!SPECIAL_ATTEMPT_THRESHOLD_OPTIONS.includes(n)) return { ok: false, reason: 'NOT_AN_ALLOWED_OPTION' };
  return { ok: true, attempts: n };
}

/**
 * The stored value, coerced defensively. A row holding something the ladder does not admit (a
 * hand-edited row, an older deploy's option) falls back to the default rather than classifying the
 * whole open book against a number nothing else in the system understands.
 */
export function coerceStoredSpecialThreshold(value: unknown): number {
  const parsed = parseSpecialAttemptThreshold(value);
  return parsed.ok ? parsed.attempts : DEFAULT_SPECIAL_ATTEMPT_THRESHOLD;
}

/** The minimal Prisma surface this reader needs — so callers can pass a client OR a transaction. */
type SettingReader = {
  systemSetting: { findUnique(args: { where: { key: string } }): Promise<{ value: Prisma.JsonValue } | null> };
};

/**
 * Read the live threshold. A free function over the Prisma client, matching
 * `readAssignmentThresholdHours` — the consumers are query services constructed directly in tests
 * with nothing but a Prisma client. Read per evaluation, never cached: an operator edit reclassifies
 * the queue on the next read with no restart, which is exactly what "derived" buys.
 */
export async function readSpecialAttemptThreshold(prisma: SettingReader): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SPECIAL_ATTEMPT_THRESHOLD_KEY } });
  if (row == null) return DEFAULT_SPECIAL_ATTEMPT_THRESHOLD;
  return coerceStoredSpecialThreshold(row.value);
}
