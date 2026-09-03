# HANDOFF — scope-module-gaps survey of all 14 modules — 2026-09-03

Status: active
Issue: none — this was a `/scope-module-gaps` investigation run, not a backlog slice. Nothing was built.
Branch: `feat/autoplant-integration` · survey evidence gathered at `beea7d2` (backend build fingerprint
`beea7d2-dirty`) · HEAD moved to `e0b0ed5` during the run by a **parallel session**.

> **Why this is not `HANDOFF-ACTIVE.md`.** That file is another live session's armed handoff
> (scheduler-forensics, Wave 3, `#315 next`). Overwriting it would destroy their continuation, so this
> handoff lives beside it. The `SessionStart` hook will NOT inject this file — the next session must be
> pointed at it, or read it via the INDEX session-log line.

## The job

Produce a priced, evidence-backed gap survey of the whole FSM platform: what the PRD says each module
should do, what the code and the running app actually do, how bad each gap is, what closing it costs, and
what to do first. Investigation only — no fixes, no issues filed.

**The survey is complete.** Deliverables are in `docs/module-gaps/` (start at `_INDEX.md`, then
`EXEC-SUMMARY.md`). What follows is what a session *continuing from* it needs.

## Next step

None is mandatory — the deliverable exists. If the user wants to continue, the highest-value follow-ups,
in order, are:

1. **Clear the Wave-0 fixtures and re-run S3 on the blocked modules.** 17 findings are `needs-verify`
   for want of test data. The single biggest unblocker: `se.north@fsm.test` has a `users` row and no
   `engineer_master` / `se_coverage` row (`apps/backend/src/auth/auth-fixture-seed.ts:114`). The tickets
   walker proved two OH calls (`POST /org/engineers`, `POST /org/se-coverage` on plant 103) take
   `/me/tickets` from 0 to 521 rows — **those rows now exist in the dev DB**, so the SE half of
   `vouchers`, `inventory`, `scheduling` is walkable today. Also: `verification` has zero live rows
   (two or three seeded `VerificationRun`s across zones 1 and 2 would settle V-01/V-02).
2. **Finish the `scheduling` walk.** Its walker died on the rate limit after writing 6 outcome rows to
   `.work/scheduling/gaps.jsonl`; `not-walked.json`, `primer.md` and the `gaps-*.md` narratives are
   missing. Re-dispatch one walker with `stages/S3-gaps.md`; tell it SCH-01 is already falsified.
3. **One browser pass** for the screen-only claims every module listed in its `not-walked.json`
   (no browser was used at all — see Decisions). Sequential, one module at a time; Chrome is single.

If instead the user wants to *act* on findings: hand `docs/module-gaps/ROADMAP.md` to a build skill.
This skill's boundary is diagnose-and-price; it must not be the one that builds.

## Standing instructions from the user

Quoted verbatim from this session:

- "**Do not modify, fix, refactor, migrate, or implement anything in the FSM application. This is an
  investigation/scoping run only.**"
- "Follow the `scope-module-gaps` skill exactly."
- "First discover and profile the application yourself; do not assume module boundaries, routes,
  personas, backend structure, or architecture."
- "Audit **all relevant FSM modules**, not just one obvious screen."
- "Stop after the complete diagnostic/estimation output is produced and store in .md file."
- "continue , if required re run all the agents" (after the rate-limit failures)
- "store the .md in audit folder" (this handoff)

## State of the tree

- Committed this session: see `git log` for `docs(module-gaps): …` — the 22 briefs/portfolio files
  plus `docs/module-gaps/.work/` evidence (1.4 MB) and this handoff.
- **Uncommitted and deliberately left so:** ~353 files belonging to the parallel scheduler-forensics
  session (their in-flight Wave 3 work). **Do not commit them from a survey session.**
  `.scratch/fsm-platform-v1/INDEX.md` carries one appended session-log line for this survey and is
  otherwise their dirty file — the line rides along with their next commit.
