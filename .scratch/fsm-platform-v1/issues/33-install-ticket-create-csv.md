# 33 — Install Ticket create (single + CSV, scoped)

Status: done
Type: AFK

## What to build

Manual Install Ticket creation. Single create (`/install/new`) and CSV bulk upload (`/install/upload`) with `install_trigger_source = MANUAL_OPERATIONS`; every Ticket records `created_by` + `created_by_role` and a full audit entry. Scope enforcement: Zonal Manager creates within own zone, Central Service Manager within authority scope, Operations Head all zones — same UI/CSV. CSV columns: `vehicle_no, plant_id, company_id, device_type, device_id` (+ optional `sim_id, target_date, notes`). CSV validation before any row is created: Vehicle exists, no active Device mapping, Plant exists, company-account context present, and each row's Plant is within the creator's zone authority — with line-number errors for bad rows so partial imports don't silently corrupt the backlog. Install and Troubleshoot share one Ticket entity with a `work_type` discriminator.

## Acceptance criteria

- [x] Single Install create records work_type=INSTALL, `created_by` + `created_by_role`, full audit
- [x] CSV upload validates Vehicle existence, no active Device mapping, Plant existence, company context, zone authority per row
- [x] Bad CSV rows reported with line-number errors; no partial corruption of the backlog
- [x] Scope enforced: ZM own zone / CSM scope / OH all zones via the same UI/CSV
- [x] `install_trigger_source = MANUAL_OPERATIONS` set on created tickets

## Blocked by

- #07

## Disposition (done — backend slice, 2026-06-26)

Backend vertical slice complete and verified green (12 e2e: `install-create` ×4 / `install-controller` ×4
/ `install-csv` ×4). Migration `20260626120000_add_install_tickets` (additive on `tickets`:
`created_by`, `created_by_role`, `install_trigger_source` enum [`MANUAL_OPERATIONS`/`EXTERNAL_API` —
v2 webhook defined up-front, no later `ALTER TYPE`], `install_batch_id`, `install_sim_id`/
`install_target_date`/`install_notes`). `InstallService` (single + all-or-nothing CSV with per-row
line-numbered errors) + `InstallController` (`POST /api/install`, `POST /api/install/upload`, creator
roles ZM/CSM/OH, `@CurrentActor()` audit-attribution via #47). Mirrors the #36 posture (shared `tickets`
table + work-type discriminator).

**Parity gate:** the ACs above are backend-phrased and met across both channels; the *admin Install-create
surface* (single-create form + CSV upload page consuming these endpoints) is filed as follow-up **#69**
and linked in INDEX. Scope enforcement (ZM/CSM/OH) is proven identical for both channels at the
service+controller layer. CSM scope = unrestricted-all-zones in v1 (CSM is central authority; per-zone
CSM-authority narrowing rides on #27's acting-scope seam, not re-implemented here).
