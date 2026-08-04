import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ComponentRequestRow } from '@fsm/shared';
import { apiConfirmReceipt, apiGetMyComponentRequests, apiGetVanStock } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { StatTile } from '../../components/kit/StatTile';
import { StatusPill } from '../../components/kit/StatusPill';
import { mergeVanStockRows, vanStockSummary, type VanStockRow } from '../../stock/vanStockDisplay';
import { color, radius, spacing, typeScale } from '../../theme/tokens';

interface StockState {
  status: 'loading' | 'ready' | 'error';
  rows: VanStockRow[];
  kitComplete: boolean;
  requests: ComponentRequestRow[];
}

/**
 * #60 (M6) — Stock tab. Read surface of `/me/van-stock` + `/me/component-requests` (#163), plus SE
 * Confirm Receipt. Not built: the per-row "Request" button and the Zone Warehouse row (#172
 * Decision 2's fuller surface — both need #173's still-unbuilt SE write/read endpoints); Scan
 * Serial / Use Part (deferred behind #101 by the ratification itself, not this build's call).
 */
export function StockScreen() {
  const [state, setState] = useState<StockState>({ status: 'loading', rows: [], kitComplete: true, requests: [] });
  const [confirming, setConfirming] = useState<string | null>(null);

  const loadRequests = useCallback(async (token: string) => {
    const view = await apiGetMyComponentRequests(token);
    setState((s) => ({ ...s, requests: view.items }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('UNAUTHORIZED');
        const [vanStock, requestsView] = await Promise.all([apiGetVanStock(token), apiGetMyComponentRequests(token)]);
        if (cancelled) return;
        setState({
          status: 'ready',
          rows: mergeVanStockRows(vanStock),
          kitComplete: vanStock.commonKit.complete,
          requests: requestsView.items,
        });
      } catch {
        if (!cancelled) setState((s) => ({ ...s, status: 'error' }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConfirmReceipt = async (requestId: string) => {
    setConfirming(requestId);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      await apiConfirmReceipt(token, requestId);
      await loadRequests(token);
    } catch {
      // Inline error rendering for a 409 COMPONENT_REQUEST_INVALID_STATE is a reasonable follow-up;
      // not building a bespoke banner for a case the button's own visibility already narrows to
      // SHIPPED-only requests (see the edge case note on #60 itself).
    } finally {
      setConfirming(null);
    }
  };

  const summary = vanStockSummary(state.rows);

  return (
    <ScrollView testID="screen-stock" style={styles.container}>
      <Text style={styles.pageTitle}>Inventory</Text>

      {state.status === 'error' ? (
        <View style={styles.section}>
          <Text style={styles.emptyText}>Couldn&apos;t load your stock. Pull to retry.</Text>
        </View>
      ) : (
        <>
          <View style={styles.tileRow}>
            <StatTile value={summary.available} label="AVAILABLE" status="success" />
            <StatTile value={summary.low} label="LOW STOCK" status="critical" />
            <StatTile value={summary.healthy} label="HEALTHY" status="info" />
          </View>

          <View testID={state.kitComplete ? 'kit-status-complete' : 'kit-status-incomplete'} style={styles.kitRow}>
            <StatusPill label={state.kitComplete ? 'Kit Complete' : 'Kit Incomplete'} status={state.kitComplete ? 'success' : 'critical'} />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Stock Health</Text>
            {state.rows.map((row) => (
              <View key={row.componentId} style={styles.stockRow}>
                <Text style={styles.stockName}>{row.name}</Text>
                <View style={styles.stockRight}>
                  <StatusPill label={row.status} status={row.status === 'LOW' ? 'critical' : 'success'} />
                  <Text style={styles.stockQty}>{row.qty}</Text>
                </View>
              </View>
            ))}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Requests</Text>
            {state.requests.length === 0 ? (
              <Text style={styles.emptyText}>No component requests.</Text>
            ) : (
              state.requests.map((req) => (
                <View key={req.requestId} style={styles.requestRow}>
                  <View>
                    <Text style={styles.stockName}>{req.componentName ?? 'Component'}</Text>
                    <StatusPill label={req.status} status={req.status === 'REJECTED' ? 'critical' : 'info'} />
                  </View>
                  {req.status === 'SHIPPED' ? (
                    <Pressable
                      testID={`confirm-receipt-${req.requestId}`}
                      disabled={confirming === req.requestId}
                      onPress={() => void handleConfirmReceipt(req.requestId)}
                      style={styles.confirmButton}
                    >
                      <Text style={styles.confirmLabel}>
                        {confirming === req.requestId ? 'Confirming…' : 'Confirm Receipt'}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ))
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
  },
  pageTitle: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
    padding: spacing.lg,
    paddingBottom: 0,
  },
  tileRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.lg,
  },
  kitRow: {
    paddingHorizontal: spacing.lg,
  },
  section: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typeScale.sectionTitle,
    color: color.inkStrong,
  },
  emptyText: {
    ...typeScale.body,
    color: color.inkMuted,
  },
  stockRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  stockName: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.inkStrong,
  },
  stockRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  stockQty: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.inkStrong,
  },
  requestRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
    gap: spacing.sm,
  },
  confirmButton: {
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  confirmLabel: {
    ...typeScale.cellSecondary,
    fontWeight: '700',
    color: color.onColor,
  },
});
