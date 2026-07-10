# Progress — Issue 47: RequestActor acting-attribution seam

> Build date: 2026-06-25 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE (backend)** — a single resolved `RequestActor` now carries real role +
> `acted_as_role` + `acting_zone` from the controller seam through every audited config mutation,
> not just `GET /me`. **+2 source files** (`request-actor.ts`, `current-actor.decorator.ts`),
> **+1 e2e**; `ConfigActor` removed; `auditActor()` centralizes the actor→audit flattening
> (kills ~14 `?? null` call sites). `tsc` clean; **490/490** backend e2e. No migration (the
> `audit_logs.acting_zone` column already existed, added 2026-06-24). No UI/mobile ACs.

## The defect this closes

`acted_as_role` was **structurally always `null`** on every audited mutation: controllers injected
`@CurrentUser() user: AccessTokenClaims` (`{ user_id, role, zone_id }` — no acting field) and handed
it to services as the `ConfigActor`, which then wrote `actedAsRole: actor.acted_as_role ?? null` —
only ever `null`. The acting context was resolved **only** in `GET /me`. Latent (every Issue 02
mutation is `@Roles('OPERATIONS_HEAD')`, where `null` is correct), it would become audit-trail
corruption the moment a ZM-scoped, acting-capable mutation lands (#27/#33/#35).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | A request acting in a ZM's zone (CSM/Ops-Head via `X-Acting-As-Zone`) carries `acted_as_role` through to any audited mutation, not just `/me` | 🟢 | `@CurrentActor()` resolves a `RequestActor` once at the controller seam (`resolveRequestActor` → existing `resolveActingContext`); every audited config service now consumes it and stamps via `auditActor(actor)`. Proven on the companies path; the seam is uniform across all 10 org/settings services. |
| 2 | At least one e2e drives a **non-null** `acted_as_role` onto an `audit_logs` row via a real mutation | 🟢 | `request-actor-attribution.e2e-spec` — Ops-Head `POST /api/org/companies` with `X-Acting-As-Zone: 1` → the `COMPANY_CREATED` audit row has `actedAsRole = 'OPERATIONS_HEAD'` **and** `actingZone = 1`. |
| 3 | Existing audited mutations (Ops-Head config) still record `acted_as_role = null` | 🟢 | Same spec, second case — `POST /api/org/companies` with **no** acting header → `actedAsRole` + `actingZone` both null. All pre-existing org/settings e2e (companies/zones/users/sla/scoring/plants/common-kit/territory/coverage/settings) stay green. |
| 4 | `AccessTokenClaims` is no longer the type passed where acting attribution is expected | 🟢 | All 10 audited config controllers switched from `@CurrentUser() user: AccessTokenClaims` to `@CurrentActor() actor: RequestActor`; services take `RequestActor`; `ConfigActor` (`common/config-actor.ts`) **deleted**. (Non-audited / later-issue controllers still use `@CurrentUser()` — out of #47 scope.) |

## Slice-by-slice RED→GREEN report

- **Slice 1+2 — the seam + a real non-null audit row (AC#1–#3).**
  RED: `request-actor-attribution.e2e-spec` asserted `actedAsRole = 'OPERATIONS_HEAD'` on the
  companies audit row → got `null` (the structural defect). GREEN: added `RequestActor` +
  `resolveRequestActor` (`common/request-actor.ts`), the `@CurrentActor()` param decorator
  (resolves once at the seam, reads `x-acting-as-zone`), and `auditActor()` in `audit.service.ts`;
  migrated the companies controller→`@CurrentActor()` and `companies.service` to stamp via
  `...auditActor(actor)`. The companion no-header case (AC#3) was already green — kept as a guard.
  `/me` re-pointed at the same seam (`@CurrentActor()`) so `GET /me` and audited services share one
  resolution path. REFACTOR: none (the helper landed in GREEN).

- **Slice 3 — migrate every audited config service+controller (AC#1 generality, AC#4).**
  Type-only convergence guarded by the full org/settings suite: settings, zones, users, sla-rules,
  scoring-weights, plants, common-kit, se-territory, se-coverage (+ companies from slice 2). Each
  service now takes `RequestActor` and collapses the 3-line `actorId/actorRole/actedAsRole` block to
  `...auditActor(actor)` (which also stamps `actingZone`); each controller injects `@CurrentActor()`.
  Deleted the now-unused `ConfigActor`. Full backend suite **490/490** green, `tsc --noEmit` clean.

## Deviations / decisions

1. **Seam = a param decorator, not a guard/interceptor.** `@CurrentActor()` resolves the
   `RequestActor` once where it is injected, reusing the verified claims `AuthGuard` already attached
   plus the `X-Acting-As-Zone` header. This keeps `resolveActingContext` (auth-layer truth) as the
   single resolver — `/me` and the audited services now both flow through `resolveRequestActor`.
2. **Centralized flattening (`auditActor`).** The issue's optional consolidation was taken: the
   `actor → {actorId, actorRole, actedAsRole, actingZone}` mapping now lives in exactly one place
   (`audit.service.ts`), so future audited mutations stamp attribution uniformly and `actingZone`
   stops being silently dropped by hand-written entry literals.
3. **e2e uses Ops-Head + `X-Acting-As-Zone` (not a CSM).** No CSM-accessible audited endpoint exists
   in Issue 02 scope, so the seam is proven with the one acting-capable role that *can* reach an
   audited mutation today. `resolveActingContext` stamps the caller's own role as `acted_as_role`
   when they target a zone — the genuinely-meaningful CSM/ZM-scoped flows land with #27/#33/#35,
   which this seam unblocks.
4. **Scope held to the audited config path.** Controllers outside Issue 02 (dashboard, scheduling,
   ticketing, verification, …) keep `@CurrentUser()`; they are not audited acting-capable mutations
   and converting them is #27/#33/#35's job, not a representation seam.

## Parity-gate disposition

**No UI or mobile acceptance criteria.** This is a backend attribution seam; the admin already sends
`X-Acting-As-Zone` (acting banner, #27), so both ends of the seam are wired. Nothing deferred.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/request-actor-attribution.e2e-spec.ts test/acting-context.e2e-spec.ts test/audit.e2e-spec.ts
```
