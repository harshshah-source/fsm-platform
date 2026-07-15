# 124 — Capture effective config (not just DB-overridden) in dispatch_runs.config_snapshot
Status: ready-for-agent
Type: AFK

> Source: #123 Batch-Assignment transparency contract-map session (2026-07-15). Building the
> config-in-effect panel exposed the gap.

## Problem

`captureConfigSnapshot()` (dispatch-run.service.ts, landed in #123 slice 2) records only the
config that is **overridden in the DB**:
- `priorityRules` comes from active `priority_rule_config` rows — **empty** when the recommender
  ran on the code-default weight set (`DEFAULT_WEIGHT_SET`);
- `settings.plant_cluster_multiplier` / `settings.eligibility_mode` are captured only if a
  `system_setting` row exists — **absent** when the code default (`DEFAULT_CLUSTER_MULTIPLIER = 1.25`,
  the default eligibility mode) applied.

So a run driven entirely by code defaults records a snapshot that can't answer "what weighting/
clustering/eligibility actually applied?" — the transparency panel then renders
**"Default weighting (not overridden)"** instead of the real numbers.

## What to build

Extend `captureConfigSnapshot()` to record the **effective** config: merge DB overrides over the
code defaults so the snapshot is self-describing regardless of whether a DB row existed.
- weights: fall back to `DEFAULT_WEIGHT_SET` components/weights when no active `priority_rule_config`
  rows exist (and mark the source, e.g. `weightsSource: 'DB' | 'CODE_DEFAULT'`);
- `plant_cluster_multiplier`: fall back to `DEFAULT_CLUSTER_MULTIPLIER`;
- `eligibility_mode`: fall back to the code default.
Keep the shape backward-compatible (the FE already reads `priorityRules` / `settings`).

## Acceptance criteria

- [ ] A run with no DB `priority_rule_config` / `system_setting` rows records real weight/cluster/
      eligibility values (from code defaults) in `config_snapshot`, not empty.
- [ ] Snapshot marks the source (DB override vs code default) so the panel can label it honestly.
- [ ] Existing #123 slice-2 byte-identical dispatch e2e stays green (observe-only; no selection change).
- [ ] From-zero migrate + transparency e2e green.

## Constraints / notes

- **Cannot be retrofitted.** Only affects runs recorded *after* this lands; already-recorded runs keep
  their partial snapshots. The FE shows "Default (not overridden)" for those.
- **Must land before `BUSINESS_SWEEPS_ENABLED` is turned on in production** — otherwise the first real
  production dispatch history is recorded with un-interpretable config, defeating the transparency
  feature's purpose. This is the gating reason it sits in Next-up rather than the general backlog.

## UI surfaces
n/a directly — feeds the #123 config-in-effect panel (which renders the fallback label until this lands).

## Blocked by
None. Touches the #123 slice-2 write path (`captureConfigSnapshot`) only.
