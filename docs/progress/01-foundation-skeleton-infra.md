# Progress — Issue 01: Foundation Skeleton & Infrastructure

> Assessment date: 2026-06-17 · Source of truth: Issue 01, CONTEXT.md, PRD, workflow, backend LLD, [ADR-0025](../adr/0025-foundation-skeleton-infra.md).
> Status: **In progress (HITL) — ~3 of 7 AC green, 2 partial.** Backend auth/guard + DB foundation (TB1–TB10) + `packages/shared` + Admin Shell complete. **Remaining: mobile, CI, PostGIS, httpOnly cookie.**
> Update 2026-06-17a: DB foundation via strict TDD against **local PostgreSQL 18** (not Docker) — Prisma migrations, `system_settings`, in-tx `AuditService`.
> Update 2026-06-17b: `packages/shared` (auth/session DTOs, backend consumes) + **Admin Shell** (login → `/api/me` → shell renders role+zone; sessionStorage; CORS). Tests: backend 25, admin 4, all typecheck clean.

## Summary

The walking skeleton is **partially up**: a NestJS backend with self-managed JWT auth and a role/zone
guard chain exists and is green (15 e2e tests pass, no Docker needed). The defining P0 demo —
**a login that renders the admin shell and an audited mutation that writes an `audit_logs` row in the
same DB transaction** — is **not yet demonstrable**, because there is no database, no `AuditService`,
and no admin or mobile deployable. Roughly the no-Docker subset of ADR-0025's tracer-bullet order
(TB1–5, 7, 8) is done; the Postgres-gated steps (TB6 in-tx audit, TB9 `system_settings`, TB10 migration)
and the two missing front-ends are not.

## Acceptance criteria status

