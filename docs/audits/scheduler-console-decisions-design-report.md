# Scheduler Decisions 1–5 — How They Will Function, and Whether They Are Good

> **Status: report only. No implementation was started and no code was changed.**
>
> **Date:** 2026-08-27 · **Branch:** `feat/autoplant-integration` · **HEAD:** `56f5aec`
>
> Follows `docs/audits/scheduler-console-product-vision-analysis.md` (cited as **A§n**), which
> established the findings these decisions respond to. This document takes the decisions as given and
> answers two questions for each: **how would it actually work**, and **is it a good idea**.
>
> Evidence tags as in A: `[CODE]` read from source during this pass · `[INFER]` reasoned ·
> `[OPEN]` unresolved.

---

## 0. The decisions, as taken

| # | Decision | Taken |
|---|---|---|
| **D1** | A device with **3+ failure episodes, each lasting more than 24 hours, opened within a rolling 7-day window**, goes onto a separate **"Repeated Inactive"** list, surfaced to managers. These devices **continue to be assigned exactly like any other device** — they are not removed from the scheduler. | 2026-08-27 |
| **D1a** | The repeat-failure job **stops setting `ESCALATED`**. Tickets currently stuck in `ESCALATED` *because of repeat failure* are moved back to `OPEN` so they re-enter dispatch. `ESCALATED` survives only for failed-verification cases. | 2026-08-27 |
| **D2** | `repeat_failure_penalty` is **left exactly as it is**. No change, no removal. Repeated failure gets **no priority treatment** in scheduling. | 2026-08-27 |
| **D4** | Build a **proper "Run Now"** control on the scheduler screen: zone-scoped, reason box, in-flight guard, result summary. **No** one-time scheduled runs, **no** pause/skip switch. | 2026-08-27 |
| **D5** | **All three manager roles** (Zonal Manager, Central Service Manager, Operations Head) may trigger a run. A **Zonal Manager is forced to their own zone, server-side** — they can never run another zone or trigger a pan-India run. | 2026-08-27 |

"Admin" throughout is read as **the three manager roles**, not a separate admin role.

---

## 1. Decision 1 — the Repeated Inactive list

### 1.1 The rule, stated precisely enough to build

A device is **Repeated Inactive** at any moment when, counting its failure episodes:

```
COUNT(failure episodes) >= 3
  WHERE  the episode opened within the last 7 days
    AND  the episode lasted more than 24 hours
           (closed_at − opened_at > 24h,  or  still open and now − opened_at > 24h)
```

Two things this deliberately does **not** do:

- **It does not look at whether an engineer was sent.** That is a different question and it already has an
  answer — "Special" (A§10.2), which counts *visits that failed*, not *failures*. The two lists are
  about different things and must not be merged. See §1.5.
- **It does not change anything about how the device is scheduled.** Per D2, a Repeated Inactive device
  is ranked and assigned by the ordinary rules. The list is *identification*, not *priority*.

### 1.2 How it will be computed — derived, never stored

**Recommendation: compute this on every read, exactly as "Special" does. Do not add a column, a flag,
or a list table for the membership itself.**

This is not a style preference — it is the reasoning #244 already recorded and validated, and it
applies here almost word for word `[CODE — special-ticket.query.ts:16-22]`:

| Property of this rule | Why a stored flag breaks |
|---|---|
| The window **rolls** | A device *falls off* the list as its old failures age past 7 days. A stored flag needs a writer to clear it, and the day that writer misses a run, a device is flagged chronic forever |
| An episode's duration **changes while it is open** | A device silent for 20 hours qualifies four hours later with nobody touching the row |
| The thresholds may be **tuned** (3, 24h, 7 days) | A change has to reclassify the whole fleet retroactively. A stored counter could only manage that with a recompute pass — and that pass becomes the thing that drifts |

With no writer there is no drift, no double-count, and nothing to undo. One SQL predicate, shared by
the badge, the list, the filter and the count — so the count on the dashboard card can never disagree
with the rows the list shows. That single-definition discipline is what `deferral.ts` exists to enforce
and what #153 is the cautionary tale for. `[CODE]`

