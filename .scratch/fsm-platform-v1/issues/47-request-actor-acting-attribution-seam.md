# 47 — RequestActor acting-attribution seam

Status: done
Type: AFK
Origin: Issue 02 deep review + architecture review (2026-06-18).
Done: 2026-06-25 — `RequestActor` + `@CurrentActor()` seam + `auditActor()` flattening; `ConfigActor`
removed; e2e drives non-null `acted_as_role` + `acting_zone` onto a real audited mutation. See
`docs/progress/47-request-actor-acting-attribution-seam.md`.

## Problem

`acted_as_role` is **structurally always `null`** on every audited mutation. Controllers inject
`@CurrentUser() user: AccessTokenClaims` (`{ user_id, role, zone_id }` — no `acted_as_role` field)
and pass it as the `ConfigActor`; every service then writes `actedAsRole: actor.acted_as_role ?? null`,
which can only ever be `null`. The acting context is resolved **only** in `GET /me`
(`resolveActingContext` in `auth/acting-context.ts`), a read — it never reaches a mutation. The
audit unit test (`test/audit.e2e-spec.ts`) hand-sets `actedAsRole`, so it proves the audit module
stores what it is given but masks the fact that no HTTP mutation can produce a non-null value.

**Why it's latent, not yet active:** every Issue 02 mutation is `@Roles('OPERATIONS_HEAD')`, and an
Operations Head configuring is never "acting as a Zonal Manager" — so `null` is the *correct* value
today. The defect becomes a real audit-trail corruption the moment a **ZM-scoped, acting-capable**
mutation lands: **#27 (CSM acting scope), #33 (Install Ticket create), #35 (Non-Operational)**, where
the backup cascade must record `acted_as_role = CENTRAL_SERVICE_MANAGER` (etc.) and won't.

## What to build

- A single **RequestActor** resolved once at a seam (guard or interceptor) carrying real role +
  `acted_as_role` + acting zone, attached to the request and consumed by both `/me` and the audited
  services — so controllers stop handing services a shape that cannot carry attribution.
- Optionally let `AuditService.withAudit(actor, descriptor, work)` absorb the
  `ConfigActor → {actorId, actorRole, actedAsRole}` flattening, so the fix lands in one place instead
  of the ~9 duplicated `?? null` call sites.
- Do **not** change behaviour for existing Issue 02 rows — `null` stays correct for OpsHead config.

## Acceptance criteria

- [x] A request acting in a ZM's zone (CSM/Operations Head via `X-Acting-As-Zone`) carries
      `acted_as_role` through to any audited mutation it performs, not just `/me`
- [x] At least one e2e drives a non-null `acted_as_role` onto an `audit_logs` row via a real mutation
- [x] Existing audited mutations (OpsHead config) still record `acted_as_role = null`
- [x] `AccessTokenClaims` is no longer the type passed where acting attribution is expected

## Notes

- Pairs with ADR-0015 (role backup cascade). This issue converges the *representation* only; the
  cascade *authorization* (who may act when, driven by `ROLE_UNAVAILABILITY`) is #27's job.
- Land **before** #27/#33/#35.

## Blocked by

- #02
