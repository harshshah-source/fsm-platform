# 249 — Explicit override of return-date deferral: confirm + reason, no silent bypass

Status: ready-for-agent
Type: AFK · Backend + Admin touchpoint

Filed 2026-08-19. Approved Decision 17: manual assignment may override a vehicle-return-date
deferral, but only with explicit confirmation AND a reason — applied consistently; no silent
bypasses.

## What to build

### Current behaviour (verified)

- `OverrideService.assignTicket` (`override.service.ts:276-278`) checks existence, zone scope, and
  `ALREADY_ASSIGNED` — **it never consults `notDeferredOn`**. A ZM can one-click-assign a ticket
  deferred to a future return date, silently bypassing the hold and the priority logic; the assign
  also leaves `deferredUntil` set on a now-FORMALLY_ASSIGNED ticket (only dispatch `:182` clears it).
- `assignPlants` (`:350`) already honours deferral on selection (#146) — but then calls
  `assignTicket`, which wouldn't refuse one handed to it directly.
- `moveTickets` (REASSIGN/SPLIT_BATCH, `:412-417`) and `swapSe` (`:366-399`) check nothing about
  deferral — structurally near-vacuous for *entering* a deferral (a deferred ticket has no live row
  to move) but reachable for the assignTicket-created edge above, where an assigned ticket still
  carries a future `deferredUntil`.
- The confirm pattern already exists on every override command: `CONFLICT_ON_SITE` →
  `confirm: true` + mandatory `reasonCode` + an extra audit row (`:86-105`;
  `batches.controller.ts:69-75` maps it to a 409 with instructions).

### Required change

1. **`assignTicket`:** if the ticket is deferred beyond today (`deferredUntil > istDate(now)`) and
   `confirm` is not set → return a new outcome `CONFLICT_DEFERRED { ticketId, deferredUntil,
   vuReport? }` (409 at the controller, mirroring the ON_SITE mapping). With `confirm: true` + a
   `reasonCode`: proceed, write an `OVERRIDE_DEFERRED_ASSIGN` audit row (deferral date, VU report id
   if one is OPEN, reason), and **clear `deferredUntil`** on assignment — consistent with dispatch
   `:182` (the deferral is spent; the batch row's audit trail is the durable record). The signature
   gains optional `confirm`/`reasonCode` params; existing callers (Critical Queue, intraday accept,
   `assignPlants`, Device Detail) pass them through where user-initiated — intraday accept cannot
   hit the branch (its tickets are CRITICAL-bucket, unassigned-not-deferred sweep-selected, which
   spreads `notDeferredOn` — verified `intraday-insertion.service.ts:107`), pinned by a test rather
   than assumed.
2. **`moveTickets` / `swapSe` (defense-in-depth):** when any affected ticket carries a future
   `deferredUntil`, require the same `confirm` + reason (reusing the existing per-command `confirm`
   field) and audit it; the deferral is preserved (moving a batch does not spend a deferral —
   only an assignment-creating action does).
3. **Admin:** the assign actions that can hit the branch (Critical Queue one-click, Device Detail
   assign, ZM same-day ADD) surface the confirm dialog: show the return date (and the VU report's
   proposed/authoritative dates when present) and collect the reason — the exact UX shape of the
   existing ON_SITE conflict confirm.

### Existing code to reuse

The `CONFLICT_ON_SITE` confirm mechanism + audit shape (`override.service.ts:86-105`), controller
409 mapping, `notDeferredOn`, #245's report read for the dialog context, existing admin confirm
dialog from the override flow.

### Tests

- e2e: unconfirmed assign of a deferred ticket → 409 `CONFLICT_DEFERRED`; confirmed assign →
  succeeds, audited with reason, `deferredUntil` cleared; non-deferred ticket unaffected
  (no new friction on the normal path); intraday accept can never hit the branch (pinned);
  `assignPlants` still filters deferred tickets out (unchanged, pinned).
- moveTickets/swapSe with a deferral-carrying ticket: refused without confirm, audited with.
- Admin: dialog renders dates + requires reason; happy path unchanged when no deferral.

### Risks / rollback

Additive outcome + optional params — no breaking change to existing callers; rollback = revert.
The one behaviour change (clearing `deferredUntil` on confirmed assign) closes the verified
stale-deferral edge rather than creating one.

## Acceptance criteria

- [ ] AC1 — No code path can formally assign a ticket deferred to a future date without
      `confirm: true` and a `reasonCode`; every such override leaves an audit row naming the
      deferral it overrode.
- [ ] AC2 — A confirmed override clears the spent deferral, matching dispatch semantics; the VU
      report (if any) is untouched — overriding the hold is not deciding the return date.
- [ ] AC3 — `assignPlants` bulk behaviour is unchanged (deferred tickets excluded at selection).
- [ ] AC4 — REASSIGN/SPLIT_BATCH/SWAP_SE require confirm+reason when a moved ticket carries a
      future deferral, and preserve the deferral.
- [ ] AC5 — Admin assign surfaces show the return-date context in the confirm dialog and refuse an
      empty reason.

## UI surfaces

Admin: Critical Work Queue assign, Device Detail assign, ZM same-day ADD (confirm dialog, modified).
Mobile: n/a.

## Reference

Existing override-confirm dialog pattern (ON_SITE conflict) — extend, no redesign.

## Blocked by

#246 (return-date deferrals exist to be overridden).
