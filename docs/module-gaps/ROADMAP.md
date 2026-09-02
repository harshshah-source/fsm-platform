# Roadmap — what to do first

Three rankings, deliberately **not blended into one score**. Then a recommended order that applies the
dependency graph *after* scoring, with the reason each item moved.

> **Read the numbers correctly.** TEQ is AI context cost — never a schedule, never headcount. Engineering
> size is relative only: XL is bigger than L, not "six weeks". Every module came out `conf LOW`, on a
> **borrowed** calibration (272 runs on a different TypeScript/Prisma repo, never measured on this one),
> and cross-check A split by 3.8×–15.7× everywhere. **Trust the ordering; do not commit to the absolute TEQ.**
> Portfolio totals sum module means, not medians (§5.2 finding 3).

---

## Ranking 1 — by severity (worst operational damage first)

Ranked on what breaks for a named person, never on fix cost (policy P7).

| # | module | S4 | S3 | DANGEROUS | the damage |
|---|---|---|---|---|---|
| 1 | `auth-access` | 0 | 4 | 4 | Anyone senior can act in any zone with no check that the manager is away; the ledger cannot say who really did it |
| 2 | `vouchers` | 0 | 6 | 6 | One person clears both money gates; a clarification request is a dead end |
| 3 | `tickets` | 1 | 2 | 2 | Reporting a component unavailable 500s every time; the SLA clock stops with no audit |
| 4 | `notifications` | 1 | 5 | 1 | The engineer is never told anything unless the app is already open |
| 5 | `cross-zone` | 0 | 6 | 1 | The zone that must do the work is never told; approve can strand an escalation |
| 6 | `ingestion` | 0 | 4 | 3 | A pipeline that stops reads as healthy; departed devices close tickets invisibly |
| 7 | `engineers` | 0 | 4 | 4 | A mistaken leave cannot be revoked by anyone, and the UI shows it corrected |
| 8 | `admin-config` | 2 | 3 | 3 | The console mints accounts nobody can log into |
| 9 | `reports` | 0 | 3 | 2 | The contractual uptime KPI reports a fabricated 100% |
| 10 | `verification` | 0 | 3 | 0 | Fraud flags are unscoped; an escalation can never be undone |

## Ranking 2 — by cost (cheapest meaningful fix first, P80)

The cheapest big fix in each module, from `estimate.json`. Six are under 2M.

| module | gap | P80 | what it buys |
|---|---|---|---|
| `engineers` | ENG-G2 | **0.67M** | planner writes that change dispatch become auditable |
| `ingestion` | ING-05 | **0.76M** | manual sync/pipeline/snapshot triggers get an audit row |
| `cross-zone` | CZ-09 | **1.24M** | decision notices stop vanishing when a zone has no manager |
| `vouchers` | VCH-10 | **1.31M** | a half-committed mark-PAID batch stops reporting success |
| `notifications` | NOTIF-02 | **1.62M** | insertion and escalation notices survive a crash |
| `dashboard` | DASH-G02 | **1.83M** | dead Action Required counts become links — a map that already exists |
| `admin-config` | AC-04 | **1.85M** | an audit row can finally say what a dial changed *from* and *to* |
| `auth-access` | AA-02 | **2.16M** | acting-scope writes stop being recorded as the manager's own |
| `reports` | RPT-02 | **2.90M** | the cubes finally cover the month the screens ask for |
| `tickets` | TKT-01 | **3.06M** | stopping the SLA clock leaves a trace |

## Ranking 3 — by leverage (unblocks the most)

| # | module | unblocks | why |
|---|---|---|---|
| 1 | `notifications` | 5 modules | NOTIF-01 is the single keystone; nothing blocks it |
| 2 | `ingestion` | 3 modules | feeds every work item; owns the producing end of staleness |
| 3 | `auth-access` | all 14 (audit) | attribution is app-wide, and it gates two other modules' reports |
| 4 | `tickets` | 5 modules | 19 spine edges; TKT-02 is why the warehouse queues are empty |
| 5 | `admin-config` | scheduling + every module's behaviour | its dials move other people's systems |

