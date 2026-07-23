# 157 — Company tier: global setting + scoped, expiring tier overrides (redesigned)

Status: ready-for-human (redesign complete 2026-07-23 — operator review required before any slice starts)
Type: AFK after review sign-off

> **Decision history.** Filed 2026-07-23 as "admin-editable company priority + plant ranking"; the
> original weight-0 plant-rank seam was **vetoed** the same day as the ship-config-now-wire-later
> middle path (see the #130/run-65 family) and the issue was deferred to a decision session. The
> operator then answered Q1 (2026-07-23, confirming the redesign below) and set **the PRD as the
> authority for tier canon**. This file is the redesign. The **plant-ranking half is parked** — see
> Open questions Q-F; nothing in this design touches plants.
>
> **Operator's Q1 decision (verbatim intent):** OH sets a customer's **global tier**; CSM/ZM can
> create a **scoped tier override** for their zone/scope with three mandatory attributes — a reason
> (free text, required, min length), an expiry date (max 2 months from creation), and automatic
> revert to the global tier at expiry. All overrides audited in `audit_logs` AND surfaced in a
> monthly report of active overrides + reason + creator + expiry. Expiry without renewal reverts
> silently but audits the auto-revert. Stacking of multiple active overrides on the same
> customer × scope: prevented or explicitly stacked — design decision needed (→ Q-A).

## PRD reading (the operator's hard gate — completed 2026-07-23, before this redesign)

Authority note: the PRD (`docs/PRD-fsm-admin-dashboard.md`) defers canonical decisions to the
repo-root `CONTEXT.md` glossary/Decisions (e.g. PRD:673 → "Decision §17"); the workflow doc restates
them operationally. All three were read; they agree.

1. **Tier list — canonical, unambiguous: `PLATINUM | GOLD | SILVER`.** `CONTEXT.md:314-316` (the
   definitional entry, which also bans the synonym "Customer Tier"); `PRD:178` (story 54:
   "configure Company Tier (PLATINUM / GOLD / SILVER)"); `workflow:345`. No fourth tier anywhere.
2. **Ordering — explicit: Platinum > Gold > Silver.** `CONTEXT.md:315` ("Priority order:
   Platinum > Gold > Silver; Company Priority Rank breaks ties within the same tier");
   `CONTEXT.md:765` (Decision §17 key 1: "Company Tier descending (PLATINUM > GOLD > SILVER)").
3. **Sort semantics — fully specified.** Tier is the FIRST canonical sort key, descending, ahead of
   Device Bucket → Priority Rank → Oldest Inactive → Device ID (Decision §17, `CONTEXT.md:761-769`;
   `PRD:673`). Tier is also the top-level scoring **gate** with a documented starvation consequence
   and metric (`CONTEXT.md:606-612` Decision §3; `workflow:1976` "Company Tier starve depth").
   Cross-zone: Platinum gets auto-escalation (1h unassigned in CRITICAL / 4h to SUBMITTED);
   Gold/Silver manual-only (`CONTEXT.md:746-753` Decision §18). The spec never assigns tiers
   numeric weights — the encoding is an implementation choice.
4. **Spec silences (flagged, per instruction):** per-tier SLA minute values (PRD:177 makes them
   OH-configurable but sets no defaults — the numbers in `org-seed.ts:45-47` are code-only);
   and override lifecycle — the spec says OH "can override per-company" (`CONTEXT.md:311`,
   `PRD:178`) but is **silent on temporariness, zone scoping, and expiry**. The Q1 decision is
   therefore a **new requirement, not a PRD reading**, and it **extends documented authority**
   (spec: OH-only, `CONTEXT.md:28`; decision: +CSM/ZM scoped) — recorded as an operator-approved
   business-rule extension; S6 updates CONTEXT.md/PRD so the docs and the code do not disagree.

### constants.ts cross-check (instruction 3)

**ALIGNED on values and effective order.** There is no `@fsm/shared` tier constant
(`packages/shared/src/index.ts` has `ROLES` and `SLA_BANDS`, no tiers); the definition sites are the
Prisma enum (`schema.prisma:35-41`, declared PLATINUM→GOLD→SILVER), the recommender's
`TIER_ORDER` (`canonical-sort.ts:30`), the backend validation set (`companies.service.ts:29`,
derived from the enum), and hard-coded admin dropdowns (`sections.tsx:245-247,305-307`).

**Two drift-risk flags (housekeeping candidates to file later, NOT blockers):**
- `TIER_ORDER` is written **reversed** — `['SILVER','GOLD','PLATINUM']` with a compensating
  comparator (`canonical-sort.ts:29-30,42,49`). Runtime result is correct and spec-aligned, but the
  order is encoded opposite to both the spec's prose and the enum's declaration order; anyone
  "fixing" the array to match the enum silently inverts dispatch priority. The S1 `tiers` table +
  spec-pin test below removes this footgun as a side effect.
- Admin UI/API treat tier as bare `string` (`badges.tsx:144`, `org.ts:16`) — membership is enforced
  in exactly one layer (backend set). Noted; not in this issue's scope.

## Evidence — how tier moves the engine today (verified this session)

Tier is consumed from **two different copies**, and the override design must face this or it ships
a half-inert knob (the Q2 veto class):

- **Live reads** (join `company_master` at query time): the recommender selects
  `company.companyTier` per zone-run and it drives canonical sort key 1 — gated by **nothing**
  (`recommender.service.ts:122,131-139`; `canonical-sort.ts:49`). Dashboards similarly.
- **Snapshot readers** (read `tickets.company_tier`, stamped at ticket creation from
  `company_master` — `ticket-creation.service.ts:57-99`, column `schema.prisma:1986`): ticket
  queues (`ticket-query.service.ts:144` raw SQL), shared pool (`shared-pool.service.ts:59`),
  intraday (`intraday-insertion.service.ts:343-350`), and — critically — the **Platinum cross-zone
  auto-escalation sweep filters on the ticket snapshot** (`cross-zone-escalation.service.ts:78`).
- Other tier-typed columns: `recommendations.company_tier` (`schema.prisma:332`, per-run
  explainability stamp — correct as history), `cross_zone_escalations.company_tier` (`:428`).
- SLA windows are configurable per tier (`sla_rule_config` scope `company_tier`,
  `sla-rules.service.ts:22`; seeded `org-seed.ts:45-47`).
- Transparency: `config_snapshot` does **not** auto-capture new config tables
  (`dispatch-run.service.ts:217-234` — explicit fetch list); per-recommendation `scoreBreakdown`
  already stamps `companyTier` (`recommender.service.ts:311-319`).
- Zone-scoped writes precedent: `ZoneScopeGuard` clamps a ZM only via `:zoneId`/`zone_id`
  **params/query** (`zone-scope.guard.ts`); a zone in a request **body** needs a service-level
  clamp (the #102 install-scope precedent).

## Design

### Data model (per operator instruction: tiers table + companies.tier + company_tier_overrides)

**`tiers` — the canonical tier list and order as data** (new, seeded from the PRD canon):

| column | notes |
|---|---|
| `name` | PK/unique; values exactly `PLATINUM`, `GOLD`, `SILVER` |
| `rank` | int, unique, **1 = highest** (PLATINUM=1, GOLD=2, SILVER=3) — matches the spec's prose direction |

Read by: admin dropdowns (replacing the hard-coded option lists) and an S1 **spec-pin test**
asserting `tiers` ⇄ Prisma enum ⇄ `TIER_ORDER` agree — which retires the reversed-array footgun
without touching the comparator. The recommender keeps its in-process comparator (hot path, no
join); the pin test is what prevents drift.

**`companies.company_tier` — unchanged.** It already exists (`schema.prisma:59`) and remains the
OH-owned **global tier**, edited via the existing audited `PATCH /api/org/companies/:id` (#46).
No column migration; the enum stays the storage type (adding a future tier = `ALTER TYPE … ADD
VALUE` + a `tiers` row — documented two-step, out of scope).

**`company_tier_overrides` — the scoped, expiring override** (new):

| column | notes |
|---|---|
| `id` | bigint PK |
| `company_id` | FK → company_master |
| `zone_id` | FK → zones — the scope |
| `tier` | `CompanyTier` enum — the overriding tier |
| `reason` | text **NOT NULL**, service-validated min length (mandatory per Q1) |
| `expires_at` | timestamptz **NOT NULL**; raw-SQL CHECK `expires_at <= created_at + interval '2 months'` (hard cap per Q1) and `expires_at > created_at` |
| `status` | `ACTIVE` / `EXPIRED` / `CANCELLED` |
| `created_by`, `created_at`, `updated_at` | actor + timestamps; `cancelled_by`/`cancelled_at` nullable |

- **No stacking (recommended — Q-A decides):** partial unique `(company_id, zone_id) WHERE
  status = 'ACTIVE'` — the platform's established idiom (one-active-per-X partial uniques, e.g.
  `failure_cycles`, `plant_deactivations`). "Replace" = cancel + create, two audit rows, full trail.
- **Anti-drift:** FSM-owned side table; never in any sync update set (the
  `plant_zone_overrides`/`plant_deactivations` posture, `schema.prisma:1771-1773`).
- **History:** rows are never deleted — EXPIRED/CANCELLED rows + `audit_logs` (prev/new metadata,
  the `COMPANY_UPDATED` `previous:{}` shape at `companies.service.ts:96-105`) are the trail.

### Effective tier — one resolver, predicate on the timestamp, never the status flag

```
effectiveTier(companyId, zoneId, now) =
  activeOverride(companyId, zoneId) where status='ACTIVE' AND expires_at > now
  ?? companies.company_tier
```

One exported helper (the #146 `deferral.ts` precedent: N readers ⇒ one predicate, not N hand-written
copies). **The read predicates on `expires_at`, not on `status` alone** — expiry is effective the
second it passes, even if the sweep that flips `status` and writes the audit row lags. Trusting the
derived `status` flag at a read boundary is the exact #130 failure class.

### Auto-revert at expiry (Q1: silent revert + audited)

Because the fallback is read-time, **revert needs no write to `companies`** — the override simply
stops applying. A new env-gated sweep in the business-sweep family
(`business-sweep-scheduler.service.ts` pattern: single-in-flight, never throws out of cron) flips
newly-expired `ACTIVE` rows → `EXPIRED` and writes `TIER_OVERRIDE_EXPIRED` audit rows (actor =
system) — satisfying "revert silently but audit the auto-revert" without making correctness depend
on cron timing.

### Endpoint contract (role-gated)

- `POST /api/org/tier-overrides` — body `{companyId, zoneId, tier, reason, expiresAt}`. Roles:
  OH (any zone), CSM (any zone — cross-zone role; Q-C confirms), ZM (**service-level clamp** to
  `actor.zone_id`, since the zone is in the body and `ZoneScopeGuard` only reads params/query).
  400 on missing/short reason, expiry past the 2-month cap, unknown tier; 409 on an existing ACTIVE
  override for the pair (no stacking). Audited `TIER_OVERRIDE_SET` with
  `{companyId, zoneId, prevEffectiveTier, newTier, reason, expiresAt}`.
- `DELETE /api/org/tier-overrides/:id` — cancel (same role scope as creation; ZM own-zone only).
  Audited `TIER_OVERRIDE_CANCELLED` with the row's fields.
- `GET /api/org/tier-overrides?status=&zoneId=&month=` — the **report read** (Q1's monthly report):
  active overrides + reason + creator + expiry; month filter serves the monthly review; ZM sees own
  zone, CSM/OH all. No aggregation cube needed — the table is small and the audit log is the
  history; a cube can be added later if the monthly review wants trends.

### Engine consumption — where the override must actually bite (the Q2 test)

1. **Recommender (dispatch order)** — resolve effective tier per candidate in the zone-run's
   existing company read (`recommender.service.ts:122-139`; one batched override lookup per run,
   keyed by the run's `zoneId`). Canonical sort key 1 is gated by nothing, so a ZM raising a
   customer to PLATINUM **provably reorders dispatch in that zone** — no second knob. Stamp
   `scoreBreakdown` with the effective tier + `tierOverrideId` when applied (explainability).
2. **Ticket creation** — stamp `tickets.company_tier` with the **effective** tier (creation already
   knows the plant → zone).
3. **Snapshot coherence (Q-B decides, option B recommended)** — on override create/cancel/expiry,
   re-stamp `tickets.company_tier` for that company × zone's **open** tickets in the same
   transaction (sweep does it for expiry), audited. Without this, the Platinum auto-escalation
   sweep (`cross-zone-escalation.service.ts:78`) and every queue reads the old tier and the
   override is half-inert — the vetoed pattern. Bounded write (open tickets of one company in one
   zone), same class as #119's deactivation cancel.
4. **Transparency ledger** — add active overrides to `captureConfigSnapshot` (explicit wiring
   required, `dispatch-run.service.ts:217-234`).
5. **SLA windows** (Q-E) — `sla_rule_config` `company_tier` scope should key off effective tier for
   coherence; consumer sites to be verified in-slice before committing to it.

### Cross-feature interaction with #158 (now LIVE — this is Q3, still open)

Overrides are keyed `(company, zone)` and a plant's zone is `plants.zone_id` — so a #158 zone
reassignment **instantly changes which override applies** to that plant's tickets (they re-scope
to the new zone and read its overrides). #158 was built **without** a tier-override warning on the
standing assumption priority was global; that assumption is now false. Q-D covers the decision;
the likely outcome is a small follow-up slice on #158's impact probe ("this company has an active
tier override in <old/new zone>").

## Acceptance criteria (draft — confirm at review)

- [ ] AC-1: `tiers` seeded exactly PLATINUM(1)/GOLD(2)/SILVER(3); spec-pin test asserts table ⇄
      enum ⇄ `TIER_ORDER` agreement; admin dropdowns read it.
- [ ] AC-2: override create/cancel enforced: mandatory reason (min length), expiry ≤ 2 months
      (DB CHECK + service 400), no stacking (partial unique + 409), ZM clamped to own zone at the
      service layer, CSM/OH cross-zone; every mutation audited with prev/new metadata in-transaction.
- [ ] AC-3: effective-tier resolver is the single shared predicate (timestamp-based); an expired-
      but-not-yet-swept override does NOT apply (test pins the sweep-lag case).
- [ ] AC-4: a ZM's PLATINUM override provably reorders that zone's dispatch (canonical-sort seam,
      asserted at the `runForZone` boundary) and is stamped in `scoreBreakdown`; other zones
      unaffected; global tier unchanged in `company_master`.
- [ ] AC-5: expiry sweep flips status + writes `TIER_OVERRIDE_EXPIRED`; open tickets re-stamped per
      Q-B's decision; behaviour identical whether the sweep has run or not (AC-3).
- [ ] AC-6: `config_snapshot` includes active overrides; the monthly report read returns active
      overrides + reason + creator + expiry, zone-scoped for ZM.
- [ ] AC-7: admin UI (role-gated per role matrix; v2-reference/UI-discovery gate honoured) for
      create/cancel/list; parity gate applies — no silent UI deferral.
- [ ] AC-8: CONTEXT.md/PRD updated to record the extended authority (OH global; CSM/ZM scoped +
      expiring) so spec and code agree.

## Slice plan (TDD-first; each slice green + committed; sized like #158's)

- **S1 — tiers table + spec-pin.** Additive migration (seed 3 rows), pin test, dropdowns read it.
- **S2 — override table + endpoint contract.** Migration (partial unique + CHECKs via raw-SQL
  appendix, the established convention); POST/DELETE/GET + role scoping + validation + audit. The
  largest test surface (roles × validation × stacking).
- **S3 — effective-tier resolver + engine bite.** Resolver helper + recommender wiring +
  ticket-creation stamp + `scoreBreakdown` + `config_snapshot`; the AC-4 reorder proof.
- **S4 — expiry sweep + snapshot coherence.** Sweep (env-gated, business-sweep family) +
  `TIER_OVERRIDE_EXPIRED` audit + Q-B re-stamp + AC-3 sweep-lag pin.
- **S5 — admin UI + report surface.** UI-discovery gate first; role-variant page (ZM own-zone
  create/list, CSM/OH cross-zone), active-overrides report view.
- **S6 — docs + edge cases.** CONTEXT/PRD authority update (AC-8); #158 interaction per Q-D;
  INDEX/SYSTEM-STATE.

## Open questions (operator review — blocking before S1)

- **Q-A (operator explicitly requested this decision): stacking.** Recommend **prevent** — partial
  unique one-ACTIVE-per-(company, zone); replace = cancel + create (two audit rows). Explicit
  stacking would need precedence rules (newest? highest tier?) with no PRD basis.
- **Q-B: snapshot coherence.** Recommend **re-stamp open tickets** on override create/cancel/expiry
  (option B above). The alternative — overrides affect only live reads — leaves Platinum
  auto-escalation and every queue on the stale tier, which is the half-inert knob the Q2 veto was
  about. Confirm, since it widens the write surface.
- **Q-C: CSM scope.** "Their zone/scope" — CSM is a cross-zone role with no home zone. Recommend:
  CSM may create overrides in any zone (audited with `actingZone`); confirm, or restrict CSM to
  their acting-scope zones under the #27 backup cascade.
- **Q-D (= the original Q3, still unanswered): #158 interaction.** A zone move silently re-attaches
  overrides. Recommend: extend #158's impact probe + warning to name active tier overrides in both
  zones. Confirm, and whether it belongs to this issue's S6 or a #158 follow-up.
- **Q-E: does effective tier drive SLA windows** (`sla_rule_config` `company_tier` scope) as well
  as dispatch order? Recommend yes for coherence; consumers verified in-slice first.
- **Q-F: plant ranking is parked.** The Q1 decision covers company tiers only; the plant-ranking
  half of the original filing (and its Q2 sort-key-vs-score question) remains undecided. Recommend
  splitting it to its own issue when/if it proceeds, so this issue ships without a dormant half.
- **Q-G (minor): min reason length** — recommend 10 characters (matches nothing existing; pick one
  at review) — and whether ZM overrides may only **raise** a tier or also lower it (nothing in the
  Q1 decision restricts direction; recommend allowing both, the report keeps it honest).
