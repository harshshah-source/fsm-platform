# 110 — Rate limiting / brute-force protection on the unauthenticated surface
Status: ready-for-agent
Type: AFK

> Source: 2026-07-07 independent re-audit. The 2026-07-03 audit noted "no rate limiting" in its
> Security score justification but never issued it; #98 (boot/ops) and #99 (guard/validation) do not
> cover it. Verified: no throttler/ratelimit reference anywhere in `apps/backend` (grep: zero
> matches in src or package.json).

## Evidence

- `auth.controller.ts` — `POST /auth/login` and `POST /auth/refresh` are public and unthrottled;
  passwords are scrypt-verified (`user-store.ts`), so each guess is also CPU-costly for the server.
- `non-operational.controller.ts:124-131` — `GET /api/non-op/confirm?token=` is public and
  unthrottled. Tokens are `randomUUID()` (122-bit — not guessable), but the endpoint is a free
  scrypt-less DB probe and an enumeration/log-noise vector.
- No `@nestjs/throttler`, no reverse-proxy assumption documented anywhere.

## Root cause

Auth was built as dev scaffolding (Issue 01) with hardening deferred; the deferral was recorded for
persistence (#91) but never for abuse protection.

## Production impact

Unlimited credential-stuffing against `/auth/login` at whatever rate the DB/CPU sustains — and
because password verification is scrypt, a modest request flood doubles as a cheap CPU-exhaustion
DoS on the API process. Refresh-token guessing is similarly unbounded (opaque 256-bit tokens make
success unlikely, but the attempt traffic is free).

## What to build

Add `@nestjs/throttler` with a global default (generous — the admin dashboard polls) and strict
per-route overrides on the unauthenticated surface: `POST /auth/login` (e.g. 5/min per IP + a
per-email counter so a distributed attack against one account still locks), `POST /auth/refresh`,
and `GET /api/non-op/confirm`. 429 responses carry `Retry-After`. Keep the limiter storage
in-process for now (single instance — same posture as the refresh-token store; note the multi-
instance upgrade rides with #91's move to shared state).

## Acceptance criteria

- [ ] Exceeding the login limit returns 429 with `Retry-After`; correct credentials inside the window still work; the per-email lock triggers on distributed-IP attempts against one account.
- [ ] `/auth/refresh` and `/api/non-op/confirm` are rate-limited; authenticated API routes keep a limit high enough that dashboard polling never trips it (existing e2e suite green without test throttling hacks — throttler disabled or raised via env in tests).
- [ ] Limits are env-tunable; defaults documented.
- [ ] Regression tests: N+1th login attempt → 429; window expiry → allowed again; authenticated route under normal polling → never 429.

## UI surfaces
n/a (backend; LoginPage already surfaces error text — a 429 message ride-along is welcome but owned by #109's error mapping)

## Reference
n/a

## Blocked by
None — can start immediately. Coordinates with #99 (global guard ordering: throttler runs before auth).

## Comments

### 2026-07-28 — mobile-readiness note (docs/status/backend-mobile-readiness-plan-2026-07-28.md §A-§2)

Re-verified fully open: zero throttler code; `@Public()` now controller-wide
(`auth.controller.ts:12`). Mobile reframes this issue from security control to **availability
control**: deploy/restart wipes the in-memory session stores → 1,000 devices re-login at once →
each attempt runs a blocking `scryptSync` (`user-store.ts:78`) → process-wide stall → clients retry
harder. The existing ACs (login/refresh/non-op-confirm, per-email lockout) cover mobile needs;
sequence immediately after #91 (which removes the sync hash and the restart-wipe trigger). No
scope change — priority note only.