- **Not in git and cannot be:** the generated skill runtime —
  `.claude/skills/scope-module-gaps/{gapscope.profile.json, stages/, scripts/, calibration/, A0.done}`.
  `.gitignore:38` ignores `.claude/skills/*`. It exists only on this machine. To preserve it:
  `git add -f .claude/skills/scope-module-gaps/` (the user's ignore rule is deliberate — ask first).
  Without it, `estimate.mjs` / `render-brief.mjs` / `api-walk.mjs` do not exist and the survey cannot be
  re-run or re-priced.
- Tests: none run — no application code was touched. Gates run instead:
  `node .claude/skills/scope-module-gaps/scripts/assert-brief.mjs <m>` → **14/14 OK**;
  `EXEC-SUMMARY.md` → 60 lines (cap 60).
- Typecheck: not applicable.

## Done so far

- A0 bootstrap: 14 modules (bounded-context = backend NestJS module + admin page folder + mobile feature
  folder), 5 personas from the PRD role table, 248 endpoints inventoried, self-test 5/5.
- A1 spine: 28 hand-off edges, 6 blank receivers, 2 "a human remembers" (E-15, E-17 — both on the money path).
- S1 × 14: all ANCHOR-pass; 118 capabilities. **CONTEXT.md §21 retired the SE accept/decline mechanic;
  the PRD is stale on it** — promoted to standing law so it was never filed as a gap.
- S2 × 14: 131 code-settled gaps; surveyors refuted several of the conductor's own leads.
- S3 × 14 (13 complete, scheduling partial): api-walk as the six real personas. 3 predicted DANGEROUS
  findings **falsified** (SCH-01, TKT-03, CZ-03); the acting-scope hole, the fabricated 100% uptime, the
  approve-and-pay breach and the never-decremented van stock all **reproduced at E4**.
- S4 × 14 + S5: 148 gaps · S4 5 · S3 48 · 28 DANGEROUS · 63% → 78% · P50 393M / P80 786M TEQ, every
  module `conf LOW`.

## Decisions taken (not recoverable from the diff)

- **Walks ran api-first, not browser-first.** One Chrome instance cannot serve 14 parallel walkers, and
  the checks that most needed evidence (backend permissions, persistence, downstream) are settled *better*
  by real seeded JWTs than by a browser — the skill's own P5 says an admin session cannot judge
  permissions. Screen-only claims are `NEEDS-VERIFY` with a named screen and a ~708k TEQ cost. Disclosure
  sweeps were therefore **not performed** and are recorded as failed sweeps, not "0 found".
  Rejected alternative: sequential browser walks — ~14 × 708k TEQ for evidence the API gave at ~2k each.
- **Modules were surveyed in parallel** despite `efficiency.md` listing it under "deliberately not done".
  Its stated reason is "saves zero tokens"; the constraint here was wall-clock, and it concedes the
  approach is file-disjoint and safe. It was.
- **`tests` lanes were dropped from pricing** (`estimate.mjs`). `estimation.md` §5.3a says `tests` is a
  separate lane *only for a demanded pin suite*; none was demanded; surveyors added it routinely. Every
  drop is recorded in `estimate.json` as `droppedLanes`.
- **Absolute TEQ was reported with loud caveats rather than tuned.** The formula produces 14–47M per
  module; the reference doc contradicts itself by ~20× on what a module "should" cost; cross-check A
  splits 3.8×–15.7× everywhere; 30 gaps breach the "over 3M is not one gap" rule. Bending the formula to a
  prettier number would be inventing. Ranking is trustworthy; absolutes are not a commitment. Stated in
  every artifact.
- **The admin-config walker was told not to touch dials**, and the ingestion walker not to fire a run —
  both shared a live DB with nine other walkers. Both complied and said so.

## Dead ends — do not retry

- **My generated static scanner had four defective columns**, all caught by surveyors and now in
  `docs/module-gaps/standing-rules.md`: audit (1-hop only; scheduling 11/11 false, tickets 8/10,
  cross-zone 6/6), guard (off by one decorator), "no data hook" (looked for react-query; this app uses
  `useEffect` + `apps/admin/src/api/*`), status-write (matched `status` inside SELECT predicates). The
  `static.md` files carry a CAVEAT header. Do not trust a "no" in any of those columns.
- **Do not re-file** (standing law, refuted): E-12 blank receiver (StockScreen consumes
  `/me/component-requests`); availability→dispatch carrier (exists, live-read); inventory rollback on
  failed verification (built); `@Public GET /api/non-op/confirm` (token is the credential); SE cannot
  decline a stop (§21, deliberate).
- **Shell heredocs eat backslashes in regex literals on this box.** Two patches to `estimate.mjs`
  corrupted it into a SyntaxError. Write patch scripts to a file with the Write tool, then `node` them.
  `python3` is not installed.
- **`api-walk.mjs` prints only the first 2 array items** — cannot settle a whole-payload scoping claim
  alone; the dashboard walker wrote its own aggregator. Fix or wrap before relying on it for that.
- **Git-Bash rewrites a leading `/` into the Git install path.** `api-walk.mjs SE GET me/tickets`, never
  `/me/tickets`. The script repairs the mangled form but do not depend on it.
- The session hit a **rate limit (resets 19:20 IST)** with 4 agents mid-flight. All 4 had already written
  their JSONL; only trailing artifacts were lost. Re-dispatching agents before reset just fails again —
  S4/S5 were finished in the main context instead, which is allowed (no read-ban applies to them).

## Gotchas

- **Two sessions are working this repo at once.** The other one moved HEAD `beea7d2 → e0b0ed5` mid-run
  and owns `HANDOFF-ACTIVE.md` (armed). The running backend (`:3000`, pid 5348) is still the
  `beea7d2-dirty` build — evidence in `docs/module-gaps/` is about **that** build. If they restart on
  HEAD, `ING-09` resolves and one ingestion section becomes testable.
- **Duplicate gap ids across S2+S3 rows are one gap.** `_lib.mjs mergeById` merges them (42 ids were
  duplicated across 8 modules on first pricing → double-count). A row with `ownedBy` ≠ module or
  `pricedElsewhere:true` is referenced, never priced (P11).
- **State changed in the dev DB by walkers, all declared** in each module's `primer.md`: one ticket
  closed (`f1978011…`, auth-access); one disposable account created then disabled
  (`surveyor.disposable.20260902@fsm.invalid`, admin-config — no DELETE verb exists); three
  leave/availability rows dated 2026-10-05→08 on engineer `459b5409` **kept on purpose** as ENG-G4/G6
  evidence; `engineer_master` + `se_coverage` rows for `se.north` (tickets). `se_planner` was restored.
- **`GET /reports/fleet-uptime/recompute` was deliberately NOT fired** — it would populate the current
  month and destroy the RPT-01 reproduction (100% vs 56.19%). Leave it unfired if a re-walk is planned.
- The 404-vs-403 technique is standing law: a 404 carrying the *service's own error code* means the
  RoleGuard cleared — a check-6 PASS on an empty table, not a failure.

## Remaining acceptance criteria

The survey has none outstanding. Coverage limits, per policy P18, are named rather than hidden:
`docs/module-gaps/_INDEX.md` "Known limits of this run", and each `.work/<m>/not-walked.json`.

## Open questions / HITL

- **One-way door, priced, needs the operator:** `VCH-08` — no reversal once a voucher is marked PAID.
  Flagged `needsCall` in `vouchers.md`; whether that is deliberate is a business-rule call.
- **Backlog-ownership:** the two "a human remembers" spine edges on the money path (E-15 ticket→voucher,
  E-17 voucher→finance) need a product decision before they can be designed.
- Whether to `git add -f` the gitignored skill runtime so the survey is reproducible from the repo.

## Suggested skills

- `/scope-module-gaps <module>` — attended re-run of one module after Wave-0 fixtures (S1+S2 in one turn,
  S3 offered as a second).
- A build skill, handed `docs/module-gaps/ROADMAP.md` Wave 1 — **not this skill**.
- `/field-ops-director` on `EXEC-SUMMARY.md` — a domain-reality review of the five headline findings
  before anyone commits to the order.

## Continuation — 2026-09-03: plan written, slices filed (planning session, no code changed)

The "act on findings" branch of *Next step* was taken. Every survey finding was re-verified against the
working tree (HEAD `a6c87c7` + the uncommitted #295–#334 files) by six read-only passes; 21 corrections
are recorded in `docs/module-gaps/IMPLEMENTATION-PLAN.md` §1 and `standing-rules.md` (bottom). Result:
**31 implementation slices, issues #336–#366**, indexed as **P12** in `.scratch/fsm-platform-v1/INDEX.md`
with a session-log row. Wave 0/1 to start with: #336 fixtures → #337 push exit + #338 durable outbox →
#339/#340/#341 acting chain → #342 audit ledger. Preconditions: the scheduler-forensics session commits
its tree (P0-a) and the dev backend restarts on HEAD (P0-b). Operator decisions needed are in plan §7.
This handoff stays a survey record; the plan is the brief for a build session.
