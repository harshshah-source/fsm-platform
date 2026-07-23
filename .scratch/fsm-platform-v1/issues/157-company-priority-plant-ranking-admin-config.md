# 157 — Admin-editable company priority + plant ranking for the assignment engine

Status: needs-info (DEFERRED 2026-07-23 by operator — build not authorized; blocked on the Q1/Q2 decision session below)
Type: HITL (blocked on two human-only business decisions; all investigation is complete and recorded)

> **Operator decision 2026-07-23 — deferred for a decision session, and the proposed engine seam was
> vetoed.** Design decision 3 below ("scoring component, weight seeded 0") **is** the
> ship-the-config-now-wire-later middle path, and it is **out**: a knob that displays but moves
> nothing is the silent-lie pattern this project has been fighting (run-65 / #130, and the NEW-C1
> family). Recorded honestly rather than argued — the weight-0 proposal is withdrawn pending Q2.
> #158 (plant zone reassignment) was authorized to build first and independently.

> Filed from the 2026-07-23 investigation session. The ask was "admins should be able to set/edit
> company priority and plant ranking values that feed the engine." The investigation found the
> **company half already shipped as #46** (backend + UI + audit, evidence below), so the genuinely
> new scope is **plant ranking** — which has *no* existing concept anywhere in the backend — plus
> two design decisions (per-zone or global; sort-key or score-component) that need HITL sign-off.

## Evidence (verified 2026-07-23, current working tree)

### Where the engine consumes company priority today

Three layers, matching ADR-0003:

1. **Canonical sort** — `apps/backend/src/recommender/canonical-sort.ts`:
   `TIER_ORDER` at `:30`; 1st key Company **Tier desc** at `:49`; 3rd key Company **PriorityRank asc**
   at `:53-54` (full order per docstring `:5-6`: Tier desc → Bucket desc → PriorityRank asc →
   Oldest-inactive asc → DeviceID asc). Install-backlog comparator repeats both keys at `:86-87`.
2. **Weighted score** — `apps/backend/src/recommender/scoring.ts`: weight key
   `company_priority_rank` (`:45`), letter transform `rankScore` A=1.0, B=0.9… clamped [0,1]
   (`:55-60`), consumed at `:79,:84,:94`. **Tier is a sort/gate dimension only — it has no numeric
   score term; only `companyPriorityRank` is scored.**
3. **Orchestrator** — `apps/backend/src/recommender/recommender.service.ts`: selects
   `company: { select: { companyTier, companyPriorityRank } }` (`:122`), maps onto candidates
   (`:131-133`), sorts (`:139`), builds score features (`:288`), and **stamps both values into the
   persisted `scoreBreakdown`** (`:311-319`) — per-recommendation transparency. Install path mirrors
   it (`:460,:466-467,:476-477`). Active weights resolved from `priority_rule_config` at `:509-534`.

### Storage + edit path for company priority (ALREADY DONE — #46)

- `schema.prisma:35-41` enum `CompanyTier` (PLATINUM/GOLD/SILVER); `Company` model `:56-78` with
  `companyTier` (`:59`), `companyPriorityRank` letter string (`:60`), index `(companyTier,
  companyPriorityRank)` (`:76`), mapped `company_master` (`:77`).
- Edit endpoint: `PATCH /api/org/companies/:id` — `companies.controller.ts:18-20` guard
  `@Roles('OPERATIONS_HEAD')`, handler `:37-44`. Service validates tier against the enum and rank
  against a letter regex, 404s unknown ids, and audits `COMPANY_UPDATED` **with a `previous:{tier,
  rank, opsOverride}` metadata block** (`companies.service.ts:80-117`, metadata `:96-105`). This is
  the audit shape #157 should copy for plants.
- Admin UI: Settings → Companies tab, inline row edit of tier + rank + ops-override
  (`apps/admin/src/pages/settings/sections.tsx:272-346`), behind the OH-only settings route
  (`AppRoutes.tsx:385-391`).
- Anti-drift: tier/rank are FSM/CRM-owned and structurally excluded from the master-sync update set
  (`master-sync.service.ts:92-94`; SYSTEM-STATE §3a R4) — admin edits survive sync.

### Plant ranking — does NOT exist; the natural seams

