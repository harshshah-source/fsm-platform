import type { SessionView } from '@fsm/shared';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { apiLogin, apiMe } from '../api/client';

const TOKEN_KEY = 'fsm.accessToken';

interface AuthContextValue {
  session: SessionView | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({
  children,
  initialSession = null,
}: {
  children: ReactNode;
  /** Test-only seam to start with a session already established. Defaults to logged-out. */
  initialSession?: SessionView | null;
}) {
  const [session, setSession] = useState<SessionView | null>(initialSession);

  const login = async (email: string, password: string): Promise<void> => {
    const { accessToken } = await apiLogin({ email, password });
    sessionStorage.setItem(TOKEN_KEY, accessToken);
    setSession(await apiMe(accessToken));
  };

  const logout = (): void => {
    sessionStorage.removeItem(TOKEN_KEY);
    setSession(null);
  };

  return (
    <AuthContext.Provider value={{ session, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
