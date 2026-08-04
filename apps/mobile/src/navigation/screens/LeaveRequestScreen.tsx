import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { LeaveRequestRow } from '@fsm/shared';
import { apiGetMyLeaveRequests } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { StatusPill } from '../../components/kit/StatusPill';
import { LeaveRequestFormScreen } from '../../leave/LeaveRequestFormScreen';
import { formatLeaveDate, formatLeaveTypeLabel, leaveStatusLabel, leaveStatusSemantic } from '../../leave/leaveDisplay';
import { color, radius, spacing, typeScale } from '../../theme/tokens';

type Status = 'loading' | 'ready' | 'offline';

export interface LeaveRequestScreenProps {
  onBack: () => void;
}

/**
 * #86 (M8b) — SE Leave Request: My Leave Requests list (every status, so a past rejection's
 * `decisionReason` stays visible) + New Leave Request. Same local-swap show/hide pattern
 * `VouchersScreen` established. A rejected request is terminal — "resubmit" is just filing a new
 * request via the same form, there's no edit-in-place.
 */
export function LeaveRequestScreen({ onBack }: LeaveRequestScreenProps) {
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<LeaveRequestRow[]>([]);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      const view = await apiGetMyLeaveRequests(token);
      setItems(view.items);
      setStatus('ready');
    } catch {
      setStatus('offline');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (showForm) {
    return (
      <LeaveRequestFormScreen
        onCancel={() => setShowForm(false)}
        onSubmitted={() => {
          setShowForm(false);
          void load();
        }}
      />
    );
  }

  return (
    <View testID="screen-leave-requests" style={styles.container}>
      <Pressable testID="leave-requests-back" onPress={onBack} style={styles.backButton}>
        <Text style={styles.backLabel}>{'< Back'}</Text>
      </Pressable>
      <View style={styles.header}>
        <Text style={styles.pageTitle}>Leave Requests</Text>
        <Pressable testID="leave-new-button" onPress={() => setShowForm(true)} style={styles.newButton}>
          <Text style={styles.newButtonLabel}>New Request</Text>
        </Pressable>
      </View>

      {status === 'offline' ? (
        <Text testID="leave-requests-offline" style={styles.offlineText}>
          Offline — showing the last synced list.
        </Text>
      ) : null}

      {status !== 'loading' ? (
        <FlatList
          testID="leave-requests-list"
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <LeaveRow row={item} />}
          ListEmptyComponent={
            <Text testID="leave-requests-empty" style={styles.emptyText}>
              No leave requests yet.
            </Text>
          }
        />
      ) : null}
    </View>
  );
}

function LeaveRow({ row }: { row: LeaveRequestRow }) {
  return (
    <View testID={`leave-row-${row.id}`} style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowType}>{formatLeaveTypeLabel(row.type)}</Text>
        <StatusPill label={leaveStatusLabel(row.status)} status={leaveStatusSemantic(row.status)} />
      </View>
      <Text style={styles.rowWindow}>
        {formatLeaveDate(row.windowStart)} – {formatLeaveDate(row.windowEnd)}
      </Text>
      {row.status === 'REJECTED' && row.decisionReason ? (
        <Text style={styles.decisionReason}>{row.decisionReason}</Text>
      ) : null}
    </View>
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.lg,
  },
  pageTitle: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
  },
  newButton: {
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  newButtonLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
  offlineText: {
    ...typeScale.cellSecondary,
    color: color.warning,
    paddingHorizontal: spacing.lg,
  },
  emptyText: {
    ...typeScale.body,
    color: color.inkMuted,
    padding: spacing.lg,
  },
  row: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceCard,
    gap: spacing.xs,
  },
  rowMain: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowType: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.inkStrong,
  },
  rowWindow: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  decisionReason: {
    ...typeScale.cellSecondary,
    color: color.critical,
  },
});
