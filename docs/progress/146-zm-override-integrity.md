# Progress — Issue 146: ZM override integrity (B1 defer / B2 remove)

> Build date: 2026-07-22 · Strict TDD (RED→GREEN), AFK.
> Status: **PARTIAL — slices 1–2 of 5 landed** (`0d17842`). B1's "defer stops being write-only" half is
> done and shipped; **slices 3, 4, 5 remain**. Backend +2 e2e files (9 tests); one behavioural change
> in `override.service.ts`. No schema change yet — slice 3 is where the migration lands.
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
| 3 | Deferred ticket becomes re-dispatchable **on** `deferredToDate` — not before, not never | 🔴 | **Slice 3, not started.** Needs the ticket-level `deferred_until` column + recommender predicate. Two tests currently pin the *opposite* (see boundary note). |
| 4 | Capacity/scoring for non-deferred tickets byte-identical, pinned with zero deferred rows | 🟢 | `override-defer-frees-capacity` first test: zero deferred rows, committed ticket still consumes the slot. Written first, passed immediately. |
| 5 | After `REMOVE_TICKET`, same-day recommender de-prioritises the SE it was removed from (soft) | 🔴 | **Slice 4 (B2), not started.** |
| 6 | Soft bias expressed via the ADR-0022 mechanism and visible in `scoreBreakdown` | 🔴 | **Slice 4, not started.** |
| 7 | `deferrals` remains countable for the ZM Performance Scorecard | 🟢 | Asserted in-slice: after removal the `deferredToDate` **and** the `DEFER_TICKET` audit row both survive. `zm-performance-aggregation` green. |
| 8 | Admin batch-schedule-detail reflects a deferred ticket's new state | 🔴 | **Slice 5, not started.** Parity gate — see below. |
| 9 | Backend suite green; #127 APPEND and #126 zone-wedge regressions stay green | 🟢 | 17/18-file regression sweep, 68 tests, zero assertion failures (one worker crash, #156 — 4/4 in isolation). |

## Slice-by-slice RED→GREEN report

- **Slice 1 — defer removes the ticket from today's reads.** The whole fix is one write: stamp
  `removedAt`/`removedBy` alongside `deferredToDate` in `deferTicket`. Every read already filters
  `removedAt: null`, so the SE day plan, ZM schedule view, transparency batch read **and**
  `committedDayLoad` all corrected at once. **RED** = 4 failures (ticket present in all three reads;
  `removedAt` null). **GREEN** 6/6.
- **Slice 2 — defer stops burning capacity.** Passed on its first run, exactly as the issue predicted
  ("should fall out of slice 1 for free"). Written anyway because it is the AC, and asserted at the
  recommender seam rather than by re-issuing `committedDayLoad`'s own query. 3/3.

## The slice-1 boundary — read this before writing slice 3

`assignmentState` is deliberately **left at `FORMALLY_ASSIGNED`** on defer.

The tempting move is to implement both workflow clauses at once and flip the ticket to `UNASSIGNED`
("removed from current batch"). **That would be worse than the bug.** The recommender selects
`OPEN` + `UNASSIGNED` (`recommender.service.ts:103-108`), so an `UNASSIGNED` deferred ticket is
immediately re-dispatchable **today** — the exact opposite of deferring it.

Two tests pin this boundary on purpose (`override-defer-leaves-today` last case,
`override-defer-frees-capacity` last case). They assert `FORMALLY_ASSIGNED`, and **slice 3 is expected
to change them** — but only together with the `deferred_until` predicate that makes re-dispatch safe.
If a future slice makes them fail on their own, that is the bug they exist to catch.

Consequence to be honest about: **the deferred ticket is currently stranded**. It is off today's plan
and no longer burns capacity (both improvements), but it is not yet re-planned on any future date.
That is AC#3, and it is what slice 3 closes.

## Parity-gate disposition (CLAUDE.md / workflow.md)

AC#8 (admin batch-schedule-detail shows the deferred state + date) is **in scope and not deferred** —
slice 5, and it depends on slice 3's data. This issue **may not be marked done** until slice 5 lands:
the deferral reason would be "not built yet", which the parity gate does not accept as a reason to
defer. No follow-up issue is being filed to carry it; it stays inside #146.

## Remaining work

- **Slice 3** — `deferred_until` on the ticket (additive nullable + migration), flip `assignmentState`
  to `UNASSIGNED` **at the same time**, recommender candidate predicate
  `deferred_until IS NULL OR deferred_until <= :today`. Closes AC#3. From-zero migrate must show no
  drift (note the pre-existing 22-table cosmetic drift recorded in SYSTEM-STATE — see #152).
- **Slice 4 (B2)** — `REMOVE_TICKET` soft negative preference. **Must exclude deferred rows**: slice 1
  makes defer set `removedAt`, so a penalty keyed on `removedAt` alone would also penalise defers,
  which is wrong — on the deferred date the ticket may legitimately return to the same SE. Scope it to
  removals **without** a `deferredToDate`. Keep it soft (ADR-0022); a hard filter would contradict the
  documented shared-pool return.
- **Slice 5** — admin parity (`/schedules/:engineerId`), reference
  `docs/ui/desktop/v2-reference/12-batch-schedule-review.png`.

Ship B1 (slices 1–3, 5) and B2 (slice 4) as separate commits so one can be reverted without the other.
Slices 1–2 are already committed as one B1 unit (`0d17842`).
