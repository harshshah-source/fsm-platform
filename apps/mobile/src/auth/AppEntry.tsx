import { ActivityIndicator, View } from 'react-native';
import { useAuth } from './AuthProvider';
import { LoginScreen } from './LoginScreen';
import { SessionScreen } from './SessionScreen';

// Session-gated entry: admin uses react-router's ProtectedRoute; mobile chooses the screen
// declaratively from AuthProvider's session, which flips when login/logout updates it.
// `loading` covers the rehydrate-on-mount keychain read, so a returning user with a valid
// token never sees a flash of LoginScreen before the session resolves.
export function AppEntry() {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <View testID="rehydrating">
        <ActivityIndicator />
      </View>
    );
  }
  return session ? <SessionScreen /> : <LoginScreen />;
}
