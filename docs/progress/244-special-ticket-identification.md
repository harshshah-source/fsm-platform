# #244 — Special ticket: derived identification, a governed threshold, and a checkable claim

**Done 2026-08-19.** Backend + Admin — one vertical slice. Built directly on #241 (removal reasons +
indexes) and #242 (recycling, which is what makes the condition reachable at all). Closes the
scheduler block's `#240 → #241 → #242 → #244` chain.

## What this closes

Special is the approved answer to "which tickets are we repeatedly failing to fix?" — a ticket that
**repeatedly entered an SE's active workload, was actually reached in the mobile workflow, and never
produced a successful troubleshooting outcome**.

Before #242 the question was unanswerable in principle, not merely unimplemented: no ticket on this
platform had ever reached a third assignment attempt, because an unworked ticket stayed
`FORMALLY_ASSIGNED` forever instead of returning to the pool. Recycling created the population; this
slice identifies it.

## The three definitions, and why each is an artefact rather than an intention

| Concept | Artefact | Why this one |
|---|---|---|
| **Attempt window** | one `batch_assignment_tickets` row | the only thing every assignment path writes — the 05:00 run, intraday accept, `assignTicket`, and the new row a REASSIGN/SPLIT_BATCH opens. `SWAP_SE` re-points the *batch*, so it continues one window; `REORDER` writes no row |
| **Reached** | a `soft_states` row inside the window | the earliest is the mobile auto-posted `VIEWED`, so it proves the SE **opened the ticket in the app**. It does **not** prove handset delivery, and a server-side assignment alone is therefore not an attempt at all |
| **Success** | a `troubleshooting_submissions` row | the system's single success writer, already idempotent. The component-unavailable variant writes one too — the SE *did* diagnose the fault |

A window is **countable** when it was reached, produced no submission, and ended `PLAN_EXPIRED` or
`VEHICLE_UNAVAILABLE`. Every other removal reason is an approved exclusion, and they share one
justification: somebody *decided* the attempt should end, so it is not evidence the ticket resists
repair. A new reason code is therefore excluded **by default** — the safe direction, since the failure
mode of a wrong inclusion is a fabricated Special.

`SPECIAL := countable ≥ threshold ∧ no submission ever ∧ status = OPEN`.

## Derived, with no column anywhere

There is no counter, no ticket state and no writer. Three properties follow, and each is asserted
rather than asserted-about:

- **A threshold change reclassifies the whole open book on the next read** — in both directions. A
  stored counter could only manage that with a recompute over every open ticket, and the recompute
  would be the thing that drifted.
- **A late submission un-Specials a ticket with nothing to undo.** There is no offline queue on
  mobile; a lost submit simply arrives on re-send, and when it does the verdict evaporates by itself.
- **Reading a verdict writes nothing, anywhere** — pinned with whole-table counts (the #250
  precedent), including `failure_cycles`, because REPEAT/ESCALATED live there and an *attempts*
  concept must not touch a *device* concept.

If Special ever needs to affect **sorting**, that is a recorded architectural consequence requiring a
follow-up (materialisation), not a quiet change here.

## Two judgement calls, recorded rather than absorbed

**INSTALL tickets are excluded, which the written definition does not say.** Special is defined by the
*absence* of a troubleshooting submission, and an install can never have one — so without a work-type
clause every repeatedly-dispatched install would be Special by vacuous truth: a different, unapproved
concept ("dispatched a lot") wearing the same badge. The narrowing is in the shared predicate and
pinned by its own test.

**Per-window vs per-ticket "no submission".** The issue's countable rule says "reached ∧ no submission
∧ ended PLAN_EXPIRED/VEHICLE_UNAVAILABLE" without saying which scope. The implementation uses
*per-window* for countability and *ever* for the verdict. The two readings cannot disagree about
`isSpecial` (no submission ever ⟹ none in any window), and per-window is strictly more informative for
the history a manager reads.

## One definition, four surfaces

`specialPredicateSql(threshold)` and `countableAttemptsSql` are the only implementation. They are
evaluated by the list's badge column, the `special=true` filter, the standalone count, and — through
the open-ticket LATERAL that already aliases tickets as `t` — the Device read. That matters because
the failure it prevents is invisible in unit tests of either half and obvious to a user: a queue that
badges rows the filter then hides. The API spec asserts it as an identity (the filter returns exactly
the badged ids) rather than against a hand-written list, so it survives fixture changes.

The countable-attempts subquery is evaluated twice per row (once for the number, once inside the
predicate) rather than computed once and reused. Deliberate: one definition in one place beats one
subquery fewer, the page is at most 500 rows, and #241's `(ticket_id)` index is what the whole
expression rides on.

## The threshold, and the settings gap it exposed

`special_ticket_attempt_threshold`, default **3**, ladder **2–10**, Operations-Head-owned with **no
co-owner** (unlike #238's threshold, which the CSM co-owns because they feel dispatch volume first —
nobody feels a classification threshold day to day).

The floor is the point: at 1, every ticket ever dispatched, opened and expired once becomes Special
simultaneously — the whole backlog flagged at once, which is indistinguishable from the flag meaning
nothing; at 0 a ticket nobody has visited is Special. Neither is recoverable except by moving the key
back, after everyone has seen the queue light up.

