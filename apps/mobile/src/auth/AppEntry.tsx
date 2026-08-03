import { ActivityIndicator, View } from 'react-native';
import { useAuth } from './AuthProvider';
import { LoginScreen } from './LoginScreen';
import { SessionScreen } from './SessionScreen';
import { SeTabShell } from '../navigation/SeTabShell';

// Session-gated entry: admin uses react-router's ProtectedRoute; mobile chooses the screen
// declaratively from AuthProvider's session, which flips when login/logout updates it.
// `loading` covers the rehydrate-on-mount keychain read, so a returning user with a valid
// token never sees a flash of LoginScreen before the session resolves.
//
// #54: this app is SERVICE_ENGINEER-facing — the bottom-tab shell renders only for that role.
// Any other authenticated role (a shared-infra login, e.g. a manager testing a device) falls back
// to the existing debug SessionScreen rather than a role-shaped experience nothing here builds.
export function AppEntry() {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <View testID="rehydrating">
        <ActivityIndicator />
      </View>
    );
  }
  if (!session) {
    return <LoginScreen />;
  }
  return session.role === 'SERVICE_ENGINEER' ? <SeTabShell /> : <SessionScreen />;
}
