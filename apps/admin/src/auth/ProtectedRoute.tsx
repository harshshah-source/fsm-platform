import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';

/** Gate: any authenticated session may enter the shell (role gating is a later slice). */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  // Rehydrating a stored token on reload — hold, don't bounce to login (Issue 109).
  if (loading) {
    return (
      <div role="status" className="flex min-h-screen items-center justify-center text-ink-muted">
        Loading…
      </div>
    );
  }
  if (!session) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
