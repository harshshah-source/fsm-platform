import type { SessionView } from '@fsm/shared';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { apiLogin, apiMe } from '../api/client';
import { clearTokens, setTokens } from './tokenStore';

interface AuthContextValue {
  session: SessionView | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionView | null>(null);

  const login = async (email: string, password: string): Promise<void> => {
    console.log('[AUTH] entering login()');
    try {
      console.log('[AUTH] before apiLogin()');
      const tokens = await apiLogin({ email, password });
      console.log('[AUTH] after apiLogin() succeeded');
      console.log('[AUTH] before setTokens()');
      await setTokens(tokens);
      console.log('[AUTH] after setTokens()');
      console.log('[AUTH] before apiMe()');
      const me = await apiMe(tokens.accessToken);
      console.log('[AUTH] after apiMe()');
      console.log('[AUTH] before setSession()');
      setSession(me);
      console.log('[AUTH] after setSession()');
    } catch (error) {
      console.log('[AUTH] login error', error);
      throw error;
    }
  };

  const logout = async (): Promise<void> => {
    await clearTokens();
    setSession(null);
  };

  return <AuthContext.Provider value={{ session, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
