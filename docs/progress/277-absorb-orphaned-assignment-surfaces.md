# #277 — Assign Work Console S5: absorb the orphaned manual-assignment surfaces (TDD completion report)

**Date:** 2026-08-24 · **Branch:** `feat/autoplant-integration` · **Type:** AFK · Backend + Admin
**Issue:** [`.scratch/fsm-platform-v1/issues/277-absorb-orphaned-assignment-surfaces.md`](../../.scratch/fsm-platform-v1/issues/277-absorb-orphaned-assignment-surfaces.md)
**Sequenced as:** P9 slice 6 of 6 (final), behind #274 ✅ · #275 ✅ · #268 ✅.

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## The dependency that turned out not to gate anything

The issue lists `#272 open question 1` ("does the console replace the Device Detail panel, or stay a
deep-link shortcut?") as a dependency: "Answer before deciding what else this issue absorbed." Checked
before writing code — the issue's own **Required change** section (the four numbered items actually
scoping this slice) never touches `AssignSePanel` or the Device Detail panel at all; the dependency note
was a caution to re-check scope, not a blocker on the three dead ends actually named. No business-rule
decision was needed to proceed, so none was escalated. Question 1 remains open in #272 for whoever
eventually revisits that panel.

## Three independent absorptions, taken one at a time

### 1. `available-ses`' bare-UUID row shape → #274's candidate row

`IntradayInsertionService.availableSesForManualAssign` gained a `CandidateQueryService` dependency
(injected via a Nest-resolvable default parameter — the same pattern `availability`/`audit` already used
in this constructor — so the DI-mock-provider trap this file's own comments say was hit five times
before did not need a sixth: `intraday-critical-insertion.e2e-spec.ts` still constructs the service with
its original six positional args and the new one resolves by default). The method now calls
`candidateQuery.listForPlants([plantId], scope)` and filters to `availabilityStatus === 'AVAILABLE'` —
**not** to the hard-filter `verdict`, which is the one detail that would have silently narrowed the set:
the old `availableCandidates` helper only ever checked live availability, never capacity or kit (Q2 —
manual escalation resolution is an administrative override), so filtering on `verdict === 'PASSED'`
instead would have dropped over-capacity and kit-short SEs the pre-#277 endpoint always offered. The
now-dead `availableCandidates` private method was deleted rather than left unreachable.

The controller gained `@CurrentUser()` to forward `{ role, zoneId }` — the endpoint had never been
zone-scoped before because `string[]` carried no zone-sensitive fields to leak; the candidate row does.

**Set-equality pin:** `test/available-ses-candidate-shape.e2e-spec.ts` constructs one AVAILABLE SE, one
`SOFT_UNAVAILABLE` SE, and one `dailyCapacity: 0` (over-capacity) SE, and asserts the returned set is
exactly `{available, over-capacity}` — proving the over-capacity SE survives the shape change exactly as
Q2 requires.

### 2. The intra-day manual-assign modal — the admin client that never existed

`api/intradayInsertions.ts` gained `apiAvailableSes` and `apiManualAssign`, the latter reusing
`DeferralConflictError`/`DeferralConflict` from `api/schedules.ts` verbatim rather than re-declaring the
409 shape a third time. `IntradayManualAssignModal.tsx` is new: a list of #274's candidate rows (name,
coverage badge, load badge, per-row Assign), wired into `IntradayQueuePage` behind an Assign button that
appears only on an `ESCALATION_REQUIRED` row. A held ticket's 409 opens the same `DeferralConfirm` every
other manual-assign surface already uses — nothing new was built for that path, only reached.

### 3. `CriticalQueue` → the console's Critical+ preset

