import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { IntradayDeclineReasonCode, IntradayInsertionOffer, MeTicketDetailView } from '@fsm/shared';
import { INTRADAY_DECLINE_REASON_CODES } from '@fsm/shared';
import { apiAcceptIntradayInsertion, apiDeclineIntradayInsertion, apiGetTicketDetail } from '../api/client';
import { getAccessToken } from '../auth/tokenStore';
import { TilePicker } from '../components/kit/TilePicker';
import { color, radius, spacing, typeScale } from '../theme/tokens';
import { formatAcceptByLabel, formatDeclineReasonLabel } from './intradayDisplay';

const REASON_OPTIONS = INTRADAY_DECLINE_REASON_CODES.map((value) => ({ value, label: formatDeclineReasonLabel(value) }));

export interface IntradayOfferScreenProps {
  offer: IntradayInsertionOffer;
  /** Resolves with the ticketId once accepted, or `null` once declined / found already resolved
   *  elsewhere — the caller (`SeTabShell`) uses the ticketId to badge the Tickets list. */
  onResolved: (acceptedTicketId: string | null) => void;
}

/**
 * #77 — the full-screen intra-day CRITICAL insertion Accept/Decline prompt (PRD §541 Flow 4). The
 * offered ticket is still OPEN + UNASSIGNED at this point (accept is what formally assigns it), so
 * it's already readable via the existing `GET /api/me/tickets/:id` — no separate plant/vehicle
 * chrome needed from the insertion row itself.
 */
export function IntradayOfferScreen({ offer, onResolved }: IntradayOfferScreenProps) {
  const [detail, setDetail] = useState<MeTicketDetailView | null>(null);
  const [showDecline, setShowDecline] = useState(false);
  const [reason, setReason] = useState<IntradayDeclineReasonCode | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    void (async () => {
      const token = await getAccessToken();
      if (!token) return;
      try {
        const d = await apiGetTicketDetail(token, offer.ticketId);
        setDetail(d);
      } catch {
        // Best-effort chrome — Accept/Decline still work from the offer row alone.
      }
    })();
  }, [offer.ticketId]);

  const handleAccept = useCallback(async () => {
    setSubmitting(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      await apiAcceptIntradayInsertion(token, offer.insertionId);
      onResolved(offer.ticketId);
    } catch (e) {
      if (e instanceof Error && (e.message === 'INSERTION_NOT_PENDING' || e.message === 'NOT_OFFERED_TO_YOU')) {
        setGone(true);
      }
    } finally {
      setSubmitting(false);
    }
  }, [offer.insertionId, offer.ticketId, onResolved]);

  const handleDecline = useCallback(async () => {
    if (!reason) return;
    setSubmitting(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      await apiDeclineIntradayInsertion(token, offer.insertionId, { reasonCode: reason });
      onResolved(null);
    } catch (e) {
      if (e instanceof Error && (e.message === 'INSERTION_NOT_PENDING' || e.message === 'NOT_OFFERED_TO_YOU')) {
        setGone(true);
      }
    } finally {
      setSubmitting(false);
    }
  }, [reason, offer.insertionId, onResolved]);

  if (gone) {
    return (
      <View testID="intraday-offer-gone" style={styles.centered}>
        <Text style={styles.title}>This offer is no longer available</Text>
        <Text style={styles.body}>It was already resolved elsewhere.</Text>
        <Pressable testID="intraday-offer-gone-continue" onPress={() => onResolved(null)} style={styles.acceptButton}>
          <Text style={styles.acceptLabel}>Continue</Text>
        </Pressable>
      </View>
    );
  }

  if (showDecline) {
    return (
      <ScrollView testID="screen-intraday-decline" style={styles.container}>
        <Text style={styles.title}>Decline Reason</Text>
        <View style={styles.section}>
          <TilePicker options={REASON_OPTIONS} value={reason} onChange={setReason} testIDPrefix="intraday-decline-reason" />
        </View>
        <Pressable
          testID="intraday-decline-submit"
          disabled={!reason || submitting}
          accessibilityState={{ disabled: !reason || submitting }}
          onPress={() => void handleDecline()}
          style={[styles.declineButton, !reason || submitting ? styles.disabled : null]}
        >
          <Text style={styles.declineLabel}>{submitting ? 'Submitting…' : 'Submit Decline'}</Text>
        </Pressable>
        <Pressable testID="intraday-decline-cancel" onPress={() => setShowDecline(false)} style={styles.cancelButton}>
          <Text style={styles.cancelLabel}>Cancel</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView testID="screen-intraday-offer" style={styles.container}>
      <Text style={styles.eyebrow}>CRITICAL Ticket Offered</Text>
      {detail ? (
        <>
          <Text style={styles.title}>{detail.plantName}</Text>
          <Text style={styles.body}>{detail.companyName}</Text>
          <Text style={styles.body}>{detail.deviceId}</Text>
        </>
      ) : (
        <Text style={styles.body}>Ticket {offer.ticketId}</Text>
      )}
      <Text testID="intraday-offer-deadline" style={styles.deadline}>
        {formatAcceptByLabel(offer.acceptanceDeadline)}
      </Text>

      <Pressable
        testID="intraday-accept-button"
        disabled={submitting}
        onPress={() => void handleAccept()}
        style={[styles.acceptButton, submitting ? styles.disabled : null]}
      >
        <Text style={styles.acceptLabel}>{submitting ? 'Accepting…' : 'Accept'}</Text>
      </Pressable>
      <Pressable testID="intraday-decline-button" onPress={() => setShowDecline(true)} style={styles.declineButton}>
        <Text style={styles.declineLabel}>Decline</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
    padding: spacing.lg,
  },
  centered: {
    flex: 1,
    backgroundColor: color.surfaceApp,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  eyebrow: {
    ...typeScale.capsLabel,
    color: color.critical,
  },
  title: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
  },
  body: {
    ...typeScale.body,
    color: color.inkMuted,
  },
  deadline: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.critical,
    marginTop: spacing.md,
  },
  section: {
    paddingVertical: spacing.lg,
  },
  acceptButton: {
    marginTop: spacing.lg,
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  acceptLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
  declineButton: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: color.lineStrong,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  declineLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.ink,
  },
  cancelButton: {
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  cancelLabel: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.brand600,
  },
  disabled: {
    opacity: 0.5,
  },
});
