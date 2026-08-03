import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, spacing, typeScale } from '../../theme/tokens';

export interface IconSelectItem {
  key: string;
  label: string;
  icon: ReactNode;
}

export interface IconSelectGridProps {
  items: IconSelectItem[];
  onSelect: (key: string) => void;
  disabledKeys?: string[];
  /** DESIGN-SYSTEM §3.2: mobile icon-select grids are 2 columns; the bottom Stock action row
   *  (docs/ui/mobile/inventory.png) is the one 3-column exception — callers opt in explicitly. */
  columns?: 2 | 3;
}

/** e.g. Stock's Scan Serial / Use Part / Request row (docs/ui/mobile/inventory.png). */
export function IconSelectGrid({ items, onSelect, disabledKeys = [], columns = 2 }: IconSelectGridProps) {
  return (
    <View style={styles.grid}>
      {items.map((item) => {
        const disabled = disabledKeys.includes(item.key);
        return (
          <Pressable
            key={item.key}
            disabled={disabled}
            onPress={() => onSelect(item.key)}
            style={[styles.cell, { width: `${100 / columns}%`, opacity: disabled ? 0.4 : 1 }]}
          >
            <View style={styles.iconWrap}>{item.icon}</View>
            <Text style={styles.label}>{item.label}</Text>
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
  },
  cell: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    backgroundColor: color.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...typeScale.cellSecondary,
    color: color.ink,
    fontWeight: '600',
    textAlign: 'center',
  },
});
