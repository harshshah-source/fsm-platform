# 282 — DECISION RECORD: Today's Dispatch / Crew Deck is the approved scheduler cockpit, and two operational rulings

Status: **APPROVED 2026-08-25** (operator). This file is the authoritative record; implementing
issues are #283–#290.
Type: HITL · Decision · Backend + Admin
Design: [`docs/ui/desktop/approved-designs/todays-dispatch-crew-deck.html`](../../../docs/ui/desktop/approved-designs/todays-dispatch-crew-deck.html)
(in-repo, authoritative — recovered 2026-08-25 from the 2026-08-20 working artifact
`2d66798b-daa4-463f-9db0-351d8ce1195b`, "Today's Dispatch — Scheduler UI")
Evidence: [`audit/scheduler-engine-forensics-2026-08-25.md`](../../../audit/scheduler-engine-forensics-2026-08-25.md)
(the full forensic investigation this record acts on)

**Nothing in this file is speculative. These are final approved decisions.** Do not reopen unless
code reveals a direct contradiction that makes the approved behaviour impossible without a new
business decision. Do not redesign the cockpit; build it.

## What was approved

### R1 — The Crew Deck is the approved UI direction for the scheduler engine's operator surface

One zone-scoped cockpit — **Today's Dispatch** — at `/dispatch/today`, with three modes over the
same layout:

- **Plan** — the next run's projection (the existing #250/#251 preview, embedded, not rebuilt),
  holds as the only pre-run lever, and the **Run dispatch** action (`POST /schedules/dispatch-run`,
  relocated — not a new trigger) with in-flight state and a link to the resulting run.
- **Live** — the engineer deck (one card per SE: tier, load/capacity, ordered stop chips from the
  persisted `stop_sequence`/`sort_order`, availability state), the critical interception strip
  (ESCALATION_REQUIRED surfaced first-class), and the work rail: unassignable (itemised, with
  reasons), held/deferred (return date + approver), policy-withheld, changes today.
- **Replay** — a past run in the same deck layout over the run ledger, with the run-level decision
  stream (ordered by `processing_rank`) and the existing per-ticket DecisionTrace as the embedded
  inspector, plus the frozen ConfigInEffect panel.

