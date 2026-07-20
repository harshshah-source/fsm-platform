# 131 — #130 build-health UI parity: recompute history table + dispatch-run-detail stale-build badge

Status: DONE (2026-07-20)
Type: AFK

> Fast-follow to [#130](./130-stale-code-write-guard.md) Slice 2 (L3 attribution + L5 canary, backend
> + API landed 2026-07-20). The API surface is ready; this issue is display-only. Split out per the
> operator-approved plan for Slice 2: build the OpsHead build-health alert into the already-clean
> global banner now, defer the pieces that would require editing files entangled in an unrelated
> uncommitted working-tree state (not an external-integration blocker — see below).

## Problem (one paragraph)

#130 Slice 2 gives every pipeline run (`master_sync_runs`, `snapshot_runs`, `dispatch_runs`) a
`build_version`/`build_fingerprint` stamp and appends a `device_state_recomputes` ledger row (counts +
build + trigger) on every recompute, with a semantic-canary swing flag (>5% eligible-count change,
either direction). `GET /api/integration/health` already returns all of this: `runtimeLock`,
per-freshness `build` stamps (`staleBuild` flag), and `recomputes` (last-10, newest-first, each with
`swing`/`swingPct`/`staleBuild`). A minimal OpsHead alert (`BuildHealthNotice`, riding the global
`SnapshotBanner`) landed in Slice 2 and warns when either signal fires. Two richer surfaces from the
design remain unbuilt: the **last-N recompute history table** (counts, build, swing highlighted) on
an integration-health page, and the **dispatch-run-detail stale-build badge** (a run whose
`build_version < runtime_lock.version` should render "ran under build v_x_, current v_y_" on the run
detail view). Neither view exists as a routable page yet in a state safe to edit.

## Why this is deferred here, not built in-slice (verified 2026-07-20)

- **No integration-health page exists in the admin app at all** — `/api/integration/health` had no
  consumer prior to this issue; there is no routed page to add the history table to without also
  building page scaffolding + routing.
- **The natural insertion points are all uncommitted, unrelated, in-flight work** (verified via
  `git status`): `AppRoutes.tsx` (routing), `OpsHeadDashboard.tsx`, and the entire dispatch-run-detail
  backend surface (`dispatch-transparency-query.service.ts`, `dispatch-runs.controller.ts`,
  `DispatchBatchDetailPage.tsx`, `DispatchZoneDetailPage.tsx`) are all modified-but-uncommitted from a
  prior session (single bulk-restore signature, 2026-07-17 mtime across ~40 files — not part of #130).
  Editing them here would entangle this issue's commit with that unrelated WIP.
- This is **not** the CLAUDE.md "no app shell yet" carve-out (which is a backlog-ownership escalation,
  not a valid deferral reason) — the app shell exists and is routable; the blocker is a specific,
  identifiable uncommitted-file collision that the operator chose to route around rather than resolve
  inline. Once that working tree is triaged (commit/stash/discard — a separate, operator-owned
  decision), this issue is unblocked with no new investigation needed.

## What's already in place (no backend build needed)

- `GET /api/integration/health` → `IntegrationHealth`:
  - `runtimeLock: { version, fingerprint }` — current build high-water mark.
  - `masterSync.build` / `snapshot.build`: `{ buildVersion, buildFingerprint, staleBuild }`.
  - `recomputes: RecomputeLedgerEntry[]` — last 10, newest-first: `recomputeId`, `computedAt`,
    `eligibleCount`/`inactiveCount`/`departedCount`/`totalCount`, `buildVersion`/`buildFingerprint`,
    `trigger`, `staleBuild`, `swingPct`, `swing`.
- Admin typed client: `apps/admin/src/api/integrationHealth.ts` (`apiIntegrationHealth()`).
- A minimal OpsHead-gated alert already renders on the global banner:
  `apps/admin/src/components/BuildHealthNotice.tsx` — warns on `staleRun || swung`, silent otherwise,
  never renders for a non-OpsHead role. Covered by `apps/admin/test/build-health-notice.test.tsx`.
- Dispatch run row (`dispatch_runs`) already carries `buildVersion`/`buildFingerprint` — the detail
  page badge is a pure read + conditional render once its file is safe to touch.

## Acceptance criteria

- [x] An OpsHead-only **integration-health page** (routed, nav entry) renders the **last-N recompute
      history** as a table: computed-at, counts (eligible/inactive/departed/total), trigger, build
      fingerprint, and the swing delta — rows with `swing: true` visually highlighted (the operator
      should be able to spot the run-65-shaped anomaly at a glance). _(`BuildHealthPage.tsx`, routed
      at `/build-health`, "Admin" nav group, `DataTable` `rowActive`+`activeVariant="danger"` for
      swing rows.)_
  - Also show `runtimeLock` (current build version/fingerprint) and the master-sync/snapshot
    `build.staleBuild` flags inline (superset of what `BuildHealthNotice` already summarizes). _(done)_
- [x] **Dispatch run detail** renders a stale-build badge ("ran under build v_x_, current v_y_") when
      `run.buildVersion < runtimeLock.version`. Requires `dispatch-transparency-query.service.ts` (or
      its successor once the 07-17 WIP is resolved) to select `buildVersion`/`buildFingerprint` on the
      run-detail read, and the FE run-detail page/component to render the badge. _(new
      `runBuildStamp()` private method on `DispatchTransparencyQueryService.getRunDetail` — the row
      was already fetched via `include`, just not surfaced; FE badge on `DispatchRunDetailPage.tsx`.)_
- [x] `BuildHealthNotice` (already shipped) either stays as the summary alert or is superseded by a
      link into the new integration-health page — operator's call at build time, not a re-litigation
      of the Slice 2 decision. _(Kept as the alert; added a "View details →" link into
      `/build-health`.)_
- [x] New tests only (backend read enrichment if the query needs a new field selected; FE page +
      badge render). No changes to `runtime_lock`, `device_state_recomputes`, or the health-service
      logic — this issue is display-only, per the #130 Slice 2 boundary. _(Confirmed — no edits to
      either table or to `health.service.ts`; `BuildHealthPage.tsx` reads the existing
      `apiIntegrationHealth()` client unchanged.)_

## Build summary (2026-07-20)

3 new files (`BuildHealthPage.tsx`, `build-health-page.test.tsx`,
`dispatch-run-detail-build-stamp.e2e-spec.ts`), 6 modified (`AppRoutes.tsx`, `nav.ts`,
`BuildHealthNotice.tsx`, `dispatch-runs.ts` API client, `DispatchRunDetailPage.tsx`,
`dispatch-transparency-query.service.ts`). 12 new tests green (3 backend build-stamp, 5 FE badge/nav,
4 FE page); wider regression sweep 48/48 green (23 admin + 25 backend); both apps `tsc --noEmit`
clean. No new backend computation — both surfaces read data #130 Slice 2 already produces.

## Non-goals

- No new backend computation — `IntegrationHealth` already carries every field this issue's UI needs.
- No change to the canary threshold, the L1/L4 boot guards, or L2 (Slice 3, separately in-flight).
