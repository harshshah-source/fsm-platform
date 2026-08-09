import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, shadow, spacing, typeScale } from '../../theme/tokens';

export interface TilePickerOption<T extends string> {
  value: T;
  label: string;
}

export interface TilePickerProps<T extends string> {
  options: TilePickerOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  testIDPrefix: string;
}

/**
 * Single-select tile grid (e.g. Troubleshoot's Issue Found / Action Taken sections,
 * docs/ui/mobile/troubleshooting.png). Text-only — the mockup's per-tile icons aren't reproduced
 * (no icon vocabulary is specified anywhere for these domain concepts; inventing one would be a
 * guess the label text doesn't need).
 */
export function TilePicker<T extends string>({ options, value, onChange, testIDPrefix }: TilePickerProps<T>) {
  return (
    <View style={styles.grid}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={`${testIDPrefix}-tile-${option.value}`}
            onPress={() => onChange(option.value)}
            style={[styles.tile, selected ? styles.tileSelected : null]}
          >
            <Text style={[styles.label, selected ? styles.labelSelected : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  tile: {
    width: '47%',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceCard,
    paddingVertical: spacing.md,
    alignItems: 'center',
    ...shadow.card,
  },
  tileSelected: {
    backgroundColor: color.brand600,
    borderColor: color.brand600,
    // A selected tile pops rather than just changing color — reads as "chosen", not just "different".
    shadowColor: color.brand600,
    shadowOpacity: 0.35,
    elevation: 4,
  },
  label: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.ink,
  },
  labelSelected: {
    color: color.onColor,
  },
});
