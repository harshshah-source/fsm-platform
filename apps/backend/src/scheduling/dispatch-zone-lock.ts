/**
 * The advisory-lock key a zone's dispatch holds for the life of its transaction (Issue 100) — the
 * primary serializer that stops two dispatches of the same zone from both proceeding.
 *
 * Extracted by #147 slice 2, which needed a second holder: the schedule closer must not be able to
 * write a terminal status onto a schedule that #127's APPEND has already read and is about to extend.
 * Two hand-spelled key strings that disagreed by a character would take *different* locks and contend
 * with nothing — a race that no test would fail on — so both call sites name the lock from here.
 *
 * `hashtext(...)` maps this to the `int4` the `pg_*_advisory_*_lock` family keys on; every caller must
 * hash the same string the same way for the locks to be the same lock.
 */
export const dispatchZoneLockKey = (zoneId: bigint): string => `dispatch_zone_${zoneId}`;

/**
 * How long a per-SE dispatch transaction waits for the zone advisory lock before giving up (#262).
 *
 * #262 changed this lock's job. Run-vs-run exclusion moved to #259's zone claim, so what the advisory
 * lock still guards is dispatch against **closure and bulk-unassign** — operations whose contention
 * window is milliseconds. A blocking wait is therefore right where the old non-blocking `try` would
 * have skipped a zone that was free a moment later.
 *
 * Bounded, though: an unbounded wait turns one stuck holder into a stuck dispatch, and with the zone
 * transaction now split per SE that stall would be per SE rather than once. Three seconds is far above
 * any real holder and far below the 15 s interactive-transaction budget, so a timeout is reported as
 * this SE's skip rather than as the transaction being killed from underneath.
 */
export const ZONE_LOCK_TIMEOUT_MS = 3_000;
