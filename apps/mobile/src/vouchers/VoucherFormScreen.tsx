import { useState } from 'react';
import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ExpenseCategory } from '@fsm/shared';
import { EXPENSE_CATEGORIES } from '@fsm/shared';
import { apiCreateVoucher, apiUploadMedia } from '../api/client';
import { getAccessToken } from '../auth/tokenStore';
import { PhotoCaptureRow } from '../components/kit/PhotoCaptureRow';
import { TilePicker } from '../components/kit/TilePicker';
import { color, radius, spacing, typeScale } from '../theme/tokens';
import { formatCategoryLabel } from './voucherDisplay';

const CATEGORY_OPTIONS = EXPENSE_CATEGORIES.map((value) => ({ value, label: formatCategoryLabel(value) }));

export interface VoucherFormScreenProps {
  onSubmitted: () => void;
  onCancel: () => void;
}

/**
 * #61 (M7) — voucher capture: amount, category, receipt photo. `POST /api/vouchers`, single item.
 *
 * Single-item, single-photo: the AC's own wording is "receipt photo" (singular), and
 * `ExpenseVoucherItem.photoRef` is one column server-side — the mockup's 3 named document types
 * (Receipt/Photo/Bill, #172 Decision 6) can't all attach to one item without a schema change this
 * issue doesn't own (see #81's comment thread on the same gap). PHOTO_REQUIRED (PRD §597.3, ≥1
 * photo before submit) is enforced client-side by gating the submit button on a captured photoRef.
 *
 * Not built: offline drafting (#17, unbuilt) — `clientSubmissionId` is still generated per attempt
 * so a retry after a network drop is idempotent (server dedupes on `(se_id, client_submission_id)`),
 * same interim pattern #58/#60 used ahead of the real offline queue.
 */
export function VoucherFormScreen({ onSubmitted, onCancel }: VoucherFormScreenProps) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<ExpenseCategory | null>(null);
  const [photoRef, setPhotoRef] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedAmount = Number(amount);
  const canSubmit = category !== null && Number.isFinite(parsedAmount) && parsedAmount > 0 && photoRef !== null && !submitting;

  const handleCapture = async () => {
    setCapturing(true);
    setError(null);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError('CAMERA_PERMISSION_DENIED');
        return;
      }
      // PRD:311 mandates client-side compression before a photo ever reaches the API.
      const result = await ImagePicker.launchCameraAsync({ quality: 0.5 });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      const asset = result.assets[0];
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      const uploaded = await apiUploadMedia(token, 'VOUCHER', 'RECEIPT', {
        uri: asset.uri,
        name: asset.fileName ?? 'receipt.jpg',
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
    if (!category || photoRef === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      await apiCreateVoucher(token, {
        clientSubmissionId: Crypto.randomUUID(),
        items: [{ category, amount: parsedAmount, photoRef }],
      });
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SUBMIT_FAILED');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView testID="screen-voucher-form" style={styles.container}>
      <Pressable testID="voucher-form-cancel" onPress={onCancel} style={styles.backButton}>
        <Text style={styles.backLabel}>{'< Back'}</Text>
      </Pressable>
      <Text style={styles.pageTitle}>New Voucher</Text>

      {error ? (
        <View testID="voucher-form-error" style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.fieldLabel}>Amount</Text>
        <TextInput
          testID="voucher-amount"
          style={styles.amountInput}
          placeholder="0.00"
          keyboardType="decimal-pad"
          value={amount}
          onChangeText={setAmount}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Category</Text>
        <TilePicker options={CATEGORY_OPTIONS} value={category} onChange={setCategory} testIDPrefix="category" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Photo Proof</Text>
        <PhotoCaptureRow slots={[{ key: 'receipt', label: 'Receipt', photoRef }]} onCapture={() => void handleCapture()} />
        {capturing ? <Text style={styles.capturingLabel}>Uploading…</Text> : null}
      </View>

      <Pressable
        testID="voucher-submit"
        disabled={!canSubmit}
        accessibilityState={{ disabled: !canSubmit }}
        onPress={() => void handleSubmit()}
        style={[styles.submitButton, !canSubmit ? styles.submitButtonDisabled : null]}
      >
        <Text style={styles.submitLabel}>{submitting ? 'Submitting…' : 'Submit Voucher'}</Text>
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
  amountInput: {
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
