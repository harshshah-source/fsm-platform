# STATUS — where the work actually stands

**Compiled 2026-08-09. Read-only audit: nothing was built, committed, applied or fixed to produce it.**
Branch `feat/autoplant-integration`, HEAD `5bad38c`.

## How to read the categories

There is **no deployment mechanism in this repo** (#111 is open) and there is exactly one environment:
the local dev Postgres at `localhost:5433`. So the categories mean:

| Category | Means |
|---|---|
| **Shipped** | Committed, needs no migration, and takes effect the next time the code runs |
| **Committed, not applied** | Code is in git, but the migration has not been run and/or the code has never actually executed here |
| **Written, not committed** | Exists only in this working tree |
| **Designed only** | An issue or document exists; no code |
| **Idea** | Discussed or recommended; nothing written |

Two verification facts that qualify everything below:

- **Backend `tsc --noEmit` only covers `src/**`.** `tsconfig.json` has `"include": ["src/**/*.ts"]`, so
  `test/` is *never* typechecked and vitest transpiles with SWC, which does not typecheck either.
  "Backend compiles clean" therefore says nothing about the new spec files.
- **I did not run the backend suite.** Its `globalSetup` migrates and seeds `fsm_test`, which would
  apply the unapplied migration — an action you excluded. Backend test claims below are static reads
  of the code, and are labelled as such. Mobile tests were run (no DB involved).

---

## 1. What is actually done

### Shipped

| Work | Evidence | Note |
|---|---|---|
| #217 Operations Data Explorer, slices 1–3 + the `import type` DTO fix | `ba6053c`, `25369e5`, `f813b39` | INDEX's session-log rows for S2 and S3 still read *"(uncommitted — this session)"*. **Stale markers — the code is committed.** |
| #218a lifecycle drift detection (`lifecycleHealth()`, `quietRuns`, 9th Ops-Explorer identity) | `9c00ad6` | Baseline captured through the shipped code: `drift 5134 · missingFromSource 1131 · quietRuns 27` |
| #218 pre-window deliverables: `autoplant:window-preflight`, `--export-standdown`, SE-team note, window prep, pre-window baseline | `9c00ad6`, `5bad38c`, `36672d4`, `56ba655` | All docs/tooling. No data written. |
| #204 IST operating day · #213 operator-owned dispatch schedule · #209 native Android build · mobile #66/#68/#71/#77/#85/#86/#87 | commits through `fd289de` | The mobile app's committed state stops at the Android build |
| Installer-quality report (180-day analysis, 3 CSVs) | `audit/installer-quality-2026-08/` | Complete as an analysis product. **Untracked** — exists only in this working tree. Its action list is excluded from this document per your instruction. |

### Committed, but not applied

| Work | Evidence | What is missing |
|---|---|---|
| **#218b — the DI fix** | `9c00ad6` | The code is right and proven (4/4 red → green, 67/67 regression). But **no master sync has run since it landed**: the dev DB reading is byte-identical to the 218a baseline (`5134/1131/27`). The lifecycle pass has still never executed on the Nest-wired path *in this environment*. It is a fix that has not yet had an occasion to work. |
| **#218c — the catch-up window** | `audit/autoplant-reconciliation/FIX-PLAN.md`, `WINDOW-PREP-2026-08-07.md` | Fully prepared: three confirming dry-runs (5,238 departures — UNDEPLOYED 3,886 · MISSING_FROM_SOURCE 1,306 · MAINTENANCE 46; 4,383 tickets to force-close; 1,691 live-batch rows across 234 batches), preflight script, stand-down export, SE note, rollback position, recommended time. **Not approved. Not run.** |

### Written, but not committed

See §2 for detail. In summary: the whole mobile Home/UI pass, the #175 backend endpoint, the #217
plants enrichment, the `first_reported_at` capture, the `device_commissioning` table, #184's
test-infra deliverables, and eight audit documents.

### Designed only

| Work | Where | State |
|---|---|---|
| **#222** — the +330 offset is wrong; FSM shifts every GPS ping 5.5 h into the past | `issues/222-telemetry-staleness.md` (**rewritten in this working tree, uncommitted**) | Full design, 5 proposed steps, acceptance criteria. Explicitly re-scoped 2026-08-09: **not a one-line constant change** — the two-directional skew guard must ship in the same release. |
| **#223** — never-reported devices counted healthy | `issues/223-ndd-counted-healthy.md` (**rewritten, uncommitted**) | Full design: state model, 6-step MVP, 9 documented breakages, measured Fleet-Health movement. P1 decided. P2–P5 open. |
| **#226** — FSM holds NULL GPS for 15 devices the source has telemetry for | `issues/226-*.md` (**untracked**) | Filed, deliberately **not** diagnosed. Candidates listed unranked. |
| **#227** — 6 device rows FSM holds that the source no longer has | `issues/227-*.md` (**untracked**) | Filed. Disposition must be taken once, jointly with #220. Total orphan count across all 26,543 mirrored devices **not measured** — 6 is a floor. |
| **#228** — every guard is one-directional and fails toward "fine" | `issues/228-*.md` (**untracked**) | Four remedies (R1 empirical identities, R2 distributional source fingerprints, R3 typed zeros, **R4 boot-time DI resolution test**). No code. |
| #224 — lifecycle check absent from the Integration Health page | `issues/224-*.md` (committed) | `ready-for-agent`, frontend-only, backend already ships the data. **Hard parity gate on #218 being marked done.** |
| #225 — #218's two documentation deliverables | `issues/225-*.md` (committed) | `ready-for-agent`. Also has to settle a live `quietRunsAlert` wording mismatch. |
| #221 — lint the `import type` DI-erasure class + review 13 `@Optional()` params | `issues/221-*.md` (committed) | `ready-for-agent`. Audit already done (747 files, 2 real instances, 10 false positives). |
| #219, #220 — the unexplained 1,251-row Excel gap; `mst_vehicle` hard-deletes | committed issue files | Investigation records. #219 is the only reconciliation figure never accounted for. |
| **Commissioning / install-quality view** | `audit/commissioning-view-feasibility.md` (**untracked**, 40 KB) | Verdict: build it, but the premise needed correcting — 97% of installs report within 24 h, so there is essentially no commissioning tail. Endpoint and page **not started**. |
| #190 — #184's deliverables uncommitted while #184 reads `done` | `issues/190-*.md` (committed) | Still true today. See §2 bundle E. |

### Idea

- The commissioning/install-quality **admin page** itself (feasibility §7.3 sizes it M–L). Its own
  assessment recommends deferring until several weeks of `first_reported_at` data exist.
- **Person-vs-machine installer classification** — a hand-maintained pattern list, named as a
  maintenance liability.
- **#223's "correct model"** — a `device_report_state` enum replacing the boolean pair. Sized 1–2
  weeks and explicitly marked *do not attempt in this slice*.
- **#222 step 5's threshold** — how far into the past is implausible. Designed in principle, no value chosen.

### Things you may believe are done that are not

1. **#218 is not done.** 218a and 218b landed; 218c is unapproved and unrun; #224 and #225 are open,
   and #224 is a hard parity gate under CLAUDE.md.
2. **#184 reads `done` but its deliverables are uncommitted.** The retry wrapper, `vitest.config.ts`
   change, `crash-diagnostics.ts`, the tinypool patch and the `patchedDependencies` registration live
   only in this working tree. A fresh clone or CI gets none of them — i.e. the silent file-drop #184
   was opened to eliminate is reintroduced everywhere except this machine. Already filed as #190.
3. **The mobile Home dashboard work is not committed.** INDEX is honest about this — both 2026-08-05
   rows say *"(uncommitted — awaiting review)"* — but the work is described in past tense as landed,
   and it is four days old.
4. **`docs/progress/184-vitest-worker-exited-unexpectedly.md` does not exist**, yet `run-tests.mjs`
   and `vitest.config.ts` both cite it as the authority for a live config decision.
5. **`docs/SYSTEM-STATE-2026-07.md` is current only through #218b** (last touched in `9c00ad6`). It has
   **zero** mentions of #222, #223, #226, #227, #228, `first_reported_at` or `device_commissioning`.
6. **`audit/handoff.md` is a consumed handoff still sitting outside `docs/archive/`.** It is dated
   2026-08-04, names #68 as "next", and CLAUDE.md says it should have been `git mv`'d with an
   ARCHIVED banner as soon as it was consumed.

---

## 2. What is in flight right now

35 modified files, 20 untracked paths. It is **six independent bundles**, not one change.

### A — Mobile Home/UI pass + the #175 backend endpoint (the largest)

- **Backend:** new `me-work-history.service.ts` (134 lines), controller route `GET /me/work-history`,
  module wiring, `MeWorkHistoryView`/`MeWorkHistoryDay` in `@fsm/shared`, mobile API client function,
  and `test/me-work-history.e2e-spec.ts` (228 lines).
- **Mobile:** 18 modified files (+903/−181) — `HomeScreen` rebuilt to
  `docs/ui/mobile/home-dashboard.png`, `LoginScreen` fully restyled, `SeTabShell`, `ProfileScreen`,
  six kit components, theme tokens — plus 6 new files (`BrandMark`, `WorkHistoryChart` + test,
  `PlantWorkloadCard`, `plantSummary` + test, `metro.config.js`).
- **State:** complete. `#175`'s series half is ticked; its second AC (dated ticket-row read) is
  explicitly left for #88.
- **Compiles:** backend `tsc --noEmit` **clean**; mobile `tsc --noEmit -p tsconfig.typecheck.json` **clean**.
- **Tests:** mobile **49 suites / 337 tests, all passing** (run just now). The backend
  `me-work-history` e2e was **not run** — the service and its wiring exist, so it is plausible-green,
  but that is an inference, not a measurement.
- **To finish:** review and commit. No code left to write.

### B — #217 Ops Explorer `plants` enrichment

`dataset-registry.ts` +162 lines: `companyNames`, `vehicleCount`, `deviceCount`,
`deployed/undeployedVehicleCount`, `active/inactiveDeviceCount`. Registry-only, no engine change.
Compiles. INDEX already records it (accurately) as uncommitted. **To finish:** commit.

### C — `first_reported_at` capture (perishable)

`device_states.first_reported_at` + `first_reported_offset_min`, written write-once via `COALESCE` in
the existing snapshot-ingestion upsert, at **true UTC (offset 0)** rather than the wrong live +330 —
so the column is correct on the day it is written and needs no correction pass after #222.

- **Compiles:** yes (`src` only).
- **Migration NOT applied.** Verified directly against `localhost:5433`: the columns do not exist, the
  `device_commissioning` table does not exist, and `prisma migrate status` reports
  `20260809120000_device_commissioning` as pending.
- **Consequence, stated plainly:** with this working tree and the migration unapplied, **the next
  snapshot ingest against the dev DB will throw** — the INSERT names columns the database does not have.
- **No test covers `first_reported_at` anywhere.** Not one file in `apps/backend/test` references it.
  This is a write-once column with an unusual offset contract and zero coverage.

### D — `device_commissioning` fact table — **half-built, and red by construction**

Schema model (61 lines, heavily documented), migration (PG-15 guard, `NULLS NOT DISTINCT` unique
index, column comments), generated Prisma client, and a 220-line e2e spec that boots the real
`AppModule`.

**There is no writer.** A repo-wide grep finds `device_commissioning` in exactly three places:
generated Prisma code, the migration, and the spec. `master-sync.service.ts` and `master-mapping.ts`
are untouched; `VehicleMasterMasterRow` has no `first_installed_date_time` or `first_installed_by`
field, though the spec constructs rows with both. Because backend `tsc` never sees `test/` and SWC
does not typecheck, **those type errors are invisible and the spec will simply fail at runtime**.

This is a genuine TDD red state — the test is written, the implementation is not — but nothing in the
tree says so, and a casual `git status` reads it as finished work.

### E — #184 / #190 test infrastructure (not from these two sessions)

`scripts/run-tests.mjs` (crash-retry wrapper), `vitest.config.ts`, `test/crash-diagnostics.ts`,
`patches/tinypool@1.1.1.patch`, `pnpm-workspace.yaml` `patchedDependencies`, `pnpm-lock.yaml`,
`audit/verify-run1.txt`. Authored on another machine/session, already tracked as **#190**. Memory note
`project_190_lockfile_entanglement` applies: the lockfile is entangled with this.

### F — Documents

Modified: `INDEX.md` (5 issue lines + 1 session-log row), issues #222 and #223 (both substantially
rewritten with withdrawn diagnoses), #175, #55. Untracked: issues #226/#227/#228, and eight audit
documents including `cross-analysis.md`, `prism-independent/`, `commissioning-view-feasibility.md`,
`installer-quality-2026-08/`, `structural-audit-2026-08-05.md`, the two mobile audits, and
`docs/autoplant/SUMMARY REPORT Deployed (6).xlsx`.

