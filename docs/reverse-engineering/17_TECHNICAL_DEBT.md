# 17 — Technical Debt Register

Ranked by blast radius. Most items are **self-declared in code comments** with issue numbers —
this codebase is unusually honest about its debt; the register below consolidates and verifies.

## P0 — blocks production

| Item | Detail | Owning marker |
|---|---|---|
| DB-backed authentication | In-memory user store (5 seeded accounts, shared password) + in-memory refresh tokens; Postgres `users` exists but can't log in; restart kills all sessions | Issue #91 (`user-store.ts`, `auth.service.ts:14`, `dev-zone-resolver.ts`) |
| Deployment story | No Dockerfile, compose, CI, runbook, migration-deploy procedure | Issue #111 (absence verified) |
| Notification adapters | All external channels stubbed `UNAVAILABLE`; the intraday acceptance flow's WhatsApp confirmation and the customer non-op email cannot actually send | `notification-channel.gateway.ts` seam |
| Activation switches + data | `INGESTION_SCHEDULER_ENABLED` / `BUSINESS_SWEEPS_ENABLED` OFF; `engineer_master`/`se_coverage` unpopulated; `eligibility_mode=pgi` over empty `pgi_history` ⇒ funnel is code-complete but produces nothing unattended | scheduler configs, `eligibility.ts` |

## P1 — correctness/security risk under real load

| Item | Detail |
|---|---|
| Token storage in sessionStorage | XSS ⇒ full session theft; httpOnly-cookie upgrade already seamed (CORS credentials:true) but not built |
| Single-instance coupling | In-memory sweep guards + refresh store + node-cron make >1 replica unsafe; needs DB/advisory-lock-backed guards (dispatch already has one — extend the pattern) |
| Login hardening | No rate limit, no lockout, no security headers |
| ZM scoping by convention | ZoneScopeGuard covers only explicit zone params; per-service `zone_id` filtering is untyped convention (one miss = cross-zone data leak) |
| Interface-typed request bodies | Routes without class DTOs bypass the global ValidationPipe entirely |

## P2 — maintainability / scale

| Item | Detail |
|---|---|
| Shared-contract drift | Admin's 31 API modules hand-declare backend response shapes; only auth DTOs live in `@fsm/shared`. Any backend contract change is a silent frontend break (tests catch some) |
| Pipeline N+1 loops | Ticket creation and recommender do per-row queries/transactions; fine at hundreds, not at tens of thousands of devices |
| No client cache layer | Every admin page hand-rolls fetch/loading/error; react-query (or similar) would delete a lot of repetition and fix refetch storms |
| Two zone controllers / org module breadth | `zones` vs `org/zones`; `org` at 14 controllers is the next candidate for a split |
| Frozen cron config | Env changes require restart (documented); acceptable single-instance, awkward operationally |
| Generated Prisma client committed path under `src/generated` but gitignored | Fresh clones must run `prisma generate` before typecheck passes — undocumented setup step |

## P3 — hygiene

- Root npm artifacts (`package.json`/`package-lock.json` vestige), stray dashboard JPEGs at root.
- `docs/audits/` accumulating xlsx/csv working files (`SUMMARY REPORT Deployed (1).xlsx`, …) —
  currently untracked/uncommitted clutter in git status.
- Trailing-blank-line churn in `auth.controller.ts`.
- Backend vitest full-suite OOM on 8 GB machines (local test-infra debt).

## Debt that is deliberately NOT debt (seams by design)

The AutoPlant unconfigured fallbacks, the notification gateway, the SAP PGI table, the deferred
polygon territory editor, and the deferred `expected_components` join are all **explicit ports
with issue ownership** — the architecture anticipated their replacement; building them is
scheduled work, not entropy.
