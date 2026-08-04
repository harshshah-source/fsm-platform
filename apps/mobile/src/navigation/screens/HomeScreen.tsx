import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { DayPlanView, MeTicketRow } from '@fsm/shared';
import { apiGetDayPlan, apiGetMyTickets, apiGetNotifications } from '../../api/client';
import { getConnectivityState } from '../../api/connectivity';
import { useAuth } from '../../auth/AuthProvider';
import { getAccessToken } from '../../auth/tokenStore';
import { ProgressBar } from '../../components/kit/ProgressBar';
import { StatTile } from '../../components/kit/StatTile';
import { computeHomeKpis } from '../../home/homeKpi';
import { NotificationsScreen } from '../../notifications/NotificationsScreen';
import { color, radius, spacing, typeScale } from '../../theme/tokens';

interface HomeState {
  status: 'loading' | 'ready' | 'offline';
  dayPlan: DayPlanView | null;
  tickets: MeTicketRow[];
  unreadNotifications: number;
}

/**
 * #55 (M1) — SE Home. Per #172 Decision 1: KPI tiles + Next Visit + Plant Workload + Open Ticket
 * Pool + Scan FAB, no employeeCode (cancelled per #161), no Common-Kit badge (moved to Inventory,
 * #60), no 7-day chart (deferred to #175). KPI-tile definitions confirmed by the operator
 * 2026-08-04 (see `homeKpi.ts`). "Online/last-sync" is purely client-side telemetry (connectivity
 * state + the timestamp of this screen's own last successful fetch) — no backend freshness
 * endpoint exists or is needed for it.
 */
