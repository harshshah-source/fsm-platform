# Progress — Issue 146: ZM override integrity (B1 defer / B2 remove)

> Build date: 2026-07-22 · Strict TDD (RED→GREEN), AFK.
> Status: **PARTIAL — slices 1–3 of 5 landed** (`0d17842`, `0b77bdd`). **B1 is functionally complete**:
> defer now removes, frees capacity, and returns the ticket on its date. **Slices 4 (B2) and 5 (admin
> parity) remain.** Backend +3 e2e files (14 tests), +2 shared modules, 1 additive migration.
> Blocked-by [#153](../../.scratch/fsm-platform-v1/issues/153-override-blanks-day-plan-and-capacity.md)
> is **cleared** (done earlier the same day), which is what made these criteria observable at all.

## Why slices 1–2 could not have been written before #153

#146's slice-1 criterion is "the deferred ticket leaves the plan, **the rest of the plan is
untouched**", and slice 2's is a capacity assertion. Before #153 the day plan was **already empty**
and committed load was **already 0** for an unrelated reason — any test written against those
criteria would have passed for the wrong reason. That is how #153 was found, and it is why the
roadmap was resequenced.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Deferred ticket disappears from SE day plan, ZM schedule view, dispatch-transparency reads | 🟢 | `override-defer-leaves-today.e2e-spec` — one assertion per surface, each also asserting the **batch-mate stays**. RED: present in all three. |
| 2 | Deferred ticket does not consume SE capacity for the current day | 🟢 | `override-defer-frees-capacity.e2e-spec` — SE at 1/1 → defer → the blocked ticket flips `UNASSIGNABLE` → `SUGGESTED` at the `runForZone` seam. |
| 3 | Deferred ticket becomes re-dispatchable **on** `deferredToDate` — not before, not never | 🟢 | `dispatch-defer-lifecycle.e2e-spec` — window asserted from both sides: today's re-run leaves it off (plan, recommendation **and** Shared Pool), tomorrow's dispatches it. RED: `expected +0 to be 1`. |
| 4 | Capacity/scoring for non-deferred tickets byte-identical, pinned with zero deferred rows | 🟢 | `override-defer-frees-capacity` first test: zero deferred rows, committed ticket still consumes the slot. Written first, passed immediately. |
| 5 | After `REMOVE_TICKET`, same-day recommender de-prioritises the SE it was removed from (soft) | 🔴 | **Slice 4 (B2), not started.** |
| 6 | Soft bias expressed via the ADR-0022 mechanism and visible in `scoreBreakdown` | 🔴 | **Slice 4, not started.** |
| 7 | `deferrals` remains countable for the ZM Performance Scorecard | 🟢 | Asserted in-slice: after removal the `deferredToDate` **and** the `DEFER_TICKET` audit row both survive. `zm-performance-aggregation` green. |
| 8 | Admin batch-schedule-detail reflects a deferred ticket's new state | 🔴 | **Slice 5, not started.** Parity gate — see below. |
| 9 | Backend suite green; #127 APPEND and #126 zone-wedge regressions stay green | 🟢 | **Full suite after slice 3: 291 files / 3 skipped (294); 1196 passed / 5 skipped (1201); exit 0; 686 s.** Reconciles against the post-#153 baseline: 288 + 3 files, 1182 + 14 tests. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — defer removes the ticket from today's reads.** The whole fix is one write: stamp
  `removedAt`/`removedBy` alongside `deferredToDate` in `deferTicket`. Every read already filters
  `removedAt: null`, so the SE day plan, ZM schedule view, transparency batch read **and**
  `committedDayLoad` all corrected at once. **RED** = 4 failures (ticket present in all three reads;
  `removedAt` null). **GREEN** 6/6.
- **Slice 2 — defer stops burning capacity.** Passed on its first run, exactly as the issue predicted
  ("should fall out of slice 1 for free"). Written anyway because it is the AC, and asserted at the
  recommender seam rather than by re-issuing `committedDayLoad`'s own query. 3/3.
- **Slice 3 — defer returns the ticket on its date.** `deferred_until` on the Ticket (additive
  nullable, migration `20260722120000_ticket_deferred_until`), `deferTicket` flips the ticket to
  `UNASSIGNED` **and** stamps the date, and every reader of unassigned work gains the shared
  `notDeferredOn(day)` predicate. **RED**: `expected 'FORMALLY_ASSIGNED' to be 'UNASSIGNED'`, and on
  the deferred date `expected +0 to be 1` — the ticket was never re-dispatched. **GREEN** 5/5, and
  14/14 across all three defer specs.

## The flip and the date are one change — never split them

The single most important thing in this issue. `deferTicket` flips the ticket to `UNASSIGNED` *and*
stamps `deferred_until`, and those two must always ship together.

- **Flip without date** → the recommender selects `OPEN` + `UNASSIGNED`
  (`recommender.service.ts:103-108`), so the deferred ticket is re-dispatched on the very next run,
  possibly the same minute. That is worse than the bug this issue fixes, and it is why slices 1–2
  deliberately left `assignmentState` alone and pinned it with tests.
- **Date without flip** → the ticket stays `FORMALLY_ASSIGNED` and no reader of unassigned work can
  ever see it: the permanent-stranding bug, which is what slice 3 closes.

Six readers select unassigned work, and every one of them would have handed a deferred ticket
straight back. So the predicate is **one exported helper** (`src/ticketing/deferral.ts`), not six
hand-written `OR` clauses:

| Reader | Why it matters |
|---|---|
| `recommender.service.ts` TROUBLESHOOT | the main re-dispatch path |
| `recommender.service.ts` INSTALL backlog | an INSTALL can sit in a batch and be deferred too |
| `shared-pool.service.ts` | would offer the deferral straight back to the SE as pickable work |
| `intraday-insertion.service.ts` | would re-offer it as an intraday CRITICAL insertion |
| `cross-zone-escalation.service.ts` | a deferred Platinum ticket must not trip the escalation clock |
| `override.service.ts` bulk plant-assign | a ZM bulk action must not silently undo another ZM's defer |

**#153 is the cautionary tale directly upstream of that decision**: six copies of a liveness filter
drifted apart and blanked every SE's day plan. This is the same shape of problem, so it got one
definition from the start.

Two related cleanups fell out of the slice and are worth knowing about:

- **`utcDayStart` was already duplicated** in `recommender.service.ts` and `dispatch-run.service.ts`,
  and slice 3 needed a third copy. Consolidated into `src/common/utc-day.ts`. A date gate that
  disagreed with the dispatch day by even an hour would release deferred work early or hold it an
  extra day.
- **`getSharedPool` had no clock** — it read `new Date()` directly, so the deferral gate could not be
  tested against a fixed timeline. It now takes an injectable `now`, matching the intraday and
  cross-zone sweeps. The RED caught this: the spec's "today" was June while the wall clock was July.

The two tests that pinned `FORMALLY_ASSIGNED` are **inverted by slice 3, deliberately** — that is
exactly what they were written to gate. Both now assert `UNASSIGNED` **and** the date, because neither
half is correct alone.

## Migration notes

`20260722120000_ticket_deferred_until` — additive, nullable `DATE`. Existing rows read as "not
deferred", correct for all of them. Ticket-level rather than batch-level because the batch row is
per-plan and the ticket is being removed from its current batch, so it cannot carry the future date;
`batch_assignment_tickets.deferred_to_date` stays as the durable audit/scorecard record (AC#7).

**Deliberately no index.** The predicate is `deferred_until IS NULL OR deferred_until <= :day`, which
is unselective by construction (almost every row is NULL) and always rides alongside existing
status/assignment-state/plant filters. A partial index would have to be raw SQL — `@@index` cannot
express a `WHERE` — adding a fresh schema-drift entry to buy nothing measured. Revisit under #103 if
profiling ever shows otherwise.

**Drift gate:** no `tickets` / `deferred_until` drift — the migration reproduces `schema.prisma`. The
only new line is `runtime_lock`, the documented artifact of running the gate against a *booted*
database (handoff §7.4); a true from-zero check needs a never-booted DB, which cannot be created on
this host (the `fsm` role is not a superuser). **Not re-baselined.**

Dispatch clears a spent `deferred_until` as it re-assigns the ticket, in the `ticket.update` that
already sets `FORMALLY_ASSIGNED` — no extra query.

## Parity-gate disposition (CLAUDE.md / workflow.md)

AC#8 (admin batch-schedule-detail shows the deferred state + date) is **in scope and not deferred** —
slice 5, and it depends on slice 3's data. This issue **may not be marked done** until slice 5 lands:
the deferral reason would be "not built yet", which the parity gate does not accept as a reason to
defer. No follow-up issue is being filed to carry it; it stays inside #146.

## Remaining work

- **Slice 4 (B2)** — `REMOVE_TICKET` soft negative preference. **Must exclude deferred rows**: slice 1
  makes defer set `removedAt`, so a penalty keyed on `removedAt` alone would also penalise defers,
  which is wrong — on the deferred date the ticket may legitimately return to the same SE. Scope it to
  removals **without** a `deferredToDate`. Keep it soft (ADR-0022); a hard filter would contradict the
  documented shared-pool return.
- **Slice 5** — admin parity (`/schedules/:engineerId`), reference
  `docs/ui/desktop/v2-reference/12-batch-schedule-review.png`.

Ship B1 (slices 1–3, 5) and B2 (slice 4) as separate commits so one can be reverted without the other.
Slices 1–2 landed as `0d17842`, slice 3 as `0b77bdd` — both B1, independently revertible.
