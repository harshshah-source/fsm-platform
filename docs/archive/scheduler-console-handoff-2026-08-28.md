> **ARCHIVED 2026-08-28 — consumed.** Phase 4 was built from this handoff and D4 was answered; the current record is [`scheduler-console-implementation-slice-2026-08-27.md`](../audits/scheduler-console-implementation-slice-2026-08-27.md) §13/§14.
> Two items outlived it and were carried out before archiving: §6 is now [`#292`](../../.scratch/fsm-platform-v1/issues/292-ticket-drawer-attempts-unguarded.md), and §3 D7 is the slice doc only remaining open decision. Nothing below is current.

# Scheduler Console — session handoff, 2026-08-28

> **Read this second.** The authoritative record is
> [`scheduler-console-implementation-slice-2026-08-27.md`](./scheduler-console-implementation-slice-2026-08-27.md)
> — it carries the approved structure (§2.1), the operator rulings (§0.5), every phase's outcome (§13)
> and the decision table (§14). **This file does not restate any of it.** It exists to tell you the
> three things that document cannot: what is uncommitted, what is still open, and what bit me.

**Branch:** `feat/autoplant-integration` · **HEAD:** `56f5aec` · **Nothing from this session is committed.**

---

## 1. Where the work stands

**Phases 0, 1, 2 and 3 are implemented and verified.** Phase 4 (Assign mode) is the only one left.

Read, in order: the slice doc §13 (phase-by-phase outcomes), then the three `2026-08-27` / `2026-08-28`
rows in `.scratch/fsm-platform-v1/INDEX.md`'s Session log, then
[`#291`](../../.scratch/fsm-platform-v1/issues/291-decision-zm-run-dispatch-rbac-reversal.md) if you
touch anything near `dispatch-run`.

### Verification as of this handoff
| | |
|---|---|
| `tsc --noEmit` | clean, **both** apps |
| `vite build` | clean |
| Admin suite | **720 tests / 115 files, all passing** |
| Backend | typecheck clean; **specs for every route this session changed pass** (~90 tests across ~20 spec files) |
| Backend **full** suite | **not run this session** — the user interrupted it once and I did not retry. Run it before committing |

---

## 2. The uncommitted change set — and what is *not* mine

The working tree was **already dirty when this session started**. Do not assume every modified file is
this work.

**Backend (mine):** `scheduling/scheduler-preview.service.ts` · `scheduling/schedules.controller.ts` ·
`scheduling/dispatch-run.service.ts` · `scheduling/batches.controller.ts` ·
`scheduling/dispatch-today-query.service.ts` · `scheduling/dispatch-changes-today.service.ts` ·
`dashboard/dashboard.controller.ts` · `dashboard/dashboard.service.ts` ·
`test/dispatch-run-zone-clamp.e2e-spec.ts` *(new)* · `test/dashboard-action-required.e2e-spec.ts`

**Admin (mine):** `src/pages/dispatch/console/` *(new — 11 files)* ·
`pages/dispatch/TodaysDispatchPage.tsx` · `pages/dispatch/CrewCard.tsx` ·
`pages/assign/CandidateColumn.tsx` · `pages/schedules/ScheduleDetailPage.tsx` ·
`api/{dispatchToday,dashboard,schedules,schedulerPreview}.ts` ·
`test/scheduler-console-phase{1,2,3}.test.tsx` *(new)* · `test/todays-dispatch.test.tsx`

**Docs/tracker (mine):** this file · the slice doc · `INDEX.md` ·
`issues/285-todays-dispatch-cockpit.md` · `issues/239-…md` · `issues/291-…md` *(new)*

**Pre-existing dirt, NOT mine — leave alone or triage separately:**
`pages/dashboard/{ActivityTrendSection,ManagerDashboard}.tsx` ·
`pages/dispatch/{ConfigInEffectPanel,DecisionTrace}.tsx` · `scheduling/business-sweep-scheduler*` ·
`apps/admin/visual/baseline/*.png` · `test/dashboard-acting-scope.e2e-spec.ts` ·
`issues/23{6,7}-*.md` · the other `docs/audits/scheduler-*` documents · `apps/backend/_wh_evidence.mjs`.

---

## 3. What is still open

| | Decision | Blocks | Notes |
|---|---|---|---|
| **D4** | Is the Console's Assign pool **zone-scoped**, narrowing today's pan-India pool for CSM/OH? | **Phase 4.3** | The slice recommends accepting the narrowing and keeping standalone `/assign` for the pan-India case. Two panes on one screen that disagree about scope is a correctness bug, not a feature |
| **D7** | Do `/schedules/:engineerId`, `/schedules`, `/intraday`, `/schedules/preview` survive as routes? | **Phase 2.5** | Deliberately **not executed**. Retiring a route is not reversible by the next edit; `/intraday`'s ledger half is structurally dead but its escalation modal is live and must be relocated *before* retirement. The Console already makes all four optional, which is the precondition D7 needed |

D1, D2, D3 approved and implemented. D5 answered by data (Phase 0.3). D6 and D8 answered 2026-08-28.

---

## 4. Phase 4 — what the next session builds

The plan is slice doc §13 PHASE 4. Two things that are easy to get wrong:

1. **The mixed-commitment rule (§3.4) is a written condition of the D2 approval, not advice.** Draft
   work and committed work may share a screen, a frame and a grammar. They may **never share a lane
   object**. `/assign` chips write nothing on placement and are lost on navigation; Console lane chips
   write immediately. Same shape for two meanings is the one thing the shared grammar forbids.
2. **Reuse, do not rebuild.** `AssignConsolePage` + `CandidateColumn` + `DistributePanel` +
   `ReviewCommitScreen` + `LaneCoverage` + `grammar.tsx` already exist and already behave correctly.
   `CandidateColumn` was made read-only-capable this session (omit `onAssign`) — the Console's
   Alternatives band uses it that way, and Assign mode will pass the callback.

---

## 5. Traps this session actually hit

Each of these cost real time or nearly shipped a defect. They are not hypothetical.

1. **`INDEX.md` status lines are hypotheses, not facts.** Row 4 claimed `#285` DONE *including*
   "Run-dispatch relocated". It never was — the button was a `<Link to="/bulk-unassign">`, an
   `OPERATIONS_HEAD`-only route that silently bounced a ZM and a CSM to the dashboard. Scoping from
   INDEX alone priced that work at zero. **Re-read against source.**
2. **Two Phase-0.3 database counts refuted the plan.** Both "Repeated Inactive" predicates and the
   whole D1a migration turned out to have empty populations. When a plan assumes a population exists,
   *count it before designing on it.* The counts are recorded in the slice doc §13 Phase 0.
3. **A test that asserts a call is *not made*.** The Console fired `GET /dispatch/today` with no zone
   for a CSM on the chooser — a guaranteed `400 ZONE_REQUIRED` on every open. The screen looked
   correct either way; only asserting the absence of the call caught it.
4. **Three latent client-side defects sat behind "the backend already handles this."** Both override
   409s were typed as the ON_SITE conflict (so a deferral conflict claimed the engineer was on site);
   `placeHold` threw away the populated 409 its own backend comment says the client must read, making
   two declared refusal variants unreachable; and `POST /batches/:id/override` hard-coded
   `actedAsRole: null`. **When a backend comment says "the client needs this", check that it reads it.**
5. **The colour grammar is full.** Crimson = critical, amber = over capacity, violet = tier crossing,
   dashed = human, dotted = unknown. `#290` fixed a live collision in exactly this. A new marker needs
   a **new axis** (the chronic marker became an inline `CHR ×4` token in the `RET` idiom), not a fourth
   border colour — even when a preview the operator approved suggested one. That correction is
   documented in the slice doc §13 Phase 3.
6. **Bash heredocs break on this repo's prose.** Multi-line Python patches with quotes/backticks
   should be written to a file (scratchpad) and run, not piped via `<<'PY'`.
7. **`prisma db execute` returns no rows.** For ad-hoc counts use a small `pg`-client script; the
   generated Prisma client is TypeScript source at `apps/backend/src/generated/prisma` and will not
   import from plain node.

---

## 6. Known pre-existing issue (not fallout — do not "fix" as part of this work)

`apps/admin/test/ticket-drawer-tabs.test.tsx` produces **one unhandled rejection** on every full admin
run: `TicketDetailDrawer.tsx:440` reads `attempts.attempts` without a guard. The file and its test are
untouched by this session. It fails no test; it is noise in the runner output. Worth its own issue.

---

## 7. Context the transcript has that no document does

**The originating instruction was truncated.** The user's Phase-approval prompt ended mid-way, right
after the §4 console-structure diagram; sections 5 onward never arrived. I flagged it at the time and
proceeded on §1–§4, which were complete and self-consistent, and everything since has been built on
them plus the operator's explicit answers. **If work appears to contradict an instruction you cannot
find, that is probably where it came from — ask rather than reconcile.**

---

## Suggested skills for the next session

| Skill | Why |
|---|---|
| **`/tdd`** | Phase 4 is a vertical slice over endpoints that already exist. Red-green-refactor is the repo's protocol and the three Phase suites are written to match it |
| **`/field-ops-director`** | Assign mode is the highest-judgement surface left. A domain review against field reality ("would a CSM actually work this way?") is worth more here than a code-style pass |
| **`/code-review`** | Before committing. This session touched RBAC (`#291`), an audit-attribution bug, and two write paths — a Standards + Spec review against `56f5aec` is proportionate |
| **`/diagnose`** | Only if the pre-existing `ticket-drawer-tabs` rejection is picked up as its own issue |

Do **not** reach for `/prototype` or `/design-an-interface`: the structure is operator-approved and
recorded in the slice doc §2.1, and the standing instruction is *match the reference, do not redesign*.

---

## First five minutes

```bash
git status --short                 # expect the dirty tree described in §2
cd apps/backend && npx tsc --noEmit && npx vitest run     # the full backend run this session skipped
cd ../admin    && npx tsc --noEmit && npx vitest run
```

Then read the slice doc §13 PHASE 4, and get **D4** answered before writing Assign-mode code — it
decides whether the Console's pool is zone-scoped, which is a scope question, not a layout one.

*Saved to `docs/audits/` at the user's explicit request, rather than the OS temp directory the handoff
skill defaults to — it sits beside the six other `scheduler-console-*` documents it references.*
