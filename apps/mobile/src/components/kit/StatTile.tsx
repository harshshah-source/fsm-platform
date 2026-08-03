import { StyleSheet, Text, View } from 'react-native';
import { color, radius, spacing, typeScale, type SemanticStatus } from '../../theme/tokens';

const TILE_COLOR: Record<SemanticStatus, string> = {
  info: color.info,
  success: color.success,
  verified: color.verified,
  warning: color.warning,
  critical: color.critical,
  neutral: color.neutral,
};

export interface StatTileProps {
  value: number;
  label: string;
  status: SemanticStatus;
  testID?: string;
}

/** Home dashboard's 4-up KPI strip (docs/ui/mobile/home-dashboard.png) — bold semantic-color
 *  tile, white numeral + caps label. Distinct from StatusPill, which uses the tinted bg/fg pair. */
export function StatTile({ value, label, status, testID }: StatTileProps) {
  return (
    <View testID={testID} style={[styles.tile, { backgroundColor: TILE_COLOR[status] }]}>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    alignItems: 'flex-start',
  },
  value: {
    ...typeScale.display,
    color: color.onColor,
  },
  label: {
    ...typeScale.capsLabel,
    color: color.onColor,
    opacity: 0.9,
  },
});
