import type { SessionView } from '@fsm/shared';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiLogin, apiMe } from '../api/client';
import { apiRefresh, setOnSessionExpired } from '../api/http';
import { recordActingEntered, recordActingExited } from '../api/roleUnavailability';
import { clearTokens, getAccessToken, setTokens } from '../api/tokens';

const ACTING_ZONE_KEY = 'fsm.actingZone';
/** #339 — the zone's NAME, remembered beside its id so the banner can say "West", not "Zone 3". */
const ACTING_ZONE_NAME_KEY = 'fsm.actingZoneName';

interface AuthContextValue {
  session: SessionView | null;
  /** True while a stored token is being rehydrated via `/me` on mount — gate the shell, don't bounce. */
  loading: boolean;
  /** Set when a session ended because it could not be refreshed — LoginPage renders a "session expired" notice. */
  sessionExpired: boolean;
  clearSessionExpired: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** The zone a CSM / Operations Head is currently acting in as ZM (backup cascade, Issue 27); null = not acting. */
  actingZone: number | null;
  /** #339 — that zone's name when the picker knew it; null when acting was entered by raw id. */
  actingZoneName: string | null;
  setActingZone: (zone: number | null, zoneName?: string | null) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function readActingZone(): number | null {
  const raw = sessionStorage.getItem(ACTING_ZONE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function readActingZoneName(): string | null {
  return sessionStorage.getItem(ACTING_ZONE_NAME_KEY);
}

/** Decode a JWT's `exp` (seconds since epoch) without verifying — for proactive-refresh scheduling only. */
function decodeExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1] ?? '')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
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
  // Loading only when we must rehydrate a stored token (no seeded session + a token present).
  const [loading, setLoading] = useState<boolean>(initialSession == null && getAccessToken() != null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [actingZone, setActingZoneState] = useState<number | null>(readActingZone);
  const [actingZoneName, setActingZoneNameState] = useState<string | null>(readActingZoneName);
  const proactiveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Schedule a refresh ~1 min before the access token expires (reactive 401 refresh is the backstop). */
  const scheduleProactiveRefresh = (accessToken: string): void => {
    if (proactiveTimer.current) clearTimeout(proactiveTimer.current);
    const expMs = decodeExpMs(accessToken);
    if (expMs == null) return;
    const delay = expMs - Date.now() - 60_000;
    if (delay <= 0) return;
    proactiveTimer.current = setTimeout(() => {
      void apiRefresh().then((token) => {
        if (token) scheduleProactiveRefresh(token);
      });
    }, delay);
  };

  // The session ended and could not be refreshed (revoked / rotation reuse / expired refresh token).
  useEffect(() => {
    setOnSessionExpired(() => {
      if (proactiveTimer.current) clearTimeout(proactiveTimer.current);
      clearTokens();
      sessionStorage.removeItem(ACTING_ZONE_KEY);
      setActingZoneState(null);
      setSession(null);
      setSessionExpired(true);
    });
  }, []);

  // Rehydrate a stored session on reload — a loading gate, never a login bounce.
  useEffect(() => {
    if (initialSession != null) return;
    const token = getAccessToken();
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const me = await apiMe(token);
        if (!cancelled) {
          setSession(me);
          scheduleProactiveRefresh(getAccessToken() ?? token);
        }
      } catch {
        // Access token no longer valid — try the rotating refresh once before giving up.
        const refreshed = await apiRefresh();
        if (cancelled) return;
        if (refreshed) {
          try {
            setSession(await apiMe(refreshed));
            scheduleProactiveRefresh(refreshed);
          } catch {
            clearTokens();
          }
        } else {
          clearTokens(); // invalid/expired token → land on login cleanly (no notice; this is a reload)
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = async (email: string, password: string): Promise<void> => {
    const { accessToken, refreshToken } = await apiLogin({ email, password });
    setTokens(accessToken, refreshToken);
    setSession(await apiMe(accessToken));
    setSessionExpired(false);
    scheduleProactiveRefresh(accessToken);
  };

  const logout = (): void => {
    if (proactiveTimer.current) clearTimeout(proactiveTimer.current);
    clearTokens();
    sessionStorage.removeItem(ACTING_ZONE_KEY);
    sessionStorage.removeItem(ACTING_ZONE_NAME_KEY);
    setActingZoneState(null);
    setActingZoneNameState(null);
    setSession(null);
  };

  /**
   * Enter or leave acting (#339).
   *
   * The audit call is fired **after** the new state is written to `sessionStorage`, because
   * `authHeaders()` reads the acting zone from there — an exit posted before the clear would carry
   * the zone, and an entry posted before the write would carry none. Both are deliberately
   * fire-and-forget: the operator's own view must not hang on, or be refused by, a bookkeeping call,
   * and the backend gate has already had its say on whether the acting request is allowed at all.
   */
  const setActingZone = (zone: number | null, zoneName?: string | null): void => {
    const leaving = actingZone;
    if (zone == null) {
      sessionStorage.removeItem(ACTING_ZONE_KEY);
      sessionStorage.removeItem(ACTING_ZONE_NAME_KEY);
    } else {
      sessionStorage.setItem(ACTING_ZONE_KEY, String(zone));
      if (zoneName) sessionStorage.setItem(ACTING_ZONE_NAME_KEY, zoneName);
      else sessionStorage.removeItem(ACTING_ZONE_NAME_KEY);
    }
    setActingZoneState(zone);
    setActingZoneNameState(zone == null ? null : (zoneName ?? null));
    if (zone != null) void recordActingEntered();
    else if (leaving != null) void recordActingExited(leaving);
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        sessionExpired,
        clearSessionExpired: () => setSessionExpired(false),
        login,
        logout,
        actingZone,
        actingZoneName,
        setActingZone,
      }}
    >
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
