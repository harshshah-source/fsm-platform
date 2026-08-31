# The Scheduler Engine — an end-to-end operating guide

**Audience:** the manager who has to use it (ZM / CSM / Operations Head), and the engineer who has to
maintain it. Written 2026-08-31 against `feat/autoplant-integration`.

**What this is:** a walkthrough of `/dispatch/today` — the **Scheduler Console** — from the moment you
open it, region by region, control by control, with the backend behaviour behind each one. Every claim
here was read from the code, not from a spec.

**What this is not:** a state document. `docs/SYSTEM-STATE-2026-07.md` is the only current-state
authority and `.scratch/fsm-platform-v1/INDEX.md` is the only work tracker. When this guide and those
disagree, **they win** — this file explains how the thing works, not what is or is not built.

---

## Table of contents

1. [The thirty-second model](#1-the-thirty-second-model)
2. [Before you arrive: what the engine did at 05:00](#2-before-you-arrive-what-the-engine-did-at-0500)
3. [Getting to the Console, and the first screen](#3-getting-to-the-console-and-the-first-screen)
4. [The top bar — the frame](#4-the-top-bar--the-frame)
5. [The health band — recovery and critical escalations](#5-the-health-band--recovery-and-critical-escalations)
6. [Region 1 (left) — Engineers](#6-region-1-left--engineers)
7. [Region 2 (centre) — the board](#7-region-2-centre--the-board)
8. [Region 3 (right) — Work Pool, or Attention](#8-region-3-right--work-pool-or-attention)
9. [The Inspector — the bottom band](#9-the-inspector--the-bottom-band)
10. [The eight write actions](#10-the-eight-write-actions)
11. [Drag and drop](#11-drag-and-drop)
12. [Run Now](#12-run-now)
13. [Assign mode — handing out work](#13-assign-mode--handing-out-work)
14. [The day axis — past, today, future](#14-the-day-axis--past-today-future)
15. [How to read the numbers without being misled](#15-how-to-read-the-numbers-without-being-misled)
16. [Roles — what changes, and what does not](#16-roles--what-changes-and-what-does-not)
17. [What reaches the engineer's phone](#17-what-reaches-the-engineers-phone)
18. [Recipes — six common jobs](#18-recipes--six-common-jobs)
19. [Glossary](#19-glossary)

---

## 1. The thirty-second model

The platform's job is to decide, every morning, **which Service Engineer visits which plant to fix
which device** — and then to let a human correct that decision all day without losing the audit trail.

There are three moving parts, and the Console is where all three meet:

| Part | What it is | Where it lives |
|---|---|---|
| **The engine** | A nightly cron that scores and places work, per zone | `apps/backend/src/recommender/` + `scheduling/` |
| **The plan** | What the engine committed: day plans, stops, tickets | `work_schedules` → `plant_batch_assignments` → `batch_assignment_tickets` |
| **The Console** | Where a manager sees the plan, understands it, and changes it | `/dispatch/today` |

Two sentences that explain most of the design:

> **The engine plans one zone at a time.** There is no pan-India dispatch view, deliberately — the
> Console refuses to guess a zone rather than inventing a national number.

> **The Console never re-implements the engine.** Every "why" you read on this screen was computed by
> the backend and persisted; the frontend explains it, never re-derives it.

---

## 2. Before you arrive: what the engine did at 05:00

Understanding the screen means understanding what already happened. This is the whole run, in order.

### 2.1 The trigger

Three cron jobs make up the dispatch family
(`apps/backend/src/scheduling/dispatch-scheduler.service.ts`):

| Job | Default | Purpose |
|---|---|---|
| `business-dispatch` | `0 5 * * *` **IST** | the real run — `DispatchRunService.runForActiveZones` |
| `business-dispatch-reaper` | every 3 min | frees zones held by runs whose process died, and records that the zone is *owed a day* |
| `business-dispatch-recovery` | every 5 min | collects on those marks — bounded re-dispatch, 3 attempts, 18:00 IST cutoff |

**The 05:00 is not hard-coded.** It comes from `system_settings.dispatch_cron`, and
`DispatchScheduleService` re-points the live job at boot and on every write — an Operations Head can
move the dispatch hour with no redeploy. This is why the Console publishes **Next run** as a fact read
from the server rather than printing a constant (§4.5).

### 2.2 Who is allowed to run, and who is not

Concurrency is layered, and every layer is coordinated in the database, not in process memory:

1. **Tick claim** — `cron_tick_claims`, `INSERT … ON CONFLICT DO NOTHING`. One instance runs a given
   (job, UTC-minute) window; the rest return `TICK_CLAIMED`.
2. **Zone claim** — the `dispatch_run_zones` row *is* the claim, behind a unique index
   (`one_running_per_zone`). Every requested zone already held → **409 with zero rows written**, because
   a run that never happened must leave no history.
3. **Per-SE transaction** with `SELECT … FOR UPDATE SKIP LOCKED` — one engineer's failure costs that
   engineer only, never the whole zone.
4. **Heartbeat + reaper**, with the checkable invariant `reap ≤ retry deadline`.
5. **Bounded patient retry** on the cron path only. A manual run is *never* patient — it refuses
   immediately and tells you who is holding the zone.

### 2.3 What work enters the run

Only tickets that are **OPEN and UNASSIGNED**. That single fact explains the most common "is it
broken?" moment (§12). Work already on somebody's plan is never re-planned.

Four populations are then held back, and the engine counts each **separately** because they have
different owners and different next actions:

| Population | Meaning | Whose problem |
|---|---|---|
| `withheldBelowThreshold` | the device has not been silent long enough yet | nobody's — policy working |
| `componentBlockedWithheld` | waiting on a part; SLA paused | the warehouse's |
| `bucketlessDropped` | no computed SLA bucket, so nothing to rank on | a **data fault** |
| held / deferred | a human deliberately parked it until a date | the manager who did it |

They are never summed into one "not dispatched" number. A total nobody can act on is worse than four
numbers each of which someone owns.

### 2.4 The order tickets are considered in

`canonical-sort.ts` — pure, deterministic, and the **only** thing that orders the dispatch path (there
is no SQL mirror, and the docstring says so explicitly to stop someone "restoring" one):

```
Company Tier ↓ → Device Bucket ↓ → Return-Due-Today ↓ (below CRITICAL+ only)
  → Company Priority Rank ↑ → Oldest Inactive ↑ → Device ID ↑
```

This order matters to you because it is the order the **Run decisions** replay shows (§9.4), and
`processing_rank` is what makes that a replay rather than a report.

### 2.5 Choosing an engineer — four steps, in this order

For each ticket, in that order:

**Step 1 — candidates, by strict coverage precedence.**
`CandidateSelectionService.orderedCandidatesForPlant` returns, in this order:
`DEDICATED` → `MULTI_PLANT` (both from `se_coverage`) → `FLOATING` (from the
`plant_eligible_floating_se` materialized view, **re-validated live** against `engineer_master`, so a
now-dedicated or deactivated engineer cannot be resurrected by a stale MV).

**Step 2 — hard filters.** `hard-filters.ts`. Five filters, evaluated in a fixed order, first failure
wins:

| Filter | Fires when |
|---|---|
| `VEHICLE_ON_TRIP` | the engineer's vehicle is out |
| `SE_UNAVAILABLE` | leave / off-shift |
| `OVER_CAPACITY` | at or past `daily_capacity` |
| `COMMON_KIT_INCOMPLETE` | missing standard kit |
| `COMPONENT_UNAVAILABLE` | missing the expected part |

Each filter reports **three** states, not two: `PASSED` / `FAILED` / **`NOT_ENFORCED`**.
`NOT_ENFORCED` means *the data source does not exist yet* and it **never drops a candidate**. Two
filters sit there today (`VEHICLE_ON_TRIP` awaiting the vehicle feed, `COMPONENT_UNAVAILABLE` awaiting
the component feed). This is a correct representation of an incomplete input — the run records that it
did not enforce the filter rather than pretending it passed. You see this tri-state verbatim in the
Inspector's **Why** band.

> **Note:** an engineer's activity ping is *deliberately not* a hard filter. Someone working offline in
> a no-network area must stay a candidate.

**Step 3 — the winning tier.** `tier-score-chooser.ts`. The winning tier is the **first non-empty tier
in precedence order**. This is a scan, not a sort — which means:

> **A floating engineer can never out-score an eligible dedicated one.** The score is only ever
> consulted *within* one tier. A lower tier is reached only when every higher-tier candidate was
> filtered out.

**Step 4 — the score, within that tier only.** `scoring.ts`:

```
baseScore = w_rank·rankScore + w_urgency·urgency − w_repeat·repeatPenalty
          + w_repeatBonus·repeatPenalty + w_age·ageScore + w_distance·distanceScore

score     = max(baseScore, 0) × clusterMultiplier
```

Selection order is then: **an SE-Planner pin** (a human's explicit pin crosses tiers), then the
winning tier's top score, then `se_id` ascending as a deterministic tie-break.

Every term above is persisted per decision and rendered term-by-term in the Inspector (§9.3.1).

### 2.6 Two operating modes

The zone runs in one of two modes, switched automatically off the **Soft Inactive Count**:

| Internal name | What you see | Behaviour |
|---|---|---|
| `DEFICIT` | **Catch-up** | repeat failure is a *penalty*; device age is not weighted |
| `PREVENTIVE` | **Steady** | repeat failure becomes a *bonus*; aged devices add |

The switch is `softInactive > 2% × eligible devices` (configurable). The enum names never reach a
user-facing surface — you always see *Catch-up* or *Steady*.

### 2.7 The write, and the announcement

`BatchAssignmentService.dispatchForZone` writes, **per engineer, in one transaction**:

- one `ACTIVE` **WorkSchedule** (the day plan)
- one `PlantBatchAssignment` per plant (a **stop**)
- its `batch_assignment_tickets`, carrying provenance (`added_by`, `add_source`)

There is **no approval gate** — the plan is dispatched directly and the manager overrides afterwards.

The *"Day Plan is live"* intent is written to `day_plan_notification_outbox` **inside that same
transaction**, so it commits with the plan or not at all. A rolled-back plan can never announce
itself. Delivery is attempted after commit and retried by a sweep. (What actually reaches the handset
is §17 — read it, because it is the one place reality is thinner than it looks.)

### 2.8 Critical work that nobody could take

If a `CRITICAL` / `HIGH_CRITICAL` ticket has no capacity-eligible engineer, the engine does **not**
overload someone silently. It writes an **escalation** (`intraday_insertions`, type
`ESCALATION_REQUIRED`) and hands the decision to a human. That is the crimson strip at the top of your
Console (§5.2).

---

## 3. Getting to the Console, and the first screen

### 3.1 The door

Left sidebar → **Dispatch** group → **Today's Dispatch** *("What is happening now")*.
Route: `/dispatch/today`.

Three sibling rows sit under it, indented, and they are four views of one concept at four points in
time. Knowing which is which saves a lot of confusion:

| Row | Answers |
|---|---|
| **Today's Dispatch** | what is happening **now** |
| Scheduler Preview | what the next run **would** do |
| Schedules | committed day plans (not date-scoped) |
| Intra-day Queue | changes made to today's plan |
| Dispatch Runs | the ledger of what already ran |

### 3.2 First arrival — what you see depends on your role

**If you are a Zonal Manager:** the Console loads straight into your zone. You never name it; the
backend resolves it from your token and refuses any other. There is no zone picker — not because it is
disabled, but because `GET /org/zones` genuinely returns nothing for you, and a dropdown with one
unchangeable option teaches a choice that does not exist.

**If you are a CSM or Operations Head:** you get a **Choose a zone** card:

> *The Console shows one zone's operating day. There is no pan-India dispatch view — the scheduler
> plans, and this screen reports, one zone at a time.*

This is not a loading state and not an error. `GET /dispatch/today` **refuses to guess** a zone for a
multi-zone role (`400 ZONE_REQUIRED`), because any number shown on an "all zones" screen would be
invented. Pick a zone from the picker; the Console remembers it in `localStorage` and opens there next
time.

### 3.3 What loads

**One fetch.** `GET /dispatch/today` is called once by the page shell and every region reads that same
object. This is deliberate and it is the reason the four regions can never disagree about an
engineer's load:

> Every write in the Console calls `invalidate()` — it refetches the whole payload. No region is
> allowed to refresh itself independently.

A second, secondary fetch (`changes-today`) is graded differently: if it fails, the change list goes
empty and **the board still stands**. A rail that cannot load must not take the operating day down
with it.

### 3.4 The URL is the state

Everything you are looking at is in the query string, so you can paste it to a colleague and they see
exactly your screen:

| Param | Meaning |
|---|---|
| `?zoneId=7` | which zone (CSM/OH only) |
| `?day=2026-08-27` | which day column is focused |
| `?span=week` | three days either side instead of one |
| `?sel=ticket:abc123` | what is selected (`ticket:` / `stop:` / `engineer:` / `run:`) |
| `?assign=1` | Assign mode is on |

A malformed value degrades to "nothing selected" — it never throws.

---

## 4. The top bar — the frame

One compact strip that owns *where you are standing*. Everything in it stays true and stays visible in
every mode, including Assign mode.

```
Scheduler Console  [Zone ▾]  ‹Prev [TODAY] Next›  [Day|Week]  [Find ticket or SE /]
                                   ● DISPATCHED 10:53 · SUCCESS   Next run 05:00 1 Sept  [Run now]
[⚠ 6 need attention ▸]  [Assign work]  [Run facts ▾]  [?]
```

### 4.1 Zone

A picker for CSM/OH; plain text for a ZM. Changing it **clears your selection and leaves Assign mode**
— a selection from another zone's deck means nothing on this one, and a draft staged against the old
zone must never be committed under the new zone's heading.

### 4.2 Day navigation — `‹ Prev · TODAY · Next ›`

Moves the focused column. `TODAY` is always one click away. This axis **replaced** the old
Plan / Live / Replay mode navigation: a future column *is* the plan, today *is* live, a past column *is*
the replay. See §14.

### 4.3 Day / Week

How many context columns surround the focused day — one either side, or three.

### 4.4 Find ticket or SE (`/`)

Press `/` anywhere to focus it; `Esc` peels back one layer — the selection first, then the attention
rail. **No shortcut fires a write**, deliberately: a keystroke that commits an irreversible override is
out of scope.

It **filters, never fetches** — every object on this screen is already
in the one payload. An engineer whose own name misses but who is carrying a matched plant or ticket
**stays visible**, because hiding the lane would hide the match. In Assign mode the same box filters
the assignable pool.

### 4.5 Run state and Next run

- `● Dispatched 10:53 · SUCCESS` — today's run for this zone, or **No run today**.
- **Next run 05:00 1 Sept** — read from the server, never a hard-coded constant. If the day is not
  today, the date is printed, because *"next run 05:00"* on a screen at 23:00 reads as "in five
  minutes". If your role cannot read the schedule, the pill is **absent** rather than guessing.

### 4.6 Run now

See §12. Rendered for CSM, OH **and** ZM — a ZM's run is clamped server-side to their own zone
whatever the request body says.

### 4.7 Attention strip

`⚠ 6 need attention · 3 chronic · 2 approvals ▸` — click to expand it into the right rail (§8.2).
It reads the same `action-required` cards the dashboard uses, scoped to **this zone**, so a CSM never
sees a national number under a zone's heading.

### 4.8 Assign work

Enters Assign mode (§13). Entering **drops your current selection** — a selection is a committed object
and must not sit beside draft lanes that write nothing.

### 4.9 Run facts ▾

A popover holding the eight funnel counters plus **Refresh the operating day**. It lives here rather
than as a strip because eight numbers competing with the board is exactly the clutter this composition
removed. Two of the eight are nullable and keep a hard distinction:

> **`—` is not `0`.** A dash means *this run did not record that population*; a zero means it recorded
> it and found none. The popover prints the explanation next to the dash rather than hiding it in a
> tooltip.

### 4.10 `?`

The chip grammar legend. Reference content, not screen content — see §7.3.

---

## 5. The health band — recovery and critical escalations

These are the only two things besides the top bar that get full width, and they earn it.

### 5.1 Recovery notice

Appears only when this zone's dispatch run **died** today. Four states, and you must be able to tell
them apart at a glance:

| State | Meaning | Do you act? |
|---|---|---|
| `RECOVERED` | the system put it right itself | no — reassurance, not an alarm |
| `PENDING` | still owed; the collector will come back | no |
| `EXHAUSTED` | the system tried its budget and stopped | **yes** |
| `EXPIRED` | the field day ran out first | **yes** — that work will not happen today |

The last two are drawn with a heavy amber border and say plainly: *nothing further will be attempted
automatically today — run dispatch for this zone manually once the cause is cleared.*

### 5.2 Critical escalation strip

> **225 critical tickets need manual assignment**
> No capacity-eligible engineer was available, so the scheduler escalated rather than overloading anyone.

Each row is one escalated ticket: short id, SLA badge, when it escalated, and a verb on the right.
Two causes write these rows and the strip does not blur them:

- **no capacity-eligible engineer** (§2.8) → the row's verb is **Assign this work →**
- **the assigned engineer became unavailable** → the row names them, and the verb is
  **Reassign this work →**

The distinction is not cosmetic: `assignTicket` *refuses* an already-assigned ticket, so offering
"Assign" on a stranded ticket would be a button that always 409s.

The explanatory sentence about capacity is printed **only when it is true of every row** — one
explanation over a mixed list would be wrong about half of it.

The strip shows six rows and then a count. Every one resolves the same way: select it, then assign or
reassign from the Inspector.

Inside Assign mode the verb changes to **Leave assigning and resolve →**, and clicking it takes you
out of the mode first (asking about your draft on the way — §13.7), because the Inspector is not on
screen while you are drafting.

---

## 6. Region 1 (left) — Engineers

The board answers *who is carrying what, in what order*. This rail answers the question that comes
first: **who have I got today, and how loaded are they?**

Each row shows:

| Element | Meaning |
|---|---|
| **Name** | click to select the engineer — the Inspector opens on them |
| **Load badge `3/25`** | committed stops today / daily capacity. **Amber at or past capacity.** |
| **Coverage** | `DEDICATED` · `MULTI PLANT` · `FLOATING` |
| **`2 stops · 7 devices`** | today's plan at a glance |
| **Availability** | printed in amber when not `AVAILABLE` (leave, off-shift) |

Two rules worth knowing:

**The load number is the one the engine enforces.** `committed` and `dailyCapacity` come from
`committedDayPlan` — the same function dispatch itself uses to decide whether an engineer can take
more. This rail never recomputes a load from the stops it can see, because a number you read as *"can
this person carry it?"* has to be the number the engine will actually check.

**An unavailable engineer still holds their work.** Nothing is silently reassigned when someone goes on
leave. The rail says both things: they are unavailable, *and* the work is still theirs. Reassigning it
is your decision.

---

## 7. Region 2 (centre) — the board

The dominant canvas. Axes are **ENGINEER × DAY**: rows are engineers in People-rail order, columns are
operating days, and a cell holds that engineer's stops and tickets for that day.

### 7.1 A cell, read top to bottom

```
1  Kotputli Works                    ← stop sequence + plant name (click to select the stop)
   ●a1b2c3d4 CRIT   a3f9…  ●b7c2…    ← the tickets on that stop (chips)
2  Neem Works
   ●d4e5f6a7 RET  CHR ×4
```

- The number is the **stop sequence** — the order the engineer is expected to visit.
- The plant name is the **stop**; clicking it selects it and offers stop-level actions.
- The chips are individual **tickets** (devices).
- `adjusted` badge on a stop means its status is `OVERRIDDEN` — a human has changed it.
- An amber cell means **the engineer is at or over capacity that day**. Capacity is a fact about the
  engineer's day, so it colours the *cell*, never a chip.
- `no stops — available` is a real and useful state, and it is distinguished from `no stops` on an
  over-capacity engineer.

Only the **focused** column expands chips. Context columns collapse to `5 devices` — enough to see
shape without drowning the focus.

### 7.2 A last row: *Not on today's roster*

Committed work on other days held by engineers who are not on today's roster. It is a fact about
those days, and omitting it would make a past column look emptier than it was.

### 7.3 The chip grammar — four channels, four meanings

This is the single most useful thing to learn on the screen. Four **independent** channels, no
overlap, and every one survives grayscale:

| Channel | Carries |
|---|---|
| **Border style** | **provenance** — who put this here |
| **Inline tokens** | urgency (`CRIT`), vehicle return (`RET`), chronic device (`CHR ×n`) |
| **Cell fill (amber)** | capacity — the engineer's day |
| **Chip fill** | **reserved and currently unused** — it claims nothing |

**Borders — provenance:**

| Border | Means |
|---|---|
| **solid + dot** | the **engine** placed this |
| **dashed** | a **human** placed this |
| **dashed violet** | a human placed it **and crossed a coverage tier** |
| **dotted, muted** | provenance **not recorded** — this predates provenance tracking |

That last one is load-bearing. Absence is a fact about the record, and drawing an unknown as a system
decision would be the one lie this grammar exists to prevent.

**Tokens:**

| Token | Means |
|---|---|
| `CRIT` | critical work — **travels with the ticket whoever assigned it** |
| `RET` | the vehicle is due back today |
| `CHR ×4` | chronic device — 4 lifetime failure cycles. Dispatch treats it normally; the question this raises is whether to *replace the unit*. |
| `~ghost` | projected by the preview — **nothing committed** |

`CRIT` is a token rather than a border for a specific reason: it used to be a crimson border drawn only
on system-placed chips, so a critical ticket *lost its urgency mark the moment a human reassigned it*.
A token renders on every chip regardless.

Selection adds a **ring**, never a border change — the border already means provenance.

### 7.4 The column header

Each column says what mood it is in:

- `LIVE` (green) — today
- `history` — a past day
- `projected` (blue) — a future day with no committed plan
- `committed` — a future day that already has a live `WorkSchedule` (committed beats projected)

The focused column's header also carries its own door:

- **today** → `Run decisions →` (opens the run replay in the Inspector) and `All runs →`
- **past** → *counts only · open a run for detail →*
- **future** → the projection summary (`Catch-up mode · 42 would be assigned · 3 unassignable · 7
  withheld · ranking as of …`) and `Open the full projection →`

---

## 8. Region 3 (right) — Work Pool, or Attention

**One slot, two occupants, never both.** The Work Pool by default; the Attention list when you click the
top-bar strip.

### 8.1 Work Pool — what did *not* land

Three tabs plus a panel. Together they answer *what is not on anybody's plan, and why?*

| Tab | Population |
|---|---|
| **Unassigned** | the engine looked and found nobody eligible |
| **Held** | deliberately deferred to a future date, with the date and who decided |
| **Changes** | what a human has changed since the run |

Plus a **chronic** toggle that cuts across the current tab (chronic is a property of the *device*, not
a location, so it is a filter and not a fourth tab). Its threshold comes from the payload, never from a
constant in the frontend.

Three rules this rail must not break:

1. **`policyWithheld` is a count and never becomes a list.** The engine counts that work and never
   itemises it — those tickets have no recommendation, no row and no trace. It renders as a *panel*
   rather than a tab precisely so nobody tries to "finish" it.
2. **"reason not recorded" is never rendered as a guess.** An unassignable row with no recorded reason
   says so.
3. **Every row selects the same underlying ticket the board would have selected**, and drives the same
   single Inspector. A rail row is a different *door* to the same object, not a different kind of thing.

### 8.2 Attention — what needs a manager, ranked

The expanded strip. Nine urgency-ordered cards, from the same definition the dashboard uses (a
Console-local queue would drift from it the day either changed). Each card names its own count and one
verb.

Two honesty rules:

- **A stub is not a zero.** A category that is not counted yet renders as *not counted*, collapsed
  below the live cards — never as `0`, which would report the absence of a counter as the absence of
  work.
- **A count with no destination says so** — *"no queue page yet"* rather than a link that goes nowhere.

---

## 9. The Inspector — the bottom band

Selecting anything opens a band beneath the board. **Exactly one object is selected at a time**, and
selecting the same engineer in the People rail or on the board is the *same* selection — one object,
one Inspector, regardless of which door you used.

With nothing selected, the Inspector does not render at all. (The old empty "select something"
placeholder cost vertical space to say nothing.)

### 9.1 Engineer selected

Coverage, availability, stops today, devices today, day-plan status, load badge. If they are over
capacity: *"Dispatch will not add to this engineer; a human still may."*

There are **no actions here**, and that is deliberate: every move is a property of a *stop* or a
*ticket*. The band tells you so: *"Select a stop or a ticket on this engineer's lane to move, split,
reorder or remove work."*

### 9.2 Stop selected

Engineer, stop number, plant, device count, status, the device list, a `Why dispatch chose this →`
link, and three actions: **Swap engineer · Split stop · Reorder** (§10).

### 9.3 Ticket selected — three bands

The identity strip carries only what the decision trace does *not* know: which engineer, which stop,
SLA bucket, company tier, and a provenance badge.

#### Why

The engine's own decision trace for this ticket in this run: the candidates it compared, the tier it
evaluated, the hard-filter verdicts (including every `NOT_ENFORCED`), the capacity at the moment it
chose.

If there is no run today, it says so. If the ticket has no trace in that run, it says *that* rather
than inventing one.

##### 9.3.1 The score breakdown

Underneath the trace, the per-term arithmetic — the engine's numbers restated, not re-derived.
A worked example (the figures below are illustrative; yours come from the persisted breakdown):

| Term | Value | Weight | Contribution |
|---|---|---|---|
| Company priority | 0.900 | 0.40 | +0.360 |
| Dispatch urgency | 0.571 | 0.30 | +0.171 |
| Repeat-failure penalty | 1.000 | 0.20 | −0.200 |
| Repeat-failure bonus | 1.000 | 0.00 | +0.000 *· not weighted here* |
| Device age | 0.480 | 0.00 | +0.000 *· not weighted here* |
| Distance | 0.250 | 0.10 | +0.025 |
| **Base score** | | | **0.356** |
| Same-plant cluster bonus | | | ×1.25 |
| **Score** | | | **0.445** |

Three rules:

- **A weight of zero is shown, not hidden.** Device age and repeat-failure *bonus* default to 0 in
  Catch-up mode — you need to see that they were not consulted, or the two modes look identical.
- **The floor is shown when it bites.** `score = max(base, 0) × cluster`, so a negative base is
  clamped before the bonus multiplies it. When that happens the panel says the score is not the sum of
  the rows, and prints the true base anyway.
- **Distance is never a fabricated `0 km`.** *not available* means no home base, no prior stop, or no
  plant geometry — a different statement from "zero distance away".

#### Alternatives

The engine's own candidate list, tier-grouped, in the engine's exact order. **Nothing re-sorts** — not
by name, not by load. All three tier headings render whether populated or not, because *"No dedicated
engineer for this plant"* is what makes the floating candidate below it legible as the fallback it is.

Dropped candidates are shown, muted, **with their reason** — and here they are read-only.

#### History

The ticket's lifecycle (state changes with reason codes and actor roles) and its **visit attempts** —
`3 countable of 5 threshold`, with a warning when the repeated-attempt threshold is reached.

### 9.4 Run selected — the replay

Reached from the today column's `Run decisions →`. Every decision the run made, **in the order it made
them** (`processing_rank`), each expandable to its own trace.

> An **unassignable** decision is a decision and gets a row. Listing only the placements would show a
> run doing less than it did.

---

## 10. The eight write actions

Every action commits **immediately** through the endpoint that already owns it. There is no draft, no
staging, and no "commit all" here — that is Assign mode's job, and only Assign mode's.

**Four properties that are not negotiable:**

1. **Every override requires a reason.** Confirm stays disabled until it is non-empty. The reason is
   recorded on the ticket.
2. **The legal set is rendered and the rest is hidden.** Not greyed out. An action absent from this
   band is an action this object cannot take in this state.
3. **Two confirms are two-gate.** Some refusals come back as populated `409`s to be re-sent with
   `confirm: true`. They render as a **second deliberate step**, never as an error toast.
4. **Impact is previewed where projectable, and its absence never removes Confirm.** The preview is
   information, not a gate.

### 10.1 What is legal, and when

A ticket is in exactly one of three placements, decided **by the data**:

| Placement | Where it is | Actions offered |
|---|---|---|
| **PLACED** | on a stop | Reassign · Defer · Remove |
| **UNPLACED** | nobody holds it | Assign · Hold |
| **HELD** | parked until a date | Release hold |

A stop always offers: Swap engineer · Split stop · Reorder.

Why Assign is absent on a placed ticket: `assignTicket` *refuses* an already-assigned ticket, so the
button would always fail. Why Hold is absent on a held ticket: the hold was already a decision, and
offering it again would invite you to overwrite your own return date without seeing it.

### 10.2 The actions, one by one

| Action | Object | What it does | Endpoint |
|---|---|---|---|
| **Reassign** | ticket | moves one ticket to another engineer | `POST /batches/:id/override` |
| **Defer** | ticket | *"do it then, not today"* — moves it to a later day | same |
| **Remove** | ticket | takes it off the plan entirely (danger styling) | same |
| **Swap engineer** | stop | moves the **whole stop** to another engineer | same |
| **Split stop** | stop | moves **some** of a stop's devices elsewhere | same |
| **Reorder** | stop | changes the stop's position in the day | same |
| **Assign** | unplaced ticket | puts it on an engineer's plan | `POST /schedules/assign` |
| **Hold** / **Release** | unplaced / held ticket | parks it until a date / returns it | `POST /schedules/holds`, `/holds/release` |

**Split stop is the one place multi-select exists in the entire product** — `SPLIT_BATCH` takes
`ticketIds[]`. Everywhere else, multi-select would imply a bulk write the backend does not offer.

### 10.3 The target picker

Zone-scoped and acting-aware server-side: the engineers offered are the same engineers the board
shows, never a pan-India list beside a one-zone board. The current engineer is excluded — nobody is a
reassign target for their own work.

Options are labelled `Name (7/25)` and an over-capacity engineer is **marked, never removed**:

> Dispatch will not pick an over-capacity engineer. **A human may.** The option says both.

### 10.4 Impact preview

Only the three two-lane moves — Reassign, Swap, Split — have a two-lane impact. The endpoint
deliberately refuses the other three with `NOT_PROJECTABLE` rather than answering zeros, because
`0 → 0` would read as *"removing this person's work costs nothing"*.

The preview is keyed on **the target and the selection, never on the reason** — otherwise it would fire
a projection on every keystroke while you type your justification.

### 10.5 The two conflict gates

**`CONFLICT_ON_SITE`** — the engineer is standing at the site right now, on work this move touches.

**`CONFLICT_DEFERRED`** — the work is held to a future vehicle-return date.

Both render as an amber panel naming the affected tickets, with **Override anyway** and **Cancel**.
They are *different facts* and the panel says which. Overriding is recorded in the audit trail.

A third refusal exists on Hold: **`CONFLICT_VEHICLE_UNAVAILABLE`** — a vehicle-unavailability report
already returns this vehicle on a stated date. You may override that date, deliberately.

### 10.6 One detail that catches people out

> **`heldUntil` is the day the ticket comes *back*.** The check is inclusive. Holding something off
> tomorrow means naming the day *after* tomorrow. The form says so on the line beneath the field.

Releasing a hold takes no reason and has no conflict — the ticket re-enters the very next run.

---

## 11. Drag and drop

**A drag initiates. It never commits.**

Releasing a chip on a legal cell opens the same authoritative dialog the typed path uses, prefilled
with the target or the date. The same validation, the same impact preview, the same mandatory reason
and the same Confirm still stand between the release and any write. `Esc` or Cancel leaves the board
exactly as it was, and **the chip does not visually move until the write returns.**

Legal drops:

| Drag | Onto | Opens |
|---|---|---|
| a ticket | another engineer, **today** | Reassign, target prefilled |
| a ticket | the **same** engineer, a future day | Defer, date prefilled |
| a stop | another engineer, today | Swap engineer, target prefilled |
| a pool row | an engineer, today | Assign, target prefilled |
| a placed ticket | the Work rail | Remove |

An illegal cell **never becomes a drop target** — refusal is a cursor state during the drag, not an
error afterwards. A **past** column refuses every drop by construction. A **future** column accepts
exactly one: the same engineer's own ticket, which means *"do it then, not today"* and opens Defer.

---

## 12. Run Now

The real trigger — `POST /schedules/dispatch-run` — in the frame you are already standing in.

Clicking it opens a confirm with three things on it, and each is a real property of the engine:

**1. The warning you cannot undo:**

> **Engineers are notified.** A manual run commits day plans through the same path as the 05:00 run, so
> any work it places is pushed to engineers' phones immediately — mid-shift, if it is mid-shift.

**2. What it will consider:** work that is still open and unassigned. Anything already on a plan is
left alone.

**3. An optional reason**, recorded on the run ledger.

### The in-flight guard

A run already going for this zone disables the button before you press it (`Dispatch running…`), and
the server refuses independently with a populated `409` naming the zone, the time it started, and who
started it. The pre-check is a courtesy; the server is the authority.

### The zero-result state — read this before you conclude it is broken

> **No new assignments.** The run completed and placed nothing — that is the expected result when
> nothing has changed. Dispatch only considers tickets that are still **open** and **unassigned**; work
> already on a plan is never re-planned, and work that is held, withheld by policy or without an
> eligible engineer stays where the rails show it.

Pressing Run Now twice in a row legitimately places zero the second time. This state is designed, not
incidental — without it, managers learn to distrust the scheduler.

---

## 13. Assign mode — handing out work

The engine's job is to place what it can. **Assign mode is where a human places the rest.**

Enter it from the top bar's **Assign work**. The URL becomes `?assign=1`. It is a *mode of this
Console*, not another page: the top bar, zone, day, run state, attention strip and health band all stay
exactly where they were.

### 13.1 Why it replaces the board rather than sitting beside it

This is the one rule that shapes everything about the mode:

> **Draft work and committed work may share a screen, a frame and a grammar. They may never share a
> lane object.**

A chip on the committed board **writes immediately**. A chip in a draft lane **writes nothing** and is
lost when you leave. Two identically shaped objects on one screen meaning opposite things is the
defect this rule exists to prevent — so Assign mode takes over the board region entirely, and there is
no drag between them because there is nowhere to drag to.

### 13.2 The layout — the same three regions, different occupants

| Region | Normal mode | Assign mode |
|---|---|---|
| **Left** | Engineer roster | The same roster — **and it is the lane-target list** |
| **Centre** | Committed board | **Your draft**, as engineer rows |
| **Right** | Work Pool | **Not assigned yet** — the assignable pool |
| **Bottom band** | Inspector | **Candidates** for the plant in focus |

### 13.3 The three steps, on screen

Across the top, replacing any prose about drafts and browser tabs:

```
① 1479  Not assigned yet          ② 606  Selected for assignment       ③ 873  Will remain unassigned
   waiting in North                    going to 1 engineer · 98 critical      after you commit

Nothing has changed in the system yet — your draft is written only when you commit,
one engineer at a time.                                          [1 ENGINEER OVER CAPACITY]
```

Step ③ is **arithmetic over a draft that has written nothing** — which is exactly why the wording is
*will remain*, never *remains*.

The warning chips on the right are silent on a clean draft. A row reading *"0 over capacity · 0
crossings"* would train you to stop reading the one place a real warning appears.

### 13.4 The gesture: tick, then choose a person

1. **Tick work** in the right rail. Rows are grouped company → plant, showing outstanding count,
   `n CRIT`, `n held`, and *oldest 61 h silent*.
2. The left rail's heading changes to **Add to whose plan?** and every engineer row becomes
   `Add 3 →`.
3. **Click an engineer.** The work lands on their lane in the centre.

That is the whole thing. There are no lane numbers and no *"Select engineer…"* dropdown — the roster
*is* the target list, and the row that performs the assignment is the row that shows you what it costs.

### 13.5 What the draft shows you

**On the engineer's rail row:** `25 → 631 / 25` and `+606 staged`. Amber when the draft takes them at
or past capacity.

**On the draft lane:** *"Will be added to Rahul Verma — 606 devices"*, the coverage badge per plant,
the same `committed → after / capacity` figure, and the work as chips. **Take back** empties the lane.

**Chip grammar in the draft** (different from the board's, because it answers a different question):

| Form | Means |
|---|---|
| solid + dot | assignment **inside the engineer's own coverage** |
| dashed violet | a human **crossed a coverage tier** |
| heavy crimson + ⚑ | **critical work** |
| dashed crimson | the engineer covers this plant **at no tier at all** |
| amber lane | this draft takes them **at or past capacity** |

Critical work gets **its own chip** — `Kotputli Works ×3 crit` beside `Kotputli Works ×15` — because a
plant reading `×15` says nothing about whether any of it is on a clock.

**Nothing here is a gate.** Over capacity, a crossed tier and no coverage are all *states*. Manual
overload is an administrative right; the screen states the fact and lets you decide.

### 13.6 Two things that are easy to miss

**A plant is the unit of the write.** A site shared by two companies moves **all** of its unassigned
work together, whichever company's row you ticked. The row says so: *"shared site — all of its work
moves together"*, and the counters count the whole plant, because a draft that counted only the ticked
row would under-report its own commit.

**"Nobody can take this."** If you use **Spread across engineers…** (a projection across several
engineers at once), whatever it could not place stays in the draft region as a dashed rail:

- *no coverage* — none of the engineers you chose covers that plant at any tier
- *all dropped* — some do, and every one of them failed a readiness check

Those are different problems (a coverage gap versus a readiness gap) and the rail refuses to blur them
into "unassignable". These chips are deliberately un-actionable: nothing in your selection *can* take
them, and the fix is coverage or a freed-up engineer, not another click.

### 13.7 Leaving without committing

If your draft is empty, you leave immediately. If it is not:

> **606 devices are selected for 1 engineer and nothing has been written.** Leaving now hands out none
> of it.
> `[Keep drafting]` `[Leave and discard]`

The draft lives in this browser tab only and dies when you leave — that is by design. What is *not* by
design is losing it without being told what you are giving up.

### 13.8 Review, then commit

**Review & commit** resolves your plants into the exact ticket ids the write will move, and shows a
**diff, not a confirmation dialog**:

- **Committing** — how many devices, to how many engineers
- **Still unassigned after** — the residual, including *"n with no eligible engineer"*
- **Over capacity** — `allowed — not blocked`
- a per-engineer table: coverage used, plants, devices (`n crit`), load `25 → 631 / 25`, flags
- a **mandatory reason**
- when someone is being overloaded, it is stated in words: *"Rahul Verma is being taken to 25× daily
  capacity. This is allowed and will be recorded — it is not blocked."*

Nothing is written until you press **Commit n assignments**.

### 13.9 What "commit" actually does

`POST /schedules/assign-batch` runs **one transaction per engineer**, and answers with **one result row
per engineer**.

> There is no atomic "commit all". Three engineers can be written and a fourth can fail, and the
> receipt says so rather than averaging it away.

The receipt:

> **606 devices are now on 1 engineer's plan**
> Written one engineer at a time — each line below is its own transaction and its own result.
> To move any of this again, use the engineer's lane on the board — every row here is a normal
> assignment now, with its own audit trail.

Per lane you then see `assigned 604, 2 skipped`, and a skipped ticket held to a future date offers
**Resolve hold** in place — the same single-ticket confirm flow every other assign surface uses,
without touching the rest of the lane.

After a commit the Commit button is **gone** (the draft was consumed and the pool has moved
underneath it) and only **Done** remains. Leaving the mode puts you back on the board, which already
shows the work you just handed out.

### 13.10 The standalone `/assign` page

There is a second route, **Assign Work** in the sidebar and the top bar's **+ Assign SE** button. It
runs the *same* draft machine with one difference: **no zone scope**.

That is the whole reason it exists. A CSM or Operations Head sometimes needs to ask *"where in the
country is the work?"* — a different question from *"what is left in this zone today?"*. The Console's
Assign mode is deliberately clamped to the zone its board is showing, because a pan-India pool beside a
one-zone board is two panes disagreeing about where you are standing.

---

## 14. The day axis — past, today, future

`GET /dispatch/today` is **never given a date**. Instead, each column picks the source that can
honestly answer for it:

| Column | Source | Fidelity | Can you change it? |
|---|---|---|---|
| **Past** | `GET /schedules?date=` | committed **counts only** | **No** — immutable by construction |
| **Today** | the one lifted `GET /dispatch/today` | full — stops, chips, provenance, traces | **Yes** |
| **Future** | `GET /schedules?date=` if a plan exists, else `GET /schedules/preview?date=` | committed counts, else **ghost chips** | **No** |

Three consequences:

- **A past column is history.** Selection and drop are refused by construction, not by a permission
  error after the fact. For detail, open the run.
- **Committed beats projected.** A future day that already has a live plan shows it, badged
  `committed`, rather than a projection of what would happen.
- **A ghost chip is not a commitment.** It is ghosted, italic, muted, badged *projected*, and
  deliberately **not selectable** — there is no committed object behind it to inspect, no trace to
  explain, and no override to offer. The projection runs the *real* recommender, so it is a truthful
  answer to a conditional question, and it carries a `ranking as of …` watermark.

> **Holding a ticket back is the only pre-run lever**, and it lives on the Work Pool's held
> population — not on a future column.

---

## 15. How to read the numbers without being misled

The whole surface is built on a small set of honesty rules. Knowing them turns the screen from
"numbers" into "answers".

| Rule | What it means in practice |
|---|---|
| **`—` ≠ `0`** | a dash means *not recorded by this run*; a zero means *recorded and none* |
| **The counters are never summed** | eight populations with different owners do not add to one actionable number |
| **`policyWithheld` is a count, never a list** | that work has no recommendation and no trace; there is nothing to itemise |
| **Unknown provenance is drawn as unknown** | dotted, muted — never as a system decision |
| **`NOT_ENFORCED` is not `PASSED`** | a filter with no data source says so, and can never drop a candidate |
| **`not available` is not `0 km`** | no home base / no prior stop / no plant geometry |
| **"reason not recorded" is not a guess** | absence is a fact about the record |
| **One load definition, everywhere** | the People rail, the board, Assign mode, the review screen and the engine all read `committedDayPlan` |
| **Over capacity is a *state*, never a barrier** | dispatch will not pick them; a human may; nothing is ever disabled for it |
| **A projection is conditional mood** | *would be assigned*, never *is assigned* |

---

## 16. Roles — what changes, and what does not

**Every permission is enforced server-side.** Role variance in the Console is *rendering only*, and
controls a role does not have are **hidden, never disabled** — a greyed-out button advertises a
capability as broken rather than as belonging to someone else.

| | Zonal Manager | Central Service Manager | Operations Head |
|---|---|---|---|
| Zone | own zone, resolved from the token | must pick one | must pick one |
| Zone picker | **absent** | ✅ | ✅ |
| Board, rails, Inspector | ✅ | ✅ | ✅ |
| All eight write actions | ✅ | ✅ | ✅ |
| Run Now | ✅ *(clamped to own zone server-side)* | ✅ | ✅ |
| Assign mode | ✅ own zone | ✅ board's zone | ✅ board's zone |
| `/assign` pan-India pool | own zone | ✅ | ✅ |
| Bulk unassign (`/bulk-unassign`) | ✗ | ✗ | ✅ only |

**Acting as a zone.** A CSM or OH can work inside a zone via the `Act as ZM` control. That header is
honoured on the assignable-work read, the candidate read and the engineer list — so an acting OH sees
that zone's pool and that zone's engineers, not the national set. This matters: on a screen about what
is left in *this* zone, an acting OH reading pan-India is about to hand out another zone's work.

---

## 17. What reaches the engineer's phone

Be honest with your engineers about this, because the Console will not tell you.

**The data is correct and the endpoints are real.** `GET /api/schedules/me` serves the ordered,
plant-clustered day plan; `GET /api/me/tickets` serves assigned plus covered-pool work with removal and
deferral markers. Both are IST-day-scoped and both tolerate override states correctly.

**Delivery is not built.** As of this writing:

- **No push.** The external channel gateway returns `UNAVAILABLE` and logs the intent; the mobile app
  has no push dependency at all. *"Your Day Plan is live"* is written as an **in-app** row only.
- **Nothing on the handset ever asks again.** No pull-to-refresh, no focus refetch, no polling. Each
  screen fetches once on mount.
- **The session dies after 15 minutes.** There is no per-request token refresh, so a working handset on
  a working network starts rendering *"Offline"* over data that is perfectly fine on the server.
- **The server's change signal has no reader.** `removedFromPlanAt` / `deferredToDate` are published
  and unread; the client diffs consecutive fetches instead, which cannot see a change made while the
  app was closed.

**In practice:** an engineer sees whatever was true at cold start. A reassign you make at 11:00 is
invisible on their handset until they force-close and reopen the app — and if they logged in more than
fifteen minutes ago, reopening shows "Offline" until they log in again.

> **Operationally: if a change matters today, phone them.** Do not assume the Console's write reached
> the field.

---

## 18. Recipes — six common jobs

### A. "It's 09:00. What needs me?"

1. Open **Today's Dispatch**. Pick your zone if asked.
2. Read the **health band** first — a recovery notice or a crimson escalation strip outranks everything
   below it.
3. Read the **attention strip** (`⚠ n need attention`) and expand it if the number is non-zero.
4. Scan the **board** for amber cells (over-capacity engineers) and dashed chips (human overrides you
   may not have made).
5. Open the **Work Pool** → *Unassigned* to see what the engine could not place.

### B. "This critical ticket is unassigned — fix it"

1. Click its id in the escalation strip → the Inspector opens on it.
2. Read **Why** — was it *no coverage* or *all dropped*? They need different fixes.
3. Read **Alternatives** — dropped candidates are listed **with their reason**, and remain assignable.
4. Actions → **Assign**, pick an engineer, Confirm. If it is held, you get a second gate and a reason
   field.

### C. "This engineer went on leave"

1. Their rail row already shows the availability, and their work **still stands** — nothing was
   silently moved.
2. Select each **stop** on their lane → **Swap engineer** → pick a target → read the impact → give a
   reason → Confirm.
3. Swapping a whole stop is one write; reassigning ticket by ticket is many. Prefer the stop.

### D. "Hand out this morning's backlog"

1. Top bar → **Assign work**.
2. Tick sites in the right rail. Watch step ② and ③ move.
3. Click an engineer on the left for each batch. Watch `committed → after / capacity` on their row.
4. Click a plant's name to ask **Candidates** *"who can cover this?"* before committing to a choice.
5. **Review & commit** → read the diff → type a reason → **Commit**.
6. Read the receipt. It is per-engineer, and a failed lane says so.

### E. "Something is wrong with today's plan — why did the engine do that?"

1. Focused column header → **Run decisions →**.
2. The replay lists every decision **in the order the engine made them**, unassignable ones included.
3. Open any row's **Why?** for the candidates it compared, the tier, the filters and the score.
4. For the arithmetic itself, select the ticket and read the **score breakdown** — every term, its
   weight, and its contribution.

### F. "New critical tickets arrived since this morning"

1. **Run now** → read the notification warning → optional reason → **Run dispatch**.
2. If it reports **No new assignments**, that is not a failure — see §12.
3. If it refuses, the 409 names the zone, the start time and the holder.
4. Anything it still cannot place lands in the escalation strip or the Unassigned rail. Handle it by
   recipe B or D.

---

## 19. Glossary

| Term | Meaning |
|---|---|
| **Operating day** | the IST calendar day; the server owns which day is "today", never the browser |
| **Day plan** | one engineer's `WorkSchedule` for a day |
| **Stop** | one plant visit — a `PlantBatchAssignment`, with a sequence number |
| **Chip** | one ticket (one device) on a stop |
| **Committed load** | live day-plan stops for an engineer on a day, across every zone; what `daily_capacity` caps |
| **Coverage tier** | `DEDICATED` → `MULTI_PLANT` → `FLOATING`, in strict precedence |
| **Tier crossing** | a human assigned across that precedence when a stronger tier was still passing |
| **SLA bucket** | device severity: `WARNING` … `CRITICAL` … `LONG_PENDING` |
| **Critical+** | `CRITICAL` and `HIGH_CRITICAL` — the buckets that trigger escalation |
| **Chronic** | a device with ≥ threshold lifetime failure cycles — a *replace-or-investigate* question |
| **Catch-up / Steady** | the two recommender modes (`DEFICIT` / `PREVENTIVE`) |
| **Hold / deferral** | a ticket deliberately kept out of runs until a return date (inclusive) |
| **Escalation** | critical work with no capacity-eligible engineer, handed to a human |
| **Provenance** | who put a ticket on a plan — the engine, a person, or *not recorded* |
| **Draft** | Assign mode's staged, unwritten plan; lives in one browser tab and dies with it |
| **Projection** | the real recommender run against a future date, committing nothing |

---

## Where the code is

| Concern | Path |
|---|---|
| The Console page | `apps/admin/src/pages/dispatch/TodaysDispatchPage.tsx` |
| Its regions | `apps/admin/src/pages/dispatch/console/` |
| Assign mode + `/assign` | `apps/admin/src/pages/dispatch/console/AssignBoard.tsx`, `apps/admin/src/pages/assign/` |
| The draft state machine | `apps/admin/src/pages/assign/useAssignDraft.ts` |
| The run orchestration | `apps/backend/src/scheduling/dispatch-run.service.ts` |
| Selection and scoring | `apps/backend/src/recommender/` |
| The write | `apps/backend/src/scheduling/batch-assignment.service.ts` |
| Overrides | `apps/backend/src/scheduling/override.service.ts` |
| The Console's reads | `apps/backend/src/scheduling/dispatch-today-query.service.ts` |

**Design record** (historical — read for *why*, not for *what is true now*):
`docs/audits/scheduler-console-implementation-slice-2026-08-27.md` (phases and decisions D1–D8) and
`docs/audits/scheduler-console-ui-composition-correction.md` (composition, D9–D13, and §10's Assign
mode).