**The one thing that does need to be stored** is *"we have already told a manager about this device."*
Without it, a daily alert re-announces the same twelve devices every morning until someone acts. That
is a small notification-suppression record keyed on `(deviceId, first qualified at)` — not a
membership table.

### 1.3 What actually changes

| Layer | Change | Size |
|---|---|---|
| Backend — new | One shared SQL predicate + a query service (`countFor(zone)`, `listFor(zone)`, `verdictFor(device)`), mirroring `SpecialTicketQueryService` | Small |
| Backend — new | Three settings so the rule is tunable, not hardcoded: episode count (3), minimum duration (24h), window (7 days) | Small |
| Backend — modify | `RepeatEscalationService` stops writing `ESCALATED`. What remains is the scan that decides who to notify | Small |
| Backend — modify | Light up the existing `action-required` card mechanism with a Repeated Inactive count (A§10.1 — 7 of its 9 cards are already stubs waiting for exactly this) | Small |
| Backend — one-off | The unwind migration — see §1.4 | **Needs care** |
| Frontend | A filter + badge on the existing ticket/device list, and a count card. **No new page.** The device table already carries every column this list needs — SLA bucket, last ping, assigned engineer, batch (A§13.2) | Small |

**Note what is not on this list: no new screen.** The device and ticket tables already render
everything a Repeated Inactive row needs. This is a filter and a badge over surfaces that exist —
the same shape #244 used, which is why #244 was cheap.

### 1.4 The ESCALATED unwind — and what it will do when it runs

**The discriminator exists and is reliable.** Every transition into `ESCALATED` writes a
`ticket_events` row naming its cause:

- repeat failure → `reasonCode: 'REPEAT_ESCALATION'` `[CODE — repeat-escalation.service.ts:67]`
- failed verification → `reasonCode: 'VERIFICATION_FRAUD_ESCALATED'` `[CODE — verification.service.ts:99]`

So "move the repeat-failure ones back, leave the fraud ones alone" is a precise query, not a guess.
This was the main thing that could have made D1a risky, and it does not.

**What will happen the moment it runs** — this is the part to plan for, not discover:

1. **A burst of auto-closures.** Auto-recovery only looks at `OPEN` tickets `[CODE —
   auto-recovery.service.ts:126-129]`. Some of these devices started reporting again weeks ago and
   their tickets have been sitting escalated, unable to close. The moment they return to `OPEN`, the
   next auto-recovery sweep will close them as self-healed. **This is correct behaviour and it will
   look alarming** — a spike of closures on the day of the migration, which will land in Fleet Uptime
   and the monthly cubes.
2. **A burst of new dispatchable work.** The rest re-enter the 05:00 pool. If there are 200 of them,
   the next run has 200 more eligible tickets than the previous one — spread across zones, competing
   for the same engineer capacity, and pushing other work out.
3. **Nothing at all**, if the number is small.

**Which of these happens is currently unknown.** Nobody has counted the `ESCALATED` rows in either
database (A§10.2). **Run that count before writing the migration, not after.** It determines whether
this is a one-line fix or a staged rollout — and if it is staged, the obvious stagger is by zone.

The migration should be **counted, audited, and reversible in principle**: one `ticket_events` row per
ticket recording the un-escalation with its own reason code, so the change is legible in every
ticket's history rather than appearing as an unexplained state change.

### 1.5 Is it good?

**The core is right, and it fixes a genuine defect.** A device that keeps breaking should not silently
vanish from the work list with no way back. Nothing about that is arguable.

**Three things that are genuinely good about this shape:**

- It reuses a proven pattern. "Identification first, derived not stored, one shared predicate" is
  exactly how Special was built, and Special has held up.
- It needs **no new screen and no new page** — which is the difference between a week and a month.
- It lights up machinery that is already half-built and currently rendering "coming soon" to your
  managers.

**Three things that are weak, stated plainly:**

**(a) The list gives visibility without a scheduler lever — and that is only fine if the real action
lives outside the scheduler.** Combined with D2, a manager opening this list can do exactly what they
could do for any other ticket: assign it manually, pin an engineer, override the company tier, or mark
the device non-operational. The scheduler itself will treat a device that broke three times this week
identically to one that broke once.

