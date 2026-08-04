import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MeTicketDetailView, VerificationView } from '@fsm/shared';
import { apiGetTicketDetail, apiGetTicketVerification, apiRecoveryOnSite, apiSetSoftState, SoftStateConflictError } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { StatusPill } from '../../components/kit/StatusPill';
import { color, radius, spacing, typeScale } from '../../theme/tokens';
import { formatSlaBucketLabel, slaBucketToStatus } from '../ticketDisplay';
import { CollectionFormScreen } from '../recovery/CollectionFormScreen';
import { formatRecoveryStatusLabel } from '../recovery/recoveryDisplay';
import { UnableToCollectScreen } from '../recovery/UnableToCollectScreen';
import { TroubleshootFormScreen } from '../troubleshoot/TroubleshootFormScreen';
import { VehicleUnavailabilityFormScreen } from '../vehicle-unavailability/VehicleUnavailabilityFormScreen';
import { VerificationScreen } from '../verification/VerificationScreen';
import { captureLocation } from './captureLocation';
import { formatInactiveDuration } from './ticketDetailDisplay';

type ScreenState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; detail: MeTicketDetailView }
  | { status: 'verification-pending'; detail: MeTicketDetailView; verification: VerificationView };

/** Soft states that already sit at or past ON_SITE — VIEWED is a backward transition from either
 *  and would 409 (`advance()`: "valid only as the next step in the chain"), so the ON_SITE button
 *  is hidden too — there's nothing left for this screen to advance. */
const PAST_ON_SITE = new Set(['ON_SITE', 'TROUBLESHOOT_STARTED']);

export interface TicketDetailScreenProps {
  ticketId: string;
  /** No stack navigator wraps the tab shell yet — the caller (TicketsScreen) owns the back
   *  transition via local state; omit to render without a back affordance. */
  onBack?: () => void;
}

/**
 * #57 (M3) — Ticket Detail, both states, plus the VIEWED/ON_SITE soft-state actions (Issue 15).
 * `GET /tickets/:id/verification` 404s (`NO_VERIFICATION_RUN`) until a run exists, so it's only
 * fetched once `detail.status === 'VERIFICATION_PENDING'`. No Timeline section —
 * `MeTicketDetailView` carries no generic lifecycle-events field to source it from; not fabricated
 * from unrelated data.
 *
 * TROUBLESHOOT_STARTED (CONTEXT §347: "SE has opened and is actively working the troubleshooting
 * form") is posted when the SE taps Start Troubleshooting, immediately before opening #58's form —
 * the tap itself is "opening" the form, so this is the one legitimate place to set it.
 */
