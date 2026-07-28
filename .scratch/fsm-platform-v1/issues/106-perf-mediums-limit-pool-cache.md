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

## Comments

### 2026-07-28 — mobile-readiness extension (docs/status/backend-mobile-readiness-plan-2026-07-28.md §A-§5)

Re-verified: `PrismaPg` still constructed with only `connectionString` + UTC options
(`prisma.service.ts:26-40`); pg defaults `max:10` (measured in installed `pg/lib/defaults.js:42`),
`connectionTimeoutMillis:0`; live DB (07-28): `statement_timeout=0`,
`idle_in_transaction_session_timeout=0`, `max_connections=100`. Cron load grew: **11 business
sweeps + dispatch + MV refresh = 13 in-process crons**, six co-firing on every hour mark, all on
the same 10-connection pool.

This issue's pool AC is the right owner — extend it with the named values and a mobile-scale AC:

- pool `max` ≈ 25–50 (rationale: `max_connections=100` minus cron/admin/headroom);
- `connectionTimeoutMillis` ≈ 5 s — acquisition fail-fast is **the backpressure signal** a retrying
  mobile client needs; today excess requests queue forever and retries stack invisibly;
- session options: `-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000`
  (alongside the existing `-c timezone=UTC`), or env-driven equivalents;
- AC: a pool-exhausted request fails fast with a distinct error (not unbounded queuing); a
  deliberately slow query aborts (existing AC) *and* a stalled transaction is reaped.

Quantified target (plan doc §A-§5/§6): 1,000 devices polling at 60 s ≈ 50 req/s ≈ 185 SQL/s —
steady-state fits even today; the outage modes are the tails (shift-start burst ⇒ 9–18 s full-pool
saturation stalling admin + sweeps; one stuck query permanently eating 1 of 10 connections). These
config values are hours of work and convert silent latency collapse into bounded, observable
errors — **do first in the mobile runway; no load test is meaningful before it.**

### 2026-07-28 — Wave 0: pool + timeout config LANDED ✅ (AC2 config leg)

`prisma.service.ts` now builds its `PrismaPg` options from env with explicit defaults, replacing the
node-postgres defaults it had been running on:

| Setting | Was | Now (env-tunable) |
|---|---|---|
| pool `max` | 10 (pg default) | **25** — `DB_POOL_MAX` |
| `connectionTimeoutMillis` | 0 = wait forever | **5 000** — `DB_POOL_ACQUIRE_TIMEOUT_MS` |
| `statement_timeout` | 0 | **120 000** — `DB_STATEMENT_TIMEOUT_MS` |
| `idle_in_transaction_session_timeout` | 0 | **60 000** — `DB_IDLE_IN_TX_TIMEOUT_MS` |

**`statement_timeout` is deliberately 120 s, not the 30 s the freeze plan sketched.** The goal is to
bound a *stuck* query, not police slow ones, and this process runs set-based recomputes, a
materialized-view refresh and zone-wide dispatch transactions whose **per-statement** cost has never
been measured. A 30 s cap risked killing legitimate sweep work — a self-inflicted outage in the name
of preventing one. **Follow-up: measure per-statement timings on the sweep paths and tighten.**

`idle_in_transaction_session_timeout` at 60 s is safe by construction — it fires only on a
transaction that is open but not executing, i.e. exactly the leaked-connection case.

Verified: backend `tsc` clean; `batch-dispatch`, `dispatch-concurrent` (advisory locks +
transactions) and `tickets-api` all green under the new settings.

Still open on this issue: the criticalQueue `LIMIT` and the dashboard cache legs.
