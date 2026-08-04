import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { UNABLE_TO_COLLECT_REASONS, type UnableToCollectReason } from '@fsm/shared';
import { apiRecoveryUnableToCollect } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { TilePicker } from '../../components/kit/TilePicker';
import { color, radius, spacing, typeScale } from '../../theme/tokens';
import { formatUnableToCollectReasonLabel } from './recoveryDisplay';

const REASON_OPTIONS = UNABLE_TO_COLLECT_REASONS.map((value) => ({ value, label: formatUnableToCollectReasonLabel(value) }));

export interface UnableToCollectScreenProps {
  ticketId: string;
  onSubmitted: () => void;
  onCancel: () => void;
}

/**
 * #68 — Recovery Unable to Collect. `POST /api/recovery/:id/unable-to-collect` routes the ticket to
 * the ZM decision queue (Issue 37); the ticket's own status stays `ON_SITE` (the manager decision,
 * not this filing, is what closes it out) — so this shows an explicit confirmation rather than
 * silently returning to a detail view that looks unchanged (issue AC: "submit → confirmation that
 * the ticket moved to the ZM decision queue").
 */
export function UnableToCollectScreen({ ticketId, onSubmitted, onCancel }: UnableToCollectScreenProps) {
  const [reason, setReason] = useState<UnableToCollectReason | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const canSubmit = reason !== null && !submitting;

  const handleSubmit = async () => {
    if (!reason) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      await apiRecoveryUnableToCollect(token, ticketId, { reasonCode: reason });
      setConfirmed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SUBMIT_FAILED');
    } finally {
      setSubmitting(false);
    }
  };

  if (confirmed) {
    return (
      <View testID="unable-confirmation" style={styles.confirmationContainer}>
        <Text style={styles.confirmationTitle}>Routed to the Zone Manager</Text>
        <Text style={styles.confirmationBody}>This ticket has moved to the Zone Manager&apos;s decision queue.</Text>
        <Pressable testID="unable-confirmation-done" onPress={onSubmitted} style={styles.submitButton}>
          <Text style={styles.submitLabel}>Done</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView testID="screen-unable-to-collect" style={styles.container}>
      <Pressable testID="unable-form-cancel" onPress={onCancel} style={styles.backButton}>
        <Text style={styles.backLabel}>{'< Back'}</Text>
      </Pressable>
      <Text style={styles.pageTitle}>Unable to Collect</Text>

      {error ? (
        <View testID="unable-form-error" style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Reason</Text>
        <TilePicker options={REASON_OPTIONS} value={reason} onChange={setReason} testIDPrefix="unable-reason" />
      </View>

      <Pressable
        testID="unable-submit"
        disabled={!canSubmit}
        accessibilityState={{ disabled: !canSubmit }}
        onPress={() => void handleSubmit()}
        style={[styles.submitButton, !canSubmit ? styles.submitButtonDisabled : null]}
      >
        <Text style={styles.submitLabel}>{submitting ? 'Submitting…' : 'Submit'}</Text>
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
  pageTitle: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
    paddingHorizontal: spacing.lg,
  },
  errorBanner: {
    margin: spacing.lg,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: color.criticalBg,
  },
  errorText: {
    ...typeScale.cellSecondary,
    color: color.critical,
  },
  section: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typeScale.sectionTitle,
    color: color.inkStrong,
  },
  submitButton: {
    margin: spacing.lg,
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
  confirmationContainer: {
    flex: 1,
    backgroundColor: color.surfaceApp,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  confirmationTitle: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
    textAlign: 'center',
  },
  confirmationBody: {
    ...typeScale.body,
    color: color.inkMuted,
    textAlign: 'center',
  },
});
