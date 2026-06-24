# 33 — Install Ticket create (single + CSV, scoped)

Status: ready-for-agent
Type: AFK

## What to build

Manual Install Ticket creation. Single create (`/install/new`) and CSV bulk upload (`/install/upload`) with `install_trigger_source = MANUAL_OPERATIONS`; every Ticket records `created_by` + `created_by_role` and a full audit entry. Scope enforcement: Zonal Manager creates within own zone, Central Service Manager within authority scope, Operations Head all zones — same UI/CSV. CSV columns: `vehicle_no, plant_id, company_id, device_type, device_id` (+ optional `sim_id, target_date, notes`). CSV validation before any row is created: Vehicle exists, no active Device mapping, Plant exists, company-account context present, and each row's Plant is within the creator's zone authority — with line-number errors for bad rows so partial imports don't silently corrupt the backlog. Install and Troubleshoot share one Ticket entity with a `work_type` discriminator.

## Acceptance criteria

- [ ] Single Install create records work_type=INSTALL, `created_by` + `created_by_role`, full audit
- [ ] CSV upload validates Vehicle existence, no active Device mapping, Plant existence, company context, zone authority per row
- [ ] Bad CSV rows reported with line-number errors; no partial corruption of the backlog
- [ ] Scope enforced: ZM own zone / CSM scope / OH all zones via the same UI/CSV
- [ ] `install_trigger_source = MANUAL_OPERATIONS` set on created tickets

## Blocked by

- #07
