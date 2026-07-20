# 15 — Codebase Findings (Validation Pass)

Findings from the architecture-validation phase. Each item cites code evidence.
Severity: 🔴 significant · 🟡 worth attention · 🟢 informational.

## Dead / vestigial code & artifacts

| # | Finding | Evidence |
|---|---|---|
| 🟢 1 | Root `package.json` + `package-lock.json` are npm leftovers (only `@playwright/mcp`, `turbo`); the real lockfile is pnpm's. `package-lock.json` is even gitignored yet exists on disk | repo root |
| 🟢 2 | Stray reference images at repo root (`oh-dashboard.jpeg`, `zm-east-dashboard.jpeg`) belong in `docs/ui/` | repo root |
| 🟢 3 | `KitchenSink` page is dev-only by design (`import.meta.env.DEV` route) — not dead, but excluded from prod | `AppRoutes.tsx:51` |
| 🟢 4 | `InMemorySourceReader` / `EMPTY_MASTER_SOURCE` are live fallbacks, not dead code — they are the unconfigured-env binding | `ingestion.module.ts:41-46,135` |
| 🟡 5 | Duplicate zone read surfaces: `GET /zones/:zoneId` (`zones/zones.controller.ts`) alongside `GET /org/zones` (`org/zones.controller.ts`) — two controllers, two modules, overlapping concern | both files |
| 🟡 6 | `AuthController` file padded with ~10 trailing blank lines — cosmetic churn artifact | `auth/auth.controller.ts:28-39` |

## Duplicate / divergent logic

| # | Finding | Evidence |
|---|---|---|
| 🟡 7 | Guard registration duplicated: guards are global `APP_GUARD`s **and** still provided/`@UseGuards`-ed per-controller in `IngestionModule` ("re-runs are idempotent" per comment) — two enforcement styles to keep in sync | `app.module.ts:174-176`, `ingestion.module.ts:57-66` |
| 🟡 8 | DTO validation is split-brain: class-validator DTOs get the global pipe; interface-typed bodies (e.g. `AuthController`'s `LoginRequest`) get **no validation at all** — deliberate ("contracts don't drift") but means whole routes rely on service-level checks | `app.module.ts:178-182`, `auth.controller.ts` |
| 🟡 9 | Frontend API modules re-declare response types locally instead of importing from `@fsm/shared` (shared only covers auth/session + SLA bands) — 31 modules of hand-kept contract duplication with the backend | `apps/admin/src/api/*` vs `packages/shared/src/index.ts` |

## Coupling & design observations

| # | Finding | Evidence |
|---|---|---|
| 🟡 10 | `RecommenderService` self-constructs collaborators as constructor defaults (`new InventoryService(prisma)` …) — bypasses DI when built manually; hides the real dependency graph | `recommender.service.ts:66-74` |
| 🟡 11 | Recommender run is O(tickets × candidates) with per-ticket awaits (`orderedCandidatesForPlant`, per-SE kit/availability memoised but still serial creates per row) — fine at current volumes, a hotspot at fleet scale | `recommender.service.ts:136-239` |
| 🟡 12 | `TicketCreationService` loops candidates with one repeat-check query + one transaction each — N+1 pattern on the pipeline hot path | `ticket-creation.service.ts:52-80` |
| 🟡 13 | `ZoneScopeGuard` only clamps when `:zoneId`/`zone_id` is explicitly present; all other ZM scoping is by-convention inside services — a forgotten `where zone` in a new service is silently fleet-wide | `zone-scope.guard.ts:30-41` |
| 🟢 14 | `DeviceStateModule` is imported only by `IngestionModule`; other consumers read `device_states` through their own Prisma queries — table-level coupling instead of service reuse (acknowledged in SYSTEM-STATE) | module imports grep |
| 🟢 15 | God-ish modules by breadth: `org` (14 controllers) and `ticketing` (8 controllers, 12 services) are wide but internally cohesive; no true god *service* found — logic is well sliced per concern | file tree |

## Security observations (see also 09/17)

| # | Finding | Evidence |
|---|---|---|
| 🔴 16 | **In-memory auth**: 5 hard-coded dev users with a published password; DB users cannot log in; refresh tokens die on restart. Acceptable only pre-production; blocks any real deployment | `auth/user-store.ts` |
| 🔴 17 | Admin tokens in `sessionStorage` — readable by any XSS; the httpOnly-cookie upgrade is explicitly deferred | `api/tokens.ts` comments |
| 🟡 18 | No rate limiting / brute-force protection on `/auth/login`; no helmet/security headers anywhere | absence in `main.ts`/`app.config.ts` |
| 🟡 19 | Hand-rolled JWT: sound implementation (timing-safe compare, exp check) but `alg` is not pinned-verified from the header (it recomputes HS256 regardless — actually safe against alg-confusion) and there is no `nbf`/`aud`/`iss`. Low risk, non-standard | `token.service.ts:35-59` |
| 🟢 20 | Good: fail-fast secret validation, scrypt hashing even for seeds, single-use refresh rotation with reuse detection, timing-safe comparisons throughout | `boot-config.ts`, `user-store.ts`, `refresh-token-store.ts` |

## Scalability / reliability observations

| # | Finding | Evidence |
|---|---|---|
| 🔴 21 | Single-instance assumptions everywhere: in-memory refresh store, in-memory sweep guards, in-process cron. Running two replicas would double-fire the (in-memory-guarded) sweeps whose serialization is not DB-backed | `business-sweep-scheduler.service.ts:103` (Set), `dispatch-scheduler.service.ts:41` (bool) |
| 🟡 22 | Cron expressions are frozen at module load ("flipping the env flag requires a restart") — self-documented operational caveat | `integration-scheduler.service.ts:46-48` |
| 🟡 23 | The eligibility gate defaults to `pgi` mode over a manually-seeded `pgi_history`; with the SAP feed absent, ticket creation silently yields zero unless `eligibility_mode` is switched — a business switch disguised as data absence | `device-state/eligibility.ts`, `device-state.service.ts:60-68` |
| 🟢 24 | Strong idempotency discipline: every pipeline stage is re-runnable (documented + tested); resume-cursor vs display-watermark separation in the snapshot worker is unusually careful | `snapshot-ingestion.worker.ts:120-134` |

## Test posture

268 backend spec files covering every controller/service including race/idempotency e2e
(dispatch-concurrent, intraday-accept-timeout-race, snapshot-partial-cursor). Frontend has
component tests + visual-diff scripts. **No CI executes any of this automatically.**
