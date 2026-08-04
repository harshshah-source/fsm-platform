import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MeTicketRow } from '@fsm/shared';
import { apiGetMyTickets } from '../../api/client';
import { getConnectivityState } from '../../api/connectivity';
import { getAccessToken } from '../../auth/tokenStore';
import { TicketCard } from '../../components/kit/TicketCard';
import { color, spacing, typeScale } from '../../theme/tokens';
import { formatSlaBucketLabel, slaBucketToStatus, workStateLabel } from '../../tickets/ticketDisplay';

interface TicketsState {
  status: 'loading' | 'ready' | 'offline-no-cache';
  items: MeTicketRow[];
  offline: boolean;
}

function toCardData(row: MeTicketRow) {
  return {
    // #56: vehicleNo is null when the ticket has no vehicle attached — fall back to the
    // ticket-number label (always present) rather than an opaque device/vehicle id.
    vehicleNo: row.vehicleNo ?? row.ticketNoDisplay,
    plantName: row.plantName,
    gpsId: row.deviceId,
    transporterName: row.companyName,
    issueDescription: row.topHint?.label ?? '',
    priorityLabel: formatSlaBucketLabel(row.slaBucket),
    priorityStatus: slaBucketToStatus(row.slaBucket),
    statusLabel: workStateLabel(row.workState),
    statusStatus: row.workState === 'VISIT_NOW' ? ('critical' as const) : ('info' as const),
  };
}

/** #56 (M2) — per #172 Decision 3, one merged list grouped by urgency, no assigned/pool visual
 *  split. "Visit Now" = workState VISIT_NOW; "Other Tickets" = PLAN/IN_WORK/VERIFY. Row tap ->
 *  Ticket Detail (M3/#57) is not wired — that screen doesn't exist yet. */
export function TicketsScreen() {
  const [state, setState] = useState<TicketsState>({ status: 'loading', items: [], offline: false });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const connectivity = await getConnectivityState();
      if (connectivity === 'offline') {
        if (!cancelled) setState((s) => ({ ...s, status: s.items.length ? 'ready' : 'offline-no-cache', offline: true }));
        return;
      }
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('UNAUTHORIZED');
        const view = await apiGetMyTickets(token);
        if (!cancelled) setState({ status: 'ready', items: view.items, offline: false });
      } catch {
        if (!cancelled) setState((s) => ({ ...s, status: s.items.length ? 'ready' : 'offline-no-cache', offline: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visitNow = state.items.filter((i) => i.workState === 'VISIT_NOW');
  const other = state.items.filter((i) => i.workState !== 'VISIT_NOW');

  return (
    <View testID="screen-tickets" style={styles.container}>
      {state.offline ? (
        <View testID="tickets-offline-banner" style={styles.offlineBanner}>
          <Text style={styles.offlineText}>Offline — showing the last cached list</Text>
        </View>
      ) : null}
      {state.status === 'offline-no-cache' ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>No cached tickets yet — connect to load your list.</Text>
        </View>
      ) : (
        <ScrollView>
          <View testID="tickets-visit-now-section" style={styles.section}>
            <Text style={styles.sectionTitle}>Visit Now</Text>
            <Text style={styles.sectionSubtitle}>Most urgent tickets across all plants</Text>
            {visitNow.length === 0 ? (
              <Text testID="tickets-visit-now-empty" style={styles.emptyText}>
                Nothing urgent right now.
              </Text>
            ) : (
              visitNow.map((row) => <TicketCard key={row.ticketId} ticket={toCardData(row)} />)
            )}
          </View>
          <View testID="tickets-other-section" style={styles.section}>
            <Text style={styles.sectionTitle}>Other Tickets</Text>
            <Text style={styles.sectionSubtitle}>Planned, in-work, and verification tickets</Text>
            {other.length === 0 ? (
              <Text testID="tickets-other-empty" style={styles.emptyText}>
                No other tickets on your list.
              </Text>
            ) : (
              other.map((row) => <TicketCard key={row.ticketId} ticket={toCardData(row)} />)
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
  },
  offlineBanner: {
    backgroundColor: color.warningBg,
    padding: spacing.sm,
  },
  offlineText: {
    ...typeScale.cellSecondary,
    color: color.warning,
    textAlign: 'center',
  },
  section: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typeScale.sectionTitle,
    color: color.inkStrong,
  },
  sectionSubtitle: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
    marginBottom: spacing.xs,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyText: {
    ...typeScale.body,
    color: color.inkMuted,
  },
});
