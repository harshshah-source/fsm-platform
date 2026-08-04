import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, spacing, typeScale } from '../../theme/tokens';
import { LeaveRequestScreen } from './LeaveRequestScreen';

/** #86 — the #54 empty Profile tab stub gains its first real entry point: Leave Request, via the
 *  same local-swap pattern used everywhere else (no owning issue for the rest of Profile chrome
 *  yet, so nothing else here is built out). */
export function ProfileScreen() {
  const [showLeaveRequests, setShowLeaveRequests] = useState(false);

  if (showLeaveRequests) {
    return <LeaveRequestScreen onBack={() => setShowLeaveRequests(false)} />;
  }

  return (
    <View testID="screen-profile" style={styles.container}>
      <Text style={styles.title}>Profile</Text>
      <Pressable testID="profile-leave-requests-button" onPress={() => setShowLeaveRequests(true)} style={styles.linkRow}>
        <Text style={styles.linkLabel}>Leave Requests</Text>
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
