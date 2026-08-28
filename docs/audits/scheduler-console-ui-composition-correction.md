# Scheduler Console — UI Composition Correction

**Status:** ✅ **APPROVED AND IMPLEMENTED 2026-08-28.** The operator's "Final Product Direction and
Implementation" instruction of 2026-08-28 (the Engineer × Day scheduling-grid composition) approved
this plan, and stages **A–D** were built the same day: the three-region shell + top bar (A), the
`BoardGrid` engineer × day canvas with date navigation over the three honest sources (B), the
four-channel chip grammar with `CRIT` as an inline token and the amber tier-crossing fix (C), and
drag-and-drop as a dialog initiator (D). **Two deliberate deviations from the plan as written:**
**D12 was resolved the other way** — the operator's final-direction diagram keeps the Inspector as
the **bottom contextual band** (rendered only while something is selected, so §1.5's empty
placeholder is still gone; the right-rail slot is shared by the Work Pool and the Attention list
instead) — and the projection is fetched **only for the focused future day**, not for context
columns, because it runs the real recommender. **Stage E / D13 (the day-scoped board read) is
deferred**, exactly as §13.3 allows: past columns ship at count fidelity, and operational-state
fill, board-level carry-forward and chip device-ids wait on that read. Verification and outcomes:
the 2026-08-28 recomposition row in `.scratch/fsm-platform-v1/INDEX.md`'s session log.
**Written:** 2026-08-28, after the operator rejected the built composition as "not the Scheduler
Console product we agreed to build".
**Supersedes:** slice §2.1 (the four-region structure), §2.3 ("not date-navigable"),
§3.3 ("no drag in v1"), and the Phase 1–4 layout as built.
**Does not supersede:** any data contract, any write path, any RBAC rule, or the mixed-commitment
rule (§3.4), all of which survive intact.

---

## 0. Two things to settle before you read the plan

**0.1 — The reference designs are not in the repo.** The instruction says to re-read "the two
scheduler UI reference designs from the conversation". They are not in
`docs/ui/desktop/v2-reference/` or `docs/ui/desktop/approved-designs/`, and nothing image-shaped has
landed in `docs/` since 2026-08-20. So **this plan is written from your written description of the
reference UX** — left = people, centre = large calendar/scheduling board, right = unscheduled work —
not from the images.

This is the exact failure `approved-designs/README.md` already records against the Crew Deck: *"A
design discussed in a session but not committed here does not exist as far as the next session is
concerned — land it in this directory, or lose it."* **Please drop the two references into
`docs/ui/desktop/approved-designs/` before implementation starts.** If they disagree with anything
below, they win.

**0.2 — One backend ask, and the plan names it precisely.** You said not to add backend
functionality. Most of this correction is pure composition and needs nothing. But four of the things
you asked for — historical operational colour, the carry-forward marker, the device id on a chip,
and past days rendered as chips — **read fields that exist in the database and do not cross the
wire today**. They are one read, not a feature. §5.6 and §12.3 scope it exactly. Everything else in
this plan is buildable with zero backend change, and the plan is staged so you can approve the
composition without approving the read.

---

## 1. What is wrong with the current implementation

The critique is accepted. Stated precisely, so the fix targets the cause rather than the symptom:

**1.1 — The board is a column, not a canvas.** The layout is
`xl:grid-cols-[15rem_1fr_17rem]`. The scheduling board is the `1fr` between two fixed rails: on a
1440px viewport it gets roughly 830px, and inside that it renders `sm:grid-cols-2 2xl:grid-cols-3`
of `CrewCard`s. The dominant visual object on a scheduling product is therefore **about half the
screen, subdivided into cards**. Nothing about the composition says "this is a schedule".

**1.2 — Three vertical lists, not a grid.** People rail (a list), board (a grid of cards, each
containing a list of stops, each containing a list of chips), Work rail (tabs over a list). Four
levels of list nesting. The eye has no single plane to scan across.

**1.3 — The day axis does not exist.** The board's only axes are *engineer* and *stop order*. There
is no day. `/dispatch/today` reads `istDate(now)`, always, and §2.3 explicitly ruled the surface not
date-navigable. **A scheduling board with no time axis is a work list.** This is the root cause of
the "doesn't feel like a scheduler" reaction, and of the field-ops review's carry-forward findings —
both are the same missing axis seen from two directions.

