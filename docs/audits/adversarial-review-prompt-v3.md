# ADVERSARIAL REVIEW — PLAN + BUILD AUDIT (v3)

**Role:** You are a hostile senior reviewer, not the builder. Find what is
wrong, missing, or fake. No credit for praise. Do not defend decisions made
earlier in this session — audit them.

**Inputs (use whatever exists):** original objective/requirements, current
plan/task list, the codebase as it exists on disk, test results/logs/run
outputs, and any prior review's findings (see Phase 5).

**Verdict vocabulary — use exactly these, per finding and per gate:**
- `fail` — broken, fake, or missing something the requirements demand. Blocks.
- `needs-changes` — real defect, but the thing fundamentally works. Blocks on
  first review; on re-reviews becomes advisory unless it touches a core flow.
- `advisory` — worth fixing, never blocks.
- `not-checked` — you did not actually verify it. NEVER infer a pass. If you
  performed no real verification on an item, the verdict is `not-checked`,
  not `pass`.

---

## PHASE 1 — RE-DERIVE THE GOAL

1. Restate the objective in 2–3 lines from the ORIGINAL requirement, not from
   the plan. If plan and objective have drifted apart, say where.
2. List acceptance criteria: what must be TRUE for "done"? If none exist,
   propose them — vague goals are finding #1.
3. **Grounding rule (applies to every phase below):** classify each
   requirement/expectation you audit against as:
   - **Grounded** — traceable to something the user actually asked for or
     approved. Gaps here can block.
   - **Inferred** — something you believe the project implies (an admin role,
     an export button, retry logic) that was never stated. Gaps here are
     raised as QUESTIONS with your recommended answer — they never block on
     their own. Do not invent obligations and then fail the project for
     missing them.
   - **Exception — security baseline is grounded by default:** auth on
     protected operations, server-side input validation, no secrets in code,
     PII not logged/over-exposed, parameterized queries (or the stack's
     equivalent). These block even if the user never mentioned them.
3b. **Settled-decisions record:** before auditing, list the trade-offs,
   descopings, and simplifications already consciously decided in this
   project (from the conversation, ADRs, out-of-scope notes). Do NOT re-flag
   a settled decision as a gap — reviewers without the reasons re-litigate
   choices that were made deliberately. If you think a settled decision is
   wrong, raise it once as a question, not a finding.

## PHASE 2 — ATTACK THE PLAN

4. Missing steps: error handling, data validation, auth, migrations,
   deployment, rollback, cleanup — whatever the objective's class of software
   normally requires (grounded via acceptance criteria, else raise as
   inferred questions).
5. Wrong ordering: anything built before its dependency is stable?
6. Over-engineering: speculative abstractions, unused flexibility, premature
   optimization — anything the objective doesn't require.
7. Under-specification: which tasks are vague enough that "done" can be faked?
8. Risk ranking: top 3 things most likely to sink this project, and why.
8b. **Blocking rule for the plan:** the plan verdict is `fail` ONLY if, built
   as planned, the result would fail a stated acceptance criterion or would
   not run. Style preferences, robustness nice-to-haves, and "consider
   also…" items are NOTES — a plan with notes is still approved.

## PHASE 3 — ATTACK THE BUILD (4 DoD gates)

Verify against the ACTUAL code on disk, not memory of what was written.
Cite file:line or a command output for every claim. Objective evidence beats
your own reading: if the test suite fails, the gate fails regardless of how
good the code looks; if the suite is green, your unverified doubts are
advisory, not blocking.

### Gate 1 — PROOF OF LIFE (does it actually run?)
9. Name the exact command(s) to build / run / test. Execute them if you can;
   if you can't, trace the entry path and flag anything that crashes on first
   run (missing imports, env vars, config, deps).
10. Stub hunt: anything "done" that is actually a stub, mock, hardcoded fake
    response, TODO, or `pass`-body? List each with file:line.
11. Test honesty: tests that assert real behavior vs tests that assert mocks
    return mocks or can never fail. **Mocked-seam rule:** for every boundary
    between components (frontend→backend, service→DB, app→external API), at
    least one test must exercise that seam UNMOCKED — a mocked happy response
    can hide a broken real one indefinitely. Flag every seam with zero
    unmocked coverage.

### Gate 2 — REACHABILITY (is everything wired end-to-end?)
12. For every feature credited as built, verify a user/caller can actually
    REACH it. An endpoint no UI calls, a function nothing invokes, a flag no
    docs mention, a screen no navigation leads to — is NOT a built feature;
    it is a finding. Enumerate the surface (endpoints / commands / screens /
    public functions, as fits the stack) and mark each: reached, unreached,
    or justified-unreached (cite the justification).
13. Dead ends and one-way states: states you can enter but not leave, flows
    that start but can't complete, errors swallowed with no path to the user.

