# 277 — Assign Work Console S5: absorb the orphaned manual-assignment surfaces

Status: done (2026-08-24) — see `docs/progress/277-absorb-orphaned-assignment-surfaces.md`
Type: AFK · Backend + Admin
Decision: #272 **R1** (the console is the single manual-assignment surface)

## Objective

The three manual-assignment surfaces that are built but unreachable become reachable — inside the
console where they belong — instead of being left dead or rebuilt from scratch beside it.

## Current behaviour (verified)

Three separate dead ends, each with working code behind it:

1. **`dashboard/CriticalQueue.tsx` is orphaned** — imported by no file (grepped across
   `apps/admin/src`; `dashboard.ts`, `ManagerDashboard.tsx`, `ZmDashboard.tsx` and
   `EscalationQueueList.tsx` reference the *type* `CriticalQueueGroup`, not the component). It
   already contains a working engineer picker, cluster one-click assign via `apiAssignTicket`, and
   the `#249` `DeferralConfirm` flow.
2. **The intra-day manual-assign path has no admin client at all.**
   `intraday-insertion.controller.ts:93` `GET :id/available-ses` and `:99` `POST :id/manual-assign`
   are implemented, `Roles(...MANAGER_ROLES)`-gated and tested; nothing in `apps/admin/src` calls
   either (grepped). `availableSesForManualAssign` returns `string[]` — **bare UUIDs**, with no name,
   coverage, load or availability, so even a modal built on it today would show unidentifiable rows.
   `IntradayQueuePage` is read-only.
3. **`planner/PlannerPage.tsx:196`** renders `eng.engineerId` — a raw UUID — in the Engineer column,
   where `v2-reference/16-se-planner.png` shows the engineer's name, zone and availability.
   `ZoneEngineer.name` is already in the payload (`api/schedules.ts:81-89`) and already used by every
   other picker.

## Required change

1. **`CriticalQueue` → the console's Critical+ preset.** Retire the standalone component's dead
   duplicate flow: the console's Critical+ filter chip, plant grouping and cluster-size signal cover
   it, and commit goes through #275. Preserve what the component uniquely carries — the plant-cluster
   size badge and the `DeferralConfirm` wiring — into the console rather than deleting them with the
   file. Keep the `critical-group` test id or replace its coverage explicitly; do not silently drop a
   tested behaviour.
2. **Give `available-ses` the candidate row shape.** Return #274's candidate row
   (`{seId, name, coverageType, verdict, dropReason, committed, dailyCapacity, availabilityStatus,
   kitComplete}`) instead of `string[]`. Same source — `availableCandidates` already resolves the
   plant's candidates; it is the projection to `string[]` that throws the information away.
3. **Build the intra-day manual-assign modal** on the Intra-day Queue, on top of (2): pick an
   engineer from a list that identifies them, assign, refetch. This is the Issue 30 UI that was
   specified and never built. It stays on `/intraday` — it acts on one escalated insertion in
   context, which is not what the console is for.
4. **`PlannerPage` Engineer column shows the name**, falling back to the id only when `name` is null.
   The `LOAD / CAP` column that reference 16 also specifies is **#269's**, not this issue's — do not
   build a second capacity figure here.

## Existing code to reuse

`CriticalQueue`'s `AssignControl` + cluster badge + `DeferralConfirm` wiring · `availableCandidates`
(`intraday-insertion.service.ts`) · #274's candidate row shape and its backend assembly ·
`IntradayQueuePage`'s table and `intradayUpdates.ts` client · `formatPlantDisplayName`.

## Data model / API

No schema change. One response-shape change (`available-ses`, `string[]` → row objects — a breaking
change to an endpoint with **zero** clients, verified). No new write.

## UI surfaces

Admin: `/assign` Critical+ preset; `/intraday` manual-assign modal; `/planner` Engineer column.
Mobile: none.

## Reference

`docs/ui/desktop/approved-designs/assign-work-console.html` (Critical+ preset chip) ·
`docs/ui/desktop/v2-reference/13-intraday-queue.png` (the modal's host page) ·
`docs/ui/desktop/v2-reference/16-se-planner.png` (Engineer column: name, zone, availability).

## Acceptance criteria

- [x] No component in `apps/admin/src` is imported by nothing (sweep test or documented exception) —
      `CriticalQueue`'s state is resolved, not left ambiguous.
- [x] The plant-cluster size signal and the deferral-confirm flow are reachable in the console; the
      behaviours `CriticalQueue`'s tests covered are still covered somewhere.
- [x] `GET /intraday-insertions/:id/available-ses` returns rows carrying at minimum `seId`, `name`,
      `coverageType`, `committed`, `dailyCapacity`; the candidate set is unchanged from today's
      `string[]` for the same insertion (set-equality pin).
- [x] The Intra-day Queue offers manual assignment on an escalated insertion; assigning calls
      `POST :id/manual-assign` and the row reflects the new state after refetch.
- [x] The manual-assign modal never shows a bare UUID.
- [x] `PlannerPage` shows engineer names; a null name falls back to the id and does not crash.
- [x] No second capacity counter was introduced anywhere in this issue (#269 owns it).

## Tests

Backend: `available-ses` shape + candidate-set equality with the previous implementation; existing
`manual-assign` e2e still green. Admin: intra-day modal (list renders names, assign posts, refetch),
planner name rendering + null fallback, console Critical+ preset, orphan sweep.

## Dependencies / Blocked by

- **#274** — the candidate row shape this reuses; building it here first would define it twice.
- **#275** — the console commit path the Critical+ preset assigns through.
- **#272 open question 1** — whether the Device Detail `AssignSePanel` stays as a deep-link shortcut
  or is retired. Answer before deciding what else this issue absorbs.
- **#268** — retires the acceptance lifecycle on the CRITICAL path but **keeps
  `ESCALATION_REQUIRED`**; the intra-day modal acts on escalated insertions, so land after #268 or
  confirm the insertion states this modal targets still exist.

## Risks

Low–medium. The `available-ses` shape change is breaking in principle and inert in fact (no clients);
the set-equality pin is what proves it. The real risk is deleting `CriticalQueue.tsx` and its tested
behaviour together — hence the first two ACs.

## Rollback

Each of the three parts is independent and independently revertible.