**1.4 — Vertical stacking has become the answer to every requirement.** The live screen stacks:
header → mode nav → 8 metrics → recovery notice → escalation strip → three-column region →
Inspector (full-width) → Attention band (full-width). Each block was individually justified. The sum
is a tall dashboard in which the schedule is one band among eight.

**1.5 — The Inspector is a permanent full-width band.** It sits below the board and pushes the
Attention band off-screen. Even empty it renders a dashed placeholder occupying vertical space that
the board should own.

**1.6 — Identity is a truncated UUID.** Chips read `a1b2c3d4`. The rails read device ids. Confirmed
in the field-ops review as P0; it is a composition problem as much as a data one, because a chip
sized for 8 monospace characters cannot carry ticket + device + plant + state.

**1.7 — What is *not* wrong, and must survive.** The data contracts, the single lifted fetch and its
mutation→invalidation rule, every write path, the RBAC clamps, the zone scoping, the honesty rules
(absence never drawn as knowledge), the explainability stack, and the mixed-commitment rule. This is
a composition reset, not a rebuild. §3 lists what is kept verbatim.

---

## 2. The revised composition

```
┌─ TOP BAR ─────────────────────────────────────────────────────────────────────────────────────┐
│ Scheduler Console · Zone ▾ │ ‹ Prev  [ TODAY ]  Next ›  · Day│Week │ 🔍 find · filters ▾      │
│ Catch-up mode · Dispatched 05:02 ✓ · Next run 05:00 · [Run now] · ⚠ 6 needs attention ▸       │
├──────────────┬──────────────────────────────────────────────────────────┬─────────────────────┤
│ ENGINEERS 12 │  SCHEDULING BOARD          ◀ the dominant visual object  │ WORK POOL           │
│              │                                                          │  ── or ──           │
│ ⬤ RK  Ramesh │        Mon 25   Tue 26   Wed 27  │ THU 28 │ Fri 29       │ INSPECTOR           │
│    DEDICATED │      ┌────────┬────────┬────────┼────────┼────────┐      │ (same slot)         │
│    ▓▓▓▓▓░ 6/8│ Ramesh  ●●○     ●●●      ●●◐    │ T-102  │  ~T-140│      │                     │
│              │      │        │        │        │ D-7842 │ proj.  │      │ Unassigned    12    │
│ ⬤ SP  Sunita │      │        │        │        │ Pune   │        │      │ Held           3    │
│    MULTI     │      │        │        │        │ 🔴RET↗2│        │      │ Attention      6    │
│    ▓▓▓▓▓▓▓ 8/8│      │        │        │        ├────────┤        │      │ Changes        4    │
│    ⚠ at cap  │ Sunita  ●○○     ●●●      ●●●    │ T-118  │  ~T-151│      │                     │
│              │      │        │        │        │ D-3310 │        │      │ [search        ]    │
│ ⬤ AK  Arun   │      └────────┴────────┴────────┴────────┴────────┘      │ [chronic][crit]     │
│    FLOATING  │        history   history  history   LIVE    projected     │                     │
│    ▓░░░░ 1/8 │                                                          │  ⋮ rows             │
│    on leave  │                                                          │                     │
└──────────────┴──────────────────────────────────────────────────────────┴─────────────────────┘
   ~15rem                    ~ everything else                                    ~20rem
```

**The five rules this composition carries.**

1. **The board is the canvas.** Left rail fixed at ~15rem, right rail fixed at ~20rem, board takes
   all remaining width *and* all remaining height. It is the only region that grows.
2. **The board's axes are ENGINEER × DAY.** Rows are engineers, in the same order as the left rail.
   Columns are operating days. Cells hold the stops/tickets for that engineer on that day.
3. **The right rail is one slot with two occupants** — Work Pool by default, Inspector on selection.
   Never both, never a fourth column. This is what buys the board its width.
4. **Nothing else is full-width.** Attention collapses into a top-bar strip that expands into the
   right rail. The situation counters collapse into the top bar and the column headers.
