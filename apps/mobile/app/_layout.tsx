import { Slot } from 'expo-router';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

// Root layout mounts the auth context around the routed tree (admin: AuthProvider at app root).
// The boundary sits OUTSIDE AuthProvider (#209) so a throw in the provider itself — the keychain
// rehydrate on mount is the realistic candidate — is caught rather than white-screening the app.
export default function RootLayout() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Slot />
      </AuthProvider>
    </ErrorBoundary>
  );
}
