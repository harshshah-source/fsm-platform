# INV-G1 walk — the disputed-shadow-use arithmetic. 2026-09-02, api-walk only.

## The numbers, before and after — there are none, and that is the finding

Step 1 of the plan died at the first read.

    SE  GET /api/me/van-stock  -> HTTP 200
    { "stock": [], "commonKit": { "complete": true, "missing": [] } }

`se.north` carries **zero** van-stock rows. Not "a component at qty 0" — no `seVanStock` row exists
for this engineer at all. `decrementStock` (`troubleshoot-submission.service.ts:375`) reads
`findUnique` and **returns on a missing row** — documented as "No-op when untracked". So even with a
ticket in hand, step 2 could not have moved a number.

Step 2 died a second, harder death. `troubleshoot.controller.ts:52-70` builds the service input field
by field and **never sets `consumedComponents`**. `packages/shared/src/index.ts:468` admits it in
writing: `shadowUseRecorded` is "permanently `false` over HTTP today — `TroubleshootSubmitRequest`
carries no `consumedComponents` field yet (structural gap owned by #101)". Both consumption loops
(`:296` PRE_VERIFICATION, `:330` SHADOW_USE) iterate `input.consumedComponents ?? []`, so over HTTP
they iterate nothing. Filed as **INV-G8** (C7, S3, DANGEROUS, E4) — it blocks INV-G1.

Step 3 had nothing to dispute:

    WM  GET /api/warehouse/shadow-use -> HTTP 200  ARRAY len=0
    ZM  GET /api/component-blocked    -> HTTP 200  ARRAY len=0
    SE  GET /api/me/tickets           -> HTTP 200  items len=0

**Result: INV-G1 = UNTESTABLE / NEEDS-VERIFY. Not falsified.** An empty queue is not a pass.

## What the code still says, re-read at file:line

`markDisputed` (`shadow-use.service.ts:72-94`) flips `inventoryTransaction.status` to `DISPUTED`,
stamps `reconciledBy` + `reason`, writes a no-transition `ticketEvent` (`INVENTORY_DISPUTE`) and an
`auditLog` (`SHADOW_USE_DISPUTED`, `escalatedTo:'ZONAL_MANAGER'`). It touches **no stock table**.
The strongest alternative — a restore somewhere else — is dead: 6 `seVanStock` references in
non-generated `src`, only 2 writers (`:377` decrement, `verification.service.ts:409` rollback upsert);
`@Cron` count in `inventory/` + `component-request/` = 0. The absence is earned; only the walk failed.

## Fixture that would settle INV-G1 at E4

One `se_van_stock` row for `se.north` with `qty > 0`; one OPEN ticket assigned to `se.north`; a
second SE submission on that ticket to force the business 409; and a `consumedComponents` field on
the wire (INV-G8) so the 409 branch actually runs. Then: read qty, submit, read qty (expect the
decrement), dispute as `wm@fsm.test`, read qty a third time.

## Settled in the same pass — free, and it costs the reader nothing to trust

`INV-H3 falsified` (no gap, logged as `INV-N1`). The warehouse write guard is real at runtime:
`PATCH /api/inventory/warehouse-stock` -> **403** as ZM, as CSM, and as SE; **200** on `GET` as WM
and as ZM, 403 as SE. `GET /api/warehouse/requests` -> 403 as ZM and as SE. `POST
/api/warehouse/requests/1/approve` -> 403 as ZM and as SE. `GET /api/me/van-stock` -> 403 as ZM.
`WRITE_ROLES` = WM+OH holds; `static.md`'s READ_ROLES print was the scanner off-by-one already ruled.

`INV-G5 upgraded E2 -> E4`. The dispute escalates to the ZONAL_MANAGER, and
`ZM GET /api/warehouse/shadow-use` -> **403**, `ZM POST .../1/dispute` -> **403**. The escalation
target is locked out of the only queue carrying the escalation. Role has no lens, reproduced.

`INV-G2` and `INV-G4` UNTESTABLE for the same reason: `recovery/awaiting-receipt` len=0,
`component-requests` len=0 (all three lenses), `warehouse-stock` len=0, fulfilment SLA
`{totalReceived:0, openRequests:0, slaWindowDays:7}`. Fixtures named in `gaps.jsonl`.

DISCL 0 found 0 opened 0 blocked (api-walk only; no browser walk taken).
