import type { SessionView } from '@fsm/shared';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { apiLogin, apiMe } from '../api/client';

const TOKEN_KEY = 'fsm.accessToken';
const ACTING_ZONE_KEY = 'fsm.actingZone';

interface AuthContextValue {
  session: SessionView | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** The zone a CSM / Operations Head is currently acting in as ZM (backup cascade, Issue 27); null = not acting. */
  actingZone: number | null;
  setActingZone: (zone: number | null) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function readActingZone(): number | null {
  const raw = sessionStorage.getItem(ACTING_ZONE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

export function AuthProvider({
  children,
  initialSession = null,
}: {
  children: ReactNode;
  /** Test-only seam to start with a session already established. Defaults to logged-out. */
  initialSession?: SessionView | null;
}) {
  const [session, setSession] = useState<SessionView | null>(initialSession);
  const [actingZone, setActingZoneState] = useState<number | null>(readActingZone);

  const login = async (email: string, password: string): Promise<void> => {
    const { accessToken } = await apiLogin({ email, password });
    sessionStorage.setItem(TOKEN_KEY, accessToken);
    setSession(await apiMe(accessToken));
  };

  const logout = (): void => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(ACTING_ZONE_KEY);
    setActingZoneState(null);
    setSession(null);
  };

  const setActingZone = (zone: number | null): void => {
    if (zone == null) sessionStorage.removeItem(ACTING_ZONE_KEY);
    else sessionStorage.setItem(ACTING_ZONE_KEY, String(zone));
    setActingZoneState(zone);
  };

  return (
    <AuthContext.Provider value={{ session, login, logout, actingZone, setActingZone }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