There is a good defence of that, and it is worth stating because it makes D1 and D2 coherent rather
than contradictory: **for a genuinely chronic device, "send someone sooner" is usually the wrong
answer.** Three failures in a week after three separate repairs is not a dispatch problem — it is a
hardware, warranty, installation-quality or root-cause problem. The list's real value is feeding a
*different* decision: replace the unit, escalate to the vendor, or take it non-operational. If that is
the intent, D1 + D2 are consistent and correct, and the list should be presented that way — as a
**replace-or-investigate queue**, not a dispatch queue.

If instead the expectation is that appearing on this list makes an engineer arrive sooner, **that will
not happen**, and D2 is the reason. That is the one place these two decisions could disappoint in use.

**(b) The name will collide with "Special", and the two are genuinely different.**

| | Counts | Means |
|---|---|---|
| **Repeated Inactive** (new) | Failure *episodes* on the device | *"This equipment keeps breaking."* |
| **Special** (exists) | Visits where the engineer arrived and filed nothing | *"We keep going and cannot fix it."* |

A device can be on both, and a device on one is not automatically on the other. Two similar-sounding
red badges on the same table with no explanation will be read as duplicates and one will be ignored.
**Each needs a one-line explainer at the point of display** — the rule, not the value (A§19 rule 5).
Consider naming the new one for what it is about — the equipment — rather than for the count.

**(c) The list may be nearly empty, and that is worth knowing before building.** Three episodes each
lasting over 24 hours, all opened inside 7 days, means more than 72 hours of downtime **plus** at least
two recovery gaps inside a 168-hour window. That is a genuinely chronic device — which is good for
signal quality and bad if it turns out to describe four devices nationally. `[INFER]`

**The same count that sizes the unwind also sizes the feature.** If the qualifying population is tiny,
the honest move is to loosen the rule (drop the 24-hour condition, or widen the window to 14 or 30
days) rather than ship a list nobody ever sees. Because the thresholds are settings (§1.3), that is a
tuning decision after launch — but it should be an informed one on day one.

### 1.6 The one question still open on D1

**Does "3 failures" mean 3 failures, or 3 *repeat* failures?**

The existing job counts only episodes flagged `repeat_failure = true` — meaning a failure *after a
previous failure had closed*. Under that reading, "3 repeats in 7 days" is really **the 4th or later
failure overall**. `[CODE — repeat-escalation.service.ts:31]`

- **Reading A — 3 repeat episodes** (keeps the existing predicate; stricter; a device must fail, be
  fixed, fail, be fixed, fail, be fixed, fail)
- **Reading B — 3 failure episodes of any kind** (plainer, matches the words "3 more failures", and
  produces a meaningfully larger list)

**I have assumed Reading B**, because it is what the decision literally says and because Reading A
combined with the 24-hour condition would make an already-small list smaller still. **Confirm or
correct this** — it is a one-word change in the predicate and a large change in the population.

---

## 2. Decision 2 — leaving `repeat_failure_penalty` alone

Taken and recorded. Two consequences, noted once and not argued:

1. The setting stays visible and editable in Settings as a tunable weight that **changes no decision**
   (A§10.2 — it is a ticket-level term in an engineer-level comparison, so it cancels out across all
   candidates). Anyone who tunes it later will believe they have changed something.
2. It continues to appear in every saved `score_breakdown`, so historical decision records will keep
   showing a penalty being applied that did not affect the outcome.

**Cheapest mitigation, if ever wanted:** one line of copy next to the field in Settings. No code, no
migration, no behaviour change. Not doing it is a legitimate call — it is recorded here so a future
reader does not treat the knob as live.

---

## 3. Decisions 4 + 5 — Run Now, for every manager, zone-clamped

### 3.1 How it will function

**Most of this already exists and works.** The Bulk Unassign page carries the only correct
Run-dispatch implementation in the app: zone selector, reason box, in-flight polling that disables the
button *with the reason shown before anyone presses it*, and a result summary.
`[CODE — BulkUnassignPage.tsx:75-79, 160-180]` D4 is largely **relocating a working component**, not
building one.

The end state:

```
Scheduler console header
   [ Run now ]        ← ZM: implicit own zone.  CSM/OH: zone picker, or all zones
      │
      ├─ disabled, with the reason, while a run holds the zone
      │     "North is being dispatched by a run started 05:00 by the scheduler"
      │
      └─ pressed → reason box (optional) → confirm
             │
             └─ result: "2 zones · 14 day plans · 61 tickets dispatched"
                    or  "0 new assignments — every eligible ticket is already on a plan"
```

