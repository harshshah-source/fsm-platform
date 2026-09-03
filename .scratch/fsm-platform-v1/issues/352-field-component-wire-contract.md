# 352 — Field component wire contract: component identity + consumed parts
Status: ready-for-agent
Type: AFK
Wave: 3 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

Two breaks in one submission path, and between them the whole component workflow never starts.

**(a) Component-unavailable reports 500.** `troubleshooting_submissions` has the CHECK constraint
`ts_submissions_component_unavailable_item`
(`prisma/migrations/20260623150000_…/migration.sql:51-52`) requiring `component_unavailable_item`
whenever `component_unavailable = true`. The controller passes `null` unvalidated
(`ticketing/troubleshoot.controller.ts:64-65`) and the shared DTO documents the field as "not sent by
this build" (`packages/shared/src/index.ts:434-437`). Every component-unavailable report therefore
fails with HTTP 500, no `component_requests` row is ever created, and the warehouse queue stays empty.

**(b) Consumed parts are never sent.** `TroubleshootSubmitRequest` (`packages/shared/src/index.ts:425-441`)
has no `consumedComponents`. The service already has the consumption loops
(`troubleshoot-submission.service.ts:296-309, 330-346`) and `decrementStock` (`:374-381`), but nothing
reaches them: van stock never depletes, no `inventory_transactions` are written, Common Kit is always
complete, Component-Blocked never fires, and `shadowUseRecorded` is always false (TKT-04).

## Current code

- `prisma/migrations/20260623150000_…/migration.sql:51-52` — CHECK `ts_submissions_component_unavailable_item`.
- `ticketing/troubleshoot.controller.ts:64-65` — passes `null` for the item, unvalidated.
- `packages/shared/src/index.ts:425-441` — `TroubleshootSubmitRequest`; `:434-437` documents the
  item field as "not sent by this build"; no `consumedComponents`.
- `troubleshoot-submission.service.ts:296-309, 330-346` — consumption loops; `:374-381` —
  `decrementStock`; `:142-143, 207-234` — the entry points to change.
- `schema.prisma:1319` — `ComponentMaster` has no list endpoint.

## What to build

- `packages/shared/src/index.ts` — `componentUnavailableItem: string` (required when
  `componentUnavailable` is true); `consumedComponents: { componentId: string, qty: number }[]`.
- `troubleshoot.controller.ts` — class-validator DTO (the troubleshoot half of **#174**); map service
  outcomes to 400 `COMPONENT_ITEM_REQUIRED`, 400 `UNKNOWN_COMPONENT`, 409 `INSUFFICIENT_VAN_STOCK`.
- `troubleshoot-submission.service.ts:142-143, 207-234` — accept and apply the new fields.
- New `GET /api/components` (all roles, active rows) as the catalog read for the picker — the
  catalog half of **#173**.
- Tests: `troubleshoot-controller.e2e-spec.ts`, `component-request-raise.e2e-spec.ts`,
  `shadow-use-conflict.e2e-spec.ts`, `inventory-rollback.e2e-spec.ts`.
- Mobile form changes are excluded; the contract must be ready for them.

## Acceptance criteria

- [ ] AC1 — component-unavailable with an item → 201 and a `component_requests` row carrying the
      component; without an item → 400, never 500.
- [ ] AC2 — `consumedComponents` decrements `se_van_stock`, writes `TICKET_CONSUMPTION`
      transactions, and on the business-409 path records SHADOW_USE with `shadowUseRecorded: true`.
- [ ] AC3 — Common Kit status changes after a consumption that empties a kit item, and the
      recommender writes `component_blocked_queue`.
- [ ] AC4 — `GET /api/components` returns the catalog.
- [ ] AC5 — submissions without the new fields behave exactly as today.

## Verification

e2e for AC1–AC4 end to end (submit → van stock → kit → blocked queue → WM request queue); the
existing rollback tests now have rows to roll back.

## UI surfaces

n/a — backend and shared-contract only (the mobile form that will send the fields is excluded by
scope).

## Reference

n/a — no UI surface in this slice.

## Blocked by

- #336 — dev seed fixtures (van stock, SE rows) needed to walk the path

## Absorbs / supersedes

- survey ids: TKT-02, INV-G8, TKT-04 (backend consequence of INV-G8)
- existing issues: the troubleshoot half of #174 and the catalog half of #173 (each closes into this
  slice when it lands; the remainder of #173 / #174 stays where it is)
