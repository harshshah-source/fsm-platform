# 291 — DECISION RECORD: a Zonal Manager may trigger a dispatch run for their own zone (RBAC reversal)

Status: **APPROVED 2026-08-27** (operator, as part of the Scheduler Console direction). Landed
2026-08-28 as Console Phase 2.1.
Type: HITL · Decision · Backend
Supersedes: the closed position of the `#272` / `#282` RBAC ladder on `POST /schedules/dispatch-run`
Implements: `docs/audits/scheduler-console-implementation-slice-2026-08-27.md` §9 **B3** / §14 **D3**

**This file exists because a role-list edit is not an adequate record of a permission reversal.** The
slice was explicit that the widening *"must be recorded as an explicit reversal in a decision record,
not slipped in as a role-list edit"*, and this is that record.

---

## What changed

`POST /api/schedules/dispatch-run` and `GET /api/schedules/dispatch-run/in-flight` were
`@Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER')`. They are now
`@Roles('OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER', 'ZONAL_MANAGER')`, **with a zone clamp that
lands in the same change.**

## Why the ladder was held closed, and why that reason expired

The ladder `#272`/`#282` built deliberately withheld engine controls from a ZM. The reasoning was
sound while the ZM's surfaces were *reporting* surfaces: a ZM read their zone's plan and escalated;
they did not command the engine.

The Scheduler Console changes that premise. `/dispatch/today` is **the ZM's primary screen**, the
Console's stated purpose includes CONTROL, and the only engine control on it is Run Now. Leaving a ZM
unable to press it makes the Console's own zone-scoped variant the one that cannot do the thing the
Console exists for — and pushes the ZM back to asking a CSM, by phone, to run their zone.

Two supporting facts, both from code:

1. **A ZM already commands the engine indirectly and irreversibly.** They hold six override actions on
   `POST /batches/:id/override` — reassign, swap, split, remove, defer, reorder — each of which commits
   immediately, notifies engineers, and has no undo endpoint. Withholding "re-run the recommender for
   my own zone" from a role that may already rewrite that zone's day plan by hand is not a coherent
   security boundary.
2. **A manual run is not privileged work.** `runForActiveZones` is the same path the 05:00 cron drives,
   with the same admission, the same claim ledger and the same conflict refusal. A ZM pressing Run Now
   causes what would have happened anyway, earlier.

## The clamp — and why it is *ignore*, not *validate*

> **The widening is not approved without all four parts. They are one change.**

The endpoint read its zone straight off the request body and **never compared it to the caller**:

```ts
zoneId: body.zoneId != null ? BigInt(body.zoneId) : undefined
```

That was safe only because both permitted roles were global-scope, for whom "any zone" and "your zone"
are the same permission. **Widened without a clamp, any Zonal Manager could rebuild another manager's
day plans — or omit `zoneId` entirely and trigger a run across every zone in the country.**

| # | Part | Landed |
|---|---|---|
| 1 | Widen `@Roles` on `POST /schedules/dispatch-run` to the three manager roles | ✅ `schedules.controller.ts` |
| 2 | **Clamp:** derive the zone from `@CurrentScope()`; when the caller has a zone of their own, **ignore** `body.zoneId` | ✅ same method |
| 3 | Widen **and clamp** `GET /schedules/dispatch-run/in-flight`, which returned every zone globally | ✅ `inFlightZones(zoneId?)` |
| 4 | Hide the zone picker entirely for a ZM — hide, don't disable | ✅ Console Phase 1.1 |

**Ignore rather than validate, and the distinction is the whole decision.** A validating clamp — 403
when `body.zoneId` disagrees with the caller's zone — is passed trivially by a client that simply
*stops sending the field*, and the no-zone path is pan-India. Deriving the zone from the caller's scope
means **there is no request a ZM can compose that reaches another zone, or reaches all of them.** The
safe behaviour does not depend on the client sending anything in particular.

**`@CurrentScope()`, not the claims.** It folds in `X-Acting-As-Zone`, so a CSM working a zone through
the backup cascade runs *that* zone — matching every read on the deck in front of them. A non-acting
CSM/OH still has `zoneId === null`, so **the pan-India path is untouched for the roles that had it.**

## What was NOT widened

- **`POST /schedules/bulk-unassign`** stays `OPERATIONS_HEAD`-only. It is destructive across a zone or
  the country and has no equivalent in the Console.
- **`GET/PUT /schedules/dispatch-schedule`** (the cron itself) stays OH-only. Reading `nextFireAt` for
  the three manager roles is a separate, read-only widening (slice §9 B2) and is not this record.
- **Scoring weights, thresholds and engine configuration** are untouched. Nothing here lets a ZM change
  what a run decides — only *when* their own zone's run happens.

## Blast radius, stated

A ZM can now cause, for their own zone only: a `dispatch_runs` ledger row with `trigger = MANUAL` and
their user id; day plans for work that is still `OPEN` **and** `UNASSIGNED`; and **push notifications to
their engineers' phones**, mid-shift if it is mid-shift. The Console's confirm dialog states the
notification consequence before the button commits, and the run is refused with a populated 409 if one
is already in flight for that zone.

## Verification

- `dispatch-run` with a ZM caller and `body.zoneId` naming another zone runs **the caller's** zone.
- `dispatch-run` with a ZM caller and **no** `zoneId` runs the caller's zone, never pan-India.
- `dispatch-run` with a non-acting CSM/OH and no `zoneId` still runs every active zone.
- `dispatch-run/in-flight` returns only the caller's zone for a ZM, and every zone for a non-acting
  CSM/OH.

Covered in `apps/backend/test/dispatch-run-zone-clamp.e2e-spec.ts`.
