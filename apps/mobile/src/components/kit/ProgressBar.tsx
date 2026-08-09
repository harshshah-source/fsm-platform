import { StyleSheet, View } from 'react-native';
import { color, radius } from '../../theme/tokens';

export interface ProgressBarProps {
  value: number;
  max: number;
  fillColor?: string;
  /** The unfilled remainder. Overridable because the remainder is not always "empty space": on Home's
   *  Plant Workload cards the reference tints it (`brand300`) so the outstanding work reads as
   *  outstanding rather than as background. */
  trackColor?: string;
  testID?: string;
}

/** Minimal linear-progress kit primitive (Plant Workload / stock-level bars in
 *  docs/ui/mobile/home-dashboard.png, inventory.png). The Home screen's dual-series day chart is a
 *  different shape and lives with the screen that owns it (`src/home/WorkHistoryChart.tsx`, #175). */
export function ProgressBar({
  value,
  max,
  fillColor = color.info,
  trackColor = color.surfaceSunken,
  testID,
}: ProgressBarProps) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <View testID={testID} style={[styles.track, { backgroundColor: trackColor }]}>
      <View testID={testID ? `${testID}-fill` : undefined} style={[styles.fill, { width: `${pct}%`, backgroundColor: fillColor }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 8,
    borderRadius: radius.full,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.full,
  },
});
