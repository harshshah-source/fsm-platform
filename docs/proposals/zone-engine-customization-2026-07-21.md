# Proposal — Zone-Manager Customization of the Assignment Engine

**Date:** 2026-07-21 · **Branch:** `feat/autoplant-integration` · **Status:** proposal / design analysis
**Author prompt:** "Expose ticket-creation and assignment-engine behavior to zone managers so they can
configure how it runs for their zone — but ZMs are non-technical and must never see scoring, weights,
thresholds, or engineering vocabulary."
**Scope:** READ-ONLY analysis. No code changed. Every claim about current behavior cites `file:line`.
Current-state background is not restated here — see `docs/SYSTEM-STATE-2026-07.md` §3c–§3h.

---

## 0. TL;DR — my recommendation up front

**Do not build "ZM tunes the engine" as asked.** The literal feature — per-zone engine knobs a ZM
edits — is a net-negative for this platform, for three evidence-backed reasons:

1. **The most tempting knob is the one that breaks the KPI system.** The device-silence threshold that
   decides "is this a job?" also defines the *denominator* of Fleet Uptime and the Soft Inactive Count
   the platform grades ZMs on. Letting a graded ZM set their own threshold is letting the examinee set
   the exam's pass mark, and it makes zones non-comparable in the very reports that compare them.
2. **Most of what a ZM actually wants, they already have** — as *per-instance* operational control
   (override, same-day update, SE-planner bias, capacity, leave), not as engine config.
3. **The genuinely-safe knobs are few and small**, and only two of them are even worth surfacing.

