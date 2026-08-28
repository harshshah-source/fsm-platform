# Scheduler Console — Implementation Slice Specification

> **Status: APPROVED and in implementation.** The operator approved the Operational Scheduler Console
> direction on **2026-08-27** and authorised code changes. This document is no longer a proposal: §0.5
> records the final product decisions, §2.1 carries the **approved** console structure (which replaced
> the one this document originally proposed), and §13 records phase outcomes as they land.
>
> **Date:** 2026-08-27 · **Branch:** `feat/autoplant-integration` · **HEAD at approval:** `56f5aec`
>
> **What this is:** the agreed Scheduler Console product direction turned into a concrete, sequenced
> implementation slice that can be approved or rejected clause by clause. It supersedes nothing on
> its own — the decision records it asks to overturn are listed in §1 and §14 and must be overturned
> **in writing** before the phases that depend on them execute.
>
> **Evidence order used, per instruction:** CODE → technical walkthrough (**W**) → UI specification
> (**UI**) → console product analysis (**A**) → earlier design/decision records. Contradictions are
> **stated in §1, never silently reconciled.**
>
> Tags: `[CODE]` read from source this pass · `[DOC]` from a repo document · `[INFER]` reasoned ·
> `[OPEN]` unresolved and blocking.

---

## 0.5 Final product decisions — operator ruling of 2026-08-27

The console concept was reviewed and **approved**. What follows overrides, in this document, anything
below it that reads as still-open. Where a ruling settles one of §14's open decisions, the disposition
is recorded here and §14's row is marked.

### 0.5.1 What is being built
> **The OPERATIONAL SCHEDULER CONSOLE / SCHEDULER COPILOT — one operational workspace, not a
> collection of disconnected Scheduler pages.**

The seven verbs the Console must support, as ruled:

| Verb | Meaning | Where this document answers it |
|---|---|---|
| **SEE** | understand the operating day | A1–A5 (frame, health, situation, board, rails) |
| **IDENTIFY** | find what needs attention | A8 attention band · find-ticket/SE |
| **INSPECT** | understand *why* the Scheduler decided | A6 Inspector — Why band |
| **EXPLORE** | candidates / alternatives / history | A6 Inspector — Alternatives, History |
| **ACT** | assign · reassign · hold · defer · remove · swap · reorder · split · distribute · resolve | §5 action matrix, in the Inspector |
| **CONTROL** | Run Now | A1 frame · §9 B3 |
| **CONFIGURE** | authorised Scheduler settings, where appropriate | role-gated links out; **never** a dead lever (§11) |
| **VERIFY** | see the actual result | §5 itemised results · §8.4 invalidation contract |

### 0.5.2 Rulings that settle open decisions

| Ruling | Settles | Effect |
|---|---|---|
| **ACT is in scope**, including reassign/swap/split/reorder/remove/defer | **D1 (C6) — APPROVED** | `/schedules/:engineerId`'s override controls are **absorbed** into the Console Inspector. One implementation, so `#282 R5` holds. Phase 2 is unblocked |
| **ACT includes assign and distribute**; the approved structure has a **Work Pool** region | **D2 (C2) — APPROVED** | `#280 R7` is overturned for the Console. The mixed-commitment rule (§3.4) is a **binding condition** of the approval, not advice |
| **CONTROL: Run Now** is a Console control for the manager roles | **D3 — APPROVED in principle** | The RBAC widening still ships as an explicit decision record (§9 B3), not a role-list edit. All four clamp parts land together |
| *"The UI must adapt to the user's authority. Do NOT render all controls and leave unauthorized controls disabled. Use progressive disclosure and role-aware rendering."* | Confirms §12 and A6's hide-not-disable rule | Raised from a recommendation to a **hard requirement**. Any greyed-out unauthorised control is a defect |
| The approved structure names **Repeated** and **Inactive** as Work Pool filters | D6 naming | Still needs the operator's word on copy — see §14 |

### 0.5.3 Correction to this document's proposed shape
This document originally proposed a **two-region** console (board left, Inspector right). **The
approved structure is four regions**, and §2.1 has been rewritten to match. The substantive change is
that **people and work get their own persistent rails** — the Inspector no longer shares the right
column with the work rails, and moves to the bottom as a full-width contextual band.

**What this changes in the plan:** layout and component placement only. Every data source, endpoint,
rule and refusal in §4–§11 is unaffected — the Inspector's six bands, the rails' contents and the
board's lanes are the same objects in different columns. **No phase is added, removed or reordered.**

---

## 0. Verification ledger — what was re-checked against source this pass

`INDEX.md`'s own convention says a status line is *"a hypothesis to re-check against `git log`/the
current source, not a fact to carry forward."* Everything below was re-read, not inherited.