5. **One day column is "focused" and rendered at full fidelity**; the others are context. Which day
   is focused is what Prev/Today/Next changes. See §6 — this is not a stylistic choice, it is forced
   by which data source can answer for which day.

---

## 3. What stays

Kept **verbatim**, no changes:

| Kept | Why it survives a composition reset |
|---|---|
| Every data contract and write path | This is a layout change. No endpoint moves. |
| `useConsoleData` + the mutation→invalidation rule | Four regions reading one payload is *more* important on a denser board, not less |
| `ActionsBand` — all six overrides, assign/hold/release, both 409 gates, impact preview | The entire override flow moves location and changes nothing else |
| `Inspector`'s bands: Identity / Why / Alternatives / History | Composed into the right rail instead of a full-width band |
| `ScoreBreakdownPanel`, `DecisionTraceView`, `CandidateColumn` (read-only) | The explainability stack is the best part of the build |
| `RunNowControl` in full — in-flight guard, notify warning, zero-result state | Moves into the top bar; behaviour identical |
| `AssignWorkspace` + its five components + the mixed-commitment rule | §10 |
| `ZonePicker` + remembered zone, `NextRunPill` | Move into the top bar |
| `LoadBadge`, `isOverCapacity`, `committedDayPlan` as the single load definition | One definition of capacity, everywhere |
| Zone scoping, the ZM clamp, hide-don't-disable, D4's narrowing | Unchanged |
| Every honesty rule | `policyWithheld` stays a count; unknown provenance stays unknown; unwired counters stay "not counted"; `NOT_PROJECTABLE` still loses the panel and keeps Confirm |

---

## 4. What moves

| Element | From | To | Note |
|---|---|---|---|
| **Zone picker, run badge, next-run pill, Run Now, find box** | `PageHeader` actions, wrapping onto 2–3 lines | **Top bar**, one row, compact | No behaviour change |
| **Situation counters** (8 in a `MetricStrip`) | Full-width band under the nav | **Split**: `placed`/`unassignable`/`held` become the Work Pool's tab counts; `overCapacity` is already visible per engineer in the left rail; `criticalNeedsYou` folds into the Attention strip; `changesToday` is a Work Pool tab; the two nullable ones move into a top-bar "run facts" popover that keeps their `—` vs `0` distinction | The strip is the clearest case of §1.4 — eight numbers competing with the board |
| **Inspector** | Permanent full-width band below the board | **Right rail**, replacing the Work Pool on selection | §9 |
| **Attention band** | Full-width band at the very bottom | **Top-bar strip** (`⚠ 6 needs attention`) expanding into the right rail | §11 — the field-ops review found it unreadably positioned at the bottom |
| **Plan / Live / Replay mode nav** | Three-mode segmented nav | **Dissolved into the day axis.** Plan = a future column. Live = the today column. Replay = a past column plus the "Run detail" link | §6. This removes a whole navigation concept and replaces it with something more legible |
| **Escalation strip** | Full-width crimson band | Stays visible but **compact**, docked under the top bar; its rows drive the Inspector like any other selection | Fixes the field-ops P1: its verbs are dead in Assign mode today |
| **Recovery notice** | Full-width band | Stays full-width **when present** | It is rare, it is a statement about whether the day is intact, and it earns the space |
| **`ProvenanceLegend`** | Under the board | Into a **`?` popover** in the top bar, alongside the new operational-state key | A legend is reference, not content |

---

## 5. What is removed from the primary viewport

Removed from the default view. **None of this is deleted** — every one remains reachable.

1. **The mode nav** (§4). Replaced by the day axis.
2. **`PlanMode`'s card.** It was a mode containing one link. The projection becomes a future column;
   the "Open the projection" link moves into that column's header.
3. **`ReplayMode`'s decision list.** Becomes the focused-past-day column's detail, reached from the
   column header ("Run detail →", "All runs →").
4. **Six of eight situation counters** as standalone tiles (§4).
5. **The empty-Inspector placeholder.** No selection = the right rail shows the Work Pool. The
   dashed "select something" card costs vertical space to say nothing.
6. **The `ProvenanceLegend` strip** → popover.
7. **The standalone "Refresh" button.** Every mutation already invalidates the lifted fetch; a manual
   refresh belongs in the run-facts popover, not beside Run Now where it competes with it.

