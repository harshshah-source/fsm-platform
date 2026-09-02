# skeleton — Notifications & Audit Trail (notifications)
generated 2026-09-02 · 0 TEQ · source: gapscope.profile.json

## admin routes (declared)
_none — this module has no admin route of its own_

## backend endpoints
### apps/backend/src/notifications/notifications.controller.ts  `@Controller('notifications')`
- `GET /api/notifications` → `list()` :22
- `POST /api/notifications/read-all` → `markAllRead()` :27
- `POST /api/notifications/:id/read` → `markRead()` :33
- `POST /api/notifications/device-token` → `registerDeviceToken()` :44

### apps/backend/src/audit/audit-trail.controller.ts  `@Controller('audit-trail')`
- `GET /api/audit-trail/tickets/:ticketId` → `ticket()` :20

## backend units (services / schedulers / jobs)
- `apps/backend/src/notifications/device-token.service.ts` — class DeviceTokenService:11 · register():14 · clear():23
- `apps/backend/src/notifications/notification-channel.gateway.ts` — deliver():25 · class LoggingChannelGateway:35 · deliver():37
- `apps/backend/src/notifications/notification-seam.ts` — class NotificationSeamBreachError:28 · if():51 · for():67
- `apps/backend/src/notifications/notification.service.ts` — class NotificationService:75 · notify():81 · listForUser():90 · markRead():115 · markAllRead():127
- `apps/backend/src/audit/audit-trail.service.ts` — class AuditTrailService:40 · ticketTrail():43
- `apps/backend/src/audit/audit.service.ts` — class AuditService:45 · record():52

## admin UI files

## admin api client calls (apps/admin/src/api)

## mobile screens
- `apps/mobile/src/notifications/NotificationsScreen.tsx` — 229 loc

## tests touching this module
- `apps/backend/test/notifications-controller.e2e-spec.ts`
- `apps/mobile/src/notifications/NotificationsScreen.test.tsx`
