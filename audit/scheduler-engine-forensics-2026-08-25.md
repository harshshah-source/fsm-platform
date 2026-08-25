# Scheduler Engine Forensics — 2026-08-25

Forensic investigation of the Scheduler Engine implementation against the two historical baselines
of **2026-08-19** (backend/operational design) and **2026-08-19/20** (Today's Dispatch / Crew Deck
UI concept). Analysis only — no implementation file was modified.

- Repo: `C:\fsm-platform-backup`, branch `feat/autoplant-integration`
- Method: five independent read-only code investigations (history · engine lifecycle ·
  planning/assignment · API+UI · audit/override/replay) plus recovery of the original Aug-20
  design artifact's six artboards.
- Published copy: https://claude.ai/code/artifact/2b8f58ac-a744-4922-b079-d92eddd71da8
- Evidence levels: **[VF]** verified fact (read directly in code/git/schema) · **[SE]** strong
  evidence (multiple corroborating sources) · **[UNKNOWN]** not verifiable from available material.
- Capability classes: **A** implemented + test-verified · **B** implemented, incomplete ·
  **C** implemented, potentially incorrect · **D** missing · **E** dead / unused / stale.

---

## A. Executive conclusion

> **Option 2: the backend is substantially complete; targeted backend/API additions are required.
> The primary gap is the UI — but not only the UI.**