**Explicitly NOT removed:** the Withheld-by-policy panel (it is the honest statement about a
population that is never itemised, and it belongs in the Work Pool), the chronic filter, the
per-row drop reasons, or any empty/error state.

---

## 6. How date navigation works

This is the largest change and the one with a real constraint behind it. **The composition is
driven by which data source can honestly answer for which day.**

### 6.1 Three semantic states, three sources — all existing

| Column | Source (all exist today) | What it can render | Mood |
|---|---|---|---|
| **Past** | `GET /schedules?date=` → `apiListSchedules(date)` | **Counts only** — `batchCount`, `ticketCount` per SE per day | Committed, immutable, past tense |
| **Past, deeper** | `GET /dispatch-runs/:runId` + `/dispatch-runs/:runId/zones/:zoneId` + `/batches/:batchId` | The run's decisions in `processing_rank` order, per-batch detail | Immutable ledger |
| **Today** | `GET /dispatch/today?zoneId=` → `apiDispatchToday` | **Everything** — stops, chips, provenance, capacity, rails, escalations, recovery | Live, mutable |
| **Future** | `GET /schedules/preview?date=` → `getSchedulerPreview(date)` | **`plan[]` = `{seId, plants:[{plantId, ticketIds}]}` — a real per-engineer projected board**, plus `mode`, `bucketsAsOf`, `recommended`/`unassignable`/`withheldBelowThreshold` | Conditional — "would be assigned" |

**The good surprise:** the projection already returns a per-engineer, per-plant, per-ticket plan. A
**future column renders as chips with no backend change at all.** It also carries `mode`, which is
the Catch-up/Steady fact the field-ops review wanted in the frame — free.

**The one gap:** a **past day cannot be rendered as chips** from any existing read. `listSchedules`
returns counts. That is the whole of the backend ask (§12.3).

### 6.2 The interaction

- **`‹ Prev · TODAY · Next ›`** in the top bar moves the **focused day**.
- The focused day is rendered at that day's **maximum available fidelity** and is the widest column.
- Surrounding days render as **context columns**: density dots for a past day (from counts),
  ghosted chips for a future day (from the projection).
- **`Day | Week`** toggles how many context columns are shown. Day = focused column plus one either
  side. Week = seven columns, the focused one wide.
- **`TODAY` is always one click away** and is visually distinct (it is the only mutable column).

### 6.3 The rules that protect backend truth

1. **`GET /dispatch/today` is never given a date.** It stays `istDate(now)`. The Console picks a
   source by semantic state; it does not teach an endpoint to lie.
2. **A future column is a projection and says so** — ghosted treatment, the word *projected*, the
   `bucketsAsOf` watermark rendered as an as-of caveat, and **no write actions** except Hold, which
   is genuinely the only pre-run lever.
3. **A future column that has a *committed* schedule shows it as committed, not projected.**
   `apiListSchedules(date)` answers this for any future date; where a live `WorkSchedule` covers it,
   that column is committed.
4. **A past column is immutable.** No override controls. Selection opens the Inspector in read-only
   history mode. This is not a permission rule (the backend would refuse anyway) — it is a mood rule.
5. **Staging.** Until §12.3's read lands, past columns render at **count fidelity** with an explicit
   "counts only — open the run for detail" affordance. That is honest and shippable. It is not
   pretending to be a chip board.

---

## 7. How historical colours work

**Accepted: historical days stay fully colour-coded, never grayscale.** The immutability of a past
day is carried by *mood* (no action buttons, past-tense labels), never by desaturation. A greyed-out
history is unreadable precisely when a manager most needs to scan it.

### 7.1 The four operational states, and where they come from

All four are real, derived from data that exists. **`SoftState` + `Ticket.status`, exactly as
`CONTEXT.md` defines them** — and note CONTEXT's rule that Activity Status is *derived, never
stored*, so this is a read-side derivation and no new column:

| State | Derived from | Meaning to the operator |
|---|---|---|
| **Not troubleshooted** | Ticket `OPEN`, no soft state (or only `VIEWED`) | Scheduled, nobody has started |
| **Troubleshooting started** | Soft state `TROUBLESHOOT_STARTED`, unresolved | Work is under way |
| **Active / on site** | Soft state `ON_SITE`, unresolved | The SE is physically there |
| **Completed** | Ticket `SUBMITTED` / `VERIFICATION_PENDING` / `CLOSED*` | Done, or awaiting verification |

