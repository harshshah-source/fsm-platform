# 27 — Role backup cascade + CSM acting scope

Status: ready-for-agent
Type: AFK

## What to build

The role hierarchy and backup model. Hierarchy Operations Head → Central Service Manager → Zonal Manager; backup cascades strictly up. When a Central Service Manager acts in a Zonal Manager's scope, a persistent **"Acting as Zonal Manager for [Zone]"** banner shows across every page, and all such actions carry `acted_as_role = CENTRAL_SERVICE_MANAGER` in the audit trail and on every API call. CSM cross-zone read access plus acting authority in any zone's Batch Schedule, Intra-day Queue, Non-Op queue, etc. A per-zone "% of approvals performed by Central Service Manager this month" breakdown so Operations Head can spot zones where ZM backup is becoming routine. `role_unavailability` table drives the cascade.

## Acceptance criteria

- [ ] Role hierarchy + strict upward backup cascade enforced via `role_unavailability`
- [ ] CSM acting in a ZM's scope shows the persistent "Acting as Zonal Manager for [Zone]" banner
- [ ] All acted-as actions carry `acted_as_role = CENTRAL_SERVICE_MANAGER` on API calls and in audit
- [ ] CSM has cross-zone read + acting authority in ZM-scoped surfaces
- [ ] Per-zone "% approvals by CSM this month" breakdown available to Operations Head

## Blocked by

- #02