On Aug 19–20 two designs were produced. The manual-assignment one (Assign Work Console, #272) was
committed to the repo and built. The scheduler-engine one — **Today's Dispatch / Crew Deck** —
lived only as a claude.ai artifact, left exactly one trace in the repo (the orphaned phrase
*"dispatch-board grammar … the two boards read as one product"*,
`272-decision-assign-work-console.md:64`), and was lost. Four days later #280 recorded, verbatim
and wrongly, *"No wireframe exists for this screen set"* and directed #281 to ship navigation
grouping and cross-links only. The result is a correct engine wearing the wrong face — plus a
short list of real backend defects surfaced along the way. [VF]

| Layer | Status | Confidence |
|---|---|---|
| Backend engine | Substantially complete and correct against the ratified #258 model. Core run machinery (tick claims, per-zone admission rows, heartbeat, reaper, bounded retry, per-SE transactions, closure recycling) is DB-coordinated, status-guarded, and pinned by two-connection e2e specs with **zero skipped specs**. Gaps cluster in *post-failure* behaviour and provenance edges. | High — code- and test-verified |
| API surface | Rich but mis-shaped for a live cockpit: no today-scoped read, no changes-today read, four write endpoints unused by any UI, multiple payload fields returned and rendered nowhere. | High — every endpoint enumerated with callers |
| Admin UI | Four separate tense-views plus cross-links (#281). No unified today view, no multi-engineer lane board, partial provenance, the only Run-dispatch button on the OH-only Bulk-Unassign page, and an Intra-day Queue that cannot see the changes the UI itself makes. | High — every screen traced to its APIs |
| Architecture | Sound. The #258 Q8 model is compatible with the Crew Deck; no architectural change required. The Crew Deck's data spine (per-SE day plans with persisted stop sequence, per-decision traces, escalation rows, holds, capacity payload) already exists. | High |

---

## B. Historical baseline

### August 19, 2026 — Scheduler Engine backend/operational design

- **The operator's "2026-08-19 brief" (Decisions 1–18) is itself lost.** Cited by section number
  in #243 and `docs/audits/scheduler-slice-plan-2026-08-19.md:11`; no file in the repo contains
  it. [VF that it is cited; UNKNOWN its full text]
- **Twelve implementation slices #240–#251 landed the same day**, all approved, all still in
  force: IST day boundary (#240), recorded removal reasons (#241), plan-expiry recycling (#242),
  Special-ticket derivation (#244), vehicle-unavailability lifecycle (#245/#246), SLA resume
  (#247 — re-ruled next day by Q7), return-date priority one key below CRITICAL+ (#248),
  deferral override-never-bypass (#249), the dry-run preview seam that must project the *real*
  recommender (#250), the gate-less admin Scheduler Preview page (#251). [VF]
- Two gate questions answered by the operator: provisional deferral from the SE's proposal;
  latest valid in-scope managerial action supersedes. [VF]
- **Two audits produced and never committed** — `audit/navigation-ia-audit-2026-08-19.md`
  (F6 HIGH: "the dispatch timeline is three sidebar rows and a dead end") and
  `audit/frontend-ux-audit-2026-08-19.md` (P0: "the primary action is missing from the primary
  surfaces"). Both exploratory analysis; both re-entered the process only on Aug 24 via #280. [VF]

### August 20, 2026 — the ratified operational model (#258 / P8) — all APPROVED

| Ruling | Substance |
|---|---|
| Q1 | Score is a real selection factor *within* a coverage tier; DEDICATED → MULTI_PLANT → FLOATING precedence inviolable. |
| Q2 | `daily_capacity` is an automatic-planning constraint, never an authorization boundary; manual paths may exceed it, visibly, with no block. |
| Q3 | CRITICAL work is directly assigned, never offered — SE Acceptance retired. |
| Q4/Q5 | Phase-1 eligibility proxy; VEHICLE_ON_TRIP and COMPONENT_UNAVAILABLE non-blocking but transparency must distinguish evaluated-passed / evaluated-failed / **not-enforced**. |
| Q6 | Distance from admin-managed SE home base; **no live GPS in Phase 1**. |
| Q7 | SLA resume follows *ticket* outcome — explicitly re-rules #247 AC2. |
| Q8 | Database-coordinated, zone-partitioned scheduling monolith: Postgres is the concurrency coordinator; heartbeat + reaper + conditional finish; per-SE dispatch transactions; DB tick claims; one execution path for cron and manual. |
| Q-A/Q-B | Cluster multiplier candidate-specific; a CRITICAL with no capacity-eligible SE **escalates** — the scheduler never self-authorises overload. |
| G1–G8 | Effectively-once dispatch · zone independence · blast radius ≤ one SE · clean 4xx losers · crash recovery with no permanent RUNNING · misconfiguration safety · auditable outcomes · one execution path. |

### August 19–20, 2026 — Today's Dispatch / Crew Deck UI design

Recovered in full from the artifact *"Today's Dispatch — Scheduler UI"* (updated 2026-08-20;
six artboards extracted from its embedded document). [VF content; UNKNOWN whether the operator
formally approved it — no repo record exists either way.]

- **Winning direction — "Crew Deck (Live)"**: header *Dashboard · Today's Dispatch* with zone,
  date, run-status pill (*Dispatched 05:00 · Success*), a **Plan | Live | Replay** mode toggle,
  a **Run dispatch** action, find-ticket/SE search. Situation chips: *42 placed · 3 unassignable ·
  2 held · 1 critical needs you · 1 over capacity · 4 changes today*. A **critical interception
  strip** (the Q-B escalation surfaced: "no capacity-eligible SE — escalated 11:42 · ZM alerted —
  Assign manually"). A 3-wide **deck of SE cards**, one per engineer: tier badge, load 7/8,
  numbered plant groups holding ordered stop chips; override chips tagged *ZM·initials*; *RET*
  return-date chips; special card states (Overloaded 9/8; Floating with headroom "first candidate
  for rebalance"; On-leave "coverage fell to Ramesh"). A **provenance legend**: solid = system
  decision · dashed + role·initials = human override · crimson = critical direct-assigned ·
  RET · ghost = not on a route. A right-hand **work rail**: Unassignable (per-device reasons
  NO_COVERAGE / ALL_DROPPED), Held/deferred (return dates + approver), Withheld by policy
  (below-threshold count), Changes today (2 adds · 1 remove · 1 swap).
- **Override flow board**: *Inspect → understand → override → preview impact → confirm*. Click a
  chip; an inspector opens alongside showing the system's decision ("Dedicated coverage at P4 ·
  Available all day · Capacity 6 of 8 at decision time · Common kit complete · + already routed
  to P4 (clustering) · Vehicle-on-trip — not enforced yet"), a link to the full candidate
  comparison, then Move/Hold/Remove with an **impact preview before commit** (capacity both
  lanes, "Sneha ranked #2 in the 05:00 run", route effect, conflicts) and a mandatory audited
  reason. After confirm the chip re-renders dashed with *ZM · initials* — "a human decision never
  looks like a system one." A lost race re-presents as a clean conflict.
- **Exploratory concepts** (explicitly not the winner): A Route Ribbons; C Decision Stream
  ("perfect for audit and replay — survives as the inspector inside B"); D Zone Map ("right as a
  later overlay, wrong as primary" — honest about missing home-base/geometry data). The canvas
  note recommends B + C-as-inspector + D-later. The design is **ordinal — "no fake clock"**:
  sequenced stops, no times, no ETA, consistent with Q6.
- **Also approved that day**: the Assign Work Console (#272, in-repo design file, R1–R9, visual
  grammar "non-negotiable"). #272:64 inherits "the dispatch-board grammar" from "the two boards" —
  the only surviving repo trace of the Crew Deck. [VF]

---

## C. Current scheduler backend — verified state

Engine lives in `apps/backend/src/scheduling/**` + `src/recommender/**` (no "dispatch module").
426 spec files; zero skipped specs.

| Capability | Class | Evidence / location | Concern |
|---|---|---|---|
| Cron trigger, 05:00 IST | A | `dispatch-scheduler.service.ts:82`; exact 20-job registry pinned | Master switch `BUSINESS_SWEEPS_ENABLED` defaults OFF |
| Configurable schedule applied at boot (#213/#257) | A | `dispatch-schedule.service.ts:75`; `main.ts:46` | Accepts sub-daily cron expressions (see E) |
| Manual trigger `POST /schedules/dispatch-run` | A | `schedules.controller.ts:190` — OH + CSM; same entry path as cron | CSM grant code-verified only |
| Duplicate prevention — DB tick claims (#263) | A | CTE insert-is-the-test, `cron-tick-claim.service.ts:51-71`; real two-pool race spec | Arbitrates per minute only |
| Per-zone admission row (#259) | A | Partial unique `ux_dispatch_run_zones_one_running_per_zone`; all-held ⇒ zero rows written | — |
| Run lifecycle + status-guarded terminal writes | A | RUNNING → SUCCESS/PARTIAL/FAILED/ABORTED; every terminal write keyed on `status='RUNNING'` | — |
| Heartbeat | A | Beat at admission, per zone (after finalize), per patience iteration; 10-min staleness; reap ≤ retry-deadline invariant unit-pinned | False-positive reap of a slow-but-alive run possible |
| Reaper / zombie handling (#261) | A/B | Run-then-claims order; 3-min cron + pre-admission + in-patience | Reaps but **never re-dispatches** |
| Bounded retry (#260) | A | Two patience loops (pre-admission; CONTENDED promotion) under one run row; CRON patient, MANUAL never | — |
| **Crashed-zone re-dispatch** | **D** | `dispatch-scheduler.service.ts:122-125` declines the job explicitly; nothing else claims it | A 05:02 crash costs those zones their field day until a human or tomorrow's tick |
| Eligibility-MV freshness at run time | C | 04:30 refresh swallows its own failure (`plant-eligibility-refresh-scheduler.service.ts:91-93`); 05:00 run never checks; not in `configSnapshot` | Silent wrong-pool risk with zero signal |
| Per-SE dispatch transactions (#262) | A | One tx per SE: advisory lock, `SKIP LOCKED` claim, in-tx idempotency re-read, outbox row in-tx; failures itemised as `seSkips` | Recommender phase not transactional (by design) |
| Day-plan closure + recycling (#242/#178/#241) | A | 04:00 IST; PLAN_EXPIRED set-based; 7 protected classes; terminal closure across 7 call sites (docstring says six) | Cosmetic doc drift |
| Input-work predicate | C | #273's shared `assignableTickets` unifies the two *manual* paths; the engine keeps a third, wider inline spelling `recommender.service.ts:325-396` | Three spellings of "assignable" |
| Candidates & eligibility | A | DEDICATED/MULTI from `se_coverage`, FLOATING via MV joined live to `engineer_master` (#138); one readiness function, three callers (#274) | 2 of 5 hard filters honestly NOT_ENFORCED (Q5) |
| Scoring & selection (#266) | A | Score genuinely decides within the winning tier; 6-component closed vocabulary; trace provably matches the decision; pin crosses tiers deliberately; `seId` asc tie-break | Only per-candidate terms are distance + cluster; without geometry, ties fall to `seId` |
| Priority (#248 return-date, #268 CRITICAL direct) | A | Return-date key two-sided-gated below CRITICAL+; intraday direct-assign every 2 min, same filter/score discipline; no candidate ⇒ ESCALATION_REQUIRED + ZM notification, never overload | — |
| Capacity (#269, Q2) | A auto / C system | One payload (`committed-day-load.ts`), cross-zone; engine cannot over-assign (test-pinned) | Every manual door bypasses capacity — *by ruling*, but it silently shrinks the next automatic run's headroom |
| Holds / deferrals / return-date | A | One column (`deferred_until`), one predicate, four writers; #249 confirm+reason override with audit | Hold reason/approver live only in audit metadata |
| Sequencing / routing | B | `stop_sequence` + `sort_order` persisted and honoured end-to-end; **`orderPlantStops` is a documented identity-function seam** `batch-assignment.service.ts:308` | Ordered stops exist; a route does not — geography wires only into the score |
| Provenance & decision trace | C | Rich per-decision trace (chosen + capacity-at-decision + tier + tri-state filters + ≤5 runners-up); UNASSIGNABLE rows persisted with reasons | Runner-up cap 5 in precedence order; traces cascade-deleted on failure paths; human batches stamped `AUTO_ASSIGNED`; intraday system schedules stamped `ZM_MANUAL` |
| Intra-day mechanics | A / D reroute | Add/remove/reorder/swap/split with reasons; escalation manual-assign; VU lifecycle | Stop order overwritten in place (no plan-as-dispatched history); **no mid-day reroute** when an SE becomes unavailable — the timeout path was retired by #268 and replaced with nothing |
| Audit spine | A | `withAudit` same-transaction writes (pinned); `ticket_events` before/after stream; closed removal-reason vocabulary | Assignment *adds* are anonymous (no `added_by`); SLA pauses are an accumulator, not intervals |
| Replay substrate | B | `configSnapshot` frozen at admission (weights, thresholds, capacity map, tier overrides, cron); per-decision rows + traces; run/zone ledger with funnel counters | Input ticket set and dropped populations are counts, not rows (79% of open tickets on the dev mirror); coverage/availability/kit/bucket state not snapshotted; never-committed decisions deleted |
| Retention (#104) | E claim | `schema.prisma:923` documents a 90-day window; no purge job exists for traces / recommendations / audit_logs | Good for replay; the comment is false |

---

## D. Current scheduler UI — verified state

```
Dispatch (sidebar group, #281)                    Operations
├── Scheduler Preview   /schedules/preview        ├── Assign Work        /assign        ← manual M→N console (P9)
│     "What the next run would do"  FUTURE        ├── SE Planner         /engineers/planner  ← 5th tense, ungrouped
├── Schedules           /schedules                Admin (OH only)
│     "Today's committed day plans" PRESENT*      ├── Bulk Unassign      /bulk-unassign ← the ONLY "Run dispatch" button
├──── Intra-day Queue   /intraday   (indented)    └── Settings ?tab=dispatch  (cron)
│     "Changes to today's plan"                   Policy
└── Dispatch Runs       /dispatch-runs   PAST     └── SE Assignment Threshold
      └ /:runId → /zones/:zoneId → /batches/:batchId → DecisionTrace (expandable)
```

\*The "present" claim is false in code: `/schedules` has no date filter — it returns every live
schedule, mixing today with stale never-closed plans (`zm-schedule-query.service.ts:98-101`). [VF]

| Screen | Concept | APIs | Operator actions | Sharpest gaps |
|---|---|---|---|---|
| Scheduler Preview | Future projection (gate-less by Decision 1/18) | `GET /schedules/preview`, holds place/release | Date, hold, release, hold-anyway on VU conflict | Renders none of the per-decision why-layer it already fetches (score, candidates, capacity-at-decision); unassignable/withheld are counts + a sentence; `errors[]` silently dropped — a failed zone vanishes |
| Schedules | "Present" committed plans | `GET /schedules`, `/schedules/engineers` | None (monitoring); row → detail | Not date-scoped; no execution progress; no who/when for OVERRIDDEN |
| Schedule Detail | One SE's ordered day plan + the write path | `GET /schedules/:seId`, `POST /batches/:id/override` | Swap / split / reorder / remove / defer / reassign, reason-gated, immediate commit | One SE at a time; no ticket status; ticket ids plain text here (linked everywhere else); its writes invisible to the Intra-day Queue |
| Intra-day Queue | Changes-to-present ledger | `GET /intraday-updates`, `GET /intraday-insertions`, manual-assign modal | **Assign** on ESCALATION_REQUIRED (the one live-day action that works well) | Reads only `MANUAL_ZM_UPDATE`, which no admin code ever writes — UI-made overrides audit as `BATCH_OVERRIDE_*` and never appear; both queries unbounded by date; "SE Acceptance" column vestigial (#268) |
| Dispatch Runs / Run / Zone / Batch / Trace | Past ledger | `GET /dispatch-runs…`, `GET /batches/:id`, per-ticket trace | Read-only drill-down, search/filter/export | No polling (a RUNNING run never updates); manual-run reason not returned; `capacityUsed`, `seSkips[].seId`, `sortOrder/rank/score` in payloads, rendered nowhere; `contendedWithRunId` unlinked |
| Assign Work Console | Manual M→N write surface (P9 — deliberately separate per #280 R7) | #273–#276 endpoints | Draft lanes, distribute, review-diff, commit | Session-local draft (ruled); separately, the #272 visual grammar (chip dots, dashed-violet crossings, amber lanes, legend) is unimplemented |
| Bulk Unassign | Mid-day rebalance + **the only run trigger** | bulk-unassign preview/execute, `POST dispatch-run`, in-flight poll (10 s) | Unassign (token-confirmed), Run dispatch | OH-only route though the API allows CSM; result names no runId; two nav groups from the Preview it belongs beside |
| SE Planner | Future soft-bias input | planner CRUD | Place/remove plant intents | Not in the Dispatch group; never shows whether the run honoured an intent (`plannerPlanned` exists in traces) |

### Crew-Deck modes check [VF]

| Capability | Verdict |
|---|---|
| Unified "today" operational view | **Absent** — no route, page, or endpoint is scoped to the current operating day |
| Per-engineer lanes with sequenced stops | **Partial ~⅓** — sequence exists, rendered for one engineer at a time only |
| System-vs-human provenance | **Partial ~½** — schedule/batch badges yes; ticket-level nothing; override trail unsurfaced |
| Run-dispatch with preview | **Partial ~½** — trigger and projection on different pages in different nav groups, unlinked |
| Critical-escalation surfacing | **Exists** — ESCALATION_REQUIRED rows + assign modal + ZM notification |
| Unassignable / held / policy-withheld rails | **Partial ~½** — held: real rail; unassignable: full table for past runs only, count-only on Preview; withheld: count only, itemised nowhere |
| Changes-today ledger | **Partial ~⅓ and unreliable** — see the Intra-day Queue defect above |
| Replay of a past run | **Exists per ticket, absent per run** — DecisionTrace + frozen config panel are genuinely good |

---

## E. Backend gaps

### Missing (D)

1. **Crashed-zone re-dispatch.** The reaper frees claims and stops, deliberately
   (`dispatch-scheduler.service.ts:122-125`). Highest-impact operational gap.
2. **Mid-day reroute on SE unavailability.** The stated recovery mechanism (acceptance-timeout
   reroute) was retired by #268 and replaced with nothing.
3. **Changes-today query.** All ingredients exist (removal reasons, audit actions); no endpoint
   composes them; swaps are invisible to the only ledger read.
4. **Add-side assignment provenance.** `batch_assignment_tickets` records who removed a ticket
   and why — never who added it or why. Highest-value missing column pair
   (`added_by`, `add_reason`).
5. **Tier-crossing provenance on manual assigns.** The engine persists `tierEvaluated` +
   `coverageType` per decision; the human path persists neither.
6. **Per-ticket itemisation of policy-withheld / bucketless / component-blocked populations.**
   Counts only (`recommender.service.ts:401,420,438`); 5,127 of 6,464 tickets on the dev mirror
   unenumerable after the fact.
7. **#104 retention** — documented in the schema (`schema.prisma:923`), implemented nowhere.

### Incomplete (B)

- Runner-up trace capped at 5, taken in precedence order, not score order.
- Stop sequencing is priority order; `orderPlantStops` is a self-documented seam awaiting geometry.
- No escalation on repeated run failure — warnings only; nothing pages a human.
- No boot-time reap; recovery of restart-orphaned claims depends on the sweeps-enabled reaper cron.
- SLA pause is an accumulator; individual pause intervals unrecoverable (#271 fixed arithmetic,
  not auditability).

### Potentially incorrect (C)

- **Human-created batches stamped `AUTO_ASSIGNED`** (`override.service.ts:511,750`); the only
  reliable engine-discriminator is `run_id IS NOT NULL`.
- **Intraday system assignments stamped `ZM_MANUAL`** — the CRITICAL direct-assign path creates
  schedules via `ensureSchedule` with a manual source and no `run_id`.
- **MV staleness invisible to its consumer** (see C table).
- **Never-committed decisions and their traces deleted** by `clearFinalizedOrphans`
  (`recommender.service.ts:986-995`) + cascade (`schema.prisma:935`).
- Three spellings of the "assignable" predicate (engine vs shared manual predicate).
- `validateDispatchCron` accepts sub-daily expressions; each fire gets its own tick window,
  potentially stacking ~15 concurrent patient runs.
- `/schedules` read not date-scoped while every label above it promises "today".
- `removedSince` refuses to attribute cause on grounds #241 has since made false — stale comment,
  cheap win.

### Architectural

**None required.** Dead/stale hygiene items: `DispatchSummary.skipReason` (no writer),
`IntradayInsertion.retryChain` (no writer, described as live in the schema), injected-unused
`AuditService` in the intraday service, three stale "no writer yet" comments in
`removal-reason.ts`, a docstring citing a spec file that does not exist
(`removal-reason.e2e-spec.ts`), `tierCandidates` dead binding, `close-assignment.ts:11`
"six call sites" vs seven actual, `partition-maintenance` as the one `@Cron` without a
`timeZone` pin.

---

## F. UI gaps vs the Crew Deck concept

- **No cockpit.** One screen where a zone's whole day is visible and commandable has no
  counterpart; the four tense-pages answer the four questions separately, one record at a time.
- **No deck.** SE cards with capacity-as-shape, ordered stops, and exception states exist
  nowhere; the only stop-sequence render is single-engineer.
- **No provenance grammar.** Solid-vs-dashed system/human marking exists at no level of any
  dispatch surface; the same grammar was ruled non-negotiable for the Assign Console (#272) and
  is unimplemented there too (amber/crimson collisions, no legend, no chip dots).
- **Modes:** Plan exists as a separate page (Preview — genuinely good, gate-less by design).
  Live does not exist. Replay half-exists (excellent per-ticket DecisionTrace + frozen config;
  no run-level decision stream, though `recommendations.processing_rank` could order one today).
- **Run dispatch** on the wrong page (OH-only Bulk Unassign), disconnected from its projection,
  result unlinked to the run it created.
- **Rails:** held ✓ (Preview); unassignable — past runs only; policy-withheld — count only;
  changes-today — structurally broken.
- **Override flow:** understand ✓ (DecisionTrace), act ✓ (six override actions, reason-gated),
  but no *impact preview* between them — every override commits immediately; distribute-preview
  proves the projection pattern exists server-side.
- **Escalation strip:** data and action exist (Intra-day Queue) but not as an interception
  surface on any primary screen.

---

## G. Crew Deck feasibility matrix

| Crew Deck capability | Current UI | Backend | API/data | Gap type |
|---|---|---|---|---|
| Unified today view (deck of SE cards) | Absent | Data exists: live day plans + stops + load | No today-scoped, all-SEs-with-stops read | **API/data exposure** (+ UI) |
| Ordered stop chips per lane | Single-SE only | `stop_sequence`/`sort_order` persisted, honoured | Per-SE endpoint exists; needs batching | **UI-only** (+ trivial API) |
| Capacity as shape; overload state | Badges scattered | #269 one payload, cross-zone, test-pinned | `GET /schedules/engineers` already carries it | **UI-only** |
| System vs human provenance (solid/dashed + role·initials) | Absent at ticket level | Partially derivable (`run_id`, audit actors); adds anonymous; two mislabelling bugs; tier-crossing unpersisted | Not exposed | **Targeted backend** |
| Plan mode (next-run projection + holds) | Exists (Preview) | #250 dry-run projects the real recommender | Rich payload, under-rendered | **Already supported** — integration + render |
| Live mode (today + changes + escalations) | Fragmented, partly broken | All ingredients persisted | Changes-today + today-plan reads missing | **API/data exposure** + one backend query |
| Replay mode (what the run did, in its order, why) | Per-ticket only | `processing_rank` + traces + frozen config persist per run; dropped populations are counts; failed-run traces deleted | No run-level decision-stream read | **API exposure** now; **targeted backend** for full fidelity |
| Run dispatch action beside its projection | Misplaced | `POST dispatch-run` + in-flight, correct 409s | Exists | **UI-only** |
| Critical interception strip | Row in a queue page | Q-B escalation live: ESCALATION_REQUIRED + notification | Exists (insertions + available-ses + manual-assign) | **UI-only** |
| Unassignable rail with reasons | Past runs only | UNASSIGNABLE rows + NO_COVERAGE/ALL_DROPPED persisted per run | Exposed for past runs; today = latest run's rows | **API/data exposure** |
| Held rail with return dates + approver | Preview shows holds | Deferral column + VU reports (immutable `proposed_from`); approver only in audit metadata | Mostly exists | **Already supported** (approver: minor exposure) |
| Policy-withheld rail | Count only | Never itemised — count queries only | — | **Targeted backend** |
| Changes-today ledger (adds · removes · swaps) | Broken | Renderable via a three-way UNION today; clean with `added_by` | No endpoint | **Targeted backend** |
| Override flow with impact preview | Immediate-commit actions | Projection pattern proven (distribute-preview writes nothing) | No override-impact endpoint | **Targeted backend** (small) + UI |
| RET return-date chips | Absent | `returnDueToday` derived per run; VU reports queryable live | Not exposed on plan reads | **API/data exposure** |
| On-leave / availability card states | Absent | `se_availability` windows, reconstructable | Not exposed on plan reads | **API/data exposure** |
| Zone Map overlay (concept D) | — | Design itself defers it; home-base optional data, no map stack | — | Out of scope, per the design's own note |

Nothing in the matrix requires an architectural change. [SE]

---

## H. End-to-end architecture map (as implemented)

```
TRIGGER      @Cron 05:00 IST 'business-dispatch' ─┬─ DispatchSchedulerService.dispatchTick
             POST /schedules/dispatch-run (OH,CSM)─┘   gate: BUSINESS_SWEEPS_ENABLED
                 │  cron_tick_claims — INSERT-is-the-test, per (job, minute)          [#263]
LIFECYCLE    DispatchRunService.runForActiveZones → istDate · future-day guard · reap
                 │  admit(): dispatch_runs(RUNNING, heartbeat, configSnapshot)
                 │           dispatch_run_zones ON CONFLICT DO NOTHING ← one RUNNING/zone [#259]
                 │           losers → CONTENDED;  all-held → zero rows, 409
PRE-CHECK    (only) future-day · reap · admission  —  MV freshness NOT checked          [gap]
RETRY        CRON: pre-admission wait + waitOutContention, ≤15 min, same run row       [#260]
REAPER       */3 min: stale heartbeat (10 min) → run ABORTED, claims ERROR — no re-dispatch [#261]
PLANNING     RecommenderService.runForZone   (per zone)
                 work: OPEN·UNASSIGNED·TROUBLESHOOT·¬component·¬deferred·age≥threshold
                 candidates: se_coverage → MV(+live re-validate)      [tiers, #138]
                 hard filters (5; 2 NOT_ENFORCED) → chooseWithinTier (pin→score→seId)  [#266]
                 canonicalSort: tier ▸ bucket ▸ returnDueToday ▸ rank ▸ oldest ▸ id    [#248]
                 CRITICAL w/o capacity-eligible SE → ESCALATION_REQUIRED, never overload [Q-B]
PERSIST      recommendations(SUGGESTED|UNASSIGNABLE) + dispatch_decision_traces (≤5 runners-up)
DISPATCH     BatchAssignmentService.dispatchForZone → ONE TX PER SE                    [#262]
                 advisory lock · SKIP LOCKED claim · idempotency re-read
                 work_schedules (append) · plant_batch_assignments(stop_sequence)
                 batch_assignment_tickets(sort_order) · ticket→FORMALLY_ASSIGNED
                 outbox row in-tx [#264] · recommendations→DISPATCHED
FINALIZE     zone→DONE/ERROR (+seSkips) · heartbeat/zone · run→SUCCESS/PARTIAL/FAILED
                 all terminal writes guarded WHERE status='RUNNING'
INTRA-DAY    */2 min CRITICAL direct-assign [#268/Q3] · batch overrides (reason-gated)
                 bulk-unassign (token) · holds · VU lifecycle — no reroute on SE loss  [gap]
CLOSURE      04:00 IST: PLAN_EXPIRED recycling [#242] · terminal closure ×7 paths [#178]
             04:30 IST: MV refresh (failure swallowed) — 05:00 next run
AUDIT/REPLAY audit_logs (same-tx) · ticket_events · removal_reason vocabulary [#241]
             configSnapshot + traces = per-ticket replay;  run-level replay: partial
```

---

## I. Drift from the original Aug 19–20 intent

| Original decision / intent | Current implementation | Drift | Why it occurred | Severity |
|---|---|---|---|---|
| Today's Dispatch / Crew Deck as the scheduler's operator surface (designed Aug 20, artifact-only) | Four tense-pages + cross-links (#281) | Concept never implemented | Design never committed; #280 recorded "no wireframe exists" and scoped #281 to navigation only | **High** |
| Provenance grammar — "a human decision never looks like a system one" (both boards, Aug 20) | No solid/dashed grammar anywhere; two provenance-mislabelling bugs; adds anonymous; tier-crossing unpersisted | Grammar lost end-to-end | Carried only by the lost board + #272's grammar table; #272's implementation also skipped it (no violet token, amber/crimson collisions) | **High** |
| #258 Q8 operational model | Implemented as ruled, DB-side, test-pinned | None | — | — |
| G5 "crash recovery: no permanent RUNNING state" | True as stated — but recovery ends at reaping; the day plan itself is not recovered | Letter kept, spirit partial | Reaper deliberately refuses to dispatch; no issue owns re-dispatch | **High** |
| #247 AC2 (sweep as single SLA resumer, Aug 19) | Re-ruled next day by Q7; implemented per Q7 (#271) | Legitimate, recorded change | Operator re-ruling | None |
| #251 "Schedules = today's committed day plans" framing | Read is status-scoped, not date-scoped; stale plans mingle | Label vs query mismatch | Incremental page evolution; never pinned | Medium |
| Intra-day Queue as the changes-to-present record (#280 R9) | Reads an audit action no UI path writes; UI overrides invisible; unbounded history | Ledger structurally broken | #268 retired the offer machinery; override writes moved to `BATCH_OVERRIDE_*`; the read was never re-pointed | **High** |
| Run trigger as a first-class operator action (Crew Deck header) | One button on OH-only Bulk Unassign, unlinked to Preview or the resulting run | Buried | Shipped where first needed (#179); never relocated | Medium |
| Aug-19 audits as evidentiary base | Still uncommitted (#280 Q4 open); invisible to sessions for 5 days | Evidence outside the repo | Session artifacts never landed in git | Medium |
| Aug-19 operator brief (Decisions 1–18) | Lost; quoted second-hand by section number | Authority document missing | Never committed | Medium |

**The "no scheduler UI design exists" assumption and its downstream decisions.** Because #280
believed no wireframe existed, it (R8) rejected any shared switcher or unified surface as "new
page behaviour, not navigation", ruled cross-links per record instead, (R9) demoted Intra-day to
an indented row, and #281 shipped exactly that. All of #281's work remains valid — grouping,
hints, cross-links, dead-end fixes are what the Crew Deck needs *underneath* it — but the
decision to stop at navigation was made on a false factual premise, and it is the single act that
turned a lost file into a lost product concept. [VF]

---

## J. Recommended target architecture (operator experience)

### Primary operational cockpit — Today's Dispatch (Crew Deck)

One route (e.g. `/dispatch/today`), zone-scoped, three modes mapping to existing machinery:

- **Plan** — the #250/#251 projection embedded (next run, holds as the one pre-run lever, bucket
  watermark), with the **Run dispatch** action and in-flight state in the header.
- **Live** — the deck: one card per SE (name, tier, load-as-shape from #269, ordered stop chips
  from `stop_sequence`, availability state), the critical-interception strip fed by
  ESCALATION_REQUIRED, and the work rail (unassignable with reasons, held with return dates,
  withheld count→list, changes today).
- **Replay** — a past run rendered in the same deck layout, backed by the run ledger, per-ticket
  DecisionTrace as the embedded inspector (the design's own "Concept C survives as the inspector"
  note), and the frozen ConfigInEffect panel.

Provenance grammar everywhere: solid = system (`run_id` set), dashed + role·initials = human
(audit actor), crimson = critical direct-assigned, RET = return-date, ghost = not on a route —
after the provenance fixes in K.

### Supporting / detail views

- Schedule Detail (per-SE day plan + overrides) — kept, reached from a card; gains an
  impact-preview step.
- DecisionTrace — kept as-is; the best screen in the current product.
- **Assign Work Console — kept, separate.** #280 R7 is right: `/assign` is the human write
  surface, the Crew Deck is the engine's face. Its #272 grammar debt is a separate work item.
- SE Planner — kept, cross-linked (surface `plannerPlanned` honour-rate from traces).

### Administrative / configuration

Dispatch cron, assignment threshold, weights, eligibility mode, Bulk Unassign (loses the run
trigger to the cockpit, keeps the rebalance flow).

### Historical / audit / replay

Dispatch Runs ledger + Run/Zone/Batch drill-down — kept as the archival spine under the cockpit's
Replay mode; render the already-returned fields (capacityUsed, seSkips identities,
sortOrder/rank/score), link `contendedWithRunId`, add polling for RUNNING.

This deliberately does not preserve the current sidebar as-is: the four tense-rows collapse into
the cockpit + the historical ledger, which is what the Aug-19 IA audit's F6 was asking for before
the concept was lost.

---

## K. Minimum sensible implementation plan

Ordered so every tier stands alone. Reuse is the rule: the recommender, run machinery, traces,
#269 payload, #274 candidates and the preview seam are **not** rebuilt anywhere below.

### 1 · UI-only (no server change)

| Change | Why / reuse | Risk · priority |
|---|---|---|
| Deck shell: SE-card grid for a zone, composed from `GET /schedules` + `/schedules/:seId` + `/schedules/engineers` | Lanes, stops, load all served today; N+1 acceptable at zone scale until tier 2 lands | Low · **P1** |
| Relocate **Run dispatch** + in-flight poll beside the Preview; link the result to its run | Endpoint allows CSM already; pure recomposition | Low · **P1** |
| Critical interception strip from ESCALATION_REQUIRED rows + existing assign modal | Whole flow exists on `/intraday` | Low · **P1** |
| Render withheld payload: Preview's decisions/errors layer, `capacityUsed`, `seSkips[].seId`, `sortOrder/rank/score`; fix remaining dead ends; poll RUNNING runs | Fields already cross the wire | Low · P2 |
| Provenance badges v1 from existing signals (`run_id`, OVERRIDDEN status, audit actor) | Honest partial grammar until tier 3 | Low · P2 |
| #272 visual-grammar debt on `/assign` (violet token, chip grammar, legend, amber lane) | Approved design, in-repo, unbuilt | Low · P3 |

### 2 · API / data exposure (read-only additions)

| Change | Why / reuse | Risk · priority |
|---|---|---|
| `GET /dispatch/today` — zone's operating-day view: per-SE plans with stops + ticket status, situation counters, latest run identity | One query family over existing tables; removes the deck's N+1 and the date-scoping ambiguity | Low · **P1** |
| `GET /dispatch/changes-today` — the UNION over removal reasons + audit actions (adds · removes · swaps), IST-day-bounded, zone-clamped | The forensic query is already written; fixes the broken ledger read without schema change | Low · **P1** |
| Expose current-run unassignable rows + held (with VU dates/approver) + RET + availability states on the today read | All persisted or trivially derivable | Low · P2 |
| Run-level decision stream for Replay: recommendations + traces ordered by `processing_rank` | Data persists per run today | Low · P2 |
| Date filter on `/schedules` (or default today + explicit all) | Makes the page's own label true | Low · P2 |

### 3 · Backend logic

| Change | Why | Risk · priority |
|---|---|---|
| Fix the two provenance stamps: human batches ≠ `AUTO_ASSIGNED`; intraday system schedules ≠ `ZM_MANUAL` | Two-line-scale bugs blocking the honest grammar | Low · **P1** |
| Add `added_by` / `add_reason` / `add_source` to `batch_assignment_tickets`; stamp all writers | Turns changes-today into a single-table query and completes both-sided attribution | Medium (migration + ~8 writers) · **P1** |
| Persist tier-crossing/coverage on manual assigns | Dashed-violet exists or the grammar lies | Low · P2 |
| Crashed-zone re-dispatch policy (bounded; e.g. reaper marks REDISPATCH_NEEDED; next tick or an operator action within a window collects it) — **needs an operator ruling first; touches G1** | Highest-impact operational gap | Medium · **P1 (HITL)** |
| MV freshness: record refresh outcome, stamp into `configSnapshot`, warn on the run | Silent wrong-pool risk | Low · P2 |
| Repoint Intra-day read to include `BATCH_OVERRIDE_*`; date-bound both queries | Or the ledger keeps lying | Low · P2 |
| Itemise withheld/bucketless/component-blocked populations (rows or a live equivalent read) | The rail, and honest replay of 79% of the pool | Medium · P3 |
| Stop deleting failed-run traces (retire instead of delete); reject sub-daily cron; escalate repeated zone failure; stale-comment sweep | Evidence preservation + hygiene | Low · P3 |
| Override impact-preview endpoint (dry projection of one move — capacity both lanes, rank context, conflicts) | The design's step 3; distribute-preview proves the pattern | Medium · P3 |

### 4 · Architectural

**Nothing.** Genuinely-architectural candidates (event-sourced assignment stream, full input
snapshotting for perfect replay, route optimisation in `orderPlantStops`, live GPS) are each
deferrable; the last two are explicitly Phase-2 / ruled out by Q6 and the design's own Zone-Map
note.

### Process prerequisites (before any code)

1. Commit the recovered Crew Deck design into `docs/ui/desktop/approved-designs/` and put it
   before the operator for formal approval (its in-artifact status is "recommended", not
   "ruled").
2. Amend #280 with a correction note (its factual premise was wrong; its rulings R1–R10 mostly
   survive), and file the implementing issues in INDEX.md.
3. Commit the two Aug-19 audits (#280 Q4) — same failure class, same fix.

---

## L. Final answer

**Keep the engine; give it its face; fix five named seams.** The scheduler backend is the Aug-20
ratified model, implemented and proven — nothing about planning, admission, dispatch, closure,
capacity, tiers, scoring or escalation needs rebuilding. To match the Aug 19–20 product concept:

1. Commit and ratify the recovered Crew Deck design, correcting #280's false premise.
2. Build the Today's Dispatch cockpit — Plan / Live / Replay — as a composition of the existing
   Preview, day-plan, escalation, trace and run-ledger machinery.
3. Add the thin read layer it needs (today-scoped plans, changes-today, run-level decision
   stream).
4. Repair provenance so the grammar can be honest (two stamping bugs, add-side attribution,
   tier-crossing record).
5. Close the two backend gaps that exist regardless of UI — crashed-zone re-dispatch (operator
   ruling required) and MV-freshness visibility.

Everything else in the current dispatch UI — the ledger drill-down, DecisionTrace, the Assign
Console, #281's cross-links — is kept, because it is exactly the supporting tissue the Crew Deck
was designed to sit on.
