import { StyleSheet, Text, View } from 'react-native';
import { color } from '../../theme/tokens';

export interface BrandMarkProps {
  /** `onDark` (white wordmark) for the Home header's brand-red block; `onLight` for any future
   *  placement on a card/app-bar surface. */
  tone?: 'onDark' | 'onLight';
}

/**
 * The product's own name — "autoplant Systems" / "Field Management System" — mirrors
 * `apps/admin/src/components/shell/BrandLogo.tsx` exactly (same wordmark casing, same two-line
 * caption pattern) so the mobile app and the admin dashboard read as one product family rather than
 * two unrelated tools. Text-only by design: an image asset would need to ship at multiple densities
 * and this is one line of styled text.
 */
export function BrandMark({ tone = 'onDark' }: BrandMarkProps) {
  const onDark = tone === 'onDark';
  return (
    <View style={styles.wrap}>
      <Text style={[styles.wordmark, { color: onDark ? color.onColor : color.brand600 }]}>
        autoplant Systems
      </Text>
      <Text style={[styles.caption, { color: onDark ? 'rgba(255,255,255,0.72)' : color.inkMuted }]}>
        Field Management System
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 1,
  },
  wordmark: {
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  caption: {
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
});
