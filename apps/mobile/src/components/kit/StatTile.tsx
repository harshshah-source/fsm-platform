import { StyleSheet, Text, View } from 'react-native';
import { color, radius, shadow, spacing, typeScale, type SemanticStatus } from '../../theme/tokens';

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
    ...shadow.card,
    // A tinted shadow rather than the shared token's neutral black: on a bold flat-color tile a
    // plain gray shadow reads as dirt at the edges, a color-matched one reads as depth.
    shadowColor: '#000',
    shadowOpacity: 0.16,
  },
  value: {
    ...typeScale.display,
    fontWeight: '800',
    color: color.onColor,
  },
  label: {
    ...typeScale.capsLabel,
    color: color.onColor,
    opacity: 0.9,
  },
});
