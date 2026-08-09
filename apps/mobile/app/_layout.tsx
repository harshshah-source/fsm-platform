import { Slot } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { color } from '../src/theme/tokens';

// Root layout mounts the auth context around the routed tree (admin: AuthProvider at app root).
// The boundary sits OUTSIDE AuthProvider (#209) so a throw in the provider itself — the keychain
// rehydrate on mount is the realistic candidate — is caught rather than white-screening the app.
//
// `app.json` sets `edgeToEdgeEnabled: true`, and Android 15 (the handset we test on) draws every app
// edge-to-edge regardless, so the OS status bar sits ON TOP of the first row of content unless the
// app insets it. No screen did, which put screen titles and header actions (Home's "Notifications",
// Vouchers' "New Voucher") underneath the clock and battery icons. Insetting ONCE here rather than
// per screen means new screens inherit the fix instead of re-introducing the bug.
//
// `edges` is top-only on purpose: the bottom inset belongs to the tab bar, which React Navigation
// already insets itself now that a `SafeAreaProvider` exists above it — claiming it here as well
// would double the gap under the tabs. The app is portrait-locked, so left/right never inset.
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ErrorBoundary>
          <AuthProvider>
            <Slot />
          </AuthProvider>
        </ErrorBoundary>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    // The inset strip is painted rather than left transparent, so the status bar reads as part of
    // the app surface instead of a white band above a grey screen.
    backgroundColor: color.surfaceApp,
  },
});