export function HomeScreen() {
  const { session } = useAuth();
  const navigation = useNavigation();
  const [state, setState] = useState<HomeState>({ status: 'loading', dayPlan: null, tickets: [], unreadNotifications: 0 });
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const connectivity = await getConnectivityState();
      if (connectivity === 'offline') {
        if (!cancelled) setState((s) => ({ ...s, status: 'offline' }));
        return;
      }
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('UNAUTHORIZED');
        const [dayPlan, ticketsView, notifications] = await Promise.all([
          apiGetDayPlan(token),
          apiGetMyTickets(token),
          apiGetNotifications(token, { unreadOnly: true }),
        ]);
        if (cancelled) return;
        setState({ status: 'ready', dayPlan, tickets: ticketsView.items, unreadNotifications: notifications.unreadCount });
        setLastSyncAt(new Date());
      } catch {
        if (!cancelled) setState((s) => ({ ...s, status: 'offline' }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const kpis = computeHomeKpis(state.tickets);
  const poolCount = state.tickets.filter((t) => !t.assigned).length;
  const firstStop = state.dayPlan?.stops[0] ?? null;

  if (showNotifications) {
    return <NotificationsScreen onBack={() => setShowNotifications(false)} />;
  }

  return (
    <ScrollView testID="screen-home" style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.name}>{session?.profile?.name ?? ''}</Text>
          <Text style={styles.zone}>{session?.profile?.zoneName ?? ''}</Text>
        </View>
        <View style={styles.headerRight}>
          <Pressable testID="notifications-button" onPress={() => setShowNotifications(true)} style={styles.notificationsButton}>
            <Text style={styles.notificationsLabel}>Notifications</Text>
            {state.unreadNotifications > 0 ? (
              <View testID="notifications-unread-badge" style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>{state.unreadNotifications}</Text>
              </View>
            ) : null}
          </Pressable>
          {state.status === 'offline' ? (
            <View testID="home-offline-badge" style={styles.offlineBadge}>
              <Text style={styles.offlineText}>Offline</Text>
            </View>
          ) : (
            <Text style={styles.syncText}>{lastSyncAt ? 'Synced' : ''}</Text>
          )}
        </View>
      </View>

      {state.status !== 'ready' ? null : state.dayPlan && !state.dayPlan.dispatched ? (
        <View style={styles.section}>
          <Text style={styles.emptyText}>Your plan is being prepared — check back shortly.</Text>
        </View>
      ) : (
        <>
          <View style={styles.tileRow}>
            <StatTile value={kpis.started} label="STARTED" status="info" testID="home-kpi-started-tile" />
            <StatTile value={kpis.completed} label="COMPLETED" status="success" testID="home-kpi-completed-tile" />
            <StatTile value={kpis.verified} label="VERIFIED" status="verified" testID="home-kpi-verified-tile" />
            <StatTile value={kpis.failed} label="FAILED" status="critical" testID="home-kpi-failed-tile" />
          </View>
          {/* Plain-number nodes for tests to read counts unambiguously off StatTile's rendered text. */}
          <Text testID="home-kpi-started" style={styles.hidden}>
            {kpis.started}
          </Text>
          <Text testID="home-kpi-completed" style={styles.hidden}>
            {kpis.completed}
          </Text>

          {firstStop ? (
            <View testID="next-visit-card" style={styles.card}>
              <Text style={styles.cardLabel}>NEXT VISIT</Text>
              <Text style={styles.cardTitle}>{firstStop.plantName}</Text>
              <Pressable
                testID="next-visit-view-button"
                onPress={() => navigation.navigate('Tickets' as never)}
                style={styles.viewButton}
              >
                <Text style={styles.viewButtonLabel}>View</Text>
              </Pressable>
            </View>
          ) : null}

          {state.dayPlan && state.dayPlan.stops.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Plant Workload</Text>
              <View style={styles.workloadGrid}>
                {state.dayPlan.stops.map((stop) => {
                  const stopTicketIds = new Set(stop.tickets.map((t) => t.ticketId));
                  const stopRows = state.tickets.filter((t) => stopTicketIds.has(t.ticketId));
                  const done = stopRows.filter((t) => t.status === 'CLOSED' || t.status === 'CLOSED_AUTO_RECOVERY').length;
                  return (
                    <View key={stop.batchId} testID={`plant-workload-${stop.plantId}`} style={styles.workloadCard}>
                      <Text style={styles.workloadPlant}>{stop.plantName}</Text>
                      <ProgressBar value={done} max={stopRows.length || 1} />
                      <Text style={styles.workloadCount}>
                        {done} / {stopRows.length}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          ) : null}

          <Pressable
            testID="open-ticket-pool-button"
            onPress={() => navigation.navigate('Tickets' as never)}
            style={styles.poolButton}
          >
            <Text style={styles.poolLabel}>Open Ticket Pool</Text>
            <Text style={styles.poolCount}>{poolCount}</Text>
          </Pressable>
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.lg,
  },
  name: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
  },
  zone: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  headerRight: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  notificationsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  notificationsLabel: {
    ...typeScale.cellSecondary,
    fontWeight: '600',
    color: color.brand600,
  },
  unreadBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: radius.full,
    backgroundColor: color.critical,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs / 2,
  },
  unreadBadgeText: {
    ...typeScale.cellSecondary,
    fontSize: 11,
    fontWeight: '700',
    color: color.onColor,
  },
  offlineBadge: {
    backgroundColor: color.warningBg,
    borderRadius: radius.full,
    paddingVertical: spacing.xs / 2,
    paddingHorizontal: spacing.sm,
  },
  offlineText: {
    ...typeScale.cellSecondary,
    color: color.warning,
  },
  syncText: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  section: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  emptyText: {
    ...typeScale.body,
    color: color.inkMuted,
  },
  tileRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  hidden: {
    position: 'absolute',
    opacity: 0,
    height: 0,
  },
  card: {
    margin: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceCard,
    gap: spacing.xs,
  },
  cardLabel: {
    ...typeScale.capsLabel,
    color: color.brand600,
  },
  cardTitle: {
    ...typeScale.sectionTitle,
    color: color.inkStrong,
  },
  viewButton: {
    alignSelf: 'flex-start',
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
  },
  viewButtonLabel: {
    ...typeScale.cellSecondary,
    fontWeight: '700',
    color: color.onColor,
  },
  sectionTitle: {
    ...typeScale.sectionTitle,
    color: color.inkStrong,
  },
  workloadGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  workloadCard: {
    width: '47%',
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceCard,
    gap: spacing.xs,
  },
  workloadPlant: {
    ...typeScale.cellSecondary,
    fontWeight: '600',
    color: color.inkStrong,
  },
  workloadCount: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  poolButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    margin: spacing.lg,
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  poolLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
  poolCount: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
});
