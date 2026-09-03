/**
 * One parser for the numeric surrogate ids this API carries on the wire (`batch_id`, `zone_id`,
 * `insertion_id`, …) — #310 / CB-9.
 *
 * Those ids are `BigInt` columns, so handlers reached for `BigInt(raw)` directly. `BigInt` throws a
 * `SyntaxError` on anything that is not a numeric literal, which nothing caught: five handlers
 * answered **500** to input the caller fully controls, while their own siblings in the same files
 * wrapped it and answered 404. That asymmetry is the bug — not the missing try/catch in any one place.
 *
 * This returns `null` rather than throwing, deliberately: **which** refusal a malformed id deserves is
 * a question about the resource, not about the parse. A path segment naming a batch is an absent batch
 * (404); a body field naming the zone to sweep is a malformed request (400). The caller owns that
 * choice and its `code`; this owns only the answer to "is this an id at all".
 *
 * Stricter than `BigInt` on purpose, because `BigInt` is surprisingly permissive and each surprise
 * reaches the database as a real query: `BigInt('')` is `0n`, `BigInt(' 7 ')` is `7n`, `BigInt('0x1f')`
 * is `31n`. Only a run of decimal digits is an id here, which is exactly what the route that minted
 * the id emits.
 */
export function toBigIntId(raw: unknown): bigint | null {
  if (typeof raw === 'bigint') return raw >= 0n ? raw : null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw);
  if (!/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
