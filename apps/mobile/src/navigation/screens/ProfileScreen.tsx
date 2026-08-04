import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { color, spacing, typeScale } from '../../theme/tokens';
import { AvailabilityScreen } from './AvailabilityScreen';
import { LeaveRequestScreen } from './LeaveRequestScreen';

type Panel = 'none' | 'leave-requests' | 'availability';

/** #86/#87 — the #54 empty Profile tab stub gains its first real entry points: Leave Request and
 *  Availability, via the same local-swap pattern used everywhere else (no owning issue for the
 *  rest of Profile chrome yet, so nothing else here is built out). */
export function ProfileScreen() {
  const { session } = useAuth();
  const [panel, setPanel] = useState<Panel>('none');

  if (panel === 'leave-requests') {
    return <LeaveRequestScreen onBack={() => setPanel('none')} />;
  }
  if (panel === 'availability' && session) {
    return <AvailabilityScreen seId={session.user_id} onBack={() => setPanel('none')} />;
  }

  return (
    <View testID="screen-profile" style={styles.container}>
      <Text style={styles.title}>Profile</Text>
      <Pressable testID="profile-leave-requests-button" onPress={() => setPanel('leave-requests')} style={styles.linkRow}>
        <Text style={styles.linkLabel}>Leave Requests</Text>
      </Pressable>
      <Pressable testID="profile-availability-button" onPress={() => setPanel('availability')} style={styles.linkRow}>
        <Text style={styles.linkLabel}>Availability</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
    padding: spacing.lg,
  },
  title: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
  },
  linkRow: {
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: color.line,
  },
  linkLabel: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.brand600,
  },
});
