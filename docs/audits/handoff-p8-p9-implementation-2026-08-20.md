# Handoff — P8/P9 implementation (session of 2026-08-20)

**Repo:** `C:\fsm-platform-backup` · branch `feat/autoplant-integration`
**Next session's job:** continue implementation. **Next issue is [#269](../../.scratch/fsm-platform-v1/issues/269-capacity-overload-visibility.md).**
**Everything this session produced is committed.** No uncommitted work of mine to recover.

> Placed in `docs/audits/` at the operator's explicit request. Note the repo convention
> (`CLAUDE.md`) otherwise puts live handoffs beside the issue and moves them to `docs/archive/`
> with an ARCHIVED banner once consumed — apply that when this is spent.

---

## 1. Read these, don't re-derive them

| What | Where |
|---|---|
| Scheduler decision set Q1–Q8, Q-A, Q-B | `.scratch/fsm-platform-v1/issues/258-…md` |
| Assign Work Console — approved UI direction, R1–R9 | `.scratch/fsm-platform-v1/issues/272-…md` |
| The approved console design (authoritative, in-repo) | `docs/ui/desktop/approved-designs/assign-work-console.html` |
| Build order P8 + P9 | `.scratch/fsm-platform-v1/INDEX.md` §§ P8, P9 |
| What #178 actually did, and what it deliberately left | `docs/progress/178-closure-never-clears-assignment.md` |

Three commits this session — read `git show` rather than asking what changed:

```
24597f1  fix(#178): terminal closure ends the assignment with the ticket, across six paths
8482aac  docs(#272): approve the Assign Work Console …, file P9
c114467  docs(#258): file the ratified scheduler production-readiness decision set as P8
```

Nothing is pushed. The ~99 remaining working-tree changes are **pre-existing #239 acting-zone and
admin-chart work that predates this session** — not mine, not to be committed as part of P8/P9.

---

## 2. Where implementation stands

`#178` **done** — the P8 gate that blocked `#269`, and through it P9's `#274`. Full backend suite
after it: **1917 passed / 0 failed / 5 skipped**, 388 files, exit 0.

Remaining P9 chain, in order, with what each is waiting on:

```
#269  capacity {committed, dailyCapacity}   ← NEXT. #178 (its hard prereq) is now done.
  └→ #274  candidates + capacity            also needs #266
#273  work pool + ledger                    unblocked now (its #178 dep was soft)
#275  assign-batch                          needs #262, #265
#276  Distribute                            needs #274, #275, #266
#277  absorb the orphans                    needs #274, #275, #268
```

`#273` and `#269` are both startable. The operator chose backend-first this session precisely so the
console arrives able to answer "can this engineer carry it?" — keep that order unless told otherwise.

---

## 3. Open operator decisions

**Blocking nothing today, but do not decide these yourself.**

1. **#178's backfill population is exactly #243's C1 + C3 — unresolved.** The read-only probe
   (`npm run closure-backfill:probe`) measured **3,310** live rows on resolved tickets and **4,402**
   resolved-yet-`FORMALLY_ASSIGNED`; C1 3,310 + C3 1,092 = 4,402, to the row. The issue's headline
   "351" is stale by an order of magnitude. #243 stamps `DEV_CLEANUP`, which its own text names as
   its rollback handle, so running #178's `--apply` first would consume those rows under
   `TICKET_RESOLVED` and destroy the handle. **Neither was executed.** Recorded in both issue files.
   Recommendation on file: fold C1+C3 into #243's single audited cleanup.
   **#243 remains HITL-gated. Do not run it. Re-measure at execution time.**
2. **#272 Q1 — Device Detail panel: retired, or kept as a deep-link shortcut?** Needed before #277.
3. **#272 Q3 — does the ZM get Distribute, or only OH + CSM?** Needed before #276.

**Already ruled this session, recorded, don't reopen:** #272 Q2 — the console draft is
**session-local for v1**, stated on screen. No table, no owner, no staleness rule.

---

## 4. Environment and process facts that cost time

- **Never pipe a long-running command through `tail`.** `tail` buffers until the pipe closes, so a
  30-minute suite run produced a zero-byte output file and looked hung. Redirect to a file instead.
- **The e2e global-setup TRUNCATEs `fsm_test`.** Two vitest invocations cannot overlap — a
  single-spec run started alongside a full-suite run will corrupt both. Serialise them.