`VIEWED` carries a `timeoutAt` and clears; `ON_SITE` and `TROUBLESHOOT_STARTED` never time-expire and
resolve only on explicit events. The Console must honour that — a stale `ON_SITE` is a real signal,
not a rendering bug, and must not be aged out client-side.

### 7.2 The colour axis this occupies — and the collision it would have caused

**Operational state takes the fill/background of the chip. It is the only thing that does.** This is
the single most important rule in this document, because the existing grammar has no free colour and
#290 already paid once for a collision in it.

### 7.3 The corrected grammar — four independent channels

| Channel | Carries | Values |
|---|---|---|
| **Chip FILL / background** | **Operational state** *(new axis)* | not started · started · on site · completed |
| **Chip BORDER STYLE** | **Provenance** *(existing, unchanged)* | solid+dot = scheduler · dashed = human · dashed violet = human crossed a coverage tier · dotted = not recorded |
| **Inline TOKENS** | **Urgency, carry-forward, repeat, return** | `🔴 CRIT` · `↗ 2d` · `CHR ×4` · `SPECIAL` · `RET` |
| **LANE / cell treatment** | **Capacity** *(existing, unchanged)* | amber cell = engineer at or over capacity on that day |

Four channels, four meanings, no overlap. Every one survives grayscale: fill has a distinct pattern
per state, border style is already shape-based, tokens carry words and numbers, and capacity is a
cell treatment plus the `n/cap` badge.

**This is also the fix for the field-ops P0.** Urgency stops being a *border colour reachable only
when the engine placed the work* and becomes an **inline token that renders on every chip
regardless of who assigned it** — exactly as instruction §10 requires. `SLABadge` already exists at
`components/domain/badges` and is imported-but-unused in `CrewCard.tsx:2`.

---

## 8. How carry-forward works

**Fully backed by real data. No invented history, no new table, no migration.**

### 8.1 The source

`BatchAssignmentTicket` (`batch_assignment_tickets`) is an append-only assignment-window log:
`createdAt`, `removedAt`, `removalReason`, `addedBy`, `addSource`. Joined through
`PlantBatchAssignment` → `WorkSchedule.dateFrom`, it yields **every operating day a ticket was on a
plan, and why it stopped being live on each.**

`#244` already computes exactly this and exposes it at **`GET /tickets/:id/attempts`**
(`apiTicketAttempts`) as `TicketAttempt[]` — `{ attemptId, seId, seName, openedAt, closedAt,
removalReason, reached, submitted, countable }` plus `countableAttempts`, `threshold`, `isSpecial`.

**So carry-forward is not new logic. It is an existing computation that is currently per-ticket and
needs to be per-board.** The precedent for batching it exists too: `TicketRow` on the ticket-list
contract already carries `isSpecial` and `specialAttempts` server-side and zone-scoped.

### 8.2 The definition

> A ticket is **carried forward** on day D when it was on a committed plan for at least one operating
> day before D, that window closed without a submission, and the ticket is on a plan again on D.

- **Days carried** = count of prior closed windows that did not submit.
- **Carried from** = `openedAt` of the earliest such window.

### 8.3 The marker

An inline token in the `RET` / `CHR ×n` idiom — **not a colour, not a border**:

```
↗ 2d        title: "Carried forward — on a plan since 26 Aug, 2 previous days, not completed"
```

Rendered on the chip, on every column that has the data. The Inspector's History band already shows
the full attempt list underneath it, unchanged.

### 8.4 What it must not do

- **Not conflated with `CHR ×n`.** Chronic = *this unit keeps failing over its lifetime* (failure
  cycles). Carry-forward = *this specific work keeps not getting done*. Different axes, both shown.
- **Not conflated with `SPECIAL`.** Special is the *countable reached-attempt* threshold verdict with
  an operator-visible threshold. Carry-forward counts *scheduled days*, whether or not the SE
  arrived. A ticket can be carried 3 days with 0 attempts — that is a dispatch problem, not a repair
  problem, and the two must stay distinguishable.
