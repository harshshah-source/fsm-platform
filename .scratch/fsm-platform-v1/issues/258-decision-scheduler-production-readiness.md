# 258 — DECISION RECORD: scheduler production-readiness ruling set (Q1–Q8)

Status: **RULED 2026-08-20** (operator). This file is the authoritative record; implementing issues
are #259–#271. Remaining: record the rulings in `CONTEXT.md` (same follow-through as #198/#199).
Type: HITL · Decision · Backend + Admin + Mobile

**Nothing in this file is speculative. These are final approved business decisions.** Do not reopen
unless code reveals a direct contradiction that makes the approved behaviour impossible without a
new business decision.

## The rulings

- **Q1 — Scoring is a real selection factor WITHIN a coverage tier.** Precedence DEDICATED →
  MULTI_PLANT → FLOATING stays authoritative; a FLOATING SE can never out-score an eligible
  DEDICATED SE. Within the winning tier, the highest-scoring filter-passer wins. Score never
  replaces canonical ticket ordering. Scores must be computed for the candidates that the decision
  actually weighs, and the persisted breakdown must reflect the real factors. → #266
- **Q2 — `daily_capacity` is an automatic-planning constraint, not an authorization boundary.**
  The recommender/system paths respect it; already-authorized manual paths may exceed it with **no
  block and no forced confirm** — but overload must be visible, never silent. Existing RBAC/zone
  scope stays authoritative. → #268 (system side), #269 (visibility)
- **Q3 — CRITICAL work is directly assigned, never offered.** No PENDING_ACCEPTANCE, no 10-minute
  window, no accept/decline, no acceptance-driven retry/escalation on the critical path. → #268
- **Q4 — Phase 1 eligibility = the ACTIVE/DEPLOYED proxy.** SAP PGI is Phase 2; the proxy's
  limitation is documented, not hidden and not presented as PGI-equivalent. → #270 (doc AC), #116 stays Phase 2
- **Q5 — VEHICLE_ON_TRIP and COMPONENT_UNAVAILABLE stay non-blocking in Phase 1**, but
  transparency must distinguish evaluated-passed / evaluated-failed / **not-enforced**. → #270
- **Q6 — Distance uses an admin-managed SE home/base in Phase 1** (home → stop → stop chain over
  existing plant coordinates). No live GPS in Phase 1. → #267
- **Q7 — SLA resume depends on TICKET outcome, not on VU-report resolution.** Successful
  troubleshooting → ticket terminal, no SLA restart. Ticket still active when the VU condition ends
  → pause ends, SLA resumes. This re-rules #247 AC2's single-automatic-resumer invariant. → #271
- **Q8 — Database-coordinated, zone-partitioned scheduling monolith.** PostgreSQL is the
  concurrency coordinator; no Redis/BullMQ/separate scheduler service/leader election. Zone is the
  admission unit (#259), the 05:00 run gets bounded patience instead of skip-until-tomorrow (#260),
  crash recovery is heartbeat+reaper+conditional-finish (#261), dispatch writes are per-SE
  transactions (#262), duplicate-instance safety is DB tick claims (#263), manual and automatic
  runs share one implementation differing only in metadata/scope/acquisition (already true — protect).
- **Q-A (ruled 2026-08-20, second pass) — the Plant Cluster Multiplier becomes a CANDIDATE-SPECIFIC
  scoring factor.** Filed because the pre-implementation review proved the multiplier could not
  influence selection even under Q1: it is computed per ticket-plant, so every candidate for a given
  ticket receives the identical factor and it cancels out of any within-tier comparison. The ruling:
  an SE who already has a relevant clustered stop receives the benefit; an SE who does not, does not.
  The clustering signal is derived from existing route/schedule data (see #266). Never a hard filter,
  never able to override coverage precedence, and the breakdown must show the candidate-specific
  contribution. → #266
- **Q-B (ruled 2026-08-20, second pass) — CRITICAL with no capacity-eligible SE escalates; the
  scheduler never self-authorises an overload.** Filed because Q2 ("automatic respects capacity") and
  Q3 ("CRITICAL is directly assigned") did not, together, say what happens when every eligible SE is
  at capacity. The ruling: escalate to the appropriate ZM / authorized manager, who may then assign
  manually and may exceed capacity under Q2. **No automatic CRITICAL-only capacity bypass.** The
  escalation path must be explicit and operationally visible. → #268

## Required guarantees (verbatim adopted)

G1 effectively-once dispatch · G2 zone independence · G3 blast radius ≤ one SE · G4 human
responsiveness with clean 4xx losers · G5 crash recovery, no permanent RUNNING · G6
misconfiguration safety across instances · G7 auditable outcomes · G8 one execution path.

## Confirmed-as-already-correct (verified against code 2026-08-20, no new work)

- **Special (#244)**: shipped derivation matches the approved model exactly — threshold
  `special_ticket_attempt_threshold` default 3 ladder 2–10; window = one `batch_assignment_tickets`
  row; reached = mobile-posted `soft_states` VIEWED inside the window; countable = reached ∧
  unsubmitted ∧ ended `PLAN_EXPIRED`/`VEHICLE_UNAVAILABLE` (human withdraw/defer and AUTO_RECOVERY
  excluded by default-exclusion; REORDER writes no row; SWAP_SE continues one window).
- **Return-date model (#245–#249)**: `proposedFrom` immutable + `expectedFrom` authoritative +
  decision columns + override reason (schema.prisma:2297-2333); one-OPEN-per-ticket partial unique
  (`20260819130100_vu_approval_lifecycle:71`); no horizon cap, no deferral-count cap anywhere;
  same-day return creates no `deferredUntil`; #248 priority key sits below CRITICAL/HIGH_CRITICAL in
  canonical sort; #249 confirm+reason override with no silent bypass. Preserved as-is.
- **Cleanup (#243)**: C1/C2/C3 scope ratified (Part 10); still HITL-gated, **not executed**, counts
  to be re-measured at execution time; runs after #242 (already enabled) and after #241 (landed).

## UI surfaces

n/a (decision record).

## Blocked by

Nothing. #259–#271 implement it.
