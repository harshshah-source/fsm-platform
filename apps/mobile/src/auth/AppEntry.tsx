import { useAuth } from './AuthProvider';
import { LoginScreen } from './LoginScreen';
import { SessionScreen } from './SessionScreen';

// Session-gated entry: admin uses react-router's ProtectedRoute; mobile chooses the screen
// declaratively from AuthProvider's session, which flips when login/logout updates it.
export function AppEntry() {
  const { session } = useAuth();
  return session ? <SessionScreen /> : <LoginScreen />;
}
