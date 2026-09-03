# 352 — Field component wire contract: component identity + consumed parts

**Done 2026-09-03.** Wave 3 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids **TKT-02, INV-G8, TKT-04**, and
closing the **troubleshoot half of #174** (class-validator DTO on the SE's submit) and the **catalog
half of #173** (`GET /api/components`). Red-first. Depends on #336 (dev seed fixtures). Unlocks **#353**
and **#366**.

## What it closes

Two breaks in one submission path, and between them the entire component workflow never started.

**(a) Component-unavailable answered 500.** `troubleshooting_submissions` carries the CHECK constraint
`ts_submissions_component_unavailable_item` (`prisma/migrations/20260623150000_…/migration.sql:51-52`):
`component_unavailable_item` must be present whenever `component_unavailable` is true. The controller
passed a hard `null` (`troubleshoot.controller.ts:64-65`) and the shared DTO documented the field as
"not sent by this build". So every component-unavailable report from the field died at the database
with a sanitized 500 — no `component_requests` row, an empty Warehouse Manager queue, and nothing in
the response telling the SE what to do differently.

**(b) Consumed parts were never sent.** `TroubleshootSubmitRequest` had no `consumedComponents`. The
service has had the consumption loop and `decrementStock` since Issue 24, and `handleConflict` has had
the SHADOW_USE loop for as long — none of it was reachable over HTTP. Van stock never depleted, no
`inventory_transactions` were written, the Common Kit was permanently complete, Component-Blocked never
fired, and `shadowUseRecorded` was permanently `false` (TKT-04).

Both halves were verified against the working tree before building: the `file:line` citations in the
issue were accurate, and the service-side loops were present and correct exactly as described. The one
place the brief's premise did not survive contact with the code is the catalog — see Decision 5.

## The shape of the fix

The contract is now three things: two request fields, a catalog to populate them from, and a named
vocabulary for every way they can be wrong.

```
componentUnavailableItem?: string            // required-when componentUnavailable === true
consumedComponents?: { componentId: string, qty: number }[]
GET /api/components -> ComponentCatalogItem[]
```

| Code | Status | Meaning |
| --- | --- | --- |
| `COMPONENT_ITEM_REQUIRED` | 400 | `componentUnavailable: true` with no item — was a CHECK-constraint 500 |
| `UNKNOWN_COMPONENT` | 400 | an id naming no `component_master` row, on either field — was an FK 500 (or a `BigInt()` `SyntaxError` 500 for a non-numeric id) |
| `INSUFFICIENT_VAN_STOCK` | 409 | the van does not carry what the form says was fitted — was a silent floor-at-zero |

`TroubleshootSubmitDto` (`src/ticketing/dto/troubleshoot-submit.dto.ts`) is the #174 half: the handler
took an *interface*, and the global `ValidationPipe` skips interface-typed bodies by design, so the SE's
most consequential write validated nothing below two hand-rolled presence checks.

## Decisions worth keeping

**1. The refusals are service outcomes, not controller exceptions.** `SubmitOutcome` gained
`COMPONENT_ITEM_REQUIRED`, `UNKNOWN_COMPONENT` and `INSUFFICIENT_VAN_STOCK`, and the controller maps
them. The alternative — validating in the controller only — would have left every direct caller of
`TroubleshootSubmissionService.submit` (the resubmit path, a dozen specs, whatever calls it next) able
to walk into the same CHECK constraint. The service must refuse it however it was called; the controller
only chooses the status code.

**2. Identity is checked before the conflict branch; sufficiency is checked after it.** They point in
opposite directions on purpose.

*Identity* has to come first because `handleConflict` writes SHADOW_USE rows against
`component_master` — an id naming no catalog row is an FK violation (a 500) on the conflict path just
as on the happy path. A bad id is a stale picker cache whichever way the race went.

*Sufficiency* deliberately does **not** pre-empt the conflict. On that path the parts are already
fitted; the SE fitted them before learning they had lost the race. The answer they need is who won, and
the ledger's job is to record physical reality — so shadow use still books (floored at zero, as it
always has) and the 409 stays `TICKET_ALREADY_CLOSED`. Refusing there would lose the reconciliation row
the warehouse actually needs, to protect a number that is already wrong. Both directions are pinned in
`shadow-use-conflict.e2e-spec.ts`.

