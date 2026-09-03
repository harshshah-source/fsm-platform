# Parallel lanes — module-gaps backlog (#337, #342–#366)

Derived from `IMPLEMENTATION-PLAN.md`, a file-ownership pass over the issue files, and a
path-existence check against the working tree (2026-09-03). Lane boundaries are **file
ownership**, not the plan's wave numbers — §5's "file-disjoint within a wave" does not hold
(see "Cross-lane hazards").

**These are completion slices on shipped modules, not greenfield.** Every backend module and
admin page these issues name already exists; the only paths below that do not yet exist are the
admin audit API client and viewer page #342 creates. Read the current file before planning any
slice — the line numbers quoted in the issue files were taken at filing time and #341 has since
moved code in 20 controllers and every `apps/admin/src/api/*` client.

**Done and excluded from every lane:** #336, #338, #339, #340, #341. Verified against INDEX.md,
`docs/progress/` and `git log` — the other 26 (#337, #342–#366) have no report and no commit.

## Pre-flight (blocks every lane)

`#341` is code-complete but **uncommitted**, inside a 383-file dirty tree. No lane may start
until that tree is committed — parallel sessions share one checkout, and `git worktree` will
not carry uncommitted state into a second one.

```
git status --porcelain | wc -l     # must be 0 before fanning out
```

Then one worktree per lane, all branched off the commit that lands #341:

```
git worktree add ../fsm-lane1 -b feat/lane1-notifications
git worktree add ../fsm-lane2 -b feat/lane2-audit
git worktree add ../fsm-lane3 -b feat/lane3-reports
```

## The three lanes

| lane | branch | chain | owns |
|---|---|---|---|
| 1 · notifications & ingestion | `feat/lane1-notifications` | #337 → #348 → #349 → #361 | `notifications/**`, `ingestion/**` (incl. `ingestion/snapshots.controller.ts`), `SnapshotBanner.tsx`, `IntegrationHealth*` |
| 2 · audit & SE contract | `feat/lane2-audit` | #342 → #343 → #363, then #360 → #345 | `backend/src/audit/**`, `engineers/leave-*`, `me-tickets/**`, `day-plan-notifier.ts`, `day-plan-notification-outbox.ts`, plus the admin audit client + page it creates |
| 3 · reports & dashboards | `feat/lane3-reports` | #346 → #347 → #364, then #350 → #351 | `reports/**`, `api/reports.ts`, `pages/reports/**`, `dashboard.service.ts`, `*Dashboard.tsx`, `ActionRequiredPanel.tsx`, `AttentionBand.tsx` |

Later, once these drain, five independent chains fan out as wide as you have sessions:
`#354 → #355` · `#352 → #353 → #366` · `#357 → #358` · `#359` · `#344` · `#356` · `#362` · `#365`.

## Cross-lane hazards (encoded in the prompts below)

1. **`snapshots.controller.ts`** — #348 (lane 1, role widen) ⨯ #343 (lane 2, audit writer).
   **Lane 1 owns it.** Lane 2 leaves the snapshot-export audit site to a follow-up line in INDEX.
2. **`notification.service.ts`** — #337 rewrites the per-channel delivery contract (`:168-175`).
   **Lane 1 owns it.** Later #354/#356 write against whatever #337 lands.
3. **`day-plan-notifier.ts` / `day-plan-notification-outbox.ts`** — #360 replaces the whole
   action→sentence map; #345 adds one action to it. **#360 before #345**, both inside lane 2.
4. **`ingestion/ingestion-alert.ts`** — #348 adds the overdue detector, #361 hangs the OH notice
   off it. Same lane, in order. Undeclared in the plan.
5. **`ManagerDashboard.tsx` / `CentralDashboard.tsx`** — #346, #350 and #351 all touch them.
   All three sit in lane 3, sequential. Never split them across lanes.
6. **`dataset-registry.ts`** — #342 and #343, both lane 2, in order.
7. **`apps/backend/src/audit/` is not greenfield.** `audit.service.ts`, `audit-trail.service.ts`
   and `audit-trail.controller.ts` already exist; the controller today serves exactly one route,
   `GET /api/audit-trail/tickets/:ticketId`, manager-roles-only and ZM-zone-scoped. #342 adds
   ledger-wide search and the admin surface **on top of that**; #343 adds writers through the
   existing `audit.service.ts`. Read both files before planning either slice.
8. **`schema.prisma` is edited by all three lanes** — #337 (`device_tokens`, ~:225),
   #342 (`audit_logs`, ~:1733), #348 (`SnapshotRun`), #347 (the four report cubes, ~:2689-2807)
   and #351 (~:2651). Distinct models, hundreds of lines apart, so git merges them cleanly.
   The rule that keeps it that way: **append fields to your own model, never reformat the file.**
9. **`dashboard.service.ts` in #361 is a false positive.** A basename scan pairs #361 with
   #350/#351 here, but #361 only *cites* `:976-995` as evidence the `waiting_component_overdue`
   surfacing already exists — it adds the push notice elsewhere and does not edit this file.
   #350/#351 work at `:192`, `:411-460`, `:851`, `:883-901`. No lane conflict.
10. **Migrations** — #348 (`SnapshotRun.error`) and later #357/#366. Not a code conflict, but
   concurrent lanes emit out-of-order migration timestamps: whoever merges second renames their
   migration folder and re-runs `prisma migrate dev` against a fresh shadow DB.

---

## Paste-ready session prompts

Each is self-sufficient: open a session in that lane's worktree and paste it whole.

### Lane 1

```
You are lane 1 of a 3-lane parallel build of the module-gaps backlog. Worktree
../fsm-lane1, branch feat/lane1-notifications. Two other sessions are building lanes 2
and 3 on the same base commit right now.

Read in order: CLAUDE.md, docs/SYSTEM-STATE-2026-07.md, docs/module-gaps/IMPLEMENTATION-PLAN.md,
docs/module-gaps/PARALLEL-LANES.md, .scratch/fsm-platform-v1/INDEX.md, then the issue file.

Build, in this order, one slice at a time, each via the /tdd red-green-refactor protocol:
  #337 push delivery exit / FCM gateway
  #348 ingestion silence, reaped reason, role-safe freshness
  #349 integration-health page completion
  #361 notification producers for the PRD events

Your file fence — you own, and no other lane will touch:
  apps/backend/src/notifications/**, the FCM gateway and notification-seam,
  apps/backend/src/ingestion/**  (including ingestion-alert.ts),
  (snapshots.controller.ts lives at apps/backend/src/ingestion/snapshots.controller.ts —
   it is inside your fence, and lane 2 defers to you on it),
  apps/admin/src/components/SnapshotBanner.tsx, apps/admin/src/pages/**/IntegrationHealth*.

Out of fence, hard stop: reports.service.ts, dashboard.service.ts, any *Dashboard.tsx,
backend/src/audit/**, day-plan-notifier.ts, day-plan-notification-outbox.ts, me-tickets/**,
engineers/leave-*. If a slice genuinely needs one of those, do not edit it — stop, and
report which file and why.

#337 rewrites the per-channel delivery contract in notification.service.ts. That contract is
load-bearing for #354/#356 later, so write it as the interface you'd want them to code against,
and say in the TDD report what shape you landed on.

Rules: full-suite green before each commit; the surfacing rule and parity gate in CLAUDE.md
apply (UI ACs ship in the same slice or a follow-up issue is filed and linked in INDEX.md);
per-issue report to docs/progress/<issue>.md; update the issue Status line and append one
Session log row in .scratch/fsm-platform-v1/INDEX.md prefixed "lane 1 ·". Do not rebase or
merge the other lanes' branches. AFK by default — stop only for the Strategic HITL triggers.
```

### Lane 2

```
You are lane 2 of a 3-lane parallel build of the module-gaps backlog. Worktree
../fsm-lane2, branch feat/lane2-audit. Two other sessions are building lanes 1 and 3 on the
same base commit right now.

Read in order: CLAUDE.md, docs/SYSTEM-STATE-2026-07.md, docs/module-gaps/IMPLEMENTATION-PLAN.md,
docs/module-gaps/PARALLEL-LANES.md, .scratch/fsm-platform-v1/INDEX.md, then the issue file.

Build, in this order, one slice at a time, each via the /tdd red-green-refactor protocol:
  #342 audit ledger search + viewer   (land first so #343's writers are visible)
  #343 audit writers: leave, planner, ingestion, voucher, settings, VU
  #363 leave integrity: revoke, tiebreak, overlap
  #360 SE poll contract              (MUST precede #345 — it replaces the action→sentence map)
  #345 plant deactivation day-plan notice

Your file fence — you own, and no other lane will touch:
  apps/backend/src/audit/**  (audit.service.ts, audit-trail.service.ts,
  audit-trail.controller.ts — all three ALREADY EXIST, you are extending them),
  the admin audit API client and viewer page #342 creates,
  apps/backend/src/engineers/leave-*,
  apps/backend/src/me-tickets/**, apps/backend/src/scheduling/day-plan-notifier.ts and
  day-plan-notification-outbox.ts, apps/admin/src/pages/engineers/LeaveRequestsPage.tsx.

Out of fence, hard stop: all of ingestion/** (which contains snapshots.controller.ts) and notifications/**
(lane 1 owns them), reports.service.ts, dashboard.service.ts, any *Dashboard.tsx (lane 3).

#343 wants an audit writer on the snapshot export door, and that controller
(apps/backend/src/ingestion/snapshots.controller.ts) belongs to lane 1. Do not edit it. Build every other writer, then file a one-line follow-up issue for the
snapshot-export writer in .scratch/fsm-platform-v1/INDEX.md and link it from #343 — that is the
parity-gate-compliant deferral, and say so in the TDD report.

#360 and #345 both rewrite the day-plan notification vocabulary. #360 lands the whole map;
#345 then adds exactly one entry to the map #360 built. Never the other way round.

Rules: full-suite green before each commit; the surfacing rule and parity gate in CLAUDE.md
apply (UI ACs ship in the same slice or a follow-up issue is filed and linked in INDEX.md);
per-issue report to docs/progress/<issue>.md; update the issue Status line and append one
Session log row in .scratch/fsm-platform-v1/INDEX.md prefixed "lane 2 ·". Do not rebase or
merge the other lanes' branches. AFK by default — stop only for the Strategic HITL triggers.
```

### Lane 3

```
You are lane 3 of a 3-lane parallel build of the module-gaps backlog. Worktree
../fsm-lane3, branch feat/lane3-reports. Two other sessions are building lanes 1 and 2 on the
same base commit right now.

Read in order: CLAUDE.md, docs/SYSTEM-STATE-2026-07.md, docs/module-gaps/IMPLEMENTATION-PLAN.md,
docs/module-gaps/PARALLEL-LANES.md, .scratch/fsm-platform-v1/INDEX.md, then the issue file.

Build, in this order, one slice at a time, each via the /tdd red-green-refactor protocol:
  #346 fleet uptime honesty + cube coverage
  #347 report freshness stamps + auto-escalations cube
  #364 report pages consume the API
  #350 action-required truth and links
  #351 dashboard fidelity

Your file fence — you own, and no other lane will touch:
  apps/backend/src/reports/**, apps/backend/src/dashboard/**,
  apps/admin/src/api/reports.ts, apps/admin/src/api/dashboard.ts,
  apps/admin/src/pages/reports/**, apps/admin/src/pages/exports/ExportsPage.tsx,
  every *Dashboard.tsx, ActionRequiredPanel.tsx, AttentionBand.tsx, ZoneOverviewTable.tsx.

Out of fence, hard stop: notifications/**, ingestion/** incl. snapshots.controller.ts (lane 1),
backend/src/audit/**, leave-*, me-tickets/**, day-plan-notifier.ts (lane 2).

#346, #350 and #351 all edit ManagerDashboard.tsx and CentralDashboard.tsx, and #346/#347/#364
all edit ReportsPage.tsx and api/reports.ts. That is why they are one lane: strictly sequential,
never two of them in flight. #350 and #351 touch different functions of dashboard.service.ts
(#350 ≈ the action-required builder, #351 ≈ the zone/queue aggregates) — read the whole file
before each, don't assume the line numbers in the issue survived the previous slice.

Before any slice with UI acceptance criteria, follow the UI-discovery steps in
docs/agents/workflow.md against docs/ui/desktop/v2-reference/ then
docs/ui/desktop/approved-designs/. Match layout, hierarchy, role visibility, navigation;
do not redesign.

Rules: full-suite green before each commit; the surfacing rule and parity gate in CLAUDE.md
apply; per-issue report to docs/progress/<issue>.md; update the issue Status line and append
one Session log row in .scratch/fsm-platform-v1/INDEX.md prefixed "lane 3 ·". Do not rebase
or merge the other lanes' branches. AFK by default — stop only for the Strategic HITL triggers.
```

### Merge order back to `feat/autoplant-integration`

Lane 3 → lane 1 → lane 2. Lane 3 is the widest UI surface and merges cleanest first; lane 2
merges last because its INDEX.md and dataset-registry.ts edits are the most textually contended.
Each merge runs the full suite before the next lane merges. INDEX.md will conflict every time —
it is an append-only Session log, so keep all rows and order them by lane number.
