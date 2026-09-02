# tickets · S3 walk narrative — 2026-09-02, api-walk only, no browser

## The SE-zero-rows question, settled first

**(a) empty seed — and worse than empty: the SE login is not an engineer.** `se.north@fsm.test` is
user `22222222-…-2222`. `seedAuthFixtureUsers` (auth-fixture-seed.ts:114) writes **only `users` rows**
— no `engineer_master`, no `se_coverage`. The 15 engineers `GET /engineers` returns are ingested
AutoPlant identities (Rahul Verma, Vikram Singh, …), and **65 of the 100 zone-1 tickets are assigned
to them**. So work exists; it is simply assigned to people who cannot log in, while the person who can
log in is not an engineer. The scoping query is fine: `coveredPlantIds()` returned `[]`, so both the
assigned branch and the shared-pool branch matched nothing.

Proof, and the unlock: as OH I created two config rows through the app — `POST /org/engineers`
(`{userId: 2222…, MULTI_PLANT, zone 1, capacity 5}`) and `POST /org/se-coverage` (`{plantId: 103}`).
`GET /me/tickets` went from 0 to **521**. Nothing was patched; the SE half is now walkable for anyone
who repeats those two calls.

## What the walk found

**TKT-01 · confirmed, E4, the sharpest finding.** SE filed a VU report 09:26:56 → `slaPaused:true` on
both the SE and ZM queues. ZM `resume-sla` 09:27:25 → `slaResumed:true`, 28s correctly folded into
`sla_accumulated_pause_seconds`. `GET /audit-trail/tickets/:id` was **1 entry before and 1 entry after
both legs**, and `audit_logs` has zero rows at either instant — while `TROUBLESHOOT_SUBMITTED`,
`CROSS_ZONE_ASSIGN`, `BATCH_OVERRIDE_REMOVE_TICKET` and `SE_AVAILABILITY_SET` from the same 30 minutes
are all there. The audit machinery works; these two paths simply do not use it. Nuance that keeps the
price honest: attribution *does* survive on the report row (`se_id`, `resolved_by`, `resolved_by_role`).
It is the ledger and the ZM's per-ticket trail that are blind.

**TKT-02 · confirmed and upgraded to S4.** The component-unavailable submission does not deliver a
null `componentId` to the Warehouse Manager — **it cannot be submitted at all**. Every attempt returns
HTTP 500 (4/4, two tickets). Cause reproduced directly in a rolled-back Postgres transaction: CHECK
`ts_submissions_component_unavailable_item` = `(component_unavailable = false OR
component_unavailable_item IS NOT NULL)`, and no caller anywhere populates `componentUnavailableItem`.
WAITING_COMPONENT, the component SLA pause and the whole request-to-warehouse hand-off are unreachable
over HTTP. This is why `/warehouse/requests` and `/me/component-requests` are both empty — the primer's
"0 rows" for those queues is not thin seed data, it is a wall.

**TKT-03 · falsified.** Same `clientSubmissionId` twice ⇒ `DUPLICATE`, `duplicate:true`, the **same**
`submissionId`, no second row. PRD:721-724's contract is honoured server-side and unique-indexed.
A *different* id on the same ticket ⇒ 409, not a duplicate. S3→S2, dangerous→false. Folded residual:
`clientSubmissionId` is checked for presence only, never for UUID shape, so a non-UUID returns 500
instead of 400 (controller:47) — that cost me four probes before I read the schema.

**TKT-10 · new, and it is what H-TKT-1 was really groping at.** A retry with a fresh UUID after a
timed-out-but-succeeded submit hits `handleConflict`, which looks for a winner `seId != this SE`,
finds none, and returns `winnerSeId/winnerSeName/winnerAt` all **null**. The SE is shown the
another-SE-won screen for their own successful work, naming nobody. Reproduced live.

**TKT-04 · confirmed E4.** The live 409 body carries `shadowUseRecorded:false`; no request field can
ever flip it. Dead line, now walked rather than read.

**TKT-11 · new.** One coverage row ⇒ 521 items in one unpaginated response. No `take`, no cursor,
while the ZM's own list pages at 100. Invisible until the SE persona had coverage.

**TKT-12 · new.** `GET /me/tickets/:id` was 200 before filing a VU report and 404 after: filing sets
`deferredUntil` and the SE reads apply `notDeferredOn(today)`. The SE cannot re-read or correct the
ticket they just filed on.

**TKT-13 · falsified.** The coverage floor is symmetric. Covered+unassigned: detail 200, forms 200,
troubleshoot 201. Uncovered: detail 404, soft-state 404. No read-promise/write-refusal gap for
TROUBLESHOOT. RECOVERY/INSTALL stay NEEDS-VERIFY — every one of the 100 tickets is TROUBLESHOOT.

**Check 6 · 19 wrong-role calls, zero defects.** `/me/tickets`, `/me/tickets/:id`, `/me/tickets/:id/forms`,
`/me/work-history`, `/me/vehicle-unavailability`, `/me/activity-ping`, soft-state ⇒ 403 for ZM/WM/CSM.
Manager VU list and `/audit-trail` ⇒ 403 for SE and WM. Zone clamp holds: `zm.south` ⇒ 404 on a zone-1
ticket's audit trail. `GET /me` is unguarded by design and returns only the caller's own claims.

DISCL 0 found 0 opened 0 blocked (no browser walk — every claim was settled by API).
