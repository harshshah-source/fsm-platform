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
