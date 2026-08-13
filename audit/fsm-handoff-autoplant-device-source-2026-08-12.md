# Handoff — AutoPlant → FSM Device Source Feasibility

**Session date:** 2026-08-12 · **Repo:** `C:\fsm-platform-backup` · **Branch:** `feat/autoplant-integration`
**Session type:** READ-ONLY architecture investigation. No code, schema, migration, test or database row was
modified in either system. The only files written were the report and this handoff.

---

## 1. What this session produced

**The deliverable — read this first, do not re-derive it:**

`docs/autoplant-device-source-feasibility-analysis.md` (~1,050 lines, 15 sections)

It contains the full evidence base: architecture trace, per-stage master-sync and telemetry traces, the orphan
characterisation, the FSM device data model, a downstream containment map, 14 hidden architectural assumptions,
six architecture options scored on 18 dimensions each, a before/after equivalence matrix, a regression-risk table,
a testing strategy, a 10-question safety gate, the verdict, and next steps.

**Do not duplicate any of it in a new document.** Reference it by path and section number.

Also referenced (pre-existing, not authored this session):
- `docs/codebase-complete-analysis.md` — whole-platform architecture and KPI catalog
- `docs/autoplant-fsm-deep-data-lineage-and-correctness-audit.md` — AutoPlant→FSM lineage + incident history
- `docs/dashboard-complete-data-lineage.md` — all 430 dashboard elements traced to source columns
- `.scratch/fsm-platform-v1/INDEX.md` — issue tracker (issues #218, #220, #222, #223, #228, #229, #230, #231 are all load-bearing context)

---

## 2. Verdict as it stands

**🟠 POSSIBLE BUT REQUIRES ISOLATION** (report §14)

| Question | Verdict |
|---|---|
| Replace `mst_vehicle` with `tb_vehiclemaster` as the device source? | ❌ NOT FEASIBLE without an architectural breaking change |
| Make the 11,852 orphans normal FSM devices? | ❌ Not safely |
| Account for the wider population without harming existing behaviour? | ✅ Yes — via a non-device discovery ledger (Option 3), optionally + an additive catalog counter (Option 4a) |
| Classified/isolated devices (Option 5)? | ⚠️ INSUFFICIENT EVIDENCE — technically possible, safety rests on an exhaustiveness claim across ≥13 read paths |

**No implementation has been started. The user explicitly withheld approval.**

---

## 3. Correction made late in the session — verify you are reading the current file

In a chat reply I stated that report §9/§10 had been updated after the `plant_id` finding. **They had not been at
that moment.** The edits were made immediately afterwards and the file on disk is now current. If you are working
from a copy or a stale context, re-read the file.

The specific change: the earlier draft listed *"company attribution has no validated source"* as a blocker for the
widgets-anchored option. **That framing was too broad.** A follow-up measurement (now report **§5.7**) proved
attribution works for the orphan population. The NOT-FEASIBLE verdict survives, but it now rests only on the
519-row status swap, the absence guard, the dead-device population, and the plant-scope widening.

---

## 4. Load-bearing numbers (all measured live, 2026-08-12)

Do not re-run these to satisfy curiosity; re-run them only if you are about to act, because the source mutates
(`mst_vehicle` lost 9 rows during this session — issue #220 hard-deletes).

| Fact | Value |
|---|---|
| `tb_vehiclemaster` distinct devices | 63,124 |
| `mst_vehicle` distinct devices | 51,272 (51,263 ~30 min later) |
| Orphans (widgets ∖ masters) | **11,852** — 100% `RR_`/`RR-` prefixed |
| Reverse direction (masters ∖ widgets) | **0** |
| Orphans pinged in last 90 days | **0** — newest fix across the whole set `2025-12-17` |
| Orphans never reported | 2,922 · stale >24 h: 8,930 |
| Orphans "operational" per widgets status | 646 (every one stale or never-reported) |
| `plant_id` agreement widgets vs masters | **51,278 / 51,280 (99.996%)** |
| `vehicle_deployment_status` disagreement | **519 / 51,263**, all one-directional (widgets over-claims operational) |
| `plant_name` disagreement | 12,812 / 63,118 (stale label, reliable id) |
| Orphans resolving plant → company | **11,849 / 11,852**, deterministic (0 plant_ids carry >1 company) |
| Companies involved | 14 — **all already in FSM**, 0 new companies needed |
| Orphans on FSM-**deactivated** plants | **4,139** |
| Orphans on **UNZONED** FSM plants | 4,674 |
| Orphans on plants **INACTIVE at source** | 2,211 (3 plants, all UTCL) |
| Absence-guard ratio if attributed | **26.2%** vs a 10% limiter → aborts the absence pass fleet-wide |
| Fleet Health if all admitted | **81.3% → 50.4%** · inactiveOperational +326.6% |
| FSM live: devices / vehicles / plants / companies | 27,185 / 27,250 / 931 / 45 |
| FSM live: operational / warehouse / eligible | 15,429 / 11,756 / 15,429 |
| FSM live: open TROUBLESHOOT tickets | 14,332 (includes ~3,439 un-remediated phantom cycles from run 153) |
| FSM `eligibility_mode` | `all-deployed` · `inactivity_threshold_hours` 24 |

**The single most reusable insight:** trust in `tb_vehiclemaster` is **per-column, not per-table**. `plant_id` is
reliable; `plant_name` and `vehicle_deployment_status` are not.

---

## 5. Blocking questions the user must resolve (report §15)

These are **not** engineering tasks. Do not attempt to answer them from code.

1. **What is the `RR_*` identity family?** Why are 11,852 absent from `mst_vehicle` while widgets marks them
   `VEHICLE_DATA_SOURCE='CURRENT'`? → AutoPlant data owner.
2. **Is the plant-scope widening acceptable?** Attributing 2,211 orphans needs `MasterSyncScope.plantStatuses` to
   move beyond `['ACTIVE']`, which changes plant scope for the **entire fleet**. Blast radius unmeasured.
3. **Operator decision on the "AutoPlant Catalog" KPI** — should it mean the source device catalog (63,124) or the
   vehicle-master catalog (51,174)? The card and its own `kpiCatalog.ts` entry currently disagree with the data.
4. **Are the 4,139 orphans on FSM-deactivated plants intended to stay invisible?** Surfacing them contradicts an
   explicit OH decision.

## 6. Operational hygiene flagged, not actioned

| Item | State |
|---|---|
| `master_sync_runs` run **121** | stuck `RUNNING` since 2026-08-11 07:14 — blocks the single-in-flight guard |
| Run-153 phantom cycles (#230) | ~3,439 still open; 14,332 open TROUBLESHOOT tickets is not a clean baseline |
| #218c lifecycle catch-up | never executed — `drift 49`, `missing_from_source 2,689` |

**None of these was touched.** They are prerequisites for any change to this pipeline, not side quests.

---

## 7. If the next session is asked to implement

The user has **not** approved an architecture. If approval arrives, the safe path is report §9 **Option 3**
(discovery ledger, no `devices` rows) and optionally **Option 4a** (additive catalog counter). Report §15 lists
steps 9–13 for that path.

Two rules carried from this investigation:
- **The proof of safety for Option 3 is that the existing 365-file test suite stays green *unmodified*.** If a
  change requires editing an existing assertion, stop — that is the definition of changed behaviour.
- A new writer must follow the `appendCommissioning` posture: after every mirror write, **outside** any
  transaction, inside try/catch, best-effort.

---

## 8. Environment / access notes

- AutoPlant production MySQL is reachable over the user's VPN using credentials in
  `apps/backend/.env` (`AUTOPLANT_MYSQL_*`). **Do not print, copy or embed those values.** The account is
  read-only and the client enforces a SELECT/SHOW/DESCRIBE/EXPLAIN allow-list.
- FSM Postgres is at the `DATABASE_URL` in the same file (local, port 5433).
- **DBA constraint: < 100 rows returned per query.** Aggregate first; every row-listing query used `LIMIT ≤ 90`.
- `mysql` CLI is **not** installed. This session installed `mysql2` / `pg` into a throwaway scratchpad project
  under the OS temp dir and deleted it afterwards. Do the same; never add DB clients to the repo.
- Cross-schema string comparisons between `ap_widgets` and `ap_masters` fail with
  `Illegal mix of collations`. Compare numerically (`CAST(... AS UNSIGNED)`) instead of casting to CHAR.

---

## 9. Suggested skills for the next session

| Skill | When to invoke |
|---|---|
| **`/tdd`** | **Mandatory** if implementation is approved. The repo's red-green-refactor protocol is this skill, not a doc. Every change to the ingestion path must arrive with the test that would have caught its absence — that is the explicit lesson of #218/#223/#228. |
| **`/code-review ultra`** | Before any PR touching `ingestion/`, `device-state/`, `device-departure/` or `ticketing/`. User-triggered and billed — you cannot launch it; suggest it. |
| **`/handoff`** | At the end of the next session if the work is again left mid-decision. |

**Project rules that are not skills but bind every session** (`CLAUDE.md`):
- Reading order: `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` → `.scratch/fsm-platform-v1/INDEX.md` → the issue file.
- **Two living documents, no forks.** Edit `docs/SYSTEM-STATE-2026-07.md` in place; never create a new
  "current state" doc. Every session appends one row to the INDEX.md Session log.
- **Surfacing rule:** backend + UI are one vertical slice. "Build the seam" applies to external integrations only.
- Strategic HITL: stop for architecture / business-rule conflict / backlog-ownership / external-access / security.
  **This investigation hit the architecture trigger — that is why it stopped at a verdict.**

---

## 10. What NOT to do

- Do not create `devices` or `vehicles` rows for the orphans.
- Do not change `readVehicleMasters()`, `isOperationalStatus()`, or the existing meaning of
  `stats.devices.observed`.
- Do not add a predicate to any dashboard query.
- Do not widen `MasterSyncScope.plantStatuses`.
- Do not treat the resolvable hierarchy (§5.7) as permission — it makes a wrong outcome *easier to produce*, which
  is the opposite of a green light.
