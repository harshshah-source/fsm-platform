# Field Operations Director Review

**Target:** the implemented Scheduler Console — `apps/admin/src/pages/dispatch/TodaysDispatchPage.tsx`,
`pages/dispatch/console/*`, `pages/dispatch/CrewCard.tsx`, and Assign mode
(`pages/dispatch/console/AssignMode.tsx` → `pages/assign/AssignWorkspace.tsx`).
**Reviewed:** 2026-08-28, against the built source and the payload contracts it renders
(`dispatch-today-query.service.ts`, `dashboard.service.ts`, `assignable-work-query.service.ts`).
**Authority:** `CONTEXT.md` (Language + Decisions §7, §16, §17, §19, §21), then the slice spec.

> **Method, stated plainly.** This is a review of the *built implementation* — the components, the
> payloads they render, and the branches they take — not of the markdown design, and not a
> click-through of a live instance with seeded data. Every finding below names a file and a line and
> can be checked. Where a conclusion depends on data volume I say so rather than assert it.
> No code was changed during this pass.

---

## 1. Overall Verdict

**Ship with fixes.** This is the best operational surface in the product and it is not close. It
answers *what happened, why, and what can I do about it* on one screen, it refuses to invent numbers,
and in a dozen places it tells the truth where a lesser screen would have shown a comforting zero. The
teaching quality — the Run Now zero-result state, the Withheld-by-policy panel, the recovery notice,
the score breakdown — is genuinely unusual.

But it has **one P0 that costs me the thing I open this screen for**, and a second P0 that will make me
under-read my own backlog. Both are small fixes. Neither is a design problem; both are the last mile of
a grammar that is otherwise carefully built.

The headline: **I can see what the scheduler did. I cannot reliably see what is urgent, and I cannot
find a device by the name my engineer uses on the phone.**

---

## 2. Can a ZM use this effectively?

**Mostly yes — this is clearly the role it was built for.** No zone picker (correct: I have one zone,
a dropdown with one option teaches nothing). The board is my roster. The rails are my leftovers. Run
Now is mine now, clamped to my zone. Attention is scoped to me.

Where it fails me during a real day:

- **07:10, an SE calls in sick.** Setting SE availability is my job (`CONTEXT` — Zonal Manager: "set
  SE availability, approve leave"). The People rail *shows* me availability and I cannot *change* it,
  and there is no link to where I could. I leave the Console, hunt for `/engineers`, come back, and
  re-read the board. This is the single most common intra-day action a ZM takes and the Console has no
  door to it. **P1.**
- **09:30, an SE phones: "the unit on the Kotputli truck still isn't reporting."** I cannot find it.
  See §7 P0-1.
- **Any time I want to know why today looks the way it does.** Whether my zone is in **Catch-up**
  (deficit) or **Steady** (preventive) mode changes what the engine optimised for — clustering and
  throughput versus repeat offenders and Install backlog. That fact is on the *dashboard*
  (`ZoneOperatingModeTable`) and it is buried three clicks deep in the Console (select a ticket → Why →
  score breakdown, `ScoreBreakdownPanel.tsx:131`). On the screen that claims to be the operating-day
  workspace, my zone's operating mode should be in the frame. **P1.**

## 3. Can a CSM use this effectively?

**Yes, with one trap.** The zone picker is the fix that made this screen openable for me at all, and
the remembered-zone convenience is right.

The trap is the **acting cascade**, which is my defining behaviour. When I am acting for a ZM,
`authHeaders()` sends `X-Acting-As-Zone`, and `dispatch-today` throws `ZONE_SCOPE_VIOLATION` for any
zone that is not the one I am acting in. But `CAN_CHOOSE_ZONE` is decided from `session.role`, which is
still `CENTRAL_SERVICE_MANAGER` — so the picker still lists **every zone in the country**, and picking
any of them but the acting one drops me on *"Could not load the operating day"*. The error never says
*"you are acting in West; that is the only zone this screen can show you right now."* **P1.**

Second, smaller: `readLastZone()` is read once at mount (`TodaysDispatchPage.tsx:88`). A zone I looked
at last Tuesday loads today looking exactly like a zone I deliberately chose. The header names it and
the Run Now dialog names it again — that is a real mitigation — but a remembered zone should look
remembered. **P2.**

## 4. Can an OH use this effectively?

**Yes, and I should be honest that this screen is not really for me.** I run fleet-wide; this is a
zone-at-a-time surface and says so in words on the chooser (`ZonePicker.tsx` — *"There is no pan-India
dispatch view — the scheduler plans, and this screen reports, one zone at a time"*). That is the right
call and the right way to say it. I get everything a CSM gets. My genuine work — cross-zone
escalations, configuration, the fleet KPI — lives elsewhere and should.

One note: **`/assign` still gives me the pan-India assignable pool** and the Console deliberately does
not. That split is correct and I want it kept. But nothing on the Console *tells* me the other view
exists — Assign mode narrows silently. One line ("this zone only — `/assign` for all zones") would
close it. **P2.**

---

## 5. What is immediately understandable?

Credit where it is due. These read correctly on first sight, without training:

- **The recovery notice** (`TodaysDispatchPage.tsx:483`). Four states, each with a different sentence,
  attempts and last error shown for the two that need a human, and an explicit *"nothing further will
  be attempted automatically today."* This is how an operational alert should read.
- **Run Now.** The *"engineers are notified — mid-shift, if it is mid-shift"* warning is not a
  footnote, and it is the one consequence I cannot undo. The **zero-result state** is the best single
  piece of copy in the product: it explains that a second press placing nothing is *correct*, because
  the engine only looks at OPEN + UNASSIGNED work. Without it I would have concluded the scheduler was
  broken within a week.
- **Withheld by policy** as a count that explains itself and refuses to become a list.
- **The critical interception strip** — count, per-row SLA bucket, escalation time, and a verb.
- **The provenance legend, rendered on the surface.** A grammar nobody can read is decoration.
- **The chronic-device framing** — *"the question is whether to replace the unit rather than repair it
  again"* — is a genuinely operational sentence, and it is right that it does not promise a faster
  visit, because under the current engine no visit gets faster.
- **`PlanMode`'s** *"Holding a ticket back is the only change available before a run; approval was
  never required."* That sentence does more to teach Decisions §7 than the PRD does.

## 6. What is confusing?

- **Two words for "unassigned", two populations, one screen.** See §7 P0-2.
- **A chip's identity is a truncated ticket UUID; a rail row's identity is a device id.** Same objects,
  two vocabularies. See §7 P0-1.
- **"Adjusted"** on a stop (`CrewCard.tsx`, `stop.status === 'OVERRIDDEN'`) is a quiet word for *a
  human changed the engine's plan here*. It is the correct fact, undersold.
- **Replay says "What a past run did"** but `ReplayMode` only ever receives *today's* run
  (`run` comes from `latestRun(zoneId, day)`). It cannot replay a past day. The mode name promises
  history the mode does not hold; the actual history is behind the "All runs" link. **P2.**
- **Plan mode is a mode containing one link.** A whole third of the primary navigation resolves to a
  card and an "Open the projection" button. That is a navigation item wearing a mode's clothes. **P2.**

---

## 7. Critical operational risks

### 🔴 P0-1 — On the board, urgency is only visible when the engine placed the work

`CrewCard.tsx:20` computes `critical` from the SLA bucket, and `CrewCard.tsx:28` consults it **only
inside the `systemPlaced` branch.** Walk the three cases:

| Chip | Renders as |
|---|---|
| System-placed, CRITICAL | heavy crimson ✅ |
| **Human-placed, CRITICAL** | **plain dashed — identical to routine work** ❌ |
| **Unknown provenance, CRITICAL** | **dotted grey — identical to routine work** ❌ |

`SLABadge` is imported at `CrewCard.tsx:2` and **never rendered**. So the SLA bucket — the axis the
entire canonical sort is built on (`CONTEXT` Decisions §17: Company Tier → Device Bucket → Priority
Rank) — is absent from the board except as a side effect of provenance.

*Field impact:* the moment I reassign a CRITICAL ticket — which is exactly what the escalation strip
asks me to do — **it stops looking critical.** I hand it to Ramesh, it becomes a plain dashed chip
among fifteen others, and at 15:00 when I scan the board for what is still on a clock, it is invisible.
The same is true of every ticket written before provenance tracking existed. This is the screen I use
to answer *what should I do first*, and the answer degrades precisely as I do my job.

*Root cause, and why it is not a slip:* the grammar table fuses two independent facts —
**provenance** (who decided) and **urgency** (what is on a clock) — onto one border axis, and calls the
combined meaning "critical, direct-assigned". That is faithful to Decisions §21 for *system* CRITICAL
insertions and silently wrong for every other route a CRITICAL ticket takes onto a lane.

*Fix:* urgency needs its own axis, the way `RET` and `CHR ×n` already have theirs — an inline SLA token
on the chip, independent of border treatment. Do **not** spend a fourth border colour; #290 already
paid for that lesson.

### 🔴 P0-2 — "Unassigned" means two different things and both are on this screen

The Work rail's first tab is labelled **"Unassigned"** (`WorkRail.tsx:90`) over `rails.unassignable`,
which `unassignableToday()` builds from **decision traces of today's run where `se_id IS NULL`** — that
is, *work this run looked at and could not place.* It excludes everything the run never considered:
tickets raised after the run, work withheld below the assignment threshold (which gets no trace at
all), and anything the run skipped.

Assign mode's pool, one keystroke away, is `assignableTickets(day)` — **every OPEN + UNASSIGNED ticket
not held** — and its ledger is labelled **"Open unassigned"** (`AssignWorkspace.tsx:406`).

*Field impact:* the rail says `Unassigned 3`. I read that as *there are three loose ends in my zone
today.* I press Assign work and the ledger says `47`. One of those numbers is my actual backlog and the
screen gives me no way to know which. The metric strip, to its credit, calls the same population
**"Unassignable"** — so the Console already spells this population two ways *within one frame*. This is
the identical defect class that B5 fixed for the attention band and D4 fixed for the assign pool: two
panes on one screen disagreeing about how much trouble the zone is in.

*Fix:* the tab is not "Unassigned", it is **"Couldn't place"** (or "Unassignable", matching the counter
directly above it). One word, and the two populations stop competing.

### 🔴 P0-3 — The Attention band teaches a flow the platform retired

`ACTION_REQUIRED_CARDS` (`dashboard.service.ts:292-301`) still carries:

- `critical_insertions_awaiting_accept` — **"CRITICAL insertions awaiting SE Acceptance"**, urgency 3
- `manual_assignment_required` — "Manual assignment required (**retry exhausted**)"
- `unreviewed_batches` — "Auto-dispatched batches **awaiting review**", urgency 1

`CONTEXT.md` is explicit on all three. **SE Acceptance is retired** (Decisions §21 / #268, ratified
2026-08-20): *"a CRITICAL/HIGH_CRITICAL insertion is assigned directly… no offer, no accept/decline, no
acceptance window,"* and under _Avoid_: *"describing a CRITICAL insertion as something the SE accepts or
declines."* **Acceptance Timeout is retired** with it — *"No insertion is offered any more, so there is
nothing to time out."* And Decisions §7 / the Override entry: *"There is no Approve gate."*

`AttentionBand.tsx` renders these under a collapsed *"N categories are not counted yet"* — and
`CARD_DESTINATION` points `critical_insertions_awaiting_accept` at `/intraday`.

*Field impact:* the mitigation is real — they are unwired stubs behind a `<details>` — but a new ZM
opening the one screen we built to *teach the scheduler* reads "CRITICAL insertions awaiting SE
Acceptance" and concludes an SE can sit on critical work. They will then wait for an acceptance that
will never come, on the highest-urgency bucket we have. On any other screen this is stale copy. Here it
is mis-teaching, and #268 was fought precisely to remove that belief.

*Fix:* re-label or retire the three cards. `manual_assignment_required` still describes something real
(escalation with no eligible SE) and just needs its parenthetical dropped. The other two describe
nothing that exists.

---

## 8. Workflow problems

### 🟠 P1-1 — The escalation strip's action is dead in Assign mode
The critical interception strip renders at `TodaysDispatchPage.tsx:339`, **before and independent of**
the mode blocks — so it stays on screen inside Assign mode. Its `Assign this work →` button calls
`select({kind:'ticket'})`, which only sets `?sel=`; the Inspector that would render it is not mounted
while `assigning` is true (`:409`).

*Field impact:* in Assign mode I press the verb on the most urgent element of the screen and **nothing
happens.** No error, no panel, no navigation. I press it again. Then I stop trusting the strip. Of the
whole review this is the one dead control, and it is on CRITICAL work.

*Fix:* either exit Assign mode when an escalation row is actioned, or hide the strip's verbs while
drafting. Do not leave a live-looking button over a region that cannot answer it.

### 🟠 P1-2 — I cannot set SE availability from the Console
Covered in §2. The People rail states availability and offers no way to change it and no link to one.
The Engineer Inspector links only to `/schedules/:seId`. For the role that owns SE availability, this
is a daily round-trip out of the workspace and back.

### 🟠 P1-3 — Acting-zone versus the zone picker
Covered in §3. The picker offers zones that are guaranteed to 403 for an acting CSM, and the resulting
error does not name the cause.

### 🟠 P1-4 — The operating mode is not in the frame
Covered in §2. Catch-up versus Steady is the largest single explanation of *why today looks like this*,
and it is three clicks deep.

### 🟡 P2-1 — The change ledger truncates silently
`WorkRail.tsx:192` renders `changeRows.slice(0, 12)` with no "showing 12 of N". The adds/removes/swaps
counts sit directly above it, so on a busy day the header and the list visibly disagree and nothing
explains why. On a list whose whole purpose is *who changed my plan today*, silent truncation is the
wrong default.

### 🟡 P2-2 — The run badge does not say how the run was triggered
`run.trigger` is in the payload; the header badge shows only status and time
(`TodaysDispatchPage.tsx`, `Dispatched 05:02 · SUCCESS`). If a CSM pressed Run Now at 11:00 I see
"Dispatched 11:00 · SUCCESS" and cannot tell it was a human. Given that a manual run pushes work to
phones mid-shift, *who started this* is operational, not trivia.

---

## 9. Information-density problems

**Appropriately dense for an operations user — with one layout caveat.**

A full Live screen with a selection stacks: header (title · find · zone · run badge · next run · Run
now · refresh) → mode nav → 8 metrics → recovery → escalations → People │ Board │ Work → Inspector →
Attention. That is a lot of blocks, but each is compact, and an ops screen that fits on one page is an
ops screen that is hiding something. I would not thin this out.

Two real notes:

- **The grid breaks below 1280px** (`xl:grid-cols-[15rem_1fr_17rem]`). On a 1366-wide laptop it is fine;
  on anything narrower the three columns stack and the People rail pushes the board a full screen down.
  A ZM on a 1280×720 field laptop scrolls past their whole roster to reach the board. **P2.**
- **The strip is called "six counters" in the design and renders eight.** Cosmetic, but the two extras
  (`Component-blocked`, `No SLA bucket`) are exactly the two that render `—` for "not recorded", which
  is the subtlest distinction on the strip. They are correct; they are also the two most likely to be
  misread as zeros by someone scanning fast. **P3.**

---

## 10. Missing operational context

Things I expect on an operating-day workspace and cannot find:

| Missing | Why it matters in the field | Class |
|---|---|---|
| **Device / vehicle identity on the board** | Every field conversation is about a truck and a unit, never a ticket UUID | P0-1 |
| **Zone operating mode (Catch-up / Steady)** | The largest single explanation of today's shape | P1-4 |
| **SE availability control or link** | The ZM's most frequent intra-day action | P1-2 |
| **Days-on-plan / carry-forward** | See §12 | P1-5 |
| **SPECIAL (repeated-attempt) on the board** | See §12 | P1-6 |
| **Config in effect for this run** | `ConfigInEffectPanel` exists and renders only on `/dispatch-runs/:runId` | P2 |
| **Transporter on a stop** | `CONTEXT`: the SE contacts the **Transporter** to get vehicle access. Not on the stop, not in the Inspector | P2 |

The Transporter one is worth a sentence. When I am deciding whether to move a stop, *can the SE actually
get to the vehicles* is a Transporter-coordination question, and `CONTEXT` names Transporter as a
first-class field-use reference on Tickets. The Console shows me plant and device counts and never who
to ring.

---

## 11. Assign Mode review

**This is the strongest part of the slice and I would ship it as-is but for one dead control.**

What is right, and I want it on the record:

- **The mixed-commitment rule is structural, not conventional.** Assign mode replaces the board, both
  rails and the Inspector. Draft chips (write nothing until commit) and committed chips (write
  immediately) are never on screen together. There is no drag to forbid because there is nowhere to
  drag to. This is the correct answer to *"is the distinction between committed board and draft safe
  and obvious?"* — it is safe because it is impossible to confuse two things that cannot co-exist.
- **The banner is honest and constant across drafting and review:** *"Nothing is written until you
  commit — this draft lives in this browser tab only."* It does not imply a durability it lacks.
- **Zone scope is enforced on all three surfaces** — pool, ledger, and lane roster. Narrowing the pool
  and forgetting the roster would have offered me another zone's engineers for this zone's work; it
  doesn't.
- **The ledger is re-derived over the narrowed rows, not carried.** "21 unassigned" above five rows
  totalling five would have been worse than no ledger.
- **Changing the zone leaves Assign mode** rather than leaving the old zone's plants staged under the
  new zone's heading. That is the right trade: I lose a draft I was told was session-local, instead of
  committing another zone's work.
- **The review-and-commit screen is a diff, not a confirmation dialog**, with a mandatory reason, an
  over-capacity statement in words (*"allowed and will be recorded — it is not blocked"*), and per-lane
  itemised results including skips. Correct against `CONTEXT` — manual overload is an administrative
  right and must be *seen*, never *gated*.
- **Distribute projects before it drafts**, and the remainder it cannot place lands in the draft's own
  no-eligible-engineer rail rather than dying with the panel that reported it.

Findings:

- **P1-1** (escalation verb dead in Assign mode) — §8. This is the only thing I would call a defect.
- **P2:** the pool is plant-shaped, and the row says so when a site is shared (*"serves 2 companies —
  all of its unassigned work moves together"*). Good. But the **Critical+ filter is the only preset**.
  My real triage question is *oldest silent first*; `oldestInactivityHours` is rendered per row and
  cannot be sorted or filtered on. The pool sorts busiest-first, which is a volume question, not an SLA
  one.
- **P2:** nothing in Assign mode says the pan-India pool exists at `/assign` (§4).
- **P3:** the draft's lane test-ids (`lane-1`) and the board's (`lane-se-1`) collided before the modes
  were separated. They can no longer co-exist, so this is now only a naming hazard for the next person.

---

## 12. Historical / carry-forward review

**This is the weakest area of the Console, and it is the area a Field Ops Director lives in.**

The Console is deliberately not date-navigable — `istDate(now)`, always — and I accept that. The
scheduler plans today; a date picker would make "today" mean two things. But *not navigable to
yesterday* is not the same as *silent about yesterday*, and right now it is silent.

### 🟠 P1-5 — Nothing on the board says how long this work has been carried
The recommender re-plans OPEN + UNASSIGNED work every run, so yesterday's unfinished work simply
**reappears on today's board with no marker.** `TodayTicket` carries no first-seen date, no days-on-plan
count, and no carried-forward flag. A device that has been on a plan four days running looks exactly
like one raised this morning.

*Field impact:* the question I am judged on is Fleet Uptime, and Fleet Uptime is time-weighted. A device
silent four days costs four times a device silent one day. The board sorts and marks by none of that.
I cannot answer *what has been rotting* without opening tickets one at a time.

### 🟠 P1-6 — SPECIAL is one click deep and CHR is on the chip
The two "we keep going back and it is still broken" signals are split:

- **`CHR ×n`** (failure cycles on the device) is an inline chip token — good, and correctly *not* a
  colour, since #290 spent the last free hue.
- **SPECIAL** (`attempts.isSpecial` — the repeated-*visit-attempt* threshold, the actual domain term)
  appears **only in the Inspector's History band**, behind a selection and a tab.

These are different axes and both matter: CHR says *this unit keeps failing*, SPECIAL says *we keep
visiting and not fixing it*. The second is the one that means my process is broken rather than the
hardware. The chronic token's own comment says it "stays legible next to a SPECIAL badge" — which tells
me a SPECIAL badge was expected on the chip and never landed.

### What *is* there, and is good
- **`RET`** — vehicle due back today. Forward-looking, correct, cheap to read.
- **The Held rail** names the return date and whether a manager approved it.
- **The Changes tab** answers *who changed my plan today, and why* with resolved actor **names**, not
  UUIDs — with the truncation caveat at P2-1.
- **Replay** puts today's decisions in `processing_rank` order — the order the engine actually used —
  and lists unassignable decisions as decisions. Right call; listing only placements would show a run
  doing less than it did.

### Historical colour coding
There is no historical colour axis, and there should not be one — the grammar is full. What history
needs is **position and number** (days carried, attempts made), not another hue. Recording that here so
nobody "solves" §12 with a colour.

---

## 13. Attention Required review

**Structurally right, materially compromised by its own catalogue.**

Right:
- **Co-scoped with the deck.** `?zoneId=` was landed *before* the band that needs it. Beside a one-zone
  board a national count is not a filtering preference, it is a lie about how much trouble my zone is
  in — and a CSM would have acted on it.
- **A stub is not a zero.** Unwired cards render as *not counted yet*, sorted below live ones, behind a
  disclosure. Reporting the absence of a counter as the absence of work would be the worst thing this
  band could do.
- **Every live item names an owner and a verb.** A count with no verb is a worry, not a queue. And where
  no destination exists it says *"no queue page yet"* instead of inventing one.
- **`recovery_stalled` links to the unfiltered ticket list on purpose**, because `TicketsPage` ignores
  URL filters and a filtered-looking link that arrives unfiltered is worse than an honest one.

Wrong:
- **P0-3** — three of the nine cards describe retired flows (§7).
- **P2** — the band answers *"what needs a manager in this zone"* and sits **below** the Inspector, at
  the very bottom of a long page. On a busy day I will not scroll to it. Its urgency ranking is
  meaningless if its position is last.
- **P2** — `critical_insertions_awaiting_accept` links to `/intraday`, whose ledger half reads
  `MANUAL_ZM_UPDATE` audit rows that no admin code writes. Sending me to a structurally dead page from
  the attention queue compounds P0-3.

---

## 14. Explainability review

**This is the best-executed dimension in the whole slice, and it is why I would ship the Console at
all.** Taking the user's questions 3 and 4 in turn:

**Can I understand what the Scheduler decided?** Yes. The board is the decision. Stops are ordinal with
no fabricated clock — `CONTEXT` has no ETA model and the surface refuses to imply one. `OVERRIDDEN`
stops are marked. The rails account for everything that did *not* land, in four named populations, and
the counters trace to payload fields rather than to arithmetic done here.

**Can I understand why?** Yes, and further than I expected:
- **`DecisionTraceView`** for the chosen SE.
- **`CandidateColumn` reused verbatim, read-only**, tier-grouped in the engine's own precedence order
  with dropped candidates *shown* and their hard-filter reason named. A flat score-sorted list here
  would teach a false model of an engine that walks tiers — this one teaches the real model.
- **`ScoreBreakdownPanel`** shows the persisted feature and the persisted weight side by side, so the
  contribution is checkable rather than asserted. It shows **zero-weight terms rather than hiding
  them**, because a term that contributed nothing is a fact about how my zone is configured. It shows
  **the `max(base,0)` floor when it bites**, so I do not conclude the arithmetic is wrong. And it
  renders `repeat_failure_penalty` as a *term* and refuses to offer it as a lever, because it is a
  ticket property in a score that picks an engineer and therefore cancels across candidates.

That last one is the moment I decided this screen was built by someone who understood the engine. It
would have been very easy, and completely wrong, to give me a slider there.

**Provenance — can I distinguish scheduler / human / committed / projected / proposed?**

| Distinction | Verdict |
|---|---|
| Scheduler decision vs human decision | **Yes** — solid+dot vs dashed, with unknown drawn as *unknown* rather than as system. That rule is the one this grammar exists for and it holds. |
| Committed vs projected | **Yes, and structurally** — Live is committed, Plan is a projection behind its own mode and its own words, Assign mode's draft cannot share a screen with the committed board. |
| Proposed action | **Yes** — impact previews before Confirm where projectable; the endpoint refuses the other three with `NOT_PROJECTABLE` rather than answering zeros, because `0 → 0` would read as "removing this person's work costs nothing". |
| **Urgency** | **No — P0-1.** |

**One live grammar collision.** `Inspector.tsx:481` renders a tier crossing as
`<Badge tone="warning">` — **amber**. Every other surface renders a tier crossing **violet**
(`tone="tierCross"`), and amber means over capacity and nothing else. #290 was the slice that fixed
exactly this collision (over capacity was crimson, crossing was amber) across seven surfaces; the
Inspector's provenance badge was missed. Same fact, two colours, one screen. **P1-7.**

---

## 15. Run Now review

**Semantics are understandable, and this is a model of how to ship a dangerous button.**

- It is the **real trigger**, in the frame where I already am. It replaces a "Run dispatch" link that
  pointed at an `OPERATIONS_HEAD`-only route and silently bounced a ZM and a CSM to the dashboard — a
  prominent button that was broken for two of its three audiences.
- **Two-step, never one.** Idle → confirm dialog → running → result.
- **The notification warning is the headline of the dialog**, not a footnote. Correct: a mid-day run
  commits day plans through the same path as the 05:00 run, so it pushes work onto phones mid-shift.
  That is the one consequence I cannot undo and I am told before I press, not after.
- **The in-flight guard is a courtesy and the server is the authority** — pre-check disables the
  button, and the populated 409 is still handled.
- **The zero-result state is designed.** Already praised in §5; it is the difference between a manager
  who trusts the scheduler and one who doesn't.
- **Errors are per-zone and itemised.**
- Reason is optional here, and that is right — Run Now is not an override, it is a re-run of the same
  policy.

Findings:
- **P2-2** (§8): the run badge does not distinguish a CRON run from a manual one afterwards. The
  dialog warns me before; the board forgets after.
- **P3:** `RunNowControl`'s own docblock still says a ZM cannot call this and that the control is hidden
  for them. `#291` widened it with the clamp and `CAN_RUN_DISPATCH` includes `ZONAL_MANAGER`. Stale
  comment, correct behaviour — noting it only because the next reader will trust the comment.

---

## 16. Recommended changes

Ordered by field severity, not by effort.

| # | Change | Class |
|---|---|---|
| 1 | **Put the SLA bucket on the chip as its own inline token**, independent of provenance — `RET`/`CHR` idiom, not a fourth border colour | P0 |
| 2 | **Rename the Work rail's first tab** from "Unassigned" to "Couldn't place" (or "Unassignable", matching the counter above it) | P0 |
| 3 | **Re-label or retire the three retired-flow attention cards** — SE Acceptance, "retry exhausted", "awaiting review" | P0 |
| 4 | **Kill the dead escalation verb in Assign mode** — exit the mode on action, or hide the verbs while drafting | P1 |
| 5 | **Put the device id on the board chip** beside the ticket id, and make the find box match it | P1 |
| 6 | **Show the zone's operating mode (Catch-up / Steady) in the frame** | P1 |
| 7 | **Give the Engineer Inspector an SE-availability action or link** | P1 |
| 8 | **Fix the amber tier-crossing badge** at `Inspector.tsx:481` → `tone="tierCross"` | P1 |
| 9 | **Scope the zone picker to the acting zone**, or name the acting zone in the `ZONE_SCOPE_VIOLATION` error | P1 |
| 10 | **Add days-carried / SPECIAL to the board** — number and position, never a new colour | P1 |
| 11 | Move the Attention band above the Inspector, or make it sticky | P2 |
| 12 | Say "showing 12 of N" on the Changes tab | P2 |
| 13 | Show the run trigger (scheduled vs manual, and by whom) on the run badge | P2 |
| 14 | Rename Replay, or let it reach past days | P2 |
| 15 | Mark a remembered zone as remembered | P2 |

---

## 17. Must-fix before commit

I would fix **three** things before this branch lands. All three are label-or-token changes, none
touches an endpoint, and each is a case of the screen saying something untrue:

1. **P0-1 — SLA on the chip.** The board's job is *what should I do first*, and today it answers that
   correctly only for work no human has touched. This is the one finding that changes what I do during
   a shift.
2. **P0-2 — the "Unassigned" tab label.** One word. It currently causes me to under-read my own backlog
   by whatever the gap is between "the run couldn't place it" and "nobody holds it".
3. **P0-3 — the retired-flow attention cards.** `CONTEXT` names this exact wording under _Avoid_. On
   the screen we built to teach the scheduler, teaching a flow #268 deliberately removed is the one
   thing this Console must not do.

I would also take **P1-1 (the dead escalation verb in Assign mode)** in the same pass if it is as small
as it looks, because a dead button on CRITICAL work is how operators learn to stop pressing things.
I am not blocking on it.

**Everything else can land after the commit.** Nothing in §8, §10 or §12 is unsafe — they are gaps in
what the Console tells me, not errors in what it does. No write path is wrong. No override skips its
reason. No projection is presented as a commitment. Nothing here risks putting work on the wrong
engineer's phone.

## 18. Can safely wait until later

- **All of §12's carry-forward work (P1-5, P1-6).** It is the biggest *product* gap in the Console and
  it needs a payload change (`TodayTicket` carries neither a first-seen date nor `isSpecial`). That is a
  slice, not a fix, and it should be scoped properly rather than bolted on.
- **SE availability from the Console (P1-2)** — a real workflow gap, but the capability exists
  elsewhere and the round-trip is annoying rather than dangerous.
- **The operating-mode pill (P1-4)** and **the acting-zone picker scope (P1-3)** — both are one-session
  fixes; neither is unsafe today.
- **Every P2 and P3.** The layout breakpoint, the Changes truncation, the run trigger, Replay's name,
  Plan-as-a-mode, the Transporter, the remembered-zone marker, the eight-counters-called-six.
- **D7's route retirement.** Unrelated to this review and correctly still an open decision.

---

## 19. Final recommendation

**Ship with the three P0 label fixes. Do not hold the branch for anything else.**

This Console is the first surface in the platform that treats the scheduler as something a manager is
entitled to understand rather than something they must accept. It refuses to draw absence as knowledge
— unknown provenance renders as unknown, an unwired counter renders as *not counted*, a population the
engine never itemises stays a count. It moved the override controls rather than copying them, so there
is one implementation of every write. It puts the engine's own candidate order, its own drop reasons
and its own score terms in front of me, and then declines to give me a lever the engine would ignore.
Those are the decisions of people who understood that a dispatcher's trust is the actual product.

The gap between this and excellent is narrow and specific: **the screen explains the past better than
it flags the present.** I can reconstruct why the engine chose Ramesh at 05:02 in four clicks, and I
cannot see at a glance which of Ramesh's eleven devices is on a clock, how long any of them has been
waiting, or which one we have already failed to fix twice. Explainability is finished. **Triage is
not.**

Fix the three labels, land it, and make triage the next slice.

*— Field Service Operations Director, 2026-08-28*