- **Not inferred where the data is absent.** Pre-`#241` history has no windows. Absent evidence
  renders **no token**, never `↗ 0`.

---

## 9. How the Inspector works

**One right-rail slot, two occupants, never a fourth column.**

- **Default:** Work Pool.
- **On selection** of ticket / device / stop / engineer / attention item: the rail becomes the
  Inspector, with a **`‹ Back to work pool`** affordance. Selection stays URL-reflected (`?sel=`),
  which is already built and already shareable.
- **On `Esc` or Close:** back to the Work Pool.
- The board and both rails keep their widths. **Nothing reflows when the Inspector opens** — this is
  the point of the shared slot, and it is what stops the Console feeling like it rearranges itself.

**Contents — all existing components, recomposed vertically for a ~20rem rail:**

| Band | Component | Change |
|---|---|---|
| Identity | `Facts` + `ProvenanceFact` | Add device id, plant, operational state. **Fix `Inspector.tsx:481`**: tier crossing must be `tone="tierCross"` (violet), not `warning` (amber) — the live collision the field-ops review found |
| Why | `DecisionTraceView` | Unchanged |
| Score | `ScoreBreakdownPanel` | Unchanged |
| Candidates | `CandidateColumn` (read-only, `onAssign` omitted) | Unchanged. Already narrow-friendly — it is a column by construction |
| Filters | The hard-filter drop reasons inside `CandidateColumn` | Already rendered; surface the tier headings as the "filters" view |
| History | Lifecycle + `TicketAttemptHistory` | Now also the carry-forward evidence (§8) |
| Actions | `ActionsBand` — `TicketActions` / `StopActions` | Unchanged, including `placementOf`'s hidden-not-disabled legal set. **Read-only on a past or projected column** |
| Impact | `OverrideImpactPanel` via `useOverridePreview` | Unchanged, including `NOT_PROJECTABLE` losing the panel and keeping Confirm |

Bands become an accordion rather than a tab row in a narrow rail; **Why is open by default**.

---

## 10. How Assign Mode works

**Kept as a mode of the same Console, and it now fits the composition better than it did.**

- **Entered** from the top bar, still `?assign=1`, still Live-only.
- **The frame stays** — top bar, zone, day axis, run state, attention strip. It must feel like the
  same product, which is what the instruction asks and what the current full-region takeover does
  not quite deliver.
- **The composition maps one-to-one onto the three regions**, which is why this gets *simpler*:

| Region | Normal mode | Assign mode |
|---|---|---|
| **Left** | Engineer roster | Engineer roster — **unchanged**, and it is the lane-target list |
| **Centre** | Committed board | **Draft lanes** — the same engineer rows, the same grid, holding draft chips |
| **Right** | Work Pool / Inspector | **Assignable pool**, and Candidates on focus |

- **The mixed-commitment rule (§3.4) still holds and is still structural.** The centre shows *either*
  committed lanes *or* draft lanes, never both. A draft chip and a committed chip never share a lane
  object. Draft chips are visually distinct (draft treatment + "nothing written yet" banner).
- **Review & commit** is `ReviewCommitScreen`, unchanged — a diff, not a dialog, with its mandatory
  reason and per-lane itemised results.
- **Zone scope (D4) unchanged**: pool, ledger and roster all narrowed; `/assign` keeps pan-India.
- **Fixes the field-ops P1**: because the escalation strip and the attention strip now live in the
  top bar and drive the *right rail*, their verbs work in Assign mode instead of being dead controls.
- Assign mode is **day-scoped to today**. Drafting against a past day is meaningless; drafting
  against a future day is what the projection and Hold are for.

---

## 11. How Attention works

**A compact top-bar strip that expands into the right rail.**

```
⚠ 6 need attention   ·  3 chronic · 2 approvals · 1 recovery            ▸
```

- Collapsed: one line in the top bar, with the total and the two or three largest categories.
- Click → the right rail becomes the Attention list (same slot as the Inspector, §9).
- Click an item → the Inspector for that object, or navigation to the page that owns it.
- **Everything the current band does correctly is kept**: zone co-scoping (B5), urgency ordering,
  "not counted yet" ≠ "0", every live item carrying an owner and a verb, and the honest
  "no queue page yet" where no destination exists.
