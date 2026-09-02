# vouchers

STATUS: estimated  updated 2026-09-02
COMPLETE: 56%  ->  78% after backlog
GAPS: 12 (S4 1 · S3 7 · S2 4 · S1/S0 0)  DANGEROUS 8 · needs-verify 2
EST: P50 33.00M · P80 65.99M TEQ · size XXL · risk HIGH · conf LOW · basis borrowed
VERDICT: One Operations Head account can click approve and then mark-paid on the same voucher, and once money is marked paid by mistake there is no button anywhere to take it back.

## The picture
Vouchers sits about half built (56% now, 78% after the backlog), and the score understates the real risk: the module's one login for a service engineer has no linked engineer record anywhere in this environment, so nothing plant-side can create a voucher, which blanks persistence testing across most of the open questions — not because those gaps are small, but because the harness cannot reach them. The headline is not a hypothesis: the same-principal approve-then-pay hole was reproduced live, with contrast calls showing the guard clears for that one role and holds for every other, so it is a guard-clearance bug, not a leaky endpoint. One finding cuts the other way — the resubmit flow that looked dead is actually alive on the server, so it is a missing button, not a missing feature.

## What matters, ranked
S4 / S3 / DANGEROUS / one-way doors only. Worst first. <=8 bullets. Always one 🟢 that works.
- 🔴 One Operations Head can approve then mark-paid the same voucher — reproduced live, guard cleared for `ops.head@fsm.test` on both halves, held for WM (review 403) and ZM (mark-paid 403); only the same-row transition remains unwalked, SE-fixture blocked (VCH-02, S3, dangerous)
- 🔴 No way to undo a voucher marked PAID by mistake — no endpoint exists at all, this is a business call not a measurement (VCH-08, S3, dangerous)
- 🔴 Resubmit route is live but no client calls it — reclassified cheaper than first thought: server route answers with its real error code, so this is a button and a wrapper, not a dead path (VCH-03, S4)
- ⚠ number-health: top-down vs bottom-up split ~12x, far past the 2x low-confidence line — top-down assumes cost is screen-shaped, these gaps are control- and data-shaped, the two counts should not be averaged
- ⚠ number-health: VCH-02, VCH-07, VCH-08 all price over 3M TEQ each, past the brief's own "split before you commit" line — none of the three should be quoted as a single unit of work
- ⚠ number-health: 3.99M TEQ of this estimate leans on thin cohorts — integration n=6 (VCH-07) and data n=4 (VCH-08, VCH-10, VCH-11, VCH-12)
- 🟠 The SE login has no `engineer_master` row anywhere in this environment, so no voucher can be created and every persistence walk (VCH-01, VCH-05, VCH-06, VCH-10) is stuck at E2 module-wide — one fixture row unblocks all of them
- 🟢 The mandatory-reason gate on reject genuinely works end to end, and the reason is carried into audit metadata

## Numbers
| | |
|---|---|
| functionally complete | 56% now → 78% after backlog |
| backlog | P50 33.00M / P80 65.99M TEQ · conf LOW |
| cheapest big fix | VCH-10 at 1.31M — Half a Mark-PAID batch can commit and the rest fail |
| engineering size / risk | XXL / HIGH — **not a schedule** |

## Not finished / needs you
- **needs-verify:** VCH-01, VCH-05
- **your call:** VCH-08
- **not walked:** VCH-01 / H3 — duplicate-submit walk: POST the same voucher body twice with the SAME clientSubmissionId (expect duplicate:true, one row) then with a DIFFERENT id (expect two rows), then re-GET /me/vouchers. Blocked by SE-FIXTURE. Held at E2.; VCH-05 / H4 — NO_ACTIVITY_LINK warning on a real queue row, read as ZM from GET /vouchers. Blocked by SE-FIXTURE. Held at E2. Narrowed for free: the API accepts plantId/ticketId/vehicleId (controller.ts:36-39), so the omission is mobile-only.; VCH-02 residual — the same OH approving voucher X and then paying voucher X end to end. The GUARD overlap is walked and E4; only the same-row transition is unreached. Blocked by SE-FIXTURE.; VCH-03 residual — that a real NEEDS_CLARIFICATION row flips to ZONAL_MANAGER_REVIEW and restamps submittedAt. Route liveness is walked and E4. Blocked by SE-FIXTURE.; VCH-06 — activityCheck() passing a voucher that cites an unrelated real ticket id. Needs both a voucher and a ticket. Blocked by SE-FIXTURE. Held at E2.; VCH-08 — no un-pay path. Nothing to walk: absence of an endpoint is settled by the controller read (E2) and confirmed by the route list; the open question is a business decision (needsCall), not a measurement.; VCH-10 residual — a genuine mid-batch partial commit (some ids APPROVED, one failing mid-loop). The all-miss case is walked and E4. Needs APPROVED rows: blocked by SE-FIXTURE.; VCH-11 — offline draft behaviour. Requires the mobile app on a device with the network cut; api-walk cannot reach it and the desktop browser cannot either. UNTESTABLE by any instrument available to S3.; VCH-07 — that the admin subtitle asserts a notification the SE never receives. The backend half is settled by code (vouchers.module.ts:18, unconditional LoggingVoucherNotifier). The rendered subtitle at VoucherReviewPage.tsx:228 is a screen-only claim: NEEDS-VERIFY, one browser walk ~708k TEQ, screen /vouchers as ZM, the header subtitle under the page title.; VoucherReviewPage disclosure sweep — no hypothesis named a screen, and the queue is empty in this DB, so no sweep was run. DISCL 0/0/0 (not applicable, not skipped).
- **⚠ weak anchor:** 3.99M TEQ of this estimate rests on cohorts with n<10
- **⚠ cross-check split:** top-down 2.70M vs bottom-up 33.00M (12.22×) — module is LOW-CONFIDENCE

## All gaps, one line each
| id | sev | ⚠ | what (plain words) | type | size | P50 | conf |
|---|---|---|---|---|---|---|---|
| VCH-03 | S4 | ✗ | Resubmit route is live but no client calls it | COMPLETE | — | — | HIGH |
| VCH-01 | S3 | ☠ | Second tap after a timeout files a second paid claim | FIX | — | — | MED |
| VCH-02 | S3 | ☠ | One Operations Head can approve then pay the same voucher | SECURITY | M | 4.05M | HIGH |
| VCH-04 | S3 |  | Reject reason is stored and returned but never shown to the engineer | COMPLETE | — | — | HIGH |
| VCH-05 | S3 | ☠ | Fraud check gets no ticket or plant, so it always warns | COMPLETE | — | — | HIGH |
| VCH-07 | S3 |  | Screen says the engineer is notified; the notifier only writes a log | INTEGRATION | L | 3.43M | HIGH |
| VCH-08 | S3 | ☠ | No way to undo a voucher marked PAID by mistake | NEW | L | 5.35M | HIGH |
| VCH-11 | S3 |  | No offline draft; a claim cannot be filed without signal | NEW | XL | 2.24M | HIGH |
| VCH-06 | S2 | ☠ | Ticket check only proves the ticket exists, not that it matches | NEW | M | 2.04M | HIGH |
| VCH-09 | S2 | ☠ | Bulk export of every approved claim is not audited | SECURITY | S | 1.72M | HIGH |
| VCH-10 | S2 | ☠ | Half a Mark-PAID batch can commit and the rest fail | FIX | M | 1.01M | HIGH |
| VCH-12 | S2 | ☠ | Spend limits are hardcoded and cannot be changed by the business | NEW | M | 2.88M | HIGH |

Evidence: `.work/vouchers/` · estimate: `.work/vouchers/estimate.json`
