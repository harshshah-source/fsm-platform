# 204 — Implement the ruled time semantics: day boundary, dispatch clock, leave windows

Status: ready-for-agent — **blocked by [#198](./198-decision-day-boundary-and-dispatch-clock.md)**
Type: AFK · Backend + Admin
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04

## Root cause

See [#198](./198-decision-day-boundary-and-dispatch-clock.md). This issue is the implementation of
whatever it rules; it deliberately holds no opinion. The one thing that is *not* in question is that
the current state — three surfaces with three definitions of "today" and a cron whose real firing
hour depends on an unset environment variable — cannot be defended under any ruling.

## Findings closed

Audit 2: **A6** (cron TZ), **C7** (three definitions of today), **B8** (leave-window shift), **B7**
(admin date-render traps, latent).

## Evidence — verified 2026-08-04

- `apps/backend/src/common/utc-day.ts:9-11` is the single definition, consumed by ~15 services
  (enumerated on #198).
- `dispatch-scheduler.service.ts:50` — `@Cron` with no `timeZone`; `'0 5 * * *'` at `:10`; no `TZ=`
  in any compose/Dockerfile/env in the repo. `prisma.service.ts:46-52` pins the *DB session* to UTC
  (ADR-0025), which is unrelated to the Node process clock.
- `apps/admin/src/pages/planner/PlannerPage.tsx:33-47` — device-local `YYYY-MM-DD`, opposite
  convention to the backend; they agree 05:30-23:59 IST and disagree 00:00-05:29 IST.
- `leave-request.controller.ts:52-53` — `new Date('YYYY-MM-DD')` → UTC midnight.
- Latent render traps that become live the moment a field's type changes:
  `apps/admin/src/pages/admin/TierOverridesPage.tsx:19-22` (safe only because it re-serialises via
  `toISOString`) and `PlantDeactivationsPage.tsx:48` (`toLocaleDateString`, safe only because the
  field is a real instant). Both clients otherwise slice date-only strings, which is correct.
- **Mobile is clean on this axis** — zero `toLocaleDateString` calls; `leaveDisplay.ts:28-30` slices.
  The one device-local computation is `vehicleUnavailabilityDisplay.ts:26-31` ("tomorrow 9 AM"),
  which is defensible because it produces an instant.

## Scope

**In:** implement #198's Q1/Q2/Q3 rulings — the day-boundary helper(s) and their call sites, the cron
timezone/`TZ` pinning, and the leave/availability date interpretation; align admin's planner to the
ruled convention; add a regression test that pins the boundary so it cannot drift silently again.

**Out:** the ruling itself (#198). Changing storage — timestamps stay `timestamptz` UTC per
`fsm-backend-low-level-design.md:113`; this is about *bucketing*, not storage. Refactoring the
latent admin render traps beyond adding a comment, unless the ruling makes one live.

## Acceptance criteria

- [ ] `utc-day.ts` (or its replacement) implements the ruled boundary and its doc comment states the
      ruling and cites #198 — so the next reader does not re-derive it
- [ ] All call sites enumerated on #198 use the ruled helper; none computes a day boundary inline
- [ ] The dispatch cron's firing time is deterministic and independent of host `TZ`, and a test or a
      documented startup log line proves which local hour it will fire at
- [ ] Admin's planner and the backend agree on "today" at 00:15 IST — asserted, not assumed
- [ ] A leave request for a single calendar day covers that day as ruled (not shifted 5h30m)
- [ ] A regression test pins the boundary with a frozen clock at 00:15 IST and 23:45 IST.
      **Cheap** — `#183` already established the frozen-clock fixture pattern in this suite

## Verification

```bash
cd apps/backend && node scripts/run-tests.mjs test/day-plan-query.e2e-spec.ts test/me-tickets-controller.e2e-spec.ts
# plus the new boundary spec, and a full sweep — ~15 services consume the helper:
node scripts/run-tests.mjs
```
A full backend run is mandatory here; this is the highest-blast-radius change in the epic.

## Risk if deferred

Work done before 05:30 IST lands on the wrong day plan and the wrong report; deferred tickets can be
released early (the failure #146 was filed for); and the dispatch run intended to precede the field
day may fire hours into it. All of it is invisible to the current tests, because they were written
against the same unexamined assumption.

## Size estimate

M-L, depending on the ruling. Option B (keep UTC, document it) is S. Option A/C is M-L — ~15 call
sites plus every test that pins a day.
