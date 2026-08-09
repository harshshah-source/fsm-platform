import { StyleSheet, Text, View } from 'react-native';
import { radius, semanticColors, spacing, typeScale, type SemanticStatus } from '../../theme/tokens';

export interface StatusPillProps {
  label: string;
  status: SemanticStatus;
  testID?: string;
}

/** The tinted-bg/darker-text status chip used across tickets/vouchers/verification
 *  (DESIGN-SYSTEM §1.5) — same hue means the same thing everywhere. */
export function StatusPill({ label, status, testID }: StatusPillProps) {
  const { fg, bg } = semanticColors(status);
  return (
    <View testID={testID} style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.label, { color: fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderRadius: radius.full,
    paddingVertical: spacing.xs / 2 + 1,
    paddingHorizontal: spacing.sm + 2,
  },
  label: {
    ...typeScale.cellSecondary,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
});