---

## Recommended order

Topological order applied **after** scoring. Where an item moved from its severity rank, the reason is stated.

**Wave 0 — fixtures. Not in the backlog, not priced, but do it first.**
`ENG-G7`, `V-08`, the empty inventory surface, `ING-09`. These are dev-process (O4). They blocked 17
needs-verify findings across the survey; clearing them converts code-evidence into reproduced evidence
and would let a re-run settle much of what this one had to leave open.

**Wave 1 — the keystone and the two cheapest control fixes.**
1. **`notifications` NOTIF-01** — *moved up from severity rank 4.* Nothing blocks it and five modules bottom
   out on it. Until it ships, work in `scheduling`, `intraday`, `cross-zone` and `inventory` cannot be
   finished, only staged.
2. **`auth-access` AA-01 + AA-02** — *held at severity rank 1.* AA-01 is missing a *when*, not a *who*
   (a ZM was correctly refused), so it is narrower than "rebuild acting scope". Note that AA-03 has **two**
   independent causes: fixing AA-02 alone will not repair the backup-share report.
3. **`engineers` ENG-G2** and **`ingestion` ING-05** — the two cheapest audit fixes in the survey, together
   under 1.5M P80.

**Wave 2 — the things that are wrong in the flattering direction.**
4. **`reports` RPT-01/RPT-02/RPT-03** — *moved up from severity rank 9.* A KPI that reports a fabricated
   100% against a contractual 98% is worse than one that reports nothing, because nobody investigates good
   news. RPT-03 is a select-list change, not a writer change.
5. **`ingestion` ING-02** — one admin-client edit unlocks three capabilities and surfaces three health
   sections that are red right now. The best cost-to-value ratio in the survey.
6. **`dashboard` DASH-G02 + DASH-G11** — must ship together, or one-click assign ships with nothing to click.

**Wave 3 — the money path.**
7. **`vouchers` VCH-02** (separation of duties, reproduced), **VCH-03** (now C4 "no UI", cheaper than feared),
   **VCH-10**. Also decide the one-way door: **VCH-08**, no reversal after PAID — priced, flagged, *your call*.

**Wave 4 — field work and hand-offs.**
8. **`tickets` TKT-02** — *held high.* The HTTP 500 is a small fix with a large blast radius: it is why the
   entire warehouse chain is unreachable. Pair with **`inventory` INV-G8**, since the two together restore
   the component path end to end.
9. **`cross-zone` CZ-01 + CZ-11**; **`admin-config` AC-01 + E-26**.

**Wave 5 — the remainder**, including `verification` V-02 and V-04, and the two human-memory spine edges
(E-15, E-17) on the money path, which need a product decision before they can be designed.

---

## Portfolio totals, with their health stated

| | |
|---|---|
| modules scoped | **14 of 14** — none parked |
| capability completeness | **63% → 78%** after this backlog (capability-weighted) |
| gaps | **148** — S4 5 · S3 48 · S2 52 · S1/S0 21 · **28 DANGEROUS** · 17 needs-verify |
| AI cost | **P50 393M / P80 786M TEQ**, summing module means |
| confidence | **LOW on every module**, without exception |
| weak-anchor exposure | **30.4M TEQ** rests on cohorts with n<10 (integration n=6, migration n=4) |
| basis | **borrowed** — never measured on this repo |

**Not estimated, and deliberately so:** review time · the product decisions themselves (a one-way door is
priced; deciding it is not) · requirement churn · this survey's own cost · anything behind Wave 0 fixtures.

## What would most change these numbers

1. **Clear Wave 0 and re-run S3.** Seventeen findings are unresolved for want of test data, not for want of looking.
2. **Split the over-3M gaps.** 30 gaps exceed the model's own "any single gap over 3M is not one gap" line.
   Every one is a decomposition failure, not a measurement — they will fall when split.
3. **Measure one real build.** The moment a single gap here is built and its actual TEQ recorded, the
   borrowed anchors can be replaced and `conf LOW` can start moving.
