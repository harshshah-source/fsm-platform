import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiNotificationList,
  apiNotificationMarkAllRead,
  apiNotificationMarkRead,
  type NotificationItem,
} from '../../api/notifications';
import { cn } from '../../lib/cn';

/**
 * The top-bar notification tray (#344). The bell in the v2 reference
 * (`docs/ui/desktop/v2-reference/01-dashboard-zonal-manager.png`) carries an unread dot and nothing
 * behind it; the v2 set never drew the panel, so this is the dot's count made exact plus the
 * smallest panel that discharges it — header, mark-all, list, deep link — in the shell's own
 * surface/line/ink tokens rather than a new visual language.
 *
 * The rows are real: cross-zone escalations for a CSM, `INTRADAY_ESCALATION_REQUIRED` for a ZM. They
 * have been written since Issue 03 and no admin surface has ever read them.
 */

/** Poll cadence. Exported so the test drives the real interval rather than a test-only constant. */
export const NOTIFICATION_POLL_MS = 60_000;

/** The roles whose `RoleRoute` gates admit `/cross-zone` and `/intraday` (`AppRoutes.tsx:359,387`). */
const QUEUE_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Age of a notification in the units an operator thinks in, degrading to an absolute date past a
 * week — "9d ago" is a worse answer than "01 Jul" for something that old.
 *
 * Clamped at zero: a row created a few seconds ahead of the viewer's clock (the backend stamps in
 * UTC, the browser's clock drifts) must not read "-1m ago". Formatted from an explicit month table
 * rather than `toLocaleDateString`, so the string does not change shape with the viewer's locale.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(then);
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`;
}

/**
 * The family a notification belongs to, as the chip on the row. Deliberately the *family* and not
 * the raw type: `CROSS_ZONE_AUTO_ESCALATION` / `CROSS_ZONE_MANUAL_FLAG` / `CROSS_ZONE_DECISION` /
 * `CROSS_ZONE_RE_ESCALATED` are four types and one place to go, and the title already says which of
 * the four it is. An unrecognised type is title-cased rather than dropped — a new backend type must
 * degrade to something readable, not to a blank chip.
 */
export function notificationLabel(type: string): string {
  if (type.startsWith('CROSS_ZONE')) return 'Cross-zone';
  if (type.startsWith('INTRADAY')) return 'Intra-day';
  if (type.startsWith('DAY_PLAN')) return 'Day plan';
  if (type.startsWith('INSTALL')) return 'Install';
  if (type.startsWith('RECOVERY')) return 'Recovery';
  const words = type.toLowerCase().replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Notification';
}

/**
 * Where a row goes when it is clicked, or null when it has nowhere to go.
 *
 * Type first, entity second: a cross-zone escalation *is about* a ticket, but the decision the
 * manager owes it lives on `/cross-zone`, not on the ticket drawer. The role is part of the answer
 * because both queues are role-gated — sending a Warehouse Manager to `/cross-zone` would bounce
 * them off a `RoleRoute` and look like the tray was broken, so they get the ticket instead.
 */
export function notificationLink(n: NotificationItem, role: string): string | null {
  const queues = QUEUE_ROLES.includes(role);
  if (queues && n.type.startsWith('CROSS_ZONE')) return '/cross-zone';
  if (queues && n.type.startsWith('INTRADAY')) return '/intraday';
  if (n.entityType === 'ticket' && n.entityId) return `/tickets/${encodeURIComponent(n.entityId)}`;
  return null;
}

export interface NotificationsState {
  items: NotificationItem[];
  /** Unread across the whole mailbox, not just the page — the backend counts past the 50-row cap. */
  unreadCount: number;
  error: string | null;
  markRead: (id: string) => void;
  markAllRead: () => void;
}

/**
 * The tray's data. It lives here rather than in `TopBar` because the badge needs the unread count
 * while the tray is shut — the count is top-bar state, and mounting the panel to get it would mean
 * the bell only ever told the truth after someone opened it.
 *
 * Read state is updated optimistically and never re-fetched on the write: the poll below reconciles
 * within a minute, and a refetch racing the optimistic update is how a badge flickers back to its
 * old value. `enabled` is false before the session resolves, so a signed-out shell polls nothing.
 */
export function useNotifications(enabled: boolean): NotificationsState {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const list = await apiNotificationList();
        if (!alive) return;
        // Defensive against a backend older than this shape: an unreadable payload must leave the
        // top bar rendered and quiet, never crash the shell every surface hangs off.
        setItems(Array.isArray(list?.items) ? list.items : []);
        setUnreadCount(typeof list?.unreadCount === 'number' ? list.unreadCount : 0);
        setError(null);
      } catch {
        if (alive) setError('Notifications could not be loaded.');
      }
    };
    void load();
    const timer = setInterval(() => void load(), NOTIFICATION_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled]);

  const markRead = useCallback((id: string): void => {
    setItems((prev) =>
      prev.map((n) => (n.id === id && !n.read ? { ...n, read: true, readAt: new Date().toISOString() } : n)),
    );
    setUnreadCount((c) => Math.max(0, c - 1));
    apiNotificationMarkRead(id).catch(() => setError('That notification could not be marked read.'));
  }, []);

  const markAllRead = useCallback((): void => {
    const at = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.read ? n : { ...n, read: true, readAt: at })));
    setUnreadCount(0);
    apiNotificationMarkAllRead().catch(() => setError('Notifications could not be marked read.'));
  }, []);

  return { items, unreadCount, error, markRead, markAllRead };
}

/**
 * The panel itself. Anchored by the caller (`TopBar` owns the `relative` wrapper and the
 * outside-click/Escape close, because the trigger is its button).
 */
export function NotificationTray({
  state,
  role,
  onClose,
}: {
  state: NotificationsState;
  role: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { items, unreadCount, error, markRead, markAllRead } = state;

  /**
   * One click does both halves of "I have dealt with this": the row stops being unread and the
   * operator lands where the work is. A row with nowhere to go still marks read but leaves the tray
   * open — closing it on a click that moved nothing reads as the click being swallowed.
   */
  const openRow = (n: NotificationItem): void => {
    if (!n.read) markRead(n.id);
    const to = notificationLink(n, role);
    if (!to) return;
    onClose();
    navigate(to);
  };

  return (
    <div
      role="dialog"
      aria-label="Notifications"
      className="absolute right-0 top-full z-30 mt-2 w-[21rem] overflow-hidden rounded-lg border border-line bg-surface-card shadow-floating sm:w-[24rem]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-strong">Notifications</h2>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-brand-700 transition-colors hover:bg-surface-sunken focus-ring dark:text-brand-300"
          >
            Mark all read
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="border-b border-line px-4 py-3 text-xs text-critical">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        !error && <p className="px-4 py-8 text-center text-sm text-ink-muted">No notifications yet.</p>
      ) : (
        <ul className="max-h-[26rem] divide-y divide-line overflow-y-auto">
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => openRow(n)}
                className={cn(
                  'flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-surface-sunken focus-ring',
                  !n.read && 'bg-brand-300/10',
                )}
              >
                <span className="flex items-center gap-2">
                  {!n.read && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" />}
                  <span className="rounded bg-neutral-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral">
                    {notificationLabel(n.type)}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-ink-muted">{relativeTime(n.createdAt)}</span>
                </span>
                <span
                  className={cn(
                    'text-[13px] leading-snug',
                    n.read ? 'text-ink-muted' : 'font-semibold text-ink-strong',
                  )}
                >
                  {n.title}
                </span>
                {n.body && <span className="line-clamp-2 text-xs text-ink-muted">{n.body}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
