import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { DayPlanView, MeTicketRow, MeWorkHistoryDay } from '@fsm/shared';
import { apiGetDayPlan, apiGetMyTickets, apiGetNotifications, apiGetWorkHistory } from '../../api/client';
import { getConnectivityState } from '../../api/connectivity';
import { useAuth } from '../../auth/AuthProvider';
import { getAccessToken } from '../../auth/tokenStore';
import { BrandMark } from '../../components/kit/BrandMark';
import { StatTile } from '../../components/kit/StatTile';
import { computeHomeKpis } from '../../home/homeKpi';
import { PlantWorkloadCard, type PlantWorkload } from '../../home/PlantWorkloadCard';
import { summarisePlant, type PlantSummary } from '../../home/plantSummary';
import { WorkHistoryChart } from '../../home/WorkHistoryChart';
import { NotificationsScreen } from '../../notifications/NotificationsScreen';
import { color, radius, spacing, typeScale } from '../../theme/tokens';

interface HomeState {
  status: 'loading' | 'ready' | 'offline';
  dayPlan: DayPlanView | null;
  tickets: MeTicketRow[];
  workHistory: MeWorkHistoryDay[];
  unreadNotifications: number;
}

/** Relative "2 min ago"-style label for the Last-sync chip. Purely client-side (see the screen doc);
 *  `null` until this screen has completed a fetch of its own, which is the only thing it can honestly
 *  report on. */
