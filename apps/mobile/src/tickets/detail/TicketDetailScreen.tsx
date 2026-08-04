import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MeTicketDetailView, VerificationView } from '@fsm/shared';
import { apiGetTicketDetail, apiGetTicketVerification } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { StatusPill } from '../../components/kit/StatusPill';
import { color, radius, spacing, typeScale } from '../../theme/tokens';
import { formatSlaBucketLabel, slaBucketToStatus } from '../ticketDisplay';
import { formatInactiveDuration } from './ticketDetailDisplay';

type ScreenState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; detail: MeTicketDetailView }
  | { status: 'verification-pending'; detail: MeTicketDetailView; verification: VerificationView };

export interface TicketDetailScreenProps {
  ticketId: string;
}

/**
 * #57 (M3) — Ticket Detail, both states. `GET /tickets/:id/verification` 404s
 * (`NO_VERIFICATION_RUN`) until a run exists, so it's only fetched once `detail.status ===
 * 'VERIFICATION_PENDING'`. No Timeline section — `MeTicketDetailView` carries no generic
 * lifecycle-events field to source it from; not fabricated from unrelated data. Soft-state actions
 * (VIEWED auto-post, ON_SITE button) are a separate slice — this component renders, it doesn't act.
 */
export function TicketDetailScreen({ ticketId }: TicketDetailScreenProps) {
  const [state, setState] = useState<ScreenState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('UNAUTHORIZED');
        const detail = await apiGetTicketDetail(token, ticketId);
        if (cancelled) return;
        if (detail.status === 'VERIFICATION_PENDING') {
          const verification = await apiGetTicketVerification(token, ticketId);
          if (!cancelled) setState({ status: 'verification-pending', detail, verification });
        } else {
          setState({ status: 'ready', detail });
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof Error && error.message === 'TICKET_NOT_FOUND') {
          setState({ status: 'not-found' });
        } else {
          setState({ status: 'error' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  if (state.status === 'loading') {
    return <View testID="ticket-detail-loading" style={styles.container} />;
  }
  if (state.status === 'not-found') {
    return (
      <View testID="ticket-detail-not-found" style={styles.centered}>
        <Text style={styles.emptyText}>This ticket isn&apos;t available.</Text>
      </View>
    );
  }
  if (state.status === 'error') {
    return (
      <View testID="ticket-detail-error" style={styles.centered}>
        <Text style={styles.emptyText}>Couldn&apos;t load this ticket. Pull to retry.</Text>
      </View>
    );
  }

  const { detail } = state;
  const priorityStatus = slaBucketToStatus(detail.slaBucket);
  const priorityLabel = formatSlaBucketLabel(detail.slaBucket);
  const inactiveDuration = formatInactiveDuration(detail.technicalHealth.dataAsOf);

  return (
    <ScrollView testID="screen-ticket-detail" style={styles.container}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.ticketNo}>{detail.ticketNoDisplay}</Text>
          <Text style={styles.vehicleNo}>{detail.vehicleNo ?? detail.ticketNoDisplay}</Text>
        </View>
        <StatusPill label={priorityLabel} status={priorityStatus} />
      </View>
      <View style={styles.metaRow}>
        <Text style={styles.metaText}>{detail.deviceId}</Text>
        {inactiveDuration ? <Text style={styles.metaText}>{inactiveDuration} inactive</Text> : null}
      </View>

      {state.status === 'verification-pending' ? (
        <View testID="verification-pending-card" style={styles.card}>
          <Text style={styles.cardTitle}>Verification pending</Text>
          <Text style={styles.cardSubtitle}>GPS recovery check running.</Text>
          <Text style={styles.badgeText}>{state.verification.badge ?? 'PENDING'}</Text>
          <Text style={styles.metaText}>{state.verification.pingsReceivedCount} ping(s) received</Text>
        </View>
      ) : (
        <View testID="ready-card" style={styles.card}>
          <Text style={styles.cardTitle}>Ready to start</Text>
          <Text style={styles.cardSubtitle}>Start only when field work begins.</Text>
        </View>
      )}

      <View style={styles.infoRow}>
        <Text style={styles.infoLabel}>Plant</Text>
        <Text style={styles.infoValue}>{detail.plantName}</Text>
      </View>
      {detail.transporterName ? (
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Transporter</Text>
          <Text style={styles.infoValue}>{detail.transporterName}</Text>
        </View>
      ) : null}

      {detail.technicalHealth.available ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Technical Health</Text>
          <View style={styles.hintRow}>
            {detail.technicalHealth.hints.map((h) => (
              <Text key={h.code} style={styles.hintText}>
                {h.label}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyText: {
    ...typeScale.body,
    color: color.inkMuted,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: spacing.lg,
  },
  ticketNo: {
    ...typeScale.capsLabel,
    color: color.inkCaps,
  },
  vehicleNo: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
  },
  metaRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  metaText: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  card: {
    margin: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceCard,
    gap: spacing.xs,
  },
  cardTitle: {
    ...typeScale.sectionTitle,
    color: color.inkStrong,
  },
  cardSubtitle: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  badgeText: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.verified,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: color.line,
  },
  infoLabel: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  infoValue: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.inkStrong,
  },
  section: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typeScale.sectionTitle,
    color: color.inkStrong,
  },
  hintRow: {
    gap: spacing.xs,
  },
  hintText: {
    ...typeScale.body,
    color: color.critical,
  },
});
