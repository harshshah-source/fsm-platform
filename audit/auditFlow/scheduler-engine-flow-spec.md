# FSM Scheduler Engine — Verified Flow Specification

**Purpose:** a complete, code-verified description of the scheduler engine, written as an
image-generation prompt. Paste sections 1–3 into ChatGPT (or any image model) to produce a
corrected version of `fsm_engine_FLOW.png`.

**Verified against:** `apps/backend/src/{ingestion,scheduling,recommender,intraday,ticketing,device-state,cross-zone}`
and `prisma/schema.prisma` on branch `feat/autoplant-integration`, 2026-08-25.

> **Note on image models.** No current image generator renders 150+ distinct text labels
> accurately — expect garbled words in the dense boxes. Two ways to handle it:
> **(a)** generate the poster in 3 passes (one band at a time) and compose them, or
> **(b)** use this spec as the content source for a real diagramming tool, where the text stays
> correct. The art direction in §1 is written for a single-pass attempt.

---

## 1 · ART DIRECTION (the prompt preamble)

```
Create a large, professional single-page technical infographic poster — a landscape
"system flow diagram" of the kind an engineering team presents to management.

CANVAS: landscape, 3:2 ratio, high resolution. White background.

STYLE: clean corporate infographic. Flat vector illustration, no gradients, no 3D,
no photorealism, no drop shadows beyond a faint card lift. Thin 1px rounded-rectangle
cards on a white ground. Generous white space between groups.

PALETTE:
  - deep navy #1B3A6B for the title bar, structural rules and primary text
  - one accent per stage group, used only as the card's header colour and left edge:
      teal #0E7C86 (ingestion), amber #C2762A (dispatch), indigo #3B4A9E (live day),
      slate #4A5568 (downstream)
  - semantic colour used ONLY for meaning, never decoration:
      green #1C6B49 = verified/safe, amber #8F5D0C = not enforced, red #A32B27 = known gap
  - neutral grey #5A6472 for secondary label text

TYPOGRAPHY: a clean geometric sans throughout. Stage titles in bold uppercase.
Box titles in semibold sentence case. Detail lines in regular, small. Table and
database names in a monospace face. All text must be crisp, horizontal and legible —
no decorative or handwritten lettering.

ICONS: simple flat line icons, one per box maximum — database cylinder, satellite,
truck, clipboard, gear, clock, lock, engineer figure, mobile phone, chart.
No emoji, no clip-art, no mascots.

STRUCTURE: a title bar across the top, three horizontal swim-lane bands stacked in
the main body, a full-width database bar between band 1 and band 2, a right-hand
column for downstream consumers, small reference panels in the top-right corner,
and four summary panels across the bottom.

Arrows flow left-to-right within each band. Vertical arrows connect the bands to the
central database bar. Every arrow is labelled.
```

---

## 2 · LAYOUT MAP

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  TITLE BAR                                    │ LEGEND │ PRINCIPLES │ SWITCHES │
├───────────────────────────────────────────────────────────────────────────────┤
│ BAND A — INGESTION PIPELINE  · every 30 min                                   │
│   [1 Data Collection] → [2 Snapshot & #230 Gate ◆] → [3 State, Recovery,      │
│                                                        Ticket Creation]        │
├───────────────────────────────────────────────────────────────────────────────┤
│ ════════════ POSTGRES — the only surface the three engines share ════════════ │
├───────────────────────────────────────────────────────────────────────────────┤
│ BAND B — DISPATCH ENGINE · 05:00 IST daily          │  BAND D —              │
│   [4 Run Admission ◆] → [5 Recommender A–F] →       │  DOWNSTREAM            │
│                          [6 Per-SE Write] → [6b Finalize] │  CONSUMPTION      │
├──────────────────────────────────────────────────────┤  (right column,       │
│ BAND C — THE LIVE DAY · every 2 min → daily          │   spans bands B & C)  │
│   [7 Intra-day Operations] → [8 Closure & Recycling] │                        │
├───────────────────────────────────────────────────────────────────────────────┤
│ KEY SAFEGUARDS │ KNOWN GAPS │ AUDIT & OBSERVABILITY │ END-TO-END OUTCOME      │
└───────────────────────────────────────────────────────────────────────────────┘
```

**The single most important structural rule:** bands A, B and C are three *independent* cron
families. They never call each other. Draw **no arrow from band A directly into band B** — the
only connection is each band's vertical arrow into the shared Postgres bar. This is the fact the
previous poster got wrong.

---

## 3 · EXACT TEXT CONTENT

### 3.0 Title bar

- **Title:** `FSM SCHEDULER ENGINE — COMPLETE FLOW`
- **Subtitle:** `From a silent GPS device to an engineer's committed day plan`

