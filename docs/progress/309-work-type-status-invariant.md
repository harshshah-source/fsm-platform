# #309 — `work_type ⇔ status`: the CHECK the schema had claimed for a year

**Finding:** CB-12 (`audit/2026-09-01-scheduler-engine-forensics.md` §6) · **Wave 2** · P2
**Landed:** 2026-09-02 · branch `feat/autoplant-integration`

---

## What was wrong

`schema.prisma` documented the `ticket_status` enum as *"Coupled to `work_type` by a CHECK + service
guard"*. The service guard is real. The CHECK never existed. The only CHECK ever migrated onto
`tickets` (`migrations/20260620124718:255`) is TROUBLESHOOT ⇒ `failure_cycle_id NOT NULL` — a
different invariant entirely.

So a TROUBLESHOOT ticket could sit at `FITTED`, an INSTALL ticket at `RECEIVED_AT_WAREHOUSE`, and the
database would take it without complaint. On its own that is a P3 documentation lie. What raised it is
CB-5 (#308): the four divergent terminal-status vocabularies meant unguarded writes were landing
statuses from other ladders onto tickets, with **nothing below application code** to catch it. #308
removed the writers most likely to produce a violation; this issue is the backstop underneath them,
which is why it was sequenced second — landing the CHECK first would have converted CB-5's silent
overwrites into 500s.

## Probe first — the shape of this slice

The issue is explicit that the probe comes before any DDL (AC1), and that what the probe finds decides
whether the rest is AFK or a stop for the operator. That ordering is the #155 lesson: **do not assume
zero**.

`apps/backend/scripts/probe-work-type-status.cjs` is read-only — no writes, no transaction, exits 1 on
violations so it doubles as a pre-migration gate. It was run against the **dev** database `fsm`, the
one carrying a real AutoPlant sync, not only the empty `fsm_test`:

| database | ticket rows | pairs | outside the map |
|---|---|---|---|
| `fsm` (dev) | 30,460 | TROUBLESHOOT/CLOSED 18,206 · TROUBLESHOOT/OPEN 9,054 · TROUBLESHOOT/CLOSED_AUTO_RECOVERY 3,200 | **0** |
| `fsm_test` | 0 (truncated per run) | — | **0** |

**Clean** ⇒ the AFK branch. No operator disposition, no repair, no exemption. The probe also
re-confirmed the finding at the database itself: `pg_constraint` on `tickets` held exactly one CHECK,
and it was the cycle one.

The result was written into the issue file *before* the migration was authored, which is what AC1 asks
for and what makes the ruling reviewable rather than retrofitted.

## The map, and why it is not the PRD's map

The issue's boundary is unusually pointed: *"the legal map must be derived from what writers actually
produce… if code produces a pair the map calls illegal, that is a finding to record, not a row to
break."* Every pair was therefore traced to the service that writes it. The full table lives in the
issue file; three rulings are worth repeating because they are judgements, not transcriptions.

**1. Three statuses are written by no writer at all.** `SUBMITTED`, `FITTED` and
`RECEIVED_AT_WAREHOUSE` never reach `tickets.status`:

- `FITTED` — `install-lifecycle.service.ts:141` writes the *event*, then :145 moves the row straight to
  `ACTIVATED` in the same transaction. There is no instant at which a row is `FITTED`.
- `RECEIVED_AT_WAREHOUSE` — `recovery.service.ts:155` writes the event, :158 closes the row `CLOSED`.
  Same shape.
- `SUBMITTED` — appears only in `non-operational.service.ts`'s `IN_FLIGHT_TICKET_STATES` read filter.
  A troubleshoot submission takes the ticket `OPEN → VERIFICATION_PENDING`; it is the *failure cycle*
  that goes `SUBMITTED`.

They were kept in the map, each on the single ladder its own code belongs to. Excluding them would have
been strictly truer to "what writers produce" — and wrong for this constraint. CB-12's complaint is
that a status is not coupled to a **work type**; a CHECK that also forbids `INSTALL/FITTED` is a
transition-**order** rule, which nobody asked for and which would 500 the first slice that decides to
persist the intermediate state. The narrow reading would have bought nothing and cost a future
outage.

**2. `CLOSED_NON_OPERATIONAL` is legal on all three work types although only TROUBLESHOOT can reach it
today.** `non-operational.service.ts:400` selects `IN_FLIGHT_TICKET_STATES` =
OPEN/SUBMITTED/VERIFICATION_PENDING/ESCALATED — all TROUBLESHOOT-only — so no INSTALL or RECOVERY
ticket is ever closed this way. But it is a *device left service* closure, the same family as `CLOSED`,
which device departure and plant deactivation already write **work-type-blind**
(`device-departure.service.ts:299`, `plant-deactivation.service.ts:185`). Widening that in-flight list
is a plausible next slice; it must not be a 500.

**3. `ESCALATED` and `CLOSED_AUTO_RECOVERY` stay TROUBLESHOOT-only.** Both hang off failure-cycle
machinery no other work type has. The near-miss is `recovery.service.ts:243`, `escalateToOh` — which
transitions to `ticket.status`, the ticket's own unchanged state, and so never produces
RECOVERY/`ESCALATED`. Reading that as "recovery tickets can be escalated" would have widened the map
on a transition that does not exist.

## What landed

- `prisma/migrations/20260902120000_ticket_work_type_status_check/migration.sql` — one raw-SQL CHECK,
  the established pattern for constraints Prisma cannot express (same file style as the 20260620124718
  invariants block). Validated on apply: Postgres scanned all 30,460 dev rows and accepted.
- `prisma/schema.prisma` — the enum's docblock now describes the constraint that exists, names it and
  its migration, lists the three ladders, and says plainly that it is a backstop under the service
  guards rather than a replacement for them (AC3).
- `scripts/probe-work-type-status.cjs` — the probe, kept.
- `test/work-type-status-invariant.e2e-spec.ts` — the spec, below.

No writer changed. No status semantics changed. No row was repaired.

## The test is a sweep, not a sample

`test/work-type-status-invariant.e2e-spec.ts` reads the **live `ticket_status` enum out of `pg_enum`**
and then walks every (work_type, status) combination it allows — 3 × 17 — asserting both directions:

- every legal pair still inserts (**the map is not too strict** — the issue's stated regression risk,
  asserted directly rather than inferred from the suite passing);
- every other pair is refused, **and refused by this constraint**. The rejection is matched against
  `tickets_work_type_status` by name, so a TROUBLESHOOT row bounced by the older cycle CHECK, or by a
  foreign key, cannot read as a pass. Each TROUBLESHOOT insert is given its own VERIFIED failure cycle
  precisely so that older CHECK is satisfied and cannot be what answers.

Reading the enum from the database rather than from TypeScript is what makes this a drift pin: a
status added by a later `ALTER TYPE` cannot slip through untested. A dedicated coverage case fails if
the map does not name every live label — otherwise a new status would be silently swept as "illegal
for all three", a rule nobody decided.

**Red before green, on the real thing:** run before the migration, the sweep listed all 27 illegal
pairs as accepted by the database. The other three cases were green from the start — which is the point
of stating them: they show the map matches the world as it already is, so only the refusal half is new.

## Four fixtures seeded states no writer can produce

The full suite is the issue's own assertion, and it earned its keep. Four specs constructed pairs the
map calls illegal:

| fixture | seeded | now |
|---|---|---|
| `terminal-status-no-reclose.e2e-spec.ts` | TROUBLESHOOT at `FAILED_ACTIVATION` / `RECEIVED_AT_WAREHOUSE` | the work type each status belongs to; cycle link kept |
| `dashboard-activity-trend.e2e-spec.ts` | INSTALL at `OPEN` | INSTALL at `REQUESTED` |
| `report-mix-outcomes.e2e-spec.ts` | all three work types flat at `OPEN` | each in the status its own creator writes |
| `special-ticket-derivation.e2e-spec.ts` | INSTALL at `OPEN` | INSTALL at `REQUESTED` |

Every assertion survives unchanged, because in each case the code under test reads `status` alone
(#308's closure guard) or reads `work_type` and `created_at` and never `status` (both reports, the
activity trend). A brace-matched static sweep of `ticket.create` found the first two; **the other two
only surfaced when the suite ran against the landed CHECK** — the scan could not see a status supplied
through a helper parameter. That is the case for running the suite rather than trusting a scan.

One consequence is recorded rather than buried. `special-ticket.query.ts`'s Special predicate reads
`work_type = 'TROUBLESHOOT' AND status = 'OPEN' AND …`, and its docblock calls the `work_type` clause a
deliberate narrowing beyond the written definition. With the CHECK landed, `OPEN` is reachable only by
TROUBLESHOOT, so **that clause is now provably implied by the status clause**. It was left alone —
this slice changes no source outside the migration and the schema comment, and defence in depth against
a future map change costs nothing — but the spec's INSTALL case no longer isolates it, and its docblock
now says so instead of quietly overstating what the case proves.

## Verification

- **Full backend suite green: 448 spec files, 2,372 tests passed, 8 skipped, ZERO failures.** Run as
  five foreground batches per the standing recipe (a single run exceeds the Bash tool's 10-minute cap);
  the three batches that had failures mid-slice were re-run in full after the fixtures were corrected.
- `tsc --noEmit` clean. `apps/admin` is untouched by this issue.
- `dispatch-crashed-zone-recovery.e2e-spec.ts` failed once mid-batch — the documented load-sensitive
  spec, Wave-1 handoff trap #2. Re-run isolated it is 3 × green, and it touches no work_type/status
  pair. Nothing was changed for it.
- **Drift baseline unchanged at 99 lines**, as the issue requires (#152 pending). Postgres CHECK
  constraints are invisible to `prisma migrate diff` — the pre-existing
  `tickets_troubleshoot_requires_cycle` is not in the baseline either — and the diff output carries no
  line on the `tickets` table at all. (The gate does report 5 lines against a *booted* dev database:
  `runtime_lock`, which the baseline's own header documents as expected there, and two cosmetic
  `dispatch_zone_recoveries` naming lines that predate this slice. Neither is reachable from a comment
  edit plus an `ADD CONSTRAINT`. CI's dedicated `fsm_drift` database could not be rebuilt here — the
  local role has no `CREATE DATABASE` right.)

## What this does not do

It is a backstop, not a lifecycle engine. It says which statuses belong to which work type; it says
nothing about the order they may be visited in, and it cannot: `CLOSED` is legal for all three, and a
CHECK sees one row, not a history. Transition order remains the services' business — `ticket_events`
is where the ladder is actually recorded, and #308's guards are what stop a terminal row moving again.
