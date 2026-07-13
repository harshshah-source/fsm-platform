# 99 — Global auth guard + request validation + body limits
Status: done (2026-07-13, commit `aaf233e`, TDD) — APP_GUARD chain (Auth→Role→ZoneScope) with new
`@Public()` opt-out (login/refresh, health ×2, non-op customer confirm — the sweep test pins this
allowlist); APP_PIPE ValidationPipe (whitelist+forbidNonWhitelisted+transform) with format-only
cross-zone DTOs (garbage → 400, `{code}` presence contracts unchanged); explicit BODY_LIMIT_JSON
(1mb sole parser) with the #98 filter now mapping http-errors 4xx (413/400) instead of 500;
INSTALL_CSV_MAX_ROWS (1000) count-checked before row validation → `CSV_TOO_MANY_ROWS`.
8-test e2e (canary + ~150-route sweep) + 20 regression suites (78 tests) green, tsc clean.
Type: AFK

> Source: `docs/audits/2026-07-03-backend-production-readiness-audit.md` — HIGH #10.
> Verified still-open 2026-07-07: no `APP_GUARD`/`useGlobalGuards` anywhere; `app.config.ts` sets only
> global prefix + CORS — no `ValidationPipe`, no body-size limits. Auth is opt-in per controller
> (43 of 44 remember `@UseGuards`).

## What to build

Close the "the next controller that forgets `@UseGuards` ships world-readable" gap and the
"bodies are compile-time interfaces only" gap, framework-wide:

1. **Global auth guard.** Register the AuthGuard as an `APP_GUARD` so every route is protected by
   default, with an explicit `@Public()` decorator opt-out for login/refresh/health. The
   role/zone-scope guards continue to layer on top per-route as today.
2. **Global validation.** Add a global `ValidationPipe` (or a zod-based equivalent consistent with
   the repo) so request bodies/params are validated at the edge — e.g. `BigInt(body.zoneId)` on
   garbage returns a 400, not a raw 500 (`cross-zone.controller.ts` path).
3. **Body-size + CSV row limits.** A request body-size limit and an explicit row cap on the CSV
   upload path (install bulk create) so oversized payloads are rejected cleanly.
4. **Route-guard sweep test.** A test that walks the resolved route map and asserts every route is
   either behind the global guard or explicitly `@Public()` — so a future unguarded route fails CI.

## Acceptance criteria

- [x] AuthGuard is registered as `APP_GUARD`; removing a controller's local `@UseGuards` no longer exposes it. Login/refresh/health are `@Public()`.
- [x] A global `ValidationPipe`/zod layer rejects malformed bodies/params with 400 (not 500); the `zoneId`/`BigInt` garbage case is covered by a test.
- [x] A request body-size limit is enforced; the install CSV path rejects payloads over a defined row cap with a clear error.
- [x] A route-guard sweep test asserts no route is unintentionally public; it fails if a new route is added without a guard or `@Public()`.
- [x] Existing e2e suite stays green (existing per-controller `@UseGuards` remain compatible with the global guard).

## UI surfaces
n/a (backend)

## Reference
n/a

## Blocked by
None — can start immediately. Coordinates with #91 (auth) and #98 (the exception filter improves the 400/500 shaping).
