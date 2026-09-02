# notifications — walker primer (first walk, S3, 2026-09-02)

Login and instrument: see `docs/module-gaps/.work/_shared-primer.md`. Nothing extra is needed —
this module has no browser step worth paying for.

**Where the module lives.** Backend `apps/backend/src/notifications/` (list, read state, device
token) and `apps/backend/src/audit/` (the ledger half). Mobile
`apps/mobile/src/notifications/NotificationsScreen.tsx`. **Admin: nothing.** `apps/admin/src/api/`
has 44 typed clients and none is for notifications or audit.

**Routes that exist** (everything else 404s):
```
GET  /api/notifications[?unread=true]          any authenticated user, own rows only
POST /api/notifications/read-all               any authenticated user
POST /api/notifications/:id/read               numeric id; 404 if not yours
POST /api/notifications/device-token           @Roles SERVICE_ENGINEER, needs X-Device-Id
GET  /api/audit-trail/tickets/:ticketId        @Roles ZM/CSM/OH, UUID only, no filters
GET  /api/reports/csm-approval-share[?month=]  @Roles OPERATIONS_HEAD (audit roll-up, has a page)
```

**Seeded data — who holds what.** `csm@fsm.test` 3 unread `CROSS_ZONE_MANUAL_FLAG` (ids 3962, 3958,
…); `ops.head@fsm.test` 3 of its own (3961, 3957, 3955 — **3961 was marked read by this walk**).
`zm.north`, `zm.south`, `wm`, `se.north` all hold **0** notifications, so the SE half of anything is
`UNTESTABLE` here. Usable ticket with a trail: `7292c081-752f-44c6-9b4d-4855d16c0083` (zone 3).
`csm-approval-share`: 2026-09 → 1 zone, 2026-08 / 2026-07 → 5 zones, `csmActions` 0 throughout.

**Do not re-walk.** NOTIF-01 (the dead push gateway) is E2 standing law. Check 3 and check 6 are both
settled `v` at E4 — see `NOTIF-H1` and `NOTIF-H4` in `gaps.jsonl`.
