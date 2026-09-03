# 309 — `work_type ⇔ status` invariant: probe, then enforce (the CHECK the schema claims exists)
Status: **done** (2026-09-02) — report [`docs/progress/309-work-type-status-invariant.md`](../../../docs/progress/309-work-type-status-invariant.md). Probe CLEAN on the dev database (30,460 real tickets, 0 violations), so the AFK branch applied and no operator disposition was needed. Three rulings the map records rather than assumes: `SUBMITTED`/`FITTED`/`RECEIVED_AT_WAREHOUSE` are written by **no** writer (they reach `ticket_events` only) yet stay legal on their own ladder, because this CHECK couples a status to a work type and is not a transition-order rule; `CLOSED_NON_OPERATIONAL` is legal on all three although only TROUBLESHOOT reaches it today, matching the work-type-blind closures departure and deactivation already write; `ESCALATED`/`CLOSED_AUTO_RECOVERY` stay TROUBLESHOOT-only (`recovery.service.ts:243` transitions to the ticket's own unchanged status — it is not a RECOVERY escalation). The spec sweeps all 3 x 17 pairs against the enum read from `pg_enum`, both directions, matching the rejection by constraint name. Four fixtures seeded pairs no writer produces; two only surfaced under the full suite, which is why the suite is the assertion and a static scan is not. Drift baseline unchanged at 99 lines.
Type: AFK (HITL gate only if the probe finds violating rows)
Wave: 2 · Severity: P2 (P3 finding, elevated by CB-5's write gap) · Finding: CB-12,
`audit/2026-09-01-scheduler-engine-forensics.md` §6

## Problem

`schema.prisma:1915-1917` documents a CHECK coupling `work_type` to legal `status` values. It
does not exist: the only ticket CHECK (`migrations/20260620124718:255`) is
TROUBLESHOOT ⇒ `failure_cycle_id NOT NULL`. Nothing at the DB stops a TROUBLESHOOT ticket at
`FITTED` or an INSTALL ticket at `RECEIVED_AT_WAREHOUSE`; combined with the unguarded writes CB-5
found, the coupling is enforced nowhere below application code.

## Root cause

The comment was written for a constraint that was never migrated (doc/DB divergence).

## Affected files / symbols

- `apps/backend/prisma/schema.prisma` (comment)
- New migration under `apps/backend/prisma/migrations/` (raw SQL CHECK, the repo's established
  pattern for constraints Prisma cannot express)
- A read-only probe script/spec first

## Intended behavior after fix

1. **Probe first (the #155 lesson: do not assume zero):** a read-only query counting rows whose
   (work_type, status) pair is outside the legal map (the map derived from the three lifecycle
   ladders in the forensic report §(b) / the code's own transition writers).
2. Probe clean ⇒ add the CHECK by migration and correct the schema comment to describe it.
3. Probe dirty ⇒ **stop and put the disposition to the operator** (repair vs exempt vs narrow the
   CHECK) — Strategic HITL, data repair is not an agent's call. The CHECK lands only after.

## Implementation boundaries

- Constraint + comment + probe only. No writer changes (those are CB-5/#308), no status semantics
  change, no backfill without the operator's ruling.
- The legal map must be derived from what writers actually produce, not from the PRD — code is
  truth; if code produces a pair the map calls illegal, that is a finding to record, not a row to
  break.

## DB / API / frontend impact

DB: one CHECK constraint (additive; violating writes would start failing — which is the point).
API/frontend: none.

## Dependencies

After #308 (its guards remove the writers most likely to produce new violations; landing the
CHECK first would convert CB-5's silent overwrite into 500s). Drift note: the new migration must
not enlarge `drift-baseline.txt` (#152 pending).

## Regression risks

- A too-strict map breaks legitimate writes — mitigate by probing against production-shaped data
  AND by running the full backend suite (its fixtures exercise every writer).

## Tests required

- The probe itself, kept as a spec (green = zero violations — the ongoing invariant).
- Migration test: an illegal pair insert fails; every legal lifecycle transition in existing e2e
  suites still passes (full suite is the assertion).

## Probe result (AC1) — recorded 2026-09-02, before any DDL

**CLEAN.** `apps/backend/scripts/probe-work-type-status.cjs` (read-only; no writes, no transaction)
run against the **dev** database `fsm` — the one carrying the real AutoPlant sync, per the #155
lesson — and against `fsm_test`.

| database | ticket rows | pairs found | outside the map |
|---|---|---|---|
| `fsm` (dev) | 30,460 | TROUBLESHOOT/CLOSED 18,206 · TROUBLESHOOT/OPEN 9,054 · TROUBLESHOOT/CLOSED_AUTO_RECOVERY 3,200 | **0** |
| `fsm_test` | 0 (reset between runs) | — | **0** |

The probe also re-confirmed the finding at the DB: the only CHECK on `tickets` is
`tickets_troubleshoot_requires_cycle`. The documented `work_type ⇔ status` CHECK does not exist.

Probe clean ⇒ **the AFK branch applies**; no operator disposition is needed and no row is repaired.

### The legal map, derived from the writers

Every pair below was confirmed against the service that writes it, not against the PRD. "Persisted"
means a writer sets `tickets.status` to that value; "ladder-only" means the code writes the state as
a `ticket_events` row or reads it in a filter, but never persists it on the ticket (a real finding —
see below).

| status | TROUBLESHOOT | INSTALL | RECOVERY | writer |
|---|:--:|:--:|:--:|---|
| `OPEN` | ✔ | | | `ticket-creation.service.ts:126-129` (create) |
| `SUBMITTED` | ladder-only | | | `non-operational.service.ts:48-53` in-flight filter; no writer |
| `VERIFICATION_PENDING` | ✔ | | | `troubleshoot-submission.service.ts:263-265` |
| `ESCALATED` | ✔ | | | `repeat-escalation.service.ts:59-61`; `verification.service.ts:113-115` (fraud) |
| `FAILED_VERIFICATION` | ✔ | | | `verification.service.ts:367,377-379` (finalize) |
| `CLOSED_AUTO_RECOVERY` | ✔ | | | `auto-recovery.service.ts:307-310`; `verification.service.ts:174-176` |
| `REQUESTED` | | ✔ | ✔ | `install.service.ts:239-242`; `non-operational.service.ts:462-465` |
| `SCHEDULED` | | ✔ | ✔ | `install-lifecycle.service.ts:104`; `recovery.service.ts:99-100,217` |
| `ON_SITE` | | ✔ | ✔ | `install-lifecycle.service.ts:113`; `recovery.service.ts:109` |
| `FITTED` | | ladder-only | | `install-lifecycle.service.ts:141` writes the **event**; the row goes straight to `ACTIVATED` (:145) |
| `ACTIVATED` | | ✔ | | `install-lifecycle.service.ts:145` |
| `FAILED_ACTIVATION` | | ✔ | | `install-lifecycle.service.ts:253` |
| `COLLECTED` | | | ✔ | `recovery.service.ts:127` |
| `RECEIVED_AT_WAREHOUSE` | | | ladder-only | `recovery.service.ts:155` writes the **event**; :158 closes the row `CLOSED` in the same tx |
| `FAILED_RECOVERY` | | | ✔ | `recovery.service.ts:234` (`closeFailedRecovery`) |
| `CLOSED` | ✔ | ✔ | ✔ | `verification.service.ts` finalize; `install-lifecycle.service.ts:242`; `recovery.service.ts:158,258`; and work-type-blind: `device-departure.service.ts:299-302`, `plant-deactivation.service.ts:185-188` |
| `CLOSED_NON_OPERATIONAL` | ✔ | allowed | allowed | `non-operational.service.ts:403-406` |

Three rulings the table records, so the CHECK is not mistaken for stricter or looser than it is:

1. **`SUBMITTED`, `FITTED` and `RECEIVED_AT_WAREHOUSE` are written by no writer** — they exist on the
   lifecycle timeline (`ticket_events`) and in read filters only. They are kept in the map, each on
   the single ladder its own code belongs to, because the constraint's job (CB-12) is to couple a
   status to a **work type**, not to enforce transition order. Excluding them would make the CHECK an
   ordering rule the issue does not ask for, and would 500 the first slice that persists one.
2. **`CLOSED_NON_OPERATIONAL` is allowed on all three work types even though only TROUBLESHOOT can
   reach it today.** `non-operational.service.ts` selects `IN_FLIGHT_TICKET_STATES` =
   OPEN/SUBMITTED/VERIFICATION_PENDING/ESCALATED, all TROUBLESHOOT-only, so an INSTALL or RECOVERY
   ticket is never closed this way. It is a device-left-service closure, of the same family as
   `CLOSED`, which departure and deactivation already write work-type-blind; widening that in-flight
   list is a plausible next slice and must not be a 500.
3. **`ESCALATED` and `CLOSED_AUTO_RECOVERY` stay TROUBLESHOOT-only.** Both hang off the failure-cycle
   machinery, which exists only on TROUBLESHOOT. `recovery.service.ts:243` (`escalateToOh`) is the
   near-miss: it transitions to `ticket.status` — the ticket's **own** state, unchanged — so it never
   produces RECOVERY/ESCALATED.

### Fixtures the map contradicts (no writer does)

Four existing test fixtures construct pairs no writer can produce. Each was corrected to a
representable pair with its assertion intact — recorded here because they are the only places in the
repo the map had to change anything, and because a fixture that seeds an unreachable state is itself
a small finding. Two were found by a static sweep of `ticket.create` calls; the other two only
surfaced when the full suite ran against the landed CHECK, which is why the suite is the assertion
the issue asks for and a scan is not.

| fixture | seeded | now | why the assertion is unchanged |
|---|---|---|---|
| `test/terminal-status-no-reclose.e2e-spec.ts` | TROUBLESHOOT at `FAILED_ACTIVATION` / `RECEIVED_AT_WAREHOUSE` (#308's terminal-vocabulary cases) | the work type each status belongs to (INSTALL / RECOVERY), cycle link kept | the guard under test reads `status` alone, and the live cycle it must still end is reached through `tickets.failure_cycle_id`, which every row keeps |
| `test/dashboard-activity-trend.e2e-spec.ts` | INSTALL at `OPEN` | INSTALL at `REQUESTED` | the trend query groups on `created_at` + `work_type` and never reads `status` |
| `test/report-mix-outcomes.e2e-spec.ts` | all three work types flat at `OPEN` | each in the status its own creator writes | `workTypeMix` counts over `created_at` + `work_type` only |
| `test/special-ticket-derivation.e2e-spec.ts` | INSTALL at `OPEN` | INSTALL at `REQUESTED` | see the note below — the case still holds, and what it isolates changes |

One consequence worth recording rather than burying: `special-ticket.query.ts`'s Special predicate is
`work_type = 'TROUBLESHOOT' AND status = 'OPEN' AND …`, and the `work_type` clause is documented there
as a deliberate narrowing. With the CHECK landed, `OPEN` is reachable only by TROUBLESHOOT, so that
clause is now **provably implied** by the status clause. It was left in place — this issue changes no
source outside the migration and the schema comment, and defence in depth against a future map change
is cheap — but the spec's INSTALL case no longer isolates it, and its docblock now says so.

## Acceptance criteria

- [x] AC1 — the probe exists, runs read-only, and its result is recorded in this issue before any
      DDL.
- [x] AC2 — after landing, the DB rejects any (work_type, status) pair outside the recorded map.
- [x] AC3 — the schema comment describes the constraint that actually exists.

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

308 (guards first, then the backstop)
