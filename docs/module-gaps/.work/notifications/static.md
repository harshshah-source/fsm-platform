> **CAVEAT (measured 2026-09-02):** the `audit` column follows only ONE delegation hop — it reports "no" whenever the audit write sits in a shared private helper. Verified false-positive rates: scheduling 11/11, tickets 8/10, cross-zone 6/6, vouchers 0/0, ingestion 0/3. Error is one-directional (under-detects, never invents), so "yes" is trustworthy and every "no" must be checked at `file:line`. The `guard` column can be off by one decorator. Never infer a UI facade from skeleton.md "no data hook" — admin pages use `useEffect` + `apps/admin/src/api/`, not react-query.

# static facts — Notifications & Audit Trail (notifications)
columns: guard = @Roles/@Public on the handler · audit = withAudit/record/auditLog.create in the reached service · status = writes a *status/state* field · tx = $transaction

| endpoint | file:line | guard | audit | status-write | tx |
|---|---|---|---|---|---|
| `GET /api/notifications` | apps/backend/src/notifications/notifications.controller.ts:22 | **none** | no | yes | no |
| `POST /api/notifications/read-all` | apps/backend/src/notifications/notifications.controller.ts:27 | **none** | no | yes | no |
| `POST /api/notifications/:id/read` | apps/backend/src/notifications/notifications.controller.ts:33 | **none** | no | yes | no |
| `POST /api/notifications/device-token` | apps/backend/src/notifications/notifications.controller.ts:44 | 'SERVICE_ENGINEER' | no | no | no |
| `GET /api/audit-trail/tickets/:ticketId` | apps/backend/src/audit/audit-trail.controller.ts:20 | 'ZONAL_MANAGER','CENTRAL_SERVICE_MANAGER','OPERATIONS_HEAD' | no | no | no |

**totals:** 5 endpoints · 3 with no @Roles at handler or class · 0 @Public · 3 write-verb endpoints with no audit write in the reached method

## prisma models plausibly owned (name match on module keywords)
_no model name matched the slug — surveyor must map by hand_

## spine edges owned by this module
| id | from | to | carrier | receiver | reverse | ev |
|---|---|---|---|---|---|---|
| E-04 | scheduling · Batch · DISPATCHED | notifications | outbox row `queueDayPlanDispatched` written in the same tx | commit of the per-SE dispatch tx | seId, scheduleId, zoneId, stops, tickets | drained by cron `notificationOutboxTick` | `queueDayPlanOverridden` :44 on override | E2 `scheduling/day-plan-notification-outbox.ts:22,44` · `scheduling/business-sweep-scheduler.service.ts:280` | notifications | OK |
| E-05 | notifications · DayPlan event · queued | scheduling (SE phone) | **push seam returns UNAVAILABLE** — in-app row only, SE must open app | cron drain | title, body, scheduleId | *(blank for push)* — in-app only at NotificationsScreen.tsx via HomeScreen.tsx:147 · SE | none | E2 `notifications/notification-channel.gateway.ts:37` (`return 'UNAVAILABLE'`) | notifications | BROKEN — S4 |
| E-19 | intraday · Insertion · assigned | notifications (SE phone) | `notifications.notify` outside tx — in-app only, same UNAVAILABLE push seam as E-05 | auto-assign / manual-assign | insertionId, ticketId, plant, new stop order | in-app NotificationsScreen.tsx · SE (no push) | `intraday-updates/remove` :75 | E2 `intraday/intraday-insertion.service.ts:343,465,498` · `notifications/notification-channel.gateway.ts:37` | notifications | PARTIAL — S3 |

## env flags referenced in this module
_none_