- **Must be fixed while it moves** (field-ops P0-3): three of the nine cards describe flows
  `CONTEXT.md` says no longer exist — `critical_insertions_awaiting_accept` ("awaiting SE
  Acceptance", retired by Decisions §21), `manual_assignment_required` ("retry exhausted", retired
  with Acceptance Timeout), and `unreviewed_batches` ("awaiting review", the gate Decisions §7
  removed). Label fixes only.

---

## 12. Drag and drop

**Accepted as a V1 interaction, and only under the constraint you stated.** This reverses slice
§3.3's "no drag in v1" — which itself allowed exactly this: *"it can be proposed later as a dialog
**initiator** only."*

### 12.1 The contract

```
drag chip  →  drop on (engineer × day) cell
           →  NOTHING IS WRITTEN
           →  the authoritative action dialog opens, PREFILLED (target SE, target day, ticket/stop)
           →  the same validation the typed path runs
           →  impact preview where projectable (NOT_PROJECTABLE simply loses the panel)
           →  mandatory reason
           →  Confirm
           →  the existing endpoint  (POST /batches/:id/override — no new write path)
           →  invalidate the lifted fetch
```

**Never commit on mouse release.** Release opens a dialog; `Esc` or Cancel leaves the board exactly
as it was.

### 12.2 What drop maps to

| Dragged | Dropped on | Opens |
|---|---|---|
| Ticket chip | another engineer, same day | `REASSIGN`, prefilled |
| Ticket chip | same engineer, a later day | `DEFER_TICKET`, date prefilled |
| Stop | another engineer, same day | `SWAP_SE`, prefilled |
| Ticket chip | the Work Pool | `REMOVE_TICKET`, prefilled |
| Work Pool row | an engineer cell | `ASSIGN`, prefilled |
| Draft chip (Assign mode) | a draft lane | pure client-side draft move — **writes nothing by design** |

### 12.3 Where drop is refused

Onto a **past column** (immutable) or a **projected column** (nothing to override — Hold is the only
pre-run lever). Refusal is a cursor state and a cell treatment during drag, not an error after it.

Keyboard and click paths remain complete and authoritative. **Drag is an accelerator; it is never the
only way to do anything.**

---

## 13. Exact components and APIs to reuse

### 13.1 Reused as-is (no change)

**Components** — `pages/dispatch/console/`: `Inspector`, `ActionsBand` (`TicketActions`,
`StopActions`, `OverrideForm`, `AssignForm`, `HoldForm`, `ReleaseHoldButton`, `useOverridePreview`),
`ScoreBreakdownPanel`, `RunNowControl`, `NextRunPill`, `ZonePicker` + `readLastZone`/`rememberZone`,
`useConsoleData`, `selection.ts`. `pages/dispatch/`: `DecisionTraceView`, `format.ts`.
`pages/assign/`: `AssignWorkspace`, `CandidateColumn`, `DistributePanel`, `ReviewCommitScreen`,
`LaneCoverage`, `grammar.tsx`. Shared: `OverrideImpactPanel`, `LoadBadge`, `SLABadge`, `Badge`,
`MetricStrip`, `Skeleton`, `EmptyState`, `lib/capacity`, `lib/plantNames`.

**APIs** — `apiDispatchToday`, `apiDispatchChangesToday`, `apiListSchedules(date)`,
`getSchedulerPreview(date)`, `apiDispatchRunDecisions`, `apiDispatchTicketTrace`, `apiCandidates`,
`apiTicketDetail`, `apiTicketAttempts`, `apiOverrideBatch`, `apiOverridePreview`, `apiAssignTicket`,
`apiZoneEngineers`, `placeHold`, `releaseHold`, `apiActionRequired(zoneId)`, `apiAssignableWork`,
`apiAssignBatch`, `apiAssignableTickets`, `apiDistributePreview`, `runDispatch`,
`getDispatchInFlight`, `getDispatchSchedule`, `listZones`.

### 13.2 Recomposed (same data, new layout)