**3. An untracked component passes; a tracked-and-short one is refused.** A component with no
`se_van_stock` row at all is "inventory not yet tracked" — the same seam default `commonKitStatus`
already takes ("don't ground an SE on a data gap"). Van stock is seeded per zone as the warehouse rolls
out, and losing a real visit's whole record to protect a number nobody is keeping yet is the worse
failure. A *tracked* van short of the claim is a different thing — a mis-pick or a typo — and it is
refused. Both edges are pinned in `inventory-rollback.e2e-spec.ts`.

The sufficiency read is outside the transaction. The van has exactly one holder and the mobile client
submits one form at a time, so the read-then-write window is not a race this build needs to close;
`decrementStock`'s floor-at-zero remains the backstop.

**4. Parts fitted on a component-unavailable visit now reach the ledger too.** The consumption loop ran
only on the normal path. But "one component was unavailable" is not "nothing was fitted" — the SE
routinely replaces two parts and finds the third missing, which is the whole reason the branch exists.
Dropping those two would leave the van's book value permanently above its physical contents, and #353
is about to reconcile that ledger. The rows are `PRE_VERIFICATION` like any other consumption and
resolve at the eventual verification, which keys on the **ticket** (`verification.service.ts:401`) —
and the resubmit that follows the part's arrival closes that same ticket. The loop is now one private
method called from both branches.

**5. `GET /api/components` returns the whole catalog, because there is no `active` column.** The brief
asked for "active rows". `component_master` has `name`, `category` and `serial_tracked` and nothing
else (`schema.prisma:1319`). Adding a flag would mean editing `prisma/schema.prisma`, which another
agent owns this round, and filtering on a proxy would be a guess. So the catalog is returned whole and
"how is a part retired" is filed as a follow-up rather than invented. **This is a place the issue's
premise did not match the code.**