Enforcing that exposed a real gap. `PUT /api/settings/:key` accepted **anything JSON-shaped**, while
the #238-style reader coerces an illegal stored value to its default — the worst combination
available: the settings page reads back the operator's number while the engine quietly uses another.
So the generic writer grew `SETTING_VALIDATORS`: a pure validator per key, refusing with
`SETTING_VALUE_INVALID` **and the allowed list**, because the bound exists nowhere else an operator
can read. The coerced value is what lands in the column, so `"3"` from a form body is stored as `3`.
This is a small general mechanism rather than a second governance service — anything needing I/O, a
lock or a history row still belongs in a specialised writer.

## Admin

Built to `07-tickets` (the SIGNALS column is where REPEAT/ESCALATED already live) and
`28-tickets-drawer`.

- **Queue**: a `SPECIAL · 3` badge in the existing inline-badge strip, violet — deliberately not the
  orange of REPEAT (a device fact) or the red of ESCALATED (a cycle state), because three concepts
  sharing a colour read as three shades of one alarm. The count travels with the badge: "SPECIAL"
  alone is an assertion, "SPECIAL · 3" is a claim a manager can go and check.
- **Filter**: a toggle with the server-side count beside it. The count is fetched, never derived from
  the loaded page — a page count on a filter chip understates the queue the moment it paginates.
- **Ticket drawer → Assignment History**: the tab previously showed only lifecycle *events*; it now
  leads with the attempt windows, each carrying its evidence (who, reached?, submitted?, how it
  ended) and whether it counted, under a verdict stated **against the live threshold**. Every window
  is listed — withdrawals and the still-open one included — because a history showing only the
  countable attempts could not be reconciled against the ledger. A live window reads "in progress",
  not as an outcome.
- **Device Detail**: that page represents a device's ticket as a **single link**, not a section, so
  parity is the identification travelling with the link (a SPECIAL chip beside it) while the history
  itself stays one click away in the drawer. Duplicating the section onto a one-line panel would be
  the redesign the surfacing rule forbids. The verdict comes from the same shared predicate inside the
  device read's existing open-ticket LATERAL, so a device cannot disagree with the queue about its own
  ticket.

The badge renders from the row's own `isSpecial` and never re-derives the rule client-side — the #238
`HELD` precedent, and the reason a queue cannot drift from the filter that populates it.

## Tests

New: `special-ticket-threshold.e2e-spec.ts` (7), `special-ticket-derivation.e2e-spec.ts` (17),
`special-ticket-api.e2e-spec.ts` (10) and admin `special-ticket-surface.test.tsx` (7) — **41**, all
written red first.

- One case **per approved exclusion**, each at three windows (i.e. at threshold volume), so an
  exclusion that silently stopped working flips the verdict rather than merely shifting a count.
- The evidence boundaries both ways: a window with no soft state never counts, and a soft state
  *outside* a window does not make that window reached (otherwise one visit would retro-reach the
  whole history).
- AC-4 as three separate guards: SPECIAL is in no lifecycle enum (read from the generated client, not
  restated); a verdict read changes no table count anywhere and leaves the failure cycle byte-identical;
  REPEAT and Special coexist without either implying the other.
- AC-6 as an ordering identity: moving the threshold changes the verdicts and leaves the row sequence
  byte-identical. Written against the ordering itself rather than against #248, so it holds before and
  after that slice lands.
- The route-ordering pin: `special-count` is a literal path on a controller that also declares `:id`,
  and the wrong declaration order turns it into a lookup for the id "special-count" — a 404 that looks
  exactly like an unknown ticket and would be found in a browser, not in CI.

**Sensitivity verified, not just green.** Five load-bearing clauses of the derivation were broken one
at a time and exactly the right tests went red each time: dropping the reached requirement, widening
the window bound, dropping the TROUBLESHOOT narrowing, dropping the OPEN requirement, and dropping the
submission disqualifier. All restored.

**A fixture bug the suite caught, worth keeping:** the derivation spec seeded the registry row without
a description, and because `seedDefaults` upserts with `update: {}` it never backfills one — so the
threshold spec's "is seeded with a description" assertion failed only when the two ran in that order.
The fixture was wrong, not the product, but the same shape would bite anything that creates a settings
key outside the registry.

## The query-plan pin

The issue asks that the aggregate ride #241's indexes rather than seq-scanning the ledger per request.
`EXPLAIN ANALYZE` against the **dev** database (16k ledger rows — `fsm_test` is too small for a plan
to mean anything, which is why #241 measured the same way):

```
->  Index Scan using batch_assignment_tickets_ticket_id_idx on batch_assignment_tickets bat
      Index Cond: (ticket_id = $0)
      Filter: (removal_reason = ANY ('{PLAN_EXPIRED,VEHICLE_UNAVAILABLE}'::text[]))
```

So the per-ticket window read is an index scan, as intended. **Honest caveat:** the `soft_states`
probe inside it plans as a seq scan, because that table holds **17 rows in the entire database** —
Postgres is right to ignore the `(ticket_id, set_at)` index at that size, and the plan will change on
its own as the table grows. This is measured, not assumed, and it is not pinned as a test: asserting a
plan against `fsm_test` would assert whatever the planner does on an empty table, which is worse than
no assertion.

## Verification

`tsc --noEmit` clean (backend + admin). Targeted backend regression across the 14 specs touching
tickets, devices, settings and thresholds: 100/100. Admin suite and the full backend suite recorded in
`INDEX.md`'s session log.