**What has to change:**

| Change | Detail |
|---|---|
| Widen two role gates | `POST /schedules/dispatch-run` and `GET /schedules/dispatch-run/in-flight` from `OH, CSM` to all three manager roles `[CODE — schedules.controller.ts:192, 228]` |
| **Add the clamp** | See §3.2 — this is the load-bearing one |
| Clamp the in-flight read | A ZM sees their own zone's run status, not every zone's |
| Move the control | Onto the scheduler console; remove the button that currently navigates to the wrong page `[CODE — TodaysDispatchPage.tsx:424-426]` |
| Result copy | See §3.4 |

### 3.2 The clamp — the part that must not be skipped

`POST /schedules/dispatch-run` reads `zoneId` **straight from the request body and never checks it
against the caller's own zone**:

```ts
zoneId: body.zoneId != null ? BigInt(body.zoneId) : undefined,
```
`[CODE — schedules.controller.ts:196-205]`

That is safe today only because both permitted roles are global-scope. Widen the role gate without
adding a clamp and any Zonal Manager can rebuild another manager's day plans, or omit `zoneId`
entirely and **trigger a run across every zone in the country**.

The fix is small and belongs in the same change: when the caller's role is `ZONAL_MANAGER`, the zone
is taken from their token claims and the request body's value is **ignored, not validated**. Ignoring
rather than rejecting is the safer shape — it cannot be bypassed by a client that simply stops sending
the field.

This decision widens the RBAC ladder that `#272`/`#282` deliberately held closed (A§14). That is a
legitimate operator call and it has now been made — but it should be **recorded as an explicit
reversal** in the issue tracker, not slipped in as a role-list edit, so the next person to read those
rulings finds the reason.

### 3.3 Is it good?

**The mechanism is sound.** The safety properties are already correct and proven: one run may hold a
zone at a time; a second attempt gets a clean, populated refusal naming the zone, when the holding run
started (in IST) and who started it; three managers running three different zones simultaneously is
fine. `[CODE — dispatch-run.service.ts:365-425]`

**And it does not do the dangerous thing.** A re-run does **not** wipe and rebuild. New work is
*appended* to the end of each engineer's existing plan, and stop numbering continues from the last
stop, so a route the engineer is already driving is never reordered.
`[CODE — batch-assignment.service.ts:205-240]` A ticket already assigned cannot be picked up twice.
Pressing Run twice is close to a no-op.

**But here is the honest problem, and it is the main thing to design around:**

> **Most of the time, pressing Run Now will do nothing, and that is correct behaviour.**

The engine only looks at work that is `OPEN` **and** `UNASSIGNED`. If the morning run already placed
everything it could, a re-run has nothing to place. This is the same truth the Bulk Unassign page
already prints in its own warning:

> *"With roster, coverage, zones, availability and device states unchanged since the morning run,
> unassign-then-redispatch reproduces materially the same plan… This control pays only when dispatch
> inputs have changed — fix the data first, then press it."* `[CODE — BulkUnassignPage.tsx:20-25]`

**When it is genuinely valuable** — and these are real, frequent cases:

| Situation | Why Run Now earns its place |
|---|---|
| **A zone failed at 05:00 and its recovery is EXHAUSTED** | **This is the strongest case.** There is no "retry this zone" API. A manual run is the *only* human lever for a zone whose day plan never got built (A§4) |
| **Right after D1's unwind** | Hundreds of tickets return to `OPEN` — you will not want to wait until tomorrow morning |
| Coverage, capacity or availability was corrected | The morning run made its decision on the old data |
| The assignment threshold was changed | New policy should apply to the existing backlog now |
| New critical tickets arrived since 05:00 | Genuinely new work to place |

**The risk is not damage — it is disappointment.** A manager who presses Run because "engineers look
idle" and sees nothing happen will conclude the button is broken, then that the scheduler is broken.
That is a UI problem with a UI fix, and it is the single most important detail in D4.

