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
 * #304 — the engine's per-ENGINEER lock, spanning zones.
 *
 * `daily_capacity` caps an engineer's whole day, but zone claims serialize per zone and
 * `work_schedules_one_active_per_se_zone_day` is deliberately per-(SE, zone, day), so two concurrent
 * runs in different zones — a manual zone-scoped run, or a #286 recovery beside the 05:00 loop — could
 * each fill the same floating SE to capacity. Nothing downstream re-checked, and the database permits
 * it by design.
 *
 * Taken **after** the zone lock and never the other way round, so the ordering is the same in every
 * transaction that takes both. A per-SE transaction holds one zone lock and one engineer lock and
 * never asks for a second zone lock, so there is no cycle to deadlock on: two runs contending for one
 * engineer simply take turns, and every other engineer in both zones proceeds in parallel. That is
 * what keeps this from serializing zone runs against each other, which #259/#260's model forbids.
 */
export const dispatchEngineerLockKey = (seId: string): string => `dispatch_se_${seId}`;

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
