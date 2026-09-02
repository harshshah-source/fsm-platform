# tickets · module primer (first walker, 2026-09-02) — read with `_shared-primer.md`

**Login.** `se.north@fsm.test` / `correct-password`. Module lives at
`apps/backend/src/{ticketing,me-tickets,soft-state}` + `apps/mobile/src/tickets/**` +
`apps/admin/src/pages/{tickets,readiness}`.

**The SE persona is a login, not an engineer.** `seedAuthFixtureUsers` writes only `users` rows, so
`se.north` had no `engineer_master` and no `se_coverage` — that, not a broken query, is why
`GET /me/tickets` returned 0. The 15 engineers on `GET /engineers` are ingested AutoPlant identities
with no credentials; 65 of the 100 zone-1 tickets are assigned to them.

**Unlock the SE half in two calls (as `ops.head@fsm.test`) — already done in this DB:**
```
POST /api/org/engineers   {"userId":"22222222-2222-2222-2222-222222222222","coverageType":"MULTI_PLANT","zoneId":1,"dailyCapacity":5}
POST /api/org/se-coverage {"seId":"22222222-2222-2222-2222-222222222222","plantId":103,"coverageType":"MULTI_PLANT"}
```
After this `GET /me/tickets` returns **521** rows (unpaginated — see TKT-11).

**Seeded state after this walk.** All 100 tickets are `workType: TROUBLESHOOT`; no RECOVERY, no
INSTALL. Plant 103 (`NCP-9117`, zone 1) is the covered plant. Consumed by this walk:
`TCK-29817` (`5dbbd40c…`) carries VU report id `1`, now RESOLVED, cycle unpaused with 28s accumulated;
`TCK-29742` (`ec639ce5…`) is now `VERIFICATION_PENDING` with two submissions
(`bbbbbbbb-0000-4000-8000-00000000000{1,2}` — the second 409'd). Pick a different ticket for a fresh
lifecycle walk.

**Gotchas that cost probes.**
- `clientSubmissionId` must be a real UUID — a non-UUID returns 500, not 400.
- `rootCauseCategory` is a server enum; `HARDWARE` is not in it (`POWER_ISSUE` is).
- `componentUnavailable: true` **always 500s** — a DB CHECK requires `component_unavailable_item`,
  which nothing populates (TKT-02).
- `POST /tickets/:id/soft-state` takes `{target}`, not `{type}`.
- Audit reads: `GET /audit-trail/tickets/:ticketId`, manager roles only; table is `audit_logs`.
- DB is reachable at `postgresql://fsm:test123@localhost:5433/fsm`; `pg` resolves only from
  `apps/backend/`, so run probe scripts from there.
