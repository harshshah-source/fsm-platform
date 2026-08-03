import { StyleSheet, View } from 'react-native';
import { color, radius } from '../../theme/tokens';

export interface ProgressBarProps {
  value: number;
  max: number;
  fillColor?: string;
  testID?: string;
}

/** Minimal linear-progress kit primitive (Plant Workload / stock-level bars in
 *  docs/ui/mobile/home-dashboard.png, inventory.png). A capsule dual-series chart is real chart-
 *  library work belonging to the screen that needs it (#175), not this shell issue. */
export function ProgressBar({ value, max, fillColor = color.info, testID }: ProgressBarProps) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <View testID={testID} style={styles.track}>
      <View testID={testID ? `${testID}-fill` : undefined} style={[styles.fill, { width: `${pct}%`, backgroundColor: fillColor }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 6,
    borderRadius: radius.full,
    backgroundColor: color.surfaceSunken,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.full,
  },
});