| # | Criterion | State | Evidence / gap |
|---|-----------|-------|----------------|
| 1 | Monorepo scaffolds backend + admin + mobile with shared TS DTO types | 🟡 Partial (2 of 3 + shared) | Backend ✅ + **admin ✅** (`apps/admin`, Vite+React+TS+Tailwind) + **`packages/shared` ✅** (`Role`, `SessionView`, `LoginRequest`, `LoginResponse`; backend consumes it). **Mobile still absent**; `api-client`/`config` packages not created (not required by AC#1's text). |
| 2 | Prisma schema migrates clean vs PG16+PostGIS; `system_settings` present | 🟢 Done | Prisma 7 schema + migrations apply clean; `system_settings` present and seeded (TB10/TB9). **PostGIS clause closed (2026-06-21, Issue 09)** — local dev moved to **PG16 + PostGIS 3.5.3 on :5433** (PG18 had no PostGIS Windows binaries); `CREATE EXTENSION postgis` + geometry migrations apply clean. Verified by `migration.e2e-spec.ts` + `territory-schema.e2e-spec.ts`. |
| 3 | JWT access+refresh issues role+zone claims; mobile keychain storage | 🟡 Partial | Access+refresh with `{user_id, role, zone_id}` claims ✅; single-use refresh rotation ✅. Admin stores access token in **sessionStorage** (per decision). **Mobile keychain absent**; httpOnly refresh cookie is the agreed fast-follow (CORS `credentials:true` already set). |
| 4 | Guard chain enforces role + zone; unauth/out-of-zone rejected | 🟢 Substantially complete | `AuthGuard → RoleGuard → ZoneScopeGuard` implemented + tested (401/403/zone-scope). **Missing** `CoverageScopeGuard` (SE) and `IdempotencyInterceptor` from the ADR-0025 chain. |
| 5 | `AuditService` writes `audit_logs` in same tx as a sample mutation | 🟢 Complete | `AuditService.withAudit()` runs the mutation + audit insert in one interactive `$transaction`, stamping `acted_as_role`. Atomicity proven: on `work` throw, both the mutation and the audit row roll back (`audit.e2e-spec.ts`, 2 tests). |
| 6 | Login → admin shell renders; `/api/me` returns role + zone | 🟢 Complete | `apps/admin`: login → `/api/auth/login` → `/api/me` → `AdminShell` (sidebar + top-bar) renders role + zone; CSM acting banner when `acted_as_role` present. 4 RTL tests (login/redirect/error/logout) + backend CORS test. Demo achievable: `pnpm --filter @fsm/backend start` + `pnpm --filter @fsm/admin dev`. |
| 7 | CI runs lint + typecheck + tests for all three packages | 🔴 Not started | No `.github/`. Turbo `lint` task is empty; no ESLint configured. Backend + admin have test/typecheck; mobile absent. |

## What works (verified)

- `pnpm` + Turborepo monorepo root; `apps/backend` builds and tests green.
- Self-managed JWT (`TokenService`, hand-rolled HS256 on `node:crypto`): 15-min access / 30-day refresh TTLs.
- Guard chain for role + zone scope with passing 401/403 e2e coverage.
- `/api/me` session view incl. header-driven `acted_as_role` proxy (CSM/Ops Head + `X-Acting-As-Zone`).
- **DB foundation (2026-06-17, local PG18):** dedicated `fsm` role + database; Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg` driver adapter); 2 clean migrations (`system_settings`, `audit_logs`); `SettingsService` seeds canonical defaults on boot and serves them via guarded `GET /api/settings`; in-tx `AuditService`.
- **21/21 e2e tests pass.** Auth/guard tests run without a DB; migration/settings/audit tests run against local PG18.

## Temporary implementations / technical debt

1. **In-memory stores** — `InMemoryUserStore` (4 seeded users), `InMemoryRefreshTokenStore`. Process-local; do not survive restart or scale horizontally. To be replaced by Postgres-backed stores (TB6+/TB9+).
2. **Hand-rolled HS256 JWT** — custom crypto in `TokenService` instead of a vetted library (`@nestjs/jwt`/`jose`). Comment says swappable; should be swapped before any non-skeleton use.
3. **Refresh transport** — returned in JSON `TokenPair`, not the httpOnly secure cookie ADR-0025 mandates for admin. No CSRF/cookie handling yet.
4. **`acted_as_role` is a header proxy** — `resolveActingContext` trusts `X-Acting-As-Zone` and is not driven by `ROLE_UNAVAILABILITY` cascade authorization, nor persisted to audit rows (deferred to DB slices / Issue 27).
5. ~~**`SettingsController` stub**~~ — resolved: now backed by `SettingsService` + `system_settings`.
6. **Node version drift** — ADR targets Node 20 LTS; local dev on Node 24. Not yet pinned via `engines`/CI matrix.
7. **In-memory auth stores not yet swapped to Postgres** — DB + Prisma now exist, but `InMemoryUserStore`/`InMemoryRefreshTokenStore` are still in use; `users`/`refresh_tokens` tables not yet modelled. Next persistence slice.
8. **PostGIS — RESOLVED (2026-06-21, Issue 09).** PG18 had no PostGIS Windows binaries, so local dev moved to **PG16 + PostGIS 3.5.3 on :5433** (CONTEXT.md's specified PG16). `CREATE EXTENSION postgis` is a per-database superuser bootstrap; geometry migrations apply clean. AC#2's "+ PostGIS" is closed.
9. **Dev infra is local, not Dockerized** — per your direction we use a local Postgres (now **PG16 on :5433**) instead of Docker (ADR-0025 assumed Docker). CI will need its own Postgres+PostGIS service; revisit ADR-0025 if local-PG becomes the standard.
10. **No mutation endpoint exercises `AuditService` yet** — `withAudit` is proven by tests against a `system_settings` probe; first real audited write lands with the next domain slice.

## Architectural risks

- **DB persistence path unproven (highest)** — the P0 exit gate (clean PostGIS migration + in-tx audit write) is entirely unbuilt. Until proven, every downstream slice rests on an unvalidated assumption (Prisma `Unsupported(...)` geometry + raw SQL + single-tx audit).
- **`IdempotencyInterceptor` absent** — it is foundational to all mobile submission slices (Issues 16, 17, 22, 24, 38) and the `client_submission_id` contract. Deferring it risks rework across the field loop.
- **Audit spine absent** — Issue 01 AC#5 wants a *sample* in-tx audit write; Issue 03 owns the full spine. Overlap must be resolved so the sample write isn't thrown away (see deviations).
- **No shared types package** — backend, admin, mobile will drift on DTO shapes without `packages/shared`; api-client/config also missing.
- **Custom JWT crypto** — security-sensitive surface hand-rolled; should not reach staging.

## Resequencing — 2026-06-17 (demo-driven, supersedes the order below)

The DB-first slice is **done** (TB10/TB9/TB6). Remaining order re-prioritised against the
stakeholder demo *"User logs in and sees the FSM admin shell"* — that demo touches only
`POST /api/auth/login` + `GET /api/me` (both already working, on in-memory stores) and a
missing `apps/admin`. **PostGIS contributes nothing to it** (no geometry until Issue 09) and is
demoted below the front-ends. Revised order:

1. **Admin Shell (next)** — smallest vertical slice: `apps/admin` (Vite+TS), login → `/api/me`
   → `AdminShell` (sidebar + top-bar) renders role+zone. **Closes AC#6, admin part of AC#1, cookie part of AC#3.** Design review below / in the slice's issue.
2. **`packages/shared` first DTOs** — extract `SessionView`, `TokenPair`, `LoginRequest`, `Role`
   so backend + admin share one contract (done as the opening step of the Admin slice). **AC#1 shared-types.**
3. **Mobile shell** — Expo SDK 54, keychain token storage, `/api/me`. **AC#1 (mobile), AC#3 keychain.**
4. **CI** — Actions lint+typecheck+test across all three + ESLint; needs all three packages to exist. **AC#7.**
5. **PostGIS (deferred fast-follow)** — `CREATE EXTENSION postgis` once installed on PG18. **Closes AC#2's last clause.** Required before Issue 09, not before the demo.

_Fast-follows after the minimal Admin demo:_ httpOnly refresh cookie (AC#3/ADR-0025), shadcn/Tailwind design system (AC#1 stack literal).

### Superseded order (pre-2026-06-17, kept for history: DB → CI → Admin → Mobile)

1. ~~**DB / persistence first**~~ — **done** (TB10/TB9/TB6, local PG18; `IdempotencyInterceptor` + Postgres auth-store swap still outstanding as debt, not AC-blocking).
2. **CI** — GitHub Actions lint+typecheck+test; ESLint + boundary rules; pin Node 20. **AC#7.**
3. **Admin** — `AdminShell`; login → httpOnly refresh cookie; `/api/me` renders sidebar/top-bar. **AC#6, AC#1-admin, AC#3-cookie.**
4. **Mobile** — Expo SDK 54 shell; keychain; WatermelonDB wired-not-exercised. **AC#1-mobile, AC#3-keychain.**

## Deviations from Issue 01 scope

- Scope effectively narrowed to **backend-only**; admin + mobile deployables not scaffolded (ADR-0025 §Decision lists all three).
- `packages/{shared,api-client,config}` not created (explicit in ADR-0025).
- No Docker/Postgres/Redis/S3 wiring (ADR flags Docker as a hard dependency; per-issue gating is acknowledged, but the ACs remain unmet).
- Guard chain omits `CoverageScopeGuard` and `IdempotencyInterceptor` named in ADR-0025.
- `system_settings` registry not present (AC#2).
- **Issue 01 ↔ Issue 03 audit overlap** — decide whether the AC#5 sample in-tx write lands in Issue 01 or is folded into the Issue 03 spine, to avoid duplicate/throwaway work.
