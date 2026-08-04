import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { VerificationCheck, VerificationView } from '@fsm/shared';
import { apiGetTicketVerification } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { StatusPill } from '../../components/kit/StatusPill';
import { color, radius, spacing, typeScale } from '../../theme/tokens';

export interface VerificationScreenProps {
  ticketId: string;
  ticketNoDisplay: string;
  /** Escalated is rendered from the ticket's own status, not `VerificationView.outcome` — the
   *  operator decided (2026-08-04) it is not a real verification outcome (PRD:412 lists it only as
   *  a ticket badge), so no `VerifyOutcome` enum change was made. */
  ticketStatus: string;
  onBack: () => void;
}

function checkStatus(state: VerificationCheck['state']): 'success' | 'critical' | 'neutral' {
  if (state === 'PASS') return 'success';
  if (state === 'FAIL') return 'critical';
  return 'neutral';
}

const BADGE_COPY: Record<string, { title: string; subtitle: string }> = {
  PARTIAL_RECOVERY: { title: 'Repair submitted', subtitle: 'GPS recovery check is running.' },
  CLOSED: { title: 'Verified', subtitle: 'GPS recovery check passed.' },
  CLOSED_AUTO_RECOVERY: { title: 'Verified (auto-recovery)', subtitle: 'Device recovered before submission.' },
  FAILED_VERIFICATION: { title: 'Verification failed', subtitle: 'GPS recovery check did not pass.' },
};

/**
 * #59 (M5) — the fuller Verification view (checks list, Device Guard, possible-outcomes legend),
 * reached from Ticket Detail's compact verification-pending card. Read-only (CONTEXT: no state
 * mutation here).
 */
export function VerificationScreen({ ticketId, ticketNoDisplay, ticketStatus, onBack }: VerificationScreenProps) {
  const [view, setView] = useState<VerificationView | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await getAccessToken();
      if (!token) return;
      try {
        const result = await apiGetTicketVerification(token, ticketId);
        if (!cancelled) setView(result);
      } catch {
        // No verification run yet (or a transient failure) — the screen stays in its loading state
        // rather than showing a false "no checks passed" reading.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  const badgeCopy = view ? (BADGE_COPY[view.badge ?? ''] ?? { title: 'Verification pending', subtitle: '' }) : null;

  return (
    <ScrollView testID="screen-verification" style={styles.container}>
      <Pressable testID="verification-back" onPress={onBack} style={styles.backButton}>
        <Text style={styles.backLabel}>{'< Back'}</Text>
      </Pressable>
      <Text style={styles.ticketNo}>{ticketNoDisplay}</Text>
      <Text style={styles.pageTitle}>Verification</Text>

      {ticketStatus === 'ESCALATED' ? (
        <View testID="escalated-badge" style={styles.section}>
          <StatusPill label="Escalated" status="critical" />
        </View>
      ) : null}

      {view && badgeCopy ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{badgeCopy.title}</Text>
          <Text style={styles.cardSubtitle}>{badgeCopy.subtitle}</Text>
          {view.badge ? <StatusPill label={view.badge} status={view.badge === 'FAILED_VERIFICATION' ? 'critical' : 'info'} /> : null}
        </View>
      ) : null}

      {view ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>VERIFICATION CHECKS</Text>
          <Text style={styles.sectionSubtitle}>These run automatically after a repair is submitted.</Text>
          {view.checks.map((check) => (
            <View key={check.key} testID={`check-${check.key}`} style={styles.checkRow}>
              <Text style={styles.checkLabel}>{check.label}</Text>
              <StatusPill label={check.state} status={checkStatus(check.state)} />
            </View>
          ))}
        </View>
      ) : null}

      {view ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Device Guard</Text>
          <View style={styles.deviceGuardCard}>
            <Text style={styles.deviceGuardTitle}>{view.deviceId} only</Text>
            <Text style={styles.cardSubtitle}>Backup device cannot close this ticket.</Text>
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>POSSIBLE OUTCOMES</Text>
        <Text style={styles.sectionSubtitle}>One of these is reported when the check completes.</Text>
        <View style={styles.outcomeLegend}>
          <StatusPill label="Closed" status="success" />
          <StatusPill label="Failed" status="critical" />
          <StatusPill label="Partial" status="warning" />
          <StatusPill label="Escalated" status="warning" />
        </View>
      </View>

      <Pressable testID="back-to-ticket-button" onPress={onBack} style={styles.backToTicketButton}>
        <Text style={styles.backToTicketLabel}>Back to Ticket</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
  },
  backButton: {
    padding: spacing.lg,
    paddingBottom: 0,
  },
  backLabel: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.brand600,
  },
  ticketNo: {
    ...typeScale.capsLabel,
    color: color.inkCaps,
    paddingHorizontal: spacing.lg,
  },
  pageTitle: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
    paddingHorizontal: spacing.lg,
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
  section: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typeScale.capsLabel,
    color: color.inkCaps,
  },
  sectionSubtitle: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  checkRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  checkLabel: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.inkStrong,
  },
  deviceGuardCard: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceSunken,
    gap: spacing.xs,
  },
  deviceGuardTitle: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.inkStrong,
  },
  outcomeLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  backToTicketButton: {
    margin: spacing.lg,
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  backToTicketLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
});
