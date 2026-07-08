# 106 — Perf hardening: criticalQueue LIMIT + connection-pool sizing/timeouts + dashboard cache
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-03-backend-production-readiness-audit.md` — MEDIUM findings
> (unbounded criticalQueue; all-default connection pooling; per-request dashboard scans). Verified
> 2026-07-07: `dashboard.service.ts` re-runs aggregate scans of `device_states` per poll and the
> critical queue has no LIMIT. Note the AutoPlant **MySQL** connect/query timeouts are owned by #97
> (Slice A4) — this issue is the Postgres side + the dashboard.

## What to build

Three independent, low-risk performance guards:

1. **Bound the critical queue.** Add a LIMIT (and stable ordering) to the `criticalQueue` read so a
   bad week with thousands of CRITICAL tickets can't serialize the whole set into one request.
2. **Postgres pool sizing + statement timeout.** Configure pool size/timeouts on the Prisma/pg
   adapter and a `statement_timeout`, so a runaway query fails fast instead of hanging a connection.
   (MySQL/AutoPlant timeouts are #97's Slice A4 — do not duplicate.)
3. **Dashboard read cache.** Add a short-TTL cache (or a materialized view where the audit notes one
   was deferred) for the per-poll `device_states` rollups so N managers polling don't each trigger
   2–4 full aggregate scans.

## Acceptance criteria

- [ ] `criticalQueue` returns at most a defined LIMIT with deterministic ordering; a seeded large-critical scenario returns the capped set, and a test asserts the cap.
- [ ] The Postgres connection pool has explicit sizing/timeouts and a `statement_timeout`; a deliberately slow query aborts rather than hanging (documented check or test).
- [ ] The dashboard rollup reads are served from a short-TTL cache or matview; repeated polls within the window do not re-scan `device_states` (assert via query count or cache hit).
- [ ] Existing dashboard e2e stays green; the cached path returns identical data to the uncached path within the TTL semantics.

## UI surfaces
n/a (backend; dashboard payload shape unchanged — no admin FE change)

## Reference
n/a

## Blocked by
None — can start immediately. MySQL-side timeouts are owned by #97.
