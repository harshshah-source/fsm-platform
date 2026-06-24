import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';

/** Gate: any authenticated session may enter the shell (role gating is a later slice). */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  if (!session) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
