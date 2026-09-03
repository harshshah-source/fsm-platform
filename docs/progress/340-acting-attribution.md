# 340 — Acting attribution: the eleven null sites, two column overloads, and the backup-share report

**Done 2026-09-03.** Wave 1 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids AA-02, AA-03 and the CZ-03
residual, and closing **#318**. Red-first.

## What it closes

`acted_as_role` was non-null on **1 of 34,758** audit rows. Not because acting was rare — #339 had
just made the acting claim provable, and the guard puts a resolved `request.acting` on every request
— but because eleven controller doors threw it away by hand:

```ts
{ userId: user.user_id, role: user.role, actedAsRole: null }
```

Three lines that look complete. Every write those doors made while a CSM or Operations Head was
covering a zone was recorded as the caller's own role, which is the one case the column exists to
distinguish. #339 made the claim *true*; this slice makes it *recorded*.

And the column it feeds was carrying two other meanings at once, so even the attribution that did
survive could not be read:

- **`bulk-unassign.service.ts` wrote the rebalance's *target* zone into `acting_zone`** with no
  `acted_as_role` at all (named in the issue).
- **`vehicle-unavailability.service.ts` wrote `actor.zoneId` — the caller's *home* zone — into the
  same column** (**not** named in the issue; found by reading the code).

`csmBackupShareByZone` reads any non-null `acting_zone` as "a manager was standing in for this zone's
ZM". So every pan-India rebalance and every ordinary VU decision entered that report's **denominator**
and never its numerator. The CSM share it printed was a real number divided by the wrong total,
understated worst in exactly the zones an Operations Head works hardest — and it was the only reader
of the attribution this slice restores.

## The shape of the fix

**One object per door, not a near-copy.** The eleven doors take `@CurrentActor()` and hand the
resulting `RequestActor` straight to their service. The copying *was* the defect: a hand-built subset
is where a field goes missing, and it went missing eleven times.

To make that possible, `RequestActor` gained the caller's own **`zoneId`**. Four module actor types
(`LeaveActor`, `CrossZoneActor`, `VuActor`, `AvailabilityActor`) require it, and without it a door
would still have had to inject both decorators and re-copy fields — reintroducing the exact shape
that lost the attribution.

## Decisions worth keeping

**1. `zoneId` is the claims value verbatim, and acting does not narrow it.** `actingZone` and
`zoneId` are different questions — *which zone's ZM duty is this write being made under* versus
*which zone does the caller belong to* — and several write doors use the second to decide what they
may touch. Folding acting into it here would have changed **permissions** under cover of an
attribution fix, silently, in a slice whose tests are all about audit rows. Whether acting should
narrow a write door is **#341**, which is the next slice and now unblocked. The controllers keep
passing `{ role: user.role, zoneId: user.zone_id }` as the scope argument, with a comment at each
site saying so.

**2. The issue named one column overload; the code had two.** The standing instruction for this run
is to verify every survey finding against the current code rather than implement the report, and this
is what that buys. Bulk unassign's target zone and vehicle-unavailability's home zone are the same
defect pointing in opposite directions, and only one of them was on the list. The lesson for the rest
of the backlog: `acting_zone` is a column three different writers found convenient — look for the
pattern, not the site.

**3. The target zone moves to `entity_id`, not to a new metadata key.** The issue proposed "own
metadata key for the target zone". `entity_type = 'zones'` / `entity_id` already carried it — on
**every row ever written**, not just new ones. So `history()` reads it back from there and is correct
on pre-fix rows with **nothing backfilled and no migration**. A new metadata key would have needed
either a backfill or a dual read for the life of the table.

**4. Both halves of the report fix are kept, and they do different jobs.** Fixing the producers
corrects the rows that exist. Adding `actedAsRole IS NOT NULL` to the query is what stops the *next*
writer who finds `acting_zone` convenient from corrupting the number again. Either alone makes this
month's figure right; only both make the column mean one thing. The read-side filter also states the
rule positively: a row is a backup action **because it names the role that acted**, not because it
happens to name a zone.

**5. The five services behind those doors now stamp `acting_zone` as well as `acted_as_role`.**
`auto-recovery`, `cross-zone-escalation`, `device`, `se-availability` and `override` each wrote the
role and dropped the zone. Stamping only the role would have satisfied a naive reading of AC2 while
leaving the attribution invisible to its one reader — so every assertion in this slice checks the
**pair**.

**6. Two doors already had the actor and still lost the zone.** `batches.controller.ts` and
`vehicle-unavailability.controller.ts` injected `@CurrentActor()` and then rebuilt the object
field-by-field, copying `actedAsRole` and not `actingZone`. They are the same defect as the eleven,
one step further along, and they are the reason the fix is "pass the actor whole" rather than "copy
one more field".

