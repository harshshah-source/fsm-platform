import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { MeVoucherRow, MeVouchersView } from '@fsm/shared';
import { apiGetMyVouchers } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { StatTile } from '../../components/kit/StatTile';
import { StatusPill } from '../../components/kit/StatusPill';
import { color, radius, spacing, typeScale } from '../../theme/tokens';
import { VoucherFormScreen } from '../../vouchers/VoucherFormScreen';
import { formatCategoryLabel, voucherStatusLabel, voucherStatusSemantic } from '../../vouchers/voucherDisplay';

type Status = 'loading' | 'ready' | 'offline';

/**
 * #61 (M7) — the SE Vouchers tab: My Vouchers list (all 7 statuses, PRD §494) + New Voucher capture
 * (#172 Decision 6 single-photo scope — see `VoucherFormScreen`'s own doc comment). Same
 * local-state show/hide drill-down pattern #58/#59 established (no stack navigator wraps the tab
 * shell yet).
 */
export function VouchersScreen() {
  const [status, setStatus] = useState<Status>('loading');
  const [view, setView] = useState<MeVouchersView | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    setStatus('loading');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      const result = await apiGetMyVouchers(token);
      setView(result);
      setStatus('ready');
    } catch {
      setStatus('offline');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (showForm) {
    return (
      <VoucherFormScreen
        onCancel={() => setShowForm(false)}
        onSubmitted={() => {
          setShowForm(false);
          void load();
        }}
      />
    );
  }

  return (
    <View testID="screen-vouchers" style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.pageTitle}>Vouchers</Text>
        <Pressable testID="voucher-new-button" onPress={() => setShowForm(true)} style={styles.newButton}>
          <Text style={styles.newButtonLabel}>New Voucher</Text>
        </Pressable>
      </View>

      {status === 'offline' ? (
        <Text testID="vouchers-offline" style={styles.offlineText}>
          Offline — showing the last synced list.
        </Text>
      ) : null}

      {status !== 'loading' && view ? (
        <>
          <View style={styles.summaryRow}>
            <StatTile testID="voucher-summary-claimed" value={view.summary.claimedTotal} label="CLAIMED" status="info" />
            <StatTile testID="voucher-summary-pending" value={view.summary.pendingCount} label="PENDING" status="warning" />
            <StatTile testID="voucher-summary-approved" value={view.summary.approvedCount} label="APPROVED" status="success" />
          </View>

          <FlatList
            testID="voucher-list"
            data={view.items}
            keyExtractor={(item) => item.voucherId}
            renderItem={({ item }) => <VoucherRow row={item} />}
            ListEmptyComponent={
              <Text testID="vouchers-empty" style={styles.emptyText}>
                No vouchers yet.
              </Text>
            }
          />
        </>
      ) : null}
    </View>
  );
}

function VoucherRow({ row }: { row: MeVoucherRow }) {
  const categories = [...new Set(row.items.map((i) => formatCategoryLabel(i.category)))].join(', ');
  return (
    <View testID={`voucher-row-${row.voucherId}`} style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowCategory}>{categories || '—'}</Text>
        <Text style={styles.rowAmount}>₹{row.totalAmount.toFixed(2)}</Text>
      </View>
      <StatusPill label={voucherStatusLabel(row.status)} status={voucherStatusSemantic(row.status)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
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
  summaryRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
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
  },
  rowCategory: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.inkStrong,
  },
  rowAmount: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.inkStrong,
  },
});