export function TicketDetailScreen({ ticketId, onBack }: TicketDetailScreenProps) {
  const [state, setState] = useState<ScreenState>({ status: 'loading' });
  const [conflict, setConflict] = useState<{ from: string | null; to: string } | null>(null);
  const [settingOnSite, setSettingOnSite] = useState(false);
  const [showTroubleshootForm, setShowTroubleshootForm] = useState(false);
  const [showVerification, setShowVerification] = useState(false);
  const [showVehicleUnavailability, setShowVehicleUnavailability] = useState(false);
  const [settingRecoveryOnSite, setSettingRecoveryOnSite] = useState(false);
  const [showCollectionForm, setShowCollectionForm] = useState(false);
  const [showUnableToCollect, setShowUnableToCollect] = useState(false);

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      const detail = await apiGetTicketDetail(token, ticketId);
      if (detail.status === 'VERIFICATION_PENDING') {
        const verification = await apiGetTicketVerification(token, ticketId);
        setState({ status: 'verification-pending', detail, verification });
      } else {
        setState({ status: 'ready', detail });
      }
      return detail;
    } catch (error) {
      if (error instanceof Error && error.message === 'TICKET_NOT_FOUND') {
        setState({ status: 'not-found' });
      } else {
        setState({ status: 'error' });
      }
      return null;
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-post VIEWED (CONTEXT §334: "SE has opened the Ticket detail") once, on the ready state —
  // never for verification-pending (the ticket is no longer OPEN; `assertInScope` would 404 it) and
  // never once already past ON_SITE (a backward transition, 409s).
  useEffect(() => {
    if (state.status !== 'ready' || state.detail.workType === 'RECOVERY' || PAST_ON_SITE.has(state.detail.activeSoftState ?? '')) return;
    let cancelled = false;
    void (async () => {
      const token = await getAccessToken();
      if (!token || cancelled) return;
      try {
        await apiSetSoftState(token, ticketId, { target: 'VIEWED' });
      } catch {
        // Best-effort activity signal — a failure here doesn't block reading or acting on the ticket.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on activeSoftState, not the whole detail object, so a later poll/refetch with an unrelated field change doesn't re-fire this
  }, [ticketId, state.status === 'ready' ? state.detail.activeSoftState : undefined]);

  const handleOnSite = useCallback(async () => {
    setSettingOnSite(true);
    setConflict(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      const location = await captureLocation();
      await apiSetSoftState(token, ticketId, location ? { target: 'ON_SITE', location } : { target: 'ON_SITE' });
      await load();
    } catch (error) {
      if (error instanceof SoftStateConflictError) {
        setConflict({ from: error.from, to: error.to });
        await load();
      }
    } finally {
      setSettingOnSite(false);
    }
  }, [ticketId, load]);

  const handleRecoveryOnSite = useCallback(async () => {
    setSettingRecoveryOnSite(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      await apiRecoveryOnSite(token, ticketId);
      await load();
    } finally {
      setSettingRecoveryOnSite(false);
    }
  }, [ticketId, load]);

  const handleStartTroubleshooting = useCallback(async () => {
    const token = await getAccessToken();
    if (token) {
      try {
        await apiSetSoftState(token, ticketId, { target: 'TROUBLESHOOT_STARTED' });
      } catch {
        // Best-effort — an SE already past this transition (idempotent re-tap) or a stale read
        // shouldn't block opening the form itself.
      }
    }
    setShowTroubleshootForm(true);
  }, [ticketId]);

  if (showTroubleshootForm) {
    return (
      <TroubleshootFormScreen
        ticketId={ticketId}
        onSubmitted={() => {
          setShowTroubleshootForm(false);
          void load();
        }}
      />
    );
  }

  if (showVerification && state.status === 'verification-pending') {
    return (
      <VerificationScreen
        ticketId={ticketId}
        ticketNoDisplay={state.detail.ticketNoDisplay}
        ticketStatus={state.detail.status}
        onBack={() => setShowVerification(false)}
      />
    );
  }

  if (showVehicleUnavailability && (state.status === 'ready' || state.status === 'verification-pending')) {
    return (
      <VehicleUnavailabilityFormScreen
        ticketId={ticketId}
        transporterName={state.detail.transporterName}
        transporterContact={state.detail.transporterContact}
        onSubmitted={() => {
          setShowVehicleUnavailability(false);
          void load();
        }}
        onCancel={() => setShowVehicleUnavailability(false)}
      />
    );
  }

  if (showCollectionForm && state.status === 'ready') {
    return (
      <CollectionFormScreen
        ticketId={ticketId}
        expectedDeviceSerial={state.detail.deviceId}
        onSubmitted={() => {
          setShowCollectionForm(false);
          void load();
        }}
        onCancel={() => setShowCollectionForm(false)}
      />
    );
  }

  if (showUnableToCollect && state.status === 'ready') {
    return (
      <UnableToCollectScreen
        ticketId={ticketId}
        onSubmitted={() => {
          setShowUnableToCollect(false);
          void load();
        }}
        onCancel={() => setShowUnableToCollect(false)}
      />
    );
  }

  if (state.status === 'loading') {
    return <View testID="ticket-detail-loading" style={styles.container} />;
  }
  if (state.status === 'not-found') {
    return (
      <View testID="ticket-detail-not-found" style={styles.centered}>
        <Text style={styles.emptyText}>This ticket isn&apos;t available.</Text>
        {onBack ? (
          <Pressable testID="ticket-detail-back" onPress={onBack} style={styles.backButton}>
            <Text style={styles.backLabel}>{'< Back'}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  if (state.status === 'error') {
    return (
      <View testID="ticket-detail-error" style={styles.centered}>
        <Text style={styles.emptyText}>Couldn&apos;t load this ticket. Pull to retry.</Text>
        {onBack ? (
          <Pressable testID="ticket-detail-back" onPress={onBack} style={styles.backButton}>
            <Text style={styles.backLabel}>{'< Back'}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const { detail } = state;
  const priorityStatus = slaBucketToStatus(detail.slaBucket);
  const priorityLabel = formatSlaBucketLabel(detail.slaBucket);
  const inactiveDuration = formatInactiveDuration(detail.technicalHealth.dataAsOf);

  return (
    <ScrollView testID="screen-ticket-detail" style={styles.container}>
      {onBack ? (
        <Pressable testID="ticket-detail-back" onPress={onBack} style={styles.backButton}>
          <Text style={styles.backLabel}>{'< Back'}</Text>
        </Pressable>
      ) : null}
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

      {conflict ? (
        <View testID="soft-state-conflict" style={styles.conflictBanner}>
          <Text style={styles.conflictText}>
            That action isn&apos;t available right now — the ticket has moved on. Refreshed below.
          </Text>
        </View>
      ) : null}

      {detail.workType === 'RECOVERY' ? (
        <View testID="recovery-card" style={styles.card}>
          <Text style={styles.cardTitle}>Recovery — {formatRecoveryStatusLabel(detail.status)}</Text>
          {detail.status === 'SCHEDULED' ? (
            <Pressable
              testID="recovery-onsite-button"
              disabled={settingRecoveryOnSite}
              onPress={() => void handleRecoveryOnSite()}
              style={[styles.startButton, settingRecoveryOnSite ? styles.startButtonDisabled : null]}
            >
              <Text style={styles.startButtonLabel}>{settingRecoveryOnSite ? 'Marking On-Site…' : 'Mark On-Site'}</Text>
            </Pressable>
          ) : null}
          {detail.status === 'ON_SITE' ? (
            <>
              <Pressable
                testID="recovery-collection-form-button"
                onPress={() => setShowCollectionForm(true)}
                style={styles.startButton}
              >
                <Text style={styles.startButtonLabel}>Collection Form</Text>
              </Pressable>
              <Pressable
                testID="recovery-unable-button"
                onPress={() => setShowUnableToCollect(true)}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonLabel}>Unable to Collect</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : state.status === 'verification-pending' ? (
        <View testID="verification-pending-card" style={styles.card}>
          <Text style={styles.cardTitle}>Verification pending</Text>
          <Text style={styles.cardSubtitle}>GPS recovery check running.</Text>
          <Text style={styles.badgeText}>{state.verification.badge ?? 'PENDING'}</Text>
          <Text style={styles.metaText}>{state.verification.pingsReceivedCount} ping(s) received</Text>
          <Pressable
            testID="view-verification-button"
            onPress={() => setShowVerification(true)}
            style={styles.startButton}
          >
            <Text style={styles.startButtonLabel}>View Verification</Text>
          </Pressable>
        </View>
      ) : (
        <View testID="ready-card" style={styles.card}>
          {PAST_ON_SITE.has(detail.activeSoftState ?? '') ? (
            <>
              <Text style={styles.cardTitle}>On site</Text>
              <Text style={styles.cardSubtitle}>Continue in the Troubleshoot form.</Text>
              <Pressable
                testID="start-troubleshooting-button"
                onPress={() => void handleStartTroubleshooting()}
                style={styles.startButton}
              >
                <Text style={styles.startButtonLabel}>Start Troubleshooting</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.cardTitle}>Ready to start</Text>
              <Text style={styles.cardSubtitle}>Start only when field work begins.</Text>
              <Pressable
                testID="on-site-button"
                disabled={settingOnSite}
                onPress={() => void handleOnSite()}
                style={[styles.startButton, settingOnSite ? styles.startButtonDisabled : null]}
              >
                <Text style={styles.startButtonLabel}>{settingOnSite ? 'Marking ON_SITE…' : 'Start Work'}</Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      <View style={styles.infoRow}>
        <Text style={styles.infoLabel}>Plant</Text>
        <Text style={styles.infoValue}>{detail.plantName}</Text>
      </View>
      {detail.transporterName ? (
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Transporter</Text>
          {detail.transporterContact ? (
            <Pressable testID="transporter-call-button" onPress={() => void Linking.openURL(`tel:${detail.transporterContact}`)}>
              <Text style={[styles.infoValue, styles.transporterCallValue]}>
                {detail.transporterName} — {detail.transporterContact}
              </Text>
            </Pressable>
          ) : (
            <Text testID="transporter-no-contact" style={styles.infoValueMuted}>
              {detail.transporterName} (no contact on file)
            </Text>
          )}
        </View>
      ) : null}

      <Pressable
        testID="report-vehicle-unavailable-button"
        onPress={() => setShowVehicleUnavailability(true)}
        style={styles.vehicleUnavailableLink}
      >
        <Text style={styles.vehicleUnavailableLinkLabel}>Report Vehicle Unavailable</Text>
      </Pressable>

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
  startButton: {
    marginTop: spacing.sm,
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  startButtonDisabled: {
    opacity: 0.6,
  },
  startButtonLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
  secondaryButton: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryButtonLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.brand600,
  },
  conflictBanner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: color.warningBg,
  },
  conflictText: {
    ...typeScale.cellSecondary,
    color: color.warning,
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
  infoValueMuted: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.inkMuted,
  },
  transporterCallValue: {
    color: color.brand600,
    textDecorationLine: 'underline',
  },
  vehicleUnavailableLink: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  vehicleUnavailableLinkLabel: {
    ...typeScale.cellSecondary,
    fontWeight: '600',
    color: color.brand600,
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