### Are you an hour or a day from clean?

**Neither, exactly — it depends where you draw "clean".**

- **~2 hours** gets you an *honest* tree: commit A, B and F, and leave C and D uncommitted behind an
  explicit note (or commit them with the red spec marked skipped and the migration state stated).
  Nothing is lost, and `git status` stops lying.
- **~1 day** gets you a *finished* tree: the above, plus applying the migration, writing the missing
  `first_reported_at` test, and writing the master-sync commissioning writer to turn D green.

Do not split the difference by committing C and D as-is: that publishes a migration nobody has run
and a spec that cannot pass.

---

## 3. What depends on what

### The commissioning view

| Needs | Status |
|---|---|
| `first_reported_at` capture | **Written, migration unapplied, untested** (bundle C) |
| An immutable fitment record | **Table exists, writer does not** (bundle D) |
| Master-sync read of `FIRST_INSTALLED_DATE_TIME` / `_BY` / `INSTALLATION_REMARK` | **Not written** |
| A settled NDD definition | #223 P1 decided; the rest of #223 unbuilt |
| #222 landed | Not started |
| Cohort endpoint + admin page | Not started (the bulk of the work) |

So: the *page* is not buildable for weeks — and by its own feasibility assessment it should not be,
because it needs accumulated `first_reported_at` data before its central number is real. **The
capture, by contrast, is buildable today and is the only genuinely time-sensitive item in this
document:** every day it does not run is a day of commissioning history that no later query recovers.

