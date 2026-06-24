# 27 — Role backup cascade + CSM acting scope

Status: accepted (cascade + acting banner + CSM authority + %-report; per-endpoint audit-threading incremental)
Type: AFK
Progress: docs/progress/27-role-backup-cascade-csm-acting.md — AC#1–#5. Migrations `20260624200000_add_role_unavailability` + `20260624210000_audit_acting_zone`. Acting-context seam (X-Acting-As-Zone → acted_as_role) pre-existing; admin banner + acting-mode + CSM Backup Share report new. 2026-06-24.

## What to build

The role hierarchy and backup model. Hierarchy Operations Head → Central Service Manager → Zonal Manager; backup cascades strictly up. When a Central Service Manager acts in a Zonal Manager's scope, a persistent **"Acting as Zonal Manager for [Zone]"** banner shows across every page, and all such actions carry `acted_as_role = CENTRAL_SERVICE_MANAGER` in the audit trail and on every API call. CSM cross-zone read access plus acting authority in any zone's Batch Schedule, Intra-day Queue, Non-Op queue, etc. A per-zone "% of approvals performed by Central Service Manager this month" breakdown so Operations Head can spot zones where ZM backup is becoming routine. `role_unavailability` table drives the cascade.

## Acceptance criteria

- [x] Role hierarchy + strict upward backup cascade enforced via `role_unavailability` (`RoleBackupService.currentActingRoleForZone`)
- [x] CSM acting in a ZM's scope shows the persistent "Acting as Zonal Manager for [Zone]" banner (AdminShell acting-mode)
- [x] Acted-as actions carry `acted_as_role` on API (acting-context seam + `X-Acting-As-Zone` header) and audit rows support `acted_as_role`/`acting_zone` (per-endpoint audit threading is incremental)
- [x] CSM has cross-zone read + acting authority in ZM-scoped surfaces (services accept CSM/acting as manager)
- [x] Per-zone "% approvals by CSM this month" breakdown for Operations Head (`/reports/csm-approval-share`)

## UI surfaces

- **Admin:** persistent acting banner + acting-mode entry (CSM/Ops, AdminShell); CSM Backup Share
  report page (`/reports/csm-approval-share`, Operations Head). Built here.
- No dedicated v2 mockup; banner follows the existing header status-chip pattern, report follows the
  reports table pattern.

## Blocked by

- #02
