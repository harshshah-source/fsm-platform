# ADR-0011: Install Tickets Created by Operations Head Only in v1; External Order Webhook Deferred to v2

## Status

**Superseded (2026-06-08)** — Install Tickets are no longer Operations-Head-only. They are created manually (single-create UI or CSV bulk upload) by **Zonal Manager** (own zone), **Central Service Manager** (authority scope), or **Operations Head** (all zones), each scope-enforced; every Ticket records `install_trigger_source = MANUAL_OPERATIONS` plus `created_by` and `created_by_role` with full audit. Auto-PGI creation and the External Order Webhook (v2) remain out of scope as before. See `CONTEXT.md` Decisions §11 and the 2026-06-08 business edits.

The "Operations Head **only**" creation rule in the Decision below is **no longer in force**. Install Tickets are now created by **Zonal Manager (own zone) / Central Service Manager (authority scope) / Operations Head (all zones)**, each **scope-enforced**, recording `created_by` + `created_by_role` + a full audit entry. The CSV schema and validation rules below remain accurate **except** that (a) creation authority is no longer Operations-Head-exclusive, and (b) every row's Plant must fall within the creator's zone authority before any Ticket is created. `install_trigger_source = MANUAL_OPERATIONS` (v1) / `EXTERNAL_API` (v2) are unchanged.

_Original status: Accepted._

## Context

Install Tickets must enter the system somehow. Options evaluated: auto-creation from SAP PGI events, Zonal Manager or Admin creation paths, External Order Webhook, and manual Operations Head creation. Auto-PGI integration confidence is insufficient at v1 to gate customer-billable install work — a misfire would create phantom Install Tickets consuming SE Day Plan capacity. Multi-source creation disperses install-pipeline ownership.

PGI events are the eligibility signal for Fleet Uptime (ADR-0005), not an install trigger — conflating the two would couple unrelated concerns.

## Decision

For v1, the **only** way an Install Ticket enters the system is **Operations Head manually creating it** — through the FSM web UI or a CSV bulk upload. Each Install Ticket carries `install_trigger_source = MANUAL_OPERATIONS`. No Zonal Manager or Admin creation path.

In v2 (roadmap), an **External Order Webhook** from another application will add `install_trigger_source = EXTERNAL_API`. Auto-PGI-driven install creation remains explicitly **out of scope**.

**CSV bulk upload schema:**

| Column | Required | Notes |
|---|---|---|
| `vehicle_no` | Mandatory | Validated against Vehicle master |
| `plant_id` | Mandatory | Validated against Plant master; determines Zone and Zonal Manager |
| `company_id` | Mandatory | Validated against Company Master; determines SLA and tier |
| `device_type` | Mandatory | Type of GPS unit to be installed |
| `device_id` | Mandatory | Pre-assigned device serial; must exist in inventory and not be actively mapped to another Vehicle |
| `sim_id` | Optional | Pre-assigned SIM serial; if blank, SE selects from Common Kit |
| `target_date` | Optional | Deadline hint for Recommender scheduling bias; if blank, Recommender decides |
| `notes` | Optional | Free-text context for the SE |

**CSV bulk upload validation** must check before creating any Tickets:
- Vehicle existence in Vehicle master.
- Absence of an active Device mapping for that Vehicle.
- Plant existence and Zone derivation.
- Customer-account existence in Company Master.
- If `device_id` supplied: device exists, is not already actively mapped to another Vehicle.
- If `sim_id` supplied: SIM exists in Component master.

Bad rows reject with line-number errors — no partial imports.

## Consequences

- `Ticket` carries `install_trigger_source` enum (`MANUAL_OPERATIONS` for v1; `EXTERNAL_API` reserved for v2).
- Demo / replacement / pre-order / retro-fit cases all use `MANUAL_OPERATIONS` — sub-typing within the trigger source is unnecessary at this scale.
- Reports break out Install volumes by trigger source so the v2 webhook rollout has a clean before/after comparison.
- Operations Head is the single point of accountability for what enters the install backlog.