| Now | Becomes |
|---|---|
| `PeopleRail` | Left roster with initials avatar, coverage, capacity bar, availability, warnings |
| `CrewCard` + `TicketChip` | **`BoardGrid` + `BoardCell` + `WorkChip`** — the chip keeps `chipTreatment`'s provenance logic verbatim and gains fill (state) and tokens (SLA / carry-forward) |
| `WorkRail` | Right-rail Work Pool, same four populations, same rules, same chronic toggle and Withheld panel |
| `AttentionBand` | Top-bar strip + right-rail expansion |
| `TodaysDispatchPage` | Top bar + three-region shell + day-axis state |

**No avatar photo exists.** `User` has `userId, name, role, zoneId, phone, email, status` — no image
field. Use **initials in a coloured disc**, derived from `name`. A real photo needs a schema change
and an upload path; out of scope, and not worth one.

### 13.3 The one backend ask — a day-scoped board read

Needed for: past days as chips (§6), historical operational colour (§7), the board-level
carry-forward marker (§8), and the device id on a chip (field-ops P0-1).

**What it is:** `GET /dispatch/day?zoneId=&date=` — `DispatchTodayQueryService.today()` already takes
`{ zoneId, now }` and derives `day = istDate(now)`; **every internal query is already parameterised
on `day`.** Plus four fields on `TodayTicket`: `deviceId`, `status`, `operationalState` (derived
from soft states), `carriedForward: { days, since } | null`.

**What it is not:** a new table, a migration, a new write path, or any change to the recommender.

**Two things that are genuinely not free, and I will not pretend otherwise:**

1. `availabilityBySe(seIds, now)` answers *as of now*, not as of that day. For a past column it would
   report today's leave against last Tuesday's board.
2. `escalationsOpen(zoneId)` is not day-scoped at all — it reads current `ESCALATION_REQUIRED` rows.

Both need a day-aware branch or an explicit "current, not historical" label. That is what makes this
a small slice rather than a one-line parameter, and it is why it is called out for approval rather
than slipped in.

**Staging:** the whole composition below the chip level ships **without** this. Past columns render
at count fidelity, today at full fidelity, future at projection fidelity — all from existing reads.

---

## 14. Decisions this plan asks you to record

| # | Decision | Reverses |
|---|---|---|
| **D9** | The Console **is** date-navigable — past / today / future, each from its own source, with `/dispatch/today` never taught to accept a date | slice §2.3 |
| **D10** | **Drag and drop ships in V1** as a dialog initiator only; never commits on release | slice §3.3 |
| **D11** | **Operational state becomes a fourth grammar channel** (chip fill), and SLA/urgency moves to an inline token so it survives human assignment | slice §7.3; fixes field-ops P0-1 |
| **D12** | The **Inspector shares the right rail** with the Work Pool rather than being a permanent full-width band | slice §2.1 |
| **D13** | **Approve or defer the day-scoped board read** (§13.3). Deferring is safe — it costs past-day chip fidelity and the board-level carry-forward marker, nothing else | — |

---

## 15. Recommended build order

Nothing starts until you approve this composition.

| Stage | Work | Backend |
|---|---|---|
| **A** | Three-region shell, top bar, right-rail slot sharing, Attention strip. Board still single-day. | none |
| **B** | `BoardGrid` engineer × day. Today full fidelity, past counts, future projection chips. Date navigation. | none |
| **C** | Chip redesign: fill = state, border = provenance, tokens = SLA / carry-forward / chronic / RET. **Field-ops P0-1, P0-2, P0-3 and the amber tier-crossing fix land here.** | none (state/carry-forward need D13) |
| **D** | Drag and drop as initiator. | none |
| **E** | Day-scoped board read; past columns become chips; carry-forward on the board. | **D13** |

Stages A–D are pure composition. If D13 is declined, A–D still ship and the Console still becomes a
scheduling board.

---

## 16. What I need from you

1. **Approve or correct the composition** in §2 — the three-region shell with an engineer × day board
   as the dominant canvas.
2. **Land the two reference designs** in `docs/ui/desktop/approved-designs/` (§0.1). If they
   contradict anything here, they win and I will revise.
3. **Rule on D9–D13** (§14), particularly **D13** — the one backend ask.
4. **Confirm the grammar table in §7.3.** It is the load-bearing decision: four channels, four
   meanings, and it is what stops operational state colliding with the three meanings colour already
   carries.

**Stopping here. No code will change until you approve.**
