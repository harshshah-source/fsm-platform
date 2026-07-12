# 98 — Boot & ops hardening: fail-fast env validation, graceful shutdown, health probe, structured logging
Status: done (2026-07-12) — 4 slices: `25a46d4` fail-fast boot config + fallback-JWT-secret removal,
`e61b71a` public liveness/readiness probes, `8c3a26f` graceful shutdown + fatal bootstrap guard,
`55183e6` global exception filter + error correlation id. Deliberate deviation from leg 5: the pino
structured-JSON-logging swap was NOT adopted (Nest `Logger` retained); correlation ids are delivered
by the filter on the error path. If full request-scoped structured logging is wanted, file it as a
follow-up — it is not silently pending here.
Type: AFK

> Source: `docs/audits/2026-07-03-backend-production-readiness-audit.md` — CRITICAL #5 (residual) + HIGH #7.
> Verified still-open 2026-07-07: `auth/token.service.ts:18` still carries the fallback secret;
> `main.ts` is still `void bootstrap()` with no config validation, no shutdown hooks; the only health
> endpoint is `/api/integration/health` (AutoPlant-specific), not a general liveness/readiness probe.

## What to build

Turn the process from "boots and hopes" into an observable, fail-fast, gracefully-terminating
service. Five independent hardening legs, deployable together:

1. **Fail-fast env validation at boot.** A single startup validator that throws (before `listen`) if
   required config is unset or unsafe — at minimum `JWT_ACCESS_SECRET` (present, non-default,
   ≥ 32 chars) and `DATABASE_URL` (present, parseable). In `production` the checks are always fatal.
2. **Remove the fallback JWT secret.** `TokenService` must read the validated secret and never fall
   back to a repo-published constant, so a missing env var can no longer sign forgeable tokens.
3. **Graceful shutdown.** `enableShutdownHooks()` so `onModuleDestroy` (Prisma disconnect, AutoPlant
   MySQL pool end) actually fires on SIGTERM; `bootstrap()` failures surface as a logged fatal exit,
   not an unhandled rejection.
4. **General health probe.** A public `/api/health` (liveness) and readiness check (DB reachable)
   distinct from the AutoPlant integration health controller.
5. **Structured logging + a global exception filter.** Replace ad-hoc `Logger` output with a
   structured JSON logger (pino), a global exception filter that maps unhandled errors to clean
   responses (no stack leakage) and logs them, and a per-request correlation id.

## Acceptance criteria

- [x] Boot aborts with a clear error when `JWT_ACCESS_SECRET` is unset, equals the old dev default, or is too short; and when `DATABASE_URL` is unset/unparseable. In `production` these are always fatal.
- [x] `TokenService` has no `?? 'dev-...'` fallback; tokens can only be signed with the validated secret.
- [x] `main.ts` calls `enableShutdownHooks()`; a SIGTERM triggers Prisma `$disconnect` and the MySQL pool `end` (assert via the `onModuleDestroy` chain). `bootstrap()` rejection logs a fatal and exits non-zero.
- [x] `GET /api/health` returns 200 with a body indicating liveness; a readiness check reports DB reachability. Route is `@Public()`.
- [x] A global exception filter is registered; unhandled errors return a sanitized JSON body (no stack), are logged with a correlation id, and 500s are no longer raw.
- [x] Requests carry/emit a correlation id in logs (error path — via the filter; full request-scoped pino logging deliberately not adopted, see Status).
- [x] Existing e2e suite stays green; new tests cover env-validation failure modes and the health/readiness responses.

## UI surfaces
n/a (backend/ops)

## Reference
n/a

## Blocked by
None — can start immediately. Coordinates with #91 (Postgres auth) but does not depend on it.