A second, smaller effect worth knowing: a mid-day run **appends work to an engineer already driving a
route**, and they will be notified — day-plan notifications ride the same commit path as the morning
run, so a manual run notifies exactly as the 05:00 run does. `[CODE — batch-assignment.service.ts:65-81]`
That is the right behaviour, but it means Run Now is not a silent operation. Managers should know that
pressing it can move work onto someone's phone mid-shift.

### 3.4 What the UI must say — non-negotiable

1. **A zero result must be explained, never left blank.** "0 new assignments — every eligible ticket is
   already on a plan" is a *required* state, not a nicety. Without it, this control teaches managers
   that the scheduler is unreliable.
2. **The disabled state must carry its reason**, before the click. Already built — keep it.
3. **A Zonal Manager must not see a zone picker at all.** Their run is their zone, implicitly. Showing
   a picker with one option, or a picker they cannot change, teaches nothing (A§19 rule 3).
4. **Say what it will not do.** A short line near the control — *"Places newly available work. It will
   not rebuild or reorder plans already in progress."* — prevents the most likely misunderstanding and
   costs one sentence.

---

## 4. How the decisions interact

Two useful couplings, and one ordering constraint.

**D1's unwind is the best possible justification for D4.** Un-escalating a backlog of chronic tickets
puts a pile of work back in the pool mid-day. Without Run Now, nothing happens until 05:00 the next
morning. With it, a manager can place that work immediately. **Build them in that order and D4 has an
obvious first real use** rather than being a button in search of a reason.

**D2 sets the ceiling on D1's usefulness**, and that is a deliberate choice. See §1.5(a).

**Ordering constraint:** the working tree does not compile — one stray character in
`scheduler-preview.service.ts:221`, present since 26 Aug (A§0.1). **Nothing here can be built or
verified until that is removed.** It is a deletion, not a fix.

**Suggested sequence:**

```
0.  Delete the stray character.                                          minutes
1.  COUNT: ESCALATED tickets by age and zone.                            ~30 min SQL
    COUNT: devices matching the D1 rule today, under both readings (§1.6).
        ── these two numbers size everything below ──
2.  D4 + D5: relocate Run Now, widen roles, ADD THE CLAMP.               small
3.  D1: the derived predicate + settings + count card + filter/badge.    small
4.  D1a: the unwind migration — staged by zone if the count is large.    depends on step 1
5.  Press Run Now. Its first real job is placing what step 4 released.
```

---

## 5. What these decisions do *not* cover

Recorded so nothing is assumed settled that is not:

- **The console itself.** Whether the scheduler pages merge (A§29 P2/P3) is untouched by D1–D5. So is
  whether Assign Work comes inside.
- **The three orphaned surfaces** (ticket journey, telemetry drill-down, Special) — still not linked
  from any scheduler screen (A§0.2). Three links, still unbuilt.
- **The two role-blocking defects** — no zone picker for CSM/OH on the main screen; a Zonal Manager
  still cannot see when the run fires (A§2). D5 widens *who can run*; it does not tell a ZM *when the
  automatic run will happen*, which is the question that makes an empty 04:55 screen frightening.
- **Deferral approvals** — the audited approve/override queue is still invisible from the scheduler
  (A§10.4).
- **The engine's own explanation** — score breakdown and per-engineer pass/fail checks are still sent
  to the browser and discarded (A§18).

---

## 6. Open questions

| # | Question | Blocks |
|---|---|---|
| **Q1** | **3 failures, or 3 *repeat* failures?** (§1.6) — I have assumed the plainer reading: any 3 qualifying episodes | The predicate. One word; large population difference |
| **Q2** | Is the Repeated Inactive list a **replace-or-investigate queue** (§1.5a) or is an engineer visit expected to follow? The answer changes the copy, the placement, and whether D2 will satisfy in use | Framing, not code |
| **Q3** | What is it **called**? "Repeated Inactive" collides audibly with "Special" (§1.5b) | Naming |
| **Q4** | Should first qualification **notify** a manager, or is appearing in the list and count enough? A notification needs a suppression record; a list does not | Small scope |
| **Q5** | If the unwind count is large, **stage by zone or do it in one pass?** | Answerable only after the count in §4 step 1 |

---

*End of report. Nothing here was implemented. The counts in §4 step 1 are the next action, and they
are a database question, not a design one.*
