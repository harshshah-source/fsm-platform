import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { VEHICLE_UNAVAIL_REASONS, type VehicleUnavailReason } from '@fsm/shared';
import { apiFileVehicleUnavailability } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { getAccessToken } from '../../auth/tokenStore';
import { TilePicker } from '../../components/kit/TilePicker';
import { color, radius, spacing, typeScale } from '../../theme/tokens';
import { captureLocation } from '../detail/captureLocation';
import { formatReasonLabel, formatReturnDay, istInstantFromEntry } from './vehicleUnavailabilityDisplay';

const REASON_OPTIONS = VEHICLE_UNAVAIL_REASONS.map((value) => ({ value, label: formatReasonLabel(value) }));

export interface VehicleUnavailabilityFormScreenProps {
  ticketId: string;
  /** Prefilled from the master `Transporter.contactPhone` (#171) shown on Ticket Detail; the SE may
   *  edit before submit — the report's own `transporterName`/`transporterContact` record what was
   *  actually used, which may differ from (and correct) the master. */
  transporterName: string | null;
  transporterContact: string | null;
  onSubmitted: () => void;
  onCancel: () => void;
}

/**
 * #64 — SE Vehicle Unavailability Report. `POST /api/vehicle-unavailability`, filed for self
 * (`seId` = the caller's own id). Pauses the primary SLA server-side; this screen never renders
 * the manager-only Secondary SLA Clock (PRD §299) — there is simply no field for it here.
 *
 * `expectedFrom` was four relative presets until #246. They capped at roughly tomorrow 2 PM, which
 * made "next week" — the commonest real answer for a vehicle on a long trip — literally inexpressible
 * on the one screen whose job is saying when the vehicle comes back. It is now free date entry
 * (`YYYY-MM-DD`, optional `HH:MM`), read as IST by `istInstantFromEntry` so client and server agree on
 * which operating day was meant. There is no native date-picker component in this project and adding
 * one is a native dependency, so this follows the same plain-text pattern the leave form uses and the
 * server stays authoritative on parsing. `expectedTo` (optional) is not built.
 *
 * After a successful submit the screen holds on a confirmation instead of closing straight back to
 * Ticket Detail: filing now *defers* the ticket (#246), and the SE has to be told which day it comes
 * back — reported as missing in the service docstring before this slice. The day shown is the one the
 * **server** derived, never the date typed, because the same-day rule (Decision 14) makes those two
 * different whenever the vehicle is back before midnight.
 */
export function VehicleUnavailabilityFormScreen({
  ticketId,
  transporterName,
  transporterContact,
  onSubmitted,
  onCancel,
}: VehicleUnavailabilityFormScreenProps) {
  const { session } = useAuth();
  const [reason, setReason] = useState<VehicleUnavailReason | null>(null);
  const [transporterContacted, setTransporterContacted] = useState(false);
  const [reportedName, setReportedName] = useState(transporterName ?? '');
  const [reportedContact, setReportedContact] = useState(transporterContact ?? '');
  const [expectedDate, setExpectedDate] = useState('');
  const [expectedTime, setExpectedTime] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set once the server has answered; `deferredUntil` is its verdict, `null` meaning "no wait". */
  const [filed, setFiled] = useState<{ deferredUntil: string | null } | null>(null);

  const expectedFrom = istInstantFromEntry(expectedDate, expectedTime);
  const canSubmit = reason !== null && expectedFrom !== null && !submitting;

  const handleSubmit = async () => {
    if (!reason || !expectedFrom || !session) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      const location = await captureLocation();
      const response = await apiFileVehicleUnavailability(token, {
        ticketId,
        seId: session.user_id,
        reasonCode: reason,
        transporterContacted,
        transporterName: reportedName || undefined,
        transporterContact: reportedContact || undefined,
        expectedFrom,
        notes: notes || undefined,
        ...(location ? { gpsLat: location.lat, gpsLng: location.lng } : {}),
      });
      setFiled({ deferredUntil: response.deferredUntil });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SUBMIT_FAILED');
    } finally {
      setSubmitting(false);
    }
  };

  if (filed) {
    const returnDay = formatReturnDay(filed.deferredUntil);
    return (
      <ScrollView testID="vu-confirmation" style={styles.container}>
        <Text style={styles.pageTitle}>Report Filed</Text>
        <View style={styles.section}>
          <Text style={styles.confirmationBody}>
            {returnDay
              ? `This ticket will return to scheduling on ${returnDay}.`
              : 'The vehicle is expected back today, so this ticket stays available today.'}
          </Text>
        </View>
        <Pressable testID="vu-confirmation-done" onPress={onSubmitted} style={styles.submitButton}>
          <Text style={styles.submitLabel}>Done</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView testID="screen-vehicle-unavailability-form" style={styles.container}>
      <Pressable testID="vu-form-cancel" onPress={onCancel} style={styles.backButton}>
        <Text style={styles.backLabel}>{'< Back'}</Text>
      </Pressable>
      <Text style={styles.pageTitle}>Vehicle Unavailable</Text>

      {error ? (
        <View testID="vu-form-error" style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Reason</Text>
        <TilePicker options={REASON_OPTIONS} value={reason} onChange={setReason} testIDPrefix="vu-reason" />
      </View>

      <Pressable
        testID="vu-transporter-contacted-toggle"
        onPress={() => setTransporterContacted((v) => !v)}
        style={styles.toggleRow}
      >
        <View style={[styles.checkbox, transporterContacted ? styles.checkboxChecked : null]} />
        <Text style={styles.toggleLabel}>I contacted the transporter</Text>
      </Pressable>

      <View style={styles.section}>
        <Text style={styles.fieldLabel}>Transporter Name Used</Text>
        <TextInput testID="vu-transporter-name" style={styles.textInput} value={reportedName} onChangeText={setReportedName} />
        <Text style={styles.fieldLabel}>Transporter Number Used</Text>
        <TextInput
          testID="vu-transporter-contact"
          style={styles.textInput}
          value={reportedContact}
          onChangeText={setReportedContact}
          keyboardType="phone-pad"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Expected Back</Text>
        <Text style={styles.fieldLabel}>Date (YYYY-MM-DD)</Text>
        <TextInput
          testID="vu-expected-date"
          style={styles.textInput}
          placeholder="2026-06-27"
          value={expectedDate}
          onChangeText={setExpectedDate}
          autoCapitalize="none"
        />
        <Text style={styles.fieldLabel}>Time (optional, HH:MM)</Text>
        <TextInput
          testID="vu-expected-time"
          style={styles.textInput}
          placeholder="14:30"
          value={expectedTime}
          onChangeText={setExpectedTime}
          autoCapitalize="none"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.fieldLabel}>Notes</Text>
        <TextInput
          testID="vu-notes"
          style={styles.notesInput}
          placeholder="What's going on…"
          value={notes}
          onChangeText={setNotes}
          multiline
        />
      </View>

      <Pressable
        testID="vu-submit"
        disabled={!canSubmit}
        accessibilityState={{ disabled: !canSubmit }}
        onPress={() => void handleSubmit()}
        style={[styles.submitButton, !canSubmit ? styles.submitButtonDisabled : null]}
      >
        <Text style={styles.submitLabel}>{submitting ? 'Submitting…' : 'File Report'}</Text>
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
  confirmationBody: {
    ...typeScale.body,
    color: color.ink,
  },
});