What I *would* build is a much smaller thing in two parts: **(P1)** make the engine's *already
per-zone* behavior **legible** to the ZM (they can't currently see it), and **(P2)** — only if real
demand is shown — expose **at most two** recommender-local dials as **named operational postures**
(no numbers), bounded by the Operations Head. Everything that defines a KPI or a business tier stays
global and OH-owned. Details in §4–§5.

If you only take one thing from this doc: **configurability is not empowerment when the configurer is
the graded party.** §3.1 is the load-bearing argument.

---

## 1. What the engine actually does, and every knob it already has

I traced the funnel end-to-end (recompute → eligibility → ticket creation → recommender → dispatch)
and catalogued every value that changes engine behavior. This is the raw material for "what could a
ZM control" — derived from the code, not from assumptions.

### 1.1 The tunable surface today (evidence)

| # | Knob | Where it lives | What it changes | Who can edit today | Per-zone? |
|---|------|----------------|-----------------|--------------------|-----------|
| 1 | `inactivity_threshold_hours` (24) | `system_settings`; read at `device-state.service.ts:55-57`; default `settings.service.ts:13` | Device silent longer ⇒ `is_inactive` ⇒ **candidate for a ticket** | OH only (`settings.controller.ts:11`) | **No** |
| 2 | `eligibility_mode` (`pgi`\|`all-deployed`) | `system_settings`; read `device-state.service.ts:58,82-90`; default `settings.service.ts:38` | Which devices count as Eligible ⇒ **the ticket-creation gate** and the Fleet-Uptime denominator | OH only | **No** |
| 3 | `plant_cluster_multiplier` (1.25) | `system_settings`; read `recommender.service.ts:522-526`; default `settings.service.ts:29` | Score boost for a 2nd+ ticket at the same plant ⇒ **clustering of an SE's day** | OH only | **No** |
| 4 | Deficit-mode threshold (2%) | **hard-coded constant** `DEFAULT_DEFICIT_THRESHOLD_PCT`, `soft-inactive-count.service.ts:9`, injected as a constructor default `:37` | When a zone flips DEFICIT→PREVENTIVE ⇒ **whether the recommender chases outages or does preventive/backlog work** | Nobody (constant) | Signal is per-zone (`modeForZone`, `:41-51`); **threshold is global** |
| 5 | Scoring weights (`priority_rule_config`) | table; read `recommender.service.ts:495-520`; edited `scoring-weights.service.ts` | Relative weight of company rank / urgency / repeat / distance ⇒ **which SE is suggested and in what order** | OH only (`scoring-weights.controller.ts:16`) | **No** (one global active set) |
| 6 | SLA windows (`sla_rule_config`) | table; edited `sla-rules.service.ts` | *Intended* submit/verify/escalate minutes per bucket or tier | OH only | keyed by `(scope,key)`, **not zone** |
| 7 | SLA band boundaries (`SLA_BANDS`) | **code constant**, `packages/shared/src/index.ts:67-76` | The bucket ladder (WARNING 4h … LONG_PENDING 7d+) used by every queue, dashboard, and report | Nobody (code) | **No** |
| 8 | Candidate precedence | code, `candidate-selection.service.ts` (ADR-0001): DEDICATED→MULTI_PLANT→FLOATING | Which *kind* of SE is tried first | Nobody (code) | **No** |
| 9 | Per-SE `daily_capacity`, `is_active` | `engineer_master`; read `recommender.service.ts:528-533` | OVER_CAPACITY hard filter ⇒ how many jobs an SE gets | OH via engineer admin | per-SE (zone-adjacent) |
| 10 | SE-Planner intent | `se_planner`; read `recommender.service.ts:471-486` | **Soft** bias toward a ZM-named SE for a plant/day (ADR-0022, never a constraint) | **ZM already** | per-plant/day |

**Two findings that matter for this design:**

- **Nothing in the engine is per-zone config.** The `zones` table carries a name and a ZM pointer and
  *no behavioral columns* (`schema.prisma:168-186`). Every knob above is either global
  (`system_settings`, `priority_rule_config`) or a code constant. The *only* thing that varies by zone
  today is emergent, not configured: `SoftInactiveCountService.modeForZone` computes each zone's
  DEFICIT/PREVENTIVE mode from that zone's own silent-device ratio (`soft-inactive-count.service.ts:41-51`).
- **`sla_rule_config` (#6) is editable-but-inert.** A grep for its columns
  (`submitWithinMinutes`/`verifyWithinMinutes`/`escalateAfterMinutes`) finds **only** the CRUD service
  and the seed — `org/sla-rules.service.ts` and `org/org-seed.ts`. No runtime clock, sweep, or SLA
  derivation consumes it. So the platform *already ships* a config surface a ZM might expect to matter
  that changes nothing. Any new config we add must not repeat that.

### 1.2 The levers a ZM already has (these are not config — they're execution)

Per SYSTEM-STATE §3h, the ZM already owns rich *per-instance* control, committed immediately, audited,
no approval gate:

- **Override engine** (#13, `override.service.ts`): reassign / split / remove / defer / reorder any
  ticket in today's plan, with a mandatory reason.
- **Same-day update** (#31, `same-day-update.service.ts`): add/remove/reorder mid-shift.
- **SE-Planner** (#14): tell the recommender which SE they *intend* for a plant today (knob #10).
- **Capacity / availability / leave**: shape who is eligible and how loaded.
- **Intraday manual-assign** and **cross-zone flag** for stuck Platinum work.

This is the altitude a non-technical ZM operates at: *"send Ravi to this plant, defer that one, my
team is short today."* It is decisions about **today's real tickets**, not about how the machine
computes in the abstract. Hold this thought — it is why most of the requested feature is redundant.

---

## 2. Translating the engine into ZM vocabulary

The rule was: derive what ZMs plausibly want **from what the engine does**, phrased with zero
engineering vocabulary. Here is the honest mapping — each row is a real engine behavior, a plain-language
want, and the verdict I defend in §3.

| ZM-language want | Engine reality it maps to | Verdict (defended in §3) |
|---|---|---|
| "How long can a truck's tracker go quiet before it becomes a job for my team?" | `inactivity_threshold_hours` (#1) | ❌ **Global.** Defines a graded KPI's denominator + self-grading conflict |
| "Which trackers are even worth sending someone for?" | `eligibility_mode` (#2) | ❌ **Global.** Denominator definition; platform-wide |
| "When my team is swamped, chase the fires; when it's calm, do the catch-up/backlog work." | DEFICIT/PREVENTIVE mode + its 2% threshold (#4) | ⚠️ **Safe-ish.** Already per-zone signal; only the *sensitivity* is a candidate knob |
| "Group jobs that are close together / at the same plant so my SE isn't zig-zagging." | `plant_cluster_multiplier` (#3) | ⚠️ **Safe-ish.** Local efficiency; no KPI contamination |
| "Prefer my planned engineer for this plant." | SE-Planner (#10) | ✅ **Already exists**, per plant/day |
| "This customer/plant matters more today — bump it up." | scoring weights (#5), company rank | ❌ **Global.** Business/CRM-owned tier; cross-zone explainability |
| "Change my team's SLA/escalation timers." | `sla_rule_config` (#6) | ❌ Inert today; and cross-zone SLA comparability |
| "Rearrange, reassign, or defer today's plan." | override / same-day (§1.2) | ✅ **Already exists**, correct altitude |

The striking result: of eight plausible wants, **three already exist**, **three break platform
invariants**, and **only two** ("staffing pressure sensitivity" and "group nearby jobs") are new,
safe, and worth discussing. That ratio is the core message of this proposal.

---

## 3. What is safely per-zone vs. what breaks the platform

### 3.1 The load-bearing argument: the silence threshold is a grading dial, not an ops dial

This is the single most important point in the document, and it's where I push back hardest on the
framing.

`inactivity_threshold_hours` (#1) reads as an innocent operational preference — "my zone's trucks are
rural, give them longer before I panic." But follow the data flow:

- It sets `is_inactive` in the **one global set-based recompute** (`device-state.service.ts:108`).
- `is_inactive` **is** the Soft Inactive Count (`soft-inactive-count.service.ts:44,58`), which is the
  intraday counterpart to **Fleet Uptime %** — the monthly KPI the platform grades zones on
  (`zm_performance_summary_monthly`, SYSTEM-STATE §2.8).
- The same count drives each zone's DEFICIT/PREVENTIVE mode (`recommender.service.ts:101`).

So if North sets 12h and South sets 48h:

1. **Zones stop being comparable** in the exact reports built to compare them. "North's uptime is
   worse than South's" becomes meaningless — they're measuring different things.
2. **A ZM can improve their own scorecard by widening their own threshold.** Fewer devices cross
   "inactive," Soft Inactive Count drops, uptime looks better — with zero field improvement. This is a
   direct conflict of interest, handed to the graded party, in a plain-language UI that hides the fact
   that they're editing their own grade.
3. **The hot path pays for it.** Recompute is today *one* set-based `UPDATE` using a single `threshold`
   scalar (`device-state.service.ts:96-126`) — this is deliberate R4-B architecture. Per-zone thresholds
   force a per-device join to zone config and destroy the single-scalar simplicity, on the pipeline's
   most frequent job.

The same logic condemns `eligibility_mode` (#2 — it literally is the denominator) and scoring weights
(#5 — company rank is CRM/business-owned and cross-zone explainability of "why this SE" collapses if
each zone weights differently). **These belong to the Operations Head, full stop.** That's not a UI
decision; it's an integrity decision, and it happens to already be how the code is gated
(`settings.controller.ts:11`, `scoring-weights.controller.ts:16`).

### 3.2 The genuinely-safe zone-local candidates

Two knobs change **only** how *this zone's recommender* orders *this zone's* SEs on *today's* run, and
touch no cross-zone KPI, no denominator, and no business tier:

- **Staffing-pressure sensitivity** (deficit threshold, #4). The DEFICIT/PREVENTIVE decision is
  *already* computed per zone from that zone's own ratio; only the 2% cutoff is global-and-hard-coded.
  A rural zone with chronically higher baseline silence plausibly wants a different trip point for
  "switch to fire-fighting mode." This is the one knob where per-zone is arguably *more correct*, not
  just tolerable. **Caveat:** it reads the same Soft Inactive Count that feeds the KPI, so it must be
  bounded (see §5) and recorded, or it drifts toward the §3.1 problem by the back door.
- **"Group nearby jobs"** (cluster multiplier, #3). Pure routing efficiency. Geography genuinely
  differs by zone (dense metro vs. spread-out rural). Changing it re-shapes an SE's day but cannot
  move a KPI or mis-rank a customer. Lowest-risk knob on the board.

SE-Planner (#10) and per-SE capacity (#9) are already ZM-adjacent and per-instance; no new config
needed.

### 3.3 Summary table

| Knob | Safe per-zone? | Why |
|---|---|---|
| Silence threshold (#1) | ❌ | KPI denominator + self-grading conflict + hot-path cost |
| Eligibility mode (#2) | ❌ | *Is* the Fleet-Uptime denominator |
| Scoring weights (#5) | ❌ | Business-owned tier; cross-zone "why this SE" explainability |
| SLA windows/bands (#6/#7) | ❌ | Cross-zone SLA comparability; #6 also inert today |
| Candidate precedence (#8) | ❌ | Correctness invariant (ADR-0001), not a preference |
| **Staffing-pressure sensitivity (#4)** | ⚠️ **Yes, bounded** | Recommender-local; already per-zone signal; must be OH-bounded + recorded |
| **Group nearby jobs (#3)** | ✅ **Yes** | Recommender-local routing; no KPI/tier impact |
| SE-Planner (#10), capacity (#9) | ✅ already ZM | Per-instance, already owned |

---

## 4. Architecturally distinct approaches

### Approach A — Per-zone engine-config override table (the literal ask)

A `zone_engine_config` table overriding `system_settings` per zone; every engine read resolves
zone-override → global-default; a ZM UI in plain language edits the ZM-safe subset.

- **Data model:** `zone_engine_config(zone_id, key, value_json, updated_by, updated_at)`, unique
  `(zone_id, key)`; plus an allow-list of which keys a ZM may touch.
- **Read path:** every consumer that reads a setting must become zone-aware. The recommender is already
  per-zone (`runForZone`) so #3/#4 are cheap there. **But** #1/#2 live in the *global* recompute
  (`device-state.service.ts`), which would have to join per-device→plant→zone config and give up its
  single-scalar set-based form — a real tax on the hottest job, for exactly the knobs that shouldn't be
  per-zone anyway.
- **Write path:** `PUT /api/zones/:zoneId/engine-config/:key`, `ZoneScopeGuard` clamps to home zone
  (the guard already rejects cross-zone `:zoneId`, SYSTEM-STATE §3j), audited via the existing
  `withAudit` pattern (`settings.service.ts:89-110`), allow-listed keys only.
- **UI shape:** a ZM "Zone Tuning" page of plain-language cards with raw-ish controls.
- **Risks:** invites the §3.1 disaster if the allow-list ever grows carelessly; two-layer resolution
  everywhere becomes a permanent debugging tax ("why did North behave differently at 09:00?"); config
  sprawl; every *future* setting must now decide zone-overridable-or-not.
- **Maintenance cost:** **High.** Cross-cutting resolution logic + governance on the allow-list forever.

### Approach B — Curated operational postures (presets, not numbers)

Do not expose numbers. Expose a tiny set of **named postures** the OH pre-defines; the ZM picks one for
their zone. Each posture maps to OH-sanctioned values within OH-set bounds. Only recommender-local knobs
(#3, #4) are ever behind a posture; KPI-defining settings are never exposed.

- **Data model:** small `zone_config(zone_id, key, choice_enum)`; the enum→number mapping and bounds
  live in OH-owned config/code, **not** in the ZM's hands. Recompute stays single-scalar and untouched.
- **Read path:** only `recommender.service.ts` resolves the two per-zone choices (it's already per-zone);
  `device-state.service.ts` is **not** modified. Blast radius = one file.
- **Write path:** `PUT /api/zones/:zoneId/posture/:key` with an enum body; `ZoneScopeGuard` + audit +
  allow-list as in A.
- **UI shape:** 2–3 dropdowns in operational English, no numbers, no "threshold/weight/score":
  - *"How fast should the system switch my team into catch-up mode when devices pile up?"* →
    Balanced (default) / Sensitive / Relaxed → bounded deficit thresholds.
  - *"How strongly should I group jobs that are near each other?"* → Off / Normal (default) / Strong →
    bounded cluster multipliers.
- **Risks:** low; bounded blast radius; can't game a KPI (the exposed knobs don't feed one directly);
  OH retains guardrails. Residual: "Sensitive" staffing-pressure *does* read the Soft Inactive Count, so
  the posture-in-effect must be recorded on the dispatch run for auditability of the ZM scorecard.
- **Maintenance cost:** **Low–moderate.** One resolution site; a small OH-owned mapping.

### Approach C — Build no config; make the existing per-zone behavior legible + widen owned levers

The null-ish option, and a serious contender. The genuine ZM need is same-day operational control,
which **already exists** (§1.2). The real *gap* is that the engine already personalizes per zone
(DEFICIT/PREVENTIVE) and the **ZM cannot see it or why**. Close that instead of adding knobs.

- **Data model:** none. Read-only surfacing of `RunSummary.mode` (already returned,
  `recommender.service.ts:387`) and the zone's Soft Inactive Count.
- **Read/write path:** no engine change; a dashboard read + a plain-language explainer
  ("Your zone is in **Catch-up mode** because ~X% of your eligible devices have gone quiet").
- **UI shape:** one card on the ZM dashboard + existing override/planner/capacity controls.
- **Risks:** essentially none. Ships in days.
- **Maintenance cost:** **Minimal.**

---

## 5. Recommendation

**Reject Approach A. Ship Approach C now. Add the two safe dials of Approach B only if demand is
evidenced — and never widen past those two.**

Concretely, in order:

- **P1 (build now, C):** Make the engine legible. Surface the zone's current operating mode
  (DEFICIT/PREVENTIVE, renamed to non-technical language — "Catch-up" / "Preventive") and the plain
  reason, on the ZM dashboard. This delivers most of the *felt* need ("I want to understand/steer how
  it runs for my zone") at near-zero risk, and it's honest: the engine really is already personalizing
  per zone; the ZM just can't see it. It also makes any later posture (P2) intelligible rather than a
  mystery dial.
- **P2 (build only on evidenced demand, B):** Expose **exactly two** OH-bounded, recommender-local
  postures as named choices — staffing-pressure sensitivity (#4) and group-nearby-jobs (#3) — with the
  posture-in-effect stamped on the dispatch-run ledger so the ZM scorecard stays auditable.
- **Never:** silence threshold (#1), eligibility mode (#2), scoring weights (#5), SLA windows/bands
  (#6/#7), candidate precedence (#8). These are OH-owned platform invariants; the code already gates
  them that way.

**Why the others lose:**

- **A loses** because it makes the pipeline's hottest path zone-aware for knobs that must not be
  per-zone (§3.1), imports a permanent two-layer resolution/debugging tax, and — worst — its plain-language
  UI would quietly hand a graded ZM the dial that sets their own grade. A "just add an allow-list"
  defense doesn't hold: the whole value proposition of the ask is the KPI-shaping knobs, and those are
  exactly the ones the allow-list must forbid. What's left after the forbidden set is… Approach B.
- **Pure C loses** only if there is real, evidenced demand for zone-level *behavior shaping* that
  override/planner/capacity can't express. The one plausible such knob is staffing-pressure sensitivity
  — and B captures it safely without C's ceiling. So the answer is C **plus** a gated B, not C alone.

**The honest "don't build it" verdict:** the feature *as literally framed* — "let ZMs configure the
engine" — is **not worth building**, and building it faithfully would harm the platform. The version
worth building is small, mostly legibility, and deliberately withholds every knob that made the
original ask sound powerful. If after P1 the ZMs don't ask for P2, **P2 is YAGNI** — do not build it
speculatively. Config surfaces that don't change outcomes are worse than nothing; `sla_rule_config`
(§1.1) is the in-repo proof.

---

## 6. Open questions the design must resolve before implementation

1. **Is there evidenced demand, or is this speculative?** P2 should not be built until a ZM asks for
   behavior the override/planner/capacity levers can't express. What's the evidence?
2. **Is the "let me change the silence threshold" impulse actually a symptom of blocker B7?** Today
   `eligibility_mode='pgi'` over an empty `pgi_history` creates **zero** tickets (SYSTEM-STATE §3d).
   A ZM frustrated that "nothing shows up" may be feeling the PGI gap, not a real threshold need — which
   a per-zone threshold would *not* fix. Resolve B7 framing first.
3. **Who owns the posture→number mapping and the bounds?** My assumption: Operations Head, in
   OH-owned config, audited — same authority that owns `system_settings` and `priority_rule_config` today.
4. **Auditability of the grade.** If staffing-pressure sensitivity is exposed, the posture-in-effect
   must be recorded per dispatch run (extend the existing `weightSetRef`/`mode` stamp,
   `recommender.service.ts:387`) so the ZM scorecard remains defensible. Confirm.
5. **Naming.** "DEFICIT/PREVENTIVE," "cluster multiplier," "deficit threshold" are all engineering
   vocabulary. P1 needs a vetted non-technical lexicon ("Catch-up mode," "group nearby jobs") — who signs
   off on the words, given CONTEXT.md is the domain-language authority?
6. **Per-zone vs. per-plant.** Geography (the honest rationale for #3/#4) varies *within* a zone too.
   Is zone the right granularity, or does this eventually want to be per-plant — and if so, does that
   change the data model enough that we'd regret a zone-only table?
7. **Mobile.** None of this touches the SE app (auth-shell only, SYSTEM-STATE §1.1); confirm P1/P2 are
   admin-only and no mobile AC is implied.

---

## 7. Evidence index (primary `file:line` citations)

- Recompute & silence threshold: `apps/backend/src/device-state/device-state.service.ts:55-57,96-126`
- Eligibility gate/modes: `device-state.service.ts:58,82-90`; `device-state/eligibility.ts:22-40`
- Global settings + OH-only gate: `settings/settings.service.ts:12-48,89-110`; `settings/settings.controller.ts:11`
- Recommender orchestration/mode/weights: `recommender/recommender.service.ts:97-152,495-526`
- Scoring components: `recommender/scoring.ts:45-114`
- Hard filters: `recommender/hard-filters.ts:40-60`
- Deficit/preventive switch + threshold: `reports/soft-inactive-count.service.ts:9,37,41-51`
- Scoring-weights config (OH-only): `org/scoring-weights.service.ts`; `org/scoring-weights.controller.ts:16`
- SLA config (editable-but-inert): `org/sla-rules.service.ts`; grep of `submit_within_minutes` ⇒ CRUD+seed only
- SLA bands (code constant): `packages/shared/src/index.ts:67-76`
- `zones` has no behavioral columns: `apps/backend/prisma/schema.prisma:168-186`
- ZM per-instance levers: SYSTEM-STATE §3h (override #13, same-day #31, planner #14)
- Existing OH Settings UI surface: `apps/admin/src/pages/settings/SettingsPage.tsx:26-36`
