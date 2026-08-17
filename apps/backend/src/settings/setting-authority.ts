import { SE_ASSIGNMENT_THRESHOLD_KEY } from './assignment-threshold';

/** The role every settings key falls back to. `SettingsController` is `@Roles('OPERATIONS_HEAD')`,
 *  and that stays the default for the registry as a whole. */
export const DEFAULT_SETTING_WRITE_ROLES: readonly string[] = ['OPERATIONS_HEAD'];

/**
 * #238 — the keys whose write authority is shared beyond the Operations Head, and with whom.
 *
 * There is exactly one today, and the list is meant to stay short. A settings key is platform-wide
 * policy; widening who may move it is a governance decision, so it is recorded here as data — one
 * greppable place that answers "who can change this" — rather than spread across controller
 * decorators where the answer has to be reassembled from five files.
 */
export const SETTING_WRITE_ROLES: Record<string, readonly string[]> = {
  // The SE-assignment threshold is an operational dial the CSM owns day to day (they run the
  // cross-zone service picture and feel the dispatch volume first), bounded by an OH who can lock it.
  [SE_ASSIGNMENT_THRESHOLD_KEY]: ['OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER'],
};

/** The role that outranks every other on a settings key. Locking, unlocking and reverting are its
 *  alone — this constant is the literal expression of "the Operations Head has the final decision". */
export const SETTING_FINAL_AUTHORITY_ROLE = 'OPERATIONS_HEAD';

export function writeRolesFor(key: string): readonly string[] {
  return SETTING_WRITE_ROLES[key] ?? DEFAULT_SETTING_WRITE_ROLES;
}

/** The lock state of a key, as the columns store it. */
export interface SettingLock {
  lockedAt: Date | null;
  lockedBy: string | null;
  lockedByRole: string | null;
  lockReason: string | null;
}

export const isLocked = (lock: Pick<SettingLock, 'lockedAt'> | null | undefined): boolean =>
  lock?.lockedAt != null;

export type WriteVerdict =
  | { allowed: true }
  | { allowed: false; code: 'ROLE_NOT_PERMITTED' }
  | { allowed: false; code: 'SETTING_LOCKED' };

/**
 * May `role` write `key` given its current lock state?
 *
 * The two refusals are deliberately distinct. `ROLE_NOT_PERMITTED` means "this was never yours";
 * `SETTING_LOCKED` means "it is yours, and the Operations Head has taken it back for now" — a
 * temporary, explained, reversible state the CSM should see as such rather than as a permissions bug.
 */
export function canWriteSetting(
  key: string,
  role: string,
  lock: Pick<SettingLock, 'lockedAt'> | null | undefined,
): WriteVerdict {
  if (!writeRolesFor(key).includes(role)) return { allowed: false, code: 'ROLE_NOT_PERMITTED' };
  // The final authority is never locked out — otherwise a lock would be irreversible.
  if (isLocked(lock) && role !== SETTING_FINAL_AUTHORITY_ROLE)
    return { allowed: false, code: 'SETTING_LOCKED' };
  return { allowed: true };
}
