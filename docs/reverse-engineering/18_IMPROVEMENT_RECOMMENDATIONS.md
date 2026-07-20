# 18 — Improvement Recommendations

Ordered as a pragmatic sequence, not a wish list. Each maps to findings in 15/17.

## 1. Ship the production gate (do these before anything else)

1. **DB-backed auth (#91)** — swap `InMemoryUserStore`/`InMemoryRefreshTokenStore` for Postgres
   stores keyed to the existing `users` table; add a `refresh_tokens` table (hash the token,
   store rotation lineage). The `TokenService` surface was designed to survive this swap
   untouched. Delete `DevZoneResolver` in the same change (its comment already says so).
2. **httpOnly refresh cookie** — CORS `credentials:true` is already set for exactly this;
   move the refresh token out of `sessionStorage`, keep the access token in memory only.
3. **Deployment baseline (#111)** — one multi-stage Dockerfile (backend), one for the admin
   static bundle behind nginx/caddy, docker-compose with Postgres+PostGIS, documented
   `prisma migrate deploy` step, and a `.env.example` generated from the variable inventory in
   `02_PROJECT_STRUCTURE.md`.
4. **CI** — GitHub Actions running `turbo run typecheck lint test` with a Postgres service
   container. 268 backend specs exist and run nowhere automatically; this is the cheapest
   highest-value change in the repo.
5. **Login hardening** — `@nestjs/throttler` on `/auth/*`, helmet, and an account-lockout
   counter once auth is DB-backed.

## 2. Make multi-instance safe (before scaling past one replica)

- Replace the in-memory sweep guards (`BusinessSweepSchedulerService.inFlight` Set,
  `DispatchSchedulerService.inFlight` bool) with **Postgres advisory locks** — the pattern
  already exists in batch dispatch (#100); generalize it into a small `withDbLock(name, fn)`
  helper used by every cron handler.
- Either accept single-instance cron (documented) or extract schedulers behind a leader-election
  lock; the structured `SchedulerTickOutcome` design makes both trivial.

## 3. Contract safety between backend and admin

- Move endpoint response/request types into `@fsm/shared` progressively (start with tickets,
  dashboard, schedules — the highest-churn surfaces), or generate types from the backend
  (`@nestjs/swagger` + openapi-typescript). This also produces the missing API reference for
  free and eliminates the 31-module hand-sync identified in finding #9.
- Enforce class-DTO validation on the remaining interface-typed bodies (auth, several POSTs) so
  the global ValidationPipe covers 100% of routes.

## 4. Zone-scoping defense-in-depth

- Add a `zoneScopedWhere(actor)` helper (or Prisma client extension) that services must use for
  ZM-visible queries, plus an e2e matrix test that walks every GET endpoint as a ZM and asserts
  no cross-zone rows — turning the current convention (finding #13) into an enforced invariant.

## 5. Pipeline scale readiness (when fleet size grows)

- Batch the ticket-creation loop: one set-based INSERT…SELECT for cycles+tickets (the repeat
  check can be a lateral join), keeping the P2002 skip as backstop.
- Recommender: prefetch candidates/kit/availability for the whole zone in 3 queries instead of
  per-ticket awaits; batch `recommendation` creates with `createMany`.
- These are safe refactors — both services have dense e2e coverage to pin behaviour.

## 6. Frontend leverage

- Introduce TanStack Query for fetching/caching/invalidation; the api-module layer maps 1:1 to
  query functions, so migration is mechanical page-by-page.
- Keep the interceptor; register it as the query client's fetcher instead of patching
  `window.fetch` (removes a global monkey-patch).

## 7. Observability

- Adopt pino (already name-checked in comments) with request-id propagation matching the
  existing correlation-id in `AllExceptionsFilter`; export the run-ledger tables
  (`snapshot_runs`, `master_sync_runs`, scheduler outcomes) on a `/metrics`-style endpoint or a
  simple ops dashboard page — the data model for observability already exists in Postgres.

## 8. Hygiene sweep (one small PR)

Delete root npm artifacts and stray JPEGs; move audit xlsx/csv working files out of `docs/audits`
or commit them deliberately; add `.env.example`; document `prisma generate` in a README bootstrap
section; consolidate `zones` controller into `org`.

## What NOT to do

- **Do not introduce Redis/BullMQ now.** The in-process cron + DB-guard architecture is coherent,
  idempotent, and sized for the current single-tenant fleet; a broker adds an ops dependency the
  team has explicitly avoided. Revisit only if multi-instance workers become a real requirement.
- **Do not rewrite the hand-rolled JWT** until #91; it is correct, and `@nestjs/jwt` can arrive
  with the DB-auth slice as the comments plan.
- **Do not split the monolith.** Module boundaries are clean; the seams (ports/tokens) already
  mark where any future extraction would cut.
