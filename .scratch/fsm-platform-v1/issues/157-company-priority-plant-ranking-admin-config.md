# 157 — Company tier: global setting + scoped, expiring tier overrides (redesigned)

Status: ready-for-agent (operator go-ahead given 2026-07-23 — S1+S2+S3+S4+S5 landed; S6 remains: AC-9 (#158 zoneChangeImpact + Plant Zones dialog name active overrides) + AC-8 (CONTEXT.md/PRD extended-authority update))
Type: AFK after go-ahead

> **Review completed 2026-07-23 (interactive).** Q-A **stacking allowed** (operator choice, against
> recommendation) — precedence set to newest-wins as the working assumption, confirm at go-ahead;
> Q-B **live reads only** (operator choice, against recommendation) — the scope consequence is
> documented honestly below and must appear in UI copy; Q-C **CSM any zone**; Q-D **extend #158's
> impact warning** (S6). Defaults accepted without objection: Q-E SLA windows follow effective tier
> (consumers verified in-slice), Q-F plant ranking split to its own issue, Q-G 10-char min reason +
> overrides may raise or lower.
>
> **Retraction note (do not resurrect):** a mid-review operator message introduced a "Payment
> Defaulter" tier, PRD ordinal tables (Bronze=1…PayDef=5), "Special Case" vocabulary, a
> `company_tier_transitions` PRD posture, and a `companies.rank` integer migration. Investigation
> found **none of these exist** in this repo, in any sibling project (`fsm-admin-dashboard`,
> `-v2`, `fsm-platform-issue34` — all use the identical 3-tier canon), or in the live dev DB
> (43 companies, exactly PLATINUM/GOLD/SILVER). The operator confirmed the message was based on
> hallucinated content and **retracted it in full**; the business uses exactly three tiers. Nothing
> from that message is part of this design (including its expiry-notification idea — Q1's clean
> "revert silently but audit" stands; a notification can be added at final go if wanted).

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

- **Stacking ALLOWED (operator decision 2026-07-23, Q-A):** multiple ACTIVE overrides may coexist
  per (company, zone). **Precedence: newest wins** — `ORDER BY created_at DESC, id DESC LIMIT 1`
  among unexpired ACTIVE rows (working assumption from the review; confirm at go-ahead). No partial
  unique; instead an index `(company_id, zone_id, status, expires_at)` for the resolver read. The
  report and UI must show ALL active overrides for a pair, with the winning one marked — a stack
  where only the top row bites is exactly the kind of thing the monthly report exists to catch.
- **Anti-drift:** FSM-owned side table; never in any sync update set (the
  `plant_zone_overrides`/`plant_deactivations` posture, `schema.prisma:1771-1773`).
- **History:** rows are never deleted — EXPIRED/CANCELLED rows + `audit_logs` (prev/new metadata,
  the `COMPANY_UPDATED` `previous:{}` shape at `companies.service.ts:96-105`) are the trail.

### Effective tier — one resolver, predicate on the timestamp, never the status flag

```
effectiveTier(companyId, zoneId, now) =
  newest override for (companyId, zoneId) where status='ACTIVE' AND expires_at > now
    (ORDER BY created_at DESC, id DESC LIMIT 1)
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
  400 on missing/short reason (min 10 chars), expiry past the 2-month cap, unknown tier. Stacking
  is allowed (Q-A) — no conflict response; the create simply becomes the newest (winning) override.
  Audited `TIER_OVERRIDE_SET` with
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
3. **Snapshot coherence — RESOLVED: live reads only (operator decision 2026-07-23, Q-B, chosen
   with the trade-off stated).** No retroactive re-stamp, ever. `tickets.company_tier` keeps the
   effective-tier-at-creation stamp for each ticket's lifetime; existing open tickets keep their
   old stamp when an override lands or lapses. **Documented scope consequence:** an override
   changes dispatch ordering (live recommender read) and applies to tickets created while it is
   active — it does NOT grant the Platinum auto-escalation path
   (`cross-zone-escalation.service.ts:78`) or re-badge queues for tickets that already existed.
   This is deliberate, not an oversight — and the honesty requirement moves to the UI: the
   create-override dialog and the report MUST state this scope in copy (AC-7), so the knob's
   limits are visible to the person turning it.
4. **Transparency ledger** — add active overrides to `captureConfigSnapshot` (explicit wiring
   required, `dispatch-run.service.ts:217-234`).
5. **SLA windows** (Q-E) — `sla_rule_config` `company_tier` scope should key off effective tier for
   coherence; consumer sites to be verified in-slice before committing to it.

### Cross-feature interaction with #158 (now LIVE — this is Q3, still open)

Overrides are keyed `(company, zone)` and a plant's zone is `plants.zone_id` — so a #158 zone
reassignment **instantly changes which override applies** to that plant's tickets (they re-scope
to the new zone and read its overrides). **RESOLVED (operator decision 2026-07-23, Q-D): extend
#158's impact warning** — S6 widens `zoneChangeImpact` + the Plant Zones confirm dialog to name
active tier overrides for the plant's companies in both the old and new zone, so the re-attachment
is visible before the admin confirms. Owned by this issue's S6 (the warning is meaningless until
overrides exist).

## Acceptance criteria (draft — confirm at review)

- [x] AC-1: `tiers` seeded exactly PLATINUM(1)/GOLD(2)/SILVER(3); spec-pin test asserts table ⇄
      enum ⇄ `TIER_ORDER` agreement; admin dropdowns read it. **DONE 2026-07-23 (S1).**
- [x] AC-2: override create/cancel enforced: mandatory reason (min 10 chars), expiry ≤ 2 months
      (DB CHECK + service 400), ZM clamped to own zone at the service layer, CSM/OH cross-zone
      (CSM any zone — Q-C); raise AND lower both permitted (Q-G); every mutation audited with
      prev/new metadata in-transaction. **DONE 2026-07-23 (S2).**
- [x] AC-3: effective-tier resolver is the single shared predicate (timestamp-based, newest-wins
      under stacking — Q-A); an expired-but-not-yet-swept override does NOT apply (sweep-lag pin);
      with two ACTIVE overrides on one pair, the newer provably wins (stacking-precedence pin).
      **DONE 2026-07-23 (S2)** — resolver built and pinned; engine wiring (recommender/ticket
      creation/scoreBreakdown/config_snapshot) is S3's "engine bite," not yet done.
- [x] AC-4: a ZM's PLATINUM override provably reorders that zone's dispatch (canonical-sort seam,
      asserted at the `runForZone` boundary) and is stamped in `scoreBreakdown`; other zones
      unaffected; global tier unchanged in `company_master`. **DONE 2026-07-23 (S3).**
- [x] AC-5: expiry sweep flips status + writes `TIER_OVERRIDE_EXPIRED`; **no ticket re-stamp**
      (Q-B: live reads only — a test PINS that open tickets' stamped tier is untouched by override
      lifecycle events); behaviour identical whether the sweep has run or not (AC-3). **DONE 2026-07-27 (S4).**
- [x] AC-6: `config_snapshot` includes active overrides **(DONE 2026-07-23, S3)**; the monthly report
      read returns ALL active overrides + reason + creator + expiry with the winning override per
      pair marked (Q-A) **(DONE 2026-07-27, S5 — `GET /api/org/tier-overrides` now returns `isWinning`
      per row, computed by reusing the shared resolver `resolveActiveOverrides` so the mark matches
      what the engine applies; resolved against the whole table, so a `month`-filtered or
      ACTIVE-but-expired row is never falsely marked winning)**.
- [x] AC-7: admin UI (role-gated per role matrix; v2-reference/UI-discovery gate honoured) for
      create/cancel/list; the create dialog and report state the Q-B scope in copy ("affects
      dispatch ordering and newly created tickets; existing tickets keep their tier"); parity gate
      applies — no silent UI deferral. **DONE 2026-07-27 (S5)** — standalone role-variant page (ZM
      own-zone locked, CSM/OH zone picker) at `/tier-overrides`, RoleRoute + nav gated to ZM/CSM/OH;
      the v2 reference has no such surface and Settings is OH-only, so a documented discrepancy
      mirroring #158's Plant Zones (no silent deferral).
- [ ] AC-9: #158's `zoneChangeImpact` + Plant Zones confirm dialog name active tier overrides for
      the plant's companies in old and new zone (Q-D).
- [ ] AC-8: CONTEXT.md/PRD updated to record the extended authority (OH global; CSM/ZM scoped +
      expiring) so spec and code agree.

## Slice plan (TDD-first; each slice green + committed; sized like #158's)

- **S1 — tiers table + spec-pin. DONE 2026-07-23.** Additive migration (seed 3 rows), pin test,
  dropdowns read it. `tiers` model + migration `20260723120000_tiers_reference_table`; OH-gated
  `GET /api/org/tiers` (`tiers.service.ts`, `tiers.controller.ts`); spec-pin test asserts `tiers`
  ⇄ `CompanyTier` enum ⇄ `TIER_ORDER` agree (`test/tiers-spec-pin.spec.ts`, via a new derived
  export `TIER_ORDER_EFFECTIVE_PRIORITY_DESC` in `canonical-sort.ts`, not a hand-duplicated
  literal); admin Companies create-form + inline-edit tier `<select>`s now read `listTiers()`
  instead of a hard-coded PLATINUM/GOLD/SILVER option list.
- **S2 — override table + endpoint contract. DONE 2026-07-23.** Migration
  `20260723130000_company_tier_overrides` (expiry-window CHECK + lookup index via raw-SQL
  appendix, no partial-unique per Q-A); `POST/DELETE/GET /api/org/tier-overrides`
  (`tier-overrides.service.ts`, `tier-overrides.controller.ts`) with role scoping (OH/CSM
  cross-zone, ZM clamped to `user.zone_id` at the service layer per the #102 install-scope
  precedent), validation (reason ≥10 chars, expiry window, unknown tier/company/zone), and
  in-transaction audit (`TIER_OVERRIDE_SET`/`TIER_OVERRIDE_CANCELLED`). Also lands the AC-3
  resolver (`effective-tier.ts`, the #146 `deferral.ts` one-exported-predicate pattern) used for
  the audit's `prevEffectiveTier` and pinned directly (newest-wins, sweep-lag, cross-zone
  isolation) — engine wiring is still S3.
- **S3 — effective-tier resolver + engine bite. DONE 2026-07-23.** Batched resolver additions to
  `effective-tier.ts` (`resolveActiveOverrides` + `tierOverrideKey` — one query per zone-run rather
  than per candidate); wired into the recommender's TROUBLESHOOT path AND the Install backlog (both
  read the same live company join per the issue's "two copies" evidence), stamping
  `scoreBreakdown.tierOverrideId` when an override applied; `ticket-creation.service.ts` now stamps
  a new ticket's `company_tier` with the effective tier (batched plant→zone + override lookup for
  the whole sweep); `dispatch-run.service.ts`'s `config_snapshot` now includes every ACTIVE,
  unexpired override at run start (AC-6, config_snapshot half only — see AC-6 note). **Q-E resolved
  by evidence, not by wiring:** grepped for every consumer of `sla_rule_config` scope=`company_tier`
  — none exist yet (`sla-rules.service.ts` is admin CRUD only, `org-seed.ts` just seeds rows); there
  is nothing to wire to effective tier because nothing reads it yet. AC-4 proven directly: a
  same-zone Gold-vs-overridden-Silver pair reorders, the other zone and `company_master` stay
  untouched. **Full backend: 302 files / 3 skipped (305); 1238 passed / 5 skipped (1243); exit 0**
  (reconciles exactly: 299+3 files, 1232+6 tests). Also fixed a stale hand-rolled prisma stub in
  `dispatch-run-containment.spec.ts` (missing the new `companyTierOverride.findMany` collaborator)
  and removed one pre-existing orphaned test-DB fixture row (`device_id 9372001`, unrelated to this
  issue) that was colliding with `recovery-decision-controller.e2e-spec.ts`.
- **S4 — expiry sweep.** Sweep (env-gated, business-sweep family) + `TIER_OVERRIDE_EXPIRED` audit +
  AC-3 sweep-lag pin + the AC-5 no-re-stamp pin (Q-B). Smaller than originally scoped — no ticket
  writes.
- **S5 — admin UI + report surface.** UI-discovery gate first; role-variant page (ZM own-zone
  create/list, CSM/OH cross-zone), active-overrides report view with winning-override marking
  (Q-A) and the Q-B scope copy (AC-7).
- **S6 — #158 warning + docs + edge cases.** Extend `zoneChangeImpact` + Plant Zones dialog
  (AC-9/Q-D); CONTEXT/PRD authority update (AC-8); INDEX/SYSTEM-STATE.

## Resolved decisions (operator review, 2026-07-23 — interactive)

- **Q-A: stacking ALLOWED** (operator choice, against the prevent recommendation). Precedence:
  newest-wins — see data model. Report shows all active rows, winner marked.
- **Q-B: live reads only** (operator choice, against the re-stamp recommendation). No retroactive
  ticket re-stamp; scope stated in UI copy (AC-7); no-re-stamp behaviour test-pinned (AC-5).
- **Q-C: CSM may create overrides in any zone**, audited with `actingZone`.
- **Q-D: #158 interaction handled via the extended impact warning** (S6, AC-9).
- **Q-E: SLA windows follow effective tier** (default accepted); `sla_rule_config` `company_tier`
  consumers verified in-slice before wiring.
- **Q-F: plant ranking split to its own issue** (default accepted) — file the stub when it
  proceeds; this issue ships tiers only.
- **Q-G: min reason length 10 chars; overrides may raise or lower** (default accepted).

## Remaining open items (for the final go-ahead — not blocking the design)

- **Stacking precedence = newest-wins — CONFIRMED 2026-07-23** at S2 go-ahead (alternatives
  considered and declined: highest-tier-wins, explicit priority field). Locks the resolver's
  `ORDER BY created_at DESC, id DESC` and the no-partial-unique data model decision above.
- **Optional: expiry notification** (notify creator + OH on auto-revert, renew link). Considered
  and NOT adopted — it originated in the retracted message; Q1's clean "revert silently but audit"
  stands. Say the word at go-ahead if wanted; it slots into S4/S5.
