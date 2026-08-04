import { useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { apiInstallFitted, apiUploadMedia } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { PhotoCaptureRow } from '../../components/kit/PhotoCaptureRow';
import { color, radius, spacing, typeScale } from '../../theme/tokens';

export interface InstallFormScreenProps {
  ticketId: string;
  /** `MeTicketDetailView.deviceId` — shown as a hint (server is still authoritative on the GPS
   *  serial match, mirroring #68's Collection Form). */
  expectedDeviceSerial: string;
  onSubmitted: () => void;
  onCancel: () => void;
}

/**
 * #71 — Install Form. `POST /api/install/:id/fitted`: mandatory GPS device serial (server-validated
 * against the ticket's device, `INVALID_SERIAL`) + SIM serial (`SERIAL_REQUIRED` if blank), optional
 * single `INSTALL_PHOTO` slot (#172 Decision 6 — Install carries exactly one photo slot, unlike
 * Troubleshoot's 4 or Voucher's 3).
 */
export function InstallFormScreen({ ticketId, expectedDeviceSerial, onSubmitted, onCancel }: InstallFormScreenProps) {
  const [gpsSerial, setGpsSerial] = useState('');
  const [simSerial, setSimSerial] = useState('');
  const [photoRef, setPhotoRef] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = gpsSerial.trim().length > 0 && simSerial.trim().length > 0 && !submitting;

  const handleCapture = async () => {
    setCapturing(true);
    setError(null);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError('CAMERA_PERMISSION_DENIED');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.5 });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      const asset = result.assets[0];
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      const uploaded = await apiUploadMedia(token, 'INSTALL', 'INSTALL_PHOTO', {
        uri: asset.uri,
        name: asset.fileName ?? 'install.jpg',
        type: asset.mimeType ?? 'image/jpeg',
      });
      setPhotoRef(uploaded.photoRef);
    } catch {
      setError('PHOTO_UPLOAD_FAILED');
    } finally {
      setCapturing(false);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      await apiInstallFitted(token, ticketId, {
        gpsDeviceSerial: gpsSerial.trim(),
        simSerial: simSerial.trim(),
        ...(photoRef ? { photoRef } : {}),
      });
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SUBMIT_FAILED');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView testID="screen-install-form" style={styles.container}>
      <Pressable testID="install-form-cancel" onPress={onCancel} style={styles.backButton}>
        <Text style={styles.backLabel}>{'< Back'}</Text>
      </Pressable>
      <Text style={styles.pageTitle}>Install Form</Text>
      <Text style={styles.hint}>Expected GPS device serial: {expectedDeviceSerial}</Text>

      {error ? (
        <View testID="install-form-error" style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.fieldLabel}>GPS Device Serial</Text>
        <TextInput
          testID="install-gps-serial-input"
          style={styles.textInput}
          value={gpsSerial}
          onChangeText={setGpsSerial}
          autoCapitalize="none"
        />
        <Text style={styles.fieldLabel}>SIM Serial</Text>
        <TextInput
          testID="install-sim-serial-input"
          style={styles.textInput}
          value={simSerial}
          onChangeText={setSimSerial}
          autoCapitalize="none"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Photo (optional)</Text>
        <PhotoCaptureRow
          slots={[{ key: 'install-photo', label: 'Install Photo', photoRef }]}
          onCapture={() => void handleCapture()}
        />
        {capturing ? <Text style={styles.capturingLabel}>Uploading…</Text> : null}
      </View>

      <Pressable
        testID="install-submit"
        disabled={!canSubmit}
        accessibilityState={{ disabled: !canSubmit }}
        onPress={() => void handleSubmit()}
        style={[styles.submitButton, !canSubmit ? styles.submitButtonDisabled : null]}
      >
        <Text style={styles.submitLabel}>{submitting ? 'Submitting…' : 'Mark Fitted'}</Text>
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
  capturingLabel: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
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
