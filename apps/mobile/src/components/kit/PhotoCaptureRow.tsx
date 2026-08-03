import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, spacing, typeScale } from '../../theme/tokens';

/**
 * D-12 / #172 Decision 6: photo slots are NAMED, never a flat `string[]` — Troubleshoot carries 4
 * (Before/After/Part/Plate), Vouchers 3 (Receipt/Photo/Bill). `photoRef` is the opaque id
 * `POST /api/media/upload` returns; this component never touches the upload itself, that is the
 * write-screen's job (#58/#61) via the offline WriteQueue.
 */
export interface PhotoSlot {
  key: string;
  label: string;
  photoRef: string | null;
}

export interface PhotoCaptureRowProps {
  slots: PhotoSlot[];
  onCapture: (slotKey: string) => void;
}

export function PhotoCaptureRow({ slots, onCapture }: PhotoCaptureRowProps) {
  return (
    <View style={styles.row}>
      {slots.map((slot) => (
        <Pressable key={slot.key} onPress={() => onCapture(slot.key)} style={styles.slot}>
          <View style={[styles.box, slot.photoRef ? styles.boxFilled : null]}>
            {slot.photoRef ? <View testID={`slot-${slot.key}-filled`} style={styles.filledDot} /> : null}
          </View>
          <Text style={styles.label}>{slot.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  slot: {
    alignItems: 'center',
    gap: spacing.xs,
  },
  box: {
    width: 64,
    height: 64,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.lineStrong,
    backgroundColor: color.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxFilled: {
    borderStyle: 'solid',
    borderColor: color.success,
    backgroundColor: color.successBg,
  },
  filledDot: {
    width: 10,
    height: 10,
    borderRadius: radius.full,
    backgroundColor: color.success,
  },
  label: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
});
