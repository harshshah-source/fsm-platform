# NOTIF-08 — the admin notification bell is an inert button (S3, new, 2026-09-02)

**Outcome: confirm.** Found while settling check 6; it blocks C1's UI check for manager roles.

## The two halves

**The backend really does notify managers.** Walked `GET /api/notifications` as all six seeded
accounts. `csm@fsm.test` holds 3 unread `CROSS_ZONE_MANUAL_FLAG` rows (ids 3962, 3958, …);
`ops.head@fsm.test` holds 3 of its own (3961, 3957, 3955). These are real cross-zone escalations
emitted by `cross-zone-escalation.service.ts:213`, each carrying a ticket id in `entityId` and an
`escalationId` in `metadata`. `zm.north`, `zm.south`, `wm` and `se.north` have 0 rows.

**The admin app cannot read any of them.** `apps/admin/src/components/shell/TopBar.tsx:212-219`:

```
<button type="button" aria-label="Notifications" className="…"><IconBell/></button>
```

No `onClick`. No unread badge. No state. No fetch. `apps/admin/src/api/` holds 44 typed clients and
none of them is for notifications; a grep of `apps/admin/src` for `/notifications` returns zero hits
(the only textual match is `KpiInfo.tsx:41`, a comment naming "the notification tray" as something
other surfaces should feel like).

## Why this is C6 and not UX

The taxonomy card says a dead control is `UX` work type unless a C/P/O also fits. One does: the
in-app channel — the one channel the module claims *always* fires, because it needs no push adapter —
is delivered to CSM and Operations Head, and those roles have no lens on it. Cross-zone escalation is
the payload, so the notice a manager most needs is the notice they cannot see. The bell makes it
worse than an honest absence: the product shows a control that looks live.

## Not NOTIF-01

This must not be folded into the push adapter. It needs no adapter, no FCM, no device token. Every
endpoint it would consume is proven working under this walk: `GET /api/notifications` (per-user,
`?unread=true` filter correct), `POST /api/notifications/:id/read` (durable, owner-scoped) and
`POST /api/notifications/read-all` (200 for every role). The work is one api client plus a tray.

## Residual, screen-only

Whether the bell visibly does nothing when clicked, on the admin TopBar, on any page. One browser
walk ~708k TEQ. Not load-bearing — there is no handler in source to fire.