function formatLastSync(at: Date | null, now: Date): string {
  if (!at) return '—';
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} hr ago` : `${Math.floor(hours / 24)} d ago`;
}

/** Avatar-circle initials — "Rahul" → `RA`, "Rahul Sharma" → `RS`. Two characters read better in a
 *  44px circle than one; a blank/whitespace-only name (never expected, but never crashes on) falls
 *  back to a neutral glyph rather than an empty circle. */
function initialsOf(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '•';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// `theme/tokens.ts` has no "readable on the dark brand-red header" semantic pair yet — these two
// dots are scoped to this header only, not a general-purpose token.
const STATUS_DOT_ONLINE = '#34d399';
const STATUS_DOT_OFFLINE = '#f59e0b';

/**
 * #55 (M1) — SE Home, built against `docs/ui/mobile/home-dashboard.png`. Per #172 Decision 1 the
 * image is authority over the PRD's "ordered Day Plan list": branded header + KPI tiles + Next Visit
 * + Assigned-vs-Completed chart + Plant Workload + Open Ticket Pool.
 *
 * Two things the image shows that are deliberately NOT rendered, both settled decisions rather than
 * omissions: the `ID - ANV1012` employee code (#55's superseding 2026-08-03 note — AutoPlant has no
 * employee entity and nothing on `User`/`EngineerMaster` is both unique and human-readable, so a UUID
 * or a phone number under someone's name would be worse than no ID), and the `Scan` FAB, which needs
 * the QR scanner owned by **#20** — an `expo-camera` dependency, i.e. a native module and therefore a
 * full Android rebuild, not a screen-level change.
 *
 * KPI-tile definitions are operator-confirmed (see `homeKpi.ts`); the Next Visit subline and the
 * Plant Workload ratios share one derivation (`plantSummary.ts`) so the two cards cannot disagree
 * about the same plant. "Online / last sync" is purely client-side telemetry — connectivity state
 * plus the timestamp of this screen's own last successful fetch; no backend freshness endpoint exists
 * or applies. The 7-day chart is the one part with a server side of its own (#175,
 * `GET /api/me/work-history`).
 */
export function HomeScreen() {
  const { session } = useAuth();
  const navigation = useNavigation();
  const [state, setState] = useState<HomeState>({
    status: 'loading',
    dayPlan: null,
    tickets: [],
    workHistory: [],
    unreadNotifications: 0,
  });
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
        const [dayPlan, ticketsView, notifications, history] = await Promise.all([
          apiGetDayPlan(token),
          apiGetMyTickets(token),
          apiGetNotifications(token, { unreadOnly: true }),
          // The chart is the only additive read here, and it must not be able to blank the screen:
          // an SE with a working day plan should still see it if the history query fails.
          apiGetWorkHistory(token, 7).catch(() => ({ days: [] })),
        ]);
        if (cancelled) return;
        setState({
          status: 'ready',
          dayPlan,
          tickets: ticketsView.items,
          workHistory: history.days,
          unreadNotifications: notifications.unreadCount,
        });
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

  // One pass over the day plan's stops, cross-referenced against the ticket rows already fetched, for
  // both the Next Visit subline and every Plant Workload card.
  const summaries = useMemo(() => {
    const byPlant = new Map<string, PlantSummary & { plantName: string; plantId: string }>();
    for (const stop of state.dayPlan?.stops ?? []) {
      const stopTicketIds = new Set(stop.tickets.map((t) => t.ticketId));
      const rows = state.tickets.filter((t) => stopTicketIds.has(t.ticketId));
      byPlant.set(stop.plantId, { ...summarisePlant(rows), plantId: stop.plantId, plantName: stop.plantName });
    }
    return byPlant;
  }, [state.dayPlan, state.tickets]);

  const workloads: PlantWorkload[] = [...summaries.values()].map((s) => ({
    plantId: s.plantId,
    plantName: s.plantName,
    done: s.done,
    total: s.total,
  }));
  const nextVisit = firstStop ? summaries.get(firstStop.plantId) ?? null : null;

  if (showNotifications) {
    return <NotificationsScreen onBack={() => setShowNotifications(false)} />;
  }

  const online = state.status !== 'offline';

  return (
    <ScrollView testID="screen-home" style={styles.container} contentContainerStyle={styles.content}>
      {/* Branded header block — product wordmark, avatar/name/plant · zone, notifications bell, and
          the two status chips. Two soft circular washes give the flat brand-red block some depth
          without a gradient library: `expo-linear-gradient` ships native code, which would invalidate
          the installed debug APK and force the #209 Android rebuild for what a plain View achieves. */}
      <View style={styles.header}>
        <View pointerEvents="none" style={styles.decorCircleLarge} />
        <View pointerEvents="none" style={styles.decorCircleSmall} />

        <BrandMark tone="onDark" />

        <View style={styles.headerTop}>
          <View style={styles.headerIdentity}>
            <View style={styles.avatar}>
              <Text style={styles.avatarInitials}>{initialsOf(session?.profile?.name)}</Text>
            </View>
            <View style={styles.identityText}>
              <Text style={styles.name}>{session?.profile?.name ?? ''}</Text>
              <Text style={styles.zone}>
                {[session?.profile?.homePlant?.name, session?.profile?.zoneName].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </View>
          <Pressable
            testID="notifications-button"
            accessibilityLabel="Notifications"
            onPress={() => setShowNotifications(true)}
            style={styles.bellButton}
          >
            <Text style={styles.bellGlyph}>🔔</Text>
            {state.unreadNotifications > 0 ? (
              <View testID="notifications-unread-badge" style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>{state.unreadNotifications}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>

        <View style={styles.chipRow}>
          <View testID={online ? 'home-online-chip' : 'home-offline-badge'} style={styles.chip}>
            <View style={styles.chipHeadline}>
              <View style={[styles.statusDot, { backgroundColor: online ? STATUS_DOT_ONLINE : STATUS_DOT_OFFLINE }]} />
              <Text style={styles.chipValue}>{online ? 'Online' : 'Offline'}</Text>
            </View>
            <Text style={styles.chipLabel}>Network status</Text>
          </View>
          <View testID="home-last-sync-chip" style={styles.chip}>
            <Text style={styles.chipValue}>{formatLastSync(lastSyncAt, new Date())}</Text>
            <Text style={styles.chipLabel}>Last sync</Text>
          </View>
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
              <View style={styles.nextVisitText}>
                <Text style={styles.cardLabel}>NEXT VISIT</Text>
                <Text style={styles.cardTitle}>{firstStop.plantName}</Text>
                {nextVisit ? (
                  <Text testID="next-visit-stats" style={styles.cardSubline}>
                    {`${nextVisit.inactive} inactive · ${nextVisit.urgent} urgent · ${nextVisit.inWork} in work`}
                  </Text>
                ) : null}
              </View>
              <Pressable
                testID="next-visit-view-button"
                onPress={() => navigation.navigate('Tickets' as never)}
                style={styles.viewButton}
              >
                <Text style={styles.viewButtonLabel}>View</Text>
              </Pressable>
            </View>
          ) : null}

          <WorkHistoryChart days={state.workHistory} />

          {workloads.length > 0 ? (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionHeaderText}>
                  <Text style={styles.sectionTitle}>Plant Workload</Text>
                  <Text style={styles.sectionSubtitle}>Active workload overview</Text>
                </View>
                <View testID="plant-workload-count" style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{workloads.length}</Text>
                </View>
              </View>
              <View style={styles.workloadGrid}>
                {workloads.map((workload) => (
                  <PlantWorkloadCard key={workload.plantId} workload={workload} />
                ))}
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
  content: {
    paddingBottom: spacing.xl,
  },
  header: {
    backgroundColor: color.brand700,
    borderBottomLeftRadius: radius.lg + 10,
    borderBottomRightRadius: radius.lg + 10,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.md,
    // Clips the two decorative circles to the block's own rounded corners instead of letting them
    // spill past it.
    overflow: 'hidden',
  },
  // Two soft washes of the same white-on-brand-red the chips/avatar already use — depth without a
  // gradient dependency. Sized and offset so they read as ambient light, not as shapes to notice.
  decorCircleLarge: {
    position: 'absolute',
    top: -90,
    right: -70,
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  decorCircleSmall: {
    position: 'absolute',
    bottom: -60,
    left: -40,
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: 'rgba(255,255,255,0.045)',
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  headerIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    gap: spacing.sm,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    ...typeScale.body,
    fontWeight: '800',
    color: color.onColor,
  },
  identityText: {
    flexShrink: 1,
    gap: 2,
  },
  name: {
    ...typeScale.sectionTitle,
    fontSize: 18,
    lineHeight: 22,
    color: color.onColor,
  },
  zone: {
    ...typeScale.cellSecondary,
    color: color.onColor,
    opacity: 0.85,
  },
  bellButton: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    // A translucent white disc reads as "on the brand block" without needing a second brand token.
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellGlyph: {
    fontSize: 18,
  },
  unreadBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
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
  chipRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  chip: {
    flex: 1,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  chipHeadline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
  },
  chipValue: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
  chipLabel: {
    ...typeScale.cellSecondary,
    color: color.onColor,
    opacity: 0.75,
  },
  section: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  sectionHeaderText: {
    flexShrink: 1,
  },
  sectionSubtitle: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  countBadge: {
    minWidth: 26,
    height: 26,
    borderRadius: radius.full,
    backgroundColor: color.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  countBadgeText: {
    ...typeScale.cellSecondary,
    fontWeight: '700',
    color: color.ink,
  },
  emptyText: {
    ...typeScale.body,
    color: color.inkMuted,
  },
  tileRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
  },
  hidden: {
    position: 'absolute',
    opacity: 0,
    height: 0,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceCard,
  },
  nextVisitText: {
    flexShrink: 1,
    gap: 2,
  },
  cardLabel: {
    ...typeScale.capsLabel,
    color: color.brand600,
  },
  cardTitle: {
    ...typeScale.pageTitle,
    fontSize: 17,
    lineHeight: 22,
    color: color.inkStrong,
  },
  cardSubline: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  viewButton: {
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  viewButtonLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
  sectionTitle: {
    ...typeScale.pageTitle,
    fontSize: 17,
    lineHeight: 22,
    color: color.inkStrong,
  },
  workloadGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: spacing.sm,
  },
  poolButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    margin: spacing.lg,
    backgroundColor: color.brand700,
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  poolLabel: {
    ...typeScale.body,
    fontSize: 16,
    fontWeight: '700',
    color: color.onColor,
  },
  poolCount: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
});
