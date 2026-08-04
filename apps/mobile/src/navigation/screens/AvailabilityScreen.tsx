import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AvailabilityRow } from '@fsm/shared';
import { apiGetMyAvailability, apiSetAvailability } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { currentAvailabilityRow, formatAvailabilityStatusLabel } from '../../availability/availabilityDisplay';
import { color, radius, spacing, typeScale } from '../../theme/tokens';

type Status = 'loading' | 'ready' | 'offline';

export interface AvailabilityScreenProps {
  seId: string;
  onBack: () => void;
}

/**
 * #87 (M8c) — SE Availability. Reads the caller's own windows (`GET /api/me/availability`, #163
 * item 7) and derives the currently-active one client-side the same way
 * `SeAvailabilityService.currentStatus` does server-side (latest `windowStart` row whose window
 * contains now). AVAILABLE (or no active window) → "Go Unavailable" opens a mandatory from/to form
 * (`POST /engineers/:seId/availability`, `SOFT_UNAVAILABLE`); SOFT_UNAVAILABLE → "Clear" self-sets
 * AVAILABLE, forwarding the active window's own `windowEnd` so the new row's end can never fall
 * short of the one it supersedes (avoids a race where the original window could still win once the
 * clear's own window elapses — see #87/#162's build comment). Any manager-set status renders
 * read-only — the server would 403 a clear attempt. Auto-revert at `to_ts` is entirely server-owned;
 * this screen has no client timer, it just reflects whatever `GET /api/me/availability` returns.
 */
export function AvailabilityScreen({ seId, onBack }: AvailabilityScreenProps) {
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<AvailabilityRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      const view = await apiGetMyAvailability(token);
      setItems(view.items);
      setStatus('ready');
    } catch {
      setStatus('offline');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = currentAvailabilityRow(items);
  const isAvailable = active === null || active.status === 'AVAILABLE';
  const isSelfClearable = active !== null && active.status === 'SOFT_UNAVAILABLE';

  const handleSetUnavailable = async () => {
    if (!windowStart.trim() || !windowEnd.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      await apiSetAvailability(token, seId, {
        status: 'SOFT_UNAVAILABLE',
        windowStart: windowStart.trim(),
        windowEnd: windowEnd.trim(),
      });
      setShowForm(false);
      setWindowStart('');
      setWindowEnd('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SUBMIT_FAILED');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClear = async () => {
    if (!active) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('UNAUTHORIZED');
      await apiSetAvailability(token, seId, {
        status: 'AVAILABLE',
        windowStart: new Date().toISOString(),
        windowEnd: active.windowEnd ?? new Date().toISOString(),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SUBMIT_FAILED');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView testID="screen-availability" style={styles.container}>
      <Pressable testID="availability-back" onPress={onBack} style={styles.backButton}>
        <Text style={styles.backLabel}>{'< Back'}</Text>
      </Pressable>
      <Text style={styles.pageTitle}>Availability</Text>

      {status === 'offline' ? (
        <Text testID="availability-offline" style={styles.offlineText}>
          Offline — showing the last synced state.
        </Text>
      ) : null}

      {error ? (
        <View testID="availability-form-error" style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {status !== 'loading' ? (
        <View style={styles.card}>
          <Text style={styles.statusLabel}>{formatAvailabilityStatusLabel(active?.status ?? 'AVAILABLE')}</Text>
          {active && active.windowEnd ? (
            <Text style={styles.windowText}>Until {active.windowEnd}</Text>
          ) : active && !active.windowEnd ? (
            <Text style={styles.windowText}>Open-ended</Text>
          ) : null}
          {active?.setByRole && active.setByRole !== 'SERVICE_ENGINEER' ? (
            <Text style={styles.setByText}>Set by your manager</Text>
          ) : null}

          {isAvailable && !showForm ? (
            <Pressable testID="availability-go-unavailable-button" onPress={() => setShowForm(true)} style={styles.actionButton}>
              <Text style={styles.actionButtonLabel}>Go Unavailable</Text>
            </Pressable>
          ) : null}

          {isSelfClearable ? (
            <Pressable
              testID="availability-clear-button"
              disabled={submitting}
              onPress={() => void handleClear()}
              style={[styles.actionButton, submitting ? styles.actionButtonDisabled : null]}
            >
              <Text style={styles.actionButtonLabel}>{submitting ? 'Clearing…' : 'Clear'}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {showForm ? (
        <View style={styles.section}>
          <Text style={styles.fieldLabel}>From (ISO date-time)</Text>
          <TextInput
            testID="availability-window-start-input"
            style={styles.textInput}
            placeholder="2026-08-10T09:00:00Z"
            value={windowStart}
            onChangeText={setWindowStart}
          />
          <Text style={styles.fieldLabel}>To (ISO date-time)</Text>
          <TextInput
            testID="availability-window-end-input"
            style={styles.textInput}
            placeholder="2026-08-10T17:00:00Z"
            value={windowEnd}
            onChangeText={setWindowEnd}
          />
          <Pressable
            testID="availability-set-submit"
            disabled={!windowStart.trim() || !windowEnd.trim() || submitting}
            accessibilityState={{ disabled: !windowStart.trim() || !windowEnd.trim() || submitting }}
            onPress={() => void handleSetUnavailable()}
            style={[styles.actionButton, !windowStart.trim() || !windowEnd.trim() ? styles.actionButtonDisabled : null]}
          >
            <Text style={styles.actionButtonLabel}>{submitting ? 'Submitting…' : 'Confirm Unavailable'}</Text>
          </Pressable>
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
  backButton: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  backLabel: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.brand600,
  },
  pageTitle: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
    padding: spacing.lg,
    paddingBottom: 0,
  },
  offlineText: {
    ...typeScale.cellSecondary,
    color: color.warning,
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
  card: {
    margin: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceCard,
    gap: spacing.xs,
  },
  statusLabel: {
    ...typeScale.sectionTitle,
    color: color.inkStrong,
  },
  windowText: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  setByText: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  actionButton: {
    marginTop: spacing.sm,
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  actionButtonLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
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
});