**7. AC1 is pinned statically, over comment-stripped source, with its two exceptions named.** The
defect is *copyable* — the next controller written by copy-paste reintroduces it — so a per-door e2e
catches the doors that exist and this catches the twelfth. `auth/acting-context.ts` and
`common/guards/acting-context.guard.ts` build the **non-acting** context, where `actedAsRole: null`
is the meaning rather than an omission; they are listed by name, not pattern-excluded, so a third
occurrence cannot hide behind a loose rule. Comments are stripped before matching because several of
the files that fixed the defect now discuss it in prose — and because a real one must not be able to
hide behind a `//`.

## What was tested, and why in that shape

**AC2 is a *pair* of roles, deliberately.** A CSM acting and an Operations Head acting reach the gate
by two different routes — the CSM only because #339's cascade named them, the OH unconditionally by
pan-India authority — and only the first route existed in the old code's imagination. Running the
same write down both is what distinguishes "attribution is wired" from "the CSM path happens to
work". The door chosen (`POST /api/tickets/:id/auto-recovery-close`) is the only one of the eleven a
CSM and an OH may **both** call, so the same write really is the same write.

**A third case asserts the columns still mean "acting".** The same door, same caller, no header:
`acted_as_role` and `acting_zone` must both stay null. Without it, an implementation that stamped
attribution from the caller's own role would pass the first two tests, and every row in the table
would then look like a backup action — the report reading 100 % everywhere instead of understating.

**AC3 is pinned on both sides, in two files.** The write half lives in `bulk-unassign-history`, which
already asserted that `history()` names the zone — so the same test now proves the zone survived the
move to `entity_id` *and* that `acting_zone` is left alone. The read half lives in
`csm-backup-report`, where a row shaped exactly like bulk unassign's must not change the share
(66.7 %, not the 40 % it would become) and must not conjure a zone of its own.

## Acceptance criteria

- **AC1** — met. No controller contains the literal; outside the controllers only the two non-acting
  fallbacks do. `acting-attribution-pin.spec.ts` (red first: 7 controller files, 11 sites).
- **AC2** — met. CSM-acting and OH-acting rows both carry `acted_as_role` **and** `acting_zone`; a
  non-acting write carries neither. `acting-attribution.e2e-spec.ts`.
- **AC3** — met, on both sides. Bulk-unassign rows no longer write `acting_zone`
  (`bulk-unassign-history`), and a zone-stamped row with no acting role is excluded from the report
  (`csm-backup-report`).
- **AC4** — met. The per-zone share is acting rows only, over a seeded period. `csm-backup-report`.

## Tests, verbatim

New: `acting-attribution-pin.spec.ts` (2), `acting-attribution.e2e-spec.ts` (3); extended
`csm-backup-report` (+2) and `bulk-unassign-history` (+1 block) — **10 tests, 4 files, all passing**.

Regression, as run: cross-zone / auto-recovery / leave-request / bulk-unassign / role-backup /
request-actor-attribution → **13 files**; intraday / batch-override / devices /
vehicle-unavailability / se-availability / engineers / tickets → **17 files**; acting-context /
dashboard-acting-scope / assign-batch-acting-scope / audit-trail / schedules-route-conflicts /
removal-reason / terminal-status / engineer-admin / install-lifecycle / recovery-lifecycle / voucher
→ **11 files**. All green. `npx tsc --noEmit` exit 0.

**Full backend suite — 463 files / 2494 tests: 458 passed, 3 skipped, 2 files failed, and neither
failure was in this slice's blast radius.** One was #339's (`manager-scope.spec.ts`, still calling the
pre-guard signature — see that slice's report); one was #336's (`shared-auth-se-fixture-guard` flagging
`dev-fixture-seed.e2e-spec.ts`'s rolled-back `engineerMaster.deleteMany`, resolved with the guard's own
documented `shared-auth-se-guard-ok` opt-out, which is the right answer because a static scan cannot
see that the transaction is discarded). Both fixed in test files only — no source changed — and both
re-run green. Everything #340 touched passed on the first clean run.

Existing specs updated, and why: `bulk-unassign-execute` and `bulk-unassign` queried their audit rows
**by `acting_zone`** — six call sites. That they had to change is itself the evidence the column was
doing double duty; they now query `entity_id`. Roughly twenty `RequestActor` fixtures across `test/`
gained `zoneId: null`, mechanically, because the field is now required.

## Follow-ups this slice does not own

- **#341** — acting *scope*: whether a manager write door narrows to the acting zone (~60 sites, 20
  controllers). Unblocked by this slice and #339. Every "the scope stays the caller's own" comment
  added here marks a site it will revisit.
- **Pre-existing `acting_zone` rows** are not backfilled. Old bulk-unassign and VU rows still carry a
  zone with no acting role; the report's new filter is what makes them harmless, which is the reason
  the filter is kept alongside the producer fixes rather than instead of them.
