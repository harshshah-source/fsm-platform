# #177 — the automatic pools stop handing out work that is waiting on a part

**Landed 2026-08-20.** P8 item 9; hard prerequisite of [#266](../../.scratch/fsm-platform-v1/issues/266-score-selects-within-tier.md)
(a selection rewrite belongs over a correct pool) and, through the shared chooser, of
[#268](../../.scratch/fsm-platform-v1/issues/268-critical-direct-assignment.md).

Per-issue reports are frozen once written. Corrections go to INDEX / SYSTEM-STATE, never here.

---

## What was wrong

A component-blocked ticket stays `OPEN` by design (ADR-0008). The failure cycle moves to
`WAITING_COMPONENT`, the primary SLA pauses, the part goes on order, and the ticket waits — it is not
closed, because the failure is still there. Neither automatic pool ever looked at the cycle:

- the morning recommender selected `workType + status + assignmentState + deferral + plant/device
  guards` and nothing else (`recommender.service.ts`),
- the intraday CRITICAL offer sweep selected `status + assignmentState + bucket + no live insertion`
  (`intraday-insertion.service.ts`).

So the moment such a ticket was also `UNASSIGNED` — a ZM `REMOVE_TICKET`, a deferral lapsing, an
overnight recycle, and routinely once #179 lands — it was dispatched or offered like any other. The SE
drives out, cannot finish, and resubmits `componentUnavailable` on site; the submit gate is also just
`status === 'OPEN'`, so that opens a **second live `component_request`** (the table's only unique is
`submission_id`). One burned capacity slot, one wasted visit, two live part requests against one
failure for the warehouse to reconcile.

Exposure was **0 `component_request` rows in dev**. That is the #156 condition, not safety.

## What shipped

**One predicate, `src/ticketing/component-blocked.ts`**, on the `deferral.ts` model — one exported
filter that every reader of unassigned work spreads in, rather than a clause hand-written per query.
`notComponentBlocked()` excludes; `componentBlockedTickets()` is its exact complement, so the withheld
work is **counted at the point it is excluded and never inferred by subtraction**.

Keyed on the **live cycle state and nothing else** — not `sla_paused`, not the pause reason, not "has
a component request". That is the whole of AC-2: `confirmResubmit`'s floating-SE `RETURN_TO_POOL` is
the *normal* way blocked work resumes, and it unassigns the ticket *after* the part has landed and the
cycle is back to `OPEN`. A predicate keyed on pause history strands exactly the tickets whose parts
have arrived — a worse bug than the one being fixed. See "sensitivity" below; that is not a hypothetical.

**A third ledger column, `component_blocked_withheld`** on `dispatch_runs` and `dispatch_run_zones`
(migration `20260820120000`), summed run-total-from-zone-cards like every column beside it.
Operator-ruled over the issue's other option (an `unassignableReasons` bucket), because that blob
aggregates over *unassignable* tickets — ones that entered the pool and found no SE — and a policy
hold filed there reports a warehouse delay as an Ops coverage gap. The ledger already draws this
distinction twice and now draws it three times:

| column | meaning | whose problem |
|---|---|---|
| `unassignable` | the engine looked and found nobody | Ops — a coverage or capacity gap |
| `withheld_below_threshold` (#238) | it deliberately did not look yet | nobody — policy working |
| `component_blocked_withheld` (#177) | it will not look until a part arrives | the warehouse's clock |

`NULLABLE`, following #242's `bucketless_dropped` rather than #238's column. #238 defaults to 0
honestly because a run predating its gate genuinely withheld nothing; this population was being
**dispatched** all along, so 0 on a historical run would assert a measurement nobody took.

**Excluding without counting would have been quieter than the bug and no more honest** — the ticket at
least used to appear on the run as a recommendation. Uncounted, the plant still has work and nothing
anywhere says so.

## Files

```
NEW  apps/backend/src/ticketing/component-blocked.ts                    the one predicate + complement
NEW  apps/backend/prisma/migrations/20260820120000_component_blocked_withheld_ledger/
NEW  apps/backend/test/recommender-waiting-component.e2e-spec.ts        5 tests
MOD  apps/backend/src/recommender/recommender.service.ts                pool exclusion + the count + RunSummary/ZoneProjection
MOD  apps/backend/src/intraday/intraday-insertion.service.ts            fireForZone exclusion
MOD  apps/backend/src/scheduling/dispatch-run.service.ts                aggregation, zone row, audit metadata
MOD  apps/backend/prisma/schema.prisma                                  two nullable columns
MOD  .scratch/fsm-platform-v1/{INDEX.md,issues/177-*.md}   MOD docs/SYSTEM-STATE-2026-07.md
```

No UI. The issue states UI is n/a, and this matches #242's precedent exactly: `bucketless_dropped`
has lived in the ledger with **zero** admin references since it shipped. This is a recorded choice,
not an unbuilt acceptance criterion — the parity gate is satisfied because no in-scope UI AC exists.

## Three traps, all measured rather than reasoned about

**① `notDeferredOn` and this predicate are both top-level `OR`s, so flat-spreading them silently keeps
only the last.** The first "green" attempt spread `...notComponentBlocked()` into a `where` that
already spread `...notDeferredOn(day)`, and the run came back **identical** — the filter appeared to do
nothing at all, with no error and no type complaint. Both call sites compose under
`AND: [notComponentBlocked()]`, and the predicate's docblock states the requirement so the next reader
does not rediscover it. This is the `deferral.ts` hazard generalised: a module of shared `OR`-shaped
predicates cannot be combined by spread, and nothing in the type system says so.

**② The NULL-relation trap is real but not where the issue implies.** `recommender.service.ts` already
documents, as measured, that Prisma renders a negated to-one relation filter so a row whose relation is
NULL matches *neither the filter nor its negation*. The first draft of the test built a cycle-less
TROUBLESHOOT ticket to pin it — and **the database refused the fixture**:
`tickets_troubleshoot_requires_cycle` (`20260620124718:254`) is
`work_type <> 'TROUBLESHOOT' OR failure_cycle_id IS NOT NULL`. So on the morning pool the dangerous
class cannot exist and the naive spelling would in fact have been safe.

It still is not what shipped, because **`fireForZone` has no `workType` clause at all**. There the
class is only empty because RECOVERY and INSTALL tickets happen to be created `REQUESTED` rather than
`OPEN` — an emergent property of two unrelated facts that this filter neither states nor owns. One
spelling that is correct in both places costs nothing; two spellings, one of which silently drops rows,
is the #153 failure mode.

**③ A `beforeAll` that throws is reported by vitest as `skipped`, not failed** — the same tell #273
recorded. The refused fixture surfaced as `1 test | 1 skipped` under a `Failed Suites` header, which
in a full run is a quiet line among passing ones. Worth re-reading every time a file's test count drops.

## Tests — 5, and what each is for

`test/recommender-waiting-component.e2e-spec.ts`, driven through `RecommenderService.runForZone`,
`IntradayInsertionService.fireForZone` and `DispatchRunService.runForActiveZones` — the service seam
this area's specs already use, because dispatch is cron/manual-run driven and has no HTTP entry.

1. **morning pool** — the blocked ticket reaches no decision; the OPEN-cycle one at the same plant
   does; `ticketsConsidered` and `unassignable` confirm it was not quietly reclassified as a coverage
   failure. *Red before green: 2 decisions, the blocked one among them.*
2. **intraday sweep** — no offer row for the blocked ticket, and `skipped` does not move either, so it
   does not land in the ZM Grouped Critical Queue as though somebody just needed to be found for it.
   *Red before green.*
3. **AC-3 ledger** — `componentBlockedWithheld` on the summary, the zone card and the run total, with
   `unassignable` and `withheldBelowThreshold` both still 0 beside it. *Red before green.*
4. **AC-3 honesty clause** — the column is nullable in `information_schema`. *Red before green.*
5. **AC-2/AC-4 round trip** — the part arrives, the cycle returns to `OPEN`, the ticket re-dispatches
   and the figure drops to 0. Written green, so its **sensitivity was verified rather than asserted**:
   re-keying the predicate from cycle state to `slaPaused` leaves tests 1–3 **passing** — the exclusion
   still "works" — and fails *only* this one, `expected [] to include <ticket>`. That is precisely the
   permanent-stranding bug AC-2 exists to prevent, and exactly one test catches it. The fixture leaves
   `sla_paused` and its reason standing when the cycle reopens, which is what makes the assertion bite.

## Verification

- backend `tsc` clean.
- Targeted regression over the blast radius: **11 recommender specs 29/29**, **14 dispatch / intraday /
  component specs 53/53**, plus this file **5/5**.
- Full backend suite: see the INDEX session-log row for the measured figures.
- Migration applied to dev `fsm` via `prisma migrate deploy`; additive (two nullable columns), no data
  change, and the migration file is tracked, so the repo reproduces the running schema (#144's trap).
- **#243 remains HITL-gated and unexecuted.** No data or cleanup change in this slice.

## Deliberately not built, and named

- **The one-live-request-per-ticket partial unique on `component_request`** — item 4 of the issue's
  "What to build", which asks for it to be *recorded* and added only if trivially safe against existing
  data. It is not: it needs a duplicate probe first, and dev's 0 rows are the #156 condition rather than
  evidence. Its own hardening slice.
- **The `/assign` console pool is not filtered.** #273's `assignableTickets()` selects the same
  OPEN + UNASSIGNED work and its docblock explicitly warns against absorbing "any future exclusion" —
  so this was put to the operator rather than decided quietly. **Ruled: not excluded.** The two pools
  fixed here are automatic, with no human judgment, which is what makes a blocked ticket pure waste;
  the console is a dispatcher deciding, where #258 Q1/Q2 ratified show-don't-gate (over-capacity is
  marked, selectable, never blocked), and a part that has just landed is a legitimate reason to assign
  one. **Marking it there belongs to #274**, which owns candidate and pool transparency.