### What #223 changes that other surfaces must agree with

`healthy + inactive = operational` becomes `healthy + inactive + neverReported = operational`. That
touches: `reconciliation.service.ts:205` · `dashboard.service.ts` (`FLEET_COUNT_COLUMNS`, the Fleet
Composition funnel) · `kpiCatalog.ts:137` · `docs/kpi-definitions.md` (which currently states the
two-way identity as a guarantee) · `dashboard-kpi-reconciliation.e2e-spec.ts` and
`dashboard-total-devices.e2e-spec.ts` · **the Ops Explorer `plants` dataset** · seven admin components
(`OperationalFleetSection`, `ZoneOverviewTable`, `CompanyPlantTable`, `ScorecardTable`,
`FleetDirectoryPage`, `ZoneDrilldownSection`) · `soft_inactive_count_history` (a step change on the
fix day) · and ~912 new TROUBLESHOOT tickets in one sweep, +7.3% on a 12,571 baseline.

### Would have to be built twice if done in the wrong order

1. **The master-sync read of the commissioning columns.** #223 step 1 says "add `devices.installed_at`
   and read `FIRST_INSTALLED_DATE_TIME`"; bundle D reads the same columns into a fact table. Done
   separately, the same source read is implemented twice, in two conventions. **Do them as one change.**
