# 01 — Foundation skeleton & infrastructure

Status: ready-for-human
Type: HITL
Progress: in-progress (2026-06-17) — backend (auth/guards/DB/audit/settings) + packages/shared + Admin Shell done; AC#5 & AC#6 green, AC#1/#2/#3/#4 partial; remaining: mobile, CI, PostGIS, httpOnly cookie. See docs/progress/01-foundation-skeleton-infra.md.

> **Approved 2026-06-16 — decisions ratified in [ADR-0025](../../../docs/adr/0025-foundation-skeleton-infra.md).**
> Repo: GitHub · Tooling: pnpm + Turborepo · Auth: self-managed JWT (15-min access / 30-day refresh, rotation on; admin httpOnly cookie, mobile keychain) · Infra: company-managed Postgres+PostGIS, Redis, S3-compatible via Docker · CI/CD: GitHub Actions + Docker · Mobile: Expo EAS · Envs: Dev/Staging/Prod via env vars, no secrets in git.
> **Observability:** Pino structured logging · Sentry (backend/admin/mobile) · Terminus health checks (`/health` liveness + readiness) · `audit_logs` kept strictly separate from application logs.
> Implementation gated on local toolchain (pnpm install, Docker for Postgres/Redis) — see ADR-0025 Consequences.

## What to build

Stand up the walking skeleton for all three deployables and the shared infrastructure the rest of the platform builds on. One modular-monolith NestJS backend, the React + TypeScript + Vite admin dashboard shell (`AdminShell` sidebar/top-bar frame), and the React Native + Expo (SDK 54) mobile app shell. Wire Postgres 16 + PostGIS + Prisma, Redis 7 + BullMQ, and S3-compatible object storage. Implement JWT access+refresh auth with role + zone claims, the guard chain (`AuthGuard → RoleGuard → ZoneScopeGuard → IdempotencyInterceptor`), the in-transaction `AuditService` (audit row written in the same DB tx as every mutation), and the `system_settings` registry.

End-to-end demo: a user logs into the admin shell, the session carries their role + zone, a guarded `/api/me` returns role/zone, and one audited action writes an `audit_logs` row in-tx.

This is HITL because it requires human decisions on repo/monorepo layout and CI, plus provisioning of external infra and credentials (Postgres/PostGIS, Redis, S3).

## Acceptance criteria

- [ ] Monorepo scaffolds backend (NestJS), admin (React/Vite + Tailwind + shadcn/ui), and mobile (RN/Expo) with shared TS DTO types
- [ ] Prisma schema migrates clean against Postgres 16 + PostGIS; `system_settings` table present
- [ ] JWT auth (access + refresh) issues role + zone claims; mobile stores token in keychain
- [ ] Guard chain enforces role and zone scope; unauthorized/out-of-zone requests are rejected
- [ ] `AuditService` writes an `audit_logs` row in the same transaction as a sample mutation
- [ ] Login → admin shell renders sidebar/top-bar; `/api/me` returns the caller's role + zone
- [ ] CI runs lint + typecheck + tests for all three packages

## Blocked by

- None - can start immediately