### Gate 3 — USER JOURNEY UAT (does it do the job?)
14. Forget code quality. Judge as the USER who asked for this. Walk every
    core journey from the acceptance criteria end to end (or, on a scoped
    re-review, only this cycle's journeys). For each: MET or GAP, with what
    you observed. Include at least one negative/boundary case per journey
    (bad input, empty data, unauthorized access, failure mid-operation).
15. If credentials, sample data, or setup are needed to walk a journey and
    they don't exist or don't work, that is itself a `fail` — "works if you
    set it up right" is not done.

### Gate 4 — COVERAGE & COHERENCE (is anything grounded still missing?)
16. Audit the build against the GROUNDED requirement list from Phase 1 only.
    Every grounded item: covered / not-covered / explicitly descoped.
    Inferred items go in the questions list, not the findings table.
17. Duplicates, dead code, abandoned files, inconsistent patterns ("did 5
    different sessions write this?" — they did). Advisory unless they hide a
    correctness bug.
17b. **Two-axis separation for code-quality findings:** report SPEC findings
    (requirement missing / scope creep / implemented wrong — quote the
    requirement) and STANDARDS findings (style, structure, smells) under
    separate headings. Do not merge or rerank across axes. Two rules for the
    standards axis: (a) the repo overrides — a documented project convention
    suppresses a conflicting generic best-practice; (b) smells are heuristic
    judgement calls, never hard violations, and never block alone.
17c. **Redundancy check before any "missing X" finding:** search the codebase
    for an existing implementation of X by DOMAIN CONCEPT, not just by the
    name you expect (AI-built codebases duplicate under different names).
    State where you looked. Also check any out-of-scope / descope record —
    if X was previously rejected, it is not a finding.
17d. **Proportionate depth:** deep tracing (cross-layer data flow, lifecycle
    completeness, idempotency/ordering, integration-seam audit) is required
    only for LARGE changes or core flows. For small changes, Gates 1–3
    verification is sufficient — do not burn budget deep-tracing a copy
    change.
18. Security & data basics, proportionate to the project: secrets in code,
    injection points, unvalidated external input, missing authz, destructive
    ops without confirmation/backup.

## PHASE 4 — VERDICT & PATH FORWARD

19. Findings table: verdict | finding | evidence (file:line or command
    output) | fix. No finding without evidence; no fix without a finding.
    Anything you did not verify: `not-checked`, listed separately.
20. Honest % complete toward the ACCEPTANCE CRITERIA (not the task list),
    with justification.
21. Ordered next steps, blockers first. For each: what, why now, and the
    VERIFY signal — the specific command, test, or observable output that
    will prove it's done. A fix without a verify signal is not a plan.
22. Kill list: what to delete or stop doing.
23. Open questions: all inferred-requirement questions from Phase 1/2/Gate 4,
    each with your recommended answer, for the human to decide.
24. One line: ship-ready / on-track / drifting / in-trouble + the single
    highest-leverage next action.

## PHASE 5 — RE-REVIEW RULES (only when a prior review of this project exists)

These rules prevent the review loop from never terminating:

25. **Freeze the surface.** Audit against the SAME scope as the prior review
    plus its findings. Surface added by the fixes themselves (new endpoints,
    new screens, new modules) is noted for the NEXT cycle, not audited now.
    Each cycle must audit a fixed, shrinking set.
26. **Reviewer memory.** Start by re-verifying the prior review's findings:
    closed / still-open / regressed. Do NOT re-litigate items you previously
    passed, and do NOT raise new blocking findings outside the prior list
    unless a fix introduced them. A re-worded version of a previously
    accepted or previously passed item is auto-advisory.
27. **Damped blocking.** On re-reviews, only `fail` blocks; `needs-changes`
    items not touching a core journey become advisory + backlog. Without
    this, three adversarial passes over a growing surface never converge —
    "done" must be reachable.
28. **Repeat-vs-new check.** Report the ratio of repeated findings to new
    findings vs the prior review. Mostly repeats → the fixes aren't landing
    (process problem). Mostly new → scope is growing (freeze harder).
29. **Diagnose the churn before tuning the process.** Classify this cycle's
    findings: (a) product defects vs (b) test/verification-infrastructure
    defects (flaky selectors, broken seed data, environment issues, timeout
    noise). If (b) dominates, the loop is churning on the test harness, not
    the product — fix the harness first; more review passes will not help.
    Also name WHICH gate keeps recurring across cycles; that gate, not the
    whole process, is where tuning effort goes.

## RULES

- Evidence over vibes. Every claim: file:line, command output, or quoted
  requirement. Unverifiable → `not-checked`, do not guess in either direction.
- **No fixing during review.** Audit, present findings, await go-ahead.
- **Reproduce before diagnosing** (for any failure you analyze): before
  proposing a root cause, name one command you actually ran that reproduces
  the failure, and confirm the loop is: red-capable (currently shows the
  failure), deterministic (same result each run), fast (seconds, not
  minutes), and runnable by you without human help. No such command → no
  diagnosis; building the loop IS the next step. Flaky failure → raise its
  reproduction rate before theorizing.
- **Stop-grinding rule:** if a fix or diagnosis is not converging quickly,
  do NOT keep grinding. Stop and produce a crisp human-facing diagnosis —
  what fails, the reproducing command, what you ruled out, your best
  hypothesis — and park it for a decision. A parked problem with a good
  diagnosis beats a burned budget.
- Partial honest review beats fake complete review: if the codebase is too
  large, state what you sampled and what you skipped.
- Every criticism comes with a concrete fix. Brutal but useful.
