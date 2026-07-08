# 101 — Write-safety: `transitionOrConflict` helper + guarded state transitions across state machines
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-03-backend-production-readiness-audit.md` — CRITICAL #3 (+ the
> non-dispatch legs of HIGH #11 and several MEDIUMs of the same family). Verified still-open
> 2026-07-07: no `transitionOrConflict` helper exists; the read → check-in-JS → `update`-by-id idiom
> (no state guard in the WHERE, READ COMMITTED) is intact across the services below.

## What to build

Adopt one shared guarded-transition helper — `transitionOrConflict(tx, model, id, fromStates, data)`
implemented as a guarded `updateMany(where: { id, status: { in: fromStates } })` + count check — and
apply it site-by-site to the confirmed racy state machines, so a losing concurrent writer gets a
clean CONFLICT outcome instead of silently corrupting state. The correct pattern already exists in
this repo (soft-states, failure-cycle I1, snapshot runs); this generalizes it.

Confirmed sites (from the audit's race table — each is a distinct failure mode):

- **SE submit vs auto-recovery** — `troubleshoot-submission.service.ts` + `auto-recovery.service.ts`
  (orphaned submission; PRE_VERIFICATION inventory stuck; or a closed ticket overwritten back to
  VERIFICATION_PENDING).
- **Two SEs submit same ticket** — same files (both pass the OPEN check; both decrement stock).
- **Non-op dual confirmation** — `non-operational.service.ts` (stale write erases the manager's
  confirmation leg; also `closedAt` set while cycle state stays active → device permanently
  P2002-skipped if it re-enters the fleet).
- **Intraday accept vs timeout reroute** — `intraday-insertion.service.ts` (ticket committed to
  timed-out SE A while SE B holds a live offer; both told the CRITICAL ticket is theirs). Add the
  one-live-intraday-offer-per-ticket partial unique (dedupe is a query-time `none` check today).
- **Overlapping verification sweeps** — `verification.service.ts` (FAILED-path rollback
  double-restores van stock; `markAutoRecovery` never resolves PRE_VERIFICATION inventory).
- **`confirmResubmit` re-opens closed cycles** — `component-request.service.ts` (VERIFIED cycle
  forced back to OPEN with `closedAt` set).
- **Van-stock decrement + shadow-use idempotency** — `troubleshoot-submission.service.ts`: replace
  JS `Math.max(0, qty - n)` from a stale read with a guarded `qty: { decrement }` + a
  `CHECK (qty >= 0)`; and **persist `clientSubmissionId` on the CONFLICT path** so a mobile retry
  does not double-decrement stock.

Lower-blast-radius members of the same family (component-request approve/reject double-processing,
leave approve two-commit window, voucher review/markPaid, recovery/install pre-read guards, SLA
pause-accumulator RMW, repeat-escalation overwrite) adopt the same helper opportunistically.

## Acceptance criteria

- [ ] A `transitionOrConflict` helper exists (guarded `updateMany` + count → CONFLICT outcome) and is unit-tested.
- [ ] Each confirmed site above transitions via a state-guarded WHERE; a stale-read writer receives a CONFLICT/outcome instead of corrupting state.
- [ ] Inventory: PRE_VERIFICATION rows are flipped with a guarded `updateMany` before restocking (no double-restore); `qty` uses `{ decrement }` with a `CHECK (qty >= 0)`; over-consumption surfaces rather than being silently floored.
- [ ] `clientSubmissionId` is persisted on the shadow-use CONFLICT path; a duplicate submit is idempotent (no second decrement).
- [ ] Migration adds the one-live-intraday-offer partial unique + the `qty` CHECK; from-zero migrate + existing suite green.
- [ ] New concurrency tests (`Promise.all`) cover: two-SE double-submit, intraday accept-vs-timeout, overlapping verification sweeps — each asserts exactly one winner and no double stock movement.

## UI surfaces
n/a (backend)

## Reference
n/a

## Blocked by
#100 (shares the guarded-transition helper; whichever lands first introduces it).
