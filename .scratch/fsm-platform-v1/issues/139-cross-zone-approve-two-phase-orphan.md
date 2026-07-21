# 139 — Cross-zone `approve` is a two-phase non-atomic commit; a crash strands the escalation PENDING while the ticket is assigned

Status: needs-triage
Type: backend defect (latent — needs a crash in a narrow window)

> Source: `docs/audits/pattern-tracing-audit-2026-07-21.md` **NEW-A4**.

## Pattern

Pattern 2 — a related bookkeeping write (`crossZoneEscalation.update → APPROVED`) sits **outside** the
transaction that carries the primary write (the Formal Assignment). A partial completion leaves durable
inconsistent state that retry cannot heal.

## Where

- `cross-zone/cross-zone-escalation.service.ts:158` calls `override.assignTicket(...)` — its **own**
  atomic tx (`override.service.ts:262-297`) that commits the Formal Assignment (schedule + batch +
  `assignment_state → FORMALLY_ASSIGNED`).
- `cross-zone-escalation.service.ts:162-174` **then**, as a **separate** statement, updates the
  `crossZoneEscalation` row to `APPROVED` (+ target zone / SE / schedule / batch ids).
- No transaction spans the two writes.

## What happens

If the process dies (or the DB connection drops — there is no `statement_timeout`, pipeline R2) **after**
`assignTicket` commits but **before** the `:162` update:

- The ticket is durably `FORMALLY_ASSIGNED` with a schedule + batch.
- The escalation is still `PENDING`.

On retry, `assignTicket` re-reads the ticket, sees `assignmentState === 'FORMALLY_ASSIGNED'` and returns
`ALREADY_ASSIGNED` (`override.service.ts:257`); `approve` maps that to `{ result: 'ALREADY_ASSIGNED' }`
at `:159` and returns **without** updating the escalation. The escalation is now **permanently stuck
PENDING** — it shows in the CSM queue (`listForScope`), the CSM keeps "approving," and every attempt
short-circuits on `ALREADY_ASSIGNED`. It can never reach `APPROVED` through the UI.

## Trigger

A crash / connection drop / statement-cancel in the window between the assignment commit (`:158`) and the
escalation update (`:162`), on the cross-zone approve path.

## Confirmation on the dev DB (2026-07-21)

Read-only (`scratchpad/confirm-findings.cjs`).

- **Smoking-gun query** — open escalation whose ticket is already `FORMALLY_ASSIGNED`:
  `SELECT … FROM cross_zone_escalations cze JOIN tickets t … WHERE cze.status IN ('PENDING','DEFERRED')
  AND t.assignment_state='FORMALLY_ASSIGNED'` → **0 rows**.
- **Counts:** `total escalations = 0, pending = 0, approved = 0` (no cross-zone escalations on dev yet).
- **Triggers on `cross_zone_escalations`:** **none** → nothing in the DB auto-reconciles
  `escalation.status` with the ticket's assignment. The orphan state is representable and unguarded.

**Verdict:** LATENT — the orphan state does not exist on dev today (0 escalations), but nothing prevents
it; it becomes reachable the first time the cross-zone approve path runs and crashes mid-commit.

## Blast / likelihood

- **Blast:** one escalation permanently un-closable through the UI per occurrence; the **ticket itself is
  correctly assigned**, so field work is unaffected — the damage is a stuck decision record + CSM
  confusion. Never self-heals.
- **Likelihood post-activation:** LOW–MED (needs a crash in a narrow window, but the window recurs on
  every approve and the outcome is durable).

## Proposed fix approach (for triage, NOT built here)

Make retry idempotently complete (same family as #126):

1. **Reconcile on retry:** when `assignTicket` returns `ALREADY_ASSIGNED`, have `approve` still transition
   the escalation to `APPROVED` **if** the existing assignment's SE / target match the request (verify via
   the ticket's batch/schedule), rather than bailing at `:159`. This heals any stranded escalation on the
   next click.
2. **Or fold the escalation update into the assignment tx** — pass the escalation write into
   `assignTicket`'s `withAudit` transaction (callback), so the two commit atomically.

## Acceptance criteria (draft — triage owns)

- [ ] A crash simulated between the assignment commit and the escalation update leaves a state that the
      **next** `approve` (or a reconcile) drives to `APPROVED` — no permanently-stuck PENDING.
- [ ] Test: assign the ticket out-of-band, then call `approve` for the same SE/target → escalation ends
      `APPROVED` (idempotent), not `ALREADY_ASSIGNED`-and-stuck.

## Dependencies / notes

- Gated by cross-zone usage (CSM flow). Related: #126 (orphan-state family), pipeline R2 (no
  `statement_timeout` widens the crash window). No fix in this session (audit → triage contract).
