# 156 — The shared test DB accumulates orphaned fixtures, so "full suite green" degrades over time
Status: needs-triage
Type: AFK

> Found 2026-07-22 while verifying [#153](./153-override-blanks-day-plan-and-capacity.md). Directly
> undermines every "suite green" claim — the same class of problem the 2026-07-22 adversarial review
> was filed for (`docs/audits/2026-07-22-adversarial-review-admin-backend.md`), and a sibling of the
> shared-watermark trap recorded in the #153/#146 handoff §7.5.

## Problem

`fsm_test` is a **long-lived, shared** database. `test/global-setup.ts` runs `prisma migrate deploy` +
the idempotent org seed once per run — it **never truncates**. Every spec is individually responsible
for undoing its own fixtures in `afterAll`.

So any spec that dies before its `afterAll` — an interrupted run, a killed process, a worker crash, a
`beforeAll` throw — leaks its fixture rows **permanently**. There is no reset path and nothing
notices.

## Evidence (measured 2026-07-22, `fsm_test` @ localhost:5433)

```
zones 780 · engineers 404 · schedules 13 · openTickets 51 · devices 60
```

**780 zones.** Specs create 1–3 zones each and there are ~290 spec files, so a fully-cleaned database
should sit near the seed baseline. The zone and engineer tables are the accumulation sinks.

## Why it matters — it is already causing false reds

`test/dispatch-run-controller.e2e-spec.ts` ("lets Operations Head trigger a dispatch run") triggers a
run that **iterates every zone**. Its cost therefore grows with the orphan count, and it now fails the
default 5000 ms `testTimeout` in a full run while passing 3/3 in isolation.

Observed across three full runs on the same commit:

| Run | Result |
|---|---|
| 1 | 287 files passed, 1 worker crash (`settings-write`) |
| 2 | 285 files passed, 3 worker crashes (different files; overlapped an admin run) |
| 3 | 286 passed, **`dispatch-run-controller` timed out** — after run 3a was killed mid-flight, adding fresh orphans |

Every crashed/timed-out file passes in isolation. The failures move around between runs and correlate
with load and accumulated rows — the signature of environment, not of a defect in the code under test.

**This is corrosive to the audit programme.** A suite whose red/green flips with database history
cannot be used as evidence for anything, and an agent that sees a red it did not cause is pushed
toward either chasing a phantom or dismissing a real failure. Both already happened this session.

## Root Cause

Isolation is per-spec-cleanup rather than per-run. That is fine while every spec exits cleanly and
fails open the moment one does not. `global-setup.ts` is the natural place to enforce a baseline and
currently only guarantees *schema*, not *contents*.

## What to build

Make the baseline enforced rather than assumed. Options, cheapest first:

- **(a) Truncate-and-reseed in `global-setup.ts`.** One `TRUNCATE ... RESTART IDENTITY CASCADE` over
  the fixture tables (everything except the org/reference seed), then the existing seed. Deterministic
  start state for every run; removes the whole class. Cost: full-suite runs can no longer be started
  against a warm DB, and any spec that *depends* on another spec's leftovers will surface — which is
  worth knowing.
- **(b) A `pnpm test:reset` script** run on demand. Keeps runs fast; does not prevent recurrence.
- **(c) Per-spec transactional rollback.** The real fix, and much the largest — most specs use
  `PrismaService` directly and would need a shared harness.

Recommend **(a)**, plus a `scripts/` entry point so it can be run by hand.

Also raise `testTimeout` for the zone-iterating dispatch specs, or scope them to their own zone — a
5000 ms budget on a whole-fleet operation is fragile independent of this issue.

## Acceptance criteria

- [ ] A full-suite run starts from a deterministic database state regardless of what ran before it.
- [ ] The current 780 orphan zones / 404 orphan engineers are cleared, and the count is re-probed and recorded after.
- [ ] Three consecutive full runs produce identical file/test counts and exit 0 — the actual proof, since one green run never distinguished this from a real fix.
- [ ] Any spec that turns out to depend on another spec's leftovers is fixed, not accommodated (handoff §7.5 records two that already did).
- [ ] The reset path is documented next to the `.env.example` bootstrap note, so it is discoverable from the same place as the DB itself.

## Notes for whoever picks this up

- Do **not** simply widen `testTimeout` and call it fixed — that hides the growth instead of stopping it.
- Do **not** `TRUNCATE` the org/reference seed tables; `global-setup.ts` reseeds them and specs assume them.
- The drift gate must still target a never-booted DB (handoff §7.4) — a truncate/reseed step must not
  boot the Nest app, or it creates `runtime_lock` and the gate reports false drift.

## Dependencies

None. Related: [#107](./107-ci-concurrency-guard-migration-tests.md) — CI provisions a fresh database
per run, so CI is immune; this issue is about the **local** loop, where every green claim in the
session log was made.

## Estimated Effort

S for (a) + the probe. **Priority: P2** — nothing is broken in production, but suite trustworthiness is
the substrate every other issue's evidence rests on.

## UI surfaces
None.

## Reference
n/a (test infrastructure)

## Blocked by
None.
