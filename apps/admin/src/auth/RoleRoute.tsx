import type { Role } from '@fsm/shared';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthProvider';

/**
 * Role gate (Issue 02 AC#1). Unauthenticated → login; authenticated but wrong role → bounced to
 * the shell. `/settings` wraps this with `['OPERATIONS_HEAD']`, so no other role can reach it even
 * by typing the URL — the backend `@Roles('OPERATIONS_HEAD')` guard is the matching server defence.
 */
export function RoleRoute({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { session } = useAuth();
  if (!session) {
    return <Navigate to="/login" replace />;
  }
  if (!roles.includes(session.role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
