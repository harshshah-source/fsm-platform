# V-01 — auto-recovery leaves the run verdict stale (C2 · S3 · outcome NEEDS-VERIFY)

Hypothesis H1. Walked 2026-09-02 with `api-walk` as `ops.head@fsm.test`; no browser.

## The test that was asked for

S2 established two ledgers counting the same closure differently: `system-efficiency` counts
`vr.outcome`, `fleet-uptime` counts `ticket.status`. If `mark-auto-recovery` closes the ticket without
stamping the run outcome, the two must disagree on live data. Two numbers that should match and do not
would be clean O3/P3 evidence at E4.

## What the endpoints returned

`GET /reports/efficiency` (OH, 200):
`verifiedCycles 0 · failedVerifications 0 · autoRecoveries 0 · autoRecoveryRatePct 0 · failedVerificationRatePct 0`

`GET /reports/fleet-uptime` (OH, 200):
`eligibleDeviceCount 0 · autoRecoveryClosures 0 · seRepairedClosures 0 · uptimePct 100 · rows []`

`GET /reports/verification-outcomes` (OH, 200):
`total 0 · fraudFlagged 0`, and every bucket — CLOSED, CLOSED_AUTO_RECOVERY, PARTIAL_RECOVERY,
FAILED_VERIFICATION, FAILED_ACTIVATION, PENDING — at `count 0`.

## Verdict: UNTESTABLE, and honestly so

Both ledgers report zero because there are no verification runs in the database at all. Zero equals
zero. That is not agreement between the ledgers — it is the absence of any observation. Inferring a
pass here would be exactly the failure the data warning names, so V-01 stays `NEEDS-VERIFY` at E2 on
the static reading, and is **not** promoted.

The static case is unchanged and still strong: the only writer of `verificationRun.outcome` outside the
sweep is the `outcome: null` `updateMany` at `verification.service.ts:186`, and a repo-wide grep for
`verificationRun.(update|create|upsert)` outside `src/verification/` returns nothing. No later writer
reconciles the two ledgers.

## Fixture that settles it

1. Seed one ticket at `VERIFICATION_PENDING` with a troubleshoot submission older than 24 h and **no**
   `RawDeviceSnapshot` after it, so the sweep lands it on `FAILED_VERIFICATION` / no-pings.
2. `POST /verification/:ticketId/mark-auto-recovery` as `zm.north@fsm.test`.
3. Re-`GET` `/reports/efficiency` and `/reports/fleet-uptime`. If `fleet-uptime.autoRecoveryClosures`
   increments while `efficiency.autoRecoveries` does not — or the review row still renders
   "Failed — no pings" and stays clickable — the divergence is confirmed at E4.

Cost: one seeded run plus three ~2k TEQ calls.

## Reproduced in passing — belongs to `reports`, not here

`fleet-uptime` returns `uptimePct: 100` on `eligibleDeviceCount: 0`. A perfect uptime score computed
from an empty denominator is a misleading metric (O3) that a dashboard would render as green. Per the
standing rule that `reports` owns what its own screen renders and whether it degrades honestly, this is
recorded for that module rather than priced here. E4, measured 2026-09-02.
