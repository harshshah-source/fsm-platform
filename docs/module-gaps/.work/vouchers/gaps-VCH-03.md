# VCH-03 — resubmit: the route is alive, the client is missing (C4, was C7 · E4)

Hypothesis H1, predicted code `C7` (unreachable state). Walked 2026-09-02, `api-walk` only.

## The discriminating call

```
SE  POST /vouchers/<random-uuid>/resubmit  ->  404 {"code":"VOUCHER_NOT_FOUND"}
ZM  POST /vouchers/<random-uuid>/resubmit  ->  403 Forbidden
```

A 404 carrying the service's own error code means the SE cleared `@Roles('SERVICE_ENGINEER')`,
entered `resubmit()` at `vouchers.service.ts:285`, and reached the `findUnique`. The route is
**live and reachable by the owning role**. The ZM 403 confirms the gate is the real one and not
a catch-all.

## Consequence: the code changes, the severity does not

`C7` says the state cannot be left because there is no path. That is now false — the path
exists end to end on the server. What is missing is only a caller: `grep resubmit` over
`apps/mobile/src` and `apps/admin/src` still returns nothing but prose comments and an unrelated
troubleshoot test, and `apps/mobile/src/api/client.ts` has no `apiResubmitVoucher` wrapper.

That is `C4` — asymmetry, one layer without the other. It is a materially cheaper fix than the
S2 reading implied: no endpoint to design, no state machine to extend, no permissions work.
`domainLogic` drops 1 → 0 and the `api` lane disappears; what is left is a button on
`VouchersScreen.tsx:102`, a client wrapper, and a test. It pairs naturally with VCH-04 (the
reject reason is returned by `me-vouchers.service.ts:103` and never rendered) — an SE cannot
usefully resubmit without first seeing what the reviewer asked for. Do them as one slice.

Severity stays **S4**: in the shipped app an SE whose claim is sent back still cannot move it
forward, and the process still cannot complete. Cheapness is not severity.

## Correction to the map

`static.md` spine edge **E-16** is marked `OK` on route existence alone. It should read
`PARTIAL` — carrier present, receiver absent. Flagged for the S4 brief; not edited here (the
S3 walker does not own `static.md`).

## Residual

Not proven: that a real `NEEDS_CLARIFICATION` row actually flips to `ZONAL_MANAGER_REVIEW`, and
that `submittedAt` is restamped. Blocked by the same missing SE fixture as VCH-01. One
`api-walk` sequence once that exists.
