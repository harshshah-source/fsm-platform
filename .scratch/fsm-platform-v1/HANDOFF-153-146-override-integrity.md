# HANDOFF — override integrity: do #153 first, then #146

**Written:** 2026-07-22 (end of session) · **Branch:** `feat/autoplant-integration` · **HEAD at handoff:** `3852e0c`
**Working tree:** clean (see "State at handoff") · **Both suites: GREEN**

> **Scope of this file.** `CLAUDE.md` reserves handoffs for genuinely interrupted work with
> uncommitted state. **There is none here** — everything is committed and pushed. This file exists
> because the *sequencing* changed mid-flight and the reasoning behind it is worth more than one
> INDEX line. It does **not** fork current state: `INDEX.md` remains the only work tracker and
> `SYSTEM-STATE-2026-07.md` the only current-state doc. Where they disagree with this file, they win.
>
> **Consume and archive:** once #153 and #146 are done, `git mv` this file to `docs/archive/` with a
> 2-line ARCHIVED banner, per the progress convention.

---

## 1. TL;DR for the next session

1. Read `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` → `INDEX.md` (the audit-conversion block near
   the top) → this file.
2. **Do [#153](./issues/153-override-blanks-day-plan-and-capacity.md) first.** Its RED test is
   already written — §4 below has it verbatim, ready to paste back.
3. **Then [#146](./issues/146-zm-override-integrity-defer-remove.md).** Its slices are written but
   the slice *interactions* are subtle — §5 is the part that is not in the issue file.
4. Before touching anything, read §7 (traps). Several cost real time this session.

---

## 2. State at handoff

**18 commits this session, all pushed** (`592ca96..3852e0c`).

| Issue | State |
|---|---|
| #144 commit the correctness layer | ✅ complete (8/8 ACs) |
| #141 backend suite red (43 commits) | ✅ complete |
| #142 SE-directory selection contract | ✅ complete |
| #143 Critical Devices KPI regression | ✅ complete |
| #149 SYSTEM-STATE / agent-doc truth | ✅ complete |
| #107 CI | ⏸ slices 1–2 of 4 (workflow + drift gate). Slices 3–4 + **first-run verification** open |
| #148 sweep staleness | ⏸ slices 1, 2, 4 of 4. **Slice 3 (stall observability) open** |
| **#153** | 🔴 filed, not started — **do this next** |
| #146 | 🔴 filed, not started, **blocked on #153** |
| #147, #145, #103, #152 | filed, not started |

**Suite baselines to beat (both verified on full runs, reading vitest's own exit code):**

- backend — **287 files passed / 3 skipped (290); 1176 passed / 5 skipped (1181); exit 0; 494 s**
- admin — **82 files / 321 passed; exit 0**

**Working tree:** clean, except one whitespace-only edit to
`docs/audits/2026-07-22-adversarial-review-admin-backend.md` made by the operator's open IDE buffer.
The audit is READ-ONLY — leave it, do not commit it.

**Not verified and not claimable:** the CI workflow (`.github/workflows/ci.yml`) has **never executed
on GitHub Actions**. `gh` is not installed on this host. Three pushes have triggered it; check the
Actions tab. Its DB-provisioning and `pnpm/action-setup` steps are unproven on a real runner, and
#107's deliberate-break confirmation still needs a real run.

---

## 3. Why #153 comes before #146 (the whole reason for this file)

#146 was next on the roadmap. Writing its first RED test produced the **wrong failure**, and chasing
that is what found #153.

Expected failure: *"the deferred ticket is still on the plan."*
Actual failure: **the plan was completely empty.**

```
→ expected [] to have a length of 1 but got +0      (day plan had NO tickets at all)
→ expected +0 to be 1                               (committed capacity count was 0)
```

Probe run against the live fixture (`test/batch-override-defer-reorder.e2e-spec.ts`, which dispatches
2 tickets to 1 SE then applies `DEFER_TICKET` + `REORDER`):

```
PROBE schedules=    [{"id":"1303","status":"OVERRIDDEN"}]
PROBE batchTickets= [{"t":"0ce7c368","removed":false,"deferred":false},
                     {"t":"dafb69dc","removed":false,"deferred":true}]
```

Both batch tickets present, **neither removed**, one merely deferred — yet `getDayPlan` returns 0
stops and the committed-load count returns 0.

**Mechanism.** `flagOverridden` (`override.service.ts:487-490`) flips the **schedule** to
`OVERRIDDEN`; five paths treat anything not `ACTIVE` as non-existent. `workflow.md:1913` is explicit
that `OVERRIDDEN` is **live, not terminal**.

**Consequence for #146:** its slice-1 AC ("deferred ticket leaves the plan, *the rest of the plan is
untouched*") and its slice-2 capacity AC are **unobservable** while the whole plan is already blank
and load is already 0. You would be writing tests that pass for the wrong reason.

**#153 is also the bigger bug.** B1/B2 are latent on zero rows. #153 fires on *every* override —
including swap, split, reorder and reassign, which leave **no** `removed_at`/`deferred_to_date` row.
The audits' "0 removed / 0 deferred rows" exposure figure measured **two of six actions**, so live
exposure for #153 is **unknown, not zero**.

---

## 4. #153 — the RED test, verbatim

Written, run (failed as described), then **reverted** so the suite stayed green. Paste back into
`apps/backend/test/batch-override-defer-reorder.e2e-spec.ts`. That file's existing fixture already
does everything needed — dispatches 2 tickets to 1 SE across 2 plants, defers `ticketA`, reorders
`batchB` — so no new fixture is required.

Add the import:

```ts
import { DayPlanQueryService } from '../src/scheduling/day-plan-query.service';
```

Append after the existing `REORDER` test:

```ts
  it('#153 — an overridden schedule is still live: the day plan survives an override', async () => {
    const dayPlan = new DayPlanQueryService(prisma);
    const plan = await dayPlan.getDayPlan(se);
    const ticketsOnPlan = plan.stops.flatMap((s) => s.tickets.map((t) => t.ticketId));
    // Pre-#146 this is BOTH tickets — the defer has not yet been given read semantics.
    // The point of this assertion is only that the plan is not EMPTY after an override.
    expect(ticketsOnPlan.length).toBeGreaterThan(0);
  });

  it('#153 — committed capacity still counts an overridden schedule', async () => {
    const committed = await prisma.batchAssignmentTicket.count({
      where: { removedAt: null, batch: { seId: se, schedule: { status: { in: ['ACTIVE', 'OVERRIDDEN'] } } } },
    });
    expect(committed).toBeGreaterThan(0);
  });
```

> **Pin first, before widening anything:** add a case asserting a `COMPLETED` schedule stays
> **excluded**. Otherwise a sloppy fix ("drop the status filter") passes both tests above and
> silently resurrects finished work onto today's plan. The widening must be provably **exactly one
> value**.

### The five sites to change

| Site | What it does |
|---|---|
| `day-plan-query.service.ts:41` | SE day plan — the blank-plan symptom |
| `recommender.service.ts:552` | `committedDayLoad` — the capacity-zeroing symptom |
| `batch-assignment.service.ts:121` | #127 APPEND reuse lookup |
| `batch-assignment.service.ts:247` | zone dispatch schedule lookup |
| `override.service.ts:437,446` | swap/split target schedule lookup |

Put the live set behind **one exported constant** (`LIVE_SCHEDULE_STATUSES = ['ACTIVE','OVERRIDDEN']`)
so a grep for `status: 'ACTIVE'` on `workSchedule` returns only that constant and the six filters
cannot drift apart again. AC#4 of #153 requires this.

### Design fork (recorded in #153, repeated here because it is easy to get wrong)

- **(a)** widen the filters behind the constant — 6 lines, no data implications. **Recommended now.**
- **(b)** stop overloading `status` entirely: keep it `ACTIVE` and derive "was it overridden?" from
  `lastOverriddenAt != null`, columns that **already exist on the row**. Cleaner and removes the
  conflation permanently, **but** it changes the meaning of a persisted enum value that reports and
  the admin UI may read — needs a full sweep of every `OVERRIDDEN` consumer first.

Do (a) to stop the bleeding; file (b) as a follow-up if the sweep comes back clean.

---

## 5. #146 — slice interactions that are NOT in the issue file

The issue file lists five slices. These three interactions are what will bite:

### 5.1 Slice ordering is load-bearing — do NOT flip `assignmentState` early

`fsm-business-technical-workflow.md:711` defines defer as two clauses:

> `| **Defer Ticket** | Ticket pushed to a specific future date; removed from current batch |`

It is tempting to implement both at once by setting `removedAt` **and** flipping the ticket to
`UNASSIGNED` in slice 1. **Don't.** The recommender selects `OPEN` + `UNASSIGNED`
(`recommender.service.ts:103-108`), so flipping before the ticket-level `deferred_until` predicate
exists makes the ticket **immediately re-dispatchable today** — worse than the current bug.

Safe order:

- **Slice 1** — set `removedAt` + keep `deferredToDate`; leave `assignmentState` alone. The ticket
  drops out of every read that already filters `removedAt: null`, and capacity frees itself. No
  re-pickup risk because the ticket is still `FORMALLY_ASSIGNED`.
- **Slice 2** — verify capacity. Should fall out of slice 1 for free (`committedDayLoad` already
  filters `removedAt: null`); write the test anyway, it is the AC.
- **Slice 3** — add ticket-level `deferred_until`, flip to `UNASSIGNED`, add the recommender
  predicate `deferred_until IS NULL OR deferred_until <= :today`. Only now is re-dispatch safe.

### 5.2 Slice 4 (B2) must exclude deferred rows

Slice 1 makes defer set `removedAt`. Slice 4 adds a soft negative preference against the SE a ticket
was **removed** from. If that penalty keys on `removedAt` alone it will also penalise **defers** —
wrong, because on the deferred date the ticket may legitimately go back to the same SE.

Scope the penalty to removals **without** a `deferredToDate`.

Also: it must stay **soft** (ADR-0022 planner-bias mechanism), never a hard filter. "Return to the
shared pool" is the documented intent and re-assignment to a *different* SE is correct; the defect is
only that nothing prevents re-assignment to the SE the ZM just removed it from. A hard filter would
contradict the documented behaviour.

### 5.3 The semantics are settled — this is NOT a HITL gate

Both audits called defer semantics *"a business-rule call, not an engineering one"* and made it a
human gate. **They were wrong.** It is settled by the authority chain:

- `fsm-business-technical-workflow.md:711` — the two clauses quoted above (tier 3)
- `CONTEXT.md:229` — defer listed among the audited override actions (tier 1)
- `CONTEXT.md:521` / `workflow.md:1681` — `zm_performance_summary_monthly.deferrals` is a **graded ZM
  scorecard metric**, and an unobservable field cannot be counted

#146 is `ready-for-agent`. Do not stop for a decision that the docs already made.

### 5.4 Why B1 survived this long

`test/batch-override-defer-reorder.e2e-spec.ts` has two tests, and both assert only the **write** —
a date is stamped, the batch flips `OVERRIDDEN`. Nothing asserted a **read**. `deferred_to_date` had
a writer and **zero readers** across `apps/backend/src`, and the suite was fully green throughout.
Worth remembering when adding tests for the rest of the override actions.

---

## 6. Verification commands

```bash
# Backend — full suite. NEVER pipe into tail/head/tee (see §7.2)
cd apps/backend && npx vitest run                # expect: 287 files, 1176 passed + 5 skipped, exit 0

# Admin — full suite
cd apps/admin && npx vitest run                  # expect: 82 files, 321 passed, exit 0

# Typecheck + build (build MUST precede the suites on a cold tree — see §7.3)
pnpm turbo run build && pnpm turbo run typecheck

# Schema drift gate — MUST target a migrate-deploy-built, NEVER-BOOTED database (see §7.4)
cd apps/backend && DATABASE_URL=<never-booted-db> node scripts/check-schema-drift.mjs
```

---

## 7. Traps found this session — read before starting

1. **`AskUserQuestion` / operator decisions are already recorded.** The drift-gate scope decision
   (structural-only, normalise later → #152) was taken by the operator on 2026-07-22. Don't re-ask.

2. **Never pipe vitest into `tail`/`head`/`tee`.** You get the *pipe's* exit code, not vitest's. This
   is exactly how the review reported "exit code 0" on a red suite. Confirmed again this session with
   `${PIPESTATUS[0]}` → 1. Redirect to a file and grep the file instead.

3. **`@fsm/shared` resolves to `packages/shared/dist`, which is gitignored.** `turbo.json` encodes
   `test: dependsOn ^build`. Running a suite directly bypasses that — on a cold tree you must
   `pnpm turbo run build` first. This was a real bug in the first draft of the CI workflow.

4. **The drift gate must run against a never-booted database.** `runtime_lock` is created at **boot**
   by `PrismaService.onModuleInit` (#130 L1 build-fingerprint lock), not by a migration, so a booted
   DB reports it as drift. CI uses a dedicated `fsm_drift` DB for exactly this reason. Verified: run
   against a booted DB the gate correctly reports `runtime_lock` and exits 1 — that is the gate
   working, not a false positive.

5. **The test database is shared and the telemetry watermark is global.** `snapshot_runs.data_as_of`
   is read as "latest row with a non-null value", so specs that need a specific watermark **must set
   it explicitly** (`snapshotRun.create({ dataAsOf })`). Two existing specs
   (`verification-run`, `inventory-rollback`) were silently depending on an ambient value left by
   other specs and behaved differently in isolation; #148 fixed that. Do not reintroduce the pattern.
   **Never** null `data_as_of` globally in a test — a mid-test failure leaves that corruption for
   whatever runs next.

6. **The `fsm` DB role is NOT a superuser and cannot create databases.** PostGIS is a one-time
   superuser bootstrap and there is no `psql` on this host, so a true scratch-DB from-zero migrate
   **cannot be done locally**. This is recorded honestly in #144 AC#3 — do not claim it was done.

7. **Bash tool: use heredocs, not PowerShell here-strings.** `@'...'@` silently injected a stray `@`
   into a commit subject this session and needed an amend.

8. **Commit by explicit path.** The working tree has repeatedly held several unrelated workstreams at
   once. `git add -A` is how #144's four-way split would have become one unreviewable commit.

---

## 8. Open decisions (none blocking #153 or #146)

| Decision | Owner | Notes |
|---|---|---|
| #153 design (a) filter-widening vs (b) drop the `status` overload | next session may choose (a) and file (b) | (a) recommended; (b) needs an `OVERRIDDEN`-consumer sweep |
| #148 slice 3 — stall observability on `/build-health` | open | the guard converts a wrong verdict into a permanently-PENDING window; that must be **visible**. **Never** auto-expire after a grace period — it re-creates the bug with a longer fuse |
| #107 slices 3–4 + first-run verification | open | needs a real Actions run; `gh` unavailable here |
| #143 — was dropping the Critical KPI intentional? | assumed accidental, restored | if the operator says otherwise, invert per #143's HITL note **and record the #122 reversal** |

---

## 9. Reading order for the next session

```
CLAUDE.md
  → docs/SYSTEM-STATE-2026-07.md          (note the 2026-07-22 header block: tree clean + drift finding)
    → .scratch/fsm-platform-v1/INDEX.md   (audit-conversion block + resequencing note + session log)
      → THIS FILE
        → issues/153-override-blanks-day-plan-and-capacity.md
          → issues/146-zm-override-integrity-defer-remove.md
```
