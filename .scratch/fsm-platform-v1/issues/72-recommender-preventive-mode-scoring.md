# 72 — Recommender preventive-mode scoring re-prioritisation

Status: ready-for-agent
Type: AFK
Origin: Issue 40 follow-up (2026-06-26).

## What to build

Issue 40 made the Soft Inactive Count drive the Recommender's **mode** (`RunSummary.mode` +
`scoreBreakdown.mode`, switched DEFICIT/PREVENTIVE off the count vs the 2% threshold). The current
scoring is the deficit-style behaviour (devices-cleared-per-SE-day with plant clustering). This issue
implements the distinct **preventive-mode** prioritisation (CONTEXT §5/§196): when a zone is in
PREVENTIVE mode, the planner shifts toward **repeat-offenders, aged devices, and Install backlog**
instead of raw clustering.

- In `RecommenderService.runForZone`, branch the scoring/sort weights on `mode`: PREVENTIVE biases
  `repeatFailure`, device age, and INSTALL work-type tickets up; DEFICIT keeps today's behaviour.
- Keep the mode signal + breakdown stamping from Issue 40 unchanged; this only changes ranking when
  `mode === 'PREVENTIVE'`.

## Acceptance criteria

- [ ] PREVENTIVE mode re-prioritises repeat-offenders / aged devices / Install backlog over pure clustering
- [ ] DEFICIT mode behaviour unchanged from Issue 10/40
- [ ] Mode-driven ranking is reflected in `scoreBreakdown` for explainability

## Blocked by

- #40 (done)
- #10
