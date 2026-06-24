import { Slot } from 'expo-router';
import { AuthProvider } from '../src/auth/AuthProvider';

// Root layout mounts the auth context around the routed tree (admin: AuthProvider at app root).
export default function RootLayout() {
  return (
    <AuthProvider>
      <Slot />
    </AuthProvider>
  );
}