2. **Ops Explorer `plants` columns (bundle B) vs #223.** The new `activeDeviceCount` /
   `inactiveDeviceCount` deliberately mirror `FLEET_COUNT_COLUMNS`' predicates — which #223 rewrites.
   Landing B first is cheap and #223 then updates one place; landing it after means writing it against
   a predicate that has just moved.
3. **#222 step 1 without step 5.** Flipping the constant alone does not drop the ~5 IST-writing
   devices — it makes them read as permanently fresh (negative inactivity clamped to 0), so they can
   never again be detected inactive or ticketed. A visible fleet-wide error becomes five invisible
   devices, and you fix it twice.
4. **#223 shipped without #222.** Fleet Health moves 82.96% → **81.90%**, which reads as a regression
   caused by a bug fix; with #222 it lands at 84.84%. Two rounds of the same customer conversation.
5. **#218c relative to #222/#223 measurement.** #218c changes the deployment status of **5,238**
   devices. Every #222/#223 figure — the 913 NDD devices, the 434 false-inactives, 84.84% — was
   measured on a mirror carrying 5,134 rows of lifecycle drift. **The overlap between the two
   populations has not been measured.** Either run #218c first and re-measure, or accept that the
   #222/#223 acceptance numbers will move under you.
6. **#225's progress report before #218c runs.** The report would freeze without the window's actual
   readings against its own falsifiable predictions. #225 says this itself.
7. **A commissioning cohort surface built before #222/#223** would be a fourth consumer of predicates
   currently being rewritten — the feasibility assessment names this as its own §11.4 objection.

### Blocks that are cheap to clear

- **#190** blocks any trustworthy statement about the backend suite, on any machine but this one. XS.
- **#224** blocks #218 being marked done. Frontend-only; the backend already returns the data. S.
- **#228 R4** (a boot-time DI resolution test) blocks nothing, but it is the one remedy that would
  have caught both #217's and #218's defect class, and it is one file.

