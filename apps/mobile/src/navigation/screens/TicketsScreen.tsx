import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MeTicketRow, MeTicketWorkState } from '@fsm/shared';
import { apiGetMyTickets } from '../../api/client';
import { getConnectivityState } from '../../api/connectivity';
import { getAccessToken } from '../../auth/tokenStore';
import { TicketCard } from '../../components/kit/TicketCard';
import { color, radius, spacing, typeScale } from '../../theme/tokens';
import { computePlanCues, type PlanCues } from '../../tickets/dayPlanCues';
import { formatSlaBucketLabel, slaBucketToStatus, workStateLabel } from '../../tickets/ticketDisplay';
import { TicketDetailScreen } from '../../tickets/detail/TicketDetailScreen';

const NO_CUES: PlanCues = { addedIds: new Set(), removedRows: [] };

interface TicketsState {
  status: 'loading' | 'ready' | 'offline-no-cache';
  items: MeTicketRow[];
  offline: boolean;
  cues: PlanCues;
}

type TicketFilter = 'ALL' | MeTicketWorkState;

const FILTER_CHIPS: { key: TicketFilter; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'VISIT_NOW', label: 'Visit Now' },
  { key: 'PLAN', label: 'Plan' },
  { key: 'IN_WORK', label: 'In Work' },
  { key: 'VERIFY', label: 'Verify' },
];

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
 *  split. "Visit Now" = workState VISIT_NOW; "Other Tickets" = PLAN/IN_WORK/VERIFY. Row tap opens
 *  Ticket Detail (M3/#57) via local state, not a stack navigator — none wraps this tab yet. */
export function TicketsScreen() {
  const [state, setState] = useState<TicketsState>({ status: 'loading', items: [], offline: false, cues: NO_CUES });
  const [filter, setFilter] = useState<TicketFilter>('ALL');
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

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
        // #66 — computePlanCues has side effects (it advances the module's diff cache), so it must
        // run exactly once per successful fetch, never inside render.
        const cues = computePlanCues(view.items);
        if (!cancelled) setState({ status: 'ready', items: view.items, offline: false, cues });
      } catch {
        if (!cancelled) setState((s) => ({ ...s, status: s.items.length ? 'ready' : 'offline-no-cache', offline: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (selectedTicketId) {
    return <TicketDetailScreen ticketId={selectedTicketId} onBack={() => setSelectedTicketId(null)} />;
  }

  const visibleItems = filter === 'ALL' ? state.items : state.items.filter((i) => i.workState === filter);
  const visibleRemoved = filter === 'ALL' ? state.cues.removedRows : state.cues.removedRows.filter((i) => i.workState === filter);
  const orderBySection = (workStateMatch: (w: MeTicketWorkState) => boolean) => {
    const live = visibleItems.filter((i) => workStateMatch(i.workState));
    const added = live.filter((i) => state.cues.addedIds.has(i.ticketId));
    const rest = live.filter((i) => !state.cues.addedIds.has(i.ticketId));
    return { removed: visibleRemoved.filter((i) => workStateMatch(i.workState)), ordered: [...added, ...rest] };
  };
  const visitNowSection = orderBySection((w) => w === 'VISIT_NOW');
  const otherSection = orderBySection((w) => w !== 'VISIT_NOW');

  return (
    <View testID="screen-tickets" style={styles.container}>
      {state.offline ? (
        <View testID="tickets-offline-banner" style={styles.offlineBanner}>
          <Text style={styles.offlineText}>Offline — showing the last cached list</Text>
        </View>
      ) : null}
      {state.status !== 'offline-no-cache' ? (
        <View style={styles.chipRow}>
          {FILTER_CHIPS.map((chip) => {
            const active = filter === chip.key;
            return (
              <Pressable
                key={chip.key}
                testID={`ticket-filter-${chip.key}`}
                onPress={() => setFilter(chip.key)}
                style={[styles.chip, active ? styles.chipActive : null]}
              >
                <Text style={[styles.chipLabel, active ? styles.chipLabelActive : null]}>{chip.label}</Text>
              </Pressable>
            );
          })}
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
            {visitNowSection.removed.length === 0 && visitNowSection.ordered.length === 0 ? (
              <Text testID="tickets-visit-now-empty" style={styles.emptyText}>
                Nothing urgent right now.
              </Text>
            ) : (
              <>
                {visitNowSection.removed.map((row) => (
                  <TicketCard key={`removed-${row.ticketId}`} ticket={toCardData(row)} badge={{ label: 'Removed', status: 'critical' }} />
                ))}
                {visitNowSection.ordered.map((row) => (
                  <TicketCard
                    key={row.ticketId}
                    ticket={toCardData(row)}
                    onPress={() => setSelectedTicketId(row.ticketId)}
                    badge={state.cues.addedIds.has(row.ticketId) ? { label: 'Newly Added', status: 'info' } : undefined}
                  />
                ))}
              </>
            )}
          </View>
          <View testID="tickets-other-section" style={styles.section}>
            <Text style={styles.sectionTitle}>Other Tickets</Text>
            <Text style={styles.sectionSubtitle}>Planned, in-work, and verification tickets</Text>
            {otherSection.removed.length === 0 && otherSection.ordered.length === 0 ? (
              <Text testID="tickets-other-empty" style={styles.emptyText}>
                No other tickets on your list.
              </Text>
            ) : (
              <>
                {otherSection.removed.map((row) => (
                  <TicketCard key={`removed-${row.ticketId}`} ticket={toCardData(row)} badge={{ label: 'Removed', status: 'critical' }} />
                ))}
                {otherSection.ordered.map((row) => (
                  <TicketCard
                    key={row.ticketId}
                    ticket={toCardData(row)}
                    onPress={() => setSelectedTicketId(row.ticketId)}
                    badge={state.cues.addedIds.has(row.ticketId) ? { label: 'Newly Added', status: 'info' } : undefined}
                  />
                ))}
              </>
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
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    padding: spacing.lg,
    paddingBottom: 0,
  },
  chip: {
    borderRadius: radius.full,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    backgroundColor: color.surfaceSunken,
  },
  chipActive: {
    backgroundColor: color.brand600,
  },
  chipLabel: {
    ...typeScale.cellSecondary,
    fontWeight: '600',
    color: color.ink,
  },
  chipLabelActive: {
    color: color.onColor,
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
