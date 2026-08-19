# #241 — Assignment removal-cause: `removal_reason`, writer stamps, backfill, indexes

**Done 2026-08-19.** Backend + migration. The schema foundation for recycling (#242), the dev-data
cleanup (#243), and Special attempt counting (#244) — none of which can recover the distinction
after the fact, which is why it lands before all three.

## What was wrong

`batch_assignment_tickets` recorded only **when** a row stopped being live (`removed_at`) and **by
whom** (`removed_by`). That second column looks like it answers "human or system", but it does not:
`removed_by IS NULL` is **already auto-recovery's signature** (`auto-recovery.service.ts:303-306`;
1,092 rows in the dev mirror), so it can carry exactly one system path and cannot be overloaded
further. Nothing recorded *why* — and #242/#243/#244 each key on that.

Two paths ended an assignment **without touching the assignment row at all**:

- **Device departure** (`device-departure.service.ts`) and **plant deactivation**
  (`plant-deactivation.service.ts`) close the ticket and terminate the failure cycle, leaving the
  batch row live — **3,310 such rows** in the dev mirror, 20 on ACTIVE schedules.
- **`ComponentRequestService.confirmResubmit`** flips the ticket to `UNASSIGNED` on component
  arrival, leaving the batch row live.

Both are the same defect, and it is a field-visible one rather than bookkeeping: **every day-plan
read filters on `removed_at IS NULL` and *not* on ticket status** (`me-tickets-query.service.ts:50`,
`day-plan-query.service.ts:48`, the ZM schedule view, the transparency reads). So a cancelled
ticket kept rendering on the SE's day plan as work to do — a truck roll to a device that had left
the fleet or a plant the business had just switched off. Neither path had a test that looked at the
assignment row; each asserted only the thing it *did* change, which is how both survived.

Index reality: only `(batch_id)` plus the live-row partial unique `(ticket_id) WHERE removed_at IS
NULL` — which a **history** read (removed rows included) cannot use — and `soft_states` carried only
`(se_id, resolved_at)`, which serves the SE's live view, not a per-ticket time join.

## What was built

**`src/scheduling/removal-reason.ts`** — the closed vocabulary as one exported constant set plus a
derived union type. TEXT in the database rather than a Postgres enum **on purpose**: #242/#243/#246
add members without another schema migration, and the discipline lives in one importable place. The
reason is read as a *predicate* (#244 counts attempts by end cause), so free text would let a typo
silently reclassify an operational decision instead of showing up as a visible mistake.

Twelve members: `ZM_WITHDRAWN · ZM_DEFERRED · REASSIGNED · BULK_UNASSIGNED · AUTO_RECOVERY ·
TICKET_CANCELLED · COMPONENT_WAIT · PLAN_EXPIRED (#242) · VEHICLE_UNAVAILABLE (#246) ·
RESOLVED_AT_CLOSURE (#242) · DEV_CLEANUP (#243) · HUMAN_REMOVED (backfill only)`. The four with no
writer yet are defined now because they are the shared contract the later slices are specified
against; each is annotated with the slice that will write it.

**Migration `20260819120000_assignment_removal_reason`** — nullable `removal_reason TEXT`; an
idempotent backfill (`WHERE removal_reason IS NULL`, so replay is a no-op); plain index
`batch_assignment_tickets (ticket_id)`; index `soft_states (ticket_id, set_at)`.

Only two causes are recoverable from the old columns, and that is enough. `removed_by IS NULL` →
`AUTO_RECOVERY`; otherwise a human acted, and a deferral is the one human action that left its own
evidence (`deferred_to_date`) → `ZM_DEFERRED`; everything else → `HUMAN_REMOVED`. Withdraw /
reassign-source / bulk are **not** separable retroactively and do not need to be — #244 excludes all
three from attempt counting identically, so the distinction would decide nothing.

**Seven writers stamp**, five existing and two newly symmetric:

| Writer | Reason |
|---|---|
| `override.service.ts` `removeTicket` | `ZM_WITHDRAWN` |
| `override.service.ts` `deferTicket` | `ZM_DEFERRED` |
| `override.service.ts` `moveTickets` (source row) | `REASSIGNED` |
| `bulk-unassign.service.ts` | `BULK_UNASSIGNED` |
| `auto-recovery.service.ts` | `AUTO_RECOVERY` |
| `device-departure.service.ts` **(new)** | `TICKET_CANCELLED` |
| `plant-deactivation.service.ts` **(new)** | `TICKET_CANCELLED` |
| `component-request.service.ts` **(new)** | `COMPONENT_WAIT` |

Each new stamp writes inside the **same transaction** that closes/unassigns the ticket, with
`removed_by NULL` — no human withdrew these.

## Slices (RED → GREEN)

Honest ordering note: the schema, the vocabulary module and the writer stamps were written before
their assertions, because no test can reference a column that does not exist. **Redness was
therefore proven by reverting**, not assumed — each group's implementation was `git stash`ed and the
specs re-run against the pre-change services with the column already present.

### Slice 1 — AC-1 + AC-6: the five existing writers

Assertions were added to the spec that already exercises each writer, rather than to a new file —
the reason belongs next to the behaviour that produces it.

- **RED** (implementation stashed): `expected null to be 'ZM_WITHDRAWN'` ·
  `'ZM_DEFERRED'` · `'REASSIGNED'` · `'AUTO_RECOVERY'` — four specs, four reds.
- **GREEN** — one `removalReason:` field per writer. 5 files / 25 tests green (incl.
  `bulk-unassign-execute.e2e-spec.ts` → `BULK_UNASSIGNED`).
- AC-6 additionally pins `removedBy` **stays NULL** on auto-recovery while the reason now carries the
  cause, so nothing downstream needs to infer "system" from a missing actor again.

### Slice 2 — AC-3 + AC-4: the two leaking paths

New spec `removal-reason-cancellation.e2e-spec.ts`.

- **RED** (implementation stashed): plant deactivation → `expected null not to be null` (the row was
  still **live** after the ticket was cancelled); component arrival → `expected null to be
  'COMPONENT_WAIT'`; device departure → `expected null to be 'TICKET_CANCELLED'`.
- **GREEN** — the three in-transaction stamps.
- Each case asserts the *day-plan predicate itself* (`removedAt: null` returns nothing for that
  ticket) as well as the reason, since that predicate is what every SE-facing read spreads.
- Device departure is driven through `reconcile` on the `SOURCE_STATUS` path with
  `syncedPlantIds: []`, which keeps the absence path inert so the fixture cannot disturb other
  specs' devices in the shared test database.

### Slice 3 — AC-2 + AC-5: the structural guarantees

- AC-2 is asserted **table-wide, not over the fixture**: zero removed rows with a NULL reason, zero
  *live* rows carrying one (the mirror invariant), and every distinct stored value a member of the
  vocabulary. A future writer that forgets to stamp fails here regardless of where it lives.
- AC-5 reads `pg_indexes` for both new indexes.

**REFACTOR** — none.

## Verification

- New spec: `removal-reason-cancellation.e2e-spec.ts` 5/5. Five existing writer specs extended, 25/25.
- `tsc --noEmit` clean.
- Full backend suite: **368 files accounted for, 1746 passed / 2 failed / 5 skipped**. Both failures
  are `voucher-controller.e2e-spec.ts` and are **pre-existing** — proven by stashing every change
  from this session and re-running, which fails identically. One #184 worker crash retried and
  recovered; all files reconciled.

## Applied to the dev database

`prisma migrate deploy` against `fsm` @ `localhost:5433`. Measured before: 16,382 rows, 7,891
removed, **1,092** with a NULL actor — matching the 2026-08-18 audit exactly. After:

| `removal_reason` | rows |
|---|---|
| `HUMAN_REMOVED` | 6,799 |
| `AUTO_RECOVERY` | 1,092 |
| **removed with NULL reason** | **0** |
| **live rows carrying a reason** | **0** |

No `ZM_DEFERRED` rows: no removed row in the ingested mirror carries a `deferred_to_date`. The
per-ticket history query plan is now `Index Scan using batch_assignment_tickets_ticket_id_idx`,
confirmed via `EXPLAIN` on the dev data (AC-5 end to end, not just index existence).

This is **not** #243. Nothing was recycled, unassigned, or state-normalised — the migration only
fills a column that did not exist. #243's cleanup (C1 3,310 · C2 4,684 · C3 1,092) remains HITL and
unexecuted, and now has the `DEV_CLEANUP` marker it depends on.

## Risks / rollback

Column is additive and nullable — rollback is dropping it, plus the two indexes; the backfill is
re-runnable. The departure / deactivation / component stamps are a **behaviour** change and
deliberately so: they fix the live defect of cancelled and pool-returned tickets rendering on SE day
plans. Strictly corrective — the tickets in question were already closed or unassigned.
