import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiNotificationList,
  apiNotificationMarkAllRead,
  apiNotificationMarkRead,
} from '../src/api/notifications';

/**
 * #344 — the notifications client. Separate from the tray's tests because it pins a different thing:
 * the wire contract against `apps/backend/src/notifications/notifications.controller.ts:22-40`
 * (list / `:id/read` / `read-all`), which this slice does not change.
 *
 * The acting header matters here as much as anywhere (#341): a CSM acting as a ZM still reads their
 * *own* notifications — the backend keys the list on `user_id`, not on scope — but `authHeaders()`
 * is the one builder every client goes through, and `acting-header-builder.test.ts` fails any client
 * that authenticates by itself. These tests assert the header is actually on the request, so the
 * structural pin has a behavioural twin.
 */
const BASE = 'http://localhost:3000/api';

let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ items: [], unreadCount: 0 }));
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.setItem('fsm.accessToken', 'tok-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('#344 — notifications client', () => {
  it('reads the list from the controller route with the bearer token', async () => {
    fetchMock.mockResolvedValue(
      json({
        items: [
          {
            id: '1',
            type: 'INTRADAY_ESCALATION_REQUIRED',
            title: 'Manual assignment needed',
            body: null,
            entityType: 'ticket',
            entityId: 'TCK-1',
            metadata: null,
            read: false,
            readAt: null,
            createdAt: '2026-09-03T06:00:00.000Z',
          },
        ],
        unreadCount: 1,
      }),
    );

    const out = await apiNotificationList();

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/notifications`, {
      headers: { Authorization: 'Bearer tok-1' },
    });
    expect(out.unreadCount).toBe(1);
    expect(out.items[0].entityId).toBe('TCK-1');
  });

  it('carries the acting-as-zone header when a CSM is acting (#341)', async () => {
    sessionStorage.setItem('fsm.actingZone', '3');

    await apiNotificationList();

    expect(fetchMock.mock.calls[0][1]).toEqual({
      headers: { Authorization: 'Bearer tok-1', 'X-Acting-As-Zone': '3' },
    });
  });

  it('marks one read by POSTing to that notification', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));

    await apiNotificationMarkRead('42');

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/notifications/42/read`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-1' },
    });
  });

  it('encodes the id rather than splicing it raw into the path', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));

    await apiNotificationMarkRead('4 2/x');

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/notifications/4%202%2Fx/read`);
  });

  it('marks all read and returns how many the backend actually updated', async () => {
    fetchMock.mockResolvedValue(json({ updated: 7 }));

    const out = await apiNotificationMarkAllRead();

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/notifications/read-all`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-1' },
    });
    expect(out.updated).toBe(7);
  });

  it('throws on a non-2xx so the tray can say the read failed', async () => {
    fetchMock.mockResolvedValue(json({ code: 'NOPE' }, 500));

    await expect(apiNotificationList()).rejects.toThrow('REQUEST_FAILED_500');
  });
});
