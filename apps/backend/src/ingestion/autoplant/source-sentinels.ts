/**
 * The values AutoPlant uses to mean "nothing here", and the instant below which any stamp from it is a
 * sentinel rather than data. One definition, because there is one source (#323, forensics CB-11/AR-9c).
 *
 * Both mapping layers — `mapping.ts` (the Snapshot/telemetry path) and `master-mapping.ts` (the masters
 * path) — read the same MySQL tables written by the same application, so a value is either a sentinel
 * for both of them or for neither. They had drifted into two answers:
 *
 * - **The sentinel set.** `mapping.ts` had `{'', 'NULL', 'null'}`; `master-mapping.ts` added `'NA'`. A
 *   literal `'NA'` device id therefore passed the snapshot path and was journalled, while the masters
 *   path refused to create the device — leaving it in `unknownDevices` permanently, its telemetry
 *   unreachable, and warned about on every chunk. The **stricter** reading is the shared one: `'NA'` is
 *   in, because the masters path is the one that decides whether a device exists at all, and a
 *   telemetry row for a device that can never exist is not data worth keeping.
 * - **The plausibility floor.** `MIN_PLAUSIBLE_GPS_MS` and `MIN_PLAUSIBLE_INSTALL_MS` were the same
 *   value written twice, and `parseTripCreation` had neither — so MySQL's `0000-00-00 00:00:00`, which
 *   satisfies the naive-timestamp grammar, was stored as an instant near 1899-11-30 that no reader can
 *   tell from a real one. Both siblings keep their own names and their own reasoning at their own call
 *   sites; only the number stopped being copied.
 *
 * Nothing here is a policy decision — it is the source's vocabulary. Anything that *interprets* these
 * values (what to do with a blank id, whether to count a drop) stays in the mapping layer that owns
 * that path.
 */

/**
 * `''` / `'NA'` / `'NULL'` / `'null'` — AutoPlant writes all four interchangeably for an absent value.
 *
 * Matched **whole and trimmed**, never by substring: `'NA'` is a sentinel, `'NA0123'` is a perfectly
 * good WheelsEye-style alphanumeric device id.
 */
export const SOURCE_NULLISH: ReadonlySet<string> = new Set(['', 'NA', 'NULL', 'null']);

/** True when a raw source string carries no value — null, undefined, or one of {@link SOURCE_NULLISH}. */
export const isSourceBlank = (v: string | null | undefined): boolean =>
  v == null || SOURCE_NULLISH.has(v.trim());

/**
 * The earliest instant any AutoPlant timestamp may plausibly carry: **2000-01-01 UTC**.
 *
 * Deliberately modest, and it is a *sentinel* guard rather than a staleness guard. A device silent for
 * a year is not implausible data — it is the finding this platform exists to produce — so a floor tuned
 * to fleet percentiles would drop exactly the devices the system is meant to catch. What a per-row past
 * guard can do is reject sentinels: MySQL's `0000-00-00 00:00:00` zero-date and epoch garbage both
 * satisfy the naive-timestamp grammar and would otherwise be recorded as genuine values. AutoPlant's
 * own fleet starts in 2023 (feasibility §5.2), so 2000 leaves two decades of margin.
 */
export const MIN_PLAUSIBLE_SOURCE_MS = Date.UTC(2000, 0, 1);