- Grep for `plant_rank|plantRank|plant_priority|plantPriority|plant_tier|plantTier` across
  `apps/backend` → **zero matches**. `Plant` model (`schema.prisma:192-230`) has no rank column.
- Plants enter the engine only as (i) the zone-scoping filter (`recommender.service.ts:115`
  `plant: { zoneId, … }`) and (ii) the Plant Cluster Multiplier — a same-plant clustering bonus,
  not a ranking (`recommender.service.ts:217-219`, value from `system_settings`
  `plant_cluster_multiplier` at `:536-540`).
- Seam A — **canonical sort key** in `compareCandidates` (`canonical-sort.ts:47-62`): requires
  adding `plantRank` to `CandidateTicket` (`:20-27`) + the mapping at `recommender.service.ts:129-138`.
  Changes the ADR-0017 canonical order — a semantic change to established, persisted
  `processing_rank` ordering.
- Seam B — **scoring component** mirroring `company_priority_rank`: new weight key in `scoring.ts`
  (pattern `:45`), transform + `baseScore` term (`:93-99`), feature at
  `recommender.service.ts:287-296`, weight row in `priority_rule_config`.

### Role scope + zone dimension precedent

- Every config surface is **OPERATIONS_HEAD-only**: scoring weights
  (`scoring-weights.controller.ts:14-16`), settings (`settings.controller.ts:9-12`), SLA rules
  (`sla-rules.controller.ts:14-16`), companies (`companies.controller.ts:18-20`). CSM/ZM have **no
  write path to any engine config**. There is intentionally no ADMIN role (`schema.prisma:16-26`).
- All scoring/priority config is **global**: `priority_rule_config` keyed `(weightSetRef,
  component)` only (`schema.prisma:301-313`); `system_settings` single-key registry
  (`:1196-1203`); `sla_rule_config` scopes restricted to `bucket`/`company_tier`
  (`sla-rules.service.ts:22`). Zone enters only as a selection filter and the per-zone
  DEFICIT/PREVENTIVE mode switch (`recommender.service.ts:104`), whose weights are still global.
- Per-zone ZM-editable engine knobs were analysed and **decided against** 2026-07-21
  ("configurability is not empowerment when the configurer is the graded party" —
  `docs/proposals/zone-engine-customization-2026-07-21.md` §3.1; INDEX decided-against entry).
  That analysis targeted ZM self-configuration; an OH-set per-zone table is not the same thing,
  but no precedent or demand for it exists yet.

### Transparency ledger / config_snapshot behaviour

`dispatch-run.service.ts:216-235` (`captureConfigSnapshot`, called at run creation `:84`):
- **All active `priority_rule_config` rows are captured automatically** (`:218,:223`) — a new
  scoring *component* (Seam B) flows into the snapshot with zero wiring.
- `system_settings` capture is a **hard-coded key allow-list** (`:219`) — a new setting key needs
  an explicit edit.
- A brand-new config table is **not captured** without a new fetch + field (`:217,:222-234`).
- Per-plant/per-company *values* are not in the run snapshot by design — they are stamped
  per-recommendation in `scoreBreakdown` (`recommender.service.ts:311-319`), which is where a
  plant rank must also be stamped.

## Design decisions (proposed — subject to Open questions)

