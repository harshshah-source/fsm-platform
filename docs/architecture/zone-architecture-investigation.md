# Zone Architecture — First-Principles Re-Investigation

> **Trigger:** The main integration blueprint concluded *"AutoPlant Zone ≠ FSM Zone, therefore Operations Head
> manually assigns every imported plant to an FSM Zone."* That conclusion was **not approved** and challenged as
> under-evidenced. This document re-investigates from first principles, is willing to prove the prior conclusion
> wrong, and does not defend it for consistency.
>
> **⚠ SUPERSEDED IN PART — read `## Revision 3` (immediately below) first.** Revisions 1–2 (this header and §1–§6)
> established that AutoPlant zone must not be copied verbatim and that manual per-plant assignment is wrong — both
> still hold. **Revision 3** incorporates the new production fact that `ap_masters.mst_plant` is the *authoritative*
> plant-hierarchy master and reframes the answer around the **Organization-vs-Operational separation**. §1–§5 remain
> valid evidence; §6's recommendation is refined by Revision 3.
>
> **Verdict (Rev 1–2, retained):** the prior "manual per-plant" conclusion was **half right, half wrong**.
> - ✅ *Right:* AutoPlant's zone **must not be copied verbatim** into FSM Zone (per-company + inconsistent).
> - ❌ *Wrong:* **Manual per-plant assignment is not the answer** — the FSM operational zone is derived, not hand-keyed.

---

## Revision 3 — Authoritative `mst_plant` + Organization-vs-Operational separation (CURRENT recommendation)

**New authoritative production fact (AutoPlant DB team):** `ap_masters.mst_plant` is **the** authoritative production
master for the plant hierarchy — it denormalizes `company_id/company_name`, `zone_id/zone_name`,
`region_id/region_name`, `plant_state`, `plant_district`, `master_plant_id/name/code`, `status` onto every plant row
(data dump `DESCRIBE`, lines 251-304). Downstream apps should treat it as the source of truth. The Book dataset is
abandoned as evidence.

### R3.1 Decisive finding — Organization and Operational ownership are SEPARATE concerns that do not even align

This answers *"are these actually separate concerns?"* — **yes, structurally and by ownership**, proven by repo +
production evidence:

| Concern | What it is | Owner | Cardinality | Evidence |
|---|---|---|---|---|
| **Organizational hierarchy** | `company → zone → region → plant → state/district` — which customer org a plant belongs to | **AutoPlant** (authoritative `mst_plant`) | **Per-company** (each customer has its own zones/regions) | `mst_zone.company_id`, `mst_region.company_id`; `mst_plant.zone_id` is per-company, e.g. `2211`=GB Transport's "East" (dump 471-490, 517-538, 105) |
| **Operational ownership / authority** | FSM **Zone** = ZM authority + RBAC row-scope; SE mapping, coverage, batches, recommendations, tickets | **FSM** | **Cross-company, small (~4 zones, 1 ZM each)** | `Zone` has **no `company_id`** (`schema.prisma:159-174`); ZM scope = JWT `zone_id` vs `plant.zone_id` (`zone-scope.guard.ts:15-42`, `ticket-query.service.ts:181`, `device.service.ts:105`); `recommender.runForZone(plant.zoneId)` (`recommender.service.ts:87`); per-zone jobs (`ARCHITECTURE-REMEDIATION-PLAN.md:83-84`); seed=2 / canonical=4 (`org-seed.ts:11`, `CONTEXT.md:59`) |

**Why they cannot be the same object:**
- **AutoPlant zone is per-company; FSM zone is cross-company.** One FSM ZM owns a geography spanning *all* customers'
  plants there; conversely one customer spans FSM zones (ADR-0018 cross-zone escalation
  `0018-...:9`; `CROSS_ZONE_ESCALATION.homeZoneId/targetZoneId`, `schema.prisma:391,399`). Copying `mst_plant.zone_id`
  1:1 would create **thousands of per-company zones** — incompatible with one-ZM-per-zone over ~40 SEs.
- **FSM zone is used ~entirely operationally, not as an org node.** No RBAC/recommender/ticket path reads org
  metadata — all compare `plant.zone_id` to the caller's authority zone. Company is an **orthogonal axis** (on
  `vehicle`/`device_state`/`ticket`, never nested under zone — `device.service.ts:134-138` joins zone via `plant` but
  company via a *separate* `ds.company_id`).
- **AutoPlant's zone is the *customer's* grouping**, not FSM's field-service partition — a different question with a
  different owner.