**6. The catalog is readable by every authenticated role.** The SE needs it to name the part their form
is about; the WM needs it to read a request; the ZM sees component names on the Component-Blocked
Queue. It is reference data with no zone, no owner and nothing confidential — a list of part names — so
scoping it would only mean clients holding partial catalogs and rendering bare ids. It is read-only:
editing the catalog is warehouse master-data work no surface asks for yet, and when it lands it is a
manager write door that takes `@CurrentScope()`/`@CurrentActor()` (#341).

**7. The DTO validates shape; the named codes stay in the controller.** `clientSubmissionId`,
`rootCauseCategory` and `componentUnavailableItem` are all `@IsOptional()` in the DTO even though two
are required and the third is required-when. That is the house rule (`override-command.dto.ts`,
`ops-explorer.dto.ts`) and here it is load-bearing: this route's contract is a `{ code }` body that the
mobile client reads verbatim (`apps/mobile/src/api/client.ts` — `throw new Error(code)`). An
`@IsNotEmpty()` would win the race and answer `{ message: ["clientSubmissionId should not be empty"] }`
instead, replacing a sentence the SE can act on with a validator's field name. Presence is the
controller's answer to give; *type* is the pipe's — which is what closes the `seGps: { lat: 'north' }`
→ Prisma-500 hole in the same stroke.

**8. A malformed id and an unknown id get the same code.** `BigInt('antenna')` is a `SyntaxError`, and
was a 500. Both cases are one problem told twice — a picker working from a stale or invented catalog —
so `parseComponentId` answers `UNKNOWN_COMPONENT` for the malformed one rather than adding a shape
error the client would have to handle separately.

## What was tested, and why in that shape

The defect is a **wire** defect: the service half has been correct since Issue 24 and unreachable. So
the AC1–AC4 walk is driven over HTTP in `troubleshoot-controller.e2e-spec.ts` — submit → van stock →
Common Kit → Component-Blocked Queue → WM request queue — and the service specs take only the decisions
that are invisible from the wire (where validation sits relative to the conflict branch; what an
untracked component does).

AC3's walk runs in a **zone of its own**, stocked to the *seeded* Common Kit's minimums
(`org-seed.ts` — Cable 1, SIM 1, Antenna 1, Fuse 2) rather than creating a kit definition.
`common_kit_definition` is global: a spec that adds an active row to it grounds every other SE in the
database for as long as it runs. Using the kit that is already configured makes the walk both safer and
truer.

Every stock-mutating case runs as an SE the file mints and owns — `se.north@fsm.test`'s van stock is
shared across sixteen specs.

**Red evidence.** With `consumedComponents` neutered in the controller (one line) the #352 set was
**5 failed / 9 passed**: both AC2 ledger cases, the shadow-use case, the `INSUFFICIENT_VAN_STOCK` case
and the whole AC3 walk. The `COMPONENT_ITEM_REQUIRED` cases stayed green under that neuter precisely
because Decision 1 put the check in the service, which is the point.

## Acceptance criteria

- **AC1** — met. Component-unavailable with an item → 201 and a `component_requests` row carrying the
  component (ticket stays OPEN per ADR-0008); without an item → 400 `COMPONENT_ITEM_REQUIRED` with no
  submission, no request and an untouched SLA pause. An id outside the catalog, numeric or not → 400
  `UNKNOWN_COMPONENT`.
- **AC2** — met. `consumedComponents` decrements `se_van_stock` and writes `TICKET_CONSUMPTION` /
  `PRE_VERIFICATION` rows; the Business-409 path books SHADOW_USE against the losing SE and answers
  `shadowUseRecorded: true` (permanently `false` before this slice).
- **AC3** — met. A consumption that empties a kit item flips `commonKit.complete` on
  `GET /api/me/van-stock`, and the next Recommender run leaves the ticket unassignable and writes a
  `component_blocked_queue` row naming the part.
- **AC4** — met. `GET /api/components` returns the catalog to an SE and to a manager, and 401s
  unauthenticated. (Whole catalog — see Decision 5.)
- **AC5** — met. A submission carrying neither new field raises no request, writes no ledger row, moves
  no stock, and still goes VERIFICATION_PENDING.

## Tests, verbatim

- `test/troubleshoot-controller.e2e-spec.ts` — **19 tests** (5 pre-existing + 14 new: AC1 ×4, AC2 ×5,
  AC3 ×1, AC4 ×3, AC5 ×1).
- `test/component-request-raise.e2e-spec.ts` — **6 tests** (3 pre-existing + 3 new).
- `test/shadow-use-conflict.e2e-spec.ts` — **5 tests** (3 pre-existing + 2 new).
- `test/inventory-rollback.e2e-spec.ts` — **4 tests** (2 pre-existing + 2 new).

**The four owned specs → 4 files / 34 tests, all passing.**

**Regression batch → 22 files / 114 tests, all passing** (12 files / 69 tests + 10 files / 45 tests,
two locked runs): `me-ticket-forms-controller`,
`ticket-forms-read`, `troubleshoot-submission`, `component-request-resubmit`, `verification-controller`,
`me-work-history`, `closure-clears-assignment`, `vu-approval-lifecycle`, `ticket-waiting-component`,
`recommender-common-kit`, `inventory-service`, `acting-scope-route-sweep`, `global-guard-validation`,
`component-request-controller`, `component-blocked-controller`, `me-component-requests-controller`,
`shadow-use-queue`, `recommender-waiting-component`, `waiting-component-escalation`,
`component-request-warehouse`, `component-request-oversight`, `dev-fixture-seed`. (Two cross-file
flakes appeared once each and did not reproduce: the #271 VU-fold case in `troubleshoot-submission`
— unrelated to components, green in isolation and on re-run — and a vitest "Worker exited
unexpectedly" in the second batch, green on re-run.)

`npx tsc --noEmit` (backend) clean for every file in this slice; `npx tsc -b` (admin) and
`npx tsc --noEmit` (mobile) → exit 0. No migration, so the Prisma drift gate was not involved.

## Deliberately not built

**Mobile form changes are out of scope by the slice's own terms.** `TroubleshootFormScreen` still sends
neither field, and `apiSubmitTroubleshoot` needs no change to send them — the contract is ready for the
app, not consumed by it. The picker that turns `GET /api/components` into a `componentId` is the mobile
half of #173 and stays there. Nothing about this is a parity-gate deferral: the slice has no UI
acceptance criteria (issue §UI surfaces: `n/a`).

## Follow-ups this slice does not own

- **Retiring a catalog part.** `component_master` has no `active` column, so `GET /api/components`
  cannot hide a discontinued part and the picker will offer it forever. Needs a schema change
  (owned elsewhere this round) plus a WM-facing write door.
- **The mobile component picker** — the remaining half of #173.
- **The rest of #174** — `actionTakenCategory` is still an unvalidated free string
  (#172 Decision 8); this slice DTO'd the troubleshoot body but did not enumerate that field.
- **Concurrent van-stock writes.** Sufficiency is read outside the transaction (Decision 3). If van
  stock ever gains a second writer — a warehouse issue posted while the SE is submitting — the check
  wants moving inside the transaction with a row lock.
- **A `component_requests` row still allows `componentId: null`** for historical rows; the raise path
  can no longer create one, but the column is nullable and readers must still cope.
