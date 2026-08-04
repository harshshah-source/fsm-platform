import { useState } from 'react';
import * as Crypto from 'expo-crypto';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { RootCauseCategory } from '@fsm/shared';
import { ROOT_CAUSE_CATEGORIES } from '@fsm/shared';
import { apiSubmitTroubleshoot, TroubleshootConflictError } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { TilePicker } from '../../components/kit/TilePicker';
import { color, radius, spacing, typeScale } from '../../theme/tokens';
import { captureLocation } from '../detail/captureLocation';
import { ConflictScreen } from './ConflictScreen';
import { ACTION_TAKEN_OPTIONS, formatRootCauseLabel } from './troubleshootDisplay';

const ROOT_CAUSE_OPTIONS = ROOT_CAUSE_CATEGORIES.map((value) => ({ value, label: formatRootCauseLabel(value) }));
const ACTION_TAKEN_TILES = ACTION_TAKEN_OPTIONS.map((label) => ({ value: label, label }));

export interface TroubleshootFormScreenProps {
  ticketId: string;
  onSubmitted: () => void;
}

/**
 * #58 (M4) — the structured Troubleshoot form. `POST /tickets/:id/troubleshoot`.
 *
 * Not built here: photo capture (#81, Media Upload API, has since landed but this form hasn't been
 * wired to it yet — see #61's `VoucherFormScreen` for the established capture-and-upload pattern)
 * and the specific `componentUnavailableItem` catalog picker (no component catalog/read exists to
 * populate one from — only the boolean `componentUnavailable` flag is in scope, which #58's own
 * ACs name explicitly). A 409 (`TroubleshootConflictError`) renders the full-screen `ConflictScreen`
 * (#63), replacing this form entirely — never an inline banner over still-editable fields.
 */
export function TroubleshootFormScreen({ ticketId, onSubmitted }: TroubleshootFormScreenProps) {
  const [rootCause, setRootCause] = useState<RootCauseCategory | null>(null);
  const [actionTaken, setActionTaken] = useState<string | null>(null);
  const [rootCauseNotes, setRootCauseNotes] = useState('');
  const [actionTakenNotes, setActionTakenNotes] = useState('');
  const [componentUnavailable, setComponentUnavailable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<TroubleshootConflictError | null>(null);

  const canSubmit = rootCause !== null && !submitting;

  if (conflict) {
    return <ConflictScreen error={conflict} />;
  }

  const handleSubmit = async () => {
    if (!rootCause) return;
    setSubmitting(true);
    setConflict(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      const location = await captureLocation();
      await apiSubmitTroubleshoot(token, ticketId, {
        clientSubmissionId: Crypto.randomUUID(),
        rootCauseCategory: rootCause,
        rootCauseNotes: rootCauseNotes || undefined,
        actionTakenCategory: actionTaken ?? undefined,
        actionTakenNotes: actionTakenNotes || undefined,
        componentUnavailable,
        ...(location ? { seGps: { lat: location.lat, lon: location.lng } } : {}),
      });
      onSubmitted();
    } catch (error) {
      if (error instanceof TroubleshootConflictError) {
        setConflict(error);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView testID="screen-troubleshoot-form" style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Issue Found</Text>
        <TilePicker options={ROOT_CAUSE_OPTIONS} value={rootCause} onChange={setRootCause} testIDPrefix="issue" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Action Taken</Text>
        <TilePicker options={ACTION_TAKEN_TILES} value={actionTaken} onChange={setActionTaken} testIDPrefix="action" />
      </View>

      <Pressable
        testID="component-unavailable-toggle"
        onPress={() => setComponentUnavailable((v) => !v)}
        style={styles.toggleRow}
      >
        <View style={[styles.checkbox, componentUnavailable ? styles.checkboxChecked : null]} />
        <Text style={styles.toggleLabel}>A required component is unavailable</Text>
      </Pressable>

      <View style={styles.section}>
        <Text style={styles.fieldLabel}>Issue Remarks</Text>
        <TextInput
          testID="root-cause-notes"
          style={styles.notesInput}
          placeholder="Issue note…"
          value={rootCauseNotes}
          onChangeText={setRootCauseNotes}
          multiline
        />
        <Text style={styles.fieldLabel}>Completion Note</Text>
        <TextInput
          testID="action-taken-notes"
          style={styles.notesInput}
          placeholder="Action note…"
          value={actionTakenNotes}
          onChangeText={setActionTakenNotes}
          multiline
        />
      </View>

      <Pressable
        testID="troubleshoot-submit"
        disabled={!canSubmit}
        accessibilityState={{ disabled: !canSubmit }}
        onPress={() => void handleSubmit()}
        style={[styles.submitButton, !canSubmit ? styles.submitButtonDisabled : null]}
      >
        <Text style={styles.submitLabel}>{submitting ? 'Submitting…' : 'Submit Repair'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
  },
  section: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typeScale.sectionTitle,
    color: color.inkStrong,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.lineStrong,
  },
  checkboxChecked: {
    backgroundColor: color.brand600,
    borderColor: color.brand600,
  },
  toggleLabel: {
    ...typeScale.body,
    color: color.ink,
  },
  fieldLabel: {
    ...typeScale.capsLabel,
    color: color.inkCaps,
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
