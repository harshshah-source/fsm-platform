# Handoff — Scheduler/Assignment Redesign: analysis done, issues filed, implementation gated

> ⚠️ **ARCHIVED / CONSUMED 2026-08-19.** The implementation gate this file waited on was opened
> and its first two slices are built: #240 and #241 are done and green (`eb80645`, `ada87b8`). Current
> state is the INDEX session log and `docs/progress/240-*.md` / `241-*.md`; nothing here is current.


**Written 2026-08-19 at the end of the analysis/planning session. For the next agent session,
which is expected to IMPLEMENT the filed slices — but only after the operator's explicit
implementation approval (not yet given at the time of writing; the operator's last state was
"stopped at the implementation gate").**

---

## Where things stand

Three same-day analysis passes (2026-08-18 ×2, 2026-08-19) validated the operator's nine approved
scheduler/assignment business decisions against the actual source (commit `0b72976`) and the live
dev database. All open business questions were answered by the operator. **Twelve tracer-bullet
issues are filed and nothing is implemented.** No source, test, migration, or database change was
made in the entire effort — only docs and issue files.

### Read these, in order (do not re-derive them)

1. `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` → `.scratch/fsm-platform-v1/INDEX.md`
   (mandatory repo reading order; INDEX now has a **"Scheduler-decisions block"** — items 60–71 —
   and 2026-08-18/19 session-log rows for this effort).
2. `docs/audits/scheduler-slice-plan-2026-08-19.md` — architecture fit, dependency graph, the
   verified assignment-writer classification, risks.
3. `docs/audits/four-decisions-final-analysis-2026-08-18.md` — the deep verification: Special
   state machine, recycling safety proof, cleanup scope with verification queries (V1–V5), the
   corrections to earlier reports.
4. `docs/audits/four-decisions-fresh-verification-2026-08-18.md` — 9 corrections to the four
   older audit docs + 12 latent defects with file:line evidence.
5. The issue files themselves: `.scratch/fsm-platform-v1/issues/240-*.md` … `251-*.md`. Each
   carries verified current behaviour (file:line), ACs, tests, risks, rollback. **They are the
   spec — implement from them, not from memory of this summary.**

### Approved decisions (digest — full text lives in the issues and plan doc)

- Non-blocking admin preview (holds only pre-run); no vehicle-location rule anywhere in
  scheduling; Special ticket = ≥ N (configurable, default 3, min 2) unsuccessful *reached*
  attempts, derived not stored, identification-only, never a TicketStatus; unresolved assignments
  recycle at schedule closure; vehicle return date = SE proposal → audited manager
  approve/override → IST-calendar-day deferral (same-day = no deferral; **no horizon/count
  bounds**) → Option C priority (below CRITICAL+, above normal backlog); dev-data cleanup before
  recycling is enabled.
- **Recorded gate answers (operator-approved, do not re-litigate):** Q1(a) — the SE's proposed
  date takes effect immediately as a *provisional* deferral; management review changes the date,
  never un-waits the ticket. Q2(a) — the latest valid in-scope managerial action supersedes,
  regardless of role (ZM zone-clamped; CSM/OH global); no role rank, no lock; audit carries
  accountability. Both are restated in `issues/245-*.md`.

### Build order (restated in each file's "Blocked by")

```text
Track 1: #240 (IST fixes) + #241 (removal_reason)  →  #243 (cleanup, HITL, gates #242 enablement)
         →  #242 (recycling)  →  #244 (Special)
Track 2: #245 (VU approval lifecycle)  →  #246 (return-date wiring)
         →  #247 (SLA) / #248 (Option C) / #249 (confirm-override)   [parallel after #246]
Track 3: #250 (dry-run seam)  →  #251 (preview page)                 [#240 sequenced ahead]
```

Start with **#240 + #241** (independent, no prerequisites). **#243 is HITL** — it is a data
operation needing its own explicit execution approval and re-measured counts; do not run it as a
side effect of anything.

## Load-bearing verified facts (pointers, not repetition)

The final-analysis and slice-plan docs contain line-exact evidence for everything below; trust
them over the four older audit docs (`vehicle-presence-*`, `pool-scheduler-*`,
`scheduler-decisions-*`, `four-decisions-readiness-*`), which contain nine corrected errors:

- `removed_by NULL` is already owned by auto-recovery — never infer "system recycle" from it
  (hence #241 before #242).
- The closure cron has no `timeZone` and fires *after* dispatch on a UTC host (#240 is a hard
  prerequisite of #242); `plannerForDate` and `assignTicket` carry the same UTC-day bug family.
- The dispatch ordering is TypeScript-only — `canonical-sort.ts`'s "SQL mirror" docstring is
  stale; there is no SQL ORDER BY to keep in sync (#248 fixes the docstring).
- `SWAP_SE` moves the batch, never the ticket rows (same attempt window continues);
  `REASSIGN`/`SPLIT_BATCH` end the old row (human) and open a new one.
- `assignPlants` honours deferral; `assignTicket` is the real deferral-bypass entry point (#249).
- The mobile write queue has zero callers; a failed submit is lost and retries mint new
  idempotency keys — one reason Special is derived (self-correcting).
- Verification closure is an automated GPS worker; `FAILED_VERIFICATION` is irreversible and
  strands its cycle (`hasOpenFailureCycle` stays true) — a known latent defect, *not* in scope of
  these slices.
- Dev-DB baseline for #243 (2026-08-18 snapshot; **re-measure at execution**): C1 = 3,310,
  C2 = 4,684 (~1,357 immediately dispatchable), C3 = 1,092.

## Environment notes

- Dev Postgres: `localhost:5433`, db `fsm` — connection string in `apps/backend/.env`
  (credentials there; not repeated here). `psql` is not on PATH; use
  `"C:\Program Files\PostgreSQL\16\bin\psql"`. Test DB is `fsm_test` (never truncated between
  files — see #156/#180 conventions).
- The dev DB is an ingested mirror with a **seeded SE roster**; ingestion scheduler is OFF —
  counts drift only via manual actions.
- `BUSINESS_SWEEPS_ENABLED` gates closure/verification/etc. sweeps; test-suite hermeticity rules
  for it are in #182's notes (INDEX suite-repair block).
- **The working tree carries many uncommitted modifications that predate this effort** (admin
  chart redesign, acting-zone fixes, #238 — see the 2026-08-13/17 session-log rows, several marked
  "uncommitted working tree"). Nothing from the scheduler effort is committed either (docs +
  issues only). Do not sweep unrelated uncommitted files into scheduler commits; commit
  per-slice, and only what the slice touched.

## Suggested skills

- **`/tdd`** — the repo's mandatory red-green-refactor protocol for building each slice
  (CLAUDE.md: the protocol *is* the skill; per-slice TDD report format lives in
  `docs/agents/workflow.md`).
- **`/review`** (or `/code-review`) — after each slice lands, review the diff against the issue's
  ACs and repo standards before marking it done in INDEX.
- **`/field-ops-director`** — worth a pass over #245/#246 (the approval workflow and mobile
  date-entry changes) to sanity-check field reality before building the UI surfaces.
- **`/simplify`** — optional post-green pass on the larger slices (#242, #245).

## First actions for the next session

1. Confirm the operator has given implementation approval (the gate was still closed at handoff).
2. Re-read the reading-order list above; check `git log` — if the tree moved past `0b72976`,
   spot-check the line references in the issues you're about to build.
3. Begin with #240 and #241 via `/tdd`; update INDEX (issue status + session-log row) as each
   slice lands, per the mandatory progress convention in CLAUDE.md.
