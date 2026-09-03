// Typed client for the signed-in user's in-app notifications (#344, over the Issue 03 spine).
// Mirrors `apps/backend/src/notifications/notification.service.ts` `NotificationList` /
// `NotificationListItem` and the three routes on `notifications.controller.ts:22-40`.
//
// The list is scoped by the backend to `user_id` — there is no zone/role parameter to send and none
// to honour. `authHeaders()` is still the only way this client authenticates (#341): the acting
// header rides along on every request so a CSM acting as a ZM is attributed the same way here as
// everywhere else, and the structural pin in `test/acting-header-builder.test.ts` stays green.

import { authHeaders } from './authHeaders';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** One in-app notification row (backend `NotificationListItem`). */
export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: NotificationItem[];
  unreadCount: number;
}

/**
 * The newest rows, newest first, plus the unread count over the *whole* mailbox — the count is not
 * derived from `items`, because the backend caps the page (default 50, `notification.service.ts:91`)
 * while counting every unread row. The badge therefore stays honest past 50.
 *
 * No `limit` / `since` is sent: the controller accepts neither today. `?since=` is listed on #165,
 * which is still `ready-for-agent` — the tray polls the whole page until that lands.
 */
export async function apiNotificationList(): Promise<NotificationList> {
  const res = await fetch(`${BASE_URL}/notifications`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as NotificationList;
}

/** Mark one notification read. The backend 404s a row that is not the caller's own. */
export async function apiNotificationMarkRead(id: string): Promise<{ ok: true }> {
  const res = await fetch(`${BASE_URL}/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as { ok: true };
}

/** Mark every unread notification read; returns how many rows the backend actually updated. */
export async function apiNotificationMarkAllRead(): Promise<{ updated: number }> {
  const res = await fetch(`${BASE_URL}/notifications/read-all`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`REQUEST_FAILED_${res.status}`);
  return (await res.json()) as { updated: number };
}
