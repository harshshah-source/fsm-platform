# 16 — Documentation Verification (Docs vs Code)

Docs were read **after** the source analysis, per the audit protocol. Primary docs checked:
root `CLAUDE.md`, `docs/SYSTEM-STATE-2026-07.md` (dated 2026-07-10). `CONTEXT.md` (129 KB) and
the ADR set were sampled for the claims that code could falsify, not read exhaustively.

## ❌ Documentation inaccuracies (code wins)

| # | Doc claim | Code reality | Evidence |
|---|---|---|---|
| 1 | SYSTEM-STATE §1.4: guards are "applied per-controller via `@UseGuards` — **there is no global `APP_GUARD`** (issue #99 open; an unguarded controller is silently public)" | **False since #99 landed.** `AppModule` registers `AuthGuard`, `RoleGuard`, `ZoneScopeGuard` as global `APP_GUARD`s plus a global `ValidationPipe` and `AllExceptionsFilter`; every route authenticates by default | `app.module.ts:163-183` |
| 2 | SYSTEM-STATE §1.3: "55 migrations … → `20260709120000_intraday_one_live_offer`" | 56 migrations; two newer ones exist: `20260709140000_engineer_address`, `20260714120000_plant_deactivations` | `prisma/migrations/` |
| 3 | SYSTEM-STATE §1.4: "imports 24 feature modules and mounts ~45 controllers" | 27 module imports, 46 AppModule controllers + 5 module-hosted (Auth, IntegrationHealth, IntegrationSync, Exports, PlantDeactivation) = 51 | `app.module.ts:85-162` |
| 4 | SYSTEM-STATE §1.1/funnel omits the plant-deactivation exclusion | Recommender, ticket creation, and dispatch now skip plants with an active `plant_deactivations` row (Issue #119, landed after the doc's date) | `recommender.service.ts:88`, `ticket-creation.service.ts:29-39` |

*(Items 2–4 are staleness of a doc that was accurate on its own date — the doc itself declares
"code is truth". Item 1 is materially misleading for anyone reasoning about security today.)*

## ⚠ Missing documentation

| # | Gap |
|---|---|
| 1 | No `.env.example` despite ~30 backend env variables (the gitignore even whitelists one). The full variable inventory exists only in this audit (02_PROJECT_STRUCTURE). |
| 2 | No API reference/OpenAPI — 150 endpoints are documented only by decorators + tests. |
| 3 | No deployment/runbook doc (acknowledged as open issue #111 in SYSTEM-STATE). |
| 4 | The Exports page/endpoint (#120/#121) and Plant Deactivations (#119) are absent from SYSTEM-STATE's module map and funnel — INDEX.md session log has them, SYSTEM-STATE sections don't yet. |

## ✓ Verified matches (docs that code confirms)

| Claim | Verified where |
|---|---|
| CLAUDE.md: "NestJS modular-monolith … in-process `@nestjs/schedule` cron — no Redis/BullMQ/S3 in the current stack" | dependency + code grep: true |
| CLAUDE.md: mobile is "auth shell only" | `apps/mobile/src` contains only auth + login API |
| SYSTEM-STATE: in-memory auth stores, #91 pending | `auth/user-store.ts`, `refresh-token-store.ts` |
| SYSTEM-STATE: schedulers env-gated OFF; funnel dormant without flags | `integration-scheduler.service.ts`, `business-sweep-scheduler.service.ts` |
| SYSTEM-STATE: no Dockerfile/compose/CI | repo scan: true |
| SYSTEM-STATE funnel stages [a]–[i] and their file attributions | all files exist and do what the doc says |
| Schema doc-comments (ADR-0025 UTC/timestamptz, raw-SQL partial-unique posture) | `prisma.service.ts:23`, migrations |
| `SLA_BANDS` single-source claim (backend classifier + admin legend derive from one array) | `packages/shared/src/index.ts:59-76`, `device-state/sla-bucket.ts` |

## ❌ Outdated diagrams

SYSTEM-STATE's funnel ASCII diagram remains structurally correct but predates the
plant-deactivation exclusion and the OH exports surface. No other architecture diagrams exist in
the doc set to be outdated.

## Recommendation

Apply the CLAUDE.md convention: edit `docs/SYSTEM-STATE-2026-07.md` **in place** to fix items
1–4 (global guard chain; migration count; module/controller counts; add #119/#120/#121 to the
module map). This audit set deliberately does not fork it.
