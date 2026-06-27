# 75 — Recommender PREVENTIVE mode: Install backlog into the candidate set

Status: ready-for-agent
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

- [ ] PREVENTIVE mode includes open INSTALL tickets in the recommender candidate set
- [ ] INSTALL candidates slot into the canonical sort coherently (no deviceBucket)
- [ ] No double-scheduling vs the install lifecycle (#34) / auto-dispatch (#11)
- [ ] DEFICIT mode remains TROUBLESHOOT-only
- [ ] Install candidacy reflected in `scoreBreakdown`

## Blocked by

- #72 (done)
- #10, #11, #33, #34
