import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NotificationListItem } from '@fsm/shared';
import { apiGetNotifications, apiMarkAllNotificationsRead, apiMarkNotificationRead } from '../api/client';
import { getAccessToken } from '../auth/tokenStore';
import { color, radius, spacing, typeScale } from '../theme/tokens';
import { TicketDetailScreen } from '../tickets/detail/TicketDetailScreen';

type NotificationsState =
  | { status: 'loading' }
  | { status: 'ready'; items: NotificationListItem[] }
  | { status: 'error' };

type Filter = 'ALL' | 'UNREAD';

export interface NotificationsScreenProps {
  onBack: () => void;
}

/**
 * #85 (M8a) — SE Notifications, over the already-built Issue-03 spine (`GET /api/notifications`).
 * Every live `notify()` call site (`intraday-insertion.service.ts`, `cross-zone-escalation.service.ts`,
 * `bulk-unassign.service.ts`) uses `entityType` `'ticket'`, `'zone'`, or `'zones'` — zone(s)
 * notifications never reach an SE recipient, so `'ticket'` is the only entity this SE screen ever
 * needs to route through; anything else (or no entity) just marks read, matching the issue's own
 * "no entity → tap only marks read" edge case.
 */
export function NotificationsScreen({ onBack }: NotificationsScreenProps) {
  const [state, setState] = useState<NotificationsState>({ status: 'loading' });
  const [filter, setFilter] = useState<Filter>('ALL');
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

  const load = useCallback(async (f: Filter) => {
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      const list = await apiGetNotifications(token, { unreadOnly: f === 'UNREAD' });
      setState({ status: 'ready', items: list.items });
    } catch {
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [load, filter]);

  const handleTap = useCallback(
    async (item: NotificationListItem) => {
      try {
        const token = await getAccessToken();
        if (token) await apiMarkNotificationRead(token, item.id);
      } catch {
        // Best-effort — a failed markRead never blocks navigation to the entity.
      }
      await load(filter);
      if (item.entityType === 'ticket' && item.entityId) {
        setSelectedTicketId(item.entityId);
      }
    },
    [load, filter],
  );

  const handleMarkAllRead = useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (!token) return;
      await apiMarkAllNotificationsRead(token);
    } catch {
      // Best-effort — the list re-fetch below still reflects whatever actually happened server-side.
    }
    await load(filter);
  }, [load, filter]);

  if (selectedTicketId) {
    return <TicketDetailScreen ticketId={selectedTicketId} onBack={() => setSelectedTicketId(null)} />;
  }

  return (
    <ScrollView testID="screen-notifications" style={styles.container}>
      <Pressable testID="notifications-back" onPress={onBack} style={styles.backButton}>
        <Text style={styles.backLabel}>{'< Back'}</Text>
      </Pressable>
      <View style={styles.headerRow}>
        <Text style={styles.pageTitle}>Notifications</Text>
        <Pressable testID="notifications-mark-all-read" onPress={() => void handleMarkAllRead()}>
          <Text style={styles.markAllLabel}>Mark All Read</Text>
        </Pressable>
      </View>

      <View style={styles.filterRow}>
        {(['ALL', 'UNREAD'] as const).map((f) => (
          <Pressable
            key={f}
            testID={`notifications-filter-${f}`}
            onPress={() => setFilter(f)}
            style={[styles.filterChip, filter === f ? styles.filterChipActive : null]}
          >
            <Text style={[styles.filterLabel, filter === f ? styles.filterLabelActive : null]}>
              {f === 'ALL' ? 'All' : 'Unread'}
            </Text>
          </Pressable>
        ))}
      </View>

      {state.status === 'ready' && state.items.length === 0 ? (
        <View style={styles.emptyState}>
          <Text testID="notifications-empty" style={styles.emptyText}>
            No notifications yet.
          </Text>
        </View>
      ) : null}

      {state.status === 'ready'
        ? state.items.map((item) => (
            <Pressable
              key={item.id}
              testID={`notification-item-${item.id}`}
              onPress={() => void handleTap(item)}
              style={styles.item}
            >
              {!item.read ? <View testID={`notification-unread-dot-${item.id}`} style={styles.unreadDot} /> : null}
              <View style={styles.itemBody}>
                <Text style={[styles.itemTitle, item.read ? styles.itemTitleRead : null]}>{item.title}</Text>
                {item.body ? <Text style={styles.itemText}>{item.body}</Text> : null}
              </View>
            </Pressable>
          ))
        : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
  },
  backButton: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  backLabel: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.brand600,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.lg,
  },
  pageTitle: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
  },
  markAllLabel: {
    ...typeScale.cellSecondary,
    fontWeight: '600',
    color: color.brand600,
  },
  filterRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  filterChip: {
    borderRadius: radius.full,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    backgroundColor: color.surfaceSunken,
  },
  filterChipActive: {
    backgroundColor: color.brand600,
  },
  filterLabel: {
    ...typeScale.cellSecondary,
    fontWeight: '600',
    color: color.ink,
  },
  filterLabelActive: {
    color: color.onColor,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyText: {
    ...typeScale.body,
    color: color.inkMuted,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: color.line,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: radius.full,
    backgroundColor: color.brand600,
    marginTop: spacing.xs,
  },
  itemBody: {
    flex: 1,
    gap: spacing.xs / 2,
  },
  itemTitle: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.inkStrong,
  },
  itemTitleRead: {
    fontWeight: '600',
    color: color.inkMuted,
  },
  itemText: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
});
