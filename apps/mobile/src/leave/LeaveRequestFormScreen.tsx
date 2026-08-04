import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { LEAVE_REQUEST_TYPES, type LeaveRequestType } from '@fsm/shared';
import { apiSubmitLeaveRequest } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { getAccessToken } from '../auth/tokenStore';
import { TilePicker } from '../components/kit/TilePicker';
import { color, radius, spacing, typeScale } from '../theme/tokens';
import { formatLeaveTypeLabel } from './leaveDisplay';

const TYPE_OPTIONS = LEAVE_REQUEST_TYPES.map((value) => ({ value, label: formatLeaveTypeLabel(value) }));

export interface LeaveRequestFormScreenProps {
  onSubmitted: () => void;
  onCancel: () => void;
}

/**
 * #86 — SE Leave Request. `POST /api/leave-requests`, filed for self (`seId` = the caller's own
 * id, mirroring #64's Vehicle Unavailability pattern). Dates are plain `YYYY-MM-DD` text inputs —
 * no date-picker library exists in this project and no mockup specifies that input's UX (same call
 * #64 made for its own date field); the server is authoritative on parsing (`INVALID_WINDOW`) and
 * ordering (`WINDOW_ORDER`), the client only pre-checks non-empty.
 */
export function LeaveRequestFormScreen({ onSubmitted, onCancel }: LeaveRequestFormScreenProps) {
  const { session } = useAuth();
  const [type, setType] = useState<LeaveRequestType | null>(null);
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = type !== null && windowStart.trim().length > 0 && windowEnd.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!type || !session) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      await apiSubmitLeaveRequest(token, {
        seId: session.user_id,
        type,
        windowStart: windowStart.trim(),
        windowEnd: windowEnd.trim(),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SUBMIT_FAILED');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView testID="screen-leave-request-form" style={styles.container}>
      <Pressable testID="leave-form-cancel" onPress={onCancel} style={styles.backButton}>
        <Text style={styles.backLabel}>{'< Back'}</Text>
      </Pressable>
      <Text style={styles.pageTitle}>New Leave Request</Text>

      {error ? (
        <View testID="leave-form-error" style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Type</Text>
        <TilePicker options={TYPE_OPTIONS} value={type} onChange={setType} testIDPrefix="leave-type" />
      </View>

      <View style={styles.section}>
        <Text style={styles.fieldLabel}>From (YYYY-MM-DD)</Text>
        <TextInput
          testID="leave-window-start-input"
          style={styles.textInput}
          placeholder="2026-08-10"
          value={windowStart}
          onChangeText={setWindowStart}
        />
        <Text style={styles.fieldLabel}>To (YYYY-MM-DD)</Text>
        <TextInput
          testID="leave-window-end-input"
          style={styles.textInput}
          placeholder="2026-08-12"
          value={windowEnd}
          onChangeText={setWindowEnd}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.fieldLabel}>Reason (optional)</Text>
        <TextInput testID="leave-reason-input" style={styles.textInput} value={reason} onChangeText={setReason} />
      </View>

      <Pressable
        testID="leave-submit"
        disabled={!canSubmit}
        accessibilityState={{ disabled: !canSubmit }}
        onPress={() => void handleSubmit()}
        style={[styles.submitButton, !canSubmit ? styles.submitButtonDisabled : null]}
      >
        <Text style={styles.submitLabel}>{submitting ? 'Submitting…' : 'Submit Request'}</Text>
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
  fieldLabel: {
    ...typeScale.capsLabel,
    color: color.inkCaps,
  },
  textInput: {
    ...typeScale.body,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    padding: spacing.sm,
    color: color.ink,
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
});
