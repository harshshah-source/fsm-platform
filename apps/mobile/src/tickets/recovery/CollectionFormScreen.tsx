import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { apiRecoveryMarkCollected } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { color, radius, spacing, typeScale } from '../../theme/tokens';

export interface CollectionFormScreenProps {
  ticketId: string;
  /** `MeTicketDetailView.deviceId` — shown as a hint so the SE reads the expected serial rather
   *  than typing blind; the server is still authoritative on the match (#68 comment 2). */
  expectedDeviceSerial: string;
  onSubmitted: () => void;
  onCancel: () => void;
}

/**
 * #68 — Recovery Collection Form. `POST /api/recovery/:id/collected`: mandatory serial + condition
 * notes, server-validated (`INVALID_DEVICE_SERIAL` / `CONDITION_NOTES_REQUIRED`). Client-side
 * non-empty check only gates the submit button — it never pre-judges a match.
 */
export function CollectionFormScreen({ ticketId, expectedDeviceSerial, onSubmitted, onCancel }: CollectionFormScreenProps) {
  const [serial, setSerial] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = serial.trim().length > 0 && notes.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      await apiRecoveryMarkCollected(token, ticketId, { deviceSerial: serial.trim(), conditionNotes: notes.trim() });
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SUBMIT_FAILED');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView testID="screen-collection-form" style={styles.container}>
      <Pressable testID="collection-form-cancel" onPress={onCancel} style={styles.backButton}>
        <Text style={styles.backLabel}>{'< Back'}</Text>
      </Pressable>
      <Text style={styles.pageTitle}>Collection Form</Text>
      <Text style={styles.hint}>Expected device serial: {expectedDeviceSerial}</Text>

      {error ? (
        <View testID="collection-form-error" style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.fieldLabel}>Device Serial</Text>
        <TextInput
          testID="collection-serial-input"
          style={styles.textInput}
          value={serial}
          onChangeText={setSerial}
          autoCapitalize="none"
        />
        <Text style={styles.fieldLabel}>Condition Notes</Text>
        <TextInput
          testID="collection-notes-input"
          style={styles.notesInput}
          placeholder="Describe the device's condition…"
          value={notes}
          onChangeText={setNotes}
          multiline
        />
      </View>

      <Pressable
        testID="collection-submit"
        disabled={!canSubmit}
        accessibilityState={{ disabled: !canSubmit }}
        onPress={() => void handleSubmit()}
        style={[styles.submitButton, !canSubmit ? styles.submitButtonDisabled : null]}
      >
        <Text style={styles.submitLabel}>{submitting ? 'Submitting…' : 'Mark Collected'}</Text>
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
  hint: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
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
  notesInput: {
    ...typeScale.body,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    padding: spacing.sm,
    minHeight: 60,
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
