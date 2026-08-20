# #107 — CI had run 106 times and never executed a test

**Done 2026-08-20**, commit `1b99d1e` (slices 3–4, N3, AC#5, and the finding that reframed the issue). Slices 1–2 —
the workflow and the drift gate — landed 2026-07-22.

## The finding

The issue's open item read *"the workflow has **never executed** on GitHub Actions."* That was stale
in the worst possible direction. It had executed **106 times, and failed 106 times**, and in not one
of those runs did a single test run.

```
 11  success  Migrate from zero
 12  failure  Schema drift gate     <-- fails here
 13  skipped  Backend suite
 14  skipped  Admin suite
 15  skipped  Mobile suite
```

The `Schema drift gate` sits at step 7 of 10, and a failed step skips the rest of the job. It began
failing when two drift lines appeared after the 2026-07-22 baseline was written:

| New line | What it is |
|---|---|
| `media_objects.media_id` default `gen_random_uuid()` → `None` | the **4th** instance of a pattern whose siblings `voucher_id`, `submission_id`, `run_id` are already baselined (lines 40/73/81). Landed 2026-08-04. |
| `company_tier_overrides_lookup_idx` renamed | the **19th** short index name, of a class with 18 baselined |

Both are exactly what the baseline exists to tolerate — the gate was working as designed and the
baseline was stale. But the consequence was total: **the pipeline written to stop "both suites were red
and nobody knew" was itself running no suites, and nobody knew.** The same failure, one level up.

Nobody acted because the two halves of the signal each looked unremarkable on their own: the job was
red, so no one read further; the red was cosmetic, so no one thought it urgent.

## What was built

### The structural fix, not just the unstick

Re-baselining alone would have restored green and left the trap armed — the baseline going stale again
is a matter of time. So the suite steps now carry **`if: '!cancelled()'`**:

- the gates still fail the job — nothing was softened;
- but the primary signal can no longer be switched off by an unrelated earlier step.

A pipeline whose entire test signal one cosmetic drift line can disable is worth less than the sum of
its steps. Next time the baseline goes stale it costs a red gate, not every test in the repository.

### Slice 3 — concurrency scaffolding (AC#4)

`test/support/concurrency.ts` + `test/concurrency-harness.e2e-spec.ts` (8 tests).

`await Promise.all([f(), g()])` — the pattern four specs already use — starts both calls but does not
make them overlap where it matters. Both are entered on one thread; the first runs to its first `await`
before the second begins. A read-modify-write with no `await` between read and write is therefore
**atomic**, and the interleaving that loses an update is *unreachable* — so a test asserting "no lost
update" passes without ever having tried the case it names.

`raceTwice` adds a two-party release barrier: each call takes an `arrive()` it invokes at the contended
point, and neither proceeds until both are there. The spec **demonstrates** the difference instead of
asserting it — the identical read-modify-write loses exactly one update every time under `raceTwice`
and loses none under `raceTwiceUnbarriered`.

`expectExactlyOneWinner` states the assertion these tests actually want: one winner, one clean no-op
**or** a clean rejection, and the same end state *whichever* won — because that is the part a passing
run must not depend on. It rejects both two winners (the double write) and zero (the work never
happened). `raceTwiceUnbarriered` is kept for code with no injection point, with the docstring
requiring the test name to admit it is only a start-together race.

### Slice 4 — N3, the admin→backend seam

`apps/admin/test/seam/admin-backend-http.seam.test.ts`, its own `vitest.seam.config.ts`, and its own CI
step that boots the real backend against `fsm_test` (already migrated and seeded by the backend suite —
which is where the `*@fsm.test` credentials live). **Excluded from `pnpm test`**: a suite that goes red
whenever you have not started a backend gets ignored, and an ignored suite is worse than none.

**One flaw found while building it, recorded because it is the failure mode seam tests are prone to.**
The first draft read its base URL from a bespoke `SEAM_API_URL` while the client read its own
`VITE_API_URL`. It passed 4/4 — with the client talking to a **stale backend on the default port** and
the raw fetches talking to the one under test. A seam test measuring two different servers and
reporting green: the exact class of lie the seam test exists to catch, committed by the seam test.
Both now derive from the single expression the client itself uses, plus an assertion that
`VITE_API_URL` is set at all. Verified red against a dead backend (3 of 5 fail).

### AC#3 — route-guard sweep

Already owned by #99 (`global-guard-validation.e2e-spec.ts:96`) — it walks the real Express route map,
normalises the `/api/v1` dual-serve prefix, and holds a conscious public allowlist. Verified by probe
rather than assumed: marking `VouchersController` `@Public()` turned it red naming 12 leaked routes.
(A first probe — widening the allowlist — was the wrong test: widening it is by design a deliberate
edit, so it passing proved nothing.)

### AC#5 — documentation

`docs/ci-pipeline.md`: what runs and in what order, the three databases and why `fsm_drift` is never
booted, how to run each piece locally, how to recreate `fsm_drift`, the never-pipe-a-suite rule, the
`TZ=UTC` rule, and the failure mode above written down as history.

## Verification, and a mistake worth recording

GitHub runners are **UTC**; this repo's developers are on **IST**. That gap produced two defects this
week alone (#256, a spec red 5½ hours a night; #254, a cron firing five hours after the batch it feeds),
so the full backend suite was run under `TZ=UTC` before pushing — the highest-value check available
without a runner.

**The first UTC run reported 12 failures across 4 files, and every one of them was my own
contamination.** While it was in flight I ran several single-file `vitest` invocations — and every
invocation's `globalSetup` truncates and reseeds `fsm_test`. I pulled the database out from under a
running suite, repeatedly, having been told not to: the hazard is in the handoff, and INDEX records the
rule verbatim from a previous session that lost time to it — *"once a verification run starts, the tree
is frozen until it reports."*

The tell was there to read: a `POST /api/auth/login` returning **401** for a seeded fixture user is not
a timezone symptom, it is "the users table was emptied mid-run". All four files pass cleanly under
`TZ=UTC` in isolation, and the clean re-run's result is recorded in the INDEX session-log row.

Recorded rather than quietly re-run because the first conclusion — *"the UTC pre-flight paid off, 12
real failures"* — was stated before it was checked, and was wrong.
