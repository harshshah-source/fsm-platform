# 280 — DECISION RECORD: the dispatch timeline is one concept, not three destinations

Status: **APPROVED 2026-08-24** (operator) — the *direction* (R1–R7) and **Q1–Q3 are now ruled**
(R8–R10, approved 2026-08-24 after a structured recommendation covering current screens/routes, what
the 2026-08-19 audits establish, the UX trade-offs, and an explicit recommendation per question — see
the per-issue audit trail rather than restating it here). Only **Q4** (committing the two source
audits) remains open, and Q4 does **not** block #281 — see
[Open, and deliberately not ruled here](#open-and-deliberately-not-ruled-here).
Type: HITL · Decision · Admin

> ## ⚠ CORRECTION — 2026-08-25: this record's central factual premise was wrong
>
> **Nothing below is edited or deleted; this note records what was later established.** See
> [`#282`](./282-decision-todays-dispatch-crew-deck.md) and the forensic investigation
> [`audit/scheduler-engine-forensics-2026-08-25.md`](../../../audit/scheduler-engine-forensics-2026-08-25.md).
>
> This record states — at the top of the file and again under "Reference" — that **"No wireframe
> exists for this screen set."** That was **false**. A complete wireframe set for the scheduler's
> operator surface (*Today's Dispatch — the Crew Deck*: Plan/Live/Replay, engineer deck with ordered
> stops, provenance grammar, critical interception, work rails, and an inspect→understand→override→
> preview→confirm flow) was designed on **2026-08-20**, the same day as #272, in a working artifact
> that was **never committed to the repository**. Its one surviving in-repo trace is
> [`#272:64`](./272-decision-assign-work-console.md) — *"Carried forward from the dispatch-board
> grammar so the two boards read as one product"* — where "the two boards" and "dispatch-board"
> appear nowhere else in the repo. The design was recovered 2026-08-25 and is now committed at
> [`docs/ui/desktop/approved-designs/todays-dispatch-crew-deck.html`](../../../docs/ui/desktop/approved-designs/todays-dispatch-crew-deck.html).
>
> **What still stands:** the problem statement (F6), and rulings **R1–R7, R9, R10** — the tense
> model, grouping-not-merging, per-view responsibilities, the `Run → Zone → Batch` chain fix, the
> Intra-day subordination, and **R7** (the dispatch timeline is not the Assign Work Console). #281's
> delivered work is valid and is retained as supporting tissue beneath the cockpit.
>
> **What is superseded:** **R8**, whose reasoning rests directly on the false premise ("no approved
> design is required for this"; a unified surface rejected as "new page behaviour, not navigation").
> #282 R1 supersedes it: an approved design now exists and the unified Today's Dispatch cockpit is
> the approved direction. Contextual cross-links stay — they are additive, not the ceiling.
>
> **Q4 is closed:** both 2026-08-19 source audits were committed 2026-08-25 alongside #282.

Source: [`audit/navigation-ia-audit-2026-08-19.md`](../../../audit/navigation-ia-audit-2026-08-19.md)
finding **F6 (HIGH)** + [`audit/frontend-ux-audit-2026-08-19.md`](../../../audit/frontend-ux-audit-2026-08-19.md)
findings **10** (sub-group the Operations nav) and the dispatch-terminology note in §"Nav shape".
Implementing issue: **#281**.

> **Both source audits are currently untracked** (`??` in `git status`, dated 2026-08-19, analysis
> only — no source file was modified by either). They are the evidentiary basis for this record and
> should be committed so this file's citations resolve in a fresh clone. See
> [Open question Q4](#open-and-deliberately-not-ruled-here).

**This record establishes a problem and a direction, not a design.** No wireframe exists for this
screen set — unlike [#272](./272-decision-assign-work-console.md), which carried an approved design
file. Nothing here may be read as licence to invent a layout; #281 must not begin until the open
questions are ruled and, if a new visual direction is needed, an approved design is added under
`docs/ui/desktop/approved-designs/` by the process that file's README describes.

## The problem

Four nouns, four sidebar rows, one underlying timeline:

| Sidebar row | Route | What it actually answers |
|---|---|---|
| **Scheduler Preview** | `/schedules/preview` | What the *next* run would do (#251, projection + pre-run holds) |
| **Schedules** | `/schedules` | What the *current* run produced, per SE day plan |
| **Dispatch Runs** | `/dispatch-runs` | The ledger of *past* runs and their per-zone results |
| *(Intra-day Queue)* | `/intraday` | Changes made to today's plan after dispatch |

They are presented as unrelated destinations. `nav.ts:91-95` places the first three as adjacent flat
rows inside a single eighteen-link OPERATIONS group — adjacent, as the navigation-IA audit puts it,
"only because they were added in that order". The relationship is documented **only** inside a source
docblock, where no operator can see it — `SchedulerPreviewPage.tsx`'s own comment says:

> That page is the *post*-dispatch twin of this one, so matching it is what makes the two read as one
> workflow rather than two designs.

The frontend-UX audit records the operator-facing consequence directly: *"Four dispatch nouns; a new
ZM cannot rank them."*

**The drill-down chain also dead-ends.** `Run → Zone → Batch` is navigable downward
(`/dispatch-runs` → `/dispatch-runs/:runId` → `/dispatch-runs/:runId/zones/:zoneId` → `/batches/:batchId`)
and then stops. `DispatchBatchDetailPage` renders `detail.seName`, `detail.plantName` and every
`r.ticketId`, and links **none** of them — verified: its only two links point *upward*, to
`/dispatch-runs/:runId` and `/dispatch-runs`. To reach the day plan the batch produced, the operator
returns to the sidebar, opens Schedules, and searches by name — even though `/schedules/:engineerId`
is a live route that renders exactly that.

## The rulings

- **R1 — The four surfaces are one concept: the dispatch timeline.** Preview (future) → Schedules
  (present) → Dispatch Runs (past), with Intra-day Queue as the record of changes to the present.
  The navigation must express that relationship. Today it expresses only insertion order.

- **R2 — Expressing the relationship must not collapse the questions.** These are three genuinely
  different operator questions with different data, different mutability and different authority:
  *"what will happen"* (projected, re-evaluated at dispatch, holds are the only pre-run lever, #251),
  *"what is happening"* (committed day plans, overridable), *"what happened"* (an immutable ledger).
  A single merged page that blurs a projection into a result would be a worse error than the present
  fragmentation, because it would make an operator believe a preview is a commitment. **Grouping and
  cross-linking, not merging**, unless the operator later rules otherwise.

- **R3 — Each view keeps one responsibility.**
  | View | Owns | Must not claim |
  |---|---|---|
  | Preview | The next run's projection; pre-run holds; the as-of-recompute caveat | That its ordering is what dispatch will produce |
  | Schedules | The current/latest committed result, per SE | To be a projection |
  | Dispatch Runs | The historical ledger, per run and per zone | To be editable |
  | Intra-day Queue | Same-day changes to the committed plan | To be a run |

- **R4 — The `Run → Zone → Batch` chain must reach the work it produced.** A batch names an engineer,
  a plant and its tickets; those are the operator's next question, and each already has a live
  destination. The chain terminating at Batch is a defect, not a design.

- **R5 — Movement between views is part of the concept.** An operator who is looking at a projected
  plan, the committed plan for the same day, and the run that produced it should be able to move
  between those three answers without returning to the sidebar. The audit establishes the need; it
  does not establish the control (see Q1).

- **R6 — This is navigation and information architecture, not new capability.** No new endpoint, no
  new data, no change to what dispatch does. Every destination named here already exists and is
  already role-gated; #281 may not widen any role's reach.

- **R7 — This is not the Assign Work Console.** [#272](./272-decision-assign-work-console.md) / P9
  (#273–#277, landed `6ceaea5`) built `/assign`: the **manual** M→N assignment surface where an
  operator hands work out themselves. This record is about the **automatic** dispatch engine's own
  timeline — what the scheduled run will do, did, and has done. They are adjacent and must not be
  merged: `/assign` is a write surface for human decisions; the dispatch timeline is largely a read
  surface for the engine's decisions. P9 is complete and is **not** reopened by this record.

- **R8 — Q1 ruled: the cross-view control is contextual, per-record links — not a shared switcher, not
  a tab strip.** Verified against the working tree: only Scheduler Preview is single-date scoped
  (`SchedulerPreviewPage.tsx:56,80`, local `useState`, never a URL param). Schedules lists every SE's
  day plan with a per-row `Plan Date` column (`SchedulesPage.tsx:101-105`) and Dispatch Runs is a
  chronological ledger of every run (`DispatchRunsPage.tsx:29`) — neither is a single-date view today.
  A shared date-anchored switcher would require restructuring two pages into date-filtered views,
  which is new page behaviour, not navigation (out of scope per R6). A tab-like control over one shared
  header was rejected outright: it visually asserts the three views are interchangeable slides of one
  dataset, which is the exact error R2 forbids — a projection must never read as a commitment. Each of
  the four views, where it renders a specific SE, day, or run, links to the corresponding record on its
  sibling view(s); each link states the question it moves to (e.g. "See the run that produced this,"
  "Preview tomorrow for this SE"). No approved design is required for this — cross-links are additions
  to existing page furniture, not a new layout.

- **R9 — Q2 ruled: Intra-day Queue is part of the Dispatch cluster, presented as subordinate to
  Schedules, not as a flat fourth peer.** R1's own language already treats it this way — "the record of
  changes to the present," not a fourth tense standing beside future/present/past. #281 chooses the
  smallest presentational treatment that achieves this (e.g. a divider, an indent, copy that reads
  "changes to today's plan"); no change to the `NavGroup`/`NavLink` data model is required or licensed
  by this ruling.

- **R10 — Q3 ruled: the `Run → Zone → Batch` chain terminates at both the SE day plan and the ticket
  detail drawer, and `plantName` is linked too.** `DispatchBatchDetailPage.tsx:89-90,134-135` renders
  `detail.plantName` and `detail.seName` as plain text in the header and table, and `:62` renders every
  ticket identifier the same way; its only two `Link`s (`:122-131`) point upward. `/schedules/:seId`
  (`SchedulesPage.tsx:167`) and `/tickets/:ticketId` are both live, wired destinations. R4's own text
  names all three — engineer, plant, tickets — as "the operator's next question," and AC7 requires
  every displayed identifier with a live destination to be linked or explicitly ruled out of scope.
  `plantName` therefore links to its existing device-investigation destination
  (`/reports/device?plantId=`) even though it was not one of Q3's three listed options — an expansion
  flagged to the operator and approved 2026-08-24, not decided silently. `seName` → `/schedules/:seId`
  is the primary action (AC6); ticket ids → `/tickets/:ticketId` and `plantName` are per-row/secondary
  links (AC7).

## Scope

**In scope (#281):** the sidebar's expression of these routes; cross-links between Preview,
Schedules, Dispatch Runs and Intra-day Queue; the `Run → Zone → Batch → day plan` chain; and the three
navigation defects the audits found on this surface (breadcrumb collision, raw identifiers on
Preview, missing catch-all).

**Out of scope:** any change to dispatch behaviour, scheduling logic, holds, or the recommender;
`/assign` and anything in P9; the wider nav regrouping of Work / People / Readiness that
frontend-UX finding 10 also proposes — only the **Dispatch** cluster is ruled here, and the rest of
that finding remains unfiled.

## Consequences and trade-offs

- **Accepted:** grouping four rows under a Dispatch heading makes the sidebar's OPERATIONS group
  shorter and ranks the four nouns for a new ZM. It does not, on its own, teach the difference
  between them — copy and cross-links do that, which is why R5 exists.
- **Accepted cost:** cross-linking Preview ↔ Schedules ↔ Runs creates navigation paths between pages
  with different mutability. Each link must carry which question it is answering, or it re-creates
  the confusion at a smaller scale.
- **Risk being taken deliberately:** a future operator may prefer one merged page. R2 rules against
  that for now on the grounds that merging is irreversible in the operator's mental model, while
  grouping is not. Revisit with evidence, not preference.
- **Rejected:** doing nothing. The audit rates F6 HIGH, and the dead-end chain has a concrete daily
  cost — the operator retypes a name into a different page to finish a drill-down they had already
  started.
- **Not addressed here:** the four dispatch nouns themselves. Renaming is a bigger blast radius than
  navigation (docs, tests, operator habit) and the audit does not propose replacement names.

## Open, and deliberately not ruled here

**Q1–Q3 are ruled — see R8–R10 above (approved 2026-08-24).** They are no longer open; the numbering
below is kept for continuity with #281's existing citations rather than renumbered.

Only Q4 remains open, and per #281's own "Blocked by" list (Q1–Q3 only), it does **not** hold #281 at
`needs-triage`.

4. **Q4 — Are the two source audits committed to the repository?** They are untracked today. This
   record cites them as its evidence; a decision record whose sources exist only in one working tree
   is not durable. Committing them is a documentation act, not application code. Still open.

## UI surfaces

n/a (decision record). #281 owns the surfaces.

## Reference

> **Corrected 2026-08-25 — see the banner at the top of this file.** The paragraph below was true of
> the repository on 2026-08-24 and false of the world: the Crew Deck wireframes existed from
> 2026-08-20 but lived outside git. `docs/ui/desktop/approved-designs/` now contains
> `todays-dispatch-crew-deck.html` (approved 2026-08-25, [`#282`](./282-decision-todays-dispatch-crew-deck.md)).

**No approved design or v2 reference image covers this screen set.** `docs/ui/desktop/v2-reference/`
has `12-batch-schedule-review.png` (the Schedules page) and no image for Scheduler Preview or the
Dispatch Runs ledger; `docs/ui/desktop/approved-designs/` contains only `assign-work-console.html`.
Per that directory's README and `docs/agents/domain.md` § UI authority, an approved design must be
added by operator decision **before** any layout is invented — see Q1.

## Blocked by

Nothing. #281 implements it. #281 was blocked by Q1–Q3 above; those are now ruled (R8–R10,
2026-08-24). #281's own status line additionally requires confirming whether Q1's answer needs a new
approved design before it can move to `ready-for-agent` — R8 answers that: no approved design is
required, since cross-links are additions to existing page furniture, not a new layout.
