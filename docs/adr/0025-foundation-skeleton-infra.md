# ADR-0025: Foundation Skeleton & Infrastructure (Issue 01)

## Status

Accepted (2026-06-16) — supersedes nothing; first build-time ADR. Stack-level choices ratify
backend LLD §1; this ADR records the HITL decisions approved for Issue 01.

## Context

The platform is greenfield — only `docs/` exists. Issue 01 (`.scratch/fsm-platform-v1/issues/01-…`)
is the HITL foundation slice that must stand up all three deployables and the shared infrastructure
every later slice depends on. The walking-skeleton demo: a user logs into the admin shell, the
session carries role+zone, a guarded `/api/me` returns role+zone, and one audited action writes an
`audit_logs` row in the same transaction. P0 exit criteria (LLD §17): schema migrates clean; guards
enforce role+zone; audit writes in-tx.

## Decision

**Repo & tooling.** Single Git **monorepo on GitHub**, **pnpm workspaces + Turborepo**. Workspaces:
`apps/{backend,admin,mobile}`, `packages/{shared,api-client,config}`. TypeScript strict throughout.

**Backend.** **NestJS modular monolith** (Node 20 LTS target) with guard/interceptor chain
`AuthGuard → RoleGuard → ZoneScopeGuard → (CoverageScopeGuard for SE) → IdempotencyInterceptor`
(LLD §1.2, §8). Modules map 1:1 to the LLD service catalogue.

**Admin.** React + TS + Vite, Tailwind, shadcn/ui, React Router, TanStack Query. No SSR.

**Mobile.** React Native + Expo (SDK 54) + Expo Router, `react-native-keychain`, WatermelonDB/SQLite
(wired, not exercised until Issue 17).

**Auth (self-managed JWT).** Access + refresh JWT carrying `{ user_id, role, zone_id }`.
**15-min access / 30-day refresh, rotation on.** Admin stores refresh in an **httpOnly secure
cookie**; mobile stores tokens in **keychain**. `acted_as_role` resolved server-side from the
backup cascade and stamped on every audit row. Five roles, no `ADMIN`.

**Persistence.** **Postgres 16 + PostGIS** via **Prisma**. Native enums, `bigserial` PKs (`uuid` for
`users`/`tickets`), `timestamptz` UTC, `numeric(12,2)` money, `version` optimistic-lock columns,
snake_case via `@map`. PostGIS geometry as Prisma `Unsupported(...)` + raw SQL; `plant_eligible_floating_se`
as a materialized view. Audit written **in the same transaction** as each mutation (single-tx, no outbox).

**Cache/queue.** **Redis 7** (cache, WS fan-out, idempotency fast-path) + **BullMQ** (idempotent jobs,
retries, repeatable crons).

**Object storage.** **S3-compatible**, signed-URL direct upload; no blobs through the API.

**Infrastructure (company-managed).** Postgres+PostGIS, Redis, and S3-compatible storage are
company-managed and run via **Docker** locally and in CI. Deployment via **GitHub Actions + Docker
images**. Mobile builds via **Expo EAS**.

**Environments & secrets.** Dev / Staging / Prod via **environment variables**; **no secrets in git**.

**Observability.** **Pino** structured logging (backend); **Sentry** error/perf monitoring across
backend, admin, and mobile; **Terminus** health checks (`/health` liveness + readiness probing
Postgres/Redis/S3); **audit logs (`audit_logs`) kept strictly separate from application logs** —
audit is the immutable in-tx domain record, app logs are operational telemetry.

## Consequences

- **Docker is a hard local + CI dependency.** Integration/e2e tests for the in-tx audit write,
  `system_settings` reads, and the PostGIS migration require a real Postgres+PostGIS+Redis; they
  cannot run without Docker (or an externally provided Postgres+Redis). Guard/auth-logic tests
  (401/403/role/zone) do not need a DB.
- PostGIS support in Prisma is second-class (raw SQL for all geo + MV refresh); the managed Postgres
  provider must enable the PostGIS extension.
- JWT revocation relies on short access TTL + refresh rotation + a denylist for forced logout.
- pnpm + Expo/Metro require hoisting configuration (`node-linker`/`watchFolders`).
- Monorepo CI is path-filtered via Turborepo to stay fast; lint boundary rules prevent `apps/*`
  importing each other directly.
- Node 20 LTS is the target runtime; local dev currently runs Node 24 (acceptable for dev, pin via
  `engines`/CI matrix to 20 for parity).
- Terminus readiness gating + Sentry DSNs become per-environment configuration (env vars).

## Tracer-bullet order (Issue 01, TDD)

1 unauth → 401 · 2 login issues role+zone token · 3 `/api/me` returns role+zone · 4 RoleGuard 403 ·
5 ZoneScopeGuard 403 · 6 audit row in-tx · 7 `acted_as_role` stamped · 8 refresh rotation / revoked
refresh 401 · 9 `system_settings` default read · 10 migration clean with PostGIS. (1–5, 7, 8 run
without Docker; 6, 9, 10 require Postgres.)