| Claim | Verified how | Verdict |
|---|---|---|
| Backend does not compile | `npx tsc --noEmit` in `apps/backend` | **TRUE — 1 error.** `src/scheduling/scheduler-preview.service.ts(221,110): error TS1002: Unterminated string literal.` A corrupted docblock on `releaseHold` ends `…next run* . */'` |
| Admin compiles | `npx tsc --noEmit` in `apps/admin` | **Clean, 0 errors** |
| `GET /dispatch/today` carries the whole cockpit in one call | `dispatch-today-query.service.ts:1-150` | **TRUE.** `run`, `recovery`, `engineers[].stops[].tickets[]`, `situation` (6 counters), `rails{unassignable,held,policyWithheld}`, `escalations[]` — with `batchId`, `stopSequence`, `ticketId`, `seId`, `plantId`, `insertionId` all present |
| That read is keyed on (zone × today), no date param, refuses all-zones | `dispatch-today.controller.ts:38, 50-62` | **TRUE.** `parseZoneId` throws `ZONE_REQUIRED` for a multi-zone role with no `zoneId`; the day is `istDate(now)` with no override |
| A zone-list endpoint exists | `org/zones.controller.ts:25-30`; `api/org.ts:82` | **TRUE.** `GET /org/zones`, `@Roles('CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD')` — exactly the two roles that need a picker. `listZones()` already wrapped and used by 5 pages |
| The cockpit has no zone picker | `TodaysDispatchPage.tsx:48` | **TRUE.** `params.get('zoneId')` only. A CSM or OH opening `/dispatch/today` without a hand-crafted URL gets `400 ZONE_REQUIRED` |
| Run-dispatch is not on the cockpit | `TodaysDispatchPage.tsx` `PlanMode` | **TRUE, and worse than "not relocated"** — see C3. The button is a `<Link to="/bulk-unassign">` |
| The only caller of the run trigger is Bulk Unassign | grep across `apps/admin/src` | **TRUE.** `api/bulkUnassign.ts:136` is the sole `POST /schedules/dispatch-run` |
| All six overrides exist and are wired | `override.service.ts:29-35`; `ScheduleDetailPage.tsx:226,298,313,330,430,455,475` | **TRUE.** `REMOVE_TICKET`, `DEFER_TICKET`, `REORDER`, `SWAP_SE`, `REASSIGN`, `SPLIT_BATCH` — all on `/schedules/:engineerId`, all `@Roles(ZM,CSM,OH)` |
| Impact preview exists for 3 of 6 | `batches.controller.ts:70-95`; `ScheduleDetailPage.tsx:317,334,479` | **TRUE.** `POST /batches/:id/override/preview`; one-lane actions refused `NOT_PROJECTABLE`, never answered with zeros |
| The crew lanes are read-only | `CrewCard.tsx` (whole file) | **TRUE.** `TicketChip` carries `title`, `data-testid`, `data-provenance` — no `onClick`, no selection, no action affordance anywhere in the file |
| Candidates are served tier-ranked with drop reasons | `api/candidates.ts`; `candidate-query.service.ts` | **TRUE.** `tierRank`, `verdict`, `dropReason`, `committed`, `dailyCapacity`, `kitComplete`, `missingKit` — rendered tier-grouped on `/assign` only |
| `dashboard/action-required` is 2 of 9 wired | `dashboard.service.ts:291-301, 876-884` | **TRUE.** Only `waiting_component_overdue` and `recovery_stalled` return `available:true`; the other seven render "coming soon" |
| `nextFireAt` exists but is OH-only | `dispatch-schedule.service.ts:26,107`; `schedules.controller.ts:163-164` | **TRUE.** `GET /schedules/dispatch-schedule` returns `{cron, timeZone, nextFireAt}` behind `@Roles('OPERATIONS_HEAD')` |
| `dispatch-run` takes `zoneId` from the body unclamped | `schedules.controller.ts:190-205` | **TRUE.** `zoneId: body.zoneId != null ? BigInt(body.zoneId) : undefined` — never compared against the caller's claims |
| `dispatch-run/in-flight` is global | `schedules.controller.ts:227-232` | **TRUE.** `inFlightZones()` takes no scope argument |
| `checkStaleness` has no caller | grep across `apps/backend/src` | **TRUE.** Defined at `scheduler-preview.service.ts:135`; zero call sites |
| Repeat-escalation cron is wired despite its docstring | `business-sweep-scheduler.service.ts:47,62,100,240-242` | **TRUE.** `@Cron(...repeatEscalationCron)`, default `*/15 * * * *` |
| `/intraday`'s ledger reads an action no admin code writes | `intradayUpdates.ts:26` is a GET; no `POST /intraday-updates` anywhere in `apps/admin/src` | **TRUE.** `dispatch-changes-today.service.ts:33-40` says so in its own docblock and is the correct replacement |
| The cockpit's "Changes today" rail is real, not the dead audit read | `dispatch-changes-today.service.ts:41-48, 71-121` | **TRUE.** Built from `batch_assignment_tickets` `added_by`/`removed_by`, not `audit_logs` |
| Change-ledger actors are bare UUIDs | `dispatch-changes-today.service.ts:111,121` | **TRUE.** `actorId: a.addedBy!` — no name resolution |
| `committedDayPlan` is the single capacity definition | `committed-day-load.ts:1-30, 80` | **TRUE**, and shared by enforcement and display by construction (#269) |
| No drag-and-drop exists on either approved board | grep `draggable\|onDrop\|dataTransfer` across `apps/admin/src` | **TRUE.** The only drag/drop in the app is `PlannerPage.tsx:181-235` (SE Planner grid). `/assign` is checkbox-and-lane; the Crew Deck HTML mentions "drop targets" only inside its **rejected-alternatives** prose |
| The brief's `prisma/schema.prisma` path | `find -name schema.prisma` | **Wrong path.** It is `apps/backend/prisma/schema.prisma` |

---

## 1. Contradictions — stated, not reconciled

Nine. Five carried from the feasibility review and re-verified; **four are new to this pass**, and
**C6 is the one that gates the whole programme.**

### C1 — UI§37 says six surfaces and that none may be merged. The direction says one workspace.
`[DOC — UI§37.1]` The UI specification sits **above** the console analysis in the evidence order, so
this cannot be waved away.

**Position taken here:** the spec is right about the *properties* and over-reaches in the
*conclusion*. Two of its six refusals are hard separations — a projection is **date-addressable** and
must never read as a commitment; a run's evidence is **immutable and separately deep-linkable**. The
other four share the console's key exactly, `(zone × today)`, and the spec's own test (*"none of them
is a destination an operator navigates to"*) applied one level further makes them panels.
**Recommendation: three surfaces, not one and not six** (§2.1). This is a challenge to *both* sources
and needs an explicit ruling.

### C2 — `#280 R7` forbids merging `/assign` with the dispatch timeline. The direction requires it.
> *"`/assign` is a **write** surface for human decisions; the dispatch timeline is largely a **read**
> surface for the engine's decisions. They are adjacent and must not be merged."*
> `[CODE — 280-decision-dispatch-timeline-ia.md:124-126, read verbatim this pass]`

R7 carries **no escape clause** — R2, three bullets above it, does (*"unless the operator later rules
otherwise"*). Reaffirmed by `#282 R1`.

**Position taken here:** R7's concern is **blurring**, not adjacency — one lane holding both a chip
that writes nothing and a chip whose every move writes immediately. Honour the concern, overturn the
conclusion: **Assign is a mode of the console with its own board region, never sharing a lane object
with committed work** (§3.4). If the operator declines, the console still ships — it excludes the
work pool and `/assign` stays one link away. **Nothing else in this specification depends on C2.**

### C3 — `INDEX.md:548` marks `#285` DONE *including "Run-dispatch relocated"*. Three sources disagree, and the code is worse than "not done".
- `INDEX.md:548` — *"✅ **DONE 2026-08-25** … Run-dispatch relocated, nav restructured"*
- `285-todays-dispatch-cockpit.md:3` — `Status: **ready-for-agent** (after #284, #283)`
- `TodaysDispatchPage.tsx` `PlanMode` — `<Link to="/bulk-unassign"><Button variant="secondary">Run dispatch</Button></Link>`

**And `/bulk-unassign` is `<RoleRoute roles={['OPERATIONS_HEAD']}>`** `[CODE — AppRoutes.tsx]`, whose
miss path is `<Navigate to="/" replace />` `[CODE — RoleRoute.tsx:16]`.

> **So for a Zonal Manager and a Central Service Manager — two of the three primary users — the
> cockpit's "Run dispatch" button silently bounces them to the dashboard.** It is not merely
> misplaced; it is broken for the majority of its audience, and no record says so.

**Recommendation: code wins. Correct both records** — INDEX row 4 *and* the issue header, not one of
them. Scoping from INDEX alone prices this work at zero.

### C4 — UI§7.1 / G-UI-16 say there is no zone-list endpoint. There is.
`GET /org/zones`, `@Roles('CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD')`, already wrapped as
`listZones()` and consumed by `TopBar`, `BulkUnassignPage`, `PlantZonesPage`, `TierOverridesPage` and
`SeManagementDirectoryPage` `[CODE]`. **Code wins; the spec's proposed workaround is unnecessary.**
The role list is *exactly* CSM+OH — a ZM calling it gets 403, which matches "hidden for a ZM" rather
than fighting it.

### C5 — `RepeatEscalationService`'s docstring says its cron is deferred. It is wired and running.
`@Cron(readBusinessSweepSchedulerConfig().repeatEscalationCron, …)` at
`business-sweep-scheduler.service.ts:240`, default `*/15 * * * *` `[CODE]`. **Code wins.** This matters
because the stale docstring makes the D1a defect look dormant when it fires every fifteen minutes.

### C6 — NEW, and this is the gate. An operator ruling of 2026-08-25 says the cockpit must have no override controls. The direction requires exactly that.
`289-override-impact-preview.md:40-47`, read verbatim this pass:

> *"AC5 — ~~The cockpit renders~~ **Schedule Detail renders** the preview between the override choice
> and the commit. **Operator ruling, 2026-08-25**, put to them explicitly: the cockpit has no override
> controls — it links out to `/schedules/:engineerId`, which is where an operator actually chooses an
> override — so building move controls into `/dispatch/today` would duplicate an existing surface,
> which #282 R5 forbids. **The option was offered and not taken.**"*

This ruling is **two days old**, was **put to the operator explicitly**, and was **declined**. It
contradicts *"modify the plan without constantly navigating between unrelated pages"* more directly
than `#280 R7` does, and the feasibility review does not name it.

**Position taken here — the ruling's *reason* is the disposable part.** The stated reason is *"would
duplicate an existing surface."* That was correct on 2026-08-25, when the proposal was to add a
**second** set of move controls beside Schedule Detail's. The console direction changes the premise:
the console **absorbs** those controls into its Inspector rather than duplicating them, after which
`/schedules/:engineerId` either retires or survives only as a deep-link target (§14 D7). One
implementation, in one place, which is what `#282 R5` actually protects.

> **The ask is therefore not "overturn AC5". It is: authorise the *absorption* of
> `/schedules/:engineerId`'s override controls into the console Inspector, with `#282 R5` satisfied
> because the number of implementations stays at one.** Approving the console without approving this
> leaves the direction's central promise undeliverable, and the honest response would be to build a
> read-only console and say so on the record.

### C7 — NEW. The feasibility review says the score breakdown is *"served today and discarded by the client."* Half right.
`#266` landed the numeric score: `DecisionTrace.tsx` renders `t.chosen.score.toFixed(2)`, each
runner-up's **own** score, and the `scoreDegenerate` explanation `[CODE]`. What is genuinely served
and discarded is the **per-term breakdown** — `scoreBreakdown: Record<string, unknown> | null`,
returned at `dispatch-transparency-query.service.ts:763`, typed in the client at
`api/dispatch-runs.ts:266`, **rendered nowhere** (grep returns one hit: the type declaration)
`[CODE]`. Scope the work as *"render the breakdown terms"*, not *"render the score"*.

### C8 — NEW. The brief's source-of-truth path does not exist.
The brief names `prisma/schema.prisma`. The file is `apps/backend/prisma/schema.prisma`. Five stale
copies also exist under `.claude/worktrees/*` and must not be read as the schema `[CODE]`.

### C9 — NEW. The working tree does not compile, and two prior documents already said so.
`A§0.1` and the understanding doc `§0.2` each open by stating it; it is still true two documents
later. **No slice below can be verified until this is fixed.** It is a one-character deletion in a
docblock, and that is the only reason it is Phase 0.1 rather than a footnote.

---

## 2. What the Scheduler Console is

### 2.1 The shape: three surfaces, one of them the Console

> **SUPERSEDED ON COMPOSITION 2026-08-28.** The four-region structure below was built, rejected by
> the operator, and recomposed the same day — the board is now an **ENGINEER × DAY grid** with date
> navigation, the mode nav is dissolved into the day axis, and drag ships as a dialog initiator.
> The current composition is [`scheduler-console-ui-composition-correction.md`](./scheduler-console-ui-composition-correction.md)
> (approved & implemented). Everything in this section that is a *data or correctness rule* — one
> lifted fetch, one selection driving one Inspector, the honesty rules — survives unchanged.

**Approved structure, 2026-08-27.** The Console is four regions inside one frame. Two of them are
persistent rails — **people** on the left, **work** on the right — and the Inspector is a full-width
contextual band beneath the board, not a third column.

```
┌─ CONSOLE — /dispatch/today ────────── key: (zone × operating day) · MUTABLE · indicative ─────────┐
│ GLOBAL SCHEDULER HEADER                                                                          │
│  Scheduler Console · zone ▾ · operating day · run state · find ticket/SE · filters · [Run now]   │
│  HEALTH (conditional) recovery · stale eligibility view · stale build · SE skips                 │
│  SITUATION  six funnel counters — never summed into one number                                   │
├──────────────┬────────────────────────────────────────────────┬──────────────────────────────────┤
│ ENGINEERS    │            SCHEDULER BOARD                     │ WORK POOL                        │
│ / PEOPLE     │                                                │ / WORK                           │
│              │  engineer × day × stops × ticket chips         │                                  │
│ SE identity  │  ordered stops, ordinal — no clock, no map     │ Unassigned    Unresolved         │
│ Coverage     │                                                │ Attention     Held               │
│ Capacity     │  ▸ ASSIGN MODE — its own board region          │ Deferred      Repeated           │
│ Workload     │    pool → draft lanes → review → commit        │ Inactive      Withheld (count)   │
│ Status       │    never shares a lane with committed work     │ Changes today                    │
│              │                                                │ search / filter                  │
├──────────────┴────────────────────────────────────────────────┴──────────────────────────────────┤
│ CONTEXTUAL INSPECTOR / COPILOT — exactly one selected object                                     │
│  IDENTITY · WHY · CANDIDATES · HISTORY · ACTIONS · IMPACT · ATTENTION                            │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
          │                                             │
          ▼                                             ▼
┌─ PROJECTION — /schedules/preview ──┐   ┌─ LEDGER — /dispatch-runs/* ─────────┐
│ any IST date · zones in scope      │   │ run → zone → batch → per-ticket trace│
│ READ-ONLY · conditional mood       │   │ IMMUTABLE · past tense               │
│ "would be assigned"                │   │ "decided, 05:02"                     │
│ holds are the only pre-run lever   │   │ deep links must survive              │
└────────────────────────────────────┘   └──────────────────────────────────────┘
```

**Four rules the structure carries, each of which is a correctness rule and not a layout preference:**

1. **The left rail is people, the right rail is work, and neither is the Inspector.** Selecting an
   engineer in the left rail and selecting a ticket in the right rail both drive the *same* single
   Inspector below. One object, one Inspector, regardless of which door was used (§3.2).
2. **Every object in all three regions comes from the one `GET /dispatch/today` payload.** The left
   rail is `.engineers[]` without its stops; the board is `.engineers[]` with them; the right rail is
   `.rails.*` plus `/dispatch/changes-today`. The rails are **projections of one fetch, not five
   fetches** — which is exactly why §8.4's single lifted fetch is mandatory rather than advisory.
3. **`Repeated` and `Inactive` in the Work Pool are Phase 3.4 filters, and Phase 0.3 proved their
   population is not what the plan assumed** — see §13 Phase 0's recorded outcome. They render only
   once D1's predicate is settled; until then the filter chips are absent, not empty.
4. **`Withheld` stays a count and never becomes a list**, in the rail exactly as in A5. Placing it
   beside itemised filters is the most likely way for a redesign to break the one rule the engine's
   contract (`itemised: false`) makes explicit.

**The Console is `/dispatch/today` grown up, not a new route.** `#285` already built the
`(zone × today)` surface, its payload already carries every id the actions need, and a second route
would orphan the built one and fork the read. **No new top-level route is created by this
specification.** `[INFER, from CODE]`

**Why the other two stay outside.** They have a different *key* (a date; a run id), a different
*mutability* (none; none) and a different *mood* (conditional; past). Pulling them in means either
losing the date range or making "today" mean two things on one screen — the error `#280 R2` names as
*"a worse error than the present fragmentation."*

### 2.2 The one sentence
> **The Scheduler Console is the single zone-scoped operating-day workspace in which a manager sees
> what the engine did, understands why, sees what needs them, changes it, and sees the cost of the
> change — without leaving the screen.**

Everything it cannot honestly answer is a **navigation to a different question** (§11), not a missing
panel.

### 2.3 What it is explicitly not
- Not one flat page of every field.
- Not a pan-India view. `GET /dispatch/today` refuses "all zones" on purpose `[CODE]`.
- Not date-navigable. The live read is `istDate(now)`, always `[CODE]`.
- Not an approval step. Inaction means the 05:00 run proceeds exactly as if nobody looked.
- Not a rewrite of the engine. **Every screen in this specification is a Layer-4 read/write surface;
  no recommender, scoring, filter or capacity rule is touched anywhere in this plan.**

---

## 3. How the user interacts with it

### 3.1 The interaction loop, in the order it happens

```
SEE (board)  →  SELECT (one object)  →  UNDERSTAND (Inspector: why / alternatives / history)
             →  CHOOSE (an action from the legal set)  →  TARGET (SE, date, position)
             →  IMPACT (projected, where projectable)  →  REASON (mandatory free text)
             →  CONFIRM  →  RESULT (itemised)  →  BOARD REFRESHES
```

Two properties of this loop come straight from code and are non-negotiable:

1. **Every override writes immediately and requires a `reasonCode`.** `OverrideCommand` makes
   `reasonCode: string` mandatory on all six actions `[CODE — override.service.ts:29-35]`, and
   `ScheduleDetailPage` already gates Confirm on a non-empty reason `[CODE]`. There is no draft, no
   staging, no "commit all".
2. **Some confirms are two-gate.** `CONFLICT_ON_SITE` and `CONFLICT_DEFERRED` are returned as
   populated 409s to be re-sent with `confirm: true` `[CODE — override.service.ts:38-41]`. The
   Inspector must render both refusals as a *second* dialog step, never as an error toast.

### 3.2 Selection
- **Exactly one object is selected at a time**, and it is one of: a **ticket chip**, a **stop**, an
  **engineer lane**, a **rail row**, or an **attention item**. Selection is reflected in the URL
  (`?sel=ticket:<id>` etc.) so a manager can send a colleague the exact thing they are looking at.
- **Multi-select exists in exactly one place: `SPLIT_BATCH`.** That action takes `ticketIds: string[]`
  `[CODE]`. Everywhere else, multi-select would imply a bulk write the backend does not offer
  (`#272 R8` rules per-item commit and per-item results).
- Selecting a rail row or an attention item selects the same underlying ticket the board would have —
  **one object, one Inspector, regardless of which door was used.**

### 3.3 Drag and drop — the recommendation is **no drag in v1**, and here is why
**No drag-and-drop exists on either approved design.** `/assign` is checkbox-and-lane; the Crew Deck
uses ordered stops with no drag; the phrase "drop target" appears in the Crew Deck HTML only inside
its **rejected-alternatives** analysis. The one drag/drop implementation in the app is the SE Planner
grid `[CODE — PlannerPage.tsx:181-235]`. `[CODE — verified this pass]`

Three reasons a drag is the wrong gesture here, all of them technical:

| | Why a drag fails |
|---|---|
| **It commits instantly and irreversibly** | A drop would write `POST /batches/:id/override` on release. There is no undo endpoint. A slip of the mouse moves a real engineer's real day |
| **`reasonCode` is mandatory** | A drag carries no reason. The dialog would open anyway — so the drag saves nothing and adds a way to open it by accident |
| **Two of the six actions gate on a 409 confirm** | `CONFLICT_ON_SITE` / `CONFLICT_DEFERRED` need a *second* deliberate confirm. A gesture whose completion is "let go" cannot express that |

**What is specified instead — and what a later drag would be allowed to do.**

- **v1:** select chip → Inspector → `Reassign` → pick target SE → impact panel → reason → Confirm.
  Identical to the flow `ScheduleDetailPage` already runs, relocated into the Inspector.
- **If drag is later approved, it may only be an *initiator*.** Dropping a chip on a lane
  **pre-fills the target SE and opens the same dialog at the impact step**. It never writes. The chip
  does not visually move until the write returns. This keeps one write path and one audit shape.
- **Reordering stops (`REORDER`) is the one place a drag would be nearly honest** — it is single-lane,
  has no cross-engineer impact, and takes only `stopSequence`. It is still excluded from v1 because it
  also requires a reason, and because shipping drag on one action out of six teaches an affordance
  that fails on the other five. `[INFER]`

### 3.4 Assign mode — the mixed-commitment rule
This is the largest design risk in the programme and it has exactly one rule.

| | `/assign` chips (draft) | Console lane chips (committed) |
|---|---|---|
| On placing | **Nothing is written** (`#272 R2`) | **Every move writes immediately** |
| On leaving the page | Draft is lost, and the page says so (`#272 Q2`) | Nothing to lose |
| Scope | **Pan-India** for CSM/OH `[CODE — assignable-work-query.service.ts]` | **One zone**, always `[CODE]` |
| Selection unit | Plant-shaped `(companyId, plantId)` | Ticket-shaped |

The shared grammar's first rule is *"never the same shape for two meanings"*
`[CODE — approved-designs/README.md]`.

> **Rule: draft work and committed work may share a screen, a frame and a grammar. They may never
> share a lane object.** Assign mode owns its own board region, its own lanes, its own review step and
> its own commit. Crossing between regions is an explicit act with a result — never a drag.

**Consequence accepted on the record, 2026-08-28 (§14 D4):** the Console's Assign mode is
**zone-scoped**, a deliberate narrowing of today's pan-India pool for CSM/OH. Two panes on one screen
that disagree about scope is a correctness bug, not a feature. The pan-India pool stays reachable on
the standalone `/assign` route. `[INFER]`

**How the rule was actually enforced.** Assign mode **replaces** the board, both rails and the
Inspector rather than sitting beside them, so the two lane vocabularies are never co-resident — the
rule became structural instead of conventional. That the committed board and the draft had already
collided on `data-testid="lane-*"` (`lane-<seId>` against `lane-<n>`) is the same fact showing up in
the test suite before it showed up on a screen. `[CODE]`

### 3.5 Keyboard and search
- `/` focuses **Find ticket or SE** in the frame. It filters the board and the rails; it does not
  fetch — every object on the screen is already in the one payload `[CODE]`.
- `Esc` clears selection and closes the Inspector.
- No other shortcuts in v1. A shortcut that fires an irreversible write is out of scope.

---

## 4. The areas — meaning, data, and the rule each must not break

Eight areas. For each: what question it answers, where its data comes from, what exists today, and the
one rule that makes it honest.

### A1 — FRAME (global context and controls)
**Question:** which zone, which day, has the run happened, can I run it now?

| Element | Source | Today |
|---|---|---|
| Zone name + id | `GET /dispatch/today` → `.zone` | ✅ rendered |
| Zone picker (CSM/OH) | `GET /org/zones` | ❌ **frontend-only gap** (C4) |
| Operating day | `.operatingDay` | ✅ rendered |
| Run pill (status, started, trigger) | `.run` | ✅ rendered |
| Next scheduled run | `GET /schedules/dispatch-schedule` → `nextFireAt` | ⚠️ **OH-only** — backend gap (§9 B2) |
| Run now | `POST /schedules/dispatch-run` | ⚠️ exists; not here; ZM cannot call it (§9 B3) |
| In-flight guard | `GET /schedules/dispatch-run/in-flight` | ⚠️ exists; global scope (§9 B3) |
| Find ticket / SE | client-side over the payload | ❌ frontend-only |

**Rule:** the zone picker is **hidden** for a ZM, not disabled. `UI§4.4` — a picker with one
unchangeable option teaches nothing, and `GET /org/zones` 403s for a ZM anyway `[CODE]`.

### A2 — HEALTH (is this zone's day intact?)
**Question:** did anything about *this run of this zone* break, and does it need a human?

| Signal | Source | Today |
|---|---|---|
| Same-day recovery state (`PENDING`/`RECOVERED`/`EXHAUSTED`/`EXPIRED`) + attempts + last error | `.recovery` | ✅ `RecoveryNotice` |
| SE skips (an engineer the run passed over) | run payload — **not yet in `/dispatch/today`** | ❌ backend gap (§9 B1) |
| Stale eligibility MV age | `configSnapshot.eligibilityMv` on the run | ❌ not surfaced here |
| Stale build stamp | `#130` L3 ledger; rendered on run detail | ❌ not surfaced here |

**Rule:** these are properties of *this run of this zone* and belong here, **not** in the cross-cutting
attention band (A8). Two sources, one band, clearly grouped `[DOC — feasibility §6 condition 2]`.

### A3 — SITUATION (the six counters)
**Question:** what did the run do with the work it looked at?

`.situation` → `placed`, `unassignable`, `held`, `criticalNeedsYou`, `overCapacity`, `changesToday`
`[CODE — dispatch-today-query.service.ts:54-61]`. ✅ Built, rendered as `MetricStrip`.

**Rule — and this is the one most likely to be broken by a redesign:** **the counters are never
summed and never collapsed into one "not dispatched" number.** They describe different populations
with different owners and different actions. `#282 R6` forbids fabricated or example numbers here; the
wireframe's `42 placed · 3 unassignable` are illustrative and must not ship.

**Known incompleteness to state on the screen, not paper over:** the funnel has more populations than
six. `componentBlockedWithheld` and `bucketlessDropped` are recorded **per run** and are not in
`TodaySituation` `[DOC — A§10.3, feasibility §2]`. Until §9 B1 lands, the strip must not imply the six
are exhaustive.

### A4 — BOARD / crew lanes (PEOPLE × WORK)
**Question:** who is carrying what, in what order, and placed by whom?

`.engineers[]` → `{seId, name, coverageType, committed, dailyCapacity, overCapacity, availability,
scheduleId, scheduleStatus, stops[]}`; `stops[]` → `{batchId, stopSequence, plantId, plantName,
status, runId, tickets[]}`; `tickets[]` → `{ticketId, sortOrder, slaBucket, companyTier, addSource,
addedBy, addReason, coverageTypeAtAssign, systemPlaced, returnDueToday}` `[CODE]`.

✅ Rendered by `CrewCard`. ❌ **Entirely read-only** — no selection, no actions (C6).

**Rule:** `committed`/`dailyCapacity` come from `committedDayPlan`, the *same* function the recommender
enforces with `[CODE — committed-day-load.ts]`. The board must never recompute load; a number a
manager reads as *"can this engineer carry it?"* has to be the number the engine will enforce.

**Rule:** ordinal only. No times, no ETA, no map — `#258 Q6` and `#272 R7` rule out live GPS; distance
exists only as a scoring term `[DOC]`.

### A5 — BOARD / rails (what did not land)
**Question:** what is not on anybody's plan, and why?

| Rail | Source | Today |
|---|---|---|
| Unassignable (+ `poolEmptyReason`: `NO_COVERAGE` / `ALL_DROPPED` / null) | `.rails.unassignable` | ✅ |
| Held / deferred (+ `heldUntil`, `expectedFrom`, `decidedBy`) | `.rails.held` | ✅ |
| Withheld by policy | `.rails.policyWithheld` → `{count, itemised: false}` | ✅ |
| Changes today | `GET /dispatch/changes-today` | ✅ |

**Rule — `policyWithheld` must never become a list or a card.** The engine counts it and never
itemises it; those tickets get no recommendation, no row and no trace, so there is nothing to list.
`itemised: false` is the contract and the UI already honours it `[CODE]`.

**Rule — `poolEmptyReason: null` renders as "reason not recorded", never as a guess** `[CODE]`.

### A6 — INSPECTOR (the selected object)
**Question:** what is this, why is it here, who else could have taken it, what has happened to it,
what can I do, and what will that cost?

| Band | Source | Today |
|---|---|---|
| **Identity** | trace `identity` (device, vehicle, plant, company, transporter) / `GET /tickets/:id` | ✅ built inside `DecisionTraceView` |
| **Why** — chosen SE, precedence rank of N, coverage tier, capacity at decision, score, runners-up with their own scores, drop counts, not-enforced filters | `GET /dispatch-runs/:runId/tickets/:ticketId/trace` | ✅ `TracePanel` — **but needs a `runId` the console must already know** (§9 B4) |
| **Why** — per-term score breakdown | `scoreBreakdown` on the same response | ⚠️ **served, typed, never rendered** (C7) |
| **Alternatives** — every eligible engineer for the plant, in the engine's own order, dropped ones included with reason, tier-grouped | `GET /schedules/candidates?plantIds=` | ✅ served; ✅ tier-grouped renderer exists as `CandidateColumn` on `/assign` — **reuse, do not rebuild** |
| **History** — lifecycle, attempts, forms | `GET /tickets/:id` (`lifecycle[]`), `/:id/attempts`, `/:id/forms` | ✅ all three exist |
| **Actions** | see §5 | ⚠️ exist on `/schedules/:engineerId`; C6 gates relocation |
| **Impact** | `POST /batches/:id/override/preview` | ✅ 3 of 6 actions; `OverrideImpactPanel` exists |

**Rule:** the Inspector renders the **legal action set for (object × state × role)** and **hides**
what the role cannot do. It never renders the union greyed out — `UI§4.4`, and the direction says so
explicitly.

**Rule:** a null rank is **unknown**, never *"unranked"*; an invented position reads as the engine
having rejected the target `[DOC — #289, #283]`.

### A7 — ASSIGN MODE (its own board region)
**Question:** what work is unassigned, who can take it, and what does handing it out cost?

`GET /schedules/assignable-work` (pool) · `GET /schedules/candidates` · `POST /schedules/distribute-preview`
· `POST /schedules/assign-batch` (transactional, itemised per-lane results) · `POST /schedules/assign`
· `POST /schedules/assign-plants` `[CODE — schedules.controller.ts:363,404,430,495,511,545]`.

✅ All six endpoints exist. ✅ The whole UI exists as `AssignConsolePage` + `CandidateColumn` +
`DistributePanel` + `ReviewCommitScreen` + `LaneCoverage` + `grammar.tsx` (1,037 + 154 + 204 + 287 +
119 + 95 lines) `[CODE]`.

**Gated on C2.** If C2 is not overturned this area is simply absent and `/assign` stays a link.

### A8 — ATTENTION (what needs me, ranked)
**Question:** of everything on this screen, what should I do first?

**Source: extend `GET /dashboard/action-required`. Do not build a second queue.** It already exists
with nine urgency-ordered cards `[CODE — dashboard.service.ts:291-301]`:

| Card | Wired? | Note |
|---|---|---|
| Auto-dispatched batches awaiting review | ❌ | |
| **Vehicle Unavailability / readiness conflicts** | ❌ | **data already served and already rendered** at `/readiness/vehicle-unavailability` |
| CRITICAL insertions awaiting SE acceptance | ❌ | rows exist |
| **Failed Verification** | ❌ | `/verification` renders them |
| Component-Blocked | ❌ | queue table exists |
| WAITING_COMPONENT 7+ days | ✅ | |
| Non-Op awaiting confirmation | ❌ | |
| Manual assignment required | ❌ | |
| Recovery stalled 14+ days | ✅ | |

Two of the seven stubs are a `COUNT(*)` each over data that already ships. Lighting them repairs the
**dashboard** from the same definition. `[INFER, from CODE]`

**Rule — and this one is a correctness bug if ignored:** `action-required` is zone-scoped for a ZM and
**global for CSM/OH** `[CODE — dashboard.service.ts:889, 909]`. Rendered beside a single-zone deck for
a CSM, the two panes will disagree about how much trouble the zone is in. **The endpoint needs an
explicit `zoneId` parameter before this band ships** (§9 B5). This is not optional polish.

**Rule:** every attention item names its **owner** and its **one action**. A count with no verb is a
worry, not a queue.

---

## 5. Actions — the complete matrix

Every action below already has a working endpoint. **Nothing in this section requires a new write
path.** What is required is relocating the controls into the Inspector (gated on C6).

| Action | Object | Endpoint | Body | Impact preview? | Confirm gates |
|---|---|---|---|---|---|
| **Reassign** | ticket | `POST /batches/:id/override` | `{action:'REASSIGN', ticketId, newSeId, reasonCode}` | ✅ | `CONFLICT_ON_SITE`, `CONFLICT_DEFERRED` |
| **Swap SE** | stop (batch) | same | `{action:'SWAP_SE', newSeId, reasonCode}` | ✅ | both |
| **Split batch** | stop + ticket selection | same | `{action:'SPLIT_BATCH', ticketIds[], newSeId, reasonCode}` | ✅ | both |
| **Remove** | ticket | same | `{action:'REMOVE_TICKET', ticketId, reasonCode}` | ❌ `NOT_PROJECTABLE` | — |
| **Defer** | ticket | same | `{action:'DEFER_TICKET', ticketId, deferredToDate, reasonCode}` | ❌ `NOT_PROJECTABLE` | — |
| **Reorder** | stop | same | `{action:'REORDER', stopSequence, reasonCode}` | ❌ `NOT_PROJECTABLE` | — |
| **Assign** | unassigned ticket | `POST /schedules/assign` | ticket + SE | — | `CONFLICT_DEFERRED`, `REASON_REQUIRED` |
| **Hold** | ticket | `POST /schedules/holds` | `{ticketId, heldUntil, reasonCode, confirm?}` | — | `TICKET_NOT_HOLDABLE`, `CONFLICT_VEHICLE_UNAVAILABLE` |
| **Release hold** | held ticket | `POST /schedules/holds/release` | `{ticketId}` | — | — |
| **Resolve critical escalation** | `insertionId` | intraday insertion + `IntradayManualAssignModal` | — | — | — |
| **Run now** | zone | `POST /schedules/dispatch-run` | `{zoneId?, reason?}` | — | `DISPATCH_ALREADY_RUNNING` (409, populated) |

**Three refusals that are already correct in code and must survive into the Inspector:**

1. A one-lane action is refused `NOT_PROJECTABLE`, **never answered with zeros** — `0 → 0` reads as
   *"removing this person's work costs nothing"* `[CODE — batches.controller.ts:88-93]`.
2. A failed projection **loses the panel, never the Confirm** — the preview is information, not a gate
   (`#258 Q2`) `[CODE — #289 progress report, with its own test]`.
3. Over capacity is **marked amber and still projected**; refusing would turn a preview into the gate
   `#258 Q2` forbids `[CODE]`.

**One behaviour the direction does not mention and the UI must state: a manual run notifies engineers.**
Day-plan notifications ride the same commit path as the 05:00 run, so a mid-day Run Now can push work
onto a phone mid-shift `[CODE — batch-assignment.service.ts:65-81]`. That is correct behaviour and the
confirm dialog must say so.

**And Run Now must have an explicit zero-result state.** The engine only looks at work that is `OPEN`
**and** `UNASSIGNED`, so with inputs unchanged a re-run places nothing. Without a designed
"0 new assignments — here is why" state, this control teaches managers the scheduler is broken
`[CODE — recommender.service.ts:326-328]`.

---

## 6. Time — how historical, current and future scheduling behave

The three surfaces of §2.1 *are* the three tenses. The Console's existing Plan / Live / Replay mode
strip stays, and **each mode's job is redefined by where its data honestly lives.**

| | **PLAN (future)** | **LIVE (present)** | **REPLAY (past)** |
|---|---|---|---|
| Question | What would the next run do? | What is happening today? | What did that run do, and why? |
| Key | an IST **date** | `(zone × istDate(now))` | a **run id** |
| Mutability | none — projection writes nothing | mutable | immutable |
| Mood | conditional — *"would be assigned"* | indicative — *"is assigned"* | past — *"decided, 05:02"* |
| Source | `GET /schedules/preview` (`#250`/`#251`) | `GET /dispatch/today` | `GET /dispatch-runs/:runId/decisions` + `…/trace` |
| Only lever | **place / release a hold** | the full action matrix (§5) | none |
| Lives | on the **Projection** surface; Plan mode links to it | **in the Console** | on the **Ledger** surface; Replay mode composes it |

**Four things about time that the design must not get wrong:**

1. **Nothing is decided for tomorrow.** There is no future plan to inspect — only a projection that
   re-runs the real recommender with writes suppressed. *"What the Scheduler decided for tomorrow"* is
   a question with no referent `[DOC — A§0.3, W]`.
2. **The live read has no date parameter and cannot get one cheaply.** `istDate(now)`, always
   `[CODE]`. A date picker on the Console is refused in §11.
3. **A projection must never render as a commitment** (`#280 R2`). This is why Plan mode links out
   rather than embedding — and why, if it ever embeds, it must carry the conditional mood visually.
4. **Replay is already real, not two links.** `#284` landed the decision stream in `processing_rank`
   order — the order the engine actually considered tickets in — and each row expands into
   `TracePanel` `[CODE — TodaysDispatchPage.tsx ReplayMode]`. An **unassignable** decision gets a row;
   listing only placements would show a run doing less than it did.

**Historical ticket journey** (created → assigned → reached → troubleshooted → verified → resolved) is
served by `GET /tickets/:id` (`lifecycle[]`), `/:id/attempts` and `/:id/forms` `[CODE]`. It belongs in
the Inspector's History band, reached from the object — **not** as a fourth mode.

---

## 7. How ticket and device state is represented

### 7.1 Two axes, not five badges
The direction requires five states never to collapse. They are **not five independent tokens — they
are two axes**, and rendering five would produce a legend nobody reads.

```
                  COMMITTED              PROJECTED             PROPOSED
  system      "is assigned"          "would be assigned"          —
  human       "was reassigned         "would be assigned"     "will move to Ravi"
               by Priya, 09:14"
  unknown     "assigned — source          —                       —
               not recorded"
```

**The provenance axis already exists in code and is already ruled.** `#282 R2` binds it; `#290` landed
the tokens: solid + dot = system, dashed = a human crossed or overrode, **violet** = tier-crossing,
**amber** = over capacity, **heavy crimson** = critical direct-assigned, dotted = provenance not
recorded — and **it must survive grayscale** (three meanings, three shapes, with a test)
`[CODE — CrewCard.tsx chipTreatment; assign/grammar.tsx; INDEX #290 DONE]`.

**Only the tense axis is missing, and it is carried by mood and surface — never by a sixth colour.**
Because the three surfaces are already separated by tense (§6), the tense axis is **mostly free**. The
one place both axes coexist is a *proposed* action inside the Console, which is a transient state
inside a dialog — a different rendering context anyway. `[INFER]`

### 7.2 The rule about absence
`addSource == null` renders as **unknown**, never as system. *"Drawing it solid would be the single
lie this whole grammar exists to prevent"* `[DOC — #282 R2; CODE — CrewCard.tsx:19-25]`. The same rule
governs `poolEmptyReason: null`, a null rank, and `dailyCapacity: null`.

### 7.3 Two colour rules already paid for
`#290` fixed a real defect: over capacity had been rendered **crimson** (the colour reserved for
critical work) and tier-crossing **amber** (the colour reserved for over capacity), in three places
including `LoadBadge`, which appears on **seven** surfaces. Any new Console component that shows load
or a crossing **must consume `LoadBadge` and `grammar.tsx`**, not restate the colours
`[CODE — INDEX #290; assign/grammar.tsx]`.

### 7.4 Device state
Zone → company → plant → device drill-down with telemetry exists: `dashboard/zone-overview` →
`company-plant-overview` → `GET /devices` `[DOC — A§13, verified as routes]`. It is reached **from the
Inspector as a link out**, never embedded — it is a different key (a device, not an operating day) and
`A§13.3` names what must not be shown there.

---

## 8. Reuse inventory — what already exists

### 8.1 Frontend components to reuse verbatim
| Component | Path | Reuse as |
|---|---|---|
| `TodaysDispatchPage` | `pages/dispatch/TodaysDispatchPage.tsx` (553) | **The Console shell.** Grows; is not replaced |
| `CrewCard` + `ProvenanceLegend` | `pages/dispatch/CrewCard.tsx` (166) | Board lanes; gains selection only |
| `TracePanel` / `DecisionTraceView` | `pages/dispatch/DecisionTrace.tsx` (160) | Inspector **Why** band |
| `CandidateColumn` | `pages/assign/CandidateColumn.tsx` (154) | Inspector **Alternatives** band — already tier-grouped with drop reasons |
| `OverrideImpactPanel` | `components/domain` | Inspector **Impact** band |
| `grammar.tsx` + `GrammarLegend` | `pages/assign/grammar.tsx` (95) | The one chip grammar, shared by both boards |
| `LoadBadge` | `components/ui/LoadBadge.tsx` | Every capacity display, all seven surfaces |
| `LaneCoverage` / `LaneHeader` | `pages/assign/LaneCoverage.tsx` (119) | Assign-mode lanes |
| `ReviewCommitScreen` | `pages/assign/ReviewCommitScreen.tsx` (287) | Assign-mode commit step |
| `DistributePanel` | `pages/assign/DistributePanel.tsx` (204) | Assign-mode distribute |
| `IntradayManualAssignModal` | `pages/schedules/IntradayManualAssignModal.tsx` (117) | Escalation resolve |
| `MetricStrip`, `EmptyState`, `PageHeader`, `DataTable`, `Badge`, `Button` | `components/data`, `components/ui` | Everywhere |

**The six override control panels on `ScheduleDetailPage.tsx` (591) are the Inspector's Actions band.**
They are **moved**, not copied — that is what keeps `#282 R5` satisfied under C6.

### 8.2 Backend reads to reuse — no change needed
`GET /dispatch/today` · `GET /dispatch/changes-today` · `GET /dispatch-runs` · `/:runId` ·
`/:runId/zones/:zoneId` · `/:runId/decisions` · `/:runId/tickets/:ticketId/trace` ·
`GET /batches/:batchId` · `GET /schedules/candidates` · `GET /schedules/assignable-work` ·
`GET /schedules/assignable-tickets` · `GET /schedules/engineers` · `GET /schedules/preview` ·
`GET /tickets/:id` · `/:id/attempts` · `/:id/forms` · `GET /org/zones` ·
`GET /dashboard/action-required` `[CODE — all verified this pass]`

### 8.3 Backend writes to reuse — no change needed
`POST /batches/:id/override` · `POST /batches/:id/override/preview` · `POST /schedules/assign` ·
`assign-plants` · `assign-batch` · `distribute-preview` · `holds` · `holds/release` ·
`POST /schedules/dispatch-run` (for OH/CSM) `[CODE]`

### 8.4 The one architectural addition the Console needs that no page needs today
**The admin app has no query cache.** Fetching is `useApiResource` per component; a mutation refetches
one or two reads by hand `[DOC — UI§29.1; CODE — TodaysDispatchPage's hand-rolled `load()`]`. Six panes
over overlapping reads will drift out of sync after the first override.

**Fix: one lifted fetch of `GET /dispatch/today` owned by the Console shell, which every pane reads
from and every mutation invalidates.** That is one hook, not a caching library. `UI§27` already
specifies a mutation → refresh contract per action; the Console makes it **mandatory rather than
advisory**. `[INFER]`

---

## 9. Backend changes actually required

Seven, all small, all named. **None of them touches the recommender, scoring, hard filters, capacity
enforcement, the schema, or a migration.** No new table. No new column. No migration in this plan.

| # | Change | File | Why it is required | Size |
|---|---|---|---|---|
| **B0** | **Delete the stray `'` at `scheduler-preview.service.ts:221`** | `scheduling/scheduler-preview.service.ts` | The backend does not compile. Nothing below is verifiable until this lands (C9) | XS |
| **B1** | Add `componentBlockedWithheld` and `bucketlessDropped` to `TodaySituation` | `dispatch-today-query.service.ts` | Two funnel populations are recorded per run and invisible live, so the six counters imply an exhaustiveness they do not have (A3) | S |
| **B2** | Expose `nextFireAt` (read-only) to the three manager roles | `schedules.controller.ts:163` | **A ZM cannot answer "why is my deck empty at 04:55?"** The hour is configurable, so it cannot be inferred. A hole in the ZM's own primary screen | XS |
| **B3** | **D5 — widen `dispatch-run` to ZM *with the clamp*, all four parts in one change** | `schedules.controller.ts:190-232` | See the box below. **Must not be split** | S |
| **B4** | `GET /tickets/:id/decision` — resolve a ticket to its deciding `runId` | new thin route on `tickets.controller.ts` | The Inspector's Why band needs `(runId, ticketId)`; from a rail row or an attention item the console has the ticket and not the run | S |
| **B5** | `GET /dashboard/action-required?zoneId=` — explicit zone scope | `dashboard.controller.ts:77` | `action-required` is global for CSM/OH. Beside a single-zone deck the two panes disagree — **a correctness bug, not polish** (A8) | S |
| **B6** | Light the two nearly-free attention cards (vehicle unavailability, failed verification) | `dashboard.service.ts:876` | One `COUNT(*)` each over data that already ships and already renders elsewhere | S |
| **B7** | Resolve actor **names** on the change ledger | `dispatch-changes-today.service.ts:111,121` | `actorId` is a bare UUID today. *"Ravi moved it"* is the operator-facing fact; a UUID is not | XS |

> ### B3 in full — the four parts, and the hole if any is skipped
> `POST /schedules/dispatch-run` reads its zone straight from the request body and **never checks it
> against the caller**: `zoneId: body.zoneId != null ? BigInt(body.zoneId) : undefined`
> `[CODE — schedules.controller.ts:203]`. That is safe **only** because
> `@Roles('OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER')` are both global-scope roles.
>
> **Widen the role list without a clamp and any Zonal Manager can rebuild another manager's day plans
> — or omit `zoneId` entirely and trigger a run across every zone in the country.**
>
> 1. Widen `@Roles` on `POST /schedules/dispatch-run` to the three manager roles.
> 2. **Clamp:** when the caller is `ZONAL_MANAGER`, take the zone from token claims and **ignore** the
>    body value. *Ignore, not validate* — a client that simply stops sending the field must not reach
>    the pan-India path.
> 3. Widen **and clamp** `GET /schedules/dispatch-run/in-flight`, which today returns every zone
>    globally `[CODE:227-232]`.
> 4. Hide the zone picker entirely for a ZM (`UI§4.4` — hide, don't disable).
>
> **This widens the RBAC ladder `#272`/`#282` deliberately held closed. It is a legitimate operator
> call, but it must be recorded as an explicit reversal in a decision record, not slipped in as a
> role-list edit** (§14 D3).

### Also required, and it is not new work — it is finishing #239
**Acting-zone (`X-Acting-As-Zone`) is honoured on roughly half the `/schedules` routes**
`[DOC — #239, Status: needs-triage]`. Across separate pages this is confusing. **On one screen showing
two panes at once it is incorrect** — a pool clamped to the acting zone beside a candidate column
scoped pan-India offers engineers for work the pool never showed. `#239` becomes a **prerequisite** of
the Console, not a background defect. `[DOC — A§26 B3; CODE — the two `/assign` clients already send
the header and say why]`

---

## 10. What is frontend-only

Everything in this list ships with **zero backend change** and is the bulk of the value.

1. **Zone picker** for CSM/OH from `GET /org/zones`, hidden for ZM, with a remembered last zone. Fixes
   the fact that two of three roles cannot open the primary screen at all today (C4).
2. **Run Now relocated onto the Console** for OH and CSM — the roles the endpoint already serves —
   with the in-flight guard, the reason box, the **notifies-engineers** warning, and the **explicit
   zero-result state**. Fixes the broken `/bulk-unassign` link (C3). ZM support is B3.
3. **Selection on the board.** Chips, stops, lanes and rail rows become selectable; URL-reflected.
4. **The Inspector column** — Identity / Why / Alternatives / History / Actions / Impact, composed
   from `TracePanel`, `CandidateColumn`, `OverrideImpactPanel` and the relocated Schedule Detail
   panels. *(Actions band gated on C6.)*
5. **Tier-grouped alternatives in the Console.** The data is served today and `CandidateColumn`
   already renders it correctly; a flat, score-sorted list teaches a false model of the engine.
6. **Per-term score breakdown rendering** — served, typed, discarded (C7).
7. **Three links out of the Inspector**: ticket → journey, ticket → attempts, plant → devices.
8. **One lifted fetch** in the Console shell + a mutation → invalidation contract (§8.4).
9. **Find ticket / SE** over the payload already in memory.
10. **Health line** composed from `.recovery` plus (once B1 lands) the skip and staleness signals.
11. **The `DEFICIT`/`PREVENTIVE` → "Catch-up"/"Steady" copy mapping** — engine enum names must never
    reach a user-facing surface `[DOC — UI§34.1]`.

---

## 11. Not possible with the current system — refuse once, here

Every item below would produce a plausible wireframe that promises something the engine cannot keep.
They are listed so the design phase refuses them **on the record** rather than rediscovering them in
review.

| Wanted | Reality `[CODE unless noted]` |
|---|---|
| A **fleet-wide / pan-India scheduler view** | No aggregate read exists; the backend refuses to guess a zone deliberately — *"'all zones' is not a cockpit, it is a different product"* |
| A **date picker on the live Console** | `GET /dispatch/today` is `istDate(now)`, always |
| *"What the Scheduler decided for tomorrow"* | **Nothing is decided for tomorrow.** Only a projection exists |
| A **staleness badge on the projection** | `checkStaleness()` is implemented at `scheduler-preview.service.ts:135` and **no route calls it** |
| **Cancel / pause / retry a run** | No API. `ABORTED` is reaper-only and means *"the process stopped existing"* |
| **Run progress %** | The engine has no stage concept and no total-zone count while running |
| **Live GPS / ETA / route line / map** | Ruled out (`#258 Q6`, `#272 R7`). Distance exists only as a scoring term |
| One atomic **"Commit all changes"** | No such construct; `#272 R8` rules per-item commit and per-item results |
| **Per-ticket priority / "promote this"** | No mechanism at any level |
| **Preview of a configuration change** | The projection takes no weight or threshold parameters |
| An **"Approve the plan"** step | Inaction means the 05:00 run proceeds exactly as if nobody looked |
| An itemised **policy-withheld** list | The engine counts and never itemises; there is nothing to list |
| **`TIER_NOT_REACHED` in the assign console** | A human may cross tiers |
| A **capacity page** | There is no capacity endpoint; capacity is a property of a lane |
| **One combined "not dispatched" number** | Different populations, different owners, different actions |
| **`repeat_failure_penalty` as a Console control** | It is a live, OH-editable weight that **changes no decision** — see below |

> ### The dead lever, stated once
> `repeat_failure_penalty` **subtracts** (in Catch-up mode a repeatedly-failing device scores *lower*),
> **cancels out entirely** (it is a *ticket* property in a score that picks an *engineer*, so it shifts
> every candidate identically), and **the queue order never consults it** (`compareCandidates` is
> tier → bucket → return-due → priority rank → oldest inactive → device id). `[DOC — feasibility D2,
> from CODE]`
>
> **Decision D2 was to leave it alone. The Console consequence is binding: do not surface it as a
> control in any Console configuration panel.** Exposing a dead lever on the screen whose stated
> purpose is *teaching* would actively mis-teach.

---

## 12. Role variants — three consoles, not one with disabled buttons

Rendering the union of three roles' controls greyed out fails the direction's own requirement. From
the authorization model as it stands in code:

| | **ZONAL_MANAGER** | **CENTRAL_SERVICE_MANAGER** | **OPERATIONS_HEAD** |
|---|---|---|---|
| **Lands on** | Their zone's deck, immediately | **"Choose a zone"** — the backend refuses to guess | Same as CSM |
| First question | *"Is my day intact, what needs me?"* | *"Which zone is in trouble?"* | *"Is the engine behaving, is policy right?"* |
| Zone picker | **Hidden** (403s anyway) | Required | Required |
| Run Now | ✗ today → ✓ own zone, forced (B3) | ✓ any zone / all | ✓ any zone / all |
| Sees `nextFireAt` | ✗ — **gap (B2)** | ✗ — **gap (B2)** | ✓ |
| Overrides · holds · assign · escalations | ✓ | ✓ | ✓ |
| Bulk unassign · scoring weights · cron | ✗ | ✗ | ✓ |
| Assignment threshold | ✗ | ✓ | ✓ |
| Acting-as-zone | n/a | ✓ (inconsistently honoured — #239) | ✓ (same) |

`[CODE — controller `@Roles` decorators; `settings/setting-authority.ts`; `AppRoutes.tsx` RoleRoutes]`

**Three consequences the design must absorb:**

1. **The ZM Console is genuinely simpler and should look it** — no zone picker, no engine config, no
   cross-zone anything.
2. **CSM/OH have a first-run problem the ZM does not.** Their opening state is a picker, not a
   dashboard. **Do not fabricate a fleet summary to fill it** — no aggregate read exists. A remembered
   last zone plus an explicit chooser is the honest answer.
3. **Every permission above is enforced server-side already.** The Console's role variance is a
   *rendering* concern; it adds no new gate and removes none.

---

## 13. The slice sequence — what to build, in what order

Five phases. Each is independently shippable and each states what it unblocks. **Phases 0 and 1
overturn no ruling and need no backend change** — that is deliberate, and it is what makes the
architecture question in §14 empirically answerable rather than speculative.

### PHASE 0 — unblock (hours) — ✅ **DONE 2026-08-27**
| | Work | Why it is first | Outcome |
|---|---|---|---|
| 0.1 | **Repair the corrupted docblock at `scheduler-preview.service.ts:221`** | `tsc` reports one error; nothing can be built or verified until it is gone (C9) | ✅ The line was worse than a stray quote — a docblock with unrelated text pasted into it (`…the very  ZOPerational HEAD scope is not defined. next run* . */'`). Restored to `/** Release a hold — the ticket re-enters the very next run. */`. **`npx tsc --noEmit` now exits 0 in both apps** |
| 0.2 | **Correct `#285`'s record in both places** — `INDEX.md` row 4 and `285-…md:3` | Scoping from INDEX prices C3's work at zero | ✅ Both corrected. INDEX row 4 is now `DONE-WITH-CORRECTION` and states that "Run-dispatch relocated" was never true and that the button bounces a ZM and a CSM to the dashboard; the issue header moved from a stale `ready-for-agent` to `done-with-follow-up` with the same correction. The remainder is owned by Phase 1.2 |
| 0.3 | **Two counts, from the database** — ESCALATED tickets by age and zone; devices matching the D1 predicate today | Decides whether D1a is one pass or a zone-by-zone stagger. A database question, not a design one | ✅ Run against `localhost:5433/fsm`. **Both answers are decisive and neither is what the plan assumed** — see the box below |

> ### Phase 0.3 — what the database actually says
> Measured 2026-08-27 against the working database (29,475 failure cycles over 26,056 devices;
> 29,475 tickets).
>
> **Count 1 — ESCALATED tickets by age and zone: there are none.** `SELECT status, count(*) FROM
> tickets GROUP BY 1` returns exactly three statuses — `CLOSED` 16,799 · `OPEN` 10,276 ·
> `CLOSED_AUTO_RECOVERY` 2,400. **Zero `ESCALATED`.** The 212 rows that *do* carry an escalation are
> `intraday_insertions` with `status = 'ESCALATION_REQUIRED'`, and all 212 are `SYSTEM_CRITICAL`
> (#268's no-capacity-eligible-engineer path) — **not one is a repeat-failure escalation.**
>
> **Count 2 — the D1 predicate population.** Failure cycles per device top out at **four**:
> 22,755 devices have 1 · 3,188 have 2 · 108 have 3 · 5 have 4. So:
> - **≥3 failure cycles (the plain reading): 113 devices**, 68 of them with a cycle open right now.
> - **≥3 *repeat* cycles (the `repeat_failure` reading): 0 devices.** Only 72 cycles in the entire
>   database have `repeat_failure = true` at all (63 `REPEAT`, 9 `FAILED`).
>
> **Three consequences, and they change the plan rather than confirming it.**
>
> 1. **D5 is answered by data, not by preference.** `RepeatEscalationService` implements *"3+ repeat
>    episodes within 7 days"* `[CODE — repeat-escalation.service.ts:5-6, 29-34]`. That predicate
>    selects **zero devices** — not zero-in-7-days, zero *ever*, because no device has three repeat
>    cycles. **Only the plain reading (≥3 failure cycles) yields a population a manager would ever
>    see.** A "Repeated" filter built on `repeat_failure` would ship a chip that is permanently empty.
> 2. **D1a is a no-op and its two feared migration effects cannot occur.** The burst of auto-closures
>    and the burst of dispatchable work both presuppose a backlog of repeat-failure escalations. There
>    is no such backlog: zero `ESCALATED` tickets, zero devices over the threshold. **Phase 3.5 needs
>    no zone-by-zone stagger, and the `ticket_events` audit requirement, while still correct, will
>    write no rows against current data.** Phase 3.5 drops from a staged migration to a guard.
> 3. **The 15-minute cron (C5) has never escalated anything, and that is the finding, not the
>    reassurance.** `@Cron('*/15 * * * *')` has been live and has produced zero `ESCALATED` tickets
>    because its threshold is unreachable. C5 said the stale docstring made a dormant-looking defect
>    fire every fifteen minutes; the truth is the reverse — **it fires every fifteen minutes and does
>    nothing.** Whether `repeat_failure` is under-written upstream is a separate question this slice
>    does not own, but it must be asked before D1 is designed on top of that column. `[OPEN]`


### PHASE 1 — make the built cockpit whole — ✅ **DONE 2026-08-27** (no backend change · no ruling overturned)
| | Work | Delivers | Outcome |
|---|---|---|---|
| 1.1 | Zone picker from `GET /org/zones`, hidden for ZM, remembered last zone | **Two of three roles can open the primary screen at all** | ✅ `console/ZonePicker.tsx`. Hidden for a ZM (`listZones` is never even called); a CSM/OH with no zone gets `ChooseZoneState` and **the deck read is suspended** rather than fired at a guaranteed `400 ZONE_REQUIRED` — a defect the tests caught, see the note below. Last zone remembered in `localStorage`, wrapped in try/catch |
| 1.2 | Run Now relocated onto the Console for OH/CSM, with in-flight guard, reason, the notifies-engineers warning and the **zero-result state** | Fixes C3's broken button | ✅ `console/RunNowControl.tsx` calls `POST /schedules/dispatch-run` directly. The `<Link to="/bulk-unassign">` is **deleted** from `PlanMode`. In-flight pre-check, populated-409 handling, reason box, the engineers-are-notified warning *before* confirm, and a designed zero-result state that names the OPEN-and-UNASSIGNED predicate. Hidden for a ZM pending B3 |
| 1.3 | Board selection + the Inspector's **read** bands: Identity, Why, Alternatives (tier-grouped), History | *Understand and inspect without leaving* | ✅ `console/selection.ts` + `console/Inspector.tsx`. Chips, stops, lanes, People-rail rows and Work-rail rows are all selectable and all drive **one** Inspector; selection is URL-reflected (`?sel=ticket:<id>`) and `Esc` clears it. Alternatives reuses `CandidateColumn` (now read-only when `onAssign` is omitted); Why reuses `DecisionTraceView` |
| 1.4 | Render the per-term **score breakdown** (C7) | The engine's own explanation stops being discarded | ✅ `console/ScoreBreakdownPanel.tsx` — term · feature · weight · contribution, from the persisted `scoreBreakdown`. Zero-weight terms stay visible and say they were not consulted; the `max(baseScore,0)` floor is explained when it bites; `NOT_AVAILABLE` distance never renders as 0 km; an `UNASSIGNABLE` breakdown renders as a reason, not an empty table; `DEFICIT`/`PREVENTIVE` are mapped to Catch-up/Steady per UI§34.1 |
| 1.5 | Three links out: ticket → journey, ticket → attempts, plant → devices | Drill-down without a second nav trip | ✅ In the Inspector, plus stop → batch and engineer → day plan |
| 1.6 | One lifted fetch in the Console shell + the mutation→invalidation contract (§8.4) | **Required by everything in Phase 2** | ✅ `console/useConsoleData.ts`. One `GET /dispatch/today` owned by the shell; a request-sequence counter so a slow earlier response cannot land on top of an invalidation; Run Now already invalidates through it, which is the contract Phase 2's overrides inherit |

**Also delivered, from the approved structure (§0.5.3):** the four-region layout —
`console/PeopleRail.tsx` (left), the existing `CrewCard` board (centre, now selectable),
`console/WorkRail.tsx` (right, tabbed Unassigned/Held/Changes with the withheld count as a panel and
never a tab), and the Inspector across the bottom. Plus find-ticket/SE over the payload already in
memory (§3.5), which filters and never refetches.

> ### Two defects Phase 1's own tests caught, recorded because both were live in the first draft
> 1. **The Console fired `GET /dispatch/today` with no zone for a CSM sitting on the chooser** — a
>    guaranteed `400 ZONE_REQUIRED` on every open, and a race with the chooser's first real fetch.
>    `useConsoleData` now takes an `enabled` gate. The test asserts the call is *not made*, which is
>    the only way to catch it: the screen looked correct either way.
> 2. **The Inspector named the plant twice** — once in its own facts strip and once in the trace's
>    identity strip. Fixed by giving the facts strip only what the trace has no idea about (which
>    engineer, which stop, SLA, tier, provenance).

**Verification:** `tsc --noEmit` clean in **both** apps · `vite build` clean · **113 admin test files,
687 tests, all passing**, including 30 new Phase 1 tests in
`apps/admin/test/scheduler-console-phase1.test.tsx`. One pre-existing unhandled rejection persists in
`test/ticket-drawer-tabs.test.tsx` (`TicketDetailDrawer.tsx:440` reads `attempts.attempts` without a
guard) — **neither file is in this change set**; it is noted here so it is not mistaken for fallout.
The backend suite was not run this session; the only backend change is the Phase 0.1 docblock repair,
which is a comment.


> **After Phase 1 the Console *is* the workspace for everything except changing the plan and handing
> out work** — and as of 2026-08-27 that is true in code, not in plan. C6 and C2 have both been
> approved (§0.5.2), so Phase 2 is unblocked; what still gates it is **D3's decision record** for the
> RBAC widening and **#239**'s acting-zone completion, neither of which is a design question.

### PHASE 2 — commandable — ✅ **DONE 2026-08-28** (C6 approved; see §0.5.2)
| | Work | Outcome |
|---|---|---|
| 2.1 | **B3 — the clamp, all four parts in one change**, plus the decision record recording the RBAC reversal | ✅ `@Roles` widened to the three manager roles on `dispatch-run` **and** `dispatch-run/in-flight`; the zone is derived from `@CurrentScope()` and the body is **ignored** for any caller with a zone of their own; `inFlightZones(zoneId?)` narrows the guard; the ZM picker was already hidden (Phase 1.1). Recorded as [`#291`](../../.scratch/fsm-platform-v1/issues/291-decision-zm-run-dispatch-rbac-reversal.md) and pinned by `dispatch-run-zone-clamp.e2e-spec.ts` |
| 2.2 | Finish **#239** acting-zone on the `/schedules` routes the Console reads | ✅ Converted **exactly the Console-reachable set**, not a sweep (#239 says *"decide, don't sweep"*): `GET /schedules/engineers`, `GET /schedules/:engineerId`, and all three of `batches.controller` (`:batchId`, `override/preview`, `override`). The rest of #239's 61 sites remain its own |
| 2.3 | **Move** the six override panels into the Inspector's Actions band | ✅ `console/ActionsBand.tsx`. All six commit through `POST /batches/:id/override` — no new write path exists. Reason mandatory, impact previewed where projectable, both 409 gates as a second step |
| 2.4 | Assign / hold / release / resolve-escalation in the Inspector | ✅ On ids already in the payload. `placementOf` decides the legal set from where the ticket actually is |
| 2.5 | Retire or redirect `/schedules/:engineerId` per §14 D7 | ⏸ **Deliberately not done — D7 is still open.** See below |

> ### Why 2.5 was not executed
> D7 asks whether `/schedules/:engineerId`, `/schedules`, `/intraday` and `/schedules/preview` survive
> as routes. **It is still open, and retiring a route is not reversible by the next session's edit** —
> deep links go dead, and `/intraday`'s escalation modal is live even though its ledger half is
> structurally dead. The Console now makes every one of those pages *optional* rather than necessary,
> which is the precondition D7 needed; the decision itself is the operator's. Both surviving deep links
> (engineer → day plan, stop → batch record) are wired from the Inspector and work today.

> ### Three defects found while absorbing the override controls
> None of these were in scope; all three were live on the existing surface and are fixed.
>
> 1. **Both override 409s were typed as the ON_SITE conflict.** The backend has always returned two
>    distinct codes — `OVERRIDE_ON_SITE_CONFLICT` and `CONFLICT_DEFERRED` — but `api/schedules.ts`
>    declared `OverrideConflict` with the ON_SITE code only, so `ScheduleDetailPage` told an operator
>    *"SE is ON_SITE on affected work"* about a ticket whose blocker was a future vehicle-return date.
>    The confirm worked; the sentence explaining what they were confirming was about the wrong thing.
>    Now a discriminated union, fixed on **both** surfaces.
> 2. **`placeHold` threw away its populated 409.** The backend comments that the refusal is *"returned
>    as a 409 body rather than thrown away: the client needs the return-date context"* — and the client
>    routed it through a helper that throws on `!res.ok`, making both refusal variants declared in
>    `HoldResult` **unreachable** and every refusal a bare `REQUEST_FAILED_409`.
> 3. **`POST /batches/:id/override` hard-coded `actedAsRole: null`.** An override committed by an
>    acting CSM recorded as an ordinary CSM action and the acting was lost from the ticket's history.
>    `RequestActor` had always resolved it; this one writer never asked.


### PHASE 3 — the attention band — ✅ **DONE 2026-08-28** (3.1–3.4; 3.5 dissolved)
| | Work | Outcome |
|---|---|---|
| 3.1 | **B5** — `?zoneId=` on `action-required` (**must precede 3.2**) | ✅ Landed first, as required. A ZM stays clamped by scope and the parameter cannot widen them; it only narrows a role that would otherwise see every zone |
| 3.2 | **B6** — light the two nearly-free cards; render the band in the Console | ✅ `vehicle_unavailability` (open VU reports) and `failed_verification` (`verification_runs.outcome`) are one `COUNT(*)` each, so the **dashboard** is repaired from the same definition. `console/AttentionBand.tsx` ranks by the endpoint's own urgency, gives each item a destination checked against `AppRoutes.tsx`, and renders a stub as *not counted*, never as `0` |
| 3.3 | **B1** funnel counters · **B2** `nextFireAt` · **B7** actor names | ✅ All three. B1 reads the same `dispatch_run_zones` row `policyWithheld` reads, so all three counters describe one run of one zone by construction, and **null renders as "—/not recorded", never `0`**. B2 widened the schedule **read** to the three manager roles and left the write OH-only. B7 resolves ids in one `IN` for the whole page |
| 3.4 | **D1** — chronic device as a derived read-side predicate | ✅ **Landed once the operator answered D6 and D8 (2026-08-28).** Computed, never stored: `CHRONIC_FAILURE_CYCLE_THRESHOLD` plus a `failureCycles` count per row, filled by one `groupBy` for the whole payload. No table, no column, no migration — and nothing in the recommender consults it, so it provably cannot alter ranking |
| 3.5 | **D1a** — release repeat-failure escalations | ❎ **Dissolved by Phase 0.3.** The population is empty: zero `ESCALATED` tickets exist and no device meets the threshold, so there is nothing to release and neither feared migration burst can occur. What remains is a guard, not a migration, and it belongs with 3.4 |

> ### Two things worth stating about B6's queries
> **`failed_verification` counts `verification_runs.outcome`, not `tickets.status`.** The verdict lives
> on the run — the same column `/verification`'s review queue reads. Counting the ticket status would
> drift the moment a ticket moves on from `FAILED_VERIFICATION` while its failed run still stands.
>
> **`vehicle_unavailability` counts `OPEN` reports only.** A `RESOLVED` report is history for one
> ticket, not work waiting on anybody, and the page that renders these makes the same split.

> ### One destination this band deliberately does not deep-link
> `recovery_stalled` links to `/tickets` **unfiltered**. `TicketsPage` holds its filters in local state
> and never reads the URL, so `/tickets?workType=RECOVERY` would look like a filtered deep link and
> arrive unfiltered — a worse failure than an honest unfiltered one, because it is invisible. The verb
> promises only what the link delivers. Filtering it is a change to `TicketsPage`, not to this band.

> ### 3.4 — the operator's D6 and D8 answers, and one correction made against them
> **D6 — the signal is "chronic device", not "Repeated Inactive".** It names the *equipment*, which is
> what the predicate measures, and reads as clearly distinct from **Special** (failed *visit attempts*).
> A device can be both, and the two ask different questions: *should this be replaced?* versus *why can
> nobody reach it?* "Repeated Inactive" also overloaded "inactive", which already means "not reporting
> GPS" platform-wide.
>
> **D8 — it is a replace-or-investigate queue, not a go-sooner one**, and the copy says so. This is the
> honest framing rather than the flattering one: `repeat_failure_penalty` is a *ticket* property in a
> score that picks an *engineer*, so it shifts every candidate identically and decides nothing (§11's
> dead lever). Dispatch treats a chronic device exactly like any other, and the band says that out loud
> before naming the action that is real.
>
> **The predicate is settled by data (D5):** the `repeat_failure` reading selects **0 devices**, the
> plain ≥3-failure-cycles reading selects **113** (108 with three, 5 with four; 68 open now).
>
> ### The correction applied against the approved option
> The chosen preview drew the marker in **amber**. **Amber is spent.** `#290` fixed a live defect in
> which over capacity had been drawn crimson (reserved for critical work) and tier-crossing amber
> (reserved for over capacity) — in three places including `LoadBadge`, which appears on seven
> surfaces. A fourth meaning in amber would re-create precisely that collision.
>
> The marker therefore ships as an **inline token in the `RET` idiom** — `CHR ×4`, no border, no hue.
> It stays legible beside a `SPECIAL` badge, survives grayscale because it carries a word and a number
> rather than a colour, and leaves the border grammar's three meanings intact. **Intent honoured,
> colour changed**, and pinned by a test asserting the marker carries no border class.


> ### D1a's two migration effects — **superseded by Phase 0.3, kept for the reasoning**
> *Neither effect can occur against current data: there is no backlog of repeat-failure escalations to
> release. The analysis stands if that ever changes.*
> The two escalation causes are distinguishable by a recorded reason code
> (`REPEAT_ESCALATION` vs `VERIFICATION_FRAUD_ESCALATED`), so *"release the repeat ones, keep the
> fraud ones"* is an exact query `[DOC — feasibility D1a, from CODE]`. But:
> 1. **A burst of auto-closures.** Devices that recovered weeks ago have tickets stuck unable to
>    close. The next auto-recovery sweep closes them as self-healed — correct, and it lands in Fleet
>    Uptime and the monthly cubes on **one day**.
> 2. **A burst of dispatchable work** competing for the same engineer capacity on the next run.
>
> **Audit requirement:** one `ticket_events` row per released ticket with its own reason code, so the
> change reads as a deliberate act in every ticket's history rather than an unexplained state change.

> **Correction to Phase 3, found by Phase 4's full backend run (2026-08-28).** **B5** gave
> `DashboardService.actionRequired` a `filters` parameter **inserted before** the existing trailing
> `now`. Two specs called it positionally as `(scope, NOW)`, which after B5 hands the frozen test
> clock to `filters` and lets `now` default to the real one — moving a 7-day cutoff by two months and
> making a deliberately-not-overdue fixture count. Both call sites are fixed. It surfaced as a wrong
> **number**, not a type error, because `apps/backend/tsconfig.json` includes only `src`
> ([`#293`](../../.scratch/fsm-platform-v1/issues/293-backend-tests-untypechecked.md)); and only a
> **full** run could find it, because both specs call the service directly rather than the route, so
> Phase 3's changed-route spec run was honestly green and still missed it. **Inserting a parameter
> before an optional trailing one is a silent break for every positional caller.**

### PHASE 4 — Assign mode — ✅ **DONE 2026-08-28** (C2 overturned per D2; D4 answered — zone-scoped, `/assign` kept)
| | Work | Outcome |
|---|---|---|
| 4.1 | Assign mode as **its own board region** — pool, draft lanes, distribute, review, commit — reusing `AssignConsolePage`'s five components wholesale | **Done, and one step further than "reuse the five components".** The five were always reusable; the *draft state machine* was not — it lived in `AssignConsolePage`'s 1,037 lines, and a Console that rebuilt it would have owned a second implementation of a machine whose whole contract is "nothing is written until commit". So the workspace was **lifted out whole** into `pages/assign/AssignWorkspace.tsx` and `/assign` became a 35-line route that renders it. Both surfaces are now one implementation differing in three props: `zoneId`, `engineers`, `header` |
| 4.2 | Enforce the mixed-commitment rule (§3.4): a draft chip and a committed chip never share a lane object | **Done, and made structural rather than conventional.** Assign mode **replaces** the board, both rails and the Inspector instead of sitting beside them, so the two lane vocabularies are never on screen together — there is no drag to forbid because there is nowhere to drag to. Two further reasons, each independently sufficient: the Work rail and the Assign pool are *different predicates* over "unassigned work" (engine-refused vs. manually-assignable) and side by side under one zone heading are the B5 defect one region over; and the Inspector's Actions band writes on confirm, which is immediate writes beside lanes that write nothing. **Entering drops the selection** and leaving does not restore it. The frame — zone, day, run state, six counters, Run Now, health — stays throughout |
| 4.3 | Zone-scope the Console's pool; keep `/assign` standalone for the pan-India case, or retire it per §14 D2 | **Done per D4: narrowed, `/assign` kept.** The narrowing is client-side and exact — the pool rows already carry `zoneId` — so Phase 4 ships with **zero backend change**, as §10 predicted. **The ledger is re-derived, not carried:** the server's totals are its sum over the pan-India set, and keeping them would print "21 unassigned" above five rows totalling five, on the one surface whose purpose is to answer *how much is left*. **The roster is narrowed too, and that was the near-miss:** `GET /schedules/engineers` is *also* pan-India for a CSM not acting in a zone, so it would have offered another zone's engineers as lane targets for this zone's work. The Console passes the roster from its own lifted payload instead — same `committed` figure the board's load badges show, so one screen never holds two counts of one engineer's day |

### Explicitly NOT in this plan
- Drag and drop, in any phase (§3.3). It can be proposed later as a dialog *initiator* only.
- Any recommender, scoring, hard-filter or capacity change. **Zero engine work anywhere above.**
- Any schema change or migration. **No new table, no new column.**
- Every item in §11.
- A natural-language Copilot. `A§13.4` — nothing to build on and not needed for v1. Levels 1–4
  (explain / recommend / simulate / act) are what Phases 1–2 actually deliver, under different names.

---

## 14. Open decisions — approval is blocked on these

| # | Decision | Blocks | Recommendation |
|---|---|---|---|
| **D1** ✅ **APPROVED 2026-08-27 · IMPLEMENTED 2026-08-28** | **C6 — absorb `/schedules/:engineerId`'s override controls into the Console Inspector.** The 2026-08-25 ruling declined *building* them there; this asks to *move* them, leaving one implementation | **Phase 2 entirely.** Without it the Console is read-only and the direction's central promise is undeliverable | **Approve.** The ruling's reason was "would duplicate"; absorption does not duplicate, and `#282 R5` is satisfied |
| **D2** ✅ **APPROVED 2026-08-27**, conditional on §3.4 | **C2 — overturn `#280 R7`** so Assign becomes a Console mode with its own board region? | Phase 4 only. Nothing else | Approve, **with** the mixed-commitment rule (§3.4) as a written condition |
| **D3** ✅ **RECORDED AND IMPLEMENTED 2026-08-28** as [`#291`](../../.scratch/fsm-platform-v1/issues/291-decision-zm-run-dispatch-rbac-reversal.md) | **Record the RBAC widening (B3) as an explicit reversal** of the ladder `#272`/`#282` held closed | Phase 2.1 | Approve as a decision record, not a role-list edit |
| **D4** ✅ **ANSWERED 2026-08-28 — accept the narrowing, keep `/assign` · IMPLEMENTED same day** | **Console Assign mode is zone-scoped** — a deliberate narrowing of today's pan-India pool for CSM/OH. Accept, or keep `/assign` standalone for the pan-India case? | Phase 4.3 | Accepted as recommended. The narrowing covers the **pool, its ledger and the lane roster** — `assignable-work` and `/schedules/engineers` are both pan-India for a CSM not acting in a zone, and only the first was obvious. `/assign` is unchanged and keeps the pan-India pool: *where in the country is the work?* is a different question from *what is left in this zone today?*, and it is asked on a surface with no zone-scoped deck beside it to contradict |
| **D5** ✅ **ANSWERED BY DATA 2026-08-27** | **D1's predicate: 3 failures, or 3 *repeat* failures?** | Phase 3.4's predicate | **Settled by Phase 0.3, not by preference.** The `repeat_failure` reading selects **0 devices** (only 72 such cycles exist in the whole database and no device has three). The plain reading selects **113**. A filter on the former would ship permanently empty. **Use ≥3 failure cycles** — and confirm with the operator that `repeat_failure` being written 72 times in 29,475 cycles is expected upstream behaviour, because D1 was designed on the assumption that column carries the signal |
| **D6** ✅ **ANSWERED 2026-08-28 — "chronic device"** | **Naming: "Repeated Inactive" vs "Special."** One is about the equipment, one about failed visits; a device can be both. Two similar red badges with no explainer and one gets ignored | Phase 3.4's copy | Needs an operator answer |
| **D7** ⏳ **still open** — consequential to D1, decide before Phase 2.5 | **Do `/schedules/:engineerId`, `/schedules`, `/intraday` and `/schedules/preview` survive as routes?** `/intraday`'s ledger half is **structurally dead** — it reads `MANUAL_ZM_UPDATE` audit rows that **no admin code writes** `[CODE, verified]` — but its escalation modal is live and must be relocated **before** the page is retired | Phases 2.5 and 4 | Retire `/intraday` after relocating its modal; keep the others as deep-link targets |
| **D8** ✅ **ANSWERED 2026-08-28 — replace-or-investigate** | **Is Repeated Inactive a replace-or-investigate queue, or is a faster visit expected?** Under D2 no visit gets faster | Framing and copy, not code | Needs an operator answer |

---

## 15. Acceptance criteria for the slice as a whole

The Console is done for v1 when, **for each of the three roles separately**:

1. The role can open `/dispatch/today` and reach a populated deck **without a hand-crafted URL**.
2. Six situation counters render live values, never summed, never example numbers, with the two
   missing populations either present (B1) or absent-and-said-so.
3. Selecting any ticket, stop, lane or rail row opens one Inspector showing identity, the engine's own
   reasoning including per-term score, tier-grouped alternatives with drop reasons, and history.
4. The legal action set for that object and that role is **present and hidden-not-disabled**; every
   action commits through the endpoint that already owns it; every one carries its mandatory reason;
   the two 409 confirm gates render as a second step, not an error.
5. Where the action is projectable, the impact panel renders **before** Confirm — and a failed
   projection loses the panel, never the Confirm.
6. Run Now is on the Console, guarded by the in-flight check, warns that engineers are notified, and
   has a designed **zero-result** state.
7. Every mutation invalidates the single lifted `GET /dispatch/today` fetch; no pane can show stale
   state after an override.
8. The attention band is **co-scoped with the deck** (B5) and every item names an owner and one action.
9. Nothing in §11 has been built, and nothing on the screen implies it exists.
10. Both suites green; `tsc --noEmit` clean in **both** apps.

---

*End of specification. **Phases 0–4 are implemented and verified** (§13) — the Console now SEES,
IDENTIFIES, INSPECTS, EXPLORES, ACTS, CONTROLS, VERIFIES and ASSIGNS. Of §14's eight decisions, seven
are answered: D1/D2/D3 approved and implemented, D5 answered by the Phase 0.3 counts, D6 and D8
answered on 2026-08-28 with 3.4 shipped against them, and **D4 answered on 2026-08-28** with Phase 4
shipped against it. **Only D7 remains open**, and it gates Phase 2.5 — deliberately not executed,
because retiring a route is not reversible by the next edit and `/intraday`'s live escalation modal
must be relocated first. **Every phase of this specification is now built.** What is left is D7's
route retirement, which is a decision before it is work.*
