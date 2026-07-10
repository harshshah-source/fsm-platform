# Progress — Issue 49: Device `deal_type` column + Operations-Head manual tagging

> Build date: 2026-06-25 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE (backend)** — Ops-Head audited `deal_type` tag + device read path. The column already
> existed (Issue 05 spine); admin tag control deferred to **#44** (Device Detail) per spec. Backend
> **+1 module / +1 service / +1 controller / +2 e2e files**; `tsc` clean; **485/485** e2e. No migration
> (column pre-existed).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | `device.deal_type` enum column (RECURRING \| ONE_TIME, nullable) + migration | 🟢 | Already present — `DealType` enum + `Device.dealType` column + `@@index([dealType])` (schema), added by Issue 05's `20260620124718_add_device_ticket_spine` migration. No new migration needed. |
| 2 | Operations-Head-only manual-tag endpoint sets `deal_type`, audited; other roles 403 | 🟢 | `PATCH /api/devices/:deviceId/deal-type` (`@Roles('OPERATIONS_HEAD')`); `DeviceService.setDealType` writes via `AuditService.withAudit` (`action = DEVICE_DEAL_TYPE_TAG`, metadata `{ dealType, previous }`). ZM/SE → 403; bad enum → 400; unknown device → 404; unauth → 401. `device-deal-type-service` (4) + `devices-controller` (4). |
| 3 | `deal_type` readable wherever #35 needs it (device read path) | 🟢 | `GET /api/devices/:deviceId` (manager-roled) returns `DeviceView` incl. `dealType`; `DeviceService.getDevice` is the in-process read #35 consumes. |
| 4 | INDEX + #35 "Blocked by" reflect that #35 depends on this slice | 🟢 | #35 already lists `#49 (device.deal_type column — drives the RECURRING-only auto-Recovery-Ticket rule)`; INDEX 49 marked done. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — service.** `DeviceService.setDealType` (audited tag, NOT_FOUND for unknown) + `getDevice`
  read. `DeviceView` projects bigint ids to strings. RED = missing service module.
  `device-deal-type-service.e2e-spec` (4) GREEN.
- **Slice 2 — HTTP.** `DevicesController` + `DevicesModule` (imports Prisma + Audit). `PATCH
  :deviceId/deal-type` (Ops-Head only, enum-validated, id-validated) + `GET :deviceId` (manager read).
  Wired into AppModule. RED = controller absent. `devices-controller.e2e-spec` (4) GREEN.

## Deviations / decisions

1. **Column pre-existed — no migration.** The `deal_type` column + enum + index were laid down by the
   Issue 05 device-ticket spine (forward-looking). Issue 49 only adds the write/read behaviour, so AC#1
   was already satisfied; no schema change in this issue.
2. **`previous` captured in the audit metadata.** Re-tagging (CRM correction) records the prior value
   alongside the new one for a clean change trail.
3. **Read path is the device read, not a per-snapshot value.** `deal_type` lives on the `device`
   master (stable attribute), never `device_states` — matching the spec and CONTEXT "Deal Type".

## Parity-gate disposition

- **Admin surface deferred to #44** (Device Detail page) per the issue spec — "the endpoint is the
  hard requirement here; [the minimal tag control] may defer to the Device Detail page (#44) if that
  lands first." #44 is an existing tracked backlog issue. **Mobile: n/a.** Compliant — the only hard
  AC (the endpoint) is built; the optional UI control has a tracked owner.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/device-deal-type-service.e2e-spec.ts test/devices-controller.e2e-spec.ts
```
