> **ARCHIVED 2026-08-09 — CONSUMED.** #222 + #223 shipped as one slice; §1's decisions are now in
> `223-ndd-counted-healthy.md`, §2's gate is answered in `222-telemetry-staleness.md` (and produced #229).
> Nothing here is current. Part 3 (#218c) remains operator-gated and was NOT run.

# HANDOFF — #222 + #223 as one slice (and what landed before it)

**Opened 2026-08-09.** Written mid-task: Part 1 of the operator's three-part instruction is **done and
committed**; Part 2 (#222 + #223) is **not started**; Part 3 (#218c) is **operator-gated**.

Per CLAUDE.md this file belongs beside the issue and moves to `docs/archive/` with an ARCHIVED banner
once consumed. It is in `audit/` at the operator's explicit request — move it when you consume it.

---

## 0. Read these first, in this order

1. `CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` → `.scratch/fsm-platform-v1/INDEX.md` (last session-log
   row, stamped `5a486f8`)
2. `.scratch/fsm-platform-v1/issues/223-ndd-counted-healthy.md` — the full design. **Read it whole.**
3. `.scratch/fsm-platform-v1/issues/222-telemetry-staleness.md` — owns the offset constant and P6
4. `audit/cross-analysis.md` **§2.3** (line 190, "How far does it reach? — every affirmative-positive,
   with counts") — this is the "six read surfaces" list the operator refers to

Nothing in this document restates those. It carries only what is **not** written down anywhere else.

---

## 1. THE CRITICAL PART — operator decisions that exist only in conversation

`223-ndd-counted-healthy.md` still lists **P2–P7 as unresolved**. That is now stale. The operator
decided five of them on 2026-08-09 and **the issue file has not been updated**. If you do nothing else
from this handoff, land these into #223 first, because the issue currently contradicts them.

| # | Decision | Operator's stated reasoning |
|---|---|---|
| **P2** | **Grace window = 24 h.** Use the existing `inactivity_threshold_hours`; **no new setting.** | It covers ~86–97% of the measured curve. *"If your implementation makes 48 materially better for a reason I have not seen, say so before building rather than after."* |
| **P3** | **Never-reported devices are EXCLUDED from Fleet Uptime — not scored 0%.** | Scoring them zero is defensible, but excluding keeps the KPI measuring what it claims: reliability of devices that have reported. The never-reported count sits **beside** it. Operator explicitly invited push-back on this one. |
| **P4** | **Never-reported gets its own dashboard figure** (the "reported separately" recommendation in #223 §"second question" is ACCEPTED). | Different root causes, different owners; 602 year-old devices would make the genuine backlog unreadable. |
| **P5** | **Customer communication: NOT YET.** Build it; the operator decides comms before anything is exposed. | Vasavadatta (545) and Deepak Fertilizer (208) will see visible drops. |
| **P6** | **The two-directional skew guard ships in THIS slice.** | The current 24 h guard rejects only the future, so the ~5 IST-writing devices pass it and read as permanently fresh — worse than being dropped. *"That is the fourth #228 specimen and it is the only one still latent, so fix it before it activates."* |
| **P7** | Already decided: #222 + #223 ship together. | #223 alone moves Fleet Health **down** 1.1 points with none of the offsetting +2.8 — a bug fix that reads as a regression. |

**Q2 (the 602 >1-year cohort: ticket or hold?) was NOT answered.** It is still open in #223. Do not
assume it.

---

## 2. THE BLOCKING GATE — do this before anything is applied

> *"Tell me the expected closure count for the auto-recovery sweep. All 434 falsely-inactive devices
> hold open TROUBLESHOOT tickets and 65% of the CRITICAL band is fabricated — I want that number in
> the issue before the sweep runs, not after someone asks why SE productivity spiked."*

Concretely required:

- Compute how many currently-open failure cycles / TROUBLESHOOT tickets will **auto-close** when the
  #222 timestamp correction lands (the 434 falsely-inactive devices stop being inactive).
- **Write the number into the issue** (`222` and/or `223`) **before** the sweep runs.
- `AutoRecoveryService` needs no code change (#223 §"ticket-creation path is NOT a blocker"), which is
  exactly why the closure will happen silently if nobody publishes the expected figure first.

This is a hard gate. It is the one thing the operator asked for *before* application, not after.

---

## 3. Acceptance the operator restated (stricter than #223's own list)

- The identity changes from `healthy + inactive = operational` to the three-state form, and **all** of
  these agree: `reconciliation.service.ts:205` (verified: `statement:` line), `docs/kpi-definitions.md`,
  `dashboard.service.ts:25` (identity comment) and `:59-60` (`healthyOperational` doc + field), and the
  Fleet Composition funnel. *"A surface still asserting the two-state identity is a failure, not a
  follow-up."*
- All six read surfaces from cross-analysis §2.3 stop counting never-reported devices as healthy.
- **`test/autoplant-mapping.spec.ts:131` — `expect(AUTOPLANT_UTC_OFFSET_MIN).toBe(330)` — must be
  removed or rewritten as a live source probe.** Verified present. *"A test that pins the wrong
  constant is worse than no test."* Note `:147-149` also consumes the constant; check both.
- The `soft_inactive_count_history` step discontinuity on fix day is **expected and documented**, not
  a regression to be explained later.
- *"Anything you find that assumes today's definitions and I have not listed — tell me rather than
  quietly accommodating it."*

---

## 4. What landed this session (do not redo)

Commits `5a486f8` (slice) and `dc1cf00` (session-log stamp). Both **unpushed**. Details are in the
commit messages and the INDEX row — not repeated here. One-line summary of each strand:

- **Commissioning appender finished**, migration `20260809120000_device_commissioning` committed;
  `git status` and `_prisma_migrations` now agree (75 = 75, both directions empty).
- **`first_reported_at` has coverage** for the first time — `snapshot-first-reported-dualwrite.e2e-spec.ts`.
- **`audit/installer-quality-2026-08/` untracked + ignored**, files kept on disk.
- **Ground-truth xlsx renamed** to `docs/autoplant/SUMMARY_REPORT.xlsx` so all five citations resolve.
- Handoff `HANDOFF-commissioning-capture.md` consumed → `docs/archive/`.

### Directly relevant to your slice

`master-mapping.ts` now carries `first_installed_date_time` / `first_installed_by` /
`installation_remark` on `VehicleMasterMasterRow`, read from the `ap_widgets` join in
`autoplant-master-source.ts`, plus pure `mapCommissioning` + `parseInstalledAt`.

**#223's "Minimum viable change" step 1 is therefore PARTLY DONE.** The AutoPlant *read* of
`FIRST_INSTALLED_DATE_TIME` exists and is normalised at offset 0. What is still missing is
`devices.installed_at` — the mirrored column on `devices` that `DeviceStateService.recompute` needs
for its new `hours` branch. **Do not re-implement the read; reuse `parseInstalledAt`.** Implementing it
twice in two conventions is the exact thing the parked handoff warned about.

Also note `#223 Q1` ("Is `FIRST_INSTALLED_DATE_TIME` UTC?") is now **ANSWERED: yes, offset 0**, measured
against `device_installation_date` across 17,985 devices at exactly 0 minutes' difference, zero at ±330.
Q1 can be closed in the issue.

---

## 5. Open items flagged to the operator, not yet actioned

| Item | State |
|---|---|
| **97 pre-existing type errors in `test/**`** | `apps/backend/tsconfig.test.json` (new, committed) typechecks specs; `pnpm typecheck` is **unchanged** and still `src/**` only. Errors are bigint/string ids, `Partial<>` spreads against required fields, enum literals. **Unowned. Not filed** — backlog ownership is a HITL stop per CLAUDE.md. |
| **`docs/autoplant/SUMMARY_REPORT.xlsx` tracking** | Untracked. A 25,214-row production extract vs `docs/` policy that says track the whole tree. Conflict is unresolved and is the operator's call. |
| **Installer report in local history** | Untracked at the tip but still inside unpushed commit `9e137e9`. History rewrite still available and cheap; operator has not decided. |
| **#223 Q2** | 602 >1-year cohort: ticket or hold? Unanswered. |

---

## 6. Gotchas that will cost you time if you rediscover them

1. **`vi.spyOn(prismaDelegate, 'method').mockRestore()` is a trap.** Prisma model delegates sit behind
   a Proxy; `spyOn` installs an own property and `mockRestore()` **deletes it without reviving the
   proxy**. Every later call throws `"<method> is not a function"`, which reads exactly like an
   implementation bug. Capture the original and re-assign. Encoded in
   `test/device-commissioning.e2e-spec.ts` (`withFailingCommissioningWrite`).
2. **SWC does not typecheck.** A spec can reference a non-existent field, compile, run, silently drop
   it, and fail on an assertion — pointing at the wrong cause. Use
   `npx tsc -p tsconfig.test.json` and grep for **your** files; the 97 pre-existing errors are noise.
3. **Editing an applied migration changes its checksum.** Prisma 7.8 `migrate deploy`/`status` do
   **not** verify it (only `migrate dev` does), so nothing breaks immediately — but fix
   `_prisma_migrations.checksum` in **both** `fsm` and `fsm_test`. Plain `sha256(file bytes)`.
4. **Never `sed` the INDEX session log on a trailing-cell pattern.** 47 historical rows end in
   `| this commit |`; a naive substitution rewrote all of them. Use an exact full-sentence anchor.
   (Happened this session, caught on verification, reverted.)
5. **`git diff` on this repo is CRLF-noisy.** Use `--ignore-cr-at-eol` before concluding a change is
   larger than it is.
6. **Run tests from `apps/backend/`**, not the repo root — vitest finds no files from root.
7. **Commit with explicit paths.** `git add -A` would sweep #190's untracked test-infra set
   (`run-tests.mjs`, `vitest.config.ts`, `crash-diagnostics.ts`, `patches/`, `verify-run1.txt`,
   `pnpm-lock.yaml`, `pnpm-workspace.yaml`) — someone else's authored work; #190 owns it.

---

## 7. Baseline to verify against

- **Full suite before your changes:** 356 files — 352 passed / 3 skipped / **1 failed**. The failure is
  `voucher-controller.e2e-spec.ts` (2 tests), the known **#215** fixture dependency, zero overlap with
  ingestion. Treat it as the expected baseline, not your regression.
- `tsc --noEmit` clean on `src/**`.
- Fleet Health target after both fixes: **84.84%** (#223 table: today 82.96 → #223-only 81.90 →
  #222-only 85.72 → both 84.84).
- Dev/test DB: `localhost:5433`, databases `fsm` and `fsm_test`. **Credentials are in
  `apps/backend/.env` — do not copy them into any document.** No `psql` CLI on this machine; use
  `pg` from `apps/backend/node_modules` (see memory `project_db_query_tooling`).
- ⚠ `fsm` holds a **real AutoPlant device mirror but seeded org data** — trust device-level figures,
  distrust ticket/SE figures (memory `project_fsm_db_is_local_dev`).

---

## 8. Part 3 — #218c, do NOT run

Operator: *"Do not run the catch-up. When Parts 1 and 2 are done, tell me what state it is in and what
the current dry-run says, and I will decide."*

So: when Part 2 is complete, **report** #218c's state and the current dry-run output. Do not execute.
The stand-down export is gitignored and regenerates on every read-only rehearsal.

---

## 9. Suggested skills

| Skill | When |
|---|---|
| **`/tdd`** | The primary one. #223 is a behaviour change to a published KPI with a listed "What breaks" table — red-green-refactor per slice, and the repo's per-slice TDD report format is in `docs/agents/workflow.md`. |
| **`/field-ops-director`** | Before finalising the state model. This slice changes what "healthy" means operationally and opens ~912 tickets routed to SEs who cannot fix an installation defect (#223 Risks). A domain-reality review is worth more here than a code review. |
| **`/code-review`** | After the slice is green, before reporting. Spec axis matters most — #223 has explicit acceptance criteria and the operator restated a stricter set (§3 above). |
| **`/diagnose`** | Only if the 434/65% figures do not reproduce when you measure them. Do not re-derive by assumption; the cross-analysis records three separate `MAX()`-trap self-corrections on exactly this data. |

Avoid `/research` and `/wayfinder` — the investigation is done and written up; this is execution.

---

## 10. First three moves

1. Land the §1 decisions into `223-ndd-counted-healthy.md` (P2–P7 + close Q1), so the issue stops
   contradicting the operator.
2. Compute and record the §2 auto-recovery closure count **before** touching application code.
3. Only then start the slice — and if 48 h looks materially better than the decided 24 h grace window,
   **say so before building**, as instructed.