Retired outright (`git rm`), not left beside the console as a second surface — `#272 R1` ("the console
is the single manual-assignment surface") and the issue's own "commit goes through #275" both point the
same way: `CriticalQueue`'s one-click *immediate* write (`POST /schedules/assign` on click, no preview)
is the exact N→1 pattern #272 R2 replaced project-wide, not a behaviour worth preserving unchanged.

What the issue says must survive is narrower than "the component": the **cluster-size badge** and the
**deferral-confirm wiring**. Both already had a home:

- The console's pool already renders `criticalCount` per plant (`<Badge tone="critical">{n} crit</Badge>`)
  — the same signal `CriticalQueue`'s `Cluster: {clusterSize}` badge carried, one plant-scoped count
  either way. What was missing was a way to *narrow* the pool to it, so a **Critical+ filter chip** was
  added (`filter-critical-plus`, `aria-pressed`) — the literal chip the approved design already draws
  (`approved-designs/assign-work-console.html:949`, `<span class="fchip on">Critical+</span>`).
- The deferral-confirm flow was *already* reachable in the console before this issue — `#275`'s
  `ReviewCommitScreen` "Resolve hold" action wires the identical `DeferralConfirm` component
  (`assign-console.test.tsx`, "offers the existing confirm flow to resolve a deferred ticket the batch
  skipped"). This issue added a second live host for it (the intraday modal, above) but did not need to
  build the mechanic itself.

**Five test files rendered `CriticalQueue` directly** and needed a real decision each, not a blanket
delete:

| File | What it pinned | Disposition |
|---|---|---|
| `critical-assign.test.tsx` | The one-click immediate-write flow itself | Deleted — the flow it tested is retired by design, not relocated |
| `dashboard-critical-action.test.tsx` | Cluster grouping display + an unrelated `ActionRequiredPanel` suite | `CriticalQueue` describe block removed; `ActionRequiredPanel` block untouched |
| `deferral-override-confirm.test.tsx` | `DeferralConfirm`'s banner/reason/confirm/cancel mechanics | Rewritten to render `DeferralConfirm` directly — it now has three live hosts (`ReviewCommitScreen`, `IntradayManualAssignModal`, and formerly `CriticalQueue`), so pinning the behaviour against the shared component survives any one host changing |
| `capacity-overload-visibility.test.tsx` | `engineerOptionLabel`'s text format + never-gated selectability | The `<option>`-picker describe block replaced with a direct unit test of `engineerOptionLabel` (the pure helper every picker shares); never-gated selectability is independently proven by the console's own `assign-console.test.tsx` over-capacity-commit test |
| `duration-badge.test.tsx` | `DurationBadge` (own suite, untouched) + a redundant integration check that `CriticalQueue` wired it correctly | Only the redundant integration describe removed — `DurationBadge` itself is not console-rendered (the pool is plant-level, not per-ticket) |

New: **`orphan-component-sweep.test.ts`** — the AC's "sweep test or documented exception" taken literally.
A per-file heuristic (does any *other* `src` file import this file's basename) with two pre-existing,
out-of-scope exceptions (`ZoneOperatingModeCard`/`Table`, committed under #136, unrelated to this issue)
and a second assertion pinning `CriticalQueue.tsx` specifically gone. This is a regression guard for the
next orphan, not only a check on this one.

### `PlannerPage` — the smallest of the three

`eng.name ?? eng.engineerId` replaces the raw `{eng.engineerId}` cell. One new test
(`planner-grid.test.tsx`) pins the name showing and the null fallback separately from the existing
fixture (which has no `name` field and would have masked a regression either way).

## Verification

- Backend: full suite, 4 foreground chunks — **418 files / 2120 tests (5 pre-existing env-gated skips),
  0 failed** (one `dispatch-run-tier-override-snapshot.e2e-spec.ts` `afterAll` FK-cleanup-ordering flake
  under parallel execution — passes clean in isolation on re-run, unrelated to anything touched this
  session; one `#184` Windows worker-crash flake, self-recovered on retry — both pre-existing, documented
  patterns, not regressions). New: `test/available-ses-candidate-shape.e2e-spec.ts` (3 tests — row shape,
  set-equality pin, empty plant).
- Admin: full suite — **106 files / 568 tests, 0 failed** (the same pre-existing unrelated
  `TicketDetailDrawer.tsx:440` runtime fault every recent handoff reports). New/changed:
  `orphan-component-sweep.test.ts` (2), `intraday-queue.test.tsx` +3 (modal identifies candidates,
  refetch reflects the new state, deferral hold resolves inline), `assign-console.test.tsx` +1
  (Critical+ chip narrows and un-narrows the pool), `planner-grid.test.tsx` +1 (name + null fallback),
  `deferral-override-confirm.test.tsx` rewritten (4 tests, now against `DeferralConfirm` directly),
  `capacity-overload-visibility.test.tsx` -2/+3 (CriticalQueue picker block → `engineerOptionLabel` unit
  tests), `dashboard-critical-action.test.tsx` -1 describe, `duration-badge.test.tsx` -1 describe,
  `critical-assign.test.tsx` deleted.
- `tsc --noEmit` clean on both `apps/backend` and `apps/admin`.
- No schema change, no new migration, no second capacity counter.

## What's next

**P9 is 6 of 6 done.** #272–#277 — the entire Assign Work Console — is closed: the console is now the
single manual-assignment surface (#272 R1) with no dead sibling left importing nothing. Check
`.scratch/fsm-platform-v1/INDEX.md`'s "Next-up" ordering for whatever P10 (or the backlog's next
priority) is at this point.