1. **Scope**: company priority editing is **done** (#46). This issue builds plant ranking only.
   AC-0 re-verifies the company half rather than rebuilding it.
2. **Data model — column on `plants`, not a side table.** Add nullable
   `plants.priority_rank` (recommend small **integer**, 1 = highest; NULL = unranked, sorts/scores
   worst; domain re-confirmed in OQ-3):
   - (a) *Audit*: `audit_logs` with a `previous:{}` metadata block (copy `COMPANY_UPDATED`,
     `companies.service.ts:96-105`) is the platform's history mechanism for config — no config
     table in the repo keeps row-level history (agent-verified; `priority_rule_config.effectiveFrom`
     versions weight *sets*, not row edits). A `plant_ranking_history` side table would be a new
     pattern with no consumer.
   - (b) *Engine read cost*: the recommender already joins `plant` for zone scoping — selecting one
     more column is free. A side table with effective dates adds a per-run lookup + date resolution.
   - (c) *Transparency*: per-run visibility comes from stamping the consumed value into
     `scoreBreakdown` per recommendation (the exact mechanism company tier/rank uses today), plus
     the auto-captured weight row (Seam B). A side table would additionally need explicit
     `config_snapshot` wiring (`dispatch-run.service.ts:217-234`).
   - *Anti-drift*: the new column is FSM-owned — it simply never appears in `mapPlant`'s `mirrored`
     update set (`master-mapping.ts:251-273`), same posture as `deal_type`/`zone_id`. A sync-survival
     test pins this (S4).
3. ~~**Engine seam — Seam B (scoring component `plant_rank`), weight seeded 0.**~~
   **WITHDRAWN 2026-07-23 (operator veto).** Weight-0 was argued as "safe to land, inert until OH
   raises it" — but from the admin's chair it is a rank field that changes nothing, with the real
   control on a different page. That is the vetoed middle path. The seam is now **Q2**, and the
   investigation note that matters for answering it is that `canonical-sort.ts:53-54` is
   weight-gated by nothing, so it is the only seam with no second hidden knob.
4. **Endpoint contract**: extend the existing plants admin surface (`org/plants` controller, #45)
   with `PATCH /api/org/plants/:id` accepting `{ priorityRank?: number | null }` — validated range,
   404 unknown id, audited `PLANT_UPDATED` with `previous:{}`. OH-only via the standard
   `AuthGuard, RoleGuard` + `@Roles('OPERATIONS_HEAD')` chain.
5. **Role scope: OH-only.** Uniform with every other engine-config surface (evidence above), and
   consistent with the 2026-07-21 graded-party analysis. No CSM/ZM write path.
6. **Global, not per-zone (recommended; OQ-1 decides).** Matches the entire existing config model.
   Per-zone would require a keyed side table + resolver + explicit config_snapshot wiring + a
   Feature-2 interaction (below) — deliberately out of v1 unless HITL says otherwise.

## Acceptance criteria

- [ ] AC-0 (verify, no build): company tier/rank/ops-override editing works end-to-end as #46 shipped
      it (PATCH + UI + `COMPANY_UPDATED` audit with `previous:{}`).
- [ ] AC-1: `plants.priority_rank` exists (nullable, additive migration), never written by master
      sync — a full sync run leaves admin-set ranks untouched (test-pinned).
- [ ] AC-2: `PATCH /api/org/plants/:id` updates `priorityRank`; OH-only (403 for ZM/CSM/WM/SE);
      invalid values → 400; unknown plant → 404; audited with prev/new metadata in the same
      transaction (`withAudit` pattern).
- [ ] AC-3: recommender scores a `plant_rank` component: feature read via the existing plant join,
      transform to [0,1], weight from `priority_rule_config` (seeded 0), value stamped in
      `scoreBreakdown`; NULL rank scores as worst; behaviour with weight 0 is bit-identical to
      today (regression-pinned).
- [ ] AC-4: the run-level `config_snapshot` shows the `plant_rank` weight row with no snapshot code
      change (pins the auto-capture claim at `dispatch-run.service.ts:218,223`).
- [ ] AC-5: admin Plants tab (Settings) gains inline rank edit mirroring the Companies row pattern
      (`sections.tsx:272-346`), OH-gated at route + API; matches the v2 reference layout per
      `docs/agents/workflow.md` UI-discovery steps (read `docs/ui/desktop/v2-reference/` before
      building — surfacing rule).
- [ ] AC-6: audit-trail verification: every rank edit yields exactly one `audit_logs` row with
      actor, prev, new; edits during a dispatch run don't corrupt the run's stamped values
      (run reads are point-in-time at selection).

## Slice plan (TDD-first, #128/#130/#136 discipline — each slice lands green + committed)

- **S1 — data model + endpoint.** Additive migration (nullable column, no index — unselective);
  PATCH handler + validation + audit with `previous:{}`; RED first on the 403/400/404/audit cases;
  sync-survival test (run `mapPlant` upsert over a ranked plant, assert rank untouched).
- **S2 — engine consumption.** RED: with weight 0, scores identical to baseline (pins inertness);
  with a nonzero weight, rank reorders two otherwise-equal candidates; NULL-rank worst; value
  stamped in `scoreBreakdown`; config_snapshot shows the weight row (AC-4). All at the
  `runForZone` seam.
- **S3 — admin UI.** Read the v2 reference images first (hard gate). Plants tab rank column +
  inline edit; vitest selector-contract tests; OH RoleRoute already wraps the settings console.
- **S4 — audit + edge cases.** Audit-row shape assertions; concurrent-edit-during-run probe;
  AC-0 verification note; INDEX/SYSTEM-STATE updates.

## Open questions (HITL — the decision session; build is NOT authorized until Q1 + Q2 are answered)

- **Q1 (blocking) — is priority global or per-zone? The business question, not the technical one:
  does the business ever prioritize the same customer differently across zones?**
  - *If no*: per-zone is scope creep. `companies.companyPriorityRank` is **already editable** (#46,
    evidence above) — the feature collapses to UI copy + whatever Q2 decides, shippable in a day.
  - *If yes*: the per-zone design is right but the scope is materially larger — a
    `(zone_id, company_id, rank)` side table, a resolver in the candidate mapping, explicit
    `config_snapshot` wiring (`dispatch-run.service.ts:217-234` does **not** auto-capture new
    tables), and the live coupling to #158 in Q3.
  - Decide first: it determines the data model, and Q3 only exists if the answer is *yes*.
- **Q2 (blocking) — ranking must actually move the engine. Two honest options; the middle path is
  vetoed.**
  - **(a) Grow the scope so priority genuinely affects dispatch.** Note from the investigation that
    makes (a) cheaper than it looks: company rank moves dispatch **two** ways — a weighted score
    term (`scoring.ts:45,79,94`, gated by the `priority_rule_config` weight) *and* an unconditional
    canonical-sort key (`canonical-sort.ts:53-54`, gated by nothing). **The sort-key seam is the
    only design where "admin changes rank → order changes" is guaranteed with no second hidden
    knob.** Cost: it changes ADR-0017 canonical ordering and persisted `processing_rank` semantics,
    so it needs an ADR revision + dispatch-outcome regression. If (a) is chosen via the scoring
    seam instead, the default weight must be **nonzero and ops-chosen** — never 0.
  - **(b) Reframe as "customer tiebreaker ordering"** with UI copy saying exactly that. This is
    honest about what already ships: company rank is the 3rd canonical sort key, i.e. a tiebreaker
    within a tier/bucket cell. Smallest true scope; plant ranking is dropped or re-filed.
  - **Vetoed: (c) ship the config now and wire it later** — including the withdrawn weight-0
    proposal, where an admin sets a rank and nothing observable happens because a second knob on a
    different page is zero.
- **Q3 (cross-feature, answered together with Q1) — when a plant's zone changes via #158, do
  per-zone priorities re-attach to the new zone automatically, or is there a UX to warn/re-confirm?**
  Only live if Q1 = per-zone. Options: silently re-attach (the plant now takes the new zone's rank
  rows — cheapest, and invisible, which is the pattern we are avoiding); carry the old zone's rank
  across; or block the zone change behind a warning + explicit re-confirm in #158's UI. #158 S2 is
  being built **without** this warning on the standing assumption Q1 = global; if Q1 = per-zone, the
  warning is a follow-up slice on #158, filed at that point.
- **Q4 (minor, deferred until Q1/Q2 land): rank domain** — integer 1..N vs a letter grade mirroring
  `companyPriorityRank`'s A/B/C.
- **Q5 (scope confirm): any company-side change wanted beyond what #46 shipped?** Default: no.

## Cross-feature interaction notes (with #158 — plant zone reassignment)

- **Under the recommended global model there is no interaction**: company tier/rank and plant rank
  are zone-independent, so #158 moving a plant between zones changes *which zone's queues and
  dispatch runs* see the plant, but never which priority applies.
- **If OQ-1 chooses per-zone**, the interaction is real and must be designed, not discovered: a
  zone move re-keys every per-zone rank lookup for that plant/company. #158's UI would need a
  warning ("this plant has zone-scoped priority rows in <old zone>") and a decision (carry, clear,
  or re-prompt). This coupling is the strongest argument for global-in-v1.
- Shared trust-boundary posture (#130 lesson): the engine must read rank from the source-of-truth
  row via the existing joins at run time — no denormalised rank copies on tickets/recommendations
  beyond the per-run `scoreBreakdown` stamp, and no new columns in any sync update set.