---

## 4. Decided vs still on you

### Decisions I have on record — check these

| # | Decision | When |
|---|---|---|
| 1 | **A fitted tracker that has never reported is a fault**, not a pipeline state — counted inactive, ticketed, dispatched like any silent device. (#223 P1) | 2026-08-07 |
| 2 | **#222 and #223 ship as one slice**, because they move Fleet Health in opposite directions. (#223 P7) | 2026-08-07 |
| 3 | **#222 and #223 were deliberately excluded from #218's scope.** | 2026-08-07 |
| 4 | **#218c is operator-gated and not approved.** No production data written; the recommendation on file is Monday 2026-08-10 ~04:00 IST with a Saturday fallback. | 2026-08-07 |
| 5 | **#217 slice 3 re-scoped** — reuse `AutoPlantHealthService.reconciliationHealth()` rather than build a 12th browsable AutoPlant dataset (the DBA's <100-row-per-query cap). | 2026-08-06 |
| 6 | **#217 authorization** — `OPERATIONS_HEAD` + `OPS_EXPLORER_ENABLED`, 404 not 403 when disabled, no sixth RBAC role. | 2026-08-06 |
| 7 | The **operating day is the IST day**; the dispatch cron is pinned to Asia/Kolkata. (#204) | 2026-08-04 |
| 8 | The Excel side of the reconciliation was **verified by hand in pivot tables before any code**. | 2026-08-07 |
| 9 | Mobile charts are drawn with plain `View`s, not `react-native-svg` — a native dependency would invalidate the #209 debug APK. | 2026-08-05 |
| 10 | `employeeCode` is **cancelled, not deferred** — never render an ID under an engineer's name. | earlier |
| 11 | **You are in development, not production; losing records from before today is acceptable.** | this session |

Decision 11 materially changes the weight of #218c, #223's staged backfill, and #223 P5 — all of which
were designed around protecting production data and customer-visible numbers.

### Still on you

| Decision | Blocks | Urgency |
|---|---|---|
| **#222 P6** — the ~5 genuine IST-writing devices: accept them as permanently false-healthy, special-case the ids, or detect convention per-device at ingest | #222's acceptance, therefore the whole #222+#223 slice | **High** — it is the last thing standing between the design and a build |
| **#222 step-5 threshold** — how far into the past counts as implausible | Same slice; coupled to P6 | **High** |
| **#218c approval, timing, and execution path** — the original CLI script, or a restart plus the now-fixed `POST /api/integration/run-pipeline` (which would double as proof the DI fix works where it matters) | #218 closure; and every #222/#223 baseline figure | **High** — and it is the one item here that is an operation rather than a build; you may want it outside this sequence entirely |
| **#223 P3** — is a never-reported device 0% uptime, or excluded from Fleet Uptime? Contractual, not technical. Today all 913 score **100% uptime**. | Uptime aggregation inside the #223 slice | **Medium-high** |
| **#223 P2** — grace window from fitment. 24 h falls out for free; anything else needs its own setting (do not overload `inactivity_threshold_hours`, it is the Fleet-Uptime denominator). The measured curve says 97% report within 24 h and the feasibility doc recommends 48 h. | The `hours` branch | **Medium** |
| **#223 Q2** — ticket the 602 devices fitted >1 year ago, or hold them until install-vs-field routing is settled? | The backfill gate | **Medium** |
| **#223 P4** — fourth dashboard tile, or fold into a widened "not reporting" figure? Recommendation on file: **separate**. | Admin UI half of the slice | **Medium** |
| **#227 + #220 joint disposition** — retain frozen (the `ABSENT_FROM_READ` posture), tombstone, or exclude. Must be taken **once**, for both. | #227 and #220 | **Medium** |
| **#190** — commit the #184 test-infra as-is, or discard it? It is someone else's authored work. | Trustworthy CI, and a permanently noisy `git status` | **Medium, but XS to act on** |
| **#223 P5** — customer communication before Vasavadatta (545) and Deepak Fertilizer (208) see visible health drops | Release sequencing | **Low now**, given decision 11 |
| **#223 Q1/Q3** — is `FIRST_INSTALLED_DATE_TIME` UTC (matters only below a ~12 h window)? Do the 6 orphans need an `installed_at` fallback? | Minor design details | **Low** |
| **Commissioning view** — window length (48 h recommended); installer vs plant as the unit of accountability; machine accounts shown/hidden/bucketed; who owns the 3,903 >1-year source population (six times #223's 602, currently ownerless) | The page only | **Low** — the page is deferred by its own assessment |
| Whether `audit/` and `docs/autoplant/*.xlsx` are committed at all | Nothing; ongoing drift | **Low** |

---

## 5. Recommended order

Sizes: XS < half a day · S ≈ a day · M ≈ 2–4 days · L ≈ a week or more.

**1. Clear the working tree — bundles A, B, F. (S — review and commit only, no new code.)**
*Dependency, partly.* B genuinely must precede #223 (item 3.2 above). A and F are hygiene, but A is
four days old, is green on both typecheck and 337 mobile tests, and is the largest body of finished
work with no home. Everything below is easier to reason about once `git status` is honest.

**2. Decide #190 and act on it. (XS.)**
*Dependency.* Until this is resolved, no statement about the backend suite is verifiable anywhere but
this machine — which undermines the evidence for every item after it. Commit or discard; either is fine,
leaving it is not. While you are there, either write `docs/progress/184-*.md` or delete the two code
citations that point at it.

**3. Apply the migration and finish the perishable capture — bundle C. (S.)**
*Dependency, and the only time-driven one in this document.* Two reasons, both hard: the working tree
will throw on the next ingest until the migration is applied, and `first_reported_at` is observable
exactly once, as it happens — the raw telemetry table drops partitions after 7 days, so no later query
recovers it. Add the missing test while you are in there; a write-once column with a deliberately
non-standard offset and zero coverage is exactly the shape #228 is about.

**4. Write the commissioning writer — bundle D — as the same change that gives #223 its `installed_at`. (M.)**
*Dependency.* Doing these separately implements the same AutoPlant read twice (item 3.1). This turns a
currently-red 220-line spec green and closes the "looks finished, isn't" gap in the tree.

**5. #228 R4 — the boot-time DI resolution test. (XS–S.)**
*Preference, but a strong one.* It blocks nothing. It goes here because it is one file, it would have
caught both #217's and #218's defect, and everything after this point is a large rewrite of the state
model — you want that net in place before, not after. If only one thing from #228 ever ships, #228
itself says this is the one.

**6. #224 — render `lifecycle` on the Integration Health page. (S, frontend only.)**
*Preference on position, dependency on outcome.* The backend already ships the data; this is a
documented parity-gate breach sitting open. Cheap, and it closes one of the two things blocking #218.

**7. #218c — the catch-up window, if you approve it. (Operation, not a build.)**
*Dependency, with a caveat.* It changes 5,238 device statuses, and every #222/#223 measurement was
taken against the drifted mirror. Running it before the #222+#223 build means those figures get
re-measured once, on a corrected fleet, rather than being invalidated mid-slice. **But this is the one
operational item in the sequence** — if you would rather handle it the way you are handling the
uncovered-vehicles list, pull it out and simply accept that #222/#223's acceptance numbers will need
re-measuring afterwards.

**8. #222 + #223 as one slice. (L.)**
*Dependency — the coupling is your own decision (2), and the P-decisions above gate the start.* Internal
order, which is itself dependency-driven: `AUTOPLANT_UTC_OFFSET_MIN = 0` **together with** the
two-directional skew guard and the removal of the pinned-constant test (item 3.3) → the NDD state model
and the three-way identity → the admin surfaces → the operator-gated ticket backfill last. Fold in #226
or explicitly scope it out and say so; those 15 devices are inside the 913 and will be mis-treated by
#223's fix while #226 is open.

**9. #225, then close #218. (S.)**
*Dependency.* The progress report should carry the window's actual readings, so it comes after step 7.
#218 cannot be marked done before #224 and #225 are both closed.

**10. #221 lint rule, #226 diagnosis, #227+#220 disposition, #228 R1/R2/R3. (S–M each.)**
*Preference.* All independent; sequence them however suits you. #226 moves up if you decide to
diagnose rather than scope it out in step 8.

**11. The commissioning / install-quality page. (M–L.)**
*Dependency on data, not on code.* Its own feasibility assessment recommends waiting until several
weeks of `first_reported_at` exist so the central number is measured rather than inferred, and warns
against adding a fourth consumer to a state model mid-rewrite. Steps 3 and 4 start that clock; this is
the payoff, not the next task.

**Not sequenced here:** the uncovered-vehicles action list (excluded at your instruction), and #219 —
the one reconciliation figure never explained, which remains an open question rather than a work item.