---

### 3.1 BAND A — INGESTION PIPELINE

**Band header:** `INGESTION PIPELINE · every 30 minutes · switch: INGESTION_SCHEDULER_ENABLED (default OFF)`

#### Stage 1 · DATA COLLECTION
*Read the fleet from AutoPlant*

- `AutoPlant` — external MySQL, VPN-gated
- `ap_widgets.tb_vehiclemaster` — telemetry: last GPS timestamp, lat/lng, speed, ignition
- `mst_vehicle` / `mst_plant` — vehicle and plant masters
- `mst_company` / `mst_transporter` — org graph, separate daily sync at 02:00
- Chunked read, max 90 rows per query

**Output:** `raw_device_snapshots` — append-only, one run per pass

#### Stage 2 · SNAPSHOT GATE  ◆
*Refuse to act on evidence this pass did not read*

- Snapshot run finalizes **SUCCESS** or **PARTIAL**
- **DECISION (diamond): Did the read cover the fleet?**
  - **NO** → skip stage 3 entirely. Log loudly. Write nothing. *(the #230 gate)*
  - **YES** → continue
- Incident note box: *"A snapshot once aborted after 2,610 of 27,032 devices. The pipeline aged
  the 24,422 it never read into 'inactive' and opened 3,439 false failure cycles. This gate is
  why that cannot happen again."*

#### Stage 3 · STATE, RECOVERY & TICKET CREATION
*Turn measured silence into actionable work*

- **Device-state recompute** — inactivity hours, SLA bucket, inactive flag, uptime eligibility
- **Auto-recovery pre-check** — a device now silent for *less* than the threshold, holding an open
  ticket, has healed itself → close as `CLOSED_AUTO_RECOVERY`, kept distinct from an
  engineer-repaired close so productivity reports stay honest
- **Ticket creation** — devices silent at or past the configurable assignment threshold, with no
  open failure cycle, on an active plant, not departed from the fleet
- **Repeat detection** — a prior VERIFIED cycle closed within 24 hours makes this a `REPEAT`
- **One transaction** — failure cycle + ticket + lifecycle event, stamped with the company's
  *effective* tier including any active zone override

**Output:** tickets sitting `OPEN` · `UNASSIGNED` in Postgres

---

### 3.2 SHARED DATABASE BAR (full width, between bands A and B)

**Header:** `POSTGRES — the only surface the three engines share`

**Table strip (monospace):**
`device_states · tickets · failure_cycles · recommendations · work_schedules · plant_batch_assignments · batch_assignment_tickets · dispatch_runs · dispatch_run_zones · dispatch_decision_traces · cron_tick_claims · audit_logs`

**Annotation under the bar:** *No engine calls another. Ingestion writes; dispatch reads whatever
it finds. Coordination is the database, not a message.*

**Red warning callout attached to the bar:**
> **If ingestion stops, the 05:00 run still fires on schedule, dispatches yesterday's stale
> ticket pool, and reports SUCCESS. Nothing in the engine notices.**

---

### 3.3 BAND B — DISPATCH ENGINE

**Band header:** `DISPATCH ENGINE · 05:00 IST daily, or a manual run · switch: BUSINESS_SWEEPS_ENABLED (default OFF)`

#### Stage 4 · RUN ADMISSION  ◆
*One run per window, one claim per zone*

1. **Cron tick claim** — the insert *is* the test, per job per minute. Covers the whole run
   including its waits, so a second instance never starts a parallel run.
2. **Reap first** — free the zone claims of runs that stopped reporting (10-minute heartbeat)
3. **Future-day guard** — refuse to dispatch a date that is not today
4. **Open the run** — `dispatch_runs` = RUNNING, and freeze the config snapshot: scoring weights,
   thresholds, capacity map, tier overrides, the cron expression itself
5. **Claim the zones** — `INSERT INTO dispatch_run_zones … ON CONFLICT DO NOTHING`

**DECISION (diamond): are any zones free?**
- **Some free → PARTIAL ADMISSION.** Claim the free ones and start immediately. Held zones are
  recorded as `CONTENDED` rows on this same run. **No waiting.**
- **None free →** write nothing at all — a run that would do nothing is never opened. Wait,
  re-reap, retry. Cron only, up to 15 minutes.
- **A manual run never waits** — it gets an immediate answer naming who holds the zone.

#### Stage 5 · RECOMMENDER — *who should go?*  (per zone, six sub-boxes A–F)

**A · BUILD THE POOL — two queues, not one**

*Troubleshoot queue — nine gates:*
- work type TROUBLESHOOT · status OPEN · unassigned
- not blocked waiting on a component
- not deferred on the target day
- plant in this zone and not deactivated
- device not departed from the fleet
- silence at or past the configurable assignment threshold
- a computed SLA bucket must exist

*Install backlog — the second queue:* status REQUESTED and unassigned. Fills whatever engineer
capacity remains **after** all troubleshoot work, in PREVENTIVE mode.

*Measured but not itemised (counts only, on the run ledger):* withheld below threshold ·
dropped for no computed bucket · withheld as component-blocked

**B · RANK — the canonical sort**
*Applied once, in process. There is no SQL mirror of this order.*

1. **Company tier ↓** — PLATINUM › GOLD › SILVER (zone override aware)
2. **Device SLA bucket ↓** — eight bands, purely hours of GPS silence:
   `WARNING 4–8h` · `EARLY_RISK 8–12h` · `RISK 12–24h` · `CRITICAL 24–48h` ·
   `HIGH_CRITICAL 48–72h` · `SEVERE 3–5d` · `VERY_SEVERE 5–7d` · `LONG_PENDING 7d+`
   *(0–4h = ACTIVE = no bucket = never enters the queue)*
3. **Return due today** — outranks company priority, **never** outranks CRITICAL or above
4. **Company priority rank ↑** — A before B before C
5. **Oldest silence first**
6. **Device ID** — absolute tie-break

**C · COVERAGE TIER**

`DEDICATED → MULTI_PLANT → FLOATING`

First non-empty tier wins. A lower tier is reached only when every candidate in the higher tier
was filtered out. **Score is only ever consulted inside the winning tier** — a floating engineer
can never out-score an eligible dedicated one.

**D · HARD FILTERS** — per candidate, fail fast, first failure wins

| # | Filter | State |
|---|---|---|
| 1 | Vehicle on trip | ⚠ **NOT ENFORCED** — the feed does not exist |
| 2 | Engineer unavailable | enforced |
| 3 | Over capacity | enforced |
| 4 | Common kit incomplete | enforced |
| 5 | Component unavailable | ⚠ **NOT ENFORCED** — the feed does not exist |

Every filter reports one of three states — **PASSED / FAILED / NOT ENFORCED**. A not-enforced
filter can never drop a candidate, and must never be drawn as a pass.

**E · SCORE** — six weighted components, times a cluster multiplier

- `company_priority_rank`
- `dispatch_urgency` — derived from the SLA bucket
- `repeat_failure_penalty`
- `distance` — route position → plant
- `repeat_failure_bonus` — **PREVENTIVE mode only**
- `device_age` — **PREVENTIVE mode only**

**× Plant Cluster Multiplier** — an engineer already routed to that plant scores higher.

**Mode switch:** each zone runs in **DEFICIT** or **PREVENTIVE**, chosen from the Soft Inactive
Count. A healthy zone flips to PREVENTIVE, where repeat failure becomes a *bonus* instead of a
penalty and aged devices gain weight.

**Distance note:** the engineer's position is their last live stop today, falling back to their
admin-entered home base, and it *advances* after each ticket they win. This is a **planned
position, not live GPS**. Missing geometry yields `NOT_AVAILABLE`, never a fabricated zero.

**F · CHOOSE & RECORD**

Selection order:
1. **Planner pin** — a manager's explicit intent. The **only** mechanism that may cross the
   coverage tiers.
2. **Highest score** within the winning tier
3. **Engineer ID ascending** — deterministic tie-break

Outcomes: **`SUGGESTED`** or **`UNASSIGNABLE`** (reason: `NO_COVERAGE` or `ALL_DROPPED`)

Every decision writes a trace: the chosen engineer, the tier evaluated, capacity at the moment of
decision, each filter's three-state verdict, and up to five runners-up.

#### Stage 6 · PER-SE DISPATCH WRITE
*One transaction per engineer — blast radius of exactly one*

Group recommendations by engineer. Then, for **each** engineer, in **one transaction**:

1. Take the zone advisory lock (blocking)
2. Claim this engineer's rows — `SELECT … FOR UPDATE SKIP LOCKED`
3. Re-check idempotency **inside** the transaction
4. Reuse the engineer's live day plan, or create one — never a second plan
5. **Group tickets by plant.** Write one `plant_batch_assignments` row per plant — **that row is
   one STOP** — with `stop_sequence` continuing after the existing last stop
6. Write `batch_assignment_tickets` with `sort_order` inside the stop
7. Flip each ticket → `assignment_state = FORMALLY_ASSIGNED`
8. Write the `day_plan_notification_outbox` row **in the same transaction**
9. Mark the recommendations → `DISPATCHED`
10. **COMMIT** — then drain the outbox after commit

**Two callouts to draw prominently beside this stage:**
> **A stop is a PLANT, not a ticket.** One engineer's day is an ordered list of plant visits,
> each holding an ordered list of tickets.

> **The plan is ORDINAL — stop sequence and sort order only. There is no ETA and no time
> anywhere in it.** That is deliberate: without live positioning, any time would be fabricated.

#### Stage 6b · RETRY & FINALIZE

- **Second patience loop** — retry the CONTENDED zones under the *same* run row, same 15-minute
  budget, so one morning's work stays one ledger entry
- Zones still held when time runs out keep a visible `CONTENDED` row — never silent
- **Finalize:** `SUCCESS` / `PARTIAL` / `FAILED`
- Every terminal write is conditional on the run still being RUNNING, so a wrongly-reaped run can
  never overwrite the ledger

---

### 3.4 BAND C — THE LIVE DAY

**Band header:** `LIVE-DAY OPERATIONS · every 2 minutes → daily · switch: BUSINESS_SWEEPS_ENABLED`

#### Stage 7 · INTRA-DAY OPERATIONS

- **CRITICAL direct-assign — every 2 minutes.** Every CRITICAL and HIGH_CRITICAL ticket is
  assigned directly, through the same filters and the same scoring discipline as the morning run.
  Never offered, never waiting for an engineer to accept.
- **ESCALATE, NEVER OVERLOAD.** A critical ticket with no capacity-eligible engineer raises
  `ESCALATION_REQUIRED` and notifies the Zone Manager. *The scheduler never authorises overload on
  its own.*
- **Manager overrides** — swap · split · reorder · remove · defer · reassign. Reason-gated,
  audited, committed immediately. A human **may** exceed capacity, visibly, by ruling.
- **Cross-zone escalation** — PLATINUM tickets left unassigned past a threshold auto-raise into a
  cross-zone queue: approve · deny · defer · re-escalate to operations.
- **Bulk unassign** — token-confirmed mid-day rebalance
- **Vehicle unavailability** — hold with a return date, auto-resume when the vehicle is due back
- **Reaper — every 3 minutes.** Frees the zone claims of runs that stopped reporting.
  ⚠ **It does not re-dispatch them.**

#### Stage 8 · CLOSURE & RECYCLING

- **04:00 IST** — yesterday's day plans close. Unworked stops return to the pool as
  `PLAN_EXPIRED`, with seven protected classes exempt.
- **04:30 IST** — the plant-eligibility index refreshes, one hour before the run it feeds.
- ⚠ **If that refresh fails, the 05:00 run does not check.** It dispatches on a stale eligibility
  index with no signal.

---

### 3.5 BAND D — DOWNSTREAM CONSUMPTION *(right-hand column)*

*Surfaces and tools — management and field*

- **SE Day Plan** — mobile app. The Home screen *is* the day plan.
- **Dispatch Runs drill-down** — Run → Zone → Batch → Decision Trace
- **Assign Work Console** — manual many-to-many assignment and override
- **Scheduler Preview** — dry-run projection of the *real* recommender
- **Reports & KPIs** — performance, SLA, backlog
- ⚠ **External push is a stub.** Push, SMS, WhatsApp and email all resolve to a logging gateway
  until those accounts land. In-app notification is real; the phone does not buzz yet.

---

### 3.6 TOP-RIGHT REFERENCE PANELS

**LEGEND**
- `→` data flow
- `⇒` control / trigger
- `◆` decision
- `⇢` write / commit
- `⚠` not enforced, or a known gap
- `●` system decision  ·  `○` human decision

**ENGINE OPERATING PRINCIPLES**
- Dispatch hour — **05:00 IST**
- Write unit — **one engineer**, one transaction each
- Liveness — **10-minute heartbeat**, then reap
- Patience — **15 minutes**, cron only
- Manual run — **never waits**, immediate answer
- Zone exclusion — one RUNNING claim per zone
- Timezone — IST-pinned on the five dispatch-path jobs; the reporting sweeps follow the host clock

**MASTER SWITCHES — two, both default OFF**
*Enabling either is an explicit operations step.*
- `BUSINESS_SWEEPS_ENABLED` — dispatch, reaper, closure, eligibility refresh, twelve field sweeps
- `INGESTION_SCHEDULER_ENABLED` — telemetry and masters

---

### 3.7 BOTTOM PANELS

**KEY SAFEGUARDS**
- **Cron tick claim** — one run per job per minute; the insert is the test
- **Zone claims** — one active run per zone, enforced by the database
- **Advisory lock + SKIP LOCKED** — per-engineer isolation inside a zone
- **Per-engineer transactions** — one engineer's failure costs only that engineer
- **Heartbeat + reaper** — no run stays RUNNING forever
- **Conditional finalize** — a reaped run can never overwrite the ledger
- **The #230 gate** — a partial read stops all downstream processing
- **Outbox pattern** — notifications are reliable and idempotent
- **Escalate, never overload** — the scheduler will not self-authorise overload

**KNOWN GAPS** *(draw in red — this panel is what makes the rest credible)*
- A crashed zone is freed but **never re-dispatched** — a 05:02 crash costs those zones their
  field day
- **No mid-day reroute** when an engineer becomes unavailable after dispatch
- Vehicle-on-trip and component-availability filters are **stubs**
- Eligibility-index staleness is **invisible** to the run that consumes it
- Assignment **adds are not attributed** — removals are
- Two provenance stamps are backwards: human batches read `AUTO_ASSIGNED`, intra-day system
  assignments read `ZM_MANUAL`

**AUDIT & OBSERVABILITY**
- `dispatch_runs` — one row per run, with a frozen config snapshot
- `dispatch_run_zones` — per-zone status: RUNNING / DONE / ERROR / CONTENDED
- `dispatch_decision_traces` — per-ticket reasons, scores, filter verdicts, runners-up
- `recommendations` — what was suggested, its processing rank, its outcome
- `batch_assignment_tickets` — who removed what, and why
- `audit_logs` — written in the same transaction as the change it records
- `ticket_events` — the full lifecycle timeline

**END-TO-END OUTCOME** *(a horizontal icon strip, nine steps)*

`Silent device` → `Evidence gate` → `Ticket created` → `Ranked & filtered` →
`Best engineer chosen` → `Plant stop on a day plan` → `Worked in the field` →
`Verified & closed` → `Recycled if not done`

**FOOTER BAR** *(navy, full width, white text)*

> The scheduler engine sends the right work to the right engineer in the right order —
> reliably, reproducibly, and with a recorded reason for every decision.

---

## 4 · THE SIX THINGS THE PREVIOUS POSTER GOT WRONG

Keep these visible while reviewing whatever the image model produces:

1. **Three engines, not one.** No arrow from ticket creation to run admission. They share only
   the database.
2. **Two of the five hard filters do not run.** Vehicle-on-trip and component availability must
   carry the ⚠ NOT ENFORCED mark.
3. **No ETA.** The plan is a sequence of stops, never a schedule of times.
4. **A stop is a plant, not a ticket.**
5. **`MAINTENANCE_MODE` does not exist.** There are two master switches, and both default OFF.
6. **The SLA scale is eight buckets** by hours of silence — not Critical/High/Medium/Low.

---

## 5 · IF THE IMAGE COMES OUT GARBLED

Three fallbacks, in order of fidelity:

1. **Three passes.** Generate band A, band B and band C as three separate landscape images with
   the same art direction, then compose them vertically. Each pass carries a third of the text.
2. **Structure first, text second.** Ask for the poster with box *shapes* and headers only, then
   add the detail text in any editor.
3. **Skip the image model.** This spec is complete enough to drive a real diagramming tool, where
   every label stays exactly as written above.
