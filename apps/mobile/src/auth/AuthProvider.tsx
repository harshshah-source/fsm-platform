import type { LoginResponse, SessionView } from '@fsm/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiLogin, apiMe, apiRefresh } from '../api/client';
import { clearTokens, getTokens, setTokens } from './tokenStore';

interface AuthContextValue {
  session: SessionView | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// Shared by login and rehydrate-on-mount: on a 401 from /me, the refresh token is single-use
// (backend rotates + revokes it), so a successful refresh must persist the *new* pair before
// retrying /me with the new access token. Returns null only when both the access token and the
// refresh attempt fail — the caller is then fully logged out.
async function resolveSession(tokens: LoginResponse): Promise<SessionView | null> {
  try {
    return await apiMe(tokens.accessToken);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'UNAUTHORIZED') {
      throw error;
    }
  }
  try {
    const refreshed = await apiRefresh(tokens.refreshToken);
    await setTokens(refreshed);
    return await apiMe(refreshed.accessToken);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const tokens = await getTokens();
      if (!tokens) {
        if (!cancelled) setLoading(false);
        return;
      }
      const me = await resolveSession(tokens);
      if (cancelled) return;
      if (me) {
        setSession(me);
      } else {
        await clearTokens();
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = async (email: string, password: string): Promise<void> => {
    const tokens = await apiLogin({ email, password });
    await setTokens(tokens);
    const me = await resolveSession(tokens);
    if (!me) {
      throw new Error('UNAUTHORIZED');
    }
    setSession(me);
  };

  const logout = async (): Promise<void> => {
    await clearTokens();
    setSession(null);
  };

  return (
    <AuthContext.Provider value={{ session, loading, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