The design is **ordinal — no fake clock**: sequenced stops, no times, no ETA (#258 Q6 inherited).
The four current dispatch pages become supporting/historical surfaces under the cockpit; nothing
is deleted, but they stop being the primary mental model. `/assign` stays separate (#280 R7 stands).

### R2 — The provenance grammar is binding, and may only render what the data truthfully supports

Solid + dot = system decision · dashed + role·initials = human override · heavy crimson = critical
direct-assigned · `RET` = return-date priority · ghost = not on a route. **A human decision never
looks like a system one.** Where backend provenance is incomplete, the backend is corrected first
(#283); the UI never fakes provenance with display-only labels. Shared with #272's grammar — the
two boards read as one product.

### R3 — RULED 2026-08-25 (operator): crashed-zone re-dispatch is same-day, bounded, automatic

When the reaper aborts a stale run, the reaped zones are marked as needing re-dispatch and a
bounded same-day follow-up collects them **through the normal admission path** — zone claims,
tick claims, per-SE transactions, idempotency guards all unchanged. Manual `POST dispatch-run`
stays available and unchanged. The mechanism must preserve #258 Q8/G1–G8 in full: effectively-once
dispatch, zone isolation, blast radius ≤ one SE, no permanent RUNNING state. Implementing issue:
#286. (This closes the forensic report's highest-impact gap: previously a mid-run crash cost the
zone its field day — the reaper freed the claim and nothing re-dispatched until 05:00 tomorrow.)

### R4 — RULED 2026-08-25 (operator): mid-day SE unavailability is escalate-only

An SE becoming unavailable **after** dispatch (approved leave / availability window covering the
operating day) raises escalation entries for their remaining live work through the existing
ESCALATION_REQUIRED + manual-assign path. A human redistributes; **nothing moves automatically.**
No automatic re-planning, no capacity bypass. Implementing issue: #288. (Context: the old
accept/decline-timeout reroute was retired by #268 and never replaced; since then nothing at all
happened.)

### R5 — Reuse first; no duplicate scheduler logic anywhere

The run machinery, tick claims, admission, heartbeat/reaper, bounded retry, recommender,
candidate/eligibility, scoring, capacity (#269), dispatch transactions (#262), decision traces,
Scheduler Preview (#250/#251), day-plan queries, escalation/manual-assign path, Dispatch Runs
ledger, DecisionTrace, Assign Work Console (P9), and #281's navigation work are all **reused
unchanged** except where an implementing issue names a specific correction. No business rule moves
into React to make the cockpit work; the cockpit gets a thin read layer (#284) instead.

### R6 — No placeholder / no fake data

No hard-coded counters, invented ticket states, fabricated provenance, simulated API results, or
fake times. If data is unavailable, either the smallest honest backend/API exposure is added, or
the element is explicitly marked pending.

## Correction to #280 (recorded here, cross-noted there)

#280's factual premise — *"No wireframe exists for this screen set"* — was **wrong**. The wireframe
existed since 2026-08-20 in a working artifact outside the repo and was lost between sessions;
#272:64's "dispatch-board grammar … the two boards read as one product" is its one surviving
in-repo trace. Consequences:

- #280's **problem statement (F6) and rulings R1–R7, R9, R10 stand** — grouping, cross-linking,
  the tense model, the Run→Zone→Batch chain fix, and R7's assign/timeline separation are all
  *what the Crew Deck sits on* and are not reopened.
- #280 **R8** ("cross-links only, no unified surface — no approved design is required") was ruled
  on the false premise. It is **superseded by this record's R1**: an approved design now exists,
  and the unified cockpit is the approved direction. #281's cross-links remain valid supporting
  tissue.
- #280 **Q4** (commit the source audits) is closed by this record: both 2026-08-19 audits are
  committed alongside it.

## Constraints inherited

From **#258**: the whole P8 ruling set, verbatim — especially Q2 (capacity is not authorization),
Q3 (CRITICAL direct-assigned), Q6 (no live GPS / no ETA), Q8 + G1–G8 (the concurrency model, which
#286 must not weaken). From **#272**: R7's no-map/no-ETA and the shared visual grammar. From the
repo: the RBAC ladder — the cockpit must not widen any role's reach; `POST dispatch-run` stays
OH + CSM.

## Implementing issues (P11 — build order and prereqs in INDEX.md)

| # | Owns |
|---|---|
| #283 | Backend provenance seams: human batches not `AUTO_ASSIGNED`; intraday system schedules not `ZM_MANUAL`; `added_by`/`add_reason`/`add_source` on `batch_assignment_tickets` (all writers); tier-crossing/coverage persisted on manual assigns |
| #284 | Thin read layer: `GET /dispatch/today`, `GET /dispatch/changes-today`, run-level decision stream for Replay; date filter on `/schedules` |
| #285 | The Today's Dispatch cockpit (Plan / Live / Replay) + Run-dispatch relocation + nav restructure |
| #286 | Crashed-zone same-day bounded re-dispatch (R3) |
| #287 | MV freshness: record refresh outcome, stamp into `config_snapshot`, warn on the run |
| #288 | Escalate-only mid-day reroute (R4) |
| #289 | Override impact preview (inspect → understand → override → preview → confirm; `distribute-preview` is the precedent; preview never mutates) |
| #290 | #272 visual-grammar debt on `/assign` (violet token, chip grammar, legend, amber lane) |

## Open, and deliberately not ruled here

1. **Route optimisation in `orderPlantStops`** — stays the documented identity seam; Phase-2
   geometry work, not licensed by this record.
2. **Full-input replay snapshotting** — the persisted trace/config level is accepted for v1;
   #283/#284 improve fidelity at the edges (stop deleting failed-run traces is in #286's scope
   note), but "re-run last Tuesday byte-for-byte" is not a v1 goal.
3. **Zone Map overlay (concept D)** — deferred per the design's own note until SE home-base and
   plant-geometry coverage are real.