**Corollary — what "authoritative `mst_plant`" means for FSM:** it is authoritative for the *organizational facts*
(company/region/state/district a plant belongs to, and AutoPlant's own zone label), which FSM must **mirror
faithfully**. It is **not** authoritative for the FSM operational Zone — that concept does not exist in AutoPlant; it
is an FSM overlay the ops org owns.

### R3.2 Recommended architecture (Rev 3) — "Mirror the authoritative org hierarchy + FSM operational Zone overlay"

```
  ap_masters.mst_plant  (AUTHORITATIVE, denormalized org hierarchy per plant)
        │  MasterSyncService reads this ONE table for the whole plant hierarchy
        ▼
  MIRROR (faithful reference, AutoPlant-owned):
   • company_master ← company_id/name              (+ source_company_id)
   • plants         ← plant_id/name/code, status   (+ source_plant_id)
   • plants source attributes (NEW): source_zone_id, source_zone_name, source_region_id,
       source_region_name, plant_state, plant_district, master_plant_id/code  ← verbatim
        │
        │  derive the DEFAULT operational-zone assignment from AUTHORITATIVE geography
        ▼
  FSM-OWNED OPERATIONAL OVERLAY:
   • zones (ZM authority partition, cross-company, ~4)          — UNCHANGED shape
   • plants.zone_id = FSM OPERATIONAL zone  (NOT AutoPlant zone)
       default = plant_state → FSM `state → zone` map (FSM-owned reference)
       cross-checked against source_zone_name; unmappable → UNZONED + Ops exception queue
       Ops-Head override wins on re-sync (existing plants.service API)
   • users.zone_id, zones.zonal_manager_user_id, engineer_master.zone_id, se_coverage,
       territory, tickets, recommendations — all FSM-owned
```

- **Sync FROM AutoPlant (mirror):** company identity; plant identity + status; and the **org hierarchy as source
  attributes on the plant**. Because `mst_plant` is denormalized, this is a **single-table read** — no need to
  rebuild AutoPlant's per-company zone/region *as FSM tables*.
- **Keep FSM-owned:** the operational Zone (`plant.zone_id` + `zones` + `zonal_manager_user_id`), `users.zone_id`
  authority, SE mapping/coverage/territory, and all workflow. `plant.zone_id` is the **FSM operational zone**, seeded
  by deriving from the authoritative `plant_state`, cross-checked against `source_zone_name`, override-able.
- **AutoPlant's zone is preserved, not discarded** — it lives in `plants.source_zone_id/source_zone_name` for audit,
  reporting drill-down, and as a bootstrap/cross-check for the FSM `state → zone` map. *This is the refinement over
  Rev 1–2:* Rev 1 said "don't copy zone"; **Rev 3 says mirror it as a faithful source attribute, but do not use it as
  the operational zone key.**

### R3.3 Does the FSM Organization model change? — Yes, minimally and precisely

| Question | Answer (Rev 3) |
|---|---|
| Hierarchy synced from AutoPlant | Company identity; Plant identity + status; org-hierarchy **attributes** (`source_zone_id/name`, `source_region_id/name`, `plant_state`, `plant_district`, `master_plant_*`) mirrored onto `plants`. (Vehicle/Device in the main blueprint.) |
| Stays FSM-owned | Operational **Zone** (`zones`, `plant.zone_id`, `zonal_manager_user_id`), `users.zone_id` authority, `engineer_master.zone_id`, `se_coverage`, `engineer_territory_coverage`, company tier/rank/override, all workflow. |
| Does the org model change? | **Conceptually yes** — stop treating `plant.zone_id` as AutoPlant-sourced; it is the FSM *operational* zone. AutoPlant's zone/region become **source attributes** on the plant. **The `zones` table shape need not change.** |
| Prisma changes? | Yes — additive columns on `plants` + `source_company_id` on `company_master` (R3.4). No `zones` shape change. |
| Assumptions to remove | (1) Any notion FSM `zones` should mirror `mst_zone`/be per-company. (2) Rev-1 "don't copy AutoPlant zone" → "mirror it as a source attribute; derive operational zone separately." (3) All Book-dataset assumptions (`plant_code % 4`). |

### R3.4 Prisma recommendations (Organization only — recommendations, no code)

| Table | Change | Reason |
|---|---|---|
| `company_master` | add `source_company_id BigInt @unique`, `status String?` | Keyed idempotent upsert from `mst_company`; mirror active/inactive |
| `plants` | add `source_plant_id BigInt @unique`, `source_zone_id BigInt?`, `source_zone_name String?`, `source_region_id BigInt?`, `source_region_name String?`, `plant_state String?`, `plant_district String?`, `master_plant_id BigInt?`, `master_plant_code String?`, `status String?` | Faithfully mirror the **authoritative** `mst_plant` hierarchy; drive operational-zone derivation + Floating-SE district resolution from `plant_state`/`plant_district`; audit AutoPlant's zone |
| `plants.zone_id` | **no type change** — clarify semantics: **FSM operational zone**, derived + override, *not* `mst_plant.zone_id` | Resolve provenance ambiguity |
| `zones` | **no shape change** | Already operational; keep `zonal_manager_user_id` (notification target) + `name` |
| `state → zone` map | add FSM-owned reference (small table or `zones.covers_states`) | Deterministic default plant→operational-zone; ~36 rows |
| `regions` / `districts` | unchanged (FSM Floating-SE geography); resolve `plants.district_id` by matching `plant_district`/`plant_state` | AutoPlant `region_name` (=state) is **not** FSM `Region` (=admin cluster of districts) — keep separate |

**Impact:** additive only (no destructive change); operational Zone/RBAC/recommender/ticket paths untouched (they
already key on `plant.zone_id`); master-sync becomes a single-table `mst_plant` read for the hierarchy; Floating-SE
territory gains real `plant_state`/`plant_district`.

### R3.5 Options re-evaluated under authoritative `mst_plant`

| Option | Verdict (Rev 3) |
|---|---|
| **1. Direct sync — FSM zones = AutoPlant zones** | **REJECT.** Per-company → thousands of zones; breaks one-ZM-per-zone / cross-company authority; incompatible with RBAC + recommender. |
| **2. Synchronized hierarchy with FSM extensions** (mirror company/plant + source attributes; FSM operational zone overlay) | **RECOMMEND** — this is R3.2. Honors authoritative `mst_plant`, preserves the operational partition, additive schema. |
| **3. Independent operational hierarchy** | **PARTIAL.** Correct for the *operational zone* (FSM-owned) but wasteful to ignore the authoritative geography — Rev 3 keeps `plant_state`/`district` from `mst_plant` to drive derivation. "Independent" applies only to the zone overlay, layered on a mirrored org hierarchy. |
| **4. Hybrid** | = Option 2. **RECOMMEND.** |

### R3.6 What remains query-dependent (do not guess — §5 read-only queries still apply)

The **shape** (mirror + operational overlay) is settled by evidence. Two inputs still need production data to *tune*,
not to decide the architecture:
- **Q6** (does `plant_state` map to a single `source_zone_name`?) decides whether the FSM `state → zone` map is
  **seeded from** AutoPlant zone_name (if aligned) or **authored independently** (if inconsistent, per the
  Bokaro/Jharkhand→North sample). Either way the runtime key is `plant_state`.
- **Q3/Q4** size the `UNZONED` exception queue; **Q11** (`master_plant_id` grouping) decides whether an FSM Plant maps
  to an `mst_plant` row or a `master_plant` group; **Q8** re-confirms `mst_plant` vs the uninspected bare
  `ap_masters.plant` sibling now that `mst_plant` is declared authoritative.

### R3.7 Validation pass (this revision) — what was re-checked and what held

Re-validated the Rev 3 conclusions against the schema and repo (not memory). **All Rev 3 conclusions hold; none
revised.**
- `Zone` = `{zoneId, name, zonalManagerUserId}` — **no `company_id`** (`schema.prisma:159-174`). ✔ Operational,
  cross-company. Nothing in the repo ties a Zone to a company or expects `plant.zone_id` from an external source.
- `Plant` = `{plantId, name, zoneId (required), districtId?, location}` — **no source/hierarchy attributes, no
  `status`, no `plant_state`** (`schema.prisma:180-199`). ✔ Confirms the additive Prisma gaps in R3.4.
- `Company` = `{companyId, name, companyTier, companyPriorityRank, contractRef, source, opsOverride}` — **no
  `company_type`, no `status`** (`schema.prisma:57-73`). The only `customer`/`transporter` references in code are
  ticketing concerns (Non-Op customer confirmation; transporter-name-on-ticket), **not** an org-scoping concept.

### R3.8 NEW FINDING — master **scoping** is unresolved (and the "authoritative `mst_plant`" fact makes it urgent)

"Mirror the authoritative master faithfully" begs a question the earlier revisions did not: **which rows are in FSM
scope?** Production evidence shows the authoritative masters are *not* a clean list of FSM's fleet:
- `mst_company` mixes `company_type` = **Shipper AND Transporter** in one table (dump 405-406: Prism Mines=Shipper,
  TCI FREIGHT=Transporter), plus `status = INACTIVE` rows (Coke 1003, NuVista 1005) and obvious **test rows**
  (`Testing Company` 1049). FSM's `Company` = the **customer/shipper** (holds the GPS contract); transporters belong
  in the separate `transporters` table (§7 #2 of the main blueprint).
- `mst_plant` includes `status = INACTIVE` plants and **test plants** (`JKPlant_Test`, `test plant 1001`,
  `master test plant 1001`, `Home`, `Noida` with blank geography — dump 104, 107, 111-112, 116).
- **FSM `company_master` has no `company_type` and no `status`**, so it currently *cannot* express the shipper-vs-
  transporter split or active/inactive — a real schema gap (add `company_type` + `status`, extending R3.4).

**Consequence:** the master sync must apply a **scoping filter** (which companies/plants are FSM's fleet) that is a
**business rule, not derivable from the schema.** Mirroring `mst_plant`/`mst_company` verbatim would import
transporters-as-customers, inactive sites, and test data into FSM's operational dashboards and Fleet-Uptime
denominator. **This is an open question for AutoPlant + Operations Head (see R3.10).**

### R3.9 Change classification (this revision vs. earlier revisions)

| Class | Item |
|---|---|
| **Revised** | *(none this pass)* — Rev 3's org-vs-operational split and "mirror + operational overlay" recommendation are re-validated and stand. The last substantive revision was Rev 3 itself (Rev 1–2 "don't copy AutoPlant zone" → Rev 3 "mirror it as a `source_zone_*` attribute; derive the operational zone separately"). |
| **Unchanged** | Organizational hierarchy is AutoPlant-owned/authoritative (`mst_plant`) and mirrored; FSM operational Zone is FSM-owned, cross-company, derived from `plant_state` + override; `zones` table shape unchanged; RBAC/recommender/ticket paths key on `plant.zone_id`. |
| **Removed** | All Book-dataset-derived assumptions (`plant_code % 4` synthetic zone) — formally void as evidence per the AutoPlant team's guidance. Any implication that FSM `zones` should mirror `mst_zone` or be per-company. |
| **New findings** | (1) **Master scoping is unresolved** (R3.8) — `mst_company`/`mst_plant` contain transporters, inactive, and test rows; FSM lacks `company_type`/`status` to filter. (2) `company_master` needs `company_type` + `status` columns (extends R3.4). |
| **Open questions** | Everything in R3.10 — routed to Product Owner / Operations Head / AutoPlant experts. These are **business rules that must not be invented.** |

### R3.10 Open questions — required before the Organization architecture can be locked

These cannot be answered from the repository or the sampled production dump. **Do not invent answers.** Route to the
named owners.

**For the AutoPlant domain experts / DB team:**
1. **Scope filter:** Which `mst_plant` rows constitute the FSM fleet (~5,000 plants)? Is there a flag/column, or is
   it "`status='ACTIVE'` and joined to devices," or a company allow-list? *Why: prevents importing inactive/test
   plants into operations and the Fleet-Uptime denominator (R3.8).*
2. **Company scope:** Which `mst_company` rows are FSM **customers** vs transporters vs internal/test? Is
   `company_type` the reliable discriminator, and what are its full values? *Why: FSM `Company` must be the
   contract-holding customer; transporters go to a separate table.*
3. **`master_plant_id` semantics:** Does `master_plant_id/master_plant_code` group several `mst_plant` rows into one
   physical site (dedup), or is each `mst_plant` row a distinct plant? *Why: decides whether an FSM Plant maps to an
   `mst_plant` row or a `master_plant` group (Q11) — affects plant→zone cardinality.*
4. **`zone_name` consistency & meaning:** Is `mst_plant.zone_name` intended as a geographic label or a customer's
   operational grouping? How consistent is it across companies (the sample shows Jharkhand→`North`)? Are blanks/`NA`
   expected? *Why: decides whether the FSM `state → zone` map can be seeded from it (Q6) or must be authored.*
5. **`hierarchy_path` meaning** (`tb_vehiclemaster`, e.g. `1000#1101#1111`): does it encode `company#…#…`? *Why: a
   possible direct zone/region signal on the live table.*
6. **Bare vs `mst_` tables:** now that `mst_plant` is authoritative, are the bare `ap_masters.plant/company/region/
   transporter` tables legacy/deprecated? *Why: confirms we read only the `mst_*` masters.*
7. **Change cadence & new-plant onboarding:** how often do plants/companies get added or re-zoned in AutoPlant, and
   is there an updated-timestamp for incremental master sync? *Why: sizes sync frequency and the exception queue.*

**For the Operations Head / Product Owner:**
8. **FSM operational-zone partition:** How many FSM operational Zones, and which states map to each? (Default
   proposal: 4-zone N/S/E/W via the India Zonal-Council scheme, to be reconciled against Q6.) *Why: this is the
   FSM-owned field-service partition — the core input to the `state → zone` map; it is a business decision, not a
   data fact.*
9. **Zone granularity vs SE load:** is ~4 zones over ~40 SEs / ~5,000 plants the intended granularity, or are finer
   service territories needed? *Why: determines whether one ZM per coarse zone is operationally viable.*
10. **Exception handling authority:** who owns re-zoning of `UNZONED`/misclassified plants, and what is the SLA for
    clearing that queue so no plant sits without a ZM? *Why: an unzoned plant has no RBAC owner and no recommender
    scope.*
11. **Company tier/rank source:** AutoPlant carries **no** `company_tier`/`company_priority_rank` (the Recommender's
    top sort gates). Where do these come from — a CRM/SAP feed, or Ops-Head-maintained? What is the default for a
    newly-synced company? *Why: without it the canonical sort degenerates (all companies equal) — main blueprint
    Risk R13.*
12. **Plant→zone override vs source drift:** if AutoPlant later changes a plant's `zone_name`/state, should an FSM
    Ops override always win, or should the ZM be alerted to reconcile? *Why: defines the re-sync conflict policy for
    the operational overlay.*

Until Q1/Q2 (scope) and Q8 (partition) are answered, the Organization architecture is **shape-complete but not
data-complete** — the design (mirror + operational overlay) is settled; the *filter* and the *partition* are
pending business input.

### R3.11 Is the operational **zone partition** definable from evidence? — **No. It is an Operations-Head business decision.**

Focused investigation of the single question *"how are FSM operational zones partitioned (how many, which geography
each spans)?"* against the repository, the production dump, and the architecture docs. **Verdict: the evidence is
insufficient to define the partition, and the sources positively indicate it is a configured business decision — not
a derivable rule. No mapping is produced.**

**Evidence that the partition is undefined / Ops-owned:**

| # | Evidence | What it proves |
|---|---|---|
| 1 | `PRD-fsm-admin-dashboard.md:34` — "**Operations Head manages zones**, plants, SE mappings, SLA rules, company tiers, and user accounts." | The zone set is **configured by the Operations Head**, not fixed by the system or the source. |
| 2 | `schema.prisma:159-174` — `Zone` = `{zoneId autoincrement, name String @unique, zonalManagerUserId}`; **no `state`/`region` column, no enum, no fixed cardinality.** | The schema deliberately does **not** encode a partition; zones are free-form data. |
| 3 | Every `NORTH / SOUTH / EAST / WEST` in the repo is prefixed `e.g.` / "example": `CONTEXT.md:59`, `CONTEXT.md:278-279`, `workflow…:156`. | The 4-zone model is **illustrative, not authoritative.** |
| 4 | `org-seed.ts:11` seeds **2** zones (`North`,`South`); the abandoned Book harness used **4** (`plant_code % 4`). | Even the codebase's own fixtures disagree on the count — no canonical partition exists. |
| 5 | Doc-wide grep for `four zones` / `number of zones` / `divided into` / `zone partition` / `NORTH…SOUTH…EAST…WEST` (one line) → **no matches** in `docs/` (incl. LLD, ADRs, PRD). | **No architecture document defines the partition.** ADR-0018 uses EAST/SOUTH only as example zones in a cross-zone scenario. |
| 6 | AutoPlant `mst_plant.zone_name` is **per-company and inconsistent** (Jharkhand→`North`; blanks/`NA`; `West Zone`) — R3.1, dump 99-117. | The production DB carries the **customer's** grouping, not FSM's field-service partition — it cannot *define* the FSM partition (though it can *inform* it — see SQL below). |

**Why the evidence *cannot* define it (what a partition actually depends on, and where that data lives):** an
operational zone is a **field-service-delivery + management-span** decision. Its real inputs are:
- **SE headcount and home locations** (~40 SEs) — where the engineers actually are. **Not in AutoPlant; not in the
  repo** (`engineer_master` is FSM-owned and currently only seeded, no real roster/geography).
- **Zone Warehouse locations** (one stock point per zone — `CONTEXT.md:278-279`) — a physical logistics decision.
  **Not in any source.**
- **ZM management span** (one ZM per zone — `CONTEXT.md:562`) — an org-staffing decision (how many managers, how
  much load each can own). **Not in any source.**
- **Workload balance** across zones (devices/tickets per zone) — *this* is partly derivable from AutoPlant fleet
  geography (SQL below), but balancing it still requires the SE/warehouse/manager facts above.

None of these four inputs exists in the repository, the production dump, or the architecture docs. Therefore the
partition **must be provided by the Operations Head / Product Owner.** Producing a `state → zone` table now would
hardcode an unvalidated business rule — explicitly out of scope.

**What the earlier revisions correctly deferred (unchanged):** R3.6/R3.10-Q8 already flagged the partition as
pending. This section *proves* it is unresolvable from evidence and stops short of inventing it — as instructed.

#### R3.11.a Business questions that must be answered before a partition can be defined (Operations Head / Product Owner)

These are the *decisions* — not data lookups. No answer can be inferred; each must be stated by the business.

1. **How many operational zones** should the fleet be partitioned into, and **what is each zone's name**? (The
   system imposes no count — `org-seed` uses 2, examples use 4.)
2. **What geography defines each zone** — is it a grouping of **states** (e.g. a Zonal-Council-style N/S/E/W), a
   grouping of **AutoPlant's `zone_name`s**, a **custom** grouping, or something finer (region/district)?
3. **Is the partition purely geographic, or workload/SE-driven?** (i.e., may two geographically-adjacent states land
   in different zones to balance SE load or warehouse coverage?)
4. **Where are the SEs and Zone Warehouses located**, and how many SEs/warehouses per proposed zone? (This is the
   operational reality that should drive the partition; it is not in AutoPlant.)
5. **What is the target management span** — how many plants / devices / SEs should one Zonal Manager own? (Bounds how
   coarse or fine the partition can be.)
6. **How are new geographies handled** — when AutoPlant onboards a plant in a state not yet mapped, does it default
   to an `UNZONED` queue for Ops review, or auto-attach to a nearest zone?
7. **Who owns the partition over time**, and what is the change process when the field org restructures (new zone,
   split zone, ZM reassignment)?

#### R3.11.b Read-only SQL to *inform* (not decide) the partition — reduces uncertainty on the one derivable input (fleet geography)

These quantify the **fleet's geographic distribution** so the Operations Head can size a balanced partition. They
**inform** question 1–3/5; they **cannot** answer 4 (SE/warehouse locations aren't in AutoPlant). All read-only,
`LIMIT ≤ 20`. (These extend, and do not replace, the §5 queries.)

```sql
-- P1: plant count per state (active). Informs: how geographically spread the fleet is; candidate zone groupings.
SELECT plant_state, COUNT(*) AS plants
FROM ap_masters.mst_plant
WHERE status='ACTIVE' AND plant_state IS NOT NULL AND TRIM(plant_state) NOT IN ('','NA','india')
GROUP BY plant_state ORDER BY plants DESC LIMIT 20;

-- P2: DEVICE/vehicle workload per state (the real SE workload, not just plant count). Informs: workload balance —
--     a zone partition should equalise device load per ZM/SE, not plant count.
SELECT p.plant_state, COUNT(*) AS vehicles
FROM ap_masters.mst_vehicle v
JOIN ap_masters.mst_plant p ON p.plant_id = v.plant_id
WHERE p.status='ACTIVE'
GROUP BY p.plant_state ORDER BY vehicles DESC LIMIT 20;

-- P3: fleet concentration — how many states hold the bulk of the fleet. Informs: whether few coarse zones suffice
--     or load is spread thin. (Run P1/P2 and read the head; this is the ranked view.)
SELECT COUNT(DISTINCT plant_state) AS distinct_states,
       SUM(status='ACTIVE') AS active_plants
FROM ap_masters.mst_plant
WHERE plant_state IS NOT NULL AND TRIM(plant_state) NOT IN ('','NA','india');

-- P4: distribution across AutoPlant's OWN zone_name (the customer grouping). Informs: whether AutoPlant's zoning is
--     even enough to borrow as a starting hypothesis, or too skewed/dirty. Cross-check against P1/P2.
SELECT zone_name, COUNT(*) AS plants
FROM ap_masters.mst_plant
WHERE status='ACTIVE'
GROUP BY zone_name ORDER BY plants DESC LIMIT 20;

-- P5: state × AutoPlant-zone_name cross-tab (same as §5 Q6, repeated here for partition sizing). Informs: if a state
--     maps to one zone_name, AutoPlant's grouping is a viable hypothesis to put to Ops; if it fans out, it is not.
SELECT plant_state, COUNT(DISTINCT zone_name) AS distinct_zone_names, COUNT(*) AS plants
FROM ap_masters.mst_plant
WHERE status='ACTIVE' AND plant_state IS NOT NULL AND TRIM(plant_state) NOT IN ('','NA','india')
GROUP BY plant_state ORDER BY distinct_zone_names DESC, plants DESC LIMIT 20;
```

**How the SQL feeds the decision (and its limit):** P1–P5 give the Operations Head an evidence base — *where the
fleet actually is and how heavy each geography is* — to propose a **balanced** partition and to test whether
AutoPlant's own `zone_name` is a usable starting point. **They do not decide the partition.** The final rule still
requires the SE/warehouse/management-span facts (questions 4–5) that live only in the Operations Head's knowledge of
the field organisation. **Until those are supplied, no `state → zone` mapping is created.**

---

## 1. Repository evidence — what FSM actually intends
> *(Revisions 1–2 — retained as supporting evidence; recommendation refined by Revision 3 above.)*

**Finding: FSM Zone is a coarse *geographic* rollup of Plants and the Zonal-Manager authority boundary; a Plant
belongs to exactly one Zone via a stored `plant.zone_id`. There is no upstream-zone concept in FSM, and no
geography→zone derivation exists anywhere in the code — but nothing forbids one, and the domain definition is
explicitly geographic.**

| # | Evidence | Quote / fact |
|---|---|---|
| 1 | `CONTEXT.md:58-59` | **Zone** = "**Coarse rollup of Plants** (e.g., NORTH / SOUTH / EAST / WEST). Unit of **Zonal Manager** authority." |
| 2 | `CONTEXT.md:562` | Invariant: "A **Plant** belongs to one **Zone**; a **Zone** is owned by one **Zonal Manager**." |
| 3 | `docs/workflow/fsm-business-technical-workflow.md:156-158` | Zone = "A **coarse geographic rollup of Plants** (NORTH / SOUTH / EAST / WEST). One Zonal Manager owns one Zone." → **the domain calls Zone geographic.** |
| 4 | `schema.prisma:159-199` | `Plant.zoneId` is a **required** FK to `Zone`; `Plant.districtId` is a **separate optional** FK. Zone link and geography link are independent. |
| 5 | `schema.prisma:159-174` | `Zone` = table with `name String @unique`, autoincrement id. **No `state`/`region` column, no enum, no fixed cardinality.** Zones are data, not an enum. |
| 6 | `org-seed.ts:11`; `book8-dataset.ts:44`; `auth/dev-zone-resolver.ts:11-14` | Zone *count/names vary by dataset* — dev seed = `['North','South']` (2); book harness = `['EAST','NORTH','SOUTH','WEST']` (4). NORTH/SOUTH/EAST/WEST is an **example**, not a hard-coded set. |
| 7 | `plants.service.ts:29-43` | `create(name, zoneId)` — plant is placed under an **explicitly-passed existing zone**; unknown zone → 404. The caller supplies the zone; the system never infers it. |
| 8 | `CONTEXT.md:28`, `:830`; workflow `:105`; PRD `:34` | Operations Head is the **"system configurator"** who "owns zone/plant setup". Zones/plants are admin-configured CRUD (`issues/02-org-reference-config-settings.md:16,23`). |
| 9 | **Book harness (load-bearing)** `book8-dataset.ts:41-44`, `README.md:77-78` | `plant → zone` is `ZONE_NAMES[plant_code % 4]` **"Zone is NOT in the CSV, so plant→zone is a deterministic synthetic partition"**. The *only* automatic rule in the repo, and it is **explicitly a test-fixture stand-in for a missing column** — not an intended production rule. |
| 10 | Repo-wide grep `state.*zone / region.*zone / derive.*zone / assign.*zone` | **No geography→zone derivation exists anywhere.** Geography (state→region→district, `schema.prisma:204-229`, `geography.service.ts`) is a **parallel** hierarchy used only for Floating-SE territory, wired to Plant via optional `districtId` — never to Zone. |
| 11 | `issues/67-...:19` | Device→zone is always resolved **through the plant** (`device_states.plant → zone`) — zone follows plant, never the reverse. |

**Two things the repo evidence establishes that the prior conclusion missed:**
- The domain explicitly defines Zone as **geographic** (rows 1, 3). A *geographic* rollup is exactly the kind of
  thing that can be **derived from a geographic attribute** (`plant_state`) — the domain does not require manual
  classification; it requires *correct geographic grouping*.
- The repo's manual/`%4` mechanisms are **consequences of test data lacking a zone/state**, not deliberate
  rejections of derivation (rows 9, 6). The production source is richer than the CSV the code was built against.

**What the repo does *not* contain (so these are genuinely new design choices, needing sign-off):** any
`state → zone` reference table, any automatic zone-assignment at ingest, and any fixed enumeration of FSM zones.

---

## 2. Production database — what we know, and what we have *not* inspected

### 2.1 What the discovery dump already proves (`docs/autoplant_databaseData.md`)

`ap_masters.mst_plant` **already carries the geography the book CSV discarded**. Its `DESCRIBE` (data dump lines
251-304) includes: `plant_state`, `plant_district`, `region_id`, `region_name`, `zone_id`, `zone_name`,
`master_plant_id`, `master_plant_name`, `master_plant_code`, `status`. Sampled rows (dump lines 99-117):

| Plant | `region_name` (=state) | `zone_name` | `zone_id` | Company |
|---|---|---|---|---|
| Durgapur Steel Plant | West Bengal | `East` | 2211 | GB Transport (1069) |
| Rourkela Steel Plant | Odisha | `East` | 2211 | GB Transport (1069) |
| **Bokaro Steel Plant** | **Jharkhand** | **`North`** ⚠️ | **2210** | GB Transport (1069) |
| Bharathi Cement | Andhra Pradesh | `South` | 2183 | Vicat (1062) |
| Zuari | Maharashtra | `West` | 2186 | Zuari (1063) |
| Gallantt Ispat | Uttar Pradesh | `North` | 2192 | Gallantt (1065) |
| GGVL | Madhya Pradesh | `North` | 2215 | GRPL (1070) |
| Kadappa | *(blank / `NA`)* | `NA` ⚠️ | 2039 | Vicat (1015) |
| Noida | *(blank)* ⚠️ | *(blank)* | 2066 | (1045) |

**Three conclusions from the samples:**
1. **`plant_state` is a real, populated geographic anchor** for most plants — this is what enables automatic
   derivation and is exactly what the book CSV lacked.
2. **AutoPlant `zone_name` is per-company and inconsistent.** Bokaro (Jharkhand) is tagged `North` by the *same
   company* that tags Odisha/WB `East` — geographically Jharkhand is East. So copying `zone_name` imports each
   customer's idiosyncratic (sometimes wrong) grouping. `zone_id` is also **per-company** (`mst_zone.company_id`
   exists), so the same "East" is a different `zone_id` per company — it cannot serve as a global FSM zone key.
3. **Data is dirty at the edges** — blank / `NA` / `india` appear in `plant_state`, `zone_name`, and `region_name`
   (dump lines 99, 104, 107, 108, 111, 114-116, e.g. `plant_state = 'india'`, `'Maharashtra Region'`, `''`).

### 2.2 What we have **not** inspected (do not assume completeness)

The `ap_masters` table listing (dump lines 310-395) shows **bare tables that were never `DESCRIBE`d**, sitting
alongside the `mst_*` tables:

- `ap_masters.company`, `ap_masters.plant`, `ap_masters.region`, `ap_masters.transporter` — **bare siblings** of
  `mst_company/mst_plant/mst_region/mst_transporter`, structure unknown. One of these could be a cleaner or
  more-authoritative geography master.
- No bare `zone` table appears in the listing, but `mst_zone` was only sampled for company 1000 (values *"North
  India"/"South India"*) — its full value distribution across all companies is unknown.
- `tb_vehiclemaster.hierarchy_path` is a `varchar(10)` with values like `"1000#1101#1111"` (dump line 66) — this
  **looks like an encoded org path** (possibly `company#…#…`) that could carry a zone/region signal. Uninspected.
- `reverse_logistic_data`, `mst_secondaryclient*` — unknown relevance to geography.

**Because of §2.1(3) and §2.2, the samples are strong enough to reject "manual per-plant" and "copy zone_name" but
NOT strong enough to finalise the exact derivation input (state vs region_name vs hierarchy_path) or the
edge-case volume.** That is what the §5 queries resolve — I will not guess.

---

## 3. Business scale test — is manual plant→zone acceptable?

**Inputs:** ~5,000 plants, ~50,000 vehicles, ~40 SEs, a small number of FSM Zones (the domain's example set is 4:
N/S/E/W; the code allows any number).

**Would manual Plant→Zone mapping be acceptable? No.**

- **One-time cost:** 5,000 individual human classification decisions before go-live — days of error-prone toil for
  the Operations Head, the single "system configurator" bottleneck (`CONTEXT.md:28`).
- **Ongoing cost:** every *new* plant AutoPlant onboards (new customer site) would silently land with **no zone**
  — but `plant.zone_id` is a **required FK** (`schema.prisma:183`). So either the sync blocks on a human, or new
  plants can't be ingested until someone classifies them. That couples fleet ingestion to manual data entry — the
  opposite of an automated source integration.
- **Correctness:** humans classifying 5,000 rows will disagree and drift; a plant's zone would depend on *who*
  entered it and *when*. Geography (a plant's state) is objective and stable; manual tags are neither.
- **Consistency with the rest of the design:** FSM already treats the ~700-district geography as **reference data
  loaded once** (`org-seed.ts:53-55` calls the full district load "a separate reference-data task"). A
  state→zone table (~36 rows) is the same pattern at 1/20th the size.

**What enterprise systems do instead:** territory/zone assignment is **rule-driven reference data with exception
overrides**, never per-record manual classification at this scale. Canonical patterns — SAP sales/service
**territory hierarchies** (region/state → territory rules), Salesforce **Territory Management** (assignment rules
over account geography), CRM **routing/zoning tables** — all assign the many (accounts/sites) to the few
(territories/zones) via a small maintained **lookup keyed on a stable geographic attribute**, then expose a
**manual override** for the handful that don't fit. India itself is conventionally partitioned this way (the
Government's **Zonal Councils**: North/South/East/West/Central/North-East zones over states) — a ready-made,
defensible `state → zone` scheme.

**Conclusion:** manual per-plant assignment fails the scale test. A `state → zone` reference table (auto-applied,
~36 rows, with override) passes it and matches enterprise practice and the FSM reference-data pattern.

---

## 4. Alternative designs — full comparison

| Option | Mechanism | Advantages | Disadvantages | Ops cost | Scalability | Maintenance | Impl. complexity |
|---|---|---|---|---|---|---|---|
| **A** | AutoPlant `zone_name`/`zone_id` → FSM Zone (identical copy) | Zero human input; "already there" | `zone_name` is **per-company + inconsistent** (Bokaro/Jharkhand→North); `zone_id` per-company so no global key; blanks/`NA`; fractures FSM's single ops partition (one FSM zone must span many companies) | Low upfront, **high** correction | Poor (imports drift) | High (reconcile per-company zone spaces forever) | Low code, **high** data-quality risk |
| **B** | Option A **+ Ops-Head override** | Human can fix errors | Still starts from an unreliable base → **large** override backlog; overrides fight re-sync | High (many overrides) | Poor→Fair | High | Low–Med |
| **C** | **`plant_state` → FSM Zone via FSM-owned `state → zone` table (automatic)** | Deterministic, objective, consistent across companies; matches domain's "geographic rollup"; scales to all current + future plants; ~36-row table | Requires an FSM-owned `state→zone` table; needs handling for dirty/blank `plant_state` | **Low** (one table, once) | **Excellent** | **Low** (edit ~36 rows if the zone partition changes) | Med (add derivation at sync + reference table) |
| **D** | Company + Region → FSM Zone | Uses company context | AutoPlant `region` **is** the state (per-company); company shouldn't drive *geographic* zone; more inputs, more inconsistency; over-engineered | Med | Fair | Med–High | High |
| **E** | Dedicated mapping table maintained by sync | Explicit, auditable, override-friendly | Alone it just relocates the question ("what fills the table?") | — | — | — | — (this is the *vehicle*, not the *rule*) |
| **F (recommended)** | **Hybrid: C via E** — `state → zone` reference table drives an auto plant→zone resolution at master-sync; AutoPlant `zone_name` used only as **bootstrap hint + cross-check**; unmappable plants land in an **`UNZONED` holding zone + Ops-Head exception queue** (B-style override, but only for exceptions) | Best of all: automatic + deterministic + scalable, yet keeps human control exactly where it's needed (a small exception list, not 5,000 rows); re-sync-safe (override wins); never blocks ingestion | Introduces two new FSM-owned artifacts (`state→zone` table, exception queue) not in the repo today | **Low** | **Excellent** | **Low** | **Med** |

Notes:
- **E is not a rival to C** — it is *how C is implemented*. The interesting axis is *what rule fills the table*:
  Option C says **geography (state)**; Option A/B say **AutoPlant zone_name**; Option D says **company+region**.
- The existing manual `plants.service.create(zoneId)` API (`plants.service.ts:29`) already provides the **override
  path** for free — Option F reuses it for exceptions rather than as the primary mechanism.

---

## 5. Read-only validation queries (run against production; all `SELECT/SHOW/DESCRIBE`, `LIMIT ≤ 20`)

These resolve the residual uncertainty from §2.2 before the `state → zone` table is finalised. None modify data.

### Group 1 — Scale (confirms §3 assumptions)
```sql
-- Q1: plant + vehicle counts (active vs total). Why: validates the 5k/50k scale that kills manual assignment.
SELECT COUNT(*) AS total_plants, SUM(status='ACTIVE') AS active_plants FROM ap_masters.mst_plant;
SELECT COUNT(*) AS total_vehicles FROM ap_masters.mst_vehicle;
SELECT COUNT(*) AS live_vehicle_rows FROM ap_widgets.tb_vehiclemaster;
-- Q2: how many customer companies feed FSM. Why: confirms zones must span many companies (kills per-company copy).
SELECT COUNT(*) AS active_companies FROM ap_masters.mst_company WHERE status='ACTIVE';
```

### Group 2 — Is `plant_state` clean enough to derive from? (validates Option C)
```sql
-- Q3: distribution + dirtiness of plant_state. Why: if states are clean, state→zone derivation is viable;
--     if heavily blank/'india'/'NA', the exception-override volume rises (still bounded).
SELECT plant_state, COUNT(*) AS n
FROM ap_masters.mst_plant
GROUP BY plant_state ORDER BY n DESC LIMIT 20;

-- Q4: bad-state rate. Why: quantifies the exception queue size for Option F.
SELECT
  SUM(plant_state IS NULL OR TRIM(plant_state)='' OR LOWER(plant_state) IN ('na','india')) AS bad_state,
  COUNT(*) AS total
FROM ap_masters.mst_plant WHERE status='ACTIVE';
```

### Group 3 — Is AutoPlant `zone_name` reliable? (falsifies/confirms Option A/B)
```sql
-- Q5: distinct zone_name values + counts. Why: measures how messy/non-standard AutoPlant zones are.
SELECT zone_name, COUNT(*) AS n
FROM ap_masters.mst_plant
GROUP BY zone_name ORDER BY n DESC LIMIT 20;

-- Q6: does one state map to ONE zone_name, or many? Why: the decisive test. If a state spans multiple
--     zone_names (Bokaro/Jharkhand→North vs East), AutoPlant zone is per-company/inconsistent → prefer Option C.
SELECT plant_state, COUNT(DISTINCT zone_name) AS distinct_zone_names, COUNT(*) AS plants
FROM ap_masters.mst_plant
WHERE status='ACTIVE' AND plant_state IS NOT NULL AND TRIM(plant_state)<>''
GROUP BY plant_state
ORDER BY distinct_zone_names DESC, plants DESC LIMIT 20;

-- Q7: is zone_id per-company (so unusable as a global FSM key)? Why: confirms we cannot key FSM Zone on zone_id.
SELECT company_id, COUNT(DISTINCT zone_id) AS zones, COUNT(DISTINCT zone_name) AS zone_names
FROM ap_masters.mst_zone
GROUP BY company_id ORDER BY zones DESC LIMIT 20;
```

### Group 4 — Are there better/uninspected geography sources? (§2.2)
```sql
-- Q8: inspect the bare sibling masters we never described. Why: one may be a cleaner/authoritative geography.
DESCRIBE ap_masters.plant;
DESCRIBE ap_masters.region;
DESCRIBE ap_masters.company;
DESCRIBE ap_masters.transporter;
SHOW TABLES FROM ap_masters LIKE '%zone%';
SHOW TABLES FROM ap_masters LIKE '%geo%';
SHOW TABLES FROM ap_masters LIKE '%state%';

-- Q9: is region_name just the state (so region adds nothing over plant_state)? Why: picks the derivation input.
SELECT region_name, plant_state, COUNT(*) AS n
FROM ap_masters.mst_plant
GROUP BY region_name, plant_state ORDER BY n DESC LIMIT 20;

-- Q10: decode tb_vehiclemaster.hierarchy_path — does it encode company#zone#region? Why: a possible direct
--      zone signal on the live table (would let the SNAPSHOT reader carry zone without a master join).
SELECT hierarchy_path, plant_id, plant_name, COUNT(*) AS n
FROM ap_widgets.tb_vehiclemaster
GROUP BY hierarchy_path, plant_id, plant_name
ORDER BY n DESC LIMIT 20;
```

### Group 5 — Plant grouping (affects what an FSM Plant *is*)
```sql
-- Q11: does master_plant_id group multiple mst_plant rows into one physical site? Why: decides whether FSM Plant
--      maps to mst_plant rows or to the master_plant grouping (affects plant→zone cardinality).
SELECT master_plant_id, master_plant_name, COUNT(*) AS child_rows
FROM ap_masters.mst_plant
GROUP BY master_plant_id, master_plant_name
ORDER BY child_rows DESC LIMIT 20;
```

**How each result steers the decision:**
- **Q6 is decisive.** If most states map to a single `zone_name` → AutoPlant zone is usable as a *bootstrap* for
  the `state→zone` table (fast start). If many states fan out across zones (as Bokaro implies) → AutoPlant zone is
  unreliable and the FSM-owned `state→zone` table must be authored independently. Either way the *runtime* input
  is `plant_state`, not `zone_name`.
- **Q3/Q4** size the exception queue (Option F's override volume) and confirm Option C's feasibility.
- **Q8** could surface a cleaner geography master (e.g. a bare `region`/`plant` table) or a dedicated zone/state
  master — which would change the derivation *input* but not the *shape* (still derive-then-override).
- **Q10** could let the **snapshot reader** carry a zone signal directly (if `hierarchy_path` encodes it),
  simplifying the master-sync join — a genuine "Option F discovered from evidence".
- **Q11** decides plant granularity (mst_plant row vs master_plant), which affects how many plant→zone assignments
  exist.

---

## 6. Final recommendation

### 6.1 Correction of the prior conclusion

**My previous conclusion was wrong on the mechanism, and I retract that half.**

- The prior doc said *manual per-plant assignment by Operations Head*. That fails the scale test (§3), couples
  automated ingestion to human data entry (required FK), and was inferred from a **test-fixture artifact** — the
  book harness's `plant_code % 4`, which exists **only because the CSV lacked a zone column**
  (`book8-dataset.ts:41-44`), not from any domain requirement.
- The part that **survives**: FSM must **not copy AutoPlant's `zone_name`/`zone_id` verbatim** — those are
  per-company and inconsistent (`mst_zone.company_id`; Bokaro/Jharkhand→`North`; blanks/`NA`). That half was
  correct and is now *better* evidenced.

### 6.2 Recommended architecture — Option F (derive from state, override the exceptions)

```
   ap_masters.mst_plant.plant_state          (objective geography, per plant)
                │
                ▼
   FSM-owned  state → zone  reference table   (~36 rows; authored by Operations Head once;
                │                              bootstrapped/cross-checked from AutoPlant zone_name via Q6)
                ▼
   MasterSyncService: resolve plant.zone_id automatically for every synced plant
                │
        ┌───────┴─────────────────────────────────────────────┐
        ▼                                                       ▼
   state maps cleanly → plant.zone_id set automatically    state blank/ambiguous → plant.zone_id = UNZONED
                                                            (holding zone) + surfaced in an Ops-Head
                                                            "Unzoned Plants" exception queue
                │                                                       │
                └──────────────► Ops-Head OVERRIDE (existing plants.service API) ◄──────┘
                                 (reassign any plant's zone; override wins on re-sync; audited)
```

**Why this one:**
- **Repository-consistent:** Zone is defined as a *geographic* rollup (`CONTEXT.md:58-59`, workflow:156); deriving
  it from `plant_state` honours that definition. The existing manual `plants.service.create(zoneId)` API
  (`plants.service.ts:29`) becomes the **override** path — no throwaway; the free-form `zones` table
  (`schema.prisma:159`) already supports whatever partition Ops chooses.
- **Production-consistent:** uses the reliable field (`plant_state`) and treats AutoPlant `zone_name` as a hint,
  not truth — matching what the samples actually show.
- **Scalable & low-maintenance:** ~36-row table classifies all 5,000 current plants and every future plant
  automatically; only true exceptions need a human, and re-sync never clobbers an Ops override.
- **Enterprise-standard:** rule-driven territory assignment + exception override (SAP/Salesforce territory
  pattern; India Zonal-Council scheme is a ready default).

**New FSM-owned artifacts this introduces (none exist today — require sign-off):**
1. A `state → zone` reference table (or a `zones.covers_states` mapping), loaded like the district reference data.
2. An `UNZONED` holding zone + an "Unzoned Plants" Ops-Head exception view.
3. A derivation step in `MasterSyncService` (insert-time zone resolution; **never overwrite an Ops override**).

### 6.3 What must be confirmed before locking it (honesty gate)

This recommendation is **evidence-backed but data-quality-conditional**. Run §5 before implementation:
- If **Q6** shows `plant_state → zone_name` is largely 1:1, seed the `state→zone` table from AutoPlant and move on.
- If **Q3/Q4** show `plant_state` is badly populated, the *shape* still holds (derive-then-override) but the
  exception queue is larger — or a cleaner source from **Q8/Q10** (`hierarchy_path`, a bare master table) becomes
  the derivation input.
- Only if the production data proved to carry **no usable geography at all** (contradicted by every sample so far)
  would manual assignment re-enter consideration — and even then as a bulk CSV import, not per-plant clicks.

### 6.4 Decision for the Operations Head (Strategic HITL)

1. **Approve** deriving `plant.zone_id` from `plant_state` via an FSM-owned `state → zone` table (Option F), with
   Ops-Head override for exceptions — **replacing** the prior "manual per-plant assignment" recommendation.
2. **Decide the zone partition** (how many FSM zones and which states each contains — e.g. the 4-zone N/S/E/W the
   domain examples and AutoPlant both suggest, or a finer partition to balance ~40 SEs).
3. **Authorise** running the §5 read-only queries on production to finalise the table and size the exception queue.

---

### Appendix — evidence index
- Repo intent: `CONTEXT.md:28,52,58-59,562,830`; `docs/workflow/fsm-business-technical-workflow.md:105,148-158`;
  `schema.prisma:159-229`; `org/{plants.service,zones.service,geography.service,org-seed}.ts`;
  `auth/dev-zone-resolver.ts:11-14`; `test/env/book8/{book8-dataset.ts:41-44,288-292,README.md:77-78,
  book8-seeder.ts:70-76}`; `issues/{02,45,67}`.
- Production: `docs/autoplant_databaseData.md` — `mst_plant` DESCRIBE (lines 251-304) + samples (99-117);
  `mst_zone` (471-490); `mst_region` (517-538); `ap_masters` table listing (310-395);
  `tb_vehiclemaster.hierarchy_path` (66, 151).
