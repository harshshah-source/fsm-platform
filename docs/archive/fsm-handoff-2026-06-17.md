# Handoff — FSM Platform, Issue 01 (Foundation Skeleton & Infrastructure)

> **ARCHIVED 2026-07-12 — consumed session handoff.** Current state lives in `docs/SYSTEM-STATE-2026-07.md`; work tracking in `.scratch/fsm-platform-v1/INDEX.md`. Historical record only.
Date: 2026-06-17 · Workspace: `D:\fms_adminDashbooard\fsm-platform-greenfield`

## What this session did

Built the DB foundation, the shared types package, and the Admin Shell — all via **strict TDD
(RED→GREEN→REFACTOR)**. Canonical, up-to-date status lives in
**`docs/progress/01-foundation-skeleton-infra.md`** — read it first; do not re-derive.

- TB10/TB9/TB6: Prisma 7 + migrations, `system_settings` registry, in-tx `AuditService` (local PG18).
- `packages/shared` (`@fsm/shared`): `Role`/`ROLES`/`isRole`, `SessionView`, `LoginRequest`,
  `LoginResponse`; backend refactored to consume it.
- Admin Shell (`apps/admin`): login → `/api/me` → `AdminShell` renders role+zone; backend CORS.

Tests currently green: **backend 25, admin 4**; all three packages typecheck clean.
Issue 01 source: `.scratch/fsm-platform-v1/issues/01-foundation-skeleton-infra.md` (now carries a
`Progress:` line). Decisions ADR: `docs/adr/0025-foundation-skeleton-infra.md`.

## Issue 01 AC status (literal reading)

3 green (AC#4 guards, AC#5 audit, AC#6 shell), 3 partial (AC#1, #2, #3), 1 not-started (AC#7 CI).
Full table + evidence in the progress doc — don't duplicate it here.

## Remaining work to CLOSE Issue 01 (AC blockers only)

- **M — Mobile shell** (Expo SDK 54): login → keychain token → `/api/me` → role/zone. Closes AC#1-mobile + AC#3-keychain.
- **P — PostGIS**: install bundle on PG18 + `CREATE EXTENSION postgis` migration + `pg_extension` test. Closes AC#2.
- **S — shadcn/ui** in admin (Tailwind already present). Closes AC#1 admin literal.
- **C — CI** (GitHub Actions: lint+typecheck+test all 3 + ESLint). Closes AC#7. **Temporarily BLOCKED** — repo is not git-initialised and has no GitHub remote.

Technical debt (NOT AC blockers; do not action under Issue 01): httpOnly refresh cookie (admin token is
in sessionStorage), in-memory→Postgres auth-store swap, `@fsm/shared` raw-TS export (no `dist`),
admin session not rehydrated on reload, `IdempotencyInterceptor`/`CoverageScopeGuard`, Node 20 pin,
Redis/S3/Docker. Detail in the progress doc's debt section.

## Agreed plan / latest decision (this session)

CI is deferred until the GitHub repo exists; with CI removed, **M (mobile) is the sole critical-path long pole**;
P and S are short and parallel. **Approved next tracer bullet: M — Mobile shell** (consume `@fsm/shared`,
mirror the admin `AuthProvider`/`api/client` pattern). Trigger the PostGIS install in parallel (fire-and-forget).
The user typically: gives a tightly-scoped task, says "Strict TDD / show tests/code/AC", then "Wait" for approval
before the next step. **Wait for explicit approval before implementing.**

User decisions already locked: sessionStorage for admin token (cookie is a fast-follow, not in this slice);
Tailwind now / shadcn next; any authenticated role may access the shell (role gating later).

## Environment gotchas (important — will bite a fresh agent)

- **DB is LOCAL PostgreSQL 18, NOT Docker** (per user). Dedicated role+db `fsm` / `fsm`, owner `fsm`,
  granted `CREATEDB` (for Prisma shadow DB). Connection string in `apps/backend/.env`
  (gitignored) — **DATABASE_URL password REDACTED here**; superuser password is in the user's
  `PGPASSWORD` env var. `psql` at `C:\Program Files\PostgreSQL\18\bin\psql.exe`.
- **PostGIS is NOT installed** on this PG18 (no `.control` files); Stack Builder is present. Needed for P (and Issue 09), not for current tests.
- **FortiGate SSL inspection blocks pnpm registry fetches** (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`); the
  Fortinet CA is not in any Windows cert store. **The agent cannot install new deps** — ask the USER to
  run `pnpm add ...` / `pnpm install`, then verify. `pnpm install --offline` DOES work for pure
  workspace linking (no registry).
- **Prisma 7 specifics:** no `url` in `schema.prisma`; connection via `prisma.config.ts` (datasource
  url for Migrate) + `@prisma/adapter-pg` driver adapter in `PrismaService`. Generator is the modern
  `prisma-client` → output `apps/backend/src/generated/prisma` (gitignored). **`prisma migrate dev`
  does NOT reliably regenerate the client — run `pnpm exec prisma generate` after schema changes.**
- Tests run via `pnpm exec vitest run` inside each app (not turbo). Backend DB tests need PG18 up;
  auth/guard tests don't. Admin uses vitest + jsdom + RTL.
- Node 24 locally (target is 20).

## How to run / verify the current demo

```
pnpm --filter @fsm/backend start      # API :3000 (local PG18, in-memory users)
pnpm --filter @fsm/admin dev          # admin :5173
# login zm.north@fsm.test / correct-password  → shell shows ZONAL_MANAGER · Zone 1
```

## Suggested skills for the next session

- **`/triage`** — the user drives Issue-01 planning through triage; use it for any state/scope review.
- **`/tdd`** — all implementation here is strict RED→GREEN→REFACTOR; invoke before writing the mobile slice.
- **`/run` or `/verify`** — to launch the app / confirm the mobile login flow against the live backend.

## Immediate next action

If approved, implement **M (mobile shell)** under `/tdd`: first ask the user to install the Expo/RN
toolchain + `react-native-keychain` (FortiGate gate). Confirm the build target — `react-native-keychain`
is a native module needing a custom dev client (not Expo Go); flag, don't redesign. Then RED→GREEN:
login → keychain store → `/api/me` → render role/zone.
