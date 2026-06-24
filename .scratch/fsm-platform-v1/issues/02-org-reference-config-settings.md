# 02 — Org / reference config + Settings

Status: ready-for-agent
Type: AFK
Progress: ACCEPTED WITH FOLLOW-UP (2026-06-18 deep review). AC complete enough to unblock Issue 04
(zones/plants/companies tables + idempotent seed exist; Issue 04 only reads reference data). Backend:
zones/plants/users (prior) + companies, SE coverage (engineer_master+se_coverage), SLA rules, scoring
weights, common kit, idempotent reference seed. Admin `/settings` Operations-Head-gated page (tabs:
Zones/Users/Companies/SE Coverage/SLA/Weights/Common Kit). Tests: backend 61, admin 7, all typecheck
clean. **AC#2 downgraded to PARTIAL** by the deep review (plants not in Admin UI; company update path
absent). AC#5 (`device.deal_type`) DEFERRED. **Not reopened** — gaps tracked as follow-ups #45–#48.
See docs/progress/02-org-reference-config-settings.md.

## What to build

The Operations Head Settings module and the reference/org data it manages. CRUD for zones, plants, SE mappings and SE coverage types (DEDICATED / MULTI_PLANT / FLOATING), SLA rules (`submit_within_minutes`, `verify_within_minutes`, `escalate_after_minutes`) per device bucket or company tier, Company Tier (PLATINUM / GOLD / SILVER) and Company Priority Rank (A / B / C), the Common Kit definition (cables, SIM, antenna, fuse), Recommender scoring weights, and user accounts for all roles. There is no separate Admin persona — Operations Head owns all configuration. Manual `device.deal_type` (RECURRING / ONE_TIME) tagging when CRM/SAP data is missing.

End-to-end: Operations Head opens `/settings`, edits a config value, it persists via API, and the change is audited and reflected on read.

## Acceptance criteria

- [x] `/settings` page gated to Operations Head only; other roles cannot reach it
- [~] Zones, plants, SE mappings, coverage types editable and persisted — **PARTIAL** (see below)
- [x] SLA rules, Company Tier/Priority Rank, Common Kit definition, scoring weights configurable without code changes
- [x] User accounts manageable for ZM, CSM, Warehouse Manager (and SE)
- [ ] `device.deal_type` manually taggable — DEFERRED; owner resolved to **#49** (dedicated slice before #35) via #48 triage
- [x] Every config mutation writes an audit entry
- [x] Reference/org seed data loads for downstream slices

### AC#2 partial — known gaps (do not reopen; tracked as follow-ups)

- **Plants not editable in the Admin UI.** `PlantsAdminController` (`GET/POST /api/org/plants`)
  exists and persists, but `/settings` has no Plants tab and `apps/admin/src/api/org.ts` exposes no
  `listPlants`/`createPlant`. The SE Coverage form requires a hand-typed raw `plantId` with no way to
  list or create plants. → **follow-up #45**.
- **Company update path missing.** `companies.service.ts` is create-only; `company_tier`,
  `company_priority_rank`, and `ops_override` cannot be changed after creation, so CONTEXT.md's
  "Operations Head can override per-company" is unsatisfiable. → **follow-up #46**.

Both are reference-data **reads** for Issue 04, which the existing tables + seed already satisfy, so
neither blocks ingestion. Two further review findings are tracked separately: the dead
`acted_as_role` attribution seam (#47) and the `deal_type` ownership clarification (#48).

## Blocked by

- #01
