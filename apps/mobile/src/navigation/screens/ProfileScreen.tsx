import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { color, radius, spacing, typeScale } from '../../theme/tokens';
import { AvailabilityScreen } from './AvailabilityScreen';
import { LeaveRequestScreen } from './LeaveRequestScreen';

type Panel = 'none' | 'leave-requests' | 'availability';

/** #86/#87 — the #54 empty Profile tab stub gains its first real entry points: Leave Request and
 *  Availability, via the same local-swap pattern used everywhere else (no owning issue for the
 *  rest of Profile chrome yet, so nothing else here is built out). The Logout section
 *  (`docs/ui/mobile/profile.png` — an outlined pill anchored at the bottom of the screen, above the
 *  tab bar) is separate from that scope: it needs nothing but the session AuthProvider already
 *  exposes, so it does not wait on the rest of the page. */
export function ProfileScreen() {
  const { session, logout } = useAuth();
  const [panel, setPanel] = useState<Panel>('none');

  if (panel === 'leave-requests') {
    return <LeaveRequestScreen onBack={() => setPanel('none')} />;
  }
  if (panel === 'availability' && session) {
    return <AvailabilityScreen seId={session.user_id} onBack={() => setPanel('none')} />;
  }

  return (
    <View testID="screen-profile" style={styles.container}>
      <View>
        <Text style={styles.title}>Profile</Text>
        <Pressable testID="profile-leave-requests-button" onPress={() => setPanel('leave-requests')} style={styles.linkRow}>
          <Text style={styles.linkLabel}>Leave Requests</Text>
        </Pressable>
        <Pressable testID="profile-availability-button" onPress={() => setPanel('availability')} style={styles.linkRow}>
          <Text style={styles.linkLabel}>Availability</Text>
        </Pressable>
      </View>

      {/* AppEntry re-renders LoginScreen the instant `logout()` clears the session — no navigation
          call needed here, same pattern the reference's Logout pill implies. */}
      <Pressable testID="profile-logout-button" onPress={() => void logout()} style={styles.logoutButton}>
        <Text style={styles.logoutIcon}>🚪</Text>
        <Text style={styles.logoutLabel}>Logout</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
    padding: spacing.lg,
    // Pins Logout to the bottom of the tab regardless of how much (or little) sits above it — the
    // rest of Profile (identity card, reporting hierarchy, mapped area, device status) is unbuilt,
    // so today that's just Title + 2 links, but the pill's position must not depend on their count.
    justifyContent: 'space-between',
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
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceCard,
  },
  logoutIcon: {
    fontSize: 16,
  },
  logoutLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.inkStrong,
  },
  linkLabel: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.brand600,
  },
});
