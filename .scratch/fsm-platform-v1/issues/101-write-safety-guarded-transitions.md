# 101 — Write-safety: `transitionOrConflict` helper + guarded state transitions across state machines
Status: partial (2026-07-09, commit `9940534`, TDD) — AC#1 landed: the shared `transitionOrConflict`
primitive (`src/common/transition-or-conflict.ts`, guarded `updateMany` + count → `{won}`), unit-tested.
Applied to the **intraday accept-vs-timeout** site (the first race that fires once dispatch runs
unattended): `accept` claims PENDING_ACCEPTANCE→ACCEPTED guarded by its own offer before assigning;
`reroute` (timeout/decline) claims on status+offeredSeId+retryCount and NO-OPs on loss; migration
`20260709120000` adds the one-live-offer-per-ticket partial unique (`fireForZone` treats P2002 as a skip).
Concurrency e2e proves exactly one winner + no double assignment.
**Still open** (this issue stays partial): troubleshoot-submission vs auto-recovery, two-SE double-submit +
van-stock `qty { decrement }` + `CHECK (qty >= 0)` + shadow-use `clientSubmissionId` persistence, non-op
dual-confirm, overlapping verification sweeps, `component-request.confirmResubmit`, and the lower-blast
members — each adopts the now-existing helper.
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

## Comments

### 2026-07-28 — mobile-readiness verification (docs/status/backend-mobile-readiness-plan-2026-07-28.md §A-§3)

Both headline sub-findings re-confirmed at line level (shadow-use key persistence:
`troubleshoot-submission.service.ts:107→116→276-301`; non-atomic decrement `:315-320`).
**Reachability correction (N7):** the decrement paths are currently UNREACHABLE via HTTP —
`consumedComponents` exists only on the service input (`:37`); `TroubleshootBody`
(`troubleshoot.controller.ts:32-44`) has no such field and no caller passes it. Armed, not firing.
**Hard sequencing consequence: this issue's persist-key-on-CONFLICT + atomic-decrement ACs must
land before #82 (sync batch) or issue 21 wire the consumed-components leg** — both plan exactly
that; #82's DUPLICATE guarantee is unsatisfiable on the CONFLICT path until then (noted in #82).

Two sites added to the open list:
- `confirmReceipt` status-unguarded two-step (`component-request.service.ts:177-183`) — same family
  as the already-listed `confirmResubmit`; move status into the update WHERE (transitionOrConflict).
  (Its missing *ownership* check is #162's, not this issue's.)
- Vouchers concurrent duplicate: check-then-create (`vouchers.service.ts:157-178`) with no P2002
  catch — a concurrent same-key pair returns 500 instead of DUPLICATE. Catch → re-read → DUPLICATE.

Client-facing retry *contract* work (keys on VU/leave/availability, already-done replay,
`alreadyDone` 409 discriminator) is deliberately split out as **#164** — this issue stays
server-side race guards.
