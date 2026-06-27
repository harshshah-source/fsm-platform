# 75 — Recommender PREVENTIVE mode: Install backlog into the candidate set

Status: done
Type: AFK

## Context

Issue 72 implemented PREVENTIVE-mode re-prioritisation for the **TROUBLESHOOT** candidates the
Recommender already ranks — repeat-offenders and aged devices are biased up via a `<base>_preventive`
weight set (DEFICIT unchanged). CONTEXT §5 names a **third** PREVENTIVE signal: **Install backlog**.

The recommender run is currently TROUBLESHOOT-only (`RecommenderService.runForZone` filters
`workType: 'TROUBLESHOOT'`). Bringing INSTALL tickets into the candidate set is a candidate-selection
change — not a scoring tweak — so it was split out of #72 (scoping decision confirmed with the user
2026-06-27).

## What to build

In PREVENTIVE mode, include open INSTALL-work-type tickets in the recommender candidate set so the
Install backlog competes in the day plan, biased up alongside repeat-offenders / aged devices.

- Decide the candidate query change: INSTALL tickets have their own lifecycle (#33/#34) and no Failure
  Cycle / SLA bucket — define how they slot into the canonical sort (they have no `deviceBucket`).
- Reconcile with auto-dispatch (#11) and the install lifecycle (schedule/on-site/activation in #34) so an
  install isn't double-scheduled.
- Capacity accounting: an INSTALL stop consumes SE capacity like a troubleshoot stop.
- Keep DEFICIT mode TROUBLESHOOT-only (today's behaviour).
- Stamp the install candidacy in `scoreBreakdown` for explainability.

## Acceptance criteria

- [x] PREVENTIVE mode includes open INSTALL tickets in the recommender candidate set
- [x] INSTALL candidates slot into the canonical sort coherently (no deviceBucket) *(processed after troubleshoot via `installSort`)*
- [x] No double-scheduling vs the install lifecycle (#34) / auto-dispatch (#11) *(recommender suggests only; ZM override = the human step)*
- [x] DEFICIT mode remains TROUBLESHOOT-only
- [x] Install candidacy reflected in `scoreBreakdown` *(null deviceBucket + `weightSetRef = <base>_preventive`)*

## Blocked by

- #72 (done)
- #10, #11, #33, #34

## Disposition

**Done (2026-06-27).** 7 e2e (4 `installSort` unit + 3 run), recommender regression suites green,
`tsc` clean, full suite **183 files / 637 passed**. Ordering decision confirmed with the user: **Option 1
— TROUBLESHOOT first, then Install backlog** (installs fill remaining SE capacity); the recommendation
stays advisory — the existing ZM override path (#13) is the human approval/reorder step, so **no manual
reordering was added** here.

- **`canonical-sort.ts`** — `InstallCandidate` + `installSort` (+ `compareInstallCandidates`): Company Tier
  desc → Priority Rank asc → oldest backlog (`installTargetDate`/createdAt) → ticketId. Installs never enter
  the ADR-0017 comparator (no SLA bucket); the troubleshoot/DEFICIT path is byte-identical.
- **`RecommenderService.runForZone`** — builds a unified `RunCandidate[]` = canonical-sorted TROUBLESHOOT
  followed, **in PREVENTIVE only**, by `installBacklog(zoneId)` (open INSTALL: `REQUESTED` +
  `UNASSIGNED`). Install candidates carry a null `deviceBucket` (→ zero dispatch urgency) and use their
  backlog target date as the `ageAnchor` feeding the PREVENTIVE aged-bias term, so older backlog ranks
  higher. Scored with the `<base>_preventive` weight set; the `Recommendation` row stores `deviceBucket =
  null`. Capacity/cluster/SE-selection reuse the existing loop.
- **No double-scheduling:** the recommender only writes a `Recommendation` (suggestion); committing to a
  day plan is dispatch (#11), and the `REQUESTED`/`UNASSIGNED` filter skips anything the install lifecycle
  (#34) already advanced.
- **DEFICIT untouched** — install backlog is appended only when `mode === 'PREVENTIVE'`.
