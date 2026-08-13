/**
 * `device_commissioning.installed_by` is a LOGIN STRING, not a person. There is no user master behind
 * it on either side, so who — or what — installed a device can only be inferred from the shape of the
 * string. This module is that inference, kept as an explicit, named, unit-testable pattern list rather
 * than a regex inlined into an aggregation query.
 *
 * **Why four classes and not two.** A person/machine binary does not fit the measured population
 * (dev mirror, 24,294 fitments):
 *
 *  - 6,582 rows (27.1%) have no installer at all → `UNATTRIBUTED`.
 *  - Only 77 rows carry a space, the unambiguous human-name form (`PRATIK PAWAR`, `HARSH RAGHAV`).
 *  - 17,712 rows are the underscore form, which MIXES plant-prefixed individuals (`RISDA_DURGESH`,
 *    `CHITTOR_NARAYAN`) with genuine depot/service accounts (`UTCL_SERVICE_DEPOT_CBT`, `PRISM_IVTS`).
 *
 * Nothing in the data separates that third group, and no source we have resolves it. Forcing it into
 * either bucket would either publish a leaderboard saying a service account is bad at installing
 * things, or credit a machine's failures to a technician. So it gets its own label and is shown as
 * unresolved. That is a maintenance liability by design — the alternative is a confidently wrong
 * attribution, which is worse than an honest "unknown".
 */

export type InstallerKind =
  /** A human name — the space-separated form. Safe to rank. */
  | 'PERSON'
  /** An integration/depot/admin login. Its failures are a process defect, never a technician's. */
  | 'SERVICE_ACCOUNT'
  /** Underscore-form login that matches no machine pattern. Could be either; shown, never ranked. */
  | 'UNCLASSIFIED'
  /** `installed_by` was null or blank at source. 27.1% of real rows. */
  | 'UNATTRIBUTED';

/**
 * Logins that are machines. Calibrated against all 158 distinct `installed_by` values on the dev
 * mirror, not guessed — running this list over that population splits 24,294 rows into 5,701
 * service-account (57 logins), 82 person (6 logins), 11,929 unclassified (95 logins, every one of them
 * the `PLANT_FIRSTNAME` shape), and 6,582 unattributed.
 *
 * Both `-` and `_` are treated as separators. AutoPlant carries both conventions for the same kind of
 * account — `INTEGRATION_SERVICE` and `SERVICE-ACCOUNT-INTEGRATION-SERVICE` (212 rows) are the same
 * class of thing — and an underscore-only list silently files the hyphenated half under a technician's
 * label.
 *
 * These are matched BEFORE the human-name heuristic, and the order is load-bearing: `TRIP CREATOR`
 * carries a space and would otherwise be classified `PERSON` by shape alone.
 */
export const MACHINE_ACCOUNT_PATTERNS: readonly RegExp[] = [
  /^INTEGRATION[-_ ]/i, // INTEGRATION_SERVICE
  /^TRIP[ _-]CREATOR$/i, // spaced, but a machine — see the ordering note above
  /^SERVICE[-_]ACCOUNT/i, // SERVICE-ACCOUNT-INTEGRATION-SERVICE
  /(^|[-_])IMPADMIN$/i, // UTCL_IMPADMIN
  /(^|[-_])ADMIN$/i, // COKE_ADMIN, ADANIRMC_ADMIN
  /^ADMIN[-_]/i,
  /(^|[-_])SERVICE([-_]|$)/i, // UTCL_SERVICE_GGU, VICAT_KADAPA_SERVICE, SERVICE_DGFC
  /SERVICE[-_]USER/i, // SERVICE_USER, VBLSERVICE_USER01
  /SERVICE\d*$/i, // …SERVICE / …SERVICE01 with no separator before it
  /(^|[-_])DEPOT([-_]|$)/i, // UTCL_SERVICE_DEPOT_CBT
  /(^|[-_])EPOD([-_]|$)/i, // SERVICE-ACCOUNT-EPOD-SERVICE
  /(^|[-_])IVTS$/i, // PRISM_IVTS
];

/**
 * Classify one `installed_by` value. Pure and total — every input lands in exactly one class, and the
 * checks run in the fixed order documented on {@link MACHINE_ACCOUNT_PATTERNS}.
 */
export function classifyInstaller(raw: string | null | undefined): InstallerKind {
  const value = raw?.trim() ?? '';
  if (value === '') return 'UNATTRIBUTED';
  if (MACHINE_ACCOUNT_PATTERNS.some((pattern) => pattern.test(value))) return 'SERVICE_ACCOUNT';
  // The human-name form. Checked only after every machine pattern has failed.
  if (/\s/.test(value)) return 'PERSON';
  return 'UNCLASSIFIED';
}