- Test DB is `fsm_test` on **localhost:5433**; `.env` points the *dev* DB, which is what
  `closure-backfill:probe` reads. The probe is read-only unless given `--apply`.
- **A `Worker exited unexpectedly` crash mid-suite is expected**, not a regression — the known #184
  Windows-native fault. `scripts/run-tests.mjs` detects which files it dropped and re-runs only
  those; look for the `#184 AC-4: recovered — all N files accounted for` line before investigating.
- Single spec: `npx vitest run test/<file> --reporter=basic`. Full suite: `node scripts/run-tests.mjs`
  (~11½ min, plus any retry).
- Backticks inside a Prisma `Prisma.sql` template literal break the SWC parse. Don't put them in SQL
  comments.
- `npm run build` is needed before any `dist/`-based script (the probe included).

---

## 5. Code facts established this session (not in the issues)

Re-verifying these wastes time:

- **`RESOLVED_TICKET_STATUSES` now has a canonical home** — `src/ticketing/resolved-ticket-status.ts`.
  Three near-duplicate copies still exist and are catalogued in that file's docblock; one
  (`entity-mapping-export.service.ts`) has **four** members rather than seven. Whether that is
  deliberate scoping or drift is not answerable from the code — it is its own slice, not a drive-by.
- **`retireAssignmentOnClosure`** (`src/scheduling/close-assignment.ts`) is the single writer every
  terminal closure calls. Idempotent via `removed_at IS NULL`; flips `assignment_state` only for
  tickets left with no live row. Any *new* closure path must call it — there is no global invariant
  test that would catch a seventh path (see below).
- **`COUNTABLE_REMOVAL_REASONS` is an allow-list**, so a new `removal_reason` is excluded from #244's
  Special counting by default. This is asserted, not assumed. Safe direction — keep it that way.
- **The AC-2 invariant test is scoped to its own spec's tickets, deliberately.** The suite shares one
  database and other specs legitimately build resolved-yet-assigned fixtures, so a table-wide
  assertion fails on their data rather than on a defect. A seventh closure path therefore needs a new
  test beside the others; do not "improve" this into a global query.
- **`plantDeviceStats` now filters ticket status.** Its response *shape* is unchanged, so no admin
  work was needed. #273's R3 shared predicate still has to be extracted separately — that fix was
  narrower than R3.
- **`recommender.service.ts` line numbers drift constantly.** `committedDayLoad` is `:926-937`;
  `chosen = planner ?? passed[0]` is `:466`. Several issue files still cite older lines.

---

## 6. Method notes for whoever continues

- `CLAUDE.md` mandates strict TDD via the `/tdd` skill. That skill requires **agreeing the seams with
  the operator before writing the first test** — do it, it caught a real design question last time
  (whether flipping `assignment_state` should also fix `plantDeviceStats`; it should, and did).
- Issue files in this repo go stale. #178's writer list was wrong in *both* directions — it named two
  paths #241 had already fixed, and missed two that were broken. **Verify the inventory against the
  tree before writing code**, and correct the issue file in place when it differs.
- `#269`'s own text says "existing pages, no redesign". That is still correct and is **not**
  superseded by P9 — it is the instrumentation the console consumes. It carries a shared-predicate AC
  specifically to stop a second "committed day load" definition being born. Keep it.
- Per-issue TDD completion reports go to `docs/progress/<issue>.md` and are frozen once written;
  corrections go to INDEX/SYSTEM-STATE. Every session appends one row to INDEX's Session log.

---

## 7. Suggested skills

- **`/tdd`** — mandatory for any implementation work here. Invoke it before the first test, not after.
- **`/code-review`** (or `/review`) — for reviewing the P8/P9 branch once more slices land;
  `git diff c114467^..HEAD` is the natural range for this session's work.
- **`/diagnose`** — if a suite failure turns out to be real rather than the #184 crash.
- **`/field-ops-director`** — worth one pass over the Assign Work Console before #273 builds it, to
  sanity-check the flow against real field-service dispatch practice.
- **`artifact-design`** — only if the approved console design needs updating; the design file is
  authoritative and should not be casually re-styled.

Reading order for a fresh session, per `CLAUDE.md`: `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` →
`.scratch/fsm-platform-v1/INDEX.md` (P8 + P9 + last three session-log rows) → the issue being worked.
