import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { TroubleshootConflictError } from '../../api/client';
import { color, radius, spacing, typeScale } from '../../theme/tokens';

export interface ConflictScreenProps {
  error: TroubleshootConflictError;
}

/**
 * #63 — the SE full-screen Business 409 result (CONTEXT §Business 409 Conflict, PRD:593). Only
 * ever reached from a `TroubleshootConflictError` (HTTP 409 `TICKET_ALREADY_CLOSED`) — never an
 * idempotency duplicate, which is a 200 no-op the form treats as a normal success.
 *
 * `status === 'CLOSED_AUTO_RECOVERY'` has no winning SE at all (the device recovered before
 * anyone's submission raced) — the copy renders that case without naming an SE, never a lie like
 * "closed by null". `shadowUseRecorded` renders its own line only when true; today that is
 * permanently `false` over HTTP (`consumedComponents` has no client-facing field yet, #101), but
 * the copy is correct for once that lands.
 */
export function ConflictScreen({ error }: ConflictScreenProps) {
  const navigation = useNavigation();

  const headline =
    error.status === 'CLOSED_AUTO_RECOVERY' || !error.winnerSeName
      ? 'This ticket was already closed.'
      : `This ticket was already closed by ${error.winnerSeName}${error.winnerAt ? ` at ${formatTime(error.winnerAt)}` : ''}.`;

  return (
    <View testID="screen-troubleshoot-conflict" style={styles.container}>
      <Text style={styles.headline}>{headline}</Text>
      {error.shadowUseRecorded ? (
        <Text testID="conflict-shadow-use-line" style={styles.body}>
          Your consumed components have been logged as Shadow Use and will be reconciled by the Warehouse.
        </Text>
      ) : null}

      <Pressable
        testID="conflict-view-van-stock"
        onPress={() => navigation.navigate('Stock' as never)}
        style={styles.primaryButton}
      >
        <Text style={styles.primaryLabel}>View Van Stock</Text>
      </Pressable>
      <Pressable testID="conflict-go-back" onPress={() => navigation.navigate('Home' as never)} style={styles.secondaryButton}>
        <Text style={styles.secondaryLabel}>Go Back</Text>
      </Pressable>
    </View>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
    padding: spacing.lg,
    justifyContent: 'center',
    gap: spacing.md,
  },
  headline: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
    textAlign: 'center',
  },
  body: {
    ...typeScale.body,
    color: color.inkMuted,
    textAlign: 'center',
  },
  primaryButton: {
    marginTop: spacing.lg,
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  primaryLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
  secondaryButton: {
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: color.line,
  },
  secondaryLabel: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.inkStrong,
  },
});
